import assert from "node:assert/strict";
import type { ObserverPlan, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import { evaluateObserverPlan, observerPlanChecks, resumeObserverPlan, stopObserverPlan } from "../src/market-observer-plan.js";
import { MarketObserverService } from "../src/market-observer-service.js";

const start = Date.parse("2026-10-05T16:00:00Z"), iso = (ms = 0) => new Date(start + ms).toISOString();
const plan: ObserverPlan = { id: "plan", version: 1, instrument: "EUR_USD", mode: "NORMAL", createdAt: iso(), updatedAt: iso(), expiresAt: iso(1_800_000),
  status: "WATCHING", resumeStatus: "WATCHING", direction: "long", reason: "Watching", thesis: "Frozen hypothesis", zone: { low: 1.1, high: 1.1003 }, entry: 1.1001, stop: 1.099, target: 1.102,
  trigger: { timeframe: "M5", boundary: 1.1002, after: iso() }, invalidation: "Bid at or below frozen stop", lastEvaluatedCandle: null, confirmationCandle: null,
  triggeredAt: null, observedEntry: null, outcome: null, facts: ["original fact"] };
const read = (ms: number, bid = 1.10005, ask = 1.1001): ObserverRead => ({ version: "fixture", instrument: plan.instrument, asOf: iso(ms), state: "live", lean: "up", headline: "Leaning up",
  changedAt: iso(), revision: 1, facts: [], blockers: [], changeConditions: [], pressure: { direction: "up", observedDirection: "up", covered: true, pending: false, relation: "aligned" },
  quote: { bid, ask, time: iso(ms), spreadPips: (ask - bid) / 0.0001 }, movement: [], patterns: [], ai: { state: "disabled", text: null, at: null, factIds: [] } });
const candle = (ms: number, close = 1.1004): Candle => ({ time: iso(ms), open: 1.1, high: 1.1005, low: 1.0999, close, complete: true, volume: 0 });
const geometry = (p: ObserverPlan) => [p.entry, p.zone, p.stop, p.target, p.trigger, p.thesis, p.facts];
const copy = structuredClone(plan);
const confirmed = evaluateObserverPlan(plan, read(301_000, 1.1004, 1.10045), [candle(0)]);
assert.equal(confirmed.status, "WATCHING"); assert.equal(confirmed.confirmationCandle, iso());
assert.match(confirmed.reason, /Candle confirmed/);
assert.equal(evaluateObserverPlan(confirmed, read(599_999), []).status, "TRIGGERED");
assert.equal(evaluateObserverPlan(confirmed, read(600_000), []).status, "READY", "Confirmation expires exactly at next interval boundary");
assert.equal(evaluateObserverPlan(plan, read(299_999), [candle(0)]).status, "READY", "No early closed candle despite complete flag");
assert.equal(evaluateObserverPlan(plan, read(601_000), [candle(300_000, 1.1), candle(0)]).status, "READY", "Latest non-confirming close clears earlier confirmation even in unsorted input");
const blocked = { ...read(302_000, 1.0989, 1.099), blockers: ["High-impact news"] };
assert.equal(evaluateObserverPlan(plan, blocked, []).status, "INVALIDATED", "News gates must not resurrect an invalidated setup");
assert.equal(evaluateObserverPlan(plan, { ...blocked, state: "warming" }, []).status, "INVALIDATED", "Fresh quotes can invalidate while context warms");
assert.equal(evaluateObserverPlan(plan, { ...blocked, state: "paused" }, []).status, "PAUSED", "Stale/nontradeable quotes cannot prove invalidation");
const paused = evaluateObserverPlan(confirmed, { ...read(302_000), state: "paused", quote: null, blockers: ["Price feed interrupted"] }, []);
assert.equal(paused.confirmationCandle, null);
assert.equal(evaluateObserverPlan(paused, read(303_000), [candle(0)]).status, "READY", "Resume cannot reuse a pre-interruption confirmation");
const resumed = evaluateObserverPlan(paused, read(303_000), [candle(0)]);
assert.equal(evaluateObserverPlan(resumed, read(601_000), [candle(300_000)]).status, "READY", "A candle straddling resume is not a new confirmation");
assert.equal(evaluateObserverPlan(resumed, read(901_000), [candle(600_000)]).status, "TRIGGERED");
const contextPaused = evaluateObserverPlan(plan, { ...read(300_000), blockers: ["Awaiting broker candle close"] }, []);
assert.equal(evaluateObserverPlan(contextPaused, read(301_000), [candle(0)]).status, "TRIGGERED", "Delayed candle arrival is an entry gate, not a missing-price gap");
const triggered = evaluateObserverPlan(plan, read(301_000), [candle(0)]);
assert.equal(triggered.status, "TRIGGERED");
assert.equal(evaluateObserverPlan(triggered, read(1_900_000), []).status, "TRIGGERED", "Entry lifetime does not erase observed signals");
assert.equal(evaluateObserverPlan(triggered, { ...read(1_900_000, 1.102, 1.1021), blockers: ["Wide spread"] }, []).outcome?.kind, "target_observed");
const interrupted = evaluateObserverPlan(triggered, { ...read(302_000), state: "paused", quote: null }, []);
assert.equal(interrupted.confirmationCandle, triggered.confirmationCandle, "Keep original trigger evidence after interruption");
assert.equal(evaluateObserverPlan(interrupted, read(1_900_000, 1.102, 1.1021), []).outcome?.kind, "unknown_after_gap", "Gap takes precedence over a later target quote");
const stopped = stopObserverPlan(triggered, iso(302_000), "Monitoring stopped by you.");
assert.equal(stopped.status, "CLOSED"); assert.equal(stopped.outcome?.kind, "monitoring_stopped");
assert.deepEqual(geometry(stopped), geometry(plan));
assert.equal(stopObserverPlan(plan, iso(302_000), "Replaced").status, "EXPIRED");
assert.strictEqual(evaluateObserverPlan(stopped, read(1_900_000), []), stopped, "Terminal plans never revive");
const restarted = resumeObserverPlan(confirmed, iso(302_000));
assert.equal(restarted.status, "PAUSED"); assert.equal(restarted.confirmationCandle, null);
assert.equal(resumeObserverPlan(triggered, iso(302_000)).outcome?.kind, "unknown_after_gap");
assert.deepEqual(geometry(restarted), geometry(plan)); assert.deepEqual(plan, copy, "Input plans stay immutable");
assert.strictEqual(evaluateObserverPlan(resumed, read(302_000), []), resumed, "Out-of-order reads cannot move lifecycle backwards");
const checks = observerPlanChecks(confirmed, read(302_000));
assert.equal(checks.find(c => c.id === "confirmation")?.state, "met");
assert.equal(checks.find(c => c.id === "zone")?.state, "met");
assert.equal(observerPlanChecks(plan, { ...read(300_000), state: "paused", quote: null }).find(c => c.id === "zone")?.state, "unknown");
assert.equal(observerPlanChecks({ ...plan, trigger: null, direction: null }, read(300_000)).find(c => c.id === "geometry")?.state, "blocked");
assert.deepEqual(observerPlanChecks(stopped, read(300_000)), []);
const short: ObserverPlan = { ...plan, direction: "short", entry: 1.1001, stop: 1.102, target: 1.099, trigger: { ...plan.trigger!, boundary: 1.1 } };
assert.equal(evaluateObserverPlan(short, read(301_000), [candle(0, 1.0998)]).status, "TRIGGERED");
assert.equal(evaluateObserverPlan(short, { ...read(301_000, 1.1019, 1.102), blockers: ["News"] }, []).status, "INVALIDATED", "Short invalidation uses ask");
// Exercise the actual quote dispatch without starting timers, storage, providers or execution.
const cached = { userId: "fixture", plan: structuredClone(triggered), persisted: structuredClone(triggered), events: [] as ObserverPlan[] };
const observer = Object.create(MarketObserverService.prototype) as MarketObserverService;
Object.assign(observer, { plans: new Map([[plan.id, cached]]), writes: new Map(), mutating: new Set(), interested: new Map(), storageReady: true, stopped: false,
  patterns: { history: () => [] }, state: { update: (_instrument: string, at: string) => read(Date.parse(at) - start, at === iso(302_000) ? 1.0989 : 1.10005) } });
observer.observe(plan.instrument, iso(302_000));
observer.observe(plan.instrument, iso(302_100));
assert.equal(cached.plan.outcome?.kind, "stop_observed", "A crossing and recovery within 250ms must retain the first observed outcome");
assert.equal(cached.events.length, 1, "Terminal quote events cannot repeat");
cached.plan = structuredClone(triggered); cached.events = [];
Object.assign(observer, { snapshots: new Map() });
observer["pauseAfterFailedMutation"]("fixture", plan.instrument);
assert.equal(cached.plan.outcome?.kind, "unknown_after_gap", "A failed journal mutation cannot claim an uninterrupted outcome");
assert.deepEqual(geometry(cached.plan), geometry(plan), "Failed changes preserve the original frozen hypothesis");
console.log("Phase 6 plan tests passed: frozen geometry, exact candle boundaries, interruptions/restarts, news invalidation, continued outcomes, stop/replacement and measured checklist.");
