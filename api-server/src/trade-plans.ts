import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { isKnownInstrument } from "../../frontend/src/lib/instruments/catalog.js";
import { query, transaction } from "./database.js";
import {
  checkTransition,
  planHash,
  type MaterialPlanFields,
  type MonitoringMode,
  type TradePlanActor,
  type TradePlanStatus,
} from "./trade-plan-state.js";

/**
 * Trade plan persistence. Every status change goes through `transitionInTx`:
 * the row is locked, the edge is checked by trade-plan-state.ts, the row's
 * state_version is bumped and an append-only event is written — all in one
 * transaction. Clients never set a status, a confirmation or a size directly.
 */

export class TradePlanError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

export type TradePlanDirection = "BUY" | "SELL";
export type TradePlanSetupType = "BREAKOUT_RETEST" | "SR_REVERSAL";

export type TradePlanInput = {
  analysisId?: string;
  instrument: string;
  direction: TradePlanDirection;
  setupType: TradePlanSetupType;
  timeframe: string;
  marketBias: string;
  trendClassification: string;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number | null;
  takeProfit: number | null;
  rewardRisk: number | null;
  maxRiskPercent: number;
  expiresAt: string;
  /** Trigger, confirmation rules, stop/target/sizing rules, limits, news, invalidation, explanation. */
  plan: Record<string, unknown>;
  analysisInputs?: Record<string, unknown>;
  strategyVersion: string;
  marketDataAt?: string | null;
  conditions?: Array<{ key: string; label: string }>;
};

type PlanRow = {
  id: string;
  user_id: string;
  instrument: string;
  direction: TradePlanDirection;
  setup_type: TradePlanSetupType;
  status: TradePlanStatus;
  plan_version: number;
  plan_hash: string;
  state_version: string;
  monitoring_mode: MonitoringMode | null;
  paused_at: Date | null;
  timeframe: string;
  entry_zone_low: string;
  entry_zone_high: string;
  stop_loss: string | null;
  take_profit: string | null;
  max_risk_percent: string;
  expires_at: Date;
  plan: Record<string, unknown>;
};

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Rejects a plan whose levels contradict its direction or are missing. */
export function validateTradePlanInput(input: TradePlanInput, now = new Date()): string | null {
  if (!isKnownInstrument(input.instrument)) return "Unknown currency pair.";
  if (input.direction !== "BUY" && input.direction !== "SELL") return "Direction must be BUY or SELL.";
  if (input.setupType !== "BREAKOUT_RETEST" && input.setupType !== "SR_REVERSAL") return "Unknown setup type.";
  if (!input.timeframe || !input.marketBias || !input.trendClassification || !input.strategyVersion) return "The plan is missing its context.";
  if (!positive(input.entryZoneLow) || !positive(input.entryZoneHigh) || input.entryZoneHigh < input.entryZoneLow) return "The entry zone is invalid.";
  if (input.stopLoss !== null && !positive(input.stopLoss)) return "The stop-loss is invalid.";
  if (input.takeProfit !== null && !positive(input.takeProfit)) return "The take-profit is invalid.";
  if (input.direction === "BUY") {
    if (input.stopLoss !== null && input.stopLoss >= input.entryZoneLow) return "A BUY stop-loss must sit below the entry zone.";
    if (input.takeProfit !== null && input.takeProfit <= input.entryZoneHigh) return "A BUY target must sit above the entry zone.";
  } else {
    if (input.stopLoss !== null && input.stopLoss <= input.entryZoneHigh) return "A SELL stop-loss must sit above the entry zone.";
    if (input.takeProfit !== null && input.takeProfit >= input.entryZoneLow) return "A SELL target must sit below the entry zone.";
  }
  if (input.rewardRisk !== null && !positive(input.rewardRisk)) return "Reward/risk is invalid.";
  if (!positive(input.maxRiskPercent) || input.maxRiskPercent > 5) return "Risk per trade must be above 0% and at most 5%.";
  const expires = new Date(input.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now.getTime()) return "The plan must expire in the future.";
  if (!input.plan || typeof input.plan !== "object") return "The plan body is missing.";
  return null;
}

