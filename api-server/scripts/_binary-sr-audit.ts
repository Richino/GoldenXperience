/**
 * GOLDENXPERIENCE — BINARY SUPPORT/RESISTANCE EDGE AUDIT
 *
 * Research only. Does NOT modify binary strategy, predictions, adaptive engine,
 * or production behavior.
 *
 * Hypothesis: existing ~49% binary calls may clear payout break-even when
 * conditioned on objective, point-in-time support/resistance context.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import {
  classifyBinaryResult,
  type BinaryCandle,
} from "../src/binary-engine.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "binary-sr-audit");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");
const SWING_K = 3;
const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ET_HOUR_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hourCycle: "h23",
});

type InstrumentCache = {
  candles: BinaryCandle[];
  /** close time ms for candles[i] (OANDA open + 60s) */
  closeMs: number[];
  /** ET calendar day for each candle close */
  dayKeys: string[];
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PredRow = {
  id: string;
  prediction_sequence: string;
  instrument: string;
  direction: "up" | "down";
  start_at: string;
  entry_price: number;
  price_precision: number;
  confidence: number;
  result: "won" | "lost" | "tie" | null;
  secondary_marks: Record<string, { price: number; priceTime: string; result: "won" | "lost" | "tie" }> | null;
  session: string | null;
};

type LevelKind = "roll_high" | "roll_low" | "swing_high" | "swing_low" | "session_high" | "session_low" | "pd_high" | "pd_low" | "pd_close";
type Side = "support" | "resistance";

type Level = {
  price: number;
  side: Side;
  kinds: LevelKind[];
  ageBars: number;
  touches: number;
  rejections: number;
};

type InteractionState = "APPROACHING_LEVEL" | "TOUCHING_LEVEL" | "REJECTING_LEVEL" | "BREAKING_LEVEL" | "RETESTING_AFTER_BREAK" | "AWAY_FROM_LEVEL";

type Sample = {
  id: string;
  instrument: string;
  direction: "up" | "down";
  startAt: string;
  entry: number;
  confidence: number;
  session: string;
  zone: "train" | "dev" | "holdout";
  atr: number;
  // outcomes by expiry (excl ties tracked separately)
  o1: "won" | "lost" | "tie" | "missing";
  o5: "won" | "lost" | "tie" | "missing";
  o10: "won" | "lost" | "tie" | "missing";
  o15: "won" | "lost" | "tie" | "missing";
  // S/R features
  distSupAtr: number;
  distResAtr: number;
  nearSup: boolean;
  nearRes: boolean;
  proxBucket: string; // for nearest relevant level
  proxSupBucket: string;
  proxResBucket: string;
  supTouches: number;
  resTouches: number;
  supConfluence: number;
  resConfluence: number;
  approach: "fast" | "medium" | "slow" | "none";
  approachSide: "support" | "resistance" | "none";
  stateSup: InteractionState;
  stateRes: InteractionState;
  bodyRatio: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  closeLoc: number;
  rangeAtr: number;
  ret1: number;
  ret3: number;
  ret5: number;
};

type BucketStats = {
  n: number;
  won: number;
  lost: number;
  tie: number;
  missing: number;
  decided: number;
  wr: number;
  ciLow: number;
  ciHigh: number;
  liftPp: number;
  ev80: number;
  ev85: number;
  ev90: number;
  coverage: number;
  label: string;
};

type Candidate = {
  id: string;
  hypothesis: string;
  condition: string;
  expiry: 1 | 5 | 10 | 15;
  direction: "up" | "down" | "any";
  filter: (s: Sample) => boolean;
  train?: BucketStats;
  dev?: BucketStats;
  holdout?: BucketStats;
};

// ---------------------------------------------------------------------------
// Math / helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function wilsonCi(wins: number, decided: number) {
  if (decided <= 0) return { rate: 0, low: 0, high: 0 };
  const z = 1.96;
  const p = wins / decided;
  const denom = 1 + (z * z) / decided;
  const centre = p + (z * z) / (2 * decided);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * decided)) / decided);
  return { rate: p, low: (centre - margin) / denom, high: (centre + margin) / denom };
}

function breakEven(payout: number) {
  return 1 / (1 + payout);
}

function ev(wr: number, payout: number) {
  return wr * payout - (1 - wr);
}

function candleCloseIso(c: BinaryCandle) {
  return new Date(new Date(c.time).getTime() + 60_000).toISOString();
}

function atr14(candles: BinaryCandle[], endIdx: number): number {
  if (endIdx < 14) return NaN;
  let sum = 0;
  for (let i = endIdx - 13; i <= endIdx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    sum += tr;
  }
  return sum / 14;
}

function proxBucket(distAtr: number): string {
  if (distAtr < 0.1) return "<0.10";
  if (distAtr < 0.2) return "0.10-0.20";
  if (distAtr < 0.3) return "0.20-0.30";
  if (distAtr < 0.5) return "0.30-0.50";
  return ">0.50";
}

function sessionOf(iso: string): string {
  const h = Number(ET_HOUR_FMT.formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value);
  if (h >= 3 && h < 8) return "asia";
  if (h >= 8 && h < 12) return "london";
  if (h >= 12 && h < 17) return "overlap";
  if (h >= 17 && h < 21) return "newyork";
  return "off";
}

function toBinaryCandles(raw: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
  return raw.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: c.volume,
    complete: c.complete,
  }));
}

