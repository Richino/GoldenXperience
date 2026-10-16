import {
  OandaRequestError,
  closePracticeTrade,
  getAccountSummary,
  getPracticeOpenTradeInstruments,
  getPracticeOrderByClientId,
  getPracticeTradeProtection,
  getPricing,
  oandaEnvironment,
  submitPracticeMarketOrder,
} from "../../frontend/src/lib/oanda/client.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query, transaction } from "./database.js";
import { displayPair } from "./notifications.js";
import { quoteToUsdRate } from "./pending-manual-entries.js";
import { executionChecks, reconcileDecision, submitFailureKind, type ExecutionCheck, type ExecutionOrder } from "./trade-plan-execution-checks.js";
import { addTradingHours } from "./trade-plan-generator.js";
import { notifyOnce, type NotifiablePlan } from "./trade-plan-notify.js";
import { loadNewsEvents } from "./trade-plan-service.js";
import type { TradePlanStatus } from "./trade-plan-state.js";
import { TradePlanError, transitionInTx } from "./trade-plans.js";

/**
 * Auto trade executor: places a confirmed Auto plan on the OANDA practice
 * account, then follows it to the close.
 *
 *   EXECUTION_PENDING ─checks fail──────────────▶ EXECUTION_FAILED
 *        │ checks pass (attempt SUBMITTING, plan ORDER_SUBMITTED, committed BEFORE the request)
 *        ▼
 *   market order, FOK, stop + target attached, price bound, client ids
 *        ├─ filled ─▶ verify the stop is resting ─▶ FILLED ─(broker closes)─▶ CLOSED
 *        ├─ rejected ───────────────────────────▶ EXECUTION_FAILED
 *        └─ no answer ─▶ attempt UNKNOWN; the next tick looks the order up by
 *                        its client id — it is NEVER sent again
 *
 * No duplicates: one execution attempt per plan version (unique key), plan
 * transitions compare-and-swap, the monitor's lease keeps one worker per
 * plan, and a lost response is reconciled instead of retried.
 */

const RECONCILE_AFTER_MS = 15_000;
const GIVE_UP_AFTER_MS = 3 * 60_000;

type PlanRow = NotifiablePlan & {
  status: TradePlanStatus;
  direction: "BUY" | "SELL";
  stop_loss: string;
  take_profit: string;
  expires_at: Date;
  max_risk_percent: string;
  plan: Record<string, unknown>;
  updated_at: Date;
};

type AttemptRow = { id: string; status: string; request: Record<string, unknown> | null; response: Record<string, unknown> | null; created_at: Date; updated_at: Date };

type SettingsRow = {
  auto_limits_approved_at: Date | null;
  kill_switch: boolean;
  suspended_at: Date | null;
  max_risk_percent: string;
  max_aggregate_risk_percent: string;
  max_open_positions: number;
  daily_loss_limit_percent: string;
  max_spread_stop_fraction: string;
  max_slippage_stop_fraction: string;
  max_data_age_seconds: number;
  news_blackout_before_minutes: number;
  news_blackout_after_minutes: number;
  unprotected_fill_policy: "CLOSE_POSITION" | "ALERT_ONLY";
  broker_error_suspend_threshold: number;
};

const PLAN_COLUMNS = `id,user_id,plan_version,monitoring_mode,instrument,status,direction,stop_loss::text,take_profit::text,
  expires_at,max_risk_percent::text,plan,updated_at`;

async function loadPlan(planId: string) {
  return (await query<PlanRow>(`SELECT ${PLAN_COLUMNS} FROM trade_plans WHERE id=$1`, [planId])).rows[0] ?? null;
}

async function latestAttempt(planId: string, planVersion: number) {
  return (await query<AttemptRow>(
    "SELECT id,status,request,response,created_at,updated_at FROM trade_plan_execution_attempts WHERE plan_id=$1 AND plan_version=$2",
    [planId, planVersion],
  )).rows[0] ?? null;
}

async function settingsFor(userId: string) {
  await query("INSERT INTO trade_plan_risk_settings(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  return (await query<SettingsRow>(
    `SELECT auto_limits_approved_at,kill_switch,suspended_at,max_risk_percent::text,max_aggregate_risk_percent::text,max_open_positions,
            daily_loss_limit_percent::text,max_spread_stop_fraction::text,max_slippage_stop_fraction::text,max_data_age_seconds,
            news_blackout_before_minutes,news_blackout_after_minutes,unprotected_fill_policy,broker_error_suspend_threshold
       FROM trade_plan_risk_settings WHERE user_id=$1`,
    [userId],
  )).rows[0]!;
}

