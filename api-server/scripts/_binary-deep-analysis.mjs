import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Load DATABASE_URL from .env / .env.local without extra deps.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.resolve("./.env"));
loadEnv(path.resolve("./.env.local"));

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rows: preds } = await client.query(`
  SELECT instrument, direction, status, result, confidence::float AS confidence,
         model_version, start_at, intended_expiration, duration_seconds,
         entry_price::float AS entry_price, resolution_price::float AS resolution_price,
         resolution_source, features, market_context, secondary_marks, created_at, error_reason
  FROM binary_predictions
  WHERE is_shadow=false
  ORDER BY created_at ASC
`);

const R = preds.filter((p) => p.status === "resolved" && p.result);
const won = R.filter((p) => p.result === "won").length;
const lost = R.filter((p) => p.result === "lost").length;
const tie = R.filter((p) => p.result === "tie").length;
const decided = won + lost;

// Wilson 95% CI for a binomial proportion — honest error bars on win rate.
function wilson(w, n) {
  if (n === 0) return [null, null];
  const z = 1.96, p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [(c - m) / d, (c + m) / d];
}
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);
const line = (s) => console.log(s);

line("=".repeat(64));
line("BINARY PREDICTION DEEP ANALYSIS");
line("=".repeat(64));
line(`Total logged:  ${preds.length}`);
line(`Resolved:      ${R.length}  (${won}W / ${lost}L / ${tie}T)`);
line(`Active:        ${preds.filter((p) => p.status === "active").length}`);
line(`Voided/error:  ${preds.filter((p) => p.status === "error").length}`);
if (decided > 0) {
  const [lo, hi] = wilson(won, decided);
  line(`\nDecided win rate: ${pct(won / decided)}  (95% CI ${pct(lo)}–${pct(hi)}, n=${decided})`);
  line(`  → coin-flip is 50%. If the CI straddles 50%, there is no proven edge yet.`);
}
if (preds.length) {
  const first = new Date(preds[0].created_at), last = new Date(preds[preds.length - 1].created_at);
  const days = Math.max(1, (last - first) / 86400000);
  line(`\nWindow: ${first.toISOString().slice(0, 10)} → ${last.toISOString().slice(0, 10)}  (${days.toFixed(0)} days, ~${(preds.length / days).toFixed(1)}/day)`);
}

// Generic grouping helper.
function group(rows, keyFn, minDecided = 1) {
  const m = new Map();
  for (const p of rows) {
    const k = keyFn(p);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, { won: 0, lost: 0, tie: 0 });
    const g = m.get(k);
    if (p.result === "won") g.won++;
    else if (p.result === "lost") g.lost++;
    else if (p.result === "tie") g.tie++;
  }
  return [...m.entries()]
    .map(([k, g]) => {
      const d = g.won + g.lost;
      const [lo, hi] = wilson(g.won, d);
      return { k, ...g, decided: d, wr: d ? g.won / d : null, lo, hi };
    })
    .filter((r) => r.decided >= minDecided);
}
function table(title, rows, sortBy = "decided") {
  line(`\n${title}`);
  const sorted = rows.sort((a, b) => (sortBy === "wr" ? (b.wr ?? -1) - (a.wr ?? -1) : b.decided - a.decided));
  for (const r of sorted) {
    const flag = r.decided >= 30 ? "✓" : r.decided >= 12 ? "·" : "°";
    const ci = r.decided ? ` [${pct(r.lo)}-${pct(r.hi)}]` : "";
    line(`  ${flag} ${String(r.k).padEnd(18)} ${pct(r.wr).padStart(4)}  (${r.won}W/${r.lost}L/${r.tie}T, n=${r.decided})${ci}`);
  }
}

table("BY INSTRUMENT (✓≥30 decided, ·≥12, °<12)", group(R, (p) => p.instrument));
table("BY DIRECTION", group(R, (p) => p.direction.toUpperCase()));
table("BY SESSION", group(R, (p) => p.market_context?.session ?? "Unknown"));

