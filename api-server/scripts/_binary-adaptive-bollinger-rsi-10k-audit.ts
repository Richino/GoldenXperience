/**
 * GOLDENXPERIENCE — adaptive-bollinger-rsi-v2-10k
 *
 * Research only. Offline historical adaptive BB+RSI walk on ≥10k signals.
 * Does NOT modify production binary tables, selector, or live enablement.
 *
 * Gate: reproduce BB_REENTRY_RSI|BB20|10m week ≈ n=168 WR=58.93% EV80=+0.061
 * Primary TAKE rule pre-registered: EST_GE_0.5556 (not retuned on holdout).
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

const OUT_DIR = path.join(root, "research-v2", "binary-adaptive-bollinger-rsi-10k");
const CACHE_DIR = path.join(OUT_DIR, "cache");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");
const SIGNALS_PATH = path.join(OUT_DIR, "signals.jsonl");
const CHECKPOINTS_CSV = path.join(OUT_DIR, "learning_curve.csv");

const EXPERIMENT = "adaptive-bollinger-rsi-v2-10k";
/** Start with ~600 calendar days before data end; extend if <10k signals. */
const INITIAL_LOOKBACK_DAYS = 600;
const EXTEND_LOOKBACK_DAYS = 900;
const TARGET_SIGNALS = 10_000;
const GATE_WEEK_DAYS = 7;
/** HOLDOUT = final ~20% of signals by time (also capped near final 90d). */
const HOLDOUT_FRAC = 0.2;
const HOLDOUT_MAX_DAYS = 90;
const BE80 = 1 / (1 + 0.8);
const EXPIRY_MIN = 10;
const BB_PERIOD = 20;
const BB_K = 2.0;
const RSI_OS = 30;
const RSI_OB = 70;
const WIDTH_TRAIL = 500;
const PAGE_LIMIT = 250;
const PRIMARY_RULE: TakeRuleId = "EST_GE_0.5556";
const RANDOM_SHUFFLES = 1000;
const LEARNING_CHECKPOINTS = [1000, 2000, 3000, 5000, 7500, 10_000, 15_000, 20_000];

const MIN_LEARNING = BINARY_ADAPTIVE_SELECTOR_CONFIG.minLearningPairedSamples;
const MIN_ACTIVE = BINARY_ADAPTIVE_SELECTOR_CONFIG.minActivePairedSamples;

const PRIOR_TEST_END_MS = Date.parse("2026-08-21T21:00:00.000Z");
const EXPECTED_N = 168;
const EXPECTED_WR = 0.5893;
const GATE_N_TOL = 25;
const GATE_WR_TOL = 0.035;

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
const ET_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
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
type Zone = "LEARN" | "HOLDOUT" | "COMPARISON";

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
  month: string;
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
  decisionIdx: number;
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

type LearningSnap = {
  resolvedN: number;
  all: Score;
  take: Score;
  wait: Score;
  coverage: number;
  activeContexts: number;
  contextStats: ContextStats;
};

type ContextStats = {
  nContexts: number;
  median: number;
  p25: number;
  p75: number;
  ge100: number;
  ge300: number;
  ge500: number;
  ge1000: number;
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

const DAY_MS = 24 * 60 * 60_000;

function cachePath(instrument: string) {
  return path.join(CACHE_DIR, `${instrument}.jsonl`);
}

function loadCachedCandles(instrument: string): BinaryCandle[] | null {
  const p = cachePath(instrument);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const out: BinaryCandle[] = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as BinaryCandle;
      if (o?.time && o.complete !== false) out.push({ ...o, complete: true });
    } catch {
      /* skip bad line */
    }
  }
  return out.length ? out.sort((a, b) => a.time.localeCompare(b.time)) : null;
}

function saveCachedCandles(instrument: string, candles: BinaryCandle[]) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const body = candles
    .map((c) =>
      JSON.stringify({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        complete: true,
      }),
    )
    .join("\n");
  fs.writeFileSync(cachePath(instrument), body + (body ? "\n" : ""));
}

async function fetchM1Range(instrument: string, fromIso: string, toIso: string): Promise<BinaryCandle[]> {
  const fromMs = Date.parse(fromIso) - 2 * 24 * 60 * 60_000;
  const nowSafeMs = Date.now() - 60_000;
  const toMs = Math.min(Date.parse(toIso) + 20 * 60_000, nowSafeMs);

  const cached = loadCachedCandles(instrument);
  if (cached?.length) {
    const first = Date.parse(cached[0]!.time);
    const last = Date.parse(cached.at(-1)!.time);
    if (first <= fromMs + DAY_MS && last >= toMs - 2 * DAY_MS) {
      console.log(`  ${instrument}: cache hit ${cached.length} bars`);
      return cached.filter((c) => {
        const t = Date.parse(c.time);
        return t >= fromMs && t <= toMs;
      });
    }
    console.log(`  ${instrument}: cache partial/stale — refetching`);
  }

  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  let duplicatesRemoved = 0;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toCandles(raw).filter((c) => c.complete);
    if (!batch.length) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((m, c) => (c.time < m ? c.time : m), batch[0]!.time);
    console.log(`  ${instrument}: page ${page + 1} +${batch.length} earliest=${earliest}`);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(80);
  }
  const by = new Map<string, BinaryCandle>();
  for (const c of all) {
    if (by.has(c.time)) duplicatesRemoved += 1;
    by.set(c.time, c);
  }
  const sorted = [...by.values()].sort((a, b) => a.time.localeCompare(b.time));
  saveCachedCandles(instrument, sorted);
  console.log(
    `  ${instrument}: fetched ${sorted.length} unique (dupes removed=${duplicatesRemoved})`,
  );
  return sorted;
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

