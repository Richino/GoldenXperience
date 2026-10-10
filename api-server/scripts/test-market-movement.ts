import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MarketMovementEngine, timestampNs } from "../src/market-movement.js";
import { MarketRecorder, replayMarketRecording, type MarketRecord } from "../src/market-recording.js";
import type { OandaStreamPrice } from "../src/market-stream-normalize.js";
import { OandaPricingStream } from "../src/oanda-stream.js";

const base = Date.parse("2026-10-09T14:00:00Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const near = (actual: number | null, expected: number, tolerance = 1e-6) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
};
function quote(t: number, pips: number, instrument = "EUR_USD", spreadPips = 1): OandaStreamPrice {
  const pip = instrument === "AUD_JPY" ? 0.01 : 0.0001;
  const start = instrument === "AUD_JPY" ? 110 : 1.1;
  return { type: "PRICE", instrument, time: at(t), status: "tradeable", bids: [{ price: String(start + pips * pip) }], asks: [{ price: String(start + (pips + spreadPips) * pip) }] };
}
function connected(instruments = ["EUR_USD"], maxSamples?: number) {
  const engine = new MarketMovementEngine(instruments, { maxSamples });
  engine.setConnection("connected"); return engine;
}
function feed(engine: MarketMovementEngine, end: number, price: (t: number) => number, instrument = "EUR_USD") {
  for (let t = 0; t <= end; t += 0.25) engine.observe(quote(t, price(t), instrument), at(t));
}
function window(engine: MarketMovementEngine, t: number, instrument = "EUR_USD", index = 0) {
  return engine.snapshot(instrument, at(t)).windows[index];
}

