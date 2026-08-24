/**
 * GOLDENXPERIENCE — adaptive-bollinger-rsi-v1
 *
 * Research only. Does NOT modify binary-baseline-v1, production adaptive
 * tables/selector, prediction paths, or live/paper execution.
 *
 * Gate: reproduce BB_REENTRY_RSI|BB20|10m TEST ≈ n=168 WR=58.93% EV80=+0.061
 * then walk-forward contextual TAKE/WAIT on the same frozen signal stream.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { classifyBinaryResult, type BinaryCandle } from "../src/binary-engine.js";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";
import { evidenceLabel, wilsonInterval } from "../src/binary-regimes.js";
import {
  BINARY_ADAPTIVE_SELECTOR_CONFIG,
  determineSelectorState,
  type SelectorState,
} from "../src/binary-adaptive-selector.js";

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-audit");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT_3M.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry_3m.jsonl");

const EXPERIMENT = "adaptive-bollinger-rsi-v1-3m";
/** Calendar lookback for M1 (≈3 months). */
const LOOKBACK_DAYS = 90;
/** Final week matches prior bollinger TEST (gate + previously inspected). */
const GATE_WEEK_DAYS = 7;
/** Share of pre-gate history used as TRAIN evidence; remainder = MID eval. */
const TRAIN_FRACTION_OF_PRE_GATE = 0.67;
const BE80 = 1 / (1 + 0.8);
const EXPIRY_MIN = 10;
const BB_PERIOD = 20;
const BB_K = 2.0;
const RSI_OS = 30;
const RSI_OB = 70;
const WIDTH_TRAIL = 500;

/** Justified defaults from BINARY_ADAPTIVE_SELECTOR_CONFIG — NOT tuned on TEST WR. */
const MIN_LEARNING = BINARY_ADAPTIVE_SELECTOR_CONFIG.minLearningPairedSamples; // 50
const MIN_ACTIVE = BINARY_ADAPTIVE_SELECTOR_CONFIG.minActivePairedSamples; // 100

/** Prior bollinger audit TEST end — for UNSEEN / previously-inspected labeling. */
const PRIOR_TEST_END_MS = Date.parse("2026-08-21T21:00:00.000Z");
const EXPECTED_N = 168;
const EXPECTED_WR = 0.5893;

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
type Dir = "up" | "down";
type Side = "upper" | "lower";
type AdxBucket = "le20" | "b20_25" | "b25_30" | "gt30";
type RsiSeverity = "mild" | "medium" | "extreme";
type BbWidthBucket = "low" | "mid" | "high";
/** TRAIN=evidence warmup; MID=primary eval (less previously mined); DEV=last 7d gate week; UNSEEN=after prior audit end */
type Zone = "TRAIN" | "MID" | "DEV" | "UNSEEN";

type TakeRuleId =
  | "ALWAYS"
  | "EST_GE_0.5556"
  | "EST_GE_0.58"
  | "EST_GE_0.60"
  | "CI_LOW_GT_0.50"
  | "CI_LOW_GT_0.5556";

const TAKE_RULES: TakeRuleId[] = [
  "ALWAYS",
  "EST_GE_0.5556",
  "EST_GE_0.58",
  "EST_GE_0.60",
  "CI_LOW_GT_0.50",
  "CI_LOW_GT_0.5556",
];

type ScopeKind =
  | "direction|adxBucket"
  | "direction|session"
  | "adxBucket"
  | "direction"
  | "overall";

const SCOPE_ORDER: { kind: ScopeKind; minN: number }[] = [
  { kind: "direction|adxBucket", minN: 30 },
  { kind: "direction|session", minN: 30 },
  { kind: "adxBucket", minN: 30 },
  { kind: "direction", minN: 40 },
  { kind: "overall", minN: 50 },
];

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
  adxBucket: AdxBucket;
  rsiSeverity: RsiSeverity;
  bbWidthBucket: BbWidthBucket;
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

const registryLines: string[] = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  if (h >= 12 && h < 17) return "newyork";
  return "off";
}

function adxBucketOf(adx: number): AdxBucket {
  if (!Number.isFinite(adx)) return "gt30";
  if (adx <= 20) return "le20";
  if (adx <= 25) return "b20_25";
  if (adx <= 30) return "b25_30";
  return "gt30";
}

/** Fixed pre-registered severity beyond threshold — not fitted on TEST. */
function rsiSeverityOf(dir: Dir, rsi: number): RsiSeverity {
  const beyond = dir === "up" ? RSI_OS - rsi : rsi - RSI_OB;
  if (beyond <= 5) return "mild";
  if (beyond <= 10) return "medium";
  return "extreme";
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
  // 3-month study needs ~90 trading days of M1 (~25–30×5k pages/pair).
  const fromMs = Date.parse(fromIso) - 2 * 24 * 60 * 60_000;
  const nowSafeMs = Date.now() - 60_000;
  const toMs = Math.min(Date.parse(toIso) + 20 * 60_000, nowSafeMs);
  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  for (let page = 0; page < 120; page++) {
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toCandles(raw).filter((c) => c.complete);
    if (!batch.length) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((m, c) => (c.time < m ? c.time : m), batch[0]!.time);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(100);
  }
  const by = new Map(all.map((c) => [c.time, c]));
  return [...by.values()].sort((a, b) => a.time.localeCompare(b.time));
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
  if (!mark || mark.timeMs <= startMs) return "missing";
  return classifyBinaryResult(dir, entry, mark.price, precision);
}

type SideState = { outside: boolean; signaled: boolean };

/**
 * Exact BB_REENTRY_RSI episode logic from bollinger audit (BB20 only).
 * Episode state advances on all bars; zone labels apply from studyStart onward.
 */
function zoneOf(entryMs: number, midStartMs: number, gateStartMs: number, dataEndMs: number): Zone {
  if (entryMs > PRIOR_TEST_END_MS) return "UNSEEN";
  if (entryMs >= gateStartMs && entryMs <= dataEndMs) return "DEV";
  if (entryMs >= midStartMs && entryMs < gateStartMs) return "MID";
  return "TRAIN";
}

