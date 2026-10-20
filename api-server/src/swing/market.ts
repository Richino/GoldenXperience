import { getCandles, getPricing } from "../../../frontend/src/lib/oanda/client.js";
import { getAllCalendarEvents, getMarketSelectionCalendar } from "../../../frontend/src/lib/calendar/forex-factory.js";
import { currenciesOf, pipSizeFor, precisionFor } from "../../../frontend/src/lib/instruments/catalog.js";
import { normalizeCandles, checkCandleFreshness } from "../../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { readTrend } from "../../../frontend/src/lib/strategy/analyze-v2/structure.js";
import { buildZones } from "../../../frontend/src/lib/strategy/analyze-v2/zones.js";
import { getForexSessionStatus } from "../../../frontend/src/lib/strategy/session.js";
import type { Candle } from "../../../frontend/src/types/forex.js";
import type { SwingFrame, SwingFrameRead, SwingMarket, SwingControl } from "../../../frontend/src/lib/swing-intelligence.js";
import type { SwingSettings } from "./config.js";
import { buildCalendarSnapshot, surpriseOf } from "../intelligence/calendar-snapshot.js";
import { observedReleaseReactions } from "../intelligence/market-state-interpreter.js";

export const SWING_FRAMES: SwingFrame[] = ["D1", "H4", "H1", "M15"];
export type SwingData = { market: SwingMarket; candles: Record<SwingFrame, Candle[]> };
export function structuralControl(direction: string, sufficient: boolean): SwingControl {
  return !sufficient ? "INSUFFICIENT_DATA" : direction === "UPTREND" ? "BUYERS_DOMINANT" : direction === "DOWNTREND" ? "SELLERS_DOMINANT" : "CONTESTED";
}
export async function loadSwingMarket(instrument: string, settings: SwingSettings): Promise<SwingData> {
  const results = await Promise.allSettled(SWING_FRAMES.map(tf => getCandles(instrument, tf === "D1" ? "D" : tf, 240, { signal: AbortSignal.timeout(20000) })));
  const issues: string[] = [], candles = {} as Record<SwingFrame, Candle[]>, frames = {} as Record<SwingFrame, SwingFrameRead>;
  const now = Date.now();
  const trends = SWING_FRAMES.map((tf, i) => {
    const result = results[i];
    const source = result.status === "fulfilled" && result.value.status.state === "connected" && result.value.data.source === "oanda" ? result.value.data.candles : [];
    if (!source.length) issues.push(`${tf}: OANDA candle history unavailable.`);
    const valid = source.filter(c => [c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && Date.parse(c.time) <= now);
    if (valid.length !== source.length) issues.push(`${tf}: invalid/future candles rejected.`);
    const normalized = normalizeCandles(valid, tf);
    candles[tf] = normalized.closed.filter(c => c.complete === true);
    const freshness = checkCandleFreshness(tf, candles[tf], tf, now, 1);
    if (["FAIL", "UNKNOWN"].includes(freshness.status)) issues.push(`${tf}: ${freshness.reason}`);
    if (normalized.missing) issues.push(`${tf}: ${normalized.missing} missing open-market candles.`);
    const trend = readTrend(instrument, tf, candles[tf], settings.structure.regime);
    if (!trend.sufficient) issues.push(`${tf}: confirmed swing structure is insufficient.`);
    const recent = candles[tf].slice(-12), first = recent[0], last = recent.at(-1), atr = trend.atr;
    const net = first && last ? last.close - first.open : 0;
    const path = recent.reduce((sum, c, j) => sum + Math.abs(c.close - (j ? recent[j - 1].close : c.open)), 0);
    const previous = recent.slice(0, 6).reduce((s, c) => s + c.close - c.open, 0), current = recent.slice(-6).reduce((s, c) => s + c.close - c.open, 0);
    const span = recent.length ? Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low)) : 0;
    const recentRange = recent.slice(-6).reduce((s, c) => s + c.high - c.low, 0) / Math.max(1, recent.slice(-6).length);
    frames[tf] = { timeframe: tf, condition: trend.direction, control: structuralControl(trend.direction, trend.sufficient), sufficient: trend.sufficient,
      atr, lastClosedOpenTime: last?.time ?? null, formingOpenTime: normalized.forming?.time ?? null, evidence: trend.evidence,
      highs: trend.raw.swings.filter(s => s.type === "high").map(s => ({ price: s.price, time: s.time, confirmedAt: s.confirmedAt })),
      lows: trend.raw.swings.filter(s => s.type === "low").map(s => ({ price: s.price, time: s.time, confirmedAt: s.confirmedAt })),
      momentum: { displacementAtr: atr > 0 ? net / atr : 0, efficiency: path > 0 ? Math.abs(net) / path : 0,
        bodyStrength: recent.length ? recent.reduce((s, c) => s + (c.high > c.low ? Math.abs(c.close - c.open) / (c.high - c.low) : 0), 0) / recent.length : 0,
        closePosition: last && last.high > last.low ? (last.close - last.low) / (last.high - last.low) : 0.5,
        persistence: recent.length ? recent.reduce((s, c) => s + Math.sign(c.close - c.open), 0) / recent.length : 0,
        accelerationAtr: atr > 0 ? (current - previous) / atr : 0,
        recoveryPercent: last && span > 0 ? (last.close - Math.min(...recent.map(c => c.low))) / span * 100 : null,
        volatilityRatio: atr > 0 ? recentRange / atr : null } };
    return trend;
  });
  const [pricing, verified, actuals] = await Promise.allSettled([getPricing([instrument], { signal: AbortSignal.timeout(15000) }), getMarketSelectionCalendar(), getAllCalendarEvents()]);
  const q = pricing.status === "fulfilled" && pricing.value.status.state === "connected" ? pricing.value.data.find(p => p.instrument === instrument && p.source === "oanda") : null;
  const quote = q && Number.isFinite(Date.parse(q.time)) && [q.bid, q.ask].every(p => Number.isFinite(p) && p > 0) && q.ask >= q.bid ? { bid: q.bid, ask: q.ask, time: q.time, tradeable: q.status.toLowerCase() === "tradeable", source: "oanda" as const } : null;
  const captured = Date.now(), session = getForexSessionStatus(new Date(captured));
  if (!quote || !quote.tradeable || captured - Date.parse(quote.time) > settings.quoteMaxAgeMs || Date.parse(quote.time) > captured + 1000) issues.push("A fresh executable OANDA quote is unavailable.");
  const { base, quote: counter } = currenciesOf(instrument);
  const calendarAvailable = verified.status === "fulfilled" && actuals.status === "fulfilled";
  const releaseCalendar = buildCalendarSnapshot({ events: actuals.status === "fulfilled" ? actuals.value : null, currencies: [base, counter], now: captured });
  const reactions = observedReleaseReactions(releaseCalendar, candles.H1, captured);
  if (!calendarAvailable) issues.push("Verified current economic calendar is unavailable.");
  const price = quote ? (quote.bid + quote.ask) / 2 : candles.H4.at(-1)?.close;
  const zones = price && trends[1].sufficient && trends[0].sufficient ? buildZones({ primary: { timeframe: "H4", candles: candles.H4 }, higher: { timeframe: "D1", candles: candles.D1, trend: trends[0] }, trend: trends[1], price, config: settings.structure }) : [];
  const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(new Date(captured));
  const hour = Number(ny.find(p => p.type === "hour")?.value), minute = Number(ny.find(p => p.type === "minute")?.value);
  const rollover = hour === 16 && minute >= 55 || hour === 17 && minute < 10;
  return { candles, market: { instrument, capturedAt: new Date(captured).toISOString(), quote, pipSize: pipSizeFor(instrument), precision: precisionFor(instrument),
    state: !session.marketOpen ? "MARKET_CLOSED" : rollover ? "ROLLOVER" : !quote ? "PROVIDER_ERROR" : issues.some(i => !i.startsWith("M15:")) ? "STALE" : "CURRENT", issues, frames,
    structureZones: zones.filter(z => z.relevance !== "MINOR").map(z => ({ lower: z.low, upper: z.high, type: z.type, relevance: z.relevance, timeframes: z.sources,
      swingReferences: [...frames.H4.highs, ...frames.H4.lows, ...frames.D1.highs, ...frames.D1.lows].filter(s => s.price >= z.low && s.price <= z.high),
      evidence: [`${z.relevance} ${z.type}; ${z.reactions} confirmed pivot reactions (not a strength probability).`, `Built from ${z.sources.join(" / ")} completed candles.`] })),
    calendar: { available: calendarAvailable, fetchedAt: verified.status === "fulfilled" ? verified.value.fetchedAt : null,
      coverageUntil: verified.status === "fulfilled" ? verified.value.coverageUntil : null,
      events: actuals.status === "fulfilled" ? actuals.value.filter(e => [base, counter].includes(e.currency)).map(e => ({ id: e.id, title: e.title, currency: e.currency,
        timestamp: e.timestamp, impact: e.impact, actual: e.actual, forecast: e.forecast, previous: e.previous, revised: null, timingVerified: e.timingVerified === true,
        surprise: surpriseOf(e.actual, e.forecast), reaction: reactions.find(r => r.eventId === `${e.currency}|${e.title}|${new Date(e.timestamp).toISOString()}`) })) : [] } } };
}
