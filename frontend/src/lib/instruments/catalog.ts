import type { MajorInstrument } from "@/types/forex";

export interface InstrumentInfo {
  name: string;
  displayName: string;
  /** Power of ten of one pip: -4 for most pairs, -2 for JPY-quoted. */
  pipLocation: number;
  displayPrecision: number;
}

/**
 * Every CURRENCY instrument tradeable on the OANDA practice account, captured
 * from GET /v3/accounts/{id}/instruments. Held statically so search stays
 * instant and works without a broker round trip; pipLocation and
 * displayPrecision come from OANDA rather than being inferred from the symbol,
 * which is what makes JPY crosses format correctly.
 */
export const INSTRUMENT_CATALOG: InstrumentInfo[] = [
  { name: "AUD_CAD", displayName: "AUD/CAD", pipLocation: -4, displayPrecision: 5 },
  { name: "AUD_CHF", displayName: "AUD/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "AUD_HKD", displayName: "AUD/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "AUD_JPY", displayName: "AUD/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "AUD_NZD", displayName: "AUD/NZD", pipLocation: -4, displayPrecision: 5 },
  { name: "AUD_SGD", displayName: "AUD/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "AUD_USD", displayName: "AUD/USD", pipLocation: -4, displayPrecision: 5 },
  { name: "CAD_CHF", displayName: "CAD/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "CAD_HKD", displayName: "CAD/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "CAD_JPY", displayName: "CAD/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "CAD_SGD", displayName: "CAD/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "CHF_HKD", displayName: "CHF/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "CHF_JPY", displayName: "CHF/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "CHF_ZAR", displayName: "CHF/ZAR", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_AUD", displayName: "EUR/AUD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_CAD", displayName: "EUR/CAD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_CHF", displayName: "EUR/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_CZK", displayName: "EUR/CZK", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_DKK", displayName: "EUR/DKK", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_GBP", displayName: "EUR/GBP", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_HKD", displayName: "EUR/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_HUF", displayName: "EUR/HUF", pipLocation: -2, displayPrecision: 3 },
  { name: "EUR_JPY", displayName: "EUR/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "EUR_NOK", displayName: "EUR/NOK", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_NZD", displayName: "EUR/NZD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_PLN", displayName: "EUR/PLN", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_SEK", displayName: "EUR/SEK", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_SGD", displayName: "EUR/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_TRY", displayName: "EUR/TRY", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_USD", displayName: "EUR/USD", pipLocation: -4, displayPrecision: 5 },
  { name: "EUR_ZAR", displayName: "EUR/ZAR", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_AUD", displayName: "GBP/AUD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_CAD", displayName: "GBP/CAD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_CHF", displayName: "GBP/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_HKD", displayName: "GBP/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_JPY", displayName: "GBP/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "GBP_NZD", displayName: "GBP/NZD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_PLN", displayName: "GBP/PLN", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_SGD", displayName: "GBP/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_USD", displayName: "GBP/USD", pipLocation: -4, displayPrecision: 5 },
  { name: "GBP_ZAR", displayName: "GBP/ZAR", pipLocation: -4, displayPrecision: 5 },
  { name: "HKD_JPY", displayName: "HKD/JPY", pipLocation: -4, displayPrecision: 5 },
  { name: "NZD_CAD", displayName: "NZD/CAD", pipLocation: -4, displayPrecision: 5 },
  { name: "NZD_CHF", displayName: "NZD/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "NZD_HKD", displayName: "NZD/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "NZD_JPY", displayName: "NZD/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "NZD_SGD", displayName: "NZD/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "NZD_USD", displayName: "NZD/USD", pipLocation: -4, displayPrecision: 5 },
  { name: "SGD_CHF", displayName: "SGD/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "SGD_JPY", displayName: "SGD/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "TRY_JPY", displayName: "TRY/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "USD_CAD", displayName: "USD/CAD", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_CHF", displayName: "USD/CHF", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_CNH", displayName: "USD/CNH", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_CZK", displayName: "USD/CZK", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_DKK", displayName: "USD/DKK", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_HKD", displayName: "USD/HKD", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_HUF", displayName: "USD/HUF", pipLocation: -2, displayPrecision: 3 },
  { name: "USD_JPY", displayName: "USD/JPY", pipLocation: -2, displayPrecision: 3 },
  { name: "USD_MXN", displayName: "USD/MXN", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_NOK", displayName: "USD/NOK", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_PLN", displayName: "USD/PLN", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_SEK", displayName: "USD/SEK", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_SGD", displayName: "USD/SGD", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_THB", displayName: "USD/THB", pipLocation: -2, displayPrecision: 3 },
  { name: "USD_TRY", displayName: "USD/TRY", pipLocation: -4, displayPrecision: 5 },
  { name: "USD_ZAR", displayName: "USD/ZAR", pipLocation: -4, displayPrecision: 5 },
  { name: "ZAR_JPY", displayName: "ZAR/JPY", pipLocation: -2, displayPrecision: 3 },
];

const byName = new Map(INSTRUMENT_CATALOG.map((item) => [item.name, item]));

export function findInstrument(name: string): InstrumentInfo | undefined {
  return byName.get(name.toUpperCase());
}

export function isKnownInstrument(name: string): name is MajorInstrument {
  return byName.has(name.toUpperCase());
}

export function currenciesOf(name: string) {
  const [base, quote] = name.split("_");
  return { base: base ?? "", quote: quote ?? "" };
}

/** One pip for this instrument, e.g. 0.0001 major, 0.01 JPY-quoted. */
export function pipSizeFor(name: string) {
  const info = findInstrument(name);
  return 10 ** (info?.pipLocation ?? -4);
}

/** Decimal places OANDA displays this instrument at. */
export function precisionFor(name: string) {
  return findInstrument(name)?.displayPrecision ?? 5;
}

export function displayNameFor(name: string) {
  return findInstrument(name)?.displayName ?? name.replace("_", "/");
}
