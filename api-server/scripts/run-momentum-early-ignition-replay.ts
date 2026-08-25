/**
 * Replays the frozen M15-compression/M5-ignition detector over the exact 47
 * paired Momentum opportunities available through 2026-08-24 17:30Z.
 *
 * Research only. Reads the existing Postgres evidence and OANDA Practice
 * candles, writes local artifacts, and never updates execution or database state.
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
const {
  MOMENTUM_EARLY_IGNITION_CONFIG,
  detectMomentumEarlyIgnition,
  invertMomentumIgnitionDirection,
} = await import("../src/momentum-early-ignition.js");
import type { MomentumIgnitionBar, MomentumIgnitionDirection } from "../src/momentum-early-ignition.js";

const EXPERIMENT = "momentum-early-ignition-recorded-47-v1";
const SNAPSHOT_CUTOFF = "2026-08-24T17:30:00.000Z";
const EXPECTED_OPPORTUNITIES = 47;
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);

type PairRow = {
  pair_id: string;
  experiment_id: string;
  instrument: string;
  decision_time: string | Date;
  original_direction: MomentumIgnitionDirection;
  stop_distance: string;
  target_distance: string;
  atr: string;
  original_r: string;
  inverted_r: string;
};

type Quote = {
  closeTime: string;
  bidOpen: number;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askOpen: number;
  askHigh: number;
  askLow: number;
  askClose: number;
};

type OandaCandle = {
  complete: boolean;
  time: string;
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
};

type SimulatedArm = {
  direction: MomentumIgnitionDirection;
  entry: number;
  stop: number;
  target: number;
  resultR: number | null;
  grossR: number | null;
  spreadCostR: number;
  outcome: string;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
  resolvedAt: string | null;
};

type ResultRow = {
  pairId: string;
  sourceExperiment: string;
  instrument: string;
  originalDecisionTime: string;
  originalDirection: MomentumIgnitionDirection;
  storedOriginalImmediateR: number;
  storedInvertedImmediateR: number;
  m5OriginalImmediate: SimulatedArm;
  m5InvertedImmediate: SimulatedArm;
  action: "ignite" | "wait";
  earlyDirection: MomentumIgnitionDirection | null;
  directionRelation: "same" | "opposite" | "wait";
  ruleStrength: number;
  triggerAt: string | null;
  entryAt: string | null;
  leadMinutes: number | null;
  hourlyContext: "long" | "short" | "mixed" | null;
  compressionRangeAtr: number | null;
  bodyRatio: number | null;
  bodyM5Atr: number | null;
  entryExtensionM15Atr: number | null;
  reason: string;
  earlySelected: SimulatedArm | null;
  earlyOpposite: SimulatedArm | null;
};

type MetricRow = { r: number; ms: number };

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (!sorted.length) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

function dayBlockBootstrap(rows: readonly MetricRow[], trials = 4000, seed = 20260825) {
  if (!rows.length) return { low: Number.NaN, high: Number.NaN, effectiveDays: 0 };
  const blocks = new Map<string, number[]>();
  for (const row of rows) {
    const key = new Date(row.ms).toISOString().slice(0, 10);
    blocks.set(key, [...(blocks.get(key) ?? []), row.r]);
  }
  const values = [...blocks.values()];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
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
  if (!rows.length) {
    return { n: 0, wins: 0, winRate: null, netExpectancyR: null, opportunityExpectancyR: 0, totalR: 0, profitFactor: null, ci95: [null, null], effectiveDays: 0 };
  }
  const returns = rows.map((row) => row.r);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const lossTotal = Math.abs(sum(losses));
  const ci = dayBlockBootstrap(rows);
  return {
    n: rows.length,
    wins: wins.length,
    winRate: wins.length / rows.length,
    netExpectancyR: mean(returns),
    opportunityExpectancyR: sum(returns) / denominator,
    totalR: sum(returns),
    profitFactor: lossTotal > 0 ? sum(wins) / lossTotal : sum(wins) > 0 ? Number.POSITIVE_INFINITY : null,
    ci95: [ci.low, ci.high],
    effectiveDays: ci.effectiveDays,
  };
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function format(value: number | null, decimals = 4): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(decimals);
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function midpoint(bid: number, ask: number): number {
  return (bid + ask) / 2;
}

function quoteToMidBar(quote: Quote): MomentumIgnitionBar {
  return {
    closeTime: quote.closeTime,
    open: midpoint(quote.bidOpen, quote.askOpen),
    high: midpoint(quote.bidHigh, quote.askHigh),
    low: midpoint(quote.bidLow, quote.askLow),
    close: midpoint(quote.bidClose, quote.askClose),
  };
}

function aggregateM15(m5Bars: readonly MomentumIgnitionBar[]): MomentumIgnitionBar[] {
  const result: MomentumIgnitionBar[] = [];
  for (let index = 2; index < m5Bars.length; index += 1) {
    const closeMs = Date.parse(m5Bars[index]!.closeTime);
    const date = new Date(closeMs);
    if (date.getUTCMinutes() % 15 !== 0) continue;
    const group = m5Bars.slice(index - 2, index + 1);
    const contiguous = group.every((bar, groupIndex) => groupIndex === 0
      || Date.parse(bar.closeTime) - Date.parse(group[groupIndex - 1]!.closeTime) === 5 * 60_000);
    if (!contiguous) continue;
    result.push({
      closeTime: m5Bars[index]!.closeTime,
      open: group[0]!.open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group[2]!.close,
    });
  }
  return result;
}

const paired = await query<PairRow>(`
  WITH complete AS (
    SELECT pair_id,
           max(experiment_id) AS experiment_id,
           max(instrument) AS instrument,
           max(decision_time) AS decision_time,
           max(direction) FILTER (WHERE arm='original') AS original_direction,
           max(stop_distance)::text AS stop_distance,
           max(target_distance)::text AS target_distance,
           max(atr)::text AS atr,
           max(net_result_r) FILTER (WHERE arm='original')::text AS original_r,
           max(net_result_r) FILTER (WHERE arm='inverted')::text AS inverted_r
      FROM momentum_inversion_arms
     WHERE status='resolved' AND net_result_r IS NOT NULL AND decision_time <= $1::timestamptz
     GROUP BY pair_id
    HAVING count(*)=2 AND count(DISTINCT arm)=2
  )
  SELECT pair_id::text, experiment_id, instrument, decision_time, original_direction,
         stop_distance, target_distance, atr, original_r, inverted_r
    FROM complete ORDER BY decision_time, pair_id
`, [SNAPSHOT_CUTOFF]);

if (paired.rows.length !== EXPECTED_OPPORTUNITIES) {
  throw new Error(`Frozen replay expected ${EXPECTED_OPPORTUNITIES} complete pairs through ${SNAPSHOT_CUTOFF}, found ${paired.rows.length}.`);
}

if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") {
  throw new Error("Momentum ignition replay refuses OANDA live; use the Practice environment.");
}
const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim();
if (!token) throw new Error("OANDA Practice credentials are required for the completed M5 replay.");

const instruments = [...new Set(paired.rows.map((row) => row.instrument))].sort();
const firstDecisionMs = Math.min(...paired.rows.map((row) => Date.parse(iso(row.decision_time))));
const lastDecisionMs = Math.max(...paired.rows.map((row) => Date.parse(iso(row.decision_time))));

async function fetchPracticeM5(instrument: string): Promise<Quote[]> {
  const fromMs = firstDecisionMs - 8 * 60 * 60_000;
  const desiredToMs = lastDecisionMs + 12 * 60 * 60_000;
  const lastCompletedM5Close = Math.floor(Date.now() / (5 * 60_000)) * 5 * 60_000;
  const toMs = Math.min(desiredToMs, lastCompletedM5Close);
  const params = new URLSearchParams({
    price: "BA",
    granularity: "M5",
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    includeFirst: "true",
    smooth: "false",
  });
  const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/${instrument}/candles?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`OANDA Practice M5 replay failed for ${instrument}: HTTP ${response.status} ${detail}`);
  }
  const payload = await response.json() as { candles?: OandaCandle[] };
  return (payload.candles ?? [])
    .filter((candle) => candle.complete && candle.bid && candle.ask)
    .map((candle) => ({
      closeTime: new Date(Date.parse(candle.time) + 5 * 60_000).toISOString(),
      bidOpen: Number(candle.bid!.o), bidHigh: Number(candle.bid!.h), bidLow: Number(candle.bid!.l), bidClose: Number(candle.bid!.c),
      askOpen: Number(candle.ask!.o), askHigh: Number(candle.ask!.h), askLow: Number(candle.ask!.l), askClose: Number(candle.ask!.c),
    }));
}

const quotesByInstrument = new Map<string, Quote[]>();
const m5ByInstrument = new Map<string, MomentumIgnitionBar[]>();
const m15ByInstrument = new Map<string, MomentumIgnitionBar[]>();
for (const instrument of instruments) {
  const quotes = await fetchPracticeM5(instrument);
  const m5 = quotes.map(quoteToMidBar);
  const m15 = aggregateM15(m5);
  quotesByInstrument.set(instrument, quotes);
  m5ByInstrument.set(instrument, m5);
  m15ByInstrument.set(instrument, m15);
  console.log(`[momentum-ignition] ${instrument}: ${m5.length} completed M5 candles, ${m15.length} derived M15 candles from OANDA Practice`);
}

function quoteIndexAtOpen(quotes: readonly Quote[], openAt: string): number {
  const target = Date.parse(openAt);
  return quotes.findIndex((quote) => Date.parse(quote.closeTime) - 5 * 60_000 === target);
}

function simulateArm(args: {
  direction: MomentumIgnitionDirection;
  quote: Quote;
  decisionAt: string;
  futureQuotes: Quote[];
  stopDistance: number;
  targetDistance: number;
}): SimulatedArm {
  const entry = args.direction === "long" ? args.quote.askOpen : args.quote.bidOpen;
  const stop = args.direction === "long" ? entry - args.stopDistance : entry + args.stopDistance;
  const target = args.direction === "long" ? entry + args.targetDistance : entry - args.targetDistance;
  const outcome = labelOutcome(args.direction, entry, stop, target, args.decisionAt, args.futureQuotes);
  const spreadCostR = (args.quote.askOpen - args.quote.bidOpen) / args.stopDistance;
  return {
    direction: args.direction,
    entry,
    stop,
    target,
    resultR: outcome.resultR,
    grossR: outcome.resultR === null ? null : outcome.resultR + spreadCostR,
    spreadCostR,
    outcome: outcome.outcome,
    maxFavorableR: outcome.maxFavorableR,
    maxAdverseR: outcome.maxAdverseR,
    resolvedAt: outcome.resolvedAt,
  };
}

function resolvedR(arm: SimulatedArm | null): number | null {
  return arm !== null && arm.resultR !== null && arm.outcome !== "unresolved" ? arm.resultR : null;
}

const integrity = {
  missingImmediateQuote: 0,
  missingEarlyEntryQuote: 0,
  invalidGeometry: 0,
  earlyNotBeforeOriginal: 0,
  unresolvedImmediate: 0,
  unresolvedEarly: 0,
  ambiguousEarly: 0,
};
const results: ResultRow[] = [];

for (const row of paired.rows) {
  const originalDecisionTime = iso(row.decision_time);
  const stopDistance = Number(row.stop_distance);
  const targetDistance = Number(row.target_distance);
  if (!(stopDistance > 0) || !(targetDistance > 0) || !(Number(row.atr) > 0)) {
    integrity.invalidGeometry += 1;
    continue;
  }

  const quotes = quotesByInstrument.get(row.instrument) ?? [];
  const m5Bars = m5ByInstrument.get(row.instrument) ?? [];
  const m15Bars = m15ByInstrument.get(row.instrument) ?? [];
  const immediateQuoteIndex = quoteIndexAtOpen(quotes, originalDecisionTime);
  if (immediateQuoteIndex < 0) {
    integrity.missingImmediateQuote += 1;
    continue;
  }
  const immediateQuote = quotes[immediateQuoteIndex]!;
  const immediateFuture = quotes.slice(immediateQuoteIndex, immediateQuoteIndex + 1200);
  const m5OriginalImmediate = simulateArm({
    direction: row.original_direction,
    quote: immediateQuote,
    decisionAt: originalDecisionTime,
    futureQuotes: immediateFuture,
    stopDistance,
    targetDistance,
  });
  const m5InvertedImmediate = simulateArm({
    direction: invertMomentumIgnitionDirection(row.original_direction),
    quote: immediateQuote,
    decisionAt: originalDecisionTime,
    futureQuotes: immediateFuture,
    stopDistance,
    targetDistance,
  });
  if (m5OriginalImmediate.outcome === "unresolved" || m5InvertedImmediate.outcome === "unresolved") integrity.unresolvedImmediate += 1;

  const decision = detectMomentumEarlyIgnition({ m15Bars, m5Bars, originalDecisionTime });
  let earlySelected: SimulatedArm | null = null;
  let earlyOpposite: SimulatedArm | null = null;
  if (decision.action === "ignite" && decision.direction && decision.entryAt) {
    if (Date.parse(decision.entryAt) >= Date.parse(originalDecisionTime)) {
      integrity.earlyNotBeforeOriginal += 1;
      continue;
    }
    const earlyQuoteIndex = quoteIndexAtOpen(quotes, decision.entryAt);
    if (earlyQuoteIndex < 0) {
      integrity.missingEarlyEntryQuote += 1;
      continue;
    }
    const earlyQuote = quotes[earlyQuoteIndex]!;
    const earlyFuture = quotes.slice(earlyQuoteIndex, earlyQuoteIndex + 1200);
    earlySelected = simulateArm({
      direction: decision.direction,
      quote: earlyQuote,
      decisionAt: decision.entryAt,
      futureQuotes: earlyFuture,
      stopDistance,
      targetDistance,
    });
    earlyOpposite = simulateArm({
      direction: invertMomentumIgnitionDirection(decision.direction),
      quote: earlyQuote,
      decisionAt: decision.entryAt,
      futureQuotes: earlyFuture,
      stopDistance,
      targetDistance,
    });
    if (earlySelected.outcome === "unresolved" || earlyOpposite.outcome === "unresolved") integrity.unresolvedEarly += 1;
    if (earlySelected.outcome === "ambiguous") integrity.ambiguousEarly += 1;
  }

  results.push({
    pairId: row.pair_id,
    sourceExperiment: row.experiment_id,
    instrument: row.instrument,
    originalDecisionTime,
    originalDirection: row.original_direction,
    storedOriginalImmediateR: Number(row.original_r),
    storedInvertedImmediateR: Number(row.inverted_r),
    m5OriginalImmediate,
    m5InvertedImmediate,
    action: decision.action,
    earlyDirection: decision.direction,
    directionRelation: decision.direction === null ? "wait" : decision.direction === row.original_direction ? "same" : "opposite",
    ruleStrength: decision.ruleStrength,
    triggerAt: decision.triggerAt,
    entryAt: decision.entryAt,
    leadMinutes: decision.leadMinutes,
    hourlyContext: decision.hourlyContext,
    compressionRangeAtr: decision.compressionRangeAtr,
    bodyRatio: decision.bodyRatio,
    bodyM5Atr: decision.bodyM5Atr,
    entryExtensionM15Atr: decision.entryExtensionM15Atr,
    reason: decision.reason,
    earlySelected,
    earlyOpposite,
  });
}

if (results.length !== EXPECTED_OPPORTUNITIES) {
  throw new Error(`Only ${results.length}/${EXPECTED_OPPORTUNITIES} opportunities survived replay integrity checks: ${JSON.stringify(integrity)}`);
}

const metric = (rows: readonly ResultRow[], value: (row: ResultRow) => number | null): MetricRow[] => rows.flatMap((row) => {
  const result = value(row);
  return result === null || !Number.isFinite(result) ? [] : [{ r: result, ms: Date.parse(row.originalDecisionTime) }];
});
const usableEarly = results.filter((row) => resolvedR(row.earlySelected) !== null && resolvedR(row.earlyOpposite) !== null);
const storedOriginal = metrics(metric(results, (row) => row.storedOriginalImmediateR), EXPECTED_OPPORTUNITIES);
const storedInverted = metrics(metric(results, (row) => row.storedInvertedImmediateR), EXPECTED_OPPORTUNITIES);
const m5Original = metrics(metric(results, (row) => row.m5OriginalImmediate.resultR), EXPECTED_OPPORTUNITIES);
const m5Inverted = metrics(metric(results, (row) => row.m5InvertedImmediate.resultR), EXPECTED_OPPORTUNITIES);
const earlyConditional = metrics(metric(usableEarly, (row) => row.earlySelected?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const oppositeConditional = metrics(metric(usableEarly, (row) => row.earlyOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const earlyOpportunityRows = results.map((row) => ({
  r: resolvedR(row.earlySelected) ?? 0,
  ms: Date.parse(row.originalDecisionTime),
}));
const oppositeOpportunityRows = results.map((row) => ({
  r: resolvedR(row.earlyOpposite) ?? 0,
  ms: Date.parse(row.originalDecisionTime),
}));
const earlyOpportunity = metrics(earlyOpportunityRows, EXPECTED_OPPORTUNITIES);
const oppositeOpportunity = metrics(oppositeOpportunityRows, EXPECTED_OPPORTUNITIES);
const earlyMinusOpposite = metrics(usableEarly.map((row) => ({
  r: resolvedR(row.earlySelected)! - resolvedR(row.earlyOpposite)!,
  ms: Date.parse(row.originalDecisionTime),
})));
const earlyMinusM5Inverted = metrics(results.map((row) => ({
  r: (resolvedR(row.earlySelected) ?? 0) - (row.m5InvertedImmediate.resultR ?? 0),
  ms: Date.parse(row.originalDecisionTime),
})));

const positionAwareAccepted: ResultRow[] = [];
const positionAwareOverlapping: ResultRow[] = [];
const activeUntilByInstrument = new Map<string, number>();
for (const row of usableEarly) {
  const entryAt = Date.parse(row.entryAt!);
  const activeUntil = activeUntilByInstrument.get(row.instrument) ?? Number.NEGATIVE_INFINITY;
  if (entryAt < activeUntil) {
    positionAwareOverlapping.push(row);
    continue;
  }
  positionAwareAccepted.push(row);
  activeUntilByInstrument.set(row.instrument, row.earlySelected?.resolvedAt ? Date.parse(row.earlySelected.resolvedAt) : entryAt + 48 * 60 * 60_000);
}
const positionAwareSelected = metrics(metric(positionAwareAccepted, (row) => row.earlySelected?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const positionAwareOpposite = metrics(metric(positionAwareAccepted, (row) => row.earlyOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES);

const directionCounts = {
  same: results.filter((row) => row.directionRelation === "same").length,
  opposite: results.filter((row) => row.directionRelation === "opposite").length,
  wait: results.filter((row) => row.directionRelation === "wait").length,
};
const leadMinutes = usableEarly.flatMap((row) => row.leadMinutes === null ? [] : [row.leadMinutes]);
const byInstrument = Object.fromEntries(instruments.map((instrument) => {
  const opportunities = results.filter((row) => row.instrument === instrument);
  const selected = usableEarly.filter((row) => row.instrument === instrument);
  return [instrument, {
    opportunities: opportunities.length,
    ignitions: selected.length,
    selected: metrics(metric(selected, (row) => row.earlySelected?.resultR ?? null), opportunities.length),
  }];
}));
const byRelation = Object.fromEntries((["same", "opposite"] as const).map((relation) => {
  const rows = usableEarly.filter((row) => row.directionRelation === relation);
  return [relation, metrics(metric(rows, (row) => row.earlySelected?.resultR ?? null), EXPECTED_OPPORTUNITIES)];
}));
const byLeadBucket = Object.fromEntries((["05-30", "35-60", "65-90"] as const).map((bucket) => {
  const rows = usableEarly.filter((row) => {
    const lead = row.leadMinutes ?? 0;
    return bucket === "05-30" ? lead <= 30 : bucket === "35-60" ? lead <= 60 && lead > 30 : lead > 60;
  });
  return [bucket, {
    selected: metrics(metric(rows, (row) => row.earlySelected?.resultR ?? null), EXPECTED_OPPORTUNITIES),
    opposite: metrics(metric(rows, (row) => row.earlyOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES),
  }];
}));
const byRuleStrength = Object.fromEntries((["under85", "85-89", "90plus"] as const).map((bucket) => {
  const rows = usableEarly.filter((row) => bucket === "under85"
    ? row.ruleStrength < 85
    : bucket === "85-89" ? row.ruleStrength < 90 && row.ruleStrength >= 85 : row.ruleStrength >= 90);
  return [bucket, metrics(metric(rows, (row) => row.earlySelected?.resultR ?? null), EXPECTED_OPPORTUNITIES)];
}));

const pairedLow = earlyMinusOpposite.ci95[0];
const controlLow = earlyMinusM5Inverted.ci95[0];
const verdict = earlyConditional.n < 10
  ? "INSUFFICIENT_EARLY_SIGNALS"
  : earlyOpportunity.netExpectancyR !== null && earlyOpportunity.netExpectancyR > 0
    && pairedLow !== null && pairedLow > 0 && controlLow !== null && controlLow > 0
      ? "RETROSPECTIVE_EDGE_CANDIDATE"
      : earlyOpportunity.netExpectancyR !== null && earlyOpportunity.netExpectancyR > 0
        ? "POSITIVE_POINT_ESTIMATE_NOT_CONFIRMED"
        : "NO_EDGE_IN_RECORDED_47";

const report = {
  experiment: EXPERIMENT,
  generatedAt: new Date().toISOString(),
  verdict,
  productionChanged: false,
  frozenPolicy: MOMENTUM_EARLY_IGNITION_CONFIG,
  data: {
    opportunities: results.length,
    snapshotCutoff: SNAPSHOT_CUTOFF,
    firstDecision: new Date(firstDecisionMs).toISOString(),
    lastDecision: new Date(lastDecisionMs).toISOString(),
    instruments: instruments.length,
    effectiveUtcDays: new Set(results.map((row) => row.originalDecisionTime.slice(0, 10))).size,
    source: "Existing 47 resolved Momentum pairs plus read-only completed OANDA Practice M5 bid/ask candles.",
    limitation: "The windows were selected because a later Momentum signal existed. This diagnoses earlier timing on those 47 opportunities; it does not measure standalone false-positive frequency across all market time.",
  },
  integrity,
  actionCounts: { ignite: usableEarly.length, wait: results.length - usableEarly.length },
  directionCounts,
  timing: {
    averageLeadMinutes: mean(leadMinutes),
    minimumLeadMinutes: leadMinutes.length ? Math.min(...leadMinutes) : null,
    maximumLeadMinutes: leadMinutes.length ? Math.max(...leadMinutes) : null,
    averageRuleStrength: mean(usableEarly.map((row) => row.ruleStrength)),
  },
  storedM15Controls: { original: storedOriginal, inverted: storedInverted },
  matchedM5Controls: { original: m5Original, inverted: m5Inverted },
  earlyIgnition: {
    selectedConditional: earlyConditional,
    exactOppositeConditional: oppositeConditional,
    selectedOpportunityAdjusted: earlyOpportunity,
    exactOppositeOpportunityAdjusted: oppositeOpportunity,
    selectedMinusOppositePaired: earlyMinusOpposite,
    selectedMinusImmediateInvertedOpportunityPaired: earlyMinusM5Inverted,
  },
  positionAwareMomentumOnly: {
    accepted: positionAwareAccepted.length,
    overlapping: positionAwareOverlapping.length,
    selected: positionAwareSelected,
    exactOppositeOnSelectedSchedule: positionAwareOpposite,
    limitation: "Models one open Momentum position per instrument, not positions from other families.",
  },
  byRelation,
  byLeadBucket,
  byRuleStrength,
  byInstrument,
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT,
  frozenBeforeResults: true,
  dataset: { source: "momentum_inversion_arms", expectedOpportunities: EXPECTED_OPPORTUNITIES, snapshotCutoff: SNAPSHOT_CUTOFF },
  marketData: "Read-only completed OANDA Practice M5 bid/ask candles; M15 setup candles deterministically aggregated from M5.",
  policy: MOMENTUM_EARLY_IGNITION_CONFIG,
  execution: "Next M5 open after ignition; executable bid/ask; original absolute stop and target distances preserved for every matched arm.",
  controls: "Stored M15 original/inverted plus recomputed M5 original/inverted at the old decision time.",
  outcome: "Production labelOutcome on M5 bid/ask bars; same-day 16:45 ET forced exit; same-bar stop and target remains conservative ambiguous=-1R.",
  promotion: "NONE. Retrospective, later-signal-conditioned diagnostic only; production/practice execution remains untouched.",
}, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, "results.jsonl"), `${results.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.writeFileSync(path.join(OUTPUT_DIR, "RESULTS.json"), JSON.stringify(report, null, 2));

const lines = [
  "GOLDENXPERIENCE — MOMENTUM EARLY IGNITION RECORDED-47 V1",
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
  "EARLY SIGNAL FUNNEL",
  `IGNITE ${usableEarly.length} | WAIT ${results.length - usableEarly.length}`,
  `Same as old direction ${directionCounts.same} | Opposite ${directionCounts.opposite} | Wait ${directionCounts.wait}`,
  `Lead time avg=${format(report.timing.averageLeadMinutes, 1)}m min=${format(report.timing.minimumLeadMinutes, 0)}m max=${format(report.timing.maximumLeadMinutes, 0)}m`,
  `Average ruleStrength=${format(report.timing.averageRuleStrength, 1)}/100 (rule evidence, not calibrated probability)`,
  "",
  "MATCHED M5 IMMEDIATE CONTROLS — ALL 47",
  `Original n=${m5Original.n} WR=${percent(m5Original.winRate)} netE=${format(m5Original.netExpectancyR)} totalR=${format(m5Original.totalR, 2)} CI95=[${format(m5Original.ci95[0])}, ${format(m5Original.ci95[1])}]`,
  `Inverted n=${m5Inverted.n} WR=${percent(m5Inverted.winRate)} netE=${format(m5Inverted.netExpectancyR)} totalR=${format(m5Inverted.totalR, 2)} CI95=[${format(m5Inverted.ci95[0])}, ${format(m5Inverted.ci95[1])}]`,
  "",
  "EARLY IGNITION — TRADED SIGNALS ONLY",
  `Selected       n=${earlyConditional.n} WR=${percent(earlyConditional.winRate)} netE=${format(earlyConditional.netExpectancyR)} totalR=${format(earlyConditional.totalR, 2)} CI95=[${format(earlyConditional.ci95[0])}, ${format(earlyConditional.ci95[1])}]`,
  `Exact opposite n=${oppositeConditional.n} WR=${percent(oppositeConditional.winRate)} netE=${format(oppositeConditional.netExpectancyR)} totalR=${format(oppositeConditional.totalR, 2)} CI95=[${format(oppositeConditional.ci95[0])}, ${format(oppositeConditional.ci95[1])}]`,
  `Paired direction improvement=${format(earlyMinusOpposite.netExpectancyR)}R CI95=[${format(earlyMinusOpposite.ci95[0])}, ${format(earlyMinusOpposite.ci95[1])}]`,
  "",
  "DIAGNOSTIC BREAKDOWNS — NOT PROMOTION FILTERS",
  `Direction same as old n=${byRelation.same.n} netE=${format(byRelation.same.netExpectancyR)} | early direction opposite old n=${byRelation.opposite.n} netE=${format(byRelation.opposite.netExpectancyR)}`,
  `Lead 05-30m n=${byLeadBucket["05-30"].selected.n} selectedE=${format(byLeadBucket["05-30"].selected.netExpectancyR)} | oppositeE=${format(byLeadBucket["05-30"].opposite.netExpectancyR)}`,
  `Lead 35-60m n=${byLeadBucket["35-60"].selected.n} selectedE=${format(byLeadBucket["35-60"].selected.netExpectancyR)} | oppositeE=${format(byLeadBucket["35-60"].opposite.netExpectancyR)}`,
  `Lead 65-90m n=${byLeadBucket["65-90"].selected.n} selectedE=${format(byLeadBucket["65-90"].selected.netExpectancyR)} | oppositeE=${format(byLeadBucket["65-90"].opposite.netExpectancyR)}`,
  `ruleStrength <85 n=${byRuleStrength.under85.n} selectedE=${format(byRuleStrength.under85.netExpectancyR)} | 85-89 n=${byRuleStrength["85-89"].n} selectedE=${format(byRuleStrength["85-89"].netExpectancyR)} | 90+ n=${byRuleStrength["90plus"].n} selectedE=${format(byRuleStrength["90plus"].netExpectancyR)}`,
  "These are post-result diagnostics only. They were not used to tune or exclude trades.",
  "",
  "OPPORTUNITY-ADJUSTED — WAIT = 0R ACROSS ALL 47",
  `Early selected netE/opportunity=${format(earlyOpportunity.netExpectancyR)} totalR=${format(earlyOpportunity.totalR, 2)}`,
  `Early opposite netE/opportunity=${format(oppositeOpportunity.netExpectancyR)} totalR=${format(oppositeOpportunity.totalR, 2)}`,
  `Early selected minus immediate inverted=${format(earlyMinusM5Inverted.netExpectancyR)}R/opportunity CI95=[${format(earlyMinusM5Inverted.ci95[0])}, ${format(earlyMinusM5Inverted.ci95[1])}]`,
  "",
  "POSITION-AWARE MOMENTUM-ONLY SCHEDULE",
  `Accepted ${positionAwareAccepted.length} | overlapping ${positionAwareOverlapping.length}`,
  `Selected netE=${format(positionAwareSelected.netExpectancyR)} totalR=${format(positionAwareSelected.totalR, 2)} CI95=[${format(positionAwareSelected.ci95[0])}, ${format(positionAwareSelected.ci95[1])}]`,
  `Opposite netE=${format(positionAwareOpposite.netExpectancyR)} totalR=${format(positionAwareOpposite.totalR, 2)} CI95=[${format(positionAwareOpposite.ci95[0])}, ${format(positionAwareOpposite.ci95[1])}]`,
  "",
  "INTEGRITY",
  JSON.stringify(integrity),
  "Every chosen direction and exact opposite enter at the same M5 open, use their executable side of the book, preserve identical absolute stop/target distances, and pay spread.",
  "No parameter sweep or post-result tuning was performed.",
];
fs.writeFileSync(path.join(OUTPUT_DIR, "FINAL_REPORT.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
