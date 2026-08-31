/**
 * h1-next-candle-v1 — candle typing, shapes, and feature extraction.
 * All features at target index T use only completed bars with index < T.
 */
import type { Bar } from "../h1-direction-v1/data.js";
import { atrSeries, emaSeries, percentileRank, swingPoints } from "../h1-direction-v1/indicators.js";

export type CandleClass = "STRONG_BULL" | "BULL" | "DOJI" | "BEAR" | "STRONG_BEAR";
export type SimpleDir = "UP" | "DOWN" | "TIE";
export type VolRegime = "LOW_VOLATILITY" | "NORMAL_VOLATILITY" | "HIGH_VOLATILITY" | "EXPANDING" | "CONTRACTING";

export type CandleRecord = {
  index: number;
  iso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  body: number;
  bodyAtr: number;
  range: number;
  rangeAtr: number;
  upperWick: number;
  lowerWick: number;
  upperWickPct: number;
  lowerWickPct: number;
  bodyRangePct: number;
  closeLocation: number;
  cls: CandleClass;
  simple: SimpleDir;
  atr: number;
};

export type ShapeFlags = {
  strongBullBody: boolean;
  strongBearBody: boolean;
  longUpperWick: boolean;
  longLowerWick: boolean;
  doji: boolean;
  insideBar: boolean;
  outsideBar: boolean;
  bullishEngulfing: boolean;
  bearishEngulfing: boolean;
  narrowRange: boolean;
  wideRange: boolean;
};

export type ContextFeatures = {
  prev1: SimpleDir;
  prev2: SimpleDir;
  prev3: SimpleDir;
  prev5: SimpleDir[];
  bullCount3: number;
  bullCount5: number;
  bullCount10: number;
  ret1h: number;
  ret3h: number;
  ret5h: number;
  ret10h: number;
  bullStreak: number;
  bearStreak: number;
  volRegime: VolRegime;
  range20Loc: number;
  distSwingHighAtr: number;
  distSwingLowAtr: number;
  distEma20Atr: number;
  hourUtc: number;
  hourNy: number;
  weekday: number;
  session: string;
  shapes: ShapeFlags;
  prevCls: CandleClass;
  seq2: string;
  seq3: string;
};

const WARMUP = 250;
const SWING_K = 3;

export function minWarmup(): number {
  return WARMUP;
}

export function classifyCandle(open: number, close: number, bodyAtr: number): { cls: CandleClass; simple: SimpleDir } {
  if (bodyAtr < 0.10) return { cls: "DOJI", simple: close > open ? "UP" : close < open ? "DOWN" : "TIE" };
  if (close > open) return bodyAtr >= 0.50 ? { cls: "STRONG_BULL", simple: "UP" } : { cls: "BULL", simple: "UP" };
  if (close < open) return bodyAtr >= 0.50 ? { cls: "STRONG_BEAR", simple: "DOWN" } : { cls: "BEAR", simple: "DOWN" };
  return { cls: "DOJI", simple: "TIE" };
}

export function buildCandleRecords(bars: Bar[]): CandleRecord[] {
  const atrs = atrSeries(bars, 14);
  return bars.map((b, index) => {
    const body = b.close - b.open;
    const range = Math.max(1e-12, b.high - b.low);
    const atr = atrs[index] ?? 0;
    const bodyAtr = atr > 0 ? Math.abs(body) / atr : 0;
    const upperWick = b.high - Math.max(b.open, b.close);
    const lowerWick = Math.min(b.open, b.close) - b.low;
    const { cls, simple } = classifyCandle(b.open, b.close, bodyAtr);
    return {
      index, iso: b.iso, open: b.open, high: b.high, low: b.low, close: b.close,
      body, bodyAtr, range, rangeAtr: atr > 0 ? range / atr : 0,
      upperWick, lowerWick,
      upperWickPct: upperWick / range,
      lowerWickPct: lowerWick / range,
      bodyRangePct: Math.abs(body) / range,
      closeLocation: (b.close - b.low) / range,
      cls, simple, atr,
    };
  });
}

function shapesFor(records: CandleRecord[], i: number): ShapeFlags {
  const c = records[i]!;
  const p = i > 0 ? records[i - 1] : null;
  const pp = i > 1 ? records[i - 2] : null;
  const insideBar = !!(p && pp && p.high <= pp.high && p.low >= pp.low);
  const outsideBar = !!(p && pp && p.high > pp.high && p.low < pp.low);
  const bullishEngulfing = !!(p && pp && p.simple === "UP" && pp.simple === "DOWN"
    && p.open <= pp.close && p.close >= pp.open);
  const bearishEngulfing = !!(p && pp && p.simple === "DOWN" && pp.simple === "UP"
    && p.open >= pp.close && p.close <= pp.open);
  return {
    strongBullBody: c.cls === "STRONG_BULL",
    strongBearBody: c.cls === "STRONG_BEAR",
    longUpperWick: c.upperWickPct >= 0.45,
    longLowerWick: c.lowerWickPct >= 0.45,
    doji: c.cls === "DOJI",
    insideBar,
    outsideBar,
    bullishEngulfing,
    bearishEngulfing,
    narrowRange: c.rangeAtr < 0.50,
    wideRange: c.rangeAtr >= 1.20,
  };
}

