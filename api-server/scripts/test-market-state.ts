import assert from "node:assert/strict";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { MarketPatternEngine } from "../src/market-patterns.js";
import { candleRead, MarketStateEngine } from "../src/market-state.js";

const start = Date.parse("2026-10-05T16:00:00Z");
const iso = (ms = 0) => new Date(start + ms).toISOString();
const instrument = "EUR_USD";
const intervals = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
function bars(interval: number, direction: "up" | "down" | "range"): Candle[] {
  return Array.from({ length: 30 }, (_, i) => {
    const close = 1.1 + (direction === "range" ? i % 2 : direction === "up" ? i : 30 - i) * 0.0001;
    return { time: iso((i - 30) * interval), open: close - 0.00005, high: close + 0.00015, low: close - 0.00015, close, complete: true, volume: 0 };
  });
}
function fixture(h1: "up" | "down" | "range" = "up", h4 = h1) {
  const patterns = new MarketPatternEngine([instrument]);
  const state = new MarketStateEngine(patterns);
  patterns.setConnection("connected", "oanda", iso());
  for (const [tf, interval] of Object.entries(intervals)) {
    patterns.context({ instrument, granularity: tf, source: "oanda", snapshot: { instrument, granularity: tf, source: "oanda", candles: bars(interval, tf === "H4" ? h4 : h1) } }, iso());
  }
  const calendar = (changes: Record<string, unknown> = {}, at = iso()) => state.calendarContext({ snapshot: { source: "forex_factory", connected: true, events: [], coverageUntil: iso(86_400_000), ...changes } }, at);
  calendar();
  const quote = (ms: number, mid: number, spread = 0.00005) => {
    patterns.observe({ instrument, time: iso(ms), status: "tradeable", bids: [{ price: String(mid - spread / 2) }], asks: [{ price: String(mid + spread / 2) }] }, iso(ms));
  };
  const warm = (sign = 1, observeEach = false) => {
    let read!: ObserverRead;
    for (let i = 0; i <= 120; i++) {
      quote(i * 250, 1.1029 + sign * i * 0.000001);
      if (observeEach) read = state.update(instrument, iso(i * 250));
    }
    return observeEach ? read : state.update(instrument, iso(30_000));
  };
  return { patterns, state, calendar, quote, warm };
}

for (const direction of ["up", "down", "range"] as const) {
  const f = fixture(direction), read = f.warm(direction === "down" ? -1 : direction === "range" ? 0 : 1);
  assert.equal(read.lean, direction);
  assert.equal(read.pressure.direction, direction);
  assert.equal(read.blockers.length, 0);
}
assert.equal(fixture("up", "down").warm().lean, "conflicting", "H1/H4 disagreement is explicit");
const opposed = fixture().warm(-1);
assert.equal(opposed.lean, "up", "A short quote reversal does not rewrite closed-candle structure");
assert.equal(opposed.pressure.relation, "opposed");
assert.ok(opposed.facts.some(f => f.id === "pressure-opposed"));

const warming = fixture();
for (let i = 0; i <= 20; i++) warming.quote(i * 250, 1.1 + i * 0.000001);
let read = warming.state.update(instrument, iso(5000));
assert.equal(read.state, "live", "Quote feed can be live before its longer window is covered");
assert.equal(read.pressure.direction, "unknown", "Insufficient observations are not a range");
assert.equal(read.pressure.covered, false);
assert.ok(read.blockers.some(b => b.includes("pressure window")), "No new entry while pressure coverage warms");

const reversal = fixture();
read = reversal.warm(1, true);
assert.equal(read.pressure.direction, "up", "Pressure settles after continuous observations");
let sawPending = false, sincePending = 0, priorRevision = 0;
for (let i = 1; i <= 140; i++) {
  const ms = 30_000 + i * 250;
  reversal.quote(ms, 1.10302 - i * 0.000004);
  const next = reversal.state.update(instrument, iso(ms));
  if (!sawPending && next.pressure.observedDirection === "down" && next.pressure.pending) {
    sawPending = true; sincePending = ms; priorRevision = next.revision;
    reversal.state.attachExplanation(instrument, next.revision, { state: "ready", text: "Old evidence", at: iso(ms), factIds: [] });
    assert.notEqual(next.pressure.direction, "down", "First contrary observation cannot flip settled pressure");
  }
  if (sawPending && ms < sincePending + 3000) assert.notEqual(next.pressure.direction, "down", "Reversal must persist for three seconds");
  if (sawPending && next.pressure.direction === "down") {
    assert.ok(ms >= sincePending + 3000);
    assert.ok(next.revision > priorRevision, "A settled pressure reversal creates a meaningful event");
    assert.equal(next.ai.source, "rules", "Changed reads immediately replace old AI with current measured evidence");
    assert.notEqual(next.ai.text, "Old evidence");
    read = next; break;
  }
}
assert.ok(sawPending); assert.equal(read.pressure.direction, "down");
assert.equal(reversal.state.update(instrument, read.asOf).revision, read.revision, "Identical observations do not manufacture events");
reversal.patterns.setConnection("error", "oanda", read.asOf);
const lost = reversal.state.update(instrument, read.asOf);
assert.equal(lost.state, "paused"); assert.equal(lost.pressure.direction, "unknown");
assert.equal(lost.lean, "unknown", "Lost context clears the old lean immediately");
assert.equal(lost.quote, null);
assert.ok(lost.patterns.length > 0);
assert.ok(lost.patterns.every(p => p.contextState === "paused"), "Stored shapes are labeled as paused context, not fresh confirmations");

