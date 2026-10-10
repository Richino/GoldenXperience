import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarketRecorder, auditMarketRecording, replayMarketRecording, type MarketRecord } from "../src/market-recording.js";
import { normalizeOandaPrice } from "../src/market-stream-normalize.js";
import { OandaPricingStream } from "../src/oanda-stream.js";
import { startRecordingContext } from "../src/market-recording-context.js";
import type { getCandles } from "../../frontend/src/lib/oanda/client.js";
import type { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "gx-recording-test-"));
  const now = "2026-10-09T14:00:00.000Z";
  const raw = { type: "PRICE" as const, instrument: "AUD_JPY", time: "2026-10-09T13:59:59.123456789Z", status: "tradeable", bids: [{ price: "110.1" }], asks: [{ price: "110.12" }] };
  try {
    let clock = now;
    const recorder = new MarketRecorder({ directory, instruments: ["AUD_JPY", "EUR_USD"], environment: "practice", now: () => clock });
    recorder.record("connection", { state: "connecting" });
    recorder.quote(raw, now);
    recorder.quote(raw, "2026-10-09T14:00:00.250Z"); // Equal prices are retained.
    recorder.quote({ ...raw, bids: [{ price: "bad" }] }, "2026-10-09T14:00:00.500Z");
    recorder.record("heartbeat", { brokerTime: now }, "2026-10-09T14:00:00.750Z");
    recorder.record("heartbeat", { brokerTime: now }, "2026-10-09T14:00:25.000Z");
    recorder.record("connection", { state: "error" }, "2026-10-09T14:00:26.000Z");
    recorder.record("connection", { state: "connecting" }, "2026-10-09T14:00:27.000Z");
    recorder.quote({ ...raw, time: "2026-10-09T13:59:58.000000001Z" }, "2026-10-09T14:00:28.000Z");
    recorder.record("candles", { instrument: "AUD_JPY", snapshot: { candles: [{ complete: false }] } }, "2026-10-09T14:00:29.000Z");
    clock = "2026-10-09T14:00:30.000Z";
    await recorder.close();
    const rows = (await readFile(recorder.file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as MarketRecord);
    assert.deepEqual(rows.map(x => x.sequence), rows.map((_, i) => i + 1));
    assert.equal(rows[2].data.brokerTime, raw.time, "Broker nanoseconds must survive unchanged");
    assert.equal(rows[2].receivedAt, now);
    assert.equal(rows[3].data.bid, rows[2].data.bid);
    assert.equal(rows[8].connection, 2);
    const replay: MarketRecord[] = [];
    for await (const row of replayMarketRecording(recorder.file, { until: "2026-10-09T14:00:00.250Z" })) replay.push(row);
    assert.equal(replay.filter(x => x.kind === "quote").length, 2);
    assert.ok(!replay.some(x => x.kind === "candles"), "Later context must not leak into an earlier replay");
    const report = await auditMarketRecording(recorder.file);
    assert.equal(report.quotes, 4); assert.equal(report.invalidQuotes, 1);
    assert.equal(report.heartbeatGaps, 1); assert.equal(report.connectionErrors, 1);
    assert.equal(report.quietQuoteIntervals, 1); assert.equal(report.brokerTimeRegressions, 1);
    assert.equal(report.sequenceGaps, 0); assert.equal(report.complete, true);
    assert.equal(report.clockRegressions, 0);
    assert.equal(normalizeOandaPrice(raw, 1)?.instrument, "AUD_JPY");
    assert.equal(normalizeOandaPrice({ ...raw, instrument: "GBP_JPY" }, 1)?.displayName, "GBP/JPY");
    assert.equal(normalizeOandaPrice({ ...raw, instrument: "BAD_PAIR" }, 1), null);
    assert.equal(normalizeOandaPrice({ ...raw, asks: [{ price: "110" }] }, 1), null);

    const overflow = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice", maxPendingBytes: 1 });
    assert.equal(overflow.status().state, "error");
    await overflow.close();
    const badDisk = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice", write: async () => { throw new Error("disk full"); } });
    await badDisk.flush(); assert.equal(badDisk.status().state, "error"); assert.ok(badDisk.status().droppedRecords > 0); await badDisk.close();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const serialized = new MarketRecorder({ directory, instruments: ["AUD_JPY"], environment: "practice", write: async (file, batch) => { await writeGate; await appendFile(file, batch); } });
    const inFlight = serialized.flush();
    for (let index = 0; index < 100; index++) serialized.quote(raw, now);
    const closing = serialized.close();
    releaseWrite(); await inFlight; await closing;
    const burstAudit = await auditMarketRecording(serialized.file);
    assert.equal(burstAudit.quotes, 100); assert.equal(burstAudit.sequenceGaps, 0); assert.equal(burstAudit.complete, true);

    const fallbackContext = new MarketRecorder({ directory, instruments: ["EUR_USD"], environment: "practice" });
    let calendarFinished!: () => void;
    const gotCalendar = new Promise<void>(resolve => { calendarFinished = resolve; });
    const fallbackStatus = { state: "error" as const, source: "mock" as const, environment: "practice" as const, label: "Fixture", message: "Unavailable fixture", checkedAt: now };
    const stopContext = startRecordingContext(fallbackContext, ["EUR_USD"], {
      getCandles: async () => ({ data: { instrument: "EUR_USD", granularity: "M1", candles: [], source: "mock" }, status: fallbackStatus } as Awaited<ReturnType<typeof getCandles>>),
      getEconomicCalendar: async () => { calendarFinished(); return { data: { source: "mock", connected: false }, status: { state: "error" } } as Awaited<ReturnType<typeof getEconomicCalendar>>; },
    });
    await gotCalendar;
    await new Promise(resolve => setImmediate(resolve));
    stopContext(); await fallbackContext.close();
    const fallbackAudit = await auditMarketRecording(fallbackContext.file);
    assert.equal(fallbackAudit.contextErrors, 6);
    assert.equal(fallbackAudit.candleSnapshots, 0); assert.equal(fallbackAudit.calendarSnapshots, 0);

    // Real stream parser with split network chunks: recorder sees quotes even
    // when normalization rejects them, before any UI broadcast/filtering.
    const originalFetch = globalThis.fetch;
    const observations: { price: unknown; receivedAt: string }[] = [];
    const prices: string[] = [];
    let streamIssues = 0;
    let heartbeats = 0;
    let complete!: () => void;
    const gotQuotes = new Promise<void>(resolve => { complete = resolve; });
    const transport = new ReadableStream<Uint8Array>({ start(controller) {
      const payload = JSON.stringify({ type: "HEARTBEAT", time: now }) + "\n{bad}\n" + JSON.stringify(raw) + "\n" + JSON.stringify({ ...raw, asks: [{ price: "110" }] }) + "\n";
      controller.enqueue(new TextEncoder().encode(payload.slice(0, 40)));
      controller.enqueue(new TextEncoder().encode(payload.slice(40)));
    } });
    globalThis.fetch = async () => new Response(transport);
    const stream = new OandaPricingStream({ accountId: "fixture", apiKey: "fixture", environment: "practice", instruments: ["AUD_JPY"], isConfigured: true, streamBaseUrl: "https://example.invalid", port: 0 }, {
      onIssue: () => { streamIssues++; },
      onObservation: (price, receivedAt) => { observations.push({ price, receivedAt }); if (observations.length === 2) complete(); },
      onPrice: tick => prices.push(tick.instrument), onHeartbeat: () => { heartbeats++; }, onStatus: () => {},
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      stream.start();
      await Promise.race([gotQuotes, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Stream fixture timed out")), 2000); })]);
      assert.equal(observations.length, 2); assert.equal(prices.length, 1);
      assert.equal(streamIssues, 1); assert.equal(heartbeats, 1);
      assert.ok(observations.every(x => Number.isFinite(Date.parse(x.receivedAt))));
    } finally { clearTimeout(timeout); stream.stop(); globalThis.fetch = originalFetch; }

    await appendFile(recorder.file, "{truncated");
    await assert.rejects(async () => { for await (const row of replayMarketRecording(recorder.file)) void row; }, /Corrupt recording/);
    console.log("Market recording checks passed: stream capture, all-pair normalization, exact timestamps, duplicate retention, receive-order replay, as-of context, outages, invalid quotes, storage failure, bounded buffering, corrupt logs.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
