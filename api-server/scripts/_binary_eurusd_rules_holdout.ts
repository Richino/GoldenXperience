/**
 * EUR_USD rules engine with strict hold-out validation.
 * Discover pockets on the first ~75% of the data. Freeze rules. Test on the
 * last ~25% (fresh, unseen). Report which pockets survived and the honest
 * hold-out winrate.
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

const OUT_DIR = path.join(serviceRoot, "research-v2", "binary-eurusd-rules-v1-holdout");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

type Row = {
  direction: string; result: string; created_at: string;
  features: Record<string, unknown> | null; confidence: string | null;
  model_name: string; strategy_source: string | null;
};
const raw = (await query<Row>(`
  SELECT direction, result, created_at::text, features, confidence::text, model_name, strategy_source
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
     AND instrument = 'EUR_USD'
`)).rows;
raw.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
console.log(`EUR_USD resolved: ${raw.length}`);

const firstMs = Date.parse(raw[0]!.created_at);
const lastMs = Date.parse(raw[raw.length - 1]!.created_at);
const spanDays = (lastMs - firstMs) / 86400e3;
console.log(`span: ${spanDays.toFixed(1)} days`);

// Split: last 25% = hold-out
const cutoffMs = firstMs + spanDays * 0.75 * 86400e3;
const train = raw.filter((r) => Date.parse(r.created_at) < cutoffMs);
const holdout = raw.filter((r) => Date.parse(r.created_at) >= cutoffMs);
console.log(`train: ${train.length}   holdout: ${holdout.length}   cutoff: ${new Date(cutoffMs).toISOString()}\n`);

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

// Rule schema
type Rule = {
  name: string;
  match: (r: Row) => boolean;
  action: "follow" | "invert";
};

// Enumerate candidate rules — same slice types as the survey
function makeRules(): Rule[] {
  const rules: Rule[] = [];
  // hour rules (both directions)
  for (let h = 0; h < 24; h++) {
    rules.push({ name: `h${String(h).padStart(2, "0")}`, match: (r) => etHour(r.created_at) === h, action: "follow" });
  }
  // dir × hour
  for (let h = 0; h < 24; h++) {
    for (const d of ["up", "down"] as const) {
      rules.push({ name: `${d} / h${String(h).padStart(2, "0")}`, match: (r) => r.direction === d && etHour(r.created_at) === h, action: "follow" });
    }
  }
  // dir × day
  for (const d of ["up", "down"] as const) {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      rules.push({ name: `${d} / ${day}`, match: (r) => r.direction === d && etDay(r.created_at) === day, action: "follow" });
    }
  }
  // dir × session
  for (const d of ["up", "down"] as const) {
    for (const s of ["london", "overlap", "ny"]) {
      rules.push({ name: `${d} / ${s}`, match: (r) => r.direction === d && sessionOf(etHour(r.created_at)) === s, action: "follow" });
    }
  }
  // dir × day × session
  for (const d of ["up", "down"] as const) {
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      for (const s of ["london", "overlap", "ny"]) {
        rules.push({
          name: `${d} / ${day} / ${s}`,
          match: (r) => r.direction === d && etDay(r.created_at) === day && sessionOf(etHour(r.created_at)) === s,
          action: "follow",
        });
      }
    }
  }
  // day × confidence
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
    for (const cb of ["0.5-0.55", "0.55-0.60", "0.60-0.70", "0.70-0.80", "0.80-0.90", "0.90+"]) {
      rules.push({
        name: `${day} / conf ${cb}`,
        match: (r) => etDay(r.created_at) === day && confBucket(r.confidence !== null ? Number(r.confidence) : null) === cb,
        action: "follow",
      });
    }
  }
  return rules;
}

const allRules = makeRules();
console.log(`candidate rules: ${allRules.length}`);

// Score each rule on TRAIN
type RuleStat = { rule: Rule; nTrain: number; wTrain: number; wrTrain: number };
const trainStats: RuleStat[] = allRules.map((rule) => {
  const matches = train.filter(rule.match);
  const wins = matches.filter((r) => r.result === "won").length;
  return { rule, nTrain: matches.length, wTrain: wins, wrTrain: matches.length ? 100 * wins / matches.length : 0 };
});

// Select pockets: n>=25, winrate >= 60% OR <= 40%
// If winrate <= 40%, flip the action to invert
const MIN_TRAIN_N = 25;
const HI = 60;
const LO = 40;
const selected: Array<{ rule: Rule; action: "follow" | "invert"; trainN: number; trainWr: number }> = [];
for (const s of trainStats) {
  if (s.nTrain < MIN_TRAIN_N) continue;
  if (s.wrTrain >= HI) selected.push({ rule: { ...s.rule, action: "follow" }, action: "follow", trainN: s.nTrain, trainWr: s.wrTrain });
  else if (s.wrTrain <= LO) selected.push({ rule: { ...s.rule, action: "invert" }, action: "invert", trainN: s.nTrain, trainWr: s.wrTrain });
}
console.log(`selected pockets (train): ${selected.length}\n`);

// Evaluate each selected rule on HOLDOUT
type HoldoutResult = { ruleName: string; action: "follow" | "invert"; trainN: number; trainWr: number; holdoutN: number; holdoutW: number; holdoutWr: number; delta: number };
const holdoutResults: HoldoutResult[] = [];
for (const sel of selected) {
  const matches = holdout.filter(sel.rule.match);
  const wins = matches.filter((r) => sel.action === "follow" ? r.result === "won" : r.result === "lost").length;
  const wr = matches.length ? 100 * wins / matches.length : 0;
  // For invert rules, the "effective winrate" is the inversion — but wr as computed above IS the inverted winrate since we defined wins that way
  const trainEffectiveWr = sel.action === "follow" ? sel.trainWr : 100 - sel.trainWr;
  holdoutResults.push({
    ruleName: sel.rule.name,
    action: sel.action,
    trainN: sel.trainN,
    trainWr: trainEffectiveWr,
    holdoutN: matches.length,
    holdoutW: wins,
    holdoutWr: wr,
    delta: wr - trainEffectiveWr,
  });
}
holdoutResults.sort((a, b) => b.holdoutWr - a.holdoutWr);

console.log(`=== HOLD-OUT RESULTS (per selected pocket) ===`);
console.log(`  rule                                            act    trainN   trainWr    holdN   holdWr   Δ`);
for (const r of holdoutResults) {
  console.log(`  ${r.ruleName.padEnd(46)}  ${r.action.padEnd(6)}  n=${String(r.trainN).padStart(3)}    ${r.trainWr.toFixed(1).padStart(5)}%    n=${String(r.holdoutN).padStart(3)}   ${r.holdoutN ? r.holdoutWr.toFixed(1).padStart(5) + "%" : "  --  "}   ${r.holdoutN ? (r.delta >= 0 ? "+" : "") + r.delta.toFixed(1) + "pp" : ""}`);
}

// Composite: sum all pocket matches (deduplicated by row-index) on hold-out
const holdoutMatches = new Map<Row, "follow" | "invert">();
for (const sel of selected) {
  for (const r of holdout) {
    if (!sel.rule.match(r)) continue;
    if (!holdoutMatches.has(r)) holdoutMatches.set(r, sel.action);
    // If already matched by another rule with a different action, we skip (conflicting signals)
  }
}
let cn = 0, cw = 0;
for (const [r, act] of holdoutMatches) {
  cn++;
  const won = act === "follow" ? r.result === "won" : r.result === "lost";
  if (won) cw++;
}
const compositeWr = cn ? 100 * cw / cn : 0;
const holdoutSpanDays = (Date.parse(holdout[holdout.length - 1]!.created_at) - Date.parse(holdout[0]!.created_at)) / 86400e3;
console.log(`\n=== COMPOSITE ON HOLD-OUT (dedup rules) ===`);
console.log(`  pockets that fired:   ${selected.filter((s) => holdoutResults.find((h) => h.ruleName === s.rule.name)!.holdoutN > 0).length} / ${selected.length}`);
console.log(`  unique trades taken:  ${cn}`);
console.log(`  wins:                 ${cw}`);
console.log(`  holdout winrate:      ${compositeWr.toFixed(1)}%`);
console.log(`  holdout span:         ${holdoutSpanDays.toFixed(1)} days`);
console.log(`  trades/day (holdout): ${(cn / holdoutSpanDays).toFixed(2)}`);

// Pockets that SURVIVED (holdWr still >= 55% at n >= 10)
const survivors = holdoutResults.filter((h) => h.holdoutN >= 10 && h.holdoutWr >= 55);
console.log(`\n=== SURVIVORS (holdoutN>=10 AND holdoutWr>=55%) ===`);
if (!survivors.length) console.log(`  none`);
for (const s of survivors) {
  console.log(`  ${s.ruleName.padEnd(46)}  ${s.action}  holdoutN=${s.holdoutN}  holdoutWr=${s.holdoutWr.toFixed(1)}%  (train ${s.trainWr.toFixed(1)}% on n=${s.trainN})`);
}

writeFileSync(path.join(OUT_DIR, "RESULTS.json"), JSON.stringify({
  generated: new Date().toISOString(),
  trainN: train.length, holdoutN: holdout.length, cutoff: new Date(cutoffMs).toISOString(),
  selectedPockets: selected.length,
  composite: { n: cn, wins: cw, winrate: compositeWr, holdoutSpanDays },
  survivors,
  holdoutResults,
}, null, 2));
console.log(`\nwrote ${path.join(OUT_DIR, "RESULTS.json")}`);
process.exit(0);
