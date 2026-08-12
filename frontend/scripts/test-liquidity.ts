import assert from "node:assert/strict";
import {
  analyzePullback, findSweep, hasDisplacement, hasRejection, hasRetest, nearestLevel, RULES,
} from "../src/lib/strategy/liquidity-confirmation";
import { classifyH1Structure } from "../src/lib/strategy/market-structure";
import { mapLiquidityLevels, swingPoints } from "../src/lib/strategy/liquidity-levels";
import { evaluateLiquiditySetup, LIQUIDITY_STRATEGY_VERSION, RISK } from "../src/lib/strategy/liquidity-strategy";
import type { Candle } from "../src/types/forex";
import type { LiquidityLevel } from "../src/lib/strategy/liquidity-levels";
import { signedPracticeUnits } from "../src/lib/oanda/client";

const ATR = 0.0010; // 10 pips on a 5-decimal pair

assert.equal(LIQUIDITY_STRATEGY_VERSION, "trend-pullback-liquidity-v2");

function bar(overrides: Partial<Candle> & { time?: string } = {}): Candle {
  return {
    time: overrides.time ?? "2026-04-06T12:00:00.000Z",
    open: 1.1, high: 1.1005, low: 1.0995, close: 1.1,
    volume: 100, complete: true, ...overrides,
  };
}

// A sweep is a level taken far enough to trigger the orders resting there and
// then given back. Both halves are required.
const lowLevel: LiquidityLevel = { kind: "asian-low", price: 1.1, side: "low", label: "Asian low" };
// findSweep needs sweepReclaimBars + 1 candles to have a window to look at, so
// every fixture here carries four.
const swept = [
  bar({ high: 1.1010, low: 1.1002, close: 1.1008 }),
  // Trades 0.4 ATR below the level, past the 0.25 threshold.
  bar({ high: 1.1005, low: 1.0996, close: 1.0999 }),
  bar({ high: 1.1008, low: 1.0998, close: 1.1004 }),
  bar({ high: 1.1012, low: 1.1001, close: 1.1010 }),
];
const sweep = findSweep(swept, [lowLevel], ATR);
assert.ok(sweep, "a level taken and reclaimed must register as a sweep");
assert.equal(sweep!.direction, "long", "sweeping a low sets up a long");
assert.ok(sweep!.extreme <= 1.0996, "the extreme is the furthest point beyond the level");

// Touched but not taken: inside the threshold, so nothing happened.
// Every low stays above 1.09975 — the level less the 0.25 ATR threshold.
const grazed = [
  bar({ low: 1.09995, high: 1.1004, close: 1.1004 }),
  bar({ low: 1.0999, close: 1.1006 }),
  bar({ low: 1.0999, close: 1.1007 }),
  bar({ low: 1.0999, close: 1.1008 }),
];
assert.equal(findSweep(grazed, [lowLevel], ATR), null, "a graze inside the threshold is not a sweep");

// Taken and held is a breakout, a different trade entirely.
const brokeThrough = [bar({ low: 1.0990, close: 1.0992 }), bar({ close: 1.0988 }), bar({ close: 1.0986 }), bar({ close: 1.0985 })];
assert.equal(findSweep(brokeThrough, [lowLevel], ATR), null, "a level taken and held is not a sweep");

// Rejection: a long tail with the close pushed back to the far end.
assert.equal(hasRejection(bar({ open: 1.1002, high: 1.1004, low: 1.0990, close: 1.1003 }), "long"), true, "a long lower wick closing high is a bullish rejection");
assert.equal(hasRejection(bar({ open: 1.1002, high: 1.1004, low: 1.0990, close: 1.0991 }), "long"), false, "closing on the low is not a bullish rejection");

// Displacement measures against ATR, so the same rule works on any pair.
assert.equal(hasDisplacement([bar({ open: 1.1, close: 1.1 + ATR * RULES.displacementBodyAtr })], "long", ATR), true, "a body beyond the threshold is displacement");
assert.equal(hasDisplacement([bar({ open: 1.1, close: 1.1 + ATR * 0.5 })], "long", ATR), false, "a small body is not displacement");

// Structure: a close beyond the last swing, not a wick through it.
const rising = Array.from({ length: 40 }, (_, i) => bar({ high: 1.1 + i * 0.0002, low: 1.0995 + i * 0.0002, close: 1.0998 + i * 0.0002 }));
const swings = swingPoints(rising, RULES.swingReach);
assert.ok(swings.highs.length + swings.lows.length >= 0, "swing detection runs on a trend without throwing");

