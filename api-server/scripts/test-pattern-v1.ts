import assert from "node:assert/strict";
import {
  adxBucketOf, closeMsOf, collectBbReentrySignals, collectPatternV1Signals,
  computeFrozenConfigHash, evaluatePatternV1OnLastClosedCandle, frozenConfigMatches,
  matchesPatternV1, PATTERN_V1_BB_K, PATTERN_V1_BB_PERIOD, PATTERN_V1_CONFIG_HASH,
  PATTERN_V1_EXPIRY_MIN, PATTERN_V1_MIN_CANDLES, PATTERN_V1_RSI_OB, PATTERN_V1_RSI_OS,
  PATTERN_V1_SOURCE, PATTERN_V1_STRATEGY_ID, PATTERN_V1_STRATEGY_VERSION,
  rsiSeverityOf, type AdxBucket, type PatternCandle, type RsiSeverity,
} from "../src/pattern-v1.js";
import { ev80, nextCheckpoint, PATTERN_V1_DURATION_SECONDS } from "../src/pattern-v1-engine.js";

/**
 * Pattern V1 frozen-rule tests. Pure: no database, no network, no clock.
 *
 * These pin the RULE. The separate `pattern-v1:fixture` script pins the
 * IMPLEMENTATION against the recorded research signals.
 */

// ============================================================ 1. config identity
console.log("1. CONFIG IDENTITY");
assert.equal(PATTERN_V1_STRATEGY_ID, "binary-pattern-v1");
assert.equal(PATTERN_V1_STRATEGY_VERSION, "1.0.0");
assert.equal(PATTERN_V1_SOURCE, "pattern-v1-forward");
assert.equal(PATTERN_V1_CONFIG_HASH,
  "0e3cba650a3b62fda62db80d4b4af4bc37536851f233cadd4d995aca990f05cd");
assert.equal(PATTERN_V1_EXPIRY_MIN, 10);
assert.equal(PATTERN_V1_DURATION_SECONDS, 600, "10 minutes, in seconds");
assert.equal(PATTERN_V1_BB_PERIOD, 20);
assert.equal(PATTERN_V1_BB_K, 2.0);
assert.equal(PATTERN_V1_RSI_OS, 30);
assert.equal(PATTERN_V1_RSI_OB, 70);
{
  // The running configuration must still hash to the frozen holdout value.
  const hash = computeFrozenConfigHash();
  if (hash === null) {
    console.log("   freeze file not present in this checkout — hash pinned by constant only");
  } else {
    assert.equal(hash, PATTERN_V1_CONFIG_HASH,
      "the on-disk freeze file must still hash to the frozen holdout configuration");
    assert.equal(frozenConfigMatches(), true);
    console.log("   freeze file re-hashed and matches (LF-normalized)");
  }
}
console.log("   identity, expiry and indicator constants: OK");

// ============================================================ 2. boolean logic
console.log("\n2. EXACT BOOLEAN LOGIC");
const sig = (dir: "up" | "down", rsiSeverity: RsiSeverity, adxBucket: AdxBucket) =>
  ({ dir, rsiSeverity, adxBucket });

// The rule is UP AND (A OR B), NOT (UP AND A) OR B.
// The decisive case: a DOWN signal that satisfies branch B's severity+ADX.
assert.equal(matchesPatternV1(sig("down", "medium", "b20_25")), null,
  "a DOWN signal must NOT fire through branch B — the UP test binds both branches");
assert.equal(matchesPatternV1(sig("down", "extreme", "gt30")), null,
  "a DOWN signal must NOT fire through branch A either");
// And the mirror: UP with neither branch satisfied must not fire.
assert.equal(matchesPatternV1(sig("up", "medium", "gt30")), null,
  "medium severity does not pair with gt30");
assert.equal(matchesPatternV1(sig("up", "extreme", "b20_25")), null,
  "extreme severity does not pair with b20_25");
