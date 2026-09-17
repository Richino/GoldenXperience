import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { assessMarketCondition } from "../../frontend/src/lib/strategy/market-condition.js";
import { analyzeSrStructure, type SrSnapshot } from "../../frontend/src/lib/strategy/sr-structure.js";
import { analyzePriceReaction } from "../../frontend/src/lib/strategy/price-reaction.js";
import { profileFor } from "../../frontend/src/lib/strategy/timeframe-profiles.js";
import type { MajorInstrument } from "./market-stream-types.js";
import { query } from "./database.js";
import { queueNotification, displayPair } from "./notifications.js";

/**
 * Stage 8 backend monitor for range-reversion PLANS.
 *
 * A plan is frozen when the user clicks "Monitor Setup". This evaluates it on
 * completed candles of the plan's OWN timeframe and moves it PLANNED → READY
 * (entry trigger confirmed) or → INVALIDATED (accepted breakout / range gone).
 * It never places or modifies an order (item 27). The frozen S/R is never
 * overwritten; migration is measured against it.
 */

export type PlanStatus = "PLANNED" | "READY" | "INVALIDATED" | "EXPIRED";

export interface PlannedSetupPlan {
  direction: "long" | "short";
  setupFamily: string;
  marketConditionAtEntry: string;
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  preferredEntry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  trigger: string;
  invalidation: string;
  frozen: SrSnapshot;
  createdAt: string;
}

type PlanRow = {
  id: string;
  instrument: MajorInstrument;
  timeframe: string;
  direction: "long" | "short";
  status: PlanStatus;
  plan: PlannedSetupPlan;
  alerts: Array<{ dedupeKey: string; type: string; at: string; reason: string }>;
};

function isValidPlan(value: unknown): value is PlannedSetupPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  if (plan.direction !== "long" && plan.direction !== "short") return false;
  if (!plan.frozen || typeof plan.frozen !== "object") return false;
  return true;
}

/** Create (or replace) the live plan for this pair. */
export async function createPlannedSetup(
  userId: string,
  instrument: MajorInstrument,
  timeframe: string,
  plan: unknown,
): Promise<{ id: string; status: PlanStatus }> {
  if (!isValidPlan(plan)) throw new Error("Invalid plan payload.");
  // Retire any existing live plan on this pair first (one live per pair).
  await query(
    "UPDATE planned_setups SET status='EXPIRED', updated_at=now() WHERE user_id=$1 AND instrument=$2 AND status IN ('PLANNED','READY')",
    [userId, instrument],
  );
  const inserted = await query<{ id: string; status: PlanStatus }>(
    `INSERT INTO planned_setups(user_id, instrument, timeframe, direction, status, plan)
     VALUES($1,$2,$3,$4,'PLANNED',$5::jsonb) RETURNING id, status`,
    [userId, instrument, timeframe, plan.direction, JSON.stringify(plan)],
  );
  return inserted.rows[0]!;
}

async function loadLivePlan(userId: string, instrument: MajorInstrument): Promise<PlanRow | null> {
  const row = await query<PlanRow>(
    `SELECT id, instrument, timeframe, direction, status, plan, alerts
       FROM planned_setups
      WHERE user_id=$1 AND instrument=$2 AND status IN ('PLANNED','READY')
      ORDER BY created_at DESC LIMIT 1`,
    [userId, instrument],
  );
  return row.rows[0] ?? null;
}

export type PlanEvaluation =
  | { monitored: false; reason: string }
  | { monitored: true; id: string; status: PlanStatus; plan: PlannedSetupPlan; changed: boolean; reason: string };

/**
 * Evaluate the live plan on its own timeframe. Poll-driven: the frontend polls
 * this, and it can also be called from the server's periodic loop to keep
 * monitoring alive when no UI is open.
 */
