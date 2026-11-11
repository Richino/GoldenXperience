import type { PairTrendsSnapshot } from "../../frontend/src/lib/home/weekly-trends.js";
import { pairTrendSnapshotIsCurrent } from "../../frontend/src/lib/home/pair-trend-clock.js";

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
  let coverageRetryAt: number | null = null;
  const fresh = () => latest && (coverageRetryAt === null || now() < coverageRetryAt) && pairTrendSnapshotIsCurrent(latest.checkedAt, now());
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
      if (fresh()) return Promise.resolve();
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
          const scanned = new Set(result.pairs.map(pair => pair.instrument));
          const coverageDropped = latest?.pairs.some(pair => !scanned.has(pair.instrument));
          await deps.save(result);
          latest = result;
          loadedAt = now();
          // Give recently covered pairs another chance after a partial failure.
          coverageRetryAt = coverageDropped ? loadedAt + 15 * 60_000 : null;
          failed = false;
        } finally { await unlock(); }
      })().catch(error => { failed = true; deps.failed?.(error); }).finally(() => { running = null; });
      return running;
    },
  };
}
