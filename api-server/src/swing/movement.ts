import { measureObservedQuoteMovement, timestampNs } from "../market-movement.js";
import type { OandaStreamPrice } from "../market-stream-normalize.js";
import { pipSizeFor } from "../../../frontend/src/lib/instruments/catalog.js";
import type { SwingMovement, SwingMovementWindow, SwingZone } from "../../../frontend/src/lib/swing-intelligence.js";
import type { SwingSettings } from "./config.js";

type Sample = { ns: bigint; time: string; received: number; mid: number; bid: number; ask: number };
type Pair = { samples: Sample[]; watermark: bigint | null; gaps: number; rejected: number; reason: string | null;
  summaries: Map<string, SwingMovement["summaries"][number]>; baselines: Map<string, { activity: number; frequency: number; count: number }>; lastBaselineAt: number };
const LIMITATION = "Observed OANDA quote-price behavior only; not traded volume or complete global order flow. Buffers and session baselines restart with the process.";

/** Extends existing nanosecond timestamp handling; bounded quote storage, no AI or broker writes. */
export class SwingMovementEngine {
  private pairs = new Map<string, Pair>();
  private connection = "waiting";
  private heartbeats = 0;
  constructor(private settings: SwingSettings) {}
  private pair(instrument: string) {
    let p = this.pairs.get(instrument);
    if (!p) { p = { samples: [], watermark: null, gaps: 0, rejected: 0, reason: "Waiting for actual OANDA observations.", summaries: new Map(), baselines: new Map(), lastBaselineAt: 0 }; this.pairs.set(instrument, p); }
    return p;
  }
  setConnection(state: string, source = "oanda") {
    const next = source === "oanda" ? state : "unavailable";
    if (next !== this.connection) this.breakContinuity(`Stream ${next}; continuity restarted.`);
    this.connection = next;
  }
  heartbeat() { this.heartbeats++; }
  continuity(instrument: string) { return this.pairs.get(instrument)?.gaps ?? 0; }
  currentQuote(instrument: string, now = Date.now()) {
    const last = this.pairs.get(instrument)?.samples.at(-1);
    return this.connection === "connected" && last && now - last.received <= this.settings.quoteMaxAgeMs
      ? { bid: last.bid, ask: last.ask, time: last.time, tradeable: true, source: "oanda" as const } : null;
  }
  breakContinuity(reason: string) {
    for (const p of this.pairs.values()) { p.samples = []; p.reason = reason; p.gaps++; }
  }
  observe(raw: OandaStreamPrice, receivedAt: string) {
    if (!raw.instrument || !this.settings.instruments.includes(raw.instrument)) return;
    const p = this.pair(raw.instrument), ns = timestampNs(raw.time || ""), received = Date.parse(receivedAt);
    const bid = Number(raw.bids?.[0]?.price ?? raw.closeoutBid), ask = Number(raw.asks?.[0]?.price ?? raw.closeoutAsk);
    const reject = (reason: string) => { p.samples = []; p.rejected++; p.gaps++; p.reason = reason; };
    if (this.connection !== "connected") { reject("Stream disconnected."); return; }
    if (ns === null || !Number.isFinite(received) || ![bid, ask].every(v => Number.isFinite(v) && v > 0) || ask < bid || raw.status?.toLowerCase() !== "tradeable") { reject("Invalid/nontradeable broker quote."); return; }
    const brokerMs = Number(ns / 1000000n);
    if (received - brokerMs > this.settings.quoteMaxAgeMs || brokerMs - received > 1000) { reject("Stale/future quote."); return; }
    if (p.watermark !== null && ns <= p.watermark) {
      if (ns < p.watermark) reject("Out-of-order broker quote.");
      else { const previous = p.samples.at(-1); if (previous && (previous.bid !== bid || previous.ask !== ask)) reject("Conflicting quote at an existing broker timestamp."); }
      return;
    }
    const previous = p.samples.at(-1);
    if (previous && (received < previous.received || received - previous.received > this.settings.gapMs || Number(ns - previous.ns) / 1e6 > this.settings.gapMs)) { reject("Quote gap; silence is not inactivity."); }
    const sample: Sample = { ns, time: raw.time!, received, bid, ask, mid: (bid + ask) / 2 };
    const continuousPrevious = p.samples.at(-1);
    const pip = pipSizeFor(raw.instrument), move = continuousPrevious ? (sample.mid - continuousPrevious.mid) / pip : 0;
    p.samples.push(sample); p.watermark = ns; p.reason = null;
    const cutoff = ns - BigInt(Math.max(...this.settings.windows) * 1e9);
    while (p.samples.length > this.settings.maxSamples || p.samples[0]?.ns < cutoff) p.samples.shift();
    for (const [tf, hours] of [["H1", 1], ["H4", 4]] as const) {
      const bucket = new Date(Math.floor(brokerMs / (hours * 3600000)) * hours * 3600000).toISOString(), key = `${tf}:${bucket}`;
      let aggregate = p.summaries.get(key);
      if (!aggregate) { aggregate = { timeframe: tf, bucket, firstBrokerTime: sample.time, lastBrokerTime: sample.time, upCount: 0, downCount: 0, upPips: 0, downPips: 0, netPips: 0, resets: p.gaps }; p.summaries.set(key, aggregate); }
      // A movement crossing a bucket boundary is excluded, rather than assigning
      // an earlier candle's path to the new one. H4 buckets are UTC observations,
      // not a reconstruction of broker-aligned completed H4 OHLC candles.
      if (continuousPrevious && Math.floor(Number(continuousPrevious.ns / 1000000n) / (hours * 3600000)) === Math.floor(brokerMs / (hours * 3600000))) {
        aggregate.upCount += Number(move > 0); aggregate.downCount += Number(move < 0);
        aggregate.upPips += Math.max(0, move); aggregate.downPips += Math.max(0, -move); aggregate.netPips += move;
      }
      aggregate.lastBrokerTime = sample.time;
    }
    while (p.summaries.size > 32) p.summaries.delete(p.summaries.keys().next().value!);
  }
  snapshot(instrument: string, zone: Pick<SwingZone, "lower" | "upper"> | null = null, atr = 0, now = Date.now(), since?: number): SwingMovement {
    const p = this.pair(instrument), last = p.samples.at(-1), pip = pipSizeFor(instrument);
    const stale = !last || now - last.received > this.settings.quoteMaxAgeMs;
    const windows = this.settings.windows.map(seconds => this.measure(p.samples.filter(s => last && Number(last.ns - s.ns) / 1e9 <= seconds && (since === undefined || Number(s.ns / 1000000n) >= since)), seconds, pip, zone, !stale));
    const session = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric" }).format(new Date(now));
    const baseline = p.baselines.get(session), primary = windows.find(w => w.seconds === 60) ?? windows[0];
    const activity = primary && primary.coveredSeconds > 0 ? (primary.upPips + primary.downPips) / primary.coveredSeconds : 0;
    const normalization = { atrRatio: primary && atr > 0 ? Math.abs(primary.netPips) * pip / atr : null,
      spreadRatio: primary?.spreadPips != null && atr > 0 ? primary.spreadPips * pip / atr : null,
      sessionActivityRatio: baseline && baseline.count >= 10 && baseline.activity > 0 ? activity / baseline.activity : null,
      quoteFrequencyRatio: baseline && baseline.count >= 10 && baseline.frequency > 0 && primary ? primary.observedQuotesPerSecond / baseline.frequency : null };
    if (!zone && primary?.ready && now - p.lastBaselineAt >= 60000) {
      const count = baseline?.count ?? 0, weight = 1 / Math.min(count + 1, 120);
      p.baselines.set(session, { activity: (baseline?.activity ?? 0) * (1 - weight) + activity * weight,
        frequency: (baseline?.frequency ?? 0) * (1 - weight) + primary.observedQuotesPerSecond * weight, count: count + 1 });
      p.lastBaselineAt = now;
    }
    return { instrument, asOf: new Date(now).toISOString(), lastBrokerTime: last?.time ?? null, connection: this.connection,
      state: this.connection !== "connected" ? "DISCONNECTED" : stale ? "STALE" : primary?.ready ? "READY" : "WARMING",
      reason: stale ? p.reason ?? "Fresh quotes have stopped; no pressure inference is available." : p.reason,
      gaps: p.gaps, rejected: p.rejected, heartbeats: this.heartbeats, windows, summaries: [...p.summaries.values()], normalization, limitation: LIMITATION };
  }
  private measure(samples: Sample[], seconds: number, pip: number, zone: Pick<SwingZone, "lower" | "upper"> | null, fresh: boolean): SwingMovementWindow {
    const first = samples[0], last = samples.at(-1), elapsed = first && last ? Number(last.ns - first.ns) / 1e9 : 0;
    const measured = samples.length ? measureObservedQuoteMovement(samples.map(s => ({ time: s.ns, received: BigInt(s.received) * 1000000n,
      brokerTime: s.time, receivedAt: new Date(s.received).toISOString(), bid: s.bid, ask: s.ask, mid: s.mid })), pip, seconds) : null;
    const upCount = measured?.transitions.up ?? 0, downCount = measured?.transitions.down ?? 0, unchangedCount = measured?.transitions.unchanged ?? 0;
    const net = measured?.netPips ?? 0, path = measured?.pathPips ?? 0, upPips = Math.max(0, (path + net) / 2), downPips = Math.max(0, (path - net) / 2);
    let directionChanges = 0, consecutiveUp = 0, consecutiveDown = 0;
    let direction = 0, high = first?.mid ?? 0, low = first?.mid ?? 0, above = 0, below = 0, inside = 0, failedHigh = 0, failedLow = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], move = (b.mid - a.mid) / pip, sign = Math.sign(move), dt = Number(b.ns - a.ns) / 1e9;
      if (sign > 0) { consecutiveUp++; consecutiveDown = 0; }
      else if (sign < 0) { consecutiveDown++; consecutiveUp = 0; }
      if (sign && direction && sign !== direction) directionChanges++;
      if (sign) direction = sign;
      if (a.mid >= high && b.mid < a.mid) failedHigh++;
      if (a.mid <= low && b.mid > a.mid) failedLow++;
      high = Math.max(high, b.mid); low = Math.min(low, b.mid);
      if (zone) { if (a.mid > zone.upper) above += dt; else if (a.mid < zone.lower) below += dt; else inside += dt; }
    }
    const ready = fresh && samples.length >= this.settings.minSamples && elapsed >= seconds * this.settings.coverage;
    return { seconds, samples: samples.length, coveredSeconds: elapsed, ready, upCount, downCount, unchangedCount, upPips, downPips, netPips: net,
      efficiency: measured?.directionalEfficiency ?? 0, velocity: ready ? measured?.velocityPipsPerSecond ?? null : null,
      acceleration: ready ? measured?.accelerationPipsPerSecondSquared ?? null : null,
      consecutiveUp, consecutiveDown, directionChanges, high: first ? high : null, low: first ? low : null,
      pullbackPips: last ? (high - last.mid) / pip : 0, recoveryPips: last ? (last.mid - low) / pip : 0,
      failedHighExtensions: failedHigh, failedLowExtensions: failedLow, spreadPips: last ? (last.ask - last.bid) / pip : null,
      maxSpreadPips: samples.length ? Math.max(...samples.map(s => (s.ask - s.bid) / pip)) : null,
      observedQuotesPerSecond: elapsed > 0 ? (samples.length - 1) / elapsed : 0, aboveZoneSeconds: above, belowZoneSeconds: below, insideZoneSeconds: inside };
  }
}
