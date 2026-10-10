import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { db } from "../src/database.js";
import type { ObserverPlan } from "../../frontend/src/lib/market-observer-types.js";
import { stopObserverPlan } from "../src/market-observer-plan.js";
import { observerEvaluationRow, summarizeObserverPlans } from "../src/market-observer-evaluation.js";
import { observerReplayFixture } from "./observer-replay-fixture.js";

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
  await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) SELECT id,$2,status,'test',plan FROM market_observer_plans WHERE id=$1", [id, time]);
  assert.equal((await client.query("SELECT plan->>'entry' AS entry FROM market_observer_plans WHERE id=$1", [id])).rows[0].entry, "1.1", "Status changes preserve frozen geometry");
  assert.equal((await client.query("SELECT count(*)::integer AS n FROM market_observer_events WHERE plan_id=$1", [id])).rows[0].n, 1);
  const secondId = randomUUID();
  const signal = { id: secondId, version: version + 1, instrument: testPair, status: "TRIGGERED", entry: 1.1001, stop: 1.099, target: 1.102, triggeredAt: time, outcome: null } as ObserverPlan;
  const stopped = stopObserverPlan(signal, time, "Monitoring stopped by you.");
  await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [secondId, owner.id, testPair, version + 1, stopped.status, JSON.stringify(stopped)]);
  await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)", [secondId, time, stopped.status, stopped.reason, JSON.stringify(stopped)]);
  const archive = await client.query(`SELECT p.version,e.snapshot FROM market_observer_events e JOIN market_observer_plans p ON p.id=e.plan_id WHERE p.user_id=$1 AND p.instrument=$2 AND p.id=ANY($3::uuid[]) ORDER BY e.id DESC LIMIT 60`, [owner.id, testPair, [id, secondId]]);
  assert.deepEqual(archive.rows.map(r => r.version), [version + 1, version], "Archive spans multiple versions");
  assert.equal(archive.rows[0].snapshot.outcome.kind, "monitoring_stopped");
  assert.equal(archive.rows[0].snapshot.entry, signal.entry, "Final events carry frozen evidence");
  assert.equal((await client.query(`SELECT e.id FROM market_observer_events e JOIN market_observer_plans p ON p.id=e.plan_id WHERE p.user_id=$1 AND p.instrument=$2 AND p.id=ANY($3::uuid[])`, [owner.id, "AUD_JPY", [id, secondId]])).rowCount, 0, "Pair scoping excludes other pair's history");
  assert.equal((await client.query(`SELECT e.id FROM market_observer_events e JOIN market_observer_plans p ON p.id=e.plan_id WHERE p.user_id=$1 AND p.id=ANY($2::uuid[])`, [randomUUID(), [id, secondId]])).rowCount, 0, "Owner scoping excludes private plans");
  const measuredId = randomUUID(), fixture = observerReplayFixture().plan;
  const measured: ObserverPlan = { ...fixture, id: measuredId, version: version + 2, status: "CLOSED", triggeredAt: fixture.createdAt, observedEntry: 1.1001,
    outcome: { kind: "target_observed", at: fixture.expiresAt, price: 1.102 },
    measurements: { version: "observer-evaluation@1", engineVersion: "synthetic-db-check", planRulesVersion: "observer-plan@2", patternRulesVersion: "synthetic-db-check", triggerQuote: { bid: 1.10005, ask: 1.1001, time: fixture.createdAt, spreadPips: 0.5 },
      initialRiskPips: 11, lastQuoteKey: "synthetic", lastObservedAt: fixture.expiresAt, lastExitPrice: 1.102, observedQuotes: 2,
      maxFavorablePips: 19, maxAdversePips: 0.5, firstGapAt: null, context: { lean: "up", pressure: "up", relation: "aligned", patterns: [] } } };
  await client.query("INSERT INTO market_observer_plans(id,user_id,instrument,version,status,plan) VALUES($1,$2,$3,$4,'CLOSED',$5::jsonb)", [measuredId, owner.id, testPair, measured.version, JSON.stringify(measured)]);
  await client.query("INSERT INTO market_observer_events(plan_id,at,status,reason,snapshot) VALUES($1,$2,'CLOSED','synthetic evaluation check',$3::jsonb)", [measuredId, time, JSON.stringify(measured)]);
  const stored = (await client.query<{ plan: ObserverPlan }>("SELECT plan FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 AND id=$3", [owner.id, testPair, measuredId])).rows[0]!.plan;
  assert.deepEqual(stored.measurements, measured.measurements, "Quote measurements survive PostgreSQL JSON round trip");
  assert.equal(observerEvaluationRow(stored)?.result, "target");
  assert.ok(Math.abs(summarizeObserverPlans([stored], testPair, time).metrics.meanObservedR! - 19 / 11) < 1e-8);
  assert.equal((await client.query("SELECT id FROM market_observer_plans WHERE user_id=$1 AND instrument=$2 AND id=$3", [randomUUID(), testPair, measuredId])).rowCount, 0, "Evaluation cannot access another owner's private measurements");
  assert.deepEqual((await client.query("SELECT snapshot->'measurements' AS m FROM market_observer_events WHERE plan_id=$1", [measuredId])).rows[0].m, stored.measurements, "Terminal event contains the measurements used by the report");
  console.log("Observer database checks passed: persisted measurements/evaluation, version archive, owner/pair scoping, full event snapshots, active uniqueness and stale-write protection. All test changes rolled back.");
} finally { await client.query("ROLLBACK"); client.release(); await db().end(); }