export async function evaluatePlannedSetup(userId: string, instrument: MajorInstrument): Promise<PlanEvaluation> {
  const row = await loadLivePlan(userId, instrument);
  if (!row) return { monitored: false, reason: "No monitored setup on this pair." };
  const plan = row.plan;
  const profile = profileFor(row.timeframe);

  const [candles, pricing] = await Promise.all([
    getCandles(instrument, profile.timeframe, profile.historyCount),
    getPricing([instrument]),
  ]);
  const quote = pricing.data[0];
  if (candles.status.state !== "connected" || !quote) {
    return { monitored: true, id: row.id, status: row.status, plan, changed: false, reason: "Awaiting fresh OANDA data." };
  }

  const assessment = assessMarketCondition({
    candles: candles.data.candles,
    instrument,
    timeframe: profile.timeframe,
    windows: profile.windows,
    thresholds: profile.marketCondition,
  });
  const sr = analyzeSrStructure({
    candles: candles.data.candles,
    instrument,
    timeframe: profile.timeframe,
    migrationStepBars: profile.migrationStepBars,
    thresholds: profile.sr,
    previousSnapshot: plan.frozen, // migration vs the FROZEN entry structure
  });
  const reaction = sr
    ? analyzePriceReaction({
        candles: candles.data.candles,
        instrument,
        sr,
        thresholds: profile.reaction,
        frozenSupport: plan.frozen.supportRange,
        frozenResistance: plan.frozen.resistanceRange,
      })
    : null;

  const isLong = plan.direction === "long";
  const sideReaction = reaction ? (isLong ? reaction.support : reaction.resistance) : null;

  // Decide the new status (item 23/25). Never reverse into a breakout.
  let status: PlanStatus = row.status;
  let reason = isLong ? "Support reversion — awaiting rejection/reclaim." : "Resistance reversion — awaiting rejection/reclaim.";
  if (sideReaction && sideReaction.acceptanceState === "ACCEPTED") {
    status = "INVALIDATED";
    reason = isLong
      ? "Accepted breakdown below Support — setup cancelled (we do not short the breakdown)."
      : "Accepted breakout above Resistance — setup cancelled (we do not long the breakout).";
  } else if (assessment.condition === "MESSY_CHOP") {
    status = "INVALIDATED";
    reason = "Range structure broke down into messy chop — setup cancelled.";
  } else if (
    reaction &&
    reaction.confirmationState === "ENTER_CONDITION_MET" &&
    (isLong ? reaction.confirmationBias === "long" : reaction.confirmationBias === "short")
  ) {
    status = "READY";
    reason = isLong ? "Support rejection/reclaim confirmed — LONG READY." : "Resistance rejection/reclaim confirmed — SHORT READY.";
  }

  const changed = status !== row.status;
  if (changed) {
    // Deduplicate the alert (item 26).
    const dedupeKey = `${status}:${instrument}:${row.timeframe}`;
    const alerts = Array.isArray(row.alerts) ? row.alerts : [];
    if (!alerts.some((alert) => alert.dedupeKey === dedupeKey)) {
      alerts.push({ dedupeKey, type: status, at: new Date().toISOString(), reason });
      await query(
        "UPDATE planned_setups SET status=$2, alerts=$3::jsonb, updated_at=now() WHERE id=$1",
        [row.id, status, JSON.stringify(alerts.slice(-50))],
      );
      const title = status === "READY"
        ? `${displayPair(instrument)} ${row.timeframe} — ${isLong ? "LONG" : "SHORT"} READY`
        : `${displayPair(instrument)} ${row.timeframe} — setup cancelled`;
      await queueNotification({
        userId,
        kind: "trade_update",
        title,
        message: reason,
        instrument,
        paperTradeId: null,
        dedupeKey: `planned-setup:${row.id}:${status}`,
      }).catch((error) => console.error(`[planned-setup] notification failed for ${row.id}`, error));
    } else {
      await query("UPDATE planned_setups SET status=$2, updated_at=now() WHERE id=$1", [row.id, status]);
    }
  }

  return { monitored: true, id: row.id, status, plan, changed, reason };
}

/**
 * Background sweep over every live plan across all users. Called from the
 * server's periodic loop so monitoring continues with no UI open (item 21).
 */
export async function evaluateActivePlannedSetups(): Promise<number> {
  const rows = await query<{ user_id: string; instrument: MajorInstrument }>(
    "SELECT user_id, instrument FROM planned_setups WHERE status IN ('PLANNED','READY')",
  );
  let evaluated = 0;
  for (const row of rows.rows) {
    try {
      await evaluatePlannedSetup(row.user_id, row.instrument);
      evaluated += 1;
    } catch (error) {
      console.error(`[planned-setup] sweep failed for ${row.instrument}`, error);
    }
  }
  return evaluated;
}
