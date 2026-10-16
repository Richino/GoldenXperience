import type { EconomicCalendarEvent } from "../../../frontend/src/lib/oanda/calendar.js";

/**
 * The verified calendar slice a research run is given: releases for the
 * pair's two currencies, from the existing calendar feeds (Forex Factory
 * schedule, TradingView actuals) — never from the model.
 *
 * Surprise = actual against forecast, reported as a number and a side
 * (above / below / in line). It deliberately says nothing about which way the
 * currency "should" move: a hot print can still sell off if it was expected,
 * revised, or read as hurting growth. Revisions are not in either feed, so
 * they are reported as unavailable rather than guessed.
 */

export type CalendarRow = {
  title: string;
  currency: string;
  impact: number;
  /** UTC ISO time. */
  at: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};

export type Surprise = {
  side: "ABOVE" | "BELOW" | "IN_LINE" | "UNKNOWN";
  /** actual − forecast in the release's own unit, when both parse. */
  difference: number | null;
  unit: string | null;
};

export type CalendarSnapshot = {
  source: string;
  /** When the feed was read (UTC). */
  readAt: string;
  available: boolean;
  currencies: string[];
  upcoming: CalendarRow[];
  released: Array<CalendarRow & { surprise: Surprise }>;
  revisions: "unavailable";
  note: string | null;
};

const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** "0.3%", "-1.2B", "245K", "<0.1%", "52.4" → value and unit; null when it does not parse. */
export function parseReleaseValue(raw: string | null | undefined): { value: number; unit: string | null } | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().replace(/,/g, "").replace(/^[<>~≈]\s*/, "");
  const match = text.match(/^([+-]?\d+(?:\.\d+)?)\s*([KMBT%]?)$/i);
  if (!match) return null;
  const suffix = match[2]!.toUpperCase();
  const value = Number(match[1]) * (SCALE[suffix] ?? 1);
  return Number.isFinite(value) ? { value, unit: suffix === "%" ? "%" : suffix ? suffix : null } : null;
}

export function surpriseOf(actual: string | null, forecast: string | null): Surprise {
  const a = parseReleaseValue(actual);
  const f = parseReleaseValue(forecast);
  if (!a || !f || a.unit !== f.unit) return { side: "UNKNOWN", difference: null, unit: a?.unit ?? f?.unit ?? null };
  const difference = a.value - f.value;
  const tolerance = Math.max(Math.abs(f.value) * 1e-9, 1e-12);
  return {
    side: Math.abs(difference) <= tolerance ? "IN_LINE" : difference > 0 ? "ABOVE" : "BELOW",
    difference: Number(difference.toPrecision(6)),
    unit: a.unit,
  };
}

export function buildCalendarSnapshot(input: {
  events: EconomicCalendarEvent[] | null;
  currencies: string[];
  now: number;
  /** How far ahead and back to include. */
  aheadHours?: number;
  backHours?: number;
}): CalendarSnapshot {
  const readAt = new Date(input.now).toISOString();
  const base = { source: "Forex Factory weekly calendar; actuals from TradingView", readAt, currencies: input.currencies, revisions: "unavailable" as const };
  if (input.events === null) {
    return { ...base, available: false, upcoming: [], released: [], note: "The economic calendar could not be read; no calendar data was given to the research." };
  }
  const ahead = (input.aheadHours ?? 72) * 3_600_000;
  const back = (input.backHours ?? 72) * 3_600_000;
  const seen = new Set<string>();
  const rows = input.events
    .filter((event) => input.currencies.includes(event.currency) && event.impact >= 2)
    .map((event): CalendarRow => ({
      title: event.title,
      currency: event.currency,
      impact: event.impact,
      at: new Date(Date.parse(event.timestamp)).toISOString(),
      forecast: event.forecast,
      previous: event.previous,
      actual: event.actual,
    }))
    .filter((row) => {
      const key = `${row.currency}|${row.title}|${row.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Number.isFinite(Date.parse(row.at));
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const upcoming = rows.filter((row) => Date.parse(row.at) > input.now && Date.parse(row.at) <= input.now + ahead);
  const released = rows
    .filter((row) => Date.parse(row.at) <= input.now && Date.parse(row.at) >= input.now - back)
    .map((row) => ({ ...row, surprise: row.actual === null ? { side: "UNKNOWN" as const, difference: null, unit: null } : surpriseOf(row.actual, row.forecast) }));
  return { ...base, available: true, upcoming, released, note: null };
}
