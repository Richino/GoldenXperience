/**
 * Breakout-m5-confidence-v1 model loader + detector + decision.
 *
 * The M5 scalper: fires on M5 breakouts where the model DISAGREES with the
 * strategy's direction (CONF_T=0.00, take all). Walk-forward: 72.6% winrate,
 * +0.227R/trade, 2.68 trades/day, 87% winning months across 3 years/3 pairs.
 *
 * Slippage-sensitive: edge holds up to ~1 pip added cost, dies at ~2 pips.
 * Deployment discipline: 30 days DRY_RUN before going live; then 0.25% risk
 * for 100 trades before scaling to 1%.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.join(__dirname, "data", "breakout-m5-confidence-v1-model.json");

export type BreakoutM5Artifact = {
  modelName: "breakout-m5-confidence-v1";
  version: string;
  featureNames: string[];
  intercept: number;
  coefficients: Record<string, number>;
  normalization: { mean: Record<string, number>; std: Record<string, number> };
  metadata: {
    trainedAt: string; trainingPairs: string[]; confidenceThreshold: number;
    walkForwardValidation: string;
  };
};

let cached: BreakoutM5Artifact | null = null;
export function loadBreakoutM5Artifact(): BreakoutM5Artifact {
  if (cached) return cached;
  cached = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")) as BreakoutM5Artifact;
  return cached;
}
export function breakoutM5ArtifactAgeDays(a: BreakoutM5Artifact = loadBreakoutM5Artifact()): number {
  return (Date.now() - Date.parse(a.metadata.trainedAt)) / 86400e3;
}

// ---- OANDA candle shape (mid + bid/ask) ----
export type M5Candle = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export function pipSizeFor(inst: string): number { return inst.endsWith("JPY") ? 0.01 : 0.0001; }
export function m5SpreadCap(inst: string): number { return inst.includes("JPY") ? 3 : 2; }

// ---- indicators ----
export function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}
export function atr(bars: M5Candle[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDayNum(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function inM5Session(iso: string): boolean {
  const h = etHour(iso);
  return h >= 3 && h < 17;
}
function sessionLabel(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}
function htfBias(closeTime: string, bars: M5Candle[], e21: number[], e50: number[]): -1 | 0 | 1 {
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = e21[k]; const b = e50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return a > b ? 1 : -1;
}

// ---- M5 setup detector (same as backtest) ----
const LOOKBACK = 20;
const BREAK_THRESHOLD = 0.5;
const MIN_RANGE_ATR = 1.0;
const MAX_RANGE_ATR = 8.0;
const MAX_EXTENSION_ATR = 3.0;
const STOP_ATR = 0.5;
const TARGET_R = 2.0;
const MIN_ATR_PIPS = 0.8;

export type M5Setup = {
  passed: true; pair: string; decisionTime: string; direction: "long" | "short";
  entry: number; stop: number; target: number;
  stopPips: number; targetPips: number; spreadPips: number;
  atrPips: number; rangeWidthAtr: number; sessionHourEt: number;
};
export type M5Rejection = { passed: false; reason: string };

export function evaluateM5BreakoutSetup(
  pair: string, m5: M5Candle[], h1: M5Candle[],
): M5Setup | M5Rejection {
  if (m5.length < 30) return { passed: false, reason: "insufficient M5 history" };
  const i = m5.length - 1;
  const bar = m5[i]!;
  if (!inM5Session(bar.closeTime)) return { passed: false, reason: "outside session (London/NY window)" };

  const closes5 = m5.map((b) => b.close);
  const a14 = atr(m5, 14);
  const atrV = a14[i]!;
  if (!Number.isFinite(atrV) || atrV <= 0) return { passed: false, reason: "ATR unavailable" };
  const pip = pipSizeFor(pair);
  const atrPips = atrV / pip;
  if (atrPips < MIN_ATR_PIPS) return { passed: false, reason: `ATR ${atrPips.toFixed(2)} < ${MIN_ATR_PIPS} pip floor` };

  const winStart = Math.max(0, i - LOOKBACK);
  const window = m5.slice(winStart, i);
  if (window.length < LOOKBACK) return { passed: false, reason: "insufficient lookback window" };
  const rangeHi = Math.max(...window.map((b) => b.high));
  const rangeLo = Math.min(...window.map((b) => b.low));
  const rangeWidth = rangeHi - rangeLo;
  const rangeWidthAtr = rangeWidth / atrV;
  if (rangeWidthAtr < MIN_RANGE_ATR) return { passed: false, reason: `range ${rangeWidthAtr.toFixed(2)}xATR < min ${MIN_RANGE_ATR}` };
  if (rangeWidthAtr > MAX_RANGE_ATR) return { passed: false, reason: `range ${rangeWidthAtr.toFixed(2)}xATR > max ${MAX_RANGE_ATR}` };

  let dir: "long" | "short" | null = null;
  let level = 0;
  if (bar.close > rangeHi + BREAK_THRESHOLD * atrV) { dir = "long"; level = rangeHi; }
  else if (bar.close < rangeLo - BREAK_THRESHOLD * atrV) { dir = "short"; level = rangeLo; }
  else return { passed: false, reason: "no break beyond level" };

  const extension = dir === "long" ? bar.close - level : level - bar.close;
  if (extension > MAX_EXTENSION_ATR * atrV) return { passed: false, reason: "chasing (extension too far)" };

  const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
  if (!closedDir) return { passed: false, reason: "confirmation did not close in direction" };

  const h1_e21 = ema(h1.map((b) => b.close), 21);
  const h1_e50 = ema(h1.map((b) => b.close), 50);
  const h1b = htfBias(bar.closeTime, h1, h1_e21, h1_e50);
  if (h1b !== (dir === "long" ? 1 : -1)) return { passed: false, reason: "H1 does not agree" };

  const spreadPips = (bar.askClose - bar.bidClose) / pip;
  const spMax = m5SpreadCap(pair);
  if (!Number.isFinite(spreadPips) || spreadPips > spMax) return { passed: false, reason: `spread ${spreadPips.toFixed(1)} > ${spMax}` };

  const entry = dir === "long" ? bar.askClose : bar.bidClose;
  const stop = dir === "long" ? level - STOP_ATR * atrV : level + STOP_ATR * atrV;
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0 || stopDist / entry < 1e-6) return { passed: false, reason: "degenerate stop distance" };
  const target = dir === "long" ? entry + TARGET_R * stopDist : entry - TARGET_R * stopDist;

  return {
    passed: true, pair, decisionTime: bar.closeTime, direction: dir,
    entry, stop, target,
    stopPips: stopDist / pip, targetPips: (TARGET_R * stopDist) / pip, spreadPips,
    atrPips, rangeWidthAtr, sessionHourEt: etHour(bar.closeTime),
  };
}

// ---- prediction ----
const SESSIONS = ["london", "overlap", "ny", "off"];
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

export type BreakoutM5Features = {
  pair: string; sessionHourEt: number; atrPips: number; rangeWidthAtr: number;
  spreadPips: number; decisionTime: string;
};

function vec(f: BreakoutM5Features): Record<string, number> {
  const s = sessionLabel(f.sessionHourEt);
  const out: Record<string, number> = {};
  for (const sn of SESSIONS) out[`session_${sn}`] = s === sn ? 1 : 0;
  for (const p of PAIRS) out[`pair_${p}`] = f.pair === p ? 1 : 0;
  out.atrPips = f.atrPips;
  out.rangeWidthAtr = f.rangeWidthAtr;
  out.spreadPips = f.spreadPips;
  out.hourEt = f.sessionHourEt;
  out.dayOfWeek = etDayNum(f.decisionTime);
  return out;
}
function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

export function predictM5PLong(
  f: BreakoutM5Features, a: BreakoutM5Artifact = loadBreakoutM5Artifact(),
): number {
  const raw = vec(f);
  let z = a.intercept;
  for (const name of a.featureNames) {
    const v = raw[name];
    if (!Number.isFinite(v)) return 0.5;
    const scaled = (v! - a.normalization.mean[name]!) / (a.normalization.std[name] || 1);
    z += scaled * (a.coefficients[name] ?? 0);
  }
  return sigmoid(z);
}

export type M5Decision =
  | { action: "take_model_pick"; direction: "long" | "short"; originalDirection: "long" | "short"; pLong: number }
  | { action: "skip"; reason: "model_agrees_with_stack" | "artifact_stale" | "pair_not_trained" };

export function decideM5Direction(params: {
  pair: string; breakoutDirection: "long" | "short"; features: BreakoutM5Features;
  maxArtifactAgeDays?: number;
}): { decision: M5Decision; pLong: number; artifactVersion: string; trainedAt: string } {
  const a = loadBreakoutM5Artifact();
  if (breakoutM5ArtifactAgeDays(a) > (params.maxArtifactAgeDays ?? 14)) {
    return { decision: { action: "skip", reason: "artifact_stale" }, pLong: NaN, artifactVersion: a.version, trainedAt: a.metadata.trainedAt };
  }
  if (!a.metadata.trainingPairs.includes(params.pair)) {
    return { decision: { action: "skip", reason: "pair_not_trained" }, pLong: NaN, artifactVersion: a.version, trainedAt: a.metadata.trainedAt };
  }
  const pLong = predictM5PLong(params.features, a);
  const modelPick: "long" | "short" = pLong >= 0.5 ? "long" : "short";
  if (modelPick === params.breakoutDirection) {
    return { decision: { action: "skip", reason: "model_agrees_with_stack" }, pLong, artifactVersion: a.version, trainedAt: a.metadata.trainedAt };
  }
  return {
    decision: { action: "take_model_pick", direction: modelPick, originalDirection: params.breakoutDirection, pLong },
    pLong, artifactVersion: a.version, trainedAt: a.metadata.trainedAt,
  };
}
