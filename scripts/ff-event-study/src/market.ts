/**
 * Turns an event timestamp into the market context the study asks for:
 *   - USD trend and 2y/10y yield drift in the window BEFORE the release
 *   - the event currency's own price reaction AFTER the release (+15/30/60m)
 *
 * All numbers come from OANDA M1 mid candles. Yields are bond-PRICE contracts,
 * so a rising price means a FALLING yield; the sign is labelled, never hidden.
 */
import { getCandles, type Candle } from "./oanda.js";
import {
  PRE_WINDOW_MIN,
  POST_WINDOWS_MIN,
  REACTION_PAIR,
  USD_TREND,
  YIELD_INSTRUMENTS,
  pipSize,
  type ReactionPair,
} from "./config.js";

export interface MarketContext {
  /** Instruments actually available for this event (missing = OANDA gap). */
  reactionInstrument: string | null;
  before: {
    usdTrendPct: number | null;
    us2yPriceChange: number | null;
    us2yImpliedYieldDir: "up" | "down" | "flat" | null;
    us10yPriceChange: number | null;
    us10yImpliedYieldDir: "up" | "down" | "flat" | null;
  };
  /** Keyed by horizon minutes: e.g. reaction["15"]. */
  reaction: Record<string, { pips: number; pct: number } | null>;
}

/** Nearest candle at or before `t` within `toleranceMin`. */
function candleAtOrBefore(candles: Candle[], t: number, toleranceMin = 5): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    const ct = new Date(c.time).getTime();
    if (ct <= t) {
      if (!best || ct > new Date(best.time).getTime()) best = c;
    }
  }
  if (!best) return null;
  if (t - new Date(best.time).getTime() > toleranceMin * 60_000) return null;
  return best;
}

/** First candle at or after `t` within tolerance. */
function candleAtOrAfter(candles: Candle[], t: number, toleranceMin = 5): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    const ct = new Date(c.time).getTime();
    if (ct >= t) {
      if (!best || ct < new Date(best.time).getTime()) best = c;
    }
  }
  if (!best) return null;
  if (new Date(best.time).getTime() - t > toleranceMin * 60_000) return null;
  return best;
}

/** Signed move on `pair`, expressed from the EVENT currency's perspective. */
function moveForCurrency(
  pair: ReactionPair,
  fromPrice: number,
  toPrice: number,
): { pips: number; pct: number } {
  const rawPct = ((toPrice - fromPrice) / fromPrice) * 100;
  const rawPips = (toPrice - fromPrice) / pipSize(pair.instrument);
  // If the event currency is the quote side, a higher price = weaker currency.
  const sign = pair.currencyIsQuote ? -1 : 1;
  return { pips: sign * rawPips, pct: sign * rawPct };
}

const maxPost = Math.max(...POST_WINDOWS_MIN);

export async function marketContext(
  currency: string,
  timestampMs: number,
): Promise<MarketContext> {
  const event = timestampMs;
  const from = new Date(event - (PRE_WINDOW_MIN + 5) * 60_000);
  const to = new Date(event + (maxPost + 5) * 60_000);

  // --- yields (before) ---
  const before: MarketContext["before"] = {
    usdTrendPct: null,
    us2yPriceChange: null,
    us2yImpliedYieldDir: null,
    us10yPriceChange: null,
    us10yImpliedYieldDir: null,
  };

  const yieldDir = (delta: number): "up" | "down" | "flat" => {
    if (Math.abs(delta) < 1e-9) return "flat";
    // price up => yield down
    return delta > 0 ? "down" : "up";
  };

  for (const y of YIELD_INSTRUMENTS) {
    const candles = await getCandles(y.instrument, "M1", from, to);
    const start = candleAtOrBefore(candles, event - PRE_WINDOW_MIN * 60_000);
    const atEvent = candleAtOrBefore(candles, event);
    if (start && atEvent) {
      const delta = atEvent.close - start.close;
      if (y.key === "us2y") {
        before.us2yPriceChange = delta;
        before.us2yImpliedYieldDir = yieldDir(delta);
      } else {
        before.us10yPriceChange = delta;
        before.us10yImpliedYieldDir = yieldDir(delta);
      }
    }
  }

  // --- USD trend (before) ---
  {
    const candles = await getCandles(USD_TREND.instrument, "M1", from, to);
    const start = candleAtOrBefore(candles, event - PRE_WINDOW_MIN * 60_000);
    const atEvent = candleAtOrBefore(candles, event);
    if (start && atEvent) {
      before.usdTrendPct = moveForCurrency(USD_TREND, start.close, atEvent.close).pct;
    }
  }

  // --- reaction (after) on the event currency's own pair ---
  const reaction: MarketContext["reaction"] = {};
  const pair = REACTION_PAIR[currency];
  let reactionInstrument: string | null = null;

  if (pair) {
    reactionInstrument = pair.instrument;
    const candles = await getCandles(pair.instrument, "M1", from, to);
    const base = candleAtOrBefore(candles, event);
    for (const w of POST_WINDOWS_MIN) {
      const after = candleAtOrAfter(candles, event + w * 60_000);
      reaction[String(w)] =
        base && after ? moveForCurrency(pair, base.close, after.close) : null;
    }
  } else {
    // No tradable USD-cross pair for this currency (e.g. CNY): report nulls.
    for (const w of POST_WINDOWS_MIN) reaction[String(w)] = null;
  }

  return { reactionInstrument, before, reaction };
}
