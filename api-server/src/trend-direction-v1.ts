/**
 * Research-only H1 trend / M15 entry detector.
 *
 * It deliberately has a first-class WAIT state. Direction requires independent
 * H1 slope and structure agreement; M15 only supplies a pullback-resumption
 * entry. This module never opens orders.
 */
export type TrendCandle = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
export type TrendDirection = "long" | "short";
export type TrendDecision =
  | { action: "WAIT"; reason: string }
  | { action: "TRADE"; direction: TrendDirection; entry: number; stop: number; target: number; atrPips: number; slopeAtrPerBar: number; spreadPips: number; decisionTime: string };

const H1_SLOPE_BARS = 48;
const H1_STRUCTURE_BARS = 24;
const M15_PULLBACK_BARS = 8;
// This research variant exits at 1.5R; simulations must preserve this exact
// stop/target geometry for every original, inverse, and random arm.
const TARGET_R = 1.5;

function pip(pair: string) { return pair.endsWith("JPY") ? 0.01 : 0.0001; }
function spreadCap(pair: string) { return pair.endsWith("JPY") ? 3 : 2; }
function ema(values: number[], period: number) {
  if (!values.length) return [] as number[];
  const k = 2 / (period + 1); const out = [values[0]!];
  for (let index = 1; index < values.length; index++) out.push(values[index]! * k + out[index - 1]! * (1 - k));
  return out;
}
function atr(bars: TrendCandle[], period: number) {
  const out = new Array<number>(bars.length).fill(Number.NaN); let value = 0;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!; const previous = bars[index - 1];
    const tr = previous ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close)) : bar.high - bar.low;
    if (index < period) { value += tr; if (index === period - 1) out[index] = value / period; }
    else { value = ((out[index - 1] as number) * (period - 1) + tr) / period; out[index] = value; }
  }
  return out;
}
function slope(values: number[]) {
  const meanX = (values.length - 1) / 2; const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0; let denominator = 0;
  for (let index = 0; index < values.length; index++) { numerator += (index - meanX) * (values[index]! - meanY); denominator += (index - meanX) ** 2; }
  return denominator ? numerator / denominator : 0;
}
function etMinutes(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

export function detectTrendDirectionV1(pair: string, m15: TrendCandle[], h1: TrendCandle[]): TrendDecision {
  if (m15.length < 60 || h1.length < H1_SLOPE_BARS + 2) return { action: "WAIT", reason: "insufficient completed candles" };
  const current = m15.at(-1)!;
  if (etMinutes(current.closeTime) < 3 * 60 || etMinutes(current.closeTime) >= 16 * 60 + 45) return { action: "WAIT", reason: "outside day-trading session" };

  const h1Atr = atr(h1, 14).at(-1)!;
  if (!Number.isFinite(h1Atr) || h1Atr <= 0) return { action: "WAIT", reason: "H1 ATR unavailable" };
  const h1Closes = h1.map((bar) => bar.close); const h1Ema21 = ema(h1Closes, 21).at(-1)!; const h1Ema50 = ema(h1Closes, 50).at(-1)!;
  const normalizedSlope = slope(h1Closes.slice(-H1_SLOPE_BARS)) / h1Atr;
  const structure = h1.slice(-H1_STRUCTURE_BARS); const previous = structure.slice(0, H1_STRUCTURE_BARS / 2); const recent = structure.slice(H1_STRUCTURE_BARS / 2);
  const higherHigh = Math.max(...recent.map((bar) => bar.high)) > Math.max(...previous.map((bar) => bar.high));
  const higherLow = Math.min(...recent.map((bar) => bar.low)) > Math.min(...previous.map((bar) => bar.low));
  const lowerLow = Math.min(...recent.map((bar) => bar.low)) < Math.min(...previous.map((bar) => bar.low));
  const lowerHigh = Math.max(...recent.map((bar) => bar.high)) < Math.max(...previous.map((bar) => bar.high));
  const h1Long = normalizedSlope >= 0.05 && higherHigh && higherLow && h1Ema21 > h1Ema50 && h1.at(-1)!.close > h1Ema21;
  const h1Short = normalizedSlope <= -0.05 && lowerLow && lowerHigh && h1Ema21 < h1Ema50 && h1.at(-1)!.close < h1Ema21;
  if (!h1Long && !h1Short) return { action: "WAIT", reason: "H1 slope and structure do not agree" };

  const m15Atr = atr(m15, 14).at(-1)!; const unit = pip(pair); const atrPips = m15Atr / unit;
  if (!Number.isFinite(m15Atr) || atrPips < 2) return { action: "WAIT", reason: "M15 volatility is too low" };
  const spreadPips = (current.askClose - current.bidClose) / unit;
  if (!Number.isFinite(spreadPips) || spreadPips > spreadCap(pair)) return { action: "WAIT", reason: "spread too wide" };
  const m15Ema21 = ema(m15.map((bar) => bar.close), 21).at(-1)!; const prior = m15.slice(-1 - M15_PULLBACK_BARS, -1); const previousBar = prior.at(-1)!;
  const pullbackTouched = h1Long ? Math.min(...prior.map((bar) => bar.low)) <= m15Ema21 : Math.max(...prior.map((bar) => bar.high)) >= m15Ema21;
  const resumes = h1Long ? current.close > current.open && current.close > previousBar.high && current.close > m15Ema21 : current.close < current.open && current.close < previousBar.low && current.close < m15Ema21;
  if (!pullbackTouched || !resumes) return { action: "WAIT", reason: "M15 pullback did not resume" };
  if (Math.abs(current.close - m15Ema21) > 1.5 * m15Atr) return { action: "WAIT", reason: "M15 entry is extended" };

  const direction: TrendDirection = h1Long ? "long" : "short";
  const entry = direction === "long" ? current.askClose : current.bidClose;
  const swing = direction === "long" ? Math.min(...prior.map((bar) => bar.low)) : Math.max(...prior.map((bar) => bar.high));
  const rawStop = direction === "long" ? swing - 0.2 * m15Atr : swing + 0.2 * m15Atr;
  const minDistance = 0.8 * m15Atr; const stop = direction === "long" ? Math.min(rawStop, entry - minDistance) : Math.max(rawStop, entry + minDistance);
  const risk = Math.abs(entry - stop); const target = direction === "long" ? entry + TARGET_R * risk : entry - TARGET_R * risk;
  return { action: "TRADE", direction, entry, stop, target, atrPips, slopeAtrPerBar: normalizedSlope, spreadPips, decisionTime: current.closeTime };
}
