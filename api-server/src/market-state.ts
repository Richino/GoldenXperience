import type { Candle } from "../../frontend/src/types/forex.js";
import type { EconomicCalendarEvent, EconomicCalendarSnapshot } from "../../frontend/src/lib/oanda/calendar.js";
import type { MarketLean, QuotePressure, ObserverRead, ObserverFact } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { MarketPatternEngine } from "./market-patterns.js";
import { observerRuleExplanation } from "./market-observer-explanation.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { marketStory } from "./market-story.js";

export const MARKET_STATE_VERSION = "market-observer@3";
const DIRECTION_PERSISTENCE_MS = 3000;

function validCalendarEvent(value: unknown): value is EconomicCalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as EconomicCalendarEvent;
  return typeof event.currency === "string" && /^[A-Z]{3}$/.test(event.currency)
    && typeof event.title === "string" && event.title.trim().length > 0
    && Number.isInteger(event.impact) && event.impact >= 0 && event.impact <= 3
    && typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp));
}
export function candleRead(candles: Candle[], pip: number) {
  const bars = candles.filter(c => c.complete).slice(-20);
  if (bars.length < 20) return null;
  let path = 0;
  for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  const net = bars.at(-1)!.close - bars[0].close;
  const atr = bars.slice(-14).reduce((sum, c, i) => {
    const previous = bars[bars.length - 14 + i - 1];
    return sum + Math.max(c.high - c.low, Math.abs(c.high - previous.close), Math.abs(c.low - previous.close));
  }, 0) / 14;
  const efficiency = path ? Math.abs(net) / path : 0;
  const direction: MarketLean = Math.abs(net) >= Math.max(pip, atr * 0.5) && efficiency >= 0.3 ? net > 0 ? "up" : "down" : "range";
  return { direction, netPips: net / pip, atrPips: atr / pip, efficiency, last: bars.at(-1)! };
}