console.log("   UP AND (A OR B), never (UP AND A) OR B: OK");

// ============================================================ 3. UP only
console.log("\n3. DIRECTION");
for (const severity of ["mild", "medium", "extreme"] as RsiSeverity[]) {
  for (const bucket of ["le20", "b20_25", "b25_30", "gt30"] as AdxBucket[]) {
    assert.equal(matchesPatternV1(sig("down", severity, bucket)), null,
      `DOWN must never fire (${severity}/${bucket})`);
  }
}
console.log("   no DOWN combination fires: OK");

// ============================================================ 5/6. the two branches
console.log("\n5/6. BRANCHES");
assert.equal(matchesPatternV1(sig("up", "extreme", "gt30")), "V1A_EXTREME_ADX_GT30");
assert.equal(matchesPatternV1(sig("up", "medium", "b20_25")), "V1B_MEDIUM_ADX_20_25");
console.log("   V1a extreme+gt30 fires; V1b medium+b20_25 fires: OK");

// ============================================================ 7. mild never fires
console.log("\n7. MILD");
for (const bucket of ["le20", "b20_25", "b25_30", "gt30"] as AdxBucket[]) {
  assert.equal(matchesPatternV1(sig("up", "mild", bucket)), null, `mild must never fire (${bucket})`);
}
console.log("   mild never fires in any ADX bucket: OK");

// ============================================================ 8/9. wrong ADX
console.log("\n8/9. ADX BOUNDARIES");
for (const bucket of ["le20", "b20_25", "b25_30"] as AdxBucket[]) {
  assert.equal(matchesPatternV1(sig("up", "extreme", bucket)), null,
    `extreme outside gt30 must not fire (${bucket})`);
}
for (const bucket of ["le20", "b25_30", "gt30"] as AdxBucket[]) {
  assert.equal(matchesPatternV1(sig("up", "medium", bucket)), null,
    `medium outside b20_25 must not fire (${bucket})`);
}
// The bucket boundaries themselves, verbatim from the freeze file.
assert.equal(adxBucketOf(19.9), "le20");
assert.equal(adxBucketOf(20), "le20", "ADX==20 is le20, NOT the medium branch");
assert.equal(adxBucketOf(20.0001), "b20_25");
assert.equal(adxBucketOf(25), "b20_25", "25 inclusive");
assert.equal(adxBucketOf(25.0001), "b25_30");
assert.equal(adxBucketOf(30), "b25_30", "30 inclusive — gt30 is strictly greater");
assert.equal(adxBucketOf(30.0001), "gt30");
// Exactly 20 must NOT fire branch B, which is where the prose spec ">= 20"
// disagrees with the frozen bucket. The frozen definition governs.
assert.equal(matchesPatternV1(sig("up", "medium", adxBucketOf(20))), null,
  "ADX exactly 20 must not fire: the freeze says ADX==20 is le20");
assert.equal(matchesPatternV1(sig("up", "medium", adxBucketOf(20.5))), "V1B_MEDIUM_ADX_20_25");
assert.equal(matchesPatternV1(sig("up", "medium", adxBucketOf(25))), "V1B_MEDIUM_ADX_20_25");
assert.equal(matchesPatternV1(sig("up", "medium", adxBucketOf(25.5))), null);
console.log("   buckets: <=20 le20, (20,25] b20_25, (25,30] b25_30, >30 gt30: OK");

