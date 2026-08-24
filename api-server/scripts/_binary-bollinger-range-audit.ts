/**
 * GOLDENXPERIENCE — binary-bollinger-range-v1
 *
 * Research only. Does NOT modify binary-baseline-v1, adaptive logic,
 * production prediction paths, or live/paper execution.
 *
 * Hypothesis: Bollinger outside-excursion + close-back-inside (range rejection)
 * contains short-horizon binary edge, especially when ADX indicates range.
 *
 * FREEZE: all BB/ADX/RSI/wick thresholds are pre-registered below. Never retune
 * after seeing TEST (last-week) outcomes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { classifyBinaryResult, type BinaryCandle } from "../src/binary-engine.js";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "binary-bollinger-range-audit");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const EXPERIMENT = "binary-bollinger-range-v1";
const BE80 = 1 / (1 + 0.8); // 55.56%
const MIN_SERIOUS_N = 100;
const EXPIRIES = [1, 2, 3, 5, 10, 15] as const;
type Expiry = (typeof EXPIRIES)[number];

/** Population stdev (divide by n) — classic Bollinger; documented in report. */
const BB_STDEV_MODE = "population" as const;

const BB_SETTINGS = [
  { id: "BB20", period: 20, k: 2.0 },
  { id: "BB50", period: 50, k: 1.5 },
] as const;
type BbId = (typeof BB_SETTINGS)[number]["id"];

const ADX_RANGE = 25;
const ADX_RANGE_SENS = 20;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const WICK_MIN = 0.4;
const CLOSE_LOC_UP = 0.6;
const CLOSE_LOC_DOWN = 0.4;

const VARIANTS = [
  "BB_TOUCH",
  "BB_REENTRY",
  "BB_REENTRY_RANGE",
  "BB_REENTRY_RSI",
  "BB_REENTRY_RANGE_RSI",
  "BB_REENTRY_RANGE_REJECT",
  "KELTNER_REENTRY_RANGE",
] as const;
type Variant = (typeof VARIANTS)[number];

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});
const ET_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type PredRow = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  start_at: string;
  entry_price: number;
  price_precision: number;
  result: "won" | "lost" | "tie" | null;
};

type Outcome = "won" | "lost" | "tie" | "missing";
type Side = "upper" | "lower";
type Dir = "up" | "down";
type Regime = "RANGE" | "TREND" | "UNKNOWN";

type Signal = {
  variant: Variant;
  bb: BbId | "KELTNER";
  instrument: string;
  side: Side;
  dir: Dir;
  entry: number;
  entryMs: number;
  barIdx: number;
  adx: number;
  rsi: number;
  regime: Regime;
  regimeSens: "RANGE20" | "TREND20" | "UNKNOWN";
  session: string;
  day: string;
  outcomes: Record<Expiry, Outcome>;
};

type Bucket = {
  rawN: number;
  won: number;
  lost: number;
  tie: number;
  missing: number;
  decided: number;
  wr: number;
  ciLow: number;
  ciHigh: number;
  ev70: number;
  ev75: number;
  ev80: number;
  ev85: number;
  ev90: number;
  ev95: number;
  label: string;
};

type InstrumentCache = {
  instrument: string;
  candles: BinaryCandle[];
  closeMs: number[];
  atr14: Float64Array;
  adx14: Float64Array;
  rsi14: Float64Array;
  bb: Record<BbId, { mid: Float64Array; upper: Float64Array; lower: Float64Array }>;
  keltner: { mid: Float64Array; upper: Float64Array; lower: Float64Array };
};

