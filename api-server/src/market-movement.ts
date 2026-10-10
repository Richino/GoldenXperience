import { isKnownInstrument, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import type { OandaStreamPrice } from "./market-stream-normalize.js";
import type { MarketRecord } from "./market-recording.js";

const WINDOWS = [5, 30, 180] as const;
const EPSILON_PIPS = 1e-7;

/** OANDA UTC timestamps retain nanoseconds; Date.parse alone would lose them. */
export function timestampNs(value: string): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null;
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

interface Sample { time: bigint; received: bigint; brokerTime: string; receivedAt: string; bid: number; ask: number; mid: number }
interface PairState {
  samples: Sample[];
  reason: string | null;
  lastBreak: string | null;
  lastReceived: bigint | null;
  watermark: Sample | null;
  accepted: number;
  rejected: number;
  duplicates: number;
  resets: number;
}

function sign(value: number) { return Math.abs(value) <= EPSILON_PIPS ? 0 : value > 0 ? 1 : -1; }
function seconds(start: bigint, end: bigint) { return Number(end - start) / 1e9; }

function measure(samples: Sample[], pip: number, windowSeconds: number) {
  const first = samples[0], last = samples.at(-1)!;
  const duration = seconds(first.time, last.time);
  const net = (last.mid - first.mid) / pip;
  let path = 0, up = 0, down = 0, unchanged = 0, bothUp = 0, bothDown = 0;
  let high = first.mid, low = first.mid, above = 0, below = 0, flat = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1], current = samples[i];
    const move = (current.mid - previous.mid) / pip;
    path += Math.abs(move);
    const direction = sign(move);
    if (direction > 0) up++; else if (direction < 0) down++; else unchanged++;
    if (sign((current.bid - previous.bid) / pip) > 0 && sign((current.ask - previous.ask) / pip) > 0) bothUp++;
    if (sign((current.bid - previous.bid) / pip) < 0 && sign((current.ask - previous.ask) / pip) < 0) bothDown++;
    high = Math.max(high, current.mid); low = Math.min(low, current.mid);
    // Time weights use the preceding observed quote (no interpolation/lookahead).
    const dt = seconds(previous.time, current.time);
    const side = sign((previous.mid - first.mid) / pip);
    if (side > 0) above += dt; else if (side < 0) below += dt; else flat += dt;
  }
  const bidNet = (last.bid - first.bid) / pip, askNet = (last.ask - first.ask) / pip;
  const bidDirection = sign(bidNet), askDirection = sign(askNet);
  const direction = bidDirection === askDirection && bidDirection !== 0 ? (bidDirection > 0 ? "up" : "down")
    : sign(net) === 0 && bidDirection === 0 && askDirection === 0 ? "flat" : "mixed";
  // Half-window velocity comparison; only actual observed endpoints are used.
  const middleTime = first.time + (last.time - first.time) / 2n;
  let middle = 0;
  for (let i = 1; i < samples.length - 1 && samples[i].time <= middleTime; i++) middle = i;
  const pivot = samples[middle];
  const leftDuration = seconds(first.time, pivot.time), rightDuration = seconds(pivot.time, last.time);
  const acceleration = leftDuration >= 0.5 && rightDuration >= 0.5
    ? (((last.mid - pivot.mid) / pip / rightDuration) - ((pivot.mid - first.mid) / pip / leftDuration)) / (duration / 2)
    : null;
  return {
    windowSeconds, coverageSeconds: duration, coverageRatio: Math.min(1, duration / windowSeconds),
    state: samples.length >= 3 && duration >= windowSeconds * 0.8 ? "ready" : "warming",
    samples: samples.length, firstBrokerTime: first.brokerTime, lastBrokerTime: last.brokerTime,
    direction, netPips: net, bidNetPips: bidNet, askNetPips: askNet,
    pathPips: path, rangePips: (high - low) / pip,
    velocityPipsPerSecond: duration > 0 ? net / duration : null,
    activityPipsPerSecond: duration > 0 ? path / duration : null,
    observedUpdatesPerSecond: duration > 0 ? (samples.length - 1) / duration : null,
    accelerationPipsPerSecondSquared: acceleration,
    directionalEfficiency: path > EPSILON_PIPS ? Math.min(1, Math.abs(net) / path) : 0,
    tickPersistence: up + down ? (up - down) / (up + down) : 0,
    transitions: { up, down, unchanged, bothBidAskUp: bothUp, bothBidAskDown: bothDown },
    timeAboveStartRatio: duration > 0 ? above / duration : null,
    timeBelowStartRatio: duration > 0 ? below / duration : null,
    timeAtStartRatio: duration > 0 ? flat / duration : null,
    excursionAboveStartPips: (high - first.mid) / pip, excursionBelowStartPips: (first.mid - low) / pip,
    pullbackFromHighPips: (high - last.mid) / pip, reboundFromLowPips: (last.mid - low) / pip,
    spreadPips: (last.ask - last.bid) / pip,
    spreadChangePips: ((last.ask - last.bid) - (first.ask - first.bid)) / pip,
    maxSpreadPips: Math.max(...samples.map(x => (x.ask - x.bid) / pip)),
  };
}

