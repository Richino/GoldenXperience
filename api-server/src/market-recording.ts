import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type { OandaStreamPrice } from "./market-stream-normalize.js";

export interface MarketRecord {
  version: 1;
  sessionId: string;
  sequence: number;
  connection: number;
  receivedAt: string;
  kind: "session" | "quote" | "heartbeat" | "connection" | "candles" | "calendar" | "context-error" | "stream-error" | "end";
  data: Record<string, unknown>;
}

/** Local append-only observation log. Never imports order/execution code. */
export class MarketRecorder {
  readonly sessionId = randomUUID();
  readonly file: string;
  private sequence = 0;
  private connection = 0;
  private queue: string[] = [];
  private pendingBytes = 0;
  private storedBytes = 0;
  private writing: Promise<void> | null = null;
  private closed = false;
  private failure: string | null = null;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    directory: string;
    instruments: string[];
    environment: "practice";
    maxPendingBytes?: number;
    maxFileBytes?: number;
    write?: (file: string, batch: string) => Promise<void>;
    now?: () => string;
  }) {
    if (options.environment !== "practice") throw new Error("Market recording is practice-only.");
    this.file = path.join(path.resolve(options.directory), `${this.sessionId}.ndjson`);
    this.record("session", {
      source: "oanda", environment: options.environment, instruments: options.instruments,
      sampling: "OANDA stream: at most 4 prices/second/instrument; intermediate prices may be omitted",
      startedAt: this.now(),
    });
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }

  private now() { return this.options.now?.() ?? new Date().toISOString(); }

  record(kind: MarketRecord["kind"], data: Record<string, unknown>, receivedAt = this.now()) {
    if (this.closed || this.failure) { this.dropped++; return; }
    if (kind === "connection" && data.state === "connecting") this.connection++;
    const row: MarketRecord = { version: 1, sessionId: this.sessionId, sequence: ++this.sequence, connection: this.connection, receivedAt, kind, data };
    const line = JSON.stringify(row) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > (this.options.maxPendingBytes ?? 8 * 1024 * 1024)) {
      this.fail("Recorder buffer limit reached; observation coverage is incomplete.");
      this.dropped++;
      return;
    }
    if (this.storedBytes + this.pendingBytes + bytes > (this.options.maxFileBytes ?? 512 * 1024 * 1024)) {
      this.fail("Recorder file limit reached; start a new recording session.");
      this.dropped++;
      return;
    }
    this.queue.push(line);
    this.pendingBytes += bytes;
  }

  quote(raw: OandaStreamPrice, receivedAt: string) {
    const bid = Number(raw.bids?.[0]?.price ?? raw.closeoutBid);
    const ask = Number(raw.asks?.[0]?.price ?? raw.closeoutAsk);
    const reasons: string[] = [];
    if (!raw.instrument || !this.options.instruments.includes(raw.instrument)) reasons.push("unexpected_instrument");
    if (!raw.time || !Number.isFinite(Date.parse(raw.time))) reasons.push("invalid_broker_time");
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) reasons.push("invalid_bid_ask");
    this.record("quote", {
      instrument: raw.instrument ?? null, brokerTime: raw.time ?? null,
      bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null,
      mid: reasons.includes("invalid_bid_ask") ? null : (bid + ask) / 2,
      spread: reasons.includes("invalid_bid_ask") ? null : ask - bid,
      status: raw.status ?? "unknown", valid: reasons.length === 0, reasons, raw,
      brokerAgeMs: raw.time && Number.isFinite(Date.parse(raw.time)) ? Date.parse(receivedAt) - Date.parse(raw.time) : null,
    }, receivedAt);
  }

  status() {
    return { sessionId: this.sessionId, file: this.file, state: this.failure ? "error" : this.closed ? "closed" : "recording", failure: this.failure, receivedRecords: this.sequence, storedBytes: this.storedBytes, pendingBytes: this.pendingBytes, droppedRecords: this.dropped };
  }

  private fail(message: string) {
    this.failure = message;
    console.error(`[market-recording] ${message}`);
  }

  async flush(): Promise<void> {
    if (this.writing) { await this.writing; if (this.queue.length && !this.failure) return this.flush(); return; }
    if (!this.queue.length) return;
    const batch = this.queue.join("");
    const bytes = this.pendingBytes;
    this.queue = [];
    // Retain in-flight bytes in the budget until the write finishes.
    this.writing = (async () => {
      try {
        if (this.options.write) await this.options.write(this.file, batch);
        else { await mkdir(path.dirname(this.file), { recursive: true }); await appendFile(this.file, batch, "utf8"); }
        this.storedBytes += bytes;
      } catch {
        // A partial append cannot safely be retried without duplicating rows.
        this.dropped += batch.split("\n").length - 1;
        this.fail("Recording write failed; coverage is incomplete. Check storage and restart the recorder.");
      } finally { this.pendingBytes -= bytes; }
    })();
    await this.writing;
    this.writing = null;
  }

  async close() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.record("end", { stoppedAt: this.now(), failure: this.failure, droppedRecords: this.dropped });
    this.closed = true;
    await this.flush();
    if (this.queue.length) await this.flush();
  }
}