// Retest requires price to come back and still close the right side.
const level = 1.1;
const retested = [bar({ low: 1.0999, high: 1.1002, close: 1.1001 }), bar({ close: 1.1006 })];
assert.equal(hasRetest(retested, level, "long", ATR), true, "returning to the level and closing above is a retest");
assert.equal(hasRetest(retested, level, "short", ATR), false, "the same bars are not a short retest");

// Location: the level has to be within reach of the current price.
assert.ok(nearestLevel(1.1001, [lowLevel], ATR), "price beside a level claims that location");
assert.equal(nearestLevel(1.1200, [lowLevel], ATR), null, "price far from every level claims none");

// Levels are read from the timeframe that can see them: a week does not fit in
// 260 M15 candles, so weekly extremes come from H4.
const day = (hoursBack: number) => new Date(Date.UTC(2026, 3, 6, 12) - hoursBack * 3600_000).toISOString();
// 260 bars so the evaluator clears its 210-candle data gate and the assertions
// below test what they claim to rather than failing early on missing history.
const m15 = Array.from({ length: 260 }, (_, i) => bar({ time: day(260 - i) }));
function structuredH1(direction: "bullish" | "bearish" | "mixed") {
  return Array.from({ length: 260 }, (_, i) => {
    const drift = direction === "bullish" ? i * 0.00004 : direction === "bearish" ? -i * 0.00004 : 0;
    const wave = direction === "mixed" ? (i % 2 ? 0.00005 : -0.00005) : Math.sin(i * Math.PI / 3) * 0.0008;
    const close = 1.1 + drift + wave;
    return bar({ time: day((260 - i) * 4), open: close - (direction === "bearish" ? -0.00005 : 0.00005), high: close + 0.0002, low: close - 0.0002, close });
  });
}
const h1 = structuredH1("bullish");
const bearishH1 = structuredH1("bearish");
const mixedH1 = structuredH1("mixed");
const h4 = Array.from({ length: 260 }, (_, i) => bar({ time: day((260 - i) * 12) }));
const levels = mapLiquidityLevels(m15, h1, h4);
assert.ok(levels.length > 0, "levels are mapped from the available history");
assert.ok(levels.every((item) => Number.isFinite(item.price)), "every mapped level carries a real price");
assert.equal(classifyH1Structure(h1).direction, "bullish", "confirmed H1 higher highs and lows establish bullish direction");
assert.equal(classifyH1Structure(bearishH1).direction, "bearish", "confirmed H1 lower highs and lows establish bearish direction");
assert.equal(classifyH1Structure(mixedH1).direction, "mixed", "unclear H1 structure stays mixed");

// The evaluator refuses to trade without enough history rather than guessing.
const thin = evaluateLiquiditySetup({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: m15.slice(0, 10), candles1h: h1.slice(0, 10), candles4h: h4.slice(0, 10),
  bid: 1.1, ask: 1.10015, spreadPips: 1.5, marketOpen: true,
  calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
  evaluatedAt: "2026-04-06T12:00:00.000Z",
});
assert.equal(thin.status, "invalid", "thin candle history must not produce a tradeable setup");
assert.equal(thin.conditions.find((c) => c.name === "Market data")?.passed, false, "the failure is attributed to market data");

// A closed session is a hard requirement: no score rescues it.
const closed = evaluateLiquiditySetup({
  instrument: "EUR_USD", accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
  candles15m: m15, candles1h: h1, candles4h: h4,
  bid: 1.1, ask: 1.10015, spreadPips: 1.5, marketOpen: false,
  calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
  evaluatedAt: "2026-04-06T01:00:00.000Z", // 21:00 ET Sunday-equivalent, outside both sessions
});
assert.notEqual(closed.status, "valid", "a setup outside the session window is never tradeable");
assert.equal(closed.conditions.find((c) => c.name === "Market data")?.passed, true, "the closed-session case must clear the data gate, or it proves nothing about sessions");
assert.equal(closed.conditions.find((c) => c.name === "Session")?.passed, false, "the failure is attributed to the session");

// News is a gate that must never claim an all-clear it cannot support.
const base = {
  instrument: "EUR_USD" as const, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda" as const,
  candles15m: m15, candles1h: h1, candles4h: h4,
  bid: 1.1, ask: 1.10015, spreadPips: 1.5, marketOpen: true,
  evaluatedAt: "2026-04-06T14:00:00.000Z", // 10:00 ET, inside the overlap
};

const noFeed = evaluateLiquiditySetup({ ...base, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: true });
const noFeedNews = noFeed.conditions.find((c) => c.name === "News");
assert.equal(noFeedNews?.passed, false, "an unusable feed cannot clear the news gate");
assert.equal(noFeedNews?.required, true, "an unusable feed hard-blocks trading");
assert.match(noFeedNews?.reason ?? "", /entries pause/i, "an unusable feed reports the safety pause instead of an all-clear");

