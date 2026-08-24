import type { Candle, Quote } from "./types.js";
import { getDb } from "./env.js";

const PIP_FALLBACK: Record<string, number> = {
  USD_JPY: 0.01,
  EUR_JPY: 0.01,
  GBP_JPY: 0.01,
  AUD_JPY: 0.01,
};

export function pipSizeFor(instrument: string): number {
  return PIP_FALLBACK[instrument] ?? 0.0001;
}

export async function inventoryCounts(): Promise<Array<{ instrument: string; timeframe: string; n: number; min_t: string; max_t: string }>> {
  const { query } = await getDb();
  const res = await query<{ instrument: string; timeframe: string; n: string; min_t: Date; max_t: Date }>(
    `SELECT instrument, timeframe, count(*)::text AS n,
            min(close_time) AS min_t, max(close_time) AS max_t
       FROM market_candles
      WHERE source='oanda'
      GROUP BY 1,2
      ORDER BY 1,2`,
  );
  return res.rows.map((r) => ({
    instrument: r.instrument,
    timeframe: r.timeframe,
    n: Number(r.n),
    min_t: new Date(r.min_t).toISOString(),
    max_t: new Date(r.max_t).toISOString(),
  }));
}

export async function loadCandles(instrument: string, timeframe: string): Promise<Candle[]> {
  const { query } = await getDb();
  const res = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
       FROM market_candles
      WHERE instrument=$1 AND timeframe=$2 AND source='oanda'
      ORDER BY close_time`,
    [instrument, timeframe],
  );
  return res.rows.map((r) => ({
    closeTime: new Date(r.close_time as string | Date).toISOString(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume ?? 0),
  }));
}

export async function loadQuotes(instrument: string, timeframe: string): Promise<Quote[]> {
  const { query } = await getDb();
  const res = await query<Record<string, unknown>>(
    `SELECT close_time,
            bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes
      WHERE instrument=$1 AND timeframe=$2 AND source='oanda'
      ORDER BY close_time`,
    [instrument, timeframe],
  );
  return res.rows.map((r) => ({
    closeTime: new Date(r.close_time as string | Date).toISOString(),
    bidOpen: Number(r.bid_open),
    bidHigh: Number(r.bid_high),
    bidLow: Number(r.bid_low),
    bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open),
    askHigh: Number(r.ask_high),
    askLow: Number(r.ask_low),
    askClose: Number(r.ask_close),
  }));
}

export function alignQuotes(candles: Candle[], quotes: Quote[]): Array<Candle & { quote: Quote | null }> {
  const byTime = new Map(quotes.map((q) => [q.closeTime, q]));
  return candles.map((c) => ({ ...c, quote: byTime.get(c.closeTime) ?? null }));
}
