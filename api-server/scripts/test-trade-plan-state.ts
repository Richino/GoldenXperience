import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMINAL_STATUSES,
  TRADE_PLAN_STATUSES,
  TRADE_PLAN_TRANSITIONS,
  canonicalJson,
  checkTransition,
  planHash,
  type TransitionContext,
} from "../src/trade-plan-state.js";
import { validateTradePlanInput, type TradePlanInput } from "../src/trade-plans.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const ctx = (patch: Partial<TransitionContext> = {}): TransitionContext => ({
  monitoringMode: "NOTIFY",
  paused: false,
  expiresAt: new Date("2026-10-16T12:00:00.000Z"),
  now,
  hasCurrentApproval: true,
  ...patch,
});

// The database seed and the server table must list exactly the same edges.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = await fs.readFile(path.join(root, "migrations", "057_trade_plans.sql"), "utf8");
const seed = sql.slice(sql.indexOf("INSERT INTO trade_plan_transitions"), sql.indexOf("ON CONFLICT DO NOTHING"));
const dbEdges = new Set([...seed.matchAll(/\('([A-Z_]+)','([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`));
const tsEdges = new Set(Object.entries(TRADE_PLAN_TRANSITIONS).flatMap(([from, tos]) => Object.keys(tos).map((to) => `${from}>${to}`)));
assert.deepEqual([...dbEdges].sort(), [...tsEdges].sort(), "migration seed and TRADE_PLAN_TRANSITIONS differ");
// And the status CHECK lists every status.
for (const status of TRADE_PLAN_STATUSES) assert.ok(sql.includes(`'${status}'`), `${status} missing from migration`);

// Terminal states go nowhere.
assert.deepEqual([...TERMINAL_STATUSES].sort(), ["CANCELLED", "CLOSED", "EXECUTION_FAILED", "EXPIRED", "INVALIDATED", "REJECTED"]);
for (const status of TERMINAL_STATUSES) for (const to of TRADE_PLAN_STATUSES) assert.equal(checkTransition(status, to, "system", ctx()).ok, false);

// Happy paths.
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "user", ctx()).ok, true);
assert.equal(checkTransition("APPROVED", "MONITORING", "system", ctx()).ok, true);
assert.equal(checkTransition("MONITORING", "CONFIRMED", "monitor", ctx()).ok, true);
assert.equal(checkTransition("CONFIRMED", "NOTIFIED", "monitor", ctx()).ok, true);
assert.equal(checkTransition("CONFIRMED", "EXECUTION_PENDING", "monitor", ctx({ monitoringMode: "AUTO" })).ok, true);
assert.equal(checkTransition("EXECUTION_PENDING", "ORDER_SUBMITTED", "executor", ctx({ monitoringMode: "AUTO" })).ok, true);
assert.equal(checkTransition("ORDER_SUBMITTED", "FILLED", "executor", ctx()).ok, true);
assert.equal(checkTransition("FILLED", "CLOSED", "executor", ctx()).ok, true);

// Skipping steps is illegal.
assert.equal(checkTransition("PENDING_APPROVAL", "MONITORING", "user", ctx()).ok, false);
assert.equal(checkTransition("MONITORING", "EXECUTION_PENDING", "monitor", ctx({ monitoringMode: "AUTO" })).ok, false);
assert.equal(checkTransition("APPROVED", "CONFIRMED", "monitor", ctx()).ok, false);

// A user can never confirm a plan, submit an order or mark a fill.
for (const [from, to] of [["MONITORING", "CONFIRMED"], ["CONFIRMED", "EXECUTION_PENDING"], ["EXECUTION_PENDING", "ORDER_SUBMITTED"], ["ORDER_SUBMITTED", "FILLED"]] as const) {
  assert.equal(checkTransition(from, to, "user", ctx({ monitoringMode: "AUTO" })).ok, false, `${from}>${to} by user`);
}
// Nor approve on behalf of the user.
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "system", ctx()).ok, false);
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "monitor", ctx()).ok, false);

// Approval must match the current version.
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "user", ctx({ hasCurrentApproval: false })).ok, false);
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "user", ctx({ monitoringMode: null })).ok, false);
assert.equal(checkTransition("MONITORING", "CONFIRMED", "monitor", ctx({ hasCurrentApproval: false })).ok, false);

// Notify never becomes Auto, and Auto never ends as a bare notification.
const notifyToAuto = checkTransition("CONFIRMED", "EXECUTION_PENDING", "monitor", ctx({ monitoringMode: "NOTIFY" }));
assert.equal(notifyToAuto.ok, false);
assert.match(notifyToAuto.ok ? "" : notifyToAuto.reason, /Notify/);
assert.equal(checkTransition("CONFIRMED", "NOTIFIED", "monitor", ctx({ monitoringMode: "AUTO" })).ok, false);

