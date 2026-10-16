import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import { query, transaction } from "./database.js";
import { displayPair, type NotificationKind } from "./notifications.js";
import { notifyOnce } from "./trade-plan-notify.js";
import { executeAutoPlan, reconcileAutoPlan } from "./trade-plan-executor.js";
import { evaluateConfirmation, planTimeframes, type Confirmation, type ConfirmationEventType, type Tf } from "./trade-plan-confirmation.js";
import { confirmationLimits, loadNewsEvents, recordConfirmation, toConfirmable } from "./trade-plan-service.js";
import type { MonitoringMode, TradePlanStatus } from "./trade-plan-state.js";
import { TradePlanError, expireDueTradePlans, transitionInTx } from "./trade-plans.js";

/**
 * Background monitor for approved trade plans. Runs on the API server
 * (Railway), never in the browser, so it keeps going with the app closed.
 *
 * Each tick:
 *   1. expires plans past their time;
 *   2. claims a short lease on every due plan (an atomic UPDATE … SKIP
 *      LOCKED), so two server instances never judge the same plan at once;
 *   3. fetches market data ONCE per pair and shares it across that pair's plans;
 *   4. runs the stateless confirmation engine, stores the progress, and moves
 *      the plan (CONFIRMED → NOTIFIED, INVALIDATED, EXPIRED) with a
 *      compare-and-swap on the state version it read, so a plan the user
 *      paused, edited or cancelled meanwhile is left alone;
 *   5. releases the lease.
 *
 * Recovery after a restart needs no stored progress: the engine replays the
 * candles since each plan was created, and an abandoned lease simply expires.
 * This never places an order — Auto plans stop at CONFIRMED until the
 * executor exists.
 */

export const MONITOR_INTERVAL_MS = 60_000;
const LEASE_SECONDS = 120;
/**
 * Candles fetched per timeframe: enough to cover a plan's whole trigger window
 * (72 open-market hours for swing plans) plus the structure lookback.
 */
const CANDLE_COUNT: Record<Tf, number> = { H4: 80, H1: 160, M15: 220 };
const TF_MS: Record<Tf, number> = { H4: 4 * 3_600_000, H1: 3_600_000, M15: 900_000 };
/** Market-data failures in a row before the user hears about it. */
const ERROR_ALERT_AFTER = 5;

export const WORKER_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

// ── Pure decision ──────────────────────────────────────────────────

export type MonitorAction =
  | { kind: "transition"; to: TradePlanStatus; reason: string }
  /** One trade per pair: the other plans of the same Analyze run stop once this one confirms. */
  | { kind: "cancelSiblings"; reason: string }
  /** Auto trade: hand the plan (now EXECUTION_PENDING) to the executor. */
  | { kind: "execute" }
  | { kind: "notify"; event: string; title: string; message: string; notificationKind: NotificationKind };

const DETECTION_COPY: Partial<Record<ConfirmationEventType, string>> = {
  BREAKOUT_DETECTED: "Breakout detected",
  RETEST_DETECTED: "Retest detected",
  SWEEP_DETECTED: "Liquidity sweep reclaimed",
  REJECTION_DETECTED: "Rejection at the zone",
};

/**
 * What the monitor should do with one evaluation. Pure, so every branch is
 * testable without a database. `status` is the plan's status when it was read.
 */
