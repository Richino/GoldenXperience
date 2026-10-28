import { IMPACT_LEVEL } from "@/lib/news/impact-tagging";
import { RELEASED_EVENT_WINDOW_MINUTES, startOfNewYorkDay, type EconomicCalendarSnapshot } from "@/lib/oanda/calendar";
import { tradingDayKey } from "@/lib/format/datetime";

/** Minimum impact shown on Home (medium and high; same scale as the calendar feed). */
export const HOME_CALENDAR_MIN_IMPACT = IMPACT_LEVEL.medium;

/** Limit the preview of later days; today's releases are never capped. */
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
 * Keep all of today's releases visible, including those still ahead. A busy
 * morning must not hide an afternoon release until the earlier events pass.
 * Only later days are capped, counting same-currency simultaneous releases
 * as one group so a limit cannot cut a release's companion reports in half.
 * Uses `now` rather than fetch time so row states update while the page is open.
 */
export function homeCalendarRows<T extends { id: string; currency: string; impact: number; timestamp: string }>(
  recent: T[],
  upcoming: T[],
  now: number,
): (T & { state: HomeCalendarRowState })[] {
  const todayStart = startOfNewYorkDay(now);
  const today = tradingDayKey(now);
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
  const laterGroups = new Set<string>();
  return rows.filter((row) => {
    if (row.state !== "upcoming" || tradingDayKey(row.timestamp) === today) return true;
    const group = `${row.currency}|${Date.parse(row.timestamp)}`;
    if (laterGroups.has(group)) return true;
    if (laterGroups.size >= HOME_CALENDAR_MAX_EVENTS) return false;
    laterGroups.add(group);
    return true;
  });
}

/**
 * Releases for the same currency at the same moment (AUD Employment Change and
 * Unemployment Rate, US CPI m/m and y/y) hit the market as one event: the
 * currency moves once, on the combined numbers. Group them into one row so the
 * news card never shows two separate, possibly contradictory, reads for one
 * moment. The highest-impact release leads; `events` holds all of them.
 */
export function groupSimultaneousRows<T extends { currency: string; timestamp: string; impact: number }>(rows: T[]): (T & { events: T[] })[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = `${row.currency}|${Date.parse(row.timestamp)}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }
  return order.map((key) => {
    const events = [...groups.get(key)!].sort((a, b) => b.impact - a.impact);
    return { ...events[0]!, events };
  });
}

/** One label for a group: "Employment Change + Unemployment Rate", "CPI m/m + 3 more". */
export function groupedCalendarTitle(events: { title: string }[]): string {
  if (events.length <= 2) return events.map((event) => event.title).join(" + ");
  return `${events[0]!.title} + ${events.length - 1} more`;
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