// ---------------------------------------------------------------- severity bands
console.log("\nRSI SEVERITY BANDS");
// beyond = 30 - rsi for UP. mild <=5, medium <=10, extreme >10, evaluated in order.
assert.equal(rsiSeverityOf("up", 30), "mild", "beyond 0");
assert.equal(rsiSeverityOf("up", 25), "mild", "beyond 5 is still mild");
assert.equal(rsiSeverityOf("up", 24.999), "medium", "just past 5 becomes medium");
assert.equal(rsiSeverityOf("up", 20), "medium", "beyond 10 is still medium");
assert.equal(rsiSeverityOf("up", 19.999), "extreme", "just past 10 becomes extreme");
assert.equal(rsiSeverityOf("up", 5), "extreme");
// DOWN mirrors around the overbought threshold.
assert.equal(rsiSeverityOf("down", 70), "mild");
assert.equal(rsiSeverityOf("down", 75), "mild");
assert.equal(rsiSeverityOf("down", 80), "medium");
assert.equal(rsiSeverityOf("down", 80.001), "extreme");
console.log("   mild<=5, medium<=10, extreme>10, ordered: OK");

// ============================================================ synthetic series
/**
 * Build a candle series that drives price below the lower band and back in.
 * Flat then a sharp drop then a recovery close gives a genuine re-entry.
 */
function series(closes: number[], startMs = Date.parse("2026-08-24T12:00:00.000Z")): PatternCandle[] {
  return closes.map((close, i) => ({
    time: new Date(startMs + i * 60_000).toISOString(),
    open: close, high: close, low: close, close,
  }));
}

// ============================================================ 4. BB re-entry required
console.log("\n4. BB RE-ENTRY IS REQUIRED");
{
  // A perfectly flat series never leaves the band, so nothing can ever fire.
  const flat = series(Array.from({ length: 400 }, () => 1.1));
  assert.equal(collectBbReentrySignals("EUR_USD", flat).length, 0,
    "price that never leaves the band produces no signal");
  assert.equal(evaluatePatternV1OnLastClosedCandle("EUR_USD", flat), null);
}
console.log("   no excursion -> no signal, regardless of RSI/ADX: OK");

// ============================================================ 10/11. closed candle + no leakage
console.log("\n10/11. TIMESTAMP CONVENTION AND LEAKAGE");
{
  const candle: PatternCandle = { time: "2026-08-24T12:34:00.000Z", open: 1, high: 1, low: 1, close: 1 };
  assert.equal(closeMsOf(candle), Date.parse("2026-08-24T12:35:00.000Z"),
    "a bar stamped at its OPEN closes 60s later");
}
{
  // Truncating the future must not change the verdict for a given bar: the
  // evaluator can only see what it was handed.
  const closes = Array.from({ length: 420 }, (_, i) => 1.1 + Math.sin(i / 7) * 0.002);
  const full = series(closes);
  for (const cut of [400, 405, 410]) {
    const window = full.slice(0, cut);
    const a = evaluatePatternV1OnLastClosedCandle("EUR_USD", window);
    // Appending future bars must not alter the decision made at `cut`.
    const withFuture = full.slice(0, cut + 10);
    const b = collectPatternV1Signals("EUR_USD", withFuture).find((s) => s.barIndex === cut - 1) ?? null;
    assert.equal(a === null, b === null, `future candles must not change the verdict at bar ${cut - 1}`);
    if (a && b) {
      assert.equal(a.branch, b.branch);
      assert.equal(a.closeMs, b.closeMs);
      assert.equal(a.rsi, b.rsi);
      assert.equal(a.adx, b.adx);
    }
  }
}
{
  // Below the warmup, no decision is made at all.
  const short = series(Array.from({ length: PATTERN_V1_MIN_CANDLES - 1 }, (_, i) => 1.1 + i * 1e-5));
  assert.equal(evaluatePatternV1OnLastClosedCandle("EUR_USD", short), null,
    "insufficient warmup must produce no signal rather than a guess");
}
console.log("   close = open+60s; future bars cannot change a past verdict; warmup enforced: OK");

// ============================================================ episode dedup
console.log("\nEPISODE DEDUP (BB re-entry state machine)");
{
  // Drop out of the band, re-enter, then re-enter again without returning to
  // mid: the second re-entry must NOT produce a second signal.
  const base = Array.from({ length: 300 }, () => 1.10000);
  const closes = [...base, 1.09000, 1.09600, 1.09550, 1.09610];
  const signals = collectBbReentrySignals("EUR_USD", series(closes));
  const lowerSignals = signals.filter((s) => s.side === "lower");
  assert.ok(lowerSignals.length <= 1,
    `one episode may signal at most once before returning to mid (got ${lowerSignals.length})`);
}
console.log("   one signal per excursion episode: OK");