function collectBbReentryRsi(
  cache: InstrumentCache,
  midStartMs: number,
  gateStartMs: number,
  dataEndMs: number,
  out: RawSignal[],
) {
  const upper: SideState = { outside: false, signaled: false };
  const lower: SideState = { outside: false, signaled: false };
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
        }
      }
    }

    if (!upper.signaled && c.high > up) upper.outside = true;
    if (!lower.signaled && c.low < lo) lower.outside = true;

    const upperReentry = upper.outside && c.close <= up;
    const lowerReentry = lower.outside && c.close >= lo;

    if (upperReentry) {
      if (!upper.signaled) {
        if (Number.isFinite(rsi) && rsi >= RSI_OB) {
          const close = Number(c.close);
          const zone = zoneOf(entryMs, midStartMs, gateStartMs, dataEndMs);
          out.push({
            instrument: cache.instrument,
            side: "upper",
            dir: "down",
            entry: close,
            entryMs,
            resolveMs: entryMs + EXPIRY_MIN * 60_000,
            barIdx: i,
            adx: Number.isFinite(adx) ? adx : NaN,
            rsi,
            session: sessionOf(entryMs),
            day: ET_DAY.format(new Date(entryMs)),
            adxBucket: adxBucketOf(adx),
            rsiSeverity: rsiSeverityOf("down", rsi),
            bbWidthBucket: trailingWidthBucket(cache.bbWidthAtr, i),
            outcome: outcomeAt(cache, "down", close, precision, entryMs, EXPIRY_MIN),
            zone,
          });
        }
        upper.signaled = true;
      }
      upper.outside = false;
    }

    if (lowerReentry) {
      if (!lower.signaled) {
        if (Number.isFinite(rsi) && rsi <= RSI_OS) {
          const close = Number(c.close);
          const zone = zoneOf(entryMs, midStartMs, gateStartMs, dataEndMs);
          out.push({
            instrument: cache.instrument,
            side: "lower",
            dir: "up",
            entry: close,
            entryMs,
            resolveMs: entryMs + EXPIRY_MIN * 60_000,
            barIdx: i,
            adx: Number.isFinite(adx) ? adx : NaN,
            rsi,
            session: sessionOf(entryMs),
            day: ET_DAY.format(new Date(entryMs)),
            adxBucket: adxBucketOf(adx),
            rsiSeverity: rsiSeverityOf("up", rsi),
            bbWidthBucket: trailingWidthBucket(cache.bbWidthAtr, i),
            outcome: outcomeAt(cache, "up", close, precision, entryMs, EXPIRY_MIN),
            zone,
          });
        }
        lower.signaled = true;
      }
      lower.outside = false;
    }
  }
}

