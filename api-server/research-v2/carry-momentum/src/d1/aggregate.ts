import { loadCandles, loadQuotes, alignQuotes } from "../../../src/data.js";
import type { Currency } from "../types.js";

export type D1Bar = {
  date: string; // YYYY-MM-DD UTC
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bidClose: number | null;
  askClose: number | null;
};

export type D1Panel = {
  instrument: string;
  bars: D1Bar[];
  dateIndex: Map<string, number>;
};

/** Aggregate H1 OANDA candles/quotes into UTC calendar-day D1 bars (last H1 bar of day = close). */
export async function loadD1Panel(instrument: string, minBars = 200): Promise<D1Panel | null> {
  const [candles, quotes] = await Promise.all([loadCandles(instrument, "H1"), loadQuotes(instrument, "H1")]);
  if (candles.length < minBars) return null;
  const aligned = alignQuotes(candles, quotes);

  const byDay = new Map<string, typeof aligned>();
  for (const c of aligned) {
    const day = c.closeTime.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(c);
    byDay.set(day, arr);
  }

  const bars: D1Bar[] = [];
  for (const day of [...byDay.keys()].sort()) {
    const dayBars = byDay.get(day)!;
    const last = dayBars[dayBars.length - 1]!;
    const first = dayBars[0]!;
    let high = -Infinity;
    let low = Infinity;
    for (const b of dayBars) {
      high = Math.max(high, b.high);
      low = Math.min(low, b.low);
    }
    bars.push({
      date: day,
      closeTime: last.closeTime,
      open: first.open,
      high,
      low,
      close: last.close,
      bidClose: last.quote?.bidClose ?? null,
      askClose: last.quote?.askClose ?? null,
    });
  }

  const dateIndex = new Map(bars.map((b, i) => [b.date, i]));
  return { instrument, bars, dateIndex };
}

export function splitPair(instrument: string): { base: Currency; quote: Currency } {
  const [b, q] = instrument.split("_");
  return { base: b as Currency, quote: q as Currency };
}

/** Shared D1 timeline = intersection of dates across panels. */
export function sharedDates(panels: Map<string, D1Panel>): string[] {
  let dates: string[] | null = null;
  for (const p of panels.values()) {
    const d = p.bars.map((b) => b.date);
    dates = dates == null ? d : dates.filter((x) => p.dateIndex.has(x));
  }
  return dates ?? [];
}
