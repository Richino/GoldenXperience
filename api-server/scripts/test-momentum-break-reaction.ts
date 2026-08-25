import assert from "node:assert/strict";
import {
  MOMENTUM_BREAK_REACTION_CONFIG,
  decideMomentumBreakReaction,
  invertMomentumBreakReactionDirection,
} from "../src/momentum-break-reaction.js";
import type { MomentumIgnitionBar } from "../src/momentum-early-ignition.js";

const base = Date.UTC(2026, 7, 24, 10, 0);

function bar(index: number, open: number, high: number, low: number, close: number): MomentumIgnitionBar {
  return { closeTime: new Date(base + (index + 1) * 5 * 60_000).toISOString(), open, high, low, close };
}

const breakout = bar(0, 99.80, 100.40, 99.75, 100.30);

// FOLLOW: the first reaction candle retests 100, holds beyond it, and enters next open.
{
  const bars = [breakout, bar(1, 100.30, 100.35, 100.05, 100.16), bar(2, 100.17, 100.40, 100.10, 100.30)];
  const result = decideMomentumBreakReaction({ bars, breakoutIndex: 0, breakoutDirection: "long", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "follow");
  assert.equal(result.direction, "long");
  assert.equal(result.reactionBars, 1);
  assert.equal(result.entryIndex, 2);
  assert.equal(result.retested, true);
  assert.ok(result.ruleStrength >= 60);
}

// REVERSE: the first completed reaction closes materially back inside the range.
{
  const bars = [breakout, bar(1, 100.30, 100.34, 99.80, 99.94), bar(2, 99.93, 100.02, 99.60, 99.70)];
  const result = decideMomentumBreakReaction({ bars, breakoutIndex: 0, breakoutDirection: "long", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "reverse");
  assert.equal(result.direction, "short");
  assert.equal(result.reactionBars, 1);
  assert.ok(result.rejectionDepthM15Atr !== null && result.rejectionDepthM15Atr >= 0.03);
}

// Clean continuation without a retest is WAIT; this policy does not chase it.
{
  const bars = [
    breakout,
    bar(1, 100.30, 100.60, 100.25, 100.50),
    bar(2, 100.50, 100.80, 100.30, 100.70),
    bar(3, 100.70, 100.90, 100.50, 100.80),
  ];
  const result = decideMomentumBreakReaction({ bars, breakoutIndex: 0, breakoutDirection: "long", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "wait");
  assert.equal(result.direction, null);
}

// A shallow undecided close is neither accepted nor rejected.
{
  const bars = [breakout, bar(1, 100.30, 100.32, 99.98, 100.01), bar(2, 100.01, 100.10, 99.98, 100.01), bar(3, 100.01, 100.05, 99.99, 100.00)];
  const result = decideMomentumBreakReaction({ bars, breakoutIndex: 0, breakoutDirection: "long", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "wait");
}

// A qualifying reaction whose next open is already overextended is WAIT.
{
  const bars = [breakout, bar(1, 100.30, 100.35, 100.05, 100.16), bar(2, 100.60, 100.70, 100.55, 100.65)];
  const result = decideMomentumBreakReaction({ bars, breakoutIndex: 0, breakoutDirection: "long", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "wait");
}

// The future high/low/close of the entry candle cannot affect the decision.
{
  const clean = [breakout, bar(1, 100.30, 100.35, 100.05, 100.16), bar(2, 100.17, 100.40, 100.10, 100.30)];
  const changed = clean.map((item) => ({ ...item }));
  changed[2] = { ...changed[2]!, high: 150, low: 50, close: 75 };
  const args = { breakoutIndex: 0, breakoutDirection: "long" as const, breakoutLevel: 100, m15Atr: 1 };
  assert.deepEqual(decideMomentumBreakReaction({ bars: changed, ...args }), decideMomentumBreakReaction({ bars: clean, ...args }));
}

// Short handling is a price mirror of long handling.
{
  const longBars = [breakout, bar(1, 100.30, 100.34, 99.80, 99.94), bar(2, 99.93, 100.02, 99.60, 99.70)];
  const mirror = (item: MomentumIgnitionBar): MomentumIgnitionBar => ({
    ...item,
    open: 200 - item.open,
    high: 200 - item.low,
    low: 200 - item.high,
    close: 200 - item.close,
  });
  const result = decideMomentumBreakReaction({ bars: longBars.map(mirror), breakoutIndex: 0, breakoutDirection: "short", breakoutLevel: 100, m15Atr: 1 });
  assert.equal(result.action, "reverse");
  assert.equal(result.direction, "long");
}

assert.equal(invertMomentumBreakReactionDirection("long"), "short");
assert.equal(invertMomentumBreakReactionDirection("short"), "long");
assert.deepEqual(MOMENTUM_BREAK_REACTION_CONFIG, {
  maxReactionBars: 2,
  retestToleranceM15Atr: 0.15,
  holdBufferM15Atr: 0.02,
  rejectionBufferM15Atr: 0.03,
  maxEntryDistanceM15Atr: 0.50,
});

console.log("momentum break reaction tests passed");