export function decideMonitorActions(input: {
  status: TradePlanStatus;
  mode: MonitoringMode | null;
  instrument: string;
  direction: "BUY" | "SELL";
  confirmation: Confirmation;
}): MonitorAction[] {
  const { status, mode, confirmation } = input;
  const label = `${displayPair(input.instrument)} ${input.direction}`;
  const tag = mode === "AUTO" ? "Auto" : "Notify";
  const actions: MonitorAction[] = [];
  // Progress notices: each detection once per plan (deduplicated by the caller).
  for (const event of confirmation.events) {
    const copy = DETECTION_COPY[event.type];
    if (copy) actions.push({ kind: "notify", event: event.type, title: `${label}: ${copy.toLowerCase()}`, message: `${event.detail} [${tag}] Still waiting for the remaining conditions.`, notificationKind: "trade_update" });
  }

  if (confirmation.outcome === "INVALIDATED") {
    if (status === "MONITORING" || status === "CONFIRMED") {
      actions.push({ kind: "transition", to: "INVALIDATED", reason: confirmation.notTriggeredReason ?? "The market invalidated the plan." });
      actions.push({ kind: "notify", event: "INVALIDATED", title: `${label} plan invalidated`, message: `${confirmation.notTriggeredReason ?? "The setup failed."} No trade will be taken.`, notificationKind: "trade_update" });
    }
    return actions;
  }
  if (confirmation.outcome === "EXPIRED") {
    actions.push({ kind: "transition", to: "EXPIRED", reason: confirmation.notTriggeredReason ?? "Reached its expiry time." });
    actions.push({ kind: "notify", event: "EXPIRED", title: `${label} plan expired`, message: "It expired before every condition was met. No trade was taken.", notificationKind: "trade_update" });
    return actions;
  }
  // A Notify plan already CONFIRMED (a restart between the two writes) is handed on even if the
  // live checks have since tightened: it was confirmed, and Notify places nothing.
  if (confirmation.outcome === "WAITING" && status === "CONFIRMED" && mode === "NOTIFY") {
    actions.push({ kind: "cancelSiblings", reason: `The ${input.direction} plan confirmed first; one trade per pair.` });
    actions.push({ kind: "transition", to: "NOTIFIED", reason: "Trade ready for your decision; no order was placed." });
    actions.push({ kind: "notify", event: "SETUP_CONFIRMED", notificationKind: "setup_ready", title: `${label} ready — your call`, message: `Confirmed earlier; current state: ${confirmation.notTriggeredReason ?? "check the plan"}. No order was placed.` });
    return actions;
  }
  if (confirmation.outcome === "WAITING") {
    if (confirmation.stage === "CONFIRMED_BLOCKED" && mode === "NOTIFY") {
      actions.push({ kind: "notify", event: "SAFETY_BLOCKED", title: `${label}: setup formed, blocked for now`, message: `${confirmation.notTriggeredReason ?? ""} GX keeps watching; you will be told if it clears.`, notificationKind: "trade_update" });
    }
    return actions;
  }

  // CONFIRMED: every technical condition and every safety check passes now.
  const p = confirmation.proposal!;
  if (status === "MONITORING") {
    actions.push({ kind: "transition", to: "CONFIRMED", reason: `All conditions met: ${p.side} near ${p.entry}, stop ${p.stopLoss}, target ${p.takeProfit}, reward/risk ${p.rewardRisk}.` });
  }
  actions.push({ kind: "cancelSiblings", reason: `The ${input.direction} plan confirmed first; one trade per pair.` });
  if (mode === "NOTIFY") {
    actions.push({ kind: "transition", to: "NOTIFIED", reason: "Trade ready for your decision; no order was placed." });
    actions.push({
      kind: "notify", event: "SETUP_CONFIRMED", notificationKind: "setup_ready",
      title: `${label} ready — your call`,
      message: `Confirmed. Entry near ${p.entry}, stop ${p.stopLoss}, target ${p.takeProfit} (reward/risk ${p.rewardRisk}${p.spread !== null ? `, spread ${p.spread.toFixed(5).replace(/0+$/, "")}` : ""}). No order was placed.`,
    });
  } else {
    // Auto trade: the executor re-checks everything on fresh data before any order.
    actions.push({ kind: "transition", to: "EXECUTION_PENDING", reason: "Confirmed; placing the Auto trade after the final safety checks." });
    actions.push({ kind: "execute" });
  }
  return actions;
}

// ── Worker ─────────────────────────────────────────────────────────