/** Start of the current forex trading day: the latest 17:00 New York. */
export function tradingDayStart(now: number) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const sinceOpen = ((hour - 17 + 24) % 24) * 60 + minute;
  return Math.floor((now - sinceOpen * 60_000) / 60_000) * 60_000;
}

/** Move a plan with the executor's authority; returns false if it had already moved. */
async function move(plan: PlanRow, to: TradePlanStatus, reason: string, data?: unknown) {
  try {
    await transaction((client) => transitionInTx(client, { userId: plan.user_id, planId: plan.id, to, actor: "executor", reason, data }));
    return true;
  } catch (error) {
    if (error instanceof TradePlanError) return false;
    throw error;
  }
}

async function setAttempt(attemptId: string, status: string, patch: { response?: Record<string, unknown>; error?: string | null; checks?: ExecutionCheck[] } = {}) {
  await query(
    `UPDATE trade_plan_execution_attempts
        SET status=$2,
            response=CASE WHEN $3::jsonb IS NULL THEN response ELSE coalesce(response,'{}'::jsonb) || $3::jsonb END,
            error=coalesce($4,error),
            safety_checks=CASE WHEN $5::jsonb IS NULL THEN safety_checks ELSE $5::jsonb END,
            updated_at=now()
      WHERE id=$1`,
    [attemptId, status, patch.response ? JSON.stringify(patch.response) : null, patch.error ?? null, patch.checks ? JSON.stringify(patch.checks) : null],
  );
}

const sideWord = (plan: PlanRow) => plan.direction;
const pair = (plan: PlanRow) => displayPair(plan.instrument);

async function brokerError(plan: PlanRow, message: string) {
  const updated = await query<{ consecutive_broker_errors: number; broker_error_suspend_threshold: number; suspended_at: Date | null }>(
    `UPDATE trade_plan_risk_settings SET consecutive_broker_errors=consecutive_broker_errors+1,
            suspended_at=CASE WHEN consecutive_broker_errors+1>=broker_error_suspend_threshold THEN coalesce(suspended_at,now()) ELSE suspended_at END,
            suspended_reason=CASE WHEN consecutive_broker_errors+1>=broker_error_suspend_threshold THEN $2 ELSE suspended_reason END,
            updated_at=now()
      WHERE user_id=$1 RETURNING consecutive_broker_errors,broker_error_suspend_threshold,suspended_at`,
    [plan.user_id, message.slice(0, 300)],
  );
  const row = updated.rows[0];
  if (row && row.consecutive_broker_errors >= row.broker_error_suspend_threshold) {
    await notifyOnce(plan, {
      event: "AUTO_SUSPENDED", notificationKind: "system_issue",
      title: "Auto trade paused after broker errors",
      message: `${row.consecutive_broker_errors} OANDA errors in a row (latest: ${message}). New Auto trades are paused; turn Auto trade on again in Settings to resume.`,
    });
  }
}

const brokerOk = (userId: string) => query("UPDATE trade_plan_risk_settings SET consecutive_broker_errors=0 WHERE user_id=$1", [userId]);

/**
 * Place a plan that the monitor just moved to EXECUTION_PENDING. Safe to call
 * twice: the second call finds the attempt and leaves it to reconciliation.
 */
