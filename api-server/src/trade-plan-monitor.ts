import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { query, transaction } from "./database.js";
import { displayPair, queueNotification, type NotificationKind } from "./notifications.js";
import { evaluateConfirmation, type Confirmation, type ConfirmationEventType } from "./trade-plan-confirmation.js";
import { confirmationLimits, recordConfirmation, toConfirmable } from "./trade-plan-service.js";
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
/** M15 candles fetched per pair: covers the longest plan lifetime (48h) plus the structure lookback. */
const M15_COUNT = 220;
const H1_COUNT = 72;
/** Market-data failures in a row before the user hears about it. */
const ERROR_ALERT_AFTER = 5;

export const WORKER_ID = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

// ── Pure decision ──────────────────────────────────────────────────

export type MonitorAction =
  | { kind: "transition"; to: TradePlanStatus; reason: string }
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
  if (mode === "NOTIFY") {
    actions.push({ kind: "transition", to: "NOTIFIED", reason: "Trade ready for your decision; no order was placed." });
    actions.push({
      kind: "notify", event: "SETUP_CONFIRMED", notificationKind: "setup_ready",
      title: `${label} ready — your call`,
      message: `Confirmed. Entry near ${p.entry}, stop ${p.stopLoss}, target ${p.takeProfit} (reward/risk ${p.rewardRisk}${p.spread !== null ? `, spread ${p.spread.toFixed(5).replace(/0+$/, "")}` : ""}). No order was placed.`,
    });
  } else {
    // Auto execution is not built: hold at CONFIRMED and say so, never fall back to a silent Notify.
    actions.push({
      kind: "notify", event: "AUTO_UNAVAILABLE", notificationKind: "system_issue",
      title: `${label} confirmed — auto execution unavailable`,
      message: "The setup confirmed, but automatic execution is not enabled, so no order was placed. Review it in Plans.",
    });
  }
  return actions;
}

// ── Worker ─────────────────────────────────────────────────────────

type ClaimedPlan = {
  id: string; user_id: string; plan_version: number; state_version: string; status: TradePlanStatus;
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
      WHERE p.status IN ('MONITORING','CONFIRMED') AND p.paused_at IS NULL
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

/** One market snapshot per pair per tick, shared by every plan on that pair. */
async function loadMonitorMarket(instrument: MajorInstrument) {
  const [h1, m15, pricing] = await Promise.all([getCandles(instrument, "H1", H1_COUNT), getCandles(instrument, "M15", M15_COUNT), getPricing([instrument])]);
  const genuine = (result: typeof h1) => result.status.state === "connected" && result.data.source === "oanda" ? result.data.candles : null;
  const live = pricing.status.state === "connected" && pricing.status.source === "oanda"
    ? pricing.data.find((quote) => quote.instrument === instrument && quote.source === "oanda" && quote.status.toLowerCase() === "tradeable") ?? null
    : null;
  return { H1: genuine(h1), M15: genuine(m15), quote: live ? { bid: live.bid, ask: live.ask, time: live.time } : null };
}

async function loadNews(now: number) {
  const calendar = await getEconomicCalendar();
  return calendar.status.state === "connected" && calendar.data.connected && calendar.data.source !== "mock"
    && calendar.data.coverageUntil && Date.parse(calendar.data.coverageUntil) >= now + 30 * 60_000
    ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])]
    : null;
}

/** Newest closed M15 candle is too old while the market is open: the feed has stalled. */
export function candlesStale(m15: Array<{ time: string; complete?: boolean }>, now: number) {
  if (!getForexSessionStatus(new Date(now)).marketOpen) return false;
  const last = m15.filter((candle) => candle.complete !== false).at(-1);
  return !last || now - (Date.parse(last.time) + 900_000) > 3 * 900_000;
}

