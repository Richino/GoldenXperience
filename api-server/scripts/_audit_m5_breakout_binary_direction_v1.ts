/**
 * Clean binary-direction audit for the M5 breakout setup.
 *
 * This deliberately does NOT use stop/target outcomes.  Every setup is judged
 * only by whether the midpoint at a frozen horizon finished above or below the
 * midpoint when the fully completed breakout bar closed.  The inverse arm uses
 * the exact same two price marks.
 *
 * Holdout outcome prices are only read after a predeclared dev gate passes.
 * Research only; this script never changes the live/paper binary collector.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serviceRoot, "..");
const cacheDir = path.join(repoRoot, "backtest-breakout-m5", "candles");
const outDir = path.join(serviceRoot, "research-v2", "m5-breakout-binary-direction-v1");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const HORIZONS_MINUTES = [10, 15, 30, 60, 120] as const;
const LOOKBACK = 20;
const BREAK_THRESHOLD_ATR = 0.5;
const MIN_RANGE_ATR = 1;
const MAX_RANGE_ATR = 8;
const MAX_EXTENSION_ATR = 3;
const MIN_ATR_PIPS = 0.8;
const PURGE_MS = 2 * 60 * 60_000;
const DEV_MIN_SIGNALS = 100;
const DEV_MIN_WIN_RATE = 0.5556;

type Pair = (typeof PAIRS)[number];
type Bar = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidClose: number; askClose: number;
};
type Cache = { bars: Bar[] };
type Signal = { pair: Pair; entryAt: string; entryMid: number; direction: "UP" | "DOWN"; outcomes: Partial<Record<number, number>> };
type Metrics = { n: number; wins: number; losses: number; ties: number; winRate: number | null; wilsonLower: number | null };

function pip(pair: Pair) { return pair.endsWith("JPY") ? 0.01 : 0.0001; }
function etHour(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
}
function inSession(iso: string) { const hour = etHour(iso); return hour >= 3 && hour < 17; }
function ema(values: number[], period: number) {
  const valuesOut: number[] = []; const k = 2 / (period + 1); let current = values[0]!;
  for (const value of values) { current = value * k + current * (1 - k); valuesOut.push(current); }
  return valuesOut;
}
function atr(bars: Bar[], period: number) {
  const out = new Array<number>(bars.length).fill(Number.NaN); let sum = 0; let current = Number.NaN;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!; const prev = bars[i - 1];
    const tr = prev ? Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close)) : bar.high - bar.low;
    if (i < period) { sum += tr; if (i === period - 1) { current = sum / period; out[i] = current; } }
    else { current = (current * (period - 1) + tr) / period; out[i] = current; }
  }
  return out;
}
function latestIndexAtOrBefore(bars: Bar[], timestamp: number) {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (Date.parse(bars[mid]!.closeTime) <= timestamp) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}
function midpoint(bar: Bar) { return (bar.bidClose + bar.askClose) / 2; }
function wilsonLower(wins: number, n: number) {
  if (!n) return null; const z = 1.96; const p = wins / n; const denom = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / denom;
}
function metrics(signals: Signal[], horizon: number, invert: boolean): Metrics {
  let wins = 0, losses = 0, ties = 0;
  for (const signal of signals) {
    const delta = signal.outcomes[horizon]; if (delta === undefined || delta === 0) { ties++; continue; }
    const expectedUp = invert ? signal.direction === "DOWN" : signal.direction === "UP";
    if ((delta > 0) === expectedUp) wins++; else losses++;
  }
  const n = wins + losses;
  return { n, wins, losses, ties, winRate: n ? wins / n : null, wilsonLower: n ? wilsonLower(wins, n) : null };
}
function formatMetric(metric: Metrics) { return { ...metric, winRate: metric.winRate === null ? null : Number((metric.winRate * 100).toFixed(2)), wilsonLower: metric.wilsonLower === null ? null : Number((metric.wilsonLower * 100).toFixed(2)) }; }

const m5 = new Map<Pair, Bar[]>(); const h1 = new Map<Pair, Bar[]>();
for (const pair of PAIRS) {
  m5.set(pair, (JSON.parse(readFileSync(path.join(cacheDir, `${pair}_M5.json`), "utf8")) as Cache).bars);
  h1.set(pair, (JSON.parse(readFileSync(path.join(cacheDir, `${pair}_H1.json`), "utf8")) as Cache).bars);
}

const allSignals: Signal[] = [];
for (const pair of PAIRS) {
  const m5Bars = m5.get(pair)!; const h1Bars = h1.get(pair)!; const atr14 = atr(m5Bars, 14);
  const h1Fast = ema(h1Bars.map((bar) => bar.close), 21); const h1Slow = ema(h1Bars.map((bar) => bar.close), 50);
  for (let i = 30; i < m5Bars.length; i++) {
    const bar = m5Bars[i]!; const barTime = Date.parse(bar.closeTime); if (!inSession(bar.closeTime)) continue;
    const atrValue = atr14[i]!; if (!Number.isFinite(atrValue) || atrValue / pip(pair) < MIN_ATR_PIPS) continue;
    const previous = m5Bars.slice(i - LOOKBACK, i); const rangeHigh = Math.max(...previous.map((item) => item.high)); const rangeLow = Math.min(...previous.map((item) => item.low));
    const rangeWidthAtr = (rangeHigh - rangeLow) / atrValue; if (rangeWidthAtr < MIN_RANGE_ATR || rangeWidthAtr > MAX_RANGE_ATR) continue;
    let direction: "UP" | "DOWN" | null = null; let level = 0;
    if (bar.close > rangeHigh + BREAK_THRESHOLD_ATR * atrValue) { direction = "UP"; level = rangeHigh; }
    else if (bar.close < rangeLow - BREAK_THRESHOLD_ATR * atrValue) { direction = "DOWN"; level = rangeLow; }
    if (!direction) continue;
    const extension = direction === "UP" ? bar.close - level : level - bar.close;
    if (extension > MAX_EXTENSION_ATR * atrValue) continue;
    if (direction === "UP" ? bar.close <= bar.open : bar.close >= bar.open) continue;
    const h1Index = latestIndexAtOrBefore(h1Bars, barTime); if (h1Index < 0) continue;
    const h1Direction = h1Fast[h1Index]! > h1Slow[h1Index]! ? "UP" : "DOWN"; if (h1Direction !== direction) continue;
    const spreadPips = (bar.askClose - bar.bidClose) / pip(pair); if (!Number.isFinite(spreadPips) || spreadPips > (pair.endsWith("JPY") ? 3 : 2)) continue;
    const outcomes: Partial<Record<number, number>> = {};
    for (const horizon of HORIZONS_MINUTES) {
      const closeIndex = latestIndexAtOrBefore(m5Bars, barTime + horizon * 60_000);
      if (closeIndex > i) outcomes[horizon] = midpoint(m5Bars[closeIndex]!) - midpoint(bar);
    }
    allSignals.push({ pair, entryAt: bar.closeTime, entryMid: midpoint(bar), direction, outcomes });
  }
}
allSignals.sort((a, b) => Date.parse(a.entryAt) - Date.parse(b.entryAt));
const start = Date.parse(allSignals[0]!.entryAt); const end = Date.parse(allSignals[allSignals.length - 1]!.entryAt);
const trainCut = start + (end - start) * 0.6; const devCut = start + (end - start) * 0.8;
const train = allSignals.filter((signal) => Date.parse(signal.entryAt) < trainCut - PURGE_MS);
const dev = allSignals.filter((signal) => Date.parse(signal.entryAt) >= trainCut + PURGE_MS && Date.parse(signal.entryAt) < devCut - PURGE_MS);
const holdout = allSignals.filter((signal) => Date.parse(signal.entryAt) >= devCut + PURGE_MS);

const candidates = HORIZONS_MINUTES.flatMap((horizon) => ([false, true].map((invert) => ({ horizon, invert, train: metrics(train, horizon, invert), dev: metrics(dev, horizon, invert) }))));
const eligible = candidates.filter((candidate) => candidate.dev.n >= DEV_MIN_SIGNALS && (candidate.dev.winRate ?? 0) > DEV_MIN_WIN_RATE && (candidate.dev.wilsonLower ?? 0) > 0.5);
const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  purpose: "fixed-price binary direction, not stop/target trade P&L",
  rules: { pairs: PAIRS, horizonsMinutes: HORIZONS_MINUTES, split: "chronological 60/20/20", purgeMinutes: PURGE_MS / 60_000, devGate: { minSignals: DEV_MIN_SIGNALS, minWinRatePercent: DEV_MIN_WIN_RATE * 100, wilsonLowerAbovePercent: 50 } },
  counts: { all: allSignals.length, train: train.length, dev: dev.length, holdoutSealed: holdout.length },
  candidates: candidates.map((candidate) => ({ horizonMinutes: candidate.horizon, side: candidate.invert ? "INVERSE" : "ORIGINAL", train: formatMetric(candidate.train), dev: formatMetric(candidate.dev) })),
  gate: { passed: eligible.length > 0, eligible: eligible.map((candidate) => ({ horizonMinutes: candidate.horizon, side: candidate.invert ? "INVERSE" : "ORIGINAL" })) },
};
if (eligible.length) {
  (report as Record<string, unknown>).holdout = eligible.map((candidate) => ({ horizonMinutes: candidate.horizon, side: candidate.invert ? "INVERSE" : "ORIGINAL", metrics: formatMetric(metrics(holdout, candidate.horizon, candidate.invert)) }));
}
writeFileSync(path.join(outDir, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