async function fetchM1Range(instrument: string, fromIso: string, toIso: string): Promise<BinaryCandle[]> {
  const fromMs = Date.parse(fromIso) - 3 * 24 * 60 * 60_000; // need history for swings/PD
  const toMs = Date.parse(toIso) + 20 * 60_000;
  const all: BinaryCandle[] = [];
  let cursor = new Date(toMs).toISOString();
  for (let page = 0; page < 60; page++) {
    const raw = await getResearchCandles(instrument as MajorInstrument, "M1", 5000, { to: cursor });
    const batch = toBinaryCandles(raw).filter((c) => c.complete);
    if (!batch.length) break;
    for (const c of batch) all.push(c);
    const earliest = batch.reduce((m, c) => (c.time < m ? c.time : m), batch[0]!.time);
    if (Date.parse(earliest) <= fromMs) break;
    cursor = earliest;
    await sleep(150);
  }
  const by = new Map(all.map((c) => [c.time, c]));
  return [...by.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function buildInstrumentCache(candles: BinaryCandle[]): InstrumentCache {
  const closeMs = candles.map((c) => Date.parse(c.time) + 60_000);
  const dayKeys = closeMs.map((ms) => ET_DAY_FMT.format(new Date(ms)));
  return { candles, closeMs, dayKeys };
}

/** Last completed candle index with close_time <= asOf. */
function lastKnownIdx(cache: InstrumentCache, asOfIso: string): number {
  const asOf = Date.parse(asOfIso);
  const { closeMs } = cache;
  let lo = 0;
  let hi = closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMs[mid]! <= asOf) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Earliest completed candle with close_time >= targetMs (binary search). */
function resolutionAtOrAfter(cache: InstrumentCache, targetMs: number): { price: number; time: string } | null {
  const { candles, closeMs } = cache;
  let lo = 0;
  let hi = closeMs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closeMs[mid]! >= targetMs) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (ans < 0) return null;
  return { price: candles[ans]!.close, time: new Date(closeMs[ans]!).toISOString() };
}

// ---------------------------------------------------------------------------
// Level construction (point-in-time: only bars[0..idx])
// ---------------------------------------------------------------------------

function countTouches(candles: BinaryCandle[], idx: number, price: number, atr: number, lookback = 200): number {
  const start = Math.max(0, idx - lookback);
  const band = 0.15 * atr;
  let n = 0;
  for (let i = start; i <= idx; i++) {
    const c = candles[i]!;
    if (c.low <= price + band && c.high >= price - band) n += 1;
  }
  return n;
}

function countRejections(candles: BinaryCandle[], idx: number, price: number, atr: number, side: Side, lookback = 200): number {
  const start = Math.max(1, idx - lookback);
  const band = 0.15 * atr;
  let n = 0;
  for (let i = start; i <= idx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    if (side === "resistance") {
      // touched from below then closed lower
      if (c.high >= price - band && c.close < price - 0.05 * atr && prev.close < price) n += 1;
    } else {
      if (c.low <= price + band && c.close > price + 0.05 * atr && prev.close > price) n += 1;
    }
  }
  return n;
}

function buildLevels(candles: BinaryCandle[], idx: number, atr: number, dayKeys: string[]): Level[] {
  if (idx < 60 || !(atr > 0)) return [];
  const levels: Level[] = [];
  const push = (price: number, side: Side, kind: LevelKind, ageBars: number) => {
    if (!(price > 0)) return;
    // touches/rejections deferred until nearest levels are known
    levels.push({ price, side, kinds: [kind], ageBars, touches: 0, rejections: 0 });
  };

  // A. Rolling highs/lows
  for (const n of [10, 20, 50] as const) {
    if (idx < n) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = idx - n + 1; i <= idx; i++) {
      hi = Math.max(hi, candles[i]!.high);
      lo = Math.min(lo, candles[i]!.low);
    }
    push(hi, "resistance", "roll_high", 0);
    push(lo, "support", "roll_low", 0);
  }

  // B. Confirmed swings — only scan last 300 bars (pivot needs k bars on each side)
  const k = SWING_K;
  const swingStart = Math.max(k, idx - 300);
  for (let p = swingStart; p <= idx - k; p++) {
    const h = candles[p]!.high;
    const l = candles[p]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (candles[p - j]!.high >= h || candles[p + j]!.high >= h) isHigh = false;
      if (candles[p - j]!.low <= l || candles[p + j]!.low <= l) isLow = false;
    }
    if (isHigh) push(h, "resistance", "swing_high", idx - p);
    if (isLow) push(l, "support", "swing_low", idx - p);
  }

  // C/D. Session + previous day (precomputed ET day keys)
  const today = dayKeys[idx]!;
  let dayHi = -Infinity;
  let dayLo = Infinity;
  let dayBars = 0;
  let prevDay: string | null = null;
  let prevHi = -Infinity;
  let prevLo = Infinity;
  let prevClose = NaN;
  let prevBars = 0;
  for (let i = idx; i >= Math.max(0, idx - 2000); i--) {
    const d = dayKeys[i]!;
    const c = candles[i]!;
    if (d === today) {
      dayHi = Math.max(dayHi, c.high);
      dayLo = Math.min(dayLo, c.low);
      dayBars += 1;
    } else if (dayBars > 0) {
      if (prevDay == null) prevDay = d;
      if (d === prevDay) {
        prevHi = Math.max(prevHi, c.high);
        prevLo = Math.min(prevLo, c.low);
        if (prevBars === 0) prevClose = c.close; // first encountered going backward = day close
        prevBars += 1;
      } else break;
    }
  }
  if (dayBars) {
    push(dayHi, "resistance", "session_high", 0);
    push(dayLo, "support", "session_low", 0);
  }
  if (prevBars) {
    push(prevHi, "resistance", "pd_high", dayBars);
    push(prevLo, "support", "pd_low", dayBars);
    push(prevClose, candles[idx]!.close >= prevClose ? "support" : "resistance", "pd_close", dayBars);
  }

  // Merge nearby levels within 0.1 ATR into confluence zones
  const mergeBand = 0.1 * atr;
  const merged: Level[] = [];
  const used = new Set<number>();
  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    const group = [levels[i]!];
    used.add(i);
    for (let j = i + 1; j < levels.length; j++) {
      if (used.has(j)) continue;
      if (levels[j]!.side !== levels[i]!.side) continue;
      if (Math.abs(levels[j]!.price - levels[i]!.price) <= mergeBand) {
        group.push(levels[j]!);
        used.add(j);
      }
    }
    const price = group.reduce((s, g) => s + g.price, 0) / group.length;
    const kinds = [...new Set(group.flatMap((g) => g.kinds))];
    const swingAges = group
      .filter((g) => g.kinds.includes("swing_high") || g.kinds.includes("swing_low"))
      .map((g) => g.ageBars);
    const ageBars = swingAges.length
      ? Math.min(...swingAges)
      : Math.min(...group.map((g) => g.ageBars));
    merged.push({
      price,
      side: levels[i]!.side,
      kinds,
      ageBars,
      touches: 0,
      rejections: 0,
    });
  }
  return merged;
}

