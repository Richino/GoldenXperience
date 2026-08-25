/**
 * Replays the frozen Momentum burst FOLLOW/REVERSE/WAIT policy over the exact
 * 47 fully paired opportunities available through 2026-08-24 17:30Z.
 *
 * Research only. Reads Supabase/Postgres and writes local report artifacts. It
 * does not update a table and is not imported by practice execution.
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
  MOMENTUM_BURST_DIRECTION_CONFIG,
  decideMomentumBurstDirection,
  invertMomentumBurstDirection,
} = await import("../src/momentum-burst-direction.js");
import type { MomentumBurstBar, MomentumBurstDirection } from "../src/momentum-burst-direction.js";

const EXPERIMENT = "momentum-burst-direction-recorded-47-v1";
const SNAPSHOT_CUTOFF = "2026-08-24T17:30:00.000Z";
const EXPECTED_OPPORTUNITIES = 47;
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);

type PairRow = {
  pair_id: string;
  experiment_id: string;
  instrument: string;
  decision_time: string | Date;
  original_direction: MomentumBurstDirection;
  stop_distance: string;
  target_distance: string;
  atr: string;
  spread_pips: string;
  original_outcome: string;
  inverted_outcome: string;
  original_r: string;
  inverted_r: string;
};

type CandleRow = {
  instrument: string;
  close_time: string | Date;
  open: string;
  high: string;
  low: string;
  close: string;
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

type QuoteRow = {
  instrument: string;
  close_time: string | Date;
  bid_open: string;
  bid_high: string;
  bid_low: string;
  bid_close: string;
  ask_open: string;
  ask_high: string;
  ask_low: string;
  ask_close: string;
};

type SimulatedArm = {
  direction: MomentumBurstDirection;
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
  decisionTime: string;
  originalDirection: MomentumBurstDirection;
  originalImmediateR: number;
  invertedImmediateR: number;
  action: "follow" | "reverse" | "wait";
  chosenDirection: MomentumBurstDirection | null;
  confidence: number;
  reason: string;
  confirmationBars: number | null;
  knownAt: string | null;
  entryAt: string | null;
  selected: SimulatedArm | null;
  selectedOpposite: SimulatedArm | null;
};

type MetricRow = { r: number; ms: number };

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

/** UTC-day block bootstrap because 47 trades across a few days are correlated. */
function dayBlockBootstrap(rows: MetricRow[], trials = 4000, seed = 20260825) {
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
    for (let index = 0; index < values.length; index += 1) {
      sample.push(...values[Math.floor(random() * values.length)]!);
    }
    estimates.push(mean(sample));
  }
  estimates.sort((a, b) => a - b);
  return { low: percentile(estimates, 0.025), high: percentile(estimates, 0.975), effectiveDays: values.length };
}

