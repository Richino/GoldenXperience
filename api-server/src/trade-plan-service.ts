import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query, transaction } from "./database.js";
import { latestResearch } from "./intelligence/research-service.js";
import type { MarketIntelligence } from "./intelligence/research-contract.js";
import { researchContextForPlan } from "./intelligence/plan-research.js";
import { evaluateConfirmation, planTimeframes, type Confirmation, type PlanForConfirmation, type SafetyLimits } from "./trade-plan-confirmation.js";
import { generateTradePlans, type GeneratorResult } from "./trade-plan-generator.js";
import { TradePlanError, createTradePlan, listTradePlans, reviseTradePlan, transitionInTx, validateTradePlanInput, type TradePlanInput } from "./trade-plans.js";

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

/**
 * Calendar events for news checks; null when the calendar could not be read
 * or does not cover the next 30 minutes (callers treat that as unknown, which
 * blocks entries).
 */
export async function loadNewsEvents(now: number) {
  const calendar = await getEconomicCalendar();
  return calendar.status.state === "connected" && calendar.data.connected && calendar.data.source !== "mock"
    && calendar.data.coverageUntil && Date.parse(calendar.data.coverageUntil) >= now + 30 * 60_000
    ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])]
    : null;
}

/**
 * Freeze the validated research each plan was made against into the plan:
 * its alignment with that side, the cited factors for and against, the side's
 * research thesis, and verified releases inside the plan's window. Entry,
 * stop, target and confirmation rules are untouched (they come only from the
 * technical engine), and a plan is made whatever the research says.
 */
export function attachIntelligence(plans: TradePlanInput[], intelligence: MarketIntelligence | null, options: { fresh: boolean; staleReason: string | null; technicalReadAt: string | null; now: number }) {
  for (const plan of plans) {
    plan.plan.intelligence = researchContextForPlan({ instrument: plan.instrument, direction: plan.direction, expiresAt: plan.expiresAt }, intelligence, options);
    if (plan.analysisInputs) plan.analysisInputs.researchId = intelligence?.research.id ?? null;
  }
  return plans;
}

const lastGenerate = new Map<string, number>();
const GENERATE_COOLDOWN_MS = 15_000;

