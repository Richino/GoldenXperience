import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { db } from "../src/database.js";
import { TradePlanError, transitionInTx } from "../src/trade-plans.js";
import { CLAIM_SQL } from "../src/trade-plan-monitor.js";

/**
 * Checks the database guards of migration 057 against the configured
 * database. Everything runs inside one transaction that is ROLLED BACK, so it
 * leaves no rows behind — safe against production.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });

const client = await db().connect();
async function refused(label: string, sql: string, values: unknown[] = []) {
  await client.query("SAVEPOINT probe");
  try {
    await client.query(sql, values);
    assert.fail(`${label}: the database accepted it`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    await client.query("ROLLBACK TO SAVEPOINT probe");
    console.log(`  refused as expected: ${label}`);
  }
}

try {
  await client.query("BEGIN");
  const owner = (await client.query<{ id: string }>("SELECT id FROM users WHERE role='owner' LIMIT 1")).rows[0];
  assert.ok(owner, "no owner user");
  const settings = await client.query("SELECT kill_switch,auto_limits_approved_at,live_trading_enabled FROM trade_plan_risk_settings WHERE user_id=$1", [owner.id]);
  assert.equal(settings.rowCount, 1, "owner has no risk settings row");
  assert.equal(settings.rows[0].live_trading_enabled, false);
  assert.equal(settings.rows[0].auto_limits_approved_at, null, "auto limits must start unapproved");

  const plan = (await client.query<{ id: string }>(
    `INSERT INTO trade_plans(user_id,analysis_id,instrument,direction,setup_type,plan_hash,timeframe,market_bias,trend_classification,
                             entry_zone_low,entry_zone_high,stop_loss,take_profit,max_risk_percent,plan,strategy_version,expires_at)
     VALUES($1,gen_random_uuid(),'EUR_USD','BUY','BREAKOUT_RETEST','h1','H1','Bearish','DOWN',1.1235,1.124,1.12,1.13,1,'{}','db-check',now()+interval '1 day')
     RETURNING id`, [owner.id],
  )).rows[0]!;
  const base = { userId: owner.id, planId: plan.id };

  await transitionInTx(client, { ...base, to: "PENDING_APPROVAL", actor: "system", reason: "db-check" });
  // Approval for the wrong hash does not count.
  await client.query("UPDATE trade_plans SET monitoring_mode='NOTIFY' WHERE id=$1", [plan.id]);
  await client.query("INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) VALUES($1,$2,1,'stale','NOTIFY')", [plan.id, owner.id]);
  await assert.rejects(transitionInTx(client, { ...base, to: "APPROVED", actor: "user", reason: "db-check" }), TradePlanError);
  await client.query("UPDATE trade_plan_approvals SET revoked_at=now() WHERE plan_id=$1", [plan.id]);
  await client.query("INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) VALUES($1,$2,1,'h1','NOTIFY')", [plan.id, owner.id]);
  await refused("second active approval", "INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) VALUES($1,$2,1,'h1','NOTIFY')", [plan.id, owner.id]);
  await transitionInTx(client, { ...base, to: "APPROVED", actor: "user", reason: "db-check" });
  await transitionInTx(client, { ...base, to: "MONITORING", actor: "system", reason: "db-check" });
  // Notify mode cannot reach execution, even via the server.
  await transitionInTx(client, { ...base, to: "CONFIRMED", actor: "monitor", reason: "db-check" });
  await assert.rejects(transitionInTx(client, { ...base, to: "EXECUTION_PENDING", actor: "monitor", reason: "db-check" }), TradePlanError);
  // Stale reads are refused.
  await assert.rejects(transitionInTx(client, { ...base, to: "NOTIFIED", actor: "monitor", reason: "db-check", expectedStateVersion: "1" }), TradePlanError);
  await transitionInTx(client, { ...base, to: "NOTIFIED", actor: "monitor", reason: "db-check" });

  // Raw SQL that bypasses the server is still refused by the database.
  await refused("NOTIFIED -> FILLED by raw UPDATE", "UPDATE trade_plans SET status='FILLED' WHERE id=$1", [plan.id]);
  await refused("changing direction", "UPDATE trade_plans SET direction='SELL' WHERE id=$1", [plan.id]);
  await refused("pausing a non-monitored plan", "UPDATE trade_plans SET paused_at=now() WHERE id=$1", [plan.id]);
  await refused("editing an event", "UPDATE trade_plan_events SET reason='x' WHERE plan_id=$1", [plan.id]);
  await refused("deleting an event", "DELETE FROM trade_plan_events WHERE plan_id=$1", [plan.id]);
  await refused("enabling live trading", "UPDATE trade_plan_risk_settings SET live_trading_enabled=true WHERE user_id=$1", [owner.id]);
  const attempt = (await client.query<{ id: string }>(
    "INSERT INTO trade_plan_execution_attempts(plan_id,user_id,plan_version,idempotency_key) VALUES($1,$2,1,$3) RETURNING id",
    [plan.id, owner.id, `${plan.id}:1`],
  )).rows[0]!;
  await refused("duplicate execution attempt", "INSERT INTO trade_plan_execution_attempts(plan_id,user_id,plan_version,idempotency_key) VALUES($1,$2,1,$3)", [plan.id, owner.id, `${plan.id}:1`]);
  await refused("live broker order", "INSERT INTO trade_plan_broker_orders(attempt_id,plan_id,user_id,environment,kind,client_order_id) VALUES($1,$2,$3,'live','ENTRY','x')", [attempt.id, plan.id, owner.id]);

  const events = await client.query("SELECT from_status,to_status FROM trade_plan_events WHERE plan_id=$1 ORDER BY id", [plan.id]);
  assert.deepEqual(events.rows.map((row) => `${row.from_status}>${row.to_status}`),
    ["DRAFT>PENDING_APPROVAL", "PENDING_APPROVAL>APPROVED", "APPROVED>MONITORING", "MONITORING>CONFIRMED", "CONFIRMED>NOTIFIED"]);
  // Monitor leases: one worker holds a plan until its lease expires; paused plans are never claimed.
  const watched = (await client.query<{ id: string }>(
    `INSERT INTO trade_plans(user_id,analysis_id,instrument,direction,setup_type,status,plan_hash,timeframe,market_bias,trend_classification,
                             entry_zone_low,entry_zone_high,stop_loss,take_profit,max_risk_percent,plan,strategy_version,expires_at,monitoring_mode)
     VALUES($1,gen_random_uuid(),'EUR_USD','SELL','SR_REVERSAL','DRAFT','h2','H1','Bearish','DOWN',1.1235,1.124,1.13,1.12,1,'{}','db-check',now()+interval '1 day','NOTIFY')
     RETURNING id`, [owner.id],
  )).rows[0]!;
  const w = { userId: owner.id, planId: watched.id };
  await transitionInTx(client, { ...w, to: "PENDING_APPROVAL", actor: "system", reason: "db-check" });
  await client.query("INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) VALUES($1,$2,1,'h2','NOTIFY')", [watched.id, owner.id]);
  await transitionInTx(client, { ...w, to: "APPROVED", actor: "user", reason: "db-check" });
  await transitionInTx(client, { ...w, to: "MONITORING", actor: "system", reason: "db-check" });
  await client.query("INSERT INTO trade_plan_monitoring_state(plan_id) VALUES($1)", [watched.id]);
  const claim = async (worker: string) => (await client.query<{ plan_id: string }>(CLAIM_SQL, [worker, 120])).rows.map((row) => row.plan_id);
  assert.ok((await claim("worker-a")).includes(watched.id), "worker A claims the due plan");
  assert.ok(!(await claim("worker-b")).includes(watched.id), "worker B cannot take a leased plan");
  assert.ok((await claim("worker-a")).includes(watched.id), "worker A may renew its own lease");
  await client.query("UPDATE trade_plan_monitoring_state SET lease_expires_at=now()-interval '1 second' WHERE plan_id=$1", [watched.id]);
  assert.ok((await claim("worker-b")).includes(watched.id), "an expired lease (crashed worker) is taken over");
  await client.query("UPDATE trade_plan_monitoring_state SET lease_owner=NULL,lease_expires_at=NULL WHERE plan_id=$1", [watched.id]);
  await client.query("UPDATE trade_plans SET paused_at=now() WHERE id=$1", [watched.id]);
  assert.ok(!(await claim("worker-a")).includes(watched.id), "a paused plan is not monitored");
  console.log("  monitor leases behave");

  // Deleting the plan cascades through the append-only events.
  await client.query("DELETE FROM trade_plans WHERE id=$1", [plan.id]);
  console.log("trade plans DB guards: all checks passed (rolled back)");
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db().end();
}
