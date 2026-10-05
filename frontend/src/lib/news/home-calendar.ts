import { IMPACT_LEVEL } from "@/lib/news/impact-tagging";
import { RELEASED_EVENT_WINDOW_MINUTES, startOfNewYorkDay } from "@/lib/oanda/calendar";

/** Minimum impact shown on Home (medium and high; same scale as the calendar feed). */
export const HOME_CALENDAR_MIN_IMPACT = IMPACT_LEVEL.medium;

/** Cap list length so the rail/card stays scannable on mobile. */
export const HOME_CALENDAR_MAX_EVENTS = 6;

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
