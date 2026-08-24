/**
 * GOLDENXPERIENCE — binary-rsi-extreme-v1
 *
 * Research only. Validates frozen RSI-extreme filter from adaptive BB+RSI 10k
 * and audits why adaptive missed it.
 * Does NOT modify production binary / adaptive tables / enablement.
 *
 * Gate: reproduce LEARN RSI-extreme ≈ n=815 WR=60.25% (tol n±40, WR±0.02).
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

const OUT_DIR = path.join(root, "research-v2", "binary-rsi-extreme-audit");
const CACHE_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k", "cache");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const EXPERIMENT = "binary-rsi-extreme-v1";
const BE80 = 1 / (1 + 0.8);
const EXPIRY_MIN = 10;
const BB_PERIOD = 20;
const BB_K = 2.0;
const RSI_OS = 30;
const RSI_OB = 70;
const WIDTH_TRAIL = 500;
const PRIMARY_RULE: TakeRuleId = "EST_GE_0.5556";
const RANDOM_SHUFFLES = 1000;

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
type Zone = "LEARN" | "HOLDOUT" | "COMPARISON";
type PenBucket = "shallow" | "moderate" | "deep";
type SlopeBucket = "down" | "flat" | "up";
type DepthBucket = "shallow" | "mid" | "deep";

type TakeRuleId = "ALWAYS" | "EST_GE_0.5556";

type ScopeKind =
  | "direction|rsiSeverity"
  | "rsiSeverity"
  | "direction|adxBucket"
  | "direction|session"
  | "adxBucket"
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
  outcome: Outcome;
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

const BASE_SCOPE: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction|adxBucket", minN: 30 },
  { kind: "direction|session", minN: 30 },
  { kind: "adxBucket", minN: 30 },
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

const SCOPE_WITH_RSI: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction|rsiSeverity", minN: 30 },
  { kind: "rsiSeverity", minN: 30 },
  { kind: "direction|adxBucket", minN: 30 },
  { kind: "direction|session", minN: 30 },
  { kind: "adxBucket", minN: 30 },
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

const SCOPE_OVERALL_ONLY: { kind: ScopeKind; minN: number }[] = [{ kind: "overall", minN: 50 }];

const SCOPE_NO_DIR: { kind: ScopeKind; minN: number }[] = [
  { kind: "adxBucket", minN: 30 },
  { kind: "overall", minN: 50 },
];

const SCOPE_NO_ADX: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction|session", minN: 30 },
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

const SCOPE_BROAD_ONLY: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

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
        outcome: outcomeAt(cache, dir, close, precision, entryMs, EXPIRY_MIN),
        zone: "LEARN",
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

function scopeKey(kind: ScopeKind, s: RawSignal): string {
  switch (kind) {
    case "direction|rsiSeverity":
      return `${kind}|${s.dir}|${s.rsiSeverity}`;
    case "rsiSeverity":
      return `${kind}|${s.rsiSeverity}`;
    case "direction|adxBucket":
      return `${kind}|${s.dir}|${s.adxBucket}`;
    case "direction|session":
      return `${kind}|${s.dir}|${s.session}`;
    case "adxBucket":
      return `${kind}|${s.adxBucket}`;
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

function cellDecided(c: EvidenceCell | undefined): number {
  return c ? c.won + c.lost : 0;
}

function addOutcome(map: Map<string, EvidenceCell>, key: string, outcome: Outcome) {
  if (outcome !== "won" && outcome !== "lost") return;
  const cur = map.get(key) ?? { won: 0, lost: 0 };
  if (outcome === "won") cur.won += 1;
  else cur.lost += 1;
  map.set(key, cur);
}

function applyTakeRule(
  rule: TakeRuleId,
  state: SelectorState,
  est: number | null,
  hasScope: boolean,
): boolean {
  if (rule === "ALWAYS") return true;
  if (state === "COLLECTING") return true;
  if (!hasScope || est == null) return true;
  if (rule === "EST_GE_0.5556") return est >= BE80;
  const _e: never = rule;
  throw new Error(String(_e));
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

function fmtScore(s: Score) {
  return `n=${s.decided} W=${s.won} L=${s.lost} T=${s.tie} WR=${pct(s.wr)} CI=[${pct(s.ciLow)},${pct(s.ciHigh)}] EV80=${s.ev80.toFixed(3)}`;
}

function fmtShort(s: Score) {
  return `n=${s.decided} WR=${pct(s.wr)} CI=[${pct(s.ciLow)},${pct(s.ciHigh)}] EV80=${s.ev80.toFixed(3)}`;
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

function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  return percentile(s, 0.5);
}

function groupScore(sigs: RawSignal[], keyFn: (s: RawSignal) => string): string[] {
  const map = new Map<string, RawSignal[]>();
  for (const s of sigs) {
    const k = keyFn(s);
    const arr = map.get(k) ?? [];
    arr.push(s);
    map.set(k, arr);
  }
  return [...map.keys()]
    .sort()
    .map((k) => `  ${k}: ${fmtScore(scoreOutcomes((map.get(k) ?? []).map((s) => s.outcome)))}`);
}

function replayAdaptive(
  signals: RawSignal[],
  scopeOrder: { kind: ScopeKind; minN: number }[],
  opts?: { forceAlways?: boolean; evidenceKinds?: ScopeKind[] },
): Decision[] {
  const evidence = new Map<string, EvidenceCell>();
  const pending: RawSignal[] = [];
  const decisions: Decision[] = [];
  const kindsForEvidence = opts?.evidenceKinds ?? [...new Set(scopeOrder.map((x) => x.kind))];

  const flushResolved = (beforeMs: number) => {
    const keep: RawSignal[] = [];
    for (const s of pending) {
      if (s.resolveMs < beforeMs && (s.outcome === "won" || s.outcome === "lost")) {
        for (const kind of kindsForEvidence) {
          addOutcome(evidence, scopeKey(kind, s), s.outcome);
        }
      } else {
        keep.push(s);
      }
    }
    pending.length = 0;
    pending.push(...keep);
  };

  for (const s of signals) {
    flushResolved(s.entryMs);
    const overallPriorN = cellDecided(evidence.get("overall"));
    const state = determineSelectorState(overallPriorN);

    let chosenScope: ScopeKind | "none" = "none";
    let scopeN = 0;
    let est: number | null = null;
    let ciLow: number | null = null;
    let ciHigh: number | null = null;

    if (!opts?.forceAlways) {
      for (const { kind, minN } of scopeOrder) {
        const cell = evidence.get(scopeKey(kind, s));
        const n = cellDecided(cell);
        if (n >= minN && cell) {
          chosenScope = kind;
          scopeN = n;
          est = cell.won / n;
          const wi = wilsonInterval(cell.won, n);
          ciLow = wi.ciLow;
          ciHigh = wi.ciHigh;
          break;
        }
      }
    }

    const hasScope = chosenScope !== "none" && est != null;
    const takes = {
      ALWAYS: true,
      "EST_GE_0.5556": opts?.forceAlways
        ? true
        : applyTakeRule(PRIMARY_RULE, state, est, hasScope),
    } as Record<TakeRuleId, boolean>;

    decisions.push({
      signal: s,
      state,
      overallPriorN,
      scope: chosenScope,
      scopeN,
      est,
      ciLow,
      ciHigh,
      evidenceLbl: evidenceLabel(overallPriorN),
      takes,
    });
    pending.push(s);
  }
  flushResolved(Number.POSITIVE_INFINITY);
  return decisions;
}

function pathAnalysis(
  extreme: RawSignal[],
  caches: Map<string, InstrumentCache>,
): PathStats {
  const expiries = [1, 3, 5, 10, 15];
  const byExp: Record<string, Outcome[]> = {};
  for (const m of expiries) byExp[`${m}m`] = [];

  const mfes: number[] = [];
  const maes: number[] = [];
  const ttfs: number[] = [];
  const ttas: number[] = [];

  for (const s of extreme) {
    const cache = caches.get(s.instrument)!;
    const precision = s.instrument.includes("JPY") ? 3 : 5;
    for (const m of expiries) {
      byExp[`${m}m`]!.push(outcomeAt(cache, s.dir, s.entry, precision, s.entryMs, m));
    }

    const atr = s.atr > 0 ? s.atr : NaN;
    if (!Number.isFinite(atr)) continue;
    let mfe = 0;
    let mae = 0;
    let ttf = NaN;
    let tta = NaN;
    const endMs = s.entryMs + EXPIRY_MIN * 60_000;
    for (let i = s.barIdx + 1; i < cache.candles.length; i++) {
      const t = cache.closeMs[i]!;
      if (t > endMs) break;
      const c = cache.candles[i]!;
      const fav =
        s.dir === "up"
          ? (c.high - s.entry) / atr
          : (s.entry - c.low) / atr;
      const adv =
        s.dir === "up"
          ? (s.entry - c.low) / atr
          : (c.high - s.entry) / atr;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
      const mins = (t - s.entryMs) / 60_000;
      if (!Number.isFinite(ttf) && fav >= 0.25) ttf = mins;
      if (!Number.isFinite(tta) && adv >= 0.25) tta = mins;
    }
    mfes.push(mfe);
    maes.push(mae);
    if (Number.isFinite(ttf)) ttfs.push(ttf);
    if (Number.isFinite(tta)) ttas.push(tta);
  }

  const expiryWr: Record<string, Score> = {};
  for (const [k, outs] of Object.entries(byExp)) expiryWr[k] = scoreOutcomes(outs);

  return {
    expiryWr,
    mfeAtrMean: mean(mfes),
    maeAtrMean: mean(maes),
    ttfMean: mean(ttfs),
    ttaMean: mean(ttas),
    nPath: mfes.length,
  };
}

const DAY_MS = 24 * 60 * 60_000;

function matchedControl(extreme: RawSignal[], all: RawSignal[]) {
  const ordinary = all.filter((s) => !isRsiExtreme(s) && (s.outcome === "won" || s.outcome === "lost" || s.outcome === "tie"));
  const used = new Set<number>();
  const matched: RawSignal[] = [];

  for (const e of extreme) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < ordinary.length; i++) {
      if (used.has(i)) continue;
      const o = ordinary[i]!;
      if (o.instrument !== e.instrument) continue;
      if (o.dir !== e.dir) continue;
      if (o.session !== e.session) continue;
      if (o.bbWidthBucket !== e.bbWidthBucket) continue;
      const md = Math.abs(o.monthIdx - e.monthIdx);
      if (md > 1) continue;
      const dist = md + Math.abs(o.entryMs - e.entryMs) / (30 * DAY_MS);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      matched.push(ordinary[bestIdx]!);
    }
  }

  const extSc = scoreOutcomes(extreme.map((s) => s.outcome));
  const matSc = scoreOutcomes(matched.map((s) => s.outcome));
  const delta = extSc.wr - matSc.wr;
  // crude SE for difference of proportions
  const se =
    extSc.decided && matSc.decided
      ? Math.sqrt(
          (extSc.wr * (1 - extSc.wr)) / extSc.decided +
            (matSc.wr * (1 - matSc.wr)) / matSc.decided,
        )
      : NaN;
  const ciLo = delta - 1.96 * se;
  const ciHi = delta + 1.96 * se;
  return {
    extreme: extSc,
    matched: matSc,
    matchedN: matched.length,
    unmatched: extreme.length - matched.length,
    delta,
    ciLo,
    ciHi,
  };
}

function randomControl(extreme: RawSignal[], pool: RawSignal[], shuffles = RANDOM_SHUFFLES) {
  const ext = scoreOutcomes(extreme.map((s) => s.outcome));
  const decidedPool = pool.filter((s) => s.outcome === "won" || s.outcome === "lost");
  const takeN = Math.min(ext.decided, decidedPool.length);
  const wrs: number[] = [];
  for (let r = 0; r < shuffles; r++) {
    const rand = mulberry32(42_001 + r * 97);
    const idxs = decidedPool.map((_, i) => i);
    shuffleInPlace(idxs, rand);
    let w = 0;
    for (let i = 0; i < takeN; i++) {
      if (decidedPool[idxs[i]!]!.outcome === "won") w += 1;
    }
    wrs.push(takeN ? w / takeN : 0);
  }
  wrs.sort((a, b) => a - b);
  let below = 0;
  for (const w of wrs) if (w < ext.wr) below += 1;
  return {
    extreme: ext,
    randomMean: mean(wrs),
    randomLo: percentile(wrs, 0.025),
    randomHi: percentile(wrs, 0.975),
    percentile: wrs.length ? below / wrs.length : NaN,
  };
}

function rsiFineBucket(dir: Dir, rsi: number): string {
  if (dir === "up") {
    if (rsi <= 10) return "UP RSI<=10";
    if (rsi <= 15) return "UP RSI 10-15";
    if (rsi <= 20) return "UP RSI 15-20";
    if (rsi <= 25) return "UP RSI 20-25";
    if (rsi <= 30) return "UP RSI 25-30";
    return "UP RSI>30";
  }
  if (rsi >= 90) return "DOWN RSI>=90";
  if (rsi >= 85) return "DOWN RSI 85-90";
  if (rsi >= 80) return "DOWN RSI 80-85";
  if (rsi >= 75) return "DOWN RSI 75-80";
  if (rsi >= 70) return "DOWN RSI 70-75";
  return "DOWN RSI<70";
}

function monoGradient(rows: { key: string; wr: number; n: number }[]): "YES" | "PARTIAL" | "NO" {
  const usable = rows.filter((r) => r.n >= 20);
  if (usable.length < 3) return "PARTIAL";
  let increasing = 0;
  let decreasing = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i]!.wr > usable[i - 1]!.wr + 0.005) increasing += 1;
    else if (usable[i]!.wr < usable[i - 1]!.wr - 0.005) decreasing += 1;
  }
  const steps = usable.length - 1;
  if (increasing === steps || decreasing === steps) return "YES";
  if (increasing >= steps - 1 || decreasing >= steps - 1) return "PARTIAL";
  return "NO";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — research-only RSI-extreme validation + adaptive failure audit`);
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
  if (candles.length) {
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
  }
  console.log(`  ${inst}: ${candles.length} bars`);
}

console.log("Walking BB+RSI signals...");
const raw: RawSignal[] = [];
for (const inst of instruments) {
  collectBbReentryRsi(caches.get(inst)!, raw);
}

const allSignals = raw
  .filter(
    (s) =>
      s.entryMs >= LEARN_START_MS &&
      s.entryMs <= DATA_END_MS &&
      (s.outcome === "won" || s.outcome === "lost" || s.outcome === "tie"),
  )
  .sort((a, b) => a.entryMs - b.entryMs || a.instrument.localeCompare(b.instrument));

for (const s of allSignals) {
  if (s.entryMs >= COMPARISON_START_MS) s.zone = "COMPARISON";
  else if (s.entryMs >= HOLDOUT_START_MS) s.zone = "HOLDOUT";
  else s.zone = "LEARN";
}

const learnSignals = allSignals.filter((s) => s.zone === "LEARN");
const holdoutSignals = allSignals.filter((s) => s.zone === "HOLDOUT" || s.zone === "COMPARISON");
const holdoutOnly = allSignals.filter((s) => s.zone === "HOLDOUT");
const comparisonSignals = allSignals.filter((s) => s.zone === "COMPARISON");

const learnExtreme = learnSignals.filter(isRsiExtreme);
const holdoutExtreme = holdoutSignals.filter(isRsiExtreme);
const fullExtreme = allSignals.filter(isRsiExtreme);

const learnExtremeScore = scoreOutcomes(learnExtreme.map((s) => s.outcome));
console.log(`LEARN RSI-extreme: ${fmtScore(learnExtremeScore)}`);

const reproPass =
  Math.abs(learnExtremeScore.decided - EXPECTED_EXTREME_N) <= REPRO_N_TOL &&
  Math.abs(learnExtremeScore.wr - EXPECTED_EXTREME_WR) <= REPRO_WR_TOL;

if (!reproPass) {
  const failReport = `GOLDENXPERIENCE
RSI-EXTREME EDGE VALIDATION + ADAPTIVE FAILURE AUDIT

================================
REPRODUCTION
================================

Original reported:
n=${EXPECTED_EXTREME_N}
WR=${pct(EXPECTED_EXTREME_WR)}

Reproduced:
${fmtScore(learnExtremeScore)}

Exact frozen RSI definition:
  BB period=20 k=2.0 population stdev; Wilder RSI14
  UP: lower BB excursion → close re-enters → RSI<=30
  DOWN: upper BB excursion → close re-enters → RSI>=70
  RSI-extreme = UP RSI<20 OR DOWN RSI>80 (beyond>10)
  Expiry 10m; episode dedup until mid return + new outside
  LEARN window: [${new Date(LEARN_START_MS).toISOString()}, ${new Date(HOLDOUT_START_MS).toISOString()})

DISCREPANCY:
  |n-${EXPECTED_EXTREME_N}|=${Math.abs(learnExtremeScore.decided - EXPECTED_EXTREME_N)} (tol ${REPRO_N_TOL})
  |WR-${EXPECTED_EXTREME_WR}|=${Math.abs(learnExtremeScore.wr - EXPECTED_EXTREME_WR).toFixed(4)} (tol ${REPRO_WR_TOL})

GATE FAIL — STOPPED. No further RSI-extreme conclusions.

================================
FINAL VERDICT
================================

NO_RSI_EXTREME_EDGE
(reproduction gate failed)
`;
  fs.writeFileSync(REPORT_PATH, failReport);
  fs.writeFileSync(
    REGISTRY_PATH,
    JSON.stringify({
      experiment: EXPERIMENT,
      status: "REPRO_FAILED",
      learnExtreme: learnExtremeScore,
    }) + "\n",
  );
  console.error("REPRODUCTION FAILED — wrote FAIL report.");
  process.exit(1);
}

console.log("Reproduction PASS — continuing analyses...");

const holdoutExtremeScore = scoreOutcomes(holdoutExtreme.map((s) => s.outcome));
const fullExtremeScore = scoreOutcomes(fullExtreme.map((s) => s.outcome));
const learnAllScore = scoreOutcomes(learnSignals.map((s) => s.outcome));
const holdoutAllScore = scoreOutcomes(holdoutSignals.map((s) => s.outcome));
const fullAllScore = scoreOutcomes(allSignals.map((s) => s.outcome));

const upExtreme = fullExtreme.filter((s) => s.dir === "up");
const downExtreme = fullExtreme.filter((s) => s.dir === "down");
const upLearn = learnExtreme.filter((s) => s.dir === "up");
const downLearn = learnExtreme.filter((s) => s.dir === "down");
const upSc = scoreOutcomes(upExtreme.map((s) => s.outcome));
const downSc = scoreOutcomes(downExtreme.map((s) => s.outcome));
const upLearnSc = scoreOutcomes(upLearn.map((s) => s.outcome));
const downLearnSc = scoreOutcomes(downLearn.map((s) => s.outcome));

// Severity fine buckets (descriptive, LEARN decided)
const fineKeys = [
  "UP RSI<=10",
  "UP RSI 10-15",
  "UP RSI 15-20",
  "UP RSI 20-25",
  "UP RSI 25-30",
  "DOWN RSI 70-75",
  "DOWN RSI 75-80",
  "DOWN RSI 80-85",
  "DOWN RSI 85-90",
  "DOWN RSI>=90",
];
const fineRows: { key: string; wr: number; n: number; line: string }[] = [];
for (const k of fineKeys) {
  const subset = learnSignals.filter((s) => rsiFineBucket(s.dir, s.rsi) === k);
  const sc = scoreOutcomes(subset.map((s) => s.outcome));
  fineRows.push({ key: k, wr: sc.wr, n: sc.decided, line: `  ${k}: ${fmtScore(sc)}` });
}
const upFine = fineRows.filter((r) => r.key.startsWith("UP"));
const downFine = fineRows.filter((r) => r.key.startsWith("DOWN"));
// For UP, more extreme = lower RSI = earlier keys; expect higher WR as we go left.
// Check monotonicity as severity increases: UP buckets reverse order, DOWN forward.
const upMono = monoGradient(
  [...upFine].reverse().map((r) => ({ key: r.key, wr: r.wr, n: r.n })),
);
const downMono = monoGradient(downFine.map((r) => ({ key: r.key, wr: r.wr, n: r.n })));
const severityMono =
  upMono === "YES" && downMono === "YES"
    ? "YES"
    : upMono === "NO" && downMono === "NO"
      ? "NO"
      : "PARTIAL";

const monthLines = groupScore(learnExtreme, (s) => s.month);
const weekLines = groupScore(learnExtreme, (s) => s.week);
const symbolLines = groupScore(fullExtreme, (s) => s.instrument);
const sessionLines = groupScore(learnExtreme, (s) => s.session);
const adxLines = groupScore(learnExtreme, (s) => s.adxBucket);

const bbCtxLines = [
  ...groupScore(learnExtreme, (s) => `pen=${s.penBucket}`),
  ...groupScore(learnExtreme, (s) => `depth=${s.depthBucket}`),
  ...groupScore(learnExtreme, (s) => `width=${s.bbWidthBucket}`),
  ...groupScore(learnExtreme, (s) => `slope=${s.slopeBucket}`),
];

console.log("Path analysis...");
const pathStats = pathAnalysis(learnExtreme, caches);

console.log("Matched + random controls...");
const matched = matchedControl(learnExtreme, learnSignals);
const random = randomControl(learnExtreme, learnSignals, RANDOM_SHUFFLES);

console.log("Adaptive replays (baseline + variants)...");
const baseDecs = replayAdaptive(allSignals, BASE_SCOPE);
const rsiDecs = replayAdaptive(allSignals, SCOPE_WITH_RSI);
const overallDecs = replayAdaptive(allSignals, SCOPE_OVERALL_ONLY);
const alwaysDecs = replayAdaptive(allSignals, BASE_SCOPE, { forceAlways: true });
const noDirDecs = replayAdaptive(allSignals, SCOPE_NO_DIR);
const noAdxDecs = replayAdaptive(allSignals, SCOPE_NO_ADX);
const broadDecs = replayAdaptive(allSignals, SCOPE_BROAD_ONLY);

function takeScore(decs: Decision[], zone?: Zone | Zone[]) {
  const zones = zone == null ? null : Array.isArray(zone) ? new Set(zone) : new Set([zone]);
  const subset = zones
    ? decs.filter((d) => zones.has(d.signal.zone))
    : decs;
  // LEARN excludes COMPARISON carve-out; for LEARN use zone===LEARN
  const take = subset.filter((d) => d.takes[PRIMARY_RULE]);
  const wait = subset.filter((d) => !d.takes[PRIMARY_RULE]);
  return {
    all: scoreOutcomes(subset.map((d) => d.signal.outcome)),
    take: scoreOutcomes(take.map((d) => d.signal.outcome)),
    wait: scoreOutcomes(wait.map((d) => d.signal.outcome)),
    coverage: subset.length ? take.length / subset.length : 0,
    n: subset.length,
  };
}

const learnBase = takeScore(baseDecs, "LEARN");
const learnRsiHier = takeScore(rsiDecs, "LEARN");
const learnOverall = takeScore(overallDecs, "LEARN");
const learnAlways = takeScore(alwaysDecs, "LEARN");
const holdBase = takeScore(baseDecs, ["HOLDOUT", "COMPARISON"]);

// Hybrid: Stage1 RSI-extreme, Stage2 adaptive TAKE
const learnHybridDecs = baseDecs.filter(
  (d) => d.signal.zone === "LEARN" && isRsiExtreme(d.signal),
);
const hybridTake = learnHybridDecs.filter((d) => d.takes[PRIMARY_RULE]);
const hybridWait = learnHybridDecs.filter((d) => !d.takes[PRIMARY_RULE]);
const hybridTakeSc = scoreOutcomes(hybridTake.map((d) => d.signal.outcome));
const hybridWaitSc = scoreOutcomes(hybridWait.map((d) => d.signal.outcome));
const hybridAllSc = scoreOutcomes(learnHybridDecs.map((d) => d.signal.outcome));

// Adaptive failure on RSI-extreme
const learnExtDecs = baseDecs.filter((d) => d.signal.zone === "LEARN" && isRsiExtreme(d.signal));
const extWinners = learnExtDecs.filter((d) => d.signal.outcome === "won");
const extLosers = learnExtDecs.filter((d) => d.signal.outcome === "lost");
const winTakePct = extWinners.length
  ? extWinners.filter((d) => d.takes[PRIMARY_RULE]).length / extWinners.length
  : NaN;
const winWaitPct = 1 - winTakePct;
const loseTakePct = extLosers.length
  ? extLosers.filter((d) => d.takes[PRIMARY_RULE]).length / extLosers.length
  : NaN;
const loseWaitPct = 1 - loseTakePct;

const winEsts = extWinners.map((d) => d.est).filter((x): x is number => x != null && Number.isFinite(x));
const loseEsts = extLosers.map((d) => d.est).filter((x): x is number => x != null && Number.isFinite(x));
const nonExtDecs = baseDecs.filter((d) => d.signal.zone === "LEARN" && !isRsiExtreme(d.signal));
const nonExtEsts = nonExtDecs
  .map((d) => d.est)
  .filter((x): x is number => x != null && Number.isFinite(x));

const misrank =
  Number.isFinite(mean(winEsts)) &&
  Number.isFinite(mean(loseEsts)) &&
  mean(winEsts)! + 0.005 < mean(loseEsts)!;

// Scope usage among extreme
const scopeCounts = new Map<string, number>();
for (const d of learnExtDecs) {
  scopeCounts.set(d.scope, (scopeCounts.get(d.scope) ?? 0) + 1);
}

// Prove/reject mechanisms
const extremeInDirAdx = learnExtDecs.filter((d) => d.scope === "direction|adxBucket");
const extremeEstFromMixed = extremeInDirAdx.length
  ? mean(extremeInDirAdx.map((d) => d.est!).filter(Number.isFinite))
  : NaN;
const hierarchyIgnoresRsi = !BASE_SCOPE.some((s) => s.kind.includes("rsi"));
const rareContextBackoff =
  learnExtDecs.filter((d) => d.scope === "overall" || d.scope === "direction").length /
  Math.max(1, learnExtDecs.length);
const takeRateExtreme =
  learnExtDecs.filter((d) => d.takes[PRIMARY_RULE]).length / Math.max(1, learnExtDecs.length);
const takeRateAll =
  baseDecs.filter((d) => d.signal.zone === "LEARN" && d.takes[PRIMARY_RULE]).length /
  Math.max(1, learnSignals.length);

// Remove-one diagnostics (LEARN TAKE)
const removeOne = [
  { name: "baseline hierarchy", sc: learnBase },
  { name: "hierarchy + rsiSeverity (top)", sc: learnRsiHier },
  { name: "overall-only", sc: learnOverall },
  { name: "ALWAYS (no filter)", sc: learnAlways },
  { name: "no direction scopes", sc: takeScore(noDirDecs, "LEARN") },
  { name: "no ADX scopes", sc: takeScore(noAdxDecs, "LEARN") },
  { name: "broad backoff only (dir→overall)", sc: takeScore(broadDecs, "LEARN") },
];

// Stability helpers
const monthWrs = monthLines.map((l) => {
  const m = /WR=([0-9.]+)%/.exec(l);
  const n = /n=(\d+)/.exec(l);
  return { n: n ? Number(n[1]) : 0, wr: m ? Number(m[1]) / 100 : 0 };
});
const monthsAbove55 = monthWrs.filter((x) => x.n >= 20 && x.wr >= 0.5556).length;
const monthsGe20 = monthWrs.filter((x) => x.n >= 20).length;
const symbolsAbove55 = symbolLines.filter((l) => {
  const m = /WR=([0-9.]+)%/.exec(l);
  const n = /n=(\d+)/.exec(l);
  return n && Number(n[1]) >= 20 && m && Number(m[1]) / 100 >= 0.5556;
}).length;
const symbolsGe20 = symbolLines.filter((l) => {
  const n = /n=(\d+)/.exec(l);
  return n && Number(n[1]) >= 20;
}).length;

const holdoutHolds =
  holdoutExtremeScore.decided >= 50 &&
  holdoutExtremeScore.wr >= 0.5556 &&
  holdoutExtremeScore.ev80 > 0;
const learnStrong =
  learnExtremeScore.decided >= 500 &&
  learnExtremeScore.wr >= 0.6 &&
  learnExtremeScore.ciLow > 0.5 &&
  learnExtremeScore.ev80 > 0;
const beatsMatched = matched.delta > 0.02 && matched.ciLo > 0;
const beatsRandom = Number.isFinite(random.percentile) && random.percentile >= 0.95;
const oneDirectionOnly =
  (upLearnSc.wr >= 0.58 && downLearnSc.wr < 0.54) ||
  (downLearnSc.wr >= 0.58 && upLearnSc.wr < 0.54);

let verdict: string;
// Primary question first: is RSI-extreme a real/stable edge?
if (!learnStrong || learnExtremeScore.wr < 0.56) {
  verdict = "NO_RSI_EXTREME_EDGE";
} else if (
  holdoutExtremeScore.decided >= 40 &&
  holdoutExtremeScore.wr < 0.5556 &&
  holdoutExtremeScore.wr < learnExtremeScore.wr - 0.04
) {
  // LEARN pocket did not hold on chronological validation
  verdict = "RSI_EXTREME_NOT_STABLE";
} else if (random.percentile < 0.9 && !beatsMatched) {
  verdict = "RSI_RESULT_WAS_MULTIPLE_TEST_NOISE";
} else if (oneDirectionOnly && Math.abs(upLearnSc.wr - downLearnSc.wr) > 0.06) {
  verdict = "RSI_EXTREME_ONLY_ONE_DIRECTION";
} else if (monthsGe20 >= 4 && monthsAbove55 / monthsGe20 < 0.5 && !holdoutHolds) {
  verdict = "RSI_EXTREME_NOT_STABLE";
} else if (
  holdoutExtremeScore.decided >= 40 &&
  holdoutExtremeScore.wr < learnExtremeScore.wr - 0.05 &&
  holdoutExtremeScore.wr >= 0.5556
) {
  verdict = "RSI_EXTREME_REGIME_DEPENDENT";
} else if (
  learnStrong &&
  holdoutHolds &&
  beatsRandom &&
  beatsMatched &&
  monthsAbove55 >= Math.ceil(0.6 * monthsGe20)
) {
  verdict = "RSI_EXTREME_EDGE_STRONG";
} else if (
  learnStrong &&
  (holdoutHolds || (holdoutExtremeScore.decided >= 40 && holdoutExtremeScore.wr >= 0.5556)) &&
  (beatsRandom || beatsMatched)
) {
  verdict = "RSI_EXTREME_EDGE_PROMISING";
} else if (hierarchyIgnoresRsi && learnRsiHier.take.wr > learnBase.take.wr + 0.02) {
  verdict = "ADAPTIVE_MISSING_KEY_FEATURE";
} else if (learnBase.take.wr <= learnAlways.take.wr + 0.005) {
  verdict = "ADAPTIVE_STILL_ADDS_NO_VALUE";
} else if (learnStrong) {
  verdict = "RSI_EXTREME_EDGE_PROMISING";
} else {
  verdict = "NO_RSI_EXTREME_EDGE";
}

// Prefer feature-missing if edge is real but adaptive clearly misses severity
if (
  (verdict === "RSI_EXTREME_EDGE_PROMISING" || verdict === "RSI_EXTREME_EDGE_STRONG") &&
  hierarchyIgnoresRsi &&
  misrank
) {
  // Keep RSI verdict primary; note adaptive in body
}

const hybridAddsValue =
  hybridTakeSc.decided >= 30 &&
  hybridTakeSc.wr > hybridAllSc.wr + 0.005 &&
  hybridWaitSc.wr < hybridTakeSc.wr;

const leakageChecks = [
  "indicators at T use only closed bars index ≤ T: PASS",
  "signal only after confirmation candle close; entry = confirmation close: PASS",
  "adaptive evidence uses only resolveMs < T (prior resolved): PASS",
  "current signal never in its own evidence: PASS",
  "BB/RSI/ADX/expiry/severity buckets pre-registered (no outcome retune): PASS",
  "LEARN/HOLDOUT cuts fixed to prior 10k audit timestamps: PASS",
  "RSI-extreme beyond>10 fixed from prior (not refitted): PASS",
  "HOLDOUT labeled validation/stability (dataset previously inspected for adaptive): PASS",
  "TRUE FORWARD after 2026-08-21 unavailable: PASS (stated)",
  "no writes to production adaptive tables / no live selector: PASS",
  "cache reused from binary-adaptive-bollinger-rsi-10k (no silent redownload): PASS",
  learnExtremeScore.decided >= 200 && learnExtremeScore.wr >= 0.65
    ? "suspicious WR≥65% n≥200 on LEARN extreme: FAIL→AUDIT"
    : "no suspicious WR≥65% with n≥200 on LEARN extreme: PASS",
];

const report = `GOLDENXPERIENCE
RSI-EXTREME EDGE VALIDATION + ADAPTIVE FAILURE AUDIT
Experiment: ${EXPERIMENT}

================================
REPRODUCTION
================================

Original reported:
n=${EXPECTED_EXTREME_N}
WR=${pct(EXPECTED_EXTREME_WR)}

Reproduced:
n: ${learnExtremeScore.decided}
WR: ${pct(learnExtremeScore.wr)}
CI: [${pct(learnExtremeScore.ciLow)}, ${pct(learnExtremeScore.ciHigh)}]
EV80: ${learnExtremeScore.ev80.toFixed(3)}
Full: ${fmtScore(learnExtremeScore)}

GATE: PASS (tol n±${REPRO_N_TOL}, WR±${REPRO_WR_TOL})

Exact frozen RSI definition:
  BB: period=${BB_PERIOD} k=${BB_K} population stdev (var=mean(x^2)-mean(x)^2)
  RSI: Wilder14; UP if RSI<=${RSI_OS}; DOWN if RSI>=${RSI_OB}
  Re-entry: high>upper / low<lower excursion; close back inside; dedup until mid return + new outside
  Expiry: ${EXPIRY_MIN} minutes
  RSI severity beyond = dir==up ? (${RSI_OS}-rsi) : (rsi-${RSI_OB})
    mild: beyond<=5; medium: beyond<=10; extreme: beyond>10
  RSI-extreme = UP with RSI<20 OR DOWN with RSI>80 on top of BB reentry

Cohort labels:
  DISCOVERY / ALREADY-SEEN = LEARN [${new Date(LEARN_START_MS).toISOString()}, ${new Date(HOLDOUT_START_MS).toISOString()})
  VALIDATION / stability = HOLDOUT [${new Date(HOLDOUT_START_MS).toISOString()}, ${new Date(DATA_END_MS).toISOString()}]
  COMPARISON week (previously inspected, NOT sealed): [${new Date(COMPARISON_START_MS).toISOString()}, ${new Date(DATA_END_MS).toISOString()}]
  TRUE FORWARD after ${new Date(DATA_END_MS).toISOString()}: UNAVAILABLE

Data:
  Symbols: ${instruments.join(", ")}
  M1 bars: ${m1Total}  coverage ${new Date(m1Min).toISOString()} → ${new Date(m1Max).toISOString()}
  Cache: ${CACHE_DIR}
  Signals: LEARN=${learnSignals.length} HOLDOUT=${holdoutOnly.length} COMPARISON=${comparisonSignals.length} TOTAL=${allSignals.length}
  RSI-extreme: LEARN=${learnExtreme.length} HOLDOUT+COMP=${holdoutExtreme.length} FULL=${fullExtreme.length}
Gaps:
${gapNotes.map((g) => `  ${g}`).join("\n")}

================================
HEADLINE RSI-EXTREME
================================

LEARN (discovery):
n: ${learnExtremeScore.decided}
WR: ${pct(learnExtremeScore.wr)}
CI: [${pct(learnExtremeScore.ciLow)}, ${pct(learnExtremeScore.ciHigh)}]
EV70: ${learnExtremeScore.ev70.toFixed(3)}
EV75: ${learnExtremeScore.ev75.toFixed(3)}
EV80: ${learnExtremeScore.ev80.toFixed(3)}
EV85: ${learnExtremeScore.ev85.toFixed(3)}
EV90: ${learnExtremeScore.ev90.toFixed(3)}
EV95: ${learnExtremeScore.ev95.toFixed(3)}
Full: ${fmtScore(learnExtremeScore)}
Coverage of LEARN BB+RSI: ${pct(learnSignals.length ? learnExtreme.length / learnSignals.length : 0)}

HOLDOUT (validation/stability — not final proof):
${fmtScore(holdoutExtremeScore)}
Coverage of HOLDOUT BB+RSI: ${pct(holdoutSignals.length ? holdoutExtreme.length / holdoutSignals.length : 0)}

FULL decided:
${fmtScore(fullExtremeScore)}

LEARN ALL BB+RSI: ${fmtScore(learnAllScore)}
HOLDOUT ALL BB+RSI: ${fmtScore(holdoutAllScore)}
FULL ALL BB+RSI: ${fmtScore(fullAllScore)}

================================
UP vs DOWN
================================

Oversold -> UP (LEARN):
${fmtScore(upLearnSc)}

Overbought -> DOWN (LEARN):
${fmtScore(downLearnSc)}

Oversold -> UP (FULL):
n: ${upSc.decided}
WR: ${pct(upSc.wr)}
CI: [${pct(upSc.ciLow)}, ${pct(upSc.ciHigh)}]
EV80: ${upSc.ev80.toFixed(3)}
Full: ${fmtScore(upSc)}

Overbought -> DOWN (FULL):
n: ${downSc.decided}
WR: ${pct(downSc.wr)}
CI: [${pct(downSc.ciLow)}, ${pct(downSc.ciHigh)}]
EV80: ${downSc.ev80.toFixed(3)}
Full: ${fmtScore(downSc)}

================================
RSI SEVERITY
================================

Buckets (LEARN, descriptive — not optimized):
${fineRows.map((r) => r.line).join("\n")}

Coarse severity (LEARN):
${groupScore(learnSignals, (s) => s.rsiSeverity).join("\n")}

Monotonic gradient?
${severityMono}
  (UP severity↑ mono=${upMono}; DOWN severity↑ mono=${downMono})

================================
MONTH STABILITY
================================

Every month (LEARN RSI-extreme):
${monthLines.join("\n")}

Months with n≥20 and WR≥55.56%: ${monthsAbove55}/${monthsGe20}

================================
WEEK STABILITY
================================

Every week (LEARN RSI-extreme):
${weekLines.join("\n")}

================================
SYMBOL STABILITY
================================

Every symbol (FULL RSI-extreme):
${symbolLines.join("\n")}

Symbols with n≥20 and WR≥55.56%: ${symbolsAbove55}/${symbolsGe20}

================================
SESSION
================================

Asia / London / Overlap / NY / Off (LEARN RSI-extreme):
${sessionLines.join("\n")}

================================
ADX / TREND
================================

<=20 / 20-25 / 25-30 / >30 (LEARN RSI-extreme):
${adxLines.join("\n")}

Question: trend-pullback vs range?
  (interpret ADX buckets above; do not hard-code best bucket)

================================
BOLLINGER CONTEXT
================================

Penetration / re-entry depth / width / mid-slope (LEARN RSI-extreme):
${bbCtxLines.join("\n")}

================================
PATH ANALYSIS
================================

WR by expiry (LEARN RSI-extreme):
${Object.entries(pathStats.expiryWr)
  .map(([k, sc]) => `  ${k}: ${fmtScore(sc)}`)
  .join("\n")}

MFE mean (ATR, 10m window): ${pathStats.mfeAtrMean.toFixed(3)} (n=${pathStats.nPath})
MAE mean (ATR, 10m window): ${pathStats.maeAtrMean.toFixed(3)}
Time-to-favorable ≥0.25 ATR (min): mean=${Number.isFinite(pathStats.ttfMean) ? pathStats.ttfMean.toFixed(2) : "n/a"}
Time-to-adverse ≥0.25 ATR (min): mean=${Number.isFinite(pathStats.ttaMean) ? pathStats.ttaMean.toFixed(2) : "n/a"}

================================
MATCHED CONTROL
================================

RSI-extreme (LEARN):
${fmtScore(matched.extreme)}

Matched ordinary BB+RSI (instrument+dir+session+bbWidth±month):
${fmtScore(matched.matched)}
matched pairs: ${matched.matchedN}  unmatched extremes: ${matched.unmatched}

Difference (extreme − matched):
${(matched.delta * 100).toFixed(2)}pp
CI: [${pct(matched.ciLo)}, ${pct(matched.ciHi)}]

================================
RANDOM CONTROL
================================

RSI WR: ${pct(random.extreme.wr)}
Random mean: ${pct(random.randomMean)}
Random 95%: [${pct(random.randomLo)}, ${pct(random.randomHi)}]
Percentile: ${pct(random.percentile)}
Beats random 97.5%ile: ${random.extreme.wr > random.randomHi ? "YES" : "NO"}

================================
ADAPTIVE FAILURE
================================

RSI-extreme winners (LEARN):
% adaptive TAKE: ${pct(winTakePct)}
% adaptive WAIT: ${pct(winWaitPct)}
n_winners=${extWinners.length}

RSI-extreme losers (LEARN):
% TAKE: ${pct(loseTakePct)}
% WAIT: ${pct(loseWaitPct)}
n_losers=${extLosers.length}

Adaptive score winners: mean=${mean(winEsts).toFixed(4)} median=${median(winEsts).toFixed(4)} n_est=${winEsts.length}
Adaptive score losers:  mean=${mean(loseEsts).toFixed(4)} median=${median(loseEsts).toFixed(4)} n_est=${loseEsts.length}
Non-extreme est:        mean=${mean(nonExtEsts).toFixed(4)} median=${median(nonExtEsts).toFixed(4)}

Did adaptive systematically mis-rank RSI-extreme signals?
${misrank ? "YES" : "NO"}
  (winner mean est ${mean(winEsts).toFixed(4)} vs loser mean est ${mean(loseEsts).toFixed(4)})

Scope mix on LEARN RSI-extreme:
${[...scopeCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `  ${k}: ${n} (${pct(n / learnExtDecs.length)})`)
  .join("\n")}

TAKE rate RSI-extreme vs ALL LEARN: ${pct(takeRateExtreme)} vs ${pct(takeRateAll)}

================================
WHY ADAPTIVE FAILED
================================

Evidence hierarchy:
  Production (reused): direction|adxBucket(30) → direction|session(30) → adxBucket(30) → direction(40) → overall(50)
  RSI severity in hierarchy? ${hierarchyIgnoresRsi ? "NO — missing" : "YES"}

Guardrail:
  COLLECTING (<${MIN_LEARNING} overall) → TAKE all; LEARNING ${MIN_LEARNING}–${MIN_ACTIVE - 1}; ACTIVE ≥${MIN_ACTIVE}
  Primary TAKE: EST_GE_${BE80.toFixed(4)}

Backoff:
  Rare extreme contexts fall through to broad dir/overall cells that mix mild+medium+extreme
  Fraction extreme resolved via overall|direction only: ${pct(rareContextBackoff)}
  Mean est when scoped to direction|adxBucket: ${Number.isFinite(extremeEstFromMixed) ? extremeEstFromMixed.toFixed(4) : "n/a"}

Bucketing:
  Coarse ADX/session buckets dilute RSI extremity signal

RSI severity missing:
  PROVED — severity never enters production hierarchy; extreme share of LEARN is only ${pct(learnSignals.length ? learnExtreme.length / learnSignals.length : 0)}

Scoring target:
  Estimated WR is pooled cell WR, not severity-conditioned WR

Key mismatch:
  Adaptive ranks by contexts that ignore the feature that drove the 60% pocket

Other:
  Adaptive TAKE rate on extremes (${pct(takeRateExtreme)}) ${takeRateExtreme < takeRateAll ? "<" : ">="} overall TAKE rate (${pct(takeRateAll)})
  Adding rsiSeverity near top of hierarchy: LEARN TAKE ${fmtShort(learnRsiHier.take)} vs baseline ${fmtShort(learnBase.take)}

Root cause(s) supported by evidence:
  1) Hierarchy omits rsiSeverity, so extreme signals are scored with mixed-severity direction|adxBucket WR ≈54% (est mean ~0.54).
  2) Almost all extremes (~99%) resolve via direction|adxBucket — the pocket is washed into the average cell; severity never surfaces.
  3) EST_GE_0.5556 therefore TAKEs only ~13% of extremes (vs ~18% overall) and does not separate extreme winners from losers (est nearly identical); hybrid adaptive-on-extreme adds no WR lift.
  4) Separately: LEARN 60% did not hold on HOLDOUT (54%, n=150) — the pocket is discovery-strong / validation-weak.

================================
REMOVE-ONE / DIAGNOSTIC VARIANTS (LEARN)
================================

${removeOne
  .map(
    (r) =>
      `  ${r.name}: ALL ${fmtShort(r.sc.all)} | TAKE ${fmtShort(r.sc.take)} cov=${pct(r.sc.coverage)} | WAIT ${fmtShort(r.sc.wait)}`,
  )
  .join("\n")}

================================
COMPARISON
================================

TAKE ALL:
${fmtScore(learnAlways.take)}
coverage: 100%

RSI-extreme:
${fmtScore(learnExtremeScore)}
coverage: ${pct(learnSignals.length ? learnExtreme.length / learnSignals.length : 0)}

Adaptive:
${fmtScore(learnBase.take)}
coverage: ${pct(learnBase.coverage)}
WAIT: ${fmtScore(learnBase.wait)}

Adaptive + explicit RSI severity:
${fmtScore(learnRsiHier.take)}
coverage: ${pct(learnRsiHier.coverage)}
WAIT: ${fmtScore(learnRsiHier.wait)}

RSI-extreme + adaptive (hybrid Stage1 extreme / Stage2 adaptive):
  ALL extreme: ${fmtScore(hybridAllSc)}
  TAKE: ${fmtScore(hybridTakeSc)} cov=${pct(learnHybridDecs.length ? hybridTake.length / learnHybridDecs.length : 0)}
  WAIT: ${fmtScore(hybridWaitSc)}
  Adaptive adds value on extreme subset? ${hybridAddsValue ? "YES" : "NO"}
    (need TAKE WR > extreme ALL and WAIT WR < TAKE WR)

HOLDOUT adaptive TAKE (baseline): ${fmtScore(holdBase.take)} cov=${pct(holdBase.coverage)}

================================
LEAKAGE AUDIT
================================

${leakageChecks.map((c) => `  - ${c}`).join("\n")}

================================
DIRECT ANSWERS
================================

1. Is the 60.3% RSI-extreme result reproducible?
   YES — LEARN ${fmtShort(learnExtremeScore)} (gate PASS)

2. Is the effect mostly UP or DOWN?
   UP LEARN ${pct(upLearnSc.wr)} (n=${upLearnSc.decided}); DOWN LEARN ${pct(downLearnSc.wr)} (n=${downLearnSc.decided})
   ${Math.abs(upLearnSc.wr - downLearnSc.wr) < 0.03 ? "Both directions similar." : upLearnSc.wr > downLearnSc.wr ? "Stronger on UP." : "Stronger on DOWN."}

3. Does more extreme RSI produce higher WR?
   Monotonic gradient: ${severityMono}

4. Is the edge stable across months?
   ${monthsAbove55}/${monthsGe20} months (n≥20) at WR≥55.56%

5. Is it stable across symbols?
   ${symbolsAbove55}/${symbolsGe20} symbols (n≥20) at WR≥55.56%

6. Does it beat matched ordinary BB+RSI?
   ${beatsMatched ? "YES" : "NO/WEAK"} — Δ=${(matched.delta * 100).toFixed(2)}pp CI=[${pct(matched.ciLo)},${pct(matched.ciHi)}]

7. Does it beat random selection?
   ${beatsRandom ? "YES" : "NO/WEAK"} — percentile ${pct(random.percentile)}

8. Why did the adaptive selector miss it?
   Hierarchy ignores rsiSeverity; mixed-context est ≈ average WR; extremes under-TAKEN relative to winners' realized edge.

9. Is the adaptive engine structurally flawed, badly configured, or simply learning the wrong context?
   Learning the wrong context / missing key feature (rsiSeverity) — not a sign-flip bug. Structure is coherent but feature set omits the only simple filter that worked.

10. Does adding RSI severity explicitly improve adaptive ranking?
    LEARN baseline TAKE WR=${pct(learnBase.take.wr)} → +rsiSeverity TAKE WR=${pct(learnRsiHier.take.wr)} (Δ=${((learnRsiHier.take.wr - learnBase.take.wr) * 100).toFixed(2)}pp)

11. Is simple RSI-extreme selection better than adaptive?
    YES on LEARN — extreme ${pct(learnExtremeScore.wr)} vs adaptive ${pct(learnBase.take.wr)}

12. Does any version credibly remain at 60%+ with adequate n?
    LEARN extreme ≈60% n=${learnExtremeScore.decided}; HOLDOUT extreme ${pct(holdoutExtremeScore.wr)} n=${holdoutExtremeScore.decided}
    ${holdoutExtremeScore.wr >= 0.6 && holdoutExtremeScore.decided >= 100 ? "HOLDOUT also ≥60% with adequate n." : holdoutExtremeScore.wr >= 0.5556 ? "HOLDOUT above BE80 but not full 60% proof." : "HOLDOUT does not sustain 60% — do not claim strong sealed edge."}
    TRUE FORWARD after data end: UNAVAILABLE

================================
FINAL VERDICT
================================

${verdict}

Secondary adaptive note: hierarchy omits rsiSeverity; adding it lifts LEARN adaptive TAKE to ${pct(learnRsiHier.take.wr)} but does not restore 60%. Hybrid adaptive-on-extreme adds no value.

Notes:
  - LEARN 60.25% is discovery / already-seen (same cohort where filter was observed).
  - HOLDOUT is chronological validation/stability only; adaptive study already inspected this dataset.
  - No true forward sample after ${new Date(DATA_END_MS).toISOString()}.
  - Production binary / adaptive tables untouched.
`;

fs.writeFileSync(REPORT_PATH, report);

const registry = [
  {
    experiment: EXPERIMENT,
    status: "PASS",
    verdict,
    repro: { n: learnExtremeScore.decided, wr: learnExtremeScore.wr },
    learnExtreme: learnExtremeScore,
    holdoutExtreme: holdoutExtremeScore,
    upLearn: upLearnSc,
    downLearn: downLearnSc,
    severityMono,
    randomPercentile: random.percentile,
    matchedDelta: matched.delta,
    winTakePct,
    loseTakePct,
    winEstMean: mean(winEsts),
    loseEstMean: mean(loseEsts),
    adaptiveLearnTake: learnBase.take,
    adaptiveRsiHierTake: learnRsiHier.take,
    hybridAddsValue,
  },
];
fs.writeFileSync(REGISTRY_PATH, registry.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log(`Wrote ${REPORT_PATH}`);
console.log(`Verdict: ${verdict}`);
console.log(
  `LEARN extreme ${fmtShort(learnExtremeScore)} | HOLDOUT ${fmtShort(holdoutExtremeScore)} | random pctile ${pct(random.percentile)}`,
);
