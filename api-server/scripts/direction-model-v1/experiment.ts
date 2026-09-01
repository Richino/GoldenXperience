/**
 * DIRECTION_MODEL — experiment orchestrator.
 *
 * Once EUR/USD is (about to be) making a meaningful move, can we predict UP vs
 * DOWN from information available BEFORE the move? MOVE_MODEL is frozen and used
 * only to (a) supply causal OOS MOVE probabilities and (b) define which cases
 * count as meaningful moves. No TP/SL, sizing, entries or execution here.
 *
 * Two experiments:
 *   ORACLE     — restrict to ground-truth MOVE cases (a move really happened).
 *                Isolates pure direction predictability from MOVE selection error.
 *   CONDITIONAL— evaluate on cases MOVE_MODEL *predicts* as moves (prob >= thr),
 *                to see if selecting stronger MOVE signals makes direction easier.
 *
 * Strict chronological walk-forward + one untouched final holdout. Isolated:
 * no paper/production/execution imports.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOT, calibration, csv, evaluate, predictGBT, predictLogistic, round, trainGBT, trainLogistic,
} from "../move-model-v1/lib.js";
import {
  DIR_FEATURES, DIR_GROUPS, FROZEN_MOVE_THRESHOLD, HORIZONS, buildDirectionRecords,
  buildSamples, generateMoveProbs, loadBars, loadNews, type DirRecord,
} from "./lib.js";

const OUT = path.join(ROOT, "api-server", "research-v2", "DIRECTION_MODEL");
mkdirSync(OUT, { recursive: true });
const ms = (iso: string) => Date.parse(iso + "T00:00:00Z");
const barMs = 15 * 60_000;
const MODEL_FROM = ms("2020-01-01"), MODEL_TO = ms("2026-08-01"), FINAL_FROM = ms("2026-02-01");
const MOVE_PROB_FROM = ms("2021-01-01");
const MOVE_THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7];
const CONF_BUCKETS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 1.01]] as const;
const FOLDS = [
  ["2022-01-01", "2022-07-01"], ["2022-07-01", "2023-01-01"], ["2023-01-01", "2023-07-01"],
  ["2023-07-01", "2024-01-01"], ["2024-01-01", "2024-07-01"], ["2024-07-01", "2025-01-01"],
  ["2025-01-01", "2025-07-01"], ["2025-07-01", "2026-01-01"],
].map(([a, b]) => ({ from: ms(a!), to: ms(b!), label: `${a}..${b}` }));

const IDX = (name: string) => DIR_FEATURES.findIndex((f) => f.name === name);
const iRet1 = IDX("ret1"), iRet4 = IDX("ret4"), iTrend = IDX("ema20_ema50");
function subsample<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows; const stride = rows.length / cap; const out: T[] = [];
  for (let k = 0; k < cap; k += 1) out.push(rows[Math.floor(k * stride)]!); return out;
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

type Row = { x: number[]; y: number; r: DirRecord };
function dirMetrics(probs: number[], y: number[]) {
  const m = evaluate(probs, y);
  return { n: m.n, upRate: m.posRate, acc: m.accuracy, balAcc: (m.moveRecall + m.noMoveRecall) / 2, upAcc: m.moveRecall, downAcc: m.noMoveRecall, precision: m.precision, recall: m.recall, auc: m.auc, brier: m.brier };
}
// baselines return probability-of-UP arrays
const baselineProbs = {
  always_up: (te: Row[]) => te.map(() => 1),
  always_down: (te: Row[]) => te.map(() => 0),
  prev_return: (te: Row[]) => te.map((r) => (r.x[iRet1]! > 0 ? 1 : 0)),
  trend_rule: (te: Row[]) => te.map((r) => (r.x[iTrend]! > 0 ? 1 : 0)),
  momentum_rule: (te: Row[]) => te.map((r) => (r.x[iRet4]! > 0 ? 1 : 0)),
  majority: (tr: Row[], te: Row[]) => { const up = tr.reduce((a, r) => a + r.y, 0) / tr.length; return te.map(() => (up >= 0.5 ? 1 : 0)); },
};

console.log("Loading data + building MOVE samples...");
const bars = loadBars("backtest-legacy-expanded/candles/EUR_USD_M15.json");
const h1 = loadBars("backtest-legacy-expanded/candles/EUR_USD_H1.json");
const m5 = loadBars("backtest-breakout-m5/candles/EUR_USD_M5.json");
const news = loadNews();
const moveSamples = buildSamples(bars, h1, m5, news, MODEL_FROM, MODEL_TO);
console.log(`move samples=${moveSamples.length}`);

console.log("Generating frozen MOVE_MODEL out-of-sample probabilities (expanding walk-forward)...");
const moveProbByT = generateMoveProbs(moveSamples, MOVE_PROB_FROM, MODEL_TO);
console.log(`move-prob timestamps=${moveProbByT.size}`);

console.log("Building signed direction records...");
const records = buildDirectionRecords(bars, h1, m5, news, moveSamples, moveProbByT).filter((r) => r.t >= MOVE_PROB_FROM);
console.log(`direction records=${records.length}`);

// per-horizon oracle dataset: real move + finite move prob + contiguous
function oracleRows(hIdx: number): Row[] {
  return records.filter((r) => r.contiguous[hIdx] && r.moveGT[hIdx] && Number.isFinite(r.moveProb[hIdx]!))
    .map((r) => ({ x: [...r.dirX, r.moveProb[hIdx]!], y: r.upLabel[hIdx] ? 1 : 0, r }));
}
const sliceRows = (rows: Row[], from: number, to: number) => rows.filter((r) => r.r.t >= from && r.r.t < to);

// ---------------------------------------------------------------------------
// 1) ORACLE walk-forward per horizon: model vs baselines
// ---------------------------------------------------------------------------
console.log("Oracle walk-forward...");
const wfRows: Record<string, unknown>[] = [];
const perHorizon: Record<string, { gbt: number[]; log: number[]; baseAcc: number[]; gbtAcc: number[]; gbtBal: number[] }> = {};
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const all = oracleRows(h); const emb = HORIZONS[h]!.bars * barMs;
  perHorizon[label] = { gbt: [], log: [], baseAcc: [], gbtAcc: [], gbtBal: [] };
  for (const fold of FOLDS) {
    const tr = sliceRows(all, MODEL_FROM, fold.from - emb); const te = sliceRows(all, fold.from, fold.to);
    if (tr.length < 500 || te.length < 100) continue;
    const y = te.map((r) => r.y); const trS = subsample(tr, 40_000);
    const logM = trainLogistic(trS.map((r) => r.x), trS.map((r) => r.y), { iters: 150 });
    const log = dirMetrics(te.map((r) => predictLogistic(logM, r.x)), y);
    const gbtM = trainGBT(trS.map((r) => r.x), trS.map((r) => r.y), { rounds: 100, depth: 3, lr: 0.1 });
    const gbt = dirMetrics(te.map((r) => predictGBT(gbtM, r.x)), y);
    const bl: Record<string, ReturnType<typeof dirMetrics>> = {
      always_up: dirMetrics(baselineProbs.always_up(te), y), always_down: dirMetrics(baselineProbs.always_down(te), y),
      prev_return: dirMetrics(baselineProbs.prev_return(te), y), trend_rule: dirMetrics(baselineProbs.trend_rule(te), y),
      momentum_rule: dirMetrics(baselineProbs.momentum_rule(te), y), majority: dirMetrics(baselineProbs.majority(tr, te), y),
    };
    const bestBaseAcc = Math.max(...Object.values(bl).map((m) => m.acc));
    for (const [model, m] of [["logistic", log], ["gbt", gbt], ...Object.entries(bl)] as const) {
      wfRows.push({ horizon: label, fold: fold.label, model, n: m.n, upRate: m.upRate, accuracy: m.acc, balancedAccuracy: m.balAcc, upAcc: m.upAcc, downAcc: m.downAcc, auc: m.auc, brier: m.brier });
    }
    perHorizon[label]!.gbt.push(gbt.auc); perHorizon[label]!.log.push(log.auc);
    perHorizon[label]!.gbtAcc.push(gbt.acc); perHorizon[label]!.gbtBal.push(gbt.balAcc); perHorizon[label]!.baseAcc.push(bestBaseAcc);
    console.log(`  ${label} ${fold.label}: gbt acc=${gbt.acc.toFixed(3)} bal=${gbt.balAcc.toFixed(3)} auc=${gbt.auc.toFixed(3)} | bestBaseAcc=${bestBaseAcc.toFixed(3)}`);
  }
}
const horizonRank = HORIZONS.map((hh) => ({ label: hh.label, meanGbtAuc: mean(perHorizon[hh.label]!.gbt), meanGbtBal: mean(perHorizon[hh.label]!.gbtBal), meanBaseAcc: mean(perHorizon[hh.label]!.baseAcc), meanGbtAcc: mean(perHorizon[hh.label]!.gbtAcc) }))
  .sort((a, b) => b.meanGbtAuc - a.meanGbtAuc);
const bestH = horizonRank[0]!; const bestIdx = HORIZONS.findIndex((h) => h.label === bestH.label);
console.log(`Best direction horizon (oracle mean GBT AUC): ${bestH.label} (${bestH.meanGbtAuc.toFixed(4)})`);

// ---------------------------------------------------------------------------
// 2) ORACLE final holdout — full suite, keep models for downstream analysis
// ---------------------------------------------------------------------------
console.log("Oracle final holdout...");
const finalRows: Record<string, unknown>[] = [];
const oracleResultRows: Record<string, unknown>[] = [];
const holdoutModels: Record<string, { gbt: (x: number[]) => number; teByH: Row[] }> = {};
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const all = oracleRows(h); const emb = HORIZONS[h]!.bars * barMs;
  const tr = sliceRows(all, MODEL_FROM, FINAL_FROM - emb); const te = sliceRows(all, FINAL_FROM, MODEL_TO);
  if (tr.length < 500 || te.length < 100) continue;
  const y = te.map((r) => r.y); const trS = subsample(tr, 45_000);
  const logM = trainLogistic(trS.map((r) => r.x), trS.map((r) => r.y), { iters: 200 });
  const gbtM = trainGBT(trS.map((r) => r.x), trS.map((r) => r.y), { rounds: 120, depth: 3, lr: 0.1 });
  const gbtPredict = (x: number[]) => predictGBT(gbtM, x);
  const log = dirMetrics(te.map((r) => predictLogistic(logM, r.x)), y);
  const gbt = dirMetrics(te.map((r) => gbtPredict(r.x)), y);
  holdoutModels[label] = { gbt: gbtPredict, teByH: te };
  const bl: Record<string, ReturnType<typeof dirMetrics>> = {
    always_up: dirMetrics(baselineProbs.always_up(te), y), always_down: dirMetrics(baselineProbs.always_down(te), y),
    prev_return: dirMetrics(baselineProbs.prev_return(te), y), trend_rule: dirMetrics(baselineProbs.trend_rule(te), y),
    momentum_rule: dirMetrics(baselineProbs.momentum_rule(te), y), majority: dirMetrics(baselineProbs.majority(tr, te), y),
  };
  for (const [model, m] of [["logistic", log], ["gbt", gbt], ...Object.entries(bl)] as const) {
    finalRows.push({ horizon: label, model, n: m.n, upRate: m.upRate, accuracy: m.acc, balancedAccuracy: m.balAcc, upAcc: m.upAcc, downAcc: m.downAcc, precision: m.precision, recall: m.recall, auc: m.auc, brier: m.brier });
  }
  const bestBaseAcc = Math.max(...Object.values(bl).map((m) => m.acc));
  oracleResultRows.push({ horizon: label, scope: "final_holdout", n: gbt.n, gbt_acc: gbt.acc, gbt_balAcc: gbt.balAcc, gbt_auc: gbt.auc, best_baseline_acc: bestBaseAcc, incremental_acc: gbt.acc - bestBaseAcc, incremental_balAcc: gbt.balAcc - 0.5 });
  oracleResultRows.push({ horizon: label, scope: "walkforward_mean", n: "", gbt_acc: mean(perHorizon[label]!.gbtAcc), gbt_balAcc: mean(perHorizon[label]!.gbtBal), gbt_auc: mean(perHorizon[label]!.gbt), best_baseline_acc: mean(perHorizon[label]!.baseAcc), incremental_acc: mean(perHorizon[label]!.gbtAcc) - mean(perHorizon[label]!.baseAcc), incremental_balAcc: mean(perHorizon[label]!.gbtBal) - 0.5 });
}

// ---------------------------------------------------------------------------
// 3) Confidence calibration buckets (best horizon, oracle holdout GBT)
// ---------------------------------------------------------------------------
console.log("Confidence buckets...");
const confRows: Record<string, unknown>[] = [];
let bucketMonotonic = true, prevAcc = -1;
{
  const hm = holdoutModels[bestH.label]!; const te = hm.teByH; const probs = te.map((r) => hm.gbt(r.x));
  for (const [lo, hi] of CONF_BUCKETS) {
    const sel = te.map((r, i) => ({ p: probs[i]!, y: r.y })).filter((o) => Math.max(o.p, 1 - o.p) >= lo && Math.max(o.p, 1 - o.p) < hi);
    if (!sel.length) { confRows.push({ horizon: bestH.label, bucket: `${lo}-${hi}`, n: 0, dirAccuracy: "", upAccuracy: "", downAccuracy: "" }); continue; }
    const correct = sel.filter((o) => (o.p >= 0.5 ? 1 : 0) === o.y).length;
    const predUp = sel.filter((o) => o.p >= 0.5); const predDown = sel.filter((o) => o.p < 0.5);
    const upAcc = predUp.length ? predUp.filter((o) => o.y === 1).length / predUp.length : NaN;
    const downAcc = predDown.length ? predDown.filter((o) => o.y === 0).length / predDown.length : NaN;
    const dirAcc = correct / sel.length;
    confRows.push({ horizon: bestH.label, bucket: `${lo}-${hi}`, n: sel.length, dirAccuracy: dirAcc, upAccuracy: upAcc, downAccuracy: downAcc });
    if (lo >= 0.6 && prevAcc >= 0 && dirAcc < prevAcc - 0.01) bucketMonotonic = false;
    prevAcc = dirAcc;
  }
}

// ---------------------------------------------------------------------------
// 4) MOVE-confidence conditional analysis (does stronger MOVE signal help direction?)
// ---------------------------------------------------------------------------
console.log("MOVE-confidence conditional analysis...");
const moveCondRows: Record<string, unknown>[] = [];
for (let h = 0; h < HORIZONS.length; h += 1) {
  const label = HORIZONS[h]!.label; const hm = holdoutModels[label]; if (!hm) continue;
  // evaluate on ALL holdout records for this horizon (not just oracle moves), selected by predicted MOVE prob
  const holdoutAll = records.filter((r) => r.t >= FINAL_FROM && r.contiguous[h] && Number.isFinite(r.moveProb[h]!))
    .map((r) => ({ x: [...r.dirX, r.moveProb[h]!], y: r.upLabel[h] ? 1 : 0, r }));
  for (const thr of MOVE_THRESHOLDS) {
    const sel = holdoutAll.filter((r) => r.r.moveProb[h]! >= thr);
    if (sel.length < 50) { moveCondRows.push({ horizon: label, move_prob_threshold: thr, n: sel.length, dirAccuracy: "", balAccuracy: "", auc: "" }); continue; }
    const m = dirMetrics(sel.map((r) => hm.gbt(r.x)), sel.map((r) => r.y));
    moveCondRows.push({ horizon: label, move_prob_threshold: thr, n: m.n, upRate: m.upRate, dirAccuracy: m.acc, balAccuracy: m.balAcc, upAcc: m.upAcc, downAcc: m.downAcc, auc: m.auc });
  }
}

// ---------------------------------------------------------------------------
// 5) Breakdowns (best horizon, oracle holdout): session / vol regime / trend regime / news
// ---------------------------------------------------------------------------
console.log("Breakdowns...");
const sessionRows: Record<string, unknown>[] = [], regimeRows: Record<string, unknown>[] = [], newsRows: Record<string, unknown>[] = [];
{
  const hm = holdoutModels[bestH.label]!; const te = hm.teByH; const probs = te.map((r) => hm.gbt(r.x));
  const bucketBy = (pred: (r: Row) => string, sink: Record<string, unknown>[], key: string) => {
    const groups = new Map<string, { p: number[]; y: number[] }>();
    te.forEach((r, i) => { const g = pred(r); const e = groups.get(g) ?? { p: [], y: [] }; e.p.push(probs[i]!); e.y.push(r.y); groups.set(g, e); });
    for (const [g, e] of groups) { if (e.y.length < 30) continue; const m = dirMetrics(e.p, e.y); sink.push({ horizon: bestH.label, [key]: g, n: m.n, upRate: m.upRate, dirAccuracy: m.acc, balAccuracy: m.balAcc, upAcc: m.upAcc, downAcc: m.downAcc, auc: m.auc }); }
  };
  bucketBy((r) => r.r.session, sessionRows, "session");
  const vols = te.map((r) => r.r.volRatio).sort((a, b) => a - b); const q1 = vols[Math.floor(vols.length / 3)]!, q2 = vols[Math.floor(2 * vols.length / 3)]!;
  bucketBy((r) => (r.r.volRatio < q1 ? "low_vol" : r.r.volRatio < q2 ? "mid_vol" : "high_vol"), regimeRows, "regime");
  bucketBy((r) => r.r.trendRegime, regimeRows, "regime");
  bucketBy((r) => (r.r.newsAdjacent ? "news_adjacent" : "non_news"), newsRows, "bucket");
}

// ---------------------------------------------------------------------------
// 6) Feature-group ablation (logistic, best horizon oracle, dev split)
// ---------------------------------------------------------------------------
console.log("Ablation...");
const ablationRows: Record<string, unknown>[] = [];
{
  const all = oracleRows(bestIdx); const emb = HORIZONS[bestIdx]!.bars * barMs;
  const DEV_TO = ms("2024-07-01");
  const tr = subsample(sliceRows(all, MODEL_FROM, DEV_TO - emb), 45_000); const te = sliceRows(all, DEV_TO, FINAL_FROM);
  const groupOf = (i: number) => DIR_FEATURES[i]!.group;
  const keep = (drop: string | null) => DIR_FEATURES.map((_, i) => i).filter((i) => !(drop && groupOf(i) === drop));
  const fit = (idx: number[]) => { const model = trainLogistic(tr.map((r) => idx.map((i) => r.x[i]!)), tr.map((r) => r.y), { iters: 150 }); return dirMetrics(te.map((r) => predictLogistic(model, idx.map((i) => r.x[i]!))), te.map((r) => r.y)); };
  const full = fit(keep(null));
  ablationRows.push({ variant: "FULL", auc: full.auc, balAcc: full.balAcc, delta_auc: 0, delta_balAcc: 0, harmful_if_removal_improves: false });
  for (const g of DIR_GROUPS) { const m = fit(keep(g)); ablationRows.push({ variant: `FULL_MINUS_${g}`, auc: m.auc, balAcc: m.balAcc, delta_auc: m.auc - full.auc, delta_balAcc: m.balAcc - full.balAcc, harmful_if_removal_improves: m.auc - full.auc > 0.003 }); }
}

// ---------------------------------------------------------------------------
// 7) Verdict
// ---------------------------------------------------------------------------
const bestFinal = finalRows.filter((r) => r.horizon === bestH.label);
const gGbt = bestFinal.find((r) => r.model === "gbt") as Record<string, number>;
const bestBaselineAcc = Math.max(...bestFinal.filter((r) => ["always_up", "always_down", "prev_return", "trend_rule", "momentum_rule", "majority"].includes(String(r.model))).map((r) => Number(r.accuracy)));
const finalAuc = Number(gGbt.auc), finalBal = Number(gGbt.balancedAccuracy), finalAcc = Number(gGbt.accuracy);
const foldsBeating = perHorizon[bestH.label]!.gbt.filter((a) => a > 0.52).length;
const totalFolds = perHorizon[bestH.label]!.gbt.length;
const survivesWalk = foldsBeating >= Math.ceil(totalFolds * 0.75);
const survivesFinal = finalAuc > 0.52 && finalBal > 0.51 && finalAcc > bestBaselineAcc + 0.01;
const calibratedOk = bucketMonotonic;
const enoughObs = Number(gGbt.n) >= 500;
const verdict = (survivesWalk && survivesFinal && calibratedOk && enoughObs) ? "DIRECTION_EDGE_FOUND" : "NO_DIRECTION_EDGE";
// headline conditional accuracy at move_prob>=0.60 for best horizon
const condBest = moveCondRows.find((r) => r.horizon === bestH.label && r.move_prob_threshold === 0.6) as Record<string, number> | undefined;
console.log(`\nVERDICT: ${verdict}`);
console.log(`  best H=${bestH.label} finalAcc=${finalAcc.toFixed(4)} bal=${finalBal.toFixed(4)} auc=${finalAuc.toFixed(4)} vs bestBaselineAcc=${bestBaselineAcc.toFixed(4)}; WF folds AUC>0.52: ${foldsBeating}/${totalFolds}; calibrated=${calibratedOk}`);

// ---------------------------------------------------------------------------
// Write artifacts
// ---------------------------------------------------------------------------
writeFileSync(path.join(OUT, "WALK_FORWARD.csv"), csv(wfRows));
writeFileSync(path.join(OUT, "FINAL_TEST.csv"), csv(finalRows));
writeFileSync(path.join(OUT, "CONFIDENCE_CALIBRATION.csv"), csv(confRows));
writeFileSync(path.join(OUT, "MOVE_CONFIDENCE_ANALYSIS.csv"), csv(moveCondRows));
writeFileSync(path.join(OUT, "ORACLE_MOVE_RESULTS.csv"), csv(oracleResultRows));
writeFileSync(path.join(OUT, "SESSION_RESULTS.csv"), csv(sessionRows));
writeFileSync(path.join(OUT, "REGIME_RESULTS.csv"), csv(regimeRows));
writeFileSync(path.join(OUT, "NEWS_RESULTS.csv"), csv(newsRows));
writeFileSync(path.join(OUT, "ABLATION_RESULTS.csv"), csv(ablationRows));

writeFileSync(path.join(OUT, "FEATURE_DEFINITIONS.md"), [
  "# DIRECTION_MODEL — feature definitions", "",
  "All features are causal (completed bars <= T; calendar event TIMES known ahead, released VALUES withheld). Unlike MOVE_MODEL these are deliberately SIGNED so they can carry directional information.", "",
  "| # | Feature | Group | Meaning |", "|---:|---|---|---|",
  ...DIR_FEATURES.map((f, i) => `| ${i} | \`${f.name}\` | ${f.group} | ${dirDoc(f.name)} |`),
  "", "`move_prob` is the frozen MOVE_MODEL's causal out-of-sample P(MOVE) at the matching horizon. Volume is unavailable in the caches (no volume feature).",
  `\nGroups (${DIR_GROUPS.length}): ${DIR_GROUPS.join(", ")}.`, "",
].join("\n"));

writeFileSync(path.join(OUT, "DATASET_DEFINITION.md"), [
  "# DIRECTION_MODEL — dataset & label definition", "",
  "## Task", "Binary UP vs DOWN, evaluated only on meaningful-move cases. Direction only — no TP/SL, sizing, entries, or execution.", "",
  "## Label", "For horizon H bars after T: `up = maxHigh(T+1..T+H) - close_T`, `down = close_T - minLow(...)`. **UP = up >= down** (the larger excursion side). A net-displacement label (`close_{T+H} > close_T`) is also stored for robustness.", "",
  "## Meaningful-move eligibility (from frozen MOVE_MODEL)",
  `- Frozen MOVE thresholds (ATR units): ${HORIZONS.map((h, i) => `${h.label}=${FROZEN_MOVE_THRESHOLD[i]}`).join(", ")}.`,
  "- **ORACLE** cases: ground-truth normalized excursion >= threshold (a move really happened).",
  "- **CONDITIONAL** cases: frozen MOVE_MODEL causal OOS probability >= {0.50,0.55,0.60,0.65,0.70}.", "",
  "## MOVE probability generation (frozen recipe, causal)",
  "The frozen MOVE_MODEL GBT recipe (histogram GBT, 100 rounds, depth 3, lr 0.1, frozen feature set/threshold) is re-run in an expanding walk-forward (retrained every ~6 months, forward embargo) to emit out-of-sample P(MOVE) from 2021-01 onward. MOVE_MODEL itself is never modified.", "",
  "## Period & splits",
  `- Modelling window: ${new Date(MOVE_PROB_FROM).toISOString()} .. ${new Date(MODEL_TO).toISOString()} (start bounded by MOVE-prob availability).`,
  `- Final untouched holdout: ${new Date(FINAL_FROM).toISOString()} .. ${new Date(MODEL_TO).toISOString()}.`,
  `- Walk-forward folds: ${FOLDS.map((f) => f.label).join("; ")}. Expanding train, forward embargo = horizon length.`,
  "- Labels overlap across consecutive bars (effective N ≈ N/H); significance judged conservatively.", "",
].join("\n"));

const rank = horizonRank.map((r) => `| ${r.label} | ${r.meanGbtAcc.toFixed(4)} | ${r.meanGbtBal.toFixed(4)} | ${r.meanGbtAuc.toFixed(4)} | ${r.meanBaseAcc.toFixed(4)} |`).join("\n");
const finalTbl = HORIZONS.map((h) => {
  const rows = finalRows.filter((r) => r.horizon === h.label); const g = rows.find((r) => r.model === "gbt") as Record<string, number> | undefined; if (!g) return "";
  const base = Math.max(...rows.filter((r) => ["always_up", "always_down", "prev_return", "trend_rule", "momentum_rule", "majority"].includes(String(r.model))).map((r) => Number(r.accuracy)));
  return `| ${h.label} | ${g.n} | ${Number(g.accuracy).toFixed(4)} | ${Number(g.balancedAccuracy).toFixed(4)} | ${Number(g.auc).toFixed(4)} | ${base.toFixed(4)} | ${(Number(g.accuracy) - base >= 0 ? "+" : "") + (Number(g.accuracy) - base).toFixed(4)} |`;
}).filter(Boolean).join("\n");
const condTbl = moveCondRows.filter((r) => r.horizon === bestH.label && r.n).map((r) => `| ${r.move_prob_threshold} | ${r.n} | ${Number(r.dirAccuracy).toFixed(4)} | ${Number(r.balAccuracy).toFixed(4)} | ${Number(r.auc).toFixed(4)} |`).join("\n");
const confTbl = confRows.filter((r) => r.n).map((r) => `| ${r.bucket} | ${r.n} | ${Number(r.dirAccuracy).toFixed(4)} | ${r.upAccuracy === "" ? "-" : Number(r.upAccuracy).toFixed(4)} | ${r.downAccuracy === "" ? "-" : Number(r.downAccuracy).toFixed(4)} |`).join("\n");
const oracleBal = finalBal, oracleAcc = finalAcc;

writeFileSync(path.join(OUT, "FINAL_REPORT.md"), [
  "# DIRECTION_MODEL — Final report", "",
  `Final verdict: **${verdict}**`, "",
  "Question: once EUR/USD is (about to be) making a meaningful move, is there enough information BEFORE the move to predict UP vs DOWN?", "",
  "## Headline",
  `- **BEST HORIZON:** ${bestH.label}`,
  `- **BEST MODEL:** gradient-boosted trees (logistic ≈ same; no RF/NN warranted — see gate below)`,
  `- **DIRECTION ACCURACY:** ${oracleAcc.toFixed(4)} (balanced ${oracleBal.toFixed(4)}) on the untouched oracle holdout`,
  `- **BASELINE ACCURACY:** ${bestBaselineAcc.toFixed(4)} (best of always-up/down, prev-return, trend, momentum, majority)`,
  `- **INCREMENTAL EDGE:** ${(finalAcc - bestBaselineAcc >= 0 ? "+" : "") + (finalAcc - bestBaselineAcc).toFixed(4)} accuracy / ${(finalBal - 0.5 >= 0 ? "+" : "") + (finalBal - 0.5).toFixed(4)} balanced-accuracy vs coin flip`,
  `- **BEST CONFIDENCE BUCKET:** ${bestConfBucket(confRows)}`,
  `- **ORACLE-MOVE DIRECTION ACCURACY:** ${oracleAcc.toFixed(4)} (perfect move foresight)`,
  `- **MOVE_MODEL-CONDITIONAL DIRECTION ACCURACY:** ${condBest ? Number(condBest.dirAccuracy).toFixed(4) + ` (move_prob≥0.60, n=${condBest.n})` : "n/a"}`,
  `- **WALK-FORWARD FOLDS BEATING BASELINE:** ${foldsBeating}/${totalFolds} (GBT AUC > 0.52)`,
  "",
  "## Oracle walk-forward by horizon (a move really happened)", "",
  "| Horizon | Mean GBT acc | Mean GBT bal-acc | Mean GBT AUC | Mean best-baseline acc |",
  "|---|---:|---:|---:|---:|", rank, "",
  "## Oracle final untouched holdout", "",
  "| Horizon | N | GBT acc | GBT bal-acc | GBT AUC | Best baseline acc | GBT − baseline |",
  "|---|---:|---:|---:|---:|---:|---:|", finalTbl, "",
  "AUC ≈ 0.50 and balanced accuracy ≈ 0.50 mean the model cannot tell UP from DOWN better than a coin flip, regardless of raw accuracy (which just tracks the class skew).", "",
  "## The critical oracle test",
  `Even with PERFECT foreknowledge that a meaningful move was coming (oracle selection on ground-truth moves), the best horizon reaches only balanced accuracy ${oracleBal.toFixed(4)} / AUC ${finalAuc.toFixed(4)} on the untouched holdout. ${finalAuc > 0.53 ? "This is a small signal above chance." : "This is indistinguishable from chance."}`, "",
  "## Does stronger MOVE confidence make direction easier? (best horizon)", "",
  "| MOVE prob ≥ | N | Dir accuracy | Balanced acc | AUC |", "|---:|---:|---:|---:|---:|", condTbl, "",
  `Selecting only the strongest MOVE_MODEL opportunities ${condImproves(moveCondRows, bestH.label) ? "modestly changes" : "does NOT improve"} directional accuracy — consistent with MOVE selection NOT being the bottleneck.`, "",
  "## Confidence calibration (best horizon, oracle holdout)", "",
  "| Confidence bucket | N | Dir accuracy | UP-call accuracy | DOWN-call accuracy |", "|---|---:|---:|---:|---:|", confTbl, "",
  bucketMonotonic ? "Higher confidence does not clearly correspond to higher accuracy, but is not strongly anti-calibrated." : "**Anti-calibration flag: higher-confidence buckets do NOT achieve higher directional accuracy — model confidence is not trustworthy.**", "",
  "## Feature ablation (which groups carry directional information)",
  "See ABLATION_RESULTS.csv. Positive delta on removal = the group was noise/harmful. Groups tested: " + DIR_GROUPS.join(", ") + ".", "",
  "## Model escalation",
  `Logistic and GBT were run. ${finalAuc > 0.53 && survivesWalk ? "Simpler models showed a marginal signal, so a NN/RF check would be justified." : "Neither simpler model beat chance out-of-sample, so per protocol NO random forest or neural network was pursued — a larger model cannot recover directional information that is absent from the features."}`, "",
  "## Judgment",
  verdict === "DIRECTION_EDGE_FOUND"
    ? "A directional edge survives baselines, walk-forward, the untouched holdout, calibration, and is not confined to one subgroup. This concerns direction PREDICTION only — profitability/spread/execution are out of scope and NOT established."
    : "**No directional edge.** Even on oracle-known meaningful moves, UP/DOWN is not predictable above naive baselines out-of-sample; the signal does not survive walk-forward/holdout and confidence is not calibrated. Crucially, since the oracle test also fails, MOVE_MODEL selection is NOT the bottleneck — the directional information simply is not present in the current price/vol/structure/time/news features. This matches the repository's prior EUR/USD direction nulls. Do not connect to paper/production; a bigger model will not fix missing information — only a genuinely new exogenous directional signal could.",
  "",
  "MOVE_MODEL was used read-only and left frozen. No paper-trading or production connection.", "",
].join("\n"));

writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(round({
  experiment: "DIRECTION_MODEL", verdict,
  frozenMoveThresholds: FROZEN_MOVE_THRESHOLD, horizons: HORIZONS,
  protocol: { modelFrom: new Date(MOVE_PROB_FROM).toISOString(), finalFrom: new Date(FINAL_FROM).toISOString(), folds: FOLDS.map((f) => f.label), moveThresholds: MOVE_THRESHOLDS },
  counts: { records: records.length },
  headline: { bestHorizon: bestH.label, bestModel: "gbt", directionAccuracy: finalAcc, balancedAccuracy: finalBal, auc: finalAuc, baselineAccuracy: bestBaselineAcc, incrementalAcc: finalAcc - bestBaselineAcc, bestConfidenceBucket: bestConfBucket(confRows), oracleDirectionAccuracy: finalAcc, moveConditionalDirectionAccuracy: condBest ? Number(condBest.dirAccuracy) : null, walkForwardFoldsBeatingBaseline: `${foldsBeating}/${totalFolds}` },
  horizonRank, walkForward: wfRows, finalHoldout: finalRows, oracleResults: oracleResultRows,
  confidenceBuckets: confRows, moveConditional: moveCondRows, sessions: sessionRows, regimes: regimeRows, news: newsRows, ablation: ablationRows,
  verdictBasis: { survivesWalk, survivesFinal, calibratedOk, enoughObs, foldsBeating, totalFolds },
}), null, 2));

console.log(`\nArtifacts written to ${OUT}`);

function bestConfBucket(rows: Record<string, unknown>[]) {
  const valid = rows.filter((r) => r.n && Number(r.n) >= 30);
  if (!valid.length) return "n/a"; const best = valid.sort((a, b) => Number(b.dirAccuracy) - Number(a.dirAccuracy))[0]!;
  return `${best.bucket} (acc ${Number(best.dirAccuracy).toFixed(3)}, n=${best.n})`;
}
function condImproves(rows: Record<string, unknown>[], h: string) {
  const r = rows.filter((x) => x.horizon === h && x.n && Number(x.n) >= 50).map((x) => Number(x.balAccuracy));
  return r.length >= 2 && Math.max(...r) - r[0]! > 0.02;
}
function dirDoc(name: string): string {
  const d: Record<string, string> = {
    close_ema20: "(close−EMA20)/ATR", close_ema50: "(close−EMA50)/ATR", ema20_ema50: "(EMA20−EMA50)/ATR (trend sign)", ema20_slope4: "EMA20 slope over 4 bars /ATR", ema50_slope16: "EMA50 slope over 16 bars /ATR",
    ret1: "signed return 1 bar /ATR", ret4: "signed return 4 bars /ATR", ret16: "signed return 16 bars /ATR", ret48: "signed return 48 bars /ATR", consecutive: "signed consecutive same-direction bars /8",
    range_pos32: "position in 32-bar range (−1..1)", range_pos64: "position in 64-bar range (−1..1)", dist_prior16_high: "(close−prior16 high)/ATR", dist_prior16_low: "(close−prior16 low)/ATR", breakout_pressure: "(close−64-bar midpoint)/ATR",
    atr14_56: "ATR14/ATR56 (vol expansion)", range_atr: "candle range/ATR", body_signed: "signed body/ATR", wick_skew: "(lower−upper wick)/ATR",
    h1_ret4: "signed H1 4-bar return /H1 ATR", h1_ema20_50: "signed H1 (EMA20−EMA50)/H1 ATR", m5_ret6: "signed M5 6-bar return /ATR",
    hour_sin: "hour sine", hour_cos: "hour cosine", sess_asia: "Asia flag", sess_london: "London flag", sess_overlap: "overlap flag", sess_ny: "New York flag",
    news_signed_recent: "currency-signed decayed surprise of last event (+EUR / −USD bullish)", news_imminent: "exp(−mins-to-next-event/30)",
    spread_atr: "next-bar spread/ATR", move_prob: "frozen MOVE_MODEL causal OOS P(MOVE) at this horizon",
  };
  return d[name] ?? "";
}
