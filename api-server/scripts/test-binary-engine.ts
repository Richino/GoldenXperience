import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BINARY_HORIZON_SECONDS,
  binaryHorizonBreakdown,
  binaryStats,
  classifyBinaryResult,
  computeBinaryFeatures,
  computeSecondaryMarks,
  binaryExpiredWhileClosed,
  canOpenBinaryPrediction,
  createBaselineModel,
  isBinaryOpeningSession,
  isBinaryTie,
  mergeSecondaryMarks,
  resolutionPriceAtOrAfter,
  type BinaryCandle,
  type BinaryStatRow,
  type HorizonResultRow,
} from "../src/binary-engine.js";

// ---------------------------------------------------------------------------
// Resolution truth table. UP wins above entry, DOWN wins below; ties are never
// folded into a win or a loss.
// ---------------------------------------------------------------------------
const precision = 5; // EUR/USD-style
assert.equal(classifyBinaryResult("up", 1.16420, 1.16470, precision), "won", "UP + higher expiration price → WON");
assert.equal(classifyBinaryResult("up", 1.16420, 1.16370, precision), "lost", "UP + lower expiration price → LOST");
assert.equal(classifyBinaryResult("down", 1.16420, 1.16370, precision), "won", "DOWN + lower expiration price → WON");
assert.equal(classifyBinaryResult("down", 1.16420, 1.16470, precision), "lost", "DOWN + higher expiration price → LOST");

// Tie: equal at the instrument's display precision, for either direction.
assert.equal(classifyBinaryResult("up", 1.164200, 1.1642004, precision), "tie", "equal at precision → TIE (up)");
assert.equal(classifyBinaryResult("down", 1.164200, 1.1642004, precision), "tie", "equal at precision → TIE (down)");
assert.equal(isBinaryTie(1.16420, 1.16420, precision), true, "identical prices tie");
assert.equal(isBinaryTie(1.16420, 1.16421, precision), false, "a one-tick move is not a tie at ticks=0");
// A JPY pair (precision 3): a sub-tick difference still ties.
assert.equal(classifyBinaryResult("up", 162.420, 162.4203, 3), "tie", "JPY sub-tick difference → TIE");
assert.equal(classifyBinaryResult("up", 162.420, 162.430, 3), "won", "JPY clear move resolves");

// A configurable, wider tie band (2 ticks) folds small moves into a tie.
assert.equal(classifyBinaryResult("up", 1.16420, 1.16421, precision, 2), "tie", "widened tolerance ties a one-tick move");
assert.equal(classifyBinaryResult("up", 1.16420, 1.16423, precision, 2), "won", "beyond the widened band still resolves");

// ---------------------------------------------------------------------------
// Durability: the resolution price is the first completed candle AT OR AFTER the
// intended expiration — even across a gap left by downtime — and its real
// timestamp is returned rather than the intended one.
// ---------------------------------------------------------------------------
function candle(minute: number, close: number): BinaryCandle {
  const time = new Date(Date.UTC(2026, 0, 5, 12, minute, 0)).toISOString();
  return { time, open: close, high: close + 0.0001, low: close - 0.0001, close, volume: 10, complete: true };
}
// Candle open times 0,1,2,5 → close times 1,2,3,6 (open + 60s), leaving a gap
// where minutes 3→6 have no completed candle, standing in for downtime.
const series = [candle(0, 1.10000), candle(1, 1.10010), candle(2, 1.10020), candle(5, 1.10050)];
const expiration = new Date(Date.UTC(2026, 0, 5, 12, 4, 0)); // 12:04 sits inside the 12:03→12:06 gap
const mark = resolutionPriceAtOrAfter(series, expiration);
assert.ok(mark, "a price at or after expiration is found despite the gap");
assert.equal(mark!.price, 1.10050, "uses the first candle whose close is at or after the intended expiration");
assert.equal(mark!.time, new Date(Date.UTC(2026, 0, 5, 12, 6, 0)).toISOString(), "records the actual candle close time, not the intended expiration");
assert.equal(
  resolutionPriceAtOrAfter(series, new Date(Date.UTC(2026, 0, 5, 13, 0, 0))),
  null,
  "no reliable price yet → null, so the prediction stays active and retries",
);