/** Descriptive quote measurements only. No AI, predictions, order imports, or candle-to-tick fabrication. */
export class MarketMovementEngine {
  private pairs = new Map<string, PairState>();
  private connection = "waiting";
  private lastRecord: { session: string; sequence: number; connection: number; received: bigint } | null = null;
  private sessionValidated = false;
  private readonly maxSamples: number;

  constructor(readonly instruments: readonly string[], options: { maxSamples?: number } = {}) {
    if (!instruments.length || instruments.some(x => !isKnownInstrument(x) || x !== x.toUpperCase())) throw new Error("Choose known uppercase movement instruments.");
    this.maxSamples = options.maxSamples ?? 4096;
    if (!Number.isInteger(this.maxSamples) || this.maxSamples < 3 || this.maxSamples > 100_000) throw new Error("Invalid movement sample limit.");
    for (const instrument of instruments) this.pairs.set(instrument, { samples: [], reason: "waiting_for_quote", lastBreak: null, lastReceived: null, watermark: null, accepted: 0, rejected: 0, duplicates: 0, resets: 0 });
  }

  private reset(pair: PairState, reason: string) {
    pair.samples = []; pair.reason = reason; pair.lastBreak = reason; pair.resets++;
  }

  breakContinuity(reason: string) { for (const pair of this.pairs.values()) this.reset(pair, reason); }

  setConnection(state: string, source = "oanda") {
    const next = source === "oanda" ? state : "unavailable";
    if (next !== this.connection) this.breakContinuity(next === "connected" ? "connection_restarted" : `stream_${next}`);
    this.connection = next;
  }

  observe(raw: OandaStreamPrice, receivedAt: string) {
    const pair = this.pairs.get(raw.instrument ?? "");
    if (!pair) return;
    const received = timestampNs(receivedAt), time = timestampNs(raw.time ?? "");
    const bid = Number(raw.bids?.[0]?.price ?? raw.closeoutBid), ask = Number(raw.asks?.[0]?.price ?? raw.closeoutAsk);
    const reject = (reason: string) => { pair.rejected++; this.reset(pair, reason); };
    if (this.connection !== "connected") { reject(`stream_${this.connection}`); return; }
    if (received === null || time === null) { reject("invalid_timestamp"); return; }
    if (pair.lastReceived !== null && received < pair.lastReceived) { reject("receive_clock_regression"); return; }
    pair.lastReceived = received;
    if (![bid, ask].every(Number.isFinite) || bid <= 0 || ask < bid) { reject("invalid_bid_ask"); return; }
    if (typeof raw.status !== "string" || raw.status.toLowerCase() !== "tradeable") { reject("nontradeable_quote"); return; }
    if (received - time > 5_000_000_000n) { reject("stale_broker_quote"); return; }
    if (time - received > 1_000_000_000n) { reject("broker_clock_ahead"); return; }
    const watermark = pair.watermark;
    if (watermark) {
      if (time < watermark.time) { reject("broker_time_regression"); return; }
      if (time === watermark.time) {
        if (bid === watermark.bid && ask === watermark.ask) { pair.duplicates++; return; }
        reject("conflicting_same_timestamp"); return;
      }
    }
    const previous = pair.samples.at(-1);
    if (previous) {
      if (received - previous.received > 5_000_000_000n || time - previous.time > 5_000_000_000n) this.reset(pair, "quote_gap");
    }
    const cutoff = time - 180_000_000_000n;
    // No pre-window sample is borrowed: it would include a movement from outside the window.
    while (pair.samples.length && pair.samples[0].time < cutoff) pair.samples.shift();
    if (pair.samples.length >= this.maxSamples) this.reset(pair, "sample_limit");
    const sample = { time, received, brokerTime: raw.time!, receivedAt, bid, ask, mid: (bid + ask) / 2 };
    pair.samples.push(sample); pair.watermark = sample;
    pair.accepted++; pair.reason = null;
  }

