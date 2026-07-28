import {
  buildCalendarSnapshot,
  createMockCalendarEvents,
  type EconomicCalendarEvent,
  type EconomicCalendarSnapshot,
} from "@/lib/oanda/calendar";
import { normalizeForexFactoryEvents } from "@/lib/calendar/normalize";
import type { ConnectionStatus } from "@/types/forex";

/**
 * Only the current week is published — nextweek/lastweek/today all 404 — so the
 * snapshot has to declare where its coverage ends rather than imply it can see
 * a full 24 hours ahead.
 */
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
    const events = await loadEvents();
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
