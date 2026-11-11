import type { PairTrendsSnapshot } from "@/lib/home/weekly-trends";
import { pairTrendSnapshotIsCurrent } from "./pair-trend-clock";

export const PAIR_TRENDS_TTL_MS = 15 * 60_000;
const STORAGE_KEY = "gx:pair-trends:v2";
const DIRECTIONS = new Set(["UPTREND", "DOWNTREND", "RANGE", "TRANSITION", "UNCLEAR"]);

function validSnapshot(value: unknown): value is PairTrendsSnapshot {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<PairTrendsSnapshot>;
  return typeof data.checkedAt === "string" && Number.isFinite(Date.parse(data.checkedAt)) &&
    Array.isArray(data.pairs) && data.pairs.every(pair => pair && typeof pair.instrument === "string" &&
      DIRECTIONS.has(pair.h4) && DIRECTIONS.has(pair.d1) && DIRECTIONS.has(pair.w1));
}

/** Public trend data only; never stores account, position, or order data. */
export function createPairTrendsCache(read: () => Promise<PairTrendsSnapshot>, options: {
  now?: () => number;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
} = {}) {
  const now = options.now ?? Date.now;
  let cached: PairTrendsSnapshot | null = null;
  let cachedAt = 0;
  let pending: Promise<PairTrendsSnapshot> | null = null;
  let restored = false;
  const fresh = (data: PairTrendsSnapshot, readAt: number) => {
    const currentTime = now();
    const age = currentTime - readAt;
    return data.pairs.length > 0 && age >= 0 && age < PAIR_TRENDS_TTL_MS && pairTrendSnapshotIsCurrent(data.checkedAt, currentTime);
  };

  return {
    load(): Promise<PairTrendsSnapshot> {
      if (!restored) {
        restored = true;
        try {
          const raw = options.storage?.().getItem(STORAGE_KEY);
          const data: unknown = raw ? JSON.parse(raw) : null;
          if (validSnapshot(data) && fresh(data, Date.parse(data.checkedAt))) {
            cached = data;
            cachedAt = Date.parse(data.checkedAt);
          }
        } catch { /* Storage is optional and may contain an old or corrupt record. */ }
      }
      if (pending) return pending;
      if (cached && fresh(cached, cachedAt)) return Promise.resolve(cached);
      pending = Promise.resolve().then(read).then(data => {
        if (!validSnapshot(data)) throw new Error("Invalid trend snapshot");
        cachedAt = now();
        cached = fresh(data, cachedAt) ? data : null;
        if (cached) {
          try { options.storage?.().setItem(STORAGE_KEY, JSON.stringify(cached)); } catch { /* Keep the in-memory cache. */ }
        }
        return data;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
