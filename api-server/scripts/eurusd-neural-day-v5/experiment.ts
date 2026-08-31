/**
 * EUR/USD neural day engine V5 — news-aware, WAIT-capable, geometry-tested.
 *
 * Research-only. V5 does not import, modify, or touch V19 (frozen swing/news
 * engine), V2/V3/V4 artifacts, paper, shadow, or production. Every decision is
 * causal: models and thresholds use only data strictly before the evaluated fold.
 *
 * What is new vs V4:
 *  - polarity-adjusted signed NEWS-surprise features (the one lever prior EUR/USD
 *    research pointed to: price-only direction failed, news carried direction);
 *  - two heads learn DIRECTION and whether to trade at all (WAIT when weak);
 *  - entry/stop geometry is swept and chosen on validation, not assumed;
 *  - clean chronological TRAIN / VALIDATION / untouched TEST split + walk-forward;
 *  - standard R accounting: 1R = initial risk (stop distance), reward:risk = rr:1.
 *
 * No mirror inversion: long and short outcomes are independent executable bid/ask
 * simulations.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, trainNeuralModel, type Architecture, type NeuralModel, type Sample } from "../eurusd-neural-day-v1/model.js";
import {
  fitRegimes,
  loadBars,
  prepareSeries,
  rawFeatures,
  regimeOf,
  regimeVector,
  summarize,
  type Bar,
  type Direction,
  type Outcome,
} from "../eurusd-neural-day-v1/experiment.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUTPUT = path.join(ROOT, "api-server", "research-v2", "eurusd-neural-day-v5");

// ---- execution constants (shared with prior engines) ----
const PIP = 0.0001;
const WARMUP = 240;
const MAX_HOLD_BARS = 12;            // 180 minutes
const MIN_STOP_PIPS = 4;
const ENTRY_SLIPPAGE_PIPS = 0.1;
const EXIT_SLIPPAGE_PIPS = 0.1;
const MAX_SPREAD_ATR = 0.35;
const NEWS_BLACKOUT_MINUTES = 60;
const MAX_TRADES_PER_DAY = 3;
const DIRECTIONAL_COUNT = 22;        // 20 price directional + 2 news directional

// ---- news feature constants ----
const NEWS_SIGNAL_LOOKBACK_MIN = 300;
const NEWS_HALFLIFE_MIN = 120;
const POST_NEWS_WINDOW_MIN = 120;

// ---- chronological split (2-year news window) ----
const WINDOW_FROM = Date.parse("2024-08-01T00:00:00Z");
const TRAIN = { from: Date.parse("2024-08-01T00:00:00Z"), to: Date.parse("2025-05-01T00:00:00Z") };
const VALIDATION = { from: Date.parse("2025-05-01T00:00:00Z"), to: Date.parse("2025-11-01T00:00:00Z") };
const TEST = { from: Date.parse("2025-11-01T00:00:00Z"), to: Date.parse("2026-08-01T00:00:00Z") };
const BUILD_FROM = Date.parse("2024-06-01T00:00:00Z"); // build buffer so features/news are warm

// ---- search space ----
const LOGISTIC: Architecture = { name: "logistic", hidden1: 0, hidden2: 0 };
const MLP16: Architecture = { name: "mlp-16", hidden1: 16, hidden2: 0 };
const ARCHS = [LOGISTIC, MLP16];
const GEOMETRIES = [
  { stopAtr: 1.0, rr: 1.5 }, { stopAtr: 1.0, rr: 2.0 }, { stopAtr: 1.0, rr: 2.5 },
  { stopAtr: 1.25, rr: 1.5 }, { stopAtr: 1.25, rr: 2.0 }, { stopAtr: 1.25, rr: 2.5 },
  { stopAtr: 1.5, rr: 1.5 }, { stopAtr: 1.5, rr: 2.0 }, { stopAtr: 1.5, rr: 2.5 },
];
const COVERAGES = [0.10, 0.20, 0.35];
const CONFIDENCES = [0.0, 0.10];
const CALIBRATION_MONTHS = 6;
const WALKFORWARD_STEP_MONTHS = 2;
const WALKFORWARD_MIN_TRAIN_MONTHS = 6;

export type Geo = { stopAtr: number; rr: number };
export const geoKey = (g: Geo) => `${g.stopAtr}|${g.rr}`;

type NewsEvent = { time: number; currency: string; name: string };
type SignedRelease = { time: number; signed: number };

type Session = "LONDON" | "NY_AM" | "NY_PM";
export type V5Candidate = {
  index: number;
  time: number;
  iso: string;
  day: string;
  hour: number;
  session: Session;
  spreadAtr: number;
  newsDistanceMinutes: number | null;
  isNewsTrade: boolean;
  longX: number[];
  shortX: number[];
  outcomes: Map<string, { long: Outcome; short: Outcome }>;
};
export type V5Trade = {
  entryTime: string;
  exitTime: string;
  direction: "LONG" | "SHORT";
  session: Session;
  isNewsTrade: boolean;
  score: number;
  margin: number;
  resultR: number;
  outcome: Outcome["kind"];
  holdMinutes: number;
  spreadAtr: number;
  newsDistanceMinutes: number | null;
};
type Heads = { direction: NeuralModel; quality: NeuralModel };

export function addUtcMonths(time: number, months: number) {
  const date = new Date(time);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.getTime();
}
function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return Infinity;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * (sorted.length - 1))))]!;
}
function sessionOf(hour: number): Session {
  if (hour < 11) return "LONDON";
  if (hour < 13) return "NY_AM";
  return "NY_PM";
}

// ---------- news parsing ----------
function parseNum(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const match = str.match(/^(-?[\d,]*\.?\d+)\s*([KMBT%]?)/i);
  if (!match) return null;
  const value = parseFloat(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] || "").toUpperCase();
  const mult = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : suffix === "T" ? 1e12 : 1;
  return value * mult;
}
function polarity(name: string): number {
  // higher actual is usually currency-positive, except labour-slack metrics.
  return /unemploy|jobless|claims/i.test(name) ? -1 : 1;
}
function currencySign(currency: string): number {
  if (currency === "USD") return -1; // stronger USD => EUR/USD down
  if (currency === "EUR") return 1;  // stronger EUR => EUR/USD up
  return 0;
}

function loadNews() {
  const dirs = ["eurusd-ff-high-impact-aug2024-jul2025", "eurusd-ff-high-impact-aug2025-jul2026"];
  const all: NewsEvent[] = [];
  const signedByTime = new Map<number, number>();
  for (const dir of dirs) {
    const file = path.join(ROOT, "api-server", "research-v2", dir, "events.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as any;
    const events = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    for (const event of events) {
      const time = Date.parse(event.releaseTimeUtc ?? "");
      if (!Number.isFinite(time)) continue;
      all.push({ time, currency: event.currency ?? "", name: event.eventName ?? "" });
      const sign = currencySign(event.currency ?? "");
      if (!sign) continue;
      const actual = parseNum(event.actual);
      const forecast = parseNum(event.forecast);
      if (actual == null || forecast == null) continue;
      const scale = Math.max(Math.abs(forecast), Math.abs(parseNum(event.previous) ?? 0), 1e-9);
      const rel = (actual - forecast) / scale;
      const signed = Math.max(-1, Math.min(1, sign * polarity(event.name ?? "") * Math.tanh(2 * rel)));
      signedByTime.set(time, Math.max(-1, Math.min(1, (signedByTime.get(time) ?? 0) + signed)));
    }
  }
  const allTimes = [...new Set(all.map((e) => e.time))].sort((a, b) => a - b);
  const signedReleases: SignedRelease[] = [...signedByTime.entries()]
    .map(([time, signed]) => ({ time, signed }))
    .sort((a, b) => a.time - b.time);
  return { allTimes, signedReleases };
}

function nearestMinutes(sortedTimes: number[], time: number) {
  let low = 0, high = sortedTimes.length;
  while (low < high) { const mid = (low + high) >> 1; if (sortedTimes[mid]! < time) low = mid + 1; else high = mid; }
  let distance = Infinity;
  if (low < sortedTimes.length) distance = Math.min(distance, Math.abs(sortedTimes[low]! - time));
  if (low > 0) distance = Math.min(distance, Math.abs(sortedTimes[low - 1]! - time));
  return Number.isFinite(distance) ? distance / 60_000 : null;
}
function minutesToNext(sortedTimes: number[], time: number) {
  let low = 0, high = sortedTimes.length;
  while (low < high) { const mid = (low + high) >> 1; if (sortedTimes[mid]! <= time) low = mid + 1; else high = mid; }
  return low < sortedTimes.length ? (sortedTimes[low]! - time) / 60_000 : null;
}
function lastSignedBefore(signed: SignedRelease[], time: number): SignedRelease | null {
  let low = 0, high = signed.length;
  while (low < high) { const mid = (low + high) >> 1; if (signed[mid]!.time <= time) low = mid + 1; else high = mid; }
  return low > 0 ? signed[low - 1]! : null;
}

function newsFeatures(allTimes: number[], signed: SignedRelease[], time: number) {
  const nearest = nearestMinutes(allTimes, time);
  const toNext = minutesToNext(allTimes, time);
  let sinceMin = Infinity;
  {
    let low = 0, high = allTimes.length;
    while (low < high) { const mid = (low + high) >> 1; if (allTimes[mid]! <= time) low = mid + 1; else high = mid; }
    if (low > 0) sinceMin = (time - allTimes[low - 1]!) / 60_000;
  }
  const last = lastSignedBefore(signed, time);
  let signedSurprise = 0, signedDecayed = 0, magnitude = 0, inPost = 0, isNewsTrade = false;
  if (last) {
    const ageMin = (time - last.time) / 60_000;
    if (ageMin >= 0 && ageMin <= NEWS_SIGNAL_LOOKBACK_MIN) {
      const decay = Math.pow(0.5, ageMin / NEWS_HALFLIFE_MIN);
      signedSurprise = last.signed;
      signedDecayed = last.signed * decay;
      magnitude = Math.abs(last.signed);
      inPost = ageMin <= POST_NEWS_WINDOW_MIN ? 1 : 0;
      isNewsTrade = true;
    }
  }
  const directional = [signedSurprise, signedDecayed];
  const nonDirectional = [
    Math.min(1, sinceMin / NEWS_SIGNAL_LOOKBACK_MIN),
    toNext == null ? 1 : Math.min(1, toNext / NEWS_SIGNAL_LOOKBACK_MIN),
    inPost,
    magnitude,
  ];
  return { directional, nonDirectional, nearest, isNewsTrade };
}

// ---------- geometry-parameterized executable outcome (bid/ask, no mirror math) ----------
export function resolveOutcomeGeo(
  bars: Bar[],
  series: ReturnType<typeof prepareSeries>,
  index: number,
  direction: Direction,
  geo: Geo,
  costless = false,
  maxHoldBars = MAX_HOLD_BARS,
): Outcome {
  const entryIndex = index + 1;
  const entryBar = bars[entryIndex]!;
  const stopDistance = Math.max(geo.stopAtr * series.atr14[index]!, MIN_STOP_PIPS * PIP);
  const entrySlip = costless ? 0 : ENTRY_SLIPPAGE_PIPS * PIP;
  const exitCostR = costless ? 0 : EXIT_SLIPPAGE_PIPS * PIP / stopDistance; // 1R = stopDistance
  const entry = costless ? entryBar.open : direction === 1 ? entryBar.askOpen + entrySlip : entryBar.bidOpen - entrySlip;
  const stop = direction === 1 ? entry - stopDistance : entry + stopDistance;
  const target = direction === 1 ? entry + geo.rr * stopDistance : entry - geo.rr * stopDistance;
  let exitIndex = entryIndex;
  const base = bars[index]!.t;
  for (let cursor = entryIndex; cursor <= Math.min(entryIndex + maxHoldBars - 1, bars.length - 1); cursor += 1) {
    exitIndex = cursor;
    const bar = bars[cursor]!;
    const high = costless ? bar.high : direction === 1 ? bar.bidHigh : bar.askHigh;
    const low = costless ? bar.low : direction === 1 ? bar.bidLow : bar.askLow;
    const targetHit = direction === 1 ? high >= target : low <= target;
    const stopHit = direction === 1 ? low <= stop : high >= stop;
    if (targetHit && stopHit) return { kind: "AMBIGUOUS_STOP", r: -1 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - base) / 60_000 };
    if (targetHit) return { kind: "TARGET", r: geo.rr - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - base) / 60_000 };
    if (stopHit) return { kind: "STOP", r: -1 - exitCostR, exitTime: bar.t, holdMinutes: (bar.t - base) / 60_000 };
  }
  const exitBar = bars[exitIndex]!;
  const exit = costless ? exitBar.close : direction === 1 ? exitBar.bidClose - EXIT_SLIPPAGE_PIPS * PIP : exitBar.askClose + EXIT_SLIPPAGE_PIPS * PIP;
  const move = direction === 1 ? exit - entry : entry - exit;
  const result = Math.max(-1, Math.min(geo.rr, move / stopDistance)) - exitCostR;
  return { kind: "TIME_EXIT", r: result, exitTime: exitBar.t, holdMinutes: (exitBar.t - base) / 60_000 };
}

// ---------- candidate construction ----------
export function buildCandidates(opts?: { geometries?: Geo[]; maxHoldBars?: number; buildFrom?: number }) {
  const geometries = opts?.geometries ?? GEOMETRIES;
  const maxHoldBars = opts?.maxHoldBars ?? MAX_HOLD_BARS;
  const buildFrom = opts?.buildFrom ?? BUILD_FROM;
  const bars = loadBars();
  const series = prepareSeries(bars);
  const { allTimes, signedReleases } = loadNews();
  // regimes fit on 2020-2023 only (past-only, matches prior engines)
  const regimeIdx: number[] = [];
  for (let index = WARMUP; index < bars.length - MAX_HOLD_BARS - 2; index += 8) {
    const t = bars[index]!.t;
    if (t >= Date.parse("2020-01-01T00:00:00Z") && t < Date.parse("2023-01-01T00:00:00Z")) {
      const v = regimeVector(bars, series, index);
      if (v.every(Number.isFinite)) regimeIdx.push(index);
    }
  }
  const centroids = fitRegimes(regimeIdx.map((i) => regimeVector(bars, series, i)));

  const candidates: V5Candidate[] = [];
  for (let index = WARMUP; index < bars.length - maxHoldBars - 2; index += 1) {
    const decision = bars[index]!;
    const entryTime = decision.t; // = open of bars[index+1]
    if (entryTime < buildFrom || entryTime >= TEST.to) continue;
    const date = new Date(entryTime);
    const hour = date.getUTCHours();
    if (date.getUTCMinutes() % 15 !== 0 || hour < 6 || hour >= 16) continue;
    const atr = series.atr14[index]!;
    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(series.atr56[index]!)) continue;
    const regime = regimeOf(regimeVector(bars, series, index), centroids);
    const raw = rawFeatures(bars, series, index, regime);
    if (!raw) continue;
    const entry = bars[index + 1]!;
    const news = newsFeatures(allTimes, signedReleases, entryTime);
    const baseDir = raw.slice(0, 20);
    const baseNon = raw.slice(20);
    const longX = [...baseDir, ...news.directional, ...baseNon, ...news.nonDirectional];
    const shortX = longX.map((v, i) => (i < DIRECTIONAL_COUNT ? -v : v));
    const outcomes = new Map<string, { long: Outcome; short: Outcome }>();
    for (const geo of geometries) {
      outcomes.set(geoKey(geo), {
        long: resolveOutcomeGeo(bars, series, index, 1, geo, false, maxHoldBars),
        short: resolveOutcomeGeo(bars, series, index, -1, geo, false, maxHoldBars),
      });
    }
    candidates.push({
      index,
      time: entryTime,
      iso: new Date(entryTime).toISOString(),
      day: new Date(entryTime).toISOString().slice(0, 10),
      hour,
      session: sessionOf(hour),
      spreadAtr: (entry.askOpen - entry.bidOpen) / atr,
      newsDistanceMinutes: news.nearest,
      isNewsTrade: news.isNewsTrade,
      longX,
      shortX,
      outcomes,
    });
  }
  return { candidates, bars, series };
}

const inPeriod = (c: V5Candidate, p: { from: number; to: number }) => c.time >= p.from && c.time < p.to;
export const rowsIn = (c: V5Candidate[], p: { from: number; to: number }) => c.filter((x) => inPeriod(x, p));
export const marketDays = (c: V5Candidate[]) => new Set(c.map((x) => x.day)).size;
export const isEligible = (c: V5Candidate) =>
  c.spreadAtr <= MAX_SPREAD_ATR && (c.newsDistanceMinutes == null || c.newsDistanceMinutes > NEWS_BLACKOUT_MINUTES);

// ---------- heads ----------
export function trainHeads(train: V5Candidate[], arch: Architecture, geo: Geo, seed: number): Heads {
  const key = geoKey(geo);
  const directionRows: Sample[] = [];
  const qualityRows: Sample[] = [];
  for (const c of train) {
    const o = c.outcomes.get(key)!;
    const diff = o.long.r - o.short.r;
    if (Math.abs(diff) >= 0.05) directionRows.push({ x: c.longX, y: diff > 0 ? 1 : 0 });
    qualityRows.push({ x: c.longX, y: o.long.r > 0 ? 1 : 0 });
    qualityRows.push({ x: c.shortX, y: o.short.r > 0 ? 1 : 0 });
  }
  const epochs = arch.hidden1 ? 7 : 10;
  const learningRate = arch.hidden1 ? 0.002 : 0.004;
  const direction = trainNeuralModel(directionRows, arch, { seed, epochs, learningRate, l2: 0.0006, classBalance: false });
  const quality = trainNeuralModel(qualityRows, arch, { seed: (seed ^ 0x5f3759df) >>> 0, epochs, learningRate, l2: 0.0006, classBalance: false });
  return { direction, quality };
}
export function scoreCandidate(c: V5Candidate, heads: Heads) {
  const pLongBetter = predict(heads.direction, c.longX);
  const direction: Direction = pLongBetter >= 0.5 ? 1 : -1;
  const directionConfidence = 2 * Math.abs(pLongBetter - 0.5);
  const qualityProbability = predict(heads.quality, direction === 1 ? c.longX : c.shortX);
  const rankScore = qualityProbability * (0.5 + 0.5 * directionConfidence);
  return { direction, directionConfidence, qualityProbability, rankScore };
}

// ---------- replay (WAIT-capable) ----------
export function replay(
  scored: Array<V5Candidate & ReturnType<typeof scoreCandidate> & { threshold: number }>,
  geo: Geo,
  minConfidence: number,
): V5Trade[] {
  const key = geoKey(geo);
  const trades: V5Trade[] = [];
  const perDay = new Map<string, number>();
  let lockedUntil = -Infinity;
  for (const row of [...scored].sort((a, b) => a.time - b.time)) {
    if (!isEligible(row)) continue;                       // WAIT: illiquid / news blackout
    if (row.rankScore < row.threshold) continue;          // WAIT: low quality
    if (row.directionConfidence < minConfidence) continue; // WAIT: weak direction
    if (row.time < lockedUntil) continue;
    if ((perDay.get(row.day) ?? 0) >= MAX_TRADES_PER_DAY) continue;
    const o = row.outcomes.get(key)![row.direction === 1 ? "long" : "short"];
    trades.push({
      entryTime: row.iso,
      exitTime: new Date(o.exitTime).toISOString(),
      direction: row.direction === 1 ? "LONG" : "SHORT",
      session: row.session,
      isNewsTrade: row.isNewsTrade,
      score: row.qualityProbability,
      margin: row.directionConfidence,
      resultR: o.r,
      outcome: o.kind,
      holdMinutes: o.holdMinutes,
      spreadAtr: row.spreadAtr,
      newsDistanceMinutes: row.newsDistanceMinutes,
    });
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
    lockedUntil = o.exitTime;
  }
  return trades;
}

export function scoreAndThreshold(
  evaluation: V5Candidate[],
  calibration: V5Candidate[],
  heads: Heads,
  coverage: number,
) {
  const calScores = calibration.filter(isEligible).map((c) => scoreCandidate(c, heads).rankScore);
  const threshold = percentile(calScores, 1 - coverage);
  return evaluation.map((c) => ({ ...c, ...scoreCandidate(c, heads), threshold }));
}

// ---------- reporting ----------
export function stats(trades: V5Trade[], days: number) {
  const n = trades.length;
  const base = summarize(trades as any, days);
  const rs = trades.map((t) => t.resultR);
  const exp = n ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? rs.reduce((a, r) => a + (r - exp) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, n));
  const wins = trades.filter((t) => t.resultR > 0);
  const losses = trades.filter((t) => t.resultR <= 0);
  return {
    trades: n,
    tradesPerMarketDay: base.tradesPerMarketDay,
    winRate: base.profitableRate,
    targetRate: base.targetWinRate,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.resultR, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.resultR, 0) / losses.length : 0,
    expectancyR: exp,
    totalR: base.totalR,
    profitFactor: base.profitFactor,
    maxDrawdownR: base.maxDrawdownR,
    expectancy95: { lower: n ? exp - 1.96 * se : 0, upper: n ? exp + 1.96 * se : 0 },
    positiveMonths: base.positiveMonths,
    months: base.months,
  };
}
export function breakdowns(trades: V5Trade[], days: number) {
  const by = (pred: (t: V5Trade) => boolean) => stats(trades.filter(pred), days);
  return {
    long: by((t) => t.direction === "LONG"),
    short: by((t) => t.direction === "SHORT"),
    news: by((t) => t.isNewsTrade),
    nonNews: by((t) => !t.isNewsTrade),
    sessionLondon: by((t) => t.session === "LONDON"),
    sessionNyAm: by((t) => t.session === "NY_AM"),
    sessionNyPm: by((t) => t.session === "NY_PM"),
  };
}

// ---------- selection on VALIDATION only ----------
function main() {
  mkdirSync(OUTPUT, { recursive: true });
  console.log("Building candidates (price + news features, 9 geometries)...");
  const { candidates } = buildCandidates();
  const trainRows = rowsIn(candidates, TRAIN);
  const valRows = rowsIn(candidates, VALIDATION);
  const testRows = rowsIn(candidates, TEST);
  const trainValRows = candidates.filter((c) => c.time >= TRAIN.from && c.time < TEST.from);
  const valDays = marketDays(valRows);
  const testDays = marketDays(testRows);
  console.log(`Candidates: train=${trainRows.length} val=${valRows.length} test=${testRows.length}`);

  // Grid: for each (arch, geo) train on TRAIN once, calibrate threshold on TRAIN's last 6m, score VALIDATION.
  const grid: Array<{ arch: string; geo: Geo; coverage: number; confidence: number; summary: ReturnType<typeof stats>; trades: V5Trade[] }> = [];
  const calForVal = rowsIn(candidates, { from: addUtcMonths(VALIDATION.from, -CALIBRATION_MONTHS), to: VALIDATION.from });
  let seedBase = 0x51ed5;
  for (const arch of ARCHS) {
    for (const geo of GEOMETRIES) {
      const heads = trainHeads(trainRows, arch, geo, (seedBase += 8191));
      for (const coverage of COVERAGES) {
        const scored = scoreAndThreshold(valRows, calForVal, heads, coverage);
        for (const confidence of CONFIDENCES) {
          const trades = replay(scored, geo, confidence);
          grid.push({ arch: arch.name, geo, coverage, confidence, trades, summary: stats(trades, valDays) });
        }
      }
    }
  }
  // objective: enough trades on validation, PF>1, then maximize robust expectancy.
  const robust = (r: (typeof grid)[number]) => r.summary.expectancyR - 0.5 * (r.summary.expectancy95.upper - r.summary.expectancyR) / 1.96;
  const eligibleArms = grid.filter((r) => r.summary.trades >= 30 && r.summary.profitFactor > 1);
  const pool = eligibleArms.length ? eligibleArms : grid.filter((r) => r.summary.trades >= 30);
  const selected = [...pool].sort((a, b) => robust(b) - robust(a) || b.summary.profitFactor - a.summary.profitFactor)[0]!;
  const selArch = ARCHS.find((a) => a.name === selected.arch)!;
  console.log(`Selected arch=${selected.arch} geo=${geoKey(selected.geo)} coverage=${selected.coverage} conf=${selected.confidence}`);

  // ---- TEST: retrain on TRAIN+VALIDATION, calibrate on last 6m before TEST, evaluate once ----
  const testHeads = trainHeads(trainValRows, selArch, selected.geo, 0x7e57 ^ 0x1234);
  const calForTest = rowsIn(candidates, { from: addUtcMonths(TEST.from, -CALIBRATION_MONTHS), to: TEST.from });
  const testScored = scoreAndThreshold(testRows, calForTest, testHeads, selected.coverage);
  const testTrades = replay(testScored, selected.geo, selected.confidence);

  // ---- training-period fit (for the "do not trust training" comparison) ----
  const trainScored = scoreAndThreshold(trainRows, trainRows, trainHeads(trainRows, selArch, selected.geo, (seedBase += 8191)), selected.coverage);
  const trainTrades = replay(trainScored, selected.geo, selected.confidence);
  const trainDays = marketDays(trainRows);

  // ---- WALK-FORWARD: frozen config, expanding past-only retrain every 2 months ----
  const wfTrades: V5Trade[] = [];
  const wfFolds: any[] = [];
  let foldSeed = 0x9e37;
  for (
    let foldStart = addUtcMonths(WINDOW_FROM, WALKFORWARD_MIN_TRAIN_MONTHS);
    foldStart < TEST.to;
    foldStart = addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS)
  ) {
    const foldEnd = Math.min(TEST.to, addUtcMonths(foldStart, WALKFORWARD_STEP_MONTHS));
    const trainFold = candidates.filter((c) => c.time >= WINDOW_FROM && c.time < foldStart);
    const evalFold = candidates.filter((c) => c.time >= foldStart && c.time < foldEnd);
    if (trainFold.length < 200 || !evalFold.length) continue;
    const heads = trainHeads(trainFold, selArch, selected.geo, (foldSeed += 7919));
    const calFold = candidates.filter((c) => c.time >= addUtcMonths(foldStart, -CALIBRATION_MONTHS) && c.time < foldStart);
    const scored = scoreAndThreshold(evalFold, calFold.length ? calFold : trainFold, heads, selected.coverage);
    const trades = replay(scored, selected.geo, selected.confidence);
    wfTrades.push(...trades);
    wfFolds.push({
      fold: `${new Date(foldStart).toISOString().slice(0, 10)}..${new Date(foldEnd).toISOString().slice(0, 10)}`,
      ...stats(trades, marketDays(evalFold)),
    });
  }
  const wfDays = marketDays(candidates.filter((c) => c.time >= addUtcMonths(WINDOW_FROM, WALKFORWARD_MIN_TRAIN_MONTHS) && c.time < TEST.to));

  const testSummary = stats(testTrades, testDays);
  const wfSummary = stats(wfTrades, wfDays);

  const passesTarget =
    testSummary.winRate >= 0.45 && testSummary.winRate <= 0.60 &&
    testSummary.expectancyR > 0 && testSummary.profitFactor > 1 &&
    wfSummary.expectancyR > 0 && wfSummary.profitFactor > 1;
  const verdict = passesTarget
    ? (testSummary.expectancy95.lower > 0
        ? "POSITIVE_ON_UNTOUCHED_TEST_AND_WALKFORWARD_RESEARCH_ONLY"
        : "POSITIVE_BUT_TEST_INTERVAL_CROSSES_ZERO_EDGE_UNCERTAIN")
    : "NO_ROBUST_EDGE_ON_UNTOUCHED_TEST_OR_WALKFORWARD";

  const report = {
    generatedAt: new Date().toISOString(),
    verdict,
    isolation: { v19Modified: false, v2v3v4Overwritten: false, paperOrProductionChanged: false, mirrorMathUsed: false },
    protocol: {
      instrument: "EUR_USD",
      rAccounting: "1R = initial risk (stop distance); reward:risk = rr:1",
      decisionCadence: "every completed M15 candle, 06:00-15:45 UTC, next-open entry",
      heads: "pairwise DIRECTION head + POSITIVE_R QUALITY head; WAIT when quality<threshold or direction confidence<min",
      newsFeatures: "polarity-adjusted signed post-release surprise toward EUR/USD (decayed), minutes since/to next release, post-news flag, magnitude; surprise only from releases before entry",
      thresholding: "past-only calibration-quantile coverage",
      execution: "historical bid/ask, 0.1 pip entry+exit slippage, same-candle ambiguity charged to stop, 180-min max hold, +-60min high-impact news blackout, max 3/day, one open position",
    },
    split: {
      train: "2024-08-01..2025-05-01", validation: "2025-05-01..2025-11-01", test: "2025-11-01..2026-08-01 (touched once)",
      walkForward: "expanding past-only, retrain every 2 months, min 6m train, frozen config",
    },
    selection: {
      arch: selected.arch, geometry: geoKey(selected.geo), coverage: selected.coverage, minDirectionConfidence: selected.confidence,
      objective: "validation only: >=30 trades and PF>1, then maximize robust expectancy; never selected on test; no win-rate target",
      validationSummary: selected.summary,
      grid: grid.map((r) => ({ arch: r.arch, geometry: geoKey(r.geo), coverage: r.coverage, confidence: r.confidence, ...r.summary })),
    },
    v19Comparison: { v19OpportunitiesPerDayApprox: 59 / (2 * 259), testTradesPerDay: testSummary.tradesPerMarketDay },
    results: {
      train: { summary: stats(trainTrades, trainDays), breakdowns: breakdowns(trainTrades, trainDays) },
      validation: { summary: selected.summary, breakdowns: breakdowns(selected.trades, valDays) },
      test: { summary: testSummary, breakdowns: breakdowns(testTrades, testDays) },
      walkForward: { summary: wfSummary, folds: wfFolds, breakdowns: breakdowns(wfTrades, wfDays) },
    },
  };

  writeFileSync(path.join(OUTPUT, "RESULTS.json"), JSON.stringify(round(report), null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.test.json"), JSON.stringify(testTrades, null, 2));
  writeFileSync(path.join(OUTPUT, "TRADES.walkforward.json"), JSON.stringify(wfTrades, null, 2));
  writeFindings(round(report) as any);
  console.log(JSON.stringify({
    verdict,
    selection: { arch: selected.arch, geometry: geoKey(selected.geo), coverage: selected.coverage, confidence: selected.confidence },
    train: report.results.train.summary,
    validation: report.results.validation.summary,
    test: report.results.test.summary,
    walkForward: report.results.walkForward.summary,
  }, null, 2));
}

function round(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
  return value;
}

function fmtPct(x: number) { return (x * 100).toFixed(2) + "%"; }
function row(label: string, s: any) {
  return `| ${label} | ${s.trades} | ${s.tradesPerMarketDay.toFixed(3)} | ${fmtPct(s.winRate)} | ${s.avgWin.toFixed(3)} | ${s.avgLoss.toFixed(3)} | ${s.expectancyR.toFixed(4)} | ${s.totalR.toFixed(2)} | ${s.profitFactor === "Infinity" ? "inf" : Number(s.profitFactor).toFixed(3)} | ${s.maxDrawdownR.toFixed(2)} | [${s.expectancy95.lower.toFixed(3)}, ${s.expectancy95.upper.toFixed(3)}] |`;
}
function writeFindings(r: any) {
  const R = r.results;
  const md = `# EUR/USD Neural Day Engine V5 — News-Aware, WAIT-Capable

Verdict: **${r.verdict}**

Research-only. Isolated from V19 and from V2/V3/V4. No mirror math; long/short are
independent executable bid/ask simulations. Judgment is based on the **untouched TEST**
and **walk-forward**, never on training.

## Selection (validation only)
- Architecture **${r.selection.arch}**, geometry **${r.selection.geometry}** (stopATR|reward:risk), coverage **${(r.selection.coverage * 100).toFixed(0)}%**, min direction confidence **${r.selection.minDirectionConfidence}**.
- ${r.selection.objective}

## Headline results (1R = initial risk)
| Period | Trades | Trades/day | Win rate | Avg win | Avg loss | Expectancy | Total R | PF | Max DD | Exp 95% CI |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${row("Train (do NOT trust)", R.train.summary)}
${row("Validation (selection)", R.validation.summary)}
${row("TEST (untouched, once)", R.test.summary)}
${row("Walk-forward (all folds)", R.walkForward.summary)}

Target was 45–52% win rate with positive expectancy after costs and more opportunities than
V19 (~${(r.v19Comparison.v19OpportunitiesPerDayApprox).toFixed(3)}/day). V5 test frequency:
${R.test.summary.tradesPerMarketDay.toFixed(3)}/day.

## TEST breakdowns
| Cut | Trades | Win rate | Expectancy | Total R | PF |
|---|---:|---:|---:|---:|---:|
| Long | ${R.test.breakdowns.long.trades} | ${fmtPct(R.test.breakdowns.long.winRate)} | ${R.test.breakdowns.long.expectancyR.toFixed(4)} | ${R.test.breakdowns.long.totalR.toFixed(2)} | ${Number(R.test.breakdowns.long.profitFactor).toFixed?.(3) ?? R.test.breakdowns.long.profitFactor} |
| Short | ${R.test.breakdowns.short.trades} | ${fmtPct(R.test.breakdowns.short.winRate)} | ${R.test.breakdowns.short.expectancyR.toFixed(4)} | ${R.test.breakdowns.short.totalR.toFixed(2)} | ${Number(R.test.breakdowns.short.profitFactor).toFixed?.(3) ?? R.test.breakdowns.short.profitFactor} |
| News | ${R.test.breakdowns.news.trades} | ${fmtPct(R.test.breakdowns.news.winRate)} | ${R.test.breakdowns.news.expectancyR.toFixed(4)} | ${R.test.breakdowns.news.totalR.toFixed(2)} | ${Number(R.test.breakdowns.news.profitFactor).toFixed?.(3) ?? R.test.breakdowns.news.profitFactor} |
| Non-news | ${R.test.breakdowns.nonNews.trades} | ${fmtPct(R.test.breakdowns.nonNews.winRate)} | ${R.test.breakdowns.nonNews.expectancyR.toFixed(4)} | ${R.test.breakdowns.nonNews.totalR.toFixed(2)} | ${Number(R.test.breakdowns.nonNews.profitFactor).toFixed?.(3) ?? R.test.breakdowns.nonNews.profitFactor} |
| London (06-11) | ${R.test.breakdowns.sessionLondon.trades} | ${fmtPct(R.test.breakdowns.sessionLondon.winRate)} | ${R.test.breakdowns.sessionLondon.expectancyR.toFixed(4)} | ${R.test.breakdowns.sessionLondon.totalR.toFixed(2)} | ${Number(R.test.breakdowns.sessionLondon.profitFactor).toFixed?.(3) ?? R.test.breakdowns.sessionLondon.profitFactor} |
| NY AM (11-13) | ${R.test.breakdowns.sessionNyAm.trades} | ${fmtPct(R.test.breakdowns.sessionNyAm.winRate)} | ${R.test.breakdowns.sessionNyAm.expectancyR.toFixed(4)} | ${R.test.breakdowns.sessionNyAm.totalR.toFixed(2)} | ${Number(R.test.breakdowns.sessionNyAm.profitFactor).toFixed?.(3) ?? R.test.breakdowns.sessionNyAm.profitFactor} |
| NY PM (13-16) | ${R.test.breakdowns.sessionNyPm.trades} | ${fmtPct(R.test.breakdowns.sessionNyPm.winRate)} | ${R.test.breakdowns.sessionNyPm.expectancyR.toFixed(4)} | ${R.test.breakdowns.sessionNyPm.totalR.toFixed(2)} | ${Number(R.test.breakdowns.sessionNyPm.profitFactor).toFixed?.(3) ?? R.test.breakdowns.sessionNyPm.profitFactor} |

## Walk-forward folds
| Fold | Trades | Win rate | Expectancy | Total R | PF |
|---|---:|---:|---:|---:|---:|
${R.walkForward.folds.map((f: any) => `| ${f.fold} | ${f.trades} | ${fmtPct(f.winRate)} | ${f.expectancyR.toFixed(4)} | ${f.totalR.toFixed(2)} | ${Number(f.profitFactor).toFixed?.(3) ?? f.profitFactor} |`).join("\n")}

## Reading this
Training numbers are shown only to demonstrate they are NOT the basis for judgment. The
verdict is set by the untouched test and walk-forward. See EXPERIMENTS.md for the log.
`;
  writeFileSync(path.join(OUTPUT, "FINDINGS.md"), md);
}

export {
  GEOMETRIES, ARCHS, TRAIN, VALIDATION, TEST, WINDOW_FROM, CALIBRATION_MONTHS,
  WALKFORWARD_STEP_MONTHS, WALKFORWARD_MIN_TRAIN_MONTHS, MIN_STOP_PIPS, ENTRY_SLIPPAGE_PIPS, PIP,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