function materialFields(input: Pick<TradePlanInput,
  "instrument" | "direction" | "setupType" | "timeframe" | "entryZoneLow" | "entryZoneHigh" | "stopLoss" | "takeProfit" | "maxRiskPercent" | "expiresAt" | "plan">): MaterialPlanFields {
  return {
    instrument: input.instrument,
    direction: input.direction,
    setupType: input.setupType,
    timeframe: input.timeframe,
    entryZoneLow: input.entryZoneLow,
    entryZoneHigh: input.entryZoneHigh,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    maxRiskPercent: input.maxRiskPercent,
    expiresAt: new Date(input.expiresAt).toISOString(),
    plan: input.plan,
  };
}

async function lockPlan(client: PoolClient, userId: string, planId: string) {
  const found = await client.query<PlanRow>(
    `SELECT id,user_id,instrument,direction,setup_type,status,plan_version,plan_hash,state_version::text,
            monitoring_mode,paused_at,timeframe,entry_zone_low::text,entry_zone_high::text,stop_loss::text,
            take_profit::text,max_risk_percent::text,expires_at,plan
       FROM trade_plans WHERE id=$1 AND user_id=$2 FOR UPDATE`,
    [planId, userId],
  );
  const row = found.rows[0];
  if (!row) throw new TradePlanError("Trade plan not found.", 404);
  return row;
}

async function hasCurrentApproval(client: PoolClient, row: PlanRow) {
  const found = await client.query(
    "SELECT 1 FROM trade_plan_approvals WHERE plan_id=$1 AND revoked_at IS NULL AND plan_version=$2 AND plan_hash=$3",
    [row.id, row.plan_version, row.plan_hash],
  );
  return Boolean(found.rowCount);
}