/** Notify once per plan and event: the trade_plan_notifications row is the gate. */
async function notifyOnce(plan: ClaimedPlan, action: Extract<MonitorAction, { kind: "notify" }>) {
  const gate = await query<{ id: string }>(
    `INSERT INTO trade_plan_notifications(plan_id,event_type,monitoring_mode) VALUES($1,$2,$3)
     ON CONFLICT(plan_id,event_type) DO NOTHING RETURNING id`,
    [plan.id, `${action.event}:v${plan.plan_version}`, plan.monitoring_mode],
  );
  if (!gate.rows[0]) return;
  await query(
    `INSERT INTO trade_plan_events(plan_id,user_id,plan_version,event_type,actor,reason) VALUES($1,$2,$3,$4,'monitor',$5)`,
    [plan.id, plan.user_id, plan.plan_version, action.event, action.message],
  );
  await queueNotification({
    userId: plan.user_id, kind: action.notificationKind, title: action.title, message: action.message,
    instrument: plan.instrument, paperTradeId: null, dedupeKey: `trade-plan:${plan.id}:v${plan.plan_version}:${action.event}`, url: "/plans",
  });
  const notification = await query<{ id: string }>("SELECT id FROM notification_events WHERE user_id=$1 AND dedupe_key=$2", [plan.user_id, `trade-plan:${plan.id}:v${plan.plan_version}:${action.event}`]);
  if (notification.rows[0]) await query("UPDATE trade_plan_notifications SET notification_id=$2 WHERE id=$1", [gate.rows[0].id, notification.rows[0].id]);
}

async function recordError(planId: string, message: string) {
  const updated = await query<{ consecutive_errors: number }>(
    `UPDATE trade_plan_monitoring_state SET consecutive_errors=consecutive_errors+1,last_error=$2,updated_at=now()
      WHERE plan_id=$1 RETURNING consecutive_errors`,
    [planId, message.slice(0, 500)],
  );
  return updated.rows[0]?.consecutive_errors ?? 0;
}

export type TickSummary = { expired: number; claimed: number; evaluated: number; transitions: number; errors: number };

export async function runTradePlanMonitorTick(now = Date.now()): Promise<TickSummary> {
  const summary: TickSummary = { expired: await expireDueTradePlans(new Date(now)), claimed: 0, evaluated: 0, transitions: 0, errors: 0 };
  const ids = await claimDuePlans();
  summary.claimed = ids.length;
  if (!ids.length) return summary;
  const plans = (await query<ClaimedPlan>(
    `SELECT p.id,p.user_id,p.plan_version,p.state_version::text,p.status,p.monitoring_mode,p.instrument,p.direction,p.setup_type,
            p.entry_zone_low::text,p.entry_zone_high::text,p.stop_loss::text,p.take_profit::text,p.created_at,p.expires_at,p.plan,
            m.last_evaluated_at
       FROM trade_plans p JOIN trade_plan_monitoring_state m ON m.plan_id=p.id
      WHERE p.id=ANY($1::uuid[]) AND m.lease_owner=$2`,
    [ids, WORKER_ID],
  )).rows;

  const news = await loadNews(now).catch(() => null);
  const byPair = new Map<MajorInstrument, ClaimedPlan[]>();
  for (const plan of plans) byPair.set(plan.instrument, [...(byPair.get(plan.instrument) ?? []), plan]);
  const limitsByUser = new Map<string, Awaited<ReturnType<typeof confirmationLimits>>>();

  for (const [instrument, pairPlans] of byPair) {
    let market: Awaited<ReturnType<typeof loadMonitorMarket>> | null = null;
    let marketError: string | null = null;
    try {
      market = await loadMonitorMarket(instrument);
      if (!market.H1 || !market.M15) marketError = "Live OANDA candles unavailable.";
      else if (candlesStale(market.M15, now)) marketError = "OANDA candles are stale; waiting for fresh data.";
    } catch (error) {
      marketError = error instanceof Error ? error.message : "Market data request failed.";
    }
    for (const plan of pairPlans) {
      try {
        if (marketError || !market?.H1 || !market.M15) {
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
          candles: { H1: market.H1, M15: market.M15 },
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