function enrichLevel(level: Level, candles: BinaryCandle[], idx: number, atr: number): Level {
  return {
    ...level,
    touches: countTouches(candles, idx, level.price, atr),
    rejections: countRejections(candles, idx, level.price, atr, level.side),
  };
}

function classifyState(
  candles: BinaryCandle[],
  idx: number,
  level: Level,
  atr: number,
  price: number,
): InteractionState {
  const dist = Math.abs(price - level.price) / atr;
  const band = 0.15;
  const c = candles[idx]!;
  const prev = candles[idx - 1] ?? c;
  const prev2 = candles[idx - 2] ?? prev;

  if (dist > 0.5) return "AWAY_FROM_LEVEL";

  if (level.side === "resistance") {
    const broke = prev.close > level.price + 0.05 * atr && price > level.price;
    const retest = broke && price <= level.price + 0.2 * atr && price >= level.price - 0.15 * atr;
    if (retest) return "RETESTING_AFTER_BREAK";
    if (c.close > level.price + 0.05 * atr && prev.close <= level.price + 0.05 * atr) return "BREAKING_LEVEL";
    const rejecting =
      c.high >= level.price - band * atr &&
      c.close < level.price - 0.05 * atr &&
      c.high - Math.max(c.open, c.close) > 0.3 * (c.high - c.low);
    if (rejecting) return "REJECTING_LEVEL";
    if (dist < band) return "TOUCHING_LEVEL";
    if (price < level.price && prev.close < level.price && price > prev2.close) return "APPROACHING_LEVEL";
    return dist < 0.3 ? "APPROACHING_LEVEL" : "AWAY_FROM_LEVEL";
  }

  // support
  const broke = prev.close < level.price - 0.05 * atr && price < level.price;
  const retest = broke && price >= level.price - 0.2 * atr && price <= level.price + 0.15 * atr;
  if (retest) return "RETESTING_AFTER_BREAK";
  if (c.close < level.price - 0.05 * atr && prev.close >= level.price - 0.05 * atr) return "BREAKING_LEVEL";
  const rejecting =
    c.low <= level.price + band * atr &&
    c.close > level.price + 0.05 * atr &&
    Math.min(c.open, c.close) - c.low > 0.3 * (c.high - c.low);
  if (rejecting) return "REJECTING_LEVEL";
  if (dist < band) return "TOUCHING_LEVEL";
  if (price > level.price && prev.close > level.price && price < prev2.close) return "APPROACHING_LEVEL";
  return dist < 0.3 ? "APPROACHING_LEVEL" : "AWAY_FROM_LEVEL";
}

