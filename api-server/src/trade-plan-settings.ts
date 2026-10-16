import { isOandaConfigured } from "../../frontend/src/lib/oanda/client.js";
import { query } from "./database.js";
import { TradePlanError } from "./trade-plans.js";

/**
 * Auto trade settings. Turning Auto trade on IS approving the limits shown
 * with it: the approval time is stored, and Analyze accepts "Auto trade"
 * plans only while it is set. Practice accounts only — live trading stays
 * locked off by a database CHECK.
 */

export type AutoTradeLimits = {
  maxRiskPercent: number;
  maxAggregateRiskPercent: number;
  maxOpenPositions: number;
  dailyLossLimitPercent: number;
};

/** Allowed ranges, matching the CHECK constraints in migration 057. */
export const AUTO_TRADE_RANGES: Record<keyof AutoTradeLimits, { min: number; max: number; integer?: boolean }> = {
  maxRiskPercent: { min: 0.1, max: 5 },
  maxAggregateRiskPercent: { min: 0.1, max: 20 },
  maxOpenPositions: { min: 1, max: 20, integer: true },
  dailyLossLimitPercent: { min: 0.1, max: 20 },
};

type Row = {
  max_risk_percent: string;
  max_aggregate_risk_percent: string;
  max_open_positions: number;
  daily_loss_limit_percent: string;
  kill_switch: boolean;
  suspended_at: Date | null;
  suspended_reason: string | null;
  auto_limits_approved_at: Date | null;
};

function brokerStatus() {
  if (!isOandaConfigured()) return { environment: "unconfigured" as const };
  return { environment: process.env.OANDA_ENVIRONMENT === "live" ? "live" as const : "practice" as const };
}

export async function autoTradeSettings(userId: string) {
  await query("INSERT INTO trade_plan_risk_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  const row = (await query<Row>(
    `SELECT max_risk_percent::text,max_aggregate_risk_percent::text,max_open_positions,daily_loss_limit_percent::text,
            kill_switch,suspended_at,suspended_reason,auto_limits_approved_at
       FROM trade_plan_risk_settings WHERE user_id=$1`,
    [userId],
  )).rows[0]!;
  return {
    autoTrade: row.auto_limits_approved_at !== null,
    approvedAt: row.auto_limits_approved_at,
    limits: {
      maxRiskPercent: Number(row.max_risk_percent),
      maxAggregateRiskPercent: Number(row.max_aggregate_risk_percent),
      maxOpenPositions: row.max_open_positions,
      dailyLossLimitPercent: Number(row.daily_loss_limit_percent),
    } satisfies AutoTradeLimits,
    killSwitch: row.kill_switch,
    suspended: row.suspended_at ? { at: row.suspended_at, reason: row.suspended_reason } : null,
    broker: brokerStatus(),
    /** Confirmed Auto plans are placed by trade-plan-executor.ts. */
    executorAvailable: true,
  };
}

/** Validate a limits payload; throws a 400 naming the first bad field. */
export function parseAutoTradeLimits(payload: Record<string, unknown>): AutoTradeLimits {
  const labels: Record<keyof AutoTradeLimits, string> = {
    maxRiskPercent: "Risk per trade",
    maxAggregateRiskPercent: "Total open risk",
    maxOpenPositions: "Open trades",
    dailyLossLimitPercent: "Daily loss limit",
  };
  const out = {} as AutoTradeLimits;
  for (const key of Object.keys(AUTO_TRADE_RANGES) as Array<keyof AutoTradeLimits>) {
    const range = AUTO_TRADE_RANGES[key];
    const value = Number(payload[key]);
    if (!Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) {
      throw new TradePlanError(`${labels[key]} must be ${range.integer ? "a whole number " : ""}between ${range.min} and ${range.max}.`, 400);
    }
    out[key] = value;
  }
  if (out.maxAggregateRiskPercent < out.maxRiskPercent) throw new TradePlanError("Total open risk cannot be below risk per trade.", 400);
  return out;
}

/**
 * Save the limits and turn Auto trade on or off. Saving with Auto trade on
 * re-approves the limits as shown (the approval time moves to now).
 */
export async function saveAutoTradeSettings(userId: string, payload: Record<string, unknown>) {
  if (typeof payload.autoTrade !== "boolean") throw new TradePlanError("Say whether Auto trade is on or off.", 400);
  const limits = parseAutoTradeLimits(payload);
  if (payload.autoTrade) {
    const broker = brokerStatus();
    if (broker.environment === "unconfigured") throw new TradePlanError("Connect an OANDA practice account before turning on Auto trade.");
    if (broker.environment !== "practice") throw new TradePlanError("Auto trade only runs on an OANDA practice account.");
  }
  await query("INSERT INTO trade_plan_risk_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  await query(
    `UPDATE trade_plan_risk_settings
        SET max_risk_percent=$2,max_aggregate_risk_percent=$3,max_open_positions=$4,daily_loss_limit_percent=$5,
            auto_limits_approved_at=CASE WHEN $6 THEN now() ELSE NULL END,
            kill_switch=CASE WHEN $6 THEN false ELSE kill_switch END,
            suspended_at=CASE WHEN $6 THEN NULL ELSE suspended_at END,
            suspended_reason=CASE WHEN $6 THEN NULL ELSE suspended_reason END,
            consecutive_broker_errors=CASE WHEN $6 THEN 0 ELSE consecutive_broker_errors END,
            updated_at=now()
      WHERE user_id=$1`,
    [userId, limits.maxRiskPercent, limits.maxAggregateRiskPercent, limits.maxOpenPositions, limits.dailyLossLimitPercent, payload.autoTrade],
  );
  return autoTradeSettings(userId);
}
