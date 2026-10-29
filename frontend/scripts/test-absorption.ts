import assert from "node:assert/strict";
import { ABSORPTION_DEFAULTS as defaults, absorptionScore, candleGeometry, calculateAbsorption, createAbsorptionEngine, parseAbsorptionSettings } from "../src/lib/indicators/absorption";
import type { Candle } from "../src/types/forex";

const start = Date.parse("2026-10-26T00:00:00Z");
const bar = (i: number, patch: Partial<Candle> = {}): Candle => ({ time: new Date(start + i * 3_600_000).toISOString(), open: 1.105, high: 1.11, low: 1.1, close: 1.105, volume: 100, complete: true, ...patch });
const history = Array.from({ length: 20 }, (_, i) => bar(i));
const bull = bar(20, { open: 1.107, high: 1.11, low: 1.1, close: 1.108, volume: 250 });
const bear = bar(20, { open: 1.103, high: 1.11, low: 1.1, close: 1.102, volume: 250 });
const run = (more: Candle[], settings = defaults) => calculateAbsorption([...history, ...more], "EUR_USD", "H1", settings);
let cases = 0;
function check(name: string, fn: () => void) { fn(); cases++; console.log(`PASS ${name}`); }
check("wick, body and close geometry", () => { const g = candleGeometry(bull); assert.ok(Math.abs(g.lowerWickRatio - .7) < 1e-10); assert.ok(Math.abs(g.bodyRatio - .1) < 1e-10); assert.ok(g.closingPosition > .79); assert.equal(candleGeometry(bar(0, { high: 1.105, low: 1.105 })).range, 0); });
check("weighted score and caps", () => { assert.equal(absorptionScore(2.5, .6, .15, true), 100); assert.equal(absorptionScore(0, 0, 1, false), 0); assert.equal(absorptionScore(100, 1, 0, true), 100); assert.ok(Math.abs(absorptionScore(1.5, .4, .5, true) - (21 + 20 + .5 / .85 * 15 + 20)) < 1e-10); });
check("prior volume and structure exclude current candle", () => { const z = run([bull]).zones[0]; assert.equal(z.relativeVolume, 2.5); assert.equal(z.support, 1.1); assert.equal(z.resistance, 1.11); assert.ok(Math.abs(z.atr - .01) < 1e-10); });
check("bullish candidate and lower-wick zone", () => { const z = run([bull]).zones[0]; assert.equal(z.direction, "bullish"); assert.equal(z.status, "Candidate"); assert.equal(z.top, bull.open); assert.equal(z.bottom, bull.low); assert.equal(z.confirmationTime, null); });
check("bearish candidate and upper-wick zone", () => { const z = run([bear]).zones[0]; assert.equal(z.direction, "bearish"); assert.equal(z.top, bear.high); assert.equal(z.bottom, bear.open); });
check("hard volume, rejection, range and structure gates", () => { assert.equal(run([{ ...bull, volume: 149 }]).zones.length, 0); assert.equal(run([{ ...bull, open: 1.101, close: 1.109 }]).zones.length, 0); assert.equal(run([{ ...bull, low: 1.102, high: 1.106, open: 1.105, close: 1.1055 }]).zones.length, 0); assert.equal(run([{ ...bull, low: 1.09 }]).zones.length, 0); assert.equal(calculateAbsorption(history.slice(1).concat(bull), "EUR_USD", "H1").zones.length, 0); });
check("only a later completed close confirms", () => { const wickOnly = bar(21, { high: 1.112, close: 1.109 }); const c = bar(22, { high: 1.113, close: 1.112 }); const result = run([bull, wickOnly, c]); const z = result.zones[0]; assert.equal(z.status, "Confirmed"); assert.equal(z.confirmationTime, c.time); assert.equal(z.confirmationPrice, c.close); assert.deepEqual(result.events.map(e => e.phase), ["candidate", "confirmed"]); assert.equal(run([bull, { ...c, complete: false }]).zones[0].status, "Candidate"); });
check("bearish confirmation", () => { assert.equal(run([bear, bar(21, { low: 1.098, close: 1.099 })]).zones[0].status, "Confirmed"); });
check("invalidation wins and cannot later confirm", () => { const result = run([bull, bar(21, { low: 1.098, close: 1.099 }), bar(22, { high: 1.113, close: 1.112 })]); assert.equal(result.zones[0].status, "Invalidated"); assert.equal(result.events.filter(e => e.phase === "confirmed").length, 0); assert.equal(run([bear, bar(21, { high: 1.113, close: 1.112 })]).zones[0].status, "Invalidated"); });
check("four-bar expiration and inclusive last-bar confirmation", () => { assert.equal(run([bull, ...[21, 22, 23, 24].map(i => bar(i))]).zones[0].status, "Expired"); assert.equal(run([bull, ...[21, 22, 23].map(i => bar(i)), bar(24, { high: 1.113, close: 1.112 })]).zones[0].status, "Confirmed"); assert.equal(run([bull, ...[21, 22, 23, 24].map(i => bar(i)), bar(25, { high: 1.113, close: 1.112 })]).zones[0].status, "Expired"); });
check("missing volume, zero baseline and gaps fail closed", () => { assert.equal(run([{ ...bull, volume: undefined as unknown as number }]).zones.length, 0); assert.equal(calculateAbsorption(history.map(c => ({ ...c, volume: 0 })).concat(bull), "EUR_USD", "H1").zones.length, 0); assert.equal(run([bull, bar(22)]).zones[0].reason, "Missing candle gap"); assert.equal(run([bull, bar(21, { volume: NaN })]).zones[0].status, "Invalidated"); });
check("historical and incremental consistency, deduplication, frozen confirmations", () => { const bars = [...history, bull, bar(21, { high: 1.113, close: 1.112 }), bar(22, { low: 1.08, close: 1.09 })]; const engine = createAbsorptionEngine("EUR_USD", "H1"); bars.forEach(c => { engine.append(c); engine.append({ ...c }); }); assert.deepEqual(engine.snapshot(), calculateAbsorption(bars, "EUR_USD", "H1")); assert.deepEqual(engine.snapshot().zones[0], run(bars.slice(20, 22)).zones[0]); assert.equal(new Set(engine.snapshot().events.map(e => e.id)).size, engine.snapshot().events.length); assert.throws(() => engine.append({ ...bars.at(-1)!, volume: 101 }), /revised/); });
check("settings enforce valid types and bounds", () => { assert.throws(() => parseAbsorptionSettings({ confirmationWindow: 0 })); assert.throws(() => parseAbsorptionSettings({ volumeLookback: 2.5 })); assert.throws(() => parseAbsorptionSettings({ showScores: "yes" })); assert.equal(parseAbsorptionSettings({ minimumScore: 75 }).minimumScore, 75); });
check("closed weekend gaps preserve pending state", () => {
  const friday = Date.parse("2026-10-23T20:00:00Z");
  const prior = history.map((c, i) => ({ ...c, time: new Date(friday - (20 - i) * 3_600_000).toISOString() }));
  const candidate = { ...bull, time: new Date(friday).toISOString() };
  const reopen = { ...bar(21, { high: 1.113, close: 1.112 }), time: "2026-10-25T21:00:00.000Z" };
  assert.equal(calculateAbsorption([...prior, candidate, reopen], "EUR_USD", "H1").zones[0].status, "Confirmed");
});
check("stored zones remain bounded while event IDs stay unique", () => {
  const bars = Array.from({ length: 400 }, (_, i) => i >= 20 && i % 6 === 2 ? { ...bull, time: bar(i).time } : bar(i));
  const result = calculateAbsorption(bars, "EUR_USD", "H1");
  assert.equal(result.zones.length, 35); assert.ok(result.events.length > 35); assert.equal(new Set(result.events.map(e => e.id)).size, result.events.length);
});
console.log(`${cases} absorption test groups passed.`);