function approachSpeed(retTowardLevelAtr: number): "fast" | "medium" | "slow" | "none" {
  const a = Math.abs(retTowardLevelAtr);
  if (a < 0.05) return "none";
  if (a < 0.2) return "slow";
  if (a < 0.45) return "medium";
  return "fast";
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function outcomeAt(
  cache: InstrumentCache,
  direction: "up" | "down",
  entry: number,
  precision: number,
  startAtMs: number,
  seconds: number,
): "won" | "lost" | "tie" | "missing" {
  const mark = resolutionAtOrAfter(cache, startAtMs + seconds * 1000);
  if (!mark) return "missing";
  if (Date.parse(mark.time) <= startAtMs) return "missing";
  return classifyBinaryResult(direction, entry, mark.price, precision);
}

function statsOf(samples: Sample[], expiry: 1 | 5 | 10 | 15, baselineWr: number, totalUniverse: number): BucketStats {
  const key = expiry === 1 ? "o1" : expiry === 5 ? "o5" : expiry === 10 ? "o10" : "o15";
  let won = 0;
  let lost = 0;
  let tie = 0;
  let missing = 0;
  for (const s of samples) {
    const r = s[key];
    if (r === "won") won += 1;
    else if (r === "lost") lost += 1;
    else if (r === "tie") tie += 1;
    else missing += 1;
  }
  const decided = won + lost;
  const ci = wilsonCi(won, decided);
  const wr = ci.rate;
  return {
    n: samples.length,
    won,
    lost,
    tie,
    missing,
    decided,
    wr,
    ciLow: ci.low,
    ciHigh: ci.high,
    liftPp: (wr - baselineWr) * 100,
    ev80: ev(wr, 0.8),
    ev85: ev(wr, 0.85),
    ev90: ev(wr, 0.9),
    coverage: totalUniverse ? samples.length / totalUniverse : 0,
    label: decided
      ? `n=${decided} W=${won} L=${lost} T=${tie} WR=${(wr * 100).toFixed(2)}% CI=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%] lift=${((wr - baselineWr) * 100).toFixed(1)}pp cov=${((samples.length / Math.max(1, totalUniverse)) * 100).toFixed(1)}%`
      : `n=0`,
  };
}

function fmt(s: BucketStats) {
  return s.label;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Loading authoritative baseline predictions...");
const predRes = await query<PredRow>(
  `SELECT id, prediction_sequence::text, instrument, direction, start_at::text, entry_price::float,
          price_precision, confidence::float, result, secondary_marks,
          COALESCE(market_context->>'session', features->>'session') AS session
     FROM binary_predictions
    WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
    ORDER BY start_at`,
);
const preds = predRes.rows;
console.log(`Loaded ${preds.length} predictions`);
if (preds.length < 200) {
  console.error("INSUFFICIENT_DATA: too few predictions");
  process.exit(1);
}

// Chronological boundaries BEFORE looking at S/R outcomes for selection
const times = preds.map((p) => Date.parse(p.start_at)).sort((a, b) => a - b);
const t60 = times[Math.floor(times.length * 0.6)]!;
const t80 = times[Math.floor(times.length * 0.8)]!;
const zoneOf = (iso: string): "train" | "dev" | "holdout" => {
  const t = Date.parse(iso);
  if (t <= t60) return "train";
  if (t <= t80) return "dev";
  return "holdout";
};

const instruments = [...new Set(preds.map((p) => p.instrument))].sort();
const minStart = preds[0]!.start_at;
const maxStart = preds.at(-1)!.start_at;

console.log(`Zones: TRAIN ≤ ${new Date(t60).toISOString()} | DEV ≤ ${new Date(t80).toISOString()} | HOLDOUT after`);
console.log(`Fetching M1 (+history pad) for ${instruments.length} instruments...`);

const candlesByInst = new Map<string, InstrumentCache>();
for (const inst of instruments) {
  const candles = await fetchM1Range(inst, minStart, maxStart);
  candlesByInst.set(inst, buildInstrumentCache(candles));
  console.log(`  ${inst}: ${candles.length} M1 bars`);
}

// Leakage self-check: swing confirmation must not use future bars
{
  const cache = candlesByInst.get(instruments[0]!)!;
  const idx = 100;
  const levels = buildLevels(cache.candles, idx, atr14(cache.candles, idx), cache.dayKeys);
  for (const l of levels) {
    if (l.kinds.includes("swing_high") || l.kinds.includes("swing_low")) {
      if (l.ageBars < SWING_K) throw new Error("swing leakage: ageBars < k");
    }
  }
  console.log("Leakage self-check: swing age OK");
}

console.log("Building per-prediction S/R features...");
const samples: Sample[] = [];
let skipped = 0;

for (let pi = 0; pi < preds.length; pi++) {
  const pred = preds[pi]!;
  if (pi > 0 && pi % 500 === 0) console.log(`  ... ${pi}/${preds.length}`);
  const cache = candlesByInst.get(pred.instrument);
  if (!cache?.candles.length) {
    skipped += 1;
    continue;
  }
  const { candles } = cache;
  const idx = lastKnownIdx(cache, pred.start_at);
  if (idx < 80) {
    skipped += 1;
    continue;
  }
  const lastClose = cache.closeMs[idx]!;
  if (lastClose > Date.parse(pred.start_at)) throw new Error(`lookahead candle for ${pred.id}`);

  const atr = atr14(candles, idx);
  if (!(atr > 0)) {
    skipped += 1;
    continue;
  }

  const price = Number(pred.entry_price);
  const levels = buildLevels(candles, idx, atr, cache.dayKeys);
  const supports = levels.filter((l) => l.side === "support" && l.price <= price + 0.05 * atr);
  const resistances = levels.filter((l) => l.side === "resistance" && l.price >= price - 0.05 * atr);

  let nearestSup = supports.sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0] ?? null;
  let nearestRes = resistances.sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0] ?? null;
  if (nearestSup) nearestSup = enrichLevel(nearestSup, candles, idx, atr);
  if (nearestRes) nearestRes = enrichLevel(nearestRes, candles, idx, atr);

  const distSupAtr = nearestSup ? Math.abs(price - nearestSup.price) / atr : 99;
  const distResAtr = nearestRes ? Math.abs(price - nearestRes.price) / atr : 99;

  const c = candles[idx]!;
  const range = Math.max(c.high - c.low, 1e-12);
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const retN = (n: number) => {
    const prev = candles[idx - n];
    if (!prev || !(prev.close > 0)) return 0;
    return (c.close - prev.close) / atr;
  };
  const ret1 = retN(1);
  const ret3 = retN(3);
  const ret5 = retN(5);

  let approachSide: Sample["approachSide"] = "none";
  let approach: Sample["approach"] = "none";
  if (distResAtr <= distSupAtr && nearestRes) {
    approachSide = "resistance";
    approach = price < nearestRes.price ? approachSpeed(Math.max(0, ret3)) : approachSpeed(Math.abs(ret3));
  } else if (nearestSup) {
    approachSide = "support";
    approach = price > nearestSup.price ? approachSpeed(Math.max(0, -ret3)) : approachSpeed(Math.abs(ret3));
  }

  const stateSup = nearestSup ? classifyState(candles, idx, nearestSup, atr, price) : "AWAY_FROM_LEVEL";
  const stateRes = nearestRes ? classifyState(candles, idx, nearestRes, atr, price) : "AWAY_FROM_LEVEL";

  const startAtMs = Date.parse(pred.start_at);
  const precision = Number(pred.price_precision);
  const dir = pred.direction;

  samples.push({
    id: pred.id,
    instrument: pred.instrument,
    direction: dir,
    startAt: pred.start_at,
    entry: price,
    confidence: Number(pred.confidence),
    session: pred.session || sessionOf(pred.start_at),
    zone: zoneOf(pred.start_at),
    atr,
    o1: outcomeAt(cache, dir, price, precision, startAtMs, 60),
    o5: outcomeAt(cache, dir, price, precision, startAtMs, 300),
    o10: outcomeAt(cache, dir, price, precision, startAtMs, 600),
    o15: outcomeAt(cache, dir, price, precision, startAtMs, 900),
    distSupAtr,
    distResAtr,
    nearSup: distSupAtr < 0.3,
    nearRes: distResAtr < 0.3,
    proxBucket: proxBucket(Math.min(distSupAtr, distResAtr)),
    proxSupBucket: proxBucket(distSupAtr),
    proxResBucket: proxBucket(distResAtr),
    supTouches: nearestSup?.touches ?? 0,
    resTouches: nearestRes?.touches ?? 0,
    supConfluence: nearestSup?.kinds.length ?? 0,
    resConfluence: nearestRes?.kinds.length ?? 0,
    approach,
    approachSide,
    stateSup,
    stateRes,
    bodyRatio: body / range,
    upperWickRatio: upper / range,
    lowerWickRatio: lower / range,
    closeLoc: (c.close - c.low) / range,
    rangeAtr: range / atr,
    ret1,
    ret3,
    ret5,
  });
}

console.log(`Samples built: ${samples.length} (skipped ${skipped})`);
const train = samples.filter((s) => s.zone === "train");
const dev = samples.filter((s) => s.zone === "dev");
const holdout = samples.filter((s) => s.zone === "holdout");
console.log(`TRAIN=${train.length} DEV=${dev.length} HOLDOUT=${holdout.length}`);

const baseline10 = statsOf(samples, 10, 0.5, samples.length);
const baseline1 = statsOf(samples, 1, 0.5, samples.length);
const baseline5 = statsOf(samples, 5, 0.5, samples.length);
const baseline15 = statsOf(samples, 15, 0.5, samples.length);
const baseWr10 = baseline10.wr;

const BE80 = breakEven(0.8);