// Analytic paths verify dimensions and separation of activity from progress.
for (const instrument of ["EUR_USD", "AUD_JPY"]) {
  for (const slope of [2, -2]) {
    const engine = connected([instrument]); feed(engine, 5, t => slope * t, instrument);
    const w = window(engine, 5, instrument);
    assert.equal(w.state, "ready"); assert.equal(w.direction, slope > 0 ? "up" : "down");
    near(w.netPips, slope * 5); near(w.velocityPipsPerSecond, slope);
    near(w.activityPipsPerSecond, 2); near(w.directionalEfficiency, 1);
    near(w.tickPersistence, Math.sign(slope)); near(w.accelerationPipsPerSecondSquared, 0);
    near(w.observedUpdatesPerSecond, 4);
    assert.equal(engine.snapshot(instrument, at(5)).windows[1].state, "warming");
  }
}
{
  const engine = connected(); feed(engine, 5, t => (Math.round(t * 4) % 2) * 1);
  const w = window(engine, 5);
  near(w.netPips, 0); near(w.pathPips, 20); near(w.activityPipsPerSecond, 4);
  near(w.directionalEfficiency, 0); near(w.tickPersistence, 0); assert.equal(w.direction, "flat");
}
{
  const engine = connected(); feed(engine, 5, () => 0);
  const w = window(engine, 5);
  assert.equal(w.transitions.unchanged, 20); near(w.pathPips, 0);
  near(w.timeAtStartRatio, 1); near(w.accelerationPipsPerSecondSquared, 0);
}
{
  const engine = connected(); feed(engine, 5, t => t * t);
  near(window(engine, 5).accelerationPipsPerSecondSquared, 2);
}
{
  const engine = connected(); feed(engine, 5, t => t <= 3 ? t * 2 : 6 - (t - 3) * 2);
  const w = window(engine, 5);
  near(w.netPips, 2); near(w.excursionAboveStartPips, 6); near(w.pullbackFromHighPips, 4);
  near(w.pathPips, 10); near(w.directionalEfficiency, 0.2);
}
{
  const engine = connected();
  for (const t of [0, 0.3, 1.4, 2.9, 5]) engine.observe(quote(t, t * 3), at(t));
  near(window(engine, 5).velocityPipsPerSecond, 3); near(window(engine, 5).activityPipsPerSecond, 3);
}
// A widening ask can raise mid while bid is stationary: not a coherent up move.
{
  const engine = connected();
  for (let t = 0; t <= 5; t += 0.25) engine.observe(quote(t, 0, "EUR_USD", 1 + t), at(t));
  const w = window(engine, 5);
  assert.equal(w.direction, "mixed"); near(w.bidNetPips, 0); near(w.askNetPips, 5);
  near(w.netPips, 2.5); near(w.spreadChangePips, 5); assert.equal(w.transitions.bothBidAskUp, 0);
}
// Duplicate timestamps cannot refresh freshness, unlike new unchanged quotes.
{
  const engine = connected(); engine.observe(quote(0, 0), at(0)); engine.observe(quote(0, 0), at(4));
  const snap = engine.snapshot("EUR_USD", at(6));
  assert.equal(snap.reason, "stale_quote"); assert.deepEqual(snap.windows, []);
  assert.equal(snap.counts.accepted, 1); assert.equal(snap.counts.duplicateTimestamps, 1);
}
// Sub-millisecond durations are retained without fabricated coarse-clock speeds.
{
  assert.equal(timestampNs("2026-10-09T14:00:00.123456789Z")! - timestampNs("2026-10-09T14:00:00.123456788Z")!, 1n);
  assert.equal(timestampNs("2026-02-30T14:00:00Z"), null);
  const engine = connected();
  engine.observe({ ...quote(0, 0), time: "2026-10-09T14:00:00.000000100Z" }, at(0));
  engine.observe({ ...quote(0, 1), time: "2026-10-09T14:00:00.000500100Z" }, at(0));
  near(window(engine, 0).coverageSeconds, 0.0005); near(window(engine, 0).velocityPipsPerSecond, 2000, 1e-5);
  assert.equal(window(engine, 0).state, "warming"); assert.equal(window(engine, 0).accelerationPipsPerSecondSquared, null);
}
const invalidCases: Array<[string, OandaStreamPrice, string]> = [
  ["nontradeable_quote", { ...quote(5.25, 100), status: "non-tradeable" }, at(5.25)],
  ["invalid_bid_ask", { ...quote(5.25, 100), asks: [{ price: "1" }] }, at(5.25)],
  ["invalid_timestamp", { ...quote(5.25, 100), time: "bad" }, at(5.25)],
  ["stale_broker_quote", quote(5.25, 100), at(11)],
  ["broker_clock_ahead", quote(7, 100), at(5.25)],
  ["receive_clock_regression", quote(5.25, 100), at(4)],
  ["broker_time_regression", quote(4.5, 100), at(5.25)],
  ["conflicting_same_timestamp", quote(5, 100), at(5.25)],
  ["nontradeable_quote", JSON.parse(JSON.stringify({ ...quote(5.25, 100), status: 7 })), at(5.25)],
  ["invalid_timestamp", JSON.parse(JSON.stringify({ ...quote(5.25, 100), time: { toString: "bad" } })), at(5.25)],
];
for (const [reason, raw, received] of invalidCases) {
  const engine = connected(); feed(engine, 5, t => t);
  engine.observe(raw, received);
  const snap = engine.snapshot("EUR_USD", received);
  assert.equal(snap.reason, reason); assert.deepEqual(snap.windows, []); assert.equal(snap.counts.rejected, 1);
}
{
  const engine = connected(); feed(engine, 5, t => t);
  engine.observe(quote(4.5, 100), at(5.25)); engine.observe(quote(4.75, 200), at(5.5));
  assert.equal(engine.snapshot("EUR_USD", at(5.5)).reason, "broker_time_regression");
  engine.observe(quote(5.75, 5.75), at(5.75));
  assert.equal(window(engine, 5.75).samples, 1); near(window(engine, 5.75).netPips, 0);
}
{
  const engine = connected(); feed(engine, 5, t => t);
  engine.observe(quote(11, 100), at(11));
  assert.equal(engine.snapshot("EUR_USD", at(11)).lastBreak, "quote_gap");
  assert.equal(window(engine, 11).samples, 1); near(window(engine, 11).netPips, 0);
  assert.equal(engine.snapshot("EUR_USD", at(10)).reason, "as_of_before_latest_quote");
}
{
  const engine = connected(); feed(engine, 5, t => t);
  engine.setConnection("error"); assert.deepEqual(engine.snapshot("EUR_USD", at(5)).windows, []);
  engine.setConnection("connecting"); engine.setConnection("connected"); engine.observe(quote(6, 100), at(6));
  assert.equal(window(engine, 6).samples, 1); near(window(engine, 6).netPips, 0);
  engine.setConnection("connected", "mock"); assert.equal(engine.snapshot("EUR_USD", at(6)).reason, "stream_unavailable");
}
{
  const engine = connected(["EUR_USD", "AUD_JPY"]); feed(engine, 5, t => t); feed(engine, 5, t => -t, "AUD_JPY");
  engine.observe({ ...quote(6, 10), status: "unknown" }, at(6));
  assert.equal(engine.snapshot("EUR_USD", at(6)).state, "paused"); assert.equal(window(engine, 5, "AUD_JPY").direction, "down");
  const bounded = connected(["EUR_USD"], 4); feed(bounded, 1, t => t);
  assert.equal(bounded.snapshot("EUR_USD", at(1)).lastBreak, "sample_limit"); assert.equal(window(bounded, 1).samples, 1);
  const rolling = connected(); feed(rolling, 360, t => t);
  assert.equal(rolling.snapshot("EUR_USD", at(360)).retainedSamples, 721);
  for (let index = 0; index < 3; index++) {
    near(window(rolling, 360, "EUR_USD", index).velocityPipsPerSecond, 1);
    assert.equal(window(rolling, 360, "EUR_USD", index).state, "ready");
  }
  assert.throws(() => connected(["NOT_A_PAIR"]));
}

