import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query, transaction } from "./database.js";
import { generateTradePlans, type GeneratorResult } from "./trade-plan-generator.js";
import { TradePlanError, createTradePlan, reviseTradePlan, transitionInTx, validateTradePlanInput, type TradePlanInput } from "./trade-plans.js";

/**
 * Analyze → stored plans. Fetches genuine OANDA candles, quote and the
 * calendar on the server (the client sends only the pair), runs the
 * generator, retires older unreviewed plans on the pair and stores the new
 * ones as PENDING_APPROVAL.
 */

type RiskRow = {
  max_risk_percent: string;
  max_spread_stop_fraction: string;
  max_slippage_stop_fraction: string;
  news_blackout_before_minutes: number;
  news_blackout_after_minutes: number;
};

async function riskSettings(userId: string) {
  await query("INSERT INTO trade_plan_risk_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  const row = (await query<RiskRow>(
    `SELECT max_risk_percent::text,max_spread_stop_fraction::text,max_slippage_stop_fraction::text,
            news_blackout_before_minutes,news_blackout_after_minutes FROM trade_plan_risk_settings WHERE user_id=$1`,
    [userId],
  )).rows[0]!;
  return {
    maxRiskPercent: Number(row.max_risk_percent),
    limits: {
      maxSpreadStopFraction: Number(row.max_spread_stop_fraction),
      maxSlippageStopFraction: Number(row.max_slippage_stop_fraction),
      newsBlackoutBeforeMinutes: row.news_blackout_before_minutes,
      newsBlackoutAfterMinutes: row.news_blackout_after_minutes,
    },
  };
}

/** Live inputs for the generator; demo or failed sources are left out, never substituted. */
export async function loadGeneratorMarket(instrument: MajorInstrument) {
  const [d1, h4, h1, m15, pricing, calendar] = await Promise.all([
    getCandles(instrument, "D", 300), getCandles(instrument, "H4", 300), getCandles(instrument, "H1", 300), getCandles(instrument, "M15", 300),
    getPricing([instrument]), getEconomicCalendar(),
  ]);
  const genuine = (result: typeof d1) => result.status.state === "connected" && result.data.source === "oanda" ? result.data.candles : undefined;
  const live = pricing.status.state === "connected" && pricing.status.source === "oanda"
    ? pricing.data.find((quote) => quote.instrument === instrument && quote.source === "oanda" && quote.status.toLowerCase() === "tradeable") ?? null
    : null;
  const now = Date.now();
  const news = calendar.status.state === "connected" && calendar.data.connected && calendar.data.source !== "mock"
    && calendar.data.coverageUntil && Date.parse(calendar.data.coverageUntil) >= now + 30 * 60_000
    ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])]
    : null;
  return {
    candles: { D1: genuine(d1), H4: genuine(h4), H1: genuine(h1), M15: genuine(m15) },
    quote: live ? { bid: live.bid, ask: live.ask, time: live.time } : null,
    news,
    now,
  };
}

const lastGenerate = new Map<string, number>();
const GENERATE_COOLDOWN_MS = 15_000;

export async function generateAndStoreTradePlans(userId: string, instrument: MajorInstrument) {
  const key = `${userId}:${instrument}`;
  const last = lastGenerate.get(key) ?? 0;
  if (Date.now() - last < GENERATE_COOLDOWN_MS) throw new TradePlanError("Analysis was just run for this pair. Try again in a few seconds.", 429);
  lastGenerate.set(key, Date.now());

  const [market, risk] = await Promise.all([loadGeneratorMarket(instrument), riskSettings(userId)]);
  if (!market.candles.H4?.length || !market.candles.H1?.length) {
    throw new TradePlanError("Live OANDA candles are unavailable; no plans were generated.", 503);
  }
  const result: GeneratorResult = generateTradePlans({ instrument, ...market, maxRiskPercent: risk.maxRiskPercent, limits: risk.limits });

  // Retire unreviewed plans from earlier analyses of this pair.
  const stale = await query<{ id: string }>(
    "SELECT id FROM trade_plans WHERE user_id=$1 AND instrument=$2 AND status IN ('DRAFT','PENDING_APPROVAL') AND analysis_id<>$3",
    [userId, instrument, result.analysisId],
  );
  for (const plan of stale.rows) {
    await transaction((client) => transitionInTx(client, {
      userId, planId: plan.id, to: "INVALIDATED", actor: "system", reason: "Superseded by a newer analysis of this pair.",
    })).catch((error) => { if (!(error instanceof TradePlanError)) throw error; });
  }

  const stored: string[] = [];
  for (const plan of result.plans) {
    const invalid = validateTradePlanInput(plan);
    if (invalid) {
      result.rejected.push({ direction: plan.direction, setupType: plan.setupType, reason: invalid });
      continue;
    }
    stored.push((await createTradePlan(userId, plan)).id);
  }
  return {
    analysisId: result.analysisId,
    result: stored.length ? "PLANS" as const : "NO_VALID_SETUP" as const,
    reason: stored.length ? null : result.reason ?? "No plan passed validation.",
    planIds: stored,
    rejected: result.rejected,
    context: result.context,
  };
}