export async function generateAndStoreTradePlans(userId: string, instrument: MajorInstrument, options: { skipCooldown?: boolean } = {}) {
  const key = `${userId}:${instrument}`;
  const last = lastGenerate.get(key) ?? 0;
  // The cooldown guards against repeated presses; the research worker rebuilding plans is not one.
  if (!options.skipCooldown && Date.now() - last < GENERATE_COOLDOWN_MS) throw new TradePlanError("Analysis was just run for this pair. Try again in a few seconds.", 429);
  lastGenerate.set(key, Date.now());

  // Research first: plans are built once, from fresh validated research and fresh candles.
  // Without it nothing is generated (the user starts research; plans follow when it completes).
  const latest = await latestResearch(instrument).catch(() => null);
  const research = latest?.research?.report?.schemaVersion ? latest.research : null;
  if (process.env.RESEARCH_REQUIRED_FOR_PLANS !== "false" && !research?.fresh) {
    throw new TradePlanError(research ? `Research is out of date (${research.staleReason ?? "stale"}). Run Analyze to research again; plans are built when it finishes.` : "Research first: run Analyze to research this pair; plans are built when it finishes.", 409);
  }

  const [market, risk] = await Promise.all([loadGeneratorMarket(instrument), riskSettings(userId)]);
  if (!market.candles.H4?.length || !market.candles.H1?.length) {
    throw new TradePlanError("Live OANDA candles are unavailable; no plans were generated.", 503);
  }
  const result: GeneratorResult = generateTradePlans({ instrument, ...market, maxRiskPercent: risk.maxRiskPercent, limits: risk.limits });
  // The validated research is frozen into each plan as its evidence. It never sets levels or rules.
  attachIntelligence(result.plans, research?.report ?? null, {
    fresh: Boolean(research?.fresh),
    staleReason: research ? research.staleReason : "No research yet for this pair.",
    technicalReadAt: result.context?.candleTimes.H1 ?? null,
    now: market.now,
  });

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
  const plans = stored.length
    ? (await listTradePlans(userId, "awaiting", instrument)).filter((plan) => (plan as { analysisId: string }).analysisId === result.analysisId)
    : [];
  return {
    analysisId: result.analysisId,
    plans,
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

type ConfirmablePlanRow = {
  id: string; plan_version: number; instrument: MajorInstrument; direction: "BUY" | "SELL"; setup_type: "BREAKOUT_RETEST" | "SR_REVERSAL";
  entry_zone_low: string; entry_zone_high: string; stop_loss: string | null; take_profit: string | null;
  created_at: Date; expires_at: Date; plan: Record<string, unknown>;
};

export async function confirmationLimits(userId: string): Promise<SafetyLimits> {
  await query("INSERT INTO trade_plan_risk_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  const row = (await query<{ spread: string; age: number; before: number; after: number }>(
    `SELECT max_spread_stop_fraction::text AS spread,max_data_age_seconds AS age,news_blackout_before_minutes AS before,
            news_blackout_after_minutes AS after FROM trade_plan_risk_settings WHERE user_id=$1`,
    [userId],
  )).rows[0]!;
  return { maxSpreadStopFraction: Number(row.spread), maxDataAgeSeconds: row.age, newsBlackoutBeforeMinutes: row.before, newsBlackoutAfterMinutes: row.after };
}

export function toConfirmable(row: ConfirmablePlanRow): PlanForConfirmation {
  if (row.stop_loss === null || row.take_profit === null) throw new TradePlanError("The plan has no stop or target to confirm against.");
  return {
    instrument: row.instrument,
    direction: row.direction,
    setupType: row.setup_type,
    entryZoneLow: Number(row.entry_zone_low),
    entryZoneHigh: Number(row.entry_zone_high),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    plan: row.plan,
  };
}

/** Live H1/M15 candles, quote and calendar for confirmation; demo data is never used. */
export async function loadConfirmationMarket(instrument: MajorInstrument) {
  const market = await loadGeneratorMarket(instrument);
  return { candles: { H4: market.candles.H4, H1: market.candles.H1, M15: market.candles.M15 }, quote: market.quote, news: market.news, now: market.now };
}

/**
 * Current confirmation progress of one plan, computed live. Read-only: it
 * neither stores progress nor changes the plan's status (the monitor does).
 */
export async function confirmationProgress(userId: string, planId: string) {
  const found = await query<ConfirmablePlanRow>(
    `SELECT id,plan_version,instrument,direction,setup_type,entry_zone_low::text,entry_zone_high::text,stop_loss::text,
            take_profit::text,created_at,expires_at,plan FROM trade_plans WHERE id=$1 AND user_id=$2`,
    [planId, userId],
  );
  const row = found.rows[0];
  if (!row) throw new TradePlanError("Trade plan not found.", 404);
  const [market, limits] = await Promise.all([loadConfirmationMarket(row.instrument), confirmationLimits(userId)]);
  const confirmable = toConfirmable(row);
  if (planTimeframes(confirmable).some((tf) => !market.candles[tf]?.length)) throw new TradePlanError("Live OANDA candles are unavailable.", 503);
  return { planId, planVersion: row.plan_version, confirmation: evaluateConfirmation({ plan: confirmable, ...market, limits }) };
}

/** Persist one evaluation: condition rows for the plan's version and the monitoring snapshot. */
export async function recordConfirmation(planId: string, planVersion: number, confirmation: Confirmation, lastPrice: number | null) {
  await transaction(async (client) => {
    for (const condition of confirmation.conditions) {
      await client.query(
        `UPDATE trade_plan_conditions SET status=$4,detail=$5,evidence=$6::jsonb,evaluated_at=now()
          WHERE plan_id=$1 AND plan_version=$2 AND condition_key=$3`,
        [planId, planVersion, condition.key, condition.status, condition.detail, JSON.stringify({ at: condition.at, ...condition.evidence })],
      );
    }
    await client.query(
      `INSERT INTO trade_plan_monitoring_state(plan_id,stage,state,last_evaluated_at,last_candle_time,last_price,last_price_at,not_triggered_reason,updated_at)
       VALUES($1,$2,$3::jsonb,now(),$4,$5,CASE WHEN $5::numeric IS NULL THEN NULL ELSE now() END,$6,now())
       ON CONFLICT(plan_id) DO UPDATE SET stage=EXCLUDED.stage,state=EXCLUDED.state,last_evaluated_at=now(),
         last_candle_time=EXCLUDED.last_candle_time,last_price=EXCLUDED.last_price,last_price_at=EXCLUDED.last_price_at,
         not_triggered_reason=EXCLUDED.not_triggered_reason,consecutive_errors=0,last_error=NULL,updated_at=now()`,
      [planId, confirmation.stage, JSON.stringify({ outcome: confirmation.outcome, proposal: confirmation.proposal, evaluatedThrough: confirmation.evaluatedThrough, progress: confirmation.progress, safety: confirmation.safety }),
       confirmation.evaluatedThrough.M15, lastPrice, confirmation.notTriggeredReason],
    );
  });
}