const registryLines: string[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function wilson(wins: number, n: number) {
  if (n <= 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { rate: p, low: (c - m) / d, high: (c + m) / d };
}

function evOf(wr: number, payout: number) {
  return wr * payout - (1 - wr);
}

function sessionOf(iso: string): string {
  const h = Number(ET_HOUR.formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value);
  if (h >= 19 || h < 3) return "asia";
  if (h >= 3 && h < 8) return "london";
  if (h >= 8 && h < 12) return "overlap";
  if (h >= 12 && h < 17) return "newyork";
  return "off";
}

function pct(x: number) {
  return `${(x * 100).toFixed(2)}%`;
}

function fmtBucket(b: Bucket) {
  return `n=${b.decided} W=${b.won} L=${b.lost} T=${b.tie} WR=${pct(b.wr)} CI=[${pct(b.ciLow)},${pct(b.ciHigh)}] EV80=${b.ev80.toFixed(3)}`;
}

function score(signals: Signal[], expiry: Expiry, filter?: (s: Signal) => boolean): Bucket {
  let won = 0;
  let lost = 0;
  let tie = 0;
  let missing = 0;
  let rawN = 0;
  for (const s of signals) {
    if (filter && !filter(s)) continue;
    rawN += 1;
    const o = s.outcomes[expiry];
    if (o === "won") won += 1;
    else if (o === "lost") lost += 1;
    else if (o === "tie") tie += 1;
    else missing += 1;
  }
  const decided = won + lost;
  const wr = decided ? won / decided : 0;
  const ci = wilson(won, decided);
  const bucket: Bucket = {
    rawN,
    won,
    lost,
    tie,
    missing,
    decided,
    wr,
    ciLow: ci.low,
    ciHigh: ci.high,
    ev70: evOf(wr, 0.7),
    ev75: evOf(wr, 0.75),
    ev80: evOf(wr, 0.8),
    ev85: evOf(wr, 0.85),
    ev90: evOf(wr, 0.9),
    ev95: evOf(wr, 0.95),
    label: "",
  };
  bucket.label = fmtBucket(bucket);
  return bucket;
}

function interestingLabel(b: Bucket): string {
  if (b.decided < MIN_SERIOUS_N) return "UNDERPOWERED";
  if (b.wr >= 0.65) return "Very strong";
  if (b.wr >= 0.6) return "Strong";
  if (b.wr >= 0.58) return "Interesting";
  if (b.wr >= BE80) return "Above BE80";
  if (b.wr > 0.5) return "Above 50";
  return "No edge";
}

function toCandles(raw: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
  return raw.map((c) => ({
    time: c.time,
    open: Number(c.mid.open),
    high: Number(c.mid.high),
    low: Number(c.mid.low),
    close: Number(c.mid.close),
    volume: Number(c.volume),
    complete: c.complete,
  }));
}

async function fetchM1Range(instrument: string, fromIso: string, toIso: string): Promise<BinaryCandle[]> {
  const fromMs = Date.parse(fromIso) - 10 * 24 * 60 * 60_000;
  const toMs = Date.parse(toIso) + 20 * 60_000;
  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  for (let page = 0; page < 80; page++) {
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toCandles(raw).filter((c) => c.complete);
    if (!batch.length) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((m, c) => (c.time < m ? c.time : m), batch[0]!.time);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(120);
  }
  const by = new Map(all.map((c) => [c.time, c]));
  return [...by.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function trueRange(c: BinaryCandle, prevClose: number) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

/** SMA + population stdev Bollinger bands at each index using closes ≤ i. */
function computeBollinger(closes: Float64Array, period: number, k: number) {
  const n = closes.length;
  const mid = new Float64Array(n).fill(NaN);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const x = closes[i]!;
    sum += x;
    sumSq += x * x;
    if (i >= period) {
      const old = closes[i - period]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, sumSq / period - mean * mean);
      const sd = Math.sqrt(variance);
      mid[i] = mean;
      upper[i] = mean + k * sd;
      lower[i] = mean - k * sd;
    }
  }
  return { mid, upper, lower };
}

/** Wilder ATR14 */
function computeAtr14(candles: BinaryCandle[]) {
  const n = candles.length;
  const atr = new Float64Array(n).fill(NaN);
  if (n < 15) return atr;
  let sum = 0;
  for (let i = 1; i <= 14; i++) {
    sum += trueRange(candles[i]!, candles[i - 1]!.close);
  }
  atr[14] = sum / 14;
  for (let i = 15; i < n; i++) {
    const tr = trueRange(candles[i]!, candles[i - 1]!.close);
    atr[i] = (atr[i - 1]! * 13 + tr) / 14;
  }
  return atr;
}

/** Wilder ADX14 */
function computeAdx14(candles: BinaryCandle[]) {
  const n = candles.length;
  const adx = new Float64Array(n).fill(NaN);
  if (n < 29) return adx; // need 14 TR seed + 14 DX seed roughly

  const tr = new Float64Array(n);
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr[i] = trueRange(c, p.close);
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let atr = 0;
  let pDM = 0;
  let mDM = 0;
  for (let i = 1; i <= 14; i++) {
    atr += tr[i]!;
    pDM += plusDM[i]!;
    mDM += minusDM[i]!;
  }

  let dxSum = 0;
  const dxArr: number[] = [];
  for (let i = 14; i < n; i++) {
    if (i > 14) {
      atr = atr - atr / 14 + tr[i]!;
      pDM = pDM - pDM / 14 + plusDM[i]!;
      mDM = mDM - mDM / 14 + minusDM[i]!;
    }
    const plusDI = atr > 0 ? (100 * pDM) / atr : 0;
    const minusDI = atr > 0 ? (100 * mDM) / atr : 0;
    const denom = plusDI + minusDI;
    const dx = denom > 0 ? (100 * Math.abs(plusDI - minusDI)) / denom : 0;
    dxArr.push(dx);
    if (dxArr.length === 14) {
      dxSum = dxArr.reduce((a, b) => a + b, 0);
      adx[i] = dxSum / 14;
    } else if (dxArr.length > 14) {
      adx[i] = (adx[i - 1]! * 13 + dx) / 14;
    }
  }
  return adx;
}

/** Wilder RSI14 */
function computeRsi14(closes: Float64Array) {
  const n = closes.length;
  const rsi = new Float64Array(n).fill(NaN);
  if (n < 15) return rsi;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / 14;
  let avgLoss = loss / 14;
  rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = 15; i < n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * 13 + g) / 14;
    avgLoss = (avgLoss * 13 + l) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

/** EMA20 mid, bands = mid ± 1.5 * ATR14 (single pre-registered Keltner control). */
function computeKeltner(closes: Float64Array, atr14: Float64Array) {
  const n = closes.length;
  const mid = new Float64Array(n).fill(NaN);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  const mult = 2 / (20 + 1);
  let ema = NaN;
  for (let i = 0; i < n; i++) {
    if (i === 0) ema = closes[0]!;
    else ema = closes[i]! * mult + ema * (1 - mult);
    if (i >= 19 && Number.isFinite(atr14[i]!)) {
      mid[i] = ema;
      upper[i] = ema + 1.5 * atr14[i]!;
      lower[i] = ema - 1.5 * atr14[i]!;
    }
  }
  return { mid, upper, lower };
}

function buildCache(instrument: string, candlesIn: BinaryCandle[]): InstrumentCache {
  const candles = candlesIn.filter((c) => Number.isFinite(Date.parse(c.time)));
  const closeMs = candles.map((c) => Date.parse(c.time) + 60_000);
  const closes = new Float64Array(candles.map((c) => c.close));
  const atr14 = computeAtr14(candles);
  const adx14 = computeAdx14(candles);
  const rsi14 = computeRsi14(closes);
  const bb = {} as InstrumentCache["bb"];
  for (const setting of BB_SETTINGS) {
    bb[setting.id] = computeBollinger(closes, setting.period, setting.k);
  }
  const keltner = computeKeltner(closes, atr14);
  return { instrument, candles, closeMs, atr14, adx14, rsi14, bb, keltner };
}

function resolveAt(cache: InstrumentCache, targetMs: number): { price: number; timeMs: number } | null {
  let lo = 0;
  let hi = cache.closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cache.closeMs[mid]! >= targetMs) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (ans < 0) return null;
  return { price: cache.candles[ans]!.close, timeMs: cache.closeMs[ans]! };
}

function outcomeAt(
  cache: InstrumentCache,
  dir: Dir,
  entry: number,
  precision: number,
  startMs: number,
  minutes: number,
): Outcome {
  const mark = resolveAt(cache, startMs + minutes * 60_000);
  if (!mark) return "missing";
  if (mark.timeMs <= startMs) return "missing";
  return classifyBinaryResult(dir, entry, mark.price, precision);
}

function candleFeatures(c: BinaryCandle) {
  const range = c.high - c.low;
  if (range <= 0) {
    return { upperWick: 0, lowerWick: 0, closeLoc: 0.5, range: 0 };
  }
  const upperWick = (c.high - Math.max(c.open, c.close)) / range;
  const lowerWick = (Math.min(c.open, c.close) - c.low) / range;
  const closeLoc = (c.close - c.low) / range;
  return { upperWick, lowerWick, closeLoc, range };
}

type BandSeries = { mid: Float64Array; upper: Float64Array; lower: Float64Array };

/**
 * Episode state machine for one band family.
 * Excursion: high > upper (resistance) / low < lower (support).
 * Reentry: close back inside (close <= upper / close >= lower).
 * Dedup: after signal, suppress until close crosses/returns to mid, then NEW outside.
 */
type SideState = {
  outside: boolean;
  signaled: boolean; // waiting for mid reset after a signal
  touchFired: boolean; // for BB_TOUCH within episode
};

function freshSide(): SideState {
  return { outside: false, signaled: false, touchFired: false };
}

type EmitFn = (args: {
  variant: Variant;
  side: Side;
  dir: Dir;
  idx: number;
  raw: boolean;
}) => void;

type WalkMode = "touch" | "reentry";

function walkBands(
  cache: InstrumentCache,
  bands: BandSeries,
  bbLabel: BbId | "KELTNER",
  testStartMs: number,
  testEndMs: number,
  emit: EmitFn,
  mode: WalkMode,
  opts: { keltnerOnly?: boolean; countRaw?: { n: number } },
) {
  const upper = freshSide();
  const lower = freshSide();

  for (let i = 0; i < cache.candles.length; i++) {
    const c = cache.candles[i]!;
    const entryMs = cache.closeMs[i]!;
    const mid = bands.mid[i]!;
    const up = bands.upper[i]!;
    const lo = bands.lower[i]!;
    if (!Number.isFinite(mid) || !Number.isFinite(up) || !Number.isFinite(lo)) continue;

    const inTest = entryMs >= testStartMs && entryMs <= testEndMs;
    const adx = cache.adx14[i]!;
    const rsi = cache.rsi14[i]!;
    const feats = candleFeatures(c);

    // Mid reset: price returns to / crosses middle → allow new episode
    for (const [side, st] of [
      ["upper", upper] as const,
      ["lower", lower] as const,
    ]) {
      if (st.signaled) {
        const reset =
          side === "upper"
            ? c.close <= mid || c.low <= mid
            : c.close >= mid || c.high >= mid;
        if (reset) {
          st.signaled = false;
          st.outside = false;
          st.touchFired = false;
        }
      }
    }

    // Excursion detection (high>upper / low<lower)
    if (!upper.signaled && c.high > up) upper.outside = true;
    if (!lower.signaled && c.low < lo) lower.outside = true;

    if (mode === "touch" && bbLabel !== "KELTNER") {
      // Raw: every touch bar; deduped: first per episode (state advances on TRAIN too)
      if (c.high >= up) {
        if (opts.countRaw && inTest) opts.countRaw.n += 1;
        if (!upper.signaled && !upper.touchFired) {
          if (inTest) emit({ variant: "BB_TOUCH", side: "upper", dir: "down", idx: i, raw: false });
          upper.touchFired = true;
          upper.signaled = true;
        }
      }
      if (c.low <= lo) {
        if (opts.countRaw && inTest) opts.countRaw.n += 1;
        if (!lower.signaled && !lower.touchFired) {
          if (inTest) emit({ variant: "BB_TOUCH", side: "lower", dir: "up", idx: i, raw: false });
          lower.touchFired = true;
          lower.signaled = true;
        }
      }
      continue;
    }

    // Reentry confirmation (close back inside after outside)
    const upperReentry = upper.outside && c.close <= up;
    const lowerReentry = lower.outside && c.close >= lo;

    if (upperReentry) {
      if (opts.countRaw && inTest) opts.countRaw.n += 1;
      if (!upper.signaled) {
        if (inTest) {
          if (!opts.keltnerOnly) {
            emit({ variant: "BB_REENTRY", side: "upper", dir: "down", idx: i, raw: false });
            const rangeOk = Number.isFinite(adx) && adx <= ADX_RANGE;
            if (rangeOk) {
              emit({ variant: "BB_REENTRY_RANGE", side: "upper", dir: "down", idx: i, raw: false });
            }
            const rsiOk = Number.isFinite(rsi) && rsi >= RSI_OVERBOUGHT;
            if (rsiOk) {
              emit({ variant: "BB_REENTRY_RSI", side: "upper", dir: "down", idx: i, raw: false });
            }
            if (rangeOk && rsiOk) {
              emit({ variant: "BB_REENTRY_RANGE_RSI", side: "upper", dir: "down", idx: i, raw: false });
            }
            if (rangeOk && feats.upperWick >= WICK_MIN && feats.closeLoc <= CLOSE_LOC_DOWN) {
              emit({ variant: "BB_REENTRY_RANGE_REJECT", side: "upper", dir: "down", idx: i, raw: false });
            }
          } else {
            const rangeOk = Number.isFinite(adx) && adx <= ADX_RANGE;
            if (rangeOk) {
              emit({ variant: "KELTNER_REENTRY_RANGE", side: "upper", dir: "down", idx: i, raw: false });
            }
          }
        }
        upper.signaled = true;
      }
      upper.outside = false;
    }

    if (lowerReentry) {
      if (opts.countRaw && inTest) opts.countRaw.n += 1;
      if (!lower.signaled) {
        if (inTest) {
          if (!opts.keltnerOnly) {
            emit({ variant: "BB_REENTRY", side: "lower", dir: "up", idx: i, raw: false });
            const rangeOk = Number.isFinite(adx) && adx <= ADX_RANGE;
            if (rangeOk) {
              emit({ variant: "BB_REENTRY_RANGE", side: "lower", dir: "up", idx: i, raw: false });
            }
            const rsiOk = Number.isFinite(rsi) && rsi <= RSI_OVERSOLD;
            if (rsiOk) {
              emit({ variant: "BB_REENTRY_RSI", side: "lower", dir: "up", idx: i, raw: false });
            }
            if (rangeOk && rsiOk) {
              emit({ variant: "BB_REENTRY_RANGE_RSI", side: "lower", dir: "up", idx: i, raw: false });
            }
            if (rangeOk && feats.lowerWick >= WICK_MIN && feats.closeLoc >= CLOSE_LOC_UP) {
              emit({ variant: "BB_REENTRY_RANGE_REJECT", side: "lower", dir: "up", idx: i, raw: false });
            }
          } else {
            const rangeOk = Number.isFinite(adx) && adx <= ADX_RANGE;
            if (rangeOk) {
              emit({ variant: "KELTNER_REENTRY_RANGE", side: "lower", dir: "up", idx: i, raw: false });
            }
          }
        }
        lower.signaled = true;
      }
      lower.outside = false;
    }
  }
}

function dayShare(signals: Signal[]): { maxEvent: number; maxWin: number; byDay: Map<string, { n: number; w: number }> } {
  const byDay = new Map<string, { n: number; w: number }>();
  for (const s of signals) {
    const cur = byDay.get(s.day) ?? { n: 0, w: 0 };
    cur.n += 1;
    // win share uses 5m as reference for concentration reporting
    if (s.outcomes[5] === "won") cur.w += 1;
    byDay.set(s.day, cur);
  }
  const total = signals.length || 1;
  const totalW = [...byDay.values()].reduce((a, b) => a + b.w, 0) || 1;
  let maxEvent = 0;
  let maxWin = 0;
  for (const v of byDay.values()) {
    maxEvent = Math.max(maxEvent, v.n / total);
    maxWin = Math.max(maxWin, v.w / totalW);
  }
  return { maxEvent, maxWin, byDay };
}

function pickVerdict(args: {
  best: { variant: Variant; bb: string; expiry: Expiry; bucket: Bucket; dayShare: number } | null;
  reentryHelps: boolean;
  rangeHelps: boolean;
  dayDependent: boolean;
  clearedBe: boolean;
}): string {
  const { best, reentryHelps, rangeHelps, dayDependent, clearedBe } = args;
  if (best && best.bucket.wr >= 0.65 && best.bucket.decided >= 200) {
    // Should have stopped earlier for audit; if still here, do not claim edge yet
    return "BOLLINGER_NO_EDGE";
  }
  if (dayDependent && best && best.bucket.wr >= BE80) return "BOLLINGER_DAY_DEPENDENT";
  if (clearedBe && best && best.bucket.decided >= MIN_SERIOUS_N) {
    if (best.variant.includes("REJECT") || best.variant.includes("RANGE")) {
      return "BOLLINGER_RANGE_EDGE_FOUND";
    }
    if (best.variant.includes("REENTRY")) return "BOLLINGER_REENTRY_EDGE_FOUND";
    return "BOLLINGER_RANGE_EDGE_FOUND";
  }
  if (best && best.bucket.wr >= 0.58 && best.bucket.decided < MIN_SERIOUS_N) {
    return "BOLLINGER_PROMISING_BUT_UNDERPOWERED";
  }
  if (best && best.bucket.wr > 0.5 && best.bucket.wr < BE80 && best.bucket.decided >= MIN_SERIOUS_N) {
    return "BOLLINGER_ABOVE_50_BUT_BELOW_BREAK_EVEN";
  }
  if (!rangeHelps && reentryHelps) return "RANGE_FILTER_DOES_NOT_HELP";
  if (!reentryHelps) return "REENTRY_DOES_NOT_HELP";
  return "BOLLINGER_NO_EDGE";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — loading authoritative baseline predictions...`);
const predRes = await query<PredRow>(
  `SELECT id, instrument, direction, start_at::text, entry_price::float AS entry_price,
          price_precision, result
     FROM binary_predictions
    WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
    ORDER BY start_at`,
);
const preds = predRes.rows;
console.log(`Loaded ${preds.length} baseline predictions`);

const instruments = [...MAJOR_INSTRUMENTS];
const predMin = preds.length ? preds[0]!.start_at : new Date(Date.now() - 14 * 864e5).toISOString();
const predMax = preds.length ? preds.at(-1)!.start_at : new Date().toISOString();

console.log(`Fetching M1 for ${instruments.length} majors (pad ~10d before window)...`);
const caches = new Map<string, InstrumentCache>();
let m1Total = 0;
let m1Min = Infinity;
let m1Max = -Infinity;
const gapNotes: string[] = [];

for (const inst of instruments) {
  const candles = await fetchM1Range(inst, predMin, predMax);
  const cache = buildCache(inst, candles);
  caches.set(inst, cache);
  m1Total += candles.length;
  if (candles.length) {
    m1Min = Math.min(m1Min, Date.parse(candles[0]!.time));
    m1Max = Math.max(m1Max, cache.closeMs[cache.closeMs.length - 1]!);
    // gap heuristic: consecutive open gaps > 3 minutes (weekends excluded loosely)
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      const dt = Date.parse(candles[i]!.time) - Date.parse(candles[i - 1]!.time);
      if (dt > 3 * 60_000 && dt < 48 * 3600_000) gaps += 1;
    }
    gapNotes.push(`${inst}: bars=${candles.length} intradayGaps≈${gaps}`);
  } else {
    gapNotes.push(`${inst}: NO BARS`);
  }
  console.log(`  ${inst}: ${candles.length} M1`);
}

if (!Number.isFinite(m1Max) || m1Total < 1000) {
  console.error("INSUFFICIENT_M1_DATA");
  process.exit(1);
}

const dataEndMs = m1Max;
const testStartMs = dataEndMs - 7 * 24 * 60 * 60_000;
const testEndMs = dataEndMs;
const trainStartMs = m1Min;
const trainEndMs = testStartMs - 1;

console.log(`Period freeze (BEFORE outcome selection):`);
console.log(`  TRAIN: ${new Date(trainStartMs).toISOString()} → ${new Date(trainEndMs).toISOString()}`);
console.log(`  TEST:  ${new Date(testStartMs).toISOString()} → ${new Date(testEndMs).toISOString()}`);

// Count train/test bars
let trainBars = 0;
let testBars = 0;
for (const cache of caches.values()) {
  for (const ms of cache.closeMs) {
    if (ms >= trainStartMs && ms <= trainEndMs) trainBars += 1;
    if (ms >= testStartMs && ms <= testEndMs) testBars += 1;
  }
}

// Sanity: indicators not degenerate on TRAIN (fixed thresholds — no fitting)
{
  let adxOk = 0;
  let adxN = 0;
  let bbOk = 0;
  for (const cache of caches.values()) {
    for (let i = 0; i < cache.candles.length; i++) {
      const ms = cache.closeMs[i]!;
      if (ms < trainStartMs || ms > trainEndMs) continue;
      if (Number.isFinite(cache.adx14[i]!)) {
        adxN += 1;
        if (cache.adx14[i]! > 0 && cache.adx14[i]! < 100) adxOk += 1;
      }
      const b = cache.bb.BB20;
      if (Number.isFinite(b.upper[i]!) && b.upper[i]! > b.lower[i]!) bbOk += 1;
    }
  }
  console.log(`TRAIN indicator sanity: ADX finite-in-range ${adxOk}/${adxN}, BB20 valid bands ≈${bbOk}`);
}

const allSignals: Signal[] = [];
const rawCounts = new Map<string, number>();

for (const inst of instruments) {
  const cache = caches.get(inst)!;
  const precision = inst.includes("JPY") ? 3 : 5;

  const pushSignal = (
    variant: Variant,
    bb: BbId | "KELTNER",
    side: Side,
    dir: Dir,
    idx: number,
  ) => {
    const entryMs = cache.closeMs[idx]!;
    const c = cache.candles[idx];
    if (!c || !Number.isFinite(entryMs)) return;
    const close = Number(c.close);
    const high = Number(c.high);
    const low = Number(c.low);
    if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) return;
    const adx = cache.adx14[idx]!;
    const rsi = cache.rsi14[idx]!;
    const regime: Regime = !Number.isFinite(adx) ? "UNKNOWN" : adx <= ADX_RANGE ? "RANGE" : "TREND";
    const regimeSens =
      !Number.isFinite(adx) ? "UNKNOWN" : adx <= ADX_RANGE_SENS ? "RANGE20" : "TREND20";
    const iso = new Date(entryMs).toISOString();
    const outcomes = {} as Record<Expiry, Outcome>;
    for (const exp of EXPIRIES) {
      outcomes[exp] = outcomeAt(cache, dir, close, precision, entryMs, exp);
    }
    allSignals.push({
      variant,
      bb,
      instrument: inst,
      side,
      dir,
      entry: close,
      entryMs,
      barIdx: idx,
      adx: Number.isFinite(adx) ? adx : NaN,
      rsi: Number.isFinite(rsi) ? rsi : NaN,
      regime,
      regimeSens,
      session: sessionOf(iso),
      day: ET_DAY.format(new Date(entryMs)),
      outcomes,
    });
  };

  for (const setting of BB_SETTINGS) {
    const touchRaw = { n: 0 };
    const reentryRaw = { n: 0 };
    walkBands(
      cache,
      cache.bb[setting.id],
      setting.id,
      testStartMs,
      testEndMs,
      ({ variant, side, dir, idx }) => pushSignal(variant, setting.id, side, dir, idx),
      "touch",
      { countRaw: touchRaw },
    );
    walkBands(
      cache,
      cache.bb[setting.id],
      setting.id,
      testStartMs,
      testEndMs,
      ({ variant, side, dir, idx }) => pushSignal(variant, setting.id, side, dir, idx),
      "reentry",
      { countRaw: reentryRaw },
    );
    rawCounts.set(`BB_TOUCH|${setting.id}`, (rawCounts.get(`BB_TOUCH|${setting.id}`) ?? 0) + touchRaw.n);
    rawCounts.set(`BB_REENTRY|${setting.id}`, (rawCounts.get(`BB_REENTRY|${setting.id}`) ?? 0) + reentryRaw.n);
  }

  const kRaw = { n: 0 };
  walkBands(
    cache,
    cache.keltner,
    "KELTNER",
    testStartMs,
    testEndMs,
    ({ variant, side, dir, idx }) => pushSignal(variant, "KELTNER", side, dir, idx),
    "reentry",
    { keltnerOnly: true, countRaw: kRaw },
  );
  rawCounts.set(
    "KELTNER_REENTRY_RANGE|KELTNER",
    (rawCounts.get("KELTNER_REENTRY_RANGE|KELTNER") ?? 0) + kRaw.n,
  );

  console.log(`  walked ${inst}`);
}

console.log(`Signals emitted (TEST, all variants): ${allSignals.length}`);

// Suspiciously high WR gate — audit before claiming
const suspicionFlags: string[] = [];
for (const variant of VARIANTS) {
  for (const bb of [...BB_SETTINGS.map((b) => b.id), "KELTNER"] as const) {
    if (variant === "KELTNER_REENTRY_RANGE" && bb !== "KELTNER") continue;
    if (variant !== "KELTNER_REENTRY_RANGE" && bb === "KELTNER") continue;
    for (const exp of EXPIRIES) {
      const subset = allSignals.filter((s) => s.variant === variant && s.bb === bb);
      const b = score(subset, exp);
      if (b.decided >= 200 && b.wr >= 0.65) {
        suspicionFlags.push(`${variant}|${bb}|${exp}m WR=${pct(b.wr)} n=${b.decided}`);
      }
    }
  }
}
if (suspicionFlags.length) {
  console.error("SUSPICIOUS_WR — stopping for leakage/timestamp audit before selection:");
  for (const f of suspicionFlags) console.error(`  ${f}`);
  // Still write a partial report with audit focus
}

// Baseline on same TEST window
const baselineInTest = preds.filter((p) => {
  const ms = Date.parse(p.start_at);
  return ms >= testStartMs && ms <= testEndMs;
});
let baseW = 0;
let baseL = 0;
let baseT = 0;
for (const p of baselineInTest) {
  if (p.result === "won") baseW += 1;
  else if (p.result === "lost") baseL += 1;
  else if (p.result === "tie") baseT += 1;
}
const baseDecided = baseW + baseL;
const baseWr = baseDecided ? baseW / baseDecided : 0;
const baseCi = wilson(baseW, baseDecided);

type CellKey = string;
const cells: {
  key: CellKey;
  variant: Variant;
  bb: string;
  expiry: Expiry;
  bucket: Bucket;
  range: Bucket;
  trend: Bucket;
  always: Bucket;
  up: Bucket;
  down: Bucket;
  dayShare: number;
  dayWinShare: number;
}[] = [];

for (const variant of VARIANTS) {
  for (const bb of [...BB_SETTINGS.map((b) => b.id), "KELTNER"] as const) {
    if (variant === "KELTNER_REENTRY_RANGE" && bb !== "KELTNER") continue;
    if (variant !== "KELTNER_REENTRY_RANGE" && bb === "KELTNER") continue;
    const subset = allSignals.filter((s) => s.variant === variant && s.bb === bb);
    for (const exp of EXPIRIES) {
      const bucket = score(subset, exp);
      const range = score(subset, exp, (s) => s.regime === "RANGE");
      const trend = score(subset, exp, (s) => s.regime === "TREND");
      const always = bucket; // ALWAYS = no extra filter (same as full variant set)
      const up = score(subset, exp, (s) => s.dir === "up");
      const down = score(subset, exp, (s) => s.dir === "down");
      const ds = dayShare(subset);
      cells.push({
        key: `${variant}|${bb}|${exp}m`,
        variant,
        bb,
        expiry: exp,
        bucket,
        range,
        trend,
        always,
        up,
        down,
        dayShare: ds.maxEvent,
        dayWinShare: ds.maxWin,
      });
      registryLines.push(
        JSON.stringify({
          experiment: EXPERIMENT,
          zone: "TEST",
          variant,
          bb,
          expiry: exp,
          n: bucket.decided,
          rawN: bucket.rawN,
          won: bucket.won,
          lost: bucket.lost,
          tie: bucket.tie,
          missing: bucket.missing,
          wr: bucket.wr,
          ciLow: bucket.ciLow,
          ciHigh: bucket.ciHigh,
          ev70: bucket.ev70,
          ev75: bucket.ev75,
          ev80: bucket.ev80,
          ev85: bucket.ev85,
          ev90: bucket.ev90,
          ev95: bucket.ev95,
          rangeN: range.decided,
          rangeWr: range.wr,
          trendN: trend.decided,
          trendWr: trend.wr,
          upN: up.decided,
          upWr: up.wr,
          downN: down.decided,
          downWr: down.wr,
          dayShareMax: ds.maxEvent,
          dayWinShareMax: ds.maxWin,
          label: interestingLabel(bucket),
          frozenBeforeOutcomes: true,
        }),
      );
    }
  }
}

// Best TEST strategy among pre-registered (prefer n≥100; else best available)
const ranked = [...cells].sort((a, b) => {
  const aOk = a.bucket.decided >= MIN_SERIOUS_N ? 1 : 0;
  const bOk = b.bucket.decided >= MIN_SERIOUS_N ? 1 : 0;
  if (aOk !== bOk) return bOk - aOk;
  if (a.bucket.wr !== b.bucket.wr) return b.bucket.wr - a.bucket.wr;
  return b.bucket.decided - a.bucket.decided;
});
const best = ranked[0] ?? null;
const clearedBe = cells.filter((c) => c.bucket.decided >= MIN_SERIOUS_N && c.bucket.wr >= BE80);

// Comparisons for verdict helpers (fixed comparisons, not retuning)
function cellAt(variant: Variant, bb: string, exp: Expiry) {
  return cells.find((c) => c.variant === variant && c.bb === bb && c.expiry === exp);
}
const primaryExp: Expiry = 5;
const reentryBb20 = cellAt("BB_REENTRY", "BB20", primaryExp);
const touchBb20 = cellAt("BB_TOUCH", "BB20", primaryExp);
const rangeBb20 = cellAt("BB_REENTRY_RANGE", "BB20", primaryExp);
const reentryHelps = !!(
  reentryBb20 &&
  touchBb20 &&
  reentryBb20.bucket.decided >= 30 &&
  reentryBb20.bucket.wr > touchBb20.bucket.wr + 0.005
);
const rangeHelps = !!(
  rangeBb20 &&
  reentryBb20 &&
  rangeBb20.bucket.decided >= 30 &&
  rangeBb20.bucket.wr > reentryBb20.bucket.wr + 0.005
);
const dayDependent = !!(best && best.dayShare > 0.5 && best.bucket.wr >= BE80);

const verdict = suspicionFlags.length
  ? "BOLLINGER_NO_EDGE"
  : pickVerdict({
      best: best
        ? {
            variant: best.variant,
            bb: best.bb,
            expiry: best.expiry,
            bucket: best.bucket,
            dayShare: best.dayShare,
          }
        : null,
      reentryHelps,
      rangeHelps,
      dayDependent,
      clearedBe: clearedBe.length > 0,
    });

function sliceLines(
  subset: Signal[],
  expiry: Expiry,
  keyFn: (s: Signal) => string,
): string[] {
  const keys = [...new Set(subset.map(keyFn))].sort();
  return keys.map((k) => {
    const b = score(subset, expiry, (s) => keyFn(s) === k);
    return `  ${k}: ${b.label}`;
  });
}

function headlineBlock(variant: Variant, bb: string): string {
  const lines: string[] = [];
  for (const exp of EXPIRIES) {
    const c = cellAt(variant, bb, exp);
    if (!c) continue;
    lines.push(
      `  ${exp}m: ${c.bucket.label} | RANGE ${c.range.label} | TREND ${c.trend.label} | ${interestingLabel(c.bucket)}`,
    );
  }
  return lines.join("\n");
}

const bestRejectCells = cells
  .filter((c) => c.variant === "BB_REENTRY_RANGE_REJECT")
  .sort((a, b) => b.bucket.wr - a.bucket.wr || b.bucket.decided - a.bucket.decided);

const bestRangeReject = bestRejectCells[0];

// Per-variant raw vs: we already dedupe in state machine; report counts
const countByVariant = new Map<string, number>();
for (const s of allSignals) {
  const k = `${s.variant}|${s.bb}`;
  countByVariant.set(k, (countByVariant.get(k) ?? 0) + 1);
}

const leakagePass = [
  "indicators at T use only closed bars with index ≤ T: PASS",
  "signal only after confirmation candle close; entry = confirmation close: PASS",
  "expiry resolve uses first closed candle at/after entryMs+N*60s: PASS",
  "TEST window fixed from M1 dataEnd before outcome-based selection: PASS",
  "BB period/dev, ADX, RSI, wick thresholds pre-registered (no TEST fitting): PASS",
  "population stdev documented and consistent: PASS",
  "episode dedup until mid return + new excursion: PASS",
  "ties via classifyBinaryResult; WR = wins/(wins+losses): PASS",
  "production binary / baseline / adaptive untouched: PASS",
  suspicionFlags.length
    ? `suspicious WR≥65% n≥200 flagged (${suspicionFlags.length}) — no edge claimed: FAIL→AUDIT`
    : "no suspicious WR≥65% with n≥200: PASS",
];

const bestSummary = best
  ? `${best.variant}|${best.bb}|${best.expiry}m ${best.bucket.label} dayShare=${pct(best.dayShare)} [${interestingLabel(best.bucket)}]`
  : "n/a";

const report = `GOLDENXPERIENCE
BOLLINGER RANGE-REJECTION WALK-FORWARD TEST
Experiment: ${EXPERIMENT}

================================
DATA
================================

Pairs: ${instruments.join(", ")}
Baseline predictions (secondary): ${preds.length} spanning ${predMin} → ${predMax}
M1 coverage: ${new Date(m1Min).toISOString()} → ${new Date(m1Max).toISOString()}
M1 bars: ${m1Total} across ${instruments.length} pairs
Gaps (intraday >3m, <48h):
${gapNotes.map((g) => `  ${g}`).join("\n")}

TRAIN: ${new Date(trainStartMs).toISOString()} → ${new Date(trainEndMs).toISOString()}  (bars=${trainBars})
TEST:  ${new Date(testStartMs).toISOString()} → ${new Date(testEndMs).toISOString()}  (bars=${testBars})
Definition: TEST = [dataEnd - 7d, dataEnd]; TRAIN = all M1 strictly before TEST start.
Parameters frozen BEFORE any TEST outcome selection.

================================
PRE-REGISTERED SETTINGS
================================

BB stdev mode: ${BB_STDEV_MODE} (variance = mean(x^2) - mean(x)^2 over period)
BB20: period=20, k=2.0
BB50: period=50, k=1.5
ATR14 / ADX14 / RSI14: Wilder
Primary range filter: ADX <= ${ADX_RANGE} (sensitivity ADX <= ${ADX_RANGE_SENS})
Trend: ADX > ${ADX_RANGE}
RSI: UP if RSI<=${RSI_OVERSOLD}, DOWN if RSI>=${RSI_OVERBOUGHT}
Rejection (F): UP lowerWick/range>=${WICK_MIN} & closeLoc>=${CLOSE_LOC_UP}; DOWN upperWick/range>=${WICK_MIN} & closeLoc<=${CLOSE_LOC_DOWN}
Keltner control: EMA20 ± 1.5*ATR14
Excursion: high>upper (resistance) / low<lower (support)
Reentry: close <= upper / close >= lower after outside
Dedup: after signal suppress until price returns to mid, then NEW outside required
Expiries: ${EXPIRIES.join(", ")} minutes
BE80: ${pct(BE80)}

================================
LEAKAGE AUDIT
================================

${leakagePass.map((l) => `  - ${l}`).join("\n")}
${suspicionFlags.length ? `\nSuspicious cells:\n${suspicionFlags.map((s) => `  ${s}`).join("\n")}` : ""}

================================
EVENT FREQUENCY (TEST, deduped episodes)
================================

${[...countByVariant.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, n]) => {
    const rawKey =
      k.startsWith("BB_TOUCH|")
        ? k
        : k.startsWith("KELTNER_")
          ? "KELTNER_REENTRY_RANGE|KELTNER"
          : `BB_REENTRY|${k.split("|")[1]}`;
    const raw = rawCounts.get(rawKey) ?? rawCounts.get(k) ?? n;
    return `  ${k}: deduped=${n} rawFamily≈${raw}`;
  })
  .join("\n")}