// Confidence calibration: does a higher score actually mean a higher win rate?
line("\nCONFIDENCE CALIBRATION (is the score meaningful?)");
const conf = group(R, (p) => {
  const b = Math.floor(p.confidence / 0.05) * 0.05;
  return `${b.toFixed(2)}-${(b + 0.05).toFixed(2)}`;
}).sort((a, b) => parseFloat(a.k) - parseFloat(b.k));
for (const r of conf) {
  const flag = r.decided >= 30 ? "✓" : r.decided >= 12 ? "·" : "°";
  line(`  ${flag} ${r.k}  ${pct(r.wr).padStart(4)}  (${r.won}W/${r.lost}L, n=${r.decided})`);
}
// Correlation between confidence and outcome (point-biserial-ish).
const dR = R.filter((p) => p.result !== "tie").map((p) => ({ c: p.confidence, y: p.result === "won" ? 1 : 0 }));
if (dR.length > 3) {
  const mc = dR.reduce((s, x) => s + x.c, 0) / dR.length;
  const my = dR.reduce((s, x) => s + x.y, 0) / dR.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const x of dR) { sxy += (x.c - mc) * (x.y - my); sxx += (x.c - mc) ** 2; syy += (x.y - my) ** 2; }
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  line(`\n  Confidence↔win correlation: ${r.toFixed(3)}  ${Math.abs(r) < 0.05 ? "→ score carries ~no signal (it's noise)" : Math.abs(r) < 0.15 ? "→ very weak signal" : "→ some signal"}`);
  const avgW = R.filter((p) => p.result === "won").reduce((s, p) => s + p.confidence, 0) / (won || 1);
  const avgL = R.filter((p) => p.result === "lost").reduce((s, p) => s + p.confidence, 0) / (lost || 1);
  line(`  Avg confidence  wins ${avgW.toFixed(3)}  vs  losses ${avgL.toFixed(3)}  (Δ ${(avgW - avgL).toFixed(3)})`);
}

// Horizon comparison from secondary marks: would 5m or 15m have done better?
line("\nHORIZON COMPARISON (same predictions, scored at 5m/10m/15m)");
for (const sec of [300, 600, 900]) {
  let w = 0, l = 0, t = 0, miss = 0;
  for (const p of R) {
    const res = sec === p.duration_seconds ? p.result : p.secondary_marks?.[`${sec}s`]?.result ?? null;
    if (res === "won") w++;
    else if (res === "lost") l++;
    else if (res === "tie") t++;
    else miss++;
  }
  const d = w + l;
  const [lo, hi] = wilson(w, d);
  line(`  ${sec === 600 ? "→" : " "} ${(sec / 60).toString().padStart(2)}m  ${pct(d ? w / d : null).padStart(4)}  (${w}W/${l}L/${t}T, n=${d})${d ? ` [${pct(lo)}-${pct(hi)}]` : ""}${miss ? `  ${miss} missing` : ""}`);
}

// Tie rate — a high tie rate means the 10m horizon is too short to move.
line(`\nTIE RATE: ${pct(tie / (R.length || 1))} of resolved (${tie}/${R.length})`);
line(`  High ties = horizon too short for price to travel past entry at this precision.`);

// Movement magnitude: how far did price actually go, in pips, at resolution?
const moves = R.filter((p) => p.entry_price && p.resolution_price && p.features).map((p) => {
  const pip = p.instrument.includes("JPY") ? 0.01 : 0.0001;
  const signed = (p.resolution_price - p.entry_price) / pip;
  const correct = p.direction === "up" ? signed : -signed;
  return { correct, abs: Math.abs(signed), atr: p.features?.atrPips ?? null };
});
if (moves.length) {
  const avgAbs = moves.reduce((s, m) => s + m.abs, 0) / moves.length;
  const avgEdge = moves.reduce((s, m) => s + m.correct, 0) / moves.length;
  line(`\nMOVEMENT: avg |move| ${avgAbs.toFixed(1)} pips over 10m; avg signed edge ${avgEdge >= 0 ? "+" : ""}${avgEdge.toFixed(2)} pips`);
  line(`  Signed edge is pips-in-predicted-direction. ~0 or negative = predictions aren't catching direction.`);
}

// Concentration: how many predictions per instrument — is data lopsided?
line("\nSAMPLE CONCENTRATION (data-volume goal — where are the gaps?)");
const perInst = group(preds.filter((p) => p.status === "resolved"), (p) => p.instrument).sort((a, b) => (b.won + b.lost + b.tie) - (a.won + a.lost + a.tie));
for (const r of perInst) line(`  ${String(r.k).padEnd(18)} ${r.won + r.lost + r.tie} resolved`);

await client.end();
line("\n" + "=".repeat(64));
