import type { Candle } from "../../frontend/src/types/forex.js";
import type { ObserverEvaluation, ObserverEvaluationRow, ObserverPlan, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { evaluateObserverPlan, OBSERVER_PLAN_VERSION, TERMINAL_PLAN_STATES } from "./market-observer-plan.js";
import { PATTERN_RULES_VERSION } from "./market-pattern-definitions.js";

export const OBSERVER_EVALUATION_VERSION = "observer-evaluation@1" as const;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const validTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const terminal = (plan: ObserverPlan) => TERMINAL_PLAN_STATES.has(plan.status);

/** The same causal lifecycle and quote measurements are used by the service and replay. */
export function evaluateMeasuredPlan(plan: ObserverPlan, read: ObserverRead, candles: Candle[]): ObserverPlan {
  if (!validTime(read.asOf) || Date.parse(read.asOf) < Date.parse(plan.updatedAt) || read.instrument !== plan.instrument) return plan;
  const evaluated = evaluateObserverPlan(plan, read, candles);
  if (!evaluated.triggeredAt || terminal(plan)) return evaluated;
  const next = structuredClone(evaluated), pip = pipSizeFor(plan.instrument);
  if (!next.measurements && !plan.triggeredAt && read.quote && positive(next.observedEntry) && positive(next.stop) && next.direction
    && (next.direction === "long" ? next.observedEntry > next.stop : next.observedEntry < next.stop)) {
    next.measurements = { version: OBSERVER_EVALUATION_VERSION, engineVersion: read.version, planRulesVersion: OBSERVER_PLAN_VERSION, patternRulesVersion: PATTERN_RULES_VERSION, triggerQuote: structuredClone(read.quote),
      initialRiskPips: Math.abs(next.observedEntry - next.stop) / pip, lastQuoteKey: "", lastObservedAt: read.asOf, lastExitPrice: next.observedEntry,
      observedQuotes: 0, maxFavorablePips: 0, maxAdversePips: 0, firstGapAt: null,
      context: { lean: read.lean, pressure: read.pressure.direction, relation: read.pressure.relation,
        patterns: read.patterns.filter(p => !p.historical && p.contextState === "current").map(p => ({ kind: p.kind, timeframe: p.timeframe, state: p.state })).slice(0, 12) } };
  }
  const measurements = next.measurements;
  // Do not fabricate excursions for signals triggered before this collector existed.
  if (!measurements) return evaluated;
  if (read.state !== "live" || !read.quote) {
    if (!measurements.firstGapAt) { measurements.firstGapAt = read.asOf; next.updatedAt = read.asOf; }
    return next;
  }
  if (measurements.firstGapAt || plan.status === "PAUSED") return next;
  const quote = read.quote, key = `${quote.time}:${quote.bid}:${quote.ask}`;
  if (key === measurements.lastQuoteKey) return next;
  const exit = next.direction === "long" ? quote.bid : quote.ask;
  const netPips = (next.direction === "long" ? exit - next.observedEntry! : next.observedEntry! - exit) / pip;
  measurements.lastQuoteKey = key; measurements.lastObservedAt = read.asOf; measurements.lastExitPrice = exit; measurements.observedQuotes++;
  measurements.maxFavorablePips = Math.max(measurements.maxFavorablePips, netPips);
  measurements.maxAdversePips = Math.max(measurements.maxAdversePips, -netPips);
  next.updatedAt = read.asOf;
  return next;
}

export function observerEvaluationRow(plan: ObserverPlan): ObserverEvaluationRow | null {
  if (!validTime(plan.triggeredAt)) return null;
  const m = plan.measurements, pip = pipSizeFor(plan.instrument);
  const row: ObserverEvaluationRow = { id: plan.id, version: plan.version, mode: plan.mode, direction: plan.direction, triggeredAt: plan.triggeredAt,
    result: "legacy", netPips: null, observedR: null, spreadPips: null, favorablePips: null, adversePips: null, durationSeconds: null };
  if (!m || m.version !== OBSERVER_EVALUATION_VERSION) return row;
  const risk = positive(plan.observedEntry) && positive(plan.stop) && plan.direction ? Math.abs(plan.observedEntry - plan.stop) / pip : NaN;
  if (!positive(risk) || !positive(m.initialRiskPips) || Math.abs(risk - m.initialRiskPips) > 1e-6
    || !positive(m.triggerQuote?.bid) || !positive(m.triggerQuote?.ask) || m.triggerQuote.ask < m.triggerQuote.bid
    || !Number.isFinite(m.triggerQuote.spreadPips) || m.triggerQuote.spreadPips < 0
    || !Number.isFinite(m.maxFavorablePips) || m.maxFavorablePips < 0 || !Number.isFinite(m.maxAdversePips) || m.maxAdversePips < 0
    || !Number.isSafeInteger(m.observedQuotes) || m.observedQuotes < 1
    || !m.context || !Array.isArray(m.context.patterns) || !m.context.patterns.every(p => p && typeof p.kind === "string" && typeof p.timeframe === "string" && typeof p.state === "string")
    || !["up", "down", "range", "unknown"].includes(m.context.pressure) || !["up", "down", "range", "unknown", "conflicting"].includes(m.context.lean)
    || !["aligned", "opposed", "neutral", "unknown"].includes(m.context.relation)
    || !validTime(m.triggerQuote.time) || !positive(m.lastExitPrice) || typeof m.engineVersion !== "string" || typeof m.planRulesVersion !== "string" || typeof m.patternRulesVersion !== "string"
    || !validTime(m.lastObservedAt) || m.firstGapAt !== null && !validTime(m.firstGapAt)
    || Math.abs((m.triggerQuote.ask - m.triggerQuote.bid) / pip - m.triggerQuote.spreadPips) > 1e-6
    || Math.abs((plan.direction === "long" ? m.triggerQuote.ask : m.triggerQuote.bid) - plan.observedEntry!) > 1e-10
    || (plan.direction === "long" ? plan.observedEntry! <= plan.stop! : plan.observedEntry! >= plan.stop!)) return { ...row, result: "invalid" };
  row.spreadPips = m.triggerQuote.spreadPips; row.favorablePips = m.maxFavorablePips; row.adversePips = m.maxAdversePips;
  row.result = m.firstGapAt || plan.outcome?.kind === "unknown_after_gap" || plan.outcome?.kind === "monitoring_stopped" || terminal(plan) && !plan.outcome ? "unknown" : "tracking";
  const outcome = plan.outcome;
  if (!m.firstGapAt && outcome && (outcome.kind === "target_observed" || outcome.kind === "stop_observed")) {
    if (!positive(outcome.price) || !validTime(outcome.at) || Date.parse(outcome.at) < Date.parse(plan.triggeredAt) || plan.status !== "CLOSED") return { ...row, result: "invalid" };
    const crosses = outcome.kind === "target_observed" ? positive(plan.target) && (plan.direction === "long" ? outcome.price >= plan.target : outcome.price <= plan.target)
      : plan.direction === "long" ? outcome.price <= plan.stop! : outcome.price >= plan.stop!;
    if (!crosses) return { ...row, result: "invalid" };
    row.result = outcome.kind === "target_observed" ? "target" : "stop";
    row.netPips = (plan.direction === "long" ? outcome.price - plan.observedEntry! : plan.observedEntry! - outcome.price) / pip;
    row.observedR = row.netPips / risk;
    row.durationSeconds = (Date.parse(outcome.at) - Date.parse(plan.triggeredAt)) / 1000;
  }
  return row;
}

/** All unresolved/censored signals remain in the denominator of outcome bounds. */
export function summarizeObserverPlans(plans: ObserverPlan[], instrument: string, asOf: string, truncated = false): ObserverEvaluation {
  const selected = [...new Map(plans.filter(p => p.instrument === instrument).map(p => [p.id, p])).values()];
  const pairs = selected.map(plan => ({ plan, row: observerEvaluationRow(plan) })).filter((x): x is { plan: ObserverPlan; row: ObserverEvaluationRow } => Boolean(x.row));
  const rows = pairs.map(p => p.row), measured = rows.filter(r => r.result !== "legacy" && r.result !== "invalid");
  const resolved = measured.filter(r => r.observedR !== null);
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const target = measured.filter(r => r.result === "target").length, stop = measured.filter(r => r.result === "stop").length;
  const unknown = measured.filter(r => r.result === "unknown").length, tracking = measured.filter(r => r.result === "tracking").length;
  const cohorts = new Map<string, { group: ObserverEvaluation["cohorts"][number]["group"]; label: string; rows: ObserverEvaluationRow[] }>();
  for (const { plan, row } of pairs) {
    if (row.result === "legacy" || row.result === "invalid") continue;
    const m = plan.measurements!;
    const labels: Array<readonly [ObserverEvaluation["cohorts"][number]["group"], string]> = [["mode", plan.mode], ["pressure", m.context.pressure], ["rules", `${m.engineVersion} / ${m.planRulesVersion} / ${m.patternRulesVersion}`],
      ...[...new Set(m.context.patterns.map(p => `${p.timeframe} ${p.kind} · ${p.state}`))].map(label => ["pattern", label] as const)];
    for (const [group, label] of labels) {
      const key = `${group}:${label}`, item = cohorts.get(key) ?? { group, label, rows: [] };
      item.rows.push(row); cohorts.set(key, item);
    }
  }
  const meanR = mean(resolved.map(r => r.observedR!));
  return { version: OBSERVER_EVALUATION_VERSION, instrument, asOf, from: selected.length ? selected.map(p => p.createdAt).sort()[0]! : null, truncated,
    counts: { plans: selected.length, noSignal: selected.length - rows.length, signals: rows.length, measured: measured.length, target, stop, unknown, tracking,
      legacy: rows.filter(r => r.result === "legacy").length, invalid: rows.filter(r => r.result === "invalid").length },
    metrics: { resolved: resolved.length, meanObservedR: meanR, meanNetPips: mean(resolved.map(r => r.netPips!)), targetRateResolved: resolved.length ? target / resolved.length : null,
      targetRateBounds: measured.length ? { low: target / measured.length, high: (target + unknown + tracking) / measured.length } : null,
      meanSpreadPips: mean(measured.map(r => r.spreadPips!)) },
    baseline: { name: "No trade", observedR: 0, differenceR: meanR },
    cohorts: [...cohorts.values()].map(c => ({ group: c.group, label: c.label, signals: c.rows.length, resolved: c.rows.filter(r => r.observedR !== null).length,
      meanObservedR: mean(c.rows.flatMap(r => r.observedR === null ? [] : [r.observedR])) })).sort((a, b) => b.signals - a.signals).slice(0, 30),
    recent: rows.sort((a, b) => Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt)).slice(0, 40),
    limitations: ["Quote crossings are hypothetical observations, not broker fills or account profit. Executable bid/ask includes spread; commission, slippage and financing are not modeled.",
      "Resolved-only averages can be biased. Interrupted, stopped and unfinished signals remain visible; bounds assume each could eventually reach either boundary and are not confidence intervals.",
      "The no-trade baseline is 0R. It does not test whether candle confirmation or AI adds value; that needs a matched strategy baseline and prospective observations.",
      "Manually selected Analyze plans are a selected sample. Pattern cohorts overlap and describe association, not causation or a proven trading edge.",
      "Signals without Phase 7 measurements are excluded from performance metrics. Excursions cover received sampled quotes only, not the unseen market path."] };
}
