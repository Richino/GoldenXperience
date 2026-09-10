/**
 * Instrument display + precision. Mirrors the web's
 * `lib/instruments/catalog.ts`: JPY-quoted pairs (and the other pip-location -2
 * currencies) show 3 decimals; everything else shows 5. Deriving it from the
 * quote currency keeps this data-only and covers every featured major without
 * shipping the whole 68-row OANDA catalog.
 */

/** Quote currencies OANDA prices to 3 decimals (pipLocation -2). */
const THREE_DECIMAL_QUOTES = new Set(["JPY", "HUF", "THB"]);

export function quoteCurrencyOf(instrument: string): string {
  return instrument.split("_")[1] ?? "";
}

export function pricePrecision(instrument: string): number {
  return THREE_DECIMAL_QUOTES.has(quoteCurrencyOf(instrument)) ? 3 : 5;
}

/** "EUR_USD" → "EUR/USD". */
export function displayNameFor(instrument: string): string {
  return instrument.replace("_", "/");
}

/** Formats a price to the instrument's native precision, e.g. 1.17614 / 147.820. */
export function formatPrice(value: number, instrument: string): string {
  return value.toFixed(pricePrecision(instrument));
}