// Actual phase-1 log/replay must match the same live prefix, excluding future rows.
const directory = await mkdtemp(path.join(os.tmpdir(), "gx-movement-test-"));
try {
  let clock = at(0);
  const recorder = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice", now: () => clock });
  recorder.record("connection", { state: "connected", source: "oanda" }, at(0));
  const live = connected();
  for (let t = 0; t <= 10; t += 0.25) {
    recorder.quote(quote(t, t), at(t));
    if (t <= 5) live.observe(quote(t, t), at(t));
    if (t === 5) recorder.record("calendar", { events: [{ surprise: "future-neutral-context" }] }, at(t));
  }
  clock = at(10); await recorder.close();
  const replay = new MarketMovementEngine(["EUR_USD"]);
  for await (const record of replayMarketRecording(recorder.file, { until: at(5) })) replay.consume(record);
  assert.deepEqual(replay.snapshot("EUR_USD", at(5)).windows, live.snapshot("EUR_USD", at(5)).windows);
  assert.equal(replay.snapshot("EUR_USD", at(5)).counts.accepted, 21);
  const replayAgain = new MarketMovementEngine(["EUR_USD"]);
  for await (const record of replayMarketRecording(recorder.file, { until: at(5) })) replayAgain.consume(record);
  assert.deepEqual(replayAgain.snapshot("EUR_USD", at(5)), replay.snapshot("EUR_USD", at(5)));
} finally { await rm(directory, { recursive: true, force: true }); }

