import type { ObserverSnapshot } from "./market-observer-types";

export type ObserverMascotExpression = "neutral" | "analyzing" | "alert" | "cautious" | "paused" | "confirmed";
export interface ObserverMascotReaction { expression: "alert" | "confirmed"; key: string; until: number }
export const OBSERVER_MASCOT_ASSETS: Record<ObserverMascotExpression, { animation: string; still: string }> = {
  neutral: { animation: "/mascot/gx-neutral-loop.webp", still: "/mascot/gx-neutral.png" },
  analyzing: { animation: "/mascot/gx-analyzing-v3.webp", still: "/mascot/gx-analyzing-v3-still.png" },
  alert: { animation: "/mascot/gx-alert-loop.webp", still: "/mascot/gx-alert.png" },
  cautious: { animation: "/mascot/gx-cautious-loop.webp", still: "/mascot/gx-cautious.png" },
  paused: { animation: "/mascot/gx-paused-loop.webp", still: "/mascot/gx-paused.png" },
  confirmed: { animation: "/mascot/gx-confirmed-loop.webp", still: "/mascot/gx-confirmed.png" },
};
const currentPatterns = (snapshot: ObserverSnapshot | null | undefined) => snapshot?.read?.patterns.filter(
  pattern => !pattern.historical && pattern.contextState === "current" && ["forming", "confirmed"].includes(pattern.state),
) ?? [];

/** A reaction is an observed transition, never a repeated poll or an old saved result. */
export function observerMascotReaction(previous: ObserverSnapshot | null | undefined, next: ObserverSnapshot, now: number): ObserverMascotReaction | null {
  if (!next.enabled || next.read?.state !== "live") return null;
  const readTime = Date.parse(next.read.asOf);
  if (!Number.isFinite(readTime) || now - readTime > 5000) return null;
  const plan = next.plan;
  const triggerTime = Date.parse(plan?.triggeredAt ?? "");
  if (plan?.status === "TRIGGERED" && !plan.outcome && Number.isFinite(triggerTime)
    && now >= triggerTime && now - triggerTime < 6000
    && (previous?.plan?.id !== plan.id || previous.plan.triggeredAt !== plan.triggeredAt)) {
    return { expression: "confirmed", key: `trigger:${plan.id}:${plan.triggeredAt}`, until: now + 6000 };
  }
  const previousPatterns = new Set(currentPatterns(previous).map(pattern => `${pattern.id}:${pattern.state}`));
  const changed = currentPatterns(next).filter(pattern => !previousPatterns.has(`${pattern.id}:${pattern.state}`));
  // Initial chart context is a baseline; loading saved patterns is not a new event.
  if (previous?.read?.state === "live" && changed.length) {
    return { expression: "alert", key: `patterns:${changed.map(pattern => `${pattern.id}:${pattern.state}`).sort().join(",")}`, until: now + 6000 };
  }
  if (previous?.plan?.id === plan?.id && plan?.status === "READY" && previous?.plan?.status !== "READY") {
    return { expression: "alert", key: `ready:${plan.id}:${plan.updatedAt}`, until: now + 6000 };
  }
  return null;
}

export function observerMascotExpression({ busy, monitored, snapshot, error, reaction, now }: {
  busy: boolean; monitored: boolean; snapshot: ObserverSnapshot | null;
  error: string | null; reaction?: ObserverMascotReaction | null; now: number;
}): ObserverMascotExpression {
  if (busy) return "analyzing";
  const read = snapshot?.read;
  const readTime = Date.parse(read?.asOf ?? "");
  if (!monitored || error || !snapshot?.enabled || !read || read.state === "paused"
    || !Number.isFinite(readTime) || now - readTime > 5000 || snapshot.plan?.status === "PAUSED") return "paused";
  if (read.state === "warming") return "analyzing";
  if (read.lean === "conflicting" || read.pressure.relation === "opposed" || read.blockers.length
    || snapshot.storage === "unavailable" || snapshot.checks?.some(check => check.state === "blocked")
    || ["INVALIDATED", "EXPIRED"].includes(snapshot.plan?.status ?? "")) return "cautious";
  if (reaction && now < reaction.until) {
    // An intervening close/outcome must immediately replace a trigger reaction.
    if (reaction.expression !== "confirmed" || snapshot.plan?.status === "TRIGGERED" && !snapshot.plan.outcome) return reaction.expression;
  }
  return "neutral";
}