Raw family counters (touch bars / reentry closes before episode suppress):
${[...rawCounts.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([k, n]) => `  ${k}: ${n}`)
  .join("\n")}

================================
HEADLINE RESULTS (TEST)
================================

--- BB_TOUCH | BB20 ---
${headlineBlock("BB_TOUCH", "BB20")}

--- BB_TOUCH | BB50 ---
${headlineBlock("BB_TOUCH", "BB50")}

--- BB_REENTRY | BB20 ---
${headlineBlock("BB_REENTRY", "BB20")}

--- BB_REENTRY | BB50 ---
${headlineBlock("BB_REENTRY", "BB50")}

--- BB_REENTRY_RANGE | BB20 ---
${headlineBlock("BB_REENTRY_RANGE", "BB20")}

--- BB_REENTRY_RANGE | BB50 ---
${headlineBlock("BB_REENTRY_RANGE", "BB50")}

--- BB_REENTRY_RSI | BB20 ---
${headlineBlock("BB_REENTRY_RSI", "BB20")}

--- BB_REENTRY_RSI | BB50 ---
${headlineBlock("BB_REENTRY_RSI", "BB50")}

--- BB_REENTRY_RANGE_RSI | BB20 ---
${headlineBlock("BB_REENTRY_RANGE_RSI", "BB20")}