function metrics(rows: MetricRow[], denominator = rows.length) {
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

function opposite(direction: MomentumBurstDirection): MomentumBurstDirection {
  return invertMomentumBurstDirection(direction);
}

function format(value: number | null, decimals = 4): string {
  return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(decimals);
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
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
           max(spread_pips)::text AS spread_pips,
           max(outcome) FILTER (WHERE arm='original') AS original_outcome,
           max(outcome) FILTER (WHERE arm='inverted') AS inverted_outcome,
           max(net_result_r) FILTER (WHERE arm='original')::text AS original_r,
           max(net_result_r) FILTER (WHERE arm='inverted')::text AS inverted_r
      FROM momentum_inversion_arms
     WHERE status='resolved' AND net_result_r IS NOT NULL AND decision_time <= $1::timestamptz
     GROUP BY pair_id
    HAVING count(*)=2 AND count(DISTINCT arm)=2
  )
  SELECT pair_id::text, experiment_id, instrument, decision_time, original_direction,
         stop_distance, target_distance, atr, spread_pips,
         original_outcome, inverted_outcome, original_r, inverted_r
    FROM complete ORDER BY decision_time, pair_id
`, [SNAPSHOT_CUTOFF]);

if (paired.rows.length !== EXPECTED_OPPORTUNITIES) {
  throw new Error(`Frozen replay expected ${EXPECTED_OPPORTUNITIES} complete pairs through ${SNAPSHOT_CUTOFF}, found ${paired.rows.length}.`);
}

const instruments = [...new Set(paired.rows.map((row) => row.instrument))].sort();
const firstDecision = paired.rows[0]!.decision_time;
const lastDecision = paired.rows.at(-1)!.decision_time;
const [candleResult, quoteResult] = await Promise.all([
  query<CandleRow>(`
    SELECT instrument, close_time, open::text, high::text, low::text, close::text
      FROM market_candles
     WHERE instrument=ANY($1::text[]) AND timeframe='M15' AND source='oanda'
       AND close_time BETWEEN $2::timestamptz - interval '3 hours' AND $3::timestamptz + interval '2 days'
     ORDER BY instrument, close_time
  `, [instruments, firstDecision, lastDecision]),
  query<QuoteRow>(`
    SELECT instrument, close_time,
           bid_open::text, bid_high::text, bid_low::text, bid_close::text,
           ask_open::text, ask_high::text, ask_low::text, ask_close::text
      FROM market_candle_quotes
     WHERE instrument=ANY($1::text[]) AND timeframe='M15' AND source='oanda'
       AND close_time BETWEEN $2::timestamptz - interval '3 hours' AND $3::timestamptz + interval '2 days'
     ORDER BY instrument, close_time
  `, [instruments, firstDecision, lastDecision]),
]);

const candlesByInstrument = new Map<string, MomentumBurstBar[]>();
for (const row of candleResult.rows) {
  const bar: MomentumBurstBar = {
    closeTime: iso(row.close_time),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
  };
  candlesByInstrument.set(row.instrument, [...(candlesByInstrument.get(row.instrument) ?? []), bar]);
}
const quotesByInstrument = new Map<string, Quote[]>();
for (const row of quoteResult.rows) {
  const quote: Quote = {
    closeTime: iso(row.close_time),
    bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
    askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
  };
  quotesByInstrument.set(row.instrument, [...(quotesByInstrument.get(row.instrument) ?? []), quote]);
}

type OandaCandle = {
  complete: boolean;
  time: string;
  bid?: { o: string; h: string; l: string; c: string };
  ask?: { o: string; h: string; l: string; c: string };
};

/**
 * Live collection does not persist its rolling OANDA candles into the research
 * candle tables. When the local snapshot is absent, recover the exact completed
 * bid/ask candles read-only from OANDA Practice. Never fall through to live.
 */
async function fetchPracticeReplayCandles(instrument: string): Promise<{ bars: MomentumBurstBar[]; quotes: Quote[] }> {
  if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") {
    throw new Error("Momentum replay refuses OANDA live; use the Practice environment.");
  }
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim();
  if (!token) throw new Error("OANDA Practice credentials are required because the live M15 snapshot is not stored locally.");
  const instrumentRows = paired.rows.filter((row) => row.instrument === instrument);
  const fromMs = Math.min(...instrumentRows.map((row) => new Date(row.decision_time).getTime())) - 3 * 60 * 60_000;
  const desiredToMs = Math.max(...instrumentRows.map((row) => new Date(row.decision_time).getTime())) + 24 * 60 * 60_000;
  const lastCompletedM15Close = Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000;
  const toMs = Math.min(desiredToMs, lastCompletedM15Close);
  const params = new URLSearchParams({
    price: "BA",
    granularity: "M15",
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
    throw new Error(`OANDA Practice candle replay failed for ${instrument}: HTTP ${response.status} ${detail}`);
  }
  const payload = await response.json() as { candles?: OandaCandle[] };
  const complete = (payload.candles ?? []).filter((candle) => candle.complete && candle.bid && candle.ask);
  const quotes: Quote[] = complete.map((candle) => ({
    closeTime: new Date(Date.parse(candle.time) + 15 * 60_000).toISOString(),
    bidOpen: Number(candle.bid!.o), bidHigh: Number(candle.bid!.h), bidLow: Number(candle.bid!.l), bidClose: Number(candle.bid!.c),
    askOpen: Number(candle.ask!.o), askHigh: Number(candle.ask!.h), askLow: Number(candle.ask!.l), askClose: Number(candle.ask!.c),
  }));
  const midpoint = (bid: number, ask: number) => (bid + ask) / 2;
  const bars: MomentumBurstBar[] = quotes.map((quote) => ({
    closeTime: quote.closeTime,
    open: midpoint(quote.bidOpen, quote.askOpen),
    high: midpoint(quote.bidHigh, quote.askHigh),
    low: midpoint(quote.bidLow, quote.askLow),
    close: midpoint(quote.bidClose, quote.askClose),
  }));
  return { bars, quotes };
}

let oandaPracticeFallbacks = 0;
for (const instrument of instruments) {
  const localBars = candlesByInstrument.get(instrument) ?? [];
  const localQuotes = quotesByInstrument.get(instrument) ?? [];
  const decisions = paired.rows.filter((row) => row.instrument === instrument).map((row) => iso(row.decision_time));
  const completeLocally = decisions.every((time) => localBars.some((bar) => bar.closeTime === time))
    && decisions.every((time) => localQuotes.some((quote) => quote.closeTime === time));
  if (completeLocally) continue;
  const fetched = await fetchPracticeReplayCandles(instrument);
  candlesByInstrument.set(instrument, fetched.bars);
  quotesByInstrument.set(instrument, fetched.quotes);
  oandaPracticeFallbacks += 1;
  console.log(`[momentum-direction] ${instrument}: recovered ${fetched.bars.length} completed M15 bid/ask candles from OANDA Practice`);
}

function simulateArm(args: {
  direction: MomentumBurstDirection;
  quote: Quote;
  knownAt: string;
  futureQuotes: Quote[];
  stopDistance: number;
  targetDistance: number;
}): SimulatedArm {
  const entry = args.direction === "long" ? args.quote.askOpen : args.quote.bidOpen;
  const stop = args.direction === "long" ? entry - args.stopDistance : entry + args.stopDistance;
  const target = args.direction === "long" ? entry + args.targetDistance : entry - args.targetDistance;
  const outcome = labelOutcome(args.direction, entry, stop, target, args.knownAt, args.futureQuotes);
  const spreadCostR = (args.quote.askOpen - args.quote.bidOpen) / args.stopDistance;
  return {
    direction: args.direction,
    entry, stop, target,
    resultR: outcome.resultR,
    grossR: outcome.resultR === null ? null : outcome.resultR + spreadCostR,
    spreadCostR,
    outcome: outcome.outcome,
    maxFavorableR: outcome.maxFavorableR,
    maxAdverseR: outcome.maxAdverseR,
    resolvedAt: outcome.resolvedAt,
  };
}

const results: ResultRow[] = [];
const integrity = { missingSetupCandle: 0, missingEntryQuote: 0, invalidGeometry: 0, unresolvedSelected: 0, ambiguousSelected: 0 };
console.log(`[momentum-direction] database replay data: ${candleResult.rows.length} M15 mid candles, ${quoteResult.rows.length} M15 bid/ask candles`);

for (const row of paired.rows) {
  const decisionTime = iso(row.decision_time);
  const candles = candlesByInstrument.get(row.instrument) ?? [];
  const quotes = quotesByInstrument.get(row.instrument) ?? [];
  const setupIndex = candles.findIndex((bar) => bar.closeTime === decisionTime);
  if (setupIndex < 0) {
    integrity.missingSetupCandle += 1;
    continue;
  }

  const atr = Number(row.atr);
  const stopDistance = Number(row.stop_distance);
  const targetDistance = Number(row.target_distance);
  if (!(atr > 0) || !(stopDistance > 0) || !(targetDistance > 0)) {
    integrity.invalidGeometry += 1;
    continue;
  }

  const decision = decideMomentumBurstDirection({
    bars: candles,
    setupIndex,
    originalDirection: row.original_direction,
    atr,
  });

  let selected: SimulatedArm | null = null;
  let selectedOpposite: SimulatedArm | null = null;
  let knownAt: string | null = null;
  let entryAt: string | null = null;

  if (decision.action !== "wait" && decision.direction && decision.knownAtIndex !== null && decision.entryIndex !== null) {
    knownAt = candles[decision.knownAtIndex]!.closeTime;
    const entryBarClose = candles[decision.entryIndex]!.closeTime;
    const quoteIndex = quotes.findIndex((quote) => quote.closeTime === entryBarClose);
    if (quoteIndex < 0) {
      integrity.missingEntryQuote += 1;
      continue;
    }
    const entryQuote = quotes[quoteIndex]!;
    entryAt = knownAt; // the next M15 bar opens exactly when the confirmation bar closes
    const futureQuotes = quotes.slice(quoteIndex, quoteIndex + 400);
    selected = simulateArm({ direction: decision.direction, quote: entryQuote, knownAt, futureQuotes, stopDistance, targetDistance });
    selectedOpposite = simulateArm({ direction: opposite(decision.direction), quote: entryQuote, knownAt, futureQuotes, stopDistance, targetDistance });
    if (selected.outcome === "unresolved") integrity.unresolvedSelected += 1;
    if (selected.outcome === "ambiguous") integrity.ambiguousSelected += 1;
  }

  results.push({
    pairId: row.pair_id,
    sourceExperiment: row.experiment_id,
    instrument: row.instrument,
    decisionTime,
    originalDirection: row.original_direction,
    originalImmediateR: Number(row.original_r),
    invertedImmediateR: Number(row.inverted_r),
    action: decision.action,
    chosenDirection: decision.direction,
    confidence: decision.confidence,
    reason: decision.reason,
    confirmationBars: decision.confirmationBars,
    knownAt,
    entryAt,
    selected,
    selectedOpposite,
  });
}

if (results.length !== EXPECTED_OPPORTUNITIES) {
  throw new Error(`Only ${results.length}/${EXPECTED_OPPORTUNITIES} opportunities survived replay integrity checks: ${JSON.stringify(integrity)}`);
}

const asMetric = (rows: ResultRow[], value: (row: ResultRow) => number | null): MetricRow[] => rows.flatMap((row) => {
  const result = value(row);
  return result === null || !Number.isFinite(result) ? [] : [{ r: result, ms: Date.parse(row.decisionTime) }];
});
const usableSelected = results.filter((row) => row.selected !== null && row.selected.resultR !== null && row.selected.outcome !== "unresolved");
const baselineOriginal = metrics(asMetric(results, (row) => row.originalImmediateR), EXPECTED_OPPORTUNITIES);
const baselineInverted = metrics(asMetric(results, (row) => row.invertedImmediateR), EXPECTED_OPPORTUNITIES);
const policySelected = metrics(asMetric(usableSelected, (row) => row.selected?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const policyOpposite = metrics(asMetric(usableSelected, (row) => row.selectedOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const policyOpportunityRows = results.map((row) => ({
  r: row.selected && row.selected.resultR !== null && row.selected.outcome !== "unresolved" ? row.selected.resultR : 0,
  ms: Date.parse(row.decisionTime),
}));
const policyOpportunityAdjusted = metrics(policyOpportunityRows, EXPECTED_OPPORTUNITIES);
const oppositeOpportunityRows = results.map((row) => ({
  r: row.selectedOpposite && row.selectedOpposite.resultR !== null && row.selectedOpposite.outcome !== "unresolved" ? row.selectedOpposite.resultR : 0,
  ms: Date.parse(row.decisionTime),
}));
const oppositeOpportunityAdjusted = metrics(oppositeOpportunityRows, EXPECTED_OPPORTUNITIES);
const pairedDifferenceRows = usableSelected.flatMap((row) => {
  if (!row.selected || !row.selectedOpposite || row.selected.resultR === null || row.selectedOpposite.resultR === null) return [];
  return [{ r: row.selected.resultR - row.selectedOpposite.resultR, ms: Date.parse(row.decisionTime) }];
});
const policyMinusOpposite = metrics(pairedDifferenceRows);

// Account-realistic view for this family: once the policy opens a position on
// an instrument, later Momentum selections on that instrument wait until the
// selected arm closes. The exact-opposite comparison uses the SAME accepted
// opportunities, so direction remains the only changed variable.
const positionAwareAccepted: ResultRow[] = [];
const positionAwareOverlapping: ResultRow[] = [];
const activeUntilByInstrument = new Map<string, number>();
for (const row of usableSelected) {
  const entryAt = Date.parse(row.entryAt ?? row.decisionTime);
  const activeUntil = activeUntilByInstrument.get(row.instrument) ?? Number.NEGATIVE_INFINITY;
  if (entryAt < activeUntil) {
    positionAwareOverlapping.push(row);
    continue;
  }
  positionAwareAccepted.push(row);
  const resolvedAt = row.selected?.resolvedAt ? Date.parse(row.selected.resolvedAt) : entryAt + 48 * 60 * 60_000;
  activeUntilByInstrument.set(row.instrument, resolvedAt);
}
const positionAwareSelected = metrics(asMetric(positionAwareAccepted, (row) => row.selected?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const positionAwareOpposite = metrics(asMetric(positionAwareAccepted, (row) => row.selectedOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES);
const positionAwareDifference = metrics(positionAwareAccepted.flatMap((row) => {
  if (!row.selected || !row.selectedOpposite || row.selected.resultR === null || row.selectedOpposite.resultR === null) return [];
  return [{ r: row.selected.resultR - row.selectedOpposite.resultR, ms: Date.parse(row.decisionTime) }];
}));

const actionCounts = {
  follow: results.filter((row) => row.action === "follow").length,
  reverse: results.filter((row) => row.action === "reverse").length,
  wait: results.filter((row) => row.action === "wait").length,
};
const byAction = Object.fromEntries((["follow", "reverse"] as const)
  .map((action) => {
    const rows = usableSelected.filter((row) => row.action === action);
    return [action, {
      selected: metrics(asMetric(rows, (row) => row.selected?.resultR ?? null), EXPECTED_OPPORTUNITIES),
      opposite: metrics(asMetric(rows, (row) => row.selectedOpposite?.resultR ?? null), EXPECTED_OPPORTUNITIES),
    }];
  }));
const byChosenDirection = Object.fromEntries(["long", "short"].map((direction) => {
  const rows = usableSelected.filter((row) => row.chosenDirection === direction);
  return [direction, metrics(asMetric(rows, (row) => row.selected?.resultR ?? null), EXPECTED_OPPORTUNITIES)];
}));
const byInstrument = Object.fromEntries(instruments.map((instrument) => {
  const rows = usableSelected.filter((row) => row.instrument === instrument);
  return [instrument, metrics(asMetric(rows, (row) => row.selected?.resultR ?? null), results.filter((row) => row.instrument === instrument).length)];
}));

const pairedCiLow = policyMinusOpposite.ci95[0];
const verdict = policySelected.n < 10
  ? "INSUFFICIENT_POLICY_TRADES"
  : policyOpportunityAdjusted.netExpectancyR !== null
    && policyOpportunityAdjusted.netExpectancyR > 0
    && pairedCiLow !== null && pairedCiLow > 0
      ? "RETROSPECTIVE_EDGE_CANDIDATE"
      : policyOpportunityAdjusted.netExpectancyR !== null && policyOpportunityAdjusted.netExpectancyR > 0
        ? "POSITIVE_POINT_ESTIMATE_NOT_CONFIRMED"
        : "NO_EDGE_IN_RECORDED_47";

const report = {
  experiment: EXPERIMENT,
  generatedAt: new Date().toISOString(),
  verdict,
  productionChanged: false,
  data: {
    opportunities: results.length,
    snapshotCutoff: SNAPSHOT_CUTOFF,
    firstDecision: iso(firstDecision),
    lastDecision: iso(lastDecision),
    instruments: instruments.length,
    oandaPracticeFallbacks,
    effectiveUtcDays: new Set(results.map((row) => row.decisionTime.slice(0, 10))).size,
    note: "This is the same retrospective 47-pair sample used to investigate inversion. It is development evidence, not untouched forward proof.",
  },
  frozenPolicy: MOMENTUM_BURST_DIRECTION_CONFIG,
  integrity,
  actionCounts,
  baselines: { originalImmediate: baselineOriginal, invertedImmediate: baselineInverted },
  delayedPolicy: {
    selectedConditional: policySelected,
    exactOppositeConditional: policyOpposite,
    selectedOpportunityAdjusted: policyOpportunityAdjusted,
    exactOppositeOpportunityAdjusted: oppositeOpportunityAdjusted,
    selectedMinusOppositePaired: policyMinusOpposite,
    averageConfidence: mean(usableSelected.map((row) => row.confidence)),
  },
  positionAwareMomentumOnly: {
    accepted: positionAwareAccepted.length,
    overlapping: positionAwareOverlapping.length,
    selected: positionAwareSelected,
    exactOppositeOnSelectedSchedule: positionAwareOpposite,
    selectedMinusOppositePaired: positionAwareDifference,
    limitation: "Models one open Momentum position per instrument, but not positions opened by other strategy families.",
  },
  byAction,
  byChosenDirection,
  byInstrument,
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT,
  frozenBeforeResults: true,
  dataset: { source: "momentum_inversion_arms", expectedOpportunities: EXPECTED_OPPORTUNITIES, snapshotCutoff: SNAPSHOT_CUTOFF },
  marketDataFallback: "Read-only OANDA Practice bid/ask candles when the rolling live snapshot is absent from local research tables.",
  policy: MOMENTUM_BURST_DIRECTION_CONFIG,
  execution: "Next M15 bar open after confirmation, executable bid/ask, original absolute stop/target distances preserved for selected and exact-opposite arms.",
  outcome: "Production labelOutcome; same-day 16:45 ET forced exit; same-bar stop+target is conservative ambiguous=-1R.",
  promotion: "NONE. Retrospective development sample only; production remains untouched.",
}, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, "results.jsonl"), `${results.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.writeFileSync(path.join(OUTPUT_DIR, "RESULTS.json"), JSON.stringify(report, null, 2));

const lines = [
  "GOLDENXPERIENCE — MOMENTUM BURST DIRECTION RECORDED-47 V1",
  `Generated: ${report.generatedAt}`,
  "RESEARCH ONLY — production/practice execution unchanged",
  "",
  `VERDICT: ${verdict}`,
  "",
  "DATA",
  `Opportunities: ${results.length} across ${report.data.effectiveUtcDays} UTC days and ${instruments.length} instruments`,
  `Window: ${report.data.firstDecision} .. ${report.data.lastDecision}`,
  "The 47 are retrospective development evidence, not an untouched forward holdout.",
  "",
  "ACTION FUNNEL",
  `FOLLOW ${actionCounts.follow} | REVERSE ${actionCounts.reverse} | WAIT ${actionCounts.wait} | traded ${usableSelected.length}/${results.length}`,
  `Average confirmation confidence on traded decisions: ${format(report.delayedPolicy.averageConfidence, 1)}/100`,
  "",
  "IMMEDIATE CONTROLS — ALL 47",
  `Original  n=${baselineOriginal.n} WR=${percent(baselineOriginal.winRate)} netE=${format(baselineOriginal.netExpectancyR)} totalR=${format(baselineOriginal.totalR, 2)} CI95=[${format(baselineOriginal.ci95[0])}, ${format(baselineOriginal.ci95[1])}]`,
  `Inverted  n=${baselineInverted.n} WR=${percent(baselineInverted.winRate)} netE=${format(baselineInverted.netExpectancyR)} totalR=${format(baselineInverted.totalR, 2)} CI95=[${format(baselineInverted.ci95[0])}, ${format(baselineInverted.ci95[1])}]`,
  "",
  "DELAYED POLICY — TRADED DECISIONS ONLY",
  `Selected       n=${policySelected.n} WR=${percent(policySelected.winRate)} netE=${format(policySelected.netExpectancyR)} totalR=${format(policySelected.totalR, 2)} CI95=[${format(policySelected.ci95[0])}, ${format(policySelected.ci95[1])}]`,
  `Exact opposite n=${policyOpposite.n} WR=${percent(policyOpposite.winRate)} netE=${format(policyOpposite.netExpectancyR)} totalR=${format(policyOpposite.totalR, 2)} CI95=[${format(policyOpposite.ci95[0])}, ${format(policyOpposite.ci95[1])}]`,
  `Paired selected-opposite improvement: ${format(policyMinusOpposite.netExpectancyR)}R CI95=[${format(policyMinusOpposite.ci95[0])}, ${format(policyMinusOpposite.ci95[1])}]`,
  "",
  "POSITION-AWARE MOMENTUM-ONLY SCHEDULE",
  `Accepted ${positionAwareAccepted.length} | overlapping ${positionAwareOverlapping.length}`,
  `Selected       n=${positionAwareSelected.n} netE=${format(positionAwareSelected.netExpectancyR)} totalR=${format(positionAwareSelected.totalR, 2)} CI95=[${format(positionAwareSelected.ci95[0])}, ${format(positionAwareSelected.ci95[1])}]`,
  `Exact opposite n=${positionAwareOpposite.n} netE=${format(positionAwareOpposite.netExpectancyR)} totalR=${format(positionAwareOpposite.totalR, 2)} CI95=[${format(positionAwareOpposite.ci95[0])}, ${format(positionAwareOpposite.ci95[1])}]`,
  `Paired improvement=${format(positionAwareDifference.netExpectancyR)}R CI95=[${format(positionAwareDifference.ci95[0])}, ${format(positionAwareDifference.ci95[1])}]`,
  "Does not model positions opened by EMA, Breakout, MeanRev, or legacy strategies.",
  "",
  "OPPORTUNITY-ADJUSTED — WAIT = 0R ACROSS ALL 47",
  `Selected policy netE/opportunity=${format(policyOpportunityAdjusted.netExpectancyR)} totalR=${format(policyOpportunityAdjusted.totalR, 2)}`,
  `Exact opposite netE/opportunity=${format(oppositeOpportunityAdjusted.netExpectancyR)} totalR=${format(oppositeOpportunityAdjusted.totalR, 2)}`,
  "",
  "BY ACTION",
  `FOLLOW selected n=${byAction.follow.selected.n} netE=${format(byAction.follow.selected.netExpectancyR)} | opposite netE=${format(byAction.follow.opposite.netExpectancyR)}`,
  `REVERSE selected n=${byAction.reverse.selected.n} netE=${format(byAction.reverse.selected.netExpectancyR)} | opposite netE=${format(byAction.reverse.opposite.netExpectancyR)}`,
  "",
  "INTEGRITY",
  JSON.stringify(integrity),
  "Both delayed arms enter at the same time, use their own executable side of the book, preserve identical absolute stop/target distances, and pay spread.",
  "No parameter sweep was performed after viewing results.",
];
fs.writeFileSync(path.join(OUTPUT_DIR, "FINAL_REPORT.txt"), `${lines.join("\n")}\n`);

console.log(lines.join("\n"));
