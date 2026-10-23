import assert from "node:assert/strict";
import { createPairTrendReadCache, TREND_READ_TTL_MS, type PairTrend } from "../src/lib/pair-trend-read-cache";

async function main() {
  let now = Date.parse("2026-10-23T03:00:00Z"), requests = 0;
  const records = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } });
  const snapshot = (): PairTrend => ({ asOf: new Date(now).toISOString(),
    w1: { timeframe: "Weekly", direction: "UPTREND", closeTime: "2026-10-09T21:00:00Z", evidence: [] },
    d1: { timeframe: "Daily", direction: "UPTREND", closeTime: "2026-10-21T21:00:00Z", evidence: [] },
    h4: { timeframe: "4H", direction: "RANGE", closeTime: "2026-10-22T21:00:00Z", evidence: [] } });
  const reader = async () => { requests++; return snapshot(); };
  const options = { now: () => now, storage };
  const cache = createPairTrendReadCache(reader, options);
  const initial = cache.load("EUR_USD");
  assert.equal(cache.load("EUR_USD"), initial, "preloading, header and picker share in-flight requests");
  await initial;
  await cache.load("EUR_USD");
  assert.equal(requests, 1, "reopening within TTL never refetches");
  const remounted = createPairTrendReadCache(reader, options);
  assert.deepEqual(remounted.peek("EUR_USD"), snapshot(), "remount/reload restores usable rows synchronously");
  await remounted.load("EUR_USD");
  assert.equal(requests, 1);
  assert.equal(remounted.peek("GBP_USD"), null, "one pair must not inherit another pair's data");
  now += TREND_READ_TTL_MS;
  assert.equal(cache.peek("EUR_USD"), null, "expired reads cannot be presented as freshly cached");
  await cache.load("EUR_USD");
  assert.equal(requests, 2);
  const key = [...records.keys()][0]!;
  for (const invalid of ["{broken", JSON.stringify({ instrument: "GBP_USD", value: snapshot() }),
    JSON.stringify({ instrument: "EUR_USD", value: { ...snapshot(), asOf: new Date(now + 1).toISOString() } }),
    JSON.stringify({ instrument: "EUR_USD", value: { ...snapshot(), w1: { ...snapshot().w1, direction: "invented" } } })]) {
    records.set(key, invalid);
    assert.equal(createPairTrendReadCache(reader, options).peek("EUR_USD"), null);
  }
  let failures = 0;
  const retry = createPairTrendReadCache(async () => { failures++; if (failures === 1) throw new Error("offline"); return snapshot(); }, { now: () => now });
  await assert.rejects(retry.load("EUR_USD"));
  await retry.load("EUR_USD");
  assert.equal(failures, 2, "failures must not poison the shared promise");
  const unavailable = createPairTrendReadCache(async () => ({ ...snapshot(), w1: null }), { now: () => now });
  await unavailable.load("EUR_USD");
  assert.equal(unavailable.peek("EUR_USD"), null, "missing timeframes must be retried, not persisted");
  const blocked = createPairTrendReadCache(reader, { now: () => now, storage: () => { throw new Error("storage blocked"); } });
  await blocked.load("EUR_USD");
  assert.ok(blocked.peek("EUR_USD"), "blocked storage still permits memory caching");
  console.log("Pair trend read cache passed: preload deduplication, reopen/reload reuse, expiry, invalid storage, retry and partial-data handling.");
}
void main();
