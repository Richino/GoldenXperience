import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { OBSERVER_MASCOT_ASSETS, observerMascotExpression, observerMascotReaction } from "../src/lib/observer-mascot";
import type { ObserverSnapshot, ObserverPlan } from "../src/lib/market-observer-types";

const now = Date.parse("2026-10-10T14:00:00Z");
const at = (offset = 0) => new Date(now + offset).toISOString();
function snapshot(): ObserverSnapshot {
  return { enabled: true, storage: "ready", plan: null, history: [], read: {
    version: "market-observer@2", instrument: "AUD_JPY", asOf: at(), state: "live", lean: "up", headline: "Leaning up",
    changedAt: at(), revision: 1, facts: [], blockers: [], changeConditions: [],
    pressure: { direction: "up", observedDirection: "up", covered: true, pending: false, relation: "aligned" },
    quote: { bid: 110.5, ask: 110.51, time: at(), spreadPips: 1 }, movement: [], patterns: [],
    ai: { state: "disabled", text: null, at: null, factIds: [] },
  } };
}
const expression = (next: ObserverSnapshot, extra: Partial<Parameters<typeof observerMascotExpression>[0]> = {}) =>
  observerMascotExpression({ snapshot: next, monitored: true, busy: false, error: null, now, ...extra });
const live = snapshot();
assert.equal(expression(live), "neutral");
assert.equal(expression(live, { monitored: false }), "paused", "Stopped pairs cannot keep an active expression");
assert.equal(expression(live, { error: "Disconnected" }), "paused");
assert.equal(expression(live, { now: now + 5001 }), "paused", "Freshness must expire even without another server response");
const closedMarket = snapshot(); closedMarket.read!.state = "paused";
assert.equal(expression(closedMarket), "paused");
assert.equal(expression(closedMarket, { busy: true }), "analyzing", "Analyze gives immediate feedback before its result arrives");
const warming = snapshot(); warming.read!.state = "warming";
assert.equal(expression(warming), "analyzing");
const collecting = snapshot(); collecting.read!.pressure.covered = false;
collecting.read!.blockers = ["The 30-second pressure window is still warming."];
assert.equal(expression(collecting), "analyzing", "Collecting-data label and mascot agree even with live candle context");
const plan: ObserverPlan = {
  id: "p1", version: 1, instrument: "AUD_JPY", mode: "NORMAL", status: "TRIGGERED", resumeStatus: "TRIGGERED",
  createdAt: at(-60000), expiresAt: at(60000), updatedAt: at(), triggeredAt: at(), observedEntry: 110.5,
  direction: "long", reason: "Trigger observed", thesis: "Continuation", zone: { low: 110.4, high: 110.6 }, entry: 110.5,
  stop: 110.3, target: 110.9, trigger: { timeframe: "M5", boundary: 110.4, after: at(-60000) }, invalidation: "Below stop",
  lastEvaluatedCandle: at(), confirmationCandle: at(), outcome: null, facts: [],
};
const triggered = snapshot(); triggered.plan = plan;
const entryPaused = snapshot(); entryPaused.plan = { ...plan, status: "PAUSED", triggeredAt: null };
assert.equal(expression(entryPaused), "cautious", "Blocked entry monitoring must not mark live candle analysis as paused");
const testing = snapshot(); testing.plan = { ...plan, status: "WATCHING", triggeredAt: null,
  pullback: { rules: "pullback-monitor@1", zone: { low: 110.4, high: 110.6 }, phase: "testing", touchedAt: at(),
    lastQuoteKey: null, lastQuoteAt: at(), receivedQuotes: 1, lastEntry: 110.5, move: "unchanged" } };
assert.equal(expression(testing), "analyzing", "Testing the pullback area uses the active analysis animation");
testing.plan!.pullback!.phase = "rebounding";
assert.equal(expression(testing), "analyzing");
testing.plan!.pullback!.phase = "approaching";
assert.equal(expression(testing), "neutral", "Approaching the area is ordinary watching");
const rangeAttempt = snapshot(); rangeAttempt.plan = { ...testing.plan!, pullback: undefined,
  consolidation: { rules: "consolidation-comparison@1", low: 110.4, high: 110.6, buffer: 0.01, followThrough: 0.02,
    holdSeconds: 10, createdAt: at(), expiresAt: at(60000), lastQuoteAt: at(), lastQuoteKey: null, state: "attempt", attempts: [], truncated: false } };
