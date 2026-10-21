import assert from "node:assert/strict";
import { createWatchlistDailyCache, WATCHLIST_DAILY_TTL_MS, type WatchlistDay } from "../src/lib/watchlist-daily-cache";

async function main() {
  let now = Date.parse("2026-10-21T12:00:00Z"), reads = 0;
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
  };
  const day: WatchlistDay = { change: 0.2, high: 1.2, low: 1.1, close: 1.15, spark: [1.12, 1.15] };
  const read = async () => { reads++; return day; };
  const options = { now: () => now, storage: () => storage };
  const cache = createWatchlistDailyCache(read, options);
  assert.equal(cache.peek("EUR_USD"), null);
  await Promise.all([cache.load("EUR_USD"), cache.load("EUR_USD"), cache.load("EUR_USD")]);
  assert.equal(reads, 1, "concurrent mounts share the same pair request");
  await cache.load("EUR_USD");
  const reloaded = createWatchlistDailyCache(read, options);
  assert.deepEqual(reloaded.peek("EUR_USD"), day, "fresh rows restore before network work");
  await reloaded.load("EUR_USD");
  assert.equal(reads, 1, "navigation and reload reuse fresh candles");
  await cache.load("GBP_USD");
  assert.equal(reads, 2, "pairs have independent entries");
  await Promise.all([cache.load("EUR_USD", true), cache.load("EUR_USD", true)]);
  assert.equal(reads, 3, "foreground/manual refresh bypasses TTL and shares pending work");
  now += WATCHLIST_DAILY_TTL_MS;
  assert.equal(cache.peek("EUR_USD"), null, "expired data is not restored");
  await cache.load("EUR_USD");
  assert.equal(reads, 4, "expired candles refresh");

  const key = [...records.keys()].find(key => key.endsWith("EUR_USD"))!;
  for (const value of ["{broken", JSON.stringify({ fetchedAt: now + 1, data: day }),
    JSON.stringify({ fetchedAt: now, data: { ...day, close: "bad" } }),
    JSON.stringify({ fetchedAt: now, data: { ...day, spark: ["bad", 1] } })]) {
    records.set(key, value);
    const before = reads;
    await createWatchlistDailyCache(read, options).load("EUR_USD");
    assert.equal(reads, before + 1, "invalid stored entries are ignored");
  }
  let attempts = 0;
  const recovery = createWatchlistDailyCache(async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    return day;
  });
  await assert.rejects(recovery.load("EUR_USD"), /offline/);
  await recovery.load("EUR_USD");
  assert.equal(attempts, 2, "failed requests remain retryable");

  let partialReads = 0;
  const partial = createWatchlistDailyCache(async () => { partialReads++; return { ...day, spark: null }; });
  await partial.load("EUR_USD"); await partial.load("EUR_USD");
  assert.equal(partialReads, 2, "partial data displays but is not cached");
  assert.equal(partial.peek("EUR_USD"), null);

  const blocked = createWatchlistDailyCache(read, { storage: () => { throw new Error("blocked"); } });
  const before = reads;
  await blocked.load("EUR_USD"); await blocked.load("EUR_USD");
  assert.equal(reads, before + 1, "blocked storage still permits memory reuse");
  console.log("Watchlist cache passed: deduplication, reload reuse, pair isolation, expiry, forced refresh, invalid data, recovery and blocked storage.");
}
void main();