/** Engineering thresholds describe observations; they are not calibrated trade probabilities. */
export class MarketStateEngine {
  private calendar: { data: EconomicCalendarSnapshot; at: string } | null = null;
  private states = new Map<string, { read: ObserverRead; signature: string; candidate: MarketLean; since: number; pressureCandidate: QuotePressure; pressureSince: number }>();
  constructor(readonly patterns: MarketPatternEngine) {}
  calendarContext(data: Record<string, unknown>, at: string) {
    const value = data.snapshot as EconomicCalendarSnapshot | undefined;
    if (value?.connected === true && value.source === "forex_factory" && Array.isArray(value.events)
      && (value.recentEvents === undefined || Array.isArray(value.recentEvents))
      && Number.isFinite(Date.parse(at)) && typeof value.coverageUntil === "string" && Number.isFinite(Date.parse(value.coverageUntil))
      && Date.parse(value.coverageUntil) >= Date.parse(at)
      && [...value.events, ...(value.recentEvents ?? [])].every(validCalendarEvent)) this.calendar = { data: structuredClone(value), at };
    else this.calendar = null;
  }
  contextError(data: Record<string, unknown>) { if (data.context === "calendar" || data.context === "snapshot") this.calendar = null; }
  update(instrument: string, asOf = new Date().toISOString()): ObserverRead {
    const now = Date.parse(asOf), snapshot = this.patterns.snapshot(instrument, asOf), movement = snapshot.movement;
    const marketOpen = getForexSessionStatus(new Date(now)).marketOpen;
    const pip = pipSizeFor(instrument), facts: ObserverFact[] = [], blockers: string[] = [];
    const add = (id: string, category: ObserverFact["category"], text: string) => facts.push({ id, category, text });
    const windows = movement.windows;
    for (const w of windows) add(`movement-${w.windowSeconds}`, "movement", `${w.windowSeconds}s: ${w.netPips.toFixed(2)} pips net, ${(w.directionalEfficiency * 100).toFixed(0)}% of observed movement retained; ${w.state === "ready" ? "window covered" : "still warming"}.`);
    const structures = ["M15", "H1", "H4"].map(tf => {
      const frame = snapshot.frames.find(f => f.granularity === tf)!;
      const read = frame.contextDataState === "current" ? candleRead(this.patterns.contextHistory(instrument, tf), pip) : null;
      if (read) add(`structure-${tf}`, "structure", `${tf}: ${read.direction === "range" ? "overlapping movement" : `leaning ${read.direction}`} across the last 20 closed candles (${read.netPips.toFixed(1)} pips net).`);
      return { tf, read };
    });
    const primary = structures.find(s => s.tf === "H1")?.read?.direction ?? "unknown";
    const story = marketStory(instrument, Object.fromEntries(["H4", "H1", "M15"].map(tf => [tf,
      snapshot.frames.find(f => f.granularity === tf)?.contextDataState === "current" ? this.patterns.contextHistory(instrument, tf) : []])), asOf);
    add("story-broader", "structure", story.broader.summary);
    add("story-recent", "pattern", story.recent.summary);
    add("story-current", "structure", story.current.summary);
    const context = structures.find(s => s.tf === "H4")?.read?.direction ?? "unknown";
    const pressureWindow = windows.find(w => w.windowSeconds === 30 && w.state === "ready");
    const observedPressure: QuotePressure = !pressureWindow ? "unknown" : pressureWindow.directionalEfficiency >= 0.35 && Math.abs(pressureWindow.netPips) >= 0.5
      && (pressureWindow.direction === "up" || pressureWindow.direction === "down") ? pressureWindow.direction : "range";
    const previous = this.states.get(instrument);
    const pressureSince = previous?.pressureCandidate === observedPressure ? previous.pressureSince : now;
    let pressure = observedPressure;
    // A lost window becomes unknown immediately; directional changes must persist.
    if (previous && pressure !== "unknown" && pressure !== previous.read.pressure.direction && now - pressureSince < DIRECTION_PERSISTENCE_MS) pressure = previous.read.pressure.direction;
    const pressurePending = pressure !== observedPressure;
    const pressureRelation = pressure === "unknown" || primary === "unknown" ? "unknown"
      : pressure === "range" || primary === "range" ? "neutral" : primary === pressure ? "aligned" : "opposed";
    add("quote-pressure", "movement", pressure === "unknown"
      ? pressureWindow ? "30s quote pressure is being checked for persistence." : movement.state === "paused" ? "30s quote pressure is unavailable until fresh price observations return." : "30s quote pressure is not known yet; the observation window is still warming."
      : `30s quote pressure: ${pressure === "range" ? "no persistent direction" : `leaning ${pressure}`}${pressureRelation === "aligned" ? "; aligned with H1" : pressureRelation === "opposed" ? "; opposing H1" : ""}.${pressurePending ? " A possible change is being checked for persistence." : ""}`);
    let lean: MarketLean = primary === "unknown" ? "unknown" : primary;
    if ((primary === "up" || primary === "down") && (context === "up" || context === "down") && primary !== context) lean = "conflicting";
    if (movement.connection !== "connected") lean = "unknown";
    if (pressureRelation === "opposed") add("pressure-opposed", "risk", `Short-term quote pressure opposes the ${primary} hourly lean; this can be a pullback or an emerging reversal.`);
    const byFrame = snapshot.frames.map(frame => frame.patterns.filter(p => p.state === "forming" || p.state === "confirmed")
      .sort((a, b) => Number(b.family === "structure") - Number(a.family === "structure") || Date.parse(b.endTime) - Date.parse(a.endTime)).map(p => ({ p, frame })));
    // Reserve two highlights per timeframe so a noisy M1 stream cannot crowd out H1/H4 shapes.
    const active = [...byFrame.flatMap(items => items.slice(0, 2)), ...byFrame.flatMap(items => items.slice(2))].slice(0, 12);
    for (const { p, frame } of active.slice(0, 6)) add(`pattern-${p.id}`, "pattern", `${frame.granularity} ${p.kind.replaceAll("_", " ")}: ${p.state}${frame.dataState !== "current" ? `; context ${frame.dataState}` : ""}${p.historicalOnDiscovery ? "; discovered in historical candles" : ""}. A shape alone does not confirm an entry.`);
    if (!marketOpen) blockers.push("Forex market closed. Live analysis resumes after reopening with fresh prices.");
    else if (movement.state === "paused") blockers.push(movement.reason === "nontradeable_quote" ? "Prices are not tradeable. Entry monitoring is paused."
      : movement.reason === "stream_connecting" ? "Connecting to live prices."
      : movement.reason === "stream_error" ? "Live prices are unavailable. Reconnecting automatically."
      : movement.reason === "stale_quote" ? "The latest quote is stale. Entry monitoring waits for fresh prices."
      : "Fresh price observations are unavailable. Monitoring resumes when the feed recovers.");
    if (movement.state !== "paused" && !pressureWindow) blockers.push("The 30-second pressure window is still warming. Entry monitoring resumes when it is covered.");
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
    const since = previous?.candidate === lean ? previous.since : now;
    const candidate = lean;
    // Direction changes persist for three seconds. Feed/quality failures apply immediately.
    if (previous && lean !== "unknown" && lean !== previous.read.lean && now - since < DIRECTION_PERSISTENCE_MS) lean = previous.read.lean;
    // Analysis of fresh closed candles does not require a covered tick window.
    // A quiet connected feed can retain that analysis, but provides no executable
    // quote and cannot trigger entries. Actual connection/quote failures pause it.
    const candleAnalysisAvailable = movement.connection === "connected" && movement.reason === "stale_quote"
      && structures.some(s => s.tf === "H1" && s.read) && structures.some(s => s.tf === "H4" && s.read);
    const state = !marketOpen || movement.state === "paused" && !candleAnalysisAvailable ? "paused" : "live";
    const headline = !marketOpen ? "Market closed" : state === "paused" ? "Live analysis paused" : lean === "up" ? "Leaning up" : lean === "down" ? "Leaning down" : lean === "range" ? "Range / overlapping movement" : lean === "conflicting" ? "Timeframes disagree" : "Direction is unclear";
    // Geometry revisions on every tick do not create a new meaningful event.
    const signature = JSON.stringify([state, lean, pressure, blockers, story, active.filter(x => !x.p.historicalOnDiscovery).map(x => [x.p.id, x.p.state, x.frame.dataState]).sort()]);
    const changed = signature !== previous?.signature;
    const read: ObserverRead = { version: MARKET_STATE_VERSION, instrument, asOf, state, lean, headline,
      changedAt: changed ? asOf : previous.read.changedAt, revision: (previous?.read.revision ?? 0) + Number(changed), facts, blockers, story,
      changeConditions: ["The H1 closed-candle movement changes direction or loses its persistence.", "H4 context changes alignment with H1.", "The 30-second quote pressure changes direction and persists for three seconds.", "Price, candle, news or spread checks lose or regain valid coverage.", "A monitored plan's frozen trigger, invalidation, or expiry is reached."], quote,
      pressure: { direction: pressure, observedDirection: observedPressure, covered: Boolean(pressureWindow), pending: pressurePending, relation: pressureRelation },
      movement: windows.map(w => ({ seconds: w.windowSeconds, netPips: w.netPips, efficiency: w.directionalEfficiency, velocity: w.velocityPipsPerSecond, samples: w.samples, ready: w.state === "ready" })),
      patterns: active.map(({ p, frame }) => ({ id: p.id, kind: p.kind, timeframe: frame.granularity, state: p.state, direction: p.confirmedDirection ?? p.direction, at: p.updatedAt, historical: p.historicalOnDiscovery, contextState: frame.dataState === "current" ? "current" as const : "paused" as const })),
      ai: changed ? { state: "disabled", text: null, at: null, factIds: [] } : previous.read.ai };
    if (changed || read.ai.source === "rules") read.ai = observerRuleExplanation(read, read.ai.state);
    this.states.set(instrument, { read, signature, candidate, since, pressureCandidate: observedPressure, pressureSince });
    return structuredClone(read);
  }
  attachExplanation(instrument: string, revision: number, ai: ObserverRead["ai"]) {
    const state = this.states.get(instrument);
    if (state?.read.revision === revision) state.read.ai = ai;
  }
}
