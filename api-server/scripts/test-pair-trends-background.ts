import assert from "node:assert/strict";
import { createPairTrendsRunner, PAIR_TRENDS_REFRESH_MS } from "../src/pair-trends-runner.js";
import type { PairTrendsSnapshot } from "../../frontend/src/lib/home/weekly-trends.js";

let now = Date.parse("2026-10-23T04:00:00Z"), scans = 0, saves = 0, locks = 0, unlocks = 0;
let saved: PairTrendsSnapshot | null = null;
const snapshot = (): PairTrendsSnapshot => ({ checkedAt: new Date(now).toISOString(), pairs: [{ instrument: "EUR_USD", w1: "UPTREND", d1: "UPTREND", h4: "RANGE" }] });
let finish: ((snapshot: PairTrendsSnapshot) => void) | null = null;
let scanFails = false, lockAvailable = true, storeFails = false;
const dependencies = {
  now: () => now,
  scan: async () => { scans++; if (scanFails) throw new Error("provider unavailable"); return new Promise<PairTrendsSnapshot>(resolve => { finish = resolve; }); },
  load: async () => { if (storeFails) throw new Error("database offline"); return saved; },
  save: async (value: PairTrendsSnapshot) => { if (storeFails) throw new Error("database offline"); saves++; saved = value; },
  lock: async () => { locks++; return lockAvailable ? async () => { unlocks++; } : null; },
};
const runner = createPairTrendsRunner(dependencies);
assert.equal((await runner.read()).scanStatus, "warming");
assert.equal(scans, 0, "HTTP reads never start broker scans");
const initial = runner.refresh();
assert.equal(runner.refresh(), initial, "simultaneous ticks share one scan");
for (let i = 0; i < 12 && !finish; i++) await Promise.resolve();
assert.equal(scans, 1);
assert.equal((await runner.read()).scanStatus, "warming", "HTTP reads do not await in-flight broker work");
finish!(snapshot());
await initial;
assert.equal(saves, 1);
assert.equal(unlocks, 1);
assert.equal((await runner.read()).pairs.length, 1);
await runner.refresh();
assert.equal(scans, 1, "fresh snapshots skip expensive scans");
const restarted = createPairTrendsRunner(dependencies);
assert.equal((await restarted.read()).checkedAt, saved!.checkedAt, "a server restart restores durable results");
assert.equal(scans, 1);
now += PAIR_TRENDS_REFRESH_MS;
scanFails = true;
await runner.refresh();
assert.equal(runner.health().failed, true);
assert.equal((await runner.read()).checkedAt, saved!.checkedAt, "a failed refresh preserves the actual last-check timestamp");
assert.equal(saves, 1);
storeFails = true;
now += 30_001;
assert.equal((await runner.read()).pairs.length, 1, "database outage preserves a verified memory snapshot");
storeFails = false;
lockAvailable = false;
const before = scans;
await runner.refresh();
assert.equal(scans, before, "another replica's lock prevents duplicate broker work");
lockAvailable = true;
scanFails = false;
finish = null;
const empty = runner.refresh();
for (let i = 0; i < 12 && !finish; i++) await Promise.resolve();
finish!({ checkedAt: new Date(now).toISOString(), pairs: [] });
await empty;
assert.equal(saves, 1, "an all-pair provider outage cannot overwrite a good snapshot with empty data");
const recovered = runner.refresh();
finish = null;
for (let i = 0; i < 12 && !finish; i++) await Promise.resolve();
finish!(snapshot());
await recovered;
assert.equal(runner.health().failed, false);
assert.equal(saves, 2);
assert.equal(unlocks, locks - 1, "locks are released on success and failure; a skipped lock needs no release");
console.log("Background trends passed: request independence, startup/tick refresh, persistence, restart recovery, single-flight, replica locking and outage retention.");