function collectBbReentryRsi(cache: InstrumentCache, out: RawSignal[]) {
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
            month: ET_MONTH.format(new Date(entryMs)),
            adxBucket: adxBucketOf(adx),
            rsiSeverity: rsiSeverityOf("down", rsi),
            bbWidthBucket: trailingWidthBucket(cache.bbWidthAtr, i),
            outcome: outcomeAt(cache, "down", close, precision, entryMs, EXPIRY_MIN),
            zone: "LEARN",
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
            month: ET_MONTH.format(new Date(entryMs)),
            adxBucket: adxBucketOf(adx),
            rsiSeverity: rsiSeverityOf("up", rsi),
            bbWidthBucket: trailingWidthBucket(cache.bbWidthAtr, i),
            outcome: outcomeAt(cache, "up", close, precision, entryMs, EXPIRY_MIN),
            zone: "LEARN",
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

function contextStatsFromEvidence(evidence: Map<string, EvidenceCell>): ContextStats {
  const ns: number[] = [];
  for (const [k, cell] of evidence) {
    if (k === "overall") continue;
    const n = cellDecided(cell);
    if (n > 0) ns.push(n);
  }
  ns.sort((a, b) => a - b);
  return {
    nContexts: ns.length,
    median: percentile(ns, 0.5),
    p25: percentile(ns, 0.25),
    p75: percentile(ns, 0.75),
    ge100: ns.filter((n) => n >= 100).length,
    ge300: ns.filter((n) => n >= 300).length,
    ge500: ns.filter((n) => n >= 500).length,
    ge1000: ns.filter((n) => n >= 1000).length,
  };
}

function countActiveContexts(evidence: Map<string, EvidenceCell>): number {
  let n = 0;
  for (const [k, cell] of evidence) {
    if (k === "overall") continue;
    if (cellDecided(cell) >= 30) n += 1;
  }
  return n;
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
  randomPctile: number;
  quintiles: { q: number; n: number; wr: number }[];
  mono: boolean | null;
};

function evaluateRule(decs: Decision[], rule: TakeRuleId, shuffles = 200): RuleEval {
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
    for (let r = 0; r < shuffles; r++) {
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
  let randomPctile = NaN;
  if (wrs.length) {
    let below = 0;
    for (const w of wrs) if (w < take.wr) below += 1;
    randomPctile = below / wrs.length;
  }

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
    randomPctile,
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

function rollingWindowLines(decs: Decision[], rule: TakeRuleId, window: number): string[] {
  const lines: string[] = [];
  if (decs.length < window) {
    return [`  window=${window}: insufficient (have ${decs.length})`];
  }
  const ends = [window - 1];
  for (let i = window * 2 - 1; i < decs.length; i += window) ends.push(i);
  if (ends[ends.length - 1] !== decs.length - 1) ends.push(decs.length - 1);
  for (const end of ends) {
    const start = Math.max(0, end - window + 1);
    const slice = decs.slice(start, end + 1);
    const all = scoreOutcomes(slice.map((d) => d.signal.outcome));
    const take = scoreOutcomes(slice.filter((d) => d.takes[rule]).map((d) => d.signal.outcome));
    lines.push(
      `  [${start + 1}..${end + 1}] ALL ${fmtScore(all)} | TAKE ${fmtScore(take)} cov=${pct(take.rawN / slice.length)}`,
    );
  }
  return lines;
}

function thresholdAttainment(decs: Decision[], rule: TakeRuleId, targets: number[]): string[] {
  const take = decs.filter((d) => d.takes[rule]);
  const sc = scoreOutcomes(take.map((d) => d.signal.outcome));
  const days = new Set(take.map((d) => d.signal.day)).size;
  const symbols = new Set(take.map((d) => d.signal.instrument)).size;
  const cov = decs.length ? take.length / decs.length : 0;
  return targets.map((t) => {
    const hit = sc.decided > 0 && sc.wr >= t;
    return `  ${pct(t)}: ${hit ? "HIT" : "MISS"} n=${sc.decided} cov=${pct(cov)} WR=${pct(sc.wr)} CI=[${pct(sc.ciLow)},${pct(sc.ciHigh)}] EV80=${sc.ev80.toFixed(3)} days=${days} symbols=${symbols}`;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — research-only 10k adaptive BB+RSI audit`);
fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

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
const predMax = preds.length ? preds.at(-1)!.start_at! : "2026-08-21T21:00:00.000Z";
const dataEndAnchorMs = Math.min(Date.parse(predMax), PRIOR_TEST_END_MS);
const studyEndIso = new Date(dataEndAnchorMs + 60 * 60_000).toISOString();

async function loadAllCaches(lookbackDays: number) {
  const studyStartMs = dataEndAnchorMs - lookbackDays * DAY_MS;
  const studyStartIso = new Date(studyStartMs).toISOString();
  console.log(`Fetching ~${lookbackDays}d M1 for ${instruments.length} majors...`);
  console.log(`  window: ${studyStartIso} → ${studyEndIso}`);
  const caches = new Map<string, InstrumentCache>();
  let m1Total = 0;
  let m1Min = Infinity;
  let m1Max = -Infinity;
  const gapNotes: string[] = [];
  const shortHistoryNotes: string[] = [];
  let totalDupes = 0;

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
      if (spanDays < lookbackDays - 30) {
        shortHistoryNotes.push(
          `${inst}: OANDA M1 history ≈${spanDays.toFixed(1)}d < ${lookbackDays}d requested`,
        );
      }
    } else {
      gapNotes.push(`${inst}: NO BARS`);
      shortHistoryNotes.push(`${inst}: NO BARS`);
    }
    console.log(`  ${inst}: ready ${candles.length} M1`);
  }
  return { caches, m1Total, m1Min, m1Max, gapNotes, shortHistoryNotes, totalDupes, studyStartMs };
}

let lookback = INITIAL_LOOKBACK_DAYS;
let loaded = await loadAllCaches(lookback);

if (!Number.isFinite(loaded.m1Max) || loaded.m1Total < 1000) {
  console.error("INSUFFICIENT_M1_DATA");
  process.exit(1);
}

function collectResolvedSignals(
  caches: Map<string, InstrumentCache>,
  studyFloorMs: number,
  dataEndMs: number,
): RawSignal[] {
  const raw: RawSignal[] = [];
  for (const inst of instruments) {
    collectBbReentryRsi(caches.get(inst)!, raw);
    console.log(`  walked ${inst}; raw signals so far ${raw.length}`);
  }
  return raw
    .filter(
      (s) =>
        s.entryMs >= studyFloorMs &&
        s.entryMs <= dataEndMs &&
        (s.outcome === "won" || s.outcome === "lost" || s.outcome === "tie"),
    )
    .sort((a, b) => a.entryMs - b.entryMs || a.instrument.localeCompare(b.instrument));
}

let dataEndMs = loaded.m1Max;
let studyFloorMs = Math.max(loaded.m1Min, dataEndMs - lookback * DAY_MS);
let allSignals = collectResolvedSignals(loaded.caches, studyFloorMs, dataEndMs);
const resolvedOnly = () => allSignals.filter((s) => s.outcome === "won" || s.outcome === "lost");

console.log(`Initial resolved+tie signals: ${allSignals.length} (decided=${resolvedOnly().length})`);

if (resolvedOnly().length < TARGET_SIGNALS && lookback < EXTEND_LOOKBACK_DAYS) {
  console.log(`<${TARGET_SIGNALS} decided — extending lookback to ${EXTEND_LOOKBACK_DAYS}d`);
  lookback = EXTEND_LOOKBACK_DAYS;
  loaded = await loadAllCaches(lookback);
  dataEndMs = loaded.m1Max;
  studyFloorMs = Math.max(loaded.m1Min, dataEndMs - lookback * DAY_MS);
  allSignals = collectResolvedSignals(loaded.caches, studyFloorMs, dataEndMs);
  console.log(`Extended signals: ${allSignals.length} (decided=${resolvedOnly().length})`);
}

const gateStartMs = dataEndMs - GATE_WEEK_DAYS * DAY_MS;
const gateSignals = allSignals.filter((s) => s.entryMs >= gateStartMs && s.entryMs <= dataEndMs);
const gateScore = scoreOutcomes(gateSignals.map((s) => s.outcome));
console.log(`GATE BB_REENTRY_RSI|BB20|10m: ${fmtScore(gateScore)}`);

const gateFail =
  Math.abs(gateScore.decided - EXPECTED_N) > GATE_N_TOL ||
  Math.abs(gateScore.wr - EXPECTED_WR) > GATE_WR_TOL;

if (gateFail) {
  const stopReport = `GOLDENXPERIENCE
10,000-SIGNAL HISTORICAL ADAPTIVE BINARY TEST
(${EXPERIMENT})

================================
DATA
================================

Periods:
  studyFloor: ${new Date(studyFloorMs).toISOString()}
  dataEnd: ${new Date(dataEndMs).toISOString()}
  GATE week: ${new Date(gateStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()}
Symbols: ${instruments.join(", ")}
M1 bars: ${loaded.m1Total}  coverage ${new Date(loaded.m1Min).toISOString()} → ${new Date(dataEndMs).toISOString()}
Gaps:
${loaded.gapNotes.map((g) => `  ${g}`).join("\n")}
Short history:
${loaded.shortHistoryNotes.length ? loaded.shortHistoryNotes.map((g) => `  ${g}`).join("\n") : "  (none)"}
Signals collected: ${allSignals.length} decided=${resolvedOnly().length}

================================
FROZEN BASE STRATEGY — GATE FAILED
================================

Expected approx: n=${EXPECTED_N} WR=${pct(EXPECTED_WR)} EV80≈+0.061
Reproduced: ${fmtScore(gateScore)}

DISCREPANCY: |n-${EXPECTED_N}|=${Math.abs(gateScore.decided - EXPECTED_N)} |WR-${EXPECTED_WR}|=${Math.abs(gateScore.wr - EXPECTED_WR).toFixed(4)}
Gate thresholds: |n-168|>${GATE_N_TOL} OR |WR-0.5893|>${GATE_WR_TOL}

STOPPED. No adaptive conclusions invented. Long-history interpretation withheld.

================================
FINAL VERDICT
================================

INSUFFICIENT_NEW_DATA
(gate failure — base cohort not reproduced)
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
    }) + "\n",
  );
  console.error("GATE FAILED — wrote stop report.");
  process.exit(1);
}

console.log("Gate PASS — freezing chronological splits BEFORE holdout interpretation...");

/** Freeze holdout cut by signal time index (final 20%), also not longer than ~90d if denser. */
const nAll = allSignals.length;
const holdoutByCountStartIdx = Math.floor(nAll * (1 - HOLDOUT_FRAC));
const holdoutByCountMs = allSignals[holdoutByCountStartIdx]?.entryMs ?? dataEndMs;
const holdoutByDaysMs = dataEndMs - HOLDOUT_MAX_DAYS * DAY_MS;
/** Prefer ~20% by count; if that is longer than 90d calendar, use 90d cut (more sealed). */
const holdoutStartMs = Math.max(holdoutByCountMs, holdoutByDaysMs);

for (const s of allSignals) {
  if (s.entryMs >= gateStartMs && s.entryMs <= dataEndMs) s.zone = "COMPARISON";
  else if (s.entryMs >= holdoutStartMs) s.zone = "HOLDOUT";
  else s.zone = "LEARN";
}

const learnSignals = allSignals.filter((s) => s.zone === "LEARN");
const holdoutSignals = allSignals.filter((s) => s.zone === "HOLDOUT");
const comparisonSignals = allSignals.filter((s) => s.zone === "COMPARISON");

console.log(
  `Splits: LEARN=${learnSignals.length} HOLDOUT=${holdoutSignals.length} COMPARISON(week)=${comparisonSignals.length} TOTAL=${allSignals.length}`,
);
console.log(`  holdoutStart=${new Date(holdoutStartMs).toISOString()}`);
console.log(`  PRIMARY rule frozen: ${PRIMARY_RULE}`);

console.log("Running chronological adaptive walk...");
const evidence = new Map<string, EvidenceCell>();
const pending: RawSignal[] = [];
const decisions: Decision[] = [];
const learningSnaps: LearningSnap[] = [];
const checkpointSet = new Set(LEARNING_CHECKPOINTS);
let nextCheckpointIdx = 0;
let lastProgress = 0;

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

function maybeSnapshot(resolvedN: number) {
  while (
    nextCheckpointIdx < LEARNING_CHECKPOINTS.length &&
    resolvedN >= LEARNING_CHECKPOINTS[nextCheckpointIdx]!
  ) {
    const at = LEARNING_CHECKPOINTS[nextCheckpointIdx]!;
    const all = scoreOutcomes(decisions.map((d) => d.signal.outcome));
    const take = scoreOutcomes(
      decisions.filter((d) => d.takes[PRIMARY_RULE]).map((d) => d.signal.outcome),
    );
    const wait = scoreOutcomes(
      decisions.filter((d) => !d.takes[PRIMARY_RULE]).map((d) => d.signal.outcome),
    );
    const coverage = decisions.length ? take.rawN / decisions.length : 0;
    const snap: LearningSnap = {
      resolvedN: at,
      all,
      take,
      wait,
      coverage,
      activeContexts: countActiveContexts(evidence),
      contextStats: contextStatsFromEvidence(evidence),
    };
    learningSnaps.push(snap);
    console.log(
      `  checkpoint resolved=${at}: ALL WR=${pct(all.wr)} TAKE WR=${pct(take.wr)} cov=${pct(coverage)} activeCtx=${snap.activeContexts}`,
    );
    nextCheckpointIdx += 1;
  }
}

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
    decisionIdx: si,
  });
  pending.push(s);

  maybeSnapshot(overallPriorN);

  if (si - lastProgress >= 1000 || si === allSignals.length - 1) {
    console.log(
      `  walk ${si + 1}/${allSignals.length} entry=${new Date(s.entryMs).toISOString()} state=${state} overallN=${overallPriorN} scope=${chosenScope}`,
    );
    lastProgress = si;
  }
}
flushResolved(Number.POSITIVE_INFINITY);
maybeSnapshot(cellDecided(evidence.get("overall")));

