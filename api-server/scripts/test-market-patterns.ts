import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Candle } from "../../frontend/src/types/forex.js";
import { candlePatterns, levelPatterns, structurePatterns, boundaryAt } from "../src/market-pattern-definitions.js";
import { MarketPatternEngine } from "../src/market-patterns.js";
import { MarketRecorder, replayMarketRecording } from "../src/market-recording.js";
import { startRecordingContext } from "../src/market-recording-context.js";
import type { getCandles } from "../../frontend/src/lib/oanda/client.js";
import type { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";

const epoch = Date.parse("2026-10-09T14:00:00Z"), pip = 0.0001, base = 1.1;
const at = (minutes: number) => new Date(epoch + minutes * 60_000).toISOString();
const price = (pips: number) => base + pips * pip;
function bar(index: number, open: number, high: number, low: number, close: number, complete = true): Candle {
  return { time: at(index), open: price(open), high: price(high), low: price(low), close: price(close), complete, volume: 1 };
}
function pathBars(values: number[]) { return values.map((value, index) => bar(index, value, value + 0.2, value - 0.2, value)); }
function context(candles: Candle[], instrument = "EUR_USD", granularity = "M1") {
  return { instrument, granularity, source: "oanda", snapshot: { instrument, granularity, source: "oanda", candles } };
}
const kinds = (candles: Candle[]) => candlePatterns(candles, pip).map(x => x.kind);
const patterns = (engine: MarketPatternEngine, time: string, instrument = "EUR_USD") => engine.snapshot(instrument, time).frames.find(x => x.granularity === "M1")!.patterns;
function freshQuote(time: string, pips: number, instrument = "EUR_USD") { return { type: "PRICE" as const, instrument, time, status: "tradeable", bids: [{ price: String(price(pips) - pip * 0.5) }], asks: [{ price: String(price(pips) + pip * 0.5) }] }; }

// Literal shapes and negative controls; a neutral pattern is not a buy/sell vote.
assert.ok(kinds([bar(0, 2, 5, 0, 2.1)]).includes("doji"));
assert.ok(kinds([bar(0, 4, 5, 0, 4.5)]).includes("lower_wick_rejection"));
assert.ok(kinds([bar(0, 0.5, 5, 0, 1)]).includes("upper_wick_rejection"));
assert.ok(kinds([bar(0, 0, 5, 0, 5)]).includes("large_body"));
const bearish = bar(0, 4, 4.5, 0.5, 1), engulf = bar(1, 0.9, 5.5, 0.5, 5);
assert.ok(kinds([bearish, engulf]).includes("bullish_engulfing"));
assert.ok(!kinds([bearish, bar(1, 1, 4, 0.5, 3)]).includes("bullish_engulfing"));
assert.ok(kinds([bar(0, 1, 4.5, 0.5, 4), bar(1, 4.1, 5, 0, 0.5)]).includes("bearish_engulfing"));
assert.ok(kinds([bar(0, 2, 5, 0, 3), bar(1, 2, 4, 1, 3)]).includes("inside_bar"));
assert.ok(kinds([bar(0, 2, 4, 1, 3), bar(1, 2, 5, 0, 3)]).includes("outside_bar"));
assert.ok(kinds([bar(0, 8, 8, 0, 0), bar(1, 0, 1, -1, 0.1), bar(2, 0, 6, 0, 5)]).includes("morning_star_like"));
assert.ok(kinds([bar(0, 0, 8, 0, 8), bar(1, 8, 9, 7, 7.9), bar(2, 8, 8, 2, 3)]).includes("evening_star_like"));
assert.deepEqual(kinds([bar(0, 0, 0.2, 0, 0.1)]), []);

const doublePath = [0, 2, 4, 7, 10, 7, 4, 2, 0, 2, 4, 7, 10, 7, 4, 2, 0];
const doubleBars = pathBars(doublePath);
assert.equal(structurePatterns(doubleBars.slice(0, 14), pip).some(x => x.kind === "double_top"), false, "Right-hand pivot needs two completed future bars");
assert.ok(structurePatterns(doubleBars.slice(0, 15), pip).some(x => x.kind === "double_top"));
assert.equal(structurePatterns(pathBars(doublePath.map((x, i) => i === 12 ? 15 : x)), pip).some(x => x.kind === "double_top"), false);
assert.ok(structurePatterns(pathBars(doublePath.map(x => 20 - x)), pip).some(x => x.kind === "double_bottom"));
assert.ok(structurePatterns(doubleBars.map(c => ({ ...c, open: c.open * 100, high: c.high * 100, low: c.low * 100, close: c.close * 100 })), 0.01).some(x => x.kind === "double_top"));
const shoulders = [3, 4, 6, 8, 6, 3, 1, 4, 8, 12, 8, 3, 1, 3, 6, 8, 6, 4];
assert.ok(structurePatterns(pathBars(shoulders), pip).some(x => x.kind === "head_shoulders"));
assert.ok(structurePatterns(pathBars(shoulders.map(x => 20 - x)), pip).some(x => x.kind === "inverse_head_shoulders"));
const symmetric = [4, 6, 9, 12, 8, 4, 0, 4, 7, 11, 7, 4, 1, 4, 7, 10, 7, 4, 2, 4, 6];
assert.ok(structurePatterns(pathBars(symmetric), pip).some(x => x.kind === "symmetric_triangle"));
assert.equal(structurePatterns(pathBars(symmetric.map((x, i) => i === 9 ? 14 : x)), pip).some(x => x.kind.endsWith("triangle")), false);
const ascending = [4, 6, 9, 12, 8, 4, 0, 4, 8, 12, 8, 5, 3, 6, 9, 12, 10, 8, 6, 8, 10];
assert.ok(structurePatterns(pathBars(ascending), pip).some(x => x.kind === "ascending_triangle"));
assert.ok(structurePatterns(pathBars(ascending.map(x => 20 - x)), pip).some(x => x.kind === "descending_triangle"));

const box = Array.from({ length: 20 }, (_, i) => { const value = [1, 3, 5, 7, 9, 7, 5, 3][i % 8]; return bar(i, value, value + 1, value - 1, value); });
assert.ok(levelPatterns([...box, bar(20, 5, 13, 4, 12)], pip).some(x => x.kind === "range_break_up"));
assert.ok(levelPatterns([...box, bar(20, 5, 6, -3, -2)], pip).some(x => x.kind === "range_break_down"));
assert.ok(levelPatterns([...box, bar(20, 5, 13, 4, 9)], pip).some(x => x.kind === "high_sweep_reclaim"));
assert.ok(levelPatterns([...box, bar(20, 5, 6, -3, 1)], pip).some(x => x.kind === "low_sweep_reclaim"));
assert.ok(!levelPatterns([...box, bar(20, 5, 10.1, 4, 10.05)], pip).some(x => x.kind === "range_break_up"));

// Forming candle revocation/reappearance; tick passage alone cannot confirm.
{
  const engine = new MarketPatternEngine(["EUR_USD"]); engine.setConnection("connected", "oanda", at(1.5));
  engine.context(context([bearish, { ...engulf, complete: false }]), at(1.5));
  let p = patterns(engine, at(1.5)).find(x => x.kind === "bullish_engulfing")!;
  assert.equal(p.state, "forming"); assert.equal(p.confirmedObservedAt, null);
  const id = p.id;
  engine.observe(freshQuote(at(1.51), 0.5), at(1.51));
  assert.equal(patterns(engine, at(1.51)).find(x => x.id === id)!.state, "invalidated");
  engine.observe(freshQuote(at(1.52), 5), at(1.52));
  p = patterns(engine, at(1.52)).find(x => x.id === id)!;
  assert.equal(p.state, "forming"); assert.ok(p.revision >= 3);
  // Broker uses nanosecond strings; canonical candle keys must still match tick buckets.
  const final = { ...engulf, time: "2026-10-09T14:01:00.000000000Z" };
  engine.context(context([bearish, final]), at(2.01));
  p = patterns(engine, at(2.01)).find(x => x.id === id)!;
  assert.equal(p.state, "confirmed"); assert.equal(p.origin, "broker_candles");
  assert.equal(p.confirmedObservedAt, at(2.01));
  const sequence = engine.snapshot("EUR_USD", at(2.01)).eventSequence;
  engine.context(context([bearish, final]), at(2.02));
  assert.equal(engine.snapshot("EUR_USD", at(2.02)).eventSequence, sequence, "Repeated snapshot must not re-alert");
  engine.context(context([bar(2, 0, 0.5, -3, -2)]), at(3.01));
  p = patterns(engine, at(3.01)).find(x => x.id === id)!;
  assert.equal(p.state, "invalidated"); assert.equal(p.confirmedObservedAt, at(2.01));
  assert.throws(() => engine.snapshot("EUR_USD", at(2)), /replay/);
}
// Neckline closes drive chart pattern confirmation, with immutable anchors and retained history.
{
  const engine = new MarketPatternEngine(["EUR_USD"]);
  engine.context(context(doubleBars), at(17.01));
  const top = patterns(engine, at(17.01)).find(x => x.kind === "double_top")!;
  assert.equal(top.state, "forming"); assert.ok(top.lower);
  engine.context(context([bar(17, 0, 0, -3, -2)]), at(18.01));
  let p = patterns(engine, at(18.01)).find(x => x.id === top.id)!;
  assert.equal(p.state, "confirmed"); assert.equal(p.confirmedDirection, "down");
  assert.deepEqual(p.anchors, top.anchors); assert.equal(p.confirmedCandleTime, at(17));
  engine.context(context([bar(18, 0, 13, 0, 12)]), at(19.01));
  p = patterns(engine, at(19.01)).find(x => x.id === top.id)!;
  assert.equal(p.state, "invalidated"); assert.equal(p.confirmedCandleTime, at(17));
  assert.ok(engine.snapshot("EUR_USD", at(19.01)).events.some(x => x.pattern.id === top.id && x.pattern.state === "confirmed"));
}
{
  const engine = new MarketPatternEngine(["EUR_USD"]);
  engine.context(context(pathBars(symmetric)), at(21.01));
  const triangle = patterns(engine, at(21.01)).find(x => x.kind === "symmetric_triangle")!;
  assert.equal(triangle.state, "forming"); assert.ok(boundaryAt(triangle.upper!, at(21)) < price(12));
  engine.context(context([bar(21, 6, 13, 6, 12)]), at(22.01));
  assert.equal(patterns(engine, at(22.01)).find(x => x.id === triangle.id)!.confirmedDirection, "up");
  engine.context(context([bar(22, 12, 12, 0, 1)]), at(23.01));
  assert.equal(patterns(engine, at(23.01)).find(x => x.id === triangle.id)!.state, "invalidated");
}
// Missing, corrupt, mocked, future, stale, and revised candles cannot silently support patterns.
{
  const engine = new MarketPatternEngine(["EUR_USD"]);
  engine.context(context(doubleBars.filter((_, i) => i !== 8)), at(17.01));
  assert.equal(patterns(engine, at(17.01)).some(x => x.kind === "double_top"), false);
  const invalids = [
    { ...context([engulf]), source: "mock" },
    context([{ ...engulf, high: price(-100) }]),
    context([{ ...engulf, complete: true }]), // future complete bar at t1.5
    context([{ ...engulf, time: "2026-10-09T14:01:00.000000001Z", complete: false }]),
    JSON.parse(JSON.stringify({ ...context([engulf]), snapshot: { ...context([engulf]).snapshot, candles: [null] } })),
  ];
  for (const data of invalids) {
    const bad = new MarketPatternEngine(["EUR_USD"]); bad.context(data, at(1.5));
    assert.equal(bad.snapshot("EUR_USD", at(1.5)).frames[0].reason, "invalid_candle_snapshot");
    assert.deepEqual(patterns(bad, at(1.5)), []);
  }
  const revision = new MarketPatternEngine(["EUR_USD"]);
  revision.context(context([bearish]), at(1.1));
  revision.context(context([{ ...bearish, close: price(2) }]), at(1.2));
  assert.equal(revision.snapshot("EUR_USD", at(1.2)).frames[0].reason, "closed_candle_revision");
  const stale = new MarketPatternEngine(["EUR_USD"]); stale.context(context([bearish]), at(1.1));
  assert.equal(stale.snapshot("EUR_USD", at(4)).frames[0].reason, "stale_context");
}
// Broker H4 session offset must be inferred, not rounded to midnight UTC.
{
  const engine = new MarketPatternEngine(["EUR_USD"]); engine.setConnection("connected", "oanda", at(330));
  engine.context(context([{ ...bearish, time: at(60) }, { ...engulf, time: at(300), complete: false }], "EUR_USD", "H4"), at(330));
  engine.observe(freshQuote(at(330.01), 6), at(330.01));
  const frame = engine.snapshot("EUR_USD", at(330.01)).frames.find(x => x.granularity === "H4")!;
  assert.equal(frame.reason, null); assert.equal(frame.formingCandleTime, at(300));
  assert.equal(frame.patterns.find(x => x.kind === "bullish_engulfing")!.state, "forming");
}
// A single pair's unusable quote cannot pause another pair's candle context.
{
  const engine = new MarketPatternEngine(["EUR_USD", "AUD_JPY"]); engine.setConnection("connected", "oanda", at(1.5));
  engine.context(context([bearish, { ...engulf, complete: false }], "AUD_JPY"), at(1.5));
  engine.observe(freshQuote(at(1.505), 5, "AUD_JPY"), at(1.505));
  engine.observe({ ...freshQuote(at(1.51), 5), status: "non-tradeable" }, at(1.51));
  assert.equal(engine.snapshot("AUD_JPY", at(1.51)).frames[0].reason, null);
}
{
  const engine = new MarketPatternEngine(["EUR_USD", "AUD_JPY"]);
  engine.setConnection("connected", "oanda", at(1.5)); engine.context(context([bearish, { ...engulf, complete: false }]), at(1.5));
  const id = patterns(engine, at(1.5)).find(x => x.kind === "bullish_engulfing")!.id;
  engine.setConnection("error", "oanda", at(1.51));
  assert.equal(patterns(engine, at(1.51)).find(x => x.id === id)!.reason, "quote_preview_continuity_lost");
  engine.setConnection("connected", "oanda", at(1.52)); engine.observe(freshQuote(at(1.52), 5), at(1.52));
  assert.equal(engine.snapshot("EUR_USD", at(1.52)).frames[0].reason, "awaiting_context_resync");
  assert.deepEqual(patterns(engine, at(1.52), "AUD_JPY"), []);
  engine.context(context([bearish, engulf]), at(2.01));
  assert.equal(patterns(engine, at(2.01)).find(x => x.id === id)!.state, "confirmed", "Authoritative resync can confirm an abandoned tick preview");
}
{
  let emitted = 0;
  const engine = new MarketPatternEngine(["EUR_USD"], undefined, () => { emitted++; });
  const many = Array.from({ length: 600 }, (_, i) => bar(i, 5, 10, 0, 5));
  engine.context(context(many), at(600.1));
  const snapshot = engine.snapshot("EUR_USD", at(600.1));
  assert.equal(snapshot.frames[0].retainedCandles, 256); assert.ok(snapshot.frames[0].patterns.length <= 32); assert.ok(snapshot.events.length <= 64);
  assert.ok(snapshot.frames[0].patterns.some(x => x.state === "expired"));
  assert.equal(emitted, snapshot.eventSequence); assert.ok(emitted > 256, "Export callback receives events before history clipping");
}

// Actual recording: tick preview -> closed snapshot. A cutoff never sees the later close.
const directory = await mkdtemp(path.join(tmpdir(), "gx-pattern-test-"));
try {
  let clock = at(1.5);
  const recorder = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice", now: () => clock });
  recorder.record("connection", { state: "connected", source: "oanda" }, clock);
  recorder.record("candles", context([bearish, { ...engulf, complete: false }]), clock);
  recorder.quote(freshQuote(at(1.51), 5), at(1.51));
  recorder.record("candles", context([bearish, engulf]), at(2.01));
  clock = at(2.02); await recorder.close();
  async function replay(until: string) {
    const engine = new MarketPatternEngine(["EUR_USD"]);
    for await (const record of replayMarketRecording(recorder.file, { until })) engine.consume(record);
    return engine.snapshot("EUR_USD", until);
  }
  const early = await replay(at(1.51)), late = await replay(at(2.01));
  assert.equal(early.frames[0].patterns.find(x => x.kind === "bullish_engulfing")!.state, "forming");
  assert.equal(late.frames[0].patterns.find(x => x.kind === "bullish_engulfing")!.state, "confirmed");
  assert.deepEqual(late, await replay(at(2.01)), "Same recording/cutoff must reproduce every event and revision");
  // The live context callback uses the same receivedAt as the log, without requiring recording.
  const observed: string[] = [];
  let resolveContext!: () => void;
  const done = new Promise<void>(resolve => { resolveContext = resolve; });
  const selective = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice" });
  const stop = startRecordingContext(selective, ["EUR_USD", "AUD_JPY"], {
    getCandles: (async (instrument: string, granularity: string) => ({ data: { ...context([bearish], instrument).snapshot, granularity }, status: { state: "connected" } })) as unknown as typeof getCandles,
    getEconomicCalendar: (async () => ({ data: { source: "mock", connected: false }, status: { state: "error" } })) as unknown as typeof getEconomicCalendar,
  }, (kind, _data, receivedAt) => { observed.push(kind); assert.ok(Number.isFinite(Date.parse(receivedAt))); if (kind === "context-error") resolveContext(); }, ["EUR_USD"]);
  try { await done; assert.equal(observed.filter(x => x === "candles").length, 10); } finally { stop(); await selective.close(); }
  let savedCandles = 0;
  for await (const record of replayMarketRecording(selective.file)) if (record.kind === "candles") {
    savedCandles++; assert.equal(record.data.instrument, "EUR_USD");
  }
  assert.equal(savedCandles, 5, "Broader observation cannot expand the recorder's selected pairs");
} finally { await rm(directory, { recursive: true, force: true }); }
console.log("Market pattern tests passed: candle/chart geometry, causal pivots, lifecycle, quality, bounded history, live context, and as-of replay.");
