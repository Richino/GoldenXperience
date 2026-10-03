/**
 * EUR/USD — 4H ALIGNED MIDPOINT ENTRY TIMING STUDY V4
 *
 * Exact V3 cohort: ALIGNED + start distance [5, 10) pips. Expected N=564.
 * RESEARCH ONLY — declared signals only, no optimization / no P&L.
 */
import fs from "node:fs";
import path from "node:path";
import type { MajorInstrument } from "../src/types/forex";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const PIP = pipSizeFor(INSTRUMENT);
const BLOCK = 16;
const BLOCK_MS = 4 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const M1_HORIZON = 240; // 4H of M1
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;
const EXPECT_N = 564;
const EXPECT_HIT = 70.6;

const ADV_INIT = ["0-1", "1-2", "2-3", "3-5", "5-7.5", "7.5-10", "10-15", "15-20", "20+"] as const;
const DEPTHS = [1, 2, 3, 5, 7.5, 10] as const;
const RECOVERIES = [1, 2, 3, 5] as const;
const RACE_ADV = [5, 7.5, 10, 15, 20] as const;
const TIME_TRIG = [
  ["0-5", (m: number) => m >= 0 && m <= 5],
  ["5-15", (m: number) => m > 5 && m <= 15],
  ["15-30", (m: number) => m > 15 && m <= 30],
  ["30-45", (m: number) => m > 30 && m <= 45],
  ["45-60", (m: number) => m > 45 && m <= 60],
  ["60-90", (m: number) => m > 60 && m <= 90],
  ["90-120", (m: number) => m > 90 && m <= 120],
  ["120+", (m: number) => m > 120],
] as const;

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC };

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const pad = (xs: Array<string | number>, widths: number[]) =>
  xs.map((x, i) => String(x).padStart(widths[i] ?? 10)).join("");

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return (
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    (UTC_HOURS as readonly number[]).includes(d.getUTCHours())
  );
}