type ClaimedPlan = {
  id: string; user_id: string; analysis_id: string; plan_version: number; state_version: string; status: TradePlanStatus;
  monitoring_mode: MonitoringMode | null; instrument: MajorInstrument; direction: "BUY" | "SELL";
  setup_type: "BREAKOUT_RETEST" | "SR_REVERSAL"; entry_zone_low: string; entry_zone_high: string;
  stop_loss: string | null; take_profit: string | null; created_at: Date; expires_at: Date; plan: Record<string, unknown>;
  last_evaluated_at: Date | null;
};

/**
 * Atomically lease every due plan to this worker. A plan is due when it is
 * being monitored (or confirmed and not yet handed on), not paused, and its
 * lease is free or expired. SKIP LOCKED lets a second instance pass over
 * rows the first is claiming instead of waiting and double-claiming.
 */
export const CLAIM_SQL = `
  UPDATE trade_plan_monitoring_state m
     SET lease_owner=$1, lease_expires_at=now() + make_interval(secs => $2)
   WHERE m.plan_id IN (
     SELECT s.plan_id FROM trade_plan_monitoring_state s
       JOIN trade_plans p ON p.id=s.plan_id
      WHERE p.status IN ('MONITORING','CONFIRMED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED') AND p.paused_at IS NULL
        AND (s.lease_expires_at IS NULL OR s.lease_expires_at < now() OR s.lease_owner=$1)
      ORDER BY s.last_evaluated_at NULLS FIRST
      LIMIT 200
      FOR UPDATE OF s SKIP LOCKED)
  RETURNING m.plan_id`;

export async function claimDuePlans(workerId = WORKER_ID) {
  const claimed = await query<{ plan_id: string }>(CLAIM_SQL, [workerId, LEASE_SECONDS]);
  return claimed.rows.map((row) => row.plan_id);
}

async function releaseLease(planId: string, workerId = WORKER_ID) {
  await query("UPDATE trade_plan_monitoring_state SET lease_owner=NULL,lease_expires_at=NULL WHERE plan_id=$1 AND lease_owner=$2", [planId, workerId]);
}

/**
 * One market snapshot per pair per tick, shared by every plan on that pair.
 * Only the timeframes those plans are judged on are fetched.
 */
async function loadMonitorMarket(instrument: MajorInstrument, timeframes: Tf[]) {
  const [pricing, ...series] = await Promise.all([getPricing([instrument]), ...timeframes.map((tf) => getCandles(instrument, tf, CANDLE_COUNT[tf]))]);
  const candles: Partial<Record<Tf, Candle[]>> = {};
  timeframes.forEach((tf, index) => {
    const result = series[index]!;
    if (result.status.state === "connected" && result.data.source === "oanda") candles[tf] = result.data.candles;
  });
  const live = pricing.status.state === "connected" && pricing.status.source === "oanda"
    ? pricing.data.find((quote) => quote.instrument === instrument && quote.source === "oanda" && quote.status.toLowerCase() === "tradeable") ?? null
    : null;
  return { candles, quote: live ? { bid: live.bid, ask: live.ask, time: live.time } : null };
}

/** The newest closed candle is more than three candles old while the market is open: the feed has stalled. */
export function candlesStale(candles: Array<{ time: string; complete?: boolean }>, now: number, step = 900_000) {
  if (!getForexSessionStatus(new Date(now)).marketOpen) return false;
  const last = candles.filter((candle) => candle.complete !== false).at(-1);
  return !last || now - (Date.parse(last.time) + step) > 3 * step;
}

async function recordError(planId: string, message: string) {
  const updated = await query<{ consecutive_errors: number }>(
    `UPDATE trade_plan_monitoring_state SET consecutive_errors=consecutive_errors+1,last_error=$2,updated_at=now()
      WHERE plan_id=$1 RETURNING consecutive_errors`,
    [planId, message.slice(0, 500)],
  );
  return updated.rows[0]?.consecutive_errors ?? 0;
}