async function writeEvent(client: PoolClient, row: Pick<PlanRow, "id" | "user_id" | "plan_version">, event: {
  type: string; from?: TradePlanStatus | null; to?: TradePlanStatus | null; actor: TradePlanActor; reason: string; data?: unknown;
}) {
  await client.query(
    `INSERT INTO trade_plan_events(plan_id,user_id,plan_version,event_type,from_status,to_status,actor,reason,data)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [row.id, row.user_id, row.plan_version, event.type, event.from ?? null, event.to ?? null, event.actor, event.reason, JSON.stringify(event.data ?? {})],
  );
}

/**
 * Move a locked plan to `to`. Throws TradePlanError when the edge, actor or
 * context forbids it. `expectedStateVersion` lets a caller that read the plan
 * earlier refuse to act on a plan that changed since.
 */
export async function transitionInTx(client: PoolClient, input: {
  userId: string;
  planId: string;
  to: TradePlanStatus;
  actor: TradePlanActor;
  reason: string;
  data?: unknown;
  expectedStateVersion?: string;
  now?: Date;
}) {
  const row = await lockPlan(client, input.userId, input.planId);
  if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== row.state_version) {
    throw new TradePlanError("The plan changed since it was read. Reload and try again.");
  }
  const check = checkTransition(row.status, input.to, input.actor, {
    monitoringMode: row.monitoring_mode,
    paused: row.paused_at !== null,
    expiresAt: new Date(row.expires_at),
    now: input.now ?? new Date(),
    hasCurrentApproval: await hasCurrentApproval(client, row),
  });
  if (!check.ok) throw new TradePlanError(check.reason);
  const updated = await client.query<{ state_version: string }>(
    `UPDATE trade_plans
        SET status=$3, state_version=state_version+1, updated_at=now(),
            paused_at=CASE WHEN $3='MONITORING' THEN paused_at ELSE NULL END
      WHERE id=$1 AND user_id=$2 RETURNING state_version::text`,
    [row.id, row.user_id, input.to],
  );
  await writeEvent(client, row, { type: "STATUS_CHANGED", from: row.status, to: input.to, actor: input.actor, reason: input.reason, data: input.data });
  return { id: row.id, from: row.status, status: input.to, stateVersion: updated.rows[0]!.state_version };
}

export async function transitionTradePlan(input: Parameters<typeof transitionInTx>[1]) {
  return transaction((client) => transitionInTx(client, input));
}

/** Store a generated plan and put it up for approval. */
export async function createTradePlan(userId: string, input: TradePlanInput) {
  const invalid = validateTradePlanInput(input);
  if (invalid) throw new TradePlanError(invalid, 400);
  const fields = materialFields(input);
  return transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO trade_plans(user_id,analysis_id,instrument,direction,setup_type,status,plan_hash,timeframe,market_bias,
                               trend_classification,entry_zone_low,entry_zone_high,stop_loss,take_profit,reward_risk,
                               max_risk_percent,plan,analysis_inputs,strategy_version,market_data_at,expires_at)
       VALUES($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20)
       RETURNING id`,
      [userId, input.analysisId ?? randomUUID(), input.instrument, input.direction, input.setupType, planHash(fields),
       input.timeframe, input.marketBias, input.trendClassification, input.entryZoneLow, input.entryZoneHigh,
       input.stopLoss, input.takeProfit, input.rewardRisk, input.maxRiskPercent, JSON.stringify(input.plan),
       JSON.stringify(input.analysisInputs ?? {}), input.strategyVersion, input.marketDataAt ?? null, fields.expiresAt],
    );
    const id = inserted.rows[0]!.id;
    for (const [ordinal, condition] of (input.conditions ?? []).entries()) {
      await client.query(
        "INSERT INTO trade_plan_conditions(plan_id,plan_version,condition_key,ordinal,label) VALUES($1,1,$2,$3,$4)",
        [id, condition.key, ordinal, condition.label],
      );
    }
    await writeEvent(client, { id, user_id: userId, plan_version: 1 }, { type: "CREATED", to: "DRAFT", actor: "system", reason: "Generated by Analyze." });
    return transitionInTx(client, { userId, planId: id, to: "PENDING_APPROVAL", actor: "system", reason: "Ready for review." });
  });
}

/**
 * Approve exactly the version the user reviewed and start monitoring it.
 * Auto mode also needs the user's approved risk limits and no kill switch.
 */
export async function approveTradePlan(userId: string, planId: string, input: { planVersion: number; mode: MonitoringMode }) {
  if (input.mode !== "NOTIFY" && input.mode !== "AUTO") throw new TradePlanError("Choose Notify or Auto.", 400);
  if (!Number.isInteger(input.planVersion)) throw new TradePlanError("Say which plan version you are approving.", 400);
  return transaction(async (client) => {
    const row = await lockPlan(client, userId, planId);
    if (row.status !== "PENDING_APPROVAL") throw new TradePlanError(`A ${row.status} plan cannot be approved.`);
    if (row.plan_version !== input.planVersion) throw new TradePlanError("The plan was edited after you reviewed it. Review the new version.");
    if (input.mode === "AUTO") {
      const risk = await client.query<{ kill_switch: boolean; suspended_at: Date | null; auto_limits_approved_at: Date | null }>(
        "SELECT kill_switch,suspended_at,auto_limits_approved_at FROM trade_plan_risk_settings WHERE user_id=$1",
        [userId],
      );
      const settings = risk.rows[0];
      if (!settings?.auto_limits_approved_at) throw new TradePlanError("Approve your automatic-execution risk limits before choosing Auto.");
      if (settings.kill_switch) throw new TradePlanError("The execution kill switch is on.");
      if (settings.suspended_at) throw new TradePlanError("Automatic execution is suspended after broker errors.");
    }
    await client.query(
      "INSERT INTO trade_plan_approvals(plan_id,user_id,plan_version,plan_hash,monitoring_mode) VALUES($1,$2,$3,$4,$5)",
      [row.id, userId, row.plan_version, row.plan_hash, input.mode],
    );
    await client.query("UPDATE trade_plans SET monitoring_mode=$2 WHERE id=$1", [row.id, input.mode]);
    await transitionInTx(client, { userId, planId, to: "APPROVED", actor: "user", reason: `Approved version ${row.plan_version} for ${input.mode}.`, data: { mode: input.mode } });
    await client.query(
      `INSERT INTO trade_plan_monitoring_state(plan_id,stage) VALUES($1,'WAITING')
       ON CONFLICT(plan_id) DO UPDATE SET stage='WAITING',state='{}'::jsonb,consecutive_errors=0,last_error=NULL,updated_at=now()`,
      [row.id],
    );
    return transitionInTx(client, { userId, planId, to: "MONITORING", actor: "system", reason: "Monitoring started." });
  });
}