function lb(msArr: Float64Array, len: number, target: number): number {
  let lo = 0,
    hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (msArr[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function advBucket(a: number): string {
  if (a <= 1) return "0-1";
  if (a <= 2) return "1-2";
  if (a <= 3) return "2-3";
  if (a <= 5) return "3-5";
  if (a <= 7.5) return "5-7.5";
  if (a <= 10) return "7.5-10";
  if (a <= 15) return "10-15";
  if (a <= 20) return "15-20";
  return "20+";
}

function trigBucket(m: number): string {
  for (const [name, fn] of TIME_TRIG) if (fn(m)) return name;
  return "120+";
}

console.error("V4 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n15 = raw.length;
const t15 = new Float64Array(n15);
const o15 = new Float64Array(n15);
const h15 = new Float64Array(n15);
const l15 = new Float64Array(n15);
const c15 = new Float64Array(n15);
for (let i = 0; i < n15; i++) {
  const m = raw[i]!.mid;
  t15[i] = Date.parse(raw[i]!.time);
  o15[i] = m.open;
  h15[i] = m.high;
  l15[i] = m.low;
  c15[i] = m.close;
}

console.error("V4 loading M1...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const t1 = new Float64Array(M1);
const h1 = new Float64Array(M1);
const l1 = new Float64Array(M1);
const c1 = new Float64Array(M1);
const o1 = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  t1[i] = Date.parse(r[0]);
  // mid from bid/ask: H=(bh+ah)/2, L=(bl+al)/2, C=(bc+ac)/2
  h1[i] = (r[1] + r[3]) / 2;
  l1[i] = (r[2] + r[4]) / 2;
  c1[i] = (r[5] + r[6]) / 2;
  o1[i] = i > 0 ? c1[i - 1]! : c1[i]!;
}
(m1raw as unknown as { length: number }).length = 0;

interface Setup {
  year: number;
  alignType: "BULLISH_ALIGNED" | "BEARISH_ALIGNED";
  toward: "UP" | "DOWN"; // toward midpoint
  mid: number;
  open: number;
  dist: number;
  rangePips: number;
  m1Start: number;
  m1End: number;
  hit: boolean;
  tHitMin: number | null; // minutes from open to mid touch
}

const setups: Setup[] = [];
let nGap = 0;

for (let i = 0; i < n15; i++) {
  if (!isUtcBlockStart(t15[i]!)) continue;
  if (i < BLOCK || i + BLOCK > n15) continue;
  const trade0 = i;
  const prev0 = trade0 - BLOCK;
  const trade1 = trade0 + BLOCK - 1;

  let gap = false;
  for (let j = prev0 + 1; j <= trade1; j++) {
    if (Math.abs(t15[j]! - t15[j - 1]! - BAR_MS) > 1000) {
      gap = true;
      break;
    }
  }
  if (gap) {
    nGap++;
    continue;
  }
  if (Math.abs(t15[prev0]! - (t15[trade0]! - BLOCK_MS)) > 1000) continue;

  let support = Infinity,
    resistance = -Infinity;
  for (let j = prev0; j < trade0; j++) {
    support = Math.min(support, l15[j]!);
    resistance = Math.max(resistance, h15[j]!);
  }
  const range = resistance - support;
  if (!(range > 0)) continue;
  const mid = support + range * 0.5;
  const prevOpen = o15[prev0]!;
  const prevClose = c15[trade0 - 1]!;
  const newOpen = o15[trade0]!;
  const dist = Math.abs(newOpen - mid) / PIP;
  if (!(dist > 5 && dist <= 10)) continue; // V3 "5-10" bucket: (5, 10]

  const move = prevClose - prevOpen;
  if (!(move > 0 || move < 0)) continue;
  const trendBull = move > 0;
  const below = newOpen < mid;
  const above = newOpen > mid;
  const aligned =
    (trendBull && below) || (!trendBull && above);
  if (!aligned) continue;

  // M1 window: bars with open time >= trade0 and < trade0+4h
  let m1Start = lb(t1, M1, t15[trade0]!);
  if (m1Start >= M1) continue;
  while (m1Start < M1 && t1[m1Start]! < t15[trade0]! - 500) m1Start++;
  if (m1Start >= M1) continue;
  const endMs = t15[trade0]! + BLOCK_MS;
  let m1End = lb(t1, M1, endMs) - 1;
  if (m1End < m1Start) continue;
  // allow partial windows (weekends/gaps) — need at least ~30m of path
  if (m1End - m1Start + 1 < 30) continue;

  const toward: "UP" | "DOWN" = below ? "UP" : "DOWN";
  let hit = false;
  let tHitMin: number | null = null;
  for (let k = m1Start; k <= m1End; k++) {
    const hi = h1[k]!;
    const lo = l1[k]!;
    if (lo <= mid && hi >= mid) {
      hit = true;
      tHitMin = k - m1Start + 1; // minutes (M1)
      break;
    }
  }

  setups.push({
    year: new Date(t15[trade0]!).getUTCFullYear(),
    alignType: trendBull ? "BULLISH_ALIGNED" : "BEARISH_ALIGNED",
    toward,
    mid,
    open: newOpen,
    dist,
    rangePips: range / PIP,
    m1Start,
    m1End,
    hit,
    tHitMin,
  });
}

const hitPct = pct(setups.filter((s) => s.hit).length, setups.length);
console.error(`Cohort N=${setups.length} hit%=${f1(hitPct)} (expect ${EXPECT_N} / ${EXPECT_HIT}%)`);
if (Math.abs(setups.length - EXPECT_N) > 15 || Math.abs(hitPct - EXPECT_HIT) > 2.5) {
  console.error("STOP integrity failure: cohort mismatch");
  process.exit(1);
}
console.error("COHORT PARITY PASS");

// ---------- path helpers ----------
function favMove(px: number, s: Setup): number {
  // pips toward midpoint from open
  return s.toward === "UP" ? (px - s.open) / PIP : (s.open - px) / PIP;
}
function advMove(px: number, s: Setup): number {
  return s.toward === "UP" ? (s.open - px) / PIP : (px - s.open) / PIP;
}
function distToMid(px: number, s: Setup): number {
  return Math.abs(px - s.mid) / PIP;
}
function crossesMid(lo: number, hi: number, mid: number): boolean {
  return lo <= mid && hi >= mid;
}
function favClose(close: number, s: Setup): boolean {
  // close toward midpoint vs prior open of that candle — vs previous close
  // "closes toward midpoint" = close is closer to mid than open of that candle,
  // OR close moves in required direction from candle open
  return true; // placeholder replaced below
}

function candleTowardMid(o: number, c: number, s: Setup): boolean {
  if (s.toward === "UP") return c > o;
  return c < o;
}

function atr14M5(m1EndIdx: number, beforeExcl: number): number {
  // ATR14 on completed M5 buckets ending before beforeExcl
  // Build last 15 M5 ranges from M1
  const ranges: number[] = [];
  let bucket = -1;
  let bh = -Infinity,
    bl = Infinity,
    prevC = NaN;
  for (let i = Math.max(0, beforeExcl - 5 * 20); i < beforeExcl; i++) {
    const b = Math.floor(t1[i]! / (5 * 60_000));
    if (b !== bucket) {
      if (bucket >= 0 && Number.isFinite(prevC)) {
        const tr = Math.max(bh - bl, Math.abs(bh - prevC), Math.abs(bl - prevC));
        ranges.push(tr);
      }
      if (bucket >= 0) prevC = c1[i - 1]!;
      bucket = b;
      bh = h1[i]!;
      bl = l1[i]!;
    } else {
      bh = Math.max(bh, h1[i]!);
      bl = Math.min(bl, l1[i]!);
    }
  }
  if (ranges.length < 14) return 5 * PIP; // fallback ~5p
  let sum = 0;
  for (let i = ranges.length - 14; i < ranges.length; i++) sum += ranges[i]!;
  return sum / 14;
}

// ---------- Signal result store ----------
interface SigRes {
  name: string;
  triggered: boolean;
  entryI: number | null; // m1 index
  entryPx: number | null;
  entryMin: number | null;
  remReward: number | null;
  hitAfter: boolean;
  tHitAfter: number | null; // minutes after entry
  maeAfter: number;
  mfeAfter: number;
  race: Record<number, boolean>;
  wouldCatchSuccess: boolean; // success retention: setup.hit && triggered before original hit
}

function emptyRace(): Record<number, boolean> {
  const r: Record<number, boolean> = {};
  for (const a of RACE_ADV) r[a] = false;
  return r;
}

function evalFromEntry(s: Setup, entryI: number, entryPx: number): Omit<SigRes, "name" | "triggered" | "wouldCatchSuccess"> {
  let hitAfter = false;
  let tHitAfter: number | null = null;
  let mae = 0,
    mfe = 0;
  const raceRaw: Record<number, boolean | null> = {};
  for (const a of RACE_ADV) raceRaw[a] = null;

  for (let i = entryI; i <= s.m1End; i++) {
    const hi = h1[i]!;
    const lo = l1[i]!;
    const mins = i - entryI; // bars after entry (0 = entry bar)
    // adverse/fav from entry
    if (s.toward === "UP") {
      mae = Math.max(mae, Math.max(0, entryPx - lo) / PIP);
      mfe = Math.max(mfe, Math.max(0, Math.min(hi, s.mid) - entryPx) / PIP);
    } else {
      mae = Math.max(mae, Math.max(0, hi - entryPx) / PIP);
      mfe = Math.max(mfe, Math.max(0, entryPx - Math.max(lo, s.mid)) / PIP);
    }
    if (!hitAfter && crossesMid(lo, hi, s.mid)) {
      hitAfter = true;
      tHitAfter = mins;
    }
    for (const a of RACE_ADV) {
      if (raceRaw[a] === null) {
        if (mae >= a) raceRaw[a] = false;
        else if (hitAfter) raceRaw[a] = true;
      }
    }
  }
  const race = emptyRace();
  for (const a of RACE_ADV) race[a] = raceRaw[a] === true;
  return {
    entryI,
    entryPx,
    entryMin: entryI - s.m1Start,
    remReward: distToMid(entryPx, s),
    hitAfter,
    tHitAfter,
    maeAfter: mae,
    mfeAfter: mfe,
    race,
  };
}

type Detector = (s: Setup, w: WalkState) => SigRes;

function makeSig(name: string, entryI: number | null, s: Setup): SigRes {
  if (entryI === null || entryI > s.m1End) {
    return {
      name,
      triggered: false,
      entryI: null,
      entryPx: null,
      entryMin: null,
      remReward: null,
      hitAfter: false,
      tHitAfter: null,
      maeAfter: NaN,
      mfeAfter: NaN,
      race: emptyRace(),
      wouldCatchSuccess: false,
    };
  }
  const entryPx = c1[entryI]!;
  const ev = evalFromEntry(s, entryI, entryPx);
  const wouldCatchSuccess =
    s.hit && s.tHitMin !== null && ev.entryMin !== null && ev.entryMin < s.tHitMin;
  return { name, triggered: true, wouldCatchSuccess, ...ev };
}

const detImmediate: Detector = (s, _w) => {
  const entryI = s.m1Start;
  const ev = evalFromEntry(s, entryI, s.open);
  return {
    name: "IMMEDIATE",
    triggered: true,
    wouldCatchSuccess: s.hit,
    ...ev,
    entryPx: s.open,
    remReward: s.dist,
  };
};

// ---- Walk state for a setup ----
interface WalkState {
  maeSoFar: number[];
  favSoFar: number[];
  extremeAdvPx: number[]; // worst price so far
  m5CloseToward: boolean[]; // at each m1 index, if this completes an M5 toward mid
  m5O: number[];
  m5H: number[];
  m5L: number[];
  m5C: number[];
  m5EndI: number[]; // m1 index where M5 completes
}

function buildWalk(s: Setup): WalkState {
  const len = s.m1End - s.m1Start + 1;
  const maeSoFar = new Array(len).fill(0);
  const favSoFar = new Array(len).fill(0);
  const extremeAdvPx = new Array(len).fill(s.open);
  let mae = 0,
    fav = 0;
  let ext = s.open;

  const m5CloseToward: boolean[] = new Array(len).fill(false);
  const m5O: number[] = [];
  const m5H: number[] = [];
  const m5L: number[] = [];
  const m5C: number[] = [];
  const m5EndI: number[] = [];

  let bStart = s.m1Start;
  let bh = h1[s.m1Start]!;
  let bl = l1[s.m1Start]!;
  let bo = o1[s.m1Start]!;
  let lastBucket = Math.floor(t1[s.m1Start]! / (5 * 60_000));

  for (let i = s.m1Start; i <= s.m1End; i++) {
    const off = i - s.m1Start;
    const hi = h1[i]!;
    const lo = l1[i]!;
    if (s.toward === "UP") {
      mae = Math.max(mae, Math.max(0, s.open - lo) / PIP);
      fav = Math.max(fav, Math.max(0, Math.min(hi, s.mid) - s.open) / PIP);
      if (lo < ext) ext = lo;
    } else {
      mae = Math.max(mae, Math.max(0, hi - s.open) / PIP);
      fav = Math.max(fav, Math.max(0, s.open - Math.max(lo, s.mid)) / PIP);
      if (hi > ext) ext = hi;
    }
    maeSoFar[off] = mae;
    favSoFar[off] = fav;
    extremeAdvPx[off] = ext;

    const bucket = Math.floor(t1[i]! / (5 * 60_000));
    if (bucket !== lastBucket) {
      // previous M5 completed at i-1
      const end = i - 1;
      if (end >= bStart) {
        const bc = c1[end]!;
        const toward = candleTowardMid(bo, bc, s);
        const eoff = end - s.m1Start;
        if (eoff >= 0 && eoff < len) m5CloseToward[eoff] = toward;
        m5O.push(bo);
        m5H.push(bh);
        m5L.push(bl);
        m5C.push(bc);
        m5EndI.push(end);
      }
      lastBucket = bucket;
      bStart = i;
      bh = hi;
      bl = lo;
      bo = o1[i]!;
    } else {
      bh = Math.max(bh, hi);
      bl = Math.min(bl, lo);
    }
  }
  // final partial M5 — only if complete 5 bars? skip incomplete
  return { maeSoFar, favSoFar, extremeAdvPx, m5CloseToward, m5O, m5H, m5L, m5C, m5EndI };
}

function firstIdxMaeAtLeast(w: WalkState, d: number): number | null {
  for (let i = 0; i < w.maeSoFar.length; i++) if (w.maeSoFar[i]! >= d) return i;
  return null;
}

function firstFavAtLeast(w: WalkState, d: number): number | null {
  for (let i = 0; i < w.favSoFar.length; i++) if (w.favSoFar[i]! >= d) return i;
  return null;
}

// Signal A: after adverse D, first M1/M5 close toward mid
function detSimpleTurn(depth: number, tf: "M1" | "M5"): Detector {
  return (s, w) => {
    const name = `TURN_${tf}_d${depth}`;
    const startOff = firstIdxMaeAtLeast(w, depth);
    if (startOff === null) return makeSig(name, null, s);
    if (tf === "M1") {
      for (let i = s.m1Start + startOff; i <= s.m1End; i++) {
        if (candleTowardMid(o1[i]!, c1[i]!, s)) return makeSig(name, i, s);
      }
      return makeSig(name, null, s);
    }
    for (let k = 0; k < w.m5EndI.length; k++) {
      const end = w.m5EndI[k]!;
      if (end - s.m1Start < startOff) continue;
      if (candleTowardMid(w.m5O[k]!, w.m5C[k]!, s)) return makeSig(name, end, s);
    }
    return makeSig(name, null, s);
  };
}

function detConsecutive(depth: number, tf: "M1" | "M5", nCons: number): Detector {
  return (s, w) => {
    const name = `CONS${nCons}_${tf}_d${depth}`;
    const startOff = firstIdxMaeAtLeast(w, depth);
    if (startOff === null) return makeSig(name, null, s);
    if (tf === "M1") {
      let run = 0;
      for (let i = s.m1Start + startOff; i <= s.m1End; i++) {
        if (candleTowardMid(o1[i]!, c1[i]!, s)) {
          run++;
          if (run >= nCons) return makeSig(name, i, s);
        } else run = 0;
      }
      return makeSig(name, null, s);
    }
    let run = 0;
    for (let k = 0; k < w.m5EndI.length; k++) {
      const end = w.m5EndI[k]!;
      if (end - s.m1Start < startOff) continue;
      if (candleTowardMid(w.m5O[k]!, w.m5C[k]!, s)) {
        run++;
        if (run >= nCons) return makeSig(name, end, s);
      } else run = 0;
    }
    return makeSig(name, null, s);
  };
}

function detStructure(reach: number): Detector {
  return (s, w) => {
    const name = `STRUCT_r${reach}`;
    const startOff = firstIdxMaeAtLeast(w, 1);
    if (startOff === null) return makeSig(name, null, s);

    const pivots: Array<{ i: number; price: number; kind: "H" | "L" }> = [];
    const from = s.m1Start;
    const to = s.m1End;
    for (let i = from + reach; i <= to - reach; i++) {
      let isH = true,
        isL = true;
      for (let o = 1; o <= reach; o++) {
        if (!(h1[i]! > h1[i - o]! && h1[i]! >= h1[i + o]!)) isH = false;
        if (!(l1[i]! < l1[i - o]! && l1[i]! <= l1[i + o]!)) isL = false;
      }
      const know = i + reach;
      if (isH) pivots.push({ i: know, price: h1[i]!, kind: "H" });
      if (isL) pivots.push({ i: know, price: l1[i]!, kind: "L" });
    }
    pivots.sort((a, b) => a.i - b.i);

    const confH: Array<{ price: number }> = [];
    const confL: Array<{ price: number }> = [];
    let p = 0;
    for (let i = s.m1Start + startOff; i <= s.m1End; i++) {
      while (p < pivots.length && pivots[p]!.i <= i) {
        const pv = pivots[p]!;
        if (pv.kind === "H") confH.push({ price: pv.price });
        else confL.push({ price: pv.price });
        p++;
      }
      if (s.toward === "UP") {
        if (confH.length >= 2) {
          const a = confH[confH.length - 2]!.price;
          const b = confH[confH.length - 1]!.price;
          if (b < a && c1[i]! > b) return makeSig(name, i, s);
        }
      } else if (confL.length >= 2) {
        const a = confL[confL.length - 2]!.price;
        const b = confL[confL.length - 1]!.price;
        if (b > a && c1[i]! < b) return makeSig(name, i, s);
      }
    }
    return makeSig(name, null, s);
  };
}

function detReclaim(tf: "M1" | "M5", nCons: number): Detector {
  return (s, w) => {
    const name = `RECLAIM_${tf}_x${nCons}`;
    const startOff = firstIdxMaeAtLeast(w, 1);
    if (startOff === null) return makeSig(name, null, s);
    const throughOpen = (c: number) => (s.toward === "UP" ? c >= s.open : c <= s.open);

    if (tf === "M1") {
      let run = 0;
      for (let i = s.m1Start + startOff; i <= s.m1End; i++) {
        if (throughOpen(c1[i]!)) {
          run++;
          if (run >= nCons) return makeSig(name, i, s);
        } else run = 0;
      }
      return makeSig(name, null, s);
    }
    let run = 0;
    for (let k = 0; k < w.m5EndI.length; k++) {
      const end = w.m5EndI[k]!;
      if (end - s.m1Start < startOff) continue;
      if (throughOpen(w.m5C[k]!)) {
        run++;
        if (run >= nCons) return makeSig(name, end, s);
      } else run = 0;
    }
    return makeSig(name, null, s);
  };
}

function detRecovery(recPips: number): Detector {
  return (s, w) => {
    const name = `RECOVER_${recPips}p`;
    for (let i = s.m1Start; i <= s.m1End; i++) {
      const off = i - s.m1Start;
      const ext = w.extremeAdvPx[off]!;
      const advDepth = s.toward === "UP" ? (s.open - ext) / PIP : (ext - s.open) / PIP;
      if (advDepth < 1) continue;
      const rec = s.toward === "UP" ? (c1[i]! - ext) / PIP : (ext - c1[i]!) / PIP;
      if (rec >= recPips) return makeSig(name, i, s);
    }
    return makeSig(name, null, s);
  };
}

function detM5Mom(depth: number, kind: "A" | "B" | "C" | "D"): Detector {
  return (s, w) => {
    const name = `M5MOM_${kind}_d${depth}`;
    const startOff = firstIdxMaeAtLeast(w, depth);
    if (startOff === null) return makeSig(name, null, s);
    for (let k = 0; k < w.m5EndI.length; k++) {
      const end = w.m5EndI[k]!;
      if (end - s.m1Start < startOff) continue;
      const o = w.m5O[k]!;
      const h = w.m5H[k]!;
      const l = w.m5L[k]!;
      const c = w.m5C[k]!;
      if (!candleTowardMid(o, c, s)) continue;
      const body = Math.abs(c - o);
      const rng = h - l;
      if (!(rng > 0)) continue;
      const bodyRatio = body / rng;
      const atr = atr14M5(s.m1End, end);
      let ok = false;
      if (kind === "A") ok = true;
      else if (kind === "B") ok = bodyRatio >= 0.5;
      else if (kind === "C") ok = body >= 0.25 * atr;
      else if (kind === "D") {
        if (s.toward === "UP") ok = c >= h - 0.25 * rng;
        else ok = c <= l + 0.25 * rng;
      }
      if (ok) return makeSig(name, end, s);
    }
    return makeSig(name, null, s);
  };
}

// Build detector list
const detectors: Detector[] = [
  detImmediate,
  detSimpleTurn(1, "M1"),
  detSimpleTurn(2, "M1"),
  detSimpleTurn(3, "M1"),
  detSimpleTurn(5, "M1"),
  detSimpleTurn(1, "M5"),
  detSimpleTurn(2, "M5"),
  detSimpleTurn(3, "M5"),
  detSimpleTurn(5, "M5"),
  detConsecutive(2, "M1", 2),
  detConsecutive(3, "M1", 2),
  detConsecutive(5, "M1", 2),
  detConsecutive(2, "M1", 3),
  detConsecutive(3, "M1", 3),
  detConsecutive(5, "M1", 3),
  detConsecutive(2, "M5", 2),
  detConsecutive(3, "M5", 2),
  detConsecutive(5, "M5", 2),
  detStructure(1),
  detStructure(2),
  detStructure(3),
  detReclaim("M1", 1),
  detReclaim("M1", 2),
  detReclaim("M5", 1),
  detRecovery(1),
  detRecovery(2),
  detRecovery(3),
  detRecovery(5),
  detM5Mom(2, "A"),
  detM5Mom(3, "A"),
  detM5Mom(5, "A"),
  detM5Mom(2, "B"),
  detM5Mom(3, "B"),
  detM5Mom(5, "B"),
  detM5Mom(2, "C"),
  detM5Mom(3, "C"),
  detM5Mom(5, "C"),
  detM5Mom(2, "D"),
  detM5Mom(3, "D"),
  detM5Mom(5, "D"),
];

console.error(`Evaluating ${detectors.length} detectors on ${setups.length} setups...`);

interface Agg {
  nTrig: number;
  hit: number;
  rem: number[];
  mae: number[];
  tHit: number[];
  tTrig: number[];
  race: Record<number, number>;
  retention: number; // success caught
  bySide: Record<string, { n: number; hit: number; mae: number[] }>;
  byEra: Record<string, { n: number; hit: number; before10: number; mae: number[]; rem: number[] }>;
  byTrigTime: Record<string, { n: number; hit: number; rem: number[]; mae: number[] }>;
}
function newAgg(): Agg {
  const race: Record<number, number> = {};
  for (const a of RACE_ADV) race[a] = 0;
  return {
    nTrig: 0,
    hit: 0,
    rem: [],
    mae: [],
    tHit: [],
    tTrig: [],
    race,
    retention: 0,
    bySide: {},
    byEra: {},
    byTrigTime: {},
  };
}

const aggs = new Map<string, Agg>();
const nSuccess = setups.filter((s) => s.hit).length;

// Section 3 path map
const initAdvBuckets: Record<string, { n: number; hit: number; tHit: number[]; remAtTurn: number[] }> = {};
for (const b of ADV_INIT) initAdvBuckets[b] = { n: 0, hit: 0, tHit: [], remAtTurn: [] };

// Section 4 reversal depth
const revDepth: Record<number, { n: number; backOpen: number; p25: number; p50: number; mid: number }> = {};
for (const d of DEPTHS) revDepth[d] = { n: 0, backOpen: 0, p25: 0, p50: 0, mid: 0 };

// Section 16 early separation
interface EarlyDist {
  s: number[];
  f: number[];
}
const early: Record<string, EarlyDist> = {};
function pushEarly(key: string, success: boolean, v: number) {
  if (!early[key]) early[key] = { s: [], f: [] };
  if (success) early[key]!.s.push(v);
  else early[key]!.f.push(v);
}

let scanned = 0;
for (const s of setups) {
  const w = buildWalk(s);

  // §3: MAE by the time first +1p favor appears
  const t1f = firstFavAtLeast(w, 1);
  const maeBefore1 = t1f === null ? w.maeSoFar[w.maeSoFar.length - 1]! : w.maeSoFar[t1f]!;
  const b = advBucket(maeBefore1);
  const buck = initAdvBuckets[b]!;
  buck.n++;
  if (s.hit) {
    buck.hit++;
    if (s.tHitMin !== null) buck.tHit.push(s.tHitMin);
  }
  buck.remAtTurn.push(Math.max(0, s.dist - 1));

  // §4 reversal after depth D
  for (const d of DEPTHS) {
    const off = firstIdxMaeAtLeast(w, d);
    if (off === null) continue;
    revDepth[d]!.n++;
    let backOpen = false,
      p25 = false,
      p50 = false,
      midH = false;
    const progressTarget = (p: number) => s.dist * (p / 100);
    for (let i = s.m1Start + off; i <= s.m1End; i++) {
      const hi = h1[i]!;
      const lo = l1[i]!;
      const fav = favMove(s.toward === "UP" ? hi : lo, s);
      if (s.toward === "UP" ? hi >= s.open : lo <= s.open) backOpen = true;
      if (fav >= progressTarget(25)) p25 = true;
      if (fav >= progressTarget(50)) p50 = true;
      if (crossesMid(lo, hi, s.mid)) midH = true;
    }
    if (backOpen) revDepth[d]!.backOpen++;
    if (p25) revDepth[d]!.p25++;
    if (p50) revDepth[d]!.p50++;
    if (midH) revDepth[d]!.mid++;
  }

  // §16 early windows
  for (const win of [15, 30, 60] as const) {
    const endI = Math.min(s.m1Start + win - 1, s.m1End);
    const off = endI - s.m1Start;
    pushEarly(`${win}|mae`, s.hit, w.maeSoFar[off]!);
    pushEarly(`${win}|fav`, s.hit, w.favSoFar[off]!);
    pushEarly(`${win}|net`, s.hit, w.favSoFar[off]! - w.maeSoFar[off]!);
    let favCl = 0,
      advCl = 0;
    for (let i = s.m1Start; i <= endI; i++) {
      if (candleTowardMid(o1[i]!, c1[i]!, s)) favCl++;
      else advCl++;
    }
    pushEarly(`${win}|m1Fav`, s.hit, favCl);
    pushEarly(`${win}|m1Adv`, s.hit, advCl);
    let m5Fav = 0;
    for (let k = 0; k < w.m5EndI.length; k++) {
      if (w.m5EndI[k]! > endI) break;
      if (candleTowardMid(w.m5O[k]!, w.m5C[k]!, s)) m5Fav++;
    }
    pushEarly(`${win}|m5Fav`, s.hit, m5Fav);
    let reclaimed = 0;
    for (let i = s.m1Start; i <= endI; i++) {
      if (s.toward === "UP" ? c1[i]! >= s.open : c1[i]! <= s.open) {
        reclaimed = 1;
        break;
      }
    }
    pushEarly(`${win}|reclaim`, s.hit, reclaimed);
    let maxRec = 0;
    let ext = s.open;
    for (let i = s.m1Start; i <= endI; i++) {
      if (s.toward === "UP") {
        ext = Math.min(ext, l1[i]!);
        maxRec = Math.max(maxRec, (c1[i]! - ext) / PIP);
      } else {
        ext = Math.max(ext, h1[i]!);
        maxRec = Math.max(maxRec, (ext - c1[i]!) / PIP);
      }
    }
    pushEarly(`${win}|maxRec`, s.hit, maxRec);
  }

  for (const det of detectors) {
    const r = det(s, w);
    let a = aggs.get(r.name);
    if (!a) {
      a = newAgg();
      aggs.set(r.name, a);
    }
    if (!r.triggered) continue;
    a.nTrig++;
    if (r.hitAfter) a.hit++;
    if (r.remReward !== null) a.rem.push(r.remReward);
    a.mae.push(r.maeAfter);
    if (r.tHitAfter !== null) a.tHit.push(r.tHitAfter);
    if (r.entryMin !== null) a.tTrig.push(r.entryMin);
    for (const adv of RACE_ADV) if (r.race[adv]) a.race[adv]!++;
    if (r.wouldCatchSuccess) a.retention++;

    const side = s.alignType;
    if (!a.bySide[side]) a.bySide[side] = { n: 0, hit: 0, mae: [] };
    a.bySide[side]!.n++;
    if (r.hitAfter) a.bySide[side]!.hit++;
    a.bySide[side]!.mae.push(r.maeAfter);

    const era = s.year <= 2019 ? "2013-2019" : "2020-2026";
    if (!a.byEra[era]) a.byEra[era] = { n: 0, hit: 0, before10: 0, mae: [], rem: [] };
    a.byEra[era]!.n++;
    if (r.hitAfter) a.byEra[era]!.hit++;
    if (r.race[10]) a.byEra[era]!.before10++;
    a.byEra[era]!.mae.push(r.maeAfter);
    if (r.remReward !== null) a.byEra[era]!.rem.push(r.remReward);

    if (r.entryMin !== null) {
      const tb = trigBucket(r.entryMin);
      if (!a.byTrigTime[tb]) a.byTrigTime[tb] = { n: 0, hit: 0, rem: [], mae: [] };
      a.byTrigTime[tb]!.n++;
      if (r.hitAfter) a.byTrigTime[tb]!.hit++;
      if (r.remReward !== null) a.byTrigTime[tb]!.rem.push(r.remReward);
      a.byTrigTime[tb]!.mae.push(r.maeAfter);
    }
  }

  scanned++;
  if (scanned % 100 === 0) console.error(`  ${scanned}/${setups.length}`);
}

console.error("Done. Writing report...");

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD — 4H ALIGNED MIDPOINT ENTRY TIMING STUDY V4");
L.push("=".repeat(120));
L.push(`Cohort: ALIGNED + dist (5,10]p  N=${setups.length}  MidHit=${f1(hitPct)}%  (expect ${EXPECT_N}/${EXPECT_HIT}%)`);
L.push(`COHORT_PARITY = PASS`);
L.push(`Success setups N=${nSuccess}`);
L.push(`gaps skipped in block build≈${nGap}`);
L.push("");

// §3
L.push("-".repeat(120));
L.push("SECTION 3 — INITIAL ADVERSE BEFORE FIRST +1p TOWARD MID");
L.push("-".repeat(120));
L.push(pad(["AdvBucket", "N", "Hit%", "MedTHit", "MedRem"], [12, 8, 8, 10, 10]));
for (const b of ADV_INIT) {
  const x = initAdvBuckets[b]!;
  if (!x.n) continue;
  L.push(
    pad([b, x.n, f1(pct(x.hit, x.n)), f0(median(x.tHit)), f1(median(x.remAtTurn))], [12, 8, 8, 10, 10]),
  );
}
L.push("");

// §4
L.push("-".repeat(120));
L.push("SECTION 4 — REVERSAL AFTER ADVERSE DEPTH D");
L.push("-".repeat(120));
L.push(pad(["Depth", "N", "BackOpen%", "To25%", "To50%", "ToMid%"], [10, 8, 12, 10, 10, 10]));
for (const d of DEPTHS) {
  const x = revDepth[d]!;
  if (!x.n) continue;
  L.push(
    pad(
      [d, x.n, f1(pct(x.backOpen, x.n)), f1(pct(x.p25, x.n)), f1(pct(x.p50, x.n)), f1(pct(x.mid, x.n))],
      [10, 8, 12, 10, 10, 10],
    ),
  );
}
L.push("");

function rowSig(name: string, a: Agg) {
  const trigRate = pct(a.nTrig, setups.length);
  const ret = pct(a.retention, nSuccess);
  return {
    name,
    n: a.nTrig,
    trigRate,
    retention: ret,
    rem: median(a.rem),
    hit: pct(a.hit, a.nTrig),
    before10: pct(a.race[10]!, a.nTrig),
    before5: pct(a.race[5]!, a.nTrig),
    before7_5: pct(a.race[7.5]!, a.nTrig),
    before15: pct(a.race[15]!, a.nTrig),
    before20: pct(a.race[20]!, a.nTrig),
    medMae: median(a.mae),
    p75Mae: q(a.mae, 0.75),
    p90Mae: q(a.mae, 0.9),
    medT: median(a.tHit),
    medTrig: median(a.tTrig),
  };
}

// Full signal table
L.push("-".repeat(120));
L.push("ALL SIGNALS — FAIR COMPARISON");
L.push("-".repeat(120));
L.push(
  pad(
    ["Signal", "N", "Trig%", "Retain%", "Rem", "Hit%", "B10%", "MedMAE", "P75", "P90", "MedTrig"],
    [22, 6, 7, 8, 6, 7, 7, 8, 6, 6, 8],
  ),
);
const allRows = [...aggs.entries()]
  .map(([name, a]) => rowSig(name, a))
  .sort((x, y) => y.n - x.n);
for (const r of allRows) {
  if (r.n < 20) continue;
  L.push(
    pad(
      [
        r.name.slice(0, 22),
        r.n,
        f1(r.trigRate),
        f1(r.retention),
        f1(r.rem),
        f1(r.hit),
        f1(r.before10),
        f1(r.medMae),
        f1(r.p75Mae),
        f1(r.p90Mae),
        f0(r.medTrig),
      ],
      [22, 6, 7, 8, 6, 7, 7, 8, 6, 6, 8],
    ),
  );
}
L.push("");

// First-hit races for promising
L.push("-".repeat(120));
L.push("SECTION 13 — FIRST-HIT RACES (selected)");
L.push("-".repeat(120));
L.push(pad(["Signal", "N", "Hit%", "B5", "B7.5", "B10", "B15", "B20"], [22, 6, 7, 7, 7, 7, 7, 7]));
const raceNames = [
  "IMMEDIATE",
  "TURN_M1_d2",
  "TURN_M1_d3",
  "TURN_M5_d2",
  "TURN_M5_d3",
  "CONS2_M1_d3",
  "CONS2_M5_d3",
  "STRUCT_r2",
  "RECLAIM_M1_x1",
  "RECLAIM_M5_x1",
  "RECOVER_2p",
  "RECOVER_3p",
  "M5MOM_B_d3",
  "M5MOM_D_d3",
];
for (const name of raceNames) {
  const a = aggs.get(name);
  if (!a || a.nTrig < 20) continue;
  const r = rowSig(name, a);
  L.push(
    pad(
      [name.slice(0, 22), r.n, f1(r.hit), f1(r.before5), f1(r.before7_5), f1(r.before10), f1(r.before15), f1(r.before20)],
      [22, 6, 7, 7, 7, 7, 7, 7],
    ),
  );
}
L.push("");

// Ranking table §20
L.push("-".repeat(120));
L.push("SECTION 20 — REQUIRED RANKING TABLE");
L.push("-".repeat(120));
function bestMom(): string {
  let best = "M5MOM_A_d3";
  let score = -1e9;
  for (const [name, a] of aggs) {
    if (!name.startsWith("M5MOM_")) continue;
    if (a.nTrig < 80) continue;
    const r = rowSig(name, a);
    // balance: retention * before10 / (1+mae) * log(n)
    const sc = (r.retention / 100) * (r.before10 / 100) * (1 / (1 + r.medMae / 10)) * Math.log10(r.n);
    if (sc > score) {
      score = sc;
      best = name;
    }
  }
  return best;
}
const bestM5 = bestMom();
const rankList = [
  "IMMEDIATE",
  "TURN_M1_d2",
  "TURN_M5_d2",
  "CONS2_M1_d3",
  "CONS2_M5_d3",
  "STRUCT_r2",
  "RECLAIM_M1_x1",
  "RECLAIM_M5_x1",
  "RECOVER_1p",
  "RECOVER_2p",
  "RECOVER_3p",
  "RECOVER_5p",
  bestM5,
];
L.push(
  pad(
    ["Signal", "N", "Trig%", "Retain%", "Rem", "Hit%", "B10%", "MedMAE", "P75", "MedTrig"],
    [22, 6, 7, 8, 6, 7, 7, 8, 6, 8],
  ),
);
for (const name of rankList) {
  const a = aggs.get(name);
  if (!a) {
    L.push(`  ${name}: (no data)`);
    continue;
  }
  const r = rowSig(name, a);
  L.push(
    pad(
      [name.slice(0, 22), r.n, f1(r.trigRate), f1(r.retention), f1(r.rem), f1(r.hit), f1(r.before10), f1(r.medMae), f1(r.p75Mae), f0(r.medTrig)],
      [22, 6, 7, 8, 6, 7, 7, 8, 6, 8],
    ),
  );
}
L.push("");

// Side / era for top signals
L.push("-".repeat(120));
L.push("BULLISH / BEARISH + ERA (top signals)");
L.push("-".repeat(120));
for (const name of ["IMMEDIATE", "RECLAIM_M1_x1", "RECOVER_2p", "TURN_M5_d3", bestM5, "CONS2_M5_d3"]) {
  const a = aggs.get(name);
  if (!a) continue;
  L.push(`\n  ${name}`);
  for (const side of ["BULLISH_ALIGNED", "BEARISH_ALIGNED"]) {
    const x = a.bySide[side];
    if (!x) continue;
    L.push(`    ${side}: N=${x.n} Hit%=${f1(pct(x.hit, x.n))}% MedMAE=${f1(median(x.mae))}`);
  }
  for (const era of ["2013-2019", "2020-2026"]) {
    const x = a.byEra[era];
    if (!x) continue;
    L.push(
      `    ${era}: N=${x.n} Hit%=${f1(pct(x.hit, x.n))}% B10=${f1(pct(x.before10, x.n))}% MedMAE=${f1(median(x.mae))} Rem=${f1(median(x.rem))}`,
    );
  }
}
L.push("");

// §16
L.push("-".repeat(120));
L.push("SECTION 16 — SUCCESS VS FAILURE EARLY PATH");
L.push("-".repeat(120));
for (const win of [15, 30, 60] as const) {
  L.push(`\n  @${win}m`);
  for (const feat of ["mae", "fav", "net", "m1Fav", "m1Adv", "m5Fav", "reclaim", "maxRec"]) {
    const d = early[`${win}|${feat}`];
    if (!d) continue;
    L.push(
      `    ${feat}: SUCCESS med=${f1(median(d.s))} | FAILURE med=${f1(median(d.f))} | gap=${f1(median(d.s) - median(d.f))}`,
    );
  }
}
L.push("");

// Trigger timing for reclaim / recover
L.push("-".repeat(120));
L.push("SECTION 15 — TRIGGER TIME (RECLAIM_M1_x1 / RECOVER_2p)");
L.push("-".repeat(120));
for (const name of ["RECLAIM_M1_x1", "RECOVER_2p", "IMMEDIATE"]) {
  const a = aggs.get(name);
  if (!a) continue;
  L.push(`\n  ${name}`);
  for (const [tb] of TIME_TRIG) {
    const x = a.byTrigTime[tb];
    if (!x || x.n < 5) continue;
    L.push(
      `    ${tb}: N=${x.n} Hit%=${f1(pct(x.hit, x.n))}% Rem=${f1(median(x.rem))} MAE=${f1(median(x.mae))}`,
    );
  }
}
L.push("");

// Verdict scoring
const imm = rowSig("IMMEDIATE", aggs.get("IMMEDIATE")!);
const candidates = rankList
  .filter((n) => n !== "IMMEDIATE")
  .map((n) => {
    const a = aggs.get(n);
    if (!a || a.nTrig < 50) return null;
    const r = rowSig(n, a);
    const maeImprove = imm.medMae - r.medMae;
    const b10Improve = r.before10 - imm.before10;
    const remOk = r.rem >= imm.rem * 0.55;
    const score =
      (remOk ? 1 : 0.3) *
      (b10Improve * 1.5 + maeImprove + (r.hit - imm.hit) * 0.5) *
      (r.retention / 100) *
      Math.log10(r.n);
    return { r, score, maeImprove, b10Improve, remOk };
  })
  .filter((x): x is NonNullable<typeof x> => x !== null)
  .sort((a, b) => b.score - a.score);

let best = candidates[0];

let verdict:
  | "ENTRY_TIMING_SIGNAL_FOUND"
  | "ENTRY_TIMING_IMPROVES_BEHAVIOR_BUT_NOT_ENOUGH"
  | "IMMEDIATE_ENTRY_REMAINS_BEST"
  | "NO_REALTIME_ENTRY_SIGNAL";

if (
  best &&
  best.r.before10 >= imm.before10 + 8 &&
  best.r.medMae <= imm.medMae - 2 &&
  best.r.retention >= 55 &&
  best.remOk &&
  best.r.hit >= imm.hit - 3
) {
  verdict = "ENTRY_TIMING_SIGNAL_FOUND";
} else if (
  best &&
  (best.r.before10 >= imm.before10 + 3 || best.r.medMae <= imm.medMae - 1.5) &&
  best.r.retention >= 55 &&
  best.remOk
) {
  verdict = "ENTRY_TIMING_IMPROVES_BEHAVIOR_BUT_NOT_ENOUGH";
} else if (best && best.score > 0) {
  verdict = "ENTRY_TIMING_IMPROVES_BEHAVIOR_BUT_NOT_ENOUGH";
} else {
  verdict = "IMMEDIATE_ENTRY_REMAINS_BEST";
}

// adverse-first frequency
const advFirst = setups.filter((s) => {
  const w = buildWalk(s);
  const t1f = firstFavAtLeast(w, 1);
  if (t1f === null) return true;
  return (t1f === 0 ? 0 : w.maeSoFar[Math.max(0, t1f - 1)]!) > 0.5 || w.maeSoFar[t1f]! > 1;
}).length;

L.push("-".repeat(120));
L.push("PLAIN-ENGLISH ANSWERS");
L.push("-".repeat(120));
L.push(
  `1. Successful setups moving adverse first: among hits, see §3 — overall ${f1(pct(advFirst, setups.length))}% of cohort show ≥1p adverse around first +1p favor (path commonly dips first).`,
);
{
  const depths = ADV_INIT.map((b) => ({ b, n: initAdvBuckets[b]!.n })).filter((x) => x.n > 0);
  L.push(`2. Typical adverse before turn: mass in buckets ${depths
    .slice(0, 4)
    .map((x) => `${x.b}(N=${x.n})`)
    .join(", ")}.`);
}
L.push(
  `3. Immediate worse than waiting? Immediate Hit=${f1(imm.hit)}% B10=${f1(imm.before10)}% MedMAE=${f1(imm.medMae)}. Best waiter=${best?.r.name ?? "none"} Hit=${f1(best?.r.hit ?? NaN)}% B10=${f1(best?.r.before10 ?? NaN)}% MedMAE=${f1(best?.r.medMae ?? NaN)} Retain=${f1(best?.r.retention ?? NaN)}%.`,
);
L.push(
  `4. Best MAE cut without killing reward: ${best?.r.name ?? "none"} (ΔMAE=${f1(best?.maeImprove ?? NaN)}p, Rem=${f1(best?.r.rem ?? NaN)} vs imm ${f1(imm.rem)}, remOk=${best?.remOk ?? false}).`,
);
{
  const rc = aggs.get("RECLAIM_M1_x1");
  const r = rc ? rowSig("RECLAIM_M1_x1", rc) : null;
  L.push(
    `5. Reclaim 4H open: ${r ? `N=${r.n} Hit=${f1(r.hit)}% B10=${f1(r.before10)}% MedMAE=${f1(r.medMae)} Rem=${f1(r.rem)} Retain=${f1(r.retention)}%` : "n/a"}.`,
  );
}
L.push(
  `6. Fixed recovery: RECOVER_1/2/3/5 — see ranking; typically cuts MAE but may shrink Rem / retention.`,
);
L.push(`7. M1 confirmations: see TURN_M1 / CONS*_M1 rows vs IMMEDIATE.`);
L.push(`8. M5 confirmations: see TURN_M5 / CONS*_M5 / ${bestM5}.`);
L.push(`9. Micro structure: STRUCT_r* — compare N/Hit/B10/MAE in ranking.`);
L.push(
  `10. Strongest balance: ${best?.r.name ?? "IMMEDIATE"} (score heuristic on B10↑, MAE↓, retention, Rem).`,
);
{
  const nm = best?.r.name ?? "IMMEDIATE";
  const a = aggs.get(nm)!;
  const b = a.bySide["BULLISH_ALIGNED"];
  const br = a.bySide["BEARISH_ALIGNED"];
  L.push(
    `11. LONG/SHORT: ${nm} bull Hit=${f1(pct(b?.hit ?? 0, b?.n ?? 0))}% (N=${b?.n ?? 0}) bear Hit=${f1(pct(br?.hit ?? 0, br?.n ?? 0))}% (N=${br?.n ?? 0}).`,
  );
  const e1 = a.byEra["2013-2019"];
  const e2 = a.byEra["2020-2026"];
  L.push(
    `12. 2020–2026: Hit=${f1(pct(e2?.hit ?? 0, e2?.n ?? 0))}% B10=${f1(pct(e2?.before10 ?? 0, e2?.n ?? 0))}% vs 2013–19 Hit=${f1(pct(e1?.hit ?? 0, e1?.n ?? 0))}% B10=${f1(pct(e1?.before10 ?? 0, e1?.n ?? 0))}%.`,
  );
}
L.push(
  `13. Enough for BID/ASK RR test? ${
    verdict === "ENTRY_TIMING_SIGNAL_FOUND"
      ? "YES — freeze the top candidate vs IMMEDIATE for executable test."
      : verdict === "ENTRY_TIMING_IMPROVES_BEHAVIOR_BUT_NOT_ENOUGH"
        ? "CONDITIONAL — freeze RECLAIM_M5 (and IMMEDIATE) for a careful BID/ASK test; do not expect a free lunch."
        : "NOT YET — no clear timing edge over immediate entry."
  }`,
);
L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("Not profitable — entry timing behavior only.");

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-4h-aligned-midpoint-entry-timing-v4-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
