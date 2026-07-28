import type { EconomicCalendarEvent } from "@/lib/oanda/calendar";

/** Currencies that can move the three instruments this workspace trades. */
export const TRACKED_CURRENCIES = new Set(["EUR", "USD", "GBP", "JPY"]);

/** buildCalendarSnapshot treats >= 3 as high impact. */
const IMPACT_SCORE: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
  holiday: 0,
};

const CURRENCY_REGION: Record<string, string> = {
  USD: "americas",
  EUR: "europe",
  GBP: "europe",
  JPY: "asia",
};

export interface ForexFactoryEvent {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
}

function isForexFactoryEvent(value: unknown): value is ForexFactoryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ForexFactoryEvent>;
  return (
    typeof event.title === "string" &&
    typeof event.country === "string" &&
    typeof event.date === "string"
  );
}

function emptyToNull(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function normalizeForexFactoryEvents(
  raw: unknown,
): EconomicCalendarEvent[] {
  if (!Array.isArray(raw)) return [];

  const events: EconomicCalendarEvent[] = [];

  for (const item of raw) {
    if (!isForexFactoryEvent(item)) continue;
    if (!TRACKED_CURRENCIES.has(item.country)) continue;

    const timestampMs = Date.parse(item.date);
    if (!Number.isFinite(timestampMs)) continue;

    const timestamp = new Date(timestampMs).toISOString();

    events.push({
      id: `${item.country}:${item.title}:${timestamp}`,
      title: item.title,
      currency: item.country,
      region: CURRENCY_REGION[item.country] ?? "global",
      impact: IMPACT_SCORE[String(item.impact).toLowerCase()] ?? 0,
      timestamp,
      forecast: emptyToNull(item.forecast),
      previous: emptyToNull(item.previous),
      // The weekly feed carries only scheduled entries, never a released value.
      actual: null,
      unit: null,
    });
  }

  return events.sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}
