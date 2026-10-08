import type { Candle } from "../../../frontend/src/types/forex.js";
import type { TradabilityInput } from "../../../frontend/src/lib/strategy/ny-tradability.js";
import type { EconomicCalendarEvent } from "../../../frontend/src/lib/oanda/calendar.js";

export const FIXTURE_TIME = new Date("2026-10-07T10:35:00Z"); // 6:35 AM EDT
export function fixtureSeries(end: number, step: number, count: number, start: number, drift: number, wave: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = start + i * drift + wave * Math.sin(i / 5);
    const close = start + (i + 1) * drift + wave * Math.sin((i + 1) / 5);
    return { time: new Date(end - (count - i) * step).toISOString(), open, close, high: Math.max(open, close) + wave / 2, low: Math.min(open, close) - wave / 2, complete: true, volume: 100 };
  });
}
export function fixtureInput(instrument: string, now = FIXTURE_TIME): TradabilityInput {
  const scale = instrument.endsWith("JPY") ? 100 : 1;
  const start = scale === 100 ? 150 : 1.1;
  const ms = now.getTime();
  const m15 = fixtureSeries(Math.floor(ms / 900_000) * 900_000, 900_000, 500, start, .00004 * scale, .0015 * scale);
  const mid = m15.at(-1)!.close - .0002 * scale;
  const h1 = fixtureSeries(Math.floor(ms / 3_600_000) * 3_600_000, 3_600_000, 120, mid - .00015 * 120 * scale, .00015 * scale, .0025 * scale);
  return { instrument, now, m15, h1, quote: { bid: mid - .00003 * scale, ask: mid + .00003 * scale, time: new Date(ms - 1000).toISOString(), tradeable: true }, news: [] };
}
export function fixtureNews(currency: string, minutes: number, now = FIXTURE_TIME): EconomicCalendarEvent {
  return { id: `${currency}-${minutes}`, title: "Synthetic high-impact release", currency, region: "fixture", impact: 3, timestamp: new Date(now.getTime() + minutes * 60_000).toISOString(), actual: null, forecast: null, previous: null, unit: null };
}
