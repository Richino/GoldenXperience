import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { db } from "../src/database.js";

config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
const client = await db().connect();
try {
  await client.query("BEGIN");
  const owner = (await client.query<{ id: string }>("SELECT id FROM users LIMIT 1")).rows[0];
  assert.ok(owner, "An existing owner is needed for this rollback-only schema check");
  // An advisory lock also serializes concurrent Analyze requests on a pair.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`observer-db-test:${owner.id}`]);
  const id = randomUUID(), time = new Date().toISOString(), testPair = "EUR_USD";
  const version = (await client.query<{ version: number }>("SELECT coalesce(max(version),0)::integer+1 AS version FROM market_observer_plans WHERE user_id=$1 AND instrument=$2", [owner.id, testPair])).rows[0]!.version;
  // All modifications remain invisible to other sessions and are rolled back.
  await client.query("UPDATE market_observer_plans SET status='EXPIRED' WHERE user_id=$1 AND instrument=$2 AND status IN ('WATCHING','READY','PAUSED','TRIGGERED')", [owner.id, testPair]);
  await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan) VALUES($1,$2,$3,$4,'WATCHING',$5::jsonb)", [id, owner.id, testPair, version, JSON.stringify({ id, status: "WATCHING", entry: 1.1 })]);
  const duplicate = await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan) VALUES($1,$2,$3,$4,'WATCHING','{}') ON CONFLICT DO NOTHING", [randomUUID(), owner.id, testPair, version + 1]);
  assert.equal(duplicate.rowCount, 0, "At most one live plan per owner/pair");
  await client.query("UPDATE market_observer_plans SET status='EXPIRED',plan=plan || jsonb_build_object('status','EXPIRED','updatedAt',$2::text),updated_at=$2::timestamptz WHERE id=$1", [id, time]);
  assert.equal((await client.query("UPDATE market_observer_plans SET status='READY' WHERE id=$1 AND status NOT IN ('INVALIDATED','EXPIRED','CLOSED')", [id])).rowCount, 0, "An old async write cannot revive a replaced/cancelled plan");
  await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,'EXPIRED','test','{}')", [id, time]);
  assert.equal((await client.query("SELECT plan->>'entry' AS entry FROM market_observer_plans WHERE id=$1", [id])).rows[0].entry, "1.1", "Status changes preserve frozen geometry");
  assert.equal((await client.query("SELECT count(*)::integer AS n FROM market_observer_events WHERE plan_id=$1", [id])).rows[0].n, 1);
  console.log("Observer database checks passed: plan versions, active uniqueness, frozen geometry, typed timestamps, journal events and stale-write protection. All test changes rolled back.");
} finally { await client.query("ROLLBACK"); client.release(); await db().end(); }