/** Streaming, receive-order replay; timestamps never get sorted by broker time. */
export async function* replayMarketRecording(file: string, options: { until?: string; instrument?: string } = {}) {
  const cutoff = options.until ? Date.parse(options.until) : Infinity;
  if (Number.isNaN(cutoff)) throw new Error("Invalid replay cutoff.");
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let row: MarketRecord;
      try { row = JSON.parse(line); } catch { throw new Error(`Corrupt recording at line ${lineNumber}; replay stopped.`); }
      if (row.version !== 1 || !row.sessionId || !Number.isSafeInteger(row.sequence) || !Number.isFinite(Date.parse(row.receivedAt)) || !row.data || typeof row.data !== "object") throw new Error(`Invalid record at line ${lineNumber}.`);
      if (Date.parse(row.receivedAt) > cutoff) continue;
      if (options.instrument && typeof row.data.instrument === "string" && row.data.instrument !== options.instrument) continue;
      yield row;
    }
  } finally { lines.close(); input.destroy(); }
}

export async function auditMarketRecording(file: string) {
  const report = { records: 0, quotes: 0, invalidQuotes: 0, nonTradeableQuotes: 0, staleQuotes: 0, candleSnapshots: 0, calendarSnapshots: 0, heartbeats: 0, connectedEvents: 0, lastConnectionState: null as string | null, sequenceGaps: 0, clockRegressions: 0, brokerTimeRegressions: 0, quietQuoteIntervals: 0, heartbeatGaps: 0, connectionErrors: 0, contextErrors: 0, streamErrors: 0, complete: false, instruments: [] as string[] };
  let previousSequence = 0;
  let previousReceive = -Infinity;
  let previousHeartbeat = 0;
  const previousQuotes = new Map<string, { received: number; broker: number }>();
  const instruments = new Set<string>();
  let session: string | null = null;
  for await (const row of replayMarketRecording(file)) {
    if (session && session !== row.sessionId) throw new Error("A recording must contain one session.");
    session = row.sessionId;
    report.records++;
    const received = Date.parse(row.receivedAt);
    if (row.sequence !== previousSequence + 1) report.sequenceGaps++;
    if (received < previousReceive) report.clockRegressions++;
    previousSequence = row.sequence;
    previousReceive = received;
    report.complete = row.kind === "end" && !row.data.failure && row.data.droppedRecords === 0;
    if (row.kind === "connection" && row.data.state === "error") report.connectionErrors++;
    if (row.kind === "connection") {
      report.lastConnectionState = String(row.data.state);
      if (row.data.state === "connected") report.connectedEvents++;
    }
    if (row.kind === "context-error") report.contextErrors++;
    if (row.kind === "stream-error") report.streamErrors++;
    if (row.kind === "candles") report.candleSnapshots++;
    if (row.kind === "calendar") report.calendarSnapshots++;
    if (row.kind === "heartbeat") {
      report.heartbeats++;
      if (previousHeartbeat && received - previousHeartbeat > 20_000) report.heartbeatGaps++;
      previousHeartbeat = received;
    }
    if (row.kind !== "quote") continue;
    report.quotes++;
    if (row.data.valid !== true) { report.invalidQuotes++; continue; }
    if (row.data.status !== "tradeable") report.nonTradeableQuotes++;
    if (typeof row.data.brokerAgeMs === "number" && row.data.brokerAgeMs > 30_000) report.staleQuotes++;
    const instrument = String(row.data.instrument);
    instruments.add(instrument);
    const broker = Date.parse(String(row.data.brokerTime));
    const prior = previousQuotes.get(instrument);
    if (prior && received - prior.received > 5000) report.quietQuoteIntervals++;
    if (prior && broker < prior.broker) report.brokerTimeRegressions++;
    previousQuotes.set(instrument, { received, broker });
  }
  report.instruments = [...instruments].sort();
  return { ...report, note: "Quiet quote intervals are observations, not proof of lost ticks; the source is sampled and markets can be inactive. Complete means clean recorder shutdown, not complete market coverage." };
}
