export type WatchlistDay = {
  change: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  spark: number[] | null;
};

export const WATCHLIST_DAILY_TTL_MS = 60_000;
const STORAGE_PREFIX = "gx:watchlist-daily:v1:";
type Entry = { data: WatchlistDay; fetchedAt: number };

function completeDay(value: unknown): value is WatchlistDay {
  if (!value || typeof value !== "object") return false;
  const day = value as WatchlistDay;
  return [day.change, day.high, day.low, day.close].every(value => typeof value === "number" && Number.isFinite(value)) &&
    day.close! > 0 && day.high! >= day.low! && Array.isArray(day.spark) && day.spark.length >= 2 &&
    day.spark.every(value => typeof value === "number" && Number.isFinite(value));
}

/** Public candles only: account, setup and live bid/ask data never enter this cache. */
export function createWatchlistDailyCache(read: (instrument: string) => Promise<WatchlistDay>, options: {
  now?: () => number;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
} = {}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<WatchlistDay>>();
  const fresh = (entry: Entry) => Number.isFinite(entry.fetchedAt) && entry.fetchedAt <= now() &&
    now() - entry.fetchedAt < WATCHLIST_DAILY_TTL_MS;

  function peek(instrument: string): WatchlistDay | null {
    const entry = entries.get(instrument);
    if (entry && fresh(entry)) return entry.data;
    entries.delete(instrument);
    try {
      const raw = options.storage?.().getItem(STORAGE_PREFIX + instrument);
      const stored: unknown = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === "object" && "data" in stored && "fetchedAt" in stored &&
        typeof stored.fetchedAt === "number" && completeDay(stored.data) && fresh(stored as Entry)) {
        entries.set(instrument, stored as Entry);
        return stored.data;
      }
    } catch { /* Storage is optional and may contain corrupt or outdated data. */ }
    return null;
  }

  return {
    peek,
    load(instrument: string, force = false): Promise<WatchlistDay> {
      const inFlight = pending.get(instrument);
      if (inFlight) return inFlight;
      const cached = force ? null : peek(instrument);
      if (cached) return Promise.resolve(cached);
      const request = Promise.resolve().then(() => read(instrument)).then(data => {
        // Partial failures stay retryable; never persist an unavailable candle response.
        if (completeDay(data)) {
          const entry = { data, fetchedAt: now() };
          entries.set(instrument, entry);
          try { options.storage?.().setItem(STORAGE_PREFIX + instrument, JSON.stringify(entry)); } catch { /* Keep memory reuse. */ }
        }
        return data;
      }).finally(() => { pending.delete(instrument); });
      pending.set(instrument, request);
      return request;
    },
  };
}