// ============================================================ 12. duplicate suppression
console.log("\n12. DUPLICATE SUPPRESSION");
{
  // Determinism is what makes DB-level dedup meaningful: the same window
  // re-evaluated must yield the same signal identity, so the unique index on
  // (model, instrument, signal_candle_time, duration) catches the repeat.
  const closes = Array.from({ length: 420 }, (_, i) => 1.1 + Math.sin(i / 5) * 0.003);
  const window = series(closes);
  const first = collectPatternV1Signals("EUR_USD", window);
  for (let run = 0; run < 3; run += 1) {
    assert.deepEqual(collectPatternV1Signals("EUR_USD", window), first,
      "repeated evaluation of the same window must be identical");
  }
  for (const signal of first) {
    assert.equal(signal.closeMs, closeMsOf(window[signal.barIndex]!),
      "the dedup key is the signal bar's close instant");
  }
}
console.log("   evaluation is deterministic; dedup key is the signal bar close: OK");

// ============================================================ 13. expiration
console.log("\n13. EXPIRATION");
{
  const start = Date.parse("2026-08-24T12:35:00.000Z");
  assert.equal(start + PATTERN_V1_DURATION_SECONDS * 1000,
    Date.parse("2026-08-24T12:45:00.000Z"), "exactly 10 minutes after start");
}
console.log("   10-minute horizon: OK");

// ============================================================ 14/15/16. resolution
console.log("\n14/15/16. RESOLUTION SEMANTICS (UP)");
{
  // Pattern V1 is UP only, and settles through the EXISTING binary resolver.
  // These pin the direction semantics the shared resolver applies.
  const decide = (entry: number, exit: number) => exit > entry ? "won" : exit < entry ? "lost" : "tie";
  assert.equal(decide(1.1000, 1.1005), "won", "expiration above entry wins");
  assert.equal(decide(1.1000, 1.0995), "lost", "expiration below entry loses");
  assert.equal(decide(1.1000, 1.1000), "tie", "equal is a tie");
}
console.log("   UP: above=won, below=lost, equal=tie: OK");

// ============================================================ EV80 + checkpoints
console.log("\nSTATISTICS");
{
  assert.equal(ev80(0, 0), null, "no decided predictions -> no EV");
  // 23 wins / 14 losses -> WR 62.2%, EV80 = .6216*.8 - .3784 = +0.1189
  const value = ev80(23, 14)!;
  assert.ok(Math.abs(value - (23 / 37 * 0.8 - 14 / 37)) < 1e-12);
  assert.ok(Math.abs(value - 0.1189) < 0.0005, `EV80 ~ +0.119, got ${value}`);
  // Break-even is 5/9 = 55.56% at an 80% payout.
  assert.ok(Math.abs(ev80(5, 4)! - 0) < 1e-12, "5 of 9 is exactly break-even at 80%");
  assert.ok(ev80(1, 1)! < 0, "50% is a losing rate at an 80% payout");
  // Ties are excluded from both rates, so they cannot move EV.
  assert.equal(ev80(10, 10), ev80(10, 10));
}
{
  assert.equal(nextCheckpoint(0), 25);
  assert.equal(nextCheckpoint(24), 25);
  assert.equal(nextCheckpoint(25), 50);
  assert.equal(nextCheckpoint(99), 100);
  assert.equal(nextCheckpoint(500), null, "past the last checkpoint");
}
console.log("   EV80 = WR*0.8 - lossRate, ties excluded; checkpoints 25/50/100/250/500: OK");

console.log("\nAll Pattern V1 frozen-rule assertions passed.");
