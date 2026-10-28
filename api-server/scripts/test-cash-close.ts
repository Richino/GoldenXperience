import assert from "node:assert/strict";
import { cashCloseTrigger, parseCashCloseAmounts, readCashCloseConditions, type CashCloseConditions } from "../../frontend/src/lib/trade-close-conditions.js";
import { checkCashClose, type CashCloseObservation } from "../src/cash-close-policy.js";

assert.deepEqual(parseCashCloseAmounts({ profitAmount: "300", lossAmount: "300.25" }), { profitAmount: 300, lossAmount: 300.25 });
assert.deepEqual(parseCashCloseAmounts({ profitAmount: null, lossAmount: "" }), { profitAmount: null, lossAmount: null });
for (const value of [true, false, [], {}, undefined, " ", "1e3", "-300", -300, "0", 0, Infinity, NaN, "300.001", 300.001]) {
  assert.throws(() => parseCashCloseAmounts({ profitAmount: value, lossAmount: null }));
  assert.throws(() => parseCashCloseAmounts({ profitAmount: null, lossAmount: value }));
}
const limits = { profitAmount: 300, lossAmount: 300 };
for (const pl of [-299.99, 299.99, 0, NaN, Infinity, null]) assert.equal(cashCloseTrigger(limits, pl), null);
assert.equal(cashCloseTrigger(limits, 300), "profit");
assert.equal(cashCloseTrigger(limits, 350), "profit");
assert.equal(cashCloseTrigger(limits, -300), "loss");
assert.equal(cashCloseTrigger(limits, -400), "loss");
assert.equal(cashCloseTrigger({ profitAmount: null, lossAmount: 300 }, 500), null);
assert.equal(cashCloseTrigger({ profitAmount: 300, lossAmount: null }, -500), null);

const initial: CashCloseConditions = {
  version: 1, ...limits, currency: "USD", accountKey: "fixture-account", brokerTradeId: "1001",
  state: "armed", trigger: null, triggeredAt: null, triggeredPL: null,
  lastCheckedAt: null, nextAttemptAt: null, lastError: null,
};
assert.equal(readCashCloseConditions(initial)?.profitAmount, 300);
assert.equal(readCashCloseConditions({ ...initial, profitAmount: -300 }), null);
assert.equal(readCashCloseConditions({ ...initial, currency: "invalid" }), null);

function fixture(start = initial) {
  let saved = structuredClone(start);
  let clock = Date.parse("2026-10-28T16:00:00Z");
  let observation: CashCloseObservation = { open: true, instrument: "EUR_USD", currency: "USD", unrealizedPL: 300 };
  let closeFailure = false;
  let observeFailure = false;
  let saveFailure = false;
  let delay = 0;
  let closes = 0;
  let reads = 0;
  const writes: CashCloseConditions[] = [];
  const identity = { accountKey: "fixture-account", brokerTradeId: "1001", instrument: "EUR_USD" };
  const run = () => checkCashClose(saved, identity, {
    now: () => clock,
    observe: async () => { reads++; clock += delay; if (observeFailure) throw new Error("Broker offline."); return observation; },
    save: async rules => { if (saveFailure) throw new Error("Database offline."); saved = structuredClone(rules); writes.push(saved); },
    close: async () => { closes++; assert.equal(saved.state, "closing", "trigger is durable before broker action"); if (closeFailure) throw new Error("Broker rejected close."); },
  });
  return {
    run, identity, writes, get saved() { return saved; }, get closes() { return closes; }, get reads() { return reads; },
    observe: (patch: Partial<CashCloseObservation>) => { observation = { ...observation, ...patch }; },
    failClose: (value: boolean) => { closeFailure = value; }, failObserve: () => { observeFailure = true; },
    failSave: () => { saveFailure = true; }, delay: (ms: number) => { delay = ms; }, advance: (ms: number) => { clock += ms; },
  };
}

for (const pl of [300, 400, -300, -400]) {
  const f = fixture(); f.observe({ unrealizedPL: pl }); await f.run();
  assert.equal(f.closes, 1); assert.equal(f.saved.state, "closed");
  assert.equal(f.saved.trigger, pl > 0 ? "profit" : "loss");
  await f.run(); assert.equal(f.closes, 1, "a completed rule cannot close twice");
}
for (const pl of [0, 299.99, -299.99]) {
  const f = fixture(); f.observe({ unrealizedPL: pl }); await f.run();
  assert.equal(f.closes, 0); assert.equal(f.saved.state, "armed");
}
for (const patch of [
  { currency: "EUR" }, { instrument: "GBP_USD" }, { unrealizedPL: NaN }, { unrealizedPL: null },
]) {
  const f = fixture(); f.observe(patch); await f.run(); assert.equal(f.closes, 0); assert.ok(f.saved.lastError);
}
for (const field of ["accountKey", "brokerTradeId"] as const) {
  const f = fixture(); f.identity[field] = "different"; await f.run();
  assert.equal(f.closes, 0); assert.equal(f.reads, 0, "identity mismatch must not even request the other account's trade");
}
{
  const f = fixture(); f.failObserve(); await f.run(); assert.equal(f.closes, 0); assert.ok(f.saved.lastError);
}
{
  const f = fixture(); f.delay(5_001); await f.run(); assert.equal(f.closes, 0); assert.match(f.saved.lastError!, /delayed/);
}
{
  const f = fixture(); f.failSave(); await assert.rejects(f.run(), /Database offline/); assert.equal(f.closes, 0, "a trigger must not execute if it cannot be persisted");
}
{
  const f = fixture(); f.observe({ open: false, instrument: null }); await f.run();
  assert.equal(f.closes, 0); assert.equal(f.saved.state, "closed", "already-closed trades do not send another close");
}
{
  const f = fixture(); f.failClose(true); await f.run();
  assert.equal(f.saved.state, "closing"); assert.ok(f.saved.lastError); assert.equal(f.closes, 1);
  await f.run(); assert.equal(f.closes, 1, "failed closes wait before retrying");
  // Simulate a restart using only persisted state: the hit survives even if P/L recedes.
  const restarted = fixture(f.saved); restarted.advance(15_000); restarted.observe({ unrealizedPL: 50 }); await restarted.run();
  assert.equal(restarted.closes, 1); assert.equal(restarted.saved.state, "closed"); assert.equal(restarted.saved.triggeredPL, 300);
}
{
  const f = fixture(); f.failClose(true); await f.run(); f.advance(15_000);
  f.observe({ open: false, instrument: null }); await f.run();
  assert.equal(f.closes, 1, "timeout after a broker fill reconciles before another attempt"); assert.equal(f.saved.state, "closed");
}
console.log("Cash-close checks passed: inclusive limits, invalid input, exact trade/account/currency, fresh data, durable triggers, restart, retry, and broker confirmation.");
