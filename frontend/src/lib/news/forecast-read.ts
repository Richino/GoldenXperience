import { eventCurrencyPolarity } from "@/lib/news/event-polarity";
import { parseCalendarValue, type CalendarValueFields, type TrendDirection } from "@/lib/news/surprise-hint";

/**
 * The read most people (and ChatGPT) give a calendar line: is the forecast
 * better or worse for the currency than the previous reading? 0.1% → 0.0% GDP
 * reads "slightly bearish", 0.5% → 0.7% reads "bullish".
 *
 * It describes what the consensus already expects, not a surprise, so it is
 * the inverse of the journal's "previous" signal; the API tracks its record.
 */
export type ForecastRead = {
  direction: TrendDirection | "flat";
  /** 1 = slight change, 2 = clear change, 0 = flat. */
  weight: 0 | 1 | 2;
  /**
   * How big the change is: percentage points for % prints, the fraction of the
   * previous level for counts. Ranks releases within one weight.
   */
  size: number;
  label: string;
};

export function forecastRead(event: Pick<CalendarValueFields, "title" | "currency" | "forecast" | "previous">): ForecastRead | null {
  const polarity = eventCurrencyPolarity(event.title);
  const forecast = parseCalendarValue(event.forecast);
  const previous = parseCalendarValue(event.previous);
  if (polarity === null || forecast === null || previous === null) return null;
  const change = forecast - previous;
  const percent = Boolean(event.forecast?.includes("%") || event.previous?.includes("%"));
  // Percent prints move in tenths: one tenth is "slight". Counts (220K, 1.2M)
  // compare relative to the previous level: under 10% is "slight".
  const size = percent ? Math.abs(change) : Math.abs(change) / Math.max(Math.abs(previous), 1e-9);
  const flatBelow = percent ? 0.0001 : 0.001;
  if (size < flatBelow) return { direction: "flat", weight: 0, size: 0, label: `Neutral ${event.currency}` };
  const weight: 1 | 2 = size <= (percent ? 0.1 + 1e-9 : 0.1) ? 1 : 2;
  const direction: TrendDirection = change * polarity > 0 ? "up" : "down";
  const tone = direction === "up" ? "bullish" : "bearish";
  return { direction, weight, size, label: `${weight === 1 ? "Slightly " : ""}${weight === 1 ? tone : tone[0]!.toUpperCase() + tone.slice(1)} ${event.currency}` };
}

/** Adds the reads up: a clear change counts twice a slight one. */
export function combinedForecastRead(reads: Array<ForecastRead | null>): { direction: TrendDirection | "flat"; net: number } {
  const net = reads.reduce((sum, read) => sum + (read ? (read.direction === "up" ? read.weight : read.direction === "down" ? -read.weight : 0) : 0), 0);
  return { direction: net > 0 ? "up" : net < 0 ? "down" : "flat", net };
}
