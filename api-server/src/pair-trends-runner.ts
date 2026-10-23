import type { PairTrendsSnapshot } from "../../frontend/src/lib/home/weekly-trends.js";

export const PAIR_TRENDS_REFRESH_MS = 15 * 60_000;

/** Reads never start or wait for a broker scan. The API owns refreshing this public snapshot. */
export function createPairTrendsRunner(deps: {
  scan: () => Promise<PairTrendsSnapshot>;
  load: () => Promise<PairTrendsSnapshot | null>;
  save: (snapshot: PairTrendsSnapshot) => Promise<void>;
  lock: () => Promise<(() => Promise<void>) | null>;
  now?: () => number;
  failed?: (error: unknown) => void;
}) {
  const now = deps.now ?? Date.now;
  let latest: PairTrendsSnapshot | null = null;
  let loadedAt = -Infinity;
  let restoring: Promise<void> | null = null;
  let running: Promise<void> | null = null;
  let failed = false;
  const fresh = () => latest && now() - Date.parse(latest.checkedAt) >= 0 && now() - Date.parse(latest.checkedAt) < PAIR_TRENDS_REFRESH_MS;
  const restore = (force = false) => {
    if (restoring) return restoring;
    if (!force && latest && now() - loadedAt < 30_000) return Promise.resolve();
    restoring = deps.load().then(saved => {
      if (saved && (!latest || Date.parse(saved.checkedAt) > Date.parse(latest.checkedAt))) latest = saved;
      loadedAt = now();
    }).finally(() => { restoring = null; });
    return restoring;
  };
  const health = () => ({ refreshing: running !== null, checkedAt: latest?.checkedAt ?? null, pairs: latest?.pairs.length ?? 0, failed });
  return {
    health,
    async read(): Promise<PairTrendsSnapshot> {
      try { await restore(); } catch { /* A transient DB outage must not discard a verified in-memory snapshot. */ }
      if (latest) return { ...latest, refreshing: running !== null };
      return { checkedAt: new Date(now()).toISOString(), pairs: [], scanStatus: failed ? "unavailable" : "warming", refreshing: running !== null };
    },
    refresh(): Promise<void> {
      if (running) return running;
      running = (async () => {
        await restore(true);
        if (fresh()) return;
        const unlock = await deps.lock();
        if (!unlock) return; // Another API instance owns this scan.
        try {
          await restore(true);
          if (fresh()) return;
          const result = await deps.scan();
          if (!result.pairs.length) throw new Error("No verified trend data returned");
          await deps.save(result);
          latest = result;
          loadedAt = now();
          failed = false;
        } finally { await unlock(); }
      })().catch(error => { failed = true; deps.failed?.(error); }).finally(() => { running = null; });
      return running;
    },
  };
}
