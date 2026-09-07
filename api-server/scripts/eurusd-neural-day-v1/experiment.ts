/**
 * EUR/USD neural day engine V1.
 *
 * This is a new research line. It does not import or modify V19 or any live,
 * paper, or shadow strategy. The model is trained on side-conditioned target
 * outcomes from raw EUR/USD M15 bid/ask candles. Architecture is chosen by
 * classification quality before development; the execution threshold is chosen
 * on development without a win-rate target; validation is evaluated once.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, trainNeuralModel, type Architecture, type NeuralModel, type Sample } from "./model.js";

export type RawBar = {
  closeTime: string;
  open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export type Bar = RawBar & { t: number };
export type Direction = 1 | -1;
export type Outcome = {
  kind: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT" | "BREAKEVEN";
  r: number;
  exitTime: number;
  holdMinutes: number;
};
export type Candidate = {
  index: number;
  time: number;
  iso: string;
  day: string;
  spreadAtr: number;
  newsDistanceMinutes: number | null;
  longX: number[];
  shortX: number[];
  longOutcome: Outcome;
  shortOutcome: Outcome;
};
type ScoredCandidate = Candidate & {
  pLong: number;
  pShort: number;
  score: number;
  margin: number;
  direction: Direction;
};
export type Trade = {
  entryTime: string;
  exitTime: string;
  direction: "LONG" | "SHORT";
  score: number;
  margin: number;
  resultR: number;
  outcome: Outcome["kind"];
  holdMinutes: number;
  spreadAtr: number;
  newsDistanceMinutes: number | null;
};
type Summary = {
  trades: number;
  marketDays: number;
  tradesPerMarketDay: number;
  targetWins: number;
  targetWinRate: number;
  profitableTrades: number;
  profitableRate: number;
  totalR: number;
  expectancyR: number;
  profitFactor: number;
  maxDrawdownR: number;
  positiveMonths: number;
  months: number;
  averageHoldMinutes: number;
  medianHoldMinutes: number;
  ambiguousStops: number;
  timeExits: number;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v1");
const PIP = 0.0001;
const STOP_ATR = 1.25;
const TARGET_TO_STOP = 2;
const MAX_HOLD_BARS = 12;
const ENTRY_SLIPPAGE_PIPS = 0.1;
const EXIT_SLIPPAGE_PIPS = 0.1;
const MIN_STOP_PIPS = 4;
const MAX_SPREAD_ATR = 0.35;
const MIN_DIRECTION_MARGIN = 0.02;
const NEWS_BLACKOUT_MINUTES = 60;
const MAX_TRADES_PER_DAY = 3;
const WARMUP = 240;

const SPLITS = {
  train: { from: Date.parse("2020-01-01T00:00:00Z"), to: Date.parse("2023-01-01T00:00:00Z") },
  architecture: { from: Date.parse("2023-01-01T00:00:00Z"), to: Date.parse("2024-08-01T00:00:00Z") },
  development: { from: Date.parse("2024-08-01T00:00:00Z"), to: Date.parse("2025-08-01T00:00:00Z") },
  validation: { from: Date.parse("2025-08-01T00:00:00Z"), to: Date.parse("2026-08-01T00:00:00Z") },
};

export const FEATURE_NAMES = [
  "side_ret_1", "side_ret_2", "side_ret_4", "side_ret_8", "side_ret_16", "side_ret_32", "side_ret_96",
  "side_ema20_gap", "side_ema20_50", "side_ema50_200", "side_ema20_slope4", "side_ema50_slope16",
  "side_z32", "side_range_pos32", "side_range_pos96", "side_body", "side_wick_skew", "side_consecutive",
  "side_prior_high_distance", "side_prior_low_distance",
  "range_atr", "body_ratio", "atr_pips", "atr14_56", "spread_atr", "efficiency8", "efficiency32", "efficiency96",
  "compression16", "chase_distance", "pullback_distance", "hour_sin", "hour_cos", "dow_sin", "dow_cos",
  "session_london", "session_overlap", "session_new_york", "regime_0", "regime_1", "regime_2",
] as const;
const DIRECTIONAL_COUNT = 20;

export function loadBars() {
  const file = path.join(ROOT, "backtest-legacy-expanded", "candles", "EUR_USD_M15.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { bars: RawBar[] };
  const deduplicated = new Map<number, Bar>();
  for (const raw of parsed.bars) {
    const t = Date.parse(raw.closeTime);
    if (Number.isFinite(t)) deduplicated.set(t, { ...raw, t });
  }
  return [...deduplicated.values()].sort((left, right) => left.t - right.t);
}

export function loadNewsTimes() {
  const directories = ["eurusd-ff-high-impact-aug2024-jul2025", "eurusd-ff-high-impact-aug2025-jul2026"];
  const times = new Set<number>();
  for (const directory of directories) {
    const file = path.join(ROOT, "api-server", "research-v2", directory, "events.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { events?: Array<{ releaseTimeUtc?: string }> } | Array<{ releaseTimeUtc?: string }>;
    const events = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    for (const event of events) {
      const time = Date.parse(event.releaseTimeUtc ?? "");
      if (Number.isFinite(time)) times.add(time);
    }
  }
  return [...times].sort((left, right) => left - right);
}

export function nearestNewsMinutes(newsTimes: number[], time: number) {
  let low = 0;
  let high = newsTimes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (newsTimes[middle]! < time) low = middle + 1;
    else high = middle;
  }
  let distance = Infinity;
  if (low < newsTimes.length) distance = Math.min(distance, Math.abs(newsTimes[low]! - time));
  if (low > 0) distance = Math.min(distance, Math.abs(newsTimes[low - 1]! - time));
  return Number.isFinite(distance) ? distance / 60_000 : null;
}

function ema(values: number[], period: number) {
  const output = new Float64Array(values.length);
  const alpha = 2 / (period + 1);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = index ? alpha * values[index]! + (1 - alpha) * output[index - 1]! : values[index]!;
  }
  return output;
}

function rollingAtr(bars: Bar[], period: number) {
  const output = new Float64Array(bars.length);
  output.fill(Number.NaN);
  const tr = new Float64Array(bars.length);
  let sum = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const previousClose = index ? bars[index - 1]!.close : bars[index]!.close;
    tr[index] = Math.max(bars[index]!.high - bars[index]!.low, Math.abs(bars[index]!.high - previousClose), Math.abs(bars[index]!.low - previousClose));
    sum += tr[index]!;
    if (index >= period) sum -= tr[index - period]!;
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

function efficiency(closes: number[], index: number, lookback: number) {
  const displacement = Math.abs(closes[index]! - closes[index - lookback]!);
  let travel = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) travel += Math.abs(closes[cursor]! - closes[cursor - 1]!);
  return travel ? displacement / travel : 0;
}

function rangeStats(bars: Bar[], index: number, lookback: number, includeCurrent = true) {
  let high = -Infinity;
  let low = Infinity;
  const end = includeCurrent ? index : index - 1;
  for (let cursor = end - lookback + 1; cursor <= end; cursor += 1) {
    high = Math.max(high, bars[cursor]!.high);
    low = Math.min(low, bars[cursor]!.low);
  }
  return { high, low, width: high - low };
}

function zScore(closes: number[], index: number, lookback: number) {
  let sum = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) sum += closes[cursor]!;
  const mean = sum / lookback;
  let squared = 0;
  for (let cursor = index - lookback + 1; cursor <= index; cursor += 1) squared += (closes[cursor]! - mean) ** 2;
  const deviation = Math.sqrt(squared / lookback);
  return deviation ? (closes[index]! - mean) / deviation : 0;
}

type Series = ReturnType<typeof prepareSeries>;
export function prepareSeries(bars: Bar[]) {
  const closes = bars.map((bar) => bar.close);
  return {
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    atr14: rollingAtr(bars, 14),
    atr56: rollingAtr(bars, 56),
  };
}

export function regimeVector(bars: Bar[], series: Series, index: number) {
  const atr = series.atr14[index]!;
  const range64 = rangeStats(bars, index, 64).width;
  return [
    atr / series.atr56[index]!,
    efficiency(series.closes, index, 32),
    Math.abs(series.ema20[index]! - series.ema50[index]!) / atr,
    range64 / atr,
  ];
}

function squaredDistance(left: number[], right: number[]) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += (left[index]! - right[index]!) ** 2;
  return total;
}

export function fitRegimes(vectors: number[][], count = 3) {
  const sorted = [...vectors].sort((left, right) => left[0]! - right[0]!);
  let centroids = Array.from({ length: count }, (_, index) => [...sorted[Math.floor((index + 0.5) * sorted.length / count)]!]);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const sums = centroids.map((centroid) => new Array<number>(centroid.length).fill(0));
    const sizes = new Array<number>(count).fill(0);
    for (const vector of vectors) {
      let best = 0;
      for (let cluster = 1; cluster < count; cluster += 1) {
        if (squaredDistance(vector, centroids[cluster]!) < squaredDistance(vector, centroids[best]!)) best = cluster;
      }
      sizes[best]! += 1;
      for (let field = 0; field < vector.length; field += 1) sums[best]![field]! += vector[field]!;
    }
    centroids = centroids.map((centroid, cluster) => sizes[cluster] ? sums[cluster]!.map((value) => value / sizes[cluster]!) : centroid);
  }
  return centroids;
}

export function regimeOf(vector: number[], centroids: number[][]) {
  let best = 0;
  for (let cluster = 1; cluster < centroids.length; cluster += 1) {
    if (squaredDistance(vector, centroids[cluster]!) < squaredDistance(vector, centroids[best]!)) best = cluster;
  }
  return best;
}

export function rawFeatures(bars: Bar[], series: Series, index: number, regime: number) {
  const bar = bars[index]!;
  const atr = series.atr14[index]!;
  const range = bar.high - bar.low || atr;
  const range32 = rangeStats(bars, index, 32);
  const range96 = rangeStats(bars, index, 96);
  const prior16 = rangeStats(bars, index, 16, false);
  let consecutive = 0;
  const lastDirection = Math.sign(series.closes[index]! - series.closes[index - 1]!);
  for (let cursor = index; cursor > index - 8; cursor -= 1) {
    const direction = Math.sign(series.closes[cursor]! - series.closes[cursor - 1]!);
    if (!direction || direction !== lastDirection) break;
    consecutive += direction;
  }
  const body = bar.close - bar.open;
  const upper = bar.high - Math.max(bar.open, bar.close);
  const lower = Math.min(bar.open, bar.close) - bar.low;
  const hour = new Date(bar.t).getUTCHours() + new Date(bar.t).getUTCMinutes() / 60;
  const dow = new Date(bar.t).getUTCDay();
  const directional = [
    1, 2, 4, 8, 16, 32, 96,
  ].map((lag) => (series.closes[index]! - series.closes[index - lag]!) / atr);
  directional.push(
    (bar.close - series.ema20[index]!) / atr,
    (series.ema20[index]! - series.ema50[index]!) / atr,
    (series.ema50[index]! - series.ema200[index]!) / atr,
    (series.ema20[index]! - series.ema20[index - 4]!) / atr,
    (series.ema50[index]! - series.ema50[index - 16]!) / atr,
    zScore(series.closes, index, 32),
    range32.width ? 2 * (bar.close - range32.low) / range32.width - 1 : 0,
    range96.width ? 2 * (bar.close - range96.low) / range96.width - 1 : 0,
    body / atr,
    (lower - upper) / atr,
    consecutive / 8,
    (bar.close - prior16.high) / atr,
    (bar.close - prior16.low) / atr,
  );
  const spread = bars[index + 1]!.askOpen - bars[index + 1]!.bidOpen;
  const nonDirectional = [
    range / atr,
    Math.abs(body) / range,
    atr / PIP,
    atr / series.atr56[index]!,
    spread / atr,
    efficiency(series.closes, index, 8),
    efficiency(series.closes, index, 32),
    efficiency(series.closes, index, 96),
    rangeStats(bars, index, 16).width / atr,
    Math.abs(series.closes[index]! - series.closes[index - 4]!) / atr,
    Math.abs(bar.close - series.ema20[index]!) / atr,
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * dow / 7),
    Math.cos(2 * Math.PI * dow / 7),
    hour >= 6 && hour < 11 ? 1 : 0,
    hour >= 11 && hour < 15 ? 1 : 0,
    hour >= 13 && hour < 17 ? 1 : 0,
    regime === 0 ? 1 : 0,
    regime === 1 ? 1 : 0,
    regime === 2 ? 1 : 0,
  ];
  const combined = [...directional, ...nonDirectional];
  if (combined.length !== FEATURE_NAMES.length || combined.some((value) => !Number.isFinite(value))) return null;
  return combined;
}

function orient(features: number[], direction: Direction) {
  if (direction === 1) return features;
  return features.map((value, index) => index < DIRECTIONAL_COUNT ? -value : value);
}

export function resolveOutcome(bars: Bar[], series: Series, index: number, direction: Direction): Outcome {
  const entryIndex = index + 1;
  const entryBar = bars[entryIndex]!;
  const stopDistance = Math.max(STOP_ATR * series.atr14[index]!, MIN_STOP_PIPS * PIP);
  const entrySlip = ENTRY_SLIPPAGE_PIPS * PIP;
  const exitCostR = 0.75 * EXIT_SLIPPAGE_PIPS * PIP / stopDistance;
  const entry = direction === 1 ? entryBar.askOpen + entrySlip : entryBar.bidOpen - entrySlip;
  const stop = direction === 1 ? entry - stopDistance : entry + stopDistance;
  const target = direction === 1 ? entry + TARGET_TO_STOP * stopDistance : entry - TARGET_TO_STOP * stopDistance;
  let exitIndex = entryIndex;
  for (let cursor = entryIndex; cursor <= Math.min(entryIndex + MAX_HOLD_BARS - 1, bars.length - 1); cursor += 1) {
    exitIndex = cursor;
    const bar = bars[cursor]!;
    const high = direction === 1 ? bar.bidHigh : bar.askHigh;
    const low = direction === 1 ? bar.bidLow : bar.askLow;
    const targetHit = direction === 1 ? high >= target : low <= target;
    const stopHit = direction === 1 ? low <= stop : high >= stop;
    if (targetHit && stopHit) return { kind: "AMBIGUOUS_STOP", r: -0.75 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - bars[index]!.t) / 60_000 };
    if (targetHit) return { kind: "TARGET", r: 1.5 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - bars[index]!.t) / 60_000 };
    if (stopHit) return { kind: "STOP", r: -0.75 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - bars[index]!.t) / 60_000 };
  }
  const exitBar = bars[exitIndex]!;
  const exit = direction === 1 ? exitBar.bidClose - EXIT_SLIPPAGE_PIPS * PIP : exitBar.askClose + EXIT_SLIPPAGE_PIPS * PIP;
  const move = direction === 1 ? exit - entry : entry - exit;
  const result = Math.max(-0.75 - exitCostR, Math.min(1.5 - exitCostR, 0.75 * move / stopDistance));
  return { kind: "TIME_EXIT", r: result, exitTime: exitBar.t, holdMinutes: (exitBar.t - bars[index]!.t) / 60_000 };
}

export function buildCandidates(bars: Bar[], series: Series, centroids: number[][], newsTimes: number[]) {
  const candidates: Candidate[] = [];
  for (let index = WARMUP; index < bars.length - MAX_HOLD_BARS - 2; index += 1) {
    const decision = bars[index]!;
    const entry = bars[index + 1]!;
    const date = new Date(entry.t);
    const hour = date.getUTCHours();
    if (date.getUTCMinutes() % 30 !== 0 || hour < 6 || hour >= 16) continue;
    const atr = series.atr14[index]!;
    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(series.atr56[index]!)) continue;
    const regime = regimeOf(regimeVector(bars, series, index), centroids);
    const raw = rawFeatures(bars, series, index, regime);
    if (!raw) continue;
    const spreadAtr = (entry.askOpen - entry.bidOpen) / atr;
    candidates.push({
      index,
      time: entry.t,
      iso: new Date(entry.t).toISOString(),
      day: new Date(entry.t).toISOString().slice(0, 10),
      spreadAtr,
      newsDistanceMinutes: nearestNewsMinutes(newsTimes, entry.t),
      longX: orient(raw, 1),
      shortX: orient(raw, -1),
      longOutcome: resolveOutcome(bars, series, index, 1),
      shortOutcome: resolveOutcome(bars, series, index, -1),
    });
  }
  return candidates;
}

export function rowsIn(candidates: Candidate[], period: { from: number; to: number }) {
  return candidates.filter((candidate) => candidate.time >= period.from && candidate.time < period.to);
}

function samplesFrom(candidates: Candidate[]): Sample[] {
  const samples: Sample[] = [];
  for (const candidate of candidates) {
    samples.push({ x: candidate.longX, y: candidate.longOutcome.kind === "TARGET" ? 1 : 0 });
    samples.push({ x: candidate.shortX, y: candidate.shortOutcome.kind === "TARGET" ? 1 : 0 });
  }
  return samples;
}

function scoreCandidates(model: NeuralModel, candidates: Candidate[]) {
  return candidates.map((candidate): ScoredCandidate => {
    const pLong = predict(model, candidate.longX);
    const pShort = predict(model, candidate.shortX);
    const direction: Direction = pLong >= pShort ? 1 : -1;
    return { ...candidate, pLong, pShort, score: Math.max(pLong, pShort), margin: Math.abs(pLong - pShort), direction };
  });
}

function auc(model: NeuralModel, samples: Sample[]) {
  const scored = samples.map((sample) => ({ y: sample.y, p: predict(model, sample.x) })).sort((left, right) => left.p - right.p);
  let positive = 0;
  let negative = 0;
  let rankSum = 0;
  for (let index = 0; index < scored.length; index += 1) {
    if (scored[index]!.y) { positive += 1; rankSum += index + 1; }
    else negative += 1;
  }
  return positive && negative ? (rankSum - positive * (positive + 1) / 2) / (positive * negative) : 0.5;
}

function logLoss(model: NeuralModel, samples: Sample[]) {
  let total = 0;
  for (const sample of samples) {
    const probability = Math.max(1e-6, Math.min(1 - 1e-6, predict(model, sample.x)));
    total += -(sample.y * Math.log(probability) + (1 - sample.y) * Math.log(1 - probability));
  }
  return total / Math.max(1, samples.length);
}

function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))))]!;
}

export function marketDays(candidates: Candidate[]) {
  return new Set(candidates.map((candidate) => candidate.day)).size;
}

function replay(scored: ScoredCandidate[], threshold: number): Trade[] {
  const trades: Trade[] = [];
  const perDay = new Map<string, number>();
  let lockedUntil = -Infinity;
  for (const candidate of scored) {
    if (candidate.score < threshold || candidate.margin < MIN_DIRECTION_MARGIN) continue;
    if (candidate.spreadAtr > MAX_SPREAD_ATR) continue;
    if (candidate.newsDistanceMinutes != null && candidate.newsDistanceMinutes <= NEWS_BLACKOUT_MINUTES) continue;
    if (candidate.time < lockedUntil) continue;
    if ((perDay.get(candidate.day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    const outcome = candidate.direction === 1 ? candidate.longOutcome : candidate.shortOutcome;
    trades.push({
      entryTime: candidate.iso,
      exitTime: new Date(outcome.exitTime).toISOString(),
      direction: candidate.direction === 1 ? "LONG" : "SHORT",
      score: candidate.score,
      margin: candidate.margin,
      resultR: outcome.r,
      outcome: outcome.kind,
      holdMinutes: outcome.holdMinutes,
      spreadAtr: candidate.spreadAtr,
      newsDistanceMinutes: candidate.newsDistanceMinutes,
    });
    perDay.set(candidate.day, (perDay.get(candidate.day) ?? 0) + 1);
    lockedUntil = outcome.exitTime;
  }
  return trades;
}

export function summarize(trades: Trade[], days: number): Summary {
  const targetWins = trades.filter((trade) => trade.outcome === "TARGET").length;
  const profitableTrades = trades.filter((trade) => trade.resultR > 0).length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  const monthResults = new Map<string, number>();
  for (const trade of trades) {
    equity += trade.resultR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
    const month = trade.entryTime.slice(0, 7);
    monthResults.set(month, (monthResults.get(month) ?? 0) + trade.resultR);
  }
  const holds = trades.map((trade) => trade.holdMinutes).sort((left, right) => left - right);
  return {
    trades: trades.length,
    marketDays: days,
    tradesPerMarketDay: days ? trades.length / days : 0,
    targetWins,
    targetWinRate: trades.length ? targetWins / trades.length : 0,
    profitableTrades,
    profitableRate: trades.length ? profitableTrades / trades.length : 0,
    totalR,
    expectancyR: trades.length ? totalR / trades.length : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    maxDrawdownR,
    positiveMonths: [...monthResults.values()].filter((value) => value > 0).length,
    months: monthResults.size,
    averageHoldMinutes: holds.length ? holds.reduce((sum, value) => sum + value, 0) / holds.length : 0,
    medianHoldMinutes: holds.length ? holds[Math.floor(holds.length / 2)]! : 0,
    ambiguousStops: trades.filter((trade) => trade.outcome === "AMBIGUOUS_STOP").length,
    timeExits: trades.filter((trade) => trade.outcome === "TIME_EXIT").length,
  };
}

function counterfactual(scored: ScoredCandidate[], selected: Trade[], pick: (candidate: ScoredCandidate) => Direction) {
  const selectedTimes = new Set(selected.map((trade) => trade.entryTime));
  const trades: Trade[] = [];
  for (const candidate of scored) {
    if (!selectedTimes.has(candidate.iso)) continue;
    const direction = pick(candidate);
    const outcome = direction === 1 ? candidate.longOutcome : candidate.shortOutcome;
    trades.push({
      entryTime: candidate.iso,
      exitTime: new Date(outcome.exitTime).toISOString(),
      direction: direction === 1 ? "LONG" : "SHORT",
      score: candidate.score,
      margin: candidate.margin,
      resultR: outcome.r,
      outcome: outcome.kind,
      holdMinutes: outcome.holdMinutes,
      spreadAtr: candidate.spreadAtr,
      newsDistanceMinutes: candidate.newsDistanceMinutes,
    });
  }
  return trades;
}

function roundedSummary(summary: Summary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(6)) : value]));
}

function writeFindings(report: any) {
  const dev = report.results.development;
  const validation = report.results.validation;
  const status = report.verdict;
  const markdown = `# EUR/USD Neural Day Engine V1\n\nVerdict: **${status}**\n\n## Frozen protocol\n\n- New research line; V19 is not imported or modified.\n- M15 completed-bar decisions every 30 minutes, 06:00-15:59 UTC.\n- Entry is the next M15 open using OANDA bid/ask plus 0.1 pip entry slippage.\n- Exit uses the executable opposite side plus 0.1 pip exit slippage.\n- Stop is 1.25 ATR14 with a four-pip floor; target is twice the stop distance.\n- Payoff accounting is +1.5R / -0.75R; maximum hold is three hours.\n- Same-bar ambiguity is charged as a stop.\n- High-impact EUR/USD news is blocked within 60 minutes.\n- One open trade, maximum three entries per day, and no forced quota.\n\n## Model selection\n\nArchitecture was selected on ${report.splits.architecture} by target-class AUC, not trading win rate. The execution threshold was selected once on development by positive expectancy, profit factor, sample size, monthly stability, and drawdown. No 45-52% win-rate condition was used for selection.\n\nSelected architecture: **${report.model.selectedArchitecture}**. Selected score threshold: **${report.selection.selectedThreshold}**.\n\n## Results\n\n| Period | Trades | Trades/day | Target win rate | Profitable rate | Expectancy | Profit factor | Total R | Max DD |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n| Development | ${dev.trades} | ${dev.tradesPerMarketDay.toFixed(3)} | ${(dev.targetWinRate * 100).toFixed(2)}% | ${(dev.profitableRate * 100).toFixed(2)}% | ${dev.expectancyR.toFixed(3)}R | ${dev.profitFactor.toFixed(3)} | ${dev.totalR.toFixed(2)}R | ${dev.maxDrawdownR.toFixed(2)}R |\n| Unseen validation | ${validation.trades} | ${validation.tradesPerMarketDay.toFixed(3)} | ${(validation.targetWinRate * 100).toFixed(2)}% | ${(validation.profitableRate * 100).toFixed(2)}% | ${validation.expectancyR.toFixed(3)}R | ${validation.profitFactor.toFixed(3)} | ${validation.totalR.toFixed(2)}R | ${validation.maxDrawdownR.toFixed(2)}R |\n\n## Interpretation\n\n${report.interpretation}\n\nThe validation result was not used to retune this run. Any next model must be a separately named experiment with a new untouched validation boundary.\n`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), markdown);
}

function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Loading EUR/USD M15 bid/ask history...");
  const bars = loadBars();
  const newsTimes = loadNewsTimes();
  const series = prepareSeries(bars);
  const trainRegimeIndices: number[] = [];
  for (let index = WARMUP; index < bars.length - MAX_HOLD_BARS - 2; index += 8) {
    if (bars[index]!.t >= SPLITS.train.from && bars[index]!.t < SPLITS.train.to && Number.isFinite(series.atr56[index]!)) trainRegimeIndices.push(index);
  }
  const centroids = fitRegimes(trainRegimeIndices.map((index) => regimeVector(bars, series, index)));
  const candidates = buildCandidates(bars, series, centroids, newsTimes);
  const trainRows = rowsIn(candidates, SPLITS.train);
  const architectureRows = rowsIn(candidates, SPLITS.architecture);
  const developmentRows = rowsIn(candidates, SPLITS.development);
  const validationRows = rowsIn(candidates, SPLITS.validation);
  console.log(`Candidates train=${trainRows.length} architecture=${architectureRows.length} development=${developmentRows.length} validation=${validationRows.length}`);

  const trainSamples = samplesFrom(trainRows);
  const architectureSamples = samplesFrom(architectureRows);
  const architectures: Architecture[] = [
    { name: "logistic", hidden1: 0, hidden2: 0 },
    { name: "mlp-16", hidden1: 16, hidden2: 0 },
    { name: "mlp-24-8", hidden1: 24, hidden2: 8 },
  ];
  const architectureResults = architectures.map((architecture, index) => {
    console.log(`Training architecture ${architecture.name}...`);
    const model = trainNeuralModel(trainSamples, architecture, { seed: 0x51f15e + index, epochs: architecture.hidden1 ? 6 : 8, learningRate: architecture.hidden1 ? 0.002 : 0.004, l2: 0.0002 });
    return { architecture, auc: auc(model, architectureSamples), logLoss: logLoss(model, architectureSamples) };
  });
  architectureResults.sort((left, right) => right.auc - left.auc || left.logLoss - right.logLoss);
  const selectedArchitecture = architectureResults[0]!.architecture;
  console.log(`Selected ${selectedArchitecture.name} by architecture-period AUC=${architectureResults[0]!.auc.toFixed(4)}`);

  const finalTrainingRows = [...trainRows, ...architectureRows];
  const finalModel = trainNeuralModel(samplesFrom(finalTrainingRows), selectedArchitecture, { seed: 0x7a11d00d, epochs: selectedArchitecture.hidden1 ? 7 : 10, learningRate: selectedArchitecture.hidden1 ? 0.002 : 0.004, l2: 0.0002 });
  const scoredDevelopment = scoreCandidates(finalModel, developmentRows);
  const eligibleDevelopmentScores = scoredDevelopment
    .filter((candidate) => candidate.spreadAtr <= MAX_SPREAD_ATR && candidate.margin >= MIN_DIRECTION_MARGIN && (candidate.newsDistanceMinutes == null || candidate.newsDistanceMinutes > NEWS_BLACKOUT_MINUTES))
    .map((candidate) => candidate.score);
  const coverages = [0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5];
  const developmentDays = marketDays(developmentRows);
  const frontier = coverages.map((coverage) => {
    const threshold = percentile(eligibleDevelopmentScores, 1 - coverage);
    const trades = replay(scoredDevelopment, threshold);
    return { coverage, threshold, summary: summarize(trades, developmentDays) };
  });
  const qualified = frontier.filter((row) => row.summary.trades >= 60 && row.summary.expectancyR > 0.03 && row.summary.profitFactor > 1.05 && row.summary.positiveMonths >= Math.max(5, Math.ceil(row.summary.months / 2)));
  const selectionPool = qualified.length ? qualified : frontier.filter((row) => row.summary.trades >= 40);
  selectionPool.sort((left, right) => {
    const leftScore = left.summary.expectancyR - 0.15 * left.summary.maxDrawdownR / Math.max(1, left.summary.trades);
    const rightScore = right.summary.expectancyR - 0.15 * right.summary.maxDrawdownR / Math.max(1, right.summary.trades);
    return rightScore - leftScore;
  });
  const selected = selectionPool[0] ?? frontier[frontier.length - 1]!;
  const developmentTrades = replay(scoredDevelopment, selected.threshold);
  const developmentSummary = summarize(developmentTrades, developmentDays);
  const developmentGatePassed = qualified.some((row) => row.coverage === selected.coverage);

  console.log(`Frozen threshold=${selected.threshold.toFixed(6)} dev trades=${developmentSummary.trades} WR=${(developmentSummary.targetWinRate * 100).toFixed(2)}% exp=${developmentSummary.expectancyR.toFixed(4)}R`);
  console.log("Opening validation once with the frozen model and threshold...");
  const scoredValidation = scoreCandidates(finalModel, validationRows);
  const validationTrades = replay(scoredValidation, selected.threshold);
  const validationSummary = summarize(validationTrades, marketDays(validationRows));
  const targetGatePassed = validationSummary.targetWinRate >= 0.45 && validationSummary.targetWinRate <= 0.52;
  const validationPassed = developmentGatePassed && validationSummary.trades >= 60 && targetGatePassed && validationSummary.expectancyR > 0 && validationSummary.profitFactor > 1;

  const randomState = { value: 0x1234abcd };
  const randomDirection = () => {
    randomState.value ^= randomState.value << 13;
    randomState.value ^= randomState.value >>> 17;
    randomState.value ^= randomState.value << 5;
    return (randomState.value >>> 0) / 4_294_967_296 < 0.5 ? 1 as Direction : -1 as Direction;
  };
  const validationControls = {
    exactInverse: summarize(counterfactual(scoredValidation, validationTrades, (candidate) => candidate.direction === 1 ? -1 : 1), validationSummary.marketDays),
    alwaysLong: summarize(counterfactual(scoredValidation, validationTrades, () => 1), validationSummary.marketDays),
    alwaysShort: summarize(counterfactual(scoredValidation, validationTrades, () => -1), validationSummary.marketDays),
    emaTrend: summarize(counterfactual(scoredValidation, validationTrades, (candidate) => candidate.longX[9]! >= 0 ? 1 : -1), validationSummary.marketDays),
    seededRandom: summarize(counterfactual(scoredValidation, validationTrades, () => randomDirection()), validationSummary.marketDays),
  };

  const verdict = validationPassed ? "VALIDATION_GATE_PASSED_RESEARCH_ONLY" : developmentGatePassed ? "UNSEEN_VALIDATION_FAILED" : "DEVELOPMENT_GATE_FAILED_VALIDATION_DIAGNOSTIC_ONLY";
  const interpretation = validationPassed
    ? "The frozen candidate met the requested historical validation gates. It remains research-only because this project has previously exposed these calendar periods; a prospective shadow sample is still required."
    : !developmentGatePassed
      ? "No development threshold met the predeclared expectancy, profit-factor, sample-size, and monthly-stability gate. Validation was opened once only to provide the requested honest diagnostic; the engine is not eligible for deployment."
      : "The candidate qualified in development but failed to reproduce the complete 45-52% positive-expectancy gate on unseen validation. It must not be retuned against this validation period or promoted.";

  const report = {
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: {
      strategy: "new EUR/USD neural day-trading research line",
      v19Imported: false,
      productionOrPaperBehaviorChanged: false,
      frozenV19Manifest: "api-server/research-v2/frozen/eurusd-news-v19-2026-08-30/MANIFEST.json",
    },
    data: {
      source: "stored OANDA Practice EUR_USD M15 bid/ask",
      bars: bars.length,
      first: new Date(bars[0]!.t).toISOString(),
      last: new Date(bars.at(-1)!.t).toISOString(),
      newsEvents: newsTimes.length,
      candidateCounts: { train: trainRows.length, architecture: architectureRows.length, development: developmentRows.length, validation: validationRows.length },
    },
    splits: {
      train: "2020-01-01 through 2022-12-31",
      architecture: "2023-01-01 through 2024-07-31",
      development: "2024-08-01 through 2025-07-31",
      validation: "2025-08-01 through 2026-07-31",
      note: "Validation was not consulted for architecture or threshold selection in this run. These dates were used by prior project research, so validation is model-unseen but not project-pristine.",
    },
    execution: {
      instrument: "EUR_USD",
      style: "day trade",
      decisionCadence: "completed M15 bars at 30-minute boundaries",
      entryHoursUtc: "06:00-15:59",
      entry: "next M15 open, long ask / short bid",
      spread: "historical OANDA bid/ask embedded",
      slippage: `${ENTRY_SLIPPAGE_PIPS} pip entry and ${EXIT_SLIPPAGE_PIPS} pip exit`,
      stop: `${STOP_ATR} ATR14 with ${MIN_STOP_PIPS}-pip floor`,
      target: `${TARGET_TO_STOP} stop distances`,
      payoff: "+1.5R / -0.75R",
      maximumHold: `${MAX_HOLD_BARS * 15} minutes`,
      sameBarAmbiguity: "charged as stop",
      maximumTradesPerDay: MAX_TRADES_PER_DAY,
      concurrentTrades: 1,
      newsBlackoutMinutes: NEWS_BLACKOUT_MINUTES,
      maximumSpreadAtr: MAX_SPREAD_ATR,
    },
    features: {
      names: FEATURE_NAMES,
      causalInputs: ["multi-horizon returns", "EMA trend and slopes", "ATR and volatility state", "range position", "efficiency", "candle body and wick rejection", "pullback and chase distance", "session and weekday", "training-only K-means regime"],
      excluded: ["stored trades", "V19 signals", "future candles", "future economic actuals", "validation outcomes"],
    },
    model: {
      candidateArchitectures: architectureResults.map((row) => ({ name: row.architecture.name, auc: row.auc, logLoss: row.logLoss })),
      selectedArchitecture: selectedArchitecture.name,
      selectionMetric: "architecture-period target-class AUC; log loss as tie-breaker",
      optimizer: "deterministic mini-batch Adam with L2",
      sideConditioning: "one shared model scores executable LONG and SHORT feature orientations separately",
      regimeCentroids: centroids,
    },
    selection: {
      objective: "positive development expectancy with PF, sample-size, monthly-stability and drawdown constraints; win rate was not a selection criterion",
      frontier: frontier.map((row) => ({ coverage: row.coverage, threshold: row.threshold, ...roundedSummary(row.summary) })),
      developmentGatePassed,
      selectedCoverage: selected.coverage,
      selectedThreshold: selected.threshold,
    },
    results: {
      development: roundedSummary(developmentSummary),
      validation: roundedSummary(validationSummary),
      validationControls: Object.fromEntries(Object.entries(validationControls).map(([key, value]) => [key, roundedSummary(value)])),
      requestedValidationGate: { targetWinRateMin: 0.45, targetWinRateMax: 0.52, positiveExpectancy: true, profitFactorAboveOne: true, minimumTrades: 60 },
      validationPassed,
    },
    interpretation,
  };

  writeFileSync(path.join(OUTPUT, "MODEL.json"), JSON.stringify({
    status: verdict,
    featureNames: FEATURE_NAMES,
    threshold: selected.threshold,
    minimumDirectionMargin: MIN_DIRECTION_MARGIN,
    regimeCentroids: centroids,
    model: finalModel,
  }, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.development.json"), JSON.stringify(developmentTrades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.validation.json"), JSON.stringify(validationTrades, null, 2));
  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(report, null, 2));
  writeFindings(report);
  console.log(JSON.stringify({ verdict, development: roundedSummary(developmentSummary), validation: roundedSummary(validationSummary) }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
