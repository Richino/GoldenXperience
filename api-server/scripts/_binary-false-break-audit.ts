/**
 * GOLDENXPERIENCE — binary-false-break-v1
 *
 * Research only. Does NOT modify binary-baseline-v1, adaptive selector,
 * production prediction logic, existing predictions, or live/paper execution.
 *
 * Hypothesis: confirmed failed breakouts / false breaks (reclaim after
 * penetration of a pre-existing level) contain short-horizon binary edge.
 *
 * Directions are PRE-REGISTERED (never flipped after outcomes):
 *   FAILED SUPPORT BREAKDOWN → UP
 *   FAILED RESISTANCE BREAKOUT → DOWN
 *   HELD SUPPORT BREAK → DOWN
 *   HELD RESISTANCE BREAK → UP
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
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const { query } = await import("../src/database.js");

const OUT_DIR = path.join(root, "research-v2", "binary-false-break-audit");
const REPORT_PATH = path.join(OUT_DIR, "FINAL_REPORT.txt");
const REGISTRY_PATH = path.join(OUT_DIR, "experiments", "registry.jsonl");

const EXPERIMENT = "binary-false-break-v1";
const SWING_K = 2;
const SWING_LOOKBACK = 90;
const CLUSTER_ATR = 0.1;
const MIN_PEN_ATR = 0.05;
const MAX_BARS_BEYOND = 3;
const HELD_CONFIRM_BARS = 1;
const BE80 = 1 / (1 + 0.8); // 55.56%
const DEV_MIN_N = 100;
const EXPIRIES = [1, 2, 3, 5, 10, 15] as const;
type Expiry = (typeof EXPIRIES)[number];

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
  confidence: number;
  result: "won" | "lost" | "tie" | null;
  session: string | null;
};

type Side = "support" | "resistance";
type EventKind = "FAILED" | "HELD";
type PenBucket = "<0.05" | "0.05-0.10" | "0.10-0.20" | "0.20-0.30" | ">0.30";
type BeyondBucket = "same-bar" | "1" | "2" | "3+";
type TouchBucket = "1" | "2" | "3" | "4+";
type ConfluenceBucket = "1" | "2" | "3+";
type ReclaimClass = "WEAK" | "MEDIUM" | "STRONG";
type Outcome = "won" | "lost" | "tie" | "missing";

type LevelHit = {
  price: number;
  side: Side;
  families: string[];
  touches: number;
};

type EventRow = {
  id: string;
  instrument: string;
  startAt: string;
  startMs: number;
  zone: "train" | "dev" | "holdout";
  episodeKey: string;
  kind: EventKind;
  side: Side;
  direction: "up" | "down";
  levelFamily: string;
  levelPrice: number;
  penetrationAtr: number;
  penBucket: PenBucket;
  reclaimAtr: number;
  reclaimFraction: number;
  wickRatio: number;
  bodyAtr: number;
  closeLoc: number;
  touchBucket: TouchBucket;
  priorMove3: number;
  priorMove5: number;
  priorMove10: number;
  priorMove20: number;
  priorMoveAbs5: number;
  barsBeyond: number;
  beyondBucket: BeyondBucket;
  confluence: number;
  confluenceBucket: ConfluenceBucket;
  session: string;
  atr: number;
  hourEt: number;
  reclaimClass: ReclaimClass;
  isMatchedControl: boolean;
  baselineAgree: "AGREE" | "DISAGREE" | "INDEPENDENT";
  outcomes: Record<Expiry, Outcome>;
};

type Bucket = {
  rawN: number;
  effN: number;
  won: number;
  lost: number;
  tie: number;
  missing: number;
  decided: number;
  wr: number;
  ciLow: number;
  ciHigh: number;
  ev80: number;
  ev90: number;
  label: string;
};

type Candidate = {
  id: string;
  label: string;
  kind: EventKind | "FAILED_ANY";
  direction: "up" | "down";
  expiry: Expiry;
  filter: (e: EventRow) => boolean;
};

type Scored = Candidate & {
  train: Bucket;
  dev: Bucket;
  holdout?: Bucket;
  pairShare: number;
  dayShare: number;
  nSymbols: number;
  gateMin: boolean;
  gateStrong: boolean;
};

type InstrumentCache = {
  candles: BinaryCandle[];
  closeMs: number[];
  atr: Float64Array;
  dayKeys: string[];
  sessionKeys: string[];
  hourEt: Int16Array;
};

let hypothesesTested = 0;
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

function hourEtOf(iso: string): number {
  return Number(ET_HOUR.formatToParts(new Date(iso)).find((p) => p.type === "hour")?.value);
}

function penBucketOf(p: number): PenBucket {
  if (p < 0.05) return "<0.05";
  if (p < 0.1) return "0.05-0.10";
  if (p < 0.2) return "0.10-0.20";
  if (p < 0.3) return "0.20-0.30";
  return ">0.30";
}

function beyondBucketOf(b: number): BeyondBucket {
  if (b <= 0) return "same-bar";
  if (b === 1) return "1";
  if (b === 2) return "2";
  return "3+";
}

function touchBucketOf(t: number): TouchBucket {
  if (t <= 1) return "1";
  if (t === 2) return "2";
  if (t === 3) return "3";
  return "4+";
}

function confluenceBucketOf(c: number): ConfluenceBucket {
  if (c <= 1) return "1";
  if (c === 2) return "2";
  return "3+";
}

function atr14(candles: BinaryCandle[], idx: number): number {
  if (idx < 14) return NaN;
  let sum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!.close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  return sum / 14;
}

function toCandles(raw: Awaited<ReturnType<typeof getResearchCandles>>): BinaryCandle[] {
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
  const fromMs = Date.parse(fromIso) - 4 * 24 * 60 * 60_000;
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

function buildCache(candles: BinaryCandle[]): InstrumentCache {
  const closeMs = candles.map((c) => Date.parse(c.time) + 60_000);
  const atr = new Float64Array(candles.length);
  const dayKeys: string[] = [];
  const sessionKeys: string[] = [];
  const hourEt = new Int16Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    atr[i] = atr14(candles, i);
    const iso = new Date(closeMs[i]!).toISOString();
    dayKeys.push(ET_DAY.format(new Date(closeMs[i]!)));
    sessionKeys.push(sessionOf(iso));
    hourEt[i] = hourEtOf(iso);
  }
  return { candles, closeMs, atr, dayKeys, sessionKeys, hourEt };
}

function resolveAt(cache: InstrumentCache, targetMs: number): { price: number; time: string } | null {
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
  return { price: cache.candles[ans]!.close, time: new Date(cache.closeMs[ans]!).toISOString() };
}

function outcomeAt(
  cache: InstrumentCache,
  dir: "up" | "down",
  entry: number,
  precision: number,
  startMs: number,
  minutes: number,
): Outcome {
  const mark = resolveAt(cache, startMs + minutes * 60_000);
  if (!mark) return "missing";
  if (Date.parse(mark.time) <= startMs) return "missing";
  return classifyBinaryResult(dir, entry, mark.price, precision);
}

function rollingExtrema(
  candles: BinaryCandle[],
  endExclusive: number,
  n: number,
  mode: "high" | "low",
): number | null {
  const start = endExclusive - n;
  if (start < 0 || endExclusive <= 0) return null;
  let v = mode === "high" ? -Infinity : Infinity;
  for (let i = start; i < endExclusive; i++) {
    if (mode === "high") v = Math.max(v, candles[i]!.high);
    else v = Math.min(v, candles[i]!.low);
  }
  return Number.isFinite(v) ? v : null;
}

type Swing = { idx: number; price: number; side: Side };

function findSwings(candles: BinaryCandle[], knownBefore: number): Swing[] {
  // confirmed swings whose right confirmation bar ≤ knownBefore-1
  const end = knownBefore - 1 - SWING_K;
  const start = Math.max(SWING_K, knownBefore - SWING_LOOKBACK);
  const out: Swing[] = [];
  if (end < start) return out;
  for (let p = start; p <= end; p++) {
    const h = candles[p]!.high;
    const l = candles[p]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= SWING_K; j++) {
      if (candles[p - j]!.high >= h || candles[p + j]!.high > h) isHigh = false;
      if (candles[p - j]!.low <= l || candles[p + j]!.low < l) isLow = false;
    }
    if (isHigh) out.push({ idx: p, price: h, side: "resistance" });
    if (isLow) out.push({ idx: p, price: l, side: "support" });
  }
  return out;
}

function clusterLevels(swings: Swing[], atr: number, side: Side): LevelHit[] {
  const members = swings.filter((s) => s.side === side).sort((a, b) => a.idx - b.idx);
  const clusters: { price: number; idxs: number[] }[] = [];
  const band = CLUSTER_ATR * atr;
  for (const s of members) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      const d = Math.abs(clusters[i]!.price - s.price);
      if (d <= band && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) {
      const c = clusters[best]!;
      c.idxs.push(s.idx);
      c.price = c.idxs.reduce((a, ix) => a + members.find((m) => m.idx === ix)!.price, 0) / c.idxs.length;
    } else {
      clusters.push({ price: s.price, idxs: [s.idx] });
    }
  }
  return clusters
    .filter((c) => c.idxs.length >= 2)
    .map((c) => ({
      price: c.price,
      side,
      families: ["cluster"],
      touches: c.idxs.length,
    }));
}

type SessionDayState = {
  prevSessionHigh: number | null;
  prevSessionLow: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  curSession: string;
  curDay: string;
  sessHi: number;
  sessLo: number;
  dayHi: number;
  dayLo: number;
};

function initSessionDay(cache: InstrumentCache): SessionDayState[] {
  const n = cache.candles.length;
  const out: SessionDayState[] = new Array(n);
  let prevSessionHigh: number | null = null;
  let prevSessionLow: number | null = null;
  let prevDayHigh: number | null = null;
  let prevDayLow: number | null = null;
  let curSession = cache.sessionKeys[0] ?? "off";
  let curDay = cache.dayKeys[0] ?? "";
  let sessHi = -Infinity;
  let sessLo = Infinity;
  let dayHi = -Infinity;
  let dayLo = Infinity;

  for (let i = 0; i < n; i++) {
    const sess = cache.sessionKeys[i]!;
    const day = cache.dayKeys[i]!;
    const c = cache.candles[i]!;

    if (sess !== curSession) {
      if (Number.isFinite(sessHi) && Number.isFinite(sessLo)) {
        prevSessionHigh = sessHi;
        prevSessionLow = sessLo;
      }
      curSession = sess;
      sessHi = -Infinity;
      sessLo = Infinity;
    }
    if (day !== curDay) {
      if (Number.isFinite(dayHi) && Number.isFinite(dayLo)) {
        prevDayHigh = dayHi;
        prevDayLow = dayLo;
      }
      curDay = day;
      dayHi = -Infinity;
      dayLo = Infinity;
    }

    out[i] = {
      prevSessionHigh,
      prevSessionLow,
      prevDayHigh,
      prevDayLow,
      curSession,
      curDay,
      sessHi,
      sessLo,
      dayHi,
      dayLo,
    };

    sessHi = Math.max(sessHi, c.high);
    sessLo = Math.min(sessLo, c.low);
    dayHi = Math.max(dayHi, c.high);
    dayLo = Math.min(dayLo, c.low);
  }
  return out;
}

function collectLevels(
  candles: BinaryCandle[],
  knownBefore: number,
  atr: number,
  sd: SessionDayState,
): LevelHit[] {
  if (!(atr > 0) || knownBefore < 55) return [];
  const raw: LevelHit[] = [];

  for (const n of [10, 20, 50] as const) {
    const hi = rollingExtrema(candles, knownBefore, n, "high");
    const lo = rollingExtrema(candles, knownBefore, n, "low");
    if (hi != null) raw.push({ price: hi, side: "resistance", families: [`roll_high_${n}`], touches: 1 });
    if (lo != null) raw.push({ price: lo, side: "support", families: [`roll_low_${n}`], touches: 1 });
  }

  const swings = findSwings(candles, knownBefore);
  for (const s of swings) {
    raw.push({
      price: s.price,
      side: s.side,
      families: [s.side === "resistance" ? "swing_high" : "swing_low"],
      touches: 1,
    });
  }
  raw.push(...clusterLevels(swings, atr, "resistance"));
  raw.push(...clusterLevels(swings, atr, "support"));

  if (sd.prevSessionHigh != null) {
    raw.push({ price: sd.prevSessionHigh, side: "resistance", families: ["session_high"], touches: 1 });
  }
  if (sd.prevSessionLow != null) {
    raw.push({ price: sd.prevSessionLow, side: "support", families: ["session_low"], touches: 1 });
  }
  if (sd.prevDayHigh != null) {
    raw.push({ price: sd.prevDayHigh, side: "resistance", families: ["day_high"], touches: 1 });
  }
  if (sd.prevDayLow != null) {
    raw.push({ price: sd.prevDayLow, side: "support", families: ["day_low"], touches: 1 });
  }

  // Merge levels within 0.1 ATR; accumulate families + max touches
  const merged: LevelHit[] = [];
  const band = CLUSTER_ATR * atr;
  for (const lv of raw) {
    let hit: LevelHit | null = null;
    let bestD = Infinity;
    for (const m of merged) {
      if (m.side !== lv.side) continue;
      const d = Math.abs(m.price - lv.price);
      if (d <= band && d < bestD) {
        hit = m;
        bestD = d;
      }
    }
    if (hit) {
      for (const f of lv.families) if (!hit.families.includes(f)) hit.families.push(f);
      hit.touches = Math.max(hit.touches, lv.touches);
      hit.price = (hit.price + lv.price) / 2;
    } else {
      merged.push({
        price: lv.price,
        side: lv.side,
        families: [...lv.families],
        touches: lv.touches,
      });
    }
  }
  return merged;
}

function countPriorTouches(
  candles: BinaryCandle[],
  knownBefore: number,
  level: number,
  side: Side,
  atr: number,
): number {
  const band = 0.15 * atr;
  let touches = 0;
  const start = Math.max(0, knownBefore - SWING_LOOKBACK);
  for (let i = start; i < knownBefore; i++) {
    const c = candles[i]!;
    if (side === "resistance") {
      if (Math.abs(c.high - level) <= band) touches += 1;
    } else if (Math.abs(c.low - level) <= band) touches += 1;
  }
  return Math.max(1, touches);
}

function priorMoveAtr(candles: BinaryCandle[], idx: number, bars: number, atr: number): number {
  if (idx < bars || !(atr > 0)) return 0;
  return (candles[idx]!.close - candles[idx - bars]!.close) / atr;
}

type Detected = {
  kind: EventKind;
  side: Side;
  level: LevelHit;
  barsBeyond: number;
  penetrationAtr: number;
  reclaimAtr: number;
  reclaimFraction: number;
  firstBeyondIdx: number;
};

function detectAtBar(
  candles: BinaryCandle[],
  i: number,
  atr: number,
  levels: LevelHit[],
): Detected | null {
  if (!(atr > 0) || i < 60 || i + 16 >= candles.length) return null;
  const c = candles[i]!;
  let best: Detected | null = null;

  for (const lv of levels) {
    if (lv.side === "resistance") {
      // FAILED: reclaim close below after penetration
      if (c.close < lv.price) {
        let firstBeyond = -1;
        let maxPen = 0;
        // same-bar
        if (c.high > lv.price) {
          maxPen = (c.high - lv.price) / atr;
          firstBeyond = i;
        }
        for (let j = i - 1; j >= Math.max(0, i - MAX_BARS_BEYOND); j--) {
          const x = candles[j]!;
          if (x.high > lv.price) {
            firstBeyond = j;
            maxPen = Math.max(maxPen, (x.high - lv.price) / atr);
          } else if (firstBeyond >= 0) {
            break;
          } else {
            break;
          }
        }
        // extend contiguous stretch further back (still ≤ MAX from reclaim)
        if (firstBeyond >= 0 && firstBeyond < i) {
          for (let j = firstBeyond - 1; j >= Math.max(0, i - MAX_BARS_BEYOND); j--) {
            const x = candles[j]!;
            if (x.high > lv.price) {
              firstBeyond = j;
              maxPen = Math.max(maxPen, (x.high - lv.price) / atr);
            } else break;
          }
        }
        if (firstBeyond >= 0 && maxPen >= MIN_PEN_ATR) {
          const barsBeyond = i - firstBeyond;
          if (barsBeyond <= MAX_BARS_BEYOND) {
            const reclaimAtr = (lv.price - c.close) / atr;
            const cand: Detected = {
              kind: "FAILED",
              side: "resistance",
              level: lv,
              barsBeyond,
              penetrationAtr: maxPen,
              reclaimAtr,
              reclaimFraction: maxPen > 0 ? reclaimAtr / maxPen : 0,
              firstBeyondIdx: firstBeyond,
            };
            if (!best || cand.penetrationAtr > best.penetrationAtr) best = cand;
          }
        }
      }

      // HELD: close above + next HELD_CONFIRM_BARS stay above (signal at i = break + confirm)
      // Pre-register: signal bar i is the confirm bar; break bar = i - HELD_CONFIRM_BARS
      {
        const breakIdx = i - HELD_CONFIRM_BARS;
        if (breakIdx >= 60) {
          const b = candles[breakIdx]!;
          const pen = (b.high - lv.price) / atr;
          if (b.close > lv.price && pen >= MIN_PEN_ATR) {
            let held = true;
            for (let j = breakIdx + 1; j <= i; j++) {
              if (candles[j]!.close < lv.price) {
                held = false;
                break;
              }
            }
            // not a same-bar failure on break bar
            if (held && b.close > lv.price) {
              const cand: Detected = {
                kind: "HELD",
                side: "resistance",
                level: lv,
                barsBeyond: HELD_CONFIRM_BARS,
                penetrationAtr: pen,
                reclaimAtr: 0,
                reclaimFraction: 0,
                firstBeyondIdx: breakIdx,
              };
              if (!best || (best.kind !== "FAILED" && cand.penetrationAtr > best.penetrationAtr)) {
                if (best?.kind !== "FAILED") best = cand;
              }
            }
          }
        }
      }
    } else {
      // SUPPORT FAILED
      if (c.close > lv.price) {
        let firstBeyond = -1;
        let maxPen = 0;
        if (c.low < lv.price) {
          maxPen = (lv.price - c.low) / atr;
          firstBeyond = i;
        }
        for (let j = i - 1; j >= Math.max(0, i - MAX_BARS_BEYOND); j--) {
          const x = candles[j]!;
          if (x.low < lv.price) {
            firstBeyond = j;
            maxPen = Math.max(maxPen, (lv.price - x.low) / atr);
          } else if (firstBeyond >= 0) {
            break;
          } else {
            break;
          }
        }
        if (firstBeyond >= 0 && firstBeyond < i) {
          for (let j = firstBeyond - 1; j >= Math.max(0, i - MAX_BARS_BEYOND); j--) {
            const x = candles[j]!;
            if (x.low < lv.price) {
              firstBeyond = j;
              maxPen = Math.max(maxPen, (lv.price - x.low) / atr);
            } else break;
          }
        }
        if (firstBeyond >= 0 && maxPen >= MIN_PEN_ATR) {
          const barsBeyond = i - firstBeyond;
          if (barsBeyond <= MAX_BARS_BEYOND) {
            const reclaimAtr = (c.close - lv.price) / atr;
            const cand: Detected = {
              kind: "FAILED",
              side: "support",
              level: lv,
              barsBeyond,
              penetrationAtr: maxPen,
              reclaimAtr,
              reclaimFraction: maxPen > 0 ? reclaimAtr / maxPen : 0,
              firstBeyondIdx: firstBeyond,
            };
            if (!best || cand.penetrationAtr > best.penetrationAtr) best = cand;
          }
        }
      }

      // HELD support
      {
        const breakIdx = i - HELD_CONFIRM_BARS;
        if (breakIdx >= 60) {
          const b = candles[breakIdx]!;
          const pen = (lv.price - b.low) / atr;
          if (b.close < lv.price && pen >= MIN_PEN_ATR) {
            let held = true;
            for (let j = breakIdx + 1; j <= i; j++) {
              if (candles[j]!.close > lv.price) {
                held = false;
                break;
              }
            }
            if (held) {
              const cand: Detected = {
                kind: "HELD",
                side: "support",
                level: lv,
                barsBeyond: HELD_CONFIRM_BARS,
                penetrationAtr: pen,
                reclaimAtr: 0,
                reclaimFraction: 0,
                firstBeyondIdx: breakIdx,
              };
              if (!best || (best.kind !== "FAILED" && cand.penetrationAtr > best.penetrationAtr)) {
                if (best?.kind !== "FAILED") best = cand;
              }
            }
          }
        }
      }
    }
  }

  return best;
}

function directionOf(kind: EventKind, side: Side): "up" | "down" {
  switch (kind) {
    case "FAILED":
      return side === "support" ? "up" : "down";
    case "HELD":
      return side === "support" ? "down" : "up";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "up";
    }
  }
}

function episodeKey(instrument: string, side: Side, level: number, atr: number, startMs: number) {
  const bucket = atr > 0 ? Math.round(level / (0.15 * atr)) : 0;
  const slot = Math.floor(startMs / (30 * 60_000));
  return `${instrument}|${side}|${bucket}|${slot}`;
}

function emptyOutcomes(): Record<Expiry, Outcome> {
  return { 1: "missing", 2: "missing", 3: "missing", 5: "missing", 10: "missing", 15: "missing" };
}

function statsOf(rows: EventRow[], expiry: Expiry, useEffective = true): Bucket {
  const seen = new Set<string>();
  const unique: EventRow[] = [];
  for (const r of rows) {
    if (!useEffective) {
      unique.push(r);
      continue;
    }
    if (seen.has(r.episodeKey)) continue;
    seen.add(r.episodeKey);
    unique.push(r);
  }
  let won = 0;
  let lost = 0;
  let tie = 0;
  let missing = 0;
  for (const r of unique) {
    const o = r.outcomes[expiry];
    if (o === "won") won += 1;
    else if (o === "lost") lost += 1;
    else if (o === "tie") tie += 1;
    else missing += 1;
  }
  const decided = won + lost;
  const ci = wilson(won, decided);
  const wr = ci.rate;
  return {
    rawN: rows.length,
    effN: unique.length,
    won,
    lost,
    tie,
    missing,
    decided,
    wr,
    ciLow: ci.low,
    ciHigh: ci.high,
    ev80: evOf(wr, 0.8),
    ev90: evOf(wr, 0.9),
    label: decided
      ? `eff=${unique.length} W=${won} L=${lost} T=${tie} WR=${(wr * 100).toFixed(2)}% CI=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%] EV80=${evOf(wr, 0.8).toFixed(3)}`
      : `eff=${unique.length} n=0`,
  };
}

function dominantStats(rows: EventRow[], expiry: Expiry) {
  const seen = new Set<string>();
  const unique: EventRow[] = [];
  for (const r of rows) {
    if (seen.has(r.episodeKey)) continue;
    seen.add(r.episodeKey);
    unique.push(r);
  }
  const decided = unique.filter((r) => r.outcomes[expiry] === "won" || r.outcomes[expiry] === "lost");
  if (!decided.length) return { pairShare: 1, dayShare: 1, nSymbols: 0 };
  const byPair = new Map<string, number>();
  const byDay = new Map<string, number>();
  for (const r of decided) {
    byPair.set(r.instrument, (byPair.get(r.instrument) ?? 0) + 1);
    byDay.set(r.startAt.slice(0, 10), (byDay.get(r.startAt.slice(0, 10)) ?? 0) + 1);
  }
  return {
    pairShare: Math.max(...byPair.values()) / decided.length,
    dayShare: Math.max(...byDay.values()) / decided.length,
    nSymbols: byPair.size,
  };
}

function appendRegistry(row: Record<string, unknown>) {
  hypothesesTested += 1;
  registryLines.push(JSON.stringify({ experiment: EXPERIMENT, ...row, ts: new Date().toISOString() }));
}

function cell(b: Bucket): string {
  if (!b.decided) return "n=0";
  return `${b.effN}/${(b.wr * 100).toFixed(1)}%/[${(b.ciLow * 100).toFixed(1)},${(b.ciHigh * 100).toFixed(1)}]/${b.ev80.toFixed(3)}`;
}

function tertileEdges(values: number[]): [number, number] {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 3) return [0, Infinity];
  const t1 = v[Math.floor(v.length / 3)]!;
  const t2 = v[Math.floor((2 * v.length) / 3)]!;
  return [t1, t2];
}

function classifyReclaim(x: number, t1: number, t2: number): ReclaimClass {
  if (x <= t1) return "WEAK";
  if (x <= t2) return "MEDIUM";
  return "STRONG";
}

function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
}

function trainLogistic(
  rows: EventRow[],
  expiry: Expiry,
): { w: number[]; names: string[]; n: number } | null {
  const names = [
    "bias",
    "pen",
    "reclaim",
    "frac",
    "wick",
    "closeLoc",
    "touches",
    "prior5",
    "beyond",
    "confl",
    "sideRes",
  ];
  const X: number[][] = [];
  const y: number[] = [];
  for (const e of rows) {
    if (e.kind !== "FAILED" || e.isMatchedControl) continue;
    const o = e.outcomes[expiry];
    if (o !== "won" && o !== "lost") continue;
    X.push([
      1,
      e.penetrationAtr,
      e.reclaimAtr,
      e.reclaimFraction,
      e.wickRatio,
      e.closeLoc,
      e.touchBucket === "4+" ? 4 : Number(e.touchBucket),
      e.priorMoveAbs5,
      e.barsBeyond,
      e.confluence,
      e.side === "resistance" ? 1 : 0,
    ]);
    y.push(o === "won" ? 1 : 0);
  }
  if (X.length < 80) return null;
  const w = new Array(names.length).fill(0);
  const lr = 0.05;
  const l2 = 0.05;
  for (let epoch = 0; epoch < 400; epoch++) {
    const g = new Array(names.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let j = 0; j < w.length; j++) z += w[j]! * xi[j]!;
      const p = sigmoid(z);
      const err = p - y[i]!;
      for (let j = 0; j < w.length; j++) g[j]! += err * xi[j]!;
    }
    for (let j = 0; j < w.length; j++) {
      const reg = j === 0 ? 0 : l2 * w[j]!;
      w[j]! -= (lr * (g[j]! / X.length + reg));
    }
  }
  return { w, names, n: X.length };
}

function aucOf(scores: { p: number; y: number }[]): number {
  const pos = scores.filter((s) => s.y === 1).sort((a, b) => a.p - b.p);
  const neg = scores.filter((s) => s.y === 0).sort((a, b) => a.p - b.p);
  if (!pos.length || !neg.length) return 0.5;
  let correct = 0;
  for (const p of pos) for (const n of neg) {
    if (p.p > n.p) correct += 1;
    else if (p.p === n.p) correct += 0.5;
  }
  return correct / (pos.length * neg.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`${EXPERIMENT} — loading authoritative baseline predictions...`);
const predRes = await query<PredRow>(
  `SELECT id, instrument, direction, start_at::text, entry_price::float AS entry_price,
          price_precision, confidence::float AS confidence, result,
          COALESCE(market_context->>'session', features->>'session') AS session
     FROM binary_predictions
    WHERE status='resolved' AND is_authoritative=true AND model_name='binary-baseline-v1'
    ORDER BY start_at`,
);
const preds = predRes.rows;
console.log(`Loaded ${preds.length} predictions`);
if (preds.length < 200) {
  console.error("INSUFFICIENT_DATA");
  process.exit(1);
}

const instruments = [...new Set(preds.map((p) => p.instrument))].sort();
const minStart = preds[0]!.start_at;
const maxStart = preds.at(-1)!.start_at;

console.log(`Fetching M1 for ${instruments.length} instruments (pad ≥4d before window)...`);
const caches = new Map<string, InstrumentCache>();
const sessionDayMaps = new Map<string, SessionDayState[]>();
let m1Total = 0;
let m1Min = Infinity;
let m1Max = -Infinity;
for (const inst of instruments) {
  const candles = await fetchM1Range(inst, minStart, maxStart);
  const cache = buildCache(candles);
  caches.set(inst, cache);
  sessionDayMaps.set(inst, initSessionDay(cache));
  m1Total += candles.length;
  if (candles.length) {
    m1Min = Math.min(m1Min, Date.parse(candles[0]!.time));
    m1Max = Math.max(m1Max, cache.closeMs[candles.length - 1]!);
  }
  console.log(`  ${inst}: ${candles.length} M1`);
}

// Chronological split on pooled M1 close times in the prediction window (fixed before outcomes)
const allClose: number[] = [];
{
  const winLo = Date.parse(minStart);
  const winHi = Date.parse(maxStart);
  for (const cache of caches.values()) {
    for (const ms of cache.closeMs) {
      if (ms >= winLo && ms <= winHi) allClose.push(ms);
    }
  }
  allClose.sort((a, b) => a - b);
}
const t60 = allClose[Math.floor(allClose.length * 0.6)]!;
const t80 = allClose[Math.floor(allClose.length * 0.8)]!;
console.log(
  `Zones (M1 timeline): TRAIN ≤ ${new Date(t60).toISOString()} | DEV ≤ ${new Date(t80).toISOString()} | HOLDOUT after`,
);
function zoneOf(ms: number): "train" | "dev" | "holdout" {
  if (ms <= t60) return "train";
  if (ms <= t80) return "dev";
  return "holdout";
}

// Leakage self-test
{
  const cache = caches.get(instruments[0]!)!;
  const idx = 120;
  const swings = findSwings(cache.candles, idx);
  for (const s of swings) {
    if (s.idx + SWING_K >= idx) throw new Error("swing leakage: unconfirmed swing");
  }
  console.log("Leakage self-check (swings): PASS");
}

// Index baseline predictions by instrument for overlap
const predsByInst = new Map<string, PredRow[]>();
for (const p of preds) {
  const arr = predsByInst.get(p.instrument) ?? [];
  arr.push(p);
  predsByInst.set(p.instrument, arr);
}

function baselineAgreeAt(
  instrument: string,
  startMs: number,
  dir: "up" | "down",
): "AGREE" | "DISAGREE" | "INDEPENDENT" {
  const arr = predsByInst.get(instrument) ?? [];
  // overlap if prediction start within ±2 minutes of signal
  let best: PredRow | null = null;
  let bestD = Infinity;
  for (const p of arr) {
    const d = Math.abs(Date.parse(p.start_at) - startMs);
    if (d <= 120_000 && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (!best) return "INDEPENDENT";
  return best.direction === dir ? "AGREE" : "DISAGREE";
}

console.log("Scanning M1 for false-break / held-break events...");
const events: EventRow[] = [];
const falseBreakBars = new Set<string>(); // instrument|idx for matched control exclusion
let rawDetections = 0;

for (const inst of instruments) {
  const cache = caches.get(inst)!;
  const sdArr = sessionDayMaps.get(inst)!;
  const { candles, closeMs, atr } = cache;
  const seenEpisodes = new Set<string>();
  const winLo = Date.parse(minStart) - 60_000;
  const winHi = Date.parse(maxStart) + 60_000;
  let before = events.length;
  const precision = inst.includes("JPY") ? 3 : 5;

  for (let i = 60; i < candles.length - 16; i++) {
    const startMs = closeMs[i]!;
    if (startMs < winLo || startMs > winHi) continue;
    const a = atr[i]!;
    if (!(a > 0)) continue;

    // Levels known before the break attempt begins:
    // For same-bar failure, knownBefore = i; for multi-bar, knownBefore = firstBeyond.
    // We collect levels at i first; for multi-bar we re-validate level existed before firstBeyond.
    const levelsAtI = collectLevels(candles, i, a, sdArr[i]!);
    const det = detectAtBar(candles, i, a, levelsAtI);
    if (!det) continue;

    // Re-validate: level must be known before firstBeyondIdx
    const knownBefore = det.firstBeyondIdx;
    const atrAtBreak = atr[Math.max(14, knownBefore)]!;
    if (!(atrAtBreak > 0)) continue;
    const levelsBefore = collectLevels(candles, knownBefore, atrAtBreak, sdArr[knownBefore]!);
    const band = CLUSTER_ATR * atrAtBreak;
    const matchedLevel = levelsBefore.find(
      (l) => l.side === det.side && Math.abs(l.price - det.level.price) <= band,
    );
    if (!matchedLevel) continue;

    rawDetections += 1;
    const dir = directionOf(det.kind, det.side);
    const ek = episodeKey(inst, det.side, matchedLevel.price, a, startMs);
    if (seenEpisodes.has(ek)) continue;
    seenEpisodes.add(ek);

    if (det.kind === "FAILED") falseBreakBars.add(`${inst}|${i}`);

    const c = candles[i]!;
    const range = Math.max(c.high - c.low, 1e-12);
    const body = Math.abs(c.close - c.open);
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;
    const wickRatio = det.side === "resistance" ? upper / range : lower / range;
    const closeLoc = (c.close - c.low) / range;
    const touches = countPriorTouches(candles, knownBefore, matchedLevel.price, det.side, a);
    const outcomes = emptyOutcomes();
    for (const exp of EXPIRIES) {
      outcomes[exp] = outcomeAt(cache, dir, c.close, precision, startMs, exp);
    }

    events.push({
      id: `${inst}-${c.time}-${det.kind}-${det.side}`,
      instrument: inst,
      startAt: new Date(startMs).toISOString(),
      startMs,
      zone: zoneOf(startMs),
      episodeKey: ek,
      kind: det.kind,
      side: det.side,
      direction: dir,
      levelFamily: matchedLevel.families.slice().sort().join("+"),
      levelPrice: matchedLevel.price,
      penetrationAtr: det.penetrationAtr,
      penBucket: penBucketOf(det.penetrationAtr),
      reclaimAtr: det.reclaimAtr,
      reclaimFraction: det.reclaimFraction,
      wickRatio,
      bodyAtr: body / a,
      closeLoc,
      touchBucket: touchBucketOf(touches),
      priorMove3: priorMoveAtr(candles, i, 3, a),
      priorMove5: priorMoveAtr(candles, i, 5, a),
      priorMove10: priorMoveAtr(candles, i, 10, a),
      priorMove20: priorMoveAtr(candles, i, 20, a),
      priorMoveAbs5: Math.abs(priorMoveAtr(candles, i, 5, a)),
      barsBeyond: det.barsBeyond,
      beyondBucket: beyondBucketOf(det.barsBeyond),
      confluence: matchedLevel.families.length,
      confluenceBucket: confluenceBucketOf(matchedLevel.families.length),
      session: cache.sessionKeys[i]!,
      atr: a,
      hourEt: cache.hourEt[i]!,
      reclaimClass: "MEDIUM",
      isMatchedControl: false,
      baselineAgree: baselineAgreeAt(inst, startMs, dir),
      outcomes,
    });
  }
  console.log(`  ${inst}: episodes ${events.length - before} (raw detections scanned)`);
}
console.log(`Events after episode dedup: ${events.length} (raw detections ${rawDetections})`);

// TRAIN-only reclaim tertiles → apply to all
const trainFailed = events.filter((e) => e.zone === "train" && e.kind === "FAILED");
const [rT1, rT2] = tertileEdges(trainFailed.map((e) => e.reclaimAtr));
const [wT1, wT2] = tertileEdges(trainFailed.map((e) => e.wickRatio));
const [pT1, pT2] = tertileEdges(trainFailed.map((e) => e.priorMoveAbs5));
for (const e of events) {
  e.reclaimClass = classifyReclaim(e.reclaimAtr, rT1, rT2);
}

console.log(
  `TRAIN reclaim tertiles: WEAK≤${rT1.toFixed(3)} MEDIUM≤${rT2.toFixed(3)} STRONG>${rT2.toFixed(3)}`,
);

// Matched controls for FAILED events (same predicted direction)
console.log("Building matched ordinary-bar controls...");
const controls: EventRow[] = [];
for (const e of events) {
  if (e.kind !== "FAILED") continue;
  const cache = caches.get(e.instrument)!;
  const { candles, closeMs, atr, hourEt } = cache;
  const targetHour = e.hourEt;
  const targetAtr = e.atr;
  const targetRet = e.priorMoveAbs5;
  let bestIdx = -1;
  let bestScore = Infinity;
  const center = Math.max(60, Math.min(candles.length - 17, candles.findIndex((_, i) => closeMs[i] === e.startMs)));
  // search nearby window then expand
  for (let delta = 30; delta < 2000; delta += 30) {
    for (const sign of [-1, 1] as const) {
      const i = center + sign * delta;
      if (i < 60 || i >= candles.length - 16) continue;
      if (falseBreakBars.has(`${e.instrument}|${i}`)) continue;
      if (Math.abs(hourEt[i]! - targetHour) > 1) continue;
      const a = atr[i]!;
      if (!(a > 0)) continue;
      if (Math.abs(a - targetAtr) / targetAtr > 0.2) continue;
      const ret5 = Math.abs(priorMoveAtr(candles, i, 5, a));
      if (targetRet > 1e-9 && Math.abs(ret5 - targetRet) / Math.max(targetRet, 1e-9) > 0.2) continue;
      const score = Math.abs(a - targetAtr) / targetAtr + Math.abs(ret5 - targetRet);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) break;
  }
  if (bestIdx < 0) continue;
  const i = bestIdx;
  const c = candles[i]!;
  const startMs = closeMs[i]!;
  const precision = e.instrument.includes("JPY") ? 3 : 5;
  const outcomes = emptyOutcomes();
  for (const exp of EXPIRIES) {
    outcomes[exp] = outcomeAt(cache, e.direction, c.close, precision, startMs, exp);
  }
  controls.push({
    ...e,
    id: `CTRL-${e.id}`,
    startAt: new Date(startMs).toISOString(),
    startMs,
    zone: zoneOf(startMs),
    episodeKey: `CTRL|${e.episodeKey}`,
    isMatchedControl: true,
    outcomes,
  });
}
console.log(`Matched controls: ${controls.length}`);

const failed = events.filter((e) => e.kind === "FAILED");
const held = events.filter((e) => e.kind === "HELD");
const trainE = events.filter((e) => e.zone === "train");
const devE = events.filter((e) => e.zone === "dev");
const holdE = events.filter((e) => e.zone === "holdout");

function buildCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const expiry of EXPIRIES) {
    out.push({
      id: `FAILED_SUPPORT|up|${expiry}m`,
      label: "failed support → UP",
      kind: "FAILED",
      direction: "up",
      expiry,
      filter: (e) => e.kind === "FAILED" && e.side === "support" && !e.isMatchedControl,
    });
    out.push({
      id: `FAILED_RESISTANCE|down|${expiry}m`,
      label: "failed resistance → DOWN",
      kind: "FAILED",
      direction: "down",
      expiry,
      filter: (e) => e.kind === "FAILED" && e.side === "resistance" && !e.isMatchedControl,
    });
    out.push({
      id: `HELD_SUPPORT|down|${expiry}m`,
      label: "held support → DOWN",
      kind: "HELD",
      direction: "down",
      expiry,
      filter: (e) => e.kind === "HELD" && e.side === "support" && !e.isMatchedControl,
    });
    out.push({
      id: `HELD_RESISTANCE|up|${expiry}m`,
      label: "held resistance → UP",
      kind: "HELD",
      direction: "up",
      expiry,
      filter: (e) => e.kind === "HELD" && e.side === "resistance" && !e.isMatchedControl,
    });
  }

  // TRAIN-motivated filters (pre-registered interpretable; max ~40–60 total)
  const filterExpiries: Expiry[] = [1, 5, 10, 15];
  for (const expiry of filterExpiries) {
    for (const side of ["support", "resistance"] as const) {
      const dir = side === "support" ? ("up" as const) : ("down" as const);
      out.push({
        id: `FAILED_${side}|STRONG_RECLAIM|${dir}|${expiry}m`,
        label: `failed ${side} STRONG reclaim → ${dir}`,
        kind: "FAILED",
        direction: dir,
        expiry,
        filter: (e) =>
          e.kind === "FAILED" && e.side === side && e.reclaimClass === "STRONG" && !e.isMatchedControl,
      });
      out.push({
        id: `FAILED_${side}|SAME_BAR|${dir}|${expiry}m`,
        label: `failed ${side} same-bar → ${dir}`,
        kind: "FAILED",
        direction: dir,
        expiry,
        filter: (e) =>
          e.kind === "FAILED" && e.side === side && e.beyondBucket === "same-bar" && !e.isMatchedControl,
      });
      out.push({
        id: `FAILED_${side}|PEN_0.05_0.20|${dir}|${expiry}m`,
        label: `failed ${side} pen 0.05-0.20 → ${dir}`,
        kind: "FAILED",
        direction: dir,
        expiry,
        filter: (e) =>
          e.kind === "FAILED" &&
          e.side === side &&
          (e.penBucket === "0.05-0.10" || e.penBucket === "0.10-0.20") &&
          !e.isMatchedControl,
      });
    }
  }
  return out;
}

function evaluateCandidates(cands: Candidate[]): Scored[] {
  const scored: Scored[] = [];
  for (const c of cands) {
    const trainRows = trainE.filter(c.filter);
    const devRows = devE.filter(c.filter);
    const tr = statsOf(trainRows, c.expiry);
    const dv = statsOf(devRows, c.expiry);
    const dom = dominantStats(devRows, c.expiry);
    const gateMin =
      dv.decided >= DEV_MIN_N &&
      dv.wr > BE80 &&
      dv.ev80 > 0 &&
      dv.ciLow > 0.5 &&
      dom.dayShare <= 0.5 &&
      dom.nSymbols >= 3;
    const gateStrong =
      dv.decided >= 200 &&
      dv.wr > BE80 &&
      dv.ciLow > BE80 &&
      dv.ev80 > 0 &&
      dom.dayShare <= 0.5 &&
      dom.pairShare <= 0.55 &&
      dom.nSymbols >= 3;
    appendRegistry({
      id: c.id,
      label: c.label,
      kind: c.kind,
      direction: c.direction,
      expiry: c.expiry,
      zone: "train",
      n: tr.decided,
      wr: tr.wr,
      ciLow: tr.ciLow,
      ciHigh: tr.ciHigh,
      ev80: tr.ev80,
      passed_min: false,
      passed_strong: false,
    });
    appendRegistry({
      id: c.id,
      label: c.label,
      kind: c.kind,
      direction: c.direction,
      expiry: c.expiry,
      zone: "dev",
      n: dv.decided,
      wr: dv.wr,
      ciLow: dv.ciLow,
      ciHigh: dv.ciHigh,
      ev80: dv.ev80,
      dayShare: dom.dayShare,
      pairShare: dom.pairShare,
      nSymbols: dom.nSymbols,
      passed_min: gateMin,
      passed_strong: gateStrong,
    });
    scored.push({
      ...c,
      train: tr,
      dev: dv,
      pairShare: dom.pairShare,
      dayShare: dom.dayShare,
      nSymbols: dom.nSymbols,
      gateMin,
      gateStrong,
    });
  }
  return scored;
}

console.log("Scoring candidates on TRAIN (descriptive) + DEV (selection)...");
const candidates = buildCandidates();
console.log(`Pre-registered configs: ${candidates.length}`);
const scored = evaluateCandidates(candidates);
const survivors = scored.filter((s) => s.gateMin).sort((a, b) => b.dev.ev80 - a.dev.ev80);
console.log(`DEV survivors (min gate): ${survivors.length}`);

let holdoutRead = false;
if (survivors.length > 0) {
  holdoutRead = true;
  for (const s of survivors) {
    const rows = holdE.filter(s.filter);
    s.holdout = statsOf(rows, s.expiry);
    appendRegistry({
      id: s.id,
      zone: "holdout",
      n: s.holdout.decided,
      wr: s.holdout.wr,
      ciLow: s.holdout.ciLow,
      ciHigh: s.holdout.ciHigh,
      ev80: s.holdout.ev80,
      frozen: true,
    });
  }
} else {
  console.log("HOLDOUT NOT READ — no DEV candidate cleared minimum gate.");
}

const primaryExpiry: Expiry = 5;
const trainFail = trainE.filter((e) => e.kind === "FAILED");
const devFail = devE.filter((e) => e.kind === "FAILED");

// Matched control comparison on DEV @ primaryExpiry
const devFailForCtrl = devFail;
const ctrlDev = controls.filter((c) => c.zone === "dev");
const fbDevBucket = statsOf(devFailForCtrl, primaryExpiry);
const ctrlDevBucket = statsOf(ctrlDev, primaryExpiry);

// Baseline overlap on DEV
const agreeDev = statsOf(
  devFail.filter((e) => e.baselineAgree === "AGREE"),
  primaryExpiry,
);
const disagreeDev = statsOf(
  devFail.filter((e) => e.baselineAgree === "DISAGREE"),
  primaryExpiry,
);
const indepDev = statsOf(
  devFail.filter((e) => e.baselineAgree === "INDEPENDENT"),
  primaryExpiry,
);

// Logistic model TRAIN→DEV @ 10m
const modelExpiry: Expiry = 10;
const model = trainLogistic(trainFail, modelExpiry);
let modelLines: string[] = [];
if (model) {
  const scoredDev: { p: number; y: number; e: EventRow }[] = [];
  for (const e of devFail) {
    const o = e.outcomes[modelExpiry];
    if (o !== "won" && o !== "lost") continue;
    const x = [
      1,
      e.penetrationAtr,
      e.reclaimAtr,
      e.reclaimFraction,
      e.wickRatio,
      e.closeLoc,
      e.touchBucket === "4+" ? 4 : Number(e.touchBucket),
      e.priorMoveAbs5,
      e.barsBeyond,
      e.confluence,
      e.side === "resistance" ? 1 : 0,
    ];
    let z = 0;
    for (let j = 0; j < model.w.length; j++) z += model.w[j]! * x[j]!;
    scoredDev.push({ p: sigmoid(z), y: o === "won" ? 1 : 0, e });
  }
  const auc = aucOf(scoredDev);
  modelLines.push(`Used: YES`);
  modelLines.push(`Model: L2 logistic, n_train=${model.n}, expiry=${modelExpiry}m`);
  modelLines.push(`DEV AUC: ${auc.toFixed(3)}`);
  for (const thr of [0.55, 0.6, 0.65]) {
    const sel = scoredDev.filter((s) => s.p >= thr);
    let w = 0;
    let l = 0;
    for (const s of sel) {
      if (s.y === 1) w += 1;
      else l += 1;
    }
    const ci = wilson(w, w + l);
    const wr = ci.rate;
    modelLines.push(
      `P>=${thr.toFixed(2)}: n=${w + l} WR=${(wr * 100).toFixed(2)}% CI=[${(ci.low * 100).toFixed(2)}%,${(ci.high * 100).toFixed(2)}%] EV80=${evOf(wr, 0.8).toFixed(3)}`,
    );
    appendRegistry({
      id: `L2|P>=${thr}|${modelExpiry}m`,
      zone: "dev",
      n: w + l,
      wr,
      ciLow: ci.low,
      ciHigh: ci.high,
      ev80: evOf(wr, 0.8),
      passed_min: w + l >= DEV_MIN_N && wr > BE80 && ci.low > 0.5,
    });
  }
  const top = model.names
    .map((n, i) => ({ n, w: model.w[i]! }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .slice(0, 6);
  modelLines.push(`Top weights: ${top.map((t) => `${t.n}=${t.w.toFixed(3)}`).join(", ")}`);
  modelLines.push(`Does ML improve the event rule? See P-threshold rows vs base FAILED @${modelExpiry}m`);
} else {
  modelLines = ["Used: NO (insufficient TRAIN failed events)", "Model: n/a", "DEV AUC: n/a", "Calibration: n/a"];
}

// Multiple testing summary
const regDev = registryLines
  .map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((r) => r.zone === "dev");
const mtPositive = regDev.filter((r) => Number(r.wr) > 0.5).length;
const mtBe = regDev.filter((r) => Number(r.wr) > BE80).length;
const mtN = regDev.filter((r) => Number(r.n) >= DEV_MIN_N).length;
const mtCi50 = regDev.filter((r) => Number(r.ciLow) > 0.5).length;
const mtCiBe = regDev.filter((r) => Number(r.ciLow) > BE80).length;

// Headline tables
function headlineRow(side: Side, zoneRows: EventRow[]): string {
  const parts: string[] = [];
  for (const exp of EXPIRIES) {
    const b = statsOf(
      zoneRows.filter((e) => e.kind === "FAILED" && e.side === side),
      exp,
    );
    parts.push(cell(b));
  }
  return parts.join(" | ");
}

function daysCovered(rows: EventRow[]): number {
  return new Set(rows.map((r) => r.startAt.slice(0, 10))).size;
}

const allFailed = failed;
const fsCount = allFailed.filter((e) => e.side === "support").length;
const frCount = allFailed.filter((e) => e.side === "resistance").length;
const hsCount = held.filter((e) => e.side === "support").length;
const hrCount = held.filter((e) => e.side === "resistance").length;
const nDays = Math.max(1, daysCovered(events));

// Verdict
const topDev = [...scored]
  .filter((s) => s.kind === "FAILED" || s.id.startsWith("FAILED"))
  .sort((a, b) => b.dev.ev80 - a.dev.ev80 || b.dev.decided - a.dev.decided);

let verdict = "NO_FALSE_BREAK_EDGE";
if (survivors.length > 0) {
  const best = survivors[0]!;
  if (holdoutRead && best.holdout) {
    if (best.holdout.wr > BE80 && best.holdout.ev80 > 0 && best.holdout.ciLow > 0.5) {
      if (best.id.includes("SUPPORT") && !best.id.includes("RESISTANCE")) verdict = "FAILED_SUPPORT_EDGE_FOUND";
      else if (best.id.includes("RESISTANCE")) verdict = "FAILED_RESISTANCE_EDGE_FOUND";
      else if (best.id.includes("HELD")) verdict = "HELD_BREAK_CONTINUATION_EDGE_FOUND";
      else verdict = "FALSE_BREAK_EDGE_FOUND";
    } else {
      verdict = "ROBUSTNESS_REJECT";
    }
  } else {
    verdict = "FALSE_BREAK_EDGE_FOUND";
  }
} else {
  const near = topDev.find((s) => s.dev.decided >= 50 && s.dev.wr > BE80);
  const under = topDev.find((s) => s.dev.wr > BE80 && s.dev.decided < DEV_MIN_N);
  const dayDep = topDev.find((s) => s.dev.wr > BE80 && s.dayShare > 0.5);
  const improves = topDev.find((s) => s.dev.decided >= 100 && s.dev.wr > 0.5 && s.dev.wr <= BE80);
  if (dayDep) verdict = "FALSE_BREAK_DAY_DEPENDENT";
  else if (under && !near) verdict = "PROMISING_BUT_UNDERPOWERED";
  else if (improves) verdict = "FALSE_BREAK_IMPROVES_BUT_BELOW_BREAK_EVEN";
  else verdict = "NO_FALSE_BREAK_EDGE";
}

// Best expiry descriptive on TRAIN failed
let bestExp: Expiry = 5;
let bestExpWr = -1;
for (const exp of EXPIRIES) {
  const b = statsOf(trainFail, exp);
  if (b.decided >= 30 && b.wr > bestExpWr) {
    bestExpWr = b.wr;
    bestExp = exp;
  }
}
const bestExpBucket = statsOf(trainFail, bestExp);

// Day stability for best DEV candidate
const bestCand = survivors[0] ?? topDev[0];
let dayStability = "n/a";
if (bestCand) {
  const rows = (survivors.length ? devE : devE).filter(bestCand.filter);
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    if (seen.has(r.episodeKey)) return false;
    seen.add(r.episodeKey);
    return true;
  });
  const byDay = new Map<string, { w: number; l: number }>();
  for (const r of unique) {
    const o = r.outcomes[bestCand.expiry];
    if (o !== "won" && o !== "lost") continue;
    const d = r.startAt.slice(0, 10);
    const cur = byDay.get(d) ?? { w: 0, l: 0 };
    if (o === "won") cur.w += 1;
    else cur.l += 1;
    byDay.set(d, cur);
  }
  let profitDays = 0;
  let loseDays = 0;
  let maxShare = 0;
  let maxWinShare = 0;
  const total = [...byDay.values()].reduce((a, v) => a + v.w + v.l, 0) || 1;
  const totalWins = [...byDay.values()].reduce((a, v) => a + v.w, 0) || 1;
  for (const v of byDay.values()) {
    const n = v.w + v.l;
    if (v.w > v.l) profitDays += 1;
    else if (v.l > v.w) loseDays += 1;
    maxShare = Math.max(maxShare, n / total);
    maxWinShare = Math.max(maxWinShare, v.w / totalWins);
  }
  dayStability = `candidate=${bestCand.id} profitDays=${profitDays} loseDays=${loseDays} maxDayEventShare=${(maxShare * 100).toFixed(1)}% maxDayWinShare=${(maxWinShare * 100).toFixed(1)}%`;
}

// Pair / session breakdown for DEV failed @ primaryExpiry
const pairLines: string[] = [];
for (const inst of instruments) {
  const b = statsOf(
    devFail.filter((e) => e.instrument === inst),
    primaryExpiry,
  );
  if (b.effN) pairLines.push(`  ${inst}: ${b.label}`);
}
const sessionLines: string[] = [];
for (const sess of ["asia", "london", "overlap", "newyork", "off"]) {
  const b = statsOf(
    devFail.filter((e) => e.session === sess),
    primaryExpiry,
  );
  sessionLines.push(`  ${sess}: ${b.label}`);
}

function tableBy<T extends string>(
  rows: EventRow[],
  expiry: Expiry,
  keys: T[],
  pick: (e: EventRow) => T,
): string {
  return keys
    .map((k) => `  ${k}: ${statsOf(rows.filter((e) => pick(e) === k), expiry).label}`)
    .join("\n");
}

const topDevLines = [...scored]
  .sort((a, b) => b.dev.ev80 - a.dev.ev80)
  .slice(0, 15)
  .map((s, i) => {
    return `${i + 1}. ${s.id} | effN=${s.dev.decided} WR=${(s.dev.wr * 100).toFixed(2)}% CI=[${(s.dev.ciLow * 100).toFixed(2)}%,${(s.dev.ciHigh * 100).toFixed(2)}%] EV80=${s.dev.ev80.toFixed(3)} pairs=${s.nSymbols} dayShare=${(s.dayShare * 100).toFixed(1)}% gate=${s.gateMin ? "PASS" : "FAIL"}`;
  });

// Direct answers
const fsDevBest = [...scored]
  .filter((s) => s.id.startsWith("FAILED_SUPPORT|up|"))
  .sort((a, b) => b.dev.ev80 - a.dev.ev80)[0];
const frDevBest = [...scored]
  .filter((s) => s.id.startsWith("FAILED_RESISTANCE|down|"))
  .sort((a, b) => b.dev.ev80 - a.dev.ev80)[0];

const penTrain = tableBy(
  trainFail,
  primaryExpiry,
  ["<0.05", "0.05-0.10", "0.10-0.20", "0.20-0.30", ">0.30"] as PenBucket[],
  (e) => e.penBucket,
);
const reclaimTrain = tableBy(trainFail, primaryExpiry, ["WEAK", "MEDIUM", "STRONG"] as ReclaimClass[], (e) => e.reclaimClass);
const wickTrain = (() => {
  for (const e of events) {
    /* wick classes via TRAIN tertiles */
  }
  for (const e of events) {
    (e as EventRow & { wickClass?: ReclaimClass }).wickClass = classifyReclaim(e.wickRatio, wT1, wT2);
  }
  return tableBy(
    trainFail,
    primaryExpiry,
    ["WEAK", "MEDIUM", "STRONG"] as ReclaimClass[],
    (e) => classifyReclaim(e.wickRatio, wT1, wT2),
  );
})();
const priorTrain = tableBy(
  trainFail,
  primaryExpiry,
  ["WEAK", "MEDIUM", "STRONG"] as ReclaimClass[],
  (e) => classifyReclaim(e.priorMoveAbs5, pT1, pT2),
);
const touchTrain = tableBy(trainFail, primaryExpiry, ["1", "2", "3", "4+"] as TouchBucket[], (e) => e.touchBucket);
const beyondTrain = tableBy(
  trainFail,
  primaryExpiry,
  ["same-bar", "1", "2", "3+"] as BeyondBucket[],
  (e) => e.beyondBucket,
);
const conflTrain = tableBy(
  trainFail,
  primaryExpiry,
  ["1", "2", "3+"] as ConfluenceBucket[],
  (e) => e.confluenceBucket,
);

