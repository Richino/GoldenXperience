/**
 * TP/SL grid on breakout-confidence-v1's flipped trades.
 *
 * For each grid cell (newTargetR, newStopR), we recompute what would have
 * happened on the inverted trades using the ORIGINAL opportunity's MFE / MAE
 * plus the original outcome to disambiguate which side got hit first when both
 * levels are inside the excursion.
 *
 * When we FLIP direction (long -> short or vice versa):
 *   flipped_favorable_excursion = original MAE
 *   flipped_adverse_excursion   = original MFE
 *
 * Resolution rules for a flipped trade with target T (R units) and stop S:
 *   - if orig outcome was "stop_first" (mae hit first):
 *       flipped would hit TARGET if T <= mae, provided S > mfe (or T <= mae reached before mfe = S)
 *       Approximation: order is preserved — the direction that hit first (mae) is now favorable, hits first.
 *       So target hit if T <= mae; else if S <= mfe stop hit; else forced_close.
 *   - if orig outcome was "target_first" (mfe hit first): mfe is now adverse and hits first
 *       stop hit if S <= mfe; else if T <= mae target hit; else forced_close.
 *   - if orig outcome was "forced_close": neither TP/SL was hit — assume same forced_close R,
 *       scaled by newTargetR/originalTargetR if positive, or newStopR/originalStopR if negative.
 *
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPP_FILE = path.join(serviceRoot, "research-v2", "four-family-adaptive-historical-v1", "opportunities.jsonl");
const OUT_DIR = path.join(serviceRoot, "research-v2", "confidence-breakout-tp-sl-grid-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Opp = {
  ms: number; ts: string; family: string; pair: string; direction: "long" | "short";
  entry: number; stop: number; target: number; plannedR: number;
  quality: number; spreadPips: number; atrPips: number;
  session: string; regime: string; trendStrength: number; volBucket: string;
  outcome: string; netR: number; costR: number;
  mfe: number; // R units — max favorable excursion in original direction
  mae: number; // R units — max adverse excursion in original direction
};

const raw = readFileSync(OPP_FILE, "utf8").trim().split("\n").filter(Boolean);
const rows: Opp[] = raw.map((line) => JSON.parse(line))
  .filter((r: Opp) => r.family === "breakout" && Number.isFinite(r.netR) && Number.isFinite(r.mfe) && Number.isFinite(r.mae));
rows.sort((a, b) => a.ms - b.ms);
console.log(`breakout opportunities with excursions: ${rows.length}`);

function etHour(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(ms));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function longWon(r: Opp): 1 | 0 {
  return ((r.direction === "long" && r.netR > 0) || (r.direction === "short" && r.netR < 0)) ? 1 : 0;
}

const SESSIONS = ["London", "New York", "London/New York overlap", "Off"];
const REGIMES = ["trending", "ranging", "mixed"];
const VOL_BUCKETS = ["low", "normal", "high"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const FEATURE_NAMES = [
  ...SESSIONS.map((s) => `session_${s.replace(/[^A-Za-z]/g, "")}`),
  ...REGIMES.map((r) => `regime_${r}`),
  ...VOL_BUCKETS.map((v) => `vol_${v}`),
  ...PAIRS.map((p) => `pair_${p}`),
  "trendStrength", "atrPips", "spreadPips", "quality", "hourEt", "dayOfWeek",
];
function vec(r: Opp): number[] {
  return [
    ...SESSIONS.map((s) => r.session === s ? 1 : 0),
    ...REGIMES.map((rg) => r.regime === rg ? 1 : 0),
    ...VOL_BUCKETS.map((v) => r.volBucket === v ? 1 : 0),
    ...PAIRS.map((p) => r.pair === p ? 1 : 0),
    r.trendStrength, r.atrPips, r.spreadPips, r.quality, etHour(r.ms), etDay(r.ms),
  ];
}
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Opp[]) {
  const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, f) => s + vec(f)[k]!, 0) / IS.length);
  const std = new Array(K).fill(0).map((_, k) => {
    const m = mean[k]!;
    const v = IS.reduce((s, f) => s + (vec(f)[k]! - m) ** 2, 0) / IS.length;
    return Math.sqrt(v) || 1;
  });
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.05, epochs = 300, l2 = 0.001;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  for (let ep = 0; ep < epochs; ep++) {
    const grads = new Array(K).fill(0);
    let gb = 0;
    for (const r of IS) {
      const x = vec(r).map((v, k) => (v - mean[k]!) / std[k]!);
      const y = longWon(r);
      const p = sig(x.reduce((s, xi, k) => s + xi * w[k]!, 0) + b);
      const err = p - y;
      for (let k = 0; k < K; k++) grads[k] += err * x[k]!;
      gb += err;
    }
    for (let k = 0; k < K; k++) w[k] = w[k]! - lr * (grads[k]! / IS.length + l2 * w[k]!);
    b = b - lr * (gb / IS.length);
  }
  return { w, b, mean, std };
}
function predict(r: Opp, m: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = vec(r).map((v, k) => (v - m.mean[k]!) / m.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * m.w[k]!, 0) + m.b;
  return 1 / (1 + Math.exp(-z));
}

/**
 * Resolve a flipped trade at new (targetR, stopR) using original mfe/mae + outcome.
 * Returns the new R value, or null if ambiguous.
 */
