import type { ObserverPlan } from "../../frontend/src/lib/market-observer-types.js";
import { isKnownInstrument } from "../../frontend/src/lib/instruments/catalog.js";
import type { MarketRecord } from "./market-recording.js";
import { MarketPatternEngine } from "./market-patterns.js";
import { MarketStateEngine } from "./market-state.js";
import { resumeObserverPlan, TERMINAL_PLAN_STATES } from "./market-observer-plan.js";
import { evaluateMeasuredPlan, summarizeObserverPlans } from "./market-observer-evaluation.js";

/** Reset derived observations, while preserving the original hypothesis and decision time. */
export function observerReplaySeed(value: unknown): ObserverPlan {
  if (!value || typeof value !== "object") throw new Error("Replay requires a saved frozen plan.");
  const plan = value as ObserverPlan, time = (s: string) => Number.isFinite(Date.parse(s));
  if (!isKnownInstrument(plan.instrument) || !["NORMAL", "SWING"].includes(plan.mode) || typeof plan.id !== "string" || !Number.isSafeInteger(plan.version) || plan.version < 1
    || !time(plan.createdAt) || !time(plan.expiresAt) || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt) || !Array.isArray(plan.facts)) throw new Error("Invalid replay plan metadata.");
  const priced = plan.direction !== null || plan.entry !== null || plan.stop !== null || plan.target !== null || plan.trigger !== null;
  if (plan.zone !== null && (!plan.zone || ![plan.zone.low, plan.zone.high].every(n => typeof n === "number" && Number.isFinite(n) && n > 0) || plan.zone.low > plan.zone.high)) throw new Error("Invalid frozen replay zone.");
  if (priced && (!(plan.direction === "long" || plan.direction === "short") || !plan.zone || !plan.trigger
    || ![plan.entry, plan.stop, plan.target, plan.zone.low, plan.zone.high, plan.trigger.boundary].every(n => typeof n === "number" && Number.isFinite(n) && n > 0)
    || plan.zone.low > plan.zone.high || !["M5", "H1"].includes(plan.trigger.timeframe) || (plan.mode === "NORMAL" ? plan.trigger.timeframe !== "M5" : plan.trigger.timeframe !== "H1")
    || !time(plan.trigger.after) || Date.parse(plan.trigger.after) < Date.parse(plan.createdAt)
    || (plan.direction === "long" ? !(plan.stop! < plan.entry! && plan.entry! < plan.target!) : !(plan.target! < plan.entry! && plan.entry! < plan.stop!)))) throw new Error("Invalid frozen replay geometry.");
  const seed = structuredClone(plan);
  seed.status = "WATCHING"; seed.resumeStatus = "WATCHING"; seed.updatedAt = seed.createdAt; seed.lastEvaluatedCandle = null;
  seed.confirmationCandle = null; seed.confirmationAfter = seed.createdAt; seed.priceInterrupted = false; seed.triggeredAt = null; seed.observedEntry = null; seed.outcome = null;
  delete seed.measurements;
  if (seed.consolidation) { seed.consolidation.attempts = []; seed.consolidation.state = "inside"; seed.consolidation.lastQuoteAt = null; seed.consolidation.lastQuoteKey = null; seed.consolidation.truncated = false; }
  if (seed.pullback) { seed.pullback.touchedAt = null; seed.pullback.phase = "approaching"; seed.pullback.lastQuoteKey = null; seed.pullback.lastQuoteAt = null; seed.pullback.receivedQuotes = 0; seed.pullback.lastEntry = null; seed.pullback.move = "unknown"; }
  seed.reason = "Replaying the original frozen hypothesis from its creation time.";
  return seed;
}

