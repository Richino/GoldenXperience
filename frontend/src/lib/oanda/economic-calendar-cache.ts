import { buildCalendarSnapshot, type EconomicCalendarEvent, type EconomicCalendarSnapshot } from "./calendar";

export const CALENDAR_CACHE_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 60_000;
const STORAGE_KEY = "gx:economic-calendar:v1";
type CalendarStorage = Pick<Storage, "getItem" | "setItem">;
type CachedCalendar = { data: EconomicCalendarSnapshot; fetchedAt: number };

function validEvents(value: unknown): value is EconomicCalendarEvent[] {
  return Array.isArray(value) && value.every(e => e && typeof e.id === "string" && typeof e.title === "string" &&
    typeof e.currency === "string" && Number.isFinite(e.impact) && typeof e.timestamp === "string" && Number.isFinite(Date.parse(e.timestamp)));
}
function validCalendar(value: unknown): value is EconomicCalendarSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<EconomicCalendarSnapshot>;
  return data.connected === true && data.source === "forex_factory" && validEvents(data.events) &&
    (data.recentEvents === undefined || validEvents(data.recentEvents)) &&
    (data.coverageUntil === null || typeof data.coverageUntil === "string" && Number.isFinite(Date.parse(data.coverageUntil)));
}
function currentSnapshot(data: EconomicCalendarSnapshot, now: number) {
  // A cached upcoming release may have passed since the response was saved.
  return buildCalendarSnapshot({ events: [...(data.recentEvents ?? []), ...data.events], source: data.source,
    connected: data.connected, coverageUntil: data.coverageUntil, now: new Date(now) });
}

/** Public calendar data only. Shares requests and persists fresh results for this browser tab. */
export function createEconomicCalendarCache(read: () => Promise<EconomicCalendarSnapshot>, options: {
  now?: () => number; storage?: () => CalendarStorage;
} = {}) {
  const now = options.now ?? Date.now;
  let cached: CachedCalendar | null = null;
  let pending: Promise<EconomicCalendarSnapshot> | null = null;
  let restored = false, retryAt = 0;
  let lastError: unknown = null;
  const fresh = (entry: CachedCalendar) => entry.fetchedAt <= now() && now() - entry.fetchedAt < CALENDAR_CACHE_TTL_MS;

  function restore() {
    if (restored) return;
    restored = true;
    try {
      const raw = options.storage?.().getItem(STORAGE_KEY);
      const entry: unknown = raw ? JSON.parse(raw) : null;
      if (entry && typeof entry === "object" && "data" in entry && "fetchedAt" in entry &&
        typeof entry.fetchedAt === "number" && validCalendar(entry.data) && fresh(entry as CachedCalendar)) cached = entry as CachedCalendar;
    } catch { /* Storage may be blocked, full, or contain an old/corrupt record. */ }
  }

  return {
    load(force = false): Promise<EconomicCalendarSnapshot> {
      restore();
      if (pending) return pending;
      if (!force && cached && fresh(cached)) return Promise.resolve(currentSnapshot(cached.data, now()));
      if (now() < retryAt) return Promise.reject(lastError);
      pending = Promise.resolve().then(read).then(data => {
        if (!validCalendar(data)) throw new Error("The news calendar is unavailable.");
        cached = { data, fetchedAt: now() };
        retryAt = 0;
        try { options.storage?.().setItem(STORAGE_KEY, JSON.stringify(cached)); } catch { /* In-memory caching still works. */ }
        return currentSnapshot(data, now());
      }).catch(error => {
        lastError = error;
        retryAt = now() + RETRY_DELAY_MS;
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
