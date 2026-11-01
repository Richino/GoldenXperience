import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { config } from "dotenv";
import { db } from "../src/database.js";

for (const path of [".env", ".env.local"]) config({ path, quiet: true });
const client = await db().connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE SCHEMA gx_technical_test");
  await client.query("SET LOCAL search_path TO gx_technical_test");
  await client.query(await fs.readFile(new URL("../migrations/068_technical_analyzer.sql", import.meta.url), "utf8"));
  await client.query(await fs.readFile(new URL("../migrations/069_technical_analyzer_evaluation_retry.sql", import.meta.url), "utf8"));
  const args = ["fixture:1", "fixture-user", "fixture-account", "EUR_USD", "test", "2026-10-01T12:00:00Z", "2026-10-01T21:00:00Z", 1, true, "unique-hour", '{"immutable":true}', '{"bias":"BULLISH"}'];
  await client.query(`INSERT INTO gx_technical_forecasts(id,user_id,account_key,instrument,model_version,created_at,expires_at,horizon,eligible,fingerprint,snapshot,forecast)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, args);
  async function rejected(sql: string, params: unknown[] = []) {
    await client.query("SAVEPOINT invalid_write");
    await assert.rejects(client.query(sql, params));
    await client.query("ROLLBACK TO SAVEPOINT invalid_write");
  }
  await rejected("UPDATE gx_technical_forecasts SET eligible=false");
  await rejected("DELETE FROM gx_technical_forecasts");
  await rejected(`INSERT INTO gx_technical_forecasts SELECT 'another-id',user_id,account_key,instrument,model_version,created_at,expires_at,horizon,eligible,fingerprint,snapshot,forecast FROM gx_technical_forecasts`);
  await client.query("INSERT INTO gx_technical_outcomes(forecast_id,outcome) VALUES($1,$2)", ["fixture:1", '{"price":1.2}']);
  await client.query("INSERT INTO gx_technical_evaluation_attempts(forecast_id,retry_after,last_reason) VALUES($1,now()+interval '6 hours',$2)", ["fixture:1", "missing exact close"]);
  assert.equal((await client.query("SELECT retry_after>now() AS delayed FROM gx_technical_evaluation_attempts")).rows[0].delayed, true);
  await rejected("UPDATE gx_technical_outcomes SET outcome='{}'");
  await rejected("DELETE FROM gx_technical_outcomes");
  assert.equal((await client.query("SELECT snapshot->>'immutable' AS original FROM gx_technical_forecasts")).rows[0].original, "true");
  await client.query("INSERT INTO gx_technical_outcomes(forecast_id,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING", ["fixture:1", '{"price":9}']);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM gx_technical_outcomes")).rows[0].n, 1);
  console.log("PASS migration, immutable forecasts/outcomes, duplicate observation rejection, idempotent settlement, original snapshot preservation (rolled back)");
} finally { await client.query("ROLLBACK"); client.release(); await db().end(); }