export async function rejectTradePlan(userId: string, planId: string, reason?: string) {
  return transitionTradePlan({ userId, planId, to: "REJECTED", actor: "user", reason: reason?.trim() || "Rejected by you." });
}

/**
 * Stop a plan before execution. Once an order may be at the broker, cancel
 * has to go through the executor so a resting entry is cancelled first.
 */
export async function cancelTradePlan(userId: string, planId: string, reason?: string) {
  return transaction(async (client) => {
    const row = await lockPlan(client, userId, planId);
    if (["EXECUTION_PENDING", "ORDER_SUBMITTED", "PARTIALLY_FILLED", "FILLED"].includes(row.status)) {
      throw new TradePlanError("This plan is in execution; cancelling it needs the broker step, which is not available yet.");
    }
    const result = await transitionInTx(client, { userId, planId, to: "CANCELLED", actor: "user", reason: reason?.trim() || "Cancelled by you." });
    await client.query("UPDATE trade_plan_approvals SET revoked_at=now(),revoke_reason='Plan cancelled' WHERE plan_id=$1 AND revoked_at IS NULL", [planId]);
    return result;
  });
}

async function setPaused(userId: string, planId: string, paused: boolean) {
  return transaction(async (client) => {
    const row = await lockPlan(client, userId, planId);
    if (row.status !== "MONITORING") throw new TradePlanError("Only a monitored plan can be paused or resumed.");
    if ((row.paused_at !== null) === paused) throw new TradePlanError(paused ? "Monitoring is already paused." : "Monitoring is not paused.");
    const updated = await client.query<{ state_version: string }>(
      `UPDATE trade_plans SET paused_at=${paused ? "now()" : "NULL"},state_version=state_version+1,updated_at=now()
        WHERE id=$1 RETURNING state_version::text`,
      [row.id],
    );
    await writeEvent(client, row, { type: paused ? "PAUSED" : "RESUMED", from: row.status, to: row.status, actor: "user", reason: paused ? "Monitoring paused by you." : "Monitoring resumed by you." });
    return { id: row.id, status: row.status, paused, stateVersion: updated.rows[0]!.state_version };
  });
}

export const pauseTradePlan = (userId: string, planId: string) => setPaused(userId, planId, true);
export const resumeTradePlan = (userId: string, planId: string) => setPaused(userId, planId, false);

/**
 * A material edit: new version, new hash, approval voided, back to review.
 * The caller (Edit, step 2) must have revalidated `next` first.
 */
