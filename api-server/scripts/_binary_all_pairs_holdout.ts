/**
 * Per-pair rules-with-holdout survey. Same shape as EUR_USD script but iterates
 * across all majors + AUD crosses, using consistent params (split=0.70,
 * minTrainN=30, trainWr>=65% or <=35%). Reports how many pockets survive at
 * >=65% holdout per pair.
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(serviceRoot, "research-v2", "binary-per-pair-holdout-v1");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const PAIRS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "AUD_JPY", "EUR_AUD", "GBP_JPY",
];
type Row = { instrument: string; direction: string; result: string; created_at: string; confidence: string | null };
const raw = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text, confidence::text
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
     AND instrument = ANY($1::text[])
`, [PAIRS])).rows;
raw.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "weekday")?.value ?? "?";
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}
function confBucket(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "na";
  if (v < 0.55) return "0.5-0.55";
  if (v < 0.60) return "0.55-0.60";
  if (v < 0.70) return "0.60-0.70";
  if (v < 0.80) return "0.70-0.80";
  if (v < 0.90) return "0.80-0.90";
  return "0.90+";
}

type Rule = { name: string; match: (r: Row) => boolean };
function makeRules(): Rule[] {
  const rules: Rule[] = [];
  for (let h = 0; h < 24; h++) rules.push({ name: `h${String(h).padStart(2, "0")}`, match: (r) => etHour(r.created_at) === h });
  for (let h = 0; h < 24; h++) for (const d of ["up", "down"] as const) rules.push({ name: `${d}/h${String(h).padStart(2, "0")}`, match: (r) => r.direction === d && etHour(r.created_at) === h });
  for (const d of ["up", "down"] as const) for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) rules.push({ name: `${d}/${day}`, match: (r) => r.direction === d && etDay(r.created_at) === day });
  for (const d of ["up", "down"] as const) for (const s of ["london", "overlap", "ny"]) rules.push({ name: `${d}/${s}`, match: (r) => r.direction === d && sessionOf(etHour(r.created_at)) === s });
  for (const d of ["up", "down"] as const) for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) for (const s of ["london", "overlap", "ny"]) rules.push({ name: `${d}/${day}/${s}`, match: (r) => r.direction === d && etDay(r.created_at) === day && sessionOf(etHour(r.created_at)) === s });
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) for (const cb of ["0.5-0.55", "0.55-0.60", "0.60-0.70", "0.70-0.80", "0.80-0.90", "0.90+"]) rules.push({ name: `${day}/${cb}`, match: (r) => etDay(r.created_at) === day && confBucket(r.confidence !== null ? Number(r.confidence) : null) === cb });
  return rules;
}
const allRules = makeRules();

const SPLIT = 0.70;
const MIN_TRAIN_N = 30;
const HI = 65;
const LO = 35;
const HOLDOUT_MIN_N = 10;
const HOLDOUT_TARGET = 65;

type PairSummary = {
  pair: string; total: number; train: number; holdout: number;
  selected: number; holdoutTestable: number; passing: number;
  passingPct: number; compositeN: number; compositeWinrate: number;
  survivors: Array<{ name: string; act: string; trainN: number; trainWr: number; holdN: number; holdWr: number }>;
};
const results: PairSummary[] = [];

for (const pair of PAIRS) {
  const pairRows = raw.filter((r) => r.instrument === pair);
  if (pairRows.length < 200) continue;
  const firstMs = Date.parse(pairRows[0]!.created_at);
  const lastMs = Date.parse(pairRows[pairRows.length - 1]!.created_at);
  const cutoffMs = firstMs + (lastMs - firstMs) * SPLIT;
  const train = pairRows.filter((r) => Date.parse(r.created_at) < cutoffMs);
  const holdout = pairRows.filter((r) => Date.parse(r.created_at) >= cutoffMs);

  type Sel = { rule: Rule; act: "follow" | "invert"; trainN: number; trainWr: number };
  const selected: Sel[] = [];
  for (const rule of allRules) {
    const matches = train.filter(rule.match);
    if (matches.length < MIN_TRAIN_N) continue;
    const w = matches.filter((r) => r.result === "won").length;
    const wr = 100 * w / matches.length;
    if (wr >= HI) selected.push({ rule, act: "follow", trainN: matches.length, trainWr: wr });
    else if (wr <= LO) selected.push({ rule, act: "invert", trainN: matches.length, trainWr: 100 - wr });
  }

  type Res = { name: string; act: "follow" | "invert"; trainN: number; trainWr: number; holdN: number; holdWr: number };
  const perRule: Res[] = selected.map((s) => {
    const matches = holdout.filter(s.rule.match);
    const w = matches.filter((r) => s.act === "follow" ? r.result === "won" : r.result === "lost").length;
    return {
      name: s.rule.name, act: s.act, trainN: s.trainN, trainWr: s.trainWr,
      holdN: matches.length, holdWr: matches.length ? 100 * w / matches.length : 0,
    };
  });
  const testable = perRule.filter((r) => r.holdN >= HOLDOUT_MIN_N);
  const passing = testable.filter((r) => r.holdWr >= HOLDOUT_TARGET);

  // composite winrate (dedup across selected rules — first-match wins)
  const decided = new Map<Row, "follow" | "invert">();
  for (const s of selected) for (const r of holdout) {
    if (!s.rule.match(r)) continue;
    if (!decided.has(r)) decided.set(r, s.act);
  }
  let cn = 0, cw = 0;
  for (const [r, act] of decided) {
    cn++;
    const won = act === "follow" ? r.result === "won" : r.result === "lost";
    if (won) cw++;
  }

  results.push({
    pair, total: pairRows.length, train: train.length, holdout: holdout.length,
    selected: selected.length, holdoutTestable: testable.length, passing: passing.length,
    passingPct: testable.length ? 100 * passing.length / testable.length : 0,
    compositeN: cn, compositeWinrate: cn ? 100 * cw / cn : 0,
    survivors: passing.filter((r) => r.holdN >= HOLDOUT_MIN_N).sort((a, b) => b.holdWr - a.holdWr),
  });
}

console.log(`=== PER-PAIR HOLDOUT (split=${SPLIT}, minTrainN=${MIN_TRAIN_N}, trainWr>=${HI}% or <=${LO}%, holdTarget=${HOLDOUT_TARGET}%, holdMinN=${HOLDOUT_MIN_N}) ===\n`);
console.log(`  pair       total  train  hold  selected  testable  passing  pass%  compositeWr%(n)`);
results.sort((a, b) => b.passingPct - a.passingPct);
for (const r of results) {
  console.log(`  ${r.pair.padEnd(10)}${String(r.total).padStart(4)}  ${String(r.train).padStart(4)}  ${String(r.holdout).padStart(4)}   ${String(r.selected).padStart(4)}     ${String(r.holdoutTestable).padStart(4)}     ${String(r.passing).padStart(3)}    ${r.passingPct.toFixed(1).padStart(5)}%    ${r.compositeWinrate.toFixed(1)}%(n=${r.compositeN})`);
}

console.log(`\n=== PAIRS WITH >= 1 SURVIVING POCKET ===`);
for (const r of results.filter((r) => r.survivors.length > 0)) {
  console.log(`\n  ${r.pair}  (${r.survivors.length} survivor pockets @ >=${HOLDOUT_TARGET}%):`);
  for (const s of r.survivors) console.log(`    ${s.name.padEnd(28)} ${s.act.padEnd(6)}  trainN=${s.trainN} trainWr=${s.trainWr.toFixed(1)}%  holdN=${s.holdN} holdWr=${s.holdWr.toFixed(1)}%`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify(results, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);
