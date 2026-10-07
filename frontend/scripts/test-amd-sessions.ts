import assert from "node:assert/strict";
import { computeAmdSessionBoxes } from "../src/lib/strategy/amd-sessions";
import type { Candle } from "../src/types/forex";

function dayCandles(day: string): Candle[] {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  // A one-way breakout, with no reclaim: all three scheduled windows must
  // still appear, and the D rectangle must keep covering prices until noon.
  return Array.from({ length: 96 }, (_, i) => ({
    time: new Date(midnight + i * 15 * 60_000).toISOString(),
    open: 1.1 + i * 0.001,
    high: 1.102 + i * 0.001,
    low: 1.099 + i * 0.001,
    close: 1.101 + i * 0.001,
    volume: 100,
    complete: true,
  }));
}

for (const [day, londonHour, nyHour, noonHour] of [
  ["2026-01-15", 8, 13, 17], // standard time
  ["2026-07-15", 7, 12, 16], // daylight time
  ["2026-03-10", 8, 12, 16], // US has changed; UK has not
  ["2026-10-28", 8, 12, 16], // UK has changed; US has not
] as const) {
  const candles = dayCandles(day);
  const boxes = computeAmdSessionBoxes(candles);
  assert.deepEqual(boxes.map((box) => box.label), ["A · Asia", "M · London", "D · NY"]);
  const isoHour = (hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  assert.equal(boxes[0]!.startTime, isoHour(0));
  assert.equal(boxes[0]!.endTime, isoHour(londonHour));
  assert.equal(boxes[1]!.startTime, isoHour(londonHour));
  assert.equal(boxes[1]!.endTime, isoHour(nyHour));
  assert.equal(boxes[2]!.startTime, isoHour(nyHour));
  assert.equal(boxes[2]!.endTime, isoHour(noonHour));
  assert.equal(boxes[2]!.top, candles[noonHour * 4 - 1]!.high, "include 11:45 NY; exclude 12:00 NY and later prices");
  assert.equal(boxes[2]!.bottom, candles[nyHour * 4]!.low);
  assert.ok(boxes.every((box) => !box.faded));
  assert.deepEqual(computeAmdSessionBoxes([...candles].reverse()), boxes, "input order cannot change the sessions");
}

{
  const candles = dayCandles("2026-07-15");
  const prefix = candles.slice(0, 54); // latest close at 09:30 NY
  const boxes = computeAmdSessionBoxes(prefix);
  assert.equal(boxes[2]!.endTime, "2026-07-15T13:30:00.000Z", "D grows only with known closed candles");
  assert.equal(boxes[2]!.faded, true);
  assert.deepEqual(computeAmdSessionBoxes([...prefix, { ...candles[54]!, complete: false }]), boxes, "forming candle cannot extend the session");
  const morning = computeAmdSessionBoxes(candles.slice(0, 40));
  assert.deepEqual(morning.map((box) => box.label), ["A · Asia", "M · London"], "future D prices are not invented before New York opens");
  assert.deepEqual(computeAmdSessionBoxes([...prefix, ...candles.slice(64)]), boxes, "afternoon data cannot extend D beyond noon");
  assert.deepEqual(computeAmdSessionBoxes([]), []);
  assert.deepEqual(computeAmdSessionBoxes([{ ...candles[0]!, time: "invalid" }]), []);
  const twoDays = computeAmdSessionBoxes([...candles, ...dayCandles("2026-07-16")]);
  assert.equal(twoDays.length, 6, "each loaded day has its own three windows");
  assert.equal(new Set(twoDays.map((box) => box.key)).size, 6);
}

console.log("AMD scheduled session tests passed");
