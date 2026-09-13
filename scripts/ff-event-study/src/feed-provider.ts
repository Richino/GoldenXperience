/**
 * Feed provider — the fully-automatable source.
 *
 * Forex Factory's weekly JSON export (`ff_calendar_thisweek.json`, served from
 * faireconomy.media) is NOT behind Cloudflare, so a plain server-side fetch
 * works with no browser, no challenge, no bypass. It is the same feed the app's
 * `frontend/src/lib/calendar/forex-factory.ts` already uses for its news gate.
 *
 * Limitation: it only ever contains the CURRENT week. History has to be built
 * forward by persisting each pull — this reads a single live snapshot.
 */
import { eventFromFeedItem } from "./saved-provider.js";
import type { RawEvent } from "./types.js";

const THIS_WEEK_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

export async function fetchFeedEvents(
  log: (msg: string) => void = () => {},
): Promise<RawEvent[]> {
  log(`  GET ${THIS_WEEK_URL}`);
  const response = await fetch(THIS_WEEK_URL, {
    headers: {
      // The feed serves an HTML rate-limit page to unrecognised clients.
      "User-Agent": "Mozilla/5.0 (compatible; GoldenXperience/1.0)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Calendar feed returned ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new Error("Calendar feed is rate limited (got HTML, not JSON). Retry shortly.");
  }

  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) throw new Error("Unexpected feed shape (expected an array).");

  const events = raw
    .map((item) => eventFromFeedItem(item as Record<string, unknown>))
    .filter((e): e is RawEvent => e !== null)
    .sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));

  log(`  ${events.length} events in this week's feed`);
  return events;
}
