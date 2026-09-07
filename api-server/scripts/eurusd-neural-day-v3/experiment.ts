/**
 * EUR/USD neural day engine V3: three-class opportunity gate.
 *
 * The gate classifies each pre-entry state as:
 *   ONE_SIDED   - one executable side has a usable path;
 *   WHIPSAW     - both executable sides stop;
 *   INSUFFICIENT- neither side provides a clean target path.
 *
 * Only after the opportunity gate passes does the frozen V2 pairwise model
 * choose direction. Every fold trains on earlier data and enters at the next
 * M15 open with historical bid/ask, slippage, and the V2 news blackout.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, trainNeuralModel, type Architecture, type NeuralModel, type Sample } from "../eurusd-neural-day-v1/model.js";
import {
  loadBars,
  loadNewsTimes,
  marketDays,
  rowsIn,
  summarize,
  type Bar,
  type Candidate,
  type Direction,
  type Trade,
} from "../eurusd-neural-day-v1/experiment.js";
import {
  DEVELOPMENT,
  VALIDATION,
  buildCorrectedCandidates,
  buildRegimes,
  fitHeads,
  isMarketEligible,
  scoreCandidate,
  type Config as V2Config,
} from "../eurusd-neural-day-v2/experiment.js";

type OpportunityClass = "ONE_SIDED" | "WHIPSAW" | "INSUFFICIENT";
type LabelMode = "STRICT_TARGET" | "EXECUTABLE_ASYMMETRY";
type GateConfig = {
  name: string;
  architecture: Architecture;
  labelMode: LabelMode;
};
type GateModels = Record<OpportunityClass, NeuralModel>;
type GatedCandidate = Candidate & {
  direction: Direction;
  directionConfidence: number;
  qualityProbability: number;
  rankScore: number;
  baseThreshold: number;
  gateScore: number;
  oneSidedProbability: number;
  whipsawProbability: number;
  insufficientProbability: number;
  gateThreshold: number;
  fold: string;
  retention: number;
};
type GridRow = {
  config: GateConfig;
  retention: number;
  trades: Trade[];
  summary: ReturnType<typeof summarize>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v3");
const MLP16: Architecture = { name: "mlp-16", hidden1: 16, hidden2: 0 };
const LOGISTIC: Architecture = { name: "logistic", hidden1: 0, hidden2: 0 };
const ENTRY_MINUTE_OFFSET = 15;
const BASE_COVERAGE = 0.03;
const MIN_DIRECTION_CONFIDENCE = 0.05;
const LOOKBACK_MONTHS = 48;
const CALIBRATION_MONTHS = 6;
const RETRAIN_MONTHS = 6;
const MAX_TRADES_PER_DAY = 3;
const RETENTIONS = [0.25, 0.4, 0.55, 0.7, 0.85, 1];

const V2_CONFIG: V2Config = {
  name: "pairwise-mlp-positive-r-m15",
  directionArchitecture: MLP16,
  qualityArchitecture: MLP16,
  qualityLabel: "POSITIVE_R",
  lookbackMonths: LOOKBACK_MONTHS,
  entryMinuteOffset: ENTRY_MINUTE_OFFSET,
  ensembleSize: 1,
};

const GATE_CONFIGS: GateConfig[] = [
  { name: "logistic-strict-target", architecture: LOGISTIC, labelMode: "STRICT_TARGET" },
  { name: "mlp-strict-target", architecture: MLP16, labelMode: "STRICT_TARGET" },
  { name: "logistic-executable-asymmetry", architecture: LOGISTIC, labelMode: "EXECUTABLE_ASYMMETRY" },
  { name: "mlp-executable-asymmetry", architecture: MLP16, labelMode: "EXECUTABLE_ASYMMETRY" },
];

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

function stopped(candidate: Candidate, direction: Direction) {
  const kind = direction === 1 ? candidate.longOutcome.kind : candidate.shortOutcome.kind;
  return kind === "STOP" || kind === "AMBIGUOUS_STOP";
}

function opportunityClass(candidate: Candidate, mode: LabelMode): OpportunityClass {
  if (stopped(candidate, 1) && stopped(candidate, -1)) return "WHIPSAW";
  if (mode === "STRICT_TARGET") {
    const longTarget = candidate.longOutcome.kind === "TARGET";
    const shortTarget = candidate.shortOutcome.kind === "TARGET";
    return longTarget !== shortTarget ? "ONE_SIDED" : "INSUFFICIENT";
  }
  const longPositive = candidate.longOutcome.r > 0;
  const shortPositive = candidate.shortOutcome.r > 0;
  const separated = Math.abs(candidate.longOutcome.r - candidate.shortOutcome.r) >= 0.5;
  return longPositive !== shortPositive && separated ? "ONE_SIDED" : "INSUFFICIENT";
}

function opportunityFeatures(candidate: Candidate) {
  // Make the gate direction-invariant. Direction belongs to the downstream head.
  return candidate.longX.map((value, index) => index < 20 ? Math.abs(value) : value);
}

function classSamples(candidates: Candidate[], mode: LabelMode, target: OpportunityClass): Sample[] {
  return candidates.map((candidate) => ({
    x: opportunityFeatures(candidate),
    y: opportunityClass(candidate, mode) === target ? 1 : 0,
  }));
}

function fitGate(candidates: Candidate[], config: GateConfig, seed: number): GateModels {
  const epochs = config.architecture.hidden1 ? 7 : 10;
  const learningRate = config.architecture.hidden1 ? 0.002 : 0.004;
  const train = (target: OpportunityClass, offset: number) => trainNeuralModel(
    classSamples(candidates, config.labelMode, target),
    config.architecture,
    { seed: seed + offset, epochs, learningRate, l2: 0.0007, classBalance: false },
  );
  return {
    ONE_SIDED: train("ONE_SIDED", 101),
    WHIPSAW: train("WHIPSAW", 211),
    INSUFFICIENT: train("INSUFFICIENT", 307),
  };
}

function logit(probability: number) {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, probability));
  return Math.log(p / (1 - p));
}

function gateProbabilities(candidate: Candidate, models: GateModels) {
  const x = opportunityFeatures(candidate);
  const logits = [
    logit(predict(models.ONE_SIDED, x)),
    logit(predict(models.WHIPSAW, x)),
    logit(predict(models.INSUFFICIENT, x)),
  ];
  const maximum = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - maximum));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const oneSidedProbability = exps[0]! / total;
  const whipsawProbability = exps[1]! / total;
  const insufficientProbability = exps[2]! / total;
  return {
    oneSidedProbability,
    whipsawProbability,
    insufficientProbability,
    gateScore: oneSidedProbability - whipsawProbability,
  };
}

function scorePeriod(
  candidates: Candidate[],
  period: { from: number; to: number },
  gateConfig: GateConfig,
) {
  const output: GatedCandidate[] = [];
  let foldIndex = 0;
  for (let foldStart = period.from; foldStart < period.to; foldStart = addUtcMonths(foldStart, RETRAIN_MONTHS)) {
    const foldEnd = Math.min(period.to, addUtcMonths(foldStart, RETRAIN_MONTHS));
    const training = rowsIn(candidates, { from: addUtcMonths(foldStart, -LOOKBACK_MONTHS), to: foldStart });
    const calibration = rowsIn(candidates, { from: addUtcMonths(foldStart, -CALIBRATION_MONTHS), to: foldStart });
    const baseSeed = 0x2f6e2b1 + foldIndex * 997 + V2_CONFIG.name.length * 31;
    const heads = fitHeads(training, V2_CONFIG, baseSeed);
    const gate = fitGate(training, gateConfig, 0x45d9f3b + foldIndex * 1543 + gateConfig.name.length * 47);

    const scoredCalibration = calibration.filter(isMarketEligible).map((candidate) => ({
      candidate,
      base: scoreCandidate(candidate, heads),
      gate: gateProbabilities(candidate, gate),
    }));
    const baseThreshold = percentile(scoredCalibration.map((row) => row.base.rankScore), 1 - BASE_COVERAGE);
    const baseQualifiedCalibration = scoredCalibration.filter((row) => row.base.rankScore >= baseThreshold
      && row.base.directionConfidence >= MIN_DIRECTION_CONFIDENCE);
    const fold = `${new Date(foldStart).toISOString().slice(0, 10)}..${new Date(foldEnd).toISOString().slice(0, 10)}`;

    for (const retention of RETENTIONS) {
      const gateThreshold = percentile(baseQualifiedCalibration.map((row) => row.gate.gateScore), 1 - retention);
      for (const candidate of rowsIn(candidates, { from: foldStart, to: foldEnd })) {
        const base = scoreCandidate(candidate, heads);
        const gateResult = gateProbabilities(candidate, gate);
        output.push({
          ...candidate,
          ...base,
          ...gateResult,
          baseThreshold,
          gateThreshold,
          fold,
          retention,
        });
      }
    }
    foldIndex += 1;
  }
  return output;
}

function replay(scores: GatedCandidate[], retention: number): Trade[] {
  const rows = scores.filter((row) => row.retention === retention).sort((left, right) => left.time - right.time);
  const trades: Trade[] = [];
  const perDay = new Map<string, number>();
  let lockedUntil = -Infinity;
  for (const row of rows) {
    if (!isMarketEligible(row)
      || row.rankScore < row.baseThreshold
      || row.directionConfidence < MIN_DIRECTION_CONFIDENCE
      || row.gateScore < row.gateThreshold
      || row.time < lockedUntil
      || (perDay.get(row.day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    const outcome = row.direction === 1 ? row.longOutcome : row.shortOutcome;
    trades.push({
      entryTime: row.iso,
      exitTime: new Date(outcome.exitTime).toISOString(),
      direction: row.direction === 1 ? "LONG" : "SHORT",
      score: row.oneSidedProbability,
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
  const average = trades.reduce((sum, trade) => sum + trade.resultR, 0) / trades.length;
  const variance = trades.reduce((sum, trade) => sum + (trade.resultR - average) ** 2, 0) / (trades.length - 1);
  return Math.sqrt(variance / trades.length);
}

function selectGrid(rows: GridRow[], baselineWinRate: number) {
  const qualified = rows.filter((row) => row.summary.trades >= 35
    && row.summary.profitableRate >= Math.max(0.45, baselineWinRate)
    && row.summary.expectancyR > 0
    && row.summary.profitFactor > 1
    && row.summary.positiveMonths >= Math.ceil(row.summary.months * 0.55));
  const adequate = rows.filter((row) => row.summary.trades >= 35);
  const pool = qualified.length ? qualified : adequate.length ? adequate : rows;
  return [...pool].sort((left, right) => {
    const leftScore = left.summary.expectancyR - 0.5 * standardError(left.trades) + 0.15 * left.summary.profitableRate;
    const rightScore = right.summary.expectancyR - 0.5 * standardError(right.trades) + 0.15 * right.summary.profitableRate;
    return qualified.length
      ? right.summary.profitableRate - left.summary.profitableRate || rightScore - leftScore
      : rightScore - leftScore || right.summary.profitFactor - left.summary.profitFactor;
  })[0]!;
}

function actualClassCounts(trades: Trade[], candidateMap: Map<string, Candidate>, mode: LabelMode) {
  const counts: Record<OpportunityClass, number> = { ONE_SIDED: 0, WHIPSAW: 0, INSUFFICIENT: 0 };
  for (const trade of trades) {
    const candidate = candidateMap.get(trade.entryTime);
    if (candidate) counts[opportunityClass(candidate, mode)] += 1;
  }
  return counts;
}

function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rounded(child)]));
  return value;
}

function wilsonInterval(successes: number, total: number, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0 };
  const rate = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (rate + z2 / (2 * total)) / denominator;
  const halfWidth = (z * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total))) / denominator;
  return { lower: Math.max(0, center - halfWidth), upper: Math.min(1, center + halfWidth) };
}

function writeFindings(report: any) {
  const dev = report.results.development;
  const validation = report.results.validation;
  const bDev = report.baseline.development;
  const bVal = report.baseline.validation;
  const interval = report.results.validationProfitableRateWilson95;
  const markdown = `# EUR/USD Neural Day Engine V3 - Three-Class Opportunity Gate\n\nVerdict: **${report.verdict}**\n\n## Gate\n\nBefore direction is considered, a past-only model classifies each setup as one-sided movement, two-sided whipsaw, or insufficient movement. The selected gate is **${report.selection.config}** and retains **${(report.selection.retention * 100).toFixed(0)}%** of V2-qualified opportunities.\n\n## Results\n\n| Period / engine | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | PF | Total R | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| Development V2 | ${bDev.trades} | ${bDev.tradesPerMarketDay.toFixed(3)} | ${(bDev.targetWinRate * 100).toFixed(2)}% | ${(bDev.profitableRate * 100).toFixed(2)}% | ${bDev.expectancyR.toFixed(3)}R | ${bDev.profitFactor.toFixed(3)} | ${bDev.totalR.toFixed(2)}R | ${bDev.maxDrawdownR.toFixed(2)}R |\n| Development V3 | ${dev.trades} | ${dev.tradesPerMarketDay.toFixed(3)} | ${(dev.targetWinRate * 100).toFixed(2)}% | ${(dev.profitableRate * 100).toFixed(2)}% | ${dev.expectancyR.toFixed(3)}R | ${dev.profitFactor.toFixed(3)} | ${dev.totalR.toFixed(2)}R | ${dev.maxDrawdownR.toFixed(2)}R |\n| Validation V2 | ${bVal.trades} | ${bVal.tradesPerMarketDay.toFixed(3)} | ${(bVal.targetWinRate * 100).toFixed(2)}% | ${(bVal.profitableRate * 100).toFixed(2)}% | ${bVal.expectancyR.toFixed(3)}R | ${bVal.profitFactor.toFixed(3)} | ${bVal.totalR.toFixed(2)}R | ${bVal.maxDrawdownR.toFixed(2)}R |\n| Validation V3 | ${validation.trades} | ${validation.tradesPerMarketDay.toFixed(3)} | ${(validation.targetWinRate * 100).toFixed(2)}% | ${(validation.profitableRate * 100).toFixed(2)}% | ${validation.expectancyR.toFixed(3)}R | ${validation.profitFactor.toFixed(3)} | ${validation.totalR.toFixed(2)}R | ${validation.maxDrawdownR.toFixed(2)}R |\n\n## Sample warning\n\nValidation contains only **${validation.trades} trades across ${validation.months} active months**. The 95% Wilson interval for the profitable rate is **${(interval.lower * 100).toFixed(1)}%-${(interval.upper * 100).toFixed(1)}%**. The observed improvement is promising, but the sample is too small to establish a durable edge.\n\n## Interpretation\n\n${report.interpretation}\n`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), markdown);
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Loading EUR/USD history and corrected quarter-hour candidates...");
  const bars = loadBars();
  const news = loadNewsTimes();
  const { series, centroids } = buildRegimes(bars);
  const candidates = buildCorrectedCandidates(bars, series, centroids, news, ENTRY_MINUTE_OFFSET);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.iso, candidate]));
  const v2 = JSON.parse(readFileSync(path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v2", "RESULTS.json"), "utf8"));
  const developmentDays = marketDays(rowsIn(candidates, DEVELOPMENT));
  const validationDays = marketDays(rowsIn(candidates, VALIDATION));

  const grid: GridRow[] = [];
  for (const config of GATE_CONFIGS) {
    console.log(`Development opportunity gate: ${config.name}`);
    const scores = scorePeriod(candidates, DEVELOPMENT, config);
    for (const retention of RETENTIONS) {
      const trades = replay(scores, retention);
      grid.push({ config, retention, trades, summary: summarize(trades, developmentDays) });
    }
  }
  const selected = selectGrid(grid, v2.results.development.profitableRate);
  console.log(`Selected ${selected.config.name}, retention=${selected.retention}`);
  console.log("Running frozen V3 validation...");
  const validationScores = scorePeriod(candidates, VALIDATION, selected.config);
  const validationTrades = replay(validationScores, selected.retention);
  const developmentSummary = selected.summary;
  const validationSummary = summarize(validationTrades, validationDays);

  const winRateImproved = validationSummary.profitableRate > v2.results.validation.profitableRate;
  const expectancyImproved = validationSummary.expectancyR > v2.results.validation.expectancyR;
  const positive = validationSummary.expectancyR > 0 && validationSummary.profitFactor > 1;
  const sampleAdequate = validationSummary.trades >= 35 && validationSummary.months >= 6;
  const verdict = positive && winRateImproved && !sampleAdequate
    ? "PROMISING_SMALL_SAMPLE_UNCERTAIN"
    : positive && winRateImproved
      ? "WIN_RATE_AND_EXPECTANCY_IMPROVED_POSITIVE_RESEARCH_ONLY"
    : winRateImproved && expectancyImproved
      ? "WIN_RATE_AND_EXPECTANCY_IMPROVED_BUT_NOT_POSITIVE"
      : expectancyImproved
        ? "EXPECTANCY_IMPROVED_WIN_RATE_DID_NOT"
        : "NO_VALIDATION_IMPROVEMENT";
  const interpretation = positive && winRateImproved && !sampleAdequate
    ? `The gate improved profitable win rate and produced positive historical validation expectancy after costs, but only ${validationSummary.trades} validation trades occurred across ${validationSummary.months} active months. This is an uncertain small-sample discovery, not a proven edge, and it was not connected to practice or live execution.`
    : positive && winRateImproved
    ? "The gate improved profitable win rate and produced positive historical validation expectancy after costs. It remains research-only and was not connected to practice or live execution."
    : winRateImproved && expectancyImproved
      ? "The gate improved both profitable win rate and expectancy versus V2, but validation expectancy remains below zero. It reduced damage without proving an edge."
      : expectancyImproved
        ? "The gate reduced validation losses, but it did not improve the profitable win rate."
        : "The three-class gate did not reproduce its development improvement on validation.";

  const report = rounded({
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: { v19Modified: false, v1OrV2ArtifactsOverwritten: false, productionOrPaperBehaviorChanged: false },
    protocol: {
      instrument: "EUR_USD",
      entryCadence: "completed M15 decisions at :15/:45, next candle open",
      opportunityClasses: ["ONE_SIDED", "WHIPSAW", "INSUFFICIENT"],
      gatePosition: "before pairwise direction selection",
      retraining: "six-month walk-forward, trailing 48 months, past-only",
      baseCoverage: BASE_COVERAGE,
      minimumDirectionConfidence: MIN_DIRECTION_CONFIDENCE,
      execution: "historical bid/ask, 0.1 pip entry/exit slippage, 1.25 ATR stop, 2x stop target, 180-minute maximum hold",
      newsBlackout: "EUR/USD high-impact events plus/minus 60 minutes",
    },
    selection: {
      config: selected.config.name,
      labelMode: selected.config.labelMode,
      retention: selected.retention,
      objective: "development-only: maximize profitable win rate among candidates with at least 35 trades, at least 45% profitable, positive expectancy, PF above 1, and at least 55% positive months; robust expectancy tie-breaker",
      frontier: grid.map((row) => ({ config: row.config.name, labelMode: row.config.labelMode, retention: row.retention, ...row.summary })),
    },
    baseline: { development: v2.results.development, validation: v2.results.validation },
    results: {
      development: developmentSummary,
      validation: validationSummary,
      validationProfitableRateWilson95: wilsonInterval(validationSummary.profitableTrades, validationSummary.trades),
      developmentActualClasses: actualClassCounts(selected.trades, candidateMap, selected.config.labelMode),
      validationActualClasses: actualClassCounts(validationTrades, candidateMap, selected.config.labelMode),
    },
    comparison: {
      validationProfitableRateDelta: validationSummary.profitableRate - v2.results.validation.profitableRate,
      validationExpectancyDeltaR: validationSummary.expectancyR - v2.results.validation.expectancyR,
      validationProfitFactorDelta: validationSummary.profitFactor - v2.results.validation.profitFactor,
      validationTradeDelta: validationSummary.trades - v2.results.validation.trades,
    },
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
      labelMode: report.selection.labelMode,
      retention: report.selection.retention,
      objective: report.selection.objective,
    },
    development: report.results.development,
    validation: report.results.validation,
    validationProfitableRateWilson95: report.results.validationProfitableRateWilson95,
    comparison: report.comparison,
  }, null, 2));
}

main();