type EditablePlanRow = {
  instrument: string; direction: "BUY" | "SELL"; setup_type: "BREAKOUT_RETEST" | "SR_REVERSAL"; status: string;
  plan_version: number; timeframe: string; market_bias: string; trend_classification: string;
  entry_zone_low: string; entry_zone_high: string; stop_loss: string | null; take_profit: string | null;
  reward_risk: string | null; max_risk_percent: string; expires_at: Date; plan: Record<string, unknown>;
  strategy_version: string; analysis_id: string;
};

/**
 * Edit the eligible settings of a plan: risk per trade (up to the user's
 * cap) and an earlier expiry. Levels and rules are the generator's and are
 * not editable. Any change is material: new version, approval voided.
 */
export async function editTradePlan(userId: string, planId: string, payload: { maxRiskPercent?: unknown; expiresAt?: unknown; reason?: unknown }) {
  const found = await query<EditablePlanRow>(
    `SELECT instrument,direction,setup_type,status,plan_version,timeframe,market_bias,trend_classification,entry_zone_low::text,
            entry_zone_high::text,stop_loss::text,take_profit::text,reward_risk::text,max_risk_percent::text,expires_at,plan,
            strategy_version,analysis_id FROM trade_plans WHERE id=$1 AND user_id=$2`,
    [planId, userId],
  );
  const row = found.rows[0];
  if (!row) throw new TradePlanError("Trade plan not found.", 404);
  const { maxRiskPercent: cap } = await riskSettings(userId);
  let maxRiskPercent = Number(row.max_risk_percent);
  let expiresAt = new Date(row.expires_at);
  if (payload.maxRiskPercent !== undefined) {
    const value = Number(payload.maxRiskPercent);
    if (!Number.isFinite(value) || value <= 0) throw new TradePlanError("Risk per trade must be a positive number.", 400);
    if (value > cap) throw new TradePlanError(`Risk per trade cannot exceed your ${cap}% limit.`, 400);
    maxRiskPercent = value;
  }
  if (payload.expiresAt !== undefined) {
    const value = new Date(String(payload.expiresAt));
    if (!Number.isFinite(value.getTime())) throw new TradePlanError("Choose a valid expiry time.", 400);
    if (value.getTime() > expiresAt.getTime()) throw new TradePlanError("A plan's expiry can only be brought forward.", 400);
    expiresAt = value;
  }
  const conditions = await query<{ key: string; label: string }>(
    "SELECT condition_key AS key,label FROM trade_plan_conditions WHERE plan_id=$1 AND plan_version=$2 ORDER BY ordinal",
    [planId, row.plan_version],
  );
  const next: TradePlanInput = {
    analysisId: row.analysis_id,
    instrument: row.instrument,
    direction: row.direction,
    setupType: row.setup_type,
    timeframe: row.timeframe,
    marketBias: row.market_bias,
    trendClassification: row.trend_classification,
    entryZoneLow: Number(row.entry_zone_low),
    entryZoneHigh: Number(row.entry_zone_high),
    stopLoss: row.stop_loss === null ? null : Number(row.stop_loss),
    takeProfit: row.take_profit === null ? null : Number(row.take_profit),
    rewardRisk: row.reward_risk === null ? null : Number(row.reward_risk),
    maxRiskPercent,
    expiresAt: expiresAt.toISOString(),
    plan: {
      ...row.plan,
      positionSizingRule: `Risk ${maxRiskPercent}% of equity on the distance from the executable entry to the protective stop; recalculated at confirmation from fresh prices.`,
    },
    strategyVersion: row.strategy_version,
    conditions: conditions.rows,
  };
  const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim().slice(0, 300) : "Risk or expiry changed.";
  return reviseTradePlan(userId, planId, next, reason);
}