export async function reviseTradePlan(userId: string, planId: string, next: TradePlanInput, reason: string) {
  const invalid = validateTradePlanInput(next);
  if (invalid) throw new TradePlanError(invalid, 400);
  return transaction(async (client) => {
    const row = await lockPlan(client, userId, planId);
    if (next.instrument !== row.instrument || next.direction !== row.direction) throw new TradePlanError("Pair and direction cannot be edited.", 400);
    if (!["PENDING_APPROVAL", "APPROVED", "MONITORING"].includes(row.status)) throw new TradePlanError(`A ${row.status} plan cannot be edited.`);
    const hash = planHash(materialFields(next));
    if (hash === row.plan_hash) return { id: row.id, status: row.status, planVersion: row.plan_version, changed: false };
    if (row.status !== "PENDING_APPROVAL") {
      await transitionInTx(client, { userId, planId, to: "PENDING_APPROVAL", actor: "user", reason: `Edited: ${reason}` });
    }
    const version = row.plan_version + 1;
    await client.query(
      `UPDATE trade_plans SET plan_version=$2,plan_hash=$3,monitoring_mode=NULL,setup_type=$4,timeframe=$5,market_bias=$6,
              trend_classification=$7,entry_zone_low=$8,entry_zone_high=$9,stop_loss=$10,take_profit=$11,reward_risk=$12,
              max_risk_percent=$13,plan=$14::jsonb,expires_at=$15,state_version=state_version+1,updated_at=now()
        WHERE id=$1`,
      [row.id, version, hash, next.setupType, next.timeframe, next.marketBias, next.trendClassification, next.entryZoneLow,
       next.entryZoneHigh, next.stopLoss, next.takeProfit, next.rewardRisk, next.maxRiskPercent, JSON.stringify(next.plan),
       new Date(next.expiresAt).toISOString()],
    );
    await client.query("UPDATE trade_plan_approvals SET revoked_at=now(),revoke_reason=$2 WHERE plan_id=$1 AND revoked_at IS NULL", [row.id, `Superseded by version ${version}`]);
    for (const [ordinal, condition] of (next.conditions ?? []).entries()) {
      await client.query(
        "INSERT INTO trade_plan_conditions(plan_id,plan_version,condition_key,ordinal,label) VALUES($1,$2,$3,$4,$5)",
        [row.id, version, condition.key, ordinal, condition.label],
      );
    }
    await writeEvent(client, { ...row, plan_version: version }, { type: "REVISED", from: "PENDING_APPROVAL", to: "PENDING_APPROVAL", actor: "user", reason, data: { previousVersion: row.plan_version } });
    return { id: row.id, status: "PENDING_APPROVAL" as const, planVersion: version, changed: true };
  });
}

/** System sweep: expire every plan past its expiry that has not begun executing. */
export async function expireDueTradePlans(now = new Date()) {
  const due = await query<{ id: string; user_id: string }>(
    `SELECT id,user_id FROM trade_plans
      WHERE expires_at<=$1 AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED','MONITORING','CONFIRMED','NOTIFIED')`,
    [now],
  );
  let expired = 0;
  for (const plan of due.rows) {
    try {
      await transitionTradePlan({ userId: plan.user_id, planId: plan.id, to: "EXPIRED", actor: "system", reason: "Reached its expiry time.", now });
      expired += 1;
    } catch (error) {
      // Another worker moved it first — the row lock makes that safe.
      if (!(error instanceof TradePlanError)) throw error;
    }
  }
  return expired;
}

export const TRADE_PLAN_FILTERS: Record<string, readonly TradePlanStatus[] | null> = {
  all: null,
  awaiting: ["PENDING_APPROVAL"],
  monitoring: ["APPROVED", "MONITORING"],
  confirmed: ["CONFIRMED", "NOTIFIED"],
  executed: ["EXECUTION_PENDING", "ORDER_SUBMITTED", "PARTIALLY_FILLED", "FILLED", "EXECUTION_FAILED", "CLOSED"],
  invalidated: ["INVALIDATED"],
  expired: ["EXPIRED"],
  rejected: ["REJECTED", "CANCELLED"],
};

