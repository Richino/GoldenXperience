import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  evaluatePatternV1OnLastClosedCandle, PATTERN_V1_MIN_CANDLES, PATTERN_V1_RSI_OS,
  type PatternCandle, type PatternV1Branch,
} from "../src/pattern-v1.js";

/** The research CSV writes short branch labels; the engine writes explicit ones. */
const RESEARCH_BRANCH: Record<string, PatternV1Branch> = {
  V1a: "V1A_EXTREME_ADX_GT30",
  V1b: "V1B_MEDIUM_ADX_20_25",
};

/**
 * Tolerance for the Wilder-recursion residual between a trailing window and a
 * full-history replay. Set far below the smallest margin any recorded signal
 * has to a bucket boundary, which the run reports, so a drift large enough to
 * matter fails rather than passes quietly.
 */
const NUMERIC_TOLERANCE = 1e-5;

let worstRsi = 0;
let worstAdx = 0;
let closestAdxEdge = { margin: Infinity, symbol: "", at: "", edge: 0, adx: 0 };
let closestRsiEdge = { margin: Infinity, symbol: "", at: "", edge: 0, rsi: 0 };

/**
 * Pattern V1 forward-vs-research regression fixture.
 *
 * The requirement this discharges: given identical candles, the research
 * evaluator and the forward evaluator must return identical Pattern V1 state.
 * Rather than assert that by inspection, this replays the FORWARD evaluator
 * over the same cached M1 candles the research used and compares its output to
 * the 112 signals recorded in the consumed holdout.
 *
 * It also measures the one thing a trailing window could get wrong. Research
 * replayed the re-entry state machine from the beginning of history; forward
 * replays only the last PATTERN_V1_MIN_CANDLES bars. If that window were too
 * short the episode state could differ and a signal could appear or vanish.
 * Every recorded signal reproducing from a 300-bar window is the evidence that
 * it does not.
 *
 * Skips cleanly when the research cache is absent — it is ~950MB and is not
 * deployed with the server.
 */
