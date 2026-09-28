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