const imminent = evaluateLiquiditySetup({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: 10, newsRequired: true });
const imminentNews = imminent.conditions.find((c) => c.name === "News");
assert.equal(imminentNews?.passed, false, "a release inside the buffer fails the news gate");
assert.equal(imminentNews?.required, true, "and blocks the trade");
assert.notEqual(imminent.status, "valid", "no setup trades into an imminent high-impact release");

const distant = evaluateLiquiditySetup({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: 240, newsRequired: true });
assert.equal(distant.conditions.find((c) => c.name === "News")?.passed, true, "a release well beyond the buffer does not block");

// The batch is only worth collecting if the decision is recorded with it. These
// fields cannot be reconstructed later — the level that was swept exists only in
// the candles at decision time — so a setup that finds a sweep must carry them.
const sweptSeries = [
  ...Array.from({ length: 256 }, (_, i) => bar({ time: day(260 - i) })),
  bar({ time: day(4), high: 1.1010, low: 1.1002, close: 1.1008 }),
  bar({ time: day(3), high: 1.1005, low: 1.0990, close: 1.0999 }),
  bar({ time: day(2), high: 1.1008, low: 1.0998, close: 1.1004 }),
  bar({ time: day(1), open: 1.0997, high: 1.1016, low: 1.0996, close: 1.1014 }),
];
const recorded = evaluateLiquiditySetup({
  ...base,
  calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
  candles15m: sweptSeries,
  bid: 1.1014, ask: 1.10155,
  macroBias: "long", macroDetail: "test", evaluationMode: "historical_replay",
});
assert.equal(recorded.conditions.find((c) => c.name === "Liquidity sweep")?.passed, true, "the fixture must actually sweep, or it tests nothing");

const decision = recorded.features.liquidity;
assert.ok(decision, "a setup with a sweep records what it decided on");
assert.equal(decision!.sweptLevelKind, "asian-low", "the swept level's kind is recorded, so a batch can be sliced by it");
assert.equal(decision!.sweptLevelSide, "low", "and which side of price it sat on");
assert.ok(decision!.sweepDepthAtr! > 0, "how far beyond the level price traded is recorded in ATR");
assert.equal(typeof decision!.sweepBarsAgo, "number", "and how long ago");
for (const flag of ["rejection", "displacement", "structureBreak", "retest", "macroAgrees", "overlapSession"] as const) {
  assert.equal(typeof decision![flag], "boolean", `${flag} is recorded, not inferred later`);
}
assert.equal(decision!.macroBias, "long", "the macro read the scorecard saw is kept");
assert.equal(decision!.scoreOutOf, 0, "v2 does not use a weighted admission score");
assert.equal(typeof decision!.atSweptLevel, "boolean", "actual swept-level location is recorded independently");
assert.equal(typeof decision!.atOtherLiquidityLevel, "boolean", "unrelated nearby liquidity is recorded separately");
assert.ok(decision!.liquidityConfluenceCount >= 1, "liquidity confluence is observable without substituting for the swept level");
assert.equal(recorded.features.h1Direction, "bullish", "H1 direction is stored with the evaluation");
assert.equal(recorded.features.newsStatus, "not_evaluated", "price-only replay records news as not evaluated");
assert.equal(recorded.conditions.find((c) => c.name === "News")?.required, false, "historical replay can evaluate technical rules without a fictional news pass");
assert.equal(recorded.conditions.find((c) => c.name === "Pullback")?.passed, true, "a downward counter-trend leg is an explicit bullish pullback");
assert.equal(recorded.status, "valid", "historical replay can produce a technically valid setup without historical news data");