function volRegime(atrs: number[], i: number): VolRegime {
  const pct = percentileRank(atrs, i, 100);
  const prev = percentileRank(atrs, i - 5, 100);
  if (pct >= 0.85) return "HIGH_VOLATILITY";
  if (pct <= 0.15) return "LOW_VOLATILITY";
  if (pct > prev + 0.08) return "EXPANDING";
  if (pct < prev - 0.08) return "CONTRACTING";
  return "NORMAL_VOLATILITY";
}

function hourNy(iso: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso)).find((p) => p.type === "hour")!.value);
}

export function buildContext(records: CandleRecord[], bars: Bar[], targetIndex: number, atrs: number[], ema20: number[]): ContextFeatures | null {
  if (targetIndex < WARMUP || targetIndex >= records.length) return null;
  const prevIdx = targetIndex - 1;
  const dirs = (n: number) => records.slice(Math.max(0, targetIndex - n), targetIndex).map((r) => r.simple);
  const d1 = records[prevIdx]!.simple;
  const d2 = records[targetIndex - 2]?.simple ?? "TIE";
  const d3 = records[targetIndex - 3]?.simple ?? "TIE";
  const last5 = dirs(5);
  const bull = (xs: SimpleDir[]) => xs.filter((x) => x === "UP").length;

  let bullStreak = 0;
  for (let j = prevIdx; j >= 0; j--) {
    if (records[j]!.simple === "UP") bullStreak++;
    else break;
  }
  let bearStreak = 0;
  for (let j = prevIdx; j >= 0; j--) {
    if (records[j]!.simple === "DOWN") bearStreak++;
    else break;
  }

  const ret = (h: number) => {
    const a = records[targetIndex - 1]!;
    const b = records[targetIndex - 1 - h];
    return b ? (a.close - b.close) / Math.max(1e-12, a.atr) : 0;
  };

  const window20 = records.slice(Math.max(0, targetIndex - 20), targetIndex);
  const hi20 = Math.max(...window20.map((r) => r.high));
  const lo20 = Math.min(...window20.map((r) => r.low));
  const prevClose = records[prevIdx]!.close;
  const range20Loc = hi20 === lo20 ? 0.5 : (prevClose - lo20) / (hi20 - lo20);

  const swings = swingPoints(bars, SWING_K).filter((s) => s.index + SWING_K < targetIndex);
  const lastHigh = swings.filter((s) => s.kind === "high").at(-1)?.price ?? prevClose;
  const lastLow = swings.filter((s) => s.kind === "low").at(-1)?.price ?? prevClose;
  const atr = records[prevIdx]!.atr;

  const seq2 = `${d2}-${d1}`.replace(/TIE/g, "D");
  const seq3 = `${records[targetIndex - 3]?.simple ?? "D"}-${d2}-${d1}`.replace(/TIE/g, "D");

  return {
    prev1: d1, prev2: d2, prev3: d3, prev5: last5,
    bullCount3: bull(dirs(3)), bullCount5: bull(dirs(5)), bullCount10: bull(dirs(10)),
    ret1h: ret(1), ret3h: ret(3), ret5h: ret(5), ret10h: ret(10),
    bullStreak, bearStreak,
    volRegime: volRegime(atrs, prevIdx),
    range20Loc,
    distSwingHighAtr: atr > 0 ? (lastHigh - prevClose) / atr : 0,
    distSwingLowAtr: atr > 0 ? (prevClose - lastLow) / atr : 0,
    distEma20Atr: atr > 0 ? (prevClose - ema20[prevIdx]!) / atr : 0,
    hourUtc: new Date(bars[targetIndex]!.iso).getUTCHours(),
    hourNy: hourNy(bars[targetIndex]!.iso),
    weekday: new Date(bars[targetIndex]!.iso).getUTCDay(),
    session: (() => {
      const h = new Date(bars[targetIndex]!.iso).getUTCHours();
      if (h >= 12 && h < 16) return "London/NY overlap";
      if (h >= 7 && h < 12) return "London";
      if (h >= 16 && h < 21) return "New York";
      return "Asia";
    })(),
    shapes: shapesFor(records, prevIdx),
    prevCls: records[prevIdx]!.cls,
    seq2, seq3,
  };
}

export function dirLabel(d: SimpleDir): string {
  if (d === "UP") return "BULL";
  if (d === "DOWN") return "BEAR";
  return "DOJI";
}

export function clsLabel(c: CandleClass): string {
  return c.replace("_", " ");
}