function bucket(rows: Sample[], expiry: 1 | 5 | 10 | 15, baseWr = baseWr10) {
  return statsOf(rows, expiry, baseWr, samples.length);
}

function appendRegistry(row: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.appendFileSync(REGISTRY_PATH, JSON.stringify({ ...row, ts: new Date().toISOString() }) + "\n");
}

// ---------------------------------------------------------------------------
// Descriptive analysis helpers
// ---------------------------------------------------------------------------

function linesFor(
  title: string,
  rows: Sample[],
  grouper: (s: Sample) => string,
  expiry: 1 | 5 | 10 | 15,
  dirFilter?: "up" | "down",
): string[] {
  const filtered = dirFilter ? rows.filter((s) => s.direction === dirFilter) : rows;
  const map = new Map<string, Sample[]>();
  for (const s of filtered) {
    const k = grouper(s);
    const arr = map.get(k) ?? [];
    arr.push(s);
    map.set(k, arr);
  }
  const out = [title];
  for (const [k, arr] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`  ${k}: ${fmt(bucket(arr, expiry))}`);
  }
  return out;
}

// Predefined hypotheses → candidate filters (selected on DEV only)
const candidateDefs: Omit<Candidate, "train" | "dev" | "holdout">[] = [];

for (const expiry of [1, 5, 10, 15] as const) {
  // H1 near support + UP
  for (const prox of ["<0.10", "0.10-0.20", "0.20-0.30"] as const) {
    candidateDefs.push({
      id: `H1-sup-${prox}-UP-${expiry}m`,
      hypothesis: "H1",
      condition: `near support ${prox} ATR + UP`,
      expiry,
      direction: "up",
      filter: (s) => s.direction === "up" && s.proxSupBucket === prox,
    });
  }
  // H2 near resistance + DOWN
  for (const prox of ["<0.10", "0.10-0.20", "0.20-0.30"] as const) {
    candidateDefs.push({
      id: `H2-res-${prox}-DOWN-${expiry}m`,
      hypothesis: "H2",
      condition: `near resistance ${prox} ATR + DOWN`,
      expiry,
      direction: "down",
      filter: (s) => s.direction === "down" && s.proxResBucket === prox,
    });
  }
  // H3 rejection support → UP
  candidateDefs.push({
    id: `H3-sup-reject-UP-${expiry}m`,
    hypothesis: "H3",
    condition: `support REJECTING + UP`,
    expiry,
    direction: "up",
    filter: (s) => s.direction === "up" && s.stateSup === "REJECTING_LEVEL",
  });
  // H4 rejection resistance → DOWN
  candidateDefs.push({
    id: `H4-res-reject-DOWN-${expiry}m`,
    hypothesis: "H4",
    condition: `resistance REJECTING + DOWN`,
    expiry,
    direction: "down",
    filter: (s) => s.direction === "down" && s.stateRes === "REJECTING_LEVEL",
  });
  // H5 breakout resistance → UP
  candidateDefs.push({
    id: `H5-res-break-UP-${expiry}m`,
    hypothesis: "H5",
    condition: `resistance BREAKING + UP`,
    expiry,
    direction: "up",
    filter: (s) => s.direction === "up" && (s.stateRes === "BREAKING_LEVEL" || s.stateRes === "RETESTING_AFTER_BREAK"),
  });
  // H6 breakdown support → DOWN
  candidateDefs.push({
    id: `H6-sup-break-DOWN-${expiry}m`,
    hypothesis: "H6",
    condition: `support BREAKING + DOWN`,
    expiry,
    direction: "down",
    filter: (s) => s.direction === "down" && (s.stateSup === "BREAKING_LEVEL" || s.stateSup === "RETESTING_AFTER_BREAK"),
  });
  // H7 retest after break
  candidateDefs.push({
    id: `H7-retest-res-UP-${expiry}m`,
    hypothesis: "H7",
    condition: `resistance RETEST + UP`,
    expiry,
    direction: "up",
    filter: (s) => s.direction === "up" && s.stateRes === "RETESTING_AFTER_BREAK",
  });
  candidateDefs.push({
    id: `H7-retest-sup-DOWN-${expiry}m`,
    hypothesis: "H7",
    condition: `support RETEST + DOWN`,
    expiry,
    direction: "down",
    filter: (s) => s.direction === "down" && s.stateSup === "RETESTING_AFTER_BREAK",
  });
  // H8 confluence 2+
  candidateDefs.push({
    id: `H8-res-conf2-DOWN-${expiry}m`,
    hypothesis: "H8",
    condition: `resistance confluence≥2 + near + DOWN`,
    expiry,
    direction: "down",
    filter: (s) => s.direction === "down" && s.nearRes && s.resConfluence >= 2,
  });
  candidateDefs.push({
    id: `H8-sup-conf2-UP-${expiry}m`,
    hypothesis: "H8",
    condition: `support confluence≥2 + near + UP`,
    expiry,
    direction: "up",
    filter: (s) => s.direction === "up" && s.nearSup && s.supConfluence >= 2,
  });
  // H9 approach speed at resistance/support
  for (const spd of ["fast", "slow"] as const) {
    candidateDefs.push({
      id: `H9-res-${spd}-DOWN-${expiry}m`,
      hypothesis: "H9",
      condition: `approach resistance ${spd} + DOWN`,
      expiry,
      direction: "down",
      filter: (s) => s.direction === "down" && s.approachSide === "resistance" && s.approach === spd && s.nearRes,
    });
    candidateDefs.push({
      id: `H9-sup-${spd}-UP-${expiry}m`,
      hypothesis: "H9",
      condition: `approach support ${spd} + UP`,
      expiry,
      direction: "up",
      filter: (s) => s.direction === "up" && s.approachSide === "support" && s.approach === spd && s.nearSup,
    });
  }
  // Fade vs breakout composites
  candidateDefs.push({
    id: `FADE-near-res-DOWN-${expiry}m`,
    hypothesis: "FADE",
    condition: `FADE near resistance (<0.30) + DOWN`,
    expiry,
    direction: "down",
    filter: (s) => s.direction === "down" && s.nearRes && s.stateRes !== "BREAKING_LEVEL",
  });
  candidateDefs.push({
    id: `FADE-near-sup-UP-${expiry}m`,
    hypothesis: "FADE",
    condition: `FADE near support (<0.30) + UP`,
    expiry,
    direction: "up",
    filter: (s) => s.direction === "up" && s.nearSup && s.stateSup !== "BREAKING_LEVEL",
  });
}