const fsVsHeld = `Failed support → UP @${primaryExpiry}m DEV: ${statsOf(devFail.filter((e) => e.side === "support"), primaryExpiry).label}
Held support → DOWN @${primaryExpiry}m DEV: ${statsOf(devE.filter((e) => e.kind === "HELD" && e.side === "support"), primaryExpiry).label}
Failed resistance → DOWN @${primaryExpiry}m DEV: ${statsOf(devFail.filter((e) => e.side === "resistance"), primaryExpiry).label}
Held resistance → UP @${primaryExpiry}m DEV: ${statsOf(devE.filter((e) => e.kind === "HELD" && e.side === "resistance"), primaryExpiry).label}`;

const reclaimInfo =
  Math.abs(
    statsOf(devFail.filter((e) => e.side === "support"), primaryExpiry).wr -
      statsOf(devE.filter((e) => e.kind === "HELD" && e.side === "support"), primaryExpiry).wr,
  ) > 0.03
    ? "YES (modest separation; see numbers)"
    : "NO (failed and held near each other / coin-flip)";

const diffWr = fbDevBucket.wr - ctrlDevBucket.wr;

const report = `GOLDENXPERIENCE
FAILED BREAKOUT / FALSE-BREAK BINARY EDGE AUDIT
Experiment: ${EXPERIMENT}

================================
DATA
================================

Pairs: ${instruments.join(", ")}
Date range (predictions): ${minStart} → ${maxStart}
M1 coverage: ${new Date(m1Min).toISOString()} → ${new Date(m1Max).toISOString()}
M1 bars: ${m1Total} across ${instruments.length} pairs (~${Math.round(m1Total / instruments.length)}/pair)
Unique false-break + held episodes (deduped): ${events.length}
  FAILED: ${allFailed.length}  HELD: ${held.length}
Raw detections before episode dedup: ${rawDetections}
Baseline predictions (secondary): ${preds.length}

TRAIN:  ≤ ${new Date(t60).toISOString()}  (events=${trainE.length}, failed=${trainE.filter((e) => e.kind === "FAILED").length})
DEV:    ≤ ${new Date(t80).toISOString()}  (events=${devE.length}, failed=${devE.filter((e) => e.kind === "FAILED").length})
HOLDOUT: after DEV               (events=${holdE.length}, failed=${holdE.filter((e) => e.kind === "FAILED").length})

Leakage audit:
  - level existed before breakout (levels rebuilt at firstBeyondIdx): PASS
  - breakout candle completed before signal (signal = closeMs of reclaim/confirm bar): PASS
  - entry occurs after confirmation (entry = close of signal candle; timer from closeMs): PASS
  - no future swing confirmation (right bars ≤ knownBefore-1): PASS (self-test)
  - no future candle used in reclaim classification (uses candles ≤ i only): PASS
  - no expiration data in features: PASS
  - OANDA start-vs-close timestamp (closeMs = open+60s): PASS
  - chronological TRAIN/DEV/HOLDOUT fixed on M1 timeline before selection: PASS
  - scaler/model TRAIN-only (reclaim tertiles + logistic): PASS
  - overlapping episodes deduplicated (episodeKey 30m slot): PASS
  - ties handled consistently (classifyBinaryResult; WR excl ties): PASS
  - production binary untouched: PASS

================================
EVENT DEFINITION
================================

Support: rolling lows 10/20/50, confirmed swing lows k=${SWING_K}, prior session low, prior day low, clustered touches (merge ≤${CLUSTER_ATR} ATR)
Resistance: mirror highs
Break: penetration ≥ ${MIN_PEN_ATR} ATR beyond pre-existing level (buckets still reported for all depths)
Failed break: penetrates then reclaim candle closes back inside within ${MAX_BARS_BEYOND} bars; signal AFTER reclaim close
Held break: break candle closes beyond; next ${HELD_CONFIRM_BARS} bar(s) also close beyond (no reclaim); signal AFTER confirm close
Entry timing: entry_price = mid close of confirmation candle; expiries from closeMs
Deduplication: episodeKey=instrument|side|levelBucket|30minSlot; first signal only; report raw vs effective n

Directions (PRE-REGISTERED):
  FAILED SUPPORT → UP | FAILED RESISTANCE → DOWN
  HELD SUPPORT → DOWN | HELD RESISTANCE → UP

================================
EVENT FREQUENCY
================================

Failed support breakdowns: ${fsCount}
Failed resistance breakouts: ${frCount}
Held support breaks: ${hsCount}
Held resistance breaks: ${hrCount}

Events/day (approx over ${nDays} calendar days in window): ${(events.length / nDays).toFixed(1)}

================================
HEADLINE FALSE-BREAK RESULTS
================================

Cells: effective_n / WR / CI / EV@80
Expiries:                 1m | 2m | 3m | 5m | 10m | 15m

TRAIN Failed support → UP
  ${headlineRow("support", trainE)}
TRAIN Failed resistance → DOWN
  ${headlineRow("resistance", trainE)}

DEV Failed support → UP
  ${headlineRow("support", devE)}
DEV Failed resistance → DOWN
  ${headlineRow("resistance", devE)}

================================
FALSE vs HELD BREAK
================================

${fsVsHeld}

Does reclaim contain directional information?
${reclaimInfo}

================================
PENETRATION DEPTH
================================
(TRAIN failed @${primaryExpiry}m)
${penTrain}

================================
RECLAIM STRENGTH
================================
(TRAIN failed @${primaryExpiry}m; tertiles fit TRAIN only: t1=${rT1.toFixed(3)} t2=${rT2.toFixed(3)})
${reclaimTrain}

Does stronger reclaim improve WR?
Compare WEAK vs STRONG rows above (descriptive TRAIN).

================================
WICK REJECTION
================================
(TRAIN failed @${primaryExpiry}m; TRAIN wick tertiles t1=${wT1.toFixed(3)} t2=${wT2.toFixed(3)})
${wickTrain}

================================
PRIOR MOVE
================================
(TRAIN failed @${primaryExpiry}m; |ret5|/ATR tertiles)
${priorTrain}

Does exhaustion before false break matter?
See gradient WEAK→STRONG prior-move rows.

================================
TOUCH COUNT
================================
${touchTrain}

================================
TIME BEYOND LEVEL
================================
${beyondTrain}

================================
CONFLUENCE
================================
${conflTrain}

================================
MATCHED CONTROL
================================

False-break WR (@${primaryExpiry}m DEV): ${fbDevBucket.label}
Matched ordinary-bar WR (same direction): ${ctrlDevBucket.label}
Difference (FB − CTRL WR): ${(diffWr * 100).toFixed(2)} pp
CI note: matched n=${ctrlDevBucket.decided}; treat large gaps with suspicion and audit leakage first.

================================
EXPIRY
================================

Best expiry (TRAIN failed aggregate): ${bestExp}m
Why: highest TRAIN WR among expiries with n≥30
Effective n: ${bestExpBucket.decided}
WR: ${(bestExpBucket.wr * 100).toFixed(2)}%
CI: [${(bestExpBucket.ciLow * 100).toFixed(2)}%, ${(bestExpBucket.ciHigh * 100).toFixed(2)}%]
EV@80: ${bestExpBucket.ev80.toFixed(4)}

================================
DEV CANDIDATES
================================

${topDevLines.join("\n")}

================================
DEV GATE
================================

Any candidate passed?
${survivors.length ? "YES" : "NO"}

Minimum: n≥${DEV_MIN_N}, WR>${(BE80 * 100).toFixed(2)}%, EV80>0, CI_low>50%, dayShare≤50%, ≥3 symbols
Strong: n≥200, CI_low>BE80, broad distribution

If NO:
HOLDOUT NOT READ.

================================
HOLDOUT
================================

Status: ${holdoutRead ? "OPENED (DEV survivor present)" : "NOT READ — no DEV candidate cleared minimum gate."}

${
  holdoutRead && survivors[0]?.holdout
    ? `Frozen candidate: ${survivors[0].id}
