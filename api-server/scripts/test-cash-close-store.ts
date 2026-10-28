import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// The real pg-pool/transport code runs against isolated in-memory fixtures.
// No real database, credentials, or broker requests are used by this test.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
process.env.OANDA_ACCOUNT_ID = "fixture-account";
process.env.OANDA_API_KEY = "fixture-key";
process.env.OANDA_ENVIRONMENT = "practice";
process.env.ENABLE_SCHEDULERS = "false";
delete process.env.CASH_CLOSE_MONITOR_ENABLED;

const id = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const entry = {
  id, user_id: userId, instrument: "EUR_USD", status: "TRIGGERED", paper_trade_status: "open",
  metadata: { brokerTradeId: "1001" } as Record<string, unknown>,
};
const locks = new Set<string>();
let writes = 0;
class FixtureClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
  query(sql: string, values: unknown[], callback?: (error: Error | null, result?: unknown) => void): Promise<unknown> | void {
    const execute = () => {
      if (sql.includes("pg_try_advisory_lock")) {
        const key = String(values[0]), acquired = !locks.has(key);
        if (acquired) locks.add(key);
        return { rows: [{ locked: acquired }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) { locks.delete(String(values[0])); return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }; }
      if (sql.includes("SELECT e.id,e.user_id")) return { rows: values[0] === id && (!values[1] || values[1] === userId) ? [structuredClone(entry)] : [], rowCount: 1 };
      if (sql.includes("UPDATE pending_manual_entries SET metadata")) {
        assert.equal(values[0], id);
        writes++;
        if (values[1] === null) delete entry.metadata.cashCloseConditions;
        else entry.metadata.cashCloseConditions = JSON.parse(String(values[1]));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT id FROM pending_manual_entries")) return { rows: entry.metadata.cashCloseConditions ? [{ id }] : [], rowCount: 1 };
      throw new Error(`Unexpected fixture query: ${sql}`);
    };
    if (callback) { queueMicrotask(() => { try { callback(null, execute()); } catch (error) { callback(error as Error); } }); return; }
    return Promise.resolve().then(execute);
  }
  end(callback?: () => void) { this._ending = true; this.emit("end"); callback?.(); }
  ref() {}
  unref() {}
}

let currency = "USD", brokerReads = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  assert.equal(init?.method ?? "GET", "GET", "these store tests must never execute a broker mutation");
  brokerReads++;
  if (url.endsWith("/summary")) return Response.json({ account: { currency } });
  if (url.endsWith("/trades/1001")) return Response.json({ trade: { state: "OPEN", instrument: "EUR_USD", unrealizedPL: "10", price: "1.1", initialUnits: "-1000" } });
  throw new Error("Unexpected broker URL in fixture.");
};
const { db } = await import("../src/database.js");
const pool = db();
(pool as unknown as { Client: typeof FixtureClient }).Client = FixtureClient;
const { cashCloseSettings, updateCashCloseSettings, sweepCashCloseConditions, cashCloseMonitorStatus } = await import("../src/cash-close-conditions.js");
const { withManualTradeLock } = await import("../src/manual-trade-lock.js");
try {
  assert.equal(cashCloseMonitorStatus().monitoringEnabled, false);
  await assert.rejects(updateCashCloseSettings(userId, id, { profitAmount: 300, lossAmount: 300 }), /monitoring is disabled/);
  assert.equal(writes, 0, "disabled monitoring cannot silently arm a rule");
  await sweepCashCloseConditions(); assert.equal(brokerReads, 0);
  await assert.rejects(cashCloseSettings("another-user", id), /not found/);
  process.env.ENABLE_SCHEDULERS = "true";
  const armed = await updateCashCloseSettings(userId, id, { profitAmount: "300", lossAmount: "300" });
  assert.equal(armed.conditions?.state, "armed"); assert.equal(armed.conditions?.currency, "USD");
  assert.equal(armed.conditions?.brokerTradeId, "1001"); assert.equal(armed.conditions?.lossAmount, 300);
  assert.equal((await cashCloseSettings(userId, id)).conditions?.profitAmount, 300, "saved rule survives a fresh read");
  await sweepCashCloseConditions();
  assert.ok((await cashCloseSettings(userId, id)).conditions?.lastCheckedAt, "worker checks the saved rule without a browser");
  assert.equal((await cashCloseSettings(userId, id)).conditions?.state, "armed", "below threshold does not close");
  const beforeUnauthorized = writes;
  await assert.rejects(updateCashCloseSettings("another-user", id, { profitAmount: null, lossAmount: null }), /not found/);
  assert.equal(writes, beforeUnauthorized, "other users cannot edit or clear a rule");
  process.env.ENABLE_SCHEDULERS = "false";
  const removed = await updateCashCloseSettings(userId, id, { profitAmount: null, lossAmount: null });
  assert.equal(removed.conditions, null, "removing protection is possible while a monitor is offline");
  process.env.ENABLE_SCHEDULERS = "true";
  entry.paper_trade_status = "closed";
  await assert.rejects(updateCashCloseSettings(userId, id, { profitAmount: 300, lossAmount: null }), /open trades only/);
  entry.paper_trade_status = "open";
  currency = "invalid";
  await assert.rejects(updateCashCloseSettings(userId, id, { profitAmount: 300, lossAmount: null }), /currency is unavailable/);
  currency = "USD";
  delete entry.metadata.brokerTradeId;
  await assert.rejects(updateCashCloseSettings(userId, id, { profitAmount: 300, lossAmount: null }), /not confirmed/);
  entry.metadata.brokerTradeId = "1001";
  // A second API instance/action cannot enter while this trade's lock is held.
  await withManualTradeLock(id, async () => {
    await assert.rejects(withManualTradeLock(id, async () => { throw new Error("must not enter"); }), /being updated/);
  });
  await assert.rejects(withManualTradeLock(id, async () => { throw new Error("fixture failure"); }), /fixture failure/);
  assert.equal(locks.size, 0, "locks are released after success and failure");
  await withManualTradeLock(id, async () => {});
  console.log("Cash-close storage checks passed: ownership, persistence, offline guard, removal, broker identity, closed trades, worker read, and concurrent-action locking.");
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
}
