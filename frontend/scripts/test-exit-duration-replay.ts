import assert from "node:assert/strict";
import { signalFor } from "./experiment-exit-duration";
import { resolveSignal, type TradeAudit } from "./validate-executable-costs";
import type { ResearchCandle } from "../src/lib/oanda/client";

const trade = {
  pair: "USD_JPY", strategy: "fixture", version: "v1", direction: "long",
  signalTimestamp: "2024-01-02T11:00:00.000Z", decisionTime: "2024-01-02T12:00:00.000Z",
  midEntry: 100, atr: 1, stop: 99, target: 102, confidenceTag: null, origin: null,
} as TradeAudit;
function bar(hour: number, high = 100.6, low = 99.8, close = 100.5): ResearchCandle {
  const mid = { open: 100, high, low, close };
  const side = (delta: number) => Object.fromEntries(Object.entries(mid).map(([key, value]) => [key, value + delta])) as ResearchCandle["mid"];
  return { time: `2024-01-02T${hour}:00:00.000Z`, complete: true, volume: 1, mid, bid: side(-0.1), ask: side(0.1) };
}
const candles = [bar(11, 100.2, 99.8, 100), bar(12), bar(13), bar(14), bar(15, 102.3)];
const control = signalFor(trade, "EXECUTABLE_ENTRY_ATR", "CONTROL");
const longer = signalFor(trade, "EXECUTABLE_ENTRY_ATR", "4H");
assert.equal(control.maxHoldBars, 3);
assert.equal(resolveSignal(control, candles, "executable")!.exitReason, "TIME_EXIT");
assert.ok(Math.abs(resolveSignal(control, candles, "executable")!.resultR - 0.3) < 1e-9);
assert.equal(resolveSignal(longer, candles, "executable")!.exitReason, "TP");
assert.ok(Math.abs(resolveSignal(longer, candles, "executable")!.resultR - 2) < 1e-9);
// Ask touching a long target does not close a long when bid has not touched it.
assert.equal(resolveSignal(longer, [...candles.slice(0, 4), bar(15, 102.1)], "executable")!.exitReason, "TIME_EXIT");
const ambiguous = resolveSignal(longer, [candles[0]!, bar(12, 103, 98)], "executable")!;
assert.equal(ambiguous.exitReason, "SL"); assert.equal(ambiguous.resultR, -1); assert.equal(ambiguous.ambiguousSameBar, true);
// Reflection swaps executable sides and preserves the same long/short outcomes.
const reflected = candles.map(c => {
  const mirror = (p: ResearchCandle["mid"]) => ({ open: 200 - p.open, high: 200 - p.low, low: 200 - p.high, close: 200 - p.close });
  return { ...c, mid: mirror(c.mid), bid: mirror(c.ask), ask: mirror(c.bid) };
});
const short = signalFor({ ...trade, direction: "short" }, "EXECUTABLE_ENTRY_ATR", "4H");
assert.equal(resolveSignal(short, reflected, "executable")!.exitReason, "TP");
assert.ok(Math.abs(resolveSignal(short, reflected, "executable")!.resultR - 2) < 1e-9);
assert.equal(resolveSignal(longer, candles.slice(0, 3), "executable"), null);
assert.equal(resolveSignal(signalFor(trade, "EXECUTABLE_ENTRY_ATR", "NO_TIMEOUT"), candles.slice(0, 4), "executable"), null);
assert.equal(signalFor({ ...trade, pair: "EUR_USD" }, "MIDPOINT_LEVELS", "CONTROL").maxHoldBars, null);
for (const [variant, bars] of [["4H", 8], ["6H", 12], ["8H", 16], ["12H", 24]] as const) {
  const gbp = signalFor({ ...trade, pair: "GBP_USD" }, "MIDPOINT_LEVELS", variant);
  assert.equal(gbp.maxHoldBars, bars); assert.equal(gbp.midStop, 99); assert.equal(gbp.midTarget, 102);
}
assert.equal(signalFor({ ...trade, pair: "GBP_USD" }, "MIDPOINT_LEVELS", "CONTROL").maxHoldBars, 6);
console.log("Exit-duration replay tests passed: timing, sides, frozen geometry, same-bar stops, censoring and GBP M30 conversion.");
