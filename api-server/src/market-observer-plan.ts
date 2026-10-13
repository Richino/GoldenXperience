import { randomUUID } from "node:crypto";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { MarketAnalysis } from "../../frontend/src/lib/strategy/market-analysis.js";
import type { ObserverPlan, ObserverRead, ObserverPlanCheck } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2 } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { evaluateConsolidation, freezeConsolidation, interruptConsolidation } from "./consolidation-comparison.js";

export const TERMINAL_PLAN_STATES = new Set(["INVALIDATED", "EXPIRED", "CLOSED"]);
export const OBSERVER_PLAN_VERSION = "observer-plan@4";
const intervalFor = (plan: ObserverPlan) => plan.trigger?.timeframe === "H1" ? 3_600_000 : 300_000;
const tracked = (plan: ObserverPlan) => (plan.status === "PAUSED" ? plan.resumeStatus : plan.status) === "TRIGGERED";
const confirmationValid = (plan: ObserverPlan, now: string) => Boolean(plan.confirmationCandle
  && Date.parse(plan.confirmationCandle) >= Math.max(Date.parse(plan.trigger?.after ?? plan.createdAt), Date.parse(plan.confirmationAfter ?? plan.createdAt))
  && Date.parse(now) >= Date.parse(plan.confirmationCandle) + intervalFor(plan)
  && Date.parse(now) < Date.parse(plan.confirmationCandle) + intervalFor(plan) * 2);

/** Closing a monitor preserves the frozen hypothesis and distinguishes an unobserved outcome. */
export function stopObserverPlan(plan: ObserverPlan, now: string, reason: string): ObserverPlan {
  if (TERMINAL_PLAN_STATES.has(plan.status)) return plan;
  return { ...structuredClone(plan), status: tracked(plan) ? "CLOSED" : "EXPIRED", updatedAt: now, reason,
    ...(plan.consolidation ? { consolidation: interruptConsolidation(plan.consolidation, now) } : {}),
    outcome: tracked(plan) ? { kind: "monitoring_stopped", at: now, price: null } : plan.outcome };
}