const learnDecisions = decisions.filter((d) => d.signal.zone === "LEARN");
const holdoutDecisions = decisions.filter((d) => d.signal.zone === "HOLDOUT");
const comparisonDecisions = decisions.filter((d) => d.signal.zone === "COMPARISON");
/** Pre-holdout = LEARN + COMPARISON week inside learn stream before holdout cut — for random control use LEARN only (sealed). */
const preHoldoutDecisions = decisions.filter((d) => d.signal.entryMs < holdoutStartMs);

console.log(
  `Decisions: total=${decisions.length} LEARN=${learnDecisions.length} HOLDOUT=${holdoutDecisions.length} COMPARISON=${comparisonDecisions.length}`,
);

const learnRuleEvals = TAKE_RULES.map((r) =>
  evaluateRule(learnDecisions, r, r === PRIMARY_RULE ? RANDOM_SHUFFLES : 200),
);
const primaryLearn = learnRuleEvals.find((e) => e.rule === PRIMARY_RULE)!;
const learnAlways = learnRuleEvals.find((e) => e.rule === "ALWAYS")!;

const holdoutRuleEvals = TAKE_RULES.map((r) => evaluateRule(holdoutDecisions, r, 200));
const primaryHoldout = holdoutRuleEvals.find((e) => e.rule === PRIMARY_RULE)!;
const holdoutAlways = holdoutRuleEvals.find((e) => e.rule === "ALWAYS")!;

