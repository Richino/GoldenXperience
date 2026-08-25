/**
 * Replays the frozen impulse -> 2/3-candle pullback -> resumption Momentum
 * pattern over the exact recorded 47 opportunities. Research only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { MOMENTUM_EARLY_IGNITION_CONFIG, detectMomentumEarlyIgnition, invertMomentumIgnitionDirection } = await import("../src/momentum-early-ignition.js");
const { MOMENTUM_PULLBACK_CONTINUATION_CONFIG, detectMomentumPullbackContinuation, invertMomentumPullbackDirection } = await import("../src/momentum-pullback-continuation.js");
import type { MomentumIgnitionBar, MomentumIgnitionDirection } from "../src/momentum-early-ignition.js";

const EXPERIMENT = "momentum-pullback-continuation-recorded-47-v1";
const SNAPSHOT_CUTOFF = "2026-08-24T17:30:00.000Z";
const EXPECTED_OPPORTUNITIES = 47;
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);

type PairRow = {
  pair_id: string; experiment_id: string; instrument: string; decision_time: string | Date;
  original_direction: MomentumIgnitionDirection; stop_distance: string; target_distance: string;
  atr: string; original_r: string; inverted_r: string;
};

type Quote = {
  closeTime: string;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

type OandaCandle = {
  complete: boolean; time: string; volume?: number;
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
};

type SimulatedArm = {
  direction: MomentumIgnitionDirection; entry: number; stop: number; target: number;
  stopDistance: number; targetDistance: number; resultR: number | null; grossR: number | null;
  spreadCostR: number; outcome: string; maxFavorableR: number | null; maxAdverseR: number | null; resolvedAt: string | null;
};

type ResultRow = {
  pairId: string; sourceExperiment: string; instrument: string; originalDecisionTime: string;
  originalDirection: MomentumIgnitionDirection; storedOriginalImmediateR: number; storedInvertedImmediateR: number;
  m5OriginalImmediate: SimulatedArm; m5InvertedImmediate: SimulatedArm;
  ignitionAction: "ignite" | "wait"; ignitionDirection: MomentumIgnitionDirection | null;
  action: "trade" | "wait"; direction: MomentumIgnitionDirection | null; directionRelationToOriginal: "same" | "opposite" | "wait";
  ruleStrength: number; pullbackBars: number | null; entryAt: string | null; leadMinutes: number | null;
  impulseM15Atr: number | null; retracementFraction: number | null; entryExtensionM15Atr: number | null;
  structureRoomR: number | null; pullbackTickActivityRatio: number | null; liquidSession: boolean | null;
  lateAfterOriginal: boolean; reason: string; selected: SimulatedArm | null; exactOpposite: SimulatedArm | null;
};

type MetricRow = { r: number; ms: number };

function mean(values: readonly number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function percentile(sorted: readonly number[], fraction: number): number { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))))]!; }

function dayBlockBootstrap(rows: readonly MetricRow[], trials = 4000, seed = 20260825) {
  if (!rows.length) return { low: Number.NaN, high: Number.NaN, effectiveDays: 0 };
  const blocks = new Map<string, number[]>();
  for (const row of rows) {
    const key = new Date(row.ms).toISOString().slice(0, 10);
    blocks.set(key, [...(blocks.get(key) ?? []), row.r]);
  }
  const values = [...blocks.values()];
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const estimates: number[] = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const sample: number[] = [];
    for (let index = 0; index < values.length; index += 1) sample.push(...values[Math.floor(random() * values.length)]!);
    estimates.push(mean(sample));
  }
  estimates.sort((a, b) => a - b);
  return { low: percentile(estimates, 0.025), high: percentile(estimates, 0.975), effectiveDays: values.length };
}

function metrics(rows: readonly MetricRow[], denominator = rows.length) {
  if (!rows.length) return { n: 0, wins: 0, winRate: null, netExpectancyR: null, opportunityExpectancyR: 0, totalR: 0, profitFactor: null, ci95: [null, null], effectiveDays: 0 };
  const returns = rows.map((row) => row.r);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const lossTotal = Math.abs(sum(losses));
  const ci = dayBlockBootstrap(rows);
  return { n: rows.length, wins: wins.length, winRate: wins.length / rows.length, netExpectancyR: mean(returns), opportunityExpectancyR: sum(returns) / denominator, totalR: sum(returns), profitFactor: lossTotal > 0 ? sum(wins) / lossTotal : sum(wins) > 0 ? Number.POSITIVE_INFINITY : null, ci95: [ci.low, ci.high], effectiveDays: ci.effectiveDays };
}

function iso(value: string | Date): string { return new Date(value).toISOString(); }
function format(value: number | null, decimals = 4): string { return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(decimals); }
function percent(value: number | null): string { return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`; }
function midpoint(bid: number, ask: number): number { return (bid + ask) / 2; }

function quoteToMidBar(quote: Quote, volume: number | undefined): MomentumIgnitionBar {
  return { closeTime: quote.closeTime, open: midpoint(quote.bidOpen, quote.askOpen), high: midpoint(quote.bidHigh, quote.askHigh), low: midpoint(quote.bidLow, quote.askLow), close: midpoint(quote.bidClose, quote.askClose), volume };
}

function aggregateM15(m5Bars: readonly MomentumIgnitionBar[]): MomentumIgnitionBar[] {
  const result: MomentumIgnitionBar[] = [];
  for (let index = 2; index < m5Bars.length; index += 1) {
    if (new Date(m5Bars[index]!.closeTime).getUTCMinutes() % 15 !== 0) continue;
    const group = m5Bars.slice(index - 2, index + 1);
    if (!group.every((bar, groupIndex) => groupIndex === 0 || Date.parse(bar.closeTime) - Date.parse(group[groupIndex - 1]!.closeTime) === 5 * 60_000)) continue;
    const volumes = group.flatMap((bar) => bar.volume === undefined ? [] : [bar.volume]);
    result.push({ closeTime: group[2]!.closeTime, open: group[0]!.open, high: Math.max(...group.map((bar) => bar.high)), low: Math.min(...group.map((bar) => bar.low)), close: group[2]!.close, volume: volumes.length === group.length ? sum(volumes) : undefined });
  }
  return result;
}

const paired = await query<PairRow>(`
  WITH complete AS (
    SELECT pair_id, max(experiment_id) AS experiment_id, max(instrument) AS instrument,
           max(decision_time) AS decision_time, max(direction) FILTER (WHERE arm='original') AS original_direction,
           max(stop_distance)::text AS stop_distance, max(target_distance)::text AS target_distance, max(atr)::text AS atr,
           max(net_result_r) FILTER (WHERE arm='original')::text AS original_r,
           max(net_result_r) FILTER (WHERE arm='inverted')::text AS inverted_r
      FROM momentum_inversion_arms
     WHERE status='resolved' AND net_result_r IS NOT NULL AND decision_time <= $1::timestamptz
     GROUP BY pair_id HAVING count(*)=2 AND count(DISTINCT arm)=2
  )
  SELECT pair_id::text, experiment_id, instrument, decision_time, original_direction,
         stop_distance, target_distance, atr, original_r, inverted_r
    FROM complete ORDER BY decision_time, pair_id
`, [SNAPSHOT_CUTOFF]);
if (paired.rows.length !== EXPECTED_OPPORTUNITIES) throw new Error(`Expected ${EXPECTED_OPPORTUNITIES} frozen pairs, found ${paired.rows.length}.`);

if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("Momentum pullback replay refuses OANDA live.");
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim();
if (!token) throw new Error("OANDA Practice credentials are required for the completed M5 replay.");

const instruments = [...new Set(paired.rows.map((row) => row.instrument))].sort();
const firstDecisionMs = Math.min(...paired.rows.map((row) => Date.parse(iso(row.decision_time))));
const lastDecisionMs = Math.max(...paired.rows.map((row) => Date.parse(iso(row.decision_time))));

async function fetchPracticeM5(instrument: string): Promise<{ quotes: Quote[]; volumes: number[] }> {
  const fromMs = firstDecisionMs - 8 * 60 * 60_000;
  const toMs = Math.min(lastDecisionMs + 12 * 60 * 60_000, Math.floor(Date.now() / (5 * 60_000)) * 5 * 60_000);
  const params = new URLSearchParams({ price: "BA", granularity: "M5", from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), includeFirst: "true", smooth: "false" });
  const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`OANDA Practice M5 replay failed for ${instrument}: HTTP ${response.status} ${(await response.text()).replace(/\s+/g, " ").slice(0, 500)}`);
  const payload = await response.json() as { candles?: OandaCandle[] };
  const complete = (payload.candles ?? []).filter((candle) => candle.complete && candle.bid && candle.ask);
  return {
    quotes: complete.map((candle) => ({ closeTime: new Date(Date.parse(candle.time) + 5 * 60_000).toISOString(), bidOpen: Number(candle.bid!.o), bidHigh: Number(candle.bid!.h), bidLow: Number(candle.bid!.l), bidClose: Number(candle.bid!.c), askOpen: Number(candle.ask!.o), askHigh: Number(candle.ask!.h), askLow: Number(candle.ask!.l), askClose: Number(candle.ask!.c) })),
    volumes: complete.map((candle) => Number(candle.volume ?? 0)),
  };
}

const quotesByInstrument = new Map<string, Quote[]>();
const m5ByInstrument = new Map<string, MomentumIgnitionBar[]>();
const m15ByInstrument = new Map<string, MomentumIgnitionBar[]>();
for (const instrument of instruments) {
  const fetched = await fetchPracticeM5(instrument);
  const m5 = fetched.quotes.map((quote, index) => quoteToMidBar(quote, fetched.volumes[index]));
  const m15 = aggregateM15(m5);
  quotesByInstrument.set(instrument, fetched.quotes); m5ByInstrument.set(instrument, m5); m15ByInstrument.set(instrument, m15);
  console.log(`[momentum-pullback] ${instrument}: ${m5.length} completed M5, ${m15.length} derived M15 candles`);
}

function quoteIndexAtOpen(quotes: readonly Quote[], openAt: string): number {
  const target = Date.parse(openAt);
  return quotes.findIndex((quote) => Date.parse(quote.closeTime) - 5 * 60_000 === target);
}

function simulateDistances(args: { direction: MomentumIgnitionDirection; quote: Quote; decisionAt: string; futureQuotes: Quote[]; stopDistance: number; targetDistance: number }): SimulatedArm {
  const entry = args.direction === "long" ? args.quote.askOpen : args.quote.bidOpen;
  const stop = args.direction === "long" ? entry - args.stopDistance : entry + args.stopDistance;
  const target = args.direction === "long" ? entry + args.targetDistance : entry - args.targetDistance;
  const outcome = labelOutcome(args.direction, entry, stop, target, args.decisionAt, args.futureQuotes);
  const spreadCostR = (args.quote.askOpen - args.quote.bidOpen) / args.stopDistance;
  return { direction: args.direction, entry, stop, target, stopDistance: args.stopDistance, targetDistance: args.targetDistance, resultR: outcome.resultR, grossR: outcome.resultR === null ? null : outcome.resultR + spreadCostR, spreadCostR, outcome: outcome.outcome, maxFavorableR: outcome.maxFavorableR, maxAdverseR: outcome.maxAdverseR, resolvedAt: outcome.resolvedAt };
}

function simulateStructural(args: { direction: MomentumIgnitionDirection; structuralStop: number; quote: Quote; decisionAt: string; futureQuotes: Quote[] }): SimulatedArm | null {
  const entry = args.direction === "long" ? args.quote.askOpen : args.quote.bidOpen;
  const stopDistance = args.direction === "long" ? entry - args.structuralStop : args.structuralStop - entry;
  if (!(stopDistance > 0)) return null;
  return simulateDistances({ direction: args.direction, quote: args.quote, decisionAt: args.decisionAt, futureQuotes: args.futureQuotes, stopDistance, targetDistance: stopDistance * 2 });
}

function resolvedR(arm: SimulatedArm | null): number | null { return arm !== null && arm.resultR !== null && arm.outcome !== "unresolved" ? arm.resultR : null; }

const integrity = { missingImmediateQuote: 0, missingPatternQuote: 0, invalidRecordedGeometry: 0, invalidStructuralGeometry: 0, latePattern: 0, unresolvedImmediate: 0, unresolvedPattern: 0, ambiguousPattern: 0 };
const results: ResultRow[] = [];

for (const row of paired.rows) {
  const originalDecisionTime = iso(row.decision_time);
  const recordedStopDistance = Number(row.stop_distance);
  const recordedTargetDistance = Number(row.target_distance);
  if (!(recordedStopDistance > 0) || !(recordedTargetDistance > 0) || !(Number(row.atr) > 0)) { integrity.invalidRecordedGeometry += 1; continue; }
  const quotes = quotesByInstrument.get(row.instrument) ?? [];
  const m5Bars = m5ByInstrument.get(row.instrument) ?? [];
  const m15Bars = m15ByInstrument.get(row.instrument) ?? [];
  const immediateIndex = quoteIndexAtOpen(quotes, originalDecisionTime);
  if (immediateIndex < 0) { integrity.missingImmediateQuote += 1; continue; }
  const immediateQuote = quotes[immediateIndex]!;
  const immediateFuture = quotes.slice(immediateIndex, immediateIndex + 1200);
  const m5OriginalImmediate = simulateDistances({ direction: row.original_direction, quote: immediateQuote, decisionAt: originalDecisionTime, futureQuotes: immediateFuture, stopDistance: recordedStopDistance, targetDistance: recordedTargetDistance });
  const m5InvertedImmediate = simulateDistances({ direction: invertMomentumIgnitionDirection(row.original_direction), quote: immediateQuote, decisionAt: originalDecisionTime, futureQuotes: immediateFuture, stopDistance: recordedStopDistance, targetDistance: recordedTargetDistance });
  if (m5OriginalImmediate.outcome === "unresolved" || m5InvertedImmediate.outcome === "unresolved") integrity.unresolvedImmediate += 1;

  const ignition = detectMomentumEarlyIgnition({ m15Bars, m5Bars, originalDecisionTime });
  const pattern = ignition.action === "ignite" && ignition.direction && ignition.triggerIndex !== null && ignition.m15Atr !== null
    ? detectMomentumPullbackContinuation({ bars: m5Bars, breakoutIndex: ignition.triggerIndex, direction: ignition.direction, m15Atr: ignition.m15Atr })
    : null;
  const latePattern = pattern?.entryAt !== null && pattern?.entryAt !== undefined && Date.parse(pattern.entryAt) >= Date.parse(originalDecisionTime);
  if (latePattern) integrity.latePattern += 1;
  const trades = pattern?.action === "trade" && !latePattern && pattern.direction && pattern.entryAt && pattern.stop !== null;
  let selected: SimulatedArm | null = null;
  let exactOpposite: SimulatedArm | null = null;
  if (trades) {
    const patternIndex = quoteIndexAtOpen(quotes, pattern.entryAt!);
    if (patternIndex < 0) { integrity.missingPatternQuote += 1; continue; }
    const quote = quotes[patternIndex]!;
    const future = quotes.slice(patternIndex, patternIndex + 1200);
    selected = simulateStructural({ direction: pattern.direction!, structuralStop: pattern.stop!, quote, decisionAt: pattern.entryAt!, futureQuotes: future });
    if (selected === null) { integrity.invalidStructuralGeometry += 1; continue; }
    exactOpposite = simulateDistances({ direction: invertMomentumPullbackDirection(pattern.direction!), quote, decisionAt: pattern.entryAt!, futureQuotes: future, stopDistance: selected.stopDistance, targetDistance: selected.targetDistance });
    if (selected.outcome === "unresolved" || exactOpposite.outcome === "unresolved") integrity.unresolvedPattern += 1;
    if (selected.outcome === "ambiguous") integrity.ambiguousPattern += 1;
  }
  const effectiveTrade = selected !== null && exactOpposite !== null;
  const direction = effectiveTrade ? pattern!.direction : null;
  results.push({
    pairId: row.pair_id, sourceExperiment: row.experiment_id, instrument: row.instrument, originalDecisionTime,
    originalDirection: row.original_direction, storedOriginalImmediateR: Number(row.original_r), storedInvertedImmediateR: Number(row.inverted_r),
    m5OriginalImmediate, m5InvertedImmediate, ignitionAction: ignition.action, ignitionDirection: ignition.direction,
    action: effectiveTrade ? "trade" : "wait", direction,
    directionRelationToOriginal: direction === null ? "wait" : direction === row.original_direction ? "same" : "opposite",
    ruleStrength: effectiveTrade ? pattern!.ruleStrength : 0, pullbackBars: pattern?.pullbackBars ?? null,
    entryAt: effectiveTrade ? pattern!.entryAt : null,
    leadMinutes: effectiveTrade ? (Date.parse(originalDecisionTime) - Date.parse(pattern!.entryAt!)) / 60_000 : null,
    impulseM15Atr: pattern?.impulseM15Atr ?? null, retracementFraction: pattern?.retracementFraction ?? null,
    entryExtensionM15Atr: pattern?.entryExtensionM15Atr ?? null, structureRoomR: pattern?.structureRoomR ?? null,
    pullbackTickActivityRatio: pattern?.pullbackTickActivityRatio ?? null, liquidSession: pattern?.liquidSession ?? null,
    lateAfterOriginal: latePattern,
    reason: latePattern ? "The pullback continuation became actionable at or after the original Momentum decision, so it counted as WAIT." : pattern?.reason ?? ignition.reason,
    selected, exactOpposite,
  });
}

if (results.length !== EXPECTED_OPPORTUNITIES) throw new Error(`Only ${results.length}/${EXPECTED_OPPORTUNITIES} survived replay integrity: ${JSON.stringify(integrity)}`);

const metric = (rows: readonly ResultRow[], value: (row: ResultRow) => number | null): MetricRow[] => rows.flatMap((row) => {
  const result = value(row); return result === null || !Number.isFinite(result) ? [] : [{ r: result, ms: Date.parse(row.originalDecisionTime) }];
});
const usable = results.filter((row) => resolvedR(row.selected) !== null && resolvedR(row.exactOpposite) !== null);
const opportunityRows = (value: (row: ResultRow) => number | null) => results.map((row) => ({ r: value(row) ?? 0, ms: Date.parse(row.originalDecisionTime) }));
const storedOriginal = metrics(metric(results, (row) => row.storedOriginalImmediateR), EXPECTED_OPPORTUNITIES);
const storedInverted = metrics(metric(results, (row) => row.storedInvertedImmediateR), EXPECTED_OPPORTUNITIES);
const m5Original = metrics(metric(results, (row) => row.m5OriginalImmediate.resultR), EXPECTED_OPPORTUNITIES);
const m5Inverted = metrics(metric(results, (row) => row.m5InvertedImmediate.resultR), EXPECTED_OPPORTUNITIES);
const selectedConditional = metrics(metric(usable, (row) => resolvedR(row.selected)), EXPECTED_OPPORTUNITIES);
const oppositeConditional = metrics(metric(usable, (row) => resolvedR(row.exactOpposite)), EXPECTED_OPPORTUNITIES);
const selectedOpportunity = metrics(opportunityRows((row) => resolvedR(row.selected)), EXPECTED_OPPORTUNITIES);
const oppositeOpportunity = metrics(opportunityRows((row) => resolvedR(row.exactOpposite)), EXPECTED_OPPORTUNITIES);
const selectedMinusOpposite = metrics(usable.map((row) => ({ r: resolvedR(row.selected)! - resolvedR(row.exactOpposite)!, ms: Date.parse(row.originalDecisionTime) })));
const selectedMinusInverted = metrics(results.map((row) => ({ r: (resolvedR(row.selected) ?? 0) - (row.m5InvertedImmediate.resultR ?? 0), ms: Date.parse(row.originalDecisionTime) })));

const byPullbackBars = Object.fromEntries(([2, 3] as const).map((count) => {
  const rows = usable.filter((row) => row.pullbackBars === count);
  return [String(count), metrics(metric(rows, (row) => resolvedR(row.selected)), EXPECTED_OPPORTUNITIES)];
}));
const bySession = Object.fromEntries((["liquid", "other"] as const).map((session) => {
  const rows = usable.filter((row) => session === "liquid" ? row.liquidSession : !row.liquidSession);
  return [session, metrics(metric(rows, (row) => resolvedR(row.selected)), EXPECTED_OPPORTUNITIES)];
}));
const byInstrument = Object.fromEntries(instruments.map((instrument) => {
  const opportunities = results.filter((row) => row.instrument === instrument);
  const rows = usable.filter((row) => row.instrument === instrument);
  return [instrument, { opportunities: opportunities.length, traded: rows.length, selected: metrics(metric(rows, (row) => resolvedR(row.selected)), opportunities.length) }];
}));
const waitReasonCounts = Object.fromEntries([...new Set(results.filter((row) => row.action === "wait").map((row) => row.reason))]
  .map((reason) => [reason, results.filter((row) => row.action === "wait" && row.reason === reason).length])
  .sort((a, b) => Number(b[1]) - Number(a[1])));

const positionAwareAccepted: ResultRow[] = [];
const positionAwareOverlapping: ResultRow[] = [];
const activeUntilByInstrument = new Map<string, number>();
for (const row of usable) {
  const entryAt = Date.parse(row.entryAt!);
  const activeUntil = activeUntilByInstrument.get(row.instrument) ?? Number.NEGATIVE_INFINITY;
  if (entryAt < activeUntil) { positionAwareOverlapping.push(row); continue; }
  positionAwareAccepted.push(row);
  activeUntilByInstrument.set(row.instrument, row.selected?.resolvedAt ? Date.parse(row.selected.resolvedAt) : entryAt + 48 * 60 * 60_000);
}
const positionAwareSelected = metrics(metric(positionAwareAccepted, (row) => resolvedR(row.selected)), EXPECTED_OPPORTUNITIES);
const positionAwareOpposite = metrics(metric(positionAwareAccepted, (row) => resolvedR(row.exactOpposite)), EXPECTED_OPPORTUNITIES);

const leads = usable.flatMap((row) => row.leadMinutes === null ? [] : [row.leadMinutes]);
const pairedLow = selectedMinusOpposite.ci95[0];
const controlLow = selectedMinusInverted.ci95[0];
const verdict = selectedConditional.n < 10 ? "INSUFFICIENT_PATTERN_TRADES"
  : selectedOpportunity.netExpectancyR !== null && selectedOpportunity.netExpectancyR > 0 && pairedLow !== null && pairedLow > 0 && controlLow !== null && controlLow > 0 ? "RETROSPECTIVE_EDGE_CANDIDATE"
    : selectedOpportunity.netExpectancyR !== null && selectedOpportunity.netExpectancyR > 0 ? "POSITIVE_POINT_ESTIMATE_NOT_CONFIRMED" : "NO_EDGE_IN_RECORDED_47";

const report = {
  experiment: EXPERIMENT, generatedAt: new Date().toISOString(), verdict, productionChanged: false,
  frozenPolicies: { ignition: MOMENTUM_EARLY_IGNITION_CONFIG, pullbackContinuation: MOMENTUM_PULLBACK_CONTINUATION_CONFIG },
  data: { opportunities: results.length, snapshotCutoff: SNAPSHOT_CUTOFF, firstDecision: new Date(firstDecisionMs).toISOString(), lastDecision: new Date(lastDecisionMs).toISOString(), instruments: instruments.length, effectiveUtcDays: new Set(results.map((row) => row.originalDecisionTime.slice(0, 10))).size, limitation: "The 47 windows were selected because a later Momentum signal existed. This is a retrospective pattern diagnostic, not a standalone false-positive study or untouched holdout." },
  integrity, funnel: { trade: usable.length, wait: results.length - usable.length },
  timing: { averageLeadMinutes: mean(leads), minimumLeadMinutes: leads.length ? Math.min(...leads) : null, maximumLeadMinutes: leads.length ? Math.max(...leads) : null, averageRuleStrength: mean(usable.map((row) => row.ruleStrength)) },
  controls: { storedM15: { original: storedOriginal, inverted: storedInverted }, matchedM5: { original: m5Original, inverted: m5Inverted } },
  pullbackContinuation: { selectedConditional, exactOppositeConditional: oppositeConditional, selectedOpportunityAdjusted: selectedOpportunity, exactOppositeOpportunityAdjusted: oppositeOpportunity, selectedMinusOppositePaired: selectedMinusOpposite, selectedMinusImmediateInvertedOpportunityPaired: selectedMinusInverted },
  positionAwareMomentumOnly: { accepted: positionAwareAccepted.length, overlapping: positionAwareOverlapping.length, selected: positionAwareSelected, exactOppositeOnSelectedSchedule: positionAwareOpposite, limitation: "Models one open Momentum position per instrument, not positions from other families." },
  byPullbackBars, bySession, byInstrument, waitReasonCounts,
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT, frozenBeforeResults: true,
  dataset: { source: "momentum_inversion_arms", expectedOpportunities: EXPECTED_OPPORTUNITIES, snapshotCutoff: SNAPSHOT_CUTOFF },
  marketData: "Read-only completed OANDA Practice M5 bid/ask candles with broker tick activity; M15 setup candles aggregated from M5.",
  policies: { ignition: MOMENTUM_EARLY_IGNITION_CONFIG, pullbackContinuation: MOMENTUM_PULLBACK_CONTINUATION_CONFIG },
  execution: "Next M5 open after a 2/3-candle pullback resumption; structural stop beyond pullback; 2R target; exact opposite uses identical absolute risk/reward distances and entry time.",
  caveat: "OANDA volume is broker tick activity, not centralized stock volume, and affects ruleStrength only—not eligibility.",
  promotion: "NONE. Retrospective later-signal-conditioned diagnostic; production/practice execution unchanged.",
}, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, "results.jsonl"), `${results.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.writeFileSync(path.join(OUTPUT_DIR, "RESULTS.json"), JSON.stringify(report, null, 2));

const topWaitReasons = Object.entries(waitReasonCounts).slice(0, 5);
const lines = [
  "GOLDENXPERIENCE — MOMENTUM PULLBACK CONTINUATION RECORDED-47 V1",
  `Generated: ${report.generatedAt}`,
  "RESEARCH ONLY — production/practice execution unchanged",
  "",
  `VERDICT: ${verdict}`,
  "",
  "DATA",
  `Opportunities: ${results.length} across ${report.data.effectiveUtcDays} UTC days and ${instruments.length} instruments`,
  `Window: ${report.data.firstDecision} .. ${report.data.lastDecision}`,
  report.data.limitation,
  "",
  "PATTERN FUNNEL",
  `TRADE ${usable.length} | WAIT ${results.length - usable.length} | late patterns counted WAIT ${integrity.latePattern}`,
  `Lead time avg=${format(report.timing.averageLeadMinutes, 1)}m min=${format(report.timing.minimumLeadMinutes, 0)}m max=${format(report.timing.maximumLeadMinutes, 0)}m`,
  `Average ruleStrength=${format(report.timing.averageRuleStrength, 1)}/100 (rule evidence, not calibrated probability)`,
  "",
  "MATCHED M5 IMMEDIATE CONTROLS — ALL 47",
  `Original n=${m5Original.n} WR=${percent(m5Original.winRate)} netE=${format(m5Original.netExpectancyR)} totalR=${format(m5Original.totalR, 2)} CI95=[${format(m5Original.ci95[0])}, ${format(m5Original.ci95[1])}]`,
  `Inverted n=${m5Inverted.n} WR=${percent(m5Inverted.winRate)} netE=${format(m5Inverted.netExpectancyR)} totalR=${format(m5Inverted.totalR, 2)} CI95=[${format(m5Inverted.ci95[0])}, ${format(m5Inverted.ci95[1])}]`,
  "",
  "PULLBACK CONTINUATION — STRUCTURAL STOP, 2R TARGET",
  `Selected       n=${selectedConditional.n} WR=${percent(selectedConditional.winRate)} netE=${format(selectedConditional.netExpectancyR)} totalR=${format(selectedConditional.totalR, 2)} CI95=[${format(selectedConditional.ci95[0])}, ${format(selectedConditional.ci95[1])}]`,
  `Exact opposite n=${oppositeConditional.n} WR=${percent(oppositeConditional.winRate)} netE=${format(oppositeConditional.netExpectancyR)} totalR=${format(oppositeConditional.totalR, 2)} CI95=[${format(oppositeConditional.ci95[0])}, ${format(oppositeConditional.ci95[1])}]`,
  `Paired direction improvement=${format(selectedMinusOpposite.netExpectancyR)}R CI95=[${format(selectedMinusOpposite.ci95[0])}, ${format(selectedMinusOpposite.ci95[1])}]`,
  "",
  "DIAGNOSTIC BREAKDOWNS — NOT FILTERS",
  `2-candle pullback n=${byPullbackBars["2"].n} netE=${format(byPullbackBars["2"].netExpectancyR)} | 3-candle n=${byPullbackBars["3"].n} netE=${format(byPullbackBars["3"].netExpectancyR)}`,
  `Liquid-session n=${bySession.liquid.n} netE=${format(bySession.liquid.netExpectancyR)} | other-session n=${bySession.other.n} netE=${format(bySession.other.netExpectancyR)}`,
  "OANDA tick activity is context only and was not used as a volume gate.",
  "",
  "OPPORTUNITY-ADJUSTED — WAIT = 0R ACROSS ALL 47",
  `Selected netE/opportunity=${format(selectedOpportunity.netExpectancyR)} totalR=${format(selectedOpportunity.totalR, 2)}`,
  `Opposite netE/opportunity=${format(oppositeOpportunity.netExpectancyR)} totalR=${format(oppositeOpportunity.totalR, 2)}`,
  `Selected minus immediate inverted=${format(selectedMinusInverted.netExpectancyR)}R/opportunity CI95=[${format(selectedMinusInverted.ci95[0])}, ${format(selectedMinusInverted.ci95[1])}]`,
  "",
  "TOP WAIT REASONS",
  ...topWaitReasons.map(([reason, count]) => `${count} — ${reason}`),
  "",
  "POSITION-AWARE MOMENTUM-ONLY SCHEDULE",
  `Accepted ${positionAwareAccepted.length} | overlapping ${positionAwareOverlapping.length}`,
  `Selected netE=${format(positionAwareSelected.netExpectancyR)} totalR=${format(positionAwareSelected.totalR, 2)} CI95=[${format(positionAwareSelected.ci95[0])}, ${format(positionAwareSelected.ci95[1])}]`,
  `Opposite netE=${format(positionAwareOpposite.netExpectancyR)} totalR=${format(positionAwareOpposite.totalR, 2)} CI95=[${format(positionAwareOpposite.ci95[0])}, ${format(positionAwareOpposite.ci95[1])}]`,
  "",
  "INTEGRITY",
  JSON.stringify(integrity),
  "Selected and exact-opposite arms share the same M5 entry time and absolute stop/target distances, use executable book sides, and pay spread.",
  "No parameter sweep or post-result tuning was performed.",
];
fs.writeFileSync(path.join(OUTPUT_DIR, "FINAL_REPORT.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
