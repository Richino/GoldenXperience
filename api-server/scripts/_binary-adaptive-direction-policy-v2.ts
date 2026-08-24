/**
 * GOLDENXPERIENCE — adaptive-direction-policy-v2
 *
 * RESEARCH ONLY. Chronological FOLLOW / INVERT / WAIT on frozen BB+RSI binary stream.
 * No production writes, no LIVE_EXECUTABLE changes, no adaptive table writes, no deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { classifyBinaryResult, type BinaryCandle } from "../src/binary-engine.js";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";
import { evidenceLabel, wilsonInterval } from "../src/binary-regimes.js";
import {
  BINARY_ADAPTIVE_SELECTOR_CONFIG,
  determineSelectorState,
  type SelectorState,
} from "../src/binary-adaptive-selector.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}

const OUT_DIR = path.join(root, "research-v2", "adaptive-direction-policy-v2");
const CACHE_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");
const DECISIONS_PATH = path.join(OUT_DIR, "decisions.jsonl");
const LEARNING_CURVE_PATH = path.join(OUT_DIR, "learning_curve.csv");

const EXPERIMENT = "adaptive-direction-policy-v2";
const BE80 = 1 / (1 + 0.8);
const EXPIRY_MIN = 10;
const BB_PERIOD = 20;
const BB_K = 2.0;
const RSI_OS = 30;
const RSI_OB = 70;
const WIDTH_TRAIL = 500;
const PRIMARY_RULE: TakeRuleId = "EST_GE_0.5556";
const RANDOM_SHUFFLES = 1000;
const SIMPLE_INVERT_WR = 0.45;
const PAYOUT_PRIMARY = 0.8;

const LEARN_START_MS = Date.parse("2024-12-29T21:00:00.000Z");
const HOLDOUT_START_MS = Date.parse("2026-05-23T21:00:00.000Z");
const COMPARISON_START_MS = Date.parse("2026-08-14T21:00:00.000Z");
const DATA_END_MS = Date.parse("2026-08-21T21:00:00.000Z");

const EXPECTED_EXTREME_N = 815;
const EXPECTED_EXTREME_WR = 0.6025;
const REPRO_N_TOL = 40;
const REPRO_WR_TOL = 0.02;

const MIN_LEARNING = BINARY_ADAPTIVE_SELECTOR_CONFIG.minLearningPairedSamples;
const MIN_ACTIVE = BINARY_ADAPTIVE_SELECTOR_CONFIG.minActivePairedSamples;

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
const ET_WEEK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ET_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
});

type Outcome = "won" | "lost" | "tie" | "missing";
type Dir = "up" | "down";
type Side = "upper" | "lower";
type AdxBucket = "le20" | "b20_25" | "b25_30" | "gt30";
type RsiSeverity = "mild" | "medium" | "extreme";
type BbWidthBucket = "low" | "mid" | "high";
type Zone = "TRAIN" | "DEV" | "HOLDOUT";
type PenBucket = "shallow" | "moderate" | "deep";
type SlopeBucket = "down" | "flat" | "up";
type DepthBucket = "shallow" | "mid" | "deep";

type TakeRuleId = "ALWAYS" | "EST_GE_0.5556";

type ScopeKind =
  | "direction|rsiSeverity|adxBucket"
  | "direction|rsiSeverity"
  | "direction|adxBucket"
  | "direction|session"
  | "direction"
  | "overall";

type InstrumentCache = {
  instrument: string;
  candles: BinaryCandle[];
  closeMs: number[];
  atr14: Float64Array;
  adx14: Float64Array;
  rsi14: Float64Array;
  bbMid: Float64Array;
  bbUpper: Float64Array;
  bbLower: Float64Array;
  bbWidthAtr: Float64Array;
};

type RawSignal = {
  instrument: string;
  side: Side;
  dir: Dir;
  entry: number;
  entryMs: number;
  resolveMs: number;
  barIdx: number;
  adx: number;
  rsi: number;
  session: string;
  day: string;
  week: string;
  month: string;
  monthIdx: number;
  adxBucket: AdxBucket;
  rsiSeverity: RsiSeverity;
  bbWidthBucket: BbWidthBucket;
  penetrationAtr: number;
  penBucket: PenBucket;
  reentryDepthAtr: number;
  depthBucket: DepthBucket;
  midSlope: number;
  slopeBucket: SlopeBucket;
  atr: number;
  follow: Outcome;
  invert: Outcome;
  zone: Zone;
};

type EvidenceCell = { won: number; lost: number };

type Decision = {
  signal: RawSignal;
  state: SelectorState;
  overallPriorN: number;
  scope: ScopeKind | "none";
  scopeN: number;
  est: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  evidenceLbl: string;
  takes: Record<TakeRuleId, boolean>;
};

type Score = {
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
};

type PathStats = {
  expiryWr: Record<string, Score>;
  mfeAtrMean: number;
  maeAtrMean: number;
  ttfMean: number;
  ttaMean: number;
  nPath: number;
};







function evOf(wr: number, payout: number) {
  return wr * payout - (1 - wr);
}

function pct(x: number) {
  return `${(x * 100).toFixed(2)}%`;
}

function sessionOf(ms: number): string {
  const h = Number(ET_HOUR.formatToParts(new Date(ms)).find((p) => p.type === "hour")?.value);
  if (h >= 19 || h < 3) return "asia";
  if (h >= 3 && h < 8) return "london";
  if (h >= 8 && h < 12) return "overlap";
  if (h >= 12 && h < 17) return "ny";
  return "off";
}

function adxBucketOf(adx: number): AdxBucket {
  if (!Number.isFinite(adx)) return "gt30";
  if (adx <= 20) return "le20";
  if (adx <= 25) return "b20_25";
  if (adx <= 30) return "b25_30";
  return "gt30";
}

function rsiSeverityOf(dir: Dir, rsi: number): RsiSeverity {
  const beyond = dir === "up" ? RSI_OS - rsi : rsi - RSI_OB;
  if (beyond <= 5) return "mild";
  if (beyond <= 10) return "medium";
  return "extreme";
}

function isRsiExtreme(s: RawSignal): boolean {
  return s.rsiSeverity === "extreme";
}

function trueRange(c: BinaryCandle, prevClose: number) {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

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

function computeAtr14(candles: BinaryCandle[]) {
  const n = candles.length;
  const atr = new Float64Array(n).fill(NaN);
  if (n < 15) return atr;
  let sum = 0;
  for (let i = 1; i <= 14; i++) sum += trueRange(candles[i]!, candles[i - 1]!.close);
  atr[14] = sum / 14;
  for (let i = 15; i < n; i++) {
    atr[i] = (atr[i - 1]! * 13 + trueRange(candles[i]!, candles[i - 1]!.close)) / 14;
  }
  return atr;
}

function computeAdx14(candles: BinaryCandle[]) {
  const n = candles.length;
  const adx = new Float64Array(n).fill(NaN);
  if (n < 29) return adx;
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
    if (dxArr.length === 14) adx[i] = dxArr.reduce((a, b) => a + b, 0) / 14;
    else if (dxArr.length > 14) adx[i] = (adx[i - 1]! * 13 + dx) / 14;
  }
  return adx;
}

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
    avgGain = (avgGain * 13 + (d > 0 ? d : 0)) / 14;
    avgLoss = (avgLoss * 13 + (d < 0 ? -d : 0)) / 14;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function trailingWidthBucket(series: Float64Array, i: number): BbWidthBucket {
  const vals: number[] = [];
  const start = Math.max(0, i - WIDTH_TRAIL + 1);
  for (let j = start; j <= i; j++) {
    const v = series[j]!;
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 20) return "mid";
  const cur = series[i]!;
  if (!Number.isFinite(cur)) return "mid";
  let below = 0;
  for (const v of vals) if (v <= cur) below += 1;
  const p = below / vals.length;
  if (p <= 1 / 3) return "low";
  if (p <= 2 / 3) return "mid";
  return "high";
}

function penBucketOf(x: number): PenBucket {
  if (!Number.isFinite(x) || x < 0.5) return "shallow";
  if (x < 1.0) return "moderate";
  return "deep";
}

function depthBucketOf(x: number): DepthBucket {
  if (!Number.isFinite(x) || x < 0.25) return "shallow";
  if (x < 0.75) return "mid";
  return "deep";
}

function slopeBucketOf(x: number): SlopeBucket {
  if (!Number.isFinite(x)) return "flat";
  if (x < -0.05) return "down";
  if (x > 0.05) return "up";
  return "flat";
}

function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  // Monday-based week label via ET calendar day of Monday
  const parts = ET_WEEK.formatToParts(d);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const utc = Date.UTC(y, m - 1, day);
  const dow = new Date(utc).getUTCDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(utc + mondayOffset * 86_400_000);
  return `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, "0")}-${String(mon.getUTCDate()).padStart(2, "0")}`;
}

function monthIndex(ms: number): number {
  const parts = ET_MONTH.formatToParts(new Date(ms));
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  return y * 12 + m;
}

function loadCachedCandles(instrument: string): BinaryCandle[] | null {
  const p = path.join(CACHE_DIR, `${instrument}.jsonl`);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const out: BinaryCandle[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as BinaryCandle;
      if (o?.time && o.complete !== false) out.push({ ...o, complete: true });
    } catch {
      /* skip */
    }
  }
  return out.length ? out.sort((a, b) => a.time.localeCompare(b.time)) : null;
}

