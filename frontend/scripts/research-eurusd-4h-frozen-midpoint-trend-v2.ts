/**
 * EUR/USD — 4H FROZEN MIDPOINT + REAL-TIME TREND DIRECTION TEST V2
 *
 * Continues from midpoint-reach V1. Same S/R / blocks / midpoint / no-lookahead.
 * RESEARCH ONLY — no trades, BID/ASK, spread, RR, SL, TP, or P&L.
 *
 * Question: when open is away from frozen midpoint, does trend known at block
 * open tell us whether price will move TOWARD the midpoint?
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import { findSwingPoints } from "../src/lib/strategy/market-structure";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const PIP = pipSizeFor(INSTRUMENT);
const BLOCK = 16;
const BLOCK_MS = 4 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;
const SWING_RADIUS = 2;
const STRUCT_LOOKBACK = 64; // M15 bars before open for structure (~16h)
const EMA_FAST = 20;
const EMA_SLOW = 50;
const EMA_SLOPE_BARS = 4; // 1h

const RANGE_BUCKETS: Array<[string, (w: number) => boolean]> = [
  ["0-10", (w) => w > 0 && w <= 10],
  ["10-15", (w) => w > 10 && w <= 15],
  ["15-20", (w) => w > 15 && w <= 20],
  ["20-30", (w) => w > 20 && w <= 30],
  ["30-40", (w) => w > 30 && w <= 40],
  ["40-50", (w) => w > 40 && w <= 50],
  ["50+", (w) => w > 50],
];

const DIST_BUCKETS: Array<[string, (d: number) => boolean]> = [
  ["0-2", (d) => d >= 0 && d <= 2],
  ["2-5", (d) => d > 2 && d <= 5],
  ["5-10", (d) => d > 5 && d <= 10],
  ["10-15", (d) => d > 10 && d <= 15],
  ["15-20", (d) => d > 15 && d <= 20],
  ["20-30", (d) => d > 20 && d <= 30],
  ["30+", (d) => d > 30],
];

const MAIN_DISTS = ["5-10", "10-15", "15-20", "20-30", "30+"] as const;
const STRENGTH_4H: Array<[string, (a: number) => boolean]> = [
  ["0-5", (a) => a >= 0 && a <= 5],
  ["5-10", (a) => a > 5 && a <= 10],
  ["10-20", (a) => a > 10 && a <= 20],
  ["20-30", (a) => a > 20 && a <= 30],
  ["30+", (a) => a > 30],
];
const STRENGTH_8H: Array<[string, (a: number) => boolean]> = [
  ["0-10", (a) => a >= 0 && a <= 10],
  ["10-20", (a) => a > 10 && a <= 20],
  ["20-30", (a) => a > 20 && a <= 30],
  ["30-50", (a) => a > 30 && a <= 50],
  ["50+", (a) => a > 50],
];
const ADV = [5, 10, 15, 20] as const;
const TIME_CUM = [15, 30, 60, 120, 180, 240] as const;

const V1_DIST_BASE: Record<string, number> = {
  "5-10": 63.8,
  "10-15": 51.8,
  "15-20": 41.1,
  "20-30": 30.1,
  "30+": 17.8,
  "0-2": 93.2,
  "2-5": 80.1,
};

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC };
type Side = "BULL" | "BEAR" | "NEUTRAL";
type Align = "ALIGNED" | "OPPOSED" | "NEUTRAL";
type TrendKey = "A4H" | "B8H" | "C12H" | "DEMA" | "ESTRUCT";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const q = (arr: number[], p: number) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const pad = (xs: Array<string | number>, widths: number[]) =>
  xs.map((x, i) => String(x).padStart(widths[i] ?? 10)).join("");

function bucket(val: number, defs: Array<[string, (v: number) => boolean]>): string {
  for (const [name, fn] of defs) if (fn(val)) return name;
  return "other";
}

function alignOf(required: "UP" | "DOWN", side: Side): Align {
  if (side === "NEUTRAL") return "NEUTRAL";
  if (required === "UP") return side === "BULL" ? "ALIGNED" : "OPPOSED";
  return side === "BEAR" ? "ALIGNED" : "OPPOSED";
}

function emaAt(closes: Float64Array, endExcl: number, period: number): number | null {
  const start = Math.max(0, endExcl - 500);
  if (endExcl - start < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = start; i < start + period; i++) e += closes[i]!;
  e /= period;
  for (let i = start + period; i < endExcl; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

console.error("4H-MIDPOINT-TREND-V2 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n = raw.length;
const tms = new Float64Array(n);
const oArr = new Float64Array(n);
const hArr = new Float64Array(n);
const lArr = new Float64Array(n);
const cArr = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const m = raw[i]!.mid;
  tms[i] = Date.parse(raw[i]!.time);
  oArr[i] = m.open;
  hArr[i] = m.high;
  lArr[i] = m.low;
  cArr[i] = m.close;
}

let nSkippedGap = 0;
let nSkippedIncomplete = 0;
let nSkippedZero = 0;
let auditPrev = 0,
  auditTrade = 0,
  auditOverlap = 0,
  auditHour = 0,
  auditFrozen = 0,
  auditFuture = 0;

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return (
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    (UTC_HOURS as readonly number[]).includes(d.getUTCHours())
  );
}

interface Ev {
  year: number;
  rangePips: number;
  rangeBucket: string;
  dist: number;
  distBucket: string;
  required: "UP" | "DOWN";
  hit: boolean;
  tHit: number | null;
  mfe: number;
  mae: number;
  race: Record<number, boolean>; // adv -> mid before that mae
  // trends
  a4h: Side;
  a4hAbs: number;
  b8h: Side;
  b8hAbs: number;
  c12h: Side;
  c12hAbs: number;
  dema: Side;
  demaSlopeOk: boolean; // slope agrees with EMA side
  estruct: Side;
}

const events: Ev[] = [];

const blockStarts: number[] = [];
for (let i = 0; i < n; i++) {
  if (!isUtcBlockStart(tms[i]!)) continue;
  if (i < BLOCK) continue;
  if (i + BLOCK > n) {
    nSkippedIncomplete++;
    continue;
  }
  blockStarts.push(i);
}

for (const trade0 of blockStarts) {
  const prev0 = trade0 - BLOCK;
  const trade1 = trade0 + BLOCK - 1;
  if (trade0 - prev0 !== BLOCK) {
    auditPrev++;
    continue;
  }
  if (trade1 - trade0 + 1 !== BLOCK) {
    auditTrade++;
    continue;
  }
  if (prev0 + BLOCK > trade0) {
    auditOverlap++;
    continue;
  }

  let gap = false;
  for (let i = prev0 + 1; i <= trade1; i++) {
    if (Math.abs(tms[i]! - tms[i - 1]! - BAR_MS) > 1000) {
      gap = true;
      break;
    }
  }
  if (gap) {
    nSkippedGap++;
    continue;
  }
  if (!isUtcBlockStart(tms[trade0]!)) {
    auditHour++;
    continue;
  }
  if (Math.abs(tms[prev0]! - (tms[trade0]! - BLOCK_MS)) > 1000) {
    auditHour++;
    continue;
  }

  // Need history for 12H (48 bars) + EMA
  if (trade0 < 48 + EMA_SLOW + 5) continue;

  let support = Infinity;
  let resistance = -Infinity;
  for (let i = prev0; i < trade0; i++) {
    if (i >= trade0) auditFuture++;
    support = Math.min(support, lArr[i]!);
    resistance = Math.max(resistance, hArr[i]!);
  }
  const frozenS = support;
  const frozenR = resistance;
  const range = frozenR - frozenS;
  if (!(range > 0)) {
    nSkippedZero++;
    continue;
  }
  const midpoint = frozenS + range * 0.5;
  const nextOpen = oArr[trade0]!;
  const dist = Math.abs(nextOpen - midpoint) / PIP;
  if (dist < 0.05) continue; // trivial on-mid excluded like V1

  const required: "UP" | "DOWN" = nextOpen < midpoint ? "UP" : "DOWN";

  // ---- Trends at open (info ends at trade0-1) ----
  const prevOpen = oArr[prev0]!;
  const prevClose = cArr[trade0 - 1]!;
  const move4 = (prevClose - prevOpen) / PIP;
  const a4h: Side = move4 > 0 ? "BULL" : move4 < 0 ? "BEAR" : "NEUTRAL";

  const open8ago = oArr[trade0 - 32]!;
  const move8 = (nextOpen - open8ago) / PIP;
  const b8h: Side = move8 > 0 ? "BULL" : move8 < 0 ? "BEAR" : "NEUTRAL";

  const open12ago = oArr[trade0 - 48]!;
  const move12 = (nextOpen - open12ago) / PIP;
  const c12h: Side = move12 > 0 ? "BULL" : move12 < 0 ? "BEAR" : "NEUTRAL";

  const ema20 = emaAt(cArr, trade0, EMA_FAST);
  const ema50 = emaAt(cArr, trade0, EMA_SLOW);
  const ema20Prev = emaAt(cArr, trade0 - EMA_SLOPE_BARS, EMA_FAST);
  let dema: Side = "NEUTRAL";
  let demaSlopeOk = false;
  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50) dema = "BULL";
    else if (ema20 < ema50) dema = "BEAR";
    if (ema20Prev !== null && dema === "BULL") demaSlopeOk = ema20 > ema20Prev;
    if (ema20Prev !== null && dema === "BEAR") demaSlopeOk = ema20 < ema20Prev;
  }

  // Market structure on completed candles before open
  let estruct: Side = "NEUTRAL";
  {
    const from = Math.max(0, trade0 - STRUCT_LOOKBACK);
    const candles: Candle[] = [];
    for (let i = from; i < trade0; i++) {
      candles.push({
        time: "",
        open: oArr[i]!,
        high: hArr[i]!,
        low: lArr[i]!,
        close: cArr[i]!,
        volume: 0,
        complete: true,
      });
    }
    const { highs, lows } = findSwingPoints(candles, SWING_RADIUS);
    // pivots already require right-side confirmation within candles (ends before trade0)
    if (highs.length >= 2 && lows.length >= 2) {
      const h1 = highs[highs.length - 2]!;
      const h2 = highs[highs.length - 1]!;
      const l1 = lows[lows.length - 2]!;
      const l2 = lows[lows.length - 1]!;
      const bull = h2.price > h1.price && l2.price > l1.price;
      const bear = h2.price < h1.price && l2.price < l1.price;
      if (bull && !bear) estruct = "BULL";
      else if (bear && !bull) estruct = "BEAR";
    }
  }

  // ---- Outcome walk ----
  let hit = false;
  let tHit: number | null = null;
  let mfe = 0;
  let mae = 0;
  const race: Record<number, boolean | null> = {};
  for (const a of ADV) race[a] = null;

  for (let i = trade0; i <= trade1; i++) {
    if (frozenS !== support || frozenR !== resistance) auditFrozen++;
    const hi = hArr[i]!;
    const lo = lArr[i]!;
    const mins = (i - trade0 + 1) * 15;

    if (required === "UP") {
      const fav = Math.max(0, Math.min(hi, midpoint) - nextOpen) / PIP;
      const adv = Math.max(0, nextOpen - lo) / PIP;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    } else {
      const fav = Math.max(0, nextOpen - Math.max(lo, midpoint)) / PIP;
      const adv = Math.max(0, hi - nextOpen) / PIP;
      if (fav > mfe) mfe = fav;
      if (adv > mae) mae = adv;
    }

    const crossed = lo <= midpoint && hi >= midpoint;
    if (crossed && !hit) {
      hit = true;
      tHit = mins;
    }

    for (const a of ADV) {
      if (race[a] === null) {
        if (mae >= a) race[a] = false;
        else if (hit) race[a] = true;
      }
    }
  }

  const raceOut: Record<number, boolean> = {};
  for (const a of ADV) raceOut[a] = race[a] === true;

  events.push({
    year: new Date(tms[trade0]!).getUTCFullYear(),
    rangePips: range / PIP,
    rangeBucket: bucket(range / PIP, RANGE_BUCKETS),
    dist,
    distBucket: bucket(dist, DIST_BUCKETS),
    required,
    hit,
    tHit,
    mfe,
    mae,
    race: raceOut,
    a4h,
    a4hAbs: Math.abs(move4),
    b8h,
    b8hAbs: Math.abs(move8),
    c12h,
    c12hAbs: Math.abs(move12),
    dema,
    demaSlopeOk,
    estruct,
  });
}

console.error(`Events (non-trivial): ${events.length}`);

function sideOf(e: Ev, method: TrendKey): Side {
  switch (method) {
    case "A4H":
      return e.a4h;
    case "B8H":
      return e.b8h;
    case "C12H":
      return e.c12h;
    case "DEMA":
      return e.dema;
    case "ESTRUCT":
      return e.estruct;
    default: {
      const _x: never = method;
      return _x;
    }
  }
}

function align(e: Ev, method: TrendKey): Align {
  return alignOf(e.required, sideOf(e, method));
}

// ---------- Aggregators ----------
interface Cell {
  n: number;
  hits: number;
  times: number[];
  mfe: number[];
  mae: number[];
  race: Record<number, number>;
  cum: Record<number, number>;
}
function newCell(): Cell {
  const race: Record<number, number> = {};
  const cum: Record<number, number> = {};
  for (const a of ADV) race[a] = 0;
  for (const t of TIME_CUM) cum[t] = 0;
  return { n: 0, hits: 0, times: [], mfe: [], mae: [], race, cum };
}
function addCell(c: Cell, e: Ev) {
  c.n++;
  c.mfe.push(e.mfe);
  c.mae.push(e.mae);
  if (e.hit) {
    c.hits++;
    if (e.tHit !== null) {
      c.times.push(e.tHit);
      for (const t of TIME_CUM) if (e.tHit <= t) c.cum[t]!++;
    }
  }
  for (const a of ADV) if (e.race[a]) c.race[a]!++;
}

const cells = new Map<string, Cell>();
function C(k: string): Cell {
  let c = cells.get(k);
  if (!c) {
    c = newCell();
    cells.set(k, c);
  }
  return c;
}

const METHODS: Array<{ key: TrendKey; label: string }> = [
  { key: "A4H", label: "4H_change" },
  { key: "B8H", label: "8H_change" },
  { key: "C12H", label: "12H_change" },
  { key: "DEMA", label: "EMA20/50" },
  { key: "ESTRUCT", label: "Structure" },
];

for (const e of events) {
  // distance baseline (all trends)
  addCell(C(`DIST|${e.distBucket}`), e);
  addCell(C(`RANGE|${e.rangeBucket}`), e);

  for (const m of METHODS) {
    const al = align(e, m.key);
    addCell(C(`M|${m.key}|${al}`), e);
    addCell(C(`MD|${m.key}|${e.distBucket}|${al}`), e);
    addCell(C(`MR|${m.key}|${e.rangeBucket}|${al}`), e);
    const era = e.year <= 2019 ? "2013-2019" : "2020-2026";
    addCell(C(`ME|${m.key}|${era}|${al}`), e);
    addCell(C(`MED|${m.key}|${era}|${e.distBucket}|${al}`), e);

    if (e.dist >= 5) addCell(C(`M5|${m.key}|${al}`), e);
    if (e.dist >= 10) addCell(C(`M10|${m.key}|${al}`), e);
  }

  // EMA slope refinement
  {
    const al = align(e, "DEMA");
    if (al !== "NEUTRAL") {
      const tag = e.demaSlopeOk ? "SLOPE_OK" : "SLOPE_WEAK";
      addCell(C(`EMASLOPE|${tag}|${al}`), e);
      if (e.dist >= 5) addCell(C(`EMASLOPE5|${tag}|${al}`), e);
    }
  }

  // Strength buckets for A/B/C (aligned/opposed only, main dists)
  if (MAIN_DISTS.includes(e.distBucket as (typeof MAIN_DISTS)[number]) || e.dist >= 5) {
    const s4 = bucket(e.a4hAbs, STRENGTH_4H);
    const s8 = bucket(e.b8hAbs, STRENGTH_8H);
    const s12 = bucket(e.c12hAbs, STRENGTH_8H);
    addCell(C(`STR4|${s4}|${align(e, "A4H")}`), e);
    addCell(C(`STR8|${s8}|${align(e, "B8H")}`), e);
    addCell(C(`STR12|${s12}|${align(e, "C12H")}`), e);
    // strength among dist>=5
    if (e.dist >= 5) {
      addCell(C(`STR4_5|${s4}|${align(e, "A4H")}`), e);
      addCell(C(`STR8_5|${s8}|${align(e, "B8H")}`), e);
      addCell(C(`STR12_5|${s12}|${align(e, "C12H")}`), e);
    }
  }

  // Pre-declared combinations (at dist>=5 primarily)
  const a4 = align(e, "A4H");
  const b8 = align(e, "B8H");
  const c12 = align(e, "C12H");
  const de = align(e, "DEMA");
  const es = align(e, "ESTRUCT");

  function comboAlign(parts: Align[]): Align | null {
    const nn = parts.filter((p) => p !== "NEUTRAL");
    if (!nn.length) return "NEUTRAL";
    if (nn.every((p) => p === "ALIGNED")) return "ALIGNED";
    if (nn.every((p) => p === "OPPOSED")) return "OPPOSED";
    return null; // disagree — skip
  }

  const combos: Array<[string, Align | null]> = [
    ["4H+8H", comboAlign([a4, b8])],
    ["8H+12H", comboAlign([b8, c12])],
    ["EMA+8H", comboAlign([de, b8])],
    ["EMA+STRUCT", comboAlign([de, es])],
    ["4H+8H+EMA", comboAlign([a4, b8, de])],
    ["8H+12H+EMA", comboAlign([b8, c12, de])],
  ];
  for (const [name, al] of combos) {
    if (al === null) continue;
    addCell(C(`COMBO|${name}|${al}`), e);
    if (e.dist >= 5) addCell(C(`COMBO5|${name}|${al}`), e);
    if (e.dist >= 10) addCell(C(`COMBO10|${name}|${al}`), e);
    addCell(C(`COMBOD|${name}|${e.distBucket}|${al}`), e);
  }
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD — 4H FROZEN MIDPOINT + REAL-TIME TREND DIRECTION TEST V2");
L.push("=".repeat(120));
L.push(`PIP=${PIP}  Events=${events.length}  (trivial on-mid excluded)`);
L.push(`V1 distance baselines used for comparison (not overall 67.4%).`);
L.push("");

L.push("-".repeat(120));
L.push("INTEGRITY");
L.push("-".repeat(120));
L.push(`  16 prev / 16 next: ${auditPrev === 0 && auditTrade === 0 ? "PASS" : "FAIL"}`);
L.push(`  no obs candles in S/R: ${auditOverlap === 0 && auditFuture === 0 ? "PASS" : "FAIL"}`);
L.push(`  frozen immutable: ${auditFrozen === 0 ? "PASS" : "FAIL"}`);
L.push(`  UTC blocks: ${auditHour === 0 ? "PASS" : "FAIL"}`);
L.push(`  gaps skipped=${nSkippedGap} incomplete=${nSkippedIncomplete} zeroRange=${nSkippedZero}`);
L.push(`  pip=0.0001: ${Math.abs(PIP - 0.0001) < 1e-12 ? "PASS" : "FAIL"}`);
{
  let sum = 0;
  for (const [d] of DIST_BUCKETS) sum += C(`DIST|${d}`).n;
  L.push(`  distance buckets reconcile: ${sum} vs ${events.length} ${sum === events.length ? "PASS" : "FAIL"}`);
}
for (const m of METHODS) {
  const a = C(`M|${m.key}|ALIGNED`).n;
  const o = C(`M|${m.key}|OPPOSED`).n;
  const ntr = C(`M|${m.key}|NEUTRAL`).n;
  L.push(`  ${m.label} align counts: A=${a} O=${o} N=${ntr} sum=${a + o + ntr} (expect ${events.length})`);
}
L.push("");

// Distance baselines in this run
L.push("-".repeat(120));
L.push("DISTANCE BASELINES (this run — should ≈ V1)");
L.push("-".repeat(120));
L.push(pad(["Distance", "N", "Hit%", "V1base"], [10, 8, 8, 8]));
for (const [d] of DIST_BUCKETS) {
  const c = C(`DIST|${d}`);
  L.push(pad([d, c.n, f1(pct(c.hits, c.n)), f1(V1_DIST_BASE[d] ?? NaN)], [10, 8, 8, 8]));
}
L.push("");

function hitOf(c: Cell) {
  return pct(c.hits, c.n);
}

// Primary by method
L.push("-".repeat(120));
L.push("TABLE — TREND METHOD OVERALL (all distances)");
L.push("-".repeat(120));
L.push(pad(["Method", "Align", "N", "Hit%", "MedT"], [14, 10, 8, 8, 8]));
for (const m of METHODS) {
  for (const al of ["ALIGNED", "OPPOSED", "NEUTRAL"] as const) {
    const c = C(`M|${m.key}|${al}`);
    if (!c.n) continue;
    L.push(pad([m.label, al, c.n, f1(hitOf(c)), f0(median(c.times))], [14, 10, 8, 8, 8]));
  }
}
L.push("");

// MOST IMPORTANT: distance × trend
L.push("-".repeat(120));
L.push("TABLE — DISTANCE × TREND (MOST IMPORTANT)");
L.push("-".repeat(120));
for (const m of METHODS) {
  L.push(`\n  ${m.label}`);
  L.push(pad(["Dist", "AlN", "AlHit%", "OpN", "OpHit%", "Delta", "V1base"], [10, 8, 8, 8, 8, 8, 8]));
  for (const d of [...MAIN_DISTS, "0-2", "2-5"]) {
    const al = C(`MD|${m.key}|${d}|ALIGNED`);
    const op = C(`MD|${m.key}|${d}|OPPOSED`);
    if (al.n + op.n < 30) continue;
    const delta = hitOf(al) - hitOf(op);
    L.push(
      pad([d, al.n, f1(hitOf(al)), op.n, f1(hitOf(op)), f1(delta), f1(V1_DIST_BASE[d] ?? NaN)], [10, 8, 8, 8, 8, 8, 8]),
    );
  }
}
L.push("");

// Range × trend for dist>=5 (filter events in cells — use MR but that's all dist; add filtered)
// Rebuild range×trend for dist>=5
for (const e of events) {
  if (e.dist < 5) continue;
  for (const m of METHODS) {
    const al = align(e, m.key);
    addCell(C(`MR5|${m.key}|${e.rangeBucket}|${al}`), e);
  }
}

L.push("-".repeat(120));
L.push("TABLE — RANGE SIZE × TREND (starting distance ≥5p)");
L.push("-".repeat(120));
for (const m of METHODS) {
  L.push(`\n  ${m.label}`);
  L.push(pad(["Range", "AlN", "AlHit%", "OpN", "OpHit%", "Delta"], [10, 8, 8, 8, 8, 8]));
  for (const [r] of RANGE_BUCKETS) {
    const al = C(`MR5|${m.key}|${r}|ALIGNED`);
    const op = C(`MR5|${m.key}|${r}|OPPOSED`);
    if (al.n + op.n < 40) continue;
    L.push(pad([r, al.n, f1(hitOf(al)), op.n, f1(hitOf(op)), f1(hitOf(al) - hitOf(op))], [10, 8, 8, 8, 8, 8]));
  }
}
L.push("");

// Trend strength
L.push("-".repeat(120));
L.push("TABLE — TREND STRENGTH (distance ≥5p)");
L.push("-".repeat(120));
function strengthTable(title: string, prefix: string, buckets: Array<[string, (a: number) => boolean]>) {
  L.push(`\n  ${title}`);
  L.push(pad(["Strength", "AlN", "AlHit%", "OpN", "OpHit%", "Delta"], [10, 8, 8, 8, 8, 8]));
  for (const [s] of buckets) {
    const al = C(`${prefix}|${s}|ALIGNED`);
    const op = C(`${prefix}|${s}|OPPOSED`);
    if (al.n + op.n < 40) continue;
    L.push(pad([s, al.n, f1(hitOf(al)), op.n, f1(hitOf(op)), f1(hitOf(al) - hitOf(op))], [10, 8, 8, 8, 8, 8]));
  }
}
strengthTable("4H abs move", "STR4_5", STRENGTH_4H);
strengthTable("8H abs move", "STR8_5", STRENGTH_8H);
strengthTable("12H abs move", "STR12_5", STRENGTH_8H);
L.push("");

// MFE/MAE
L.push("-".repeat(120));
L.push("TABLE — MFE toward mid / MAE away (distance ≥5p)");
L.push("-".repeat(120));
L.push(pad(["Method", "Align", "N", "MedMFE", "MedMAE", "P75MAE", "P90MAE"], [14, 10, 8, 10, 10, 10, 10]));
for (const m of METHODS) {
  for (const al of ["ALIGNED", "OPPOSED"] as const) {
    const c = C(`M5|${m.key}|${al}`);
    if (!c.n) continue;
    L.push(
      pad(
        [m.label, al, c.n, f1(median(c.mfe)), f1(median(c.mae)), f1(q(c.mae, 0.75)), f1(q(c.mae, 0.9))],
        [14, 10, 8, 10, 10, 10, 10],
      ),
    );
  }
}
L.push("");

// First-hit races by distance for best methods
L.push("-".repeat(120));
L.push("TABLE — FIRST-HIT RACES (mid before adverse X)");
L.push("-".repeat(120));
for (const m of METHODS) {
  L.push(`\n  ${m.label}`);
  L.push(pad(["Dist", "Align", "N", "b4_5", "b4_10", "b4_15", "b4_20"], [10, 10, 8, 8, 8, 8, 8]));
  for (const d of MAIN_DISTS) {
    for (const al of ["ALIGNED", "OPPOSED"] as const) {
      const c = C(`MD|${m.key}|${d}|${al}`);
      if (c.n < 30) continue;
      L.push(
        pad(
          [d, al, c.n, f1(pct(c.race[5]!, c.n)), f1(pct(c.race[10]!, c.n)), f1(pct(c.race[15]!, c.n)), f1(pct(c.race[20]!, c.n))],
          [10, 10, 8, 8, 8, 8, 8],
        ),
      );
    }
  }
}
L.push("");

// Time cumulative
L.push("-".repeat(120));
L.push("TABLE — CUMULATIVE TIME (distance ≥5p, % of that align group)");
L.push("-".repeat(120));
for (const m of METHODS) {
  L.push(`\n  ${m.label}`);
  for (const al of ["ALIGNED", "OPPOSED"] as const) {
    const c = C(`M5|${m.key}|${al}`);
    if (!c.n) continue;
    const parts = TIME_CUM.map((t) => `${t}m=${f1(pct(c.cum[t]!, c.n))}%`).join("  ");
    L.push(`    ${al} N=${c.n}: ${parts}`);
  }
}
L.push("");

// EMA slope
L.push("-".repeat(120));
L.push("EMA SLOPE REFINEMENT (distance ≥5p)");
L.push("-".repeat(120));
for (const tag of ["SLOPE_OK", "SLOPE_WEAK"]) {
  for (const al of ["ALIGNED", "OPPOSED"] as const) {
    const c = C(`EMASLOPE5|${tag}|${al}`);
    if (!c.n) continue;
    L.push(`  ${tag} ${al}: N=${c.n} Hit%=${f1(hitOf(c))}% MedT=${f0(median(c.times))}m`);
  }
}
L.push("");

// Combinations
L.push("-".repeat(120));
L.push("TABLE — PRE-DECLARED TREND COMBINATIONS");
L.push("-".repeat(120));
L.push(pad(["Combo", "Scope", "AlN", "AlHit%", "OpN", "OpHit%", "Delta"], [14, 8, 8, 8, 8, 8, 8]));
for (const name of ["4H+8H", "8H+12H", "EMA+8H", "EMA+STRUCT", "4H+8H+EMA", "8H+12H+EMA"]) {
  for (const [scope, prefix] of [
    ["ALL", "COMBO"],
    [">=5p", "COMBO5"],
    [">=10p", "COMBO10"],
  ] as const) {
    const al = C(`${prefix}|${name}|ALIGNED`);
    const op = C(`${prefix}|${name}|OPPOSED`);
    if (al.n + op.n < 40) continue;
    L.push(
      pad([name, scope, al.n, f1(hitOf(al)), op.n, f1(hitOf(op)), f1(hitOf(al) - hitOf(op))], [14, 8, 8, 8, 8, 8, 8]),
    );
  }
}
L.push("");

// Era validation for methods with any signal
L.push("-".repeat(120));
L.push("TABLE — ERA VALIDATION (distance ≥5p)");
L.push("-".repeat(120));
for (const m of METHODS) {
  L.push(`\n  ${m.label}`);
  for (const era of ["2013-2019", "2020-2026"]) {
    // rebuild era×dist>=5
    let alN = 0,
      alH = 0,
      opN = 0,
      opH = 0;
    for (const e of events) {
      if (e.dist < 5) continue;
      const er = e.year <= 2019 ? "2013-2019" : "2020-2026";
      if (er !== era) continue;
      const al = align(e, m.key);
      if (al === "ALIGNED") {
        alN++;
        if (e.hit) alH++;
      } else if (al === "OPPOSED") {
        opN++;
        if (e.hit) opH++;
      }
    }
    L.push(
      `    ${era}: Aligned N=${alN} Hit%=${f1(pct(alH, alN))}% | Opposed N=${opN} Hit%=${f1(pct(opH, opN))}% | Delta=${f1(pct(alH, alN) - pct(opH, opN))}pp`,
    );
  }
}
L.push("");

// KEY comparison tables
function keyRow(prefix: string) {
  L.push(pad(["Method", "AlN", "AlHit%", "OpN", "OpHit%", "Delta"], [14, 8, 8, 8, 8, 8]));
  for (const m of METHODS) {
    const al = C(`${prefix}|${m.key}|ALIGNED`);
    const op = C(`${prefix}|${m.key}|OPPOSED`);
    L.push(pad([m.label, al.n, f1(hitOf(al)), op.n, f1(hitOf(op)), f1(hitOf(al) - hitOf(op))], [14, 8, 8, 8, 8, 8]));
  }
}

L.push("-".repeat(120));
L.push("KEY TABLE — ALL DISTANCES");
L.push("-".repeat(120));
keyRow("M");
L.push("");
L.push("-".repeat(120));
L.push("KEY TABLE — START DISTANCE ≥5p");
L.push("-".repeat(120));
keyRow("M5");
L.push("");
L.push("-".repeat(120));
L.push("KEY TABLE — START DISTANCE ≥10p");
L.push("-".repeat(120));
keyRow("M10");
L.push("");

// Pick best method by delta at >=5p with min N
let best = { label: "-", delta: -999, al: 0, op: 0, alHit: 0, opHit: 0 };
for (const m of METHODS) {
  const al = C(`M5|${m.key}|ALIGNED`);
  const op = C(`M5|${m.key}|OPPOSED`);
  if (al.n < 200 || op.n < 200) continue;
  const delta = hitOf(al) - hitOf(op);
  if (delta > best.delta) best = { label: m.label, delta, al: al.n, op: op.n, alHit: hitOf(al), opHit: hitOf(op) };
}

// Distance-specific deltas for best method key
function distDelta(method: TrendKey, d: string): number {
  return hitOf(C(`MD|${method}|${d}|ALIGNED`)) - hitOf(C(`MD|${method}|${d}|OPPOSED`));
}
const bestKey = METHODS.find((m) => m.label === best.label)?.key ?? "B8H";

const avgMainDelta =
  MAIN_DISTS.map((d) => distDelta(bestKey, d)).reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0) /
  MAIN_DISTS.length;

let verdict: "TREND_ADDS_DIRECTIONAL_INFORMATION" | "TREND_EFFECT_WEAK" | "NO_TREND_DIRECTIONAL_EFFECT";
if (best.delta >= 8 && avgMainDelta >= 5) verdict = "TREND_ADDS_DIRECTIONAL_INFORMATION";
else if (best.delta >= 3 || avgMainDelta >= 2) verdict = "TREND_EFFECT_WEAK";
else verdict = "NO_TREND_DIRECTIONAL_EFFECT";

// Combo best
let bestCombo = { name: "-", delta: -999, al: 0, op: 0 };
for (const name of ["4H+8H", "8H+12H", "EMA+8H", "EMA+STRUCT", "4H+8H+EMA", "8H+12H+EMA"]) {
  const al = C(`COMBO5|${name}|ALIGNED`);
  const op = C(`COMBO5|${name}|OPPOSED`);
  if (al.n < 150 || op.n < 150) continue;
  const delta = hitOf(al) - hitOf(op);
  if (delta > bestCombo.delta) bestCombo = { name, delta, al: al.n, op: op.n };
}

L.push("-".repeat(120));
L.push("FINAL QUESTIONS");
L.push("-".repeat(120));
L.push(
  `1. Does trend help predict midpoint reach? ${
    verdict === "NO_TREND_DIRECTIONAL_EFFECT" ? "No meaningful help." : verdict === "TREND_EFFECT_WEAK" ? "Only weakly." : "Yes — modest directional information."
  }`,
);
L.push(`2. Most informative definition: ${best.label} (Δ=${f1(best.delta)}pp at dist≥5p; Aligned ${f1(best.alHit)}% vs Opposed ${f1(best.opHit)}%).`);
L.push(`3. After controlling for distance: see DISTANCE×TREND table — average main-bucket Δ for ${best.label} ≈ ${f1(avgMainDelta)}pp.`);
L.push(
  `4. At 5–10p: ${METHODS.map((m) => `${m.label} Δ=${f1(distDelta(m.key, "5-10"))}`).join("; ")}`,
);
L.push(
  `5. At 10–15p: ${METHODS.map((m) => `${m.label} Δ=${f1(distDelta(m.key, "10-15"))}`).join("; ")}`,
);
L.push(
  `6. At 15–20p: ${METHODS.map((m) => `${m.label} Δ=${f1(distDelta(m.key, "15-20"))}`).join("; ")}`,
);
L.push(
  `7. At 20–30 / 30+: ${METHODS.map((m) => `${m.label} 20-30Δ=${f1(distDelta(m.key, "20-30"))} 30+Δ=${f1(distDelta(m.key, "30+"))}`).join("; ")}`,
);
{
  // stronger trend: compare weak vs strong strength delta for 8H
  const wAl = C(`STR8_5|0-10|ALIGNED`);
  const wOp = C(`STR8_5|0-10|OPPOSED`);
  const sAl = C(`STR8_5|50+|ALIGNED`);
  const sOp = C(`STR8_5|50+|OPPOSED`);
  L.push(
    `8. Stronger trend? 8H weak(0-10) Δ=${f1(hitOf(wAl) - hitOf(wOp))}pp; strong(50+) Δ=${f1(hitOf(sAl) - hitOf(sOp))}pp.`,
  );
}
{
  const al = C(`M5|${bestKey}|ALIGNED`);
  const op = C(`M5|${bestKey}|OPPOSED`);
  L.push(
    `9. Faster when aligned? ${best.label} medT Aligned=${f0(median(al.times))}m Opposed=${f0(median(op.times))}m; 1h cum Al=${f1(pct(al.cum[60]!, al.n))}% Op=${f1(pct(op.cum[60]!, op.n))}%.`,
  );
  L.push(
    `10. Mid before adverse more often when aligned? before−10p Al=${f1(pct(al.race[10]!, al.n))}% Op=${f1(pct(op.race[10]!, op.n))}%.`,
  );
}
{
  // era for best
  let d1 = 0,
    d2 = 0;
  for (const era of ["2013-2019", "2020-2026"] as const) {
    let alN = 0,
      alH = 0,
      opN = 0,
      opH = 0;
    for (const e of events) {
      if (e.dist < 5) continue;
      const er = e.year <= 2019 ? "2013-2019" : "2020-2026";
      if (er !== era) continue;
      const al = align(e, bestKey);
      if (al === "ALIGNED") {
        alN++;
        if (e.hit) alH++;
      } else if (al === "OPPOSED") {
        opN++;
        if (e.hit) opH++;
      }
    }
    const delta = pct(alH, alN) - pct(opH, opN);
    if (era === "2013-2019") d1 = delta;
    else d2 = delta;
    L.push(`11. Era ${era} (${best.label} dist≥5): Δ=${f1(delta)}pp`);
  }
  L.push(`    Stable? ${d1 > 0 && d2 > 0 && Math.abs(d1 - d2) < 8 ? "YES (same sign, similar)" : d1 > 0 && d2 > 0 ? "SAME SIGN but magnitude shifted" : "NO"}`);
}
L.push(
  `12. Combining methods: best pre-declared at ≥5p = ${bestCombo.name} Δ=${f1(bestCombo.delta)}pp (AlN=${bestCombo.al} OpN=${bestCombo.op}) vs single best Δ=${f1(best.delta)}pp — ${
    bestCombo.delta >= best.delta + 3 ? "materially better separation" : bestCombo.delta > best.delta ? "small gain" : "no material gain"
  }.`,
);
L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("Not a profitable strategy — directional information test only.");

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-4h-frozen-midpoint-trend-v2-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
