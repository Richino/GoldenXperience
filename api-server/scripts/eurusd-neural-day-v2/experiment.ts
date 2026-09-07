/**
 * EUR/USD neural day engine V2.
 *
 * V2 fixes V1's objective mismatch and stale-direction problem:
 * - a pairwise direction head learns which executable side has the better R;
 * - a calibrated quality head learns the selected side's realized outcome;
 * - both heads retrain every six months using only data available beforehand;
 * - coverage is calibrated from past score distributions, never a trade quota.
 *
 * V1 and frozen V19 artifacts are read-only inputs to the diagnostic report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, trainNeuralModel, type Architecture, type NeuralModel, type Sample } from "../eurusd-neural-day-v1/model.js";
import {
  FEATURE_NAMES,
  buildCandidates,
  fitRegimes,
  loadBars,
  loadNewsTimes,
  marketDays,
  nearestNewsMinutes,
  prepareSeries,
  rawFeatures,
  regimeOf,
  regimeVector,
  resolveOutcome,
  rowsIn,
  summarize,
  type Bar,
  type Candidate,
  type Direction,
  type Outcome,
  type Trade,
} from "../eurusd-neural-day-v1/experiment.js";

export type QualityLabel = "TARGET" | "POSITIVE_R";
export type RiskPolicy = "STATIC" | "BREAKEVEN_050" | "BREAKEVEN_075" | "BREAKEVEN_100";
export type Config = {
  name: string;
  directionArchitecture: Architecture;
  qualityArchitecture: Architecture;
  qualityLabel: QualityLabel;
  lookbackMonths: number;
  entryMinuteOffset: 0 | 15;
  ensembleSize: number;
};
export type Heads = { direction: NeuralModel[]; quality: NeuralModel[] };
export type AdaptiveScore = Candidate & {
  direction: Direction;
  directionConfidence: number;
  qualityProbability: number;
  rankScore: number;
  threshold: number;
  fold: string;
};
type GridRow = {
  config: Config;
  coverage: number;
  minimumDirectionConfidence: number;
  riskPolicy: RiskPolicy;
  trades: Trade[];
  summary: ReturnType<typeof summarize>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v2");
const PIP = 0.0001;
const WARMUP = 240;
const MAX_HOLD_BARS = 12;
const MAX_SPREAD_ATR = 0.35;
const NEWS_BLACKOUT_MINUTES = 60;
const MAX_TRADES_PER_DAY = 3;
const ENTRY_SLIPPAGE_PIPS = 0.1;
const STOP_ATR = 1.25;
const MIN_STOP_PIPS = 4;
const CALIBRATION_MONTHS = 6;
const RETRAIN_MONTHS = 6;

export const DEVELOPMENT = { from: Date.parse("2024-08-01T00:00:00Z"), to: Date.parse("2025-08-01T00:00:00Z") };
export const VALIDATION = { from: Date.parse("2025-08-01T00:00:00Z"), to: Date.parse("2026-08-01T00:00:00Z") };

const LOGISTIC: Architecture = { name: "logistic", hidden1: 0, hidden2: 0 };
const MLP16: Architecture = { name: "mlp-16", hidden1: 16, hidden2: 0 };
const CONFIGS: Config[] = [
  ...([0, 15] as const).flatMap((entryMinuteOffset) => [
    { name: `pairwise-logistic-target-m${entryMinuteOffset}`, directionArchitecture: LOGISTIC, qualityArchitecture: LOGISTIC, qualityLabel: "TARGET" as const, lookbackMonths: 48, entryMinuteOffset, ensembleSize: 1 },
    { name: `pairwise-mlp-target-m${entryMinuteOffset}`, directionArchitecture: MLP16, qualityArchitecture: MLP16, qualityLabel: "TARGET" as const, lookbackMonths: 48, entryMinuteOffset, ensembleSize: 1 },
    { name: `pairwise-mlp-positive-r-m${entryMinuteOffset}`, directionArchitecture: MLP16, qualityArchitecture: MLP16, qualityLabel: "POSITIVE_R" as const, lookbackMonths: 48, entryMinuteOffset, ensembleSize: 1 },
    { name: `pairwise-mlp-target-30m-m${entryMinuteOffset}`, directionArchitecture: MLP16, qualityArchitecture: MLP16, qualityLabel: "TARGET" as const, lookbackMonths: 30, entryMinuteOffset, ensembleSize: 1 },
  ]),
  { name: "pairwise-mlp-target-ensemble3-m15", directionArchitecture: MLP16, qualityArchitecture: MLP16, qualityLabel: "TARGET", lookbackMonths: 48, entryMinuteOffset: 15, ensembleSize: 3 },
  { name: "pairwise-mlp-positive-r-ensemble3-m15", directionArchitecture: MLP16, qualityArchitecture: MLP16, qualityLabel: "POSITIVE_R", lookbackMonths: 48, entryMinuteOffset: 15, ensembleSize: 3 },
];
const COVERAGES = [0.03, 0.05, 0.08, 0.12, 0.18];
const DIRECTION_CONFIDENCES = [0.05, 0.15, 0.25];
const RISK_POLICIES: RiskPolicy[] = ["STATIC", "BREAKEVEN_050", "BREAKEVEN_075", "BREAKEVEN_100"];

function addUtcMonths(time: number, months: number) {
  const date = new Date(time);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return Infinity;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))))]!;
}

function directionSamples(candidates: Candidate[]): Sample[] {
  const samples: Sample[] = [];
  for (const candidate of candidates) {
    const difference = candidate.longOutcome.r - candidate.shortOutcome.r;
    if (Math.abs(difference) < 0.05) continue;
    samples.push({ x: candidate.longX, y: difference > 0 ? 1 : 0 });
  }
  return samples;
}

function qualitySamples(candidates: Candidate[], label: QualityLabel): Sample[] {
  const samples: Sample[] = [];
  const positive = (candidate: Candidate, direction: Direction) => {
    const outcome = direction === 1 ? candidate.longOutcome : candidate.shortOutcome;
    return label === "TARGET" ? outcome.kind === "TARGET" : outcome.r > 0;
  };
  for (const candidate of candidates) {
    samples.push({ x: candidate.longX, y: positive(candidate, 1) ? 1 : 0 });
    samples.push({ x: candidate.shortX, y: positive(candidate, -1) ? 1 : 0 });
  }
  return samples;
}

export function fitHeads(candidates: Candidate[], config: Config, seed: number): Heads {
  const epochs = (architecture: Architecture) => architecture.hidden1 ? 6 : 9;
  const learningRate = (architecture: Architecture) => architecture.hidden1 ? 0.002 : 0.004;
  const directionRows = directionSamples(candidates);
  const qualityRows = qualitySamples(candidates, config.qualityLabel);
  const direction = Array.from({ length: config.ensembleSize }, (_, member) => trainNeuralModel(directionRows, config.directionArchitecture, {
    seed: seed + member * 104729,
    epochs: epochs(config.directionArchitecture),
    learningRate: learningRate(config.directionArchitecture),
    l2: 0.0005,
    classBalance: false,
  }));
  const quality = Array.from({ length: config.ensembleSize }, (_, member) => trainNeuralModel(qualityRows, config.qualityArchitecture, {
    seed: (seed ^ 0x5f3759df) + member * 130363,
    epochs: epochs(config.qualityArchitecture),
    learningRate: learningRate(config.qualityArchitecture),
    l2: 0.0005,
    classBalance: false,
  }));
  return { direction, quality };
}

export function scoreCandidate(candidate: Candidate, heads: Heads) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const deviation = (values: number[]) => {
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
  };
  const directionVotes = heads.direction.map((model) => predict(model, candidate.longX));
  const pLongBetter = mean(directionVotes);
  const direction: Direction = pLongBetter >= 0.5 ? 1 : -1;
  const directionConfidence = 2 * Math.abs(pLongBetter - 0.5);
  const qualityVotes = heads.quality.map((model) => predict(model, direction === 1 ? candidate.longX : candidate.shortX));
  const qualityProbability = mean(qualityVotes);
  const disagreementPenalty = Math.min(0.5, deviation(directionVotes) + deviation(qualityVotes));
  // Quality drives targetability; direction confidence breaks ties without letting
  // an uncertain directional call masquerade as a high-quality trade.
  const rankScore = qualityProbability * (0.5 + 0.5 * directionConfidence) * (1 - disagreementPenalty);
  return { direction, directionConfidence, qualityProbability, rankScore };
}

export function isMarketEligible(candidate: Candidate) {
  return candidate.spreadAtr <= MAX_SPREAD_ATR
    && (candidate.newsDistanceMinutes == null || candidate.newsDistanceMinutes > NEWS_BLACKOUT_MINUTES);
}

export function buildCorrectedCandidates(
  bars: Bar[],
  series: ReturnType<typeof prepareSeries>,
  centroids: number[][],
  newsTimes: number[],
  entryMinuteOffset: 0 | 15,
) {
  const candidates: Candidate[] = [];
  for (let index = WARMUP; index < bars.length - MAX_HOLD_BARS - 2; index += 1) {
    const decision = bars[index]!;
    // closeTime is the end of decision candle and exactly the open time of the
    // following entry candle. V1 incorrectly gated and recorded entry.t.
    const actualEntryTime = decision.t;
    const date = new Date(actualEntryTime);
    const hour = date.getUTCHours();
    if (date.getUTCMinutes() % 30 !== entryMinuteOffset || hour < 6 || hour >= 16) continue;
    const atr = series.atr14[index]!;
    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(series.atr56[index]!)) continue;
    const regime = regimeOf(regimeVector(bars, series, index), centroids);
    const raw = rawFeatures(bars, series, index, regime);
    if (!raw) continue;
    const entry = bars[index + 1]!;
    candidates.push({
      index,
      time: actualEntryTime,
      iso: new Date(actualEntryTime).toISOString(),
      day: new Date(actualEntryTime).toISOString().slice(0, 10),
      spreadAtr: (entry.askOpen - entry.bidOpen) / atr,
      newsDistanceMinutes: nearestNewsMinutes(newsTimes, actualEntryTime),
      longX: raw,
      shortX: raw.map((value, featureIndex) => featureIndex < 20 ? -value : value),
      longOutcome: resolveOutcome(bars, series, index, 1),
      shortOutcome: resolveOutcome(bars, series, index, -1),
    });
  }
  return candidates;
}

function managedOutcome(
  candidate: Candidate,
  direction: Direction,
  riskPolicy: RiskPolicy,
  bars: Bar[],
  series: ReturnType<typeof prepareSeries>,
): Outcome {
  if (riskPolicy === "STATIC") return direction === 1 ? candidate.longOutcome : candidate.shortOutcome;
  const activation = riskPolicy === "BREAKEVEN_050" ? 0.5 : riskPolicy === "BREAKEVEN_075" ? 0.75 : 1;
  const entryIndex = candidate.index + 1;
  const stopDistance = Math.max(STOP_ATR * series.atr14[candidate.index]!, MIN_STOP_PIPS * PIP);
  const entrySlip = ENTRY_SLIPPAGE_PIPS * PIP;
  const exitCostR = 0.75 * 0.1 * PIP / stopDistance;
  const entryBar = bars[entryIndex]!;
  const entry = direction === 1 ? entryBar.askOpen + entrySlip : entryBar.bidOpen - entrySlip;
  const originalStop = direction === 1 ? entry - stopDistance : entry + stopDistance;
  const target = direction === 1 ? entry + 2 * stopDistance : entry - 2 * stopDistance;
  let breakevenActive = false;
  let exitIndex = entryIndex;
  for (let cursor = entryIndex; cursor <= Math.min(entryIndex + MAX_HOLD_BARS - 1, bars.length - 1); cursor += 1) {
    exitIndex = cursor;
    const bar = bars[cursor]!;
    const high = direction === 1 ? bar.bidHigh : bar.askHigh;
    const low = direction === 1 ? bar.bidLow : bar.askLow;
    const targetHit = direction === 1 ? high >= target : low <= target;
    const activeStop = breakevenActive ? entry : originalStop;
    const activeStopHit = direction === 1 ? low <= activeStop : high >= activeStop;
    // Without tick order, a bar touching target and the active stop is charged
    // to the active stop. Once breakeven is active, the original stop no longer
    // exists and must not be charged as a full loss.
    if (activeStopHit && !breakevenActive) {
      return { kind: "STOP", r: -0.75 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - candidate.time) / 60_000 };
    }
    if (activeStopHit) {
      return { kind: "BREAKEVEN", r: -exitCostR, exitTime: bar.t, holdMinutes: (bar.t - candidate.time) / 60_000 };
    }
    if (targetHit) {
      return { kind: "TARGET", r: 1.5 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - candidate.time) / 60_000 };
    }
    const activationHit = direction === 1 ? high >= entry + activation * stopDistance : low <= entry - activation * stopDistance;
    if (activationHit) breakevenActive = true;
  }
  const exitBar = bars[exitIndex]!;
  const exit = direction === 1 ? exitBar.bidClose - 0.1 * PIP : exitBar.askClose + 0.1 * PIP;
  const move = direction === 1 ? exit - entry : entry - exit;
  const result = Math.max(-0.75 - exitCostR, Math.min(1.5 - exitCostR, 0.75 * move / stopDistance));
  return { kind: "TIME_EXIT", r: result, exitTime: exitBar.t, holdMinutes: (exitBar.t - candidate.time) / 60_000 };
}

function adaptiveScores(candidates: Candidate[], period: { from: number; to: number }, config: Config) {
  const output: AdaptiveScore[] = [];
  let foldIndex = 0;
  for (let foldStart = period.from; foldStart < period.to; foldStart = addUtcMonths(foldStart, RETRAIN_MONTHS)) {
    const foldEnd = Math.min(period.to, addUtcMonths(foldStart, RETRAIN_MONTHS));
    const trainFrom = Math.max(Date.parse("2020-01-01T00:00:00Z"), addUtcMonths(foldStart, -config.lookbackMonths));
    const training = rowsIn(candidates, { from: trainFrom, to: foldStart });
    const calibration = rowsIn(candidates, { from: addUtcMonths(foldStart, -CALIBRATION_MONTHS), to: foldStart });
    const evaluation = rowsIn(candidates, { from: foldStart, to: foldEnd });
    const heads = fitHeads(training, config, 0x2f6e2b1 + foldIndex * 997 + config.name.length * 31);
    const calibrationScores = calibration.filter(isMarketEligible).map((candidate) => scoreCandidate(candidate, heads));
    const fold = `${new Date(foldStart).toISOString().slice(0, 10)}..${new Date(foldEnd).toISOString().slice(0, 10)}`;
    for (const coverage of COVERAGES) {
      const threshold = percentile(calibrationScores.map((row) => row.rankScore), 1 - coverage);
      for (const candidate of evaluation) {
        const score = scoreCandidate(candidate, heads);
        output.push({ ...candidate, ...score, threshold, fold: `${fold}|${coverage}` });
      }
    }
    foldIndex += 1;
  }
  return output;
}

function replayAdaptive(
  scores: AdaptiveScore[],
  coverage: number,
  minimumDirectionConfidence: number,
  riskPolicy: RiskPolicy,
  bars: Bar[],
  series: ReturnType<typeof prepareSeries>,
): Trade[] {
  const trades: Trade[] = [];
  const perDay = new Map<string, number>();
  let lockedUntil = -Infinity;
  const rows = scores.filter((row) => row.fold.endsWith(`|${coverage}`)).sort((left, right) => left.time - right.time);
  for (const row of rows) {
    if (!isMarketEligible(row) || row.rankScore < row.threshold || row.directionConfidence < minimumDirectionConfidence) continue;
    if (row.time < lockedUntil || (perDay.get(row.day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    const outcome = managedOutcome(row, row.direction, riskPolicy, bars, series);
    trades.push({
      entryTime: row.iso,
      exitTime: new Date(outcome.exitTime).toISOString(),
      direction: row.direction === 1 ? "LONG" : "SHORT",
      score: row.qualityProbability,
      margin: row.directionConfidence,
      resultR: outcome.r,
      outcome: outcome.kind,
      holdMinutes: outcome.holdMinutes,
      spreadAtr: row.spreadAtr,
      newsDistanceMinutes: row.newsDistanceMinutes,
    });
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
    lockedUntil = outcome.exitTime;
  }
  return trades;
}

function standardError(trades: Trade[]) {
  if (trades.length < 2) return Infinity;
  const mean = trades.reduce((sum, trade) => sum + trade.resultR, 0) / trades.length;
  const variance = trades.reduce((sum, trade) => sum + (trade.resultR - mean) ** 2, 0) / (trades.length - 1);
  return Math.sqrt(variance / trades.length);
}

function selectGrid(rows: GridRow[]) {
  const stablePositive = rows.filter((row) => row.trades.length >= 60
    && row.summary.expectancyR > 0
    && row.summary.profitFactor > 1
    && row.summary.positiveMonths >= Math.ceil(row.summary.months * 0.55));
  const eligible = rows.filter((row) => row.trades.length >= 60);
  const pool = stablePositive.length ? stablePositive : eligible.length ? eligible : rows;
  return [...pool].sort((left, right) => {
    const leftRobust = left.summary.expectancyR - 0.5 * standardError(left.trades);
    const rightRobust = right.summary.expectancyR - 0.5 * standardError(right.trades);
    return rightRobust - leftRobust || right.summary.profitFactor - left.summary.profitFactor;
  })[0]!;
}

export function buildRegimes(bars: Bar[]) {
  const series = prepareSeries(bars);
  const indices: number[] = [];
  for (let index = WARMUP; index < bars.length - MAX_HOLD_BARS - 2; index += 8) {
    const time = bars[index]!.t;
    if (time >= Date.parse("2020-01-01T00:00:00Z") && time < Date.parse("2023-01-01T00:00:00Z")) {
      const vector = regimeVector(bars, series, index);
      if (vector.every(Number.isFinite)) indices.push(index);
    }
  }
  return { series, centroids: fitRegimes(indices.map((index) => regimeVector(bars, series, index))) };
}

function v1LossDiagnostic(candidates: Candidate[], bars: Bar[]) {
  const series = prepareSeries(bars);
  const candidateByTime = new Map(candidates.map((candidate) => [candidate.iso, candidate]));
  const periods = ["development", "validation"] as const;
  const result: Record<string, unknown> = {};
  for (const period of periods) {
    const file = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v1", `TRADES.${period}.json`);
    const trades = JSON.parse(readFileSync(file, "utf8")) as Trade[];
    const losses = trades.filter((trade) => trade.resultR < 0);
    let oppositeTarget = 0;
    let oppositePositive = 0;
    let bothSidesStop = 0;
    let lowMfe = 0;
    let halfRMfe = 0;
    let totalMfe = 0;
    let totalChase = 0;
    for (const trade of losses) {
      const candidate = candidateByTime.get(trade.entryTime)!;
      const direction: Direction = trade.direction === "LONG" ? 1 : -1;
      const opposite = direction === 1 ? candidate.shortOutcome : candidate.longOutcome;
      if (opposite.kind === "TARGET") oppositeTarget += 1;
      if (opposite.r > 0) oppositePositive += 1;
      if ((candidate.longOutcome.kind === "STOP" || candidate.longOutcome.kind === "AMBIGUOUS_STOP")
        && (candidate.shortOutcome.kind === "STOP" || candidate.shortOutcome.kind === "AMBIGUOUS_STOP")) bothSidesStop += 1;

      const entryIndex = candidate.index + 1;
      const stopDistance = Math.max(STOP_ATR * series.atr14[candidate.index]!, MIN_STOP_PIPS * PIP);
      const entryBar = bars[entryIndex]!;
      const entry = direction === 1 ? entryBar.askOpen + ENTRY_SLIPPAGE_PIPS * PIP : entryBar.bidOpen - ENTRY_SLIPPAGE_PIPS * PIP;
      let mfe = 0;
      for (let cursor = entryIndex; cursor < bars.length && bars[cursor]!.t <= Date.parse(trade.exitTime); cursor += 1) {
        const favorable = direction === 1 ? bars[cursor]!.bidHigh - entry : entry - bars[cursor]!.askLow;
        mfe = Math.max(mfe, favorable / stopDistance);
      }
      totalMfe += mfe;
      if (mfe < 0.25) lowMfe += 1;
      if (mfe >= 0.5) halfRMfe += 1;
      totalChase += candidate.longX[FEATURE_NAMES.indexOf("chase_distance")]!;
    }
    result[period] = {
      trades: trades.length,
      losses: losses.length,
      oppositeTarget,
      oppositeTargetShareOfLosses: oppositeTarget / Math.max(1, losses.length),
      oppositePositive,
      bothSidesStop,
      bothSidesStopShareOfLosses: bothSidesStop / Math.max(1, losses.length),
      lowMfeBelow025R: lowMfe,
      lowMfeShareOfLosses: lowMfe / Math.max(1, losses.length),
      reachedHalfRBeforeLosing: halfRMfe,
      reachedHalfRShareOfLosses: halfRMfe / Math.max(1, losses.length),
      averageMfeR: totalMfe / Math.max(1, losses.length),
      averageChaseAtr: totalChase / Math.max(1, losses.length),
    };
  }
  return result;
}

function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rounded(child)]));
  return value;
}

function writeFindings(report: any) {
  const dev = report.results.development;
  const validation = report.results.validation;
  const diagnosis = report.v1LossDiagnosis;
  const markdown = `# EUR/USD Neural Day Engine V2\n\nVerdict: **${report.verdict}**\n\n## What V1 got wrong\n\n- V1 optimized a class-balanced target-hit classifier, not realized expectancy. Its scores were therefore rankings, not calibrated trade probabilities.\n- V1 froze direction weights before August 2024; V2 retrains every six months using only earlier candles.\n- V1 chose direction indirectly from two side scores. V2 has a separate pairwise direction head trained to choose the side with better executable R.\n- V1 gated and recorded the following candle's close time while executing at its open; V2 aligns signal time, news distance, and next-open execution correctly.\n- Development losses: ${diagnosis.development.oppositeTarget}/${diagnosis.development.losses} would have hit target in the opposite direction; ${diagnosis.development.bothSidesStop}/${diagnosis.development.losses} stopped on both sides; ${diagnosis.development.lowMfeBelow025R}/${diagnosis.development.losses} never reached +0.25R first.\n- Validation losses: ${diagnosis.validation.oppositeTarget}/${diagnosis.validation.losses} would have hit target in the opposite direction; ${diagnosis.validation.bothSidesStop}/${diagnosis.validation.losses} stopped on both sides; ${diagnosis.validation.lowMfeBelow025R}/${diagnosis.validation.losses} never reached +0.25R first.\n\n## Selected V2\n\n- Configuration: **${report.selection.config}**\n- Coverage: **${(report.selection.coverage * 100).toFixed(0)}%** of past-calibrated opportunities\n- Minimum pairwise direction confidence: **${(report.selection.minimumDirectionConfidence * 100).toFixed(0)}%**\n- Risk policy: **${report.selection.riskPolicy}**\n- Selection used development robust expectancy, not validation.\n\n## Results\n\n| Engine / period | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | Profit factor | Total R | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| V1 development | ${report.baseline.development.trades} | ${report.baseline.development.tradesPerMarketDay.toFixed(3)} | ${(report.baseline.development.targetWinRate * 100).toFixed(2)}% | ${(report.baseline.development.profitableRate * 100).toFixed(2)}% | ${report.baseline.development.expectancyR.toFixed(3)}R | ${report.baseline.development.profitFactor.toFixed(3)} | ${report.baseline.development.totalR.toFixed(2)}R | ${report.baseline.development.maxDrawdownR.toFixed(2)}R |\n| V2 development | ${dev.trades} | ${dev.tradesPerMarketDay.toFixed(3)} | ${(dev.targetWinRate * 100).toFixed(2)}% | ${(dev.profitableRate * 100).toFixed(2)}% | ${dev.expectancyR.toFixed(3)}R | ${dev.profitFactor.toFixed(3)} | ${dev.totalR.toFixed(2)}R | ${dev.maxDrawdownR.toFixed(2)}R |\n| V1 validation | ${report.baseline.validation.trades} | ${report.baseline.validation.tradesPerMarketDay.toFixed(3)} | ${(report.baseline.validation.targetWinRate * 100).toFixed(2)}% | ${(report.baseline.validation.profitableRate * 100).toFixed(2)}% | ${report.baseline.validation.expectancyR.toFixed(3)}R | ${report.baseline.validation.profitFactor.toFixed(3)} | ${report.baseline.validation.totalR.toFixed(2)}R | ${report.baseline.validation.maxDrawdownR.toFixed(2)}R |\n| V2 validation | ${validation.trades} | ${validation.tradesPerMarketDay.toFixed(3)} | ${(validation.targetWinRate * 100).toFixed(2)}% | ${(validation.profitableRate * 100).toFixed(2)}% | ${validation.expectancyR.toFixed(3)}R | ${validation.profitFactor.toFixed(3)} | ${validation.totalR.toFixed(2)}R | ${validation.maxDrawdownR.toFixed(2)}R |\n\n## Conclusion\n\n${report.interpretation}\n`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), markdown);
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Loading EUR/USD candles and building executable candidates...");
  const bars = loadBars();
  const news = loadNewsTimes();
  const { series, centroids } = buildRegimes(bars);
  const legacyCandidates = buildCandidates(bars, series, centroids, news);
  const candidatesByOffset = new Map<0 | 15, Candidate[]>([
    [0, buildCorrectedCandidates(bars, series, centroids, news, 0)],
    [15, buildCorrectedCandidates(bars, series, centroids, news, 15)],
  ]);
  const developmentRows = rowsIn(candidatesByOffset.get(0)!, DEVELOPMENT);
  const validationRows = rowsIn(candidatesByOffset.get(0)!, VALIDATION);
  const developmentDays = marketDays(developmentRows);
  const validationDays = marketDays(validationRows);

  const scoredByConfig = new Map<string, AdaptiveScore[]>();
  const grid: GridRow[] = [];
  for (const config of CONFIGS) {
    console.log(`Walk-forward development: ${config.name}`);
    const candidates = candidatesByOffset.get(config.entryMinuteOffset)!;
    const scores = adaptiveScores(candidates, DEVELOPMENT, config);
    scoredByConfig.set(config.name, scores);
    for (const coverage of COVERAGES) {
      for (const minimumDirectionConfidence of DIRECTION_CONFIDENCES) {
        for (const riskPolicy of RISK_POLICIES) {
          const trades = replayAdaptive(scores, coverage, minimumDirectionConfidence, riskPolicy, bars, series);
          grid.push({ config, coverage, minimumDirectionConfidence, riskPolicy, trades, summary: summarize(trades, developmentDays) });
        }
      }
    }
  }
  const selected = selectGrid(grid);
  console.log(`Selected ${selected.config.name}, coverage=${selected.coverage}, directionConfidence=${selected.minimumDirectionConfidence}, risk=${selected.riskPolicy}`);
  console.log("Running chronological validation with the frozen selection...");
  const selectedCandidates = candidatesByOffset.get(selected.config.entryMinuteOffset)!;
  const validationScores = adaptiveScores(selectedCandidates, VALIDATION, selected.config);
  const validationTrades = replayAdaptive(validationScores, selected.coverage, selected.minimumDirectionConfidence, selected.riskPolicy, bars, series);
  const validationSummary = summarize(validationTrades, validationDays);
  const developmentSummary = selected.summary;

  const v1 = JSON.parse(readFileSync(path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v1", "RESULTS.json"), "utf8"));
  const validationImproved = validationSummary.expectancyR > v1.results.validation.expectancyR;
  const validationPositive = validationSummary.expectancyR > 0 && validationSummary.profitFactor > 1;
  const verdict = validationPositive ? "POSITIVE_WALK_FORWARD_VALIDATION_RESEARCH_ONLY" : validationImproved ? "IMPROVED_BUT_STILL_NEGATIVE" : "NO_VALIDATION_IMPROVEMENT";
  const interpretation = validationPositive
    ? "The objective and adaptive-direction fixes produced positive historical walk-forward validation after executable costs. This is a research result, not authorization for paper or live deployment."
    : validationImproved
      ? "V2 reduced the validation loss, but it did not produce a positive edge. The objective mismatch was real, yet direction and setup quality remain insufficient."
      : "The redesigned objective did not improve validation. The neural signal itself is not discriminating profitable EUR/USD day entries strongly enough.";

  const report = rounded({
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: { v19Modified: false, v1ArtifactsOverwritten: false, productionOrPaperBehaviorChanged: false },
    protocol: {
      instrument: "EUR_USD",
      timeframe: "M15 decisions every 30 minutes",
      evaluation: "six-month walk-forward folds; heads retrained on trailing past-only data",
      execution: "next M15 open with historical bid/ask, 0.1 pip entry and exit slippage, same-bar ambiguity charged as stop",
      stopAndTarget: "1.25 ATR stop, 2.0 stop-distance target, payoff +1.5R/-0.75R, 180-minute maximum hold",
      news: "high-impact EUR/USD blackout plus/minus 60 minutes",
      concurrency: "one open trade, maximum three per day, no forced quota",
    },
    diagnosisMethod: "Each V1 loss was joined to its original executable long/short counterfactual and reconstructed bid/ask MFE path.",
    v1LossDiagnosis: v1LossDiagnostic(legacyCandidates, bars),
    selection: {
      config: selected.config.name,
      coverage: selected.coverage,
      minimumDirectionConfidence: selected.minimumDirectionConfidence,
      riskPolicy: selected.riskPolicy,
      objective: "stable positive development first (minimum 60 trades, positive expectancy, PF above 1, at least 55% positive months), then robust expectancy",
      candidates: grid.map((row) => ({
        config: row.config.name,
        coverage: row.coverage,
        minimumDirectionConfidence: row.minimumDirectionConfidence,
        riskPolicy: row.riskPolicy,
        ...row.summary,
      })),
    },
    baseline: { development: v1.results.development, validation: v1.results.validation },
    results: { development: developmentSummary, validation: validationSummary },
    interpretation,
  }) as any;
  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.development.json"), JSON.stringify(selected.trades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.validation.json"), JSON.stringify(validationTrades, null, 2));
  writeFindings(report);
  console.log(JSON.stringify({
    verdict,
    selection: {
      config: report.selection.config,
      coverage: report.selection.coverage,
      minimumDirectionConfidence: report.selection.minimumDirectionConfidence,
      riskPolicy: report.selection.riskPolicy,
    },
    development: report.results.development,
    validation: report.results.validation,
  }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
