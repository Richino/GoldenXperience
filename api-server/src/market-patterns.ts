import type { Candle } from "../../frontend/src/types/forex.js";
import { isKnownInstrument, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { normalizeOandaPrice, type OandaStreamPrice } from "./market-stream-normalize.js";
import { MarketMovementEngine, timestampNs } from "./market-movement.js";
import type { MarketRecord } from "./market-recording.js";
import { PATTERN_INTERVALS, PATTERN_RULES_VERSION, boundaryAt, candlePatterns, levelPatterns, structurePatterns, type PatternGeometry } from "./market-pattern-definitions.js";

export interface PatternObservation extends PatternGeometry {
  id: string;
  instrument: string;
  granularity: string;
  state: "forming" | "confirmed" | "invalidated" | "expired";
  revision: number;
  observedAt: string;
  updatedAt: string;
  confirmedObservedAt: string | null;
  confirmedCandleTime: string | null;
  confirmedDirection: "up" | "down" | "neutral" | null;
  reason: string;
  origin: "broker_candles" | "sampled_quote_preview";
  historicalOnDiscovery: boolean;
}
export interface PatternEvent { sequence: number; pattern: PatternObservation }
interface Frame {
  candles: Candle[];
  contextCandles: Candle[];
  bucketOffsetMs: number;
  contextAt: string | null;
  reason: string | null;
  locked: boolean;
  patterns: Map<string, PatternObservation>;
}

/** Evidence and lifecycle observer, isolated from the frozen Pattern V1 and execution code. */
export class MarketPatternEngine {
  readonly movement: MarketMovementEngine;
  private frames = new Map<string, Frame>();
  private events: PatternEvent[] = [];
  private eventSequence = 0;
  private lastRecord: { session: string; sequence: number; connection: number; receivedAt: string } | null = null;
  private sessionValidated = false;

  constructor(readonly instruments: readonly string[], movement?: MarketMovementEngine, private readonly onEvent?: (event: PatternEvent) => void) {
    if (!instruments.length || instruments.some(x => !isKnownInstrument(x) || x !== x.toUpperCase())) throw new Error("Choose known uppercase pattern instruments.");
    this.movement = movement ?? new MarketMovementEngine(instruments);
  }
  private frame(instrument: string, granularity: string) {
    const key = `${instrument}:${granularity}`;
    let frame = this.frames.get(key);
    if (!frame) { frame = { candles: [], contextCandles: [], bucketOffsetMs: 0, contextAt: null, reason: "waiting_for_candles", locked: false, patterns: new Map() }; this.frames.set(key, frame); }
    return frame;
  }
  private emit(frame: Frame, pattern: PatternObservation) {
    frame.patterns.set(pattern.id, pattern);
    // Copies preserve earlier evidence rather than mutating a previous event.
    const event = { sequence: ++this.eventSequence, pattern: structuredClone(pattern) };
    this.events.push(event);
    this.onEvent?.(structuredClone(event));
    if (this.events.length > 256) this.events.shift();
    if (frame.patterns.size > 128) {
      const terminal = [...frame.patterns.values()].find(x => x.state === "expired" || x.state === "invalidated");
      frame.patterns.delete(terminal?.id ?? frame.patterns.keys().next().value!);
    }
  }
  private change(frame: Frame, p: PatternObservation, state: PatternObservation["state"], receivedAt: string, reason: string, candle?: Candle, direction?: PatternObservation["confirmedDirection"]) {
    if (p.state === state && p.reason === reason) return;
    this.emit(frame, { ...p, state, reason, revision: p.revision + 1, updatedAt: receivedAt,
      confirmedObservedAt: state === "confirmed" ? receivedAt : p.confirmedObservedAt,
      confirmedCandleTime: state === "confirmed" ? candle!.time : p.confirmedCandleTime,
      confirmedDirection: state === "confirmed" ? direction ?? p.direction : p.confirmedDirection });
  }
  private discover(frame: Frame, instrument: string, granularity: string, geometry: PatternGeometry, receivedAt: string, closed: boolean, historical: boolean) {
    const id = `${instrument}:${granularity}:${geometry.key}`;
    const existing = frame.patterns.get(id);
    if (existing?.state === "forming" && geometry.family === "candle" && !closed) {
      if (JSON.stringify([existing.evidence, existing.anchors, existing.invalidAbove, existing.invalidBelow]) !== JSON.stringify([geometry.evidence, geometry.anchors, geometry.invalidAbove, geometry.invalidBelow])) this.emit(frame, { ...existing, ...geometry, revision: existing.revision + 1, updatedAt: receivedAt });
      return;
    }
    if (existing && !["forming_geometry_changed", "quote_preview_continuity_lost"].includes(existing.reason)) return;
    const state = geometry.family === "candle" && closed ? "confirmed" : "forming";
    this.emit(frame, { ...geometry, id, instrument, granularity, state, revision: (existing?.revision ?? 0) + 1,
      observedAt: existing?.observedAt ?? receivedAt, updatedAt: receivedAt,
      confirmedObservedAt: state === "confirmed" ? receivedAt : null,
      confirmedCandleTime: state === "confirmed" ? geometry.endTime : null,
      confirmedDirection: state === "confirmed" ? geometry.direction : null,
      reason: state === "confirmed" ? "closed_candle_geometry" : geometry.family === "structure" ? "awaiting_boundary_close" : "candle_still_forming",
      origin: closed || geometry.family === "structure" ? "broker_candles" : "sampled_quote_preview", historicalOnDiscovery: historical });
  }
  private advance(frame: Frame, candle: Candle, receivedAt: string, granularity: string) {
    for (const p of [...frame.patterns.values()]) {
      if (p.state === "invalidated" || p.state === "expired" || candle.time < p.endTime) continue;
      const elapsedBars = (Date.parse(candle.time) - Date.parse(p.endTime)) / PATTERN_INTERVALS[granularity];
      if (elapsedBars > p.expiresAfterBars || typeof p.evidence.apexTime === "string" && Date.parse(candle.time) >= Date.parse(p.evidence.apexTime)) {
        this.change(frame, p, "expired", receivedAt, "pattern_window_expired"); continue;
      }
      const upper = p.upper ? boundaryAt(p.upper, candle.time) : null, lower = p.lower ? boundaryAt(p.lower, candle.time) : null;
      const invalid = (p.family === "structure" || candle.time > p.endTime) && (p.invalidAbove !== undefined && candle.close > p.invalidAbove || p.invalidBelow !== undefined && candle.close < p.invalidBelow
        || p.confirmedDirection === "up" && lower !== null && candle.close < lower || p.confirmedDirection === "down" && upper !== null && candle.close > upper);
      if (invalid) { this.change(frame, p, "invalidated", receivedAt, "close_crossed_invalidation"); continue; }
      if (p.state === "forming") {
        if (p.family === "candle" && p.endTime === candle.time) {
          // The closed detector must still find the shape; previews never confirm by time alone.
          const found = [...candlePatterns(frame.candles.filter(x => x.complete && x.time <= candle.time), pipSizeFor(p.instrument)), ...levelPatterns(frame.candles.filter(x => x.complete && x.time <= candle.time), pipSizeFor(p.instrument))].find(x => x.key === p.key);
          if (found) this.emit(frame, { ...p, ...found, state: "confirmed", revision: p.revision + 1, updatedAt: receivedAt, confirmedObservedAt: receivedAt, confirmedCandleTime: candle.time, confirmedDirection: found.direction, reason: "closed_candle_geometry", origin: "broker_candles" });
          else this.change(frame, p, "invalidated", receivedAt, "forming_geometry_changed");
        } else if (p.family === "structure") {
          if (upper !== null && candle.close > upper) this.change(frame, p, "confirmed", receivedAt, "close_above_boundary", candle, "up");
          else if (lower !== null && candle.close < lower) this.change(frame, p, "confirmed", receivedAt, "close_below_boundary", candle, "down");
        }
      }
    }
  }
  context(data: Record<string, unknown>, receivedAt: string) {
    const instrument = String(data.instrument), granularity = String(data.granularity);
    if (!this.instruments.includes(instrument) || !PATTERN_INTERVALS[granularity]) return;
    const frame = this.frame(instrument, granularity), interval = PATTERN_INTERVALS[granularity], received = timestampNs(receivedAt);
    if (frame.locked) return;
    const series = data.snapshot as { source?: string; instrument?: string; granularity?: string; candles?: Candle[] } | undefined;
    const incoming = series?.candles;
    const invalid = !received || data.source !== "oanda" || series?.source !== "oanda" || series.instrument !== instrument || series.granularity !== granularity || !Array.isArray(incoming) || !incoming.length || incoming.length > 1024;
    if (invalid) { frame.reason = "invalid_candle_snapshot"; return; }
    if (frame.contextAt && Date.parse(receivedAt) < Date.parse(frame.contextAt)) { frame.reason = "context_clock_regression"; return; }
    for (let i = 0; i < incoming!.length; i++) {
      const c = incoming![i];
      if (!c || typeof c !== "object") { frame.reason = "invalid_candle_snapshot"; return; }
      const time = timestampNs(c.time), prices = [c.open, c.high, c.low, c.close];
      if (!time || prices.some(x => typeof x !== "number" || !Number.isFinite(x) || x <= 0) || c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)
        || typeof c.complete !== "boolean" || time % 60_000_000_000n !== 0n || time > received! || c.complete && time + BigInt(interval) * 1_000_000n > received!
        || i > 0 && Date.parse(c.time) <= Date.parse(incoming![i - 1].time) || !c.complete && i !== incoming!.length - 1) {
        frame.reason = "invalid_candle_snapshot"; return;
      }
      const previous = frame.contextCandles.find(x => Date.parse(x.time) === Date.parse(c.time) && x.complete);
      if (previous && (!c.complete || prices.some((price, index) => price !== [previous.open, previous.high, previous.low, previous.close][index]))) {
        frame.reason = "closed_candle_revision"; frame.locked = true; return;
      }
    }
    const previousComplete = new Set(frame.candles.filter(x => x.complete).map(x => x.time));
    const merged = new Map([...frame.contextCandles, ...frame.candles].map(c => [c.time, c]));
    for (const source of incoming!) {
      const candle = { ...source, time: new Date(Date.parse(source.time)).toISOString() };
      const previous = merged.get(candle.time);
      merged.set(candle.time, !candle.complete && previous && !previous.complete
        ? { ...candle, high: Math.max(candle.high, previous.high), low: Math.min(candle.low, previous.low) } : { ...candle });
    }
    const all = [...merged.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-256);
    frame.contextCandles = structuredClone(all);
    // A missing/incomplete historical bar separates segments. No patterns bridge it.
    let start = 0;
    for (let i = 1; i < all.length; i++) if (!all[i - 1].complete || Date.parse(all[i].time) - Date.parse(all[i - 1].time) !== interval) start = i;
    frame.candles = all.slice(start); frame.contextAt = receivedAt; frame.reason = null;
    // H4 is broker-session aligned, which need not be midnight UTC.
    frame.bucketOffsetMs = Date.parse(frame.candles.at(-1)!.time) % interval;
    if (start) for (const p of [...frame.patterns.values()]) if (p.state === "forming" || p.state === "confirmed") this.change(frame, p, "invalidated", receivedAt, "candle_history_gap");
    for (let i = 0; i < frame.candles.length; i++) {
      const c = frame.candles[i]; if (!c.complete || previousComplete.has(c.time)) continue;
      const prefix = frame.candles.slice(0, i + 1), pip = pipSizeFor(instrument);
      const historical = Date.parse(c.time) + interval < Date.parse(receivedAt) - interval;
      this.advance(frame, c, receivedAt, granularity);
      for (const geometry of [...candlePatterns(prefix, pip), ...levelPatterns(prefix, pip), ...structurePatterns(prefix, pip)]) this.discover(frame, instrument, granularity, geometry, receivedAt, true, historical);
      this.advance(frame, c, receivedAt, granularity);
    }
    this.preview(frame, instrument, granularity, receivedAt);
  }
  private preview(frame: Frame, instrument: string, granularity: string, receivedAt: string) {
    const last = frame.candles.at(-1); if (!last || last.complete) return;
    const definitions = [...candlePatterns(frame.candles, pipSizeFor(instrument)), ...levelPatterns(frame.candles, pipSizeFor(instrument))];
    const keys = new Set(definitions.map(x => x.key));
    for (const p of [...frame.patterns.values()]) if (p.family === "candle" && p.state === "forming" && p.endTime === last.time && !keys.has(p.key)) this.change(frame, p, "invalidated", receivedAt, "forming_geometry_changed");
    for (const definition of definitions) this.discover(frame, instrument, granularity, definition, receivedAt, false, false);
  }
  contextError(data: Record<string, unknown>) {
    if (typeof data.instrument === "string" && this.instruments.includes(data.instrument) && typeof data.granularity === "string" && PATTERN_INTERVALS[data.granularity]) this.frame(data.instrument, data.granularity);
    for (const [key, frame] of this.frames) if ((!data.instrument || key.startsWith(`${data.instrument}:`)) && (!data.granularity || key.endsWith(`:${data.granularity}`)) && data.context !== "calendar") frame.reason = "context_unavailable";
  }
  private pauseFrames(receivedAt: string, instrument?: string) {
    for (const [key, frame] of this.frames) {
      if (instrument && !key.startsWith(`${instrument}:`)) continue;
      frame.reason = "awaiting_context_resync";
      for (const p of [...frame.patterns.values()]) if (p.state === "forming" && p.origin === "sampled_quote_preview") this.change(frame, p, "invalidated", receivedAt, "quote_preview_continuity_lost");
    }
  }
  breakContinuity(reason: string, receivedAt = new Date().toISOString()) {
    this.movement.breakContinuity(reason);
    this.pauseFrames(receivedAt);
  }
  setConnection(state: string, source = "oanda", receivedAt = new Date().toISOString()) {
    if (state !== "connected" || source !== "oanda") this.breakContinuity(`stream_${state}`, receivedAt);
    this.movement.setConnection(state, source);
  }
  observe(raw: OandaStreamPrice, receivedAt: string) {
    const instrument = raw.instrument; if (!instrument || !this.instruments.includes(instrument)) return;
    const before = this.movement.snapshot(instrument, receivedAt);
    this.movement.observe(raw, receivedAt);
    const movement = this.movement.snapshot(instrument, receivedAt);
    if (movement.state === "paused") { this.pauseFrames(receivedAt, instrument); return; }
    if (movement.counts.accepted === before.counts.accepted) return;
    // A usable quote after a gap still needs authoritative candle resynchronization.
    if (before.retainedSamples && movement.retainedSamples === 1) { this.pauseFrames(receivedAt, instrument); return; }
    const tick = normalizeOandaPrice(raw, movement.counts.accepted)!;
    for (const granularity of Object.keys(PATTERN_INTERVALS)) {
      const frame = this.frames.get(`${instrument}:${granularity}`); if (!frame || frame.reason || frame.locked) continue;
      const interval = PATTERN_INTERVALS[granularity], bucket = Math.floor((Date.parse(raw.time!) - frame.bucketOffsetMs) / interval) * interval + frame.bucketOffsetMs;
      const time = new Date(bucket).toISOString(), last = frame.candles.at(-1);
      if (!last || Date.parse(last.time) > bucket || last.time === time && last.complete) continue;
      if (Date.parse(receivedAt) - Date.parse(frame.contextAt!) > (granularity === "M1" ? 150_000 : 600_000)) { frame.reason = "stale_context"; continue; }
      if (last.time !== time) {
        if (!last.complete || Date.parse(last.time) + interval !== bucket) { frame.reason = "awaiting_broker_candle_close"; continue; }
        frame.candles.push({ time, open: tick.mid, high: tick.mid, low: tick.mid, close: tick.mid, volume: 0, complete: false });
        if (frame.candles.length > 256) frame.candles.shift();
      } else {
        last.high = Math.max(last.high, tick.mid); last.low = Math.min(last.low, tick.mid); last.close = tick.mid;
      }
      this.preview(frame, instrument, granularity, receivedAt);
    }
  }
  /** Validated broker candles only; consumers cannot mutate the observer's history. */
  history(instrument: string, granularity: string): Candle[] {
    return structuredClone(this.frames.get(`${instrument}:${granularity}`)?.candles ?? []);
  }
  /** Trading-bar context spans session gaps; geometric pattern detection stays within a contiguous segment. */
  contextHistory(instrument: string, granularity: string): Candle[] {
    return structuredClone(this.frames.get(`${instrument}:${granularity}`)?.contextCandles ?? []);
  }
  snapshot(instrument: string, asOf = new Date().toISOString()) {
    for (const [key, frame] of this.frames) if (key.startsWith(`${instrument}:`) && (frame.contextAt && Date.parse(frame.contextAt) > Date.parse(asOf) || [...frame.patterns.values()].some(p => Date.parse(p.updatedAt) > Date.parse(asOf)))) throw new Error("Use receive-order replay to request an earlier pattern snapshot.");
    const movement = this.movement.snapshot(instrument, asOf);
    const frames = Object.keys(PATTERN_INTERVALS).map(granularity => {
      const frame = this.frames.get(`${instrument}:${granularity}`), interval = PATTERN_INTERVALS[granularity];
      const age = frame?.contextAt ? Date.parse(asOf) - Date.parse(frame.contextAt) : null;
      const last = frame?.candles.at(-1);
      const reason = frame?.reason ?? (!frame ? "waiting_for_candles" : age! < 0 ? "as_of_before_context" : age! > (granularity === "M1" ? 150_000 : 600_000) ? "stale_context" : last && Date.parse(last.time) + interval * 2 < Date.parse(asOf) ? "historical_candles" : null);
      const ordered = frame ? [...frame.patterns.values()].sort((a, b) => {
        const priority = (p: PatternObservation) => p.state === "forming" || p.state === "confirmed" ? p.family === "structure" ? 2 : 1 : 0;
        return priority(b) - priority(a) || Date.parse(b.endTime) - Date.parse(a.endTime);
      }) : [];
      return { granularity, dataState: reason || movement.state === "paused" ? "paused" : "current", reason: reason ?? movement.reason, contextAt: frame?.contextAt ?? null, contextAgeMs: age,
        retainedCandles: frame?.candles.length ?? 0, completedCandles: frame?.candles.filter(c => c.complete).length ?? 0, formingCandleTime: last && !last.complete ? last.time : null,
        totalPatterns: ordered.length, omittedPatterns: Math.max(0, ordered.length - 32),
        patterns: ordered.slice(0, 32).map(p => ({ ...structuredClone(p),
          currentUpper: p.upper && last ? boundaryAt(p.upper, last.time) : null, currentLower: p.lower && last ? boundaryAt(p.lower, last.time) : null,
          previewBoundaryBreak: !last || last.complete || reason || movement.state === "paused" ? null
            : p.upper && last.close > boundaryAt(p.upper, last.time) ? "up" : p.lower && last.close < boundaryAt(p.lower, last.time) ? "down" : null,
        })) };
    });
    return { version: 1, rulesVersion: PATTERN_RULES_VERSION, instrument, asOf, purpose: "descriptive_pattern_observer", actionable: false, movement, frames,
      eventSequence: this.eventSequence, events: this.events.filter(x => x.pattern.instrument === instrument).slice(-64).map(x => structuredClone(x)) };
  }
  consume(record: MarketRecord) {
    if (record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !timestampNs(record.receivedAt)) throw new Error("Invalid pattern recording envelope.");
    if (record.kind === "session") {
      if (record.data.source !== "oanda" || record.data.environment !== "practice") throw new Error("Pattern replay requires OANDA practice data.");
      this.sessionValidated = true; this.frames.clear(); this.events = []; this.eventSequence = 0; this.lastRecord = null;
    } else if (!this.sessionValidated) throw new Error("Pattern replay requires a session header.");
    const previous = this.lastRecord;
    if (previous && record.sessionId !== previous.session) throw new Error("Recording session changed without a header.");
    const broken = previous && (record.sequence !== previous.sequence + 1 || record.connection !== previous.connection || Date.parse(record.receivedAt) < Date.parse(previous.receivedAt));
    if (broken) this.breakContinuity("recording_continuity_break", record.receivedAt);
    this.lastRecord = { session: record.sessionId, sequence: record.sequence, connection: record.connection, receivedAt: record.receivedAt };
    // Movement consumes feed rows for identical live/replay behavior; quotes go through observe once.
    this.movement.consume(record.kind === "quote" ? { ...record, kind: "heartbeat", data: {} } : record);
    if (record.kind === "connection") this.setConnection(String(record.data.state), String(record.data.source), record.receivedAt);
    if (record.kind === "stream-error") this.breakContinuity("stream_message_error", record.receivedAt);
    if (record.kind === "quote" && !broken) {
      if (!record.data.raw || typeof record.data.raw !== "object") throw new Error("Missing recorded quote payload.");
      this.observe(record.data.raw as OandaStreamPrice, record.receivedAt);
    }
    if (record.kind === "candles" && !broken) this.context(record.data, record.receivedAt);
    if (record.kind === "context-error") this.contextError(record.data);
  }
}
