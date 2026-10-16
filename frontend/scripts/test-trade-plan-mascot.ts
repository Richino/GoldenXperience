/**
 * What the plan mascot says, from fixture plans. No network.
 *   npx tsx scripts/test-trade-plan-mascot.ts
 */
import assert from "node:assert/strict";
import { mascotLine, mascotPair } from "../src/lib/trade-plans/mascot";
import { fixturePlan, watchingPair } from "../src/lib/trade-plans/fixtures";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

test("no plans, no mascot", () => {
  assert.equal(mascotLine([]), null);
  assert.equal(mascotPair([], "EUR_USD"), null);
});

test("between the zones it gives the distance to each in pips", () => {
  const line = mascotLine(watchingPair(1.12296))!;
  assert.equal(line.expression, "neutral");
  assert.match(line.text, /BUY zone 1\.12113–1\.12153 is 14 pips below/);
  assert.match(line.text, /SELL zone 1\.12399–1\.12439 is 10 pips above/);
  assert.equal(line.status, "EUR/USD · BUY & SELL");
});

test("inside a zone it says so", () => {
  assert.match(mascotLine(watchingPair(1.1213))!.text, /price is in the BUY zone/);
});

test("before the first check it says it is starting", () => {
  const line = mascotLine(watchingPair().map((plan) => ({ ...plan, lastPrice: null })))!;
  assert.equal(line.expression, "analyzing");
  assert.match(line.text, /First check/);
});

test("a plan past the early stages is narrated with its reason", () => {
  const [buy, sell] = watchingPair();
  const line = mascotLine([buy!, { ...sell!, monitorStage: "WAITING_FOR_STRUCTURE", notTriggeredReason: "Rejection seen; waiting for M15 to break 1.12350." }])!;
  assert.equal(line.expression, "alert");
  assert.equal(line.text, "SELL: Rejection seen; waiting for M15 to break 1.12350.");
});

test("a blocked confirmation is cautious", () => {
  const [buy] = watchingPair();
  const line = mascotLine([{ ...buy!, monitorStage: "CONFIRMED_BLOCKED", notTriggeredReason: "Technically confirmed, but blocked: News blackout." }])!;
  assert.equal(line.expression, "cautious");
  assert.match(line.text, /^BUY: Technically confirmed, but blocked/);
});

test("a confirmed plan wins and gives the levels", () => {
  const sell = fixturePlan("SELL", { status: "NOTIFIED", monitoringMode: "NOTIFY", monitorState: { outcome: "CONFIRMED", proposal: { confirmedAt: "x", side: "SELL", entry: 1.12401, stopLoss: 1.12537, takeProfit: 1.12166, rewardRisk: 1.7, spread: 0.00008, quoteTime: "x" } } });
  const line = mascotLine([sell])!;
  assert.equal(line.expression, "confirmed");
  assert.equal(line.text, "SELL confirmed — your call. Entry near 1.12401, stop 1.12537, target 1.12166.");
  const auto = mascotLine([{ ...sell, monitoringMode: "AUTO", status: "CONFIRMED" }])!;
  assert.match(auto.text, /Placing it on your practice account/);
});

test("an Auto trade being placed, then in the trade", () => {
  const sell = fixturePlan("SELL", { monitoringMode: "AUTO", status: "ORDER_SUBMITTED" });
  assert.match(mascotLine([sell])!.text, /placing the order/);
  const filled = mascotLine([{ ...sell, status: "FILLED" }])!;
  assert.equal(filled.expression, "confirmed");
  assert.equal(filled.text, "SELL is in the trade (Auto trade). Stop 1.12537 and target 1.12166 are held by OANDA.");
});

test("it follows the chart's pair when that pair has plans", () => {
  const plans = [...watchingPair(), fixturePlan("BUY", { id: "x", instrument: "USD_JPY", status: "NOTIFIED" })];
  assert.equal(mascotPair(plans, "EUR_USD"), "EUR_USD");
  assert.equal(mascotPair(plans, "GBP_USD"), "USD_JPY", "otherwise the confirmed one");
});

console.log(`trade plan mascot: ${passed} checks passed`);