// Secondary research horizons are priced without changing the official result.
// horizon 120s from 12:00 → target 12:02, first close ≥ 12:02 is candle(1) at 12:02.
const secondary = computeSecondaryMarks("up", 1.10000, precision, new Date(Date.UTC(2026, 0, 5, 12, 0, 0)), series, [120, 240]);
assert.equal(secondary["120s"]?.price, 1.10010, "secondary mark priced from the same candles");
assert.equal(secondary["120s"]?.result, "won", "secondary result is computed independently");

// A horizon longer than what the candles cover yet is simply absent — this is
// why the 15m mark can't be captured when a 10m prediction resolves, and why the
// deferred back-fill exists.
const notYet = computeSecondaryMarks("up", 1.10000, precision, new Date(Date.UTC(2026, 0, 5, 12, 0, 0)), series, [900]);
assert.equal(notYet["900s"], undefined, "a horizon with no candle yet is omitted, not guessed");

// Back-fill merge: an existing (resolution-time) mark always wins; only missing
// horizons are added, so the official record and earlier marks are never rewritten.
const mergedMarks = mergeSecondaryMarks(
  { "300s": { price: 1.10010, priceTime: "t", result: "won" } },
  { "300s": { price: 9.99999, priceTime: "x", result: "lost" }, "900s": { price: 1.10050, priceTime: "y", result: "won" } },
);
assert.equal((mergedMarks["300s"] as { price: number }).price, 1.10010, "an existing 5m mark is never overwritten by back-fill");
assert.equal((mergedMarks["900s"] as { result: string }).result, "won", "the missing 15m mark is added by back-fill");
assert.equal(Object.keys(mergedMarks).length, 2, "merge adds exactly the missing horizon");

// ---------------------------------------------------------------------------
// Idempotency: resolving the same prediction twice cannot change the result or
// duplicate the outcome. This mirrors the `WHERE status='active'` guard the
// engine's UPDATE uses.
// ---------------------------------------------------------------------------
function makeActiveRow() {
  return { status: "active" as string, result: null as string | null, resolutionPrice: null as number | null };
}
function idempotentResolve(row: ReturnType<typeof makeActiveRow>, price: number, result: string) {
  if (row.status !== "active") return false; // the guard
  row.status = "resolved";
  row.result = result;
  row.resolutionPrice = price;
  return true;
}
const row = makeActiveRow();
assert.equal(idempotentResolve(row, 1.10050, "won"), true, "first resolution applies");
assert.equal(row.result, "won");
assert.equal(idempotentResolve(row, 1.09000, "lost"), false, "second resolution is a no-op");
assert.equal(row.result, "won", "the recorded result is never rewritten");
assert.equal(row.resolutionPrice, 1.10050, "the recorded price is never rewritten");

// ---------------------------------------------------------------------------
// Immutability: the schema guards the audit record. Assert the migration ships
// the trigger that blocks edits to the frozen columns and to a decided result.
// ---------------------------------------------------------------------------
const migrationPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations", "024_binary_predictions.sql");
const migration = fs.readFileSync(migrationPath, "utf8");
assert.match(migration, /binary_predictions_guard/, "the immutability trigger function is defined");
assert.match(migration, /immutable fields cannot be modified/, "frozen fields are protected");
assert.match(migration, /result is immutable once decided/, "a decided result cannot be overwritten");
for (const column of ["direction", "entry_price", "start_at", "intended_expiration", "duration_seconds"]) {
  assert.ok(migration.includes(`NEW.${column} <> OLD.${column}`), `the trigger guards ${column}`);
}
assert.match(migration, /binary_predictions_one_active_idx[\s\S]*WHERE status = 'active'/, "one active prediction per symbol is enforced by a partial unique index");

// ---------------------------------------------------------------------------
// Separation: the binary engine must not import any trade-execution surface, so
// a prediction can never create an OANDA order or a paper trade.
// ---------------------------------------------------------------------------
const enginePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "binary-engine.ts");
const engineSource = fs.readFileSync(enginePath, "utf8");
for (const forbidden of ["practice-execution", "paper-cycle", "submitPracticeMarketOrder", "queuePracticeOrderIntent", "closePracticeTrade"]) {
  assert.ok(!engineSource.includes(forbidden), `binary engine must not reference ${forbidden}`);
}

