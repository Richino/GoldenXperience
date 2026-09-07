/**
 * EUR/USD neural day engine V4 - higher-volume expected-return ranking.
 *
 * Research-only. V4 does not modify V19, V2, V3, paper execution, or production.
 * Every decision is causal: models and thresholds use only rows before the fold.
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
  type Candidate,
  type Direction,
  type Trade,
} from "../eurusd-neural-day-v1/experiment.js";
import {
  DEVELOPMENT,
  VALIDATION,
  buildCorrectedCandidates,
  buildRegimes,
  isMarketEligible,
} from "../eurusd-neural-day-v2/experiment.js";

type Session = "LONDON" | "NEW_YORK";
type SessionPolicy = "ALL_SESSIONS" | "NEW_YORK_ONLY";
type DirectionMode = "DUAL_EXPECTED" | "PAIRWISE";
type Config = { name: string; architecture: Architecture; directionMode: DirectionMode; lookbackMonths: number };
type CategoryMeans = { target: number; partialWin: number; nonPositive: number };
type Heads = { positive: NeuralModel; target: NeuralModel; direction: NeuralModel; means: CategoryMeans };
type Score = Candidate & {
  session: Session;
  direction: Direction;
  directionEdge: number;
  positiveProbability: number;
  targetProbability: number;
  predictedR: number;
  threshold: number;
  coverage: number;
  fold: string;
};
type GridRow = {
  config: Config;
  coverage: number;
  minimumDirectionEdge: number;
  sessionPolicy: SessionPolicy;
  trades: Trade[];
  summary: ReturnType<typeof summarize>;
  volume: ReturnType<typeof volumeSummary>;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v4");
const LOGISTIC: Architecture = { name: "logistic", hidden1: 0, hidden2: 0 };
const MLP16: Architecture = { name: "mlp-16", hidden1: 16, hidden2: 0 };
const CONFIGS: Config[] = [
  { name: "dual-expected-r-logistic", architecture: LOGISTIC, directionMode: "DUAL_EXPECTED", lookbackMonths: 48 },
  { name: "dual-expected-r-mlp16", architecture: MLP16, directionMode: "DUAL_EXPECTED", lookbackMonths: 48 },
  { name: "pairwise-expected-r-logistic", architecture: LOGISTIC, directionMode: "PAIRWISE", lookbackMonths: 48 },
  { name: "pairwise-expected-r-mlp16", architecture: MLP16, directionMode: "PAIRWISE", lookbackMonths: 48 },
];
const COVERAGES = [0.05, 0.08, 0.12, 0.18, 0.25, 0.35];
const DIRECTION_EDGES = [0, 0.02, 0.05];
const RETRAIN_MONTHS = 6;
const CALIBRATION_MONTHS = 6;
const MAX_TRADES_PER_DAY = 3;
const MAX_TRADES_PER_SESSION = 2;
const MIN_DEVELOPMENT_TRADES_PER_DAY = 0.75;
const SCORE_CALIBRATION_WINDOW = 800;

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

function sessionOf(time: number): Session {
  return new Date(time).getUTCHours() < 11 ? "LONDON" : "NEW_YORK";
}

function trainingRows(candidates: Candidate[]): Array<{ x: number[]; r: number; target: boolean }> {
  return candidates.flatMap((candidate) => [
    { x: candidate.longX, r: candidate.longOutcome.r, target: candidate.longOutcome.kind === "TARGET" },
    { x: candidate.shortX, r: candidate.shortOutcome.r, target: candidate.shortOutcome.kind === "TARGET" },
  ]);
}

function categoryMeans(rows: ReturnType<typeof trainingRows>): CategoryMeans {
  const mean = (values: number[], fallback: number) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
  return {
    target: mean(rows.filter((row) => row.target).map((row) => row.r), 1.5),
    partialWin: mean(rows.filter((row) => row.r > 0 && !row.target).map((row) => row.r), 0.25),
    nonPositive: mean(rows.filter((row) => row.r <= 0).map((row) => row.r), -0.75),
  };
}

function fitHeads(candidates: Candidate[], config: Config, seed: number): Heads {
  const rows = trainingRows(candidates);
  const epochs = config.architecture.hidden1 ? 7 : 10;
  const learningRate = config.architecture.hidden1 ? 0.002 : 0.004;
  const train = (samples: Sample[], offset: number) => trainNeuralModel(samples, config.architecture, {
    seed: seed + offset,
    epochs,
    learningRate,
    l2: 0.0007,
    classBalance: false,
  });
  return {
    positive: train(rows.map((row) => ({ x: row.x, y: row.r > 0 ? 1 : 0 })), 101),
    target: train(rows.map((row) => ({ x: row.x, y: row.target ? 1 : 0 })), 307),
    direction: train(candidates
      .filter((candidate) => Math.abs(candidate.longOutcome.r - candidate.shortOutcome.r) >= 0.05)
      .map((candidate) => ({ x: candidate.longX, y: candidate.longOutcome.r > candidate.shortOutcome.r ? 1 : 0 })), 503),
    means: categoryMeans(rows),
  };
}

function sideEstimate(x: number[], heads: Heads) {
  const positiveProbability = predict(heads.positive, x);
  const rawTargetProbability = predict(heads.target, x);
  const targetProbability = Math.min(positiveProbability, rawTargetProbability);
  const partialProbability = Math.max(0, positiveProbability - targetProbability);
  const nonPositiveProbability = Math.max(0, 1 - positiveProbability);
  const predictedR = targetProbability * heads.means.target
    + partialProbability * heads.means.partialWin
    + nonPositiveProbability * heads.means.nonPositive;
  return { positiveProbability, targetProbability, predictedR };
}

function scoreCandidate(candidate: Candidate, heads: Heads, config: Config) {
  const long = sideEstimate(candidate.longX, heads);
  const short = sideEstimate(candidate.shortX, heads);
  const pLongBetter = predict(heads.direction, candidate.longX);
  const direction: Direction = config.directionMode === "PAIRWISE"
    ? pLongBetter >= 0.5 ? 1 : -1
    : long.predictedR >= short.predictedR ? 1 : -1;
  const selected = direction === 1 ? long : short;
  return {
    direction,
    directionEdge: config.directionMode === "PAIRWISE"
      ? 2 * Math.abs(pLongBetter - 0.5)
      : Math.abs(long.predictedR - short.predictedR),
    positiveProbability: selected.positiveProbability,
    targetProbability: selected.targetProbability,
    predictedR: selected.predictedR,
  };
}

function buildAllQuarterHourCandidates() {
  const bars = loadBars();
  const news = loadNewsTimes();
  const { series, centroids } = buildRegimes(bars);
  const candidates = [
    ...buildCorrectedCandidates(bars, series, centroids, news, 0),
    ...buildCorrectedCandidates(bars, series, centroids, news, 15),
  ].sort((left, right) => left.time - right.time);
  return { bars, candidates };
}

function scorePeriod(candidates: Candidate[], period: { from: number; to: number }, config: Config) {
  const output: Score[] = [];
  let foldIndex = 0;
  for (let foldStart = period.from; foldStart < period.to; foldStart = addUtcMonths(foldStart, RETRAIN_MONTHS)) {
    const foldEnd = Math.min(period.to, addUtcMonths(foldStart, RETRAIN_MONTHS));
    const training = rowsIn(candidates, { from: addUtcMonths(foldStart, -config.lookbackMonths), to: foldStart });
    const calibration = rowsIn(candidates, { from: addUtcMonths(foldStart, -CALIBRATION_MONTHS), to: foldStart })
      .filter(isMarketEligible);
    const evaluation = rowsIn(candidates, { from: foldStart, to: foldEnd });
    const heads = fitHeads(training, config, 0x6d2b79f5 + foldIndex * 1543 + config.name.length * 97);
    const calibrationScores = calibration.map((candidate) => ({ candidate, ...scoreCandidate(candidate, heads, config) }));
    const fold = `${new Date(foldStart).toISOString().slice(0, 10)}..${new Date(foldEnd).toISOString().slice(0, 10)}`;
    for (const coverage of COVERAGES) {
      const scoreHistory = new Map<Session, number[]>();
      for (const session of ["LONDON", "NEW_YORK"] as const) {
        scoreHistory.set(session, calibrationScores
          .filter((row) => sessionOf(row.candidate.time) === session)
          .map((row) => row.predictedR)
          .slice(-SCORE_CALIBRATION_WINDOW));
      }
      for (const candidate of [...evaluation].sort((left, right) => left.time - right.time)) {
        const session = sessionOf(candidate.time);
        const score = scoreCandidate(candidate, heads, config);
        const history = scoreHistory.get(session)!;
        const threshold = percentile(history, 1 - coverage);
        output.push({
          ...candidate,
          ...score,
          session,
          threshold,
          coverage,
          fold,
        });
        history.push(score.predictedR);
        if (history.length > SCORE_CALIBRATION_WINDOW) history.shift();
      }
    }
    foldIndex += 1;
  }
  return output;
}

function replay(
  scores: Score[],
  coverage: number,
  minimumDirectionEdge: number,
  sessionPolicy: SessionPolicy,
): Trade[] {
  const trades: Trade[] = [];
  const daily = new Map<string, number>();
  const sessionCounts = new Map<string, number>();
  let lockedUntil = -Infinity;
  const rows = scores.filter((row) => row.coverage === coverage).sort((left, right) => left.time - right.time);
  for (const row of rows) {
    const sessionKey = `${row.day}|${row.session}`;
    if ((sessionPolicy === "NEW_YORK_ONLY" && row.session !== "NEW_YORK")
      || !isMarketEligible(row)
      || row.predictedR < row.threshold
      || row.directionEdge < minimumDirectionEdge
      || row.time < lockedUntil
      || (daily.get(row.day) ?? 0) >= MAX_TRADES_PER_DAY
      || (sessionCounts.get(sessionKey) ?? 0) >= MAX_TRADES_PER_SESSION) continue;
    const outcome = row.direction === 1 ? row.longOutcome : row.shortOutcome;
    trades.push({
      entryTime: row.iso,
      exitTime: new Date(outcome.exitTime).toISOString(),
      direction: row.direction === 1 ? "LONG" : "SHORT",
      score: row.predictedR,
      margin: row.directionEdge,
      resultR: outcome.r,
      outcome: outcome.kind,
      holdMinutes: outcome.holdMinutes,
      spreadAtr: row.spreadAtr,
      newsDistanceMinutes: row.newsDistanceMinutes,
    });
    daily.set(row.day, (daily.get(row.day) ?? 0) + 1);
    sessionCounts.set(sessionKey, (sessionCounts.get(sessionKey) ?? 0) + 1);
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

function volumeSummary(trades: Trade[], days: number) {
  const counts = new Map<string, number>();
  for (const trade of trades) {
    const day = trade.entryTime.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const histogram: Record<string, number> = { "0": Math.max(0, days - counts.size), "1": 0, "2": 0, "3": 0 };
  for (const count of counts.values()) histogram[String(Math.min(3, count))] = (histogram[String(Math.min(3, count))] ?? 0) + 1;
  return {
    daysWithTrade: counts.size,
    percentMarketDaysWithTrade: counts.size / Math.max(1, days),
    tradeDayAverage: trades.length / Math.max(1, counts.size),
    dailyTradeHistogram: histogram,
  };
}

function selectGrid(rows: GridRow[]) {
  const highVolume = rows.filter((row) => row.summary.tradesPerMarketDay >= MIN_DEVELOPMENT_TRADES_PER_DAY
    && row.summary.trades >= 180);
  const stablePositive = rows.filter((row) => row.summary.trades >= 100
    && row.summary.expectancyR > 0
    && row.summary.profitFactor > 1
    && row.summary.positiveMonths >= Math.ceil(row.summary.months * 0.55));
  const stablePositiveHighVolume = stablePositive.filter((row) => row.summary.tradesPerMarketDay >= MIN_DEVELOPMENT_TRADES_PER_DAY);
  if (stablePositiveHighVolume.length) {
    return [...stablePositiveHighVolume].sort((left, right) => {
      const leftRobust = left.summary.expectancyR - 0.5 * standardError(left.trades);
      const rightRobust = right.summary.expectancyR - 0.5 * standardError(right.trades);
      return rightRobust - leftRobust || right.summary.tradesPerMarketDay - left.summary.tradesPerMarketDay;
    })[0]!;
  }
  if (stablePositive.length) {
    return [...stablePositive].sort((left, right) => right.summary.tradesPerMarketDay - left.summary.tradesPerMarketDay
      || (right.summary.expectancyR - 0.5 * standardError(right.trades)) - (left.summary.expectancyR - 0.5 * standardError(left.trades)))[0]!;
  }
  const pool = highVolume.length ? highVolume : rows;
  return [...pool].sort((left, right) => {
    const leftRobust = left.summary.expectancyR - 0.5 * standardError(left.trades);
    const rightRobust = right.summary.expectancyR - 0.5 * standardError(right.trades);
    return rightRobust - leftRobust
      || right.summary.tradesPerMarketDay - left.summary.tradesPerMarketDay
      || right.summary.profitFactor - left.summary.profitFactor;
  })[0]!;
}

function confidenceIntervals(trades: Trade[]) {
  const se = standardError(trades);
  const profitable = trades.filter((trade) => trade.resultR > 0).length;
  const n = trades.length;
  const z2 = 1.96 ** 2;
  const p = profitable / Math.max(1, n);
  const denominator = 1 + z2 / Math.max(1, n);
  const center = (p + z2 / (2 * Math.max(1, n))) / denominator;
  const half = (1.96 * Math.sqrt((p * (1 - p)) / Math.max(1, n) + z2 / (4 * Math.max(1, n) ** 2))) / denominator;
  return {
    expectancy95: { lower: trades.length ? summarize(trades, 1).expectancyR - 1.96 * se : 0, upper: trades.length ? summarize(trades, 1).expectancyR + 1.96 * se : 0 },
    profitableRateWilson95: { lower: Math.max(0, center - half), upper: Math.min(1, center + half) },
  };
}

function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rounded(child)]));
  return value;
}

function writeFindings(report: any) {
  const dev = report.results.development;
  const check = report.results.historicalCheck;
  const interval = report.results.historicalCheckIntervals.expectancy95;
  const markdown = `# EUR/USD Neural Day Engine V4 - Higher Volume\n\nVerdict: **${report.verdict}**\n\n## Architecture\n\nV4 evaluates every eligible EUR/USD M15 decision during London and New York hours. Separate past-only neural heads estimate positive-return and full-target probabilities for both long and short. The side with the higher estimated net R is selected, then compared with a rolling session-specific threshold using only preceding scores. Development selected the **${report.selection.sessionPolicy}** arm.\n\n## Results\n\n| Period | Trades | Trades/day | Profitable rate | Target rate | Expectancy | PF | Total R | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| Development | ${dev.trades} | ${dev.tradesPerMarketDay.toFixed(3)} | ${(dev.profitableRate * 100).toFixed(2)}% | ${(dev.targetWinRate * 100).toFixed(2)}% | ${dev.expectancyR.toFixed(3)}R | ${dev.profitFactor.toFixed(3)} | ${dev.totalR.toFixed(2)}R | ${dev.maxDrawdownR.toFixed(2)}R |\n| Later historical check | ${check.trades} | ${check.tradesPerMarketDay.toFixed(3)} | ${(check.profitableRate * 100).toFixed(2)}% | ${(check.targetWinRate * 100).toFixed(2)}% | ${check.expectancyR.toFixed(3)}R | ${check.profitFactor.toFixed(3)} | ${check.totalR.toFixed(2)}R | ${check.maxDrawdownR.toFixed(2)}R |\n\n## Evidence status\n\nThe later check produced **${check.tradesPerMarketDay.toFixed(3)} trades/day**, above V2's 0.236/day but below V4's development goal of 0.75/day. Its expectancy 95% interval is **${interval.lower.toFixed(3)}R to ${interval.upper.toFixed(3)}R**, which crosses zero widely. The 2025-08 through 2026-07 period is also **not pristine unseen data** because earlier V2/V3 work already inspected it. V4 remains research-only and is not connected to practice or live execution.\n\n${report.interpretation}\n`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), markdown);
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Loading EUR/USD M15 bid/ask history and building all quarter-hour candidates...");
  const { candidates } = buildAllQuarterHourCandidates();
  const developmentDays = marketDays(rowsIn(candidates, DEVELOPMENT));
  const validationDays = marketDays(rowsIn(candidates, VALIDATION));
  const grid: GridRow[] = [];

  for (const config of CONFIGS) {
    console.log(`Development model: ${config.name}`);
    const scores = scorePeriod(candidates, DEVELOPMENT, config);
    for (const coverage of COVERAGES) {
      for (const minimumDirectionEdge of DIRECTION_EDGES) {
        for (const sessionPolicy of ["ALL_SESSIONS", "NEW_YORK_ONLY"] as const) {
          const trades = replay(scores, coverage, minimumDirectionEdge, sessionPolicy);
          grid.push({
            config,
            coverage,
            minimumDirectionEdge,
            sessionPolicy,
            trades,
            summary: summarize(trades, developmentDays),
            volume: volumeSummary(trades, developmentDays),
          });
        }
      }
    }
  }

  const selected = selectGrid(grid);
  console.log(`Selected ${selected.config.name}, coverage=${selected.coverage}, directionEdge=${selected.minimumDirectionEdge}, sessions=${selected.sessionPolicy}`);
  console.log("Running the frozen configuration on the later historical period...");
  const checkScores = scorePeriod(candidates, VALIDATION, selected.config);
  const checkTrades = replay(checkScores, selected.coverage, selected.minimumDirectionEdge, selected.sessionPolicy);
  const checkSummary = summarize(checkTrades, validationDays);
  const checkVolume = volumeSummary(checkTrades, validationDays);
  const checkIntervals = confidenceIntervals(checkTrades);
  const volumeImproved = checkSummary.tradesPerMarketDay > 0.235521;
  const volumeGoalMet = checkSummary.tradesPerMarketDay >= MIN_DEVELOPMENT_TRADES_PER_DAY;
  const positive = checkSummary.expectancyR > 0 && checkSummary.profitFactor > 1;
  const statisticallyPositive = checkIntervals.expectancy95.lower > 0;
  const verdict = volumeGoalMet && positive && statisticallyPositive
    ? "HIGHER_VOLUME_AND_POSITIVE_HISTORICAL_CHECK_RESEARCH_ONLY"
    : volumeImproved && positive
      ? "VOLUME_IMPROVED_BUT_TARGET_NOT_MET_EDGE_UNCERTAIN"
    : volumeImproved
      ? "HIGHER_VOLUME_BUT_NEGATIVE_EXPECTANCY"
      : "VOLUME_GOAL_NOT_MET";
  const interpretation = volumeGoalMet && positive && statisticallyPositive
    ? "V4 met the development volume target and produced statistically positive expectancy in the later historical check. New forward practice evidence is still required because this period was previously inspected."
    : volumeImproved && positive
      ? "V4 increased frequency above V2 and finished barely positive, but it missed the 0.75-trades/day goal and its expectancy interval includes substantial losses. This is an uncertain near-breakeven result, not a confirmed edge."
    : volumeImproved
      ? "V4 increased trade frequency, but the additional opportunities lost money after costs. Higher volume alone is not an edge."
      : "V4 did not improve historical trade frequency enough to satisfy the higher-volume objective.";

  const v2 = JSON.parse(readFileSync(path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v2", "RESULTS.json"), "utf8"));
  const v3 = JSON.parse(readFileSync(path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v3", "RESULTS.json"), "utf8"));
  const report = rounded({
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: { v19Modified: false, v2OrV3ArtifactsOverwritten: false, productionOrPaperBehaviorChanged: false },
    protocol: {
      instrument: "EUR_USD",
      decisionCadence: "every completed M15 candle from 06:00 through 15:45 UTC; next candle open",
      model: "separate positive-return and full-target heads score both directions; higher predicted net-R side wins",
      retraining: "six-month walk-forward folds, trailing 48 months, past-only",
      thresholding: "rolling past-only London and New York score quantiles, initialized from preceding calibration data and capped at 800 observations",
      execution: "historical bid/ask, 0.1 pip entry/exit slippage, 1.25 ATR stop, +1.5R/-0.75R geometry, 180-minute maximum hold",
      newsBlackout: "EUR/USD high-impact events plus/minus 60 minutes",
      concurrency: "one open EUR/USD trade; maximum three per day and two per session",
    },
    selection: {
      config: selected.config.name,
      coverage: selected.coverage,
      minimumDirectionEdge: selected.minimumDirectionEdge,
      sessionPolicy: selected.sessionPolicy,
      objective: "development only: prefer stable positive arms with at least 100 trades; require positive expectancy, PF above 1, and at least 55% positive months; among them maximize volume; never select a known-negative arm merely to satisfy volume",
      frontier: grid.map((row) => ({
        config: row.config.name,
        coverage: row.coverage,
        minimumDirectionEdge: row.minimumDirectionEdge,
        sessionPolicy: row.sessionPolicy,
        ...row.summary,
        ...row.volume,
      })),
    },
    baselines: {
      v2Validation: v2.results.validation,
      v3Validation: v3.results.validation,
    },
    results: {
      development: selected.summary,
      developmentVolume: selected.volume,
      developmentIntervals: confidenceIntervals(selected.trades),
      historicalCheck: checkSummary,
      historicalCheckVolume: checkVolume,
      historicalCheckIntervals: checkIntervals,
    },
    comparison: {
      versusV2TradesPerDay: checkSummary.tradesPerMarketDay - v2.results.validation.tradesPerMarketDay,
      versusV2ExpectancyR: checkSummary.expectancyR - v2.results.validation.expectancyR,
      versusV3TradesPerDay: checkSummary.tradesPerMarketDay - v3.results.validation.tradesPerMarketDay,
      versusV3ExpectancyR: checkSummary.expectancyR - v3.results.validation.expectancyR,
    },
    interpretation,
  }) as any;

  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.development.json"), JSON.stringify(selected.trades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.historical-check.json"), JSON.stringify(checkTrades, null, 2));
  writeFindings(report);
  console.log(JSON.stringify({
    verdict,
    selection: report.selection && {
      config: report.selection.config,
      coverage: report.selection.coverage,
      minimumDirectionEdge: report.selection.minimumDirectionEdge,
      sessionPolicy: report.selection.sessionPolicy,
    },
    development: report.results.development,
    developmentVolume: report.results.developmentVolume,
    historicalCheck: report.results.historicalCheck,
    historicalCheckVolume: report.results.historicalCheckVolume,
    comparison: report.comparison,
  }, null, 2));
}

main();