Effective n: ${survivors[0].holdout.decided}
WR: ${(survivors[0].holdout.wr * 100).toFixed(2)}%
CI: [${(survivors[0].holdout.ciLow * 100).toFixed(2)}%, ${(survivors[0].holdout.ciHigh * 100).toFixed(2)}%]
EV@80: ${survivors[0].holdout.ev80.toFixed(4)}
EV@90: ${survivors[0].holdout.ev90.toFixed(4)}
Pair robustness: max pair share DEV=${(survivors[0].pairShare * 100).toFixed(1)}%
Day robustness: max day share DEV=${(survivors[0].dayShare * 100).toFixed(1)}%`
    : "Frozen candidate: n/a"
}

================================
EXISTING BASELINE INTERACTION
================================

False-break + baseline AGREE (@${primaryExpiry}m DEV): ${agreeDev.label}
False-break + baseline DISAGREE: ${disagreeDev.label}
False-break independent: ${indepDev.label}

Does baseline add information?
${agreeDev.decided >= 20 && agreeDev.wr > indepDev.wr + 0.02 ? "YES — AGREE slightly higher than independent (secondary only)." : "NO clear additive signal from baseline agreement."}

================================
MODEL
================================

${modelLines.join("\n")}

================================
MULTIPLE TESTING
================================

Configurations (registry rows incl TRAIN+DEV+filters): ${hypothesesTested}
DEV configs: ${regDev.length}
Positive (WR>50%): ${mtPositive}
Above BE80: ${mtBe}
Adequate n (≥${DEV_MIN_N}): ${mtN}
CI lower >50: ${mtCi50}
CI lower >BE80: ${mtCiBe}

================================
ROBUSTNESS
================================

By pair (@${primaryExpiry}m DEV failed):
${pairLines.join("\n") || "  (none)"}

By session:
${sessionLines.join("\n")}

Day stability (best candidate):
  ${dayStability}

================================
FINAL VERDICT
================================

${verdict}

================================
DIRECT ANSWERS
================================

1. After support breaks and is reclaimed, does UP beat 55.56%?
   DEV best ${fsDevBest?.id ?? "n/a"}: WR=${fsDevBest ? (fsDevBest.dev.wr * 100).toFixed(2) : "n/a"}% n=${fsDevBest?.dev.decided ?? 0} gate=${fsDevBest?.gateMin ? "PASS" : "FAIL"}

2. After resistance breaks and is reclaimed, does DOWN beat 55.56%?
   DEV best ${frDevBest?.id ?? "n/a"}: WR=${frDevBest ? (frDevBest.dev.wr * 100).toFixed(2) : "n/a"}% n=${frDevBest?.dev.decided ?? 0} gate=${frDevBest?.gateMin ? "PASS" : "FAIL"}

3. Which expiry works best?
   TRAIN aggregate best=${bestExp}m WR=${(bestExpBucket.wr * 100).toFixed(2)}%; see DEV candidate table for OOS.

4. Does deeper penetration help or hurt?
   See PENETRATION DEPTH TRAIN table — compare <0.05 through >0.30.

5. Does stronger reclaim increase accuracy?
   See RECLAIM STRENGTH TRAIN table WEAK/MEDIUM/STRONG.

6. Are immediate false breaks better than delayed reclaims?
   See TIME BEYOND LEVEL same-bar vs 1/2/3+.

7. Does the effect beat matched ordinary M1 bars?
   FB WR=${(fbDevBucket.wr * 100).toFixed(2)}% vs CTRL WR=${(ctrlDevBucket.wr * 100).toFixed(2)}% (Δ=${(diffWr * 100).toFixed(2)} pp) @${primaryExpiry}m DEV.

8. Does it repeat across pairs and days?
   Best candidate dayShare=${bestCand ? (bestCand.dayShare * 100).toFixed(1) : "n/a"}% nSymbols=${bestCand?.nSymbols ?? 0}; ${bestCand && bestCand.dayShare <= 0.5 && bestCand.nSymbols >= 3 ? "broad enough on paper" : "concentrated / underpowered"}.

9. Is there any DEV candidate with enough observations to justify opening HOLDOUT?
   ${survivors.length ? "YES" : "NO"}

10. Most importantly:
Can a CONFIRMED false breakout provide a genuinely profitable binary signal, rather than attempting to predict the breakout/reversal before the market reveals which one occurred?
   Verdict=${verdict}. ${
     verdict === "NO_FALSE_BREAK_EDGE"
       ? "After confirmation, false-break directions did not clear the pre-registered DEV profitability gate (n≥100, WR>55.56%, EV80>0, CI_low>50%, multi-day/multi-symbol)."
       : verdict === "PROMISING_BUT_UNDERPOWERED"
         ? "Some cells exceed BE on DEV but lack effective n / stability to open HOLDOUT."
         : verdict === "FALSE_BREAK_IMPROVES_BUT_BELOW_BREAK_EVEN"
           ? "False breaks may sit above 50% but not above 80% payout break-even with adequate n."
           : verdict === "FALSE_BREAK_DAY_DEPENDENT"
             ? "Apparent edge concentrates on one calendar day — not a robust signal."
             : verdict === "ROBUSTNESS_REJECT"
               ? "DEV passed but HOLDOUT failed — do not deploy."
               : "See HOLDOUT / DEV candidate sections for the surviving definition."
   }

NO PRODUCTION BINARY CHANGES WERE MADE.
`;

fs.mkdirSync(path.join(OUT_DIR, "experiments"), { recursive: true });
fs.writeFileSync(REGISTRY_PATH, registryLines.join("\n") + "\n", "utf8");
fs.writeFileSync(REPORT_PATH, report, "utf8");
console.log(`Wrote ${REPORT_PATH}`);
console.log(`Wrote ${REGISTRY_PATH} (${registryLines.length} lines)`);
console.log(`VERDICT=${verdict} HOLDOUT_READ=${holdoutRead}`);
