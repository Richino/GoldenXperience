import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

type Row = {
  trade_sequence: number;
  instrument: string;
  direction: string;
  outcome: string;
  entry: string; stop: string; target: string; exit: string | null;
  planned_r: string; result_r: string | null;
  spread_pips: string;
  session: string; weekday: string; setup_name: string;
  checklist_score: string;
  max_favorable_r: string | null; max_adverse_r: string | null;
  opened_at: string; closed_at: string | null; exit_reason: string | null;
};

const { rows } = await query<Row>(`
  SELECT trade_sequence, instrument, direction, outcome, entry, stop, target, exit,
         planned_r, result_r, spread_pips, session, weekday, setup_name, checklist_score,
         max_favorable_r, max_adverse_r, opened_at, closed_at, exit_reason
    FROM paper_strategy_trades
   ORDER BY trade_sequence`);

const n = (v: string | null) => (v == null ? null : Number(v));
const t = rows.map((r) => ({
  ...r,
  planned_r: n(r.planned_r)!, result_r: n(r.result_r), spread_pips: n(r.spread_pips)!,
  mfe: n(r.max_favorable_r), mae: n(r.max_adverse_r), checklist: n(r.checklist_score),
}));

const N = t.length;
const wins = t.filter((r) => (r.result_r ?? 0) > 0);
const losses = t.filter((r) => (r.result_r ?? 0) < 0);
const flat = t.filter((r) => (r.result_r ?? 0) === 0);
const netR = t.reduce((s, r) => s + (r.result_r ?? 0), 0);
const grossWinR = wins.reduce((s, r) => s + (r.result_r ?? 0), 0);
const grossLossR = losses.reduce((s, r) => s + (r.result_r ?? 0), 0);

const pct = (x: number, d = N) => ((100 * x) / d).toFixed(1) + "%";
const f = (x: number, d = 3) => x.toFixed(d);

console.log(`\n===== ALL ${N} TRADES YOU TOOK =====`);
console.log(`Wins:   ${wins.length} (${pct(wins.length)})`);
console.log(`Losses: ${losses.length} (${pct(losses.length)})`);
console.log(`Flat:   ${flat.length} (${pct(flat.length)})`);
console.log(`Net result: ${f(netR)}R total  |  ${f(netR / N)}R per trade`);
console.log(`Gross winning R: +${f(grossWinR)}   Gross losing R: ${f(grossLossR)}`);
console.log(`Avg win: +${f(grossWinR / (wins.length || 1))}R   Avg loss: ${f(grossLossR / (losses.length || 1))}R`);
console.log(`Expectancy check: win% * avgWin + loss% * avgLoss = ${f(netR / N)}R/trade`);

// ---- Outcome buckets: HOW did they end ----
console.log(`\n----- HOW TRADES ENDED (outcome) -----`);
const byOutcome = new Map<string, { c: number; r: number }>();
for (const r of t) {
  const o = byOutcome.get(r.outcome) ?? { c: 0, r: 0 };
  o.c++; o.r += r.result_r ?? 0; byOutcome.set(r.outcome, o);
}
for (const [k, v] of [...byOutcome].sort((a, b) => b[1].c - a[1].c))
  console.log(`  ${k.padEnd(14)} count=${String(v.c).padStart(3)} (${pct(v.c)})  netR=${f(v.r)}  avg=${f(v.r / v.c)}`);

// ---- Spread cost: the memory hypothesis ----
console.log(`\n----- SPREAD COST vs EDGE -----`);
// risk in pips per trade = |entry-stop| in pips; spread as fraction of risk = spread_pips / riskPips
function pipsBetween(instrument: string, a: number, b: number) {
  const jpy = instrument.includes("JPY");
  return Math.abs(a - b) / (jpy ? 0.01 : 0.0001);
}
let spreadAsR = 0;
const detail = t.map((r) => {
  const riskPips = pipsBetween(r.instrument, Number(r.entry), Number(r.stop));
  const spreadR = riskPips > 0 ? r.spread_pips / riskPips : 0; // cost in R units at entry
  spreadAsR += spreadR;
  return { ...r, riskPips, spreadR };
});
console.log(`  Avg risk distance: ${f(detail.reduce((s, r) => s + r.riskPips, 0) / N, 1)} pips`);
console.log(`  Avg spread paid:   ${f(detail.reduce((s, r) => s + r.spread_pips, 0) / N, 2)} pips`);
console.log(`  Avg spread as R:   ${f(spreadAsR / N)}R per trade  (this is the round-trip cost drag)`);
console.log(`  Total spread drag: ${f(spreadAsR)}R over ${N} trades`);
console.log(`  >> If net is ${f(netR)}R and spread drag is ${f(spreadAsR)}R, gross-of-spread edge ≈ ${f(netR + spreadAsR)}R`);