const comparisonEval = evaluateRule(comparisonDecisions, PRIMARY_RULE, 200);
const comparisonAlways = evaluateRule(comparisonDecisions, "ALWAYS", 50);

/** DEV/MID at ~10k resolved: use pre-holdout cumulative through first 10k decided if available */
const decidedPre = preHoldoutDecisions.filter(
  (d) => d.signal.outcome === "won" || d.signal.outcome === "lost",
);
const at10kDecs =
  decidedPre.length >= 10_000 ? decidedPre.slice(0, 10_000) : preHoldoutDecisions;
const at10kAll = scoreOutcomes(at10kDecs.map((d) => d.signal.outcome));
const at10kTake = scoreOutcomes(
  at10kDecs.filter((d) => d.takes[PRIMARY_RULE]).map((d) => d.signal.outcome),
);
const at10kWait = scoreOutcomes(
  at10kDecs.filter((d) => !d.takes[PRIMARY_RULE]).map((d) => d.signal.outcome),
);

const simpleControls = [
  {
    name: "take-all",
    ...(() => {
      const take = scoreOutcomes(learnDecisions.map((d) => d.signal.outcome));
      return { take, wait: scoreOutcomes([]), coverage: 1 };
    })(),
  },
  {
    name: "RSI-extreme-only",
    ...(() => {
      const pred = (d: Decision) => d.signal.rsiSeverity === "extreme";
      const take = scoreOutcomes(learnDecisions.filter(pred).map((d) => d.signal.outcome));
      const wait = scoreOutcomes(learnDecisions.filter((d) => !pred(d)).map((d) => d.signal.outcome));
      return { take, wait, coverage: learnDecisions.length ? take.rawN / learnDecisions.length : 0 };
    })(),
  },
  {
    name: "ADX>25",
    ...(() => {
      const pred = (d: Decision) => Number.isFinite(d.signal.adx) && d.signal.adx > 25;
      const take = scoreOutcomes(learnDecisions.filter(pred).map((d) => d.signal.outcome));
      const wait = scoreOutcomes(learnDecisions.filter((d) => !pred(d)).map((d) => d.signal.outcome));
      return { take, wait, coverage: learnDecisions.length ? take.rawN / learnDecisions.length : 0 };
    })(),
  },
  {
    name: "ADX<=20",
    ...(() => {
      const pred = (d: Decision) => Number.isFinite(d.signal.adx) && d.signal.adx <= 20;
      const take = scoreOutcomes(learnDecisions.filter(pred).map((d) => d.signal.outcome));
      const wait = scoreOutcomes(learnDecisions.filter((d) => !pred(d)).map((d) => d.signal.outcome));
      return { take, wait, coverage: learnDecisions.length ? take.rawN / learnDecisions.length : 0 };
    })(),
  },
  {
    name: "direction-only-UP",
    ...(() => {
      const pred = (d: Decision) => d.signal.dir === "up";
      const take = scoreOutcomes(learnDecisions.filter(pred).map((d) => d.signal.outcome));
      const wait = scoreOutcomes(learnDecisions.filter((d) => !pred(d)).map((d) => d.signal.outcome));
      return { take, wait, coverage: learnDecisions.length ? take.rawN / learnDecisions.length : 0 };
    })(),
  },
];

const fullAll = scoreOutcomes(decisions.map((d) => d.signal.outcome));
const fullTake = scoreOutcomes(
  decisions.filter((d) => d.takes[PRIMARY_RULE]).map((d) => d.signal.outcome),
);

const learnStateCounts = { COLLECTING: 0, LEARNING: 0, ACTIVE_SELECTION: 0 };
for (const d of learnDecisions) learnStateCounts[d.state] += 1;
const holdoutStateCounts = { COLLECTING: 0, LEARNING: 0, ACTIVE_SELECTION: 0 };
for (const d of holdoutDecisions) holdoutStateCounts[d.state] += 1;

const beatsRandom =
  Number.isFinite(primaryLearn.randomHi) && primaryLearn.take.wr > primaryLearn.randomHi;
