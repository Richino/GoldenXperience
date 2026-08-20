import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// ---------------------------------------------------------------------------
// Trains a direction model on the stored binary-prediction feature snapshots and
// evaluates it OUT OF SAMPLE with a walk-forward split. Dependency-free (only pg).
//
// Target: did price finish ABOVE entry at the 10m horizon (1) or below (0)?
// Reconstructed from (direction, result) so it is independent of what the
// baseline picked — this measures whether the FEATURES predict direction, not
// whether the baseline's own choice was right.
// ---------------------------------------------------------------------------

function loadEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const l of fs.readFileSync(f, "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.resolve("./.env"));
loadEnv(path.resolve("./.env.local"));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(`
  SELECT instrument, direction, result, confidence::float AS confidence,
         features, created_at
  FROM binary_predictions
  WHERE status='resolved' AND result IN ('won','lost') AND features IS NOT NULL
    AND is_shadow=false
  ORDER BY created_at ASC
`);
await client.end();

// --- Feature engineering ---------------------------------------------------
const SESSIONS = ["New York", "London", "London/New York overlap"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function vectorize(f) {
  const c = f.candle ?? {};
  const emaGapPct = num(f.emaFast) != null && num(f.emaSlow) != null && f.referenceClose
    ? (f.emaFast - f.emaSlow) / f.referenceClose
    : null;
  const h = num(f.hourEt) ?? 0;
  return {
    mom_m1: num(f.momentumPips?.m1), mom_m5: num(f.momentumPips?.m5),
    mom_m10: num(f.momentumPips?.m10), mom_m15: num(f.momentumPips?.m15),
    ret_m1: num(f.returnPct?.m1), ret_m5: num(f.returnPct?.m5),
    ret_m10: num(f.returnPct?.m10), ret_m15: num(f.returnPct?.m15),
    atrPips: num(f.atrPips), emaGapPct,
    volatilityPips: num(f.volatilityPips),
    bodyPips: num(c.bodyPips), bodyRatio: num(c.bodyRatio),
    upperWick: num(c.upperWickPips), lowerWick: num(c.lowerWickPips),
    distHigh: num(f.distanceFromHighPips), distLow: num(f.distanceFromLowPips),
    spreadPips: num(f.spreadPips),
    hour_sin: Math.sin((2 * Math.PI * h) / 24), hour_cos: Math.cos((2 * Math.PI * h) / 24),
    trend_up: f.trend === "up" ? 1 : 0, trend_down: f.trend === "down" ? 1 : 0,
    sess_ny: f.session === SESSIONS[0] ? 1 : 0, sess_ldn: f.session === SESSIONS[1] ? 1 : 0,
    sess_ovl: f.session === SESSIONS[2] ? 1 : 0,
  };
}

const data = rows.map((r) => {
  const priceWentUp = (r.direction === "up" && r.result === "won") || (r.direction === "down" && r.result === "lost");
  return { x: vectorize(r.features), y: priceWentUp ? 1 : 0, conf: r.confidence };
});
const FEATURES = Object.keys(data[0].x);

// Walk-forward split: earlier 70% train, later 30% test.
const cut = Math.floor(data.length * 0.7);
const train = data.slice(0, cut);
const test = data.slice(cut);

// Standardize using TRAIN stats only; impute nulls with train mean (→ 0 after standardize).
const mean = {}, std = {};
for (const k of FEATURES) {
  const vals = train.map((d) => d.x[k]).filter((v) => v != null);
  const m = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / (vals.length || 1)) || 1;
  mean[k] = m; std[k] = sd;
}
const toRow = (d) => FEATURES.map((k) => (d.x[k] == null ? 0 : (d.x[k] - mean[k]) / std[k]));
const Xtr = train.map(toRow), ytr = train.map((d) => d.y);
const Xte = test.map(toRow), yte = test.map((d) => d.y);

// --- Model 1: L2 logistic regression (batch gradient descent) --------------
function trainLogistic(X, y, { lr = 0.1, l2 = 1.0, epochs = 400 } = {}) {
  const n = X.length, p = X[0].length;
  let w = new Array(p).fill(0), b = 0;
  const sig = (z) => 1 / (1 + Math.exp(-z));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(p).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < p; j++) z += w[j] * X[i][j];
      const err = sig(z) - y[i];
      for (let j = 0; j < p; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < p; j++) w[j] -= lr * (gw[j] / n + (l2 * w[j]) / n);
    b -= lr * (gb / n);
  }
  return { w, b, predict: (row) => 1 / (1 + Math.exp(-(b + row.reduce((s, v, j) => s + w[j] * v, 0)))) };
}

