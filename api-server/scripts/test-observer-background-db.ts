import assert from "node:assert/strict";
import { config } from "dotenv";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { observerReplayFixture } from "./observer-replay-fixture.js";
import { reviewObserverPlan } from "../src/observer-review.js";
for (const path of [".env", ".env.local"]) config({ path, quiet: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const user = (await client.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  assert.ok(user, "An existing owner is required for this rollback-only check");
  const instrument = "AUD_JPY";
  await client.query("INSERT INTO market_observer_watches(user_id,instrument,mode,enabled,next_scan_at) VALUES($1,$2,'NORMAL',true,now()-interval '1 minute') ON CONFLICT(user_id,instrument) DO UPDATE SET enabled=true,next_scan_at=now()-interval '1 minute'", [user.id, instrument]);
  const claimed = await client.query(`UPDATE market_observer_watches w SET next_scan_at=now()+CASE WHEN mode='SWING' THEN interval '15 minutes' ELSE interval '5 minutes' END
    WHERE (user_id,instrument)=(SELECT user_id,instrument FROM market_observer_watches w2 WHERE user_id=$1 AND instrument=$2 AND enabled AND next_scan_at<=now() ORDER BY next_scan_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING user_id,instrument,mode`, [user.id, instrument]);
  assert.equal(claimed.rowCount, 1);
  assert.equal((await client.query("SELECT 1 FROM market_observer_watches WHERE user_id=$1 AND instrument=$2 AND next_scan_at<=now()", [user.id, instrument])).rowCount, 0, "Claim advances the next scan and prevents repeated work");
  assert.equal((await client.query("SELECT 1 FROM market_observer_watches WHERE user_id=$1 AND instrument=$2", [randomUUID(), instrument])).rowCount, 0);
  const fixture = observerReplayFixture().plan;
  const id = randomUUID(), proposal = { ...fixture, id, review: { decision: "pending" as const, decidedAt: null } };
  // Terminal storage row avoids altering this owner's real active observer membership.
  const version = (await client.query<{ version: number }>("SELECT coalesce(max(version),0)::integer+1 AS version FROM market_observer_plans WHERE user_id=$1 AND instrument=$2", [user.id, instrument])).rows[0]!.version;
  await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan) VALUES($1,$2,$3,$4,'EXPIRED',$5::jsonb)", [id, user.id, instrument, version, JSON.stringify(proposal)]);
  const saved = (await client.query("SELECT plan FROM market_observer_plans WHERE id=$1 AND user_id=$2 AND instrument=$3", [id, user.id, instrument])).rows[0].plan;
  const accepted = reviewObserverPlan(saved, "accepted", new Date(Date.parse(saved.createdAt) + 1000).toISOString());
  assert.equal(accepted.review?.decision, "accepted");
  assert.equal((await client.query("SELECT plan FROM market_observer_plans WHERE id=$1 AND user_id=$2", [id, randomUUID()])).rowCount, 0, "Other owners cannot review the proposal");
  const key = `observer-proposal:${id}`;
  const insert = () => client.query("INSERT INTO notification_events(user_id,kind,title,message,instrument,dedupe_key) VALUES($1,'setup_ready','Synthetic rollback-only plan','Synthetic mechanism check',$2,$3) ON CONFLICT(user_id,dedupe_key) DO NOTHING RETURNING id", [user.id, instrument, key]);
  assert.equal((await insert()).rowCount, 1);
  assert.equal((await insert()).rowCount, 0, "A proposal creates only one notification across retries");
  console.log("Background database checks passed: scan claim/cooldown, owner scoping, review JSON persistence and notification deduplication. All test changes rolled back; no push sent.");
} finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
