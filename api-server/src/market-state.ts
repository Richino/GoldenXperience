import type { Candle } from "../../frontend/src/types/forex.js";
import type { EconomicCalendarSnapshot } from "../../frontend/src/lib/oanda/calendar.js";
import type { MarketLean, ObserverRead, ObserverFact } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { MarketPatternEngine } from "./market-patterns.js";

export const MARKET_STATE_VERSION = "market-observer@1";
export function candleRead(candles: Candle[], pip: number) {
  const bars = candles.filter(c => c.complete).slice(-20);
  if (bars.length < 20) return null;
  let path = 0;
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  const net = bars.at(-1)!.close - bars[0].close;
  const atr = bars.slice(-14).reduce((sum, c, i, tail) => sum + Math.max(c.high - c.low, i ? Math.abs(c.high - tail[i - 1].close) : 0, i ? Math.abs(c.low - tail[i - 1].close) : 0), 0) / 14;
  const efficiency = path ? Math.abs(net) / path : 0;
  const direction: MarketLean = Math.abs(net) >= Math.max(pip, atr * 0.5) && efficiency >= 0.3 ? net > 0 ? "up" : "down" : "range";
  return { direction, netPips: net / pip, atrPips: atr / pip, efficiency, last: bars.at(-1)! };
}