// --- Model 2: bagged decision trees (random forest) ------------------------
function buildTree(X, y, idx, depth, maxDepth, minLeaf, featBag) {
  const ys = idx.map((i) => y[i]);
  const pos = ys.reduce((s, v) => s + v, 0);
  const leaf = () => ({ leaf: true, p: (pos + 0.5) / (ys.length + 1) });
  if (depth >= maxDepth || idx.length < 2 * minLeaf || pos === 0 || pos === ys.length) return leaf();
  const gini = (a, b, na, nb) => { const g = (c, n) => (n ? 1 - (c / n) ** 2 - (1 - c / n) ** 2 : 0); return (na * g(a, na) + nb * g(b, nb)) / (na + nb); };
  const cols = [...Array(X[0].length).keys()].sort(() => Math.random() - 0.5).slice(0, featBag);
  let best = null;
  for (const c of cols) {
    const vals = [...new Set(idx.map((i) => X[i][c]))].sort((a, b) => a - b);
    for (let q = 1; q < vals.length; q++) {
      const thr = (vals[q - 1] + vals[q]) / 2;
      let la = 0, ln = 0, ra = 0, rn = 0;
      for (const i of idx) { if (X[i][c] <= thr) { la += y[i]; ln++; } else { ra += y[i]; rn++; } }
      if (ln < minLeaf || rn < minLeaf) continue;
      const g = gini(la, ra, ln, rn);
      if (!best || g < best.g) best = { g, c, thr };
    }
  }
  if (!best) return leaf();
  const L = idx.filter((i) => X[i][best.c] <= best.thr), R = idx.filter((i) => X[i][best.c] > best.thr);
  return { leaf: false, c: best.c, thr: best.thr,
    L: buildTree(X, y, L, depth + 1, maxDepth, minLeaf, featBag),
    R: buildTree(X, y, R, depth + 1, maxDepth, minLeaf, featBag) };
}
function predTree(t, row) { return t.leaf ? t.p : predTree(row[t.c] <= t.thr ? t.L : t.R, row); }
function trainForest(X, y, { trees = 60, maxDepth = 5, minLeaf = 20, featBag = 6 } = {}) {
  const n = X.length, forest = [];
  for (let t = 0; t < trees; t++) {
    const boot = [...Array(n).keys()].map(() => Math.floor(Math.random() * n));
    forest.push(buildTree(X, y, boot, 0, maxDepth, minLeaf, featBag));
  }
  return { predict: (row) => forest.reduce((s, t) => s + predTree(t, row), 0) / forest.length };
}