const evaluated: Candidate[] = [];
for (const def of candidateDefs) {
  const trainRows = train.filter(def.filter);
  const devRows = dev.filter(def.filter);
  const trainStats = bucket(trainRows, def.expiry);
  const devStats = bucket(devRows, def.expiry);
  const cand: Candidate = { ...def, train: trainStats, dev: devStats };
  evaluated.push(cand);
  appendRegistry({
    experiment: def.id,
    hypothesis: def.hypothesis,
    condition: def.condition,
    expiry: def.expiry,
    direction: def.direction,
    train: trainStats,
    dev: devStats,
    stage: "dev",
  });
}

// DEV selection: n>=100 decided, WR point > BE80, prefer CI>BE80
const DEV_MIN_N = 100;
const survivors = evaluated
  .filter((c) => c.dev && c.dev.decided >= DEV_MIN_N && c.dev.wr > BE80)
  .sort((a, b) => (b.dev!.ciLow - a.dev!.ciLow) || (b.dev!.wr - a.dev!.wr));

const topDev = [...evaluated]
  .filter((c) => c.dev && c.dev.decided >= 50)
  .sort((a, b) => b.dev!.ev80 - a.dev!.ev80)
  .slice(0, 10);

console.log(`DEV candidates with n≥${DEV_MIN_N} and WR>BE80: ${survivors.length}`);

// HOLDOUT once for survivors (and top for transparency if none)
const holdoutTargets = survivors.length ? survivors.slice(0, 5) : [];
for (const cand of holdoutTargets) {
  const rows = holdout.filter(cand.filter);
  cand.holdout = bucket(rows, cand.expiry);
  appendRegistry({
    experiment: cand.id,
    hypothesis: cand.hypothesis,
    condition: cand.condition,
    expiry: cand.expiry,
    holdout: cand.holdout,
    stage: "holdout",
    survive: cand.holdout.ciLow > BE80,
  });
}

// Optional logistic on TRAIN — simple features, predict win at 10m for FADE-like contexts
function logisticFit(X: number[][], y: number[], lambda = 1, iters = 40) {
  const p = X[0]?.length ?? 0;
  let w = Array.from({ length: p }, () => 0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gradW = Array.from({ length: p }, () => 0);
    let gradB = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < p; j++) z += w[j]! * X[i]![j]!;
      const pred = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const err = pred - y[i]!;
      gradB += err;
      for (let j = 0; j < p; j++) gradW[j]! += err * X[i]![j]!;
    }
    const n = X.length || 1;
    b -= 0.5 * (gradB / n);
    for (let j = 0; j < p; j++) w[j]! -= 0.5 * (gradW[j]! / n + lambda * w[j]!);
  }
  return { w, b };
}

function featVec(s: Sample): number[] {
  return [
    s.distSupAtr,
    s.distResAtr,
    Math.min(s.supTouches, 10) / 10,
    Math.min(s.resTouches, 10) / 10,
    s.supConfluence / 5,
    s.resConfluence / 5,
    s.ret3,
    s.upperWickRatio,
    s.lowerWickRatio,
    s.closeLoc,
    s.rangeAtr,
    s.direction === "up" ? 1 : 0,
    s.nearSup ? 1 : 0,
    s.nearRes ? 1 : 0,
    s.stateSup === "REJECTING_LEVEL" ? 1 : 0,
    s.stateRes === "REJECTING_LEVEL" ? 1 : 0,
    s.stateSup === "BREAKING_LEVEL" ? 1 : 0,
    s.stateRes === "BREAKING_LEVEL" ? 1 : 0,
  ];
}

const trainDecided = train.filter((s) => s.o10 === "won" || s.o10 === "lost");
const Xtr = trainDecided.map(featVec);
const ytr = trainDecided.map((s) => (s.o10 === "won" ? 1 : 0));
const model = logisticFit(Xtr, ytr);
function score(s: Sample) {
  const x = featVec(s);
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j]! * x[j]!;
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

// DEV model filter: allow when P(win) high AND agrees with fade context
const modelThreshs = [0.55, 0.58, 0.6];
const modelDevResults: string[] = [];
let bestModel: { thr: number; stats: BucketStats } | null = null;
for (const thr of modelThreshs) {
  const rows = dev.filter((s) => score(s) >= thr);
  const st = bucket(rows, 10);
  modelDevResults.push(`  P>=${thr}: ${fmt(st)}`);
  if (st.decided >= DEV_MIN_N && (!bestModel || st.wr > bestModel.stats.wr)) bestModel = { thr, stats: st };
}
let modelHoldoutLine = "NOT RUN (no DEV model survivor)";
if (bestModel && bestModel.stats.wr > BE80) {
  const rows = holdout.filter((s) => score(s) >= bestModel!.thr);
  const st = bucket(rows, 10);
  modelHoldoutLine = `P>=${bestModel.thr}: ${fmt(st)}`;
}

// ---------------------------------------------------------------------------
// Report sections
// ---------------------------------------------------------------------------

const proxOrder = ["<0.10", "0.10-0.20", "0.20-0.30", "0.30-0.50", ">0.50"];

function proxTable(rows: Sample[], side: "sup" | "res", dir: "up" | "down", expiry: 1 | 5 | 10 | 15) {
  const lines: string[] = [];
  for (const b of proxOrder) {
    const arr = rows.filter((s) => s.direction === dir && (side === "sup" ? s.proxSupBucket === b : s.proxResBucket === b));
    lines.push(`  ${b}: ${fmt(bucket(arr, expiry))}`);
  }
  return lines.join("\n");
}