// ---------------------------------------------------------------------------
// Model + features. A clean uptrend produces UP with a score above threshold and
// leaks no future data; a flat market produces WAIT.
// ---------------------------------------------------------------------------
const pip = 0.0001;
function trendedCandles(step: number): BinaryCandle[] {
  const candles: BinaryCandle[] = [];
  let close = 1.10000;
  for (let minute = 0; minute < 40; minute += 1) {
    close = Number((close + step).toFixed(5));
    const time = new Date(Date.UTC(2026, 0, 6, 10, minute, 0)).toISOString();
    candles.push({ time, open: close - step, high: close + pip * 0.5, low: close - step - pip * 0.5, close, volume: 20, complete: true });
  }
  return candles;
}
const model = createBaselineModel();
const now = new Date(Date.UTC(2026, 0, 6, 10, 40, 0));

const upFeatures = computeBinaryFeatures("EUR_USD", trendedCandles(0.0002), { bid: 1.10790, ask: 1.10800, mid: 1.10795 }, now);
assert.ok(upFeatures, "features compute from a full candle history");
assert.equal(upFeatures!.trend, "up", "rising EMAs read as an up trend");
assert.ok((upFeatures!.momentumPips.m5 ?? 0) > 0, "positive 5m momentum on an uptrend");
const upDecision = model.evaluate(upFeatures!);
assert.equal(upDecision.direction, "up", "the baseline predicts UP on a clean uptrend");
assert.ok(upDecision.score >= model.threshold, "a strong signal clears the threshold");

const flatCandles: BinaryCandle[] = Array.from({ length: 40 }, (_, minute) => {
  const time = new Date(Date.UTC(2026, 0, 6, 10, minute, 0)).toISOString();
  const wiggle = minute % 2 === 0 ? pip * 0.2 : -pip * 0.2;
  return { time, open: 1.10000, high: 1.10000 + Math.abs(wiggle), low: 1.10000 - Math.abs(wiggle), close: 1.10000, volume: 5, complete: true };
});
const flatDecision = model.evaluate(computeBinaryFeatures("EUR_USD", flatCandles, { bid: 1.09995, ask: 1.10005, mid: 1.10000 }, now)!);
assert.equal(flatDecision.direction, "wait", "a flat market returns WAIT rather than forcing a prediction");

// Too little history yields no features (and therefore no prediction).
assert.equal(computeBinaryFeatures("EUR_USD", trendedCandles(0.0002).slice(0, 10), null, now), null, "insufficient candles → null features");

// ---------------------------------------------------------------------------
// Statistics. Ties are excluded from win rate; win rate is null with no decided
// predictions; nothing is presented as significant.
// ---------------------------------------------------------------------------
const statRows: BinaryStatRow[] = [
  { instrument: "EUR_USD", direction: "up", status: "resolved", result: "won", confidence: 0.7, session: "London", model_version: "1.0.0", start_at: now.toISOString() },
  { instrument: "EUR_USD", direction: "up", status: "resolved", result: "lost", confidence: 0.6, session: "London", model_version: "1.0.0", start_at: now.toISOString() },
  { instrument: "EUR_USD", direction: "down", status: "resolved", result: "tie", confidence: 0.6, session: "London", model_version: "1.0.0", start_at: now.toISOString() },
  { instrument: "EUR_USD", direction: "up", status: "active", result: null, confidence: 0.8, session: "London", model_version: "1.0.0", start_at: now.toISOString() },
];
const stats = binaryStats(statRows);
assert.equal(stats.total, 4);
assert.equal(stats.active, 1);
assert.equal(stats.resolved, 3);
assert.equal(stats.won, 1);
assert.equal(stats.lost, 1);
assert.equal(stats.tie, 1);
assert.equal(stats.winRate, 0.5, "win rate excludes ties from the denominator (1 win / 2 decided)");
assert.equal(binaryStats([]).winRate, null, "no decided predictions → null win rate, not a fabricated 0%");
assert.equal(stats.evidenceEligible, false, "3 resolved is not presented as evidence");

assert.equal(BINARY_HORIZON_SECONDS, 600, "V1 horizon is 10 minutes");