export async function executeAutoPlan(planId: string, now = Date.now()) {
  const plan = await loadPlan(planId);
  if (!plan || plan.status !== "EXECUTION_PENDING" || plan.monitoring_mode !== "AUTO") return { kind: "skipped" as const };

  // One attempt per plan version: a repeat call finds this row and stops here.
  const created = await query<{ id: string }>(
    `INSERT INTO trade_plan_execution_attempts(plan_id,user_id,plan_version,idempotency_key,status)
     VALUES($1,$2,$3,$4,'PENDING') ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
    [plan.id, plan.user_id, plan.plan_version, `${plan.id}:v${plan.plan_version}`],
  );
  const attemptId = created.rows[0]?.id;
  if (!attemptId) return { kind: "exists" as const };

  const instrument = plan.instrument as MajorInstrument;
  const [settings, pricing, news, account, rate, openInstruments, openAuto, realized, monitor] = await Promise.all([
    settingsFor(plan.user_id),
    getPricing([instrument]).catch(() => null),
    loadNewsEvents(now).catch(() => null),
    getAccountSummary().catch(() => null),
    quoteToUsdRate(instrument).catch(() => undefined),
    getPracticeOpenTradeInstruments().catch(() => null),
    query<{ count: string; risk: string | null }>(
      `SELECT count(*)::text AS count, sum((a.response->>'riskPercent')::numeric)::text AS risk
         FROM trade_plans p JOIN trade_plan_execution_attempts a ON a.plan_id=p.id AND a.plan_version=p.plan_version
        WHERE p.user_id=$1 AND p.id<>$2 AND p.status IN ('ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED')`,
      [plan.user_id, plan.id],
    ),
    query<{ pl: string | null }>(
      `SELECT sum((response->>'realizedPL')::numeric)::text AS pl FROM trade_plan_execution_attempts
        WHERE user_id=$1 AND (response->>'closedAt')::timestamptz >= $2`,
      [plan.user_id, new Date(tradingDayStart(now)).toISOString()],
    ),
    query<{ proposal: { entry?: number } | null }>("SELECT state->'proposal' AS proposal FROM trade_plan_monitoring_state WHERE plan_id=$1", [plan.id]),
  ]);
  const live = pricing && pricing.status.state === "connected" && pricing.status.source === "oanda"
    ? pricing.data.find((item) => item.instrument === instrument && item.source === "oanda" && item.status.toLowerCase() === "tradeable") ?? null
    : null;
  const accountData = account && account.status.state === "connected" && account.data.source === "oanda" ? account.data : null;

  const verdict = executionChecks({
    plan: {
      instrument,
      direction: plan.direction,
      stopLoss: Number(plan.stop_loss),
      takeProfit: Number(plan.take_profit),
      expiresAt: new Date(plan.expires_at).toISOString(),
      maxRiskPercent: Number(plan.max_risk_percent),
      minRewardRisk: Number((plan.plan.rules as Record<string, unknown> | undefined)?.minRewardRisk ?? 1.5),
      proposalEntry: typeof monitor.rows[0]?.proposal?.entry === "number" ? monitor.rows[0].proposal.entry : null,
    },
    now,
    settings: {
      autoApproved: settings.auto_limits_approved_at !== null,
      killSwitch: settings.kill_switch,
      suspended: settings.suspended_at !== null,
      maxRiskPercent: Number(settings.max_risk_percent),
      maxAggregateRiskPercent: Number(settings.max_aggregate_risk_percent),
      maxOpenPositions: settings.max_open_positions,
      dailyLossLimitPercent: Number(settings.daily_loss_limit_percent),
      maxSpreadStopFraction: Number(settings.max_spread_stop_fraction),
      maxSlippageStopFraction: Number(settings.max_slippage_stop_fraction),
      maxDataAgeSeconds: settings.max_data_age_seconds,
      newsBlackoutBeforeMinutes: settings.news_blackout_before_minutes,
      newsBlackoutAfterMinutes: settings.news_blackout_after_minutes,
    },
    brokerEnvironment: oandaEnvironment(),
    marketOpen: getForexSessionStatus(new Date(now)).marketOpen,
    quote: live ? { bid: live.bid, ask: live.ask, time: live.time } : null,
    news,
    account: accountData ? { nav: accountData.nav, marginAvailable: accountData.marginAvailable } : null,
    quoteToUsdRate: rate,
    openInstruments,
    openAutoTrades: { count: Number(openAuto.rows[0]?.count ?? 0), riskPercent: Number(openAuto.rows[0]?.risk ?? 0) },
    realizedTodayPL: Number(realized.rows[0]?.pl ?? 0),
  });

  if (!verdict.ok || !verdict.order) {
    const failed = verdict.checks.filter((item) => !item.ok).map((item) => item.detail);
    await setAttempt(attemptId, "BLOCKED", { checks: verdict.checks, error: failed.join(" ") });
    await move(plan, "EXECUTION_FAILED", `Not placed: ${failed.join(" ")}`, { checks: verdict.checks });
    await notifyOnce(plan, {
      event: "AUTO_BLOCKED", notificationKind: "trade_update",
      title: `${pair(plan)} ${sideWord(plan)} confirmed — Auto trade not placed`,
      message: `A safety check failed, so no order was sent: ${failed.join(" ")}`,
    });
    return { kind: "blocked" as const, checks: verdict.checks };
  }
  return submit(plan, attemptId, verdict.order, verdict.checks);
}

async function submit(plan: PlanRow, attemptId: string, order: ExecutionOrder, checks: ExecutionCheck[]) {
  const clientId = `gx-${attemptId}`;
  const request = {
    instrument: plan.instrument, direction: plan.direction, units: order.units, stop: order.stop, target: order.target,
    priceBound: order.priceBound, expectedEntry: order.entry, riskPercent: order.riskPercent, riskAmount: order.riskAmount, clientId,
  };
  // Record intent and move to ORDER_SUBMITTED BEFORE talking to the broker, so a
  // crash mid-request leaves something to reconcile, never a blind resend.
  try {
    await transaction(async (client) => {
      await client.query(
        `UPDATE trade_plan_execution_attempts SET status='SUBMITTING',request=$2::jsonb,safety_checks=$3::jsonb,
                response=jsonb_build_object('riskPercent',$4::numeric),updated_at=now() WHERE id=$1`,
        [attemptId, JSON.stringify(request), JSON.stringify(checks), order.riskPercent],
      );
      await client.query(
        `INSERT INTO trade_plan_broker_orders(attempt_id,plan_id,user_id,kind,client_order_id,requested_units,requested_price,state)
         VALUES($1,$2,$3,'ENTRY',$4,$5,$6,'REQUESTED')`,
        [attemptId, plan.id, plan.user_id, clientId, order.units, order.entry],
      );
      await transitionInTx(client, { userId: plan.user_id, planId: plan.id, to: "ORDER_SUBMITTED", actor: "executor", reason: `Sending ${plan.direction} ${order.units} units.`, data: request });
    });
  } catch (error) {
    if (error instanceof TradePlanError) return { kind: "skipped" as const };
    throw error;
  }

  let result: Awaited<ReturnType<typeof submitPracticeMarketOrder>>;
  try {
    result = await submitPracticeMarketOrder({
      instrument: plan.instrument as MajorInstrument,
      direction: plan.direction === "BUY" ? "long" : "short",
      units: order.units,
      stop: order.stop,
      target: order.target,
      clientRequestId: attemptId,
      priceBound: order.priceBound,
      tradeClientId: `gxt-${attemptId}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OANDA request failed.";
    const definite = submitFailureKind(error instanceof OandaRequestError ? error.status : undefined) === "rejected";
    if (definite) {
      // The broker answered and refused: nothing was opened.
      await recordRejected(plan, attemptId, message);
      await brokerError(plan, message);
    } else {
      // No answer or a server error: the order may or may not exist. Do not resend; look it up next tick.
      await setAttempt(attemptId, "UNKNOWN", { error: message });
      await query("UPDATE trade_plan_broker_orders SET state='UNKNOWN',updated_at=now() WHERE client_order_id=$1", [clientId]);
      await brokerError(plan, message);
    }
    return { kind: definite ? "rejected" as const : "unknown" as const };
  }

  if (result.cancelReason || !result.tradeId) {
    await recordRejected(plan, attemptId, result.cancelReason ?? "OANDA did not open a trade.");
    return { kind: "rejected" as const };
  }
  await brokerOk(plan.user_id);
  await recordFilled(plan, attemptId, result.tradeId, result.fillPrice, order.units);
  return { kind: "filled" as const };
}