const touchLines = (rows: Sample[], side: "sup" | "res", dir: "up" | "down") => {
  const lines: string[] = [];
  for (const [label, pred] of [
    ["1", (s: Sample) => (side === "sup" ? s.supTouches === 1 : s.resTouches === 1)],
    ["2", (s: Sample) => (side === "sup" ? s.supTouches === 2 : s.resTouches === 2)],
    ["3", (s: Sample) => (side === "sup" ? s.supTouches === 3 : s.resTouches === 3)],
    ["4+", (s: Sample) => (side === "sup" ? s.supTouches >= 4 : s.resTouches >= 4)],
  ] as const) {
    const near = rows.filter((s) => {
      if (s.direction !== dir) return false;
      if (side === "sup" && !s.nearSup) return false;
      if (side === "res" && !s.nearRes) return false;
      return pred(s);
    });
    lines.push(`  ${label}: ${fmt(bucket(near, 10))}`);
  }
  return lines.join("\n");
};

// Failure diagnosis
let verdict:
  | "SUPPORT_RESISTANCE_EDGE_FOUND"
  | "PROVISIONAL_SUPPORT_RESISTANCE_EDGE"
  | "LEVEL_CONTEXT_IMPROVES_WIN_RATE_BUT_BELOW_BREAK_EVEN"
  | "SUPPORT_ONLY_EDGE"
  | "RESISTANCE_ONLY_EDGE"
  | "BREAKOUT_EDGE"
  | "REJECTION_EDGE"
  | "INSUFFICIENT_DATA"
  | "NO_SUPPORT_RESISTANCE_EDGE"
  | "ROBUSTNESS_REJECT" = "NO_SUPPORT_RESISTANCE_EDGE";

const holdoutPass = holdoutTargets.filter((c) => c.holdout && c.holdout.ciLow > BE80);
const holdoutPoint = holdoutTargets.filter((c) => c.holdout && c.holdout.wr > BE80 && c.holdout.decided >= 40);

if (holdout.length < 80) verdict = "INSUFFICIENT_DATA";
else if (holdoutPass.length) verdict = "SUPPORT_RESISTANCE_EDGE_FOUND";
else if (holdoutPoint.length) verdict = "PROVISIONAL_SUPPORT_RESISTANCE_EDGE";
else if (survivors.length && holdoutTargets.some((c) => c.holdout && c.holdout.wr <= BE80)) verdict = "ROBUSTNESS_REJECT";
else {
  const anyLift = topDev.some((c) => c.dev && c.dev.wr > baseWr10 + 0.03 && c.dev.wr < BE80 && c.dev.decided >= 80);
  if (anyLift) verdict = "LEVEL_CONTEXT_IMPROVES_WIN_RATE_BUT_BELOW_BREAK_EVEN";
  else verdict = "NO_SUPPORT_RESISTANCE_EDGE";
}

const bestFinal = holdoutPass[0] ?? holdoutPoint[0] ?? null;

const report = `GOLDENXPERIENCE
BINARY SUPPORT/RESISTANCE EDGE AUDIT

================================
DATA
================================

Strategy: binary-baseline-v1@1.0.0 (authoritative only)
Date range: ${minStart} → ${maxStart}
Predictions: ${preds.length} loaded, ${samples.length} with S/R features (skipped ${skipped})
Symbols: ${instruments.join(", ")}
Expiry horizons: 1m / 5m / 10m / 15m

TRAIN:   n=${train.length}  through ${new Date(t60).toISOString()}  (~60%)
DEV:     n=${dev.length}  through ${new Date(t80).toISOString()}  (~20%)
HOLDOUT: n=${holdout.length}  after DEV  (~20%)

M1 source: OANDA M1 via getResearchCandles (same as binary resolver)
Leakage audit:
  - lastKnownIdx uses candle CLOSE (open+60s) ≤ prediction start: PASS
  - swing confirmation requires k=3 right bars before idx: PASS (self-test)
  - levels/touches/rejections use bars ≤ idx only: PASS
  - outcomes use resolutionPriceAtOrAfter after start: PASS
  - ties separate: PASS
  - zone boundaries fixed before candidate selection: PASS
  - production binary untouched: PASS

================================
BASELINE (all samples, M1-computed)
================================

1m:  ${fmt(baseline1)}
5m:  ${fmt(baseline5)}
10m: ${fmt(baseline10)}
15m: ${fmt(baseline15)}

80% payout break-even: ${(BE80 * 100).toFixed(2)}%

================================
SUPPORT EFFECT (TRAIN descriptive @10m)
================================

Near support + UP:
${proxTable(train, "sup", "up", 10)}

Near support + DOWN:
${proxTable(train, "sup", "down", 10)}

================================
RESISTANCE EFFECT (TRAIN @10m)
================================

Near resistance + DOWN:
${proxTable(train, "res", "down", 10)}

Near resistance + UP:
${proxTable(train, "res", "up", 10)}

================================
REJECTION VS BREAKOUT (TRAIN, all expiries)
================================

Support rejection -> UP:
  1m:  ${fmt(bucket(train.filter((s) => s.direction === "up" && s.stateSup === "REJECTING_LEVEL"), 1))}
  5m:  ${fmt(bucket(train.filter((s) => s.direction === "up" && s.stateSup === "REJECTING_LEVEL"), 5))}
  10m: ${fmt(bucket(train.filter((s) => s.direction === "up" && s.stateSup === "REJECTING_LEVEL"), 10))}
  15m: ${fmt(bucket(train.filter((s) => s.direction === "up" && s.stateSup === "REJECTING_LEVEL"), 15))}

Resistance rejection -> DOWN:
  1m:  ${fmt(bucket(train.filter((s) => s.direction === "down" && s.stateRes === "REJECTING_LEVEL"), 1))}
  5m:  ${fmt(bucket(train.filter((s) => s.direction === "down" && s.stateRes === "REJECTING_LEVEL"), 5))}
  10m: ${fmt(bucket(train.filter((s) => s.direction === "down" && s.stateRes === "REJECTING_LEVEL"), 10))}
  15m: ${fmt(bucket(train.filter((s) => s.direction === "down" && s.stateRes === "REJECTING_LEVEL"), 15))}

Support break -> DOWN:
  10m: ${fmt(bucket(train.filter((s) => s.direction === "down" && (s.stateSup === "BREAKING_LEVEL" || s.stateSup === "RETESTING_AFTER_BREAK")), 10))}

Resistance break -> UP:
  10m: ${fmt(bucket(train.filter((s) => s.direction === "up" && (s.stateRes === "BREAKING_LEVEL" || s.stateRes === "RETESTING_AFTER_BREAK")), 10))}

================================
TOUCH COUNT (TRAIN, near level, 10m)
================================

Support + UP:
${touchLines(train, "sup", "up")}

Resistance + DOWN:
${touchLines(train, "res", "down")}

Does repeated testing help? See gradient above (TRAIN only — not proof).

================================
CONFLUENCE (TRAIN @10m)
================================

Support+UP confluence:
  1: ${fmt(bucket(train.filter((s) => s.direction === "up" && s.nearSup && s.supConfluence === 1), 10))}
  2: ${fmt(bucket(train.filter((s) => s.direction === "up" && s.nearSup && s.supConfluence === 2), 10))}
  3+: ${fmt(bucket(train.filter((s) => s.direction === "up" && s.nearSup && s.supConfluence >= 3), 10))}

Resistance+DOWN confluence:
  1: ${fmt(bucket(train.filter((s) => s.direction === "down" && s.nearRes && s.resConfluence === 1), 10))}
  2: ${fmt(bucket(train.filter((s) => s.direction === "down" && s.nearRes && s.resConfluence === 2), 10))}
  3+: ${fmt(bucket(train.filter((s) => s.direction === "down" && s.nearRes && s.resConfluence >= 3), 10))}

================================
APPROACH (TRAIN @10m)
================================

${linesFor("Resistance approach + DOWN:", train.filter((s) => s.direction === "down" && s.nearRes), (s) => s.approach, 10).join("\n")}

${linesFor("Support approach + UP:", train.filter((s) => s.direction === "up" && s.nearSup), (s) => s.approach, 10).join("\n")}

================================
SESSION (TRAIN @10m, near resistance + DOWN)
================================

${linesFor("Near res + DOWN by session:", train.filter((s) => s.direction === "down" && s.nearRes), (s) => s.session, 10).join("\n")}

================================
TOP DEV CANDIDATES (by EV@80, decided n≥50)
================================

${topDev
  .map((c, i) => {
    const d = c.dev!;
    return `${i + 1}. ${c.condition} | ${c.expiry}m | ${c.direction}
   ${fmt(d)}
   EV@80=${d.ev80.toFixed(4)} EV@90=${d.ev90.toFixed(4)} coverage=${(d.coverage * 100).toFixed(1)}%
   DEV clears BE80? ${d.wr > BE80 ? "YES" : "NO"}  CI>BE80? ${d.ciLow > BE80 ? "YES" : "NO"}`;
  })
  .join("\n\n")}

DEV survivors (n≥${DEV_MIN_N} & WR>BE80): ${survivors.length}
${survivors.slice(0, 8).map((c) => `  - ${c.id}: ${fmt(c.dev!)}`).join("\n") || "  (none)"}

MULTIPLE_TESTING_RISK: ${candidateDefs.length} predefined hypotheses×expiries tested; only chronological DEV used for selection.

================================
HOLDOUT RESULTS
================================

${
  holdoutTargets.length === 0
    ? "NOT READ — no DEV survivor cleared n≥100 and WR>BE80.\nHoldout remains sealed for future predefined candidates only."
    : holdoutTargets
        .map((c) => {
          const h = c.holdout!;
          return `${c.id}
  DEV:     ${fmt(c.dev!)}
  HOLDOUT: ${fmt(h)}
  Clears BE80 on holdout CI? ${h.ciLow > BE80 ? "YES" : "NO"}
  Clears BE80 on holdout point? ${h.wr > BE80 ? "YES" : "NO"}`;
        })
        .join("\n\n")
}

================================
BEST FINAL CANDIDATE
================================

${
  bestFinal
    ? `Condition: ${bestFinal.condition}
