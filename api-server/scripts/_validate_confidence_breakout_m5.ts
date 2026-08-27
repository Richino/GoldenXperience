/**
 * Deep validation for the M5 breakout confidence filter.
 * RESEARCH ONLY. Runs on the existing walk-forward OOS to slice results by
 * year, pair, session, and applies added slippage costs to test robustness.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(serviceRoot, "..");
const TRADES = path.join(REPO_ROOT, "backtest-breakout-m5", "trades.json");
const OUT_DIR = path.join(serviceRoot, "research-v2", "confidence-breakout-m5-validation-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Trade = {
  pair: string; direction: "long" | "short"; decisionTime: string;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number; spreadPips: number;
  outcome: string; resultR: number | null; stopPips: number;
};
const raw = JSON.parse(readFileSync(TRADES, "utf8")) as { trades: Trade[] };
const trades = raw.trades.filter((t) => t.resultR !== null && Number.isFinite(t.resultR!));
trades.sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime));
console.log(`M5 trades: ${trades.length}`);

function etDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}
function longWon(t: Trade): 1 | 0 {
  return ((t.direction === "long" && t.resultR! > 0) || (t.direction === "short" && t.resultR! < 0)) ? 1 : 0;
}
function year(iso: string): number { return new Date(iso).getUTCFullYear(); }

const SESSIONS = ["london", "overlap", "ny", "off"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const FEATURE_NAMES = [
  ...SESSIONS.map((s) => `session_${s}`),
  ...PAIRS.map((p) => `pair_${p}`),
  "atrPips", "rangeWidthAtr", "spreadPips", "hourEt", "dayOfWeek",
];
function vec(t: Trade): number[] {
  const s = sessionOf(t.sessionHourEt);
  return [
    ...SESSIONS.map((sn) => s === sn ? 1 : 0),
    ...PAIRS.map((p) => t.pair === p ? 1 : 0),
    t.atrPips, t.rangeWidthAtr, t.spreadPips, t.sessionHourEt, etDay(t.decisionTime),
  ];
}
const K = FEATURE_NAMES.length;

function trainLogistic(IS: Trade[]) {
  const mean = new Array(K).fill(0).map((_, k) => IS.reduce((s, t) => s + vec(t)[k]!, 0) / IS.length);
  const std = new Array(K).fill(0).map((_, k) => {
    const m = mean[k]!;
    const v = IS.reduce((s, t) => s + (vec(t)[k]! - m) ** 2, 0) / IS.length;
    return Math.sqrt(v) || 1;
  });
  const w = new Array(K).fill(0);
  let b = 0;
  const lr = 0.05, epochs = 300, l2 = 0.001;
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  for (let ep = 0; ep < epochs; ep++) {
    const grads = new Array(K).fill(0);
    let gb = 0;
    for (const t of IS) {
      const x = vec(t).map((v, k) => (v - mean[k]!) / std[k]!);
      const y = longWon(t);
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
function predict(t: Trade, m: { w: number[]; b: number; mean: number[]; std: number[] }): number {
  const x = vec(t).map((v, k) => (v - m.mean[k]!) / m.std[k]!);
  const z = x.reduce((s, xi, k) => s + xi * m.w[k]!, 0) + m.b;
  return 1 / (1 + Math.exp(-z));
}

// Rerun walk-forward and record ALL taken trades (CONF_T=0.00, take every disagreement)
const MS_MONTH = 30 * 86400e3;
const TRAIN_MONTHS = 6;
const TEST_MONTHS = 2;
const firstMs = Date.parse(trades[0]!.decisionTime);
const lastMs = Date.parse(trades[trades.length - 1]!.decisionTime);

type TakenTrade = { trade: Trade; impR: number; win: boolean };
const takenAll: TakenTrade[] = [];

let testStart = firstMs + TRAIN_MONTHS * MS_MONTH;
while (testStart + TEST_MONTHS * MS_MONTH <= lastMs + MS_MONTH) {
  const trainStart = testStart - TRAIN_MONTHS * MS_MONTH;
  const train = trades.filter((t) => Date.parse(t.decisionTime) >= trainStart && Date.parse(t.decisionTime) < testStart);
  const test = trades.filter((t) => Date.parse(t.decisionTime) >= testStart && Date.parse(t.decisionTime) < testStart + TEST_MONTHS * MS_MONTH);
  if (train.length < 300 || test.length < 100) { testStart += TEST_MONTHS * MS_MONTH; continue; }
  const model = trainLogistic(train);
  for (const t of test) {
    const pLong = predict(t, model);
    const picked: "long" | "short" = pLong >= 0.5 ? "long" : "short";
    if (picked === t.direction) continue;
    const impR = -t.resultR!;
    takenAll.push({ trade: t, impR, win: impR > 0 });
  }
  testStart += TEST_MONTHS * MS_MONTH;
}

const totalN = takenAll.length;
const totalR = takenAll.reduce((s, x) => s + x.impR, 0);
const totalWins = takenAll.filter((x) => x.win).length;
console.log(`\nCONF_T=0.00 taken: ${totalN}  winrate=${(100 * totalWins / totalN).toFixed(1)}%  totalR=${totalR.toFixed(2)}  expR=${(totalR / totalN).toFixed(4)}`);

// ---- 1. Per-year breakdown ----
console.log(`\n=== PER-YEAR ===`);
console.log(`  year   n     winrate   totalR   expR`);
const byYear = new Map<number, TakenTrade[]>();
for (const t of takenAll) {
  const y = year(t.trade.decisionTime);
  if (!byYear.has(y)) byYear.set(y, []);
  byYear.get(y)!.push(t);
}
for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const R = rows.reduce((s, r) => s + r.impR, 0);
  console.log(`  ${y}   ${String(n).padStart(4)}   ${(100 * wins / n).toFixed(1).padStart(5)}%   ${R >= 0 ? "+" : ""}${R.toFixed(2).padStart(7)}   ${(R / n).toFixed(4)}`);
}

// ---- 2. Per-pair breakdown ----
console.log(`\n=== PER-PAIR ===`);
console.log(`  pair       n     winrate   totalR   expR`);
const byPair = new Map<string, TakenTrade[]>();
for (const t of takenAll) {
  const p = t.trade.pair;
  if (!byPair.has(p)) byPair.set(p, []);
  byPair.get(p)!.push(t);
}
for (const [p, rows] of byPair) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const R = rows.reduce((s, r) => s + r.impR, 0);
  console.log(`  ${p.padEnd(9)}  ${String(n).padStart(4)}   ${(100 * wins / n).toFixed(1).padStart(5)}%   ${R >= 0 ? "+" : ""}${R.toFixed(2).padStart(7)}   ${(R / n).toFixed(4)}`);
}

// ---- 3. Per-session breakdown ----
console.log(`\n=== PER-SESSION ===`);
console.log(`  session    n     winrate   totalR   expR`);
const bySession = new Map<string, TakenTrade[]>();
for (const t of takenAll) {
  const s = sessionOf(t.trade.sessionHourEt);
  if (!bySession.has(s)) bySession.set(s, []);
  bySession.get(s)!.push(t);
}
for (const s of ["london", "overlap", "ny", "off"]) {
  const rows = bySession.get(s) ?? [];
  if (!rows.length) continue;
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const R = rows.reduce((s, r) => s + r.impR, 0);
  console.log(`  ${s.padEnd(9)}  ${String(n).padStart(4)}   ${(100 * wins / n).toFixed(1).padStart(5)}%   ${R >= 0 ? "+" : ""}${R.toFixed(2).padStart(7)}   ${(R / n).toFixed(4)}`);
}

// ---- 4. Slippage stress test ----
// Add X pips slippage as a % of stop distance (per-trade cost in R)
console.log(`\n=== SLIPPAGE STRESS TEST ===`);
console.log(`  extra_pips  effective_expR   winners_below_breakeven   totalR_after_cost`);
for (const extraPips of [0, 0.2, 0.5, 1.0, 2.0, 3.0]) {
  let sumR = 0;
  let wins = 0;
  for (const t of takenAll) {
    const costR = t.trade.stopPips > 0 ? extraPips / t.trade.stopPips : 0;
    const netR = t.impR - costR;
    sumR += netR;
    if (netR > 0) wins++;
  }
  const expR = sumR / takenAll.length;
  console.log(`  +${extraPips.toFixed(1)}p       ${expR.toFixed(4).padStart(7)}         ${(100 * wins / takenAll.length).toFixed(1).padStart(5)}%             ${sumR >= 0 ? "+" : ""}${sumR.toFixed(2)}`);
}

// ---- 5. Regime split (winning-year vs losing-year comparison) ----
console.log(`\n=== CUMULATIVE EQUITY CURVE BY MONTH ===`);
console.log(`  month      trades    R_month   R_cumulative`);
const byMonth = new Map<string, TakenTrade[]>();
for (const t of takenAll) {
  const k = t.trade.decisionTime.slice(0, 7); // YYYY-MM
  if (!byMonth.has(k)) byMonth.set(k, []);
  byMonth.get(k)!.push(t);
}
let cum = 0;
let worstMonth = { month: "", R: 0 };
let bestMonth = { month: "", R: 0 };
for (const [m, rows] of [...byMonth.entries()].sort()) {
  const monthR = rows.reduce((s, r) => s + r.impR, 0);
  cum += monthR;
  if (monthR < worstMonth.R) worstMonth = { month: m, R: monthR };
  if (monthR > bestMonth.R) bestMonth = { month: m, R: monthR };
  console.log(`  ${m}     ${String(rows.length).padStart(4)}      ${monthR >= 0 ? "+" : ""}${monthR.toFixed(2).padStart(7)}    ${cum >= 0 ? "+" : ""}${cum.toFixed(2)}`);
}
console.log(`\nBest month:  ${bestMonth.month} = ${bestMonth.R >= 0 ? "+" : ""}${bestMonth.R.toFixed(2)}R`);
console.log(`Worst month: ${worstMonth.month} = ${worstMonth.R >= 0 ? "+" : ""}${worstMonth.R.toFixed(2)}R`);
const winMonths = [...byMonth.values()].filter((rows) => rows.reduce((s, r) => s + r.impR, 0) > 0).length;
const totalMonths = byMonth.size;
console.log(`Winning months: ${winMonths} / ${totalMonths} (${(100 * winMonths / totalMonths).toFixed(1)}%)`);

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  totalTaken: totalN,
  totalR,
  winrate: 100 * totalWins / totalN,
  perYear: [...byYear.entries()].map(([y, rows]) => ({ year: y, n: rows.length, totalR: rows.reduce((s, r) => s + r.impR, 0), winrate: 100 * rows.filter((r) => r.win).length / rows.length })),
  perPair: [...byPair.entries()].map(([p, rows]) => ({ pair: p, n: rows.length, totalR: rows.reduce((s, r) => s + r.impR, 0), winrate: 100 * rows.filter((r) => r.win).length / rows.length })),
  perSession: [...bySession.entries()].map(([s, rows]) => ({ session: s, n: rows.length, totalR: rows.reduce((s2, r) => s2 + r.impR, 0), winrate: 100 * rows.filter((r) => r.win).length / rows.length })),
  monthsWinning: winMonths, monthsTotal: totalMonths, bestMonth, worstMonth,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);
