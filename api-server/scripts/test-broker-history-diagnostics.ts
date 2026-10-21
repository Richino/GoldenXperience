import assert from "node:assert/strict";
import { brokerHistoryFailure } from "../src/broker-history-diagnostics.js";

assert.equal(brokerHistoryFailure("broker-read", { status: 401 }).reason, "broker-authentication");
assert.equal(brokerHistoryFailure("broker-read", { status: 403 }).reason, "broker-authentication");
assert.equal(brokerHistoryFailure("broker-read", { status: 429 }).reason, "broker-rate-limit");
assert.equal(brokerHistoryFailure("broker-read", { status: 503 }).httpStatus, 503);
assert.equal(brokerHistoryFailure("broker-read", new Error("OANDA request timed out.")).reason, "broker-timeout");
assert.equal(brokerHistoryFailure("broker-read", new RangeError("Invalid time value")).reason, "broker-response-data");
const database = brokerHistoryFailure("database-import", {
  code: "23505", constraint: "paper_trades_user_id_legacy_id_key", table: "paper_trades", column: "legacy_id",
});
assert.equal(database.code, "23505");
assert.equal(database.constraint, "paper_trades_user_id_legacy_id_key");
assert.equal(brokerHistoryFailure("database-import", { code: "42703" }).reason, "database-schema");
assert.equal(brokerHistoryFailure("database-import", { code: "ECONNRESET" }).code, "ECONNRESET");
for (const stage of ["broker-read", "database-import"] as const) {
  const secret = "Bearer secret-token; account=private-account; trade=private-trade";
  const diagnostic = brokerHistoryFailure(stage, { message: secret, detail: secret, stack: secret, query: secret, values: [secret],
    constraint: secret, table: secret, column: secret, status: secret, code: secret });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false, "private payloads must never reach logs");
  assert.equal(diagnostic.code, null);
  assert.equal(diagnostic.httpStatus, null);
  assert.doesNotThrow(() => brokerHistoryFailure(stage, null));
}
// Exercise both production failure paths with fake transport and a pool that cannot write.
const keys = ["DATABASE_URL", "OANDA_ACCOUNT_ID", "OANDA_API_KEY", "OANDA_ENVIRONMENT"] as const;
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, { DATABASE_URL: "postgres://diagnostic:fixture@127.0.0.1:1/unused",
  OANDA_ACCOUNT_ID: "fixture-account", OANDA_API_KEY: "fixture-token", OANDA_ENVIRONMENT: "practice" });
const originalFetch = globalThis.fetch, originalWarn = console.warn;
const originalNow = Date.now;
const logs: unknown[][] = [];
const { db } = await import("../src/database.js");
const pool = db();
const databaseError = Object.assign(new Error("private row details must not be logged"), { code: "42P01", table: "paper_trades" });
pool.query = (async () => { throw databaseError; }) as typeof pool.query;
try {
  console.warn = (...args: unknown[]) => { logs.push(args); };
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const { syncPracticeBrokerHistory, requestPracticeHistorySync } = await import("../src/paper-cycle.js");
  const pending = syncPracticeBrokerHistory("diagnostic-broker");
  assert.equal(syncPracticeBrokerHistory("diagnostic-broker"), pending, "concurrent imports still share one request");
  assert.deepEqual(await pending, { imported: 0, unavailable: true }, "a broker failure still permits stored journal reads");
  assert.equal(logs.length, 1, "one diagnostic per failed shared import");
  assert.equal((logs[0]![1] as { stage: string }).stage, "broker-read");

  globalThis.fetch = async () => new Response(JSON.stringify({ trades: [{ id: "fixture-trade", instrument: "EUR_USD",
    price: "1.1", initialUnits: "1", openTime: "2026-10-20T12:00:00Z", closeTime: "2026-10-20T13:00:00Z",
    averageClosePrice: "1.2", realizedPL: "0.1" }] }), { status: 200 });
  await assert.rejects(syncPracticeBrokerHistory("diagnostic-database"), error => error === databaseError);
  assert.equal(logs.length, 2);
  assert.equal((logs[1]![1] as { stage: string }).stage, "database-import");
  assert.equal((logs[1]![1] as { code: string }).code, "42P01");
  assert.equal(JSON.stringify(logs).includes(databaseError.message), false);

  let now = 100_000;
  Date.now = () => now;
  assert.equal(requestPracticeHistorySync("diagnostic-recovery").status, "running");
  await assert.rejects(syncPracticeBrokerHistory("diagnostic-recovery"));
  const failed = requestPracticeHistorySync("diagnostic-recovery");
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryAfterMs, 15_000, "failed imports expose the actual retry backoff to Home");
  now += 5_000;
  assert.equal(requestPracticeHistorySync("diagnostic-recovery").retryAfterMs, 10_000, "status checks do not postpone recovery");
  now += 10_000;
  globalThis.fetch = async () => new Response(JSON.stringify({ trades: [] }), { status: 200 });
  assert.equal(requestPracticeHistorySync("diagnostic-recovery").status, "running", "a failed sync retries when backoff expires");
  await syncPracticeBrokerHistory("diagnostic-recovery");
  assert.equal(requestPracticeHistorySync("diagnostic-recovery").status, "ready", "successful retries clear the failure status");
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  requestPracticeHistorySync("diagnostic-unavailable-recovery");
  await syncPracticeBrokerHistory("diagnostic-unavailable-recovery");
  const unavailable = requestPracticeHistorySync("diagnostic-unavailable-recovery");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.retryAfterMs, 15_000, "broker outages use the same bounded recovery cadence");
} finally {
  globalThis.fetch = originalFetch; console.warn = originalWarn;
  Date.now = originalNow;
  await pool.end();
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
}
console.log("Broker history checks passed: failure diagnostics, stored-data fallback, retry timing, recovery and private-field exclusion.");