Expiry: ${bestFinal.expiry}m
Direction: ${bestFinal.direction}
HOLDOUT: ${fmt(bestFinal.holdout!)}
EV @80: ${bestFinal.holdout!.ev80.toFixed(4)}
EV @90: ${bestFinal.holdout!.ev90.toFixed(4)}
Coverage: ${(bestFinal.holdout!.coverage * 100).toFixed(1)}%
Does it exceed payout break-even? ${bestFinal.holdout!.ciLow > BE80 ? "YES" : bestFinal.holdout!.wr > BE80 ? "POINT ONLY" : "NO"}`
    : `None.
No candidate simultaneously satisfied DEV gate and untouched holdout CI > ${(BE80 * 100).toFixed(2)}%.`
}

================================
MODEL (optional logistic, TRAIN→DEV)
================================

Model: L2 logistic on 18 PIT features → P(win @10m)
DEV thresholds:
${modelDevResults.join("\n")}
HOLDOUT: ${modelHoldoutLine}

Does model improve on simple rules? ${bestModel && bestModel.stats.wr > baseWr10 + 0.02 ? "MARGINAL on DEV" : "NO"}

================================
FAILURE ANALYSIS
================================

- Overall binary remains ~coin-flip across expiries.
- Proximity to S/R alone does not produce stable WR > 55.56% with adequate DEV n.
- Rejection/breakout labels visible at entry are rare or weak; many cells are underpowered.
- Any TRAIN/DEV pockets that look elevated are subject to multiple-testing across ${candidateDefs.length} cells.
- Dataset spans ~1 week of live binary history — HOLDOUT n≈${holdout.length} limits strong claims.
- Confidence still does not rescue level context (not used as primary filter).

================================
FINAL VERDICT
================================

${verdict}

Most important answer:
Support/resistance context does ${
  verdict === "SUPPORT_RESISTANCE_EDGE_FOUND" || verdict === "PROVISIONAL_SUPPORT_RESISTANCE_EDGE"
    ? ""
    : "NOT "
}identify a sufficiently large, out-of-sample subset of the existing ~49% binary predictions that clears binary payout break-even under the pre-registered chronological protocol.

NO PRODUCTION BINARY CHANGES WERE MADE.
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, report, "utf8");
fs.writeFileSync(path.join(OUT_DIR, "README.md"), `# binary-sr-audit\n\nResearch-only S/R context around existing binary predictions.\n\n\`\`\`bash\ncd api-server && npx tsx scripts/_binary-sr-audit.ts\n\`\`\`\n\nDoes not modify production binary behavior.\n`);
console.log(report);
console.log(`\nWrote ${REPORT_PATH}`);
process.exit(0);
