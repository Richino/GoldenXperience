import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { pendingManualEntryListQuery } from "../src/pending-manual-entries.js";

config({ path: ".env", quiet: true });
config({ path: ".env.local", quiet: true });
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the entry-list regression check.");
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 10_000 });
await client.connect();
try {
  await client.query("BEGIN");
  // Only temporary fixture tables are written; production tables supply column definitions only.
  await client.query("CREATE TEMP TABLE pending_manual_entries AS SELECT * FROM public.pending_manual_entries WITH NO DATA");
  await client.query("CREATE TEMP TABLE paper_trades AS SELECT id,status FROM public.paper_trades WITH NO DATA");
  const owner = randomUUID(), other = randomUUID();
  const open = randomUUID(), closed = randomUUID(), missing = randomUUID();
  await client.query("INSERT INTO paper_trades(id,status) VALUES($1,'open'),($2,'closed')", [open, closed]);
  const expected: string[] = [];
  for (const [status, tradeId, active] of [
    ["PENDING", null, true], ["TRIGGERING", null, true],
    ["TRIGGERED", open, true], ["TRIGGERED", missing, true], ["TRIGGERED", null, true],
    ["TRIGGERED", closed, false], ["CANCELLED", null, false], ["EXPIRED", null, false],
    ["INVALIDATED", null, false], ["FAILED", null, false],
  ] as const) {
    const id = randomUUID();
    await client.query("INSERT INTO pending_manual_entries(id,user_id,instrument,status,paper_trade_id,created_at) VALUES($1,$2,'EUR_USD',$3,$4,now())", [id, owner, status, tradeId]);
    if (active) expected.push(id);
  }
  await client.query("INSERT INTO pending_manual_entries(id,user_id,instrument,status,created_at) VALUES($1,$2,'GBP_USD','PENDING',now()),($3,$4,'EUR_USD','PENDING',now())", [randomUUID(), owner, randomUUID(), other]);
  const list = async (scope: "active" | "all", instrument?: string) => {
    const statement = pendingManualEntryListQuery(owner, instrument, scope);
    return (await client.query(statement.text, statement.values)).rows;
  };
  assert.deepEqual((await list("active", "EUR_USD")).map(row => row.id).sort(), expected.sort());
  assert.equal((await list("active")).length, 6);
  assert.equal((await list("all", "EUR_USD")).length, 10);
  assert.equal((await list("all")).length, 11);
  const defaultQuery = pendingManualEntryListQuery(owner);
  assert.equal((await client.query(defaultQuery.text, defaultQuery.values)).rows.length, 11);
  console.log("Pending-entry list checks passed: active/open, missing-trade reconciliation, history, pair and tenant isolation.");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
