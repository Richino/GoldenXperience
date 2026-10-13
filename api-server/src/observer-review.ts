import type { ObserverPlan } from "../../frontend/src/lib/market-observer-types.js";
import { resumeObserverPlan, stopObserverPlan, TERMINAL_PLAN_STATES } from "./market-observer-plan.js";

export function reviewObserverPlan(plan: ObserverPlan, decision: "accepted" | "rejected", now: string): ObserverPlan {
  if (plan.review?.decision !== "pending" || TERMINAL_PLAN_STATES.has(plan.status) || Date.parse(plan.expiresAt) <= Date.parse(now)) {
    throw new Error("This proposal has ended or was already reviewed. Refresh the plan.");
  }
  const next = decision === "accepted" ? resumeObserverPlan(plan, now) : stopObserverPlan(plan, now, "Plan rejected by you.");
  return { ...next, review: { decision, decidedAt: now }, reason: decision === "accepted"
    ? "Accepted for monitoring. Fresh checks and a new full confirmation candle are required. No order was placed."
    : "Plan rejected by you." };
}

export function proposalCanNotify(plan: ObserverPlan, now: string) {
  return plan.review?.decision === "pending" && !TERMINAL_PLAN_STATES.has(plan.status)
    && Date.parse(plan.expiresAt) > Date.parse(now) && plan.direction !== null
    && plan.entry !== null && plan.stop !== null && plan.target !== null && plan.trigger !== null;
}