// ---------------------------------------------------------------------------
// Session gating: predictions are OPENED only during the London / New York
// sessions (incl. their overlap), never in the Asian/off-hours between them,
// and never at the weekend. (August dates, so both centres are on summer time.)
// ---------------------------------------------------------------------------
assert.equal(isBinaryOpeningSession(new Date("2026-08-14T14:00:00Z")), true, "London/New York overlap is an opening session");
assert.equal(isBinaryOpeningSession(new Date("2026-08-14T03:00:00Z")), false, "market open but between sessions (Asian hours) does not open predictions");
assert.equal(isBinaryOpeningSession(new Date("2026-08-15T12:00:00Z")), false, "the weekend is not an opening session");

// A prediction must be able to expire before the market closes. Near the Friday
// 17:00 ET weekly close the 10-minute horizon runs past it, so opening stops.
// 2026-08-14 is a Friday; 20:55Z = 16:55 ET, whose +10m lands at 17:05 ET (closed).
assert.equal(canOpenBinaryPrediction(new Date("2026-08-14T20:55:00Z")), false, "a Friday prediction expiring after the 17:00 ET weekly close is not opened");
assert.equal(canOpenBinaryPrediction(new Date("2026-08-14T14:00:00Z")), true, "mid-session Friday opens normally");
// The same clock time on a weekday still opens — it resolves after the New York
// close from the candles that keep printing into the Asian hours.
assert.equal(canOpenBinaryPrediction(new Date("2026-08-13T20:55:00Z")), true, "late New York on a weekday still opens (the market stays open past it)");

// A prediction that expired while the market was closed is voided, not settled
// on a weekend-gap price. 21:09Z Friday = 17:09 ET, just after the weekly close.
assert.equal(binaryExpiredWhileClosed(new Date("2026-08-14T21:09:00Z")), true, "expiring just after the Friday 17:00 ET close is voided");
assert.equal(binaryExpiredWhileClosed(new Date("2026-08-14T14:09:00Z")), false, "expiring mid-session resolves normally");
assert.equal(binaryExpiredWhileClosed(new Date("2026-08-13T21:05:00Z")), false, "expiring after the NY close on a weekday is still resolvable");

// ---------------------------------------------------------------------------
// Horizon breakdown. The same resolved predictions are scored at 5m / 10m / 15m:
// the official result counts at the prediction's own horizon, the others come
// from the secondary marks, and predictions missing a horizon's mark are counted
// separately rather than silently shrinking that horizon's sample.
// ---------------------------------------------------------------------------
const horizonRows: HorizonResultRow[] = [
  { status: "resolved", durationSeconds: 600, result: "won", secondaryMarks: { "300s": { result: "lost" }, "900s": { result: "won" } } },
  { status: "resolved", durationSeconds: 600, result: "lost", secondaryMarks: { "300s": { result: "won" }, "900s": { result: "won" } } },
  { status: "resolved", durationSeconds: 600, result: "tie", secondaryMarks: { "900s": { result: "won" } } }, // no 5m mark → missing at 5m
  { status: "active", durationSeconds: 600, result: null, secondaryMarks: null }, // ignored
];
const horizons = binaryHorizonBreakdown(horizonRows);
const at = (seconds: number) => horizons.find((h) => h.horizonSeconds === seconds)!;

assert.deepEqual(horizons.map((h) => h.label), ["5m", "10m", "15m"], "horizons reported as 5m / 10m / 15m");
// 10m uses the official result: won, lost, tie → 1 win of 2 decided.
assert.equal(at(600).won, 1); assert.equal(at(600).lost, 1); assert.equal(at(600).tie, 1);
assert.equal(at(600).winRate, 0.5, "10m win rate excludes the tie");
// 5m from secondary marks: lost, won, (missing) → 1 win of 2 decided; one missing.
assert.equal(at(300).won, 1); assert.equal(at(300).lost, 1); assert.equal(at(300).missing, 1);
assert.equal(at(300).winRate, 0.5);
// 15m from secondary marks: won, won, won → 3 wins, perfect on this tiny sample.
assert.equal(at(900).won, 3); assert.equal(at(900).winRate, 1);
assert.equal(at(900).evidenceEligible, false, "3 resolved is never presented as evidence");
assert.equal(binaryHorizonBreakdown([])[0]!.winRate, null, "no data → null win rate per horizon");

console.log("Binary-engine checks passed.");