const missingContext = fixture(); missingContext.warm();
missingContext.patterns.contextError({ context: "candles", instrument, granularity: "H1" });
assert.equal(missingContext.state.update(instrument, iso(30_000)).lean, "unknown", "Missing H1 is not debounced as if it were a direction change");

const news = fixture(); news.warm();
for (const [changes, at] of [
  [{ coverageUntil: "invalid-date" }, iso()],
  [{ coverageUntil: null }, iso()],
  [{ coverageUntil: iso(30_000) }, iso()],
  [{ recentEvents: {} }, iso()],
  [{ events: [null] }, iso()],
  [{}, "invalid-date"],
  [{}, iso(31_000)],
] as Array<[Record<string, unknown>, string]>) {
  assert.doesNotThrow(() => news.calendar(changes, at));
  assert.ok(news.state.update(instrument, iso(30_000)).blockers.some(b => b.includes("News coverage")), "Malformed, short or future news coverage must not pass");
}
const event = (ms: number, currency = "USD") => ({ title: "Test release", currency, impact: 3, timestamp: iso(ms) });
for (const [ms, blocked] of [[30_000 - 15 * 60_000, true], [30_000 - 15 * 60_000 - 1, false], [30_000 + 30 * 60_000, true], [30_000 + 30 * 60_000 + 1, false]] as const) {
  news.calendar({ events: [], recentEvents: [event(ms)] });
  assert.equal(news.state.update(instrument, iso(30_000)).blockers.some(b => b.startsWith("High-impact")), blocked);
}
news.calendar({ events: [event(30_000, "JPY")] });
assert.equal(news.state.update(instrument, iso(30_000)).blockers.length, 0, "Unrelated currency does not block this pair");
assert.ok(news.state.update(instrument, iso(600_001)).blockers.some(b => b.includes("News coverage")), "Expired calendar receipt cannot stay current");

const wide = fixture(); wide.warm(); wide.quote(30_250, 1.10302, 0.0006);
assert.ok(wide.state.update(instrument, iso(30_250)).blockers.some(b => b.includes("Spread")));

const gappedBars = Array.from({ length: 20 }, (_, i) => {
  const close = i < 6 ? 1.1 : 1.102;
  return { time: iso((i - 20) * 60_000), open: close, high: close + 0.0001, low: close - 0.0001, close, complete: true, volume: 0 };
});
assert.ok(Math.abs(candleRead(gappedBars, 0.0001)!.atrPips - 47 / 14) < 1e-8, "True range includes the previous close at the start of its window");
const scheduled = fixture();
for (const [at, closed] of [
  ["2026-10-09T20:59:59Z", false], ["2026-10-09T21:00:00Z", true],
  ["2026-10-10T14:00:00Z", true], ["2026-10-11T20:59:59Z", true], ["2026-10-11T21:00:00Z", false],
  ["2026-11-06T21:59:59Z", false], ["2026-11-06T22:00:00Z", true],
  ["2026-11-08T21:59:59Z", true], ["2026-11-08T22:00:00Z", false],
] as const) {
  scheduled.quote(Date.parse(at) - start, 1.1);
  const next = scheduled.state.update(instrument, at);
  assert.equal(next.headline === "Market closed", closed, `New York market schedule at ${at}`);
  assert.equal(next.blockers.some(b => b.startsWith("Forex market closed")), closed);
  if (closed) {
    assert.equal(next.state, "paused", "A quote cannot make a scheduled closure appear live");
    assert.match(next.ai.text!, /Market closed/);
  }
}
console.log("Phase 4 tests passed: directional context, pressure persistence/events, immediate unknowns, warm-up gates, news boundaries/validation, spread, true range and DST-aware market closures.");