async function recordRejected(plan: PlanRow, attemptId: string, reason: string) {
  await setAttempt(attemptId, "REJECTED", { error: reason, response: { rejectedReason: reason } });
  await query("UPDATE trade_plan_broker_orders SET state='REJECTED',raw=jsonb_build_object('reason',$2::text),updated_at=now() WHERE client_order_id=$1", [`gx-${attemptId}`, reason]);
  await move(plan, "EXECUTION_FAILED", `OANDA rejected the order: ${reason}`);
  await notifyOnce(plan, {
    event: "AUTO_REJECTED", notificationKind: "trade_update",
    title: `${pair(plan)} ${sideWord(plan)} Auto trade rejected`,
    message: `OANDA did not open the trade (${reason}). Nothing is open.`,
  });
}

/** Record the fill, then make sure the broker holds a stop; apply the fail-safe if it does not. */
async function recordFilled(plan: PlanRow, attemptId: string, tradeId: string, fillPrice: number | null, units: number) {
  const filledAt = new Date().toISOString();
  await setAttempt(attemptId, "ACCEPTED", { response: { tradeId, fillPrice, units, filledAt } });
  await query(
    "UPDATE trade_plan_broker_orders SET state='FILLED',broker_trade_id=$2,fill_price=$3,filled_units=$4,updated_at=now() WHERE client_order_id=$1",
    [`gx-${attemptId}`, tradeId, fillPrice, units],
  );
  const protection = await getPracticeTradeProtection(tradeId).catch(() => null);
  for (const [kind, price] of [["STOP_LOSS", protection?.stopLoss ?? null], ["TAKE_PROFIT", protection?.takeProfit ?? null]] as const) {
    await query(
      `INSERT INTO trade_plan_broker_orders(attempt_id,plan_id,user_id,kind,client_order_id,broker_trade_id,requested_price,state)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(client_order_id) DO NOTHING`,
      [attemptId, plan.id, plan.user_id, kind, `${kind === "STOP_LOSS" ? "gxsl" : "gxtp"}-${attemptId}`, tradeId, price, price === null ? "UNKNOWN" : "PENDING"],
    );
  }
  await move(plan, "FILLED", `Filled ${units} units at ${fillPrice ?? "?"}.`, { tradeId, fillPrice, protection });

  if (!protection || protection.stopLoss === null) {
    const settings = await settingsFor(plan.user_id);
    if (settings.unprotected_fill_policy === "CLOSE_POSITION") {
      let closed = false;
      try {
        await closePracticeTrade(tradeId);
        closed = true;
      } catch (error) {
        console.error(`[trade-plan-executor] could not close unprotected trade ${tradeId}`, error);
      }
      await notifyOnce(plan, {
        event: "AUTO_UNPROTECTED", notificationKind: "system_issue",
        title: `URGENT: ${pair(plan)} trade had no stop-loss`,
        message: closed
          ? `OANDA did not confirm a stop on trade ${tradeId}, so GX closed it straight away.`
          : `OANDA did not confirm a stop on trade ${tradeId} and GX could not close it. Close it in OANDA now.`,
      });
    } else {
      await notifyOnce(plan, {
        event: "AUTO_UNPROTECTED", notificationKind: "system_issue",
        title: `URGENT: ${pair(plan)} trade has no stop-loss`,
        message: `OANDA did not confirm a stop on trade ${tradeId}. Add one in OANDA now.`,
      });
    }
    return;
  }
  await notifyOnce(plan, {
    event: "AUTO_FILLED", notificationKind: "paper_opened",
    title: `${pair(plan)} ${sideWord(plan)} placed (Auto trade)`,
    message: `${units.toLocaleString("en-US")} units at ${fillPrice ?? "market"}. Stop ${protection.stopLoss}, target ${protection.takeProfit ?? "none"} — both held by OANDA.`,
  });
}