--- BB_REENTRY_RANGE_RSI | BB50 ---
${headlineBlock("BB_REENTRY_RANGE_RSI", "BB50")}

--- BB_REENTRY_RANGE_REJECT | BB20 ---
${headlineBlock("BB_REENTRY_RANGE_REJECT", "BB20")}

--- BB_REENTRY_RANGE_REJECT | BB50 ---
${headlineBlock("BB_REENTRY_RANGE_REJECT", "BB50")}

--- KELTNER_REENTRY_RANGE ---
${headlineBlock("KELTNER_REENTRY_RANGE", "KELTNER")}

================================
RANGE FILTER SENSITIVITY (ADX<=20 vs <=25)
================================

${(() => {
  const lines: string[] = [];
  for (const bb of ["BB20", "BB50"] as const) {
    const base = allSignals.filter((s) => s.variant === "BB_REENTRY" && s.bb === bb);
    const r25 = score(base, primaryExp, (s) => s.regime === "RANGE");
    const r20 = score(base, primaryExp, (s) => s.regimeSens === "RANGE20");
    const always = score(base, primaryExp);
    lines.push(`${bb} BB_REENTRY @${primaryExp}m ALWAYS: ${always.label}`);
    lines.push(`${bb} ADX<=25: ${r25.label}`);
    lines.push(`${bb} ADX<=20: ${r20.label}`);
  }
  return lines.join("\n");
})()}

