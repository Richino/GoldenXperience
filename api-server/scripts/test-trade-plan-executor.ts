import assert from "node:assert/strict";
import { executionChecks, reconcileDecision, submitFailureKind, type ExecutionInput } from "../src/trade-plan-execution-checks.js";
import { tradingDayStart } from "../src/trade-plan-executor.js";

/**
 * Auto trade executor: the pre-order safety checks, sizing, slippage bound,
 * and what a lost or failed broker response leads to. No network, no database.
 */

const NOW = Date.parse("2026-10-14T14:00:00Z"); // Wednesday, market open
const base: ExecutionInput = {
  plan: {
    instrument: "EUR_USD", direction: "SELL", stopLoss: 1.1254, takeProfit: 1.1166,
    expiresAt: "2026-10-16T12:00:00Z", maxRiskPercent: 1, minRewardRisk: 1.5, proposalEntry: 1.1240,
  },
  now: NOW,
  settings: {
    autoApproved: true, killSwitch: false, suspended: false,
    maxRiskPercent: 1, maxAggregateRiskPercent: 3, maxOpenPositions: 3, dailyLossLimitPercent: 3,
    maxSpreadStopFraction: 0.15, maxSlippageStopFraction: 0.1, maxDataAgeSeconds: 10,
    newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30,
  },
  brokerEnvironment: "practice",
  marketOpen: true,
  quote: { bid: 1.1240, ask: 1.12408, time: new Date(NOW - 2000).toISOString() },
  news: [],
  account: { nav: 10_000, marginAvailable: 10_000 },
  quoteToUsdRate: 1,
  openInstruments: [],
  openAutoTrades: { count: 0, riskPercent: 0 },
  realizedTodayPL: 0,
};
const run = (patch: Partial<ExecutionInput> = {}, plan: Partial<ExecutionInput["plan"]> = {}, settings: Partial<ExecutionInput["settings"]> = {}) =>
  executionChecks({ ...base, ...patch, plan: { ...base.plan, ...plan }, settings: { ...base.settings, ...settings } });
const failed = (result: ReturnType<typeof run>) => result.checks.filter((item) => !item.ok).map((item) => item.key);

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

test("all checks pass: an order sized to the risk, at the bid for a SELL, with a slippage bound", () => {
  const result = run();
  assert.equal(result.ok, true, JSON.stringify(failed(result)));
  const order = result.order!;
  assert.equal(order.entry, 1.124);
  assert.equal(order.stop, 1.1254);
  assert.equal(order.target, 1.1166);
  // 1% of 10,000 = 100 risk over 14 pips at $10/pip/lot ≈ 0.714 lots.
  assert.ok(order.units > 70_000 && order.units <= 71_500, String(order.units));
  assert.ok(order.riskAmount <= 100.0001);
  // SELL: worst acceptable fill is below the bid by 10% of the stop distance (1.4 pips).
  assert.equal(order.priceBound, 1.12386);
  assert.equal(order.riskPercent, 1);
});

test("a BUY enters at the ask and bounds slippage above it", () => {
  const result = run({}, { direction: "BUY", stopLoss: 1.1226, takeProfit: 1.1314, proposalEntry: 1.12408 });
  assert.equal(result.ok, true, JSON.stringify(failed(result)));
  assert.equal(result.order!.entry, 1.12408);
  assert.equal(result.order!.priceBound, 1.12423);
});

test("risk per trade is the lower of the plan's and the setting's", () => {
  assert.equal(run({}, { maxRiskPercent: 2 }, { maxRiskPercent: 0.5 }).order!.riskPercent, 0.5);
});

