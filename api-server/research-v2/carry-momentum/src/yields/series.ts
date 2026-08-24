import type { Currency } from "../types.js";

/**
 * FRED series for carry research.
 *
 * Priority:
 * 1) Daily government / market yields where available (USD DGS2).
 * 2) OECD long-term government bond yields (monthly) — same family as
 *    frontend/src/lib/macro/rates.ts — for cross-currency comparability.
 *
 * Documented substitutions (2Y daily unavailable for most non-US):
 * - EUR → Germany long-term OECD (IRLTLT01DEM156N)
 * - Others → country OECD long-term series
 *
 * Point-in-time:
 * - Daily series: availableAt = observationDate + 1 calendar day (close known next day)
 * - Monthly series: availableAt = first day of month AFTER observation month (publication lag)
 */
export type SeriesDef = {
  currency: Currency;
  seriesId: string;
  frequency: "daily" | "monthly";
  role: "primary" | "secondary";
  note: string;
};

export const YIELD_SERIES: SeriesDef[] = [
  // Short-term / policy proxies — OECD 3-month interbank (monthly, comparable cross-ccy)
  { currency: "USD", seriesId: "IR3TIB01USM156N", frequency: "monthly", role: "primary", note: "OECD US 3-month interbank rate (short-rate proxy)" },
  { currency: "USD", seriesId: "DFF", frequency: "daily", role: "secondary", note: "Fed effective funds rate (daily cross-check)" },
  { currency: "EUR", seriesId: "IR3TIB01DEM156N", frequency: "monthly", role: "primary", note: "OECD Germany 3M interbank — EUR area proxy" },
  { currency: "GBP", seriesId: "IR3TIB01GBM156N", frequency: "monthly", role: "primary", note: "OECD UK 3-month interbank" },
  { currency: "JPY", seriesId: "IR3TIB01JPM156N", frequency: "monthly", role: "primary", note: "OECD Japan 3-month interbank" },
  { currency: "CHF", seriesId: "IR3TIB01CHM156N", frequency: "monthly", role: "primary", note: "OECD Switzerland 3-month interbank" },
  { currency: "CAD", seriesId: "IR3TIB01CAM156N", frequency: "monthly", role: "primary", note: "OECD Canada 3-month interbank" },
  { currency: "AUD", seriesId: "IR3TIB01AUM156N", frequency: "monthly", role: "primary", note: "OECD Australia 3-month interbank" },
  { currency: "NZD", seriesId: "IR3TIB01NZM156N", frequency: "monthly", role: "primary", note: "OECD New Zealand 3-month interbank" },
  // Long-term fallbacks (wave-1)
  { currency: "USD", seriesId: "DGS2", frequency: "daily", role: "secondary", note: "US Treasury 2Y" },
  { currency: "EUR", seriesId: "IRLTLT01DEM156N", frequency: "monthly", role: "secondary", note: "OECD Germany long-term" },
];

export function availableAtFor(observationDate: string, frequency: "daily" | "monthly"): string {
  const d = new Date(`${observationDate}T00:00:00.000Z`);
  if (frequency === "daily") {
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  // Monthly: usable from the 1st of the following month (conservative publication lag).
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();
}
