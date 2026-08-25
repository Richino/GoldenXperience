import assert from "node:assert/strict";
import {
  MOMENTUM_BURST_DIRECTION_CONFIG,
  decideMomentumBurstDirection,
  invertMomentumBurstDirection,
  type MomentumBurstBar,
} from "../src/momentum-burst-direction.js";

function bar(index: number, open: number, high: number, low: number, close: number): MomentumBurstBar {
  return { closeTime: new Date(Date.UTC(2026, 7, 24, 9, index * 15)).toISOString(), open, high, low, close };
}

const longBurst: MomentumBurstBar[] = [
  bar(0, 100.0, 101.0, 99.0, 100.8),
  bar(1, 100.8, 102.8, 100.2, 102.3),
  bar(2, 102.3, 104.7, 101.9, 104.1),
  bar(3, 104.1, 106.7, 103.8, 106.2),
  bar(4, 106.2, 108.7, 105.9, 108.2),
  bar(5, 108.2, 110.0, 107.5, 109.6),
];

// FOLLOW: pull back, close through the frozen high with a buffer, hold, enter next bar.
{
  const bars = [
    ...longBurst,
    bar(6, 109.6, 109.8, 107.2, 108.4),
    bar(7, 108.4, 110.6, 108.2, 110.4),
    bar(8, 110.4, 110.8, 109.9, 110.3),
    bar(9, 110.3, 111.0, 110.1, 110.8),
  ];
  const result = decideMomentumBurstDirection({ bars, setupIndex: 5, originalDirection: "long", atr: 2 });
  assert.equal(result.action, "follow");
  assert.equal(result.direction, "long");
  assert.equal(result.confirmationBars, 3);
  assert.equal(result.knownAtIndex, 8);
  assert.equal(result.entryIndex, 9);
  assert.equal(result.pulledBack, true);
  assert.ok(result.confidence >= 68);
}

// A breakout close without the required completed hold is not FOLLOW.
{
  const bars = [
    ...longBurst,
    bar(6, 109.6, 109.8, 107.2, 108.4),
    bar(7, 108.4, 110.6, 108.2, 110.4),
    bar(8, 110.4, 110.5, 108.9, 109.8),
    bar(9, 109.8, 110.1, 109.0, 109.5),
  ];
  const result = decideMomentumBurstDirection({ bars, setupIndex: 5, originalDirection: "long", atr: 2 });
  assert.equal(result.action, "wait");
  assert.equal(result.direction, null);
}

// REVERSE: no accepted continuation and the second completed bar loses midpoint.
{
  const bars = [
    ...longBurst,
    bar(6, 109.6, 110.1, 107.8, 108.5),
    bar(7, 108.5, 108.7, 103.9, 104.2),
    bar(8, 104.2, 105.0, 103.5, 104.0),
  ];
  const result = decideMomentumBurstDirection({ bars, setupIndex: 5, originalDirection: "long", atr: 2 });
  assert.equal(result.action, "reverse");
  assert.equal(result.direction, "short");
  assert.equal(result.confirmationBars, 2);
  assert.equal(result.entryIndex, 8);
  assert.ok(result.attemptedContinuation);
  assert.ok(result.confidence >= 62);
}

// WAIT is explicit when neither branch confirms inside the fixed window.
{
  const bars = [
    ...longBurst,
    bar(6, 109.6, 109.9, 108.1, 109.0),
    bar(7, 109.0, 109.4, 107.5, 108.4),
    bar(8, 108.4, 109.2, 107.8, 108.8),
    bar(9, 108.8, 109.0, 108.1, 108.5),
  ];
  const result = decideMomentumBurstDirection({ bars, setupIndex: 5, originalDirection: "long", atr: 2 });
  assert.equal(result.action, "wait");
  assert.equal(result.entryIndex, null);
  assert.equal(result.confidence, 0);
}

// Short handling is an exact mirror, not separate hand-written sign logic.
{
  const mirror = (item: MomentumBurstBar): MomentumBurstBar => ({
    ...item,
    open: 200 - item.open,
    high: 200 - item.low,
    low: 200 - item.high,
    close: 200 - item.close,
  });
  const longFollow = [
    ...longBurst,
    bar(6, 109.6, 109.8, 107.2, 108.4),
    bar(7, 108.4, 110.6, 108.2, 110.4),
    bar(8, 110.4, 110.8, 109.9, 110.3),
    bar(9, 110.3, 111.0, 110.1, 110.8),
  ];
  const result = decideMomentumBurstDirection({ bars: longFollow.map(mirror), setupIndex: 5, originalDirection: "short", atr: 2 });
  assert.equal(result.action, "follow");
  assert.equal(result.direction, "short");
}

// The chosen arm and its paired opposite are always genuine opposites.
assert.equal(invertMomentumBurstDirection("long"), "short");
assert.equal(invertMomentumBurstDirection("short"), "long");
assert.deepEqual(MOMENTUM_BURST_DIRECTION_CONFIG, {
  burstRangeBars: 6,
  maxConfirmationBars: 3,
  pullbackFraction: 0.20,
  breakoutBufferAtr: 0.05,
  attemptBufferAtr: 0.02,
  reverseMidpointFraction: 0.50,
});

console.log("momentum burst direction tests passed");