assert.equal(expression(rangeAttempt), "analyzing", "A breakout attempt is actively analyzed");
rangeAttempt.read!.state = "paused";
assert.equal(expression(rangeAttempt), "paused", "An interrupted feed overrides active setup testing");
const confirmed = observerMascotReaction(live, triggered, now)!;
assert.equal(confirmed.expression, "confirmed");
assert.equal(expression(triggered, { reaction: confirmed }), "confirmed");
assert.equal(observerMascotReaction(triggered, triggered, now + 1000), null, "Polling the same trigger must not restart celebration");
const freshLater = structuredClone(triggered); freshLater.read!.asOf = at(7000);
assert.equal(expression(freshLater, { reaction: confirmed, now: now + 7000 }), "neutral", "Trigger reaction ends after its animation");
const old = structuredClone(triggered); old.plan!.triggeredAt = at(-10000);
assert.equal(observerMascotReaction(null, old, now), null, "Saved historical triggers cannot look like new confirmations");
const future = structuredClone(triggered); future.plan!.triggeredAt = at(10000);
assert.equal(observerMascotReaction(live, future, now), null);
const finished = structuredClone(triggered); finished.plan!.status = "CLOSED";
finished.plan!.outcome = { kind: "stop_observed", at: at(), price: 110.3 };
assert.equal(expression(finished, { reaction: confirmed }), "neutral", "An intervening outcome must end the trigger expression immediately");
for (const risk of ["conflict", "opposed", "news", "spread", "storage"] as const) {
  const blocked = structuredClone(triggered);
  if (risk === "conflict") blocked.read!.lean = "conflicting";
  if (risk === "opposed") blocked.read!.pressure.relation = "opposed";
  if (risk === "news") blocked.read!.blockers = ["High-impact news window"];
  if (risk === "spread") blocked.checks = [{ id: "spread", label: "Spread", state: "blocked", detail: "Too wide" }];
  if (risk === "storage") blocked.storage = "unavailable";
  assert.equal(expression(blocked, { reaction: confirmed }), "cautious", `${risk} must take precedence over confirmation`);
}
const ready = structuredClone(triggered); ready.plan!.status = "READY"; ready.plan!.triggeredAt = null;
assert.notEqual(expression(ready, { reaction: confirmed }), "confirmed", "READY is not an observed entry trigger");
const invalid = structuredClone(triggered); invalid.plan!.status = "INVALIDATED";
assert.equal(expression(invalid), "cautious");
const patterns = snapshot(); patterns.read!.patterns = [{ id: "shape", kind: "double_bottom", timeframe: "M5", state: "forming", direction: "up", at: at(), historical: false, contextState: "current" }];
assert.equal(observerMascotReaction(null, patterns, now), null, "Initial context is not a new alert");
const alert = observerMascotReaction(live, patterns, now)!;
assert.equal(expression(patterns, { reaction: alert }), "alert");
const stalePattern = structuredClone(patterns); stalePattern.read!.asOf = at(-10000);
assert.equal(observerMascotReaction(live, stalePattern, now), null, "A stale response cannot queue an alert for later recovery");
assert.equal(observerMascotReaction(patterns, patterns, now + 1000), null);
const historical = structuredClone(patterns); historical.read!.patterns[0].historical = true;
assert.equal(observerMascotReaction(live, historical, now), null);
const pausedPattern = structuredClone(patterns); pausedPattern.read!.patterns[0].contextState = "paused";
assert.equal(observerMascotReaction(live, pausedPattern, now), null);
assert.equal(expression(closedMarket, { reaction: alert }), "paused", "A feed pause overrides a pending pattern reaction");
for (const asset of Object.values(OBSERVER_MASCOT_ASSETS)) for (const file of [asset.animation, asset.still]) {
  assert(existsSync(path.join(process.cwd(), "public", file)), `Missing mascot asset: ${file}`);
}
console.log("Observer mascot tests passed: freshness, risk precedence, bounded reactions, trigger/outcome semantics, historical pattern filtering and all six asset pairs.");