// The short side is the mirror, and it was previously only asserted at the
// findSweep level. Everything downstream of direction — which side the wick is
// measured on, which way the stop goes, which price fills — has to flip too, so
// the whole path is exercised rather than just the sweep.
const shortSeries = [
  ...Array.from({ length: 256 }, (_, i) => bar({ time: day(260 - i) })),
  bar({ time: day(4), high: 1.1003, low: 1.0996, close: 1.0998 }),
  bar({ time: day(3), high: 1.1020, low: 1.1000, close: 1.1002 }),
  bar({ time: day(2), high: 1.1004, low: 1.0994, close: 1.0999 }),
  bar({ time: day(1), open: 1.1003, high: 1.1004, low: 1.0982, close: 1.0984 }),
];
const shortSetup = evaluateLiquiditySetup({
  ...base,
  calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
  candles15m: shortSeries, candles1h: bearishH1,
  bid: 1.0984, ask: 1.09855,
  macroBias: "short", macroDetail: "test", evaluationMode: "historical_replay",
});
assert.equal(shortSetup.direction, "short", "sweeping a high sets up a short");
assert.equal(shortSetup.features.liquidity?.sweptLevelSide, "high", "and records the high as the level taken");
assert.ok(shortSetup.entry !== null && shortSetup.stop !== null && shortSetup.target !== null, "a short setup prices all three levels");
// A short sells at the bid; buying back at the ask is the cost, not the fill.
assert.equal(shortSetup.entry, 1.0984, "a short enters at the bid, not the ask");
assert.ok(shortSetup.stop! > shortSetup.entry!, "a short's stop sits above its entry");
assert.ok(shortSetup.target! < shortSetup.entry!, "a short's target sits below its entry");
assert.equal(
  Number(((shortSetup.entry! - shortSetup.target!) / (shortSetup.stop! - shortSetup.entry!)).toFixed(2)),
  RISK.targetR,
  "a short is paid the same multiple of its risk as a long",
);
assert.equal(shortSetup.conditions.find((c) => c.name === "Pullback")?.passed, true, "an upward counter-trend leg is an explicit bearish pullback");
assert.equal(shortSetup.status, "valid", "bearish H1 with an upward pullback and high reclaim can qualify");

const monotonicUp = Array.from({ length: 260 }, (_, i) => bar({ time: day(260 - i), open: 1 + i * 0.001, high: 1.0004 + i * 0.001, low: 0.9999 + i * 0.001, close: 1.0003 + i * 0.001 }));
const monotonicDown = Array.from({ length: 260 }, (_, i) => bar({ time: day(260 - i), open: 1.3 - i * 0.001, high: 1.3001 - i * 0.001, low: 1.2996 - i * 0.001, close: 1.2997 - i * 0.001 }));
assert.equal(analyzePullback(monotonicUp, "long", ATR, 0).detected, false, "bullish H1 without a downward pullback does not qualify");
assert.equal(analyzePullback(monotonicDown, "short", ATR, 0).detected, false, "bearish H1 without an upward pullback does not qualify");

const bullishWrongSweep = evaluateLiquiditySetup({
  ...base, candles15m: shortSeries, calendarConnected: true, highImpactNewsWithinMinutes: 240,
  macroBias: "short", macroDetail: "test",
});
assert.equal(bullishWrongSweep.direction, null, "bullish H1 never turns a swept high into a short");
assert.match(bullishWrongSweep.conditions.find((c) => c.name === "Liquidity sweep")?.reason ?? "", /wrong-direction/i);

const bearishWrongSweep = evaluateLiquiditySetup({
  ...base, candles15m: sweptSeries, candles1h: bearishH1, calendarConnected: true, highImpactNewsWithinMinutes: 240,
  macroBias: "long", macroDetail: "test",
});
assert.equal(bearishWrongSweep.direction, null, "bearish H1 never turns a swept low into a long");

const mixedDirection = evaluateLiquiditySetup({ ...base, candles1h: mixedH1, calendarConnected: true, highImpactNewsWithinMinutes: 240 });
assert.equal(mixedDirection.direction, null, "mixed H1 structure produces no trade direction");

const brokenBullishH1 = h1.map((candle, index) => index === h1.length - 1 ? { ...candle, close: 0.5, low: 0.49 } : candle);
const brokenStructure = evaluateLiquiditySetup({ ...base, candles15m: sweptSeries, candles1h: brokenBullishH1, calendarConnected: true, highImpactNewsWithinMinutes: 240 });
assert.equal(brokenStructure.direction, null, "a broken H1 swing invalidates the pullback thesis");

const incompleteBearishTail = [...h1, { ...h1.at(-1)!, close: 0.5, low: 0.49, complete: false }];
assert.equal(classifyH1Structure(incompleteBearishTail).direction, "bullish", "incomplete H1 candles cannot alter direction");

const liveNoCalendar = evaluateLiquiditySetup({ ...base, candles15m: sweptSeries, calendarConnected: false, highImpactNewsWithinMinutes: null, evaluationMode: "live", macroBias: "long" });
assert.equal(liveNoCalendar.conditions.find((c) => c.name === "News")?.passed, false, "live evaluation remains fail-closed without a calendar");
assert.notEqual(liveNoCalendar.status, "valid", "historical replay mode cannot weaken live news safety");

assert.equal(signedPracticeUnits("long", 1234.9), 1234, "LONG still maps to positive OANDA units");
assert.equal(signedPracticeUnits("short", 1234.9), -1234, "SHORT still maps to negative OANDA units");

// No sweep, nothing to describe: the field is null rather than stale or invented.
assert.equal(
  evaluateLiquiditySetup({ ...base, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false }).features.liquidity ?? null,
  null,
  "a setup with no sweep records no decision features",
);

console.log("Liquidity strategy checks passed.");