/** Restart cannot reuse a confirmation or infer a triggered signal's intervening path. */
export function resumeObserverPlan(plan: ObserverPlan, now: string): ObserverPlan {
  if (TERMINAL_PLAN_STATES.has(plan.status)) return plan;
  if (tracked(plan)) return { ...structuredClone(plan), status: "CLOSED", updatedAt: now,
    reason: "Server restarted after the signal triggered; intervening price path is unknown.",
    outcome: { kind: "unknown_after_gap", at: now, price: null } };
  return { ...structuredClone(plan), status: "PAUSED", resumeStatus: plan.status === "PAUSED" ? plan.resumeStatus : plan.status as ObserverPlan["resumeStatus"],
    ...(plan.consolidation ? { consolidation: interruptConsolidation(plan.consolidation, now) } : {}),
    ...(plan.pullback ? { pullback: { ...plan.pullback, phase: "unavailable" as const, touchedAt: null, lastEntry: null, lastQuoteKey: null, move: "unknown" as const } } : {}),
    confirmationCandle: null, confirmationAfter: now, priceInterrupted: true, updatedAt: now, reason: "Observer restarted. Awaiting fresh checks and a new full execution candle." };
}
export function createObserverPlan(analysis: MarketAnalysis, candles: Candle[], now: string, version: number): ObserverPlan {
  const v2 = analysis.v2;
  if (!v2 || v2.analyzedAt !== now) throw new Error("A fresh server analysis is required.");
  const execution = v2.execution, direction = execution ? v2.decision === "LONG" ? "long" : "short" : null;
  const timeframe = analysis.mode === "NORMAL" ? "M5" : "H1";
  const closed = candles.filter(c => c.complete && Date.parse(c.time) + (timeframe === "M5" ? 300_000 : 3_600_000) <= Date.parse(now)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const last = closed.at(-1), pip = pipSizeFor(analysis.pair);
  const zone = v2.setup.zoneLow !== null && v2.setup.zoneHigh !== null ? { low: v2.setup.zoneLow, high: v2.setup.zoneHigh } : v2.watch ? { low: v2.watch.zoneLow, high: v2.watch.zoneHigh } : null;
  if (execution && (!direction || !zone || !last || ![execution.entry, execution.stop, execution.target, zone.low, zone.high].every(x => Number.isFinite(x) && x > 0)
    || zone.high < zone.low || (direction === "long" ? !(execution.stop < execution.entry && execution.entry < execution.target) : !(execution.target < execution.entry && execution.entry < execution.stop)))) throw new Error("The analysis has no usable plan geometry.");
  const plan: ObserverPlan = { id: randomUUID(), version, instrument: analysis.pair, mode: analysis.mode, createdAt: now, updatedAt: now,
    expiresAt: new Date(Date.parse(now) + (execution?.orderLifetimeHours ?? (analysis.mode === "NORMAL" ? 4 : 48)) * 3_600_000).toISOString(),
    status: "WATCHING", resumeStatus: "WATCHING", direction, reason: execution ? "Watching the frozen entry zone and a new execution candle." : v2.headline,
    thesis: v2.headline, zone, entry: execution?.entry ?? null, stop: execution?.stop ?? null, target: execution?.target ?? null,
    trigger: execution && last ? { timeframe, boundary: direction === "long" ? last.high + pip * 0.1 : last.low - pip * 0.1, after: now } : null,
    invalidation: execution ? `${direction === "long" ? "Bid at or below" : "Ask at or above"} the frozen stop; no entry after expiry.` : v2.invalidation,
    lastEvaluatedCandle: last?.time ?? null, confirmationCandle: null, triggeredAt: null, observedEntry: null, outcome: null,
    facts: [...v2.reasoning, ...v2.warnings].slice(0, 20) };
  const consolidation = analysis.mode === "NORMAL" ? freezeConsolidation(analysis.pair, candles, now) : null;
  if (consolidation) plan.consolidation = consolidation;
  if (execution && zone) return withPullbackMonitor(plan, zone);
  const conditional = conditionalPullbackPlan(analysis, plan);
  if (conditional) return conditional;
  return consolidation ? { ...plan, consolidation, expiresAt: consolidation.expiresAt,
    thesis: "Consolidation detected. Comparing a short hold with follow-through against a new M5 close outside the frozen box. Paper observations only.",
    reason: "Watching both frozen consolidation boundaries for breakout attempts." } : plan;
}

function withPullbackMonitor(plan: ObserverPlan, zone: { low: number; high: number }): ObserverPlan {
  return { ...plan, pullback: { rules: "pullback-monitor@1", zone: { ...zone }, phase: "approaching", touchedAt: null,
    lastQuoteKey: null, lastQuoteAt: null, receivedQuotes: 0, lastEntry: null, move: "unknown" } };
}

/** Price a hypothesis from existing confirmed structure, independently of live entry readiness. */
export function conditionalPullbackPlan(analysis: MarketAnalysis, base: ObserverPlan): ObserverPlan | null {
  const v2 = analysis.v2, f = v2?.foundation, trend = f?.primary;
  if (!v2 || !f || !trend?.sufficient || !["UPTREND", "DOWNTREND"].includes(trend.direction)
    || ["UNKNOWN", "OPPOSED"].includes(f.alignment) || !Number.isFinite(trend.atr) || trend.atr <= 0
    || f.data.checks.some(c => c.id !== "quote" && (c.status === "FAIL" || c.status === "UNKNOWN"))
    || f.pullback?.state === "INVALIDATED" || f.pullback?.state === "EXPIRED" || trend.structureLevel === null) return null;
  const long = trend.direction === "UPTREND", pip = pipSizeFor(analysis.pair);
  const round = (n: number) => Number(n.toFixed(precisionFor(analysis.pair)));
  const reference = f.referencePrice ?? trend.close;
  const distanceToZone = (zone: { low: number; high: number }) => Math.max(zone.low - reference, reference - zone.high, 0);
  const candidates = [f.pullback?.zone, f.pullback?.nextZone, ...f.zones].filter(z => z && z.status === "ACTIVE"
    && (long ? z.high >= trend.structureLevel! && z.low <= reference : z.low <= trend.structureLevel! && z.high >= reference))
    .sort((a, b) => distanceToZone(a!) - distanceToZone(b!));
  const zone = candidates[0]; if (!zone) return null;
  const maxDistance = ANALYZE_V2[base.mode].pullback.maxEntryDistanceAtr * trend.atr;
  if (distanceToZone(zone) > maxDistance + pip * 1e-6) {
    const reason = `Pullback area is too far away (${(distanceToZone(zone) / pip).toFixed(1)} pips; ${base.mode === "NORMAL" ? "Normal" : "Swing"} entry limit ${(maxDistance / pip).toFixed(1)} pips). Watch only. Run Analyze again if price approaches the area.`;
    return { ...base, direction: null, entry: null, stop: null, target: null, trigger: null, pullback: undefined,
      zone: { low: round(zone.low), high: round(zone.high) }, watchOnlyReason: reason, reason, thesis: reason,
      invalidation: "No entry signal is armed for this distant area.", facts: [...base.facts, reason] };
  }
  const boundary = round(long ? zone.high + pip : zone.low - pip);
  const stop = round(long ? Math.min(zone.low, trend.structureLevel) - Math.max(pip, trend.atr * 0.15)
    : Math.max(zone.high, trend.structureLevel) + Math.max(pip, trend.atr * 0.15));
  const risk = Math.abs(boundary - stop);
  const targets = [long ? trend.lastSwingHigh?.price : trend.lastSwingLow?.price,
    ...f.zones.filter(z => z.status === "ACTIVE").map(z => long ? z.low : z.high)]
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && (long ? n > boundary : n < boundary))
    .sort((a, b) => Math.abs(a - boundary) - Math.abs(b - boundary));
  // The nearest obstacle must offer room. Never replace it with an invented R-multiple target.
  const target = targets[0];
  if (!target || risk < pip * 2 || Math.abs(target - boundary) / risk < 1.5) return null;
  const entryZone = { low: round(boundary - risk * 0.25), high: round(boundary + risk * 0.25) };
  const direction = long ? "long" : "short";
  return withPullbackMonitor({ ...base, direction, zone: entryZone, entry: boundary, stop, target: round(target),
    trigger: { timeframe: base.mode === "NORMAL" ? "M5" : "H1", boundary, after: base.createdAt },
    thesis: `Conditional ${direction} pullback: ${trend.timeframe} ${trend.direction.toLowerCase()}. Watch the frozen pullback area; touching it is not confirmation.`,
    reason: "Plan saved. Watching each received quote for a pullback-area test; confirmation and entry checks remain required.",
    invalidation: `${long ? "Bid at or below" : "Ask at or above"} ${stop.toFixed(precisionFor(base.instrument))} cancels this idea before entry. No entry after expiry.`,
    facts: [...base.facts, `Provisional geometry: nearest observed target offers ${(Math.abs(target - boundary) / risk).toFixed(2)}R before spread; this is not a validated trade.`] },
    { low: round(zone.low), high: round(zone.high) });
}