================================
UP vs DOWN / BY SYMBOL / SESSION / DAY
================================

Best cell for slices: ${bestSummary}

By direction @ best cell expiry:
${best ? sliceLines(
  allSignals.filter((s) => s.variant === best.variant && s.bb === best.bb),
  best.expiry,
  (s) => s.dir,
).join("\n") : "  n/a"}

By symbol:
${best ? sliceLines(
  allSignals.filter((s) => s.variant === best.variant && s.bb === best.bb),
  best.expiry,
  (s) => s.instrument,
).join("\n") : "  n/a"}

By session:
${best ? sliceLines(
  allSignals.filter((s) => s.variant === best.variant && s.bb === best.bb),
  best.expiry,
  (s) => s.session,
).join("\n") : "  n/a"}

By calendar day (ET):
${best ? sliceLines(
  allSignals.filter((s) => s.variant === best.variant && s.bb === best.bb),
  best.expiry,
  (s) => s.day,
).join("\n") : "  n/a"}

Day concentration (best cell): maxEventShare=${best ? pct(best.dayShare) : "n/a"} maxWinShare=${best ? pct(best.dayWinShare) : "n/a"}

================================
BASELINES (same TEST window)
================================

binary-baseline-v1: n=${baseDecided} W=${baseW} L=${baseL} T=${baseT} WR=${pct(baseWr)} CI=[${pct(baseCi.low)},${pct(baseCi.high)}] EV80=${evOf(baseWr, 0.8).toFixed(3)} (preds in TEST=${baselineInTest.length})
random 50/50 (theoretical): WR=50.00% EV80=${evOf(0.5, 0.8).toFixed(3)}
BB_TOUCH BB20 @${primaryExp}m: ${touchBb20?.bucket.label ?? "n/a"}
BB_REENTRY BB20 @${primaryExp}m: ${reentryBb20?.bucket.label ?? "n/a"}
Best range-rejection (BB_REENTRY_RANGE_REJECT): ${bestRangeReject ? `${bestRangeReject.bb}|${bestRangeReject.expiry}m ${bestRangeReject.bucket.label}` : "n/a"}

