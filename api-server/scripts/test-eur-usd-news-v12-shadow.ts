import assert from "node:assert/strict";
import {
  EUR_USD_NEWS_V12_SHADOW_POLICY,
  EUR_USD_NEWS_V13_CHALLENGER_POLICY,
  classifyEurUsdNewsV12Event,
  createEurUsdNewsV12Levels,
  groupEurUsdNewsV12Events,
  passesEurUsdNewsV12FrozenFilters,
  resolveEurUsdNewsV12FirstTouch,
  type EurUsdNewsV12Event,
} from "../src/eur-usd-news-v12-shadow.js";

const event = (overrides: Partial<EurUsdNewsV12Event> = {}): EurUsdNewsV12Event => ({
  releaseTimeUtc: "2026-08-07T12:30:00.000Z",
  currency: "USD",
  eventName: "Non-Farm Employment Change",
  actual: "200K",
  forecast: "100K",
  ...overrides,
});

assert.equal(EUR_USD_NEWS_V12_SHADOW_POLICY.ordersAllowed, false);
assert.equal(EUR_USD_NEWS_V12_SHADOW_POLICY.status, "SHADOW_ONLY");
assert.equal(EUR_USD_NEWS_V13_CHALLENGER_POLICY.ordersAllowed, false);
assert.equal(EUR_USD_NEWS_V13_CHALLENGER_POLICY.maximumSpreadToStopRatio, 0.5);
assert.ok(Date.parse(EUR_USD_NEWS_V13_CHALLENGER_POLICY.forwardSampleStartsAt) > Date.parse("2026-08-29T00:00:00.000Z"));
assert.deepEqual(classifyEurUsdNewsV12Event(event()), { direction: -1, magnitude: 1 });
assert.equal(classifyEurUsdNewsV12Event(event({ currency: "EUR" }))?.direction, 1);
assert.equal(classifyEurUsdNewsV12Event(event({ eventName: "Unemployment Rate", actual: "5%", forecast: "4%" }))?.direction, 1);
assert.equal(classifyEurUsdNewsV12Event(event({ eventName: "CPI m/m", actual: "0.4%", forecast: "0.2%" })), null);

const tie = groupEurUsdNewsV12Events([
  event(),
  event({ currency: "EUR", eventName: "Flash Manufacturing PMI", actual: "55", forecast: "50" }),
]);
assert.equal(tie.length, 0, "same-time tied votes must become WAIT");

const [group] = groupEurUsdNewsV12Events([event()]);
assert.ok(group);
assert.equal(passesEurUsdNewsV12FrozenFilters({ group, preReleaseAtr: 0.0005, preReleaseMid: 1.1, confirmationCloseMid: 1.099 }), true);
assert.equal(passesEurUsdNewsV12FrozenFilters({ group, preReleaseAtr: 0.0006, preReleaseMid: 1.1, confirmationCloseMid: 1.099 }), false);
assert.equal(passesEurUsdNewsV12FrozenFilters({ group: { ...group, surpriseStrength: 0.01 }, preReleaseAtr: 0.0005, preReleaseMid: 1.1, confirmationCloseMid: 1.099 }), false);

const long = createEurUsdNewsV12Levels({ direction: 1, executableEntry: 1.1, preReleaseAtr: 0.001 });
assert.ok(Math.abs(long.stop - 1.099) < 1e-12);
assert.ok(Math.abs(long.target - 1.102) < 1e-12);

// OANDA bars are keyed by candle start. Three completed post-release M5 bars
// start at +0, +5 and +10; the next executable open is exactly +15 minutes.
const release = Date.parse("2026-08-07T12:30:00.000Z");
const candleStarts = [0, 5, 10, 15].map((minutes) => release + minutes * 60_000);
assert.equal(candleStarts[3] - release, EUR_USD_NEWS_V12_SHADOW_POLICY.confirmationMinutes * 60_000);

const firstTouch = resolveEurUsdNewsV12FirstTouch({
  direction: 1,
  stop: 1.099,
  target: 1.102,
  bars: [
    { time: "2026-08-07T12:45:00.000Z", bid: { h: 1.101, l: 1.098 }, ask: { h: 1.1012, l: 1.0982 } },
    { time: "2026-08-07T12:46:00.000Z", bid: { h: 1.103, l: 1.1 }, ask: { h: 1.1032, l: 1.1002 } },
  ],
});
assert.deepEqual(firstTouch, { result: "STOP_FIRST", time: "2026-08-07T12:45:00.000Z" });

console.log("EUR/USD news V12 frozen shadow tests passed.");
