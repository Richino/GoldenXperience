import { IMPACT_LEVEL } from "@/lib/news/impact-tagging";

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

/** Headline releases that routinely move FX hard, beyond an ordinary "high". */
const MASSIVE_EVENT =
  /non-?farm|\bNFP\b|\bCPI\b|consumer price|rate (decision|statement)|cash rate|interest rate|monetary policy|FOMC|press conference|employment change|unemployment rate|\bGDP\b|core PCE/i;

export type HomeCalendarMoveSize = "massive" | "high" | "moderate";

/** How big a move to expect from the release, for the Home news rows. */
export function homeCalendarMoveSize(event: { impact: number; title: string }): HomeCalendarMoveSize {
  if (homeCalendarImpactTier(event.impact) !== "high") return "moderate";
  return MASSIVE_EVENT.test(event.title) ? "massive" : "high";
}
