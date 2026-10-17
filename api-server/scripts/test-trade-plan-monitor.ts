import assert from "node:assert/strict";
import { candlesStale, decideMonitorActions, type MonitorAction } from "../src/trade-plan-monitor.js";
import type { Confirmation } from "../src/trade-plan-confirmation.js";

/** Monitor decisions: what each evaluation outcome does to a plan. No database. */

const base: Confirmation = {
  outcome: "WAITING", stage: "WAITING_FOR_RETEST", conditions: [], notTriggeredReason: "Waiting for a retest.",
  events: [], proposal: null, evaluatedThrough: { H1: null, M15: null }, safety: null, progress: { attempt: 1, maxAttempts: 1, window: null },
};
const proposal = { confirmedAt: "2026-10-14T12:00:00.000Z", side: "BUY" as const, entry: 1.1009, stopLoss: 1.0985, takeProfit: 1.105, rewardRisk: 1.67, spread: 0.0001, quoteTime: "2026-10-14T12:00:00.000Z" };
const safe: { ok: boolean; blocks: string[] } = { ok: true, blocks: [] };
const blocked = { ok: false, blocks: ["News blackout: high-impact USD CPI at 12:30 UTC."] };
const decide = (patch: Partial<Confirmation>, status: "MONITORING" | "CONFIRMED" = "MONITORING", mode: "NOTIFY" | "AUTO" = "NOTIFY") =>
  decideMonitorActions({ status, mode, instrument: "EUR_USD", direction: "BUY", confirmation: { ...base, ...patch } });
const confirmed = (safety = safe): Partial<Confirmation> => ({ outcome: "CONFIRMED", stage: safety.ok ? "CONFIRMED" : "CONFIRMED_BLOCKED", proposal, notTriggeredReason: null, safety });
const transitions = (actions: MonitorAction[]) => actions.filter((a) => a.kind === "transition").map((a) => (a as { to: string }).to);
const notices = (actions: MonitorAction[]) => actions.filter((a) => a.kind === "notify").map((a) => (a as { event: string }).event);
const kinds = (actions: MonitorAction[]) => actions.map((a) => (a.kind === "transition" ? `to:${a.to}` : a.kind));

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

test("Notify: confirmed goes MONITORING → CONFIRMED → NOTIFIED with one ready notice (entry, SL, TP, spread, quote time)", () => {
  const actions = decide(confirmed());
  assert.deepEqual(transitions(actions), ["CONFIRMED", "NOTIFIED"]);
  assert.deepEqual(notices(actions), ["SETUP_CONFIRMED"]);
  const ready = actions.find((a) => a.kind === "notify") as Extract<MonitorAction, { kind: "notify" }>;
  assert.equal(ready.notificationKind, "setup_ready");
  assert.match(ready.message, /No order was placed/);
  assert.match(ready.message, /1\.1009/);
  assert.match(ready.message, /spread 0\.0001/);
  assert.match(ready.message, /quote 12:00:00 UTC/);
});

test("Notify: a confirmation blocked right now is still READY once, with the block stated", () => {
  const actions = decide(confirmed(blocked));
  assert.deepEqual(transitions(actions), ["CONFIRMED", "NOTIFIED"]);
  assert.match((actions.find((a) => a.kind === "notify") as { message: string }).message, /would be blocked: News blackout/);
});

test("Auto: confirmed and safe goes to the executor; never a Notify alert", () => {
  assert.deepEqual(kinds(decide(confirmed(), "MONITORING", "AUTO")), ["to:CONFIRMED", "to:EXECUTION_PENDING", "execute"]);
  // A restart after CONFIRMED resumes at the hand-off, not before it.
  assert.deepEqual(kinds(decide(confirmed(), "CONFIRMED", "AUTO")), ["to:EXECUTION_PENDING", "execute"]);
});

test("Auto: confirmed but blocked stays CONFIRMED (no order, no return to waiting) and says why", () => {
  const first = decide(confirmed(blocked), "MONITORING", "AUTO");
  assert.deepEqual(kinds(first), ["to:CONFIRMED", "notify"]);
  assert.ok(!first.some((a) => a.kind === "execute"));
  const later = decide(confirmed(blocked), "CONFIRMED", "AUTO");
  assert.deepEqual(kinds(later), ["notify"], "no second CONFIRMED move, no execution");
  assert.match((later[0] as { message: string }).message, /entry window/);
});

test("Test 11 — READY happens exactly once: a CONFIRMED plan is never moved to CONFIRMED again or back to waiting", () => {
  assert.ok(!transitions(decide(confirmed(), "CONFIRMED")).includes("CONFIRMED"));
  assert.deepEqual(transitions(decide(confirmed(), "CONFIRMED")), ["NOTIFIED"]);
  // Even if an evaluation somehow said WAITING, nothing moves a confirmed plan.
  assert.deepEqual(decide({}, "CONFIRMED", "AUTO"), []);
  assert.deepEqual(decide({}, "CONFIRMED", "NOTIFY"), []);
});

test("Tests 12–13 — missed, invalidated and expired end the plan with a reason", () => {
  const missed = decide({ outcome: "MISSED", stage: "MISSED", notTriggeredReason: "No retest within 24 H1 candles." });
  assert.deepEqual(transitions(missed), ["MISSED"]);
  assert.match((missed[1] as { message: string }).message, /does not chase/);
  assert.deepEqual(transitions(decide({ outcome: "MISSED", stage: "MISSED" }, "CONFIRMED", "AUTO")), ["MISSED"]);
  const invalid = decide({ outcome: "INVALIDATED", stage: "INVALIDATED", notTriggeredReason: "The breakout failed." });
  assert.deepEqual(transitions(invalid), ["INVALIDATED"]);
  assert.match((invalid[1] as { message: string }).message, /No trade will be taken/);
  assert.deepEqual(transitions(decide({ outcome: "EXPIRED", stage: "EXPIRED" })), ["EXPIRED"]);
});

test("a failed attempt is reported once per attempt", () => {
  const actions = decide({ events: [{ type: "ATTEMPT_FAILED", at: "2026-10-14T10:00:00.000Z", detail: "Breakout attempt 1 failed." }] });
  assert.deepEqual(notices(actions), ["ATTEMPT_FAILED_2026-10-14T10:00:00.000Z"]);
});

test("Notify and Auto notices are distinguishable", () => {
  const event = { events: [{ type: "BREAKOUT_DETECTED" as const, at: "t", detail: "d" }] };
  assert.match((decide(event)[0] as { message: string }).message, /\[Notify\]/);
  assert.match((decide(event, "MONITORING", "AUTO")[0] as { message: string }).message, /\[Auto\]/);
});

test("linked plans: the monitor never cancels the other side (Notify keeps it; Auto cancels only after a fill)", () => {
  for (const mode of ["NOTIFY", "AUTO"] as const) {
    for (const patch of [{}, confirmed(), confirmed(blocked), { outcome: "INVALIDATED" as const }, { outcome: "MISSED" as const }]) {
      assert.ok(decide(patch, "MONITORING", mode).every((a) => a.kind !== "transition" || ["CONFIRMED", "NOTIFIED", "EXECUTION_PENDING", "INVALIDATED", "MISSED", "EXPIRED"].includes(a.to)));
    }
  }
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

console.log(`trade plan monitor: ${passed} checks passed`);