const rankingMono = primaryLearn.mono === true;

/** Learning curve: does TAKE−ALL improve / stabilize with more data? */
const snap10k = learningSnaps.find((s) => s.resolvedN === 10_000);
const snapEarly = learningSnaps.find((s) => s.resolvedN === 2000) ?? learningSnaps[0];
const takeImprovesWithData =
  snap10k && snapEarly
    ? snap10k.take.wr - snap10k.all.wr > snapEarly.take.wr - snapEarly.all.wr + 0.005
    : false;
const holdoutImproves =
  primaryHoldout.deltaTakeAll > 0.005 && primaryHoldout.take.decided >= 50;
const learnImproves =
  primaryLearn.deltaTakeAll > 0.005 && primaryLearn.take.decided >= 100;

let hypothesis: "A" | "B" | "INCONCLUSIVE";
if (learnImproves && holdoutImproves && (rankingMono || beatsRandom || takeImprovesWithData)) {
  hypothesis = "A";
} else if (!learnImproves && !holdoutImproves) {
  hypothesis = "B";
} else if (learnImproves && !holdoutImproves) {
  hypothesis = "B";
} else {
  hypothesis = "INCONCLUSIVE";
}

const toward60 =
  primaryHoldout.take.wr >= 0.6 &&
  primaryHoldout.deltaTakeAll > 0.005 &&
  primaryHoldout.take.decided >= 50;
const toward60Learn =
  primaryLearn.take.wr >= 0.6 && primaryLearn.deltaTakeAll > 0.005 && primaryLearn.take.decided >= 100;

let verdict: string;
if (toward60 && rankingMono && beatsRandom && holdoutImproves) {
  verdict = "ADAPTIVE_SELECTION_STRONG";
} else if (toward60 || (toward60Learn && holdoutImproves)) {
  verdict = "ADAPTIVE_SELECTION_PROMISING";
} else if (holdoutImproves && primaryHoldout.take.wr < 0.6) {
  verdict = "ADAPTIVE_IMPROVES_BUT_BELOW_60";
} else if (learnImproves && !holdoutImproves) {
  verdict = "ADAPTIVE_OVERFIT";
} else if (primaryLearn.coverage < 0.95 && primaryLearn.deltaTakeAll <= 0.005) {
  verdict = "ADAPTIVE_REDUCES_SAMPLE_WITHOUT_EDGE";
} else if (primaryLearn.deltaTakeAll <= 0.005 && primaryHoldout.deltaTakeAll <= 0.005) {
  verdict = "ADAPTIVE_NO_IMPROVEMENT";
} else {
  verdict = "INSUFFICIENT_NEW_DATA";
}

const leakageChecks = [
  "indicators at T use only closed bars index ≤ T: PASS",
  "signal only after confirmation candle close; entry = confirmation close: PASS",
  "adaptive evidence uses only resolveMs < T (prior resolved): PASS",
  "current signal never in its own evidence: PASS",
  "BB/RSI/ADX/expiry/thresholds pre-registered (no outcome retune): PASS",
  "HOLDOUT cut frozen before interpreting holdout outcomes; primary rule EST_GE_0.5556 pre-registered: PASS",
  "rsiSeverity fixed beyond-threshold buckets (not outcome-fitted): PASS",
  "bbWidthPctile trailing PIT last-500: PASS",
  `COLLECTING/LEARNING/ACTIVE thresholds from selector config (${MIN_LEARNING}/${MIN_ACTIVE}): PASS`,
  "selective TAKE rules during COLLECTING treated as TAKE (no claimed selection): PASS",
  "no writes to production adaptive tables / no live selector calls: PASS",
  "COMPARISON week labeled previously-inspected; HOLDOUT sealed for one-shot: PASS",
  gateScore.decided >= 200 && gateScore.wr >= 0.65
    ? "suspicious WR≥65% n≥200: FAIL→AUDIT"
    : "no suspicious WR≥65% with n≥200 on frozen base gate: PASS",
];

const learningCurveTable = [
  "resolvedN | ALL_n ALL_WR ALL_EV80 | TAKE_n TAKE_WR TAKE_EV80 cov | WAIT_WR | activeCtx | ctxMed | ≥100 | ≥300 | ≥500 | ≥1000",
  ...learningSnaps.map((s) => {
    const c = s.contextStats;
    return `${s.resolvedN} | ${s.all.decided} ${pct(s.all.wr)} ${s.all.ev80.toFixed(3)} | ${s.take.decided} ${pct(s.take.wr)} ${s.take.ev80.toFixed(3)} ${pct(s.coverage)} | ${pct(s.wait.wr)} | ${s.activeContexts} | ${Number.isFinite(c.median) ? c.median.toFixed(0) : "n/a"} | ${c.ge100} | ${c.ge300} | ${c.ge500} | ${c.ge1000}`;
  }),
];

fs.writeFileSync(
  CHECKPOINTS_CSV,
  [
    "resolvedN,allN,allWr,allEv80,takeN,takeWr,takeEv80,coverage,waitWr,activeContexts,ctxN,ctxMed,ctxP25,ctxP75,ge100,ge300,ge500,ge1000",
    ...learningSnaps.map((s) => {
      const c = s.contextStats;
      return [
        s.resolvedN,
        s.all.decided,
        s.all.wr.toFixed(6),
        s.all.ev80.toFixed(6),
        s.take.decided,
        s.take.wr.toFixed(6),
        s.take.ev80.toFixed(6),
        s.coverage.toFixed(6),
        s.wait.wr.toFixed(6),
        s.activeContexts,
        c.nContexts,
        c.median,
        c.p25,
        c.p75,
        c.ge100,
        c.ge300,
        c.ge500,
        c.ge1000,
      ].join(",");
    }),
  ].join("\n") + "\n",
);

/** Compact signals.jsonl — keep under size; write summary rows only if huge */
const writeSignals = allSignals.length <= 25_000;
if (writeSignals) {
  const stream = fs.createWriteStream(SIGNALS_PATH);
  for (const d of decisions) {
    stream.write(
      JSON.stringify({
        instrument: d.signal.instrument,
        dir: d.signal.dir,
        entryMs: d.signal.entryMs,
        resolveMs: d.signal.resolveMs,
        outcome: d.signal.outcome,
        zone: d.signal.zone,
        state: d.state,
        est: d.est,
        scope: d.scope,
        take: d.takes[PRIMARY_RULE],
        adxBucket: d.signal.adxBucket,
        session: d.signal.session,
      }) + "\n",
    );
  }
  stream.end();
}