const ROOT = process.cwd().endsWith("api-server") ? process.cwd() : path.join(process.cwd(), "api-server");
const CACHE_DIR = path.join(ROOT, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const SIGNALS_CSV = path.join(ROOT, "research-v2", "pattern-v1-holdout", "holdout_signals.csv");

if (!fs.existsSync(CACHE_DIR) || !fs.existsSync(SIGNALS_CSV)) {
  console.log("SKIPPED: research cache or holdout signals not present.");
  console.log(`  cache:   ${CACHE_DIR}`);
  console.log(`  signals: ${SIGNALS_CSV}`);
  process.exit(0);
}

type Expected = {
  entryMs: number; symbol: string; rsi: number; rsiSeverity: string;
  adx: number; adxBucket: string; branch: string; entryPrice: number; timestamp: string;
};

const csv = fs.readFileSync(SIGNALS_CSV, "utf8").trim().split(/\r?\n/);
const header = csv[0]!.split(",");
const col = (name: string) => {
  const index = header.indexOf(name);
  assert.notEqual(index, -1, `holdout_signals.csv must carry a ${name} column`);
  return index;
};
const [cMs, cSym, cRsi, cSev, cAdx, cBucket, cBranch, cPrice, cTs] =
  ["entryMs", "symbol", "rsi", "rsiSeverity", "adx", "adxBucket", "branch", "entryPrice", "timestamp"].map(col);

const expected: Expected[] = csv.slice(1).map((line) => {
  const p = line.split(",");
  return {
    entryMs: Number(p[cMs]), symbol: p[cSym]!, rsi: Number(p[cRsi]), rsiSeverity: p[cSev]!,
    adx: Number(p[cAdx]), adxBucket: p[cBucket]!, branch: p[cBranch]!,
    entryPrice: Number(p[cPrice]), timestamp: p[cTs]!,
  };
});

const bySymbol = new Map<string, Expected[]>();
for (const row of expected) {
  const list = bySymbol.get(row.symbol) ?? [];
  list.push(row);
  bySymbol.set(row.symbol, list);
}

console.log(`Replaying ${expected.length} recorded HOLDOUT signals across ${bySymbol.size} symbols`);
console.log(`Forward window: ${PATTERN_V1_MIN_CANDLES} bars (research replayed full history)\n`);

let checked = 0;
let matched = 0;
const failures: string[] = [];

for (const [symbol, rows] of [...bySymbol.entries()].sort()) {
  const file = path.join(CACHE_DIR, `${symbol}.jsonl`);
  if (!fs.existsSync(file)) { console.log(`  ${symbol}: cache missing, skipped`); continue; }

  const targets = new Map(rows.map((row) => [row.entryMs, row]));
  // Rolling window: the cache files are ~79MB each, so the candles stream past
  // and only the trailing window is ever held.
  const window: PatternCandle[] = [];
  const stream = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  for await (const line of stream) {
    if (!line) continue;
    const raw = JSON.parse(line) as PatternCandle & { complete?: boolean };
    if (raw.complete === false) continue;
    window.push({ time: raw.time, open: raw.open, high: raw.high, low: raw.low, close: raw.close });
    if (window.length > PATTERN_V1_MIN_CANDLES) window.shift();

    const closeMs = Date.parse(raw.time) + 60_000;
    const want = targets.get(closeMs);
    if (!want) continue;
    targets.delete(closeMs);
    checked += 1;

    const got = evaluatePatternV1OnLastClosedCandle(symbol, window);
    if (!got) {
      failures.push(`${symbol} ${want.timestamp}: forward produced NO signal, research recorded ${want.branch}`);
      continue;
    }
    const problems: string[] = [];
    // CLASSIFICATION must be exact — this is what decides whether V1 fires.
    if (RESEARCH_BRANCH[want.branch] !== got.branch) problems.push(`branch ${got.branch} != ${want.branch}`);
    if (got.rsiSeverity !== want.rsiSeverity) problems.push(`severity ${got.rsiSeverity} != ${want.rsiSeverity}`);
    if (got.adxBucket !== want.adxBucket) problems.push(`bucket ${got.adxBucket} != ${want.adxBucket}`);
    if (got.dir !== "up") problems.push(`dir ${got.dir} != up`);
    // Identity of the bar and its price must be exact — these are not recursive.
    if (got.closeMs !== want.entryMs) problems.push(`closeMs ${got.closeMs} != ${want.entryMs}`);
    if (Math.abs(got.close - want.entryPrice) > 1e-9) problems.push(`close ${got.close} != ${want.entryPrice}`);

    // RSI and ADX are Wilder recursions with unbounded memory, so a trailing
    // window can never equal a full-history replay bit-for-bit; the residual
    // decays like (13/14)^bars. Track the worst case and how close it came to
    // moving a signal across a bucket boundary, which is the only way this
    // could change a decision.
    const dRsi = Math.abs(got.rsi - want.rsi);
    const dAdx = Math.abs(got.adx - want.adx);
    worstRsi = Math.max(worstRsi, dRsi);
    worstAdx = Math.max(worstAdx, dAdx);
    for (const edge of [20, 25, 30]) {
      const margin = Math.abs(want.adx - edge);
      if (margin < closestAdxEdge.margin) closestAdxEdge = { margin, symbol, at: want.timestamp, edge, adx: want.adx };
    }
    for (const edge of [PATTERN_V1_RSI_OS - 5, PATTERN_V1_RSI_OS - 10]) {
      const margin = Math.abs(want.rsi - edge);
      if (margin < closestRsiEdge.margin) closestRsiEdge = { margin, symbol, at: want.timestamp, edge, rsi: want.rsi };
    }
    if (dRsi > NUMERIC_TOLERANCE) problems.push(`rsi drift ${dRsi.toExponential(2)} exceeds tolerance`);
    if (dAdx > NUMERIC_TOLERANCE) problems.push(`adx drift ${dAdx.toExponential(2)} exceeds tolerance`);

    if (problems.length) failures.push(`${symbol} ${want.timestamp}: ${problems.join("; ")}`);
    else matched += 1;
  }
  stream.close();

  const missed = [...targets.values()];
  for (const row of missed) {
    failures.push(`${symbol} ${row.timestamp}: signal candle not found in cache (entryMs ${row.entryMs})`);
  }
  console.log(`  ${symbol.padEnd(8)} ${rows.length - missed.length}/${rows.length} signal bars located`);
}

console.log(`\nchecked ${checked}, exact matches ${matched}, failures ${failures.length}`);
console.log("\nWILDER-RECURSION RESIDUAL (trailing window vs research full history)");
console.log(`  worst |d rsi| : ${worstRsi.toExponential(3)}`);
console.log(`  worst |d adx| : ${worstAdx.toExponential(3)}`);
console.log(`  tolerance     : ${NUMERIC_TOLERANCE.toExponential(0)}`);
console.log("\nCLOSEST APPROACH TO A CLASSIFICATION BOUNDARY");
console.log("(how much drift it would take to move a recorded signal into a different bucket)");
console.log(`  ADX edge ${closestAdxEdge.edge}: margin ${closestAdxEdge.margin.toExponential(3)} `
  + `(${closestAdxEdge.symbol} ${closestAdxEdge.at}, adx=${closestAdxEdge.adx.toFixed(6)})`);
console.log(`  RSI edge ${closestRsiEdge.edge}: margin ${closestRsiEdge.margin.toExponential(3)} `
  + `(${closestRsiEdge.symbol} ${closestRsiEdge.at}, rsi=${closestRsiEdge.rsi.toFixed(6)})`);
const worstDrift = Math.max(worstRsi, worstAdx);
const tightestMargin = Math.min(closestAdxEdge.margin, closestRsiEdge.margin);
console.log(`  margin is ${(tightestMargin / Math.max(worstDrift, Number.MIN_VALUE)).toExponential(2)}x the worst drift`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
}

assert.equal(failures.length, 0, "forward evaluator must reproduce every recorded holdout signal exactly");
assert.equal(matched, expected.length,
  `all ${expected.length} recorded signals must reproduce; got ${matched}`);

console.log("\nForward evaluator reproduces the research evaluator exactly on all recorded signals.");
