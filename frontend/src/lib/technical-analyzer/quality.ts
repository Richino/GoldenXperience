import { brokerOpen, intervalTraded } from "../strategy/candle-clock";

/** Explicit published OANDA FX closures, not a blanket bank-holiday calendar.
 * https://www.oanda.com/ca-en/trading/holiday-trading-hours/ (checked 2026-10-31).
 * Dates not covered here remain unexplained gaps and are never guessed away. */
export const FX_HOLIDAYS = [
  { from: Date.parse("2025-12-24T21:59:00Z"), to: Date.parse("2025-12-25T22:05:00Z"), name: "Christmas 2025" },
  { from: Date.parse("2025-12-31T21:59:00Z"), to: Date.parse("2026-01-01T22:05:00Z"), name: "New Year 2026" },
];

export function scheduledTrading(from: number, to: number): boolean {
  return intervalTraded(from, to, FX_HOLIDAYS);
}

export function technicalDataAvailable(warnings: string[]): boolean {
  return !warnings.some(w => w.startsWith("Recent gap") || w.includes("latest completed candle is stale") || w.includes("no completed candles"));
}

export function marketQuality(now: number, quoteAt: string, tradeable: boolean, warnings: string[]) {
  const marketOpen = brokerOpen(now, FX_HOLIDAYS);
  const quoteFresh = now - Date.parse(quoteAt) <= 120000;
  const scoringReasons: string[] = [];
  if (!marketOpen) scoringReasons.push("Market closed: completed-candle analysis available; excluded from forward scoring.");
  if (marketOpen && !tradeable) scoringReasons.push("Pair not tradeable: excluded from forward scoring.");
  if (marketOpen && !quoteFresh) scoringReasons.push("Live quote unexpectedly older than two minutes: excluded from forward scoring.");
  const technicalAvailable = technicalDataAvailable(warnings);
  if (!technicalAvailable) scoringReasons.push("Recent candle gaps or stale completed candles: technical outlook unavailable.");
  return { marketOpen, quoteFresh, technicalAvailable, scoringReasons, eligible: marketOpen && quoteFresh && tradeable && technicalAvailable };
}
