import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import type { Pool } from "pg";
import { NEWS_V3_DEFAULTS, type NewsRun, type NewsLeg } from "../../frontend/src/lib/news/news-straddle-v3.js";
import { createNewsRun, PgNewsRepository } from "../src/news-straddle/store.js";
import { db, type transaction } from "../src/database.js";

config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; persistence checks must not silently skip.");
const c = await db().connect();
try {
  await c.query("BEGIN"); await c.query("SET LOCAL lock_timeout='3s'");
  const user = (await c.query<{ id: string }>("INSERT INTO users(email,password_hash,role) VALUES($1,'x','owner') RETURNING id", [`news-v3-test-${randomUUID()}@example.invalid`])).rows[0]!.id;
  const now = new Date().toISOString(), id = randomUUID();
  const leg = (side: "long" | "short"): NewsLeg => ({ side, entryId: randomUUID(), clientId: `${id}-${side}`, tradeClientId: `${id}-trade-${side}`, state: "UNSENT", entry: side === "long" ? 1.1211 : 1.119, bound: side === "long" ? 1.1213 : 1.1188, stopDistance: 0.0015, units: 1000,
    orderId: null, tradeId: null, paperTradeId: null, submittedAt: null, acknowledgedAt: null, brokerTime: null, cancellationRequestedAt: null, cancellationConfirmedAt: null, fillTime: null, fillPrice: null, slippagePips: null, fillSpreadPips: null, initialStop: null, activeStop: null, trailingOrderId: null, trailingRequestedAt: null, trailingActivatedAt: null, unrealizedPips: null, maximumFavorablePips: 0, protectedPips: null, realizedPL: null, realizedR: null, exitPrice: null, closedAt: null, lastProtectionAt: null });
  const run: NewsRun = { id, userId: user, accountKey: `test-${id}`, instrument: "EUR_USD", eventKey: `test-${id}`, version: 3, revision: 0, state: "SCHEDULED", release: { id, title: "Persistence fixture", currency: "USD", time: now, impact: 3, provider: "forex_factory" }, settings: { ...NEWS_V3_DEFAULTS }, createdAt: now, targetSubmitAt: now, preparedAt: null, calendarCheckedAt: now, calendarFetchedAt: now, transactionSeed: "1", lastReconciledAt: null, preparedQuote: { bid: 1.12, ask: 1.1201, time: now }, risk: { equity: 10000, currency: "USD", conversion: 1, eventCash: 100, perLegCash: 1.5, perLegPercent: 0.5, stopPips: 15, atrPips: null }, constraints: null, clock: null, legs: { long: leg("long"), short: leg("short") }, firstFillSide: null, exception: null, reason: null, endedAt: null, timeline: [] };
  let sp = 0;
  const transact: typeof transaction = async fn => {
    const name = `test_create_${++sp}`; await c.query(`SAVEPOINT ${name}`);
    try { const value = await fn(c); await c.query(`RELEASE SAVEPOINT ${name}`); return value; }
    catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  // Isolate the account-wide pair-busy check without touching existing rows.
  await c.query("CREATE TEMP TABLE pending_manual_entries (LIKE public.pending_manual_entries INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP");
  await c.query("CREATE TEMP TABLE paper_trades (LIKE public.paper_trades INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP");
  await createNewsRun(run, transact);
  assert.equal((await createNewsRun({ ...structuredClone(run), id: randomUUID() }, transact)).id, id);
  await assert.rejects(() => createNewsRun({ ...structuredClone(run), settings: { ...run.settings, distancePips: 20 } }, transact), /cannot be replaced/);
  await assert.rejects(() => createNewsRun({ ...structuredClone(run), id: randomUUID(), eventKey: "same-release-other-title", instrument: "GBP_USD" }, transact), /risk budget/);
  await assert.rejects(() => createNewsRun({ ...structuredClone(run), id: randomUUID(), eventKey: "other-event", release: { ...run.release, time: new Date(Date.parse(now) + 120000).toISOString() } }, transact), /already has/);
  assert.equal((await c.query("SELECT 1 FROM pending_manual_entries")).rowCount, 2);
  // Map the repository's short transactions to savepoints inside this rollback-only test.
  const wrapped = { query: async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN") return c.query("SAVEPOINT repo_save");
    if (sql === "COMMIT") return c.query("RELEASE SAVEPOINT repo_save");
    if (sql === "ROLLBACK") return c.query("ROLLBACK TO SAVEPOINT repo_save");
    return c.query(sql, values);
  }, release() {} };
  const pool = { connect: async () => wrapped, query: wrapped.query } as unknown as Pool;
  const repo = new PgNewsRepository(run.accountKey, pool);
  await repo.locked(id, async s => {
    const stored = (await s.read())!; const l = stored.legs.long;
    Object.assign(l, { state: "FILLED", fillTime: now, fillPrice: 1.1211, tradeId: "fake-broker-1", initialStop: 1.1196, activeStop: 1.1196 });
    stored.firstFillSide = "long"; stored.state = "OCO_CANCELLING";
    await s.save(stored, { event: "fake_fill", transactionId: "test-transaction" }); assert.equal(await s.seen("test-transaction"), true);
    const entry = (await c.query("SELECT target_price,metadata,paper_trade_id FROM pending_manual_entries WHERE id=$1", [l.entryId])).rows[0]!;
    assert.equal(entry.target_price, null); assert.equal(entry.metadata.configVersion, 3); assert.equal(entry.metadata.newsRun.accountKey, undefined); assert.ok(entry.paper_trade_id);
    const paper = (await c.query("SELECT entry,stop,target FROM paper_trades WHERE id=$1", [entry.paper_trade_id])).rows[0]!;
    assert.equal(Number(paper.target), Number(paper.entry));
    l.activeStop = 1.1224; stored.state = "TRAILING"; await s.save(stored, { event: "fake_trail" });
    assert.equal(Number((await c.query("SELECT stop FROM paper_trades WHERE id=$1", [entry.paper_trade_id])).rows[0]!.stop), 1.1196);
    l.closedAt = now; l.exitPrice = 1.1224; l.realizedPL = 1.3; l.realizedR = 1.3 / 1.5;
    await s.save(stored, { event: "fake_close" });
    assert.equal((await c.query("SELECT status FROM paper_trades WHERE id=$1", [entry.paper_trade_id])).rows[0]!.status, "closed");
  });
  console.log("News v3 database: duplicate settings, active pair, no-target projection, immutable R reference, trade closure and transaction replay passed. All fixtures rolled back; no broker calls.");
} finally { await c.query("ROLLBACK"); c.release(); await db().end(); }