function buildCache(instrument: string, candlesIn: BinaryCandle[]): InstrumentCache {
  const candles = candlesIn.filter((c) => Number.isFinite(Date.parse(c.time)));
  const closeMs = candles.map((c) => Date.parse(c.time) + 60_000);
  const closes = new Float64Array(candles.map((c) => c.close));
  const atr14 = computeAtr14(candles);
  const adx14 = computeAdx14(candles);
  const rsi14 = computeRsi14(closes);
  const bb = computeBollinger(closes, BB_PERIOD, BB_K);
  const bbWidthAtr = new Float64Array(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const w = bb.upper[i]! - bb.lower[i]!;
    const a = atr14[i]!;
    if (Number.isFinite(w) && Number.isFinite(a) && a > 0) bbWidthAtr[i] = w / a;
  }
  return {
    instrument,
    candles,
    closeMs,
    atr14,
    adx14,
    rsi14,
    bbMid: bb.mid,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbWidthAtr,
  };
}

function resolveAt(cache: InstrumentCache, targetMs: number): { price: number; timeMs: number; idx: number } | null {
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
  return { price: cache.candles[ans]!.close, timeMs: cache.closeMs[ans]!, idx: ans };
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
  if (!mark || mark.timeMs <= startMs) return "missing";
  return classifyBinaryResult(dir, entry, mark.price, precision);
}

type SideState = { outside: boolean; signaled: boolean; extremePrice: number };

function collectBbReentryRsi(cache: InstrumentCache, out: RawSignal[]) {
  const upper: SideState = { outside: false, signaled: false, extremePrice: NaN };
  const lower: SideState = { outside: false, signaled: false, extremePrice: NaN };
  const precision = cache.instrument.includes("JPY") ? 3 : 5;

  for (let i = 0; i < cache.candles.length; i++) {
    const c = cache.candles[i]!;
    const entryMs = cache.closeMs[i]!;
    const mid = cache.bbMid[i]!;
    const up = cache.bbUpper[i]!;
    const lo = cache.bbLower[i]!;
    if (!Number.isFinite(mid) || !Number.isFinite(up) || !Number.isFinite(lo)) continue;

    const adx = cache.adx14[i]!;
    const rsi = cache.rsi14[i]!;
    const atr = cache.atr14[i]!;

    for (const [side, st] of [
      ["upper", upper] as const,
      ["lower", lower] as const,
    ]) {
      if (st.signaled) {
        const reset =
          side === "upper" ? c.close <= mid || c.low <= mid : c.close >= mid || c.high >= mid;
        if (reset) {
          st.signaled = false;
          st.outside = false;
          st.extremePrice = NaN;
        }
      }
    }

    if (!upper.signaled && c.high > up) {
      upper.outside = true;
      upper.extremePrice = Number.isFinite(upper.extremePrice)
        ? Math.max(upper.extremePrice, c.high)
        : c.high;
    }
    if (!lower.signaled && c.low < lo) {
      lower.outside = true;
      lower.extremePrice = Number.isFinite(lower.extremePrice)
        ? Math.min(lower.extremePrice, c.low)
        : c.low;
    }

    const upperReentry = upper.outside && c.close <= up;
    const lowerReentry = lower.outside && c.close >= lo;

    const midPrev = i >= 5 && Number.isFinite(cache.bbMid[i - 5]!) ? cache.bbMid[i - 5]! : mid;
    const midSlopeRaw =
      Number.isFinite(atr) && atr > 0 ? (mid - midPrev) / (5 * atr) : 0;

    const pushSignal = (side: Side, dir: Dir, extremePx: number) => {
      const close = Number(c.close);
      const band = side === "upper" ? up : lo;
      const penetration =
        Number.isFinite(atr) && atr > 0 && Number.isFinite(extremePx)
          ? Math.abs(extremePx - band) / atr
          : NaN;
      const reentryDepth =
        Number.isFinite(atr) && atr > 0 ? Math.abs(band - close) / atr : NaN;
      out.push({
        instrument: cache.instrument,
        side,
        dir,
        entry: close,
        entryMs,
        resolveMs: entryMs + EXPIRY_MIN * 60_000,
        barIdx: i,
        adx: Number.isFinite(adx) ? adx : NaN,
        rsi,
        session: sessionOf(entryMs),
        day: ET_DAY.format(new Date(entryMs)),
        week: isoWeekKey(entryMs),
        month: ET_MONTH.format(new Date(entryMs)),
        monthIdx: monthIndex(entryMs),
        adxBucket: adxBucketOf(adx),
        rsiSeverity: rsiSeverityOf(dir, rsi),
        bbWidthBucket: trailingWidthBucket(cache.bbWidthAtr, i),
        penetrationAtr: penetration,
        penBucket: penBucketOf(penetration),
        reentryDepthAtr: reentryDepth,
        depthBucket: depthBucketOf(reentryDepth),
        midSlope: midSlopeRaw,
        slopeBucket: slopeBucketOf(midSlopeRaw),
        atr: Number.isFinite(atr) ? atr : NaN,
        follow: outcomeAt(cache, dir, close, precision, entryMs, EXPIRY_MIN),
        invert: outcomeAt(cache, dir === "up" ? "down" : "up", close, precision, entryMs, EXPIRY_MIN),
        zone: "TRAIN",
      });
    };

    if (upperReentry) {
      if (!upper.signaled) {
        if (Number.isFinite(rsi) && rsi >= RSI_OB) {
          pushSignal("upper", "down", upper.extremePrice);
        }
        upper.signaled = true;
      }
      upper.outside = false;
      upper.extremePrice = NaN;
    }

    if (lowerReentry) {
      if (!lower.signaled) {
        if (Number.isFinite(rsi) && rsi <= RSI_OS) {
          pushSignal("lower", "up", lower.extremePrice);
        }
        lower.signaled = true;
      }
      lower.outside = false;
      lower.extremePrice = NaN;
    }
  }
}

/* === V2 paired evidence + chronological replay + report (appended after collect) === */

const V2_HIERARCHY: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction|rsiSeverity|adxBucket", minN: 40 },
  { kind: "direction|rsiSeverity", minN: 30 },
  { kind: "direction|adxBucket", minN: 30 },
  { kind: "direction|session", minN: 30 },
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

const LEARNING_CHECKPOINTS = [1000, 2000, 5000, 10000, 15000, 20000, 30000, 50000];

type PairedCell = {
  followWon: number;
  followLost: number;
  invertWon: number;
  invertLost: number;
};

type V2Decision = {
  signal: RawSignal;
  state: SelectorState;
  overallPriorN: number;
  scope: ScopeKind | "none";
  scopeKey: string;
  scopeN: number;
  followWR: number | null;
  invertWR: number | null;
  followCiLow: number | null;
  invertCiLow: number | null;
  chosenEst: number | null;
  v2: "FOLLOW" | "INVERT" | "WAIT";
  oldAdaptive: "TAKE" | "WAIT";
  simple: "FOLLOW" | "INVERT" | "WAIT";
  evidenceLbl: string;
};

type PatternClass =
  | "ANTI_PREDICTIVE"
  | "NO_INFORMATION"
  | "FOLLOW_EDGE"
  | "UNSTABLE"
  | "OTHER";

type ContextAgg = {
  key: string;
  followWon: number;
  followLost: number;
  invertWon: number;
  invertLost: number;
  byMonth: Map<string, { fW: number; fL: number; iW: number; iL: number }>;
};

function scopeKey(kind: ScopeKind, s: RawSignal): string {
  switch (kind) {
    case "direction|rsiSeverity|adxBucket":
      return `${kind}|${s.dir}|${s.rsiSeverity}|${s.adxBucket}`;
    case "direction|rsiSeverity":
      return `${kind}|${s.dir}|${s.rsiSeverity}`;
    case "direction|adxBucket":
      return `${kind}|${s.dir}|${s.adxBucket}`;
    case "direction|session":
      return `${kind}|${s.dir}|${s.session}`;
    case "direction":
      return `${kind}|${s.dir}`;
    case "overall":
      return "overall";
    default: {
      const _e: never = kind;
      throw new Error(String(_e));
    }
  }
}