// --- Evaluation helpers ----------------------------------------------------
function wilson(w, n) { if (!n) return [null, null]; const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n); return [(c - m) / d, (c + m) / d]; }
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
function auc(scores, labels) {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let rankSum = 0; for (let i = 0; i < pairs.length; i++) if (pairs[i].y === 1) rankSum += i + 1;
  const nPos = labels.reduce((s, v) => s + v, 0), nNeg = labels.length - nPos;
  return nPos && nNeg ? (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : null;
}
function evaluate(name, predictFn) {
  let correct = 0, logloss = 0; const scores = [];
  for (let i = 0; i < Xte.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, predictFn(Xte[i])));
    scores.push(p);
    if ((p >= 0.5 ? 1 : 0) === yte[i]) correct++;
    logloss += -(yte[i] * Math.log(p) + (1 - yte[i]) * Math.log(1 - p));
  }
  const n = Xte.length, [lo, hi] = wilson(correct, n);
  console.log(`\n${name}`);
  console.log(`  Out-of-sample accuracy: ${pct(correct / n)}  (95% CI ${pct(lo)}-${pct(hi)}, n=${n})`);
  console.log(`  AUC: ${(auc(scores, yte) ?? 0).toFixed(3)}   LogLoss: ${(logloss / n).toFixed(4)}  (0.693 = coin flip)`);
  // Calibration: do high-confidence picks win more?
  const hiConf = scores.map((s, i) => ({ edge: Math.abs(s - 0.5), hit: (s >= 0.5 ? 1 : 0) === yte[i] })).sort((a, b) => b.edge - a.edge);
  const top = hiConf.slice(0, Math.floor(n * 0.2));
  const topHit = top.reduce((s, x) => s + x.hit, 0) / (top.length || 1);
  console.log(`  Top-20% most-confident picks accuracy: ${pct(topHit)}  (if ≈overall, confidence is meaningless)`);
  return correct / n;
}

console.log("=".repeat(64));
console.log("BINARY DIRECTION MODEL — TRAINING & OUT-OF-SAMPLE TEST");
console.log("=".repeat(64));
console.log(`Samples: ${data.length}  (train ${train.length} earlier / test ${test.length} later)`);
console.log(`Base rate (price up) — train ${pct(ytr.reduce((s, v) => s + v, 0) / ytr.length)}, test ${pct(yte.reduce((s, v) => s + v, 0) / yte.length)}`);
console.log(`Features: ${FEATURES.length}`);

const logit = trainLogistic(Xtr, ytr);
evaluate("MODEL 1 — Logistic Regression (linear)", (row) => logit.predict(row));

console.log("\n  Top feature weights (standardized; |weight| = influence):");
FEATURES.map((k, j) => ({ k, w: logit.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 10)
  .forEach((f) => console.log(`    ${f.k.padEnd(16)} ${f.w >= 0 ? "+" : ""}${f.w.toFixed(3)}`));

const exportPath = process.argv.find((arg) => arg.startsWith("--export="))?.slice("--export=".length);
if (exportPath) {
  const coefficients = {};
  for (let j = 0; j < FEATURES.length; j += 1) coefficients[FEATURES[j]] = logit.w[j];
  const artifact = {
    modelName: "binary-logistic-v1",
    version: "1.0.0",
    horizonMinutes: 10,
    horizonSeconds: 600,
    scoreKind: "probability",
    featureNames: FEATURES,
    intercept: logit.b,
    coefficients,
    normalization: { mean, std },
    metadata: {
      target: "10-minute future direction",
      trainedSamples: train.length,
      testSamples: test.length,
      totalSamples: data.length,
      trainedAt: new Date().toISOString(),
      trainingMethod: "chronological 70/30 split",
      hyperparameters: { lr: 0.1, l2: 1.0, epochs: 400 },
      missingValueStrategy: "train_mean_impute_then_zero_after_standardize",
    },
  };
  fs.mkdirSync(path.dirname(path.resolve(exportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(exportPath), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\nExported runtime config → ${path.resolve(exportPath)}`);
}

const forest = trainForest(Xtr, ytr);
evaluate("MODEL 2 — Random Forest (non-linear, 60 trees)", (row) => forest.predict(row));

// Baseline's own confidence as a "model", for reference.
let bcorrect = 0;
for (let i = 0; i < test.length; i++) if (((test[i].conf >= 0.5 ? 1 : 0)) === 1 && yte[i] === 1) bcorrect++; // trivial; kept for shape
console.log("\n" + "=".repeat(64));
console.log("VERDICT: compare each model's CI to 50%. If it straddles 50%,");
console.log("the features do not predict 10-minute direction out of sample.");
console.log("=".repeat(64));