for (const [name, patch, plan, settings, key] of [
  ["Auto trade off", {}, {}, { autoApproved: false }, "auto_trade"],
  ["kill switch on", {}, {}, { killSwitch: true }, "kill_switch"],
  ["paused after broker errors", {}, {}, { suspended: true }, "suspended"],
  ["a live account", { brokerEnvironment: "live" }, {}, {}, "practice_account"],
  ["no account connected", { brokerEnvironment: null }, {}, {}, "practice_account"],
  ["an expired plan", {}, { expiresAt: "2026-10-14T13:00:00Z" }, {}, "plan_valid"],
  ["a closed market", { marketOpen: false }, {}, {}, "market_open"],
  ["a stale quote", { quote: { bid: 1.124, ask: 1.12408, time: new Date(NOW - 60_000).toISOString() } }, {}, {}, "fresh_quote"],
  ["no quote", { quote: null }, {}, {}, "fresh_quote"],
  ["an unreadable calendar", { news: null }, {}, {}, "news"],
  ["a high-impact USD release in 10 min", { news: [{ title: "CPI", currency: "USD", impact: 3, timestamp: new Date(NOW + 10 * 60_000).toISOString() }] }, {}, {}, "news"],
  ["a trade already open on the pair", { openInstruments: ["EUR_USD"] }, {}, {}, "no_open_position"],
  ["open positions unreadable", { openInstruments: null }, {}, {}, "no_open_position"],
  ["the open-trade limit reached", { openAutoTrades: { count: 3, riskPercent: 2 } }, {}, {}, "open_positions"],
  ["total open risk over the limit", { openAutoTrades: { count: 1, riskPercent: 2.5 } }, {}, {}, "aggregate_risk"],
  ["today's losses at the daily limit", { realizedTodayPL: -300 }, {}, {}, "daily_loss"],
  ["an excessive spread", { quote: { bid: 1.124, ask: 1.1243, time: new Date(NOW - 1000).toISOString() } }, {}, {}, "spread"],
  ["price slipped since confirmation", {}, { proposalEntry: 1.1245 }, {}, "slippage"],
  ["reward/risk too low from here", {}, { takeProfit: 1.1225 }, {}, "reward_risk"],
  ["account unreadable", { account: null }, {}, {}, "account"],
  ["not enough margin", { account: { nav: 10_000, marginAvailable: 100 } }, {}, {}, "margin"],
] as Array<[string, Partial<ExecutionInput>, Partial<ExecutionInput["plan"]>, Partial<ExecutionInput["settings"]>, string]>) {
  test(`no order with ${name}`, () => {
    const result = run(patch, plan, settings);
    assert.equal(result.ok, false);
    assert.equal(result.order, null);
    assert.ok(failed(result).includes(key), `${key} not among ${JSON.stringify(failed(result))}`);
    // Every failed check says why in plain words.
    for (const item of result.checks.filter((entry) => !entry.ok)) assert.ok(item.detail.length > 8);
  });
}

test("price already past the stop or target: no order", () => {
  assert.ok(failed(run({ quote: { bid: 1.1256, ask: 1.12568, time: new Date(NOW - 1000).toISOString() } }, { proposalEntry: null })).includes("stop_side"));
  assert.ok(failed(run({ quote: { bid: 1.1160, ask: 1.11608, time: new Date(NOW - 1000).toISOString() } }, { proposalEntry: null })).includes("stop_side"));
});

test("a size under one unit is refused, never rounded up", () => {
  const result = run({ account: { nav: 0.05, marginAvailable: 10 } });
  assert.ok(failed(result).includes("position_size"));
});

test("a lost or failed response is never treated as permission to resend", () => {
  assert.equal(submitFailureKind(400), "rejected");
  assert.equal(submitFailureKind(422), "rejected");
  assert.equal(submitFailureKind(undefined), "unknown", "timeout / unreachable");
  assert.equal(submitFailureKind(503), "unknown", "server error: fate unknown");
  const timing = { reconcileAfterMs: 15_000, giveUpAfterMs: 180_000 };
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 5_000, ageMs: 5_000, order: null }), "wait", "too soon to ask");
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 20_000, ageMs: 20_000, order: { state: "FILLED", tradeId: "42" } }), "filled");
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 20_000, ageMs: 20_000, order: { state: "CANCELLED", tradeId: null } }), "rejected");
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 20_000, ageMs: 20_000, order: null }), "wait", "not found yet: keep asking");
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 200_000, ageMs: 200_000, order: null }), "lost", "never received: fail, do not resend");
  assert.equal(reconcileDecision({ ...timing, sinceUpdateMs: 20_000, ageMs: 20_000, order: { state: "PENDING", tradeId: null } }), "wait");
});

test("the daily loss window starts at 17:00 New York", () => {
  // 14:00 UTC Wednesday = 10:00 EDT: the trading day began Tuesday 17:00 EDT = 21:00 UTC.
  assert.equal(new Date(tradingDayStart(NOW)).toISOString(), "2026-10-13T21:00:00.000Z");
  // 22:30 UTC = 18:30 EDT: a new day began at 21:00 UTC.
  assert.equal(new Date(tradingDayStart(Date.parse("2026-10-14T22:30:00Z"))).toISOString(), "2026-10-14T21:00:00.000Z");
});

console.log(`trade plan executor: ${passed} checks passed`);
