import assert from "node:assert/strict";
import { calculateVolumeProfile, VolumeProfileQuoteBuffer } from "../src/lib/volume-profile";
import type { MarketPriceTick } from "../src/types/market-stream";

const profile = calculateVolumeProfile(new Map([[100, 2], [107.5, 21], [108.5, 10], [132, 4]]));
assert.ok(profile);
assert.equal(profile.quoteCount, 37);
assert.equal(profile.rows[7].volume, 21);
assert.equal(profile.rows.at(-1)?.volume, 4);
assert.equal(profile.pocPrice, 107.5);
assert.deepEqual(profile.valueArea, { first: 7, last: 8, low: 107, high: 109 });
assert.equal(calculateVolumeProfile(new Map([[100, 5]]))?.pocPrice, 100);
assert.equal(calculateVolumeProfile(new Map()), null);

const buffer = new VolumeProfileQuoteBuffer();
const start = Date.parse("2026-10-01T12:00:00Z");
const quote: MarketPriceTick = {
  type: "price", source: "oanda", instrument: "EUR_USD", displayName: "EUR/USD",
  bid: 1.24, ask: 1.26, mid: 1.25, spread: 0.02, status: "tradeable",
  time: new Date(start).toISOString(), sequence: 1,
};
assert.equal(buffer.add(quote, start, 5), true);
assert.equal(buffer.add(quote, start, 5), false);
assert.equal(buffer.add({ ...quote, source: "mock", time: "2026-10-01T12:00:01Z" }, start, 5), false);
assert.equal(buffer.add({ ...quote, time: "2026-10-01T12:00:02Z" }, start, 5), true);
assert.equal(buffer.snapshot().profile?.quoteCount, 2);

const next = start + 60_000;
assert.equal(buffer.add({ ...quote, mid: 1.27, time: new Date(next).toISOString() }, next, 5), true);
assert.equal(buffer.add({ ...quote, time: "2026-10-01T12:00:50Z" }, start, 5), false);
assert.equal(buffer.snapshot().candleStart, next);
assert.equal(buffer.snapshot().profile?.quoteCount, 1);
assert.equal(buffer.snapshot().profile?.pocPrice, 1.27);
console.log("Volume profile checks passed.");
