import assert from "node:assert/strict";
import { verifiedAbsorptionAlerts } from "../src/absorption-alerts.js";
import { ABSORPTION_DEFAULTS, calculateAbsorption } from "../../frontend/src/lib/indicators/absorption.js";
import type { Candle, CandleSeries } from "../../frontend/src/types/forex.js";
const start = Date.parse("2026-10-26T00:00:00Z");
const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({ time: new Date(start + i * 3_600_000).toISOString(), open: 1.105, high: 1.11, low: 1.1, close: 1.105, volume: 100, complete: true }));
candles.push({ ...candles[0], time: new Date(start + 20 * 3_600_000).toISOString(), open: 1.107, close: 1.108, volume: 250 });
const series: CandleSeries = { candles, instrument: "EUR_USD", granularity: "H1", source: "oanda" };
const event = calculateAbsorption(candles, series.instrument, "H1").events[0];
const now = start + 21 * 3_600_000 + 1;
const alerts = verifiedAbsorptionAlerts(series, ABSORPTION_DEFAULTS, [event.id, event.id], now);
assert.equal(alerts.length, 1); assert.equal(alerts[0].dedupeKey, event.id); assert.match(alerts[0].message, /EUR\/USD.*H1.*bullish candidate.*strength 100/);
assert.equal(verifiedAbsorptionAlerts({ ...series, source: "mock" }, ABSORPTION_DEFAULTS, [event.id], now).length, 0);
assert.equal(verifiedAbsorptionAlerts(series, ABSORPTION_DEFAULTS, ["forged"], now).length, 0);
assert.equal(verifiedAbsorptionAlerts(series, ABSORPTION_DEFAULTS, [event.id], start).length, 0);
assert.equal(verifiedAbsorptionAlerts(series, ABSORPTION_DEFAULTS, [event.id], now + 3 * 3_600_000).length, 0);
for (const direction of ["bullish", "bearish"]) {
  const candidate = { ...candles.at(-1)!, open: direction === "bullish" ? 1.107 : 1.103, close: direction === "bullish" ? 1.108 : 1.102 };
  const confirmation: Candle = { ...candidate, time: new Date(start + 21 * 3_600_000).toISOString(), high: 1.113, low: 1.098, close: direction === "bullish" ? 1.112 : 1.099, volume: 100 };
  const verified = { ...series, candles: [...candles.slice(0, 20), candidate, confirmation] };
  const events = calculateAbsorption(verified.candles, "EUR_USD", "H1").events;
  const result = verifiedAbsorptionAlerts(verified, ABSORPTION_DEFAULTS, events.map(e => e.id), start + 22 * 3_600_000);
  assert.equal(result.length, 2);
  assert.match(result[0].title, new RegExp(`${direction} candidate`));
  assert.match(result[1].title, new RegExp(`${direction} confirmed`));
  assert.match(result[1].message, new RegExp(String(confirmation.close)));
}
console.log("Absorption alert verification, recency and stable deduplication keys passed (no notifications sent).");
