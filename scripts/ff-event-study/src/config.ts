/**
 * Mapping and window configuration for the event study.
 *
 * The market-context numbers are derived entirely from OANDA candles — the same
 * instruments the project's `_catalyst_model.py` already treats as the intraday
 * catalyst channel (USD short-end + long-end yields, FX legs). Nothing here
 * fabricates a consensus or a surprise; forecast/actual/previous come straight
 * from Forex Factory and the market numbers come straight from OANDA.
 */

/** How a currency's own move is read off a tradable OANDA pair. */
export interface ReactionPair {
  /** OANDA instrument used to measure this currency's reaction. */
  instrument: string;
  /**
   * true when the currency is the QUOTE side of `instrument`, so a stronger
   * currency prints a LOWER price (USD_JPY: JPY up => price down). The study
   * always reports the move in terms of the EVENT currency, so this flips sign.
   */
  currencyIsQuote: boolean;
}

/**
 * The pair used to express each currency's post-release reaction. USD has no
 * "USD/USD" pair, so its reaction is read off EUR_USD inverted — USD strength
 * shows up as EUR_USD falling.
 */
export const REACTION_PAIR: Record<string, ReactionPair> = {
  EUR: { instrument: "EUR_USD", currencyIsQuote: false },
  GBP: { instrument: "GBP_USD", currencyIsQuote: false },
  AUD: { instrument: "AUD_USD", currencyIsQuote: false },
  NZD: { instrument: "NZD_USD", currencyIsQuote: false },
  USD: { instrument: "EUR_USD", currencyIsQuote: true },
  JPY: { instrument: "USD_JPY", currencyIsQuote: true },
  CAD: { instrument: "USD_CAD", currencyIsQuote: true },
  CHF: { instrument: "USD_CHF", currencyIsQuote: true },
};

/**
 * USD-strength proxy for the "USD trend before the event" feature. Read off
 * EUR_USD inverted (EUR_USD down = USD up). Kept separate from REACTION_PAIR so
 * the intent is explicit even though USD happens to reuse the same pair.
 */
export const USD_TREND: ReactionPair = { instrument: "EUR_USD", currencyIsQuote: true };

/**
 * US bond CFDs on OANDA. These are PRICE contracts: price up => yield DOWN. The
 * study reports the raw price move and labels the implied yield direction, it
 * does not invent a yield level.
 */
export const YIELD_INSTRUMENTS = [
  { key: "us2y", instrument: "USB02Y_USD" },
  { key: "us10y", instrument: "USB10Y_USD" },
] as const;

/** Pip size per instrument, for expressing moves in pips. */
export function pipSize(instrument: string): number {
  if (instrument.endsWith("_JPY") || instrument.startsWith("USB")) return 0.01;
  return 0.0001;
}

/** Minutes of pre-event context used for the "trend before" features. */
export const PRE_WINDOW_MIN = 60;

/** Post-release horizons (minutes) at which the price reaction is measured. */
export const POST_WINDOWS_MIN = [15, 30, 60] as const;

/** Impact ranking so callers can filter (e.g. skip low-impact noise). */
export const IMPACT_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  holiday: 0,
  none: 0,
};
