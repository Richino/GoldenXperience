import assert from "node:assert/strict";
import { createPairTrendsCache, PAIR_TRENDS_TTL_MS } from "../src/lib/home/pair-trends-cache";
import type { PairTrendsSnapshot } from "../src/components/dashboard/morning-market-picks";

async function main() {
  let now = Date.parse("2026-10-21T12:00:00Z"), reads = 0;
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
  };
  const snapshot = (): PairTrendsSnapshot => ({ checkedAt: new Date(now).toISOString(),
    pairs: [{ instrument: "EUR_USD", h4: "UPTREND", d1: "UPTREND", w1: "UPTREND" }] });
  const read = async () => { reads++; return snapshot(); };
  const options = { now: () => now, storage: () => storage };
  const cache = createPairTrendsCache(read, options);
  await Promise.all([cache.load(), cache.load(), cache.load()]);
  assert.equal(reads, 1, "concurrent consumers share one request");
  now += PAIR_TRENDS_TTL_MS - 1;
  await cache.load();
  await createPairTrendsCache(read, options).load();
  assert.equal(reads, 1, "navigation and reloads reuse a fresh snapshot");
  now++;
  await cache.load();
  assert.equal(reads, 2, "expired snapshots require a new request");

  const key = [...records.keys()][0]!;
  for (const value of ["{broken", JSON.stringify({ checkedAt: new Date(now + 1).toISOString(), pairs: snapshot().pairs }),
    JSON.stringify({ checkedAt: new Date(now).toISOString(), pairs: [{ instrument: "EUR_USD", h4: "invented", d1: "UPTREND", w1: "UPTREND" }] }),
    JSON.stringify({ checkedAt: new Date(now).toISOString(), pairs: [{ instrument: "EUR_USD", h4: "UPTREND", d1: "UPTREND" }] })]) {
    records.set(key, value);
    const before = reads;
    await createPairTrendsCache(read, options).load();
    assert.equal(reads, before + 1, "corrupt, future-dated and invalid stored data are ignored");
  }
  let attempts = 0;
  const failures = createPairTrendsCache(async () => {
    attempts++;
    if (attempts === 1) throw new Error("offline");
    return snapshot();
  }, { now: () => now });
  await assert.rejects(failures.load(), /offline/);
  await failures.load();
  assert.equal(attempts, 2, "failed reads do not poison the cache");

  let emptyReads = 0;
  const empty = createPairTrendsCache(async () => { emptyReads++; return { checkedAt: new Date(now).toISOString(), pairs: [] }; }, { now: () => now });
  await empty.load(); await empty.load();
  assert.equal(emptyReads, 2, "unavailable empty snapshots are not cached");
  const blocked = createPairTrendsCache(read, { now: () => now, storage: () => { throw new Error("blocked"); } });
  const before = reads;
  await blocked.load(); await blocked.load();
  assert.equal(reads, before + 1, "blocked storage still permits in-memory reuse");
  console.log("Pair trends cache passed: deduplication, navigation/reload reuse, TTL, invalid records, recovery and blocked storage.");
}
void main();