// Paused plans cannot confirm.
assert.equal(checkTransition("MONITORING", "CONFIRMED", "monitor", ctx({ paused: true })).ok, false);

// Expiry: an expired plan can only expire or be cancelled; a live one cannot be expired early.
const late = ctx({ now: new Date("2026-10-17T00:00:00.000Z") });
assert.equal(checkTransition("MONITORING", "CONFIRMED", "monitor", late).ok, false);
assert.equal(checkTransition("PENDING_APPROVAL", "APPROVED", "user", late).ok, false);
assert.equal(checkTransition("MONITORING", "EXPIRED", "monitor", late).ok, true);
assert.equal(checkTransition("MONITORING", "CANCELLED", "user", late).ok, true);
assert.equal(checkTransition("MONITORING", "EXPIRED", "monitor", ctx()).ok, false);
// An order already at the broker still gets its fill recorded after expiry.
assert.equal(checkTransition("ORDER_SUBMITTED", "FILLED", "executor", late).ok, true);

// Cancelling during execution belongs to the executor only.
assert.equal(checkTransition("ORDER_SUBMITTED", "CANCELLED", "user", ctx()).ok, false);
assert.equal(checkTransition("ORDER_SUBMITTED", "CANCELLED", "executor", ctx()).ok, true);
assert.equal(checkTransition("FILLED", "CANCELLED", "executor", ctx()).ok, false);

// Editing an approved or monitored plan sends it back for approval.
assert.equal(checkTransition("APPROVED", "PENDING_APPROVAL", "user", ctx()).ok, true);
assert.equal(checkTransition("MONITORING", "PENDING_APPROVAL", "user", ctx()).ok, true);
assert.equal(checkTransition("CONFIRMED", "PENDING_APPROVAL", "user", ctx()).ok, false);

// Hashing is key-order independent and sensitive to any material change.
assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
const fields = {
  instrument: "EUR_USD", direction: "BUY" as const, setupType: "BREAKOUT_RETEST", timeframe: "H1",
  entryZoneLow: 1.1235, entryZoneHigh: 1.124, stopLoss: 1.12, takeProfit: 1.13, maxRiskPercent: 1,
  expiresAt: "2026-10-16T12:00:00.000Z", plan: { trigger: "H4 close above", rules: { a: 1, b: 2 } },
};
assert.equal(planHash(fields), planHash({ ...fields, plan: { rules: { b: 2, a: 1 }, trigger: "H4 close above" } }));
assert.notEqual(planHash(fields), planHash({ ...fields, stopLoss: 1.1199 }));
assert.notEqual(planHash(fields), planHash({ ...fields, maxRiskPercent: 1.5 }));
assert.notEqual(planHash(fields), planHash({ ...fields, plan: { ...fields.plan, trigger: "H1 close above" } }));

// Plan input validation.
const buy: TradePlanInput = {
  instrument: "EUR_USD", direction: "BUY", setupType: "BREAKOUT_RETEST", timeframe: "H1", marketBias: "Bearish",
  trendClassification: "DOWN", entryZoneLow: 1.1235, entryZoneHigh: 1.124, stopLoss: 1.12, takeProfit: 1.13,
  rewardRisk: 2, maxRiskPercent: 1, expiresAt: "2026-10-16T12:00:00.000Z", plan: {}, strategyVersion: "trade-plans-v1",
};
assert.equal(validateTradePlanInput(buy, now), null);
assert.match(validateTradePlanInput({ ...buy, stopLoss: 1.124 }, now) ?? "", /below the entry/);
assert.match(validateTradePlanInput({ ...buy, takeProfit: 1.1238 }, now) ?? "", /above the entry/);
assert.match(validateTradePlanInput({ ...buy, entryZoneHigh: 1.12 }, now) ?? "", /entry zone/);
assert.match(validateTradePlanInput({ ...buy, maxRiskPercent: 6 }, now) ?? "", /Risk/);
assert.match(validateTradePlanInput({ ...buy, expiresAt: "2026-10-15T11:00:00.000Z" }, now) ?? "", /expire/);
assert.match(validateTradePlanInput({ ...buy, instrument: "XXX_YYY" }, now) ?? "", /Unknown/);
const sell: TradePlanInput = { ...buy, direction: "SELL", stopLoss: 1.126, takeProfit: 1.115 };
assert.equal(validateTradePlanInput(sell, now), null);
assert.match(validateTradePlanInput({ ...sell, stopLoss: 1.12 }, now) ?? "", /above the entry/);

console.log("trade plan state machine: all checks passed");
