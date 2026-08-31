/**
 * Same-shape rules-with-holdout, sweeping the selection parameters.
 * Goal: find a param combo where the MAJORITY of surviving pockets
 * hit >=65% winrate on the hold-out.
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(serviceRoot, "research-v2", "binary-eurusd-rules-v2-paramsweep");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Row = { direction: string; result: string; created_at: string; confidence: string | null };
const raw = (await query<Row>(`
  SELECT direction, result, created_at::text, confidence::text
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
     AND instrument = 'EUR_USD'
`)).rows;
raw.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
const firstMs = Date.parse(raw[0]!.created_at);
const lastMs = Date.parse(raw[raw.length - 1]!.created_at);
console.log(`EUR_USD: ${raw.length} predictions across ${((lastMs - firstMs) / 86400e3).toFixed(1)} days`);

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
console.log(`candidate rules: ${allRules.length}\n`);

function trySplit(splitFraction: number, minTrainN: number, hi: number, lo: number, holdoutTargetWr: number, holdoutMinN: number) {
  const cutoffMs = firstMs + (lastMs - firstMs) * splitFraction;
  const train = raw.filter((r) => Date.parse(r.created_at) < cutoffMs);
  const holdout = raw.filter((r) => Date.parse(r.created_at) >= cutoffMs);

  type Sel = { rule: Rule; action: "follow" | "invert"; trainN: number; trainWr: number };
  const selected: Sel[] = [];
  for (const rule of allRules) {
    const matches = train.filter(rule.match);
    if (matches.length < minTrainN) continue;
    const wins = matches.filter((r) => r.result === "won").length;
    const wr = 100 * wins / matches.length;
    if (wr >= hi) selected.push({ rule, action: "follow", trainN: matches.length, trainWr: wr });
    else if (wr <= lo) selected.push({ rule, action: "invert", trainN: matches.length, trainWr: 100 - wr });
  }

  type Result = { name: string; act: "follow" | "invert"; trainN: number; trainWr: number; holdN: number; holdWr: number };
  const results: Result[] = [];
  for (const sel of selected) {
    const matches = holdout.filter(sel.rule.match);
    const w = matches.filter((r) => sel.action === "follow" ? r.result === "won" : r.result === "lost").length;
    results.push({
      name: sel.rule.name, act: sel.action, trainN: sel.trainN, trainWr: sel.trainWr,
      holdN: matches.length, holdWr: matches.length ? 100 * w / matches.length : 0,
    });
  }
  const withEnoughSample = results.filter((r) => r.holdN >= holdoutMinN);
  const passing = withEnoughSample.filter((r) => r.holdWr >= holdoutTargetWr);
  return {
    splitFraction, minTrainN, hi, lo, holdoutTargetWr, holdoutMinN,
    selected: selected.length,
    holdoutTestable: withEnoughSample.length,
    passing: passing.length,
    passingPct: withEnoughSample.length ? 100 * passing.length / withEnoughSample.length : 0,
    trainDays: (cutoffMs - firstMs) / 86400e3,
    holdoutDays: (lastMs - cutoffMs) / 86400e3,
    results, passingResults: passing,
  };
}

// Sweep grid
console.log(`=== PARAM SWEEP — target majority (>50%) of pockets passing at holdWr>=65% ===\n`);
console.log(`  split  minTrainN  trainWR%  targetHoldWR%  selected  testable  passing  passingPct  trainDays/holdDays`);
const sweeps: ReturnType<typeof trySplit>[] = [];
const gridSplit = [0.70, 0.75, 0.80, 0.85];
const gridMinTrainN = [30, 40, 50, 60, 75, 100];
const gridWr = [65, 70, 75];
const holdoutMinN = 15;
const holdoutTargetWr = 65;

for (const split of gridSplit) {
  for (const minN of gridMinTrainN) {
    for (const wr of gridWr) {
      const s = trySplit(split, minN, wr, 100 - wr, holdoutTargetWr, holdoutMinN);
      if (s.selected === 0) continue;
      sweeps.push(s);
      console.log(`  ${split.toFixed(2)}   ${String(minN).padStart(3)}       ${String(wr).padStart(3)}%     ${String(holdoutTargetWr)}%          ${String(s.selected).padStart(3)}       ${String(s.holdoutTestable).padStart(3)}      ${String(s.passing).padStart(3)}      ${s.passingPct.toFixed(1).padStart(5)}%      ${s.trainDays.toFixed(1)}/${s.holdoutDays.toFixed(1)}`);
    }
  }
}

// Find configs where >50% of testable pockets pass
const winners = sweeps.filter((s) => s.holdoutTestable >= 2 && s.passingPct >= 50);
console.log(`\n=== CONFIGS WHERE MAJORITY (>50%) PASS AT 65%+ HOLDOUT ===`);
if (!winners.length) console.log(`  none`);
for (const w of winners.slice(0, 20)) {
  console.log(`\n  split=${w.splitFraction} minTrainN=${w.minTrainN} trainWr>=${w.hi}% → ${w.passing}/${w.holdoutTestable} pockets pass (${w.passingPct.toFixed(1)}%)`);
  for (const r of w.passingResults) console.log(`    ${r.name.padEnd(30)} ${r.act.padEnd(6)}  trainN=${r.trainN} trainWr=${r.trainWr.toFixed(1)}%  holdN=${r.holdN} holdWr=${r.holdWr.toFixed(1)}%`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  sweeps: sweeps.map((s) => ({ ...s, results: undefined, passingResults: s.passingResults })),
  winners: winners.map((w) => ({ ...w, results: undefined })),
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);