// ---- MFE/MAE: did losers ever go your way? did winners give back? ----
console.log(`\n----- MFE / MAE (how far price went before the exit) -----`);
const haveMfe = detail.filter((r) => r.mfe != null && r.mae != null);
if (haveMfe.length) {
  const loseMfe = losses.map((r) => detail.find((d) => d.trade_sequence === r.trade_sequence)!).filter((r) => r.mfe != null);
  const winMfe = wins.map((r) => detail.find((d) => d.trade_sequence === r.trade_sequence)!).filter((r) => r.mfe != null);
  const avg = (a: any[], k: string) => (a.length ? a.reduce((s, r) => s + (r[k] ?? 0), 0) / a.length : 0);
  console.log(`  Losers: avg MFE +${f(avg(loseMfe, "mfe"))}R  (how far in profit before reversing)`);
  console.log(`  Losers: avg MAE ${f(avg(loseMfe, "mae"))}R`);
  console.log(`  Winners: avg MAE ${f(avg(winMfe, "mae"))}R  (how deep underwater before winning)`);
  const nearMiss = loseMfe.filter((r) => (r.mfe ?? 0) >= 0.8).length;
  console.log(`  Losers that reached >= +0.8R first then lost: ${nearMiss} (${pct(nearMiss, loseMfe.length)} of losers)`);
} else console.log("  (no MFE/MAE recorded)");

function group(key: (r: typeof detail[number]) => string, label: string) {
  console.log(`\n----- BY ${label} -----`);
  const m = new Map<string, { c: number; w: number; r: number; spr: number }>();
  for (const r of detail) {
    const k = key(r);
    const o = m.get(k) ?? { c: 0, w: 0, r: 0, spr: 0 };
    o.c++; if ((r.result_r ?? 0) > 0) o.w++; o.r += r.result_r ?? 0; o.spr += r.spreadR; m.set(k, o);
  }
  for (const [k, v] of [...m].sort((a, b) => a[1].r - b[1].r))
    console.log(`  ${k.padEnd(12)} n=${String(v.c).padStart(3)}  win%=${pct(v.w, v.c).padStart(6)}  netR=${f(v.r).padStart(8)}  avg=${f(v.r / v.c).padStart(7)}  spreadDrag=${f(v.spr)}R`);
}
group((r) => r.direction, "DIRECTION");
group((r) => r.instrument, "INSTRUMENT");
group((r) => r.session, "SESSION");
group((r) => r.weekday, "WEEKDAY");
group((r) => r.setup_name, "SETUP");

// ---- Checklist score vs outcome: did "quality" predict anything? ----
console.log(`\n----- CHECKLIST SCORE vs RESULT -----`);
const wq = wins.reduce((s, r) => s + (r.checklist ?? 0), 0) / (wins.length || 1);
const lq = losses.reduce((s, r) => s + (r.checklist ?? 0), 0) / (losses.length || 1);
console.log(`  Avg checklist score of winners: ${f(wq, 2)}   of losers: ${f(lq, 2)}  (gap ${f(wq - lq, 2)})`);

// ---- Worst trades ----
console.log(`\n----- 10 WORST TRADES -----`);
for (const r of [...detail].sort((a, b) => (a.result_r ?? 0) - (b.result_r ?? 0)).slice(0, 10))
  console.log(`  #${r.trade_sequence} ${r.instrument} ${r.direction} ${r.outcome} result=${f(r.result_r ?? 0)}R mfe=${r.mfe ?? "-"} spread=${r.spread_pips}p risk=${f(r.riskPips, 1)}p ${r.session}/${r.weekday}`);

process.exit(0);
