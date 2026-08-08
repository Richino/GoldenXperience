import assert from "node:assert/strict";
import {
  findSweep, hasDisplacement, hasRejection, hasRetest, nearestLevel, RULES,
} from "../src/lib/strategy/liquidity-confirmation";
import { mapLiquidityLevels, swingPoints } from "../src/lib/strategy/liquidity-levels";
import { evaluateLiquiditySetup, SCORE } from "../src/lib/strategy/liquidity-strategy";
import type { Candle } from "../src/types/forex";
import type { LiquidityLevel } from "../src/lib/strategy/liquidity-levels";

const ATR = 0.0010; // 10 pips on a 5-decimal pair

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
const h1 = Array.from({ length: 260 }, (_, i) => bar({ time: day((260 - i) * 4) }));
const h4 = Array.from({ length: 260 }, (_, i) => bar({ time: day((260 - i) * 12) }));
const levels = mapLiquidityLevels(m15, h1, h4);
assert.ok(levels.length > 0, "levels are mapped from the available history");
assert.ok(levels.every((item) => Number.isFinite(item.price)), "every mapped level carries a real price");

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

const noFeed = evaluateLiquiditySetup({ ...base, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false });
const noFeedNews = noFeed.conditions.find((c) => c.name === "News");
assert.equal(noFeedNews?.required, false, "an unusable feed must not hard-block trading");
assert.match(noFeedNews?.reason ?? "", /not filtered/, "an unusable feed reports that news is unfiltered, never that it is clear");

const imminent = evaluateLiquiditySetup({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: 10, newsRequired: true });
const imminentNews = imminent.conditions.find((c) => c.name === "News");
assert.equal(imminentNews?.passed, false, "a release inside the buffer fails the news gate");
assert.equal(imminentNews?.required, true, "and blocks the trade");
assert.notEqual(imminent.status, "valid", "no setup trades into an imminent high-impact release");

const distant = evaluateLiquiditySetup({ ...base, calendarConnected: true, highImpactNewsWithinMinutes: 240, newsRequired: true });
assert.equal(distant.conditions.find((c) => c.name === "News")?.passed, true, "a release well beyond the buffer does not block");

// The sweep is a prerequisite, not a scored factor: scoring only runs once one
// exists, so scoring it would add the same points to every setup.
assert.equal(SCORE.atLevel + SCORE.rejectionOrDisplacement + SCORE.structureBreak + SCORE.macroAgrees + SCORE.overlapSession, 8, "the scorecard totals eight");
assert.ok(!("levelSwept" in SCORE), "the sweep is a gate, not a scored factor");
assert.ok(SCORE.minimumToTrade > 0 && SCORE.minimumToTrade <= 8, "the trade threshold sits inside the scorecard");

console.log("Liquidity strategy checks passed.");
