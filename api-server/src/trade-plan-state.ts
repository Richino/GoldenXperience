import { createHash } from "node:crypto";

/**
 * Trade plan state machine — the server's authority for every status change.
 *
 * Each legal edge names who may take it. A user can approve, reject, start,
 * edit or cancel; only the monitor confirms; only the executor touches broker
 * states. migrations/057_trade_plans.sql seeds the same edges into
 * trade_plan_transitions so the database refuses anything else
 * (scripts/test-trade-plan-state.ts keeps the two in step).
 */

export const TRADE_PLAN_STATUSES = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "MONITORING", "CONFIRMED", "NOTIFIED",
  "EXECUTION_PENDING", "ORDER_SUBMITTED", "PARTIALLY_FILLED", "FILLED", "EXECUTION_FAILED",
  "CLOSED", "REJECTED", "CANCELLED", "INVALIDATED", "EXPIRED", "MISSED",
] as const;
export type TradePlanStatus = (typeof TRADE_PLAN_STATUSES)[number];

export type TradePlanActor = "user" | "monitor" | "executor" | "system";
export type MonitoringMode = "NOTIFY" | "AUTO";

const U: TradePlanActor = "user";
const M: TradePlanActor = "monitor";
const X: TradePlanActor = "executor";
const S: TradePlanActor = "system";

/** from → to → actors allowed to take that edge. */
export const TRADE_PLAN_TRANSITIONS: Record<TradePlanStatus, Partial<Record<TradePlanStatus, readonly TradePlanActor[]>>> = {
  DRAFT: { PENDING_APPROVAL: [S], INVALIDATED: [S], EXPIRED: [S, M] },
  PENDING_APPROVAL: { APPROVED: [U], REJECTED: [U], INVALIDATED: [S, M], EXPIRED: [S, M] },
  // The monitor may cancel too: when one plan of an analysis confirms, it cancels the other side (one trade per pair).
  APPROVED: { MONITORING: [U, S], PENDING_APPROVAL: [U], CANCELLED: [U, M], INVALIDATED: [S, M], EXPIRED: [S, M] },
  // MISSED: the entry opportunity passed (price ran away, or the approved entry window closed). Never chased.
  MONITORING: { CONFIRMED: [M], PENDING_APPROVAL: [U], CANCELLED: [U, M], INVALIDATED: [M, S], EXPIRED: [M, S], MISSED: [M] },
  // A confirmed plan never goes back to MONITORING: confirmation is final.
  CONFIRMED: { NOTIFIED: [M], EXECUTION_PENDING: [M], CANCELLED: [U, M], INVALIDATED: [M, S], EXPIRED: [M, S], MISSED: [M] },
  NOTIFIED: { CANCELLED: [U, M], EXPIRED: [M, S], MISSED: [M] },
  // Cancelling once execution has begun goes through the executor, which must
  // first make sure no broker order is resting.
  EXECUTION_PENDING: { ORDER_SUBMITTED: [X], EXECUTION_FAILED: [X], CANCELLED: [X], INVALIDATED: [X], EXPIRED: [X], MISSED: [X] },
  ORDER_SUBMITTED: { PARTIALLY_FILLED: [X], FILLED: [X], EXECUTION_FAILED: [X], CANCELLED: [X] },
  PARTIALLY_FILLED: { FILLED: [X], CLOSED: [X] },
  FILLED: { CLOSED: [X] },
  EXECUTION_FAILED: {},
  CLOSED: {},
  REJECTED: {},
  CANCELLED: {},
  INVALIDATED: {},
  EXPIRED: {},
  MISSED: {},
};

export const TERMINAL_STATUSES: ReadonlySet<TradePlanStatus> = new Set(
  TRADE_PLAN_STATUSES.filter((status) => Object.keys(TRADE_PLAN_TRANSITIONS[status]).length === 0),
);

/** Plans the monitor watches (paused ones are skipped by the monitor). */
export const MONITORED_STATUSES: ReadonlySet<TradePlanStatus> = new Set(["MONITORING"]);

export function isTradePlanStatus(value: unknown): value is TradePlanStatus {
  return typeof value === "string" && (TRADE_PLAN_STATUSES as readonly string[]).includes(value);
}

export type TransitionContext = {
  monitoringMode: MonitoringMode | null;
  paused: boolean;
  expiresAt: Date;
  now: Date;
  /** True when an unrevoked approval matches the plan's current version and hash. */
  hasCurrentApproval: boolean;
};

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `actor` may move a plan from `from` to `to` right now. Pure: the
 * caller loads the context under a row lock and applies the result.
 */
export function checkTransition(
  from: TradePlanStatus,
  to: TradePlanStatus,
  actor: TradePlanActor,
  context: TransitionContext,
): TransitionCheck {
  const actors = TRADE_PLAN_TRANSITIONS[from][to];
  if (!actors) return { ok: false, reason: `A plan cannot move from ${from} to ${to}.` };
  if (!actors.includes(actor)) return { ok: false, reason: `${from} → ${to} is not allowed for ${actor}.` };

  const expired = context.now.getTime() >= context.expiresAt.getTime();
  // An expired plan can only be expired (or closed out by the executor).
  if (expired && !["EXPIRED", "CANCELLED", "EXECUTION_FAILED", "CLOSED", "FILLED", "PARTIALLY_FILLED", "REJECTED"].includes(to)) {
    return { ok: false, reason: "The plan has expired." };
  }
  if (to === "EXPIRED" && !expired) {
    return { ok: false, reason: "The plan has not reached its expiry time." };
  }

  if (to === "APPROVED" || (from === "APPROVED" && to === "MONITORING")) {
    if (!context.hasCurrentApproval) return { ok: false, reason: "No approval matches this plan version." };
    if (!context.monitoringMode) return { ok: false, reason: "Choose Notify or Auto before approving." };
  }
  if (to === "CONFIRMED") {
    if (context.paused) return { ok: false, reason: "Monitoring is paused." };
    if (!context.hasCurrentApproval) return { ok: false, reason: "The approval no longer matches this plan version." };
  }
  if (to === "NOTIFIED" && context.monitoringMode !== "NOTIFY") {
    return { ok: false, reason: "Only Notify plans end in a notification." };
  }
  // Never drift from Notify into Auto: execution needs an Auto approval.
  if (to === "EXECUTION_PENDING") {
    if (context.monitoringMode !== "AUTO") return { ok: false, reason: "This plan was approved for Notify, not Auto execution." };
    if (!context.hasCurrentApproval) return { ok: false, reason: "The approval no longer matches this plan version." };
  }
  return { ok: true };
}

/**
 * Fields that define what was approved. Changing any of them is material:
 * the plan gets a new version and must be approved again.
 */
export type MaterialPlanFields = {
  instrument: string;
  direction: "BUY" | "SELL";
  setupType: string;
  timeframe: string;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number | null;
  takeProfit: number | null;
  maxRiskPercent: number;
  expiresAt: string;
  plan: unknown;
};

/** Key-sorted JSON so the same plan always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function planHash(fields: MaterialPlanFields): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}