const PLAN_COLUMNS = `p.id,p.analysis_id AS "analysisId",p.instrument,p.direction,p.setup_type AS "setupType",p.status,
  p.plan_version AS "planVersion",p.state_version::text AS "stateVersion",p.monitoring_mode AS "monitoringMode",
  p.paused_at AS "pausedAt",p.timeframe,p.market_bias AS "marketBias",p.trend_classification AS "trendClassification",
  p.entry_zone_low::float AS "entryZoneLow",p.entry_zone_high::float AS "entryZoneHigh",p.stop_loss::float AS "stopLoss",
  p.take_profit::float AS "takeProfit",p.reward_risk::float AS "rewardRisk",p.max_risk_percent::float AS "maxRiskPercent",
  p.plan,p.strategy_version AS "strategyVersion",p.market_data_at AS "marketDataAt",p.expires_at AS "expiresAt",
  p.created_at AS "createdAt",p.updated_at AS "updatedAt",
  m.stage AS "monitorStage",m.last_evaluated_at AS "lastEvaluatedAt",m.last_price::float AS "lastPrice",
  m.not_triggered_reason AS "notTriggeredReason",m.state AS "monitorState",
  (SELECT coalesce(json_agg(json_build_object('key',c.condition_key,'label',c.label,'status',c.status,'detail',c.detail) ORDER BY c.ordinal),'[]'::json)
     FROM trade_plan_conditions c WHERE c.plan_id=p.id AND c.plan_version=p.plan_version) AS conditions`;

export async function listTradePlans(userId: string, filter = "all", instrument?: string) {
  if (!(filter in TRADE_PLAN_FILTERS)) throw new TradePlanError("Unknown filter.", 400);
  const statuses = TRADE_PLAN_FILTERS[filter];
  const rows = await query(
    `SELECT ${PLAN_COLUMNS} FROM trade_plans p LEFT JOIN trade_plan_monitoring_state m ON m.plan_id=p.id
      WHERE p.user_id=$1 AND ($2::text[] IS NULL OR p.status=ANY($2::text[])) AND ($3::text IS NULL OR p.instrument=$3)
      ORDER BY p.created_at DESC LIMIT 200`,
    [userId, statuses, instrument ?? null],
  );
  return rows.rows;
}

export async function getTradePlan(userId: string, planId: string) {
  const found = await query(
    `SELECT ${PLAN_COLUMNS},p.analysis_inputs AS "analysisInputs" FROM trade_plans p
       LEFT JOIN trade_plan_monitoring_state m ON m.plan_id=p.id WHERE p.id=$1 AND p.user_id=$2`,
    [planId, userId],
  );
  const plan = found.rows[0] as { planVersion: number } | undefined;
  if (!plan) throw new TradePlanError("Trade plan not found.", 404);
  const [conditions, approvals, events, attempts] = await Promise.all([
    query(`SELECT condition_key AS key,label,status,detail,evidence,evaluated_at AS "evaluatedAt" FROM trade_plan_conditions
            WHERE plan_id=$1 AND plan_version=$2 ORDER BY ordinal`, [planId, plan.planVersion]),
    query(`SELECT plan_version AS "planVersion",monitoring_mode AS "monitoringMode",approved_at AS "approvedAt",revoked_at AS "revokedAt",
                  revoke_reason AS "revokeReason" FROM trade_plan_approvals WHERE plan_id=$1 ORDER BY approved_at`, [planId]),
    query(`SELECT id::text,plan_version AS "planVersion",event_type AS type,from_status AS "from",to_status AS "to",actor,reason,data,
                  created_at AS "createdAt" FROM trade_plan_events WHERE plan_id=$1 ORDER BY id`, [planId]),
    query(`SELECT id,plan_version AS "planVersion",status,safety_checks AS "safetyChecks",error,created_at AS "createdAt",
                  updated_at AS "updatedAt" FROM trade_plan_execution_attempts WHERE plan_id=$1 ORDER BY created_at`, [planId]),
  ]);
  return { plan, conditions: conditions.rows, approvals: approvals.rows, events: events.rows, executionAttempts: attempts.rows };
}
