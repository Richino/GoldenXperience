import assert from "node:assert/strict";
import { createImpactCache } from "../src/lib/news/impact-cache";

async function main() {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const cache = createImpactCache<number>(2);
    let reads = 0;
    const read = async () => ++reads;
    const ttl = () => 30_000;
    assert.deepEqual(await Promise.all([cache.load("event-a", read, ttl), cache.load("event-a", read, ttl)]), [1, 1]);
    assert.equal(reads, 1, "concurrent opens share one request");
    now += 29_999;
    assert.equal(await cache.load("event-a", read, ttl), 1, "reopen uses fresh data");
    now += 1;
    assert.equal(await cache.load("event-a", read, ttl), 2, "live data refreshes at expiry");
    assert.equal(await cache.load("event-b", read, ttl), 3, "another event has separate data");
    await assert.rejects(cache.load("failed", async () => { throw new Error("offline"); }, ttl));
    assert.equal(await cache.load("failed", read, ttl), 4, "failed reads can retry");
    assert.equal(await cache.load("event-a", read, ttl), 5, "oldest result is evicted at the limit");
    console.log("News impact cache checks passed.");
  } finally {
    Date.now = originalNow;
  }
}

void main();