/** Receive-order replay with the same timer and quote lifecycle; no DB, AI or orders. */
export async function replayObserverPlan(records: AsyncIterable<MarketRecord> | Iterable<MarketRecord>, value: unknown, options: { until?: string } = {}) {
  let plan = observerReplaySeed(value);
  const cutoff = options.until ? Date.parse(options.until) : Infinity;
  if (Number.isNaN(cutoff) || cutoff < Date.parse(plan.createdAt)) throw new Error("Replay cutoff precedes the plan or is invalid.");
  const patterns = new MarketPatternEngine([plan.instrument]), state = new MarketStateEngine(patterns);
  const events: Array<{ at: string; status: ObserverPlan["status"]; reason: string; confirmation: string | null; outcome: ObserverPlan["outcome"] }> = [];
  const coverage = { records: 0, quoteRecords: 0, sequenceGaps: 0, feedErrors: 0, contextErrors: 0, cleanEnd: false, truncatedEvents: false };
  let previousTime: number | null = null, previousSequence = 0, session: string | null = null, nextTimer: number | null = null, asOf: string | null = null, ended = false;
  const kinds = new Set(["session", "quote", "heartbeat", "connection", "candles", "calendar", "context-error", "stream-error", "end"]);
  const evaluate = (ms: number) => {
    const at = new Date(ms).toISOString(), read = state.update(plan.instrument, at);
    if (ms >= Date.parse(plan.createdAt)) {
      const next = evaluateMeasuredPlan(plan, read, patterns.history(plan.instrument, plan.trigger?.timeframe ?? "M5"));
      if (next.status !== plan.status || next.reason !== plan.reason || next.confirmationCandle !== plan.confirmationCandle) {
        if (events.length < 500) events.push({ at, status: next.status, reason: next.reason, confirmation: next.confirmationCandle, outcome: structuredClone(next.outcome) });
        else coverage.truncatedEvents = true;
      }
      plan = next;
    }
    asOf = at;
    return read;
  };
  const timers = (end: number) => {
    while (nextTimer !== null && nextTimer <= end) {
      const read = evaluate(nextTimer); nextTimer += 250;
      // With no incoming records a paused feed cannot recover. Preserve exact entry
      // expiry while avoiding millions of redundant weekend timer iterations.
      if (read.state === "paused") {
        const expires = !plan.triggeredAt && !TERMINAL_PLAN_STATES.has(plan.status) ? Date.parse(plan.expiresAt) : Infinity;
        if (expires >= nextTimer && expires <= end) nextTimer = expires;
        else { nextTimer = end + 250; break; }
      }
    }
  };
  for await (const record of records) {
    const ms = Date.parse(record.receivedAt);
    if (!Number.isFinite(ms) || record.version !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error("Invalid replay record.");
    if (previousTime !== null && ms < previousTime) throw new Error("Recording receive time regressed; causal replay stopped.");
    if (ms > cutoff) break;
    if (ended || !kinds.has(record.kind) || !record.data || typeof record.data !== "object" || Array.isArray(record.data)
      || !Number.isSafeInteger(record.connection) || record.connection < 0 || typeof record.sessionId !== "string" || !record.sessionId) throw new Error("Invalid recording envelope or rows after recording end.");
    if (record.kind === "session") {
      if (session) throw new Error("Replay one recording session at a time.");
      if (!Array.isArray(record.data.instruments) || !record.data.instruments.includes(plan.instrument)) throw new Error("The plan's instrument was not recorded.");
      session = record.sessionId;
    } else if (!session || record.sessionId !== session) throw new Error("Replay requires a matching session header.");
    if (record.sequence !== previousSequence + 1) coverage.sequenceGaps++;
    timers(ms - 1);
    patterns.consume(record);
    if (record.kind === "calendar") state.calendarContext(record.data, record.receivedAt);
    if (record.kind === "context-error") { state.contextError(record.data); coverage.contextErrors++; }
    if (record.kind === "stream-error" || record.kind === "connection" && record.data.state === "error") coverage.feedErrors++;
    if (record.kind === "quote" && record.data.instrument === plan.instrument) coverage.quoteRecords++;
    if (record.kind === "end") { ended = true; coverage.cleanEnd = !record.data.failure && record.data.droppedRecords === 0; }
    evaluate(ms);
    nextTimer ??= ms + 250;
    previousTime = ms; previousSequence = record.sequence; coverage.records++;
  }
  if (!asOf || Date.parse(asOf) < Date.parse(plan.createdAt)) throw new Error("Recording does not reach this plan's creation time.");
  if (Number.isFinite(cutoff)) { timers(cutoff); evaluate(cutoff); }
  if (!Number.isFinite(cutoff) && plan.triggeredAt && !TERMINAL_PLAN_STATES.has(plan.status)) {
    plan = resumeObserverPlan(plan, asOf);
    plan.reason = "Replay ended before a terminal outcome; the remaining path is unknown.";
    if (plan.measurements) plan.measurements.firstGapAt ??= asOf;
  }
  return { kind: "frozen_plan_replay", version: "observer-replay@1", source: "recorded sampled OANDA quotes", coverage,
    plan, events, evaluation: summarizeObserverPlans([plan], plan.instrument, asOf),
    note: "The plan was supplied at its original creation time. This replays its mechanism; it does not recreate Analyze or validate a profitable strategy. Cutoff results may remain unfinished." };
}