  snapshot(instrument: string, asOf = new Date().toISOString()) {
    const pair = this.pairs.get(instrument);
    if (!pair) throw new Error("Instrument is not subscribed to the movement engine.");
    const now = timestampNs(asOf);
    if (now === null) throw new Error("Invalid movement as-of timestamp.");
    const last = pair.samples.at(-1);
    const quoteAgeMs = last ? Number(now - last.time) / 1e6 : null;
    const receiveAgeMs = last ? Number(now - last.received) / 1e6 : null;
    const reason = this.connection !== "connected" ? `stream_${this.connection}` : pair.reason
      ?? (!last ? "waiting_for_quote" : now < last.received ? "as_of_before_latest_quote" : quoteAgeMs! > 5000 || receiveAgeMs! > 5000 ? "stale_quote" : null);
    const windows = reason || !last ? [] : WINDOWS.map(window => measure(pair.samples.filter(x => x.time >= last.time - BigInt(window) * 1_000_000_000n), pipSizeFor(instrument), window));
    return {
      version: 1, instrument, source: "oanda", purpose: "descriptive_quote_movement", asOf,
      state: reason ? "paused" : windows[0].state === "ready" ? "ready" : "warming",
      reason, connection: this.connection, lastBreak: pair.lastBreak,
      lastBrokerTime: last?.brokerTime ?? null, lastReceivedAt: last?.receivedAt ?? null,
      bid: reason ? null : last?.bid ?? null, ask: reason ? null : last?.ask ?? null,
      quoteAgeMs, receiveAgeMs, pipSize: pipSizeFor(instrument), retainedSamples: pair.samples.length,
      counts: { accepted: pair.accepted, rejected: pair.rejected, duplicateTimestamps: pair.duplicates, continuityResets: pair.resets }, windows,
    };
  }

  /** Consume the exact receive-order log, including feed breaks. Context cannot become ticks. */
  consume(record: MarketRecord) {
    if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !Number.isSafeInteger(record.connection) || record.connection < 0) throw new Error("Invalid movement recording envelope.");
    const received = timestampNs(record.receivedAt);
    if (received === null) throw new Error("Invalid recording receive timestamp.");
    if (record.kind === "session") {
      if (record.data.environment !== "practice" || record.data.source !== "oanda") throw new Error("Movement replay requires an OANDA practice recording.");
      this.sessionValidated = true; this.lastRecord = null; this.setConnection("waiting");
      this.breakContinuity("recording_session_started");
      for (const pair of this.pairs.values()) { pair.lastReceived = null; pair.watermark = null; }
    } else if (!this.sessionValidated) throw new Error("Movement replay requires a session header.");
    const previous = this.lastRecord;
    if (previous && record.sessionId !== previous.session) throw new Error("Recording session changed without a session header.");
    let breakReason: string | null = null;
    if (previous && record.sequence !== previous.sequence + 1) breakReason = "recording_sequence_gap";
    if (previous && received < previous.received) breakReason = "recording_clock_regression";
    if (previous && record.connection !== previous.connection) breakReason ??= "recording_connection_changed";
    if (breakReason) this.breakContinuity(breakReason);
    this.lastRecord = { session: record.sessionId, sequence: record.sequence, connection: record.connection, received };
    if (record.kind === "connection") this.setConnection(String(record.data.state), String(record.data.source));
    if (record.kind === "stream-error") this.breakContinuity("stream_message_error");
    if (record.kind === "end") this.setConnection("closed");
    if (record.kind === "quote" && !breakReason) {
      if (!record.data.raw || typeof record.data.raw !== "object") throw new Error("Recorded quote is missing the original payload.");
      this.observe(record.data.raw as OandaStreamPrice, record.receivedAt);
    }
  }
}