/** Runs before entry gates: blocked confirmation must not hide observed zone behavior. */
function monitorPullback(next: ObserverPlan, read: ObserverRead) {
  const monitor = next.pullback; if (!monitor || !next.direction || tracked(next)) return;
  const q = read.state === "paused" ? null : read.quote;
  if (!q || Date.parse(q.time) < Math.max(Date.parse(next.createdAt), Date.parse(next.confirmationAfter ?? next.createdAt))) {
    monitor.phase = "unavailable"; monitor.touchedAt = null; monitor.lastEntry = null; monitor.move = "unknown"; return;
  }
  const key = `${q.time}:${q.bid}:${q.ask}`;
  if (key === monitor.lastQuoteKey || monitor.lastQuoteAt && Date.parse(q.time) < Date.parse(monitor.lastQuoteAt)) return;
  const entry = next.direction === "long" ? q.ask : q.bid;
  monitor.move = monitor.lastEntry === null ? "unknown" : entry > monitor.lastEntry ? "up" : entry < monitor.lastEntry ? "down" : "unchanged";
  monitor.lastQuoteKey = key; monitor.lastQuoteAt = q.time; monitor.receivedQuotes++; monitor.lastEntry = entry;
  const inside = entry >= monitor.zone.low && entry <= monitor.zone.high;
  if (inside && !monitor.touchedAt) { monitor.touchedAt = read.asOf; next.confirmationCandle = null; next.confirmationAfter = read.asOf; }
  monitor.phase = inside ? "testing" : monitor.touchedAt && (next.direction === "long" ? entry > monitor.zone.high : entry < monitor.zone.low) ? "rebounding" : "approaching";
}

