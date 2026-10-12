import assert from "node:assert/strict";
import type { ObserverPlan, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import type { MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import { conditionalPullbackPlan, evaluateObserverPlan, resumeObserverPlan } from "../src/market-observer-plan.js";
const start = Date.parse("2026-10-05T16:00:00Z"), iso = (ms = 0) => new Date(start + ms).toISOString();
const base: ObserverPlan = { id: "test", version: 1, instrument: "EUR_USD", mode: "NORMAL", createdAt: iso(), updatedAt: iso(), expiresAt: iso(3_600_000), status: "WATCHING", resumeStatus: "WATCHING",
  direction: null, reason: "Unconfirmed", thesis: "Unconfirmed", zone: null, entry: null, stop: null, target: null, trigger: null, invalidation: "Unknown", lastEvaluatedCandle: null, confirmationCandle: null, triggeredAt: null, observedEntry: null, outcome: null, facts: [] };
// Deterministic foundation fixture: clear trend, an observed support zone and a real swing target.
const zone = { low: 1.1000, high: 1.1003, status: "ACTIVE" };
const analysis = { pair: "EUR_USD", v2: { foundation: { primary: { sufficient: true, timeframe: "M15", direction: "UPTREND", atr: 0.0005, structureLevel: 1.0998, close: 1.101, lastSwingHigh: { price: 1.103 } },
  alignment: "ALIGNED", referencePrice: 1.101, zones: [zone], pullback: { state: "DEVELOPING", nextZone: zone }, data: { checks: [{ id: "primary-history", status: "PASS" }, { id: "quote", status: "UNKNOWN" }] } } } } as unknown as MarketAnalysis;
const plan = conditionalPullbackPlan(analysis, base)!;
assert.ok(plan); assert.equal(plan.direction, "long"); assert.ok(plan.entry! > plan.stop! && plan.target! > plan.entry!);
assert.equal(plan.pullback!.touchedAt, null, "Creation cannot invent a previous area touch");
assert.equal(plan.status, "WATCHING", "A missing quote blocks readiness, not provisional geometry");
const geometry = (p: ObserverPlan) => [p.entry, p.stop, p.target, p.zone, p.trigger, p.pullback?.zone];
const read = (ms: number, entry: number, blockers: string[] = []): ObserverRead => ({ version: "test", instrument: "EUR_USD", asOf: iso(ms), state: "live", lean: "up", headline: "Up", changedAt: iso(), revision: 1,
  facts: [], blockers, changeConditions: [], quote: { bid: entry - 0.00002, ask: entry, time: iso(ms), spreadPips: 0.2 }, pressure: { direction: "unknown", observedDirection: "unknown", covered: false, pending: false, relation: "unknown" }, movement: [], patterns: [], ai: { state: "disabled", text: null, at: null, factIds: [] } });
const bar = (ms: number): Candle => ({ time: iso(ms), complete: true, close: plan.trigger!.boundary + 0.00001, open: 1.1001, low: 1.1, high: 1.1006, volume: 1 });
let current = evaluateObserverPlan(plan, read(100, 1.101, ["Pressure window warming"]), []);
assert.equal(current.status, "PAUSED"); assert.equal(current.pullback!.phase, "approaching");
current = evaluateObserverPlan(current, read(200, 1.1002, ["Pressure window warming"]), []);
assert.equal(current.pullback!.phase, "testing"); assert.equal(current.pullback!.touchedAt, iso(200));
assert.equal(current.pullback!.receivedQuotes, 2);
const duplicate = evaluateObserverPlan(current, read(200, 1.1002, ["Pressure window warming"]), []);
assert.equal(duplicate.pullback!.receivedQuotes, 2, "Timer passes cannot count as broker ticks");
current = evaluateObserverPlan(current, read(300, plan.entry!, ["News coverage unknown"]), []);
assert.equal(current.pullback!.phase, "rebounding"); assert.equal(current.pullback!.move, "up"); assert.equal(current.triggeredAt, null);
current = evaluateObserverPlan(current, read(301_000, plan.entry!), [bar(0)]);
assert.equal(current.triggeredAt, null, "A candle starting before the zone test cannot confirm");
current = evaluateObserverPlan(current, read(601_000, plan.entry!), [bar(300_000)]);
assert.equal(current.status, "TRIGGERED"); assert.equal(current.pullback!.phase, "confirmed");
assert.deepEqual(geometry(current), geometry(plan), "Every level stays frozen through testing and confirmation");
const noTouch = evaluateObserverPlan(plan, read(601_000, plan.entry!), [bar(300_000)]);
assert.equal(noTouch.triggeredAt, null, "A confirming close cannot substitute for an observed zone touch");
const cancelled = evaluateObserverPlan(plan, read(100, plan.stop!, ["Warming"]), []);
assert.equal(cancelled.status, "INVALIDATED");
assert.equal(evaluateObserverPlan(plan, read(3_600_000, plan.entry!), []).status, "EXPIRED");
const interrupted = evaluateObserverPlan(plan, { ...read(500, 1.1002), quote: null }, []);
assert.equal(interrupted.pullback!.phase, "unavailable"); assert.equal(interrupted.pullback!.touchedAt, null);
const restarted = resumeObserverPlan(current, iso(602_000)); assert.equal(restarted.outcome?.kind, "unknown_after_gap");
const beforeRestart = evaluateObserverPlan(plan, read(200, 1.1002), []);
const restartedBeforeEntry = resumeObserverPlan(beforeRestart, iso(300));
assert.equal(restartedBeforeEntry.pullback!.touchedAt, null, "Restart loses the earlier zone test");
assert.equal(evaluateObserverPlan(restartedBeforeEntry, read(901_000, plan.entry!), [bar(600_000)]).triggeredAt, null, "Restart requires a new observed zone visit");
const shortPlan: ObserverPlan = { ...plan, direction: "short", entry: 1.1000, stop: 1.101, target: 1.098,
  zone: { low: 1.09975, high: 1.10025 }, trigger: { timeframe: "M5", boundary: 1.1000, after: iso() },
  pullback: { ...plan.pullback!, zone: { low: 1.1002, high: 1.1005 } } };
let shortRead = read(100, 1.10032); // bid 1.10030 is inside the short pullback area
let short = evaluateObserverPlan(shortPlan, shortRead, []);
assert.equal(short.pullback!.phase, "testing");
shortRead = read(601_000, 1.09999); // bid 1.09997 has rebounded downward
short = evaluateObserverPlan(short, shortRead, [{ ...bar(300_000), close: 1.09995 }]);
assert.equal(short.status, "TRIGGERED"); assert.equal(short.observedEntry, shortRead.quote!.bid, "Short confirmation uses executable bid");
const unsafe = structuredClone(analysis); unsafe.v2!.foundation.alignment = "OPPOSED";
assert.equal(conditionalPullbackPlan(unsafe, base), null);
unsafe.v2!.foundation.alignment = "ALIGNED"; unsafe.v2!.foundation.data.checks[0].status = "FAIL";
assert.equal(conditionalPullbackPlan(unsafe, base), null);
console.log("Pullback monitor passed: provisional planning without ticks, frozen prices, per-quote area tests, duplicate suppression, post-touch confirmation, blockers, invalidation, expiry and interruptions.");