function resolveFlipped(r: Opp, newTargetR: number, newStopR: number): number {
  // For the flipped direction:
  //   flipped_favorable = orig mae
  //   flipped_adverse   = orig mfe
  const favor = r.mae;
  const adver = r.mfe;

  // Original stop distance was 1R; original target was plannedR (2R for breakout).
  const origTargetR = Math.abs(r.plannedR); // 2
  const origStopR = 1;

  const targetHitOrig = favor >= newTargetR;
  const stopHitOrig = adver >= newStopR;

  if (targetHitOrig && !stopHitOrig) return newTargetR;
  if (!targetHitOrig && stopHitOrig) return -newStopR;
  if (!targetHitOrig && !stopHitOrig) {
    // Neither level was reached even considering excursions → forced_close.
    // Approximate final R by scaling original netR to the new stop/target geometry.
    // If original ended positive on the flipped side, scale by newTargetR/origTargetR.
    // If negative, scale by newStopR/origStopR.
    const flippedNet = -r.netR;
    if (flippedNet > 0) return flippedNet * (newTargetR / origTargetR);
    return flippedNet * (newStopR / origStopR);
  }
  // Both would be hit — disambiguate by original outcome.
  // orig "stop_first" → mae hit first → for flipped, favor (was mae) hit first → target
  // orig "target_first" → mfe hit first → for flipped, adver (was mfe) hit first → stop
  // orig "forced_close" → assume tied, take the closer to entry as first
  if (r.outcome === "stop_first") return newTargetR;
  if (r.outcome === "target_first") return -newStopR;
  // fallback: whichever is closer as an R-multiple
  return newTargetR <= newStopR ? newTargetR : -newStopR;
}

// Walk-forward with a fixed grid — compute total R for combined-rule flipped trades
// at each (target, stop) cell.
const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 12;
const TEST_MONTHS = 3;
const CONF_T = 0.10;

const TARGETS = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const STOPS = [0.5, 0.75, 1.0, 1.25, 1.5];

type CellStat = { targetR: number; stopR: number; n: number; wins: number; totalR: number; expR: number; winrate: number };
const cells: Record<string, CellStat> = {};
for (const t of TARGETS) for (const s of STOPS) cells[`${t}|${s}`] = { targetR: t, stopR: s, n: 0, wins: 0, totalR: 0, expR: 0, winrate: 0 };

const firstMs = rows[0]!.ms;
const lastMs = rows[rows.length - 1]!.ms;
let testStart = firstMs + TRAIN_MONTHS * MS_MONTH;
let windowCount = 0;