/** Signal lifecycle only. TRIGGERED is an observed condition, never an order/fill. */
export function evaluateObserverPlan(plan: ObserverPlan, read: ObserverRead, candles: Candle[]): ObserverPlan {
  if (TERMINAL_PLAN_STATES.has(plan.status)) return plan;
  const now = read.asOf;
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(plan.updatedAt)) return plan;
  const next = structuredClone(plan);
  if (next.consolidation) next.consolidation = evaluateConsolidation(next.consolidation, read, candles);
  const set = (status: ObserverPlan["status"], reason: string) => {
    next.status = status; next.reason = reason;
    if (JSON.stringify(next) !== JSON.stringify(plan)) next.updatedAt = now;
    return next;
  };
  const trackedSignal = tracked(plan);
  monitorPullback(next, read);
  if (!trackedSignal && Date.parse(now) >= Date.parse(plan.expiresAt)) return set("EXPIRED", "The frozen plan reached its entry expiry without a trigger.");
  // Entry restrictions (news, spread, context, storage) cannot hide an observed invalidation.
  if (!trackedSignal && read.state !== "paused" && read.quote && plan.direction && plan.stop !== null
    && (plan.direction === "long" ? read.quote.bid <= plan.stop : read.quote.ask >= plan.stop)) {
    next.confirmationCandle = null;
    return set("INVALIDATED", "The executable quote crossed the frozen price invalidation before a trigger.");
  }
  if (plan.review?.decision === "pending") {
    next.confirmationCandle = null;
    return set("WATCHING", "New plan awaiting your review. Accept to start entry monitoring; no order will be placed.");
  }
  if (read.state !== "live" || (!trackedSignal && read.blockers.length) || !read.quote) {
    if (plan.status !== "PAUSED") { next.resumeStatus = plan.status as ObserverPlan["resumeStatus"]; if (!trackedSignal) next.confirmationCandle = null; }
    // Context/news/spread gates block entry without claiming that observed prices
    // were missing. In particular, delayed closed-candle REST delivery is routine.
    if (!trackedSignal && (read.state !== "live" || !read.quote) && !next.priceInterrupted) {
      next.priceInterrupted = true; next.confirmationCandle = null; next.confirmationAfter = now;
    }
    return set("PAUSED", read.blockers[0] ?? "Awaiting a covered fresh movement window.");
  }
  const effective = plan.status === "PAUSED" ? plan.resumeStatus : plan.status;
  if (effective === "TRIGGERED" && plan.status === "PAUSED") {
    next.outcome = { kind: "unknown_after_gap", at: now, price: null };
    return set("CLOSED", "Observation was interrupted after the trigger; the path and outcome are unknown.");
  }
  if (!plan.direction || !plan.trigger || !plan.zone || plan.stop === null || plan.target === null || plan.entry === null) return set("WATCHING", plan.watchOnlyReason ?? "Watch condition only. Run Analyze again when its missing checks become available.");
  if (plan.status === "PAUSED") { next.confirmationCandle = null; if (plan.priceInterrupted) next.confirmationAfter = now; next.priceInterrupted = false; }
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
  const last = candles.filter(c => c.complete && Number.isFinite(c.close) && Date.parse(c.time) + intervalFor(plan) <= Date.parse(now)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).at(-1);
  if (last && (!plan.lastEvaluatedCandle || Date.parse(last.time) > Date.parse(plan.lastEvaluatedCandle))) {
    next.lastEvaluatedCandle = last.time;
    // Entire confirmation candle must follow plan creation; pre-plan history cannot trigger it.
    const confirms = (!next.pullback || Boolean(next.pullback.touchedAt)) && Date.parse(last.time) >= Math.max(Date.parse(plan.trigger.after), Date.parse(next.confirmationAfter ?? plan.createdAt)) && (isLong ? last.close > plan.trigger.boundary : last.close < plan.trigger.boundary);
    next.confirmationCandle = confirms ? last.time : null;
  }
  const validConfirmation = confirmationValid(next, now);
  if (validConfirmation && inZone && Math.abs(entry - plan.entry) <= Math.abs(plan.entry - plan.stop) * 0.25 && (isLong ? entry < plan.target : entry > plan.target)) {
    next.triggeredAt = now; next.observedEntry = entry;
    if (next.pullback) next.pullback.phase = "confirmed";
    return set("TRIGGERED", "A new closed execution candle crossed the frozen trigger, followed by executable price in the entry zone. No order placed.");
  }
  if (!validConfirmation) next.confirmationCandle = null;
  return set(inZone ? "READY" : "WATCHING", inZone ? validConfirmation ? "Candle confirmed and price is in the zone; executable entry distance or target check is not met." : "Price is in the zone. Awaiting a new closed candle beyond the frozen trigger." : validConfirmation ? "Candle confirmed. Awaiting executable price in the frozen entry zone before confirmation expires." : "Price is outside the frozen entry zone.");
}