/**
 * Cancel the other live plans from the same Analyze run. Runs only after this
 * plan reached CONFIRMED, so if both sides somehow confirmed in one tick the
 * first to be processed wins and the second finds itself cancelled.
 */
async function cancelSiblings(plan: ClaimedPlan, reason: string, now: number) {
  const siblings = await query<{ id: string; direction: string }>(
    `SELECT id,direction FROM trade_plans WHERE user_id=$1 AND analysis_id=$2 AND id<>$3
        AND status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED')`,
    [plan.user_id, plan.analysis_id, plan.id],
  );
  let cancelled = 0;
  for (const sibling of siblings.rows) {
    try {
      await transaction((client) => transitionInTx(client, { userId: plan.user_id, planId: sibling.id, to: "CANCELLED", actor: "monitor", reason, now: new Date(now) }));
      await query("UPDATE trade_plan_approvals SET revoked_at=now(),revoke_reason=$2 WHERE plan_id=$1 AND revoked_at IS NULL", [sibling.id, reason]);
      cancelled += 1;
    } catch (error) {
      if (!(error instanceof TradePlanError)) throw error;
    }
  }
  return cancelled;
}

export type TickSummary = { expired: number; claimed: number; evaluated: number; transitions: number; errors: number };

export async function runTradePlanMonitorTick(now = Date.now()): Promise<TickSummary> {
  const summary: TickSummary = { expired: await expireDueTradePlans(new Date(now)), claimed: 0, evaluated: 0, transitions: 0, errors: 0 };
  const ids = await claimDuePlans();
  summary.claimed = ids.length;
  if (!ids.length) return summary;
  const plans = (await query<ClaimedPlan>(
    `SELECT p.id,p.user_id,p.analysis_id,p.plan_version,p.state_version::text,p.status,p.monitoring_mode,p.instrument,p.direction,p.setup_type,
            p.entry_zone_low::text,p.entry_zone_high::text,p.stop_loss::text,p.take_profit::text,p.created_at,p.expires_at,p.plan,
            m.last_evaluated_at
       FROM trade_plans p JOIN trade_plan_monitoring_state m ON m.plan_id=p.id
      WHERE p.id=ANY($1::uuid[]) AND m.lease_owner=$2`,
    [ids, WORKER_ID],
  )).rows;

  // Plans already executing or in a trade are followed at the broker, not re-judged on candles.
  const executing = new Set<TradePlanStatus>(["EXECUTION_PENDING", "ORDER_SUBMITTED", "PARTIALLY_FILLED", "FILLED"]);
  for (const plan of plans.filter((item) => executing.has(item.status))) {
    try {
      await reconcileAutoPlan(plan.id, now);
    } catch (error) {
      summary.errors += 1;
      console.error(`[trade-plan-monitor] reconcile ${plan.id} failed`, error);
    } finally {
      await releaseLease(plan.id).catch(() => undefined);
    }
  }
  const watched = plans.filter((item) => !executing.has(item.status));
  if (!watched.length) return summary;

  const news = await loadNewsEvents(now).catch(() => null);
  const byPair = new Map<MajorInstrument, ClaimedPlan[]>();
  for (const plan of watched) byPair.set(plan.instrument, [...(byPair.get(plan.instrument) ?? []), plan]);
  const limitsByUser = new Map<string, Awaited<ReturnType<typeof confirmationLimits>>>();

  for (const [instrument, pairPlans] of byPair) {
    let market: Awaited<ReturnType<typeof loadMonitorMarket>> | null = null;
    let marketError: string | null = null;
    const timeframes = [...new Set(pairPlans.flatMap((plan) => planTimeframes({ setupType: plan.setup_type, plan: plan.plan })))];
    try {
      market = await loadMonitorMarket(instrument, timeframes);
      const missing = timeframes.filter((tf) => !market!.candles[tf]);
      if (missing.length) marketError = `Live OANDA ${missing.join("/")} candles unavailable.`;
      else if (timeframes.some((tf) => candlesStale(market!.candles[tf]!, now, TF_MS[tf]))) marketError = "OANDA candles are stale; waiting for fresh data.";
    } catch (error) {
      marketError = error instanceof Error ? error.message : "Market data request failed.";
    }
    for (const plan of pairPlans) {
      try {
        if (marketError || !market) {
          // Never judge a plan on missing or stale data: keep it as it is and say why.
          summary.errors += 1;
          const count = await recordError(plan.id, marketError ?? "Market data unavailable.");
          if (count === ERROR_ALERT_AFTER) {
            await notifyOnce(plan, { kind: "notify", event: "DATA_STALE", notificationKind: "system_issue", title: `${displayPair(instrument)} plan monitoring interrupted`, message: `${marketError} The plan is unchanged and will resume when data returns.` });
          }
          continue;
        }
        const limits = limitsByUser.get(plan.user_id) ?? await confirmationLimits(plan.user_id);
        limitsByUser.set(plan.user_id, limits);
        const confirmation = evaluateConfirmation({
          plan: toConfirmable({ ...plan }),
          candles: market.candles,
          quote: market.quote,
          news,
          now,
          limits,
        });
        summary.evaluated += 1;
        const mid = market.quote ? (market.quote.bid + market.quote.ask) / 2 : null;
        await recordConfirmation(plan.id, plan.plan_version, confirmation, mid);

        if (!plan.last_evaluated_at) {
          await notifyOnce(plan, { kind: "notify", event: "MONITORING_STARTED", notificationKind: "trade_update", title: `${displayPair(instrument)} ${plan.direction} plan is being monitored`, message: `${plan.monitoring_mode === "AUTO" ? "[Auto]" : "[Notify]"} ${confirmation.notTriggeredReason ?? "Checking conditions."}` });
        }
        let stateVersion = plan.state_version;
        for (const action of decideMonitorActions({ status: plan.status, mode: plan.monitoring_mode, instrument, direction: plan.direction, confirmation })) {
          if (action.kind === "notify") {
            await notifyOnce(plan, action);
            continue;
          }
          if (action.kind === "execute") {
            await executeAutoPlan(plan.id, now);
            continue;
          }
          if (action.kind === "cancelSiblings") {
            summary.transitions += await cancelSiblings(plan, action.reason, now);
            continue;
          }
          try {
            const moved = await transaction((client) => transitionInTx(client, {
              userId: plan.user_id, planId: plan.id, to: action.to, actor: "monitor", reason: action.reason,
              data: { stage: confirmation.stage, proposal: confirmation.proposal, conditions: confirmation.conditions }, expectedStateVersion: stateVersion, now: new Date(now),
            }));
            stateVersion = moved.stateVersion;
            summary.transitions += 1;
          } catch (error) {
            // The user (or another worker) changed the plan since it was read: leave it, and stop acting on this plan.
            if (error instanceof TradePlanError) break;
            throw error;
          }
        }
      } catch (error) {
        summary.errors += 1;
        await recordError(plan.id, error instanceof Error ? error.message : "Evaluation failed.").catch(() => undefined);
        console.error(`[trade-plan-monitor] plan ${plan.id} failed`, error);
      } finally {
        await releaseLease(plan.id).catch(() => undefined);
      }
    }
  }
  return summary;
}

/** Start the serialised loop. Returns a stop function. */
export function startTradePlanMonitor(intervalMs = MONITOR_INTERVAL_MS) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void runTradePlanMonitorTick()
      .then((summary) => {
        if (summary.claimed || summary.expired || summary.errors) console.log(`[trade-plan-monitor] ${JSON.stringify(summary)}`);
      })
      .catch((error) => console.error("[trade-plan-monitor] tick failed", error))
      .finally(() => { busy = false; });
  };
  const timer = setInterval(tick, intervalMs);
  setTimeout(tick, 5_000);
  console.log(`[trade-plan-monitor] started as ${WORKER_ID}, every ${Math.round(intervalMs / 1000)}s`);
  return () => clearInterval(timer);
}