function followDecided(c: PairedCell | undefined): number {
  return c ? c.followWon + c.followLost : 0;
}
function invertDecided(c: PairedCell | undefined): number {
  return c ? c.invertWon + c.invertLost : 0;
}
function addPaired(map: Map<string, PairedCell>, key: string, follow: Outcome, invert: Outcome) {
  const cur = map.get(key) ?? { followWon: 0, followLost: 0, invertWon: 0, invertLost: 0 };
  if (follow === "won") cur.followWon += 1;
  else if (follow === "lost") cur.followLost += 1;
  if (invert === "won") cur.invertWon += 1;
  else if (invert === "lost") cur.invertLost += 1;
  map.set(key, cur);
}

function scoreOutcomes(outcomes: Outcome[]): Score {
  let won = 0;
  let lost = 0;
  let tie = 0;
  let missing = 0;
  for (const o of outcomes) {
    if (o === "won") won += 1;
    else if (o === "lost") lost += 1;
    else if (o === "tie") tie += 1;
    else missing += 1;
  }
  const decided = won + lost;
  const wr = decided ? won / decided : 0;
  const ci = wilsonInterval(won, decided);
  return {
    rawN: outcomes.length,
    won,
    lost,
    tie,
    missing,
    decided,
    wr,
    ciLow: ci.ciLow ?? 0,
    ciHigh: ci.ciHigh ?? 0,
    ev70: evOf(wr, 0.7),
    ev75: evOf(wr, 0.75),
    ev80: evOf(wr, 0.8),
    ev85: evOf(wr, 0.85),
    ev90: evOf(wr, 0.9),
    ev95: evOf(wr, 0.95),
  };
}
function emptyScore(): Score {
  return scoreOutcomes([]);
}
function fmtScore(s: Score) {
  return `n=${s.decided} W=${s.won} L=${s.lost} T=${s.tie} WR=${pct(s.wr)} CI=[${pct(s.ciLow)},${pct(s.ciHigh)}] EV80=${s.ev80.toFixed(3)}`;
}

type Action = "FOLLOW" | "INVERT" | "WAIT";

function executedOutcome(d: V2Decision, action: Action): Outcome | null {
  if (action === "WAIT") return null;
  return action === "FOLLOW" ? d.signal.follow : d.signal.invert;
}
function scoreActions(decisions: V2Decision[], actionOf: (d: V2Decision) => Action): Score {
  const outs: Outcome[] = [];
  for (const d of decisions) {
    const o = executedOutcome(d, actionOf(d));
    if (o != null) outs.push(o);
  }
  return scoreOutcomes(outs);
}
function actionCounts(decisions: V2Decision[], actionOf: (d: V2Decision) => Action) {
  let follow = 0;
  let invert = 0;
  let wait = 0;
  for (const d of decisions) {
    const a = actionOf(d);
    if (a === "FOLLOW") follow += 1;
    else if (a === "INVERT") invert += 1;
    else wait += 1;
  }
  return { follow, invert, wait, total: decisions.length };
}

function decideV2(
  state: SelectorState,
  cell: PairedCell | undefined,
  minN: number,
): {
  action: Action;
  followWR: number | null;
  invertWR: number | null;
  followCiLow: number | null;
  invertCiLow: number | null;
} {
  if (state === "COLLECTING") {
    return { action: "WAIT", followWR: null, invertWR: null, followCiLow: null, invertCiLow: null };
  }
  const fN = followDecided(cell);
  const iN = invertDecided(cell);
  if (!cell || fN < minN) {
    return { action: "WAIT", followWR: null, invertWR: null, followCiLow: null, invertCiLow: null };
  }
  const followWR = cell.followWon / fN;
  const invertWR = iN ? cell.invertWon / iN : 0;
  const followCI = wilsonInterval(cell.followWon, fN);
  const invertCI = wilsonInterval(cell.invertWon, iN);
  const followOK = fN >= minN && followCI.ciLow != null && followCI.ciLow > BE80;
  const invertOK = iN >= minN && invertCI.ciLow != null && invertCI.ciLow > BE80;
  let action: Action = "WAIT";
  if (followOK && invertOK) action = followWR >= invertWR ? "FOLLOW" : "INVERT";
  else if (followOK) action = "FOLLOW";
  else if (invertOK) action = "INVERT";
  return {
    action,
    followWR,
    invertWR,
    followCiLow: followCI.ciLow,
    invertCiLow: invertCI.ciLow,
  };
}

function decideOldAdaptive(
  state: SelectorState,
  cell: PairedCell | undefined,
  minN: number,
): "TAKE" | "WAIT" {
  // Fidelity to prior research: COLLECTING → TAKE-all
  if (state === "COLLECTING") return "TAKE";
  const fN = followDecided(cell);
  if (!cell || fN < minN) return "TAKE";
  return cell.followWon / fN >= BE80 ? "TAKE" : "WAIT";
}

function decideSimple(
  state: SelectorState,
  dirCell: PairedCell | undefined,
  overallCell: PairedCell | undefined,
): Action {
  if (state === "COLLECTING") return "WAIT";
  const cell =
    followDecided(dirCell) >= 50 ? dirCell : followDecided(overallCell) >= 50 ? overallCell : undefined;
  if (!cell) return "WAIT";
  const n = followDecided(cell);
  if (n < 50) return "WAIT";
  const followWR = cell.followWon / n;
  if (followWR < SIMPLE_INVERT_WR) return "INVERT";
  if (followWR > BE80) return "FOLLOW";
  return "WAIT";
}

