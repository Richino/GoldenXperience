/** Calendar feed uses 3 = high, 2 = medium (matches frontend impact-tagging). */
export const HOME_CALENDAR_MIN_IMPACT = 2;
export const HOME_CALENDAR_MAX_EVENTS = 6;

export type HomeCalendarImpactTier = 'high' | 'medium';

export function homeCalendarImpactTier(impact: number): HomeCalendarImpactTier {
  return impact >= 3 ? 'high' : 'medium';
}

export function upcomingHomeCalendarEvents<T extends { impact: number }>(events: T[]): T[] {
  return events
    .filter((event) => event.impact >= HOME_CALENDAR_MIN_IMPACT)
    .slice(0, HOME_CALENDAR_MAX_EVENTS);
}