function row(sequence: number, kind: MarketRecord["kind"], data: Record<string, unknown>, t = 0): MarketRecord {
  return { version: 1, sessionId: "test-session", sequence, connection: 0, receivedAt: at(t), kind, data };
}
function replayEngine() {
  const engine = new MarketMovementEngine(["EUR_USD"]);
  engine.consume(row(1, "session", { environment: "practice", source: "oanda" }));
  engine.consume(row(2, "connection", { state: "connected", source: "oanda" }));
  return engine;
}
{
  const engine = replayEngine();
  engine.consume(row(3, "quote", { raw: quote(0, 0) }));
  engine.consume(row(5, "quote", { raw: quote(1, 100) }, 1));
  assert.equal(engine.snapshot("EUR_USD", at(1)).reason, "recording_sequence_gap");
  engine.consume(row(6, "quote", { raw: quote(2, 2) }, 2));
  assert.equal(window(engine, 2).samples, 1);
  engine.consume(row(7, "heartbeat", { brokerTime: at(8) }, 8));
  assert.equal(engine.snapshot("EUR_USD", at(8)).reason, "stale_quote");
  engine.consume(row(8, "stream-error", { reason: "malformed_stream_message" }, 8));
  assert.equal(engine.snapshot("EUR_USD", at(8)).reason, "stream_message_error");
  engine.consume(row(9, "end", {}, 8)); assert.equal(engine.snapshot("EUR_USD", at(8)).reason, "stream_closed");
  assert.throws(() => new MarketMovementEngine(["EUR_USD"]).consume(row(1, "quote", { raw: quote(0, 0) })));
  assert.throws(() => new MarketMovementEngine(["EUR_USD"]).consume(row(1, "session", { environment: "live", source: "oanda" })));
  assert.throws(() => replayEngine().consume(row(0, "heartbeat", {})));
}
{
  const engine = replayEngine(); engine.consume(row(3, "quote", { raw: quote(1, 1) }, 1));
  engine.consume(row(4, "quote", { raw: quote(0, 100) }, 0));
  assert.equal(engine.snapshot("EUR_USD", at(1)).reason, "recording_clock_regression");
  const changed = replayEngine(); changed.consume({ ...row(3, "quote", { raw: quote(0, 1) }), connection: 1 });
  assert.equal(changed.snapshot("EUR_USD", at(0)).reason, "recording_connection_changed");
}

// Exercise the actual stream parser -> raw observation -> movement callbacks.
{
  const originalFetch = globalThis.fetch;
  const origin = Date.now() - 4000;
  const engine = new MarketMovementEngine(["EUR_USD"]);
  let beforeIssue: ReturnType<MarketMovementEngine["snapshot"]> | null = null;
  let afterIssue: ReturnType<MarketMovementEngine["snapshot"]> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const payloads = Array.from({ length: 18 }, (_, index) => ({ ...quote(index * 0.25, index * 0.25), time: new Date(origin + index * 250).toISOString() }));
  const prefix = payloads.slice(0, 17).map(value => JSON.stringify(value) + "\n").join("");
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = new TextEncoder();
      controller.enqueue(encode.encode(prefix.slice(0, 101)));
      controller.enqueue(encode.encode(prefix.slice(101) + '{broken\n' + JSON.stringify(payloads[17]) + "\n"));
    },
  }));
  const stream = new OandaPricingStream({ accountId: "fixture", apiKey: "fixture", environment: "practice", streamBaseUrl: "https://example.invalid", port: 0, instruments: ["EUR_USD"], isConfigured: true }, {
    onPrice: () => {}, onHeartbeat: () => {},
    onStatus: value => engine.setConnection(value.state, value.source),
    onIssue: () => { beforeIssue = engine.snapshot("EUR_USD"); engine.breakContinuity("stream_message_error"); },
    onObservation: (raw, receivedAt) => {
      engine.observe(raw, receivedAt);
      if (raw.time === payloads[17].time) { afterIssue = engine.snapshot("EUR_USD", receivedAt); resolveDone(); }
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    stream.start();
    await Promise.race([done, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Movement stream fixture timed out")), 2000); })]);
    assert.equal(beforeIssue!.state, "ready"); near(beforeIssue!.windows[0].netPips, 4);
    assert.equal(afterIssue!.state, "warming"); assert.equal(afterIssue!.windows[0].samples, 1);
    near(afterIssue!.windows[0].netPips, 0);
  } finally { clearTimeout(timeout); stream.stop(); globalThis.fetch = originalFetch; }
}
console.log("Market movement tests passed: analytic paths, timing, spread, quality, bounded windows, and causal replay.");