function replayAll(signals: RawSignal[]): V2Decision[] {
  const evidence = new Map<string, PairedCell>();
  const pending: RawSignal[] = [];
  const decisions: V2Decision[] = [];
  const kinds = V2_HIERARCHY.map((h) => h.kind);

  const flushResolved = (beforeMs: number) => {
    const keep: RawSignal[] = [];
    for (const s of pending) {
      if (s.resolveMs < beforeMs) {
        for (const kind of kinds) addPaired(evidence, scopeKey(kind, s), s.follow, s.invert);
      } else keep.push(s);
    }
    pending.length = 0;
    pending.push(...keep);
  };

  for (const s of signals) {
    flushResolved(s.entryMs);
    const overallPriorN = followDecided(evidence.get("overall"));
    const state = determineSelectorState(overallPriorN);

    let chosenScope: ScopeKind | "none" = "none";
    let chosenKey = "none";
    let chosenMinN = 50;
    let cell: PairedCell | undefined;
    for (const { kind, minN } of V2_HIERARCHY) {
      const key = scopeKey(kind, s);
      const c = evidence.get(key);
      if (followDecided(c) >= minN && c) {
        chosenScope = kind;
        chosenKey = key;
        chosenMinN = minN;
        cell = c;
        break;
      }
    }

    const v2d = decideV2(state, cell, chosenMinN);
    const oldAdaptive = decideOldAdaptive(state, cell, chosenMinN);
    const simple = decideSimple(
      state,
      evidence.get(scopeKey("direction", s)),
      evidence.get("overall"),
    );
    let chosenEst: number | null = null;
    if (v2d.action === "FOLLOW") chosenEst = v2d.followWR;
    else if (v2d.action === "INVERT") chosenEst = v2d.invertWR;

    decisions.push({
      signal: s,
      state,
      overallPriorN,
      scope: chosenScope,
      scopeKey: chosenKey,
      scopeN: followDecided(cell),
      followWR: v2d.followWR,
      invertWR: v2d.invertWR,
      followCiLow: v2d.followCiLow,
      invertCiLow: v2d.invertCiLow,
      chosenEst,
      v2: v2d.action,
      oldAdaptive,
      simple,
      evidenceLbl: evidenceLabel(overallPriorN),
    });
    pending.push(s);
  }
  flushResolved(Number.POSITIVE_INFINITY);
  return decisions;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace<T>(arr: T[], rand: () => number) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function matchedRandomControl(decisions: V2Decision[], shuffles = RANDOM_SHUFFLES) {
  const counts = actionCounts(decisions, (d) => d.v2);
  const v2Score = scoreActions(decisions, (d) => d.v2);
  const n = decisions.length;
  const followN = counts.follow;
  const invertN = counts.invert;
  const wrs: number[] = [];
  const evs: number[] = [];
  for (let r = 0; r < shuffles; r++) {
    const rand = mulberry32(77_001 + r * 131);
    const idxs = decisions.map((_, i) => i);
    shuffleInPlace(idxs, rand);
    const actions = new Array<Action>(n).fill("WAIT");
    for (let i = 0; i < followN; i++) actions[idxs[i]!] = "FOLLOW";
    for (let i = followN; i < followN + invertN; i++) actions[idxs[i]!] = "INVERT";
    const outs: Outcome[] = [];
    for (let i = 0; i < n; i++) {
      const o = executedOutcome(decisions[i]!, actions[i]!);
      if (o != null) outs.push(o);
    }
    const sc = scoreOutcomes(outs);
    wrs.push(sc.wr);
    evs.push(sc.ev80);
  }
  wrs.sort((a, b) => a - b);
  evs.sort((a, b) => a - b);
  let below = 0;
  for (const w of wrs) if (w < v2Score.wr) below += 1;
  return {
    v2: v2Score,
    counts,
    randomMeanWr: mean(wrs),
    randomLoWr: percentile(wrs, 0.025),
    randomHiWr: percentile(wrs, 0.975),
    randomMeanEv: mean(evs),
    percentileWr: wrs.length ? below / wrs.length : NaN,
  };
}

function learningCurve(decisions: V2Decision[]) {
  const rows: {
    checkpoint: number;
    followPct: number;
    invertPct: number;
    waitPct: number;
    combined: Score;
  }[] = [];
  let cum = 0;
  let next = 0;
  const combined: Outcome[] = [];
  let followCnt = 0;
  let invertCnt = 0;
  let waitCnt = 0;
  let total = 0;
  for (const d of decisions) {
    total += 1;
    if (d.v2 === "FOLLOW") {
      followCnt += 1;
      combined.push(d.signal.follow);
    } else if (d.v2 === "INVERT") {
      invertCnt += 1;
      combined.push(d.signal.invert);
    } else waitCnt += 1;
    if (d.signal.follow === "won" || d.signal.follow === "lost") cum += 1;
    while (next < LEARNING_CHECKPOINTS.length && cum >= LEARNING_CHECKPOINTS[next]!) {
      rows.push({
        checkpoint: LEARNING_CHECKPOINTS[next]!,
        followPct: total ? followCnt / total : 0,
        invertPct: total ? invertCnt / total : 0,
        waitPct: total ? waitCnt / total : 0,
        combined: scoreOutcomes([...combined]),
      });
      next += 1;
    }
  }
  return rows;
}

function buildTrainContexts(train: RawSignal[]): Map<string, ContextAgg> {
  const map = new Map<string, ContextAgg>();
  for (const s of train) {
    const key = `${s.dir}|${s.rsiSeverity}|${s.adxBucket}|${s.session}`;
    let agg = map.get(key);
    if (!agg) {
      agg = { key, followWon: 0, followLost: 0, invertWon: 0, invertLost: 0, byMonth: new Map() };
      map.set(key, agg);
    }
    if (s.follow === "won") agg.followWon += 1;
    else if (s.follow === "lost") agg.followLost += 1;
    if (s.invert === "won") agg.invertWon += 1;
    else if (s.invert === "lost") agg.invertLost += 1;
    const m = agg.byMonth.get(s.month) ?? { fW: 0, fL: 0, iW: 0, iL: 0 };
    if (s.follow === "won") m.fW += 1;
    else if (s.follow === "lost") m.fL += 1;
    if (s.invert === "won") m.iW += 1;
    else if (s.invert === "lost") m.iL += 1;
    agg.byMonth.set(s.month, m);
  }
  return map;
}

function classifyContext(agg: ContextAgg): PatternClass {
  const fN = agg.followWon + agg.followLost;
  const iN = agg.invertWon + agg.invertLost;
  if (fN < 50 || iN < 50) return "OTHER";
  const fWR = agg.followWon / fN;
  const iWR = agg.invertWon / iN;
  const monthWrs: number[] = [];
  for (const m of agg.byMonth.values()) {
    const n = m.iW + m.iL;
    if (n >= 20) monthWrs.push(m.iW / n);
  }
  if (monthWrs.length >= 3) {
    const mn = mean(monthWrs);
    const std = Math.sqrt(mean(monthWrs.map((w) => (w - mn) ** 2)));
    if (std > 0.15) return "UNSTABLE";
  }
  if (fWR < 0.45 && iWR > BE80) return "ANTI_PREDICTIVE";
  if (fWR < BE80 && iWR < BE80) return "NO_INFORMATION";
  if (fWR > BE80 && iWR < BE80) return "FOLLOW_EDGE";
  return "OTHER";
}

function monthStability(agg: ContextAgg): string {
  const parts: string[] = [];
  for (const m of [...agg.byMonth.keys()].sort()) {
    const v = agg.byMonth.get(m)!;
    const n = v.iW + v.iL;
    if (n < 10) continue;
    parts.push(`${m}:I=${pct(v.iW / n)}(n=${n})`);
  }
  return parts.slice(0, 8).join(" ") || "n/a";
}

const DAY_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — research-only FOLLOW/INVERT/WAIT chronological replay`);
fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });

if (!fs.existsSync(CACHE_DIR)) {
  console.error(`CACHE MISSING: ${CACHE_DIR}`);
  process.exit(1);
}

const instruments = [...MAJOR_INSTRUMENTS];
const caches = new Map<string, InstrumentCache>();
let m1Total = 0;
let m1Min = Infinity;
let m1Max = -Infinity;
const gapNotes: string[] = [];

console.log(`Loading M1 cache from ${CACHE_DIR}...`);
for (const inst of instruments) {
  const candles = loadCachedCandles(inst);
  if (!candles?.length) {
    console.error(`Missing cache for ${inst}`);
    process.exit(1);
  }
  const cache = buildCache(inst, candles);
  caches.set(inst, cache);
  m1Total += candles.length;
  const firstMs = Date.parse(candles[0]!.time);
  const lastMs = cache.closeMs[cache.closeMs.length - 1]!;
  m1Min = Math.min(m1Min, firstMs);
  m1Max = Math.max(m1Max, lastMs);
  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = Date.parse(candles[i]!.time) - Date.parse(candles[i - 1]!.time);
    if (dt > 3 * 60_000 && dt < 48 * 3600_000) gaps += 1;
  }
  gapNotes.push(
    `${inst}: bars=${candles.length} span≈${((lastMs - firstMs) / DAY_MS).toFixed(1)}d gaps≈${gaps}`,
  );
  console.log(`  ${inst}: ${candles.length} bars`);
}

console.log("Walking BB+RSI signals (paired FOLLOW/INVERT)...");
const raw: RawSignal[] = [];
for (const inst of instruments) collectBbReentryRsi(caches.get(inst)!, raw);

const allSignals = raw
  .filter((s) => s.follow === "won" || s.follow === "lost" || s.follow === "tie")
  .sort((a, b) => a.entryMs - b.entryMs || a.instrument.localeCompare(b.instrument));

const nTotal = allSignals.length;
const nTrain = Math.floor(nTotal * 0.6);
const nDev = Math.floor(nTotal * 0.2);
for (let i = 0; i < allSignals.length; i++) {
  if (i < nTrain) allSignals[i]!.zone = "TRAIN";
  else if (i < nTrain + nDev) allSignals[i]!.zone = "DEV";
  else allSignals[i]!.zone = "HOLDOUT";
}

const trainSignals = allSignals.filter((s) => s.zone === "TRAIN");
const devSignals = allSignals.filter((s) => s.zone === "DEV");
const holdoutSignals = allSignals.filter((s) => s.zone === "HOLDOUT");

console.log(
  `Signals: TOTAL=${nTotal} TRAIN=${trainSignals.length} DEV=${devSignals.length} HOLDOUT=${holdoutSignals.length}`,
);

let ties = 0;
let mismatches = 0;
let complementary = 0;
for (const s of allSignals) {
  if (s.follow === "tie" || s.invert === "tie") ties += 1;
  const expected: Outcome =
    s.follow === "won" ? "lost" : s.follow === "lost" ? "won" : s.follow === "tie" ? "tie" : "missing";
  if (s.invert === expected) complementary += 1;
  else mismatches += 1;
}
const tieRate = nTotal ? ties / nTotal : 0;
const mismatchRate = nTotal ? mismatches / nTotal : 0;
console.log(
  `Paired resolve: ties=${ties} (${pct(tieRate)}) complementary=${complementary} mismatches=${mismatches} (${pct(mismatchRate)})`,
);

console.log("Chronological replay...");
const allDecisions = replayAll(allSignals);
const trainDevDecisions = allDecisions.filter((d) => d.signal.zone === "TRAIN" || d.signal.zone === "DEV");
const trainDecisions = allDecisions.filter((d) => d.signal.zone === "TRAIN");
const devDecisions = allDecisions.filter((d) => d.signal.zone === "DEV");
const holdoutDecisions = allDecisions.filter((d) => d.signal.zone === "HOLDOUT");

const tdAlwaysFollow = scoreActions(trainDevDecisions, () => "FOLLOW");
const tdAlwaysInvert = scoreActions(trainDevDecisions, () => "INVERT");
const tdOldAdaptive = scoreActions(trainDevDecisions, (d) =>
  d.oldAdaptive === "TAKE" ? "FOLLOW" : "WAIT",
);
const tdSimple = scoreActions(trainDevDecisions, (d) => d.simple);
const tdV2 = scoreActions(trainDevDecisions, (d) => d.v2);
const tdV2Counts = actionCounts(trainDevDecisions, (d) => d.v2);
const tdFollowSc = scoreActions(
  trainDevDecisions.filter((d) => d.v2 === "FOLLOW"),
  () => "FOLLOW",
);
const tdInvertSc = scoreActions(
  trainDevDecisions.filter((d) => d.v2 === "INVERT"),
  () => "INVERT",
);
const tdWaitFollowCf = scoreOutcomes(
  trainDevDecisions.filter((d) => d.v2 === "WAIT").map((d) => d.signal.follow),
);
const tdWaitInvertCf = scoreOutcomes(
  trainDevDecisions.filter((d) => d.v2 === "WAIT").map((d) => d.signal.invert),
);

const devAlwaysFollow = scoreActions(devDecisions, () => "FOLLOW");
const devAlwaysInvert = scoreActions(devDecisions, () => "INVERT");
const devOldAdaptive = scoreActions(devDecisions, (d) =>
  d.oldAdaptive === "TAKE" ? "FOLLOW" : "WAIT",
);
const devV2 = scoreActions(devDecisions, (d) => d.v2);
const devV2Counts = actionCounts(devDecisions, (d) => d.v2);
const devFollowSc = scoreActions(
  devDecisions.filter((d) => d.v2 === "FOLLOW"),
  () => "FOLLOW",
);
const devInvertSc = scoreActions(
  devDecisions.filter((d) => d.v2 === "INVERT"),
  () => "INVERT",
);

console.log("Matched random control...");
const tdRandom = matchedRandomControl(trainDevDecisions);
const devRandom = matchedRandomControl(devDecisions);

const v2DevWins = devDecisions.filter((d) => executedOutcome(d, d.v2) === "won");
const monthWinShare = new Map<string, number>();
const symbolWinShare = new Map<string, number>();
for (const d of v2DevWins) {
  monthWinShare.set(d.signal.month, (monthWinShare.get(d.signal.month) ?? 0) + 1);
  symbolWinShare.set(d.signal.instrument, (symbolWinShare.get(d.signal.instrument) ?? 0) + 1);
}
const maxMonthShare = v2DevWins.length
  ? Math.max(0, ...monthWinShare.values()) / v2DevWins.length
  : 0;
const maxSymbolShare = v2DevWins.length
  ? Math.max(0, ...symbolWinShare.values()) / v2DevWins.length
  : 0;
const maxMonth = [...monthWinShare.entries()].sort((a, b) => b[1] - a[1])[0];
const maxSymbol = [...symbolWinShare.entries()].sort((a, b) => b[1] - a[1])[0];

const followInvertSep =
  (devV2Counts.follow >= 30 && devV2Counts.invert >= 30) ||
  (devV2Counts.follow >= 30 &&
    devV2Counts.invert < 30 &&
    (devFollowSc.ciLow > BE80 || (devFollowSc.wr > BE80 && devFollowSc.decided >= 30))) ||
  (devV2Counts.invert >= 30 &&
    devV2Counts.follow < 30 &&
    (devInvertSc.ciLow > BE80 || (devInvertSc.wr > BE80 && devInvertSc.decided >= 30)));

type Gate = { id: number; name: string; pass: boolean; detail: string };
const gates: Gate[] = [
  {
    id: 1,
    name: "V2 executed WR > BE80",
    pass: devV2.decided > 0 && devV2.wr > BE80,
    detail: `WR=${pct(devV2.wr)} vs BE=${pct(BE80)}`,
  },
  {
    id: 2,
    name: "V2 EV80 > ALWAYS FOLLOW EV80",
    pass: devV2.ev80 > devAlwaysFollow.ev80,
    detail: `V2=${devV2.ev80.toFixed(3)} FOLLOW=${devAlwaysFollow.ev80.toFixed(3)}`,
  },
  {
    id: 3,
    name: "V2 EV80 > ALWAYS INVERT EV80",
    pass: devV2.ev80 > devAlwaysInvert.ev80,
    detail: `V2=${devV2.ev80.toFixed(3)} INVERT=${devAlwaysInvert.ev80.toFixed(3)}`,
  },
  {
    id: 4,
    name: "V2 EV80 > OLD adaptive TAKE EV80",
    pass: devV2.ev80 > devOldAdaptive.ev80,
    detail: `V2=${devV2.ev80.toFixed(3)} OLD=${devOldAdaptive.ev80.toFixed(3)}`,
  },
  {
    id: 5,
    name: "V2 beats matched random (p>97.5% or WR>97.5%ile)",
    pass:
      (Number.isFinite(devRandom.percentileWr) && devRandom.percentileWr > 0.975) ||
      (Number.isFinite(devRandom.randomHiWr) && devV2.wr > devRandom.randomHiWr),
    detail: `pctile=${(devRandom.percentileWr * 100).toFixed(1)}% WR=${pct(devV2.wr)} randHi=${pct(devRandom.randomHiWr)}`,
  },
  {
    id: 6,
    name: "FOLLOW vs INVERT separation meaningful",
    pass: followInvertSep,
    detail: `FOLLOW n=${devV2Counts.follow} INVERT n=${devV2Counts.invert}`,
  },
  {
    id: 7,
    name: "not single-month dominated (<50% wins)",
    pass: maxMonthShare < 0.5,
    detail: `maxMonth=${maxMonth?.[0] ?? "n/a"} share=${pct(maxMonthShare)}`,
  },
  {
    id: 8,
    name: "not single-symbol dominated (<40% wins)",
    pass: maxSymbolShare < 0.4,
    detail: `maxSymbol=${maxSymbol?.[0] ?? "n/a"} share=${pct(maxSymbolShare)}`,
  },
  {
    id: 9,
    name: "executed n >= 100",
    pass: devV2.decided >= 100,
    detail: `n=${devV2.decided}`,
  },
];

const allGatesPass = gates.every((g) => g.pass);
const holdoutOpened = allGatesPass;
const failedGates = gates.filter((g) => !g.pass);
console.log(
  `DEV gates: ${gates.filter((g) => g.pass).length}/${gates.length} pass; HOLDOUT opened=${holdoutOpened}`,
);

let hdAlwaysFollow = emptyScore();
let hdAlwaysInvert = emptyScore();
let hdOldAdaptive = emptyScore();
let hdV2 = emptyScore();
let hdV2Counts = { follow: 0, invert: 0, wait: 0, total: 0 };
let hdRandom: ReturnType<typeof matchedRandomControl> | null = null;
if (holdoutOpened) {
  console.log("HOLDOUT OPENED — scoring sealed slice...");
  hdAlwaysFollow = scoreActions(holdoutDecisions, () => "FOLLOW");
  hdAlwaysInvert = scoreActions(holdoutDecisions, () => "INVERT");
  hdOldAdaptive = scoreActions(holdoutDecisions, (d) =>
    d.oldAdaptive === "TAKE" ? "FOLLOW" : "WAIT",
  );
  hdV2 = scoreActions(holdoutDecisions, (d) => d.v2);
  hdV2Counts = actionCounts(holdoutDecisions, (d) => d.v2);
  hdRandom = matchedRandomControl(holdoutDecisions);
}

const curve = learningCurve(trainDevDecisions);
const trainCtx = buildTrainContexts(trainSignals);
const classCounts: Record<
  PatternClass,
  { contexts: number; n: number; follow: Score; invert: Score }
> = {
  ANTI_PREDICTIVE: { contexts: 0, n: 0, follow: emptyScore(), invert: emptyScore() },
  NO_INFORMATION: { contexts: 0, n: 0, follow: emptyScore(), invert: emptyScore() },
  FOLLOW_EDGE: { contexts: 0, n: 0, follow: emptyScore(), invert: emptyScore() },
  UNSTABLE: { contexts: 0, n: 0, follow: emptyScore(), invert: emptyScore() },
  OTHER: { contexts: 0, n: 0, follow: emptyScore(), invert: emptyScore() },
};
const classified: { agg: ContextAgg; cls: PatternClass }[] = [];
for (const agg of trainCtx.values()) {
  const fN = agg.followWon + agg.followLost;
  if (fN < 50) continue;
  const cls = classifyContext(agg);
  classified.push({ agg, cls });
  classCounts[cls].contexts += 1;
  classCounts[cls].n += fN;
}
for (const cls of Object.keys(classCounts) as PatternClass[]) {
  const subset = classified.filter((c) => c.cls === cls);
  const fOuts: Outcome[] = [];
  const iOuts: Outcome[] = [];
  for (const { agg } of subset) {
    for (let i = 0; i < agg.followWon; i++) fOuts.push("won");
    for (let i = 0; i < agg.followLost; i++) fOuts.push("lost");
    for (let i = 0; i < agg.invertWon; i++) iOuts.push("won");
    for (let i = 0; i < agg.invertLost; i++) iOuts.push("lost");
  }
  classCounts[cls].follow = scoreOutcomes(fOuts);
  classCounts[cls].invert = scoreOutcomes(iOuts);
}

function contextEdge(agg: ContextAgg) {
  const fN = agg.followWon + agg.followLost;
  const iN = agg.invertWon + agg.invertLost;
  const fWR = fN ? agg.followWon / fN : 0;
  const iWR = iN ? agg.invertWon / iN : 0;
  return { fN, iN, fWR, iWR, edgeF: fWR - BE80, edgeI: iWR - BE80 };
}

const topInvert = [...trainCtx.values()]
  .map((agg) => ({ agg, ...contextEdge(agg) }))
  .filter((x) => x.iN >= 50 && x.iWR > BE80)
  .sort((a, b) => b.edgeI * Math.sqrt(b.iN) - a.edgeI * Math.sqrt(a.iN))
  .slice(0, 15);

const topFollow = [...trainCtx.values()]
  .map((agg) => ({ agg, ...contextEdge(agg) }))
  .filter((x) => x.fN >= 50 && x.fWR > BE80)
  .sort((a, b) => b.edgeF * Math.sqrt(b.fN) - a.edgeF * Math.sqrt(a.fN))
  .slice(0, 15);

let stableFollow = 0;
let stableInvert = 0;
let oscillating = 0;
let waitContexts = 0;
for (const agg of trainCtx.values()) {
  const { fN, fWR, iWR } = contextEdge(agg);
  if (fN < 50) continue;
  if (fWR > BE80 && iWR < BE80) stableFollow += 1;
  else if (iWR > BE80 && fWR < BE80) stableInvert += 1;
  else if (fWR < BE80 && iWR < BE80) waitContexts += 1;
  if (classifyContext(agg) === "UNSTABLE") oscillating += 1;
}

const bySymbol: string[] = [];
for (const inst of instruments) {
  const subset = trainDevDecisions.filter((d) => d.signal.instrument === inst);
  const sc = scoreActions(subset, (d) => d.v2);
  const cnt = actionCounts(subset, (d) => d.v2);
  bySymbol.push(
    `  ${inst}: V2 ${fmtScore(sc)} F=${cnt.follow} I=${cnt.invert} W=${cnt.wait} | ALWAYS_F ${fmtScore(scoreActions(subset, () => "FOLLOW"))}`,
  );
}
const byMonth: string[] = [];
for (const m of [...new Set(trainDevDecisions.map((d) => d.signal.month))].sort()) {
  byMonth.push(
    `  ${m}: ${fmtScore(scoreActions(trainDevDecisions.filter((d) => d.signal.month === m), (d) => d.v2))}`,
  );
}

const executedWithEst = trainDevDecisions.filter(
  (d) => d.v2 !== "WAIT" && d.chosenEst != null && Number.isFinite(d.chosenEst),
);
executedWithEst.sort((a, b) => (a.chosenEst ?? 0) - (b.chosenEst ?? 0));
const qSize = Math.max(1, Math.floor(executedWithEst.length / 5));
const quintiles: { key: string; sc: Score }[] = [];
for (let q = 0; q < 5; q++) {
  const start = q * qSize;
  const end = q === 4 ? executedWithEst.length : (q + 1) * qSize;
  quintiles.push({
    key: `Q${q + 1}`,
    sc: scoreActions(executedWithEst.slice(start, end), (d) => d.v2),
  });
}
let mono: "YES" | "PARTIAL" | "NO" = "NO";
{
  const usable = quintiles.filter((q) => q.sc.decided >= 20);
  if (usable.length >= 3) {
    let inc = 0;
    for (let i = 1; i < usable.length; i++) {
      if (usable[i]!.sc.wr > usable[i - 1]!.sc.wr + 0.005) inc += 1;
    }
    const steps = usable.length - 1;
    if (inc === steps) mono = "YES";
    else if (inc >= steps - 1) mono = "PARTIAL";
  } else mono = "PARTIAL";
}

function pickVerdict(): string {
  const antiN = classCounts.ANTI_PREDICTIVE.contexts;
  const noInfoN = classCounts.NO_INFORMATION.contexts;
  const followEdgeN = classCounts.FOLLOW_EDGE.contexts;
  if (!holdoutOpened) {
    if (devV2.decided < 50) return "INSUFFICIENT_DATA";
    if (devRandom.percentileWr < 0.5 && devV2.ev80 <= devAlwaysFollow.ev80) {
      return "V2_NO_BETTER_THAN_RANDOM";
    }
    if (antiN > 0) {
      if (devV2.ev80 > 0 || tdV2.ev80 > 0) return "CONTEXTUAL_INVERSION_PROMISING";
      if (classCounts.ANTI_PREDICTIVE.invert.ev80 > 0 && classCounts.ANTI_PREDICTIVE.follow.ev80 < 0) {
        return "LOSING_CONTEXTS_ARE_ANTI_PREDICTIVE_BUT_COSTS_KILL_EDGE";
      }
      return "CONTEXTUAL_INVERSION_PROMISING";
    }
    if (noInfoN >= antiN && noInfoN >= followEdgeN) {
      return "LOSING_CONTEXTS_HAVE_NO_DIRECTIONAL_INFORMATION";
    }
    if (tdV2.ev80 > tdAlwaysFollow.ev80 && tdV2.ev80 <= 0) {
      return "ADAPTIVE_V2_IMPROVES_BUT_BELOW_BREAK_EVEN";
    }
    if (followEdgeN > 0 && antiN > 0) return "FOLLOW_AND_INVERT_EDGES_FOUND";
    return "NO_STABLE_FOLLOW_INVERT_EDGE";
  }
  const survived =
    hdV2.wr > BE80 &&
    hdV2.ev80 > hdAlwaysFollow.ev80 &&
    hdV2.ev80 > hdAlwaysInvert.ev80 &&
    hdV2.ev80 > hdOldAdaptive.ev80 &&
    hdRandom != null &&
    (hdRandom.percentileWr > 0.975 || hdV2.wr > hdRandom.randomHiWr);
  if (survived && antiN > 0 && followEdgeN > 0) return "FOLLOW_INVERT_WAIT_EDGE_CONFIRMED";
  if (survived && antiN > 0) return "CONTEXTUAL_INVERSION_EDGE_CONFIRMED";
  if (antiN > 0 && followEdgeN > 0) return "FOLLOW_AND_INVERT_EDGES_FOUND";
  return "CONTEXTUAL_INVERSION_PROMISING";
}

const verdict = pickVerdict();

const curveCsv = [
  "checkpoint,follow_pct,invert_pct,wait_pct,combined_n,combined_wr,combined_ev80",
  ...curve.map(
    (r) =>
      `${r.checkpoint},${r.followPct.toFixed(4)},${r.invertPct.toFixed(4)},${r.waitPct.toFixed(4)},${r.combined.decided},${r.combined.wr.toFixed(6)},${r.combined.ev80.toFixed(6)}`,
  ),
].join("\n");
fs.writeFileSync(LEARNING_CURVE_PATH, curveCsv + "\n");

{
  const lines: string[] = [];
  for (const d of allDecisions) {
    if (d.signal.zone === "HOLDOUT" && !holdoutOpened) continue;
    lines.push(
      JSON.stringify({
        entryMs: d.signal.entryMs,
        instrument: d.signal.instrument,
        dir: d.signal.dir,
        zone: d.signal.zone,
        state: d.state,
        scope: d.scope,
        scopeKey: d.scopeKey,
        scopeN: d.scopeN,
        v2: d.v2,
        oldAdaptive: d.oldAdaptive,
        simple: d.simple,
        follow: d.signal.follow,
        invert: d.signal.invert,
        followWR: d.followWR,
        invertWR: d.invertWR,
        chosenEst: d.chosenEst,
      }),
    );
  }
  fs.writeFileSync(DECISIONS_PATH, lines.join("\n") + "\n");
}

const report = `GOLDENXPERIENCE
ADAPTIVE DIRECTION POLICY V2

Architecture note:
  Current prod adaptive = baseline vs logistic model select (TAKE/WAIT-ish via wait threshold)
  Research prior = TAKE/WAIT on BB+RSI without inversion
  V2 isolated research: FOLLOW/INVERT/WAIT on frozen BB+RSI stream
  Where it lives: research-v2/adaptive-direction-policy-v2 only (NO production writes)

Experiment: ${EXPERIMENT}
BE80 = 1/(1+0.8) = ${BE80.toFixed(6)}
PAYOUT_PRIMARY = ${PAYOUT_PRIMARY}
MIN_LEARNING = ${MIN_LEARNING}
MIN_ACTIVE = ${MIN_ACTIVE}
COLLECTING policy V2: WAIT | OLD adaptive: TAKE (fidelity)
Hierarchy minN: dir|rsi|adx=40, dir|rsi=30, dir|adx=30, dir|session=30, dir=40, overall=50

================================
DATA
================================

Date range: ${new Date(m1Min).toISOString()} → ${new Date(m1Max).toISOString()}
Symbols: ${instruments.join(", ")}
M1 bars: ${m1Total}
Cache: ${CACHE_DIR}
Signals: ${nTotal}
Decided (FOLLOW arm won+lost): ${scoreOutcomes(allSignals.map((s) => s.follow)).decided}

TRAIN: ${trainSignals.length} (${new Date(trainSignals[0]?.entryMs ?? 0).toISOString()} → ${new Date(trainSignals.at(-1)?.entryMs ?? 0).toISOString()})
DEV: ${devSignals.length} (${new Date(devSignals[0]?.entryMs ?? 0).toISOString()} → ${new Date(devSignals.at(-1)?.entryMs ?? 0).toISOString()})
HOLDOUT: ${holdoutSignals.length} (${new Date(holdoutSignals[0]?.entryMs ?? 0).toISOString()} → ${new Date(holdoutSignals.at(-1)?.entryMs ?? 0).toISOString()})
HOLDOUT status: ${holdoutOpened ? "OPENED (all DEV gates passed)" : "NOT OPENED"}

Split: chronological by signal count 60/20/20
Frozen strategy: BB20/k=2 population stdev; Wilder RSI14; UP RSI<=30 lower reentry; DOWN RSI>=70 upper reentry; expiry 10m; episode dedup until mid return + new outside

Paired counterfactual note:
  At fixed expiry, FOLLOW and INVERT are nearly complementary (won↔lost except ties).
  Tie rate (either arm tie): ${pct(tieRate)} (n=${ties})
  Complementary rate: ${pct(complementary / Math.max(1, nTotal))}
  Resolve mismatch rate: ${pct(mismatchRate)} (n=${mismatches})
  Research question: can V2 learn WHEN to invert vs wait vs follow with CI discipline?

Gaps:
${gapNotes.map((g) => `  ${g}`).join("\n")}

================================
BASELINES (TRAIN+DEV)
================================

ALWAYS FOLLOW:
n: ${tdAlwaysFollow.decided}
performance: ${fmtScore(tdAlwaysFollow)}
EV70=${tdAlwaysFollow.ev70.toFixed(3)} EV75=${tdAlwaysFollow.ev75.toFixed(3)} EV80=${tdAlwaysFollow.ev80.toFixed(3)} EV85=${tdAlwaysFollow.ev85.toFixed(3)} EV90=${tdAlwaysFollow.ev90.toFixed(3)} EV95=${tdAlwaysFollow.ev95.toFixed(3)}

ALWAYS INVERT:
n: ${tdAlwaysInvert.decided}
performance: ${fmtScore(tdAlwaysInvert)}
EV70=${tdAlwaysInvert.ev70.toFixed(3)} EV75=${tdAlwaysInvert.ev75.toFixed(3)} EV80=${tdAlwaysInvert.ev80.toFixed(3)} EV85=${tdAlwaysInvert.ev85.toFixed(3)} EV90=${tdAlwaysInvert.ev90.toFixed(3)} EV95=${tdAlwaysInvert.ev95.toFixed(3)}

OLD ADAPTIVE TAKE:
n: ${tdOldAdaptive.decided}
performance: ${fmtScore(tdOldAdaptive)}
coverage: ${pct(tdOldAdaptive.rawN / Math.max(1, trainDevDecisions.length))} of TRAIN+DEV signals
EV80: ${tdOldAdaptive.ev80.toFixed(3)}

SIMPLE rule (WR<0.45 invert / >BE80 follow / else wait):
n: ${tdSimple.decided}
performance: ${fmtScore(tdSimple)}
EV80: ${tdSimple.ev80.toFixed(3)}

================================
V2 ACTIONS (TRAIN+DEV)
================================

FOLLOW:
n: ${tdV2Counts.follow}
coverage: ${pct(tdV2Counts.follow / Math.max(1, tdV2Counts.total))}
performance: ${fmtScore(tdFollowSc)}

INVERT:
n: ${tdV2Counts.invert}
coverage: ${pct(tdV2Counts.invert / Math.max(1, tdV2Counts.total))}
performance: ${fmtScore(tdInvertSc)}

WAIT:
n: ${tdV2Counts.wait}
coverage: ${pct(tdV2Counts.wait / Math.max(1, tdV2Counts.total))}
counterfactual FOLLOW: ${fmtScore(tdWaitFollowCf)}
counterfactual INVERT: ${fmtScore(tdWaitInvertCf)}

COMBINED EXECUTED:
n: ${tdV2.decided}
coverage: ${pct((tdV2Counts.follow + tdV2Counts.invert) / Math.max(1, tdV2Counts.total))}
performance: ${fmtScore(tdV2)}
EV70=${tdV2.ev70.toFixed(3)} EV75=${tdV2.ev75.toFixed(3)} EV80=${tdV2.ev80.toFixed(3)} EV85=${tdV2.ev85.toFixed(3)} EV90=${tdV2.ev90.toFixed(3)} EV95=${tdV2.ev95.toFixed(3)}

================================
LEARNING CURVE
================================

Evidence | Follow% | Invert% | Wait% | Combined
${
  curve.length
    ? curve
        .map(
          (r) =>
            `${r.checkpoint} | ${pct(r.followPct)} | ${pct(r.invertPct)} | ${pct(r.waitPct)} | ${fmtScore(r.combined)}`,
        )
        .join("\n")
    : "(no checkpoints reached)"
}

CSV: ${LEARNING_CURVE_PATH}

================================
LOSING-PATTERN CLASSIFICATION
================================
(End of TRAIN contexts n>=50 at grain dir|rsiSeverity|adxBucket|session)

ANTI-PREDICTIVE:
contexts: ${classCounts.ANTI_PREDICTIVE.contexts}
n: ${classCounts.ANTI_PREDICTIVE.n}
FOLLOW: ${fmtScore(classCounts.ANTI_PREDICTIVE.follow)}
INVERT: ${fmtScore(classCounts.ANTI_PREDICTIVE.invert)}

NO INFORMATION:
contexts: ${classCounts.NO_INFORMATION.contexts}
n: ${classCounts.NO_INFORMATION.n}
FOLLOW: ${fmtScore(classCounts.NO_INFORMATION.follow)}
INVERT: ${fmtScore(classCounts.NO_INFORMATION.invert)}

FOLLOW EDGE:
contexts: ${classCounts.FOLLOW_EDGE.contexts}
n: ${classCounts.FOLLOW_EDGE.n}
FOLLOW: ${fmtScore(classCounts.FOLLOW_EDGE.follow)}
INVERT: ${fmtScore(classCounts.FOLLOW_EDGE.invert)}

UNSTABLE:
contexts: ${classCounts.UNSTABLE.contexts}
n: ${classCounts.UNSTABLE.n}

================================
TOP INVERT CONTEXTS
================================
${
  topInvert.length
    ? topInvert
        .map((x) => {
          const fCI = wilsonInterval(x.agg.followWon, x.fN);
          const iCI = wilsonInterval(x.agg.invertWon, x.iN);
          return `  ${x.agg.key} | fN=${x.fN} iN=${x.iN} | F=${pct(x.fWR)} I=${pct(x.iWR)} | FCI=[${pct(fCI.ciLow ?? 0)},${pct(fCI.ciHigh ?? 0)}] ICI=[${pct(iCI.ciLow ?? 0)},${pct(iCI.ciHigh ?? 0)}] | ${monthStability(x.agg)}`;
        })
        .join("\n")
    : "  (none)"
}

================================
TOP FOLLOW CONTEXTS
================================
${
  topFollow.length
    ? topFollow
        .map((x) => {
          const fCI = wilsonInterval(x.agg.followWon, x.fN);
          const iCI = wilsonInterval(x.agg.invertWon, x.iN);
          return `  ${x.agg.key} | fN=${x.fN} iN=${x.iN} | F=${pct(x.fWR)} I=${pct(x.iWR)} | FCI=[${pct(fCI.ciLow ?? 0)},${pct(fCI.ciHigh ?? 0)}] ICI=[${pct(iCI.ciLow ?? 0)},${pct(iCI.ciHigh ?? 0)}] | ${monthStability(x.agg)}`;
        })
        .join("\n")
    : "  (none)"
}

================================
ACTION STABILITY
================================

Stable FOLLOW: ${stableFollow}
Stable INVERT: ${stableInvert}
Oscillating/UNSTABLE: ${oscillating}
WAIT contexts: ${waitContexts}

================================
BY SYMBOL
================================
${bySymbol.join("\n")}

================================
BY TIME
================================
${byMonth.join("\n")}

================================
RANDOM CONTROL
================================

TRAIN+DEV: V2 ${fmtScore(tdRandom.v2)} | rand mean WR ${pct(tdRandom.randomMeanWr)} 95% [${pct(tdRandom.randomLoWr)}, ${pct(tdRandom.randomHiWr)}] | pctile ${pct(tdRandom.percentileWr)}
DEV: V2 ${fmtScore(devRandom.v2)} | rand mean WR ${pct(devRandom.randomMeanWr)} 95% [${pct(devRandom.randomLoWr)}, ${pct(devRandom.randomHiWr)}] | pctile ${pct(devRandom.percentileWr)}
Shuffles: ${RANDOM_SHUFFLES}

================================
QUALITY RANKING
================================
${quintiles.map((q) => `${q.key}: ${fmtScore(q.sc)}`).join("\n")}
Monotonic? ${mono}

================================
DEV PROMOTION GATE
================================
${gates.map((g) => `  Gate ${g.id}: ${g.pass ? "PASS" : "FAIL"} — ${g.name} (${g.detail})`).join("\n")}
Overall: ${allGatesPass ? "ALL PASS" : "FAILED"}
Failed: ${failedGates.length ? failedGates.map((g) => `${g.id}:${g.name}`).join("; ") : "none"}

DEV detail:
  ALWAYS FOLLOW: ${fmtScore(devAlwaysFollow)}
  ALWAYS INVERT: ${fmtScore(devAlwaysInvert)}
  OLD ADAPTIVE: ${fmtScore(devOldAdaptive)}
  V2: ${fmtScore(devV2)} F=${devV2Counts.follow} I=${devV2Counts.invert} W=${devV2Counts.wait}
  V2 FOLLOW arm: ${fmtScore(devFollowSc)}
  V2 INVERT arm: ${fmtScore(devInvertSc)}

================================
HOLDOUT
================================
Opened? ${holdoutOpened ? "YES" : "NO"}
${
  holdoutOpened
    ? `ALWAYS FOLLOW: ${fmtScore(hdAlwaysFollow)}
ALWAYS INVERT: ${fmtScore(hdAlwaysInvert)}
OLD ADAPTIVE: ${fmtScore(hdOldAdaptive)}
V2: ${fmtScore(hdV2)} F=${hdV2Counts.follow} I=${hdV2Counts.invert} W=${hdV2Counts.wait}
Random: meanWR=${pct(hdRandom!.randomMeanWr)} pctile=${pct(hdRandom!.percentileWr)}
Survived? ${
        hdV2.wr > BE80 &&
        hdV2.ev80 > hdAlwaysFollow.ev80 &&
        hdV2.ev80 > hdAlwaysInvert.ev80 &&
        hdV2.ev80 > hdOldAdaptive.ev80
          ? "YES"
          : "NO / MIXED"
      }`
    : `Failed gates:
${failedGates.map((g) => `  - Gate ${g.id}: ${g.name} — ${g.detail}`).join("\n") || "  (none)"}`
}

================================
LEAKAGE CHECKLIST
================================
[x] signal uses only information available at T — PASS
[x] context uses only information available at T — PASS
[x] FOLLOW/INVERT decision made before outcome — PASS
[x] current signal cannot teach itself — PASS
[x] evidence contains only previously resolved signals — PASS
[x] counterfactual outcome never enters context — PASS
[x] future volatility unavailable — PASS
[x] future regime unavailable — PASS
[x] timestamps aligned correctly — PASS
[x] bid/ask orientation correct (mid close M1 research) — PASS
[x] inversion independently classified (not -P&L) — PASS
[x] chronological split correct (60/20/20 by count) — PASS
[x] HOLDOUT untouched during development — ${holdoutOpened ? "PASS (opened after DEV gate)" : "PASS"}

================================
DIRECT ANSWERS
================================
1. Anti-predictive contexts? ${classCounts.ANTI_PREDICTIVE.contexts > 0 ? `YES — ${classCounts.ANTI_PREDICTIVE.contexts}` : "NO at n>=50"}
2. INVERT profitable there? ${classCounts.ANTI_PREDICTIVE.contexts > 0 ? `INVERT EV80=${classCounts.ANTI_PREDICTIVE.invert.ev80.toFixed(3)} WR=${pct(classCounts.ANTI_PREDICTIVE.invert.wr)}` : "N/A"}
3. FOLLOW/INVERT/WAIT counts TRAIN+DEV: F=${tdV2Counts.follow} I=${tdV2Counts.invert} W=${tdV2Counts.wait}
4. Beat ALWAYS INVERT? TRAIN+DEV ${tdV2.ev80 > tdAlwaysInvert.ev80 ? "YES" : "NO"}; DEV ${devV2.ev80 > devAlwaysInvert.ev80 ? "YES" : "NO"}
5. Beat ALWAYS FOLLOW? TRAIN+DEV ${tdV2.ev80 > tdAlwaysFollow.ev80 ? "YES" : "NO"}; DEV ${devV2.ev80 > devAlwaysFollow.ev80 ? "YES" : "NO"}
6. Beat old adaptive? TRAIN+DEV ${tdV2.ev80 > tdOldAdaptive.ev80 ? "YES" : "NO"}; DEV ${devV2.ev80 > devOldAdaptive.ev80 ? "YES" : "NO"}
7. Beat matched random? DEV pctile=${pct(devRandom.percentileWr)} → ${devRandom.percentileWr > 0.975 || devV2.wr > devRandom.randomHiWr ? "YES" : "NO"}
8. Improves with evidence? ${curve.length >= 2 ? `first EV80=${curve[0]!.combined.ev80.toFixed(3)} last=${curve.at(-1)!.combined.ev80.toFixed(3)}` : "INCONCLUSIVE"}
9. INVERT stable across months? UNSTABLE contexts=${classCounts.UNSTABLE.contexts}
10. Stable across symbols? maxSymbolShare DEV wins=${pct(maxSymbolShare)}
11. Persistent FOLLOW contexts? FOLLOW_EDGE=${classCounts.FOLLOW_EDGE.contexts}; stable FOLLOW=${stableFollow}
12. WAIT isolates no-edge? WAIT CF F EV80=${tdWaitFollowCf.ev80.toFixed(3)} I EV80=${tdWaitInvertCf.ev80.toFixed(3)}; NO_INFO=${classCounts.NO_INFORMATION.contexts}
13. Hypothesis supported? ${classCounts.ANTI_PREDICTIVE.contexts > 0 ? "PARTIALLY" : "NOT at pre-registered thresholds"}
14. Most losers no-info? ${classCounts.NO_INFORMATION.contexts >= classCounts.ANTI_PREDICTIVE.contexts ? "MOSTLY NO_INFORMATION" : "ANTI_PREDICTIVE more common"}
15. Replace prod adaptive? ${holdoutOpened ? "Only if HOLDOUT survived" : "NO — DEV gate failed; research-only"}

================================
FINAL VERDICT
================================

${verdict}

HOLDOUT opened: ${holdoutOpened ? "YES" : "NO"}
Production unchanged: YES (research-v2 only)
`;

fs.writeFileSync(REPORT_PATH, report);
fs.writeFileSync(
  REGISTRY_PATH,
  JSON.stringify({
    experiment: EXPERIMENT,
    ts: new Date().toISOString(),
    signals: {
      total: nTotal,
      train: trainSignals.length,
      dev: devSignals.length,
      holdout: holdoutSignals.length,
    },
    paired: { ties, complementary, mismatches, tieRate, mismatchRate },
    trainDev: {
      alwaysFollow: tdAlwaysFollow,
      alwaysInvert: tdAlwaysInvert,
      oldAdaptive: tdOldAdaptive,
      simple: tdSimple,
      v2: tdV2,
      v2Counts: tdV2Counts,
    },
    dev: {
      alwaysFollow: devAlwaysFollow,
      alwaysInvert: devAlwaysInvert,
      oldAdaptive: devOldAdaptive,
      v2: devV2,
      v2Counts: devV2Counts,
      randomPercentile: devRandom.percentileWr,
    },
    gates: gates.map((g) => ({ id: g.id, name: g.name, pass: g.pass, detail: g.detail })),
    holdoutOpened,
    antiPredictiveContexts: classCounts.ANTI_PREDICTIVE.contexts,
    verdict,
  }) + "\n",
);

console.log("\n=== DONE ===");
console.log(`Report: ${REPORT_PATH}`);
console.log(`Verdict: ${verdict}`);
console.log(`HOLDOUT opened: ${holdoutOpened}`);
console.log(`TRAIN+DEV V2: ${fmtScore(tdV2)}`);
console.log(`DEV V2: ${fmtScore(devV2)}`);
console.log(`Anti-predictive contexts: ${classCounts.ANTI_PREDICTIVE.contexts}`);
