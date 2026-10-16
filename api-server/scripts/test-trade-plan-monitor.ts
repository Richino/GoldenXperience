import assert from "node:assert/strict";
import { candlesStale, decideMonitorActions, type MonitorAction } from "../src/trade-plan-monitor.js";
import type { Confirmation } from "../src/trade-plan-confirmation.js";

/** Monitor decisions: what each evaluation outcome does to a plan. No database. */

const base: Confirmation = {
  outcome: "WAITING", stage: "WAITING_FOR_RETEST", conditions: [], notTriggeredReason: "Waiting for a retest.",
  events: [], proposal: null, evaluatedThrough: { H1: null, M15: null },
};
const proposal = { confirmedAt: "2026-10-14T12:00:00.000Z", side: "BUY" as const, entry: 1.1009, stopLoss: 1.0985, takeProfit: 1.105, rewardRisk: 1.67, spread: 0.0001, quoteTime: "2026-10-14T12:00:00.000Z" };
const decide = (patch: Partial<Confirmation>, status: "MONITORING" | "CONFIRMED" = "MONITORING", mode: "NOTIFY" | "AUTO" = "NOTIFY") =>
  decideMonitorActions({ status, mode, instrument: "EUR_USD", direction: "BUY", confirmation: { ...base, ...patch } });
const transitions = (actions: MonitorAction[]) => actions.filter((a) => a.kind === "transition").map((a) => (a as { to: string }).to);
const notices = (actions: MonitorAction[]) => actions.filter((a) => a.kind === "notify").map((a) => (a as { event: string }).event);

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

test("waiting changes nothing", () => {
  assert.deepEqual(decide({}), []);
});

test("detections become one notice each, without moving the plan", () => {
  const actions = decide({ events: [
    { type: "BREAKOUT_DETECTED", at: "t", detail: "H1 closed through 1.1000." },
    { type: "RETEST_DETECTED", at: "t", detail: "Retest reached 1.1001." },
    { type: "CONDITIONS_MET", at: "t", detail: "x" },
  ] });
  assert.deepEqual(notices(actions), ["BREAKOUT_DETECTED", "RETEST_DETECTED"]);
  assert.deepEqual(transitions(actions), []);
});

test("Notify: confirmed goes MONITORING → CONFIRMED → NOTIFIED with a ready notice", () => {
  const actions = decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal, notTriggeredReason: null });
  assert.deepEqual(transitions(actions), ["CONFIRMED", "NOTIFIED"]);
  assert.deepEqual(notices(actions), ["SETUP_CONFIRMED"]);
  const ready = actions.find((a) => a.kind === "notify") as Extract<MonitorAction, { kind: "notify" }>;
  assert.equal(ready.notificationKind, "setup_ready");
  assert.match(ready.message, /No order was placed/);
  assert.match(ready.message, /1\.1009/);
});

test("Auto: confirmed stops at CONFIRMED and never turns into Notify", () => {
  const actions = decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal, notTriggeredReason: null }, "MONITORING", "AUTO");
  assert.deepEqual(transitions(actions), ["CONFIRMED"]);
  assert.ok(!transitions(actions).includes("NOTIFIED"));
  assert.deepEqual(notices(actions), ["AUTO_UNAVAILABLE"]);
  // Re-evaluating an Auto plan that is already CONFIRMED moves nothing.
  assert.deepEqual(transitions(decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal }, "CONFIRMED", "AUTO")), []);
});

test("restart between CONFIRMED and NOTIFIED is finished on the next tick", () => {
  assert.deepEqual(transitions(decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal }, "CONFIRMED")), ["NOTIFIED"]);
  assert.deepEqual(transitions(decide({ outcome: "WAITING", stage: "CONFIRMED_BLOCKED", proposal }, "CONFIRMED")), ["NOTIFIED"]);
});

test("invalidated and expired end the plan with a notice", () => {
  const invalid = decide({ outcome: "INVALIDATED", stage: "INVALIDATED", notTriggeredReason: "The breakout failed." });
  assert.deepEqual(transitions(invalid), ["INVALIDATED"]);
  assert.deepEqual(notices(invalid), ["INVALIDATED"]);
  assert.match((invalid[1] as { message: string }).message, /No trade will be taken/);
  const expired = decide({ outcome: "EXPIRED", stage: "EXPIRED" });
  assert.deepEqual(transitions(expired), ["EXPIRED"]);
});

test("a blocked confirmation warns Notify users once and keeps monitoring", () => {
  const blocked = decide({ outcome: "WAITING", stage: "CONFIRMED_BLOCKED", proposal, notTriggeredReason: "Technically confirmed, but blocked: News blackout." });
  assert.deepEqual(transitions(blocked), []);
  assert.deepEqual(notices(blocked), ["SAFETY_BLOCKED"]);
  assert.match((blocked[0] as { title: string }).title, /blocked/);
  // Auto never bypasses the block, and does not send the Notify-style warning.
  assert.deepEqual(decide({ outcome: "WAITING", stage: "CONFIRMED_BLOCKED", proposal }, "MONITORING", "AUTO"), []);
});

test("Notify and Auto notices are distinguishable", () => {
  const event = { events: [{ type: "BREAKOUT_DETECTED" as const, at: "t", detail: "d" }] };
  assert.match((decide(event)[0] as { message: string }).message, /\[Notify\]/);
  assert.match((decide(event, "MONITORING", "AUTO")[0] as { message: string }).message, /\[Auto\]/);
});

test("stale candles are detected only while the market is open", () => {
  const wednesday = Date.parse("2026-10-14T12:00:00Z");
  const fresh = [{ time: new Date(wednesday - 30 * 60_000).toISOString(), complete: true }];
  const old = [{ time: new Date(wednesday - 3 * 3_600_000).toISOString(), complete: true }];
  assert.equal(candlesStale(fresh, wednesday), false);
  assert.equal(candlesStale(old, wednesday), true);
  assert.equal(candlesStale([], wednesday), true);
  const saturday = Date.parse("2026-10-17T12:00:00Z");
  assert.equal(candlesStale(old, saturday), false);
});

test("a confirmation cancels the other side; nothing else does", () => {
  const kinds = (actions: MonitorAction[]) => actions.map((a) => a.kind);
  assert.ok(kinds(decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal })).includes("cancelSiblings"));
  assert.ok(kinds(decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal }, "MONITORING", "AUTO")).includes("cancelSiblings"));
  assert.ok(kinds(decide({ outcome: "WAITING", stage: "CONFIRMED_BLOCKED", proposal }, "CONFIRMED")).includes("cancelSiblings"));
  for (const patch of [{}, { outcome: "INVALIDATED" as const }, { outcome: "EXPIRED" as const }, { outcome: "WAITING" as const, stage: "CONFIRMED_BLOCKED", proposal }]) {
    assert.ok(!kinds(decide(patch)).includes("cancelSiblings"), JSON.stringify(patch));
  }
  // The other side is cancelled only after this plan's own CONFIRMED move.
  const order = kinds(decide({ outcome: "CONFIRMED", stage: "CONFIRMED", proposal }));
  assert.ok(order.indexOf("transition") < order.indexOf("cancelSiblings"));
});

console.log(`trade plan monitor: ${passed} checks passed`);
