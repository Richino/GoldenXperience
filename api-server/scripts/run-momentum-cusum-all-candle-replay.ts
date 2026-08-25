/**
 * All-candle Momentum CUSUM replay — research only.
 *
 * Fetches completed OANDA Practice M1 bid/ask candles without persisting them,
 * scans every eligible candle, compares fresh CUSUM direction, pullback-confirmed
 * direction, and exact inversions, then calibrates confidence chronologically.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
process.env.NODE_ENV = "production";

const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const {
  MOMENTUM_CUSUM_CONFIG,
  calibratedWinProbability,
  detectMomentumCusumPullback,
  fitSigmoidCalibration,
  invertMomentumCusumDirection,
  scanMomentumCusumIgnitions,
} = await import("../src/momentum-cusum-pullback.js");
import type {
  MomentumCusumBar,
  MomentumCusumDirection,
  MomentumCusumIgnition,
  MomentumCusumPullbackDecision,
  SigmoidCalibration,
} from "../src/momentum-cusum-pullback.js";

const EXPERIMENT = "momentum-cusum-all-candle-v1";
const INSTRUMENTS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const DATA_START = "2025-12-20T00:00:00.000Z";
const DECISION_START = "2026-01-01T00:00:00.000Z";
const CALIBRATION_END = "2026-06-01T00:00:00.000Z";
const REPLAY_END = "2026-08-01T00:00:00.000Z";
const M1_MS = 60_000;
const M5_MS = 5 * M1_MS;
const OUTCOME_BARS = 12 * 60;
const IMMEDIATE_STOP_M5_ATR = 0.35;
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT);
const PIP_SIZE: Record<Instrument, number> = { EUR_USD: 0.0001, GBP_USD: 0.0001, USD_JPY: 0.01 };

type Instrument = (typeof INSTRUMENTS)[number];
type OandaCandle = Awaited<ReturnType<typeof getResearchCandles>>[number];

interface QuoteBar extends MomentumCusumBar {
  bidOpen: number;
  bidHigh: number;
  bidLow: number;
  bidClose: number;
  askOpen: number;
  askHigh: number;
  askLow: number;
  askClose: number;
}

interface SimulatedArm {
  direction: MomentumCusumDirection;
  entryAt: string;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  spreadCostR: number;
  outcome: "target_first" | "stop_first" | "ambiguous" | "timed_out";
  resultR: number;
  maxFavorableR: number;
  maxAdverseR: number;
  resolvedAt: string | null;
  horizonEndsAt: string;
}

interface SignalRow {
  instrument: Instrument;
  ignitionAt: string;
  ignitionIndex: number;
  ignitionDirection: MomentumCusumDirection;
  returnZ: number;
  cusumMagnitude: number;
  impulseM5Atr: number;
  immediateRawScore: number;
  immediate: SimulatedArm | null;
  immediateInverse: SimulatedArm | null;
  pullbackAction: "trade" | "wait";
  waitReason: string | null;
  pullbackKnownAt: string | null;
  pullbackBars: number | null;
  retracementFraction: number | null;
  structureRoomR: number | null;
  pullbackActivityRatio: number | null;
  liquidSession: boolean | null;
  pullbackRawScore: number | null;
  confidenceScore: number | null;
  pullback: SimulatedArm | null;
  pullbackInverse: SimulatedArm | null;
}

type MetricObservation = { r: number; ms: number; won: boolean };

function midpoint(bid: number, ask: number): number { return (bid + ask) / 2; }
function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }
function mean(values: readonly number[]): number { return values.length ? values.reduce((total, value) => total + value, 0) / values.length : Number.NaN; }
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function format(value: number | null, digits = 4): string { return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits); }
function percent(value: number | null): string { return value === null || !Number.isFinite(value) ? "n/a" : `${(100 * value).toFixed(1)}%`; }
function percentile(sorted: readonly number[], fraction: number): number { return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)))]!; }

function toQuoteBar(candle: OandaCandle): QuoteBar {
  const closeTime = new Date(Date.parse(candle.time) + M1_MS).toISOString();
  return {
    closeTime,
    open: midpoint(candle.bid.open, candle.ask.open),
    high: midpoint(candle.bid.high, candle.ask.high),
    low: midpoint(candle.bid.low, candle.ask.low),
    close: midpoint(candle.bid.close, candle.ask.close),
    volume: candle.volume,
    bidOpen: candle.bid.open,
    bidHigh: candle.bid.high,
    bidLow: candle.bid.low,
    bidClose: candle.bid.close,
    askOpen: candle.ask.open,
    askHigh: candle.ask.high,
    askLow: candle.ask.low,
    askClose: candle.ask.close,
  };
}

async function fetchM1Range(instrument: Instrument): Promise<QuoteBar[]> {
  const startMs = Date.parse(DATA_START);
  const endMs = Date.parse(REPLAY_END);
  const byTime = new Map<string, QuoteBar>();
  let cursor = endMs;
  let previousOldest = Number.POSITIVE_INFINITY;
  let page = 0;
  while (true) {
    const candles = (await getResearchCandles(instrument, "M1", 5_000, { to: new Date(cursor).toISOString() })).filter((item) => item.complete);
    if (!candles.length) throw new Error(`OANDA returned no completed M1 candles for ${instrument} before ${new Date(cursor).toISOString()}.`);
    const oldest = Math.min(...candles.map((item) => Date.parse(item.time)));
    if (oldest >= previousOldest) throw new Error(`OANDA M1 pagination did not move backward for ${instrument}.`);
    previousOldest = oldest;
    for (const candle of candles) {
      const at = Date.parse(candle.time);
      if (at >= startMs && at < endMs) {
        const bar = toQuoteBar(candle);
        byTime.set(bar.closeTime, bar);
      }
    }
    page += 1;
    if (page % 10 === 0) console.log(`[${instrument}] fetched ${byTime.size.toLocaleString()} in-range M1 candles (${page} pages)`);
    if (oldest <= startMs) break;
    cursor = oldest - 1;
  }
  const bars = [...byTime.values()].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
  console.log(`[${instrument}] completed M1 range: ${bars.length.toLocaleString()} bars`);
  return bars;
}

function aggregateM5(bars: readonly QuoteBar[]): MomentumCusumBar[] {
  const groups = new Map<number, QuoteBar[]>();
  for (const bar of bars) {
    const start = Date.parse(bar.closeTime) - M1_MS;
    const bucket = Math.floor(start / M5_MS) * M5_MS;
    const group = groups.get(bucket) ?? [];
    group.push(bar);
    groups.set(bucket, group);
  }
  const result: MomentumCusumBar[] = [];
  for (const [bucket, unsorted] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const group = [...unsorted].sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
    const expected = Array.from({ length: 5 }, (_, index) => bucket + (index + 1) * M1_MS);
    if (group.length !== 5 || !group.every((bar, index) => Date.parse(bar.closeTime) === expected[index])) continue;
    result.push({
      closeTime: new Date(bucket + M5_MS).toISOString(),
      open: group[0]!.open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group[4]!.close,
      volume: sum(group.map((bar) => bar.volume ?? 0)),
    });
  }
  return result;
}

function atrValues(bars: readonly MomentumCusumBar[], period = 14): Array<number | null> {
  const result: Array<number | null> = Array.from({ length: bars.length }, () => null);
  const ranges: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const previous = bars[index - 1]!;
    const gap = Date.parse(bar.closeTime) - Date.parse(previous.closeTime);
    if (gap !== M5_MS) {
      ranges.length = 0;
      continue;
    }
    ranges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)));
    if (ranges.length > period) ranges.shift();
    if (ranges.length === period) result[index] = mean(ranges);
  }
  return result;
}

function pointInTimeM5Atr(bars: readonly QuoteBar[]): Array<number | null> {
  const m5 = aggregateM5(bars);
  const atr = atrValues(m5);
  const result: Array<number | null> = [];
  let m5Index = -1;
  for (const bar of bars) {
    const at = Date.parse(bar.closeTime);
    while (m5Index + 1 < m5.length && Date.parse(m5[m5Index + 1]!.closeTime) <= at) m5Index += 1;
    result.push(m5Index >= 0 ? atr[m5Index]! : null);
  }
  return result;
}

function simulateArm(
  bars: readonly QuoteBar[],
  entryIndex: number,
  direction: MomentumCusumDirection,
  riskDistance: number,
): SimulatedArm | null {
  const entryBar = bars[entryIndex];
  if (!entryBar || !(riskDistance > 0) || !Number.isFinite(riskDistance)) return null;
  const entry = direction === "long" ? entryBar.askOpen : entryBar.bidOpen;
  const stop = direction === "long" ? entry - riskDistance : entry + riskDistance;
  const target = direction === "long" ? entry + riskDistance * MOMENTUM_CUSUM_CONFIG.targetR : entry - riskDistance * MOMENTUM_CUSUM_CONFIG.targetR;
  const spreadCostR = (entryBar.askOpen - entryBar.bidOpen) / riskDistance;
  let maxFavorableR = Number.NEGATIVE_INFINITY;
  let maxAdverseR = Number.NEGATIVE_INFINITY;
  const lastIndex = Math.min(bars.length - 1, entryIndex + OUTCOME_BARS - 1);
  let last = entryBar;
  for (let index = entryIndex; index <= lastIndex; index += 1) {
    const bar = bars[index]!;
    last = bar;
    const favorable = direction === "long" ? (bar.bidHigh - entry) / riskDistance : (entry - bar.askLow) / riskDistance;
    const adverse = direction === "long" ? (entry - bar.bidLow) / riskDistance : (bar.askHigh - entry) / riskDistance;
    maxFavorableR = Math.max(maxFavorableR, favorable);
    maxAdverseR = Math.max(maxAdverseR, adverse);
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return { direction, entryAt: new Date(Date.parse(entryBar.closeTime) - M1_MS).toISOString(), entry, stop, target, risk: riskDistance, spreadCostR, outcome: "ambiguous", resultR: -1, maxFavorableR, maxAdverseR, resolvedAt: bar.closeTime, horizonEndsAt: bar.closeTime };
    if (targetHit) return { direction, entryAt: new Date(Date.parse(entryBar.closeTime) - M1_MS).toISOString(), entry, stop, target, risk: riskDistance, spreadCostR, outcome: "target_first", resultR: MOMENTUM_CUSUM_CONFIG.targetR, maxFavorableR, maxAdverseR, resolvedAt: bar.closeTime, horizonEndsAt: bar.closeTime };
    if (stopHit) return { direction, entryAt: new Date(Date.parse(entryBar.closeTime) - M1_MS).toISOString(), entry, stop, target, risk: riskDistance, spreadCostR, outcome: "stop_first", resultR: -1, maxFavorableR, maxAdverseR, resolvedAt: bar.closeTime, horizonEndsAt: bar.closeTime };
  }
  const resultR = direction === "long" ? (last.bidClose - entry) / riskDistance : (entry - last.askClose) / riskDistance;
  return {
    direction,
    entryAt: new Date(Date.parse(entryBar.closeTime) - M1_MS).toISOString(),
    entry,
    stop,
    target,
    risk: riskDistance,
    spreadCostR,
    outcome: "timed_out",
    resultR,
    maxFavorableR,
    maxAdverseR,
    resolvedAt: null,
    horizonEndsAt: last.closeTime,
  };
}

function immediateRawScore(ignition: MomentumCusumIgnition): number {
  const thresholdExcess = clamp((ignition.cusumMagnitude - MOMENTUM_CUSUM_CONFIG.cusumThreshold) / MOMENTUM_CUSUM_CONFIG.cusumThreshold, 0, 1);
  const impulse = clamp((ignition.impulseM5Atr - MOMENTUM_CUSUM_CONFIG.minImpulseM5Atr) / (MOMENTUM_CUSUM_CONFIG.maxImpulseM5Atr - MOMENTUM_CUSUM_CONFIG.minImpulseM5Atr), 0, 1);
  return 100 * (0.6 * thresholdExcess + 0.4 * impulse);
}

function rowForIgnition(instrument: Instrument, bars: readonly QuoteBar[], ignition: MomentumCusumIgnition): SignalRow {
  const immediateEntryIndex = ignition.index + 1;
  const immediateRisk = ignition.referenceM5Atr * IMMEDIATE_STOP_M5_ATR;
  const immediate = simulateArm(bars, immediateEntryIndex, ignition.direction, immediateRisk);
  const immediateInverse = simulateArm(bars, immediateEntryIndex, invertMomentumCusumDirection(ignition.direction), immediateRisk);
  const decision: MomentumCusumPullbackDecision = detectMomentumCusumPullback({ bars, ignition });
  let pullback: SimulatedArm | null = null;
  let pullbackInverse: SimulatedArm | null = null;
  if (decision.action === "trade" && decision.entryIndex !== null && decision.stop !== null) {
    const entryBar = bars[decision.entryIndex]!;
    const selectedEntry = ignition.direction === "long" ? entryBar.askOpen : entryBar.bidOpen;
    const risk = Math.abs(selectedEntry - decision.stop);
    pullback = simulateArm(bars, decision.entryIndex, ignition.direction, risk);
    pullbackInverse = simulateArm(bars, decision.entryIndex, invertMomentumCusumDirection(ignition.direction), risk);
  }
  return {
    instrument,
    ignitionAt: ignition.knownAt,
    ignitionIndex: ignition.index,
    ignitionDirection: ignition.direction,
    returnZ: ignition.returnZ,
    cusumMagnitude: ignition.cusumMagnitude,
    impulseM5Atr: ignition.impulseM5Atr,
    immediateRawScore: immediateRawScore(ignition),
    immediate,
    immediateInverse,
    pullbackAction: decision.action,
    waitReason: decision.action === "wait" ? decision.reason : null,
    pullbackKnownAt: decision.knownAt,
    pullbackBars: decision.pullbackBars,
    retracementFraction: decision.retracementFraction,
    structureRoomR: decision.structureRoomR,
    pullbackActivityRatio: decision.pullbackActivityRatio,
    liquidSession: decision.liquidSession,
    pullbackRawScore: decision.action === "trade" ? decision.rawScore : null,
    confidenceScore: null,
    pullback,
    pullbackInverse,
  };
}

function dayBlockBootstrap(rows: readonly MetricObservation[], trials = 4_000, seed = 20260825) {
  if (!rows.length) return { low: null, high: null, effectiveDays: 0 };
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

function metrics(rows: readonly MetricObservation[]) {
  if (!rows.length) return { n: 0, wins: 0, targetWinRate: null, expectancyR: null, totalR: 0, profitFactor: null, ci95: [null, null] as [number | null, number | null], effectiveDays: 0 };
  const returns = rows.map((row) => row.r);
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  const loss = Math.abs(sum(negative));
  const ci = dayBlockBootstrap(rows);
  return {
    n: rows.length,
    wins: rows.filter((row) => row.won).length,
    targetWinRate: rows.filter((row) => row.won).length / rows.length,
    expectancyR: mean(returns),
    totalR: sum(returns),
    profitFactor: loss > 0 ? sum(positive) / loss : sum(positive) > 0 ? Number.POSITIVE_INFINITY : null,
    ci95: [ci.low, ci.high] as [number | null, number | null],
    effectiveDays: ci.effectiveDays,
  };
}

function observations(rows: readonly SignalRow[], arm: (row: SignalRow) => SimulatedArm | null): MetricObservation[] {
  return rows.flatMap((row) => {
    const value = arm(row);
    return value ? [{ r: value.resultR, ms: Date.parse(value.entryAt), won: value.outcome === "target_first" }] : [];
  });
}

function pairedObservations(rows: readonly SignalRow[], left: (row: SignalRow) => SimulatedArm | null, right: (row: SignalRow) => SimulatedArm | null): MetricObservation[] {
  return rows.flatMap((row) => {
    const a = left(row);
    const b = right(row);
    return a && b ? [{ r: a.resultR - b.resultR, ms: Date.parse(a.entryAt), won: a.resultR > b.resultR }] : [];
  });
}

function positionAware(rows: readonly SignalRow[], arm: (row: SignalRow) => SimulatedArm | null): SignalRow[] {
  const accepted: SignalRow[] = [];
  const activeUntil = new Map<Instrument, number>();
  for (const row of [...rows].sort((a, b) => Date.parse(arm(a)?.entryAt ?? a.ignitionAt) - Date.parse(arm(b)?.entryAt ?? b.ignitionAt))) {
    const value = arm(row);
    if (!value) continue;
    const entryAt = Date.parse(value.entryAt);
    if (entryAt < (activeUntil.get(row.instrument) ?? Number.NEGATIVE_INFINITY)) continue;
    accepted.push(row);
    activeUntil.set(row.instrument, Date.parse(value.resolvedAt ?? value.horizonEndsAt));
  }
  return accepted;
}

function confidenceDiagnostics(rows: readonly SignalRow[], calibration: SigmoidCalibration | null) {
  const usable = rows.filter((row) => row.pullback && row.pullbackRawScore !== null && calibratedWinProbability(calibration, row.pullbackRawScore) !== null);
  const bins = [[0, 0.30], [0.30, 0.35], [0.35, 0.40], [0.40, 0.50], [0.50, 1.000001]] as const;
  const details = bins.map(([low, high]) => {
    const selected = usable.filter((row) => {
      const probability = calibratedWinProbability(calibration, row.pullbackRawScore!)!;
      return probability >= low && probability < high;
    });
    return {
      range: `${Math.round(low * 100)}-${Math.round(Math.min(1, high) * 100)}%`,
      n: selected.length,
      averageForecast: selected.length ? mean(selected.map((row) => calibratedWinProbability(calibration, row.pullbackRawScore!)!)) : null,
      observedTargetRate: selected.length ? selected.filter((row) => row.pullback!.outcome === "target_first").length / selected.length : null,
      expectancyR: selected.length ? mean(selected.map((row) => row.pullback!.resultR)) : null,
    };
  });
  const brier = usable.length ? mean(usable.map((row) => {
    const probability = calibratedWinProbability(calibration, row.pullbackRawScore!)!;
    const outcome = row.pullback!.outcome === "target_first" ? 1 : 0;
    return (probability - outcome) ** 2;
  })) : null;
  return { n: usable.length, brier, bins: details };
}

function descriptiveStats(values: readonly number[]) {
  return values.length ? { n: values.length, average: mean(values), minimum: Math.min(...values), maximum: Math.max(...values) } : { n: 0, average: null, minimum: null, maximum: null };
}

function executionDiagnostics(rows: readonly SignalRow[]) {
  const qualified = rows.filter((row) => row.pullback);
  return {
    n: qualified.length,
    outcomes: Object.fromEntries([...new Set(qualified.map((row) => row.pullback!.outcome))].map((outcome) => [outcome, qualified.filter((row) => row.pullback!.outcome === outcome).length])),
    riskPips: descriptiveStats(qualified.map((row) => row.pullback!.risk / PIP_SIZE[row.instrument])),
    spreadCostR: descriptiveStats(qualified.map((row) => row.pullback!.spreadCostR)),
    maxFavorableR: descriptiveStats(qualified.map((row) => row.pullback!.maxFavorableR)),
    maxAdverseR: descriptiveStats(qualified.map((row) => row.pullback!.maxAdverseR)),
    stoppedInEntryMinute: qualified.filter((row) => row.pullback!.outcome === "stop_first" && row.pullback!.resolvedAt !== null && Date.parse(row.pullback!.resolvedAt!) - Date.parse(row.pullback!.entryAt) <= M1_MS).length,
  };
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({
  experiment: EXPERIMENT,
  frozenBeforeResults: true,
  generatedAt: new Date().toISOString(),
  productionChanged: false,
  databaseWrites: false,
  universe: INSTRUMENTS,
  data: { source: "OANDA Practice completed M1 midpoint plus bid/ask candles", dataStart: DATA_START, decisionStart: DECISION_START, calibrationEnd: CALIBRATION_END, replayEnd: REPLAY_END },
  detector: MOMENTUM_CUSUM_CONFIG,
  execution: { entry: "next M1 open after known signal", immediateStopM5Atr: IMMEDIATE_STOP_M5_ATR, pullbackStop: "beyond pullback using selected executable entry", targetR: MOMENTUM_CUSUM_CONFIG.targetR, horizonBars: OUTCOME_BARS, ambiguous: "conservative -1R", inverse: "same entry time and absolute risk/target distances on executable opposite side" },
  confidence: { fit: "one-dimensional L2 sigmoid on raw score", fitWindow: `${DECISION_START}..${CALIBRATION_END}`, evaluationWindow: `${CALIBRATION_END}..${REPLAY_END}`, event: "2R target before stop", minimumSamples: MOMENTUM_CUSUM_CONFIG.calibrationMinimumSamples },
  promotion: "NONE. Research-only implementation and replay; production/practice execution remains untouched.",
}, null, 2));

const allRows: SignalRow[] = [];
const integrity = { fetchedBars: 0, duplicateCloseTimes: 0, nonFiniteQuotes: 0, ignitions: 0, immediatePairs: 0, pullbackPairs: 0, missingNextOpen: 0 };
for (const instrument of INSTRUMENTS) {
  const bars = await fetchM1Range(instrument);
  integrity.fetchedBars += bars.length;
  integrity.duplicateCloseTimes += bars.length - new Set(bars.map((bar) => bar.closeTime)).size;
  integrity.nonFiniteQuotes += bars.filter((bar) => ![bar.open, bar.high, bar.low, bar.close, bar.bidOpen, bar.bidHigh, bar.bidLow, bar.bidClose, bar.askOpen, bar.askHigh, bar.askLow, bar.askClose].every(Number.isFinite)).length;
  const references = pointInTimeM5Atr(bars);
  const ignitions = scanMomentumCusumIgnitions({ bars, referenceM5AtrByIndex: references }).filter((item) => item.knownAt >= DECISION_START && item.knownAt < REPLAY_END);
  integrity.ignitions += ignitions.length;
  console.log(`[${instrument}] ${ignitions.length.toLocaleString()} frozen CUSUM ignitions; evaluating pullbacks and matched outcomes`);
  for (const ignition of ignitions) {
    const row = rowForIgnition(instrument, bars, ignition);
    if (row.immediate && row.immediateInverse) integrity.immediatePairs += 1; else integrity.missingNextOpen += 1;
    if (row.pullback && row.pullbackInverse) integrity.pullbackPairs += 1;
    allRows.push(row);
  }
}

const developmentRows = allRows.filter((row) => row.ignitionAt < CALIBRATION_END);
const holdoutRows = allRows.filter((row) => row.ignitionAt >= CALIBRATION_END);
const calibrationSamples = developmentRows.flatMap((row) => row.pullback && row.pullbackRawScore !== null
  ? [{ rawScore: row.pullbackRawScore, won: row.pullback.outcome === "target_first" }]
  : []);
const calibration = fitSigmoidCalibration(calibrationSamples);
for (const row of allRows) {
  const probability = row.pullbackRawScore === null ? null : calibratedWinProbability(calibration, row.pullbackRawScore);
  row.confidenceScore = probability === null ? null : Math.round(probability * 1_000) / 10;
}

function splitReport(rows: readonly SignalRow[]) {
  const pullbackRows = rows.filter((row) => row.pullback && row.pullbackInverse);
  const scheduled = positionAware(pullbackRows, (row) => row.pullback);
  return {
    opportunities: rows.length,
    immediate: metrics(observations(rows, (row) => row.immediate)),
    immediateInverse: metrics(observations(rows, (row) => row.immediateInverse)),
    immediateMinusInverse: metrics(pairedObservations(rows, (row) => row.immediate, (row) => row.immediateInverse)),
    pullbackSignals: pullbackRows.length,
    pullback: metrics(observations(pullbackRows, (row) => row.pullback)),
    pullbackInverse: metrics(observations(pullbackRows, (row) => row.pullbackInverse)),
    pullbackMinusInverse: metrics(pairedObservations(pullbackRows, (row) => row.pullback, (row) => row.pullbackInverse)),
    positionAware: { accepted: scheduled.length, skippedOverlaps: pullbackRows.length - scheduled.length, selected: metrics(observations(scheduled, (row) => row.pullback)), inverseOnSelectedSchedule: metrics(observations(scheduled, (row) => row.pullbackInverse)) },
  };
}

const development = splitReport(developmentRows);
const holdout = splitReport(holdoutRows);
const holdoutConfidence = confidenceDiagnostics(holdoutRows, calibration);
const execution = { development: executionDiagnostics(developmentRows), holdout: executionDiagnostics(holdoutRows) };
const waitReasonCounts = Object.fromEntries([...new Set(allRows.flatMap((row) => row.waitReason ? [row.waitReason] : []))]
  .map((reason) => [reason, allRows.filter((row) => row.waitReason === reason).length])
  .sort((a, b) => Number(b[1]) - Number(a[1])));
const byInstrument = Object.fromEntries(INSTRUMENTS.map((instrument) => {
  const rows = holdoutRows.filter((row) => row.instrument === instrument);
  return [instrument, splitReport(rows)];
}));
const byMonth = Object.fromEntries([...new Set(holdoutRows.map((row) => row.ignitionAt.slice(0, 7)))].map((month) => {
  const rows = holdoutRows.filter((row) => row.ignitionAt.startsWith(month));
  return [month, splitReport(rows)];
}));

const pairedLow = holdout.pullbackMinusInverse.ci95[0];
const verdict = holdout.positionAware.accepted < 50 ? "INSUFFICIENT_HOLDOUT_TRADES"
  : holdout.positionAware.selected.expectancyR !== null && holdout.positionAware.selected.expectancyR > 0 && pairedLow !== null && pairedLow > 0 ? "HOLDOUT_DIRECTION_EDGE_CANDIDATE"
    : holdout.positionAware.selected.expectancyR !== null && holdout.positionAware.selected.expectancyR > 0 ? "POSITIVE_HOLDOUT_POINT_ESTIMATE_NOT_CONFIRMED"
      : "NO_HOLDOUT_EDGE";

const report = {
  experiment: EXPERIMENT,
  generatedAt: new Date().toISOString(),
  verdict,
  productionChanged: false,
  databaseWrites: false,
  frozenConfig: MOMENTUM_CUSUM_CONFIG,
  data: { instruments: INSTRUMENTS, dataStart: DATA_START, decisionStart: DECISION_START, calibrationEnd: CALIBRATION_END, replayEnd: REPLAY_END, integrity },
  calibration: calibration ? { ...calibration, event: "2R target before stop", holdout: holdoutConfidence } : { available: false, sampleCount: calibrationSamples.length, minimumRequired: MOMENTUM_CUSUM_CONFIG.calibrationMinimumSamples },
  development,
  holdout,
  execution,
  byInstrument,
  byMonth,
  waitReasonCounts,
  limitations: [
    "This is the first chronological holdout for this frozen CUSUM detector, but the 2026 market period is not globally untouched by every prior GoldenXperience experiment.",
    "OANDA candle volume counts broker price activity, not centralized buyer/seller transaction flow; activity affects raw ranking only and is not an eligibility gate.",
    "The OANDA stream/candles cannot reproduce the EBS buyer- versus seller-initiated order-flow variable from the published studies.",
    "One open Momentum position per instrument is modeled for the position-aware result; other strategy families are not included.",
    "No parameter sweep or post-result tuning was performed.",
  ],
};

const qualifiedTrades = allRows.filter((row) => row.pullback && row.pullbackInverse);
fs.writeFileSync(path.join(OUTPUT_DIR, "trades.jsonl"), `${qualifiedTrades.map((row) => JSON.stringify(row)).join("\n")}\n`);
fs.writeFileSync(path.join(OUTPUT_DIR, "RESULTS.json"), JSON.stringify(report, null, 2));

const lines = [
  "GOLDENXPERIENCE — MOMENTUM CUSUM ALL-CANDLE V1",
  `Generated: ${report.generatedAt}`,
  "RESEARCH ONLY — production/practice execution unchanged; database unchanged",
  "",
  `VERDICT: ${verdict}`,
  "",
  "DATA",
  `${integrity.fetchedBars.toLocaleString()} completed OANDA Practice M1 bid/ask candles across ${INSTRUMENTS.length} instruments`,
  `Decisions: ${DECISION_START} .. ${REPLAY_END}`,
  `Calibration/dev: ${DECISION_START} .. ${CALIBRATION_END}`,
  `Chronological holdout: ${CALIBRATION_END} .. ${REPLAY_END}`,
  `Ignitions ${integrity.ignitions} | immediate matched pairs ${integrity.immediatePairs} | pullback matched pairs ${integrity.pullbackPairs}`,
  "",
  "DEVELOPMENT — JANUARY THROUGH MAY",
  `Immediate selected n=${development.immediate.n} targetWR=${percent(development.immediate.targetWinRate)} E=${format(development.immediate.expectancyR)} total=${format(development.immediate.totalR, 2)}R CI95=[${format(development.immediate.ci95[0])}, ${format(development.immediate.ci95[1])}]`,
  `Immediate inverse  n=${development.immediateInverse.n} targetWR=${percent(development.immediateInverse.targetWinRate)} E=${format(development.immediateInverse.expectancyR)} total=${format(development.immediateInverse.totalR, 2)}R`,
  `Pullback selected n=${development.pullback.n} targetWR=${percent(development.pullback.targetWinRate)} E=${format(development.pullback.expectancyR)} total=${format(development.pullback.totalR, 2)}R CI95=[${format(development.pullback.ci95[0])}, ${format(development.pullback.ci95[1])}]`,
  `Pullback inverse  n=${development.pullbackInverse.n} targetWR=${percent(development.pullbackInverse.targetWinRate)} E=${format(development.pullbackInverse.expectancyR)} total=${format(development.pullbackInverse.totalR, 2)}R`,
  "",
  "CHRONOLOGICAL HOLDOUT — JUNE AND JULY",
  `Immediate selected n=${holdout.immediate.n} targetWR=${percent(holdout.immediate.targetWinRate)} E=${format(holdout.immediate.expectancyR)} total=${format(holdout.immediate.totalR, 2)}R CI95=[${format(holdout.immediate.ci95[0])}, ${format(holdout.immediate.ci95[1])}]`,
  `Immediate inverse  n=${holdout.immediateInverse.n} targetWR=${percent(holdout.immediateInverse.targetWinRate)} E=${format(holdout.immediateInverse.expectancyR)} total=${format(holdout.immediateInverse.totalR, 2)}R`,
  `Immediate direction improvement=${format(holdout.immediateMinusInverse.expectancyR)}R CI95=[${format(holdout.immediateMinusInverse.ci95[0])}, ${format(holdout.immediateMinusInverse.ci95[1])}]`,
  `Pullback selected n=${holdout.pullback.n} targetWR=${percent(holdout.pullback.targetWinRate)} E=${format(holdout.pullback.expectancyR)} total=${format(holdout.pullback.totalR, 2)}R CI95=[${format(holdout.pullback.ci95[0])}, ${format(holdout.pullback.ci95[1])}]`,
  `Pullback inverse  n=${holdout.pullbackInverse.n} targetWR=${percent(holdout.pullbackInverse.targetWinRate)} E=${format(holdout.pullbackInverse.expectancyR)} total=${format(holdout.pullbackInverse.totalR, 2)}R`,
  `Pullback direction improvement=${format(holdout.pullbackMinusInverse.expectancyR)}R CI95=[${format(holdout.pullbackMinusInverse.ci95[0])}, ${format(holdout.pullbackMinusInverse.ci95[1])}]`,
  "",
  "POSITION-AWARE HOLDOUT — ONE MOMENTUM POSITION PER INSTRUMENT",
  `Accepted ${holdout.positionAware.accepted} | overlap-skipped ${holdout.positionAware.skippedOverlaps}`,
  `Selected E=${format(holdout.positionAware.selected.expectancyR)} total=${format(holdout.positionAware.selected.totalR, 2)}R targetWR=${percent(holdout.positionAware.selected.targetWinRate)} CI95=[${format(holdout.positionAware.selected.ci95[0])}, ${format(holdout.positionAware.selected.ci95[1])}]`,
  `Inverse  E=${format(holdout.positionAware.inverseOnSelectedSchedule.expectancyR)} total=${format(holdout.positionAware.inverseOnSelectedSchedule.totalR, 2)}R targetWR=${percent(holdout.positionAware.inverseOnSelectedSchedule.targetWinRate)}`,
  "",
  "EXECUTION DIAGNOSTICS — WHY THE QUALIFIED PATTERN LOST",
  `Development risk=${format(execution.development.riskPips.average, 2)} pips avg | spread=${format(execution.development.spreadCostR.average, 3)}R avg | MFE=${format(execution.development.maxFavorableR.average, 3)}R | MAE=${format(execution.development.maxAdverseR.average, 3)}R | entry-minute stops=${execution.development.stoppedInEntryMinute}`,
  `Holdout risk=${format(execution.holdout.riskPips.average, 2)} pips avg | spread=${format(execution.holdout.spreadCostR.average, 3)}R avg | MFE=${format(execution.holdout.maxFavorableR.average, 3)}R | MAE=${format(execution.holdout.maxAdverseR.average, 3)}R | entry-minute stops=${execution.holdout.stoppedInEntryMinute}`,
  `Holdout outcomes=${JSON.stringify(execution.holdout.outcomes)}`,
  "",
  "CONFIDENCE CALIBRATION",
  calibration
    ? `Fitted on ${calibration.sampleCount} development signals (${calibration.positives} target hits); slope=${calibration.slope.toFixed(4)}. Holdout Brier=${format(holdoutConfidence.brier)} across ${holdoutConfidence.n} signals.`
    : `Unavailable: ${calibrationSamples.length} development signals; ${MOMENTUM_CUSUM_CONFIG.calibrationMinimumSamples} required.`,
  ...(calibration ? holdoutConfidence.bins.map((bin) => `${bin.range}: n=${bin.n} forecast=${percent(bin.averageForecast)} observed=${percent(bin.observedTargetRate)} E=${format(bin.expectancyR)}`) : []),
  "",
  "TOP WAIT REASONS",
  ...Object.entries(waitReasonCounts).slice(0, 8).map(([reason, count]) => `${count} — ${reason}`),
  "",
  "INTEGRITY",
  JSON.stringify(integrity),
  "Every selected/inverse pair uses the same entry time and absolute risk/target distances on executable bid/ask sides.",
  "No database writes, production imports, parameter sweep, or post-result tuning.",
  "",
  "LIMITATIONS",
  ...report.limitations.map((item) => `- ${item}`),
];
fs.writeFileSync(path.join(OUTPUT_DIR, "FINAL_REPORT.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