while (testStart + TEST_MONTHS * MS_MONTH <= lastMs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const trainEnd = testStart;
  const testEnd = testStart + TEST_MONTHS * MS_MONTH;
  const train = rows.filter((r) => r.ms >= trainStart && r.ms < trainEnd);
  const test = rows.filter((r) => r.ms >= testStart && r.ms < testEnd);
  if (train.length < 100 || test.length < 20) { testStart += TEST_MONTHS * MS_MONTH; continue; }
  const model = trainLogistic(train);
  windowCount++;
  for (const r of test) {
    const pLong = predict(r, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked === r.direction || Math.abs(pLong - 0.5) < CONF_T) continue;
    // flip this trade at each cell
    for (const t of TARGETS) for (const s of STOPS) {
      const rNew = resolveFlipped(r, t, s);
      const cell = cells[`${t}|${s}`]!;
      cell.n++;
      cell.totalR += rNew;
      if (rNew > 0) cell.wins++;
    }
  }
  testStart += TEST_MONTHS * MS_MONTH;
}

for (const k of Object.keys(cells)) {
  const c = cells[k]!;
  c.expR = c.n ? c.totalR / c.n : 0;
  c.winrate = c.n ? 100 * c.wins / c.n : 0;
}

console.log(`\nwalk-forward: ${windowCount} windows, TRAIN=${TRAIN_MONTHS}mo TEST=${TEST_MONTHS}mo CONF_T=${CONF_T}`);
console.log(`\nTP/SL GRID — total R per cell (only flipped confident trades):`);
console.log(`               SL=0.5R    SL=0.75R   SL=1.0R    SL=1.25R   SL=1.5R`);
for (const t of TARGETS) {
  const cells_row = STOPS.map((s) => cells[`${t}|${s}`]!);
  const line = cells_row.map((c) => (c.totalR >= 0 ? "+" : "") + c.totalR.toFixed(2).padStart(7)).join("  ");
  console.log(`  TP=${t.toFixed(2)}R  ${line}`);
}
console.log(`\nTP/SL GRID — expR/trade:`);
console.log(`               SL=0.5R    SL=0.75R   SL=1.0R    SL=1.25R   SL=1.5R`);
for (const t of TARGETS) {
  const cells_row = STOPS.map((s) => cells[`${t}|${s}`]!);
  const line = cells_row.map((c) => (c.expR >= 0 ? "+" : "") + c.expR.toFixed(4).padStart(7)).join("  ");
  console.log(`  TP=${t.toFixed(2)}R  ${line}`);
}
console.log(`\nTP/SL GRID — winrate %:`);
console.log(`               SL=0.5R    SL=0.75R   SL=1.0R    SL=1.25R   SL=1.5R`);
for (const t of TARGETS) {
  const cells_row = STOPS.map((s) => cells[`${t}|${s}`]!);
  const line = cells_row.map((c) => c.winrate.toFixed(1).padStart(6) + "%").join("     ");
  console.log(`  TP=${t.toFixed(2)}R  ${line}`);
}

// Sort cells by totalR descending
const sortedCells = Object.values(cells).sort((a, b) => b.totalR - a.totalR);
console.log(`\n=== TOP 5 CELLS BY TOTAL R ===`);
for (const c of sortedCells.slice(0, 5)) {
  console.log(`  TP=${c.targetR}R SL=${c.stopR}R: n=${c.n} wr=${c.winrate.toFixed(1)}% totalR=${c.totalR >= 0 ? "+" : ""}${c.totalR.toFixed(2)} expR=${c.expR.toFixed(4)}`);
}
console.log(`\n=== BOTTOM 5 CELLS ===`);
for (const c of sortedCells.slice(-5)) {
  console.log(`  TP=${c.targetR}R SL=${c.stopR}R: n=${c.n} wr=${c.winrate.toFixed(1)}% totalR=${c.totalR >= 0 ? "+" : ""}${c.totalR.toFixed(2)} expR=${c.expR.toFixed(4)}`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  params: { TRAIN_MONTHS, TEST_MONTHS, CONF_T, TARGETS, STOPS, windows: windowCount },
  cells: Object.values(cells),
  sortedByTotalR: sortedCells,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);