for (const e of learnRuleEvals) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      zone: "LEARN",
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
      ev80: e.take.ev80,
      randomMean: e.randomMean,
      randomLo: e.randomLo,
      randomHi: e.randomHi,
      randomPctile: e.randomPctile,
      mono: e.mono,
    }),
  );
}
for (const e of holdoutRuleEvals) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      zone: "HOLDOUT",
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
      ev80: e.take.ev80,
    }),
  );
}
for (const s of learningSnaps) {
  registryLines.push(
    JSON.stringify({
      experiment: EXPERIMENT,
      type: "learning_checkpoint",
      ...s,
    }),
  );
}
registryLines.push(
  JSON.stringify({
    experiment: EXPERIMENT,
    zone: "GATE",
    n: gateScore.decided,
    wr: gateScore.wr,
    ev80: gateScore.ev80,
    gatePass: true,
  }),
);
registryLines.push(
  JSON.stringify({
    experiment: EXPERIMENT,
    verdict,
    hypothesis,
    primaryRule: PRIMARY_RULE,
    totalSignals: decisions.length,
    decided: fullAll.decided,
    lookbackDays: lookback,
    holdoutStart: new Date(holdoutStartMs).toISOString(),
    dataSpan: {
      from: new Date(loaded.m1Min).toISOString(),
      to: new Date(dataEndMs).toISOString(),
    },
  }),
);

const qBlock =
  primaryLearn.quintiles.length === 0
    ? "  (insufficient LEARNING/ACTIVE finite-est decisions for quintiles)"
    : primaryLearn.quintiles.map((q) => `  Q${q.q}: n=${q.n} WR=${pct(q.wr)}`).join("\n");

const learnThresholdBlock = learnRuleEvals
  .map(
    (e) =>
      `  ${e.rule}:
    TAKE n=${e.take.decided} cov=${pct(e.coverage)} WR=${pct(e.take.wr)} CI=[${pct(e.take.ciLow)},${pct(e.take.ciHigh)}] EV80=${e.take.ev80.toFixed(3)}
    WAIT n=${e.wait.decided} WR=${pct(e.wait.wr)}
    Δ(TAKE−ALL)=${(e.deltaTakeAll * 100).toFixed(2)}pp  Δ(TAKE−WAIT)=${(e.deltaTakeWait * 100).toFixed(2)}pp`,
  )
  .join("\n");

const holdoutThresholdBlock = holdoutRuleEvals
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

const signalSpanFrom = allSignals[0] ? new Date(allSignals[0].entryMs).toISOString() : "n/a";
const signalSpanTo = allSignals.length
  ? new Date(allSignals.at(-1)!.entryMs).toISOString()
  : "n/a";

const hypothesisSentence =
  hypothesis === "A"
    ? "Hypothesis A: more chronological evidence helps — LEARN and HOLDOUT both show TAKE edge with improving/stable selection."
    : hypothesis === "B"
      ? "Hypothesis B: no stable adaptive pattern — selection does not reliably improve ALL on sealed HOLDOUT (or LEARN improvement fails to hold)."
      : "Hypothesis inconclusive: mixed LEARN vs HOLDOUT signals; neither clean support for A nor B.";

