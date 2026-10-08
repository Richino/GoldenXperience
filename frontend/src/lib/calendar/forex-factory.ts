import {
  buildCalendarSnapshot,
  createMockCalendarEvents,
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
}

let cache: CachedFeed | null = null;
let inFlight: Promise<EconomicCalendarEvent[]> | null = null;


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
      throw new Error(`Calendar feed returned ${response.status}.`);
    }

    // A rate-limited response is HTML with a 200, so the content type is the
    // only reliable signal that this is really the feed.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new Error("Calendar feed is rate limited.");
    }

    return normalizeForexFactoryEvents(await response.json());
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
  if (!cache || now - cache.fetchedAt >= CACHE_TTL_MS || !timestamps.some(at => at >= weekStart && at < weekEnd)) {
    throw new Error("Current calendar coverage is unavailable; news risk is UNKNOWN.");
  }
  return { events, fetchedAt: new Date(cache.fetchedAt).toISOString(), coverageUntil: new Date(weekEnd).toISOString() };
}

async function loadEvents(): Promise<EconomicCalendarEvent[]> {
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (cache && fresh) {
    return cache.events;
  }

  // Collapse concurrent misses into one request so a burst of page loads
  // cannot trip the feed's rate limit.
  const request = (inFlight ??= fetchFeed(THIS_WEEK_URL)
    .then((events) => {
      cache = { events, fetchedAt: Date.now() };
      return events;
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
    const stale = cache ? Date.now() - cache.fetchedAt >= CACHE_TTL_MS : false;

    return {
      data: buildCalendarSnapshot({
        events,
        source: "forex_factory",
        connected: true,
        coverageUntil: events.at(-1)?.timestamp ?? null,
      }),
      status: buildStatus(
        "connected",
        stale
          ? "Showing the last cached ForexFactory calendar."
          : "ForexFactory economic calendar loaded.",
      ),
    };
  } catch (error) {
    return {
      data: buildCalendarSnapshot({
        events: createMockCalendarEvents(),
        source: "mock",
        connected: false,
      }),
      status: buildStatus(
        "error",
        error instanceof Error ? error.message : "Calendar feed unavailable.",
      ),
    };
  }
}