/** Current checks are derived from measured input, never from AI prose. */
export function observerPlanChecks(plan: ObserverPlan | null, read: ObserverRead): ObserverPlanCheck[] {
  if (!plan || TERMINAL_PLAN_STATES.has(plan.status) || tracked(plan)) return [];
  const checks: ObserverPlanCheck[] = [{ id: "coverage", label: "Live entry checks", state: read.state === "live" && !read.blockers.length ? "met" : "blocked",
    detail: read.blockers[0] ?? (read.state === "live" ? "Data, spread and news checks are covered." : "Awaiting a fresh covered movement window.") }];
  if (!plan.direction || !plan.zone || !plan.trigger || plan.entry === null || plan.stop === null || plan.target === null) {
    return [...checks, { id: "geometry", label: "Priced setup", state: "blocked", detail: plan.watchOnlyReason ?? "This is a watch condition. Run Analyze again to obtain fresh levels when its missing checks resolve." }];
  }
  if (plan.pullback) checks.push({ id: "pullback", label: "Observed pullback-area test", state: plan.pullback.touchedAt ? "met" : plan.pullback.phase === "unavailable" ? "unknown" : "waiting",
    detail: plan.pullback.touchedAt ? `Observed ${plan.pullback.touchedAt}. Full confirmation candle must start after that test and any price interruption.` : "Each received quote is checked; a pre-plan or unobserved area touch cannot confirm this plan." });
  const quote = read.state === "paused" ? null : read.quote, entry = quote ? plan.direction === "long" ? quote.ask : quote.bid : null;
  const confirmed = confirmationValid(plan, read.asOf);
  checks.push({ id: "zone", label: "Executable price in zone", state: entry === null ? "unknown" : entry >= plan.zone.low && entry <= plan.zone.high ? "met" : "waiting", detail: `Uses the ${plan.direction === "long" ? "ask" : "bid"}, not the chart midpoint.` },
    { id: "confirmation", label: `${plan.trigger.timeframe} candle confirmation`, state: confirmed ? "met" : "waiting", detail: confirmed ? `Confirmed candle: ${plan.confirmationCandle}. Valid until ${new Date(Date.parse(plan.confirmationCandle!) + intervalFor(plan) * 2).toISOString()}.` : "A full new candle after creation or resumed monitoring must close beyond the frozen boundary." },
    { id: "distance", label: "Entry distance and target", state: entry === null ? "unknown" : Math.abs(entry - plan.entry) <= Math.abs(plan.entry - plan.stop) * 0.25 && (plan.direction === "long" ? entry < plan.target : entry > plan.target) ? "met" : "waiting", detail: "Entry must be within 25% of the original stop distance and remain before the target." },
    { id: "invalidation", label: "Price invalidation intact", state: quote === null ? "unknown" : (plan.direction === "long" ? quote.bid > plan.stop : quote.ask < plan.stop) ? "met" : "blocked", detail: plan.invalidation },
    { id: "expiry", label: "Entry lifetime", state: Date.parse(read.asOf) < Date.parse(plan.expiresAt) ? "met" : "blocked", detail: `No new signal after ${plan.expiresAt}.` });
  return checks;
}