/**
 * Follow a plan that is executing or in the trade. Called by the monitor for
 * EXECUTION_PENDING / ORDER_SUBMITTED / FILLED plans it holds the lease on.
 */
export async function reconcileAutoPlan(planId: string, now = Date.now()) {
  const plan = await loadPlan(planId);
  if (!plan) return;
  const attempt = await latestAttempt(plan.id, plan.plan_version);

  if (plan.status === "EXECUTION_PENDING") {
    if (!attempt && now - new Date(plan.updated_at).getTime() < GIVE_UP_AFTER_MS) {
      // Confirmed but not yet attempted (e.g. a restart right after the move): attempt it now.
      await executeAutoPlan(plan.id, now);
      return;
    }
    // An attempt that never got to SUBMITTING was never sent.
    if ((!attempt || attempt.status === "PENDING") && now - new Date(plan.updated_at).getTime() >= GIVE_UP_AFTER_MS) {
      if (attempt) await setAttempt(attempt.id, "FAILED", { error: "Stopped before the order was sent." });
      await move(plan, "EXECUTION_FAILED", "Stopped before the order was sent; nothing was placed.");
    }
    return;
  }

  if (plan.status === "ORDER_SUBMITTED" && attempt && (attempt.status === "SUBMITTING" || attempt.status === "UNKNOWN")) {
    const clientId = `gx-${attempt.id}`;
    if (now - new Date(attempt.updated_at).getTime() < RECONCILE_AFTER_MS) return;
    let order: Awaited<ReturnType<typeof getPracticeOrderByClientId>>;
    try {
      order = await getPracticeOrderByClientId(clientId);
    } catch {
      return; // Broker unreachable: try again next tick.
    }
    const decision = reconcileDecision({
      sinceUpdateMs: now - new Date(attempt.updated_at).getTime(),
      ageMs: now - new Date(attempt.created_at).getTime(),
      order,
      reconcileAfterMs: RECONCILE_AFTER_MS,
      giveUpAfterMs: GIVE_UP_AFTER_MS,
    });
    if (decision === "filled" && order?.tradeId) {
      await setAttempt(attempt.id, "RECONCILED");
      await brokerOk(plan.user_id);
      await recordFilled(plan, attempt.id, order.tradeId, order.fillPrice, Number(attempt.request?.units ?? 0));
      return;
    }
    if (decision === "rejected") {
      await recordRejected(plan, attempt.id, "OANDA cancelled the order (no fill).");
      return;
    }
    if (decision === "lost") {
      await setAttempt(attempt.id, "FAILED", { error: "OANDA has no record of the order." });
      await query("UPDATE trade_plan_broker_orders SET state='CANCELLED',updated_at=now() WHERE client_order_id=$1", [clientId]);
      await move(plan, "EXECUTION_FAILED", "OANDA never received the order; nothing was placed and it was not resent.");
      await notifyOnce(plan, {
        event: "AUTO_LOST", notificationKind: "system_issue",
        title: `${pair(plan)} Auto trade not placed`,
        message: "The order request got no answer and OANDA has no record of it, so nothing is open. It was not resent.",
      });
    }
    return;
  }

  if (plan.status === "FILLED" && attempt) {
    const tradeId = typeof attempt.response?.tradeId === "string" ? attempt.response.tradeId : null;
    if (!tradeId) return;
    let trade: Awaited<ReturnType<typeof getPracticeTradeProtection>>;
    try {
      trade = await getPracticeTradeProtection(tradeId);
    } catch {
      return;
    }
    if (!trade) return;
    if (trade.state === "CLOSED") {
      const closedAt = trade.closeTime ?? new Date(now).toISOString();
      await setAttempt(attempt.id, attempt.status, { response: { closedAt, realizedPL: trade.realizedPL, closePrice: trade.averageClosePrice } });
      await query("UPDATE trade_plan_broker_orders SET state=CASE WHEN kind='ENTRY' THEN state ELSE 'CANCELLED' END,updated_at=now() WHERE attempt_id=$1", [attempt.id]);
      await move(plan, "CLOSED", `Closed at ${trade.averageClosePrice ?? "?"}, P/L ${trade.realizedPL ?? "?"}.`, { realizedPL: trade.realizedPL });
      const pl = trade.realizedPL ?? 0;
      await notifyOnce(plan, {
        event: "AUTO_CLOSED", notificationKind: "paper_closed",
        title: `${pair(plan)} Auto trade closed ${pl > 0 ? "in profit" : pl < 0 ? "at a loss" : "flat"}`,
        message: `Closed at ${trade.averageClosePrice ?? "?"}. Realised P/L ${pl.toFixed(2)}.`,
      });
      return;
    }
    // The 5-trading-day hold: close it when it runs out.
    const holdDays = Number(plan.plan.maxHoldTradingDays ?? 5);
    const filledAt = Date.parse(String(attempt.response?.filledAt ?? trade.openTime ?? ""));
    if (Number.isFinite(filledAt) && now >= addTradingHours(filledAt, holdDays * 24)) {
      try {
        await closePracticeTrade(tradeId);
        await notifyOnce(plan, {
          event: "AUTO_HOLD_EXPIRED", notificationKind: "trade_update",
          title: `${pair(plan)} Auto trade closed after ${holdDays} trading days`,
          message: "Neither the stop nor the target was hit within the swing hold, so GX closed it.",
        });
      } catch (error) {
        console.error(`[trade-plan-executor] hold-expiry close failed for ${tradeId}`, error);
      }
      return;
    }
    if (trade.stopLoss === null) {
      await notifyOnce(plan, {
        event: "AUTO_STOP_REMOVED", notificationKind: "system_issue",
        title: `URGENT: ${pair(plan)} trade has no stop-loss`,
        message: `OANDA no longer holds a stop on trade ${tradeId}. Add one in OANDA.`,
      });
    }
  }
}
