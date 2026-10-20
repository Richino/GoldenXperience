import assert from "node:assert/strict";
import { buildCalendarSnapshot, type EconomicCalendarSnapshot } from "../src/lib/oanda/calendar";
import { CALENDAR_CACHE_TTL_MS, createEconomicCalendarCache } from "../src/lib/oanda/economic-calendar-cache";

async function main() {
  let now = Date.parse("2026-10-19T12:00:00Z"), reads = 0;
  const releaseAt = now + 2 * 60_000;
  const data = buildCalendarSnapshot({ source: "forex_factory", connected: true, now: new Date(now),
    coverageUntil: "2026-10-23T23:59:00Z", events: [{ id: "cpi", title: "CPI", currency: "USD", region: "americas",
      impact: 3, timestamp: new Date(releaseAt).toISOString(), timingVerified: true,
      forecast: null, previous: null, actual: null, unit: null }] });
  const records = new Map<string, string>();
  const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
  const read = async () => { reads++; return data; };
  const options = { now: () => now, storage: () => storage };
  const cache = createEconomicCalendarCache(read, options);
  await Promise.all([cache.load(), cache.load(), cache.load()]);
  assert.equal(reads, 1, "concurrent Home/chart/ticket mounts share a request");
  await cache.load(); assert.equal(reads, 1, "navigation reuses the fresh calendar");
  const reloaded = createEconomicCalendarCache(read, options);
  await reloaded.load(); assert.equal(reads, 1, "page refresh restores this tab's persisted cache");

  now = releaseAt + 1;
  const afterRelease = await cache.load();
  assert.equal(reads, 1); assert.equal(afterRelease.events.length, 0);
  assert.equal(afterRelease.recentEvents?.[0]?.id, "cpi", "a cached release moves from upcoming to released without a request");
  assert.equal(afterRelease.highImpactNewsWithinMinutes, null, "derived warnings do not retain an outdated countdown");
  now += CALENDAR_CACHE_TTL_MS;
  await cache.load(); assert.equal(reads, 2, "expiry refreshes the calendar");
  await Promise.all([cache.load(true), cache.load(true)]);
  assert.equal(reads, 3, "explicit refresh bypasses freshness but shares the pending request");

  let failures = 0;
  const offline = createEconomicCalendarCache(async () => { failures++; throw new Error("offline"); }, { now: () => now });
  await assert.rejects(offline.load(), /offline/);
  await assert.rejects(offline.load(), /offline/);
  assert.equal(failures, 1, "repeated mounts do not hammer an unavailable endpoint");
  now += 60_000;
  await assert.rejects(offline.load(), /offline/); assert.equal(failures, 2, "failed reads can retry after cooldown");

  const unavailable = createEconomicCalendarCache(async () => ({ ...data, connected: false }), { now: () => now });
  await assert.rejects(unavailable.load(), /unavailable/, "a disconnected fallback is never cached as verified news");
  const invalid = createEconomicCalendarCache(read, { now: () => now, storage: () => ({ ...storage, getItem: () => "invalid JSON" }) });
  await invalid.load(); assert.equal(reads, 4, "corrupt browser storage falls back to a network read");
  const blocked = createEconomicCalendarCache(read, { now: () => now, storage: () => { throw new Error("blocked"); } });
  await blocked.load(); await blocked.load(); assert.equal(reads, 5, "blocked storage still allows in-memory caching");

  const expiredRecords = new Map(records);
  now += CALENDAR_CACHE_TTL_MS;
  const expired = createEconomicCalendarCache(read, { now: () => now, storage: () => ({ ...storage, getItem: key => expiredRecords.get(key) ?? null }) });
  await expired.load(); assert.equal(reads, 6, "expired persisted data cannot bypass a fresh read");

  let healthy = true;
  const recovery = createEconomicCalendarCache(async (): Promise<EconomicCalendarSnapshot> => {
    if (!healthy) throw new Error("offline");
    return data;
  }, options);
  await recovery.load();
  healthy = false;
  await assert.rejects(recovery.load(true), /offline/);
  const preserved = createEconomicCalendarCache(read, options);
  await preserved.load(); assert.equal(reads, 6, "a failed refresh does not overwrite the last successful stored calendar");
  console.log("Economic calendar cache checks passed: shared reads, persistence, expiry, release transitions, explicit refresh and failure recovery.");
}

void main();