/** Engineering thresholds describe observations; they are not calibrated trade probabilities. */
export class MarketStateEngine {
  private calendar: { data: EconomicCalendarSnapshot; at: string } | null = null;
  private states = new Map<string, { read: ObserverRead; signature: string; candidate: MarketLean; since: number }>();
  constructor(readonly patterns: MarketPatternEngine) {}
  calendarContext(data: Record<string, unknown>, at: string) {
    const value = data.snapshot as EconomicCalendarSnapshot | undefined;
    if (value?.connected && value.source === "forex_factory" && Array.isArray(value.events)
      && [...value.events, ...(value.recentEvents ?? [])].every(e => typeof e.currency === "string" && typeof e.title === "string" && Number.isFinite(e.impact) && Number.isFinite(Date.parse(e.timestamp)))) this.calendar = { data: structuredClone(value), at };
    else this.calendar = null;
  }
  contextError(data: Record<string, unknown>) { if (data.context === "calendar" || data.context === "snapshot") this.calendar = null; }
  update(instrument: string, asOf = new Date().toISOString()): ObserverRead {
    const now = Date.parse(asOf), snapshot = this.patterns.snapshot(instrument, asOf), movement = snapshot.movement;
    const pip = pipSizeFor(instrument), facts: ObserverFact[] = [], blockers: string[] = [];
    const add = (id: string, category: ObserverFact["category"], text: string) => facts.push({ id, category, text });
    const windows = movement.windows;
    for (const w of windows) add(`movement-${w.windowSeconds}`, "movement", `${w.windowSeconds}s: ${w.netPips.toFixed(2)} pips net, ${(w.directionalEfficiency * 100).toFixed(0)}% of observed movement retained; ${w.state === "ready" ? "window covered" : "still warming"}.`);
    const structures = ["M15", "H1", "H4"].map(tf => {
      const frame = snapshot.frames.find(f => f.granularity === tf)!;
      const read = frame.dataState === "current" ? candleRead(this.patterns.contextHistory(instrument, tf), pip) : null;
      if (read) add(`structure-${tf}`, "structure", `${tf}: ${read.direction === "range" ? "overlapping movement" : `leaning ${read.direction}`} across the last 20 closed candles (${read.netPips.toFixed(1)} pips net).`);
      return { tf, read };
    });
    const primary = structures.find(s => s.tf === "H1")?.read?.direction ?? "unknown";
    const context = structures.find(s => s.tf === "H4")?.read?.direction ?? "unknown";
    const pressureWindow = windows.find(w => w.windowSeconds === 30 && w.state === "ready");
    const pressure: MarketLean = pressureWindow && pressureWindow.directionalEfficiency >= 0.35 && Math.abs(pressureWindow.netPips) >= 0.5
      && (pressureWindow.direction === "up" || pressureWindow.direction === "down") ? pressureWindow.direction : "range";
    let lean: MarketLean = primary === "unknown" ? "unknown" : primary;
    if ((primary === "up" || primary === "down") && (context === "up" || context === "down") && primary !== context) lean = "conflicting";
    if ((primary === "up" || primary === "down") && pressure !== "range" && primary !== pressure) add("pressure-opposed", "risk", `Short-term quote pressure opposes the ${primary} hourly lean; this can be a pullback or an emerging reversal.`);
    const byFrame = snapshot.frames.map(frame => frame.patterns.filter(p => p.state === "forming" || p.state === "confirmed")
      .sort((a, b) => Number(b.family === "structure") - Number(a.family === "structure") || Date.parse(b.endTime) - Date.parse(a.endTime)).map(p => ({ p, frame })));
    // Reserve two highlights per timeframe so a noisy M1 stream cannot crowd out H1/H4 shapes.
    const active = [...byFrame.flatMap(items => items.slice(0, 2)), ...byFrame.flatMap(items => items.slice(2))].slice(0, 12);
    for (const { p, frame } of active.slice(0, 6)) add(`pattern-${p.id}`, "pattern", `${frame.granularity} ${p.kind.replaceAll("_", " ")}: ${p.state}${frame.dataState === "paused" ? "; context paused" : ""}${p.historicalOnDiscovery ? "; discovered in historical candles" : ""}. A shape alone does not confirm an entry.`);
    if (movement.state === "paused") blockers.push(movement.reason === "nontradeable_quote" ? "Prices are not tradeable. Entry monitoring is paused."
      : movement.reason === "stream_connecting" ? "Connecting to live prices."
      : movement.reason === "stream_error" ? "Live prices are unavailable. Reconnecting automatically."
      : "Fresh price observations are unavailable. Monitoring resumes when the feed recovers.");
    if (!structures.find(s => s.tf === "H1")?.read || !structures.find(s => s.tf === "H4")?.read) blockers.push("Fresh H1 and H4 context is required.");
    if (!snapshot.frames.find(f => f.granularity === "M5" && f.dataState === "current")) blockers.push("Execution candle context is not current.");
    const quote = movement.bid !== null && movement.ask !== null && movement.lastBrokerTime ? { bid: movement.bid, ask: movement.ask, time: movement.lastBrokerTime, spreadPips: (movement.ask - movement.bid) / pip } : null;
    const m1 = candleRead(this.patterns.history(instrument, "M1"), pip);
    if (quote && (quote.spreadPips > 5 || m1 && quote.spreadPips > Math.max(1, m1.atrPips * 0.3))) blockers.push("Spread is wide relative to the observation limits.");
    const calendar = this.calendar;
    if (!calendar || now - Date.parse(calendar.at) > 600_000 || now < Date.parse(calendar.at)
      || !calendar.data.coverageUntil || Date.parse(calendar.data.coverageUntil) < now + 30 * 60_000) blockers.push("News coverage is unknown or stale.");
    else {
      const currencies = instrument.split("_");
      const events = [...calendar.data.events, ...(calendar.data.recentEvents ?? [])].filter(e => currencies.includes(e.currency) && e.impact >= 3 && Date.parse(e.timestamp) >= now - 15 * 60_000 && Date.parse(e.timestamp) <= now + 30 * 60_000);
      for (const e of events.slice(0, 4)) blockers.push(`High-impact ${e.currency} news: ${e.title} (${e.timestamp}).`);
    }
    blockers.forEach((text, i) => add(`risk-${i}`, "risk", text));
    const previous = this.states.get(instrument);
    const since = previous?.candidate === lean ? previous.since : now;
    const candidate = lean;
    // Direction changes persist for three seconds. Feed/quality failures apply immediately.
    if (previous && lean !== previous.read.lean && now - since < 3000) lean = previous.read.lean;
    const state = movement.state === "paused" ? "paused" : movement.state === "warming" ? "warming" : "live";
    const headline = state === "paused" ? "Live analysis paused" : state === "warming" ? "Building a fresh movement window" : lean === "up" ? "Leaning up" : lean === "down" ? "Leaning down" : lean === "range" ? "Range / overlapping movement" : lean === "conflicting" ? "Timeframes disagree" : "Direction is unclear";
    // Geometry revisions on every tick do not create a new meaningful event.
    const signature = JSON.stringify([state, lean, blockers, active.filter(x => !x.p.historicalOnDiscovery).map(x => [x.p.id, x.p.state]).sort()]);
    const changed = signature !== previous?.signature;
    const read: ObserverRead = { version: MARKET_STATE_VERSION, instrument, asOf, state, lean, headline,
      changedAt: changed ? asOf : previous.read.changedAt, revision: (previous?.read.revision ?? 0) + Number(changed), facts, blockers,
      changeConditions: ["The H1 closed-candle movement changes direction or loses its persistence.", "H4 context changes alignment with H1.", "A monitored plan's frozen trigger, invalidation, or expiry is reached."], quote,
      movement: windows.map(w => ({ seconds: w.windowSeconds, netPips: w.netPips, efficiency: w.directionalEfficiency, velocity: w.velocityPipsPerSecond, samples: w.samples, ready: w.state === "ready" })),
      patterns: active.map(({ p, frame }) => ({ id: p.id, kind: p.kind, timeframe: frame.granularity, state: p.state, direction: p.confirmedDirection ?? p.direction, at: p.updatedAt, historical: p.historicalOnDiscovery })),
      ai: changed ? { state: "disabled", text: null, at: null, factIds: [] } : previous.read.ai };
    this.states.set(instrument, { read, signature, candidate, since });
    return structuredClone(read);
  }
  attachExplanation(instrument: string, revision: number, ai: ObserverRead["ai"]) {
    const state = this.states.get(instrument);
    if (state?.read.revision === revision) state.read.ai = ai;
  }
}