const report = `GOLDENXPERIENCE
10,000-SIGNAL HISTORICAL ADAPTIVE BINARY TEST
(${EXPERIMENT})

================================
DATA
================================

Periods:
  studyFloor: ${new Date(studyFloorMs).toISOString()}
  holdoutStart (frozen): ${new Date(holdoutStartMs).toISOString()}
  gateStart (COMPARISON week): ${new Date(gateStartMs).toISOString()}
  dataEnd: ${new Date(dataEndMs).toISOString()}
  LEARN (DEV): [${new Date(studyFloorMs).toISOString()}, ${new Date(holdoutStartMs).toISOString()})
  HOLDOUT (sealed ~final 20% / ≤${HOLDOUT_MAX_DAYS}d): [${new Date(holdoutStartMs).toISOString()}, ${new Date(dataEndMs).toISOString()}]
  COMPARISON (recent week, previously inspected — NOT sealed): [${new Date(gateStartMs).toISOString()}, ${new Date(dataEndMs).toISOString()}]
Symbols: ${instruments.join(", ")}
Signals: LEARN=${learnDecisions.length} HOLDOUT=${holdoutDecisions.length} COMPARISON=${comparisonDecisions.length} TOTAL=${decisions.length}
Resolved decided: FULL=${fullAll.decided} LEARN=${learnAlways.all.decided} HOLDOUT=${holdoutAlways.all.decided}
Signal date span: ${signalSpanFrom} → ${signalSpanTo}
Lookback requested: ${lookback}d (target ≥${TARGET_SIGNALS} decided)
Replay method: generate all signals → sort by entryMs → single forward pass; evidence flush when resolveMs < T; ${EXPIRY_MIN}m expiry
Adaptive evidence initialization: empty store; only prior resolved outcomes
M1 bars: ${loaded.m1Total}
M1 coverage: ${new Date(loaded.m1Min).toISOString()} → ${new Date(dataEndMs).toISOString()}
Gaps / per-symbol:
${loaded.gapNotes.map((g) => `  ${g}`).join("\n")}
Short OANDA history:
${loaded.shortHistoryNotes.length ? loaded.shortHistoryNotes.map((g) => `  ${g}`).join("\n") : "  (none)"}
Reached ≥${TARGET_SIGNALS} decided: ${fullAll.decided >= TARGET_SIGNALS ? "YES" : `NO — only ${fullAll.decided}`}

Previously inspected data: COMPARISON week (bollinger-range / adaptive gate cohort)
Truly unseen / sealed: HOLDOUT final ~20% (config frozen before holdout interpretation)

================================
FROZEN BASE STRATEGY
================================

BB: period=${BB_PERIOD} k=${BB_K} population stdev (variance = mean(x^2)-mean(x)^2)
RSI: Wilder14; UP if RSI<=${RSI_OS}; DOWN if RSI>=${RSI_OB}
Re-entry: high>upper / low<lower excursion; close back inside; dedup until mid return + new outside
Expiry: ${EXPIRY_MIN} minutes only
Variant: BB_REENTRY_RSI | BB20
Thresholds: NOT retuned against outcomes

Reproduced previous result (TEST window dataEnd-7d):
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
  - classifyBinaryResult, getResearchCandles, MAJOR_INSTRUMENTS
  - NO live selectBinaryModel; NO production adaptive table writes
Context features (coarse, pre-registered):
  direction, adxBucket (<=20|20-25|25-30|>30), session (ET asia/london/overlap/ny/off), rsiSeverity, bbWidthPctile
Evidence hierarchy (first with n≥scopeMin):
  direction|adxBucket (30) → direction|session (30) → adxBucket (30) → direction (40) → overall (50)
Backoff logic: walk hierarchy; if no scope meets min → TAKE (cannot filter)
COLLECTING threshold: <${MIN_LEARNING} overall prior decided
LEARNING threshold: ${MIN_LEARNING}–${MIN_ACTIVE - 1}
ACTIVE threshold: ≥${MIN_ACTIVE}
COLLECTING policy for selective rules: TAKE (no filtering)
Primary TAKE rule (pre-registered): ${PRIMARY_RULE}

LEARN state mix: COLLECTING=${learnStateCounts.COLLECTING} LEARNING=${learnStateCounts.LEARNING} ACTIVE_SELECTION=${learnStateCounts.ACTIVE_SELECTION}
HOLDOUT state mix: COLLECTING=${holdoutStateCounts.COLLECTING} LEARNING=${holdoutStateCounts.LEARNING} ACTIVE_SELECTION=${holdoutStateCounts.ACTIVE_SELECTION}

================================
HEADLINE
================================

FROZEN ALL SIGNALS (LEARN)
${fmtScore(learnAlways.all)}

ADAPTIVE TAKE (primary ${PRIMARY_RULE} on LEARN)
n: ${primaryLearn.take.decided}
coverage: ${pct(primaryLearn.coverage)}
WR: ${pct(primaryLearn.take.wr)}
95% CI: [${pct(primaryLearn.take.ciLow)}, ${pct(primaryLearn.take.ciHigh)}]
EV80: ${primaryLearn.take.ev80.toFixed(3)}

ADAPTIVE WAIT COUNTERFACTUAL (LEARN)
n: ${primaryLearn.wait.decided}
WR: ${pct(primaryLearn.wait.wr)}
95% CI: [${pct(primaryLearn.wait.ciLow)}, ${pct(primaryLearn.wait.ciHigh)}]
EV80: ${primaryLearn.wait.ev80.toFixed(3)}

Improvement TAKE vs ALL (LEARN): ${(primaryLearn.deltaTakeAll * 100).toFixed(2)}pp
Improvement TAKE vs WAIT (LEARN): ${(primaryLearn.deltaTakeWait * 100).toFixed(2)}pp

MID/DEV TAKE vs ALL at ~10k decided (pre-holdout prefix):
  ALL ${fmtScore(at10kAll)}
  TAKE ${fmtScore(at10kTake)} cov=${at10kDecs.length ? pct(at10kTake.rawN / at10kDecs.length) : "n/a"}
  WAIT ${fmtScore(at10kWait)}

FULL stream: ALL ${fmtScore(fullAll)} | TAKE ${fmtScore(fullTake)}

================================
LEARNING CURVE
================================

${learningCurveTable.join("\n")}

================================
CONTEXT SAMPLE-SIZE DIAGNOSTICS
================================

(at learning checkpoints — see LEARNING CURVE columns ctxMed / ≥100 / ≥300 / ≥500 / ≥1000)
Final evidence cells (ex-overall): ${contextStatsFromEvidence(evidence).nContexts}
Final active contexts (n≥30): ${countActiveContexts(evidence)}

================================
HOLDOUT ONE-SHOT (sealed)
================================

FROZEN ALL: ${fmtScore(holdoutAlways.all)}
ADAPTIVE TAKE (${PRIMARY_RULE}): ${fmtScore(primaryHoldout.take)} cov=${pct(primaryHoldout.coverage)}
ADAPTIVE WAIT: ${fmtScore(primaryHoldout.wait)}
Δ(TAKE−ALL)=${(primaryHoldout.deltaTakeAll * 100).toFixed(2)}pp  Δ(TAKE−WAIT)=${(primaryHoldout.deltaTakeWait * 100).toFixed(2)}pp

================================
COMPARISON WEEK (previously inspected — NOT sealed)
================================

ALL: ${fmtScore(comparisonAlways.all)}
TAKE (${PRIMARY_RULE}): ${fmtScore(comparisonEval.take)} cov=${pct(comparisonEval.coverage)}
WAIT: ${fmtScore(comparisonEval.wait)}
Δ(TAKE−ALL)=${(comparisonEval.deltaTakeAll * 100).toFixed(2)}pp

================================
SELECTOR THRESHOLDS
================================

LEARN (all pre-registered rules):
${learnThresholdBlock}

HOLDOUT (same rules, one-shot):
${holdoutThresholdBlock}

================================
QUALITY RANKING (LEARN, ACTIVE/LEARNING est)
================================

${qBlock}

Does adaptive score monotonically rank realized WR?
${primaryLearn.mono == null ? "INCONCLUSIVE" : primaryLearn.mono ? "YES" : "NO"}

================================
RANDOM SELECTOR CONTROL (LEARN, ${RANDOM_SHUFFLES} shuffles)
================================

Adaptive coverage: ${pct(primaryLearn.coverage)}
Adaptive WR: ${pct(primaryLearn.take.wr)}

Matched random selector (same coverage on decided):
mean WR: ${Number.isFinite(primaryLearn.randomMean) ? pct(primaryLearn.randomMean) : "n/a"}
95% random range: [${Number.isFinite(primaryLearn.randomLo) ? pct(primaryLearn.randomLo) : "n/a"}, ${Number.isFinite(primaryLearn.randomHi) ? pct(primaryLearn.randomHi) : "n/a"}]
Adaptive percentile vs random: ${Number.isFinite(primaryLearn.randomPctile) ? pct(primaryLearn.randomPctile) : "n/a"}
Beats random (TAKE WR > random 97.5%ile): ${beatsRandom ? "YES" : "NO"}

================================
SIMPLE FILTER CONTROLS (LEARN)
================================

${simpleBlock}
  Adaptive (${PRIMARY_RULE}): TAKE ${fmtScore(primaryLearn.take)} cov=${pct(primaryLearn.coverage)}

================================
THRESHOLD ATTAINMENT (LEARN TAKE ${PRIMARY_RULE})
================================

${thresholdAttainment(learnDecisions, PRIMARY_RULE, [BE80, 0.58, 0.6, 0.62, 0.65]).join("\n")}

HOLDOUT TAKE attainment:
${thresholdAttainment(holdoutDecisions, PRIMARY_RULE, [BE80, 0.58, 0.6, 0.62, 0.65]).join("\n")}

================================
ROLLING WINDOWS (LEARN, ${PRIMARY_RULE})
================================

window=250:
${rollingWindowLines(learnDecisions, PRIMARY_RULE, 250).join("\n")}

window=500:
${rollingWindowLines(learnDecisions, PRIMARY_RULE, 500).join("\n")}

window=1000:
${rollingWindowLines(learnDecisions, PRIMARY_RULE, 1000).join("\n")}

================================
BY MONTH (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.month).join("\n")}

================================
ADX / TREND REGIME (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.adxBucket).join("\n")}

================================
BB WIDTH REGIME (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.bbWidthBucket).join("\n")}

================================
UP vs DOWN (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.dir).join("\n")}

================================
SYMBOL STABILITY (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.instrument).join("\n")}

================================
SESSION STABILITY (LEARN)
================================

${groupLines(learnDecisions, PRIMARY_RULE, (d) => d.signal.session).join("\n")}

================================
PAYOUT ANALYSIS
================================

Break-even @80% payout: ${pct(BE80)}

LEARN ALL:
${payoutBlock(learnAlways.all)}

LEARN TAKE (${PRIMARY_RULE}):
${payoutBlock(primaryLearn.take)}

HOLDOUT ALL:
${payoutBlock(holdoutAlways.all)}

HOLDOUT TAKE (${PRIMARY_RULE}):
${payoutBlock(primaryHoldout.take)}

================================
LEAKAGE AUDIT
================================

${leakageChecks.map((c) => `  - ${c}`).join("\n")}

================================
HYPOTHESIS A vs B
================================

A = more data helps (stable contextual edge emerges with sample)
B = no stable pattern (selection noise / regime-specific)

Conclusion: ${hypothesisSentence}

================================
DIRECT ANSWERS
================================

1. Does adaptive selection improve the frozen strategy?
   LEARN: Δ=${(primaryLearn.deltaTakeAll * 100).toFixed(2)}pp; HOLDOUT: Δ=${(primaryHoldout.deltaTakeAll * 100).toFixed(2)}pp

2. Does adaptive TAKE reach 60%?
   LEARN: ${pct(primaryLearn.take.wr)} (n=${primaryLearn.take.decided}); HOLDOUT: ${pct(primaryHoldout.take.wr)} (n=${primaryHoldout.take.decided})

3. With how many signals?
   LEARN TAKE n=${primaryLearn.take.decided}; HOLDOUT TAKE n=${primaryHoldout.take.decided}; FULL decided=${fullAll.decided}

4. What percentage of signals does it keep?
   LEARN cov=${pct(primaryLearn.coverage)}; HOLDOUT cov=${pct(primaryHoldout.coverage)}

5. Are rejected WAIT signals actually worse?
   LEARN WAIT ${pct(primaryLearn.wait.wr)} vs TAKE ${pct(primaryLearn.take.wr)}; HOLDOUT WAIT ${pct(primaryHoldout.wait.wr)} vs TAKE ${pct(primaryHoldout.take.wr)}

6. Does predicted signal quality rank realized WR?
   ${primaryLearn.mono == null ? "INCONCLUSIVE" : primaryLearn.mono ? "YES" : "NO"}

7. Does adaptive selection beat matched random selection?
   ${beatsRandom ? "YES" : "NO"} (pctile ${Number.isFinite(primaryLearn.randomPctile) ? pct(primaryLearn.randomPctile) : "n/a"})

8. Does it beat simple RSI-only or ADX-only filtering?
   Adaptive ${pct(primaryLearn.take.wr)} vs RSI-ext ${pct(simpleControls[1]!.take.wr)} ADX>25 ${pct(simpleControls[2]!.take.wr)} ADX<=20 ${pct(simpleControls[3]!.take.wr)}

9. Which contexts appear responsible?
   See ADX / session / month slices; hierarchy prefers direction|adxBucket when n≥30

10. Is the improvement stable across months/days?
    See BY MONTH and ROLLING WINDOWS

11. Is it stable across symbols?
    See SYMBOL STABILITY

12. At 80% payout, is adaptive TAKE profitable?
    LEARN EV80=${primaryLearn.take.ev80.toFixed(3)}; HOLDOUT EV80=${primaryHoldout.take.ev80.toFixed(3)}

13. Is the evidence genuinely OOS or still DEVELOPMENT?
    HOLDOUT is sealed one-shot; COMPARISON week is previously inspected; LEARN is development

================================
FINAL VERDICT
================================

${verdict}

Honesty notes:
- Primary rule ${PRIMARY_RULE} was pre-registered from prior adaptive experiment; not retuned on HOLDOUT.
- Gate week used only for reproduce + COMPARISON label.
- Hypothesis: ${hypothesis}. ${hypothesisSentence}
- Total decided signals: ${fullAll.decided} over ${signalSpanFrom} → ${signalSpanTo}
- Cache dir: ${CACHE_DIR}
`;

fs.writeFileSync(REPORT_PATH, report);
fs.writeFileSync(REGISTRY_PATH, registryLines.join("\n") + "\n");
console.log(`Wrote ${REPORT_PATH}`);
console.log(`Wrote ${REGISTRY_PATH}`);
console.log(`Wrote ${CHECKPOINTS_CSV}`);
if (writeSignals) console.log(`Wrote ${SIGNALS_PATH}`);
console.log(`VERDICT: ${verdict}`);
console.log(`HYPOTHESIS: ${hypothesis}`);
console.log(`GATE: ${fmtScore(gateScore)}`);
console.log(`LEARN TAKE: ${fmtScore(primaryLearn.take)} cov=${pct(primaryLearn.coverage)}`);
console.log(`HOLDOUT TAKE: ${fmtScore(primaryHoldout.take)} cov=${pct(primaryHoldout.coverage)}`);
console.log(`at10k TAKE vs ALL: TAKE ${fmtScore(at10kTake)} | ALL ${fmtScore(at10kAll)}`);