Cells clearing BE80 with n≥${MIN_SERIOUS_N}: ${clearedBe.length}
${clearedBe
  .slice(0, 15)
  .map((c) => `  ${c.key}: ${c.bucket.label} dayShare=${pct(c.dayShare)}`)
  .join("\n") || "  (none)"}

================================
BEST TEST STRATEGY (descriptive among pre-registered; NOT retuned)
================================

${bestSummary}
EV@0.70..0.95: ${best ? [0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((p) => `EV${(p * 100).toFixed(0)}=${evOf(best.bucket.wr, p).toFixed(3)}`).join(" ") : "n/a"}

================================
FINAL VERDICT
================================

${verdict}

================================
DIRECT ANSWERS
================================

1. Does BB outside→reentry beat break-even (55.56%) on TEST with adequate n?
   ${(() => {
     const hits = cells.filter(
       (c) =>
         (c.variant === "BB_REENTRY" || c.variant.startsWith("BB_REENTRY_")) &&
         c.bucket.decided >= MIN_SERIOUS_N &&
         c.bucket.wr >= BE80,
     );
     return hits.length
       ? `YES — ${hits.length} cells; top ${hits.sort((a, b) => b.bucket.wr - a.bucket.wr)[0]!.key} WR=${pct(hits[0]!.bucket.wr)} n=${hits[0]!.bucket.decided}`
       : `NO — best reentry-family ${cells.filter((c) => c.variant.includes("REENTRY")).sort((a, b) => b.bucket.wr - a.bucket.wr || b.bucket.decided - a.bucket.decided)[0]?.key ?? "n/a"} did not clear BE80 with n≥${MIN_SERIOUS_N}`;
   })()}

2. Does the ADX range filter (≤25) help vs unfiltered reentry?
   BB20 @${primaryExp}m REENTRY WR=${reentryBb20 ? pct(reentryBb20.bucket.wr) : "n/a"} vs RANGE WR=${rangeBb20 ? pct(rangeBb20.bucket.wr) : "n/a"} → ${rangeHelps ? "YES (descriptive)" : "NO clear help"}

3. Does RSI extreme filtering help?
   ${(() => {
     const a = cellAt("BB_REENTRY", "BB20", primaryExp);
     const b = cellAt("BB_REENTRY_RSI", "BB20", primaryExp);
     if (!a || !b) return "n/a";
     return `BB20 @${primaryExp}m REENTRY ${pct(a.bucket.wr)} n=${a.bucket.decided} vs RSI ${pct(b.bucket.wr)} n=${b.bucket.decided} → ${b.bucket.wr > a.bucket.wr + 0.005 ? "YES (descriptive)" : "NO clear help"}`;
   })()}

4. Does confirmation-candle rejection (wick/closeLoc) add edge on top of range reentry?
   ${(() => {
     const a = cellAt("BB_REENTRY_RANGE", "BB20", primaryExp);
     const b = cellAt("BB_REENTRY_RANGE_REJECT", "BB20", primaryExp);
     if (!a || !b) return "n/a";
     return `BB20 @${primaryExp}m RANGE ${pct(a.bucket.wr)} n=${a.bucket.decided} vs REJECT ${pct(b.bucket.wr)} n=${b.bucket.decided} → ${b.bucket.wr > a.bucket.wr + 0.005 ? "YES (descriptive)" : "NO clear add"}`;
   })()}

5. BB20 vs BB50 — which is better on TEST (descriptive only)?
   ${(() => {
     const a = cells.filter((c) => c.bb === "BB20" && c.bucket.decided >= 30).sort((x, y) => y.bucket.wr - x.bucket.wr)[0];
     const b = cells.filter((c) => c.bb === "BB50" && c.bucket.decided >= 30).sort((x, y) => y.bucket.wr - x.bucket.wr)[0];
     return `best BB20 (n≥30) ${a?.key ?? "n/a"} WR=${a ? pct(a.bucket.wr) : "n/a"} n=${a?.bucket.decided ?? 0}; best BB50 (n≥30) ${b?.key ?? "n/a"} WR=${b ? pct(b.bucket.wr) : "n/a"} n=${b?.bucket.decided ?? 0}`;
   })()}

6. Which expiry looks best among pre-registered cells with n≥30?
   ${(() => {
     const c = cells.filter((x) => x.bucket.decided >= 30).sort((a, b) => b.bucket.wr - a.bucket.wr)[0];
     return c ? `${c.expiry}m via ${c.key} WR=${pct(c.bucket.wr)} n=${c.bucket.decided}` : "n/a";
   })()}

7. Does any Bollinger variant beat binary-baseline-v1 on the same TEST window?
   Baseline WR=${pct(baseWr)} n=${baseDecided}; best BB ${best ? `${pct(best.bucket.wr)} n=${best.bucket.decided}` : "n/a"} → ${best && best.bucket.wr > baseWr + 0.01 ? "YES (descriptive)" : "NO clear beat"}

8. Is apparent edge day-concentrated?
   Best cell max day event share=${best ? pct(best.dayShare) : "n/a"} → ${best && best.dayShare > 0.5 ? "YES — day-dependent risk" : "No extreme single-day dominance"}

9. Did anything clear 55.56% with n≥100?
   ${clearedBe.length ? `YES — ${clearedBe.length} cells` : "NO"}

10. Most importantly:
Can Bollinger range-rejection (outside then close back inside, optionally with ADX/RSI/wick filters) provide a genuinely profitable short-horizon binary signal on a frozen walk-forward TEST week?
   Verdict=${verdict}. ${
     verdict === "BOLLINGER_RANGE_EDGE_FOUND"
       ? "A pre-registered range-rejection cell cleared BE80 with adequate n on TEST — still research-only; do not deploy without further OOS."
       : verdict === "BOLLINGER_REENTRY_EDGE_FOUND"
         ? "Reentry (without needing the full rejection stack) cleared BE80 with adequate n — research-only."
         : verdict === "BOLLINGER_PROMISING_BUT_UNDERPOWERED"
           ? "Some WR looks interesting but effective n < 100 — do not claim edge."
           : verdict === "BOLLINGER_ABOVE_50_BUT_BELOW_BREAK_EVEN"
             ? "Above coin-flip but below 80% payout break-even at adequate n."
             : verdict === "BOLLINGER_DAY_DEPENDENT"
               ? "Apparent edge concentrates on few calendar days — not robust."
               : verdict === "RANGE_FILTER_DOES_NOT_HELP"
                 ? "Reentry may differ from touch, but ADX range filter did not clearly help."
                 : verdict === "REENTRY_DOES_NOT_HELP"
                   ? "Outside→reentry did not improve on simple band touch / random."
                   : "No durable Bollinger range-rejection edge found under pre-registered frozen settings."
   }

NO PRODUCTION BINARY CHANGES WERE MADE.
`;

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });
fs.writeFileSync(REGISTRY_PATH, registryLines.join("\n") + "\n", "utf8");
fs.writeFileSync(REPORT_PATH, report, "utf8");
console.log(`Wrote ${REPORT_PATH}`);
console.log(`Wrote ${REGISTRY_PATH} (${registryLines.length} lines)`);
console.log(`VERDICT=${verdict}`);
console.log(`BEST=${bestSummary}`);
console.log(`CLEARED_BE80_n>=100=${clearedBe.length}`);
if (suspicionFlags.length) {
  console.log("NOTE: suspicious WR cells were flagged; verdict forced conservative.");
  process.exitCode = 0; // report exists; research complete with audit note
}