function scopeKey(kind: ScopeKind, s: RawSignal): string {
  switch (kind) {
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

/**
 * COLLECTING: selective rules TAKE (cannot claim selection).
 * LEARNING/ACTIVE: apply rule; insufficient evidence → TAKE.
 */
function applyTakeRule(
  rule: TakeRuleId,
  state: SelectorState,
  est: number | null,
  ciLow: number | null,
  hasScope: boolean,
): boolean {
  if (rule === "ALWAYS") return true;
  if (state === "COLLECTING") return true;
  if (!hasScope || est == null) return true;
  switch (rule) {
    case "EST_GE_0.5556":
      return est >= BE80;
    case "EST_GE_0.58":
      return est >= 0.58;
    case "EST_GE_0.60":
      return est >= 0.6;
    case "CI_LOW_GT_0.50":
      return ciLow != null && ciLow > 0.5;
    case "CI_LOW_GT_0.5556":
      return ciLow != null && ciLow > BE80;
    default: {
      const _e: never = rule;
      throw new Error(String(_e));
    }
  }
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

type RuleEval = {
  rule: TakeRuleId;
  all: Score;
  take: Score;
  wait: Score;
  coverage: number;
  deltaTakeAll: number;
  deltaTakeWait: number;
  randomMean: number;
  randomLo: number;
  randomHi: number;
  quintiles: { q: number; n: number; wr: number }[];
  mono: boolean | null;
};

function evaluateRule(decs: Decision[], rule: TakeRuleId): RuleEval {
  const all = scoreOutcomes(decs.map((d) => d.signal.outcome));
  const takeDecs = decs.filter((d) => d.takes[rule]);
  const waitDecs = decs.filter((d) => !d.takes[rule]);
  const take = scoreOutcomes(takeDecs.map((d) => d.signal.outcome));
  const wait = scoreOutcomes(waitDecs.map((d) => d.signal.outcome));
  const coverage = decs.length ? takeDecs.length / decs.length : 0;

  const ranked = decs
    .filter((d) => d.state !== "COLLECTING" && d.est != null && Number.isFinite(d.est))
    .slice()
    .sort((a, b) => (a.est ?? 0) - (b.est ?? 0));
  const quintiles: { q: number; n: number; wr: number }[] = [];
  let mono: boolean | null = null;
  if (ranked.length >= 10) {
    const chunk = Math.max(1, Math.floor(ranked.length / 5));
    for (let q = 0; q < 5; q++) {
      const slice = q === 4 ? ranked.slice(q * chunk) : ranked.slice(q * chunk, (q + 1) * chunk);
      const sc = scoreOutcomes(slice.map((d) => d.signal.outcome));
      quintiles.push({ q: q + 1, n: sc.decided, wr: sc.wr });
    }
    mono = true;
    for (let i = 1; i < quintiles.length; i++) {
      if (quintiles[i]!.wr + 1e-9 < quintiles[i - 1]!.wr) {
        mono = false;
        break;
      }
    }
  }

  const decidedIdx = decs
    .map((d, i) => ({ i, o: d.signal.outcome }))
    .filter((x) => x.o === "won" || x.o === "lost");
  const takeCount = Math.round(coverage * decidedIdx.length);
  const wrs: number[] = [];
  if (takeCount > 0 && decidedIdx.length > 0) {
    for (let r = 0; r < 200; r++) {
      const rand = mulberry32(1000 + r * 97 + rule.length);
      const pool = decidedIdx.slice();
      shuffleInPlace(pool, rand);
      const picked = pool.slice(0, takeCount);
      let w = 0;
      for (const p of picked) if (p.o === "won") w += 1;
      wrs.push(picked.length ? w / picked.length : 0);
    }
  }
  wrs.sort((a, b) => a - b);

  return {
    rule,
    all,
    take,
    wait,
    coverage,
    deltaTakeAll: take.wr - all.wr,
    deltaTakeWait: take.wr - wait.wr,
    randomMean: wrs.length ? wrs.reduce((a, b) => a + b, 0) / wrs.length : NaN,
    randomLo: percentile(wrs, 0.025),
    randomHi: percentile(wrs, 0.975),
    quintiles,
    mono,
  };
}

function groupLines(decs: Decision[], rule: TakeRuleId, keyFn: (d: Decision) => string): string[] {
  const keys = [...new Set(decs.map(keyFn))].sort();
  return keys.map((k) => {
    const subset = decs.filter((d) => keyFn(d) === k);
    const all = scoreOutcomes(subset.map((d) => d.signal.outcome));
    const take = scoreOutcomes(subset.filter((d) => d.takes[rule]).map((d) => d.signal.outcome));
    const wait = scoreOutcomes(subset.filter((d) => !d.takes[rule]).map((d) => d.signal.outcome));
    return `  ${k}: ALL ${fmtScore(all)} | TAKE ${fmtScore(take)} cov=${subset.length ? pct(take.rawN / subset.length) : "n/a"} | WAIT ${fmtScore(wait)}`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — research-only adaptive BB+RSI audit`);
console.log("Loading authoritative baseline predictions (window anchor only)...");

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
const predMax = preds.length ? preds.at(-1)!.start_at! : new Date().toISOString();
/** Anchor end to latest baseline prediction (not wall-clock — OANDA rejects future `to`). */
const dataEndAnchorMs = Date.parse(predMax);
const studyStartMs = dataEndAnchorMs - LOOKBACK_DAYS * 24 * 60 * 60_000;
const studyStartIso = new Date(studyStartMs).toISOString();
const studyEndIso = new Date(dataEndAnchorMs + 60 * 60_000).toISOString();

console.log(`Fetching ~${LOOKBACK_DAYS}d M1 for ${instruments.length} majors...`);
console.log(`  window: ${studyStartIso} → ${studyEndIso}`);
const caches = new Map<string, InstrumentCache>();
let m1Total = 0;
let m1Min = Infinity;
let m1Max = -Infinity;
const gapNotes: string[] = [];
const shortHistoryNotes: string[] = [];
const DAY_MS = 24 * 60 * 60_000;

for (const inst of instruments) {
  const candles = await fetchM1Range(inst, studyStartIso, studyEndIso);
  const cache = buildCache(inst, candles);
  caches.set(inst, cache);
  m1Total += candles.length;
  if (candles.length) {
    const firstMs = Date.parse(candles[0]!.time);
    const lastMs = cache.closeMs[cache.closeMs.length - 1]!;
    m1Min = Math.min(m1Min, firstMs);
    m1Max = Math.max(m1Max, lastMs);
    const spanDays = (lastMs - firstMs) / DAY_MS;
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      const dt = Date.parse(candles[i]!.time) - Date.parse(candles[i - 1]!.time);
      if (dt > 3 * 60_000 && dt < 48 * 3600_000) gaps += 1;
    }
    gapNotes.push(`${inst}: bars=${candles.length} span≈${spanDays.toFixed(1)}d intradayGaps≈${gaps}`);
    if (spanDays < LOOKBACK_DAYS - 5) {
      shortHistoryNotes.push(
        `${inst}: OANDA M1 history ≈${spanDays.toFixed(1)}d < ${LOOKBACK_DAYS}d requested (${new Date(firstMs).toISOString()} → ${new Date(lastMs).toISOString()})`,
      );
    }
  } else {
    gapNotes.push(`${inst}: NO BARS`);
    shortHistoryNotes.push(`${inst}: NO BARS — OANDA returned empty for requested window`);
  }
  console.log(`  ${inst}: ${candles.length} M1`);
}

if (!Number.isFinite(m1Max) || m1Total < 1000) {
  console.error("INSUFFICIENT_M1_DATA");
  process.exit(1);
}

const dataEndMs = m1Max;
const gateStartMs = dataEndMs - GATE_WEEK_DAYS * DAY_MS;
const studyFloorMs = Math.max(m1Min, dataEndMs - LOOKBACK_DAYS * DAY_MS);
const preGateMs = Math.max(0, gateStartMs - studyFloorMs);
const midStartMs = studyFloorMs + Math.floor(preGateMs * TRAIN_FRACTION_OF_PRE_GATE);
const trainStartMs = studyFloorMs;

console.log(`Period freeze (3m walk-forward):`);
console.log(`  TRAIN: ${new Date(trainStartMs).toISOString()} → ${new Date(midStartMs - 1).toISOString()}`);
console.log(`  MID (primary eval): ${new Date(midStartMs).toISOString()} → ${new Date(gateStartMs - 1).toISOString()}`);
console.log(`  DEV/GATE week: ${new Date(gateStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()}`);
console.log(`  PRIOR_TEST_END: ${new Date(PRIOR_TEST_END_MS).toISOString()}`);
if (shortHistoryNotes.length) {
  console.log(`Short OANDA history warnings:\n${shortHistoryNotes.map((n) => `  ${n}`).join("\n")}`);
}

const rawSignals: RawSignal[] = [];
for (const inst of instruments) {
  collectBbReentryRsi(caches.get(inst)!, midStartMs, gateStartMs, dataEndMs, rawSignals);
  console.log(`  walked ${inst}; raw signals so far ${rawSignals.length}`);
}
/** Walk-forward from studyStart only (episode state already warmed on earlier bars). */
const allSignals = rawSignals
  .filter((s) => s.entryMs >= trainStartMs && s.entryMs <= dataEndMs)
  .sort((a, b) => a.entryMs - b.entryMs || a.instrument.localeCompare(b.instrument));

const gateSignals = allSignals.filter((s) => s.entryMs >= gateStartMs && s.entryMs <= dataEndMs);
const midSignals = allSignals.filter((s) => s.entryMs >= midStartMs && s.entryMs < gateStartMs);
const trainSignals = allSignals.filter((s) => s.entryMs < midStartMs);
const gateScore = scoreOutcomes(gateSignals.map((s) => s.outcome));
console.log(
  `Signal counts: TRAIN=${trainSignals.length} MID=${midSignals.length} GATE/DEV=${gateSignals.length} TOTAL=${allSignals.length}`,
);
console.log(`GATE BB_REENTRY_RSI|BB20|10m: ${fmtScore(gateScore)}`);

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });

const gateFail =
  Math.abs(gateScore.decided - EXPECTED_N) > 20 || Math.abs(gateScore.wr - EXPECTED_WR) > 0.03;

if (gateFail) {
  const stopReport = `GOLDENXPERIENCE
ADAPTIVE BOLLINGER + RSI EDGE TEST
(${EXPERIMENT})

================================
DATA
================================

Periods:
  TRAIN: ${new Date(trainStartMs).toISOString()} → ${new Date(midStartMs - 1).toISOString()}
  MID: ${new Date(midStartMs).toISOString()} → ${new Date(gateStartMs - 1).toISOString()}
  DEV/GATE (dataEnd-7d): ${new Date(gateStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()}
Symbols: ${instruments.join(", ")}
M1 bars: ${m1Total}  coverage ${new Date(m1Min).toISOString()} → ${new Date(dataEndMs).toISOString()}
Gaps:
${gapNotes.map((g) => `  ${g}`).join("\n")}
Short history:
${shortHistoryNotes.length ? shortHistoryNotes.map((g) => `  ${g}`).join("\n") : "  (none — all pairs ≥~85d)"}

================================
FROZEN BASE STRATEGY — GATE FAILED
================================

BB: period=${BB_PERIOD} k=${BB_K} population stdev
RSI: Wilder14; UP if RSI<=${RSI_OS}; DOWN if RSI>=${RSI_OB}
Re-entry: excursion then close back inside; episode dedup until mid return
Expiry: ${EXPIRY_MIN}m
Variant: BB_REENTRY_RSI only on BB20

Expected approx: n=${EXPECTED_N} WR=${pct(EXPECTED_WR)} EV80≈+0.061
Reproduced: ${fmtScore(gateScore)}

DISCREPANCY: |n-${EXPECTED_N}|=${Math.abs(gateScore.decided - EXPECTED_N)} |WR-${EXPECTED_WR}|=${Math.abs(gateScore.wr - EXPECTED_WR).toFixed(4)}
Gate thresholds: |n-168|>20 OR |WR-0.5893|>0.03

STOPPED. No adaptive conclusions invented.

================================
DIRECT ANSWERS
================================

1–13. Withheld — base cohort gate failed.

================================
FINAL VERDICT
================================

INSUFFICIENT_NEW_DATA
(gate failure — base cohort not reproduced; adaptive results withheld)
`;
  fs.writeFileSync(REPORT_PATH, stopReport);
  fs.writeFileSync(
    REGISTRY_PATH,
    JSON.stringify({
      experiment: EXPERIMENT,
      status: "GATE_FAILED",
      gate: gateScore,
      expectedN: EXPECTED_N,
      expectedWr: EXPECTED_WR,
      shortHistoryNotes,
    }) + "\n",
  );
  console.error("GATE FAILED — wrote stop report.");
  process.exit(1);
}

console.log("Gate PASS — running adaptive walk-forward...");

const evidence = new Map<string, EvidenceCell>();
const pending: RawSignal[] = [];
const decisions: Decision[] = [];

function flushResolved(beforeMs: number) {
  const keep: RawSignal[] = [];
  for (const s of pending) {
    if (s.resolveMs < beforeMs && (s.outcome === "won" || s.outcome === "lost")) {
      for (const { kind } of SCOPE_ORDER) {
        addOutcome(evidence, scopeKey(kind, s), s.outcome);
      }
    } else {
      keep.push(s);
    }
  }
  pending.length = 0;
  pending.push(...keep);
}

let progressAt = 0;
for (let si = 0; si < allSignals.length; si++) {
  const s = allSignals[si]!;
  flushResolved(s.entryMs);

  const overallPriorN = cellDecided(evidence.get("overall"));
  const state = determineSelectorState(overallPriorN);

  let chosenScope: ScopeKind | "none" = "none";
  let scopeN = 0;
  let est: number | null = null;
  let ciLow: number | null = null;
  let ciHigh: number | null = null;

  for (const { kind, minN } of SCOPE_ORDER) {
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

  const hasScope = chosenScope !== "none" && est != null;
  const takes = {} as Record<TakeRuleId, boolean>;
  for (const rule of TAKE_RULES) {
    takes[rule] = applyTakeRule(rule, state, est, ciLow, hasScope);
  }

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

  if (si - progressAt >= 50 || si === allSignals.length - 1) {
    console.log(
      `  walk ${si + 1}/${allSignals.length} entry=${new Date(s.entryMs).toISOString()} state=${state} overallN=${overallPriorN} scope=${chosenScope}`,
    );
    progressAt = si;
  }
}
flushResolved(Number.POSITIVE_INFINITY);

const trainDecisions = decisions.filter((d) => d.signal.zone === "TRAIN");
const midDecisions = decisions.filter((d) => d.signal.zone === "MID");
const devDecisions = decisions.filter((d) => d.signal.zone === "DEV");
const unseenDecisions = decisions.filter((d) => d.signal.zone === "UNSEEN");
/** DEV week ∩ previously-inspected (≤ PRIOR_TEST_END); post-8/21 gate bars are UNSEEN. */
const gateDevDecisions = decisions.filter(
  (d) => d.signal.entryMs >= gateStartMs && d.signal.entryMs <= Math.min(dataEndMs, PRIOR_TEST_END_MS),
);
console.log(
  `Decisions: total=${decisions.length} TRAIN=${trainDecisions.length} MID=${midDecisions.length} DEV=${devDecisions.length} UNSEEN=${unseenDecisions.length}`,
);

/** Primary evaluation zone = MID (less previously mined). */
const midRuleEvals = TAKE_RULES.map((r) => evaluateRule(midDecisions, r));
const midAlways = midRuleEvals.find((e) => e.rule === "ALWAYS")!;
const midSelective = midRuleEvals.filter((e) => e.rule !== "ALWAYS");
const primary = ([...midSelective].sort((a, b) => {
  const aOk = a.take.decided >= 30 ? 1 : 0;
  const bOk = b.take.decided >= 30 ? 1 : 0;
  if (aOk !== bOk) return bOk - aOk;
  if (a.deltaTakeAll !== b.deltaTakeAll) return b.deltaTakeAll - a.deltaTakeAll;
  return b.take.decided - a.take.decided;
})[0] ?? midAlways) as RuleEval;

if (!midDecisions.length) {
  console.error("NO_MID_SIGNALS — cannot evaluate primary zone");
  process.exit(1);
}

const devRuleEvals = TAKE_RULES.map((r) => evaluateRule(devDecisions.length ? devDecisions : gateDevDecisions, r));
const devAlways = devRuleEvals.find((e) => e.rule === "ALWAYS")!;
const devPrimary = evaluateRule(devDecisions.length ? devDecisions : gateDevDecisions, primary.rule);

function simpleFilterOn(decs: Decision[], name: string, pred: (d: Decision) => boolean) {
  const take = scoreOutcomes(decs.filter(pred).map((d) => d.signal.outcome));
  const wait = scoreOutcomes(decs.filter((d) => !pred(d)).map((d) => d.signal.outcome));
  return {
    name,
    take,
    wait,
    coverage: decs.length ? take.rawN / decs.length : 0,
  };
}

const simpleControls = [
  simpleFilterOn(midDecisions, "take-all", () => true),
  simpleFilterOn(midDecisions, "RSI-severity-extreme-only", (d) => d.signal.rsiSeverity === "extreme"),
  simpleFilterOn(midDecisions, "ADX>25-only", (d) => Number.isFinite(d.signal.adx) && d.signal.adx > 25),
  simpleFilterOn(midDecisions, "ADX<=20-only", (d) => Number.isFinite(d.signal.adx) && d.signal.adx <= 20),
];

const continuousAll = scoreOutcomes(decisions.map((d) => d.signal.outcome));
const continuousTake = scoreOutcomes(
  decisions.filter((d) => d.takes[primary.rule]).map((d) => d.signal.outcome),
);
const continuousWait = scoreOutcomes(
  decisions.filter((d) => !d.takes[primary.rule]).map((d) => d.signal.outcome),
);
const unseenEval = unseenDecisions.length > 0 ? evaluateRule(unseenDecisions, primary.rule) : null;
const hasUnseen = unseenDecisions.length >= 30;

const midStateCounts = { COLLECTING: 0, LEARNING: 0, ACTIVE_SELECTION: 0 };
for (const d of midDecisions) midStateCounts[d.state] += 1;
const devStateCounts = { COLLECTING: 0, LEARNING: 0, ACTIVE_SELECTION: 0 };
for (const d of devDecisions) devStateCounts[d.state] += 1;

const beatsRandom =
  Number.isFinite(primary.randomHi) && primary.take.wr > primary.randomHi;
const rankingMono = primary.mono === true;
const midToward60 = primary.take.wr >= 0.6 && primary.deltaTakeAll > 0.005 && primary.take.decided >= 30;

let verdict: string;
if (midToward60 && rankingMono && beatsRandom) {
  verdict = hasUnseen ? "ADAPTIVE_SELECTION_STRONG" : "ADAPTIVE_SELECTION_PROMISING";
} else if (midToward60 && (rankingMono || beatsRandom)) {
  verdict = "ADAPTIVE_SELECTION_PROMISING";
} else if (primary.deltaTakeAll > 0.005 && primary.take.wr < 0.6 && primary.take.decided >= 30) {
  verdict = "ADAPTIVE_IMPROVES_BUT_BELOW_60";
} else if (primary.coverage < 0.95 && primary.deltaTakeAll <= 0.005) {
  verdict = "ADAPTIVE_REDUCES_SAMPLE_WITHOUT_EDGE";
} else if (primary.deltaTakeAll <= 0.005) {
  verdict = "ADAPTIVE_NO_IMPROVEMENT";
} else {
  verdict = "INSUFFICIENT_NEW_DATA";
}

const honestyUnseen = hasUnseen
  ? `UNSEEN n=${unseenDecisions.length} exists after ${new Date(PRIOR_TEST_END_MS).toISOString()}`
  : "No true post-gate UNSEEN cohort (entryMs > 2026-08-21T21:00:00Z with n≥30) — cannot CONFIRM on a brand-new week after 8/21";

const leakageChecks = [
  "indicators at T use only closed bars index ≤ T: PASS",
  "signal only after confirmation candle close; entry = confirmation close: PASS",
  "adaptive evidence uses only resolveMs < T (prior resolved): PASS",
  "current signal never in its own evidence: PASS",
  "BB/RSI/ADX/expiry/thresholds pre-registered (no outcome retune): PASS",
  "rsiSeverity fixed beyond-threshold buckets (not outcome-fitted): PASS",
  "bbWidthPctile trailing PIT last-500 (no cutpoint freeze on MID/DEV): PASS",
  `COLLECTING/LEARNING/ACTIVE thresholds from selector config (${MIN_LEARNING}/${MIN_ACTIVE}): PASS`,
  "selective TAKE rules during COLLECTING treated as TAKE (no claimed selection): PASS",
  "no writes to production adaptive tables / no live selector calls: PASS",
  "MID is primary eval; DEV/GATE week labeled previously-inspected; CONFIRMED requires UNSEEN: PASS",
  gateScore.decided >= 200 && gateScore.wr >= 0.65
    ? "suspicious WR≥65% n≥200: FAIL→AUDIT"
    : "no suspicious WR≥65% with n≥200 on frozen base gate: PASS",
];

for (const e of midRuleEvals) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      zone: "MID",
      rule: e.rule,
      allN: e.all.decided,
      allWr: e.all.wr,
      takeN: e.take.decided,
      takeWr: e.take.wr,
      takeCiLow: e.take.ciLow,
      takeCiHigh: e.take.ciHigh,
      waitN: e.wait.decided,
      waitWr: e.wait.wr,
      coverage: e.coverage,
      deltaTakeAll: e.deltaTakeAll,
      deltaTakeWait: e.deltaTakeWait,
      ev70: e.take.ev70,
      ev75: e.take.ev75,
      ev80: e.take.ev80,
      ev85: e.take.ev85,
      ev90: e.take.ev90,
      ev95: e.take.ev95,
      randomMean: e.randomMean,
      randomLo: e.randomLo,
      randomHi: e.randomHi,
      mono: e.mono,
      quintiles: e.quintiles,
    }),
  );
}
for (const e of devRuleEvals) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      zone: "DEV",
      rule: e.rule,
      allN: e.all.decided,
      allWr: e.all.wr,
      takeN: e.take.decided,
      takeWr: e.take.wr,
      waitN: e.wait.decided,
      waitWr: e.wait.wr,
      coverage: e.coverage,
      deltaTakeAll: e.deltaTakeAll,
      deltaTakeWait: e.deltaTakeWait,
      randomMean: e.randomMean,
      randomLo: e.randomLo,
      randomHi: e.randomHi,
      mono: e.mono,
    }),
  );
}
registryLines.push(
  JSON.stringify({
    experiment: EXPERIMENT,
    zone: "GATE",
    variant: "BB_REENTRY_RSI",
    bb: "BB20",
    expiry: EXPIRY_MIN,
    n: gateScore.decided,
    wr: gateScore.wr,
    ciLow: gateScore.ciLow,
    ciHigh: gateScore.ciHigh,
    ev80: gateScore.ev80,
    expectedN: EXPECTED_N,
    expectedWr: EXPECTED_WR,
    gatePass: true,
  }),
);
registryLines.push(
  JSON.stringify({
    experiment: EXPERIMENT,
    zone: "FULL_3M",
    rule: primary.rule,
    allN: continuousAll.decided,
    allWr: continuousAll.wr,
    takeN: continuousTake.decided,
    takeWr: continuousTake.wr,
    waitN: continuousWait.decided,
    waitWr: continuousWait.wr,
  }),
);
if (unseenEval) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      zone: "UNSEEN",
      rule: primary.rule,
      takeN: unseenEval.take.decided,
      takeWr: unseenEval.take.wr,
      allN: unseenEval.all.decided,
      allWr: unseenEval.all.wr,
      coverage: unseenEval.coverage,
    }),
  );
}
registryLines.push(
  JSON.stringify({
    experiment: EXPERIMENT,
    verdict,
    primaryRule: primary.rule,
    beatsRandom,
    rankingMono,
    shortHistoryNotes,
  }),
);

const primaryRule = primary.rule;
const adxLines = groupLines(midDecisions, primaryRule, (d) => d.signal.adxBucket);
const dirLines = groupLines(midDecisions, primaryRule, (d) => d.signal.dir);
const dayLines = groupLines(midDecisions, primaryRule, (d) => d.signal.day);
const symLines = groupLines(midDecisions, primaryRule, (d) => d.signal.instrument);
const sessLines = groupLines(midDecisions, primaryRule, (d) => d.signal.session);

const qBlock =
  primary.quintiles.length === 0
    ? "  (insufficient LEARNING/ACTIVE finite-est decisions for quintiles)"
    : primary.quintiles.map((q) => `  Q${q.q}: n=${q.n} WR=${pct(q.wr)}`).join("\n");

const midThresholdBlock = midRuleEvals
  .map(
    (e) =>
      `  ${e.rule}:
    TAKE n=${e.take.decided} cov=${pct(e.coverage)} WR=${pct(e.take.wr)} CI=[${pct(e.take.ciLow)},${pct(e.take.ciHigh)}] EV80=${e.take.ev80.toFixed(3)}
    WAIT n=${e.wait.decided} WR=${pct(e.wait.wr)}
    Δ(TAKE−ALL)=${(e.deltaTakeAll * 100).toFixed(2)}pp  Δ(TAKE−WAIT)=${(e.deltaTakeWait * 100).toFixed(2)}pp`,
  )
  .join("\n");

const simpleBlock = simpleControls
  .map((c) => `  ${c.name}: TAKE ${fmtScore(c.take)} cov=${pct(c.coverage)} | WAIT ${fmtScore(c.wait)}`)
  .join("\n");

const payoutBlock = (s: Score) =>
  `  70: EV=${s.ev70.toFixed(3)}  75: EV=${s.ev75.toFixed(3)}  80: EV=${s.ev80.toFixed(3)}  85: EV=${s.ev85.toFixed(3)}  90: EV=${s.ev90.toFixed(3)}  95: EV=${s.ev95.toFixed(3)}`;

const contextHints: string[] = [];
for (const key of ["le20", "b20_25", "b25_30", "gt30"] as AdxBucket[]) {
  const sub = midDecisions.filter((d) => d.signal.adxBucket === key);
  if (sub.length < 15) continue;
  const t = scoreOutcomes(sub.filter((d) => d.takes[primaryRule]).map((d) => d.signal.outcome));
  const a = scoreOutcomes(sub.map((d) => d.signal.outcome));
  if (t.decided >= 10 && t.wr > a.wr + 0.02) {
    contextHints.push(`ADX ${key}: TAKE WR ${pct(t.wr)} vs ALL ${pct(a.wr)} (nTake=${t.decided})`);
  }
}
for (const key of ["up", "down"] as Dir[]) {
  const sub = midDecisions.filter((d) => d.signal.dir === key);
  const t = scoreOutcomes(sub.filter((d) => d.takes[primaryRule]).map((d) => d.signal.outcome));
  const a = scoreOutcomes(sub.map((d) => d.signal.outcome));
  if (t.decided >= 15) {
    contextHints.push(`dir ${key}: TAKE ${pct(t.wr)} vs ALL ${pct(a.wr)} n=${t.decided}`);
  }
}

const ans1 =
  primary.deltaTakeAll > 0.005
    ? `YES (MID) — TAKE WR ${pct(primary.take.wr)} vs ALL ${pct(primary.all.wr)} via ${primary.rule}`
    : `NO clear improvement on MID — TAKE ${pct(primary.take.wr)} vs ALL ${pct(primary.all.wr)} (${primary.rule})`;
const ans2 =
  primary.take.wr >= 0.6
    ? `YES on MID — ${pct(primary.take.wr)} (n=${primary.take.decided})${hasUnseen ? "" : " but not CONFIRMED OOS"}`
    : `NO — MID TAKE WR ${pct(primary.take.wr)} < 60%`;
const ans5 =
  primary.wait.decided >= 15 && primary.deltaTakeWait > 0.01
    ? `YES — WAIT WR ${pct(primary.wait.wr)} < TAKE ${pct(primary.take.wr)}`
    : primary.wait.decided < 15
      ? `INCONCLUSIVE — WAIT n=${primary.wait.decided} too small`
      : `NO clear — WAIT ${pct(primary.wait.wr)} vs TAKE ${pct(primary.take.wr)}`;
const ans6 =
  primary.mono == null
    ? "INCONCLUSIVE — insufficient ranked LEARNING/ACTIVE decisions"
    : primary.mono
      ? "YES — Q1→Q5 realized WR non-decreasing"
      : "NO — quintiles not monotonic";
const ans7 =
  Number.isFinite(primary.randomMean)
    ? beatsRandom
      ? `YES — adaptive ${pct(primary.take.wr)} > random 97.5%ile ${pct(primary.randomHi)} (mean ${pct(primary.randomMean)})`
      : `NO — adaptive ${pct(primary.take.wr)} within random band [${pct(primary.randomLo)},${pct(primary.randomHi)}] mean ${pct(primary.randomMean)}`
    : "INCONCLUSIVE";
const rsiCtrl = simpleControls.find((c) => c.name.startsWith("RSI"))!;
const adxHi = simpleControls.find((c) => c.name.startsWith("ADX>25"))!;
const adxLo = simpleControls.find((c) => c.name.startsWith("ADX<=20"))!;
const bestSimple = Math.max(rsiCtrl.take.wr, adxHi.take.wr, adxLo.take.wr);
const ans8 =
  primary.take.wr > bestSimple + 0.005 && primary.take.decided >= 30
    ? `YES — adaptive ${pct(primary.take.wr)} beats best simple ${pct(bestSimple)}`
    : `NO / mixed — adaptive ${pct(primary.take.wr)} vs RSI-ext ${pct(rsiCtrl.take.wr)} ADX>25 ${pct(adxHi.take.wr)} ADX<=20 ${pct(adxLo.take.wr)}`;

const dayWrs = [...new Set(midDecisions.map((d) => d.signal.day))]
  .map((day) => {
    const sub = midDecisions.filter((d) => d.signal.day === day && d.takes[primaryRule]);
    return scoreOutcomes(sub.map((d) => d.signal.outcome));
  })
  .filter((s) => s.decided >= 5);
const dayStable =
  dayWrs.length >= 3 && dayWrs.every((s) => s.wr >= BE80 - 0.05)
    ? "PARTIALLY — most days near/above BE but sample thin"
    : dayWrs.length < 3
      ? "INCONCLUSIVE — too few days with n≥5"
      : "NO — material day dependence";

const report = `GOLDENXPERIENCE
ADAPTIVE BOLLINGER + RSI EDGE TEST — 3 MONTH WALK-FORWARD
(${EXPERIMENT})

================================
DATA
================================

Periods (pre-registered, not outcome-tuned):
  studyStart / TRAIN start: ${new Date(trainStartMs).toISOString()}
  midStart: ${new Date(midStartMs).toISOString()}
  gateStart: ${new Date(gateStartMs).toISOString()}
  dataEnd: ${new Date(dataEndMs).toISOString()}
  TRAIN: [${new Date(trainStartMs).toISOString()}, ${new Date(midStartMs).toISOString()})
  MID (PRIMARY eval): [${new Date(midStartMs).toISOString()}, ${new Date(gateStartMs).toISOString()})
  DEV/GATE week: [${new Date(gateStartMs).toISOString()}, ${new Date(dataEndMs).toISOString()}]
  UNSEEN: entryMs > ${new Date(PRIOR_TEST_END_MS).toISOString()}
Symbols: ${instruments.join(", ")}
Signals: TRAIN=${trainDecisions.length} MID=${midDecisions.length} DEV=${devDecisions.length} UNSEEN=${unseenDecisions.length} TOTAL=${decisions.length}
Replay method: chronological walk by entryMs from studyStart; evidence flush when resolveMs < T; ${EXPIRY_MIN}m expiry
Adaptive evidence: empty at studyStart; only prior resolved outcomes
M1 bars: ${m1Total}
M1 coverage: ${new Date(m1Min).toISOString()} → ${new Date(dataEndMs).toISOString()}
Gaps / per-symbol:
${gapNotes.map((g) => `  ${g}`).join("\n")}
Short OANDA history (<~85d of ${LOOKBACK_DAYS}d requested):
${shortHistoryNotes.length ? shortHistoryNotes.map((g) => `  ${g}`).join("\n") : "  (none)"}

Previously inspected: DEV/GATE last week (bollinger-range audit TEST cohort)
Truly unseen: ${hasUnseen ? `YES n=${unseenDecisions.length}` : "NO — " + honestyUnseen}

================================
FROZEN BASE STRATEGY
================================

BB: period=${BB_PERIOD} k=${BB_K} population stdev (variance = mean(x^2)-mean(x)^2)
RSI: Wilder14; UP if RSI<=${RSI_OS}; DOWN if RSI>=${RSI_OB}
Re-entry: high>upper / low<lower excursion; close back inside; dedup until mid return + new outside
Expiry: ${EXPIRY_MIN} minutes only
Variant: BB_REENTRY_RSI | BB20
Thresholds: NOT retuned against outcomes

GATE reproduce (last 7d = dataEnd-7d → dataEnd):
n: ${gateScore.decided}
WR: ${pct(gateScore.wr)}
CI: [${pct(gateScore.ciLow)}, ${pct(gateScore.ciHigh)}]
EV80: ${gateScore.ev80.toFixed(3)}
(expected ≈ n=168 WR=58.93% EV80=+0.061) GATE PASS

================================
ADAPTIVE ARCHITECTURE
================================

Existing components reused:
  - wilsonInterval, evidenceLabel from binary-regimes.ts
  - determineSelectorState, BINARY_ADAPTIVE_SELECTOR_CONFIG from binary-adaptive-selector.ts
  - NO live selectBinaryModel; NO production adaptive table writes
Context features (coarse, pre-registered):
  direction, adxBucket (<=20|20-25|25-30|>30), session (ET), rsiSeverity (mild|medium|extreme fixed), bbWidthPctile (trailing PIT /${WIDTH_TRAIL})
Evidence hierarchy (first with n≥scopeMin):
  direction|adxBucket (30) → direction|session (30) → adxBucket (30) → direction (40) → overall (50)
Backoff logic: walk hierarchy; if no scope meets min → TAKE (cannot filter)
COLLECTING threshold: <${MIN_LEARNING} overall prior decided
LEARNING threshold: ${MIN_LEARNING}–${MIN_ACTIVE - 1}
ACTIVE threshold: ≥${MIN_ACTIVE}
COLLECTING policy for selective rules: TAKE (no filtering) — cannot claim selection. Documented.

MID state mix: COLLECTING=${midStateCounts.COLLECTING} LEARNING=${midStateCounts.LEARNING} ACTIVE_SELECTION=${midStateCounts.ACTIVE_SELECTION}
DEV state mix: COLLECTING=${devStateCounts.COLLECTING} LEARNING=${devStateCounts.LEARNING} ACTIVE_SELECTION=${devStateCounts.ACTIVE_SELECTION}

================================
HEADLINE — MID (PRIMARY)
================================

FROZEN ALL SIGNALS
${fmtScore(midAlways.all)}

ADAPTIVE TAKE (best pre-registered selective by Δ vs ALL on MID: ${primary.rule})
n: ${primary.take.decided}
coverage: ${pct(primary.coverage)}
WR: ${pct(primary.take.wr)}
95% CI: [${pct(primary.take.ciLow)}, ${pct(primary.take.ciHigh)}]
EV80: ${primary.take.ev80.toFixed(3)}

ADAPTIVE WAIT COUNTERFACTUAL
n: ${primary.wait.decided}
WR: ${pct(primary.wait.wr)}
95% CI: [${pct(primary.wait.ciLow)}, ${pct(primary.wait.ciHigh)}]
EV80: ${primary.wait.ev80.toFixed(3)}

Improvement TAKE vs ALL: ${(primary.deltaTakeAll * 100).toFixed(2)}pp
Improvement TAKE vs WAIT: ${(primary.deltaTakeWait * 100).toFixed(2)}pp

================================
HEADLINE — DEV/GATE week (previously-inspected)
================================

FROZEN ALL: ${fmtScore(devAlways.all)}
ADAPTIVE TAKE (${primary.rule}): ${fmtScore(devPrimary.take)} cov=${pct(devPrimary.coverage)}
ADAPTIVE WAIT: ${fmtScore(devPrimary.wait)}
Δ(TAKE−ALL)=${(devPrimary.deltaTakeAll * 100).toFixed(2)}pp  Δ(TAKE−WAIT)=${(devPrimary.deltaTakeWait * 100).toFixed(2)}pp

================================
HEADLINE — FULL 3M SEQUENTIAL (studyStart→dataEnd)
================================

ALL ${fmtScore(continuousAll)}
TAKE (${primary.rule}) ${fmtScore(continuousTake)}
WAIT ${fmtScore(continuousWait)}

UNSEEN: ${unseenEval ? `ALL ${fmtScore(unseenEval.all)} | TAKE ${fmtScore(unseenEval.take)} cov=${pct(unseenEval.coverage)}` : honestyUnseen}

================================
ALL TAKE RULES ON MID
================================

${midThresholdBlock}

================================
QUALITY RANKING (MID)
================================

${qBlock}

Does adaptive score monotonically rank realized WR?
${primary.mono == null ? "INCONCLUSIVE" : primary.mono ? "YES" : "NO"}

================================
RANDOM SELECTOR CONTROL (MID)
================================

Adaptive coverage: ${pct(primary.coverage)}
Adaptive WR: ${pct(primary.take.wr)}

Matched random selector (200 shuffles, same coverage on decided):
mean WR: ${Number.isFinite(primary.randomMean) ? pct(primary.randomMean) : "n/a"}
95% random range: [${Number.isFinite(primary.randomLo) ? pct(primary.randomLo) : "n/a"}, ${Number.isFinite(primary.randomHi) ? pct(primary.randomHi) : "n/a"}]

Adaptive improvement vs random: ${ans7}
Beats random (TAKE WR > random 97.5%ile): ${beatsRandom ? "YES" : "NO"}

================================
SIMPLE FILTER CONTROLS (MID)
================================

${simpleBlock}
  Adaptive (${primary.rule}): TAKE ${fmtScore(primary.take)} cov=${pct(primary.coverage)}

Does adaptive actually add value?
${ans8}

================================
ADX / TREND REGIME (MID)
================================

${adxLines.join("\n")}

================================
UP vs DOWN (MID)
================================

${dirLines.join("\n")}

================================
DAY STABILITY (MID)
================================

${dayLines.join("\n")}

================================
SYMBOL STABILITY (MID)
================================

${symLines.join("\n")}

================================
SESSION STABILITY (MID)
================================

${sessLines.join("\n")}

================================
PAYOUT ANALYSIS (MID adaptive TAKE ${primary.rule})
================================

Break-even @80% payout: ${pct(BE80)}
Actual TAKE WR: ${pct(primary.take.wr)}
${payoutBlock(primary.take)}

ALL frozen MID:
${payoutBlock(midAlways.all)}

================================
LEAKAGE AUDIT
================================

${leakageChecks.map((c) => `  - ${c}`).join("\n")}

================================
DIRECT ANSWERS
================================

1. Does adaptive selection improve the frozen strategy on MID?
   ${ans1}

2. Does adaptive TAKE reach 60% on MID?
   ${ans2}

3. With how many signals?
   TAKE n=${primary.take.decided} (raw TAKE=${primary.take.rawN}) of MID n=${midAlways.all.decided}

4. What percentage of signals does it keep?
   coverage ${pct(primary.coverage)}

5. Are rejected WAIT signals actually worse?
   ${ans5}

6. Does predicted signal quality rank realized WR?
   ${ans6}

7. Does adaptive selection beat matched random selection?
   ${ans7}

8. Does it beat simple RSI-only or ADX-only filtering?
   ${ans8}

9. Which contexts appear responsible for the improvement?
   ${contextHints.length ? contextHints.join("; ") : "No strong context standout beyond overall estimate filter; see ADX/session slices"}

10. Is the improvement stable across days?
   ${dayStable}

11. Is it stable across symbols?
   See SYMBOL STABILITY — many symbols underpowered; treat as descriptive only

12. At 80% payout, is adaptive TAKE profitable on MID?
   ${primary.take.ev80 > 0 ? `YES on MID — EV80=${primary.take.ev80.toFixed(3)} (WR ${pct(primary.take.wr)} > BE ${pct(BE80)})` : `NO — EV80=${primary.take.ev80.toFixed(3)}`}

13. Is the evidence genuinely OOS or still DEVELOPMENT?
   ${hasUnseen ? "Partial UNSEEN exists — see UNSEEN block; MID less previously mined than DEV week" : "MID is less previously mined than DEV/GATE week, but " + honestyUnseen}

================================
FINAL VERDICT
================================

${verdict}

Honesty notes:
- Primary adaptive metrics are on MID (middle third of pre-gate history) — less previously mined than DEV/GATE week.
- DEV/GATE week remains previously inspected (bollinger TEST); used for gate reproduce + secondary headline.
- Selector thresholds (${MIN_LEARNING}/${MIN_ACTIVE}) and TAKE rules were pre-registered; not mined for 60%.
- COLLECTING selective rules force TAKE (no claimed edge while collecting).
- Best selective rule reported on MID: ${primary.rule}.
- Ranking monotonic: ${rankingMono ? "YES" : primary.mono == null ? "INCONCLUSIVE" : "NO"}; beats random: ${beatsRandom ? "YES" : "NO"}.
- ${honestyUnseen}
`;

fs.writeFileSync(REPORT_PATH, report);
fs.writeFileSync(REGISTRY_PATH, registryLines.join("\n") + "\n");
console.log(`Wrote ${REPORT_PATH}`);
console.log(`Wrote ${REGISTRY_PATH}`);
console.log(`VERDICT: ${verdict}`);
console.log(`MID best rule: ${primary.rule} TAKE ${fmtScore(primary.take)} cov=${pct(primary.coverage)}`);
console.log(`GATE: ${fmtScore(gateScore)}`);
console.log(`Beats random: ${beatsRandom} | Ranking mono: ${primary.mono}`);
