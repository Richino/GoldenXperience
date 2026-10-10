import { randomUUID } from "node:crypto";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { ObserverPlan, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

export const TERMINAL_PLAN_STATES = new Set(["INVALIDATED", "EXPIRED", "CLOSED"]);
export function createObserverPlan(analysis: MarketAnalysis, candles: Candle[], now: string, version: number): ObserverPlan {
  const v2 = analysis.v2;
  if (!v2 || v2.analyzedAt !== now) throw new Error("A fresh server analysis is required.");
  const execution = v2.execution, direction = execution ? v2.decision === "LONG" ? "long" : "short" : null;
  const timeframe = analysis.mode === "NORMAL" ? "M5" : "H1";
  const closed = candles.filter(c => c.complete && Date.parse(c.time) + (timeframe === "M5" ? 300_000 : 3_600_000) <= Date.parse(now));
  const last = closed.at(-1), pip = pipSizeFor(analysis.pair);
  const zone = v2.setup.zoneLow !== null && v2.setup.zoneHigh !== null ? { low: v2.setup.zoneLow, high: v2.setup.zoneHigh } : v2.watch ? { low: v2.watch.zoneLow, high: v2.watch.zoneHigh } : null;
  if (execution && (!direction || !zone || !last || ![execution.entry, execution.stop, execution.target, zone.low, zone.high].every(x => Number.isFinite(x) && x > 0)
    || zone.high < zone.low || (direction === "long" ? !(execution.stop < execution.entry && execution.entry < execution.target) : !(execution.target < execution.entry && execution.entry < execution.stop)))) throw new Error("The analysis has no usable plan geometry.");
  return { id: randomUUID(), version, instrument: analysis.pair, mode: analysis.mode, createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.parse(now) + (execution?.orderLifetimeHours ?? (analysis.mode === "NORMAL" ? 4 : 48)) * 3_600_000).toISOString(),
    status: "WATCHING", resumeStatus: "WATCHING", direction, reason: execution ? "Watching the frozen entry zone and a new execution candle." : v2.headline,
    thesis: v2.headline, zone, entry: execution?.entry ?? null, stop: execution?.stop ?? null, target: execution?.target ?? null,
    trigger: execution && last ? { timeframe, boundary: direction === "long" ? last.high + pip * 0.1 : last.low - pip * 0.1, after: now } : null,
    invalidation: execution ? `${direction === "long" ? "Bid at or below" : "Ask at or above"} the frozen stop; no entry after expiry.` : v2.invalidation,
    lastEvaluatedCandle: last?.time ?? null, confirmationCandle: null, triggeredAt: null, observedEntry: null, outcome: null,
    facts: [...v2.reasoning, ...v2.warnings].slice(0, 20) };
}

/** Signal lifecycle only. TRIGGERED is an observed condition, never an order/fill. */
export function evaluateObserverPlan(plan: ObserverPlan, read: ObserverRead, candles: Candle[]): ObserverPlan {
  if (TERMINAL_PLAN_STATES.has(plan.status)) return plan;
  const now = read.asOf;
  if (Date.parse(now) < Date.parse(plan.updatedAt)) return plan;
  const next = structuredClone(plan);
  const set = (status: ObserverPlan["status"], reason: string) => {
    next.status = status; next.reason = reason;
    if (JSON.stringify(next) !== JSON.stringify(plan)) next.updatedAt = now;
    return next;
  };
  if (Date.parse(now) >= Date.parse(plan.expiresAt)) return set("EXPIRED", "The frozen plan reached its expiry.");
  const trackedSignal = (plan.status === "PAUSED" ? plan.resumeStatus : plan.status) === "TRIGGERED";
  if (read.state !== "live" || (!trackedSignal && read.blockers.length) || !read.quote) {
    if (plan.status !== "PAUSED") next.resumeStatus = plan.status as ObserverPlan["resumeStatus"];
    return set("PAUSED", read.blockers[0] ?? "Awaiting a covered fresh movement window.");
  }
  const effective = plan.status === "PAUSED" ? plan.resumeStatus : plan.status;
  if (effective === "TRIGGERED" && plan.status === "PAUSED") {
    next.outcome = { kind: "unknown_after_gap", at: now, price: null };
    return set("CLOSED", "Observation was interrupted after the trigger; the path and outcome are unknown.");
  }
  if (!plan.direction || !plan.trigger || !plan.zone || plan.stop === null || plan.target === null || plan.entry === null) return set("WATCHING", "Watch condition only. Run Analyze again when its missing checks become available.");
  const quote = read.quote, isLong = plan.direction === "long", exit = isLong ? quote.bid : quote.ask, entry = isLong ? quote.ask : quote.bid;
  const stopHit = isLong ? exit <= plan.stop : exit >= plan.stop;
  if (effective === "TRIGGERED") {
    const targetHit = isLong ? exit >= plan.target : exit <= plan.target;
    if (stopHit || targetHit) {
      next.outcome = { kind: stopHit ? "stop_observed" : "target_observed", at: now, price: exit };
      return set("CLOSED", `${stopHit ? "Stop" : "Target"} observed on an executable quote; this is a hypothetical signal outcome.`);
    }
    return set("TRIGGERED", "Trigger observed. Tracking the hypothetical signal; no order was placed.");
  }
  if (stopHit) return set("INVALIDATED", "The executable quote crossed the frozen price invalidation before a trigger.");
  const inZone = entry >= plan.zone.low && entry <= plan.zone.high;
  const last = candles.filter(c => c.complete && Date.parse(c.time) + (plan.trigger!.timeframe === "M5" ? 300_000 : 3_600_000) <= Date.parse(now)).at(-1);
  if (last && (!plan.lastEvaluatedCandle || last.time > plan.lastEvaluatedCandle)) {
    next.lastEvaluatedCandle = last.time;
    // Entire confirmation candle must follow plan creation; pre-plan history cannot trigger it.
    const confirms = Date.parse(last.time) >= Date.parse(plan.trigger.after) && (isLong ? last.close > plan.trigger.boundary : last.close < plan.trigger.boundary);
    next.confirmationCandle = confirms ? last.time : null;
  }
  const interval = plan.trigger.timeframe === "M5" ? 300_000 : 3_600_000;
  const validConfirmation = next.confirmationCandle && Date.parse(now) - Date.parse(next.confirmationCandle) <= interval * 2;
  if (validConfirmation && inZone && Math.abs(entry - plan.entry) <= Math.abs(plan.entry - plan.stop) * 0.25 && (isLong ? entry < plan.target : entry > plan.target)) {
    next.triggeredAt = now; next.observedEntry = entry;
    return set("TRIGGERED", "A new closed execution candle crossed the frozen trigger, followed by executable price in the entry zone. No order placed.");
  }
  if (!validConfirmation) next.confirmationCandle = null;
  return set(inZone ? "READY" : "WATCHING", inZone ? "Price is in the zone. Awaiting a new closed candle beyond the frozen trigger." : "Price is outside the frozen entry zone.");
}
