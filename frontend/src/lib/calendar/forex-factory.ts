import {
  buildCalendarSnapshot,
  type EconomicCalendarEvent,
  type EconomicCalendarSnapshot,
  startOfNewYorkDay,
} from "@/lib/oanda/calendar";
import { normalizeForexFactoryEvents } from "@/lib/calendar/normalize";
import { withActuals } from "@/lib/calendar/forex-factory-actuals";
import type { ConnectionStatus } from "@/types/forex";

/** The current-week export is stable enough to fetch directly. */
const THIS_WEEK_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

/**
 * The feed rate-limits aggressively — two requests a second apart are enough to
 * get an HTML "Rate Limited" page back instead of JSON. Every render must be
 * served from this module-level cache rather than hitting the feed directly.
 */
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

interface CachedFeed {
  events: EconomicCalendarEvent[];
  fetchedAt: number;
  coverageUntil: number;
}

let cache: CachedFeed | null = null;
let inFlight: Promise<EconomicCalendarEvent[]> | null = null;
let retryAt = 0;
let lastFeedError: Error | null = null;


async function fetchFeed(url: string): Promise<EconomicCalendarEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        // The feed serves its rate-limit page to unrecognised clients.
        "User-Agent": "Mozilla/5.0 (compatible; GoldenXperience/1.0)",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 429) {
        const value = response.headers.get("retry-after");
        const seconds = value ? Number(value) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : 60_000;
        retryAt = Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 60_000);
      }
      throw new Error(`Calendar feed returned ${response.status}.`);
    }

    // A rate-limited response is HTML with a 200, so the content type is the
    // only reliable signal that this is really the feed.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new Error("Calendar feed is rate limited.");
    }

    const raw: unknown = await response.json();
    if (!Array.isArray(raw) || raw.some(e => !e || typeof e.title !== "string" || typeof e.country !== "string" || typeof e.date !== "string" || !Number.isFinite(Date.parse(e.date)))) {
      const error = new Error("Economic calendar provider response failed validation."); error.name = "CalendarValidationError"; throw error;
    }
    return normalizeForexFactoryEvents(raw);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Every event the current-week feed carries, past ones included.
 *
 * `getEconomicCalendar` returns a snapshot built for the trading UI, and
 * `buildCalendarSnapshot` filters that to UPCOMING events — correct for a
 * pre-trade news gate, useless for tagging a trade that already happened. News
 * impact tagging needs the whole week, so it reads the normalized list directly
 * and shares the same rate-limit cache.
 */
export async function getAllCalendarEvents(): Promise<EconomicCalendarEvent[]> {
  return withActuals(await loadEvents());
}

/** Selection requires a current feed, rather than loadEvents' stale UI fallback. */
export async function getMarketSelectionCalendar() {
  const events = await loadEvents();
  const now = Date.now();
  const today = startOfNewYorkDay(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(now));
  const daysSinceSunday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  // Anchor to local midnight after crossing DST; current-week is the feed's
  // coverage period, rather than the time of its last scheduled event.
  const weekStart = startOfNewYorkDay(today - daysSinceSunday * 86_400_000 + 6 * 3_600_000);
  const weekEnd = startOfNewYorkDay(weekStart + 7 * 86_400_000 + 6 * 3_600_000);
  const timestamps = events.map(e => Date.parse(e.timestamp));
  if (!cache || now - cache.fetchedAt >= CACHE_TTL_MS || cache.coverageUntil !== weekEnd || (events.length > 0 && !timestamps.some(at => at >= weekStart && at < weekEnd))) {
    throw new Error("Current calendar coverage is unavailable; news risk is UNKNOWN.");
  }
  return { events, fetchedAt: new Date(cache.fetchedAt).toISOString(), coverageUntil: new Date(weekEnd).toISOString() };
}

function calendarWeekEnd(now: number) {
  const today = startOfNewYorkDay(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(now));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const start = startOfNewYorkDay(today - days * 86_400_000 + 6 * 3_600_000);
  return startOfNewYorkDay(start + 7 * 86_400_000 + 6 * 3_600_000);
}

async function loadEvents(): Promise<EconomicCalendarEvent[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (cache && fresh) {
    return cache.events;
  }
  // Without a failure cooldown, every UI poll after a 429 hits the provider
  // again, prolonging the outage. Keep the stale display fallback, but let
  // strict consumers reject it until a fresh fetch succeeds.
  if (Date.now() < retryAt) {
    if (cache) return cache.events;
    throw lastFeedError ?? new Error("Calendar feed is cooling down after a failed request.");
  }

  // Collapse concurrent misses into one request so a burst of page loads
  // cannot trip the feed's rate limit.
  const request = (inFlight ??= fetchFeed(THIS_WEEK_URL)
    .then((events) => {
      cache = { events, fetchedAt: Date.now(), coverageUntil: calendarWeekEnd(Date.now()) };
      retryAt = 0;
      lastFeedError = null;
      return events;
    })
    .catch((error: unknown) => {
      lastFeedError = error instanceof Error ? error : new Error("Calendar feed unavailable.");
      retryAt = Math.max(retryAt, Date.now() + 60_000);
      throw lastFeedError;
    })
    .finally(() => {
      inFlight = null;
    }));

  try {
    return await request;
  } catch (error) {
    // Serve stale data rather than dropping the news gate entirely.
    if (cache) return cache.events;
    throw error;
  }
}

function buildStatus(
  state: ConnectionStatus["state"],
  message: string,
): ConnectionStatus {
  return {
    state,
    source: state === "connected" ? "forex_factory" : "mock",
    environment: "practice",
    label: state === "connected" ? "ForexFactory" : "Calendar unavailable",
    message,
    checkedAt: new Date().toISOString(),
  };
}

export async function getEconomicCalendar(): Promise<{
  data: EconomicCalendarSnapshot;
  status: ConnectionStatus;
}> {
  try {
    const events = await withActuals(await loadEvents());
    const weekEnd = calendarWeekEnd(Date.now());
    const weekStart = startOfNewYorkDay(weekEnd - 7 * 86_400_000 + 6 * 3_600_000);
    const wrongWeek = events.length > 0 && !events.some(e => Date.parse(e.timestamp) >= weekStart && Date.parse(e.timestamp) < weekEnd);
    const stale = cache ? Date.now() - cache.fetchedAt >= CACHE_TTL_MS || cache.coverageUntil !== weekEnd || wrongWeek : true;

    return {
      data: {
        ...buildCalendarSnapshot({ events, source: "forex_factory", connected: !stale, coverageUntil: cache ? new Date(cache.coverageUntil).toISOString() : null }),
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : undefined,
        status: stale ? "CALENDAR_STALE" : events.length ? "CALENDAR_AVAILABLE_WITH_EVENTS" : "CALENDAR_AVAILABLE_NO_EVENTS",
      },
      status: buildStatus(
        "connected",
        stale
          ? "Showing the last cached ForexFactory calendar."
          : "ForexFactory economic calendar loaded.",
      ),
    };
  } catch (error) {
    return {
      data: { ...buildCalendarSnapshot({ events: [], source: "mock", connected: false }), status: error instanceof Error && error.name === "CalendarValidationError" ? "CALENDAR_VALIDATION_FAILED" : "CALENDAR_UNAVAILABLE" },
      status: buildStatus(
        "error",
        error instanceof Error ? error.message : "Calendar feed unavailable.",
      ),
    };
  }
}
