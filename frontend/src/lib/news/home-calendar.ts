import { IMPACT_LEVEL } from "@/lib/news/impact-tagging";
import { RELEASED_EVENT_WINDOW_MINUTES, startOfNewYorkDay, type EconomicCalendarSnapshot } from "@/lib/oanda/calendar";

/** Minimum impact shown on Home (medium and high; same scale as the calendar feed). */
export const HOME_CALENDAR_MIN_IMPACT = IMPACT_LEVEL.medium;

/** Cap list length so the rail/card stays scannable on mobile. */
export const HOME_CALENDAR_MAX_EVENTS = 6;

/** The current-week export rolls to a Sunday week; publication time is not guaranteed. */
export function homeCalendarEmptyMessage(calendar: EconomicCalendarSnapshot, now: number): string {
  const coverage = calendar.coverageUntil ? Date.parse(calendar.coverageUntil) : NaN;
  if (calendar.connected && Number.isFinite(coverage) && coverage < now + 24 * 60 * 60_000) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(now));
    // A missing weekday feed has no supported availability date. Only infer the
    // weekly rollover for a recent Forex Factory export at the end of its week.
    if (calendar.source === "forex_factory" && ["Fri", "Sat", "Sun"].includes(weekday) && coverage >= now - 3 * 24 * 60 * 60_000) {
      const days = weekday === "Fri" ? 2 : weekday === "Sat" ? 1 : 0;
      const sunday = startOfNewYorkDay(now) + days * 24 * 60 * 60_000 + 12 * 60 * 60_000;
      const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" }).format(new Date(sunday));
      return `Calendar update expected ${days === 0 ? "today," : "on"} ${date}.`;
    }
    return "Calendar update pending.";
  }
  return calendar.warnings[0]?.tone !== "success" && calendar.warnings[0]?.message
    ? calendar.warnings[0].message : "No high or medium impact events this week.";
}

export type HomeCalendarImpactTier = "high" | "medium";

export function homeCalendarImpactTier(impact: number): HomeCalendarImpactTier {
  return impact >= IMPACT_LEVEL.high ? "high" : "medium";
}

export function upcomingHomeCalendarEvents<T extends { impact: number }>(events: T[]): T[] {
  return events
    .filter((event) => event.impact >= HOME_CALENDAR_MIN_IMPACT)
    .slice(0, HOME_CALENDAR_MAX_EVENTS);
}

export type HomeCalendarRowState = "live" | "released" | "upcoming";

/**
 * Home news rows: everything released today (New York day) stays on the list
 * ahead of the upcoming events. A release is `live` for its first hour, then
 * `released` until midnight. Only upcoming rows count toward the cap, so a
 * busy morning does not push the next events off. Uses `now` rather than the
 * fetch time, so rows change state while the page stays open.
 */
export function homeCalendarRows<T extends { id: string; impact: number; timestamp: string }>(
  recent: T[],
  upcoming: T[],
  now: number,
): (T & { state: HomeCalendarRowState })[] {
  const todayStart = startOfNewYorkDay(now);
  const seen = new Set<string>();
  const rows = [...recent, ...upcoming]
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return event.impact >= HOME_CALENDAR_MIN_IMPACT && Date.parse(event.timestamp) >= todayStart;
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((event) => {
      const time = Date.parse(event.timestamp);
      const state: HomeCalendarRowState = time > now ? "upcoming"
        : now - time <= RELEASED_EVENT_WINDOW_MINUTES * 60_000 ? "live" : "released";
      return { ...event, state };
    });
  const released = rows.filter((row) => row.state !== "upcoming");
  return [...released, ...rows.filter((row) => row.state === "upcoming").slice(0, HOME_CALENDAR_MAX_EVENTS)];
}

/** Headline releases that routinely move FX hard, beyond an ordinary "high". */
const MASSIVE_EVENT =
  /non-?farm|\bNFP\b|\bCPI\b|consumer price|rate (decision|statement)|cash rate|interest rate|monetary policy|FOMC|press conference|employment change|unemployment rate|\bGDP\b|core PCE/i;

export type HomeCalendarMoveSize = "massive" | "high" | "moderate";

/** How big a move to expect from the release, for the Home news rows. */
export function homeCalendarMoveSize(event: { impact: number; title: string }): HomeCalendarMoveSize {
  if (homeCalendarImpactTier(event.impact) !== "high") return "moderate";
  return MASSIVE_EVENT.test(event.title) ? "massive" : "high";
}
