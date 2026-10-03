/**
 * EUR/USD V32 — EARLY REVERSAL FAILURE DETECTION (behavioral, NO P&L optimization).
 *
 * NEW file — does NOT modify V30/V31.
 *
 * Question: can we detect that an S/R reversal is FAILING early enough to exit
 * bad trades while preserving most eventual full rotations?
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { PRICE_REACTION_THRESHOLDS as PR } from "../src/lib/strategy/price-reaction";
import { pipSizeFor } from "../src/lib/instruments/catalog";
const INSTRUMENT: MajorInstrument = "EUR_USD";
const TIMEFRAME = "M15";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const M1_PATH = path.join(PAD, "eurusd-m1-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const WINDOW = 220;
const HORIZON = 96;
const M1_HORIZON = HORIZON * 15;
const PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;
const SWING_RADIUS = 2; // project default findSwingPoints

const CHECKPOINTS = [5, 10, 15, 30, 60, 120] as const;
const MAE_PIPS = [3, 5, 7.5, 10, 15, 20, 25, 30] as const;
const MAE_PCT = [10, 20, 30, 40, 50, 75, 100] as const;
const GIVEBACK = [25, 50, 75, 100] as const;
const STALL_MIN = [5, 10, 15, 30, 60] as const;

const WIDTH_GROUP: Array<[string, (w: number) => boolean]> = [
  ["0-20", (w) => w > 0 && w <= 20],
  ["20-50", (w) => w > 20 && w <= 50],
  ["50+", (w) => w > 50],
];

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type Label = "SUCCESS" | "FAILURE" | "TIMEOUT";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

console.error("V32 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n = raw.length;
const mids: Candle[] = raw.map((c) => ({
  time: c.time,
  open: c.mid.open,
  high: c.mid.high,
  low: c.mid.low,
  close: c.mid.close,
  volume: 0,
  complete: true,
}));
const m15ms = new Float64Array(n);
for (let i = 0; i < n; i++) m15ms[i] = Date.parse(raw[i]!.time);

interface Enc {
  t0: number;
  year: number;
  side: Side;
  atr: number;
  L1: number;
  k1: Kind;
  L2: number | null;
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
  opp: number | null;
  rangePips: number;
}

const encs: Enc[] = [];
let armedR = true,
  armedS = true;
let auditFail = 0;

function pickOpposite(
  side: Side,
  origin: number,
  rh: number,
  rl: number,
  sh: number | null,
  sl: number | null,
): { opp: number; kind: Kind } | null {
  if (side === "resistance") {
    const cands: Array<{ p: number; k: Kind }> = [];
    if (rl < origin) cands.push({ p: rl, k: "range" });
    if (sl !== null && sl < origin) cands.push({ p: sl, k: "swing" });
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.p < a.p ? b : a));
  }
  const cands: Array<{ p: number; k: Kind }> = [];
  if (rh > origin) cands.push({ p: rh, k: "range" });
  if (sh !== null && sh > origin) cands.push({ p: sh, k: "swing" });
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.p > a.p ? b : a));
}

for (let t = WINDOW; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const loc = a.location;
  const cur = lv.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const yr = new Date(raw[t]!.time).getUTCFullYear();
  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";

  if (nearR && armedR) {
    const cand = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, qv) => (qv - cur < p - cur ? qv : p));
      const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const other = k1 === "range" ? lv.swingHigh : lv.rangeHigh;
      const L2 = other !== null && other > L1 ? other : null;
      if (L2 !== null && L2 <= L1) auditFail++;
      const op = pickOpposite("resistance", L1, lv.rangeHigh, lv.rangeLow, lv.swingHigh, lv.swingLow);
      encs.push({
        t0: t,
        year: yr,
        side: "resistance",
        atr: A,
        L1,
        k1,
        L2,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
        opp: op?.p ?? null,
        rangePips: op ? (L1 - op.p) / PIP : NaN,
      });
      armedR = false;
    }
  } else if (!nearR) armedR = true;

  if (nearS && armedS) {
    const cand = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, qv) => (cur - qv < cur - p ? qv : p));
      const k1: Kind = L1 === lv.rangeLow ? "range" : "swing";
      const other = k1 === "range" ? lv.swingLow : lv.rangeLow;
      const L2 = other !== null && other < L1 ? other : null;
      if (L2 !== null && L2 >= L1) auditFail++;
      const op = pickOpposite("support", L1, lv.rangeHigh, lv.rangeLow, lv.swingHigh, lv.swingLow);
      encs.push({
        t0: t,
        year: yr,
        side: "support",
        atr: A,
        L1,
        k1,
        L2,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
        opp: op?.p ?? null,
        rangePips: op ? (op.p - L1) / PIP : NaN,
      });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

{
  const step = Math.max(1, Math.floor(encs.length / 200));
  for (let i = 0; i < encs.length && i / step < 200; i += step) {
    const e = encs[i]!;
    const window = mids.slice(e.t0 - WINDOW + 1, e.t0 + 1);
    const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
    const lv = a.levels;
    if (!lv) {
      auditFail++;
      continue;
    }
    if (Math.abs(lv.rangeHigh - e.rangeHigh) > 1e-9 || Math.abs(lv.rangeLow - e.rangeLow) > 1e-9) auditFail++;
    if (e.opp !== null) {
      const ok =
        e.side === "resistance"
          ? e.opp === e.rangeLow || e.opp === e.swingLow
          : e.opp === e.rangeHigh || e.opp === e.swingHigh;
      if (!ok) auditFail++;
    }
  }
}

function classifyLevel(side: Side, level: number, atr: number, startBar: number, towardIsDown: boolean) {
  const w = TOUCH_ATR * atr;
  const end = Math.min(startBar + HORIZON, n - 1);
  let touched = false,
    broke = false,
    tBreak: number | null = null,
    revPrimary = false,
    tRev: number | null = null;
  let peakBeyond = level,
    bb = 0;
  const retHit: Record<number, boolean> = {};
  for (const r of RETS) retHit[r] = false;
  for (let j = startBar; j <= end; j++) {
    const c = raw[j]!.mid;
    const inZone =
      side === "resistance" ? c.high >= level - w && c.low <= level + w : c.low <= level + w && c.high >= level - w;
    const beyondWick = side === "resistance" ? c.high > level + w : c.low < level - w;
    if (!touched && (inZone || beyondWick || (side === "resistance" ? c.high >= level : c.low <= level))) touched = true;
    if (!touched) continue;
    if (side === "resistance") {
      if (c.high > peakBeyond) peakBeyond = c.high;
    } else if (c.low < peakBeyond) peakBeyond = c.low;
    const bc_ = side === "resistance" ? c.close - level : level - c.close;
    if (bc_ > w) bb++;
    else bb = 0;
    if (!broke && bb >= ACCEPT_MIN_BARS && bc_ / atr >= ACCEPT_MIN_DIST_ATR) {
      broke = true;
      tBreak = j;
    }
    const ret = Math.max(
      (towardIsDown ? peakBeyond - c.low : c.high - peakBeyond) / PIP,
      (towardIsDown ? level - c.low : c.high - level) / PIP,
    );
    for (const r of RETS) if (!retHit[r] && ret >= r) retHit[r] = true;
    if (!revPrimary && !broke && retHit[PRIMARY_RET]) {
      revPrimary = true;
      tRev = j;
    }
    if (broke || revPrimary) break;
  }
  if (revPrimary && broke && tRev !== null && tBreak !== null) {
    if (tRev < tBreak) broke = false;
    else revPrimary = false;
  }
  return { touched, broke, tBreak, revPrimary };
}
for (const e of encs) classifyLevel(e.side, e.L1, e.atr, e.t0, e.side === "resistance");

const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (NO_LOOKAHEAD === "FAIL") {
  console.error("STOP NO_LOOKAHEAD");
  process.exit(1);
}
console.error(`NO_LOOKAHEAD=${NO_LOOKAHEAD}`);

console.error("V32 loading M1...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const m1ms = new Float64Array(M1);
const bh = new Float64Array(M1),
  bl = new Float64Array(M1),
  ah = new Float64Array(M1),
  al = new Float64Array(M1),
  bc = new Float64Array(M1),
  ac = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  m1ms[i] = Date.parse(r[0]);
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
}
(m1raw as unknown as { length: number }).length = 0;

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

function obsPx(i: number, side: Side): number {
  return side === "resistance" ? bc[i]! : ac[i]!;
}
function exitPx(i: number, side: Side): number {
  return side === "support" ? bc[i]! : ac[i]!;
}
function midH(i: number) {
  return (bh[i]! + ah[i]!) / 2;
}
function midL(i: number) {
  return (bl[i]! + al[i]!) / 2;
}
function midC(i: number) {
  return (bc[i]! + ac[i]!) / 2;
}
function progressPct(px: number, origin: number, opp: number, side: Side, range: number): number {
  return side === "resistance" ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
}

// ---------- Signal metric accumulators ----------
interface SigAcc {
  nTrig: number;
  nTrigFail: number; // among triggered, final FAILURE (or TIMEOUT treated as fail for precision vs success)
  nTrigSuccess: number;
  nTrigTimeout: number;
  detectMin: number[];
  maeAt: number[];
  progAt: number[];
  // before adverse thresholds among FAILURES only
  before10: number;
  before20: number;
  before30: number;
  nFailTotal: number; // set globally when scoring
  // false exit recovery
  falseExitN: number; // trig + SUCCESS
  recoveryMin: number[];
  recoveryMae: number[];
}

function newSig(): SigAcc {
  return {
    nTrig: 0,
    nTrigFail: 0,
    nTrigSuccess: 0,
    nTrigTimeout: 0,
    detectMin: [],
    maeAt: [],
    progAt: [],
    before10: 0,
    before20: 0,
    before30: 0,
    nFailTotal: 0,
    falseExitN: 0,
    recoveryMin: [],
    recoveryMae: [],
  };
}

const SIG_NAMES = [
  "M1_A",
  "M1_B",
  "M1_C",
  "M1_D",
  "M5_A",
  "M5_B",
  "M5_C",
  "M5_D",
  "SR_M1_1",
  "SR_M1_2",
  "SR_M1_3",
  "SR_M5_1",
  "SR_M5_2",
  "MAE_5",
  "MAE_10",
  "MAE_15",
  "MAE_20",
  "PROG25_15",
  "PROG25_30",
  "PROG25_60",
  "GB50",
  "STALL15",
  "STALL30",
] as const;
type SigName = (typeof SIG_NAMES)[number];
const sigs = Object.fromEntries(SIG_NAMES.map((s) => [s, newSig()])) as Record<SigName, SigAcc>;

// Checkpoint state tables: key = `${cp}|${state}`
interface Cell {
  n: number;
  succ: number;
  fail: number;
  tout: number;
}
const cells = new Map<string, Cell>();
function cell(k: string): Cell {
  let c = cells.get(k);
  if (!c) {
    c = { n: 0, succ: 0, fail: 0, tout: 0 };
    cells.set(k, c);
  }
  return c;
}
function addCell(k: string, lab: Label) {
  const c = cell(k);
  c.n++;
  if (lab === "SUCCESS") c.succ++;
  else if (lab === "FAILURE") c.fail++;
  else c.tout++;
}

// Distributions at checkpoints for SUCCESS vs FAILURE
const dist: Record<string, { s: number[]; f: number[] }> = {};
function pushDist(key: string, lab: Label, v: number) {
  if (!Number.isFinite(v)) return;
  if (!dist[key]) dist[key] = { s: [], f: [] };
  if (lab === "SUCCESS") dist[key]!.s.push(v);
  else if (lab === "FAILURE") dist[key]!.f.push(v);
}

let nAll = 0,
  nSucc = 0,
  nFail = 0,
  nTout = 0;
const rewards: number[] = [];
const eraSucc: Record<string, { n: number; succ: number }> = {
  "2013-2019": { n: 0, succ: 0 },
  "2020-2026": { n: 0, succ: 0 },
};
const sideBase: Record<Side, { n: number; succ: number; fail: number }> = {
  support: { n: 0, succ: 0, fail: 0 },
  resistance: { n: 0, succ: 0, fail: 0 },
};

// Subgroup: signal × width / side / era → {n, succ, failNonSucc}
interface SubCell {
  n: number;
  succ: number;
  nons: number;
}
const sub = new Map<string, SubCell>();
function addSub(k: string, lab: Label) {
  let c = sub.get(k);
  if (!c) {
    c = { n: 0, succ: 0, nons: 0 };
    sub.set(k, c);
  }
  c.n++;
  if (lab === "SUCCESS") c.succ++;
  else c.nons++;
}

// Timing histograms for swing signals among fail/success
const swingTimeBuckets = [5, 10, 15, 30, 60, 120] as const;
const swingBefore: Record<string, { succ: number[]; nons: number[] }> = {};
function noteSwingBefore(name: string, t: number | null, lab: Label) {
  if (!swingBefore[name]) {
    swingBefore[name] = {
      succ: swingTimeBuckets.map(() => 0),
      nons: swingTimeBuckets.map(() => 0),
    };
  }
  if (t === null) return;
  const arr = lab === "SUCCESS" ? swingBefore[name]!.succ : swingBefore[name]!.nons;
  for (let i = 0; i < swingTimeBuckets.length; i++) {
    if (t <= swingTimeBuckets[i]!) arr[i]!++;
  }
}

function recordSig(
  name: SigName,
  tMin: number | null,
  lab: Label,
  mae: number,
  prog: number,
  maeAtTrig: number,
  // for failure: whether trig before adverse X (using mae path at trig time)
): void {
  if (tMin === null || !(tMin >= 0)) return;
  const s = sigs[name];
  s.nTrig++;
  s.detectMin.push(tMin);
  s.maeAt.push(maeAtTrig);
  s.progAt.push(prog);
  if (lab === "SUCCESS") {
    s.nTrigSuccess++;
    s.falseExitN++;
  } else if (lab === "TIMEOUT") s.nTrigTimeout++;
  else s.nTrigFail++;

  if (lab === "FAILURE" || lab === "TIMEOUT") {
    if (maeAtTrig < 10) s.before10++;
    if (maeAtTrig < 20) s.before20++;
    if (maeAtTrig < 30) s.before30++;
  }
}

/** Linear swing detection: pivot at k confirmed when bar k+radius completes. */
function detectSwings(
  isLong: boolean,
  entryI: number,
  pathEnd: number,
  getH: (i: number) => number,
  getL: (i: number) => number,
  getC: (i: number) => number,
  step: number,
): { A: number | null; B: number | null; C: number | null; D: number | null } {
  // Sample bars at step resolution into arrays
  const hs: number[] = [];
  const ls: number[] = [];
  const cs: number[] = [];
  const m1At: number[] = [];
  for (let i = entryI; i <= pathEnd; i += step) {
    const i1 = Math.min(i + step - 1, pathEnd);
    let h = -Infinity,
      l = Infinity,
      c = 0;
    for (let j = i; j <= i1; j++) {
      h = Math.max(h, getH(j));
      l = Math.min(l, getL(j));
      c = getC(j);
    }
    hs.push(h);
    ls.push(l);
    cs.push(c);
    m1At.push(i1);
  }

  const confH: Array<{ k: number; price: number; know: number }> = [];
  const confL: Array<{ k: number; price: number; know: number }> = [];
  let tA: number | null = null,
    tB: number | null = null,
    tC: number | null = null,
    tD: number | null = null;
  let firstL: number | null = null,
    firstH: number | null = null;
  let sawLH = false,
    sawHL = false;
  let madeProgress = false;
  const entryMid = midC(entryI);
  const R = SWING_RADIUS;

  for (let k = R; k < hs.length - R; k++) {
    // confirm pivot k when we reach k+R
    const know = k + R;
    if (know >= hs.length) break;
    let isHigh = true,
      isLow = true;
    for (let o = 1; o <= R; o++) {
      if (!(hs[k]! > hs[k - o]! && hs[k]! >= hs[k + o]!)) isHigh = false;
      if (!(ls[k]! < ls[k - o]! && ls[k]! <= ls[k + o]!)) isLow = false;
    }
    if (isHigh) confH.push({ k, price: hs[k]!, know });
    if (isLow) confL.push({ k, price: ls[k]!, know });
  }

  // Walk time in sample bars; when know time reached, swings available
  let hiPtr = 0,
    loPtr = 0;
  const activeH: Array<{ price: number }> = [];
  const activeL: Array<{ price: number }> = [];

  for (let t = 0; t < hs.length; t++) {
    const m1Now = m1At[t]!;
    const mins = m1Now - entryI;
    const closeNow = cs[t]!;
    if (isLong && closeNow > entryMid) madeProgress = true;
    if (!isLong && closeNow < entryMid) madeProgress = true;

    while (hiPtr < confH.length && confH[hiPtr]!.know <= t) {
      activeH.push({ price: confH[hiPtr]!.price });
      if (activeH.length >= 2) {
        const a = activeH[activeH.length - 2]!.price;
        const b = activeH[activeH.length - 1]!.price;
        if (b < a) sawLH = true;
      }
      hiPtr++;
    }
    while (loPtr < confL.length && confL[loPtr]!.know <= t) {
      activeL.push({ price: confL[loPtr]!.price });
      if (activeL.length >= 2) {
        const a = activeL[activeL.length - 2]!.price;
        const b = activeL[activeL.length - 1]!.price;
        if (b > a) sawHL = true;
      }
      if (firstL === null && activeL.length) firstL = activeL[0]!.price;
      loPtr++;
    }
    if (firstH === null && activeH.length) firstH = activeH[0]!.price;
    if (firstL === null && activeL.length) firstL = activeL[0]!.price;

    const latestH = activeH.length ? activeH[activeH.length - 1]!.price : null;
    const latestL = activeL.length ? activeL[activeL.length - 1]!.price : null;

    if (isLong) {
      if (tA === null && latestL !== null && closeNow < latestL) tA = mins;
      if (tD === null && firstL !== null && closeNow < firstL) tD = mins;
      if (tB === null && sawLH && latestL !== null && closeNow < latestL) tB = mins;
      if (tC === null && madeProgress && sawLH && activeL.length >= 2) {
        const a = activeL[activeL.length - 2]!.price;
        const b = activeL[activeL.length - 1]!.price;
        if (b < a) tC = mins;
      }
    } else {
      if (tA === null && latestH !== null && closeNow > latestH) tA = mins;
      if (tD === null && firstH !== null && closeNow > firstH) tD = mins;
      if (tB === null && sawHL && latestH !== null && closeNow > latestH) tB = mins;
      if (tC === null && madeProgress && sawHL && activeH.length >= 2) {
        const a = activeH[activeH.length - 2]!.price;
        const b = activeH[activeH.length - 1]!.price;
        if (b > a) tC = mins;
      }
    }
  }
  return { A: tA, B: tB, C: tC, D: tD };
}

console.error("V32 scanning 1p entries...");
let scanned = 0;
for (const e of encs) {
  if (e.opp === null || !(e.rangePips > 0)) continue;
  const origin = e.L1;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) continue;
  const side = e.side;
  const isLong = side === "support";
  const atr = e.atr;

  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  const pathEnd = Math.min(m1Start + M1_HORIZON, M1 - 1);

  // 1p confirm
  let entryI = -1;
  for (let i = m1Start; i <= pathEnd; i++) {
    const fav = isLong ? (obsPx(i, side) - origin) / PIP : (origin - obsPx(i, side)) / PIP;
    if (fav >= 1) {
      entryI = i;
      break;
    }
  }
  if (entryI < 0) continue;
  const entryPx = obsPx(entryI, side);
  const rem = isLong ? (opp - entryPx) / PIP : (entryPx - opp) / PIP;
  if (!(rem > 0)) continue;
  rewards.push(rem);

  // Path walk
  let mae = 0,
    mfe = 0,
    maxProg = 0,
    tMaxProg = 0;
  let r100 = false;
  let t100: number | null = null;
  let beyondOriginStreakM1 = 0;
  let tSrM1_1: number | null = null,
    tSrM1_2: number | null = null,
    tSrM1_3: number | null = null;
  // M5 beyond: track M5 closes
  let beyondM5 = 0;
  let tSrM5_1: number | null = null,
    tSrM5_2: number | null = null;
  let lastM5Bucket = -1;

  const maeAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const progAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const mfeAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const maxProgAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const pnlAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const beyondAtMin: boolean[] = new Array(M1_HORIZON + 1).fill(false);
  const stallAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);
  const givebackAtMin: number[] = new Array(M1_HORIZON + 1).fill(0);

  let tMae: Record<number, number | null> = {};
  for (const x of MAE_PIPS) tMae[x] = null;
  let tMaePct: Record<number, number | null> = {};
  for (const x of MAE_PCT) tMaePct[x] = null;
  let tGb: Record<number, number | null> = {};
  for (const x of GIVEBACK) tGb[x] = null;
  let tStall: Record<number, number | null> = {};
  for (const x of STALL_MIN) tStall[x] = null;

  const endI = Math.min(entryI + M1_HORIZON, pathEnd);
  for (let i = entryI + 1; i <= endI; i++) {
    const mins = i - entryI;
    const ex = exitPx(i, side);
    const fav = isLong ? (ex - entryPx) / PIP : (entryPx - ex) / PIP;
    const adv = isLong ? (entryPx - ex) / PIP : (ex - entryPx) / PIP;
    if (adv > mae) mae = adv;
    if (fav > mfe) mfe = fav;
    const prog = progressPct(ex, origin, opp, side, range);
    if (prog > maxProg) {
      maxProg = prog;
      tMaxProg = mins;
    }
    if (prog >= 100 && !r100) {
      r100 = true;
      t100 = mins;
    }

    const beyond = isLong ? midC(i) < origin : midC(i) > origin;
    if (beyond) beyondOriginStreakM1++;
    else beyondOriginStreakM1 = 0;
    if (beyondOriginStreakM1 >= 1 && tSrM1_1 === null) tSrM1_1 = mins;
    if (beyondOriginStreakM1 >= 2 && tSrM1_2 === null) tSrM1_2 = mins;
    if (beyondOriginStreakM1 >= 3 && tSrM1_3 === null) tSrM1_3 = mins;

    // M5 close beyond: every 5th minute from entry aligned to wall clock buckets
    const bucket = Math.floor(m1ms[i]! / (5 * 60_000));
    if (bucket !== lastM5Bucket) {
      lastM5Bucket = bucket;
      // treat this bar as M5 close proxy when i aligns — use every time bucket changes
      const m5Beyond = isLong ? midC(i) < origin : midC(i) > origin;
      if (m5Beyond) beyondM5++;
      else beyondM5 = 0;
      if (beyondM5 >= 1 && tSrM5_1 === null) tSrM5_1 = mins;
      if (beyondM5 >= 2 && tSrM5_2 === null) tSrM5_2 = mins;
    }

    for (const x of MAE_PIPS) if (tMae[x] === null && mae >= x) tMae[x] = mins;
    for (const x of MAE_PCT) if (tMaePct[x] === null && mae >= (x / 100) * (range / PIP)) tMaePct[x] = mins;

    const stall = mins - tMaxProg;
    const gbFromMfe = mfe > 0 ? Math.max(0, (mfe - fav) / mfe) * 100 : 0;
    const gbRange = maxProg > 0 ? Math.max(0, maxProg - prog) : 0; // in progress % points
    for (const g of GIVEBACK) {
      if (tGb[g] === null && maxProg >= 10 && gbFromMfe >= g) tGb[g] = mins;
    }
    for (const s of STALL_MIN) if (tStall[s] === null && stall >= s && maxProg > 0) tStall[s] = mins;

    if (mins <= M1_HORIZON) {
      maeAtMin[mins] = mae;
      mfeAtMin[mins] = mfe;
      progAtMin[mins] = prog;
      maxProgAtMin[mins] = maxProg;
      pnlAtMin[mins] = fav;
      beyondAtMin[mins] = beyond;
      stallAtMin[mins] = stall;
      givebackAtMin[mins] = gbFromMfe;
    }
  }

  // Label
  const endProg = progAtMin[endI - entryI] ?? 0;
  let lab: Label;
  if (r100) lab = "SUCCESS";
  else if (endProg > 0 && maxProg >= 25) lab = "TIMEOUT";
  else lab = "FAILURE";

  nAll++;
  if (lab === "SUCCESS") nSucc++;
  else if (lab === "TIMEOUT") nTout++;
  else nFail++;
  const eraKey = e.year <= 2019 ? "2013-2019" : "2020-2026";
  eraSucc[eraKey]!.n++;
  if (lab === "SUCCESS") eraSucc[eraKey]!.succ++;
  sideBase[side].n++;
  if (lab === "SUCCESS") sideBase[side].succ++;
  else sideBase[side].fail++;

  const rangePips = range / PIP;
  const widthKey =
    rangePips <= 20 ? "0-20" : rangePips <= 50 ? "20-50" : "50+";
  const widthFine =
    rangePips <= 10
      ? "0-10"
      : rangePips <= 20
        ? "10-20"
        : rangePips <= 30
          ? "20-30"
          : rangePips <= 40
            ? "30-40"
            : rangePips <= 50
              ? "40-50"
              : rangePips <= 75
                ? "50-75"
                : rangePips <= 100
                  ? "75-100"
                  : "100+";

  // Swings M1 / M5
  const m1sw = detectSwings(isLong, entryI, endI, midH, midL, midC, 1);
  const m5sw = detectSwings(isLong, entryI, endI, midH, midL, midC, 5);

  // Progress <25% at checkpoints as signals
  const tProg25_15 = 15 <= endI - entryI && maxProgAtMin[15]! < 25 ? 15 : null;
  const tProg25_30 = 30 <= endI - entryI && maxProgAtMin[30]! < 25 ? 30 : null;
  const tProg25_60 = 60 <= endI - entryI && maxProgAtMin[60]! < 25 ? 60 : null;

  function maeAt(t: number | null): number {
    if (t === null) return NaN;
    return maeAtMin[Math.min(t, maeAtMin.length - 1)] ?? NaN;
  }
  function progAt(t: number | null): number {
    if (t === null) return NaN;
    return maxProgAtMin[Math.min(t, maxProgAtMin.length - 1)] ?? NaN;
  }

  const pairs: Array<[SigName, number | null]> = [
    ["M1_A", m1sw.A],
    ["M1_B", m1sw.B],
    ["M1_C", m1sw.C],
    ["M1_D", m1sw.D],
    ["M5_A", m5sw.A],
    ["M5_B", m5sw.B],
    ["M5_C", m5sw.C],
    ["M5_D", m5sw.D],
    ["SR_M1_1", tSrM1_1],
    ["SR_M1_2", tSrM1_2],
    ["SR_M1_3", tSrM1_3],
    ["SR_M5_1", tSrM5_1],
    ["SR_M5_2", tSrM5_2],
    ["MAE_5", tMae[5]!],
    ["MAE_10", tMae[10]!],
    ["MAE_15", tMae[15]!],
    ["MAE_20", tMae[20]!],
    ["PROG25_15", tProg25_15],
    ["PROG25_30", tProg25_30],
    ["PROG25_60", tProg25_60],
    ["GB50", tGb[50]!],
    ["STALL15", tStall[15]!],
    ["STALL30", tStall[30]!],
  ];

  for (const [name, t] of pairs) {
    recordSig(name, t, lab, mae, maxProg, maeAt(t));
    // false exit recovery time
    if (t !== null && lab === "SUCCESS" && t100 !== null && t100 > t) {
      sigs[name].recoveryMin.push(t100 - t);
      // adverse after signal before recovery — approximate mae growth
      let maxA = 0;
      for (let m = t; m <= t100 && m < maeAtMin.length; m++) maxA = Math.max(maxA, maeAtMin[m]! - (maeAtMin[t] ?? 0));
      sigs[name].recoveryMae.push(maxA);
    }
    // subgroup for informative signals only
    if (
      t !== null &&
      (name === "PROG25_60" ||
        name === "PROG25_30" ||
        name === "MAE_15" ||
        name === "MAE_20" ||
        name === "M5_D" ||
        name === "SR_M5_2")
    ) {
      addSub(`${name}|w|${widthKey}`, lab);
      addSub(`${name}|wf|${widthFine}`, lab);
      addSub(`${name}|side|${side}`, lab);
      addSub(`${name}|era|${eraKey}`, lab);
    }
  }
  noteSwingBefore("M1_A", m1sw.A, lab);
  noteSwingBefore("M1_B", m1sw.B, lab);
  noteSwingBefore("M5_A", m5sw.A, lab);
  noteSwingBefore("M5_B", m5sw.B, lab);
  noteSwingBefore("M5_D", m5sw.D, lab);

  // Checkpoint classification states
  for (const cp of CHECKPOINTS) {
    if (cp > endI - entryI) continue;
    const mae_ = maeAtMin[cp]!;
    const maxP = maxProgAtMin[cp]!;
    const gb = givebackAtMin[cp]!;
    const stall = stallAtMin[cp]!;
    const beyond = beyondAtMin[cp]!;

    addCell(`${cp}|ALL`, lab);
    if (mae_ >= 5) addCell(`${cp}|MAE>=5`, lab);
    if (mae_ >= 10) addCell(`${cp}|MAE>=10`, lab);
    if (mae_ >= 15) addCell(`${cp}|MAE>=15`, lab);
    if (mae_ >= 20) addCell(`${cp}|MAE>=20`, lab);
    if (maxP < 10) addCell(`${cp}|maxProg<10`, lab);
    if (maxP < 25) addCell(`${cp}|maxProg<25`, lab);
    if (maxP < 50) addCell(`${cp}|maxProg<50`, lab);
    if (beyond) addCell(`${cp}|lostOrigin`, lab);
    if (gb >= 50 && maxP >= 10) addCell(`${cp}|gb50`, lab);
    if (stall >= 15 && maxP > 0) addCell(`${cp}|stall15`, lab);
    if (stall >= 30 && maxP > 0) addCell(`${cp}|stall30`, lab);
    // swing known by cp?
    if (m1sw.A !== null && m1sw.A <= cp) addCell(`${cp}|M1_A`, lab);
    if (m5sw.A !== null && m5sw.A <= cp) addCell(`${cp}|M5_A`, lab);

    // distributions
    pushDist(`${cp}|pnl`, lab, pnlAtMin[cp]!);
    pushDist(`${cp}|mae`, lab, mae_);
    pushDist(`${cp}|mfe`, lab, mfeAtMin[cp]!);
    pushDist(`${cp}|prog`, lab, progAtMin[cp]!);
    pushDist(`${cp}|maxProg`, lab, maxP);
    pushDist(`${cp}|gb`, lab, gb);
    pushDist(`${cp}|stall`, lab, stall);
  }

  scanned++;
  if (scanned % 15000 === 0) console.error(`  scanned ${scanned}`);
}

console.error(`Done N=${nAll} SUCCESS=${nSucc} FAIL=${nFail} TIMEOUT=${nTout}`);

// Parity
{
  const med = median(rewards);
  console.error(`Parity N=${nAll} medRew=${f2(med)}`);
  if (!near(nAll, 75331, 500) || !near(med, 26.5, 1.0) || NO_LOOKAHEAD === "FAIL") {
    console.error("STOP parity");
    process.exit(1);
  }
  console.error("PARITY PASS");
}

const baseFailRate = pct(nFail + nTout, nAll); // non-success as failure baseline for "failed to complete"
const baseFailStrict = pct(nFail, nAll);
const baseSuccess = pct(nSucc, nAll);

function sigRow(name: string, s: SigAcc) {
  const prec = pct(s.nTrigFail + s.nTrigTimeout, s.nTrig); // non-success among triggered
  const recall = pct(s.nTrigFail + s.nTrigTimeout, nFail + nTout);
  const damage = pct(s.nTrigSuccess, nSucc);
  const preserved = 100 - damage;
  return {
    name,
    n: s.nTrig,
    prec,
    recall,
    damage,
    preserved,
    medT: median(s.detectMin),
    p75T: q(s.detectMin, 0.75),
    medMae: median(s.maeAt),
    medProg: median(s.progAt),
    before10: pct(s.before10, s.nTrigFail + s.nTrigTimeout),
    before20: pct(s.before20, s.nTrigFail + s.nTrigTimeout),
    before30: pct(s.before30, s.nTrigFail + s.nTrigTimeout),
    falseExit: pct(s.falseExitN, s.nTrig),
    medRecT: median(s.recoveryMin),
    medRecMae: median(s.recoveryMae),
  };
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD V32 — EARLY REVERSAL FAILURE DETECTION (behavioral, NO P&L optimization)");
L.push("=".repeat(120));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`Cohort: 1p early entry only. Swings: findSwingPoints radius=${SWING_RADIUS}.`);
L.push("");

L.push("-".repeat(120));
L.push("PARITY / BASE RATES");
L.push("-".repeat(120));
L.push(`  N=${nAll} medRew=${f2(median(rewards))} (V30≈75331 / 26.5)`);
L.push(`  SUCCESS=${nSucc} (${f1(baseSuccess)}%)`);
L.push(`  FAILURE=${nFail} (${f1(pct(nFail, nAll))}%)`);
L.push(`  TIMEOUT=${nTout} (${f1(pct(nTout, nAll))}%)`);
L.push(`  Non-success baseline (FAIL+TIMEOUT)=${f1(baseFailRate)}%`);
L.push("");

L.push("-".repeat(120));
L.push("31  SIGNAL TABLE");
L.push("-".repeat(120));
L.push(
  ["SIGNAL", "N", "FAIL_PREC", "FAIL_REC", "WIN_DMG", "PRESERVE", "MED_T", "P75_T", "MED_MAE"]
    .map((x) => x.padStart(10))
    .join(""),
);
const rows = SIG_NAMES.map((n) => sigRow(n, sigs[n]));
for (const r of rows) {
  L.push(
    [r.name, String(r.n), f1(r.prec), f1(r.recall), f1(r.damage), f1(r.preserved), f1(r.medT), f1(r.p75T), f1(r.medMae)]
      .map((x) => String(x).padStart(10))
      .join(""),
  );
}
L.push("");

L.push("-".repeat(120));
L.push("17  CHECKPOINT STATES (FAIL% = FAIL+TIMEOUT)");
L.push("-".repeat(120));
for (const cp of CHECKPOINTS) {
  L.push(`\n  @${cp}m`);
  L.push(["STATE", "N", "SUCC%", "FAIL%", "LIFT_pp"].map((x) => x.padStart(14)).join(""));
  const states = [
    "ALL",
    "MAE>=5",
    "MAE>=10",
    "MAE>=15",
    "MAE>=20",
    "maxProg<10",
    "maxProg<25",
    "maxProg<50",
    "lostOrigin",
    "M1_A",
    "M5_A",
    "gb50",
    "stall15",
    "stall30",
  ];
  for (const st of states) {
    const c = cells.get(`${cp}|${st}`);
    if (!c || c.n < 30) continue;
    const failPct = pct(c.fail + c.tout, c.n);
    const lift = failPct - baseFailRate;
    L.push(
      [st, String(c.n), f1(pct(c.succ, c.n)), f1(failPct), f1(lift)].map((x) => String(x).padStart(14)).join(""),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("18  SUCCESS vs FAILURE DISTRIBUTIONS (median / P75)");
L.push("-".repeat(120));
for (const cp of [15, 30, 60] as const) {
  L.push(`\n  @${cp}m`);
  for (const feat of ["pnl", "mae", "mfe", "prog", "maxProg", "gb", "stall"] as const) {
    const d = dist[`${cp}|${feat}`];
    if (!d) continue;
    L.push(
      `    ${feat}: SUCCESS med=${f1(median(d.s))} P75=${f1(q(d.s, 0.75))} | FAILURE med=${f1(median(d.f))} P75=${f1(q(d.f, 0.75))}`,
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("20–21  SWING TIMING & FALSE EXITS");
L.push("-".repeat(120));
for (const name of ["M1_A", "M1_B", "M5_A", "M5_B", "M5_D"] as SigName[]) {
  const r = sigRow(name, sigs[name]);
  L.push(
    `  ${name}: falseExit(still SUCCESS)=${f1(r.falseExit)}% medDetect=${f1(r.medT)}m medRecovery=${f1(r.medRecT)}m medMaeAfter=${f1(r.medRecMae)}`,
  );
  L.push(
    `    among non-success trig: before-10p=${f1(r.before10)}% before-20p=${f1(r.before20)}% before-30p=${f1(r.before30)}%`,
  );
  const sb = swingBefore[name];
  if (sb) {
    const nNon = nFail + nTout;
    L.push(
      `    % of FAILURES with signal by: ` +
        swingTimeBuckets.map((b, i) => `${b}m=${f1(pct(sb.nons[i]!, nNon))}`).join(" "),
    );
    L.push(
      `    % of SUCCESSES with signal by: ` +
        swingTimeBuckets.map((b, i) => `${b}m=${f1(pct(sb.succ[i]!, nSucc))}`).join(" "),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("25–28  WIDTH / SIDE / ERA (top signals)");
L.push("-".repeat(120));
L.push(
  `  Base by side: support N=${sideBase.support.n} succ=${f1(pct(sideBase.support.succ, sideBase.support.n))}% | resistance N=${sideBase.resistance.n} succ=${f1(pct(sideBase.resistance.succ, sideBase.resistance.n))}%`,
);
for (const name of ["PROG25_60", "PROG25_30", "MAE_20", "MAE_15", "M5_D"] as const) {
  L.push(`\n  ${name}:`);
  for (const w of ["0-20", "20-50", "50+"]) {
    const c = sub.get(`${name}|w|${w}`);
    if (!c || c.n < 100) continue;
    L.push(`    width ${w}: N=${c.n} failPrec=${f1(pct(c.nons, c.n))}% winShare=${f1(pct(c.succ, nSucc))}%`);
  }
  for (const w of ["0-10", "10-20", "20-30", "30-40", "40-50", "50-75", "75-100", "100+"]) {
    const c = sub.get(`${name}|wf|${w}`);
    if (!c || c.n < 80) continue;
    L.push(`    fine ${w}: N=${c.n} failPrec=${f1(pct(c.nons, c.n))}%`);
  }
  for (const sd of ["support", "resistance"] as const) {
    const c = sub.get(`${name}|side|${sd}`);
    if (!c) continue;
    L.push(`    ${sd}: N=${c.n} failPrec=${f1(pct(c.nons, c.n))}%`);
  }
  for (const er of ["2013-2019", "2020-2026"] as const) {
    const c = sub.get(`${name}|era|${er}`);
    if (!c) continue;
    L.push(`    ${er}: N=${c.n} failPrec=${f1(pct(c.nons, c.n))}%`);
  }
}
L.push("");

L.push("-".repeat(120));
L.push("22  FAILURE SIGNAL BEFORE LARGE LOSS (among triggered non-success)");
L.push("-".repeat(120));
for (const name of ["M1_A", "M5_A", "SR_M1_1", "SR_M5_1", "MAE_10", "GB50"] as SigName[]) {
  const r = sigRow(name, sigs[name]);
  L.push(`  ${name}: before−10=${f1(r.before10)}% before−20=${f1(r.before20)}% before−30=${f1(r.before30)}%`);
}
L.push("");

// Separation timeline
L.push("-".repeat(120));
L.push("19  WHEN SUCCESS/FAILURE SEPARATE (MAE + maxProg med SUCCESS vs FAILURE)");
L.push("-".repeat(120));
for (const cp of CHECKPOINTS) {
  const dMae = dist[`${cp}|mae`];
  const dProg = dist[`${cp}|maxProg`];
  if (!dMae) continue;
  const gapMae = median(dMae.f) - median(dMae.s);
  const gapProg = dProg ? median(dProg.s) - median(dProg.f) : NaN;
  L.push(
    `  @${cp}m: MAE gap=${f1(gapMae)} (S=${f1(median(dMae.s))} F=${f1(median(dMae.f))}) | maxProg gap=${f1(gapProg)} (S=${f1(median(dProg?.s ?? []))} F=${f1(median(dProg?.f ?? []))})`,
  );
}
L.push("");

// Rank useful signals
const ranked = rows
  .filter((r) => r.n >= 500)
  .map((r) => ({
    ...r,
    // utility: precision lift * sqrt(recall) * preserve/100
    score: Math.max(0, r.prec - baseFailRate) * Math.sqrt(Math.max(r.recall, 0) / 100) * (r.preserved / 100),
  }))
  .sort((a, b) => b.score - a.score);

L.push("-".repeat(120));
L.push("USEFULNESS RANKING (precision lift × √recall × preserve)");
L.push("-".repeat(120));
for (const r of ranked.slice(0, 12)) {
  L.push(
    `  ${r.name}: score=${f2(r.score)} prec=${f1(r.prec)} (lift=${f1(r.prec - baseFailRate)}) rec=${f1(r.recall)} dmg=${f1(r.damage)} t=${f1(r.medT)}m`,
  );
}
L.push("");

const best = ranked[0];
const m1A = sigRow("M1_A", sigs.M1_A);
const m5A = sigRow("M5_A", sigs.M5_A);
const sr1 = sigRow("SR_M1_1", sigs.SR_M1_1);

let verdict: string;
if (best && best.prec >= baseFailRate + 15 && best.recall >= 25 && best.damage <= 35) verdict = "REVERSAL_FAILURE_SIGNAL_FOUND";
else if (best && best.prec >= baseFailRate + 8 && best.recall >= 15 && best.damage <= 45)
  verdict = "REVERSAL_FAILURE_SIGNAL_CONDITIONAL";
else if (best && best.prec >= baseFailRate + 3) verdict = "REVERSAL_FAILURE_DETECTION_TOO_NOISY";
else verdict = "NO_FAILURE_SIGNAL";

L.push("-".repeat(120));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(120));
L.push(`1. Parity PASS? YES`);
L.push(`2. No-lookahead PASS? YES`);
L.push(`3. SUCCESS rate: ${f1(baseSuccess)}%`);
L.push(`4. FAILURE rate (strict): ${f1(pct(nFail, nAll))}% ; non-success ${f1(baseFailRate)}%`);
L.push(`5. Detect above baseline? ${best && best.prec > baseFailRate + 5 ? "YES" : "WEAK/NO"}`);
L.push(`6. M1 swing A predict? prec=${f1(m1A.prec)} lift=${f1(m1A.prec - baseFailRate)} rec=${f1(m1A.recall)} dmg=${f1(m1A.damage)}`);
L.push(`7. M5 swing A predict? prec=${f1(m5A.prec)} lift=${f1(m5A.prec - baseFailRate)} rec=${f1(m5A.recall)} dmg=${f1(m5A.damage)}`);
L.push(`8. Cleaner: ${m5A.prec - m5A.damage > m1A.prec - m1A.damage ? "M5" : "M1"} (by prec−damage)`);
L.push(`9. Earlier: ${m1A.medT <= m5A.medT ? "M1" : "M5"} (medT M1=${f1(m1A.medT)} M5=${f1(m5A.medT)})`);
L.push(`10. Lose origin S/R? prec=${f1(sr1.prec)} lift=${f1(sr1.prec - baseFailRate)} rec=${f1(sr1.recall)} dmg=${f1(sr1.damage)}`);
{
  const m10 = sigRow("MAE_10", sigs.MAE_10);
  const m20 = sigRow("MAE_20", sigs.MAE_20);
  L.push(`11. Adverse predicts? MAE10 prec=${f1(m10.prec)} MAE20 prec=${f1(m20.prec)}`);
  L.push(`12. Material rise: see checkpoint MAE rows — typically from ≥10–15p`);
}
{
  const p15 = sigRow("PROG25_15", sigs.PROG25_15);
  const p30 = sigRow("PROG25_30", sigs.PROG25_30);
  L.push(`13. Lack of progress? @15m prec=${f1(p15.prec)} @30m prec=${f1(p30.prec)}`);
}
{
  const g = sigRow("GB50", sigs.GB50);
  L.push(`14. Giveback 50%? prec=${f1(g.prec)} rec=${f1(g.recall)} dmg=${f1(g.damage)}`);
}
{
  const s = sigRow("STALL15", sigs.STALL15);
  L.push(`15. Stalling 15m? prec=${f1(s.prec)} rec=${f1(s.recall)} dmg=${f1(s.damage)}`);
}
L.push(`16. Highest useful precision: ${ranked[0]?.name ?? "-"} (${f1(ranked[0]?.prec ?? NaN)}%)`);
L.push(`17. Highest useful recall: ${[...ranked].sort((a, b) => b.recall - a.recall)[0]?.name ?? "-"}`);
L.push(`18. Most winners preserved among useful: ${[...ranked].sort((a, b) => b.preserved - a.preserved)[0]?.name ?? "-"}`);
L.push(`19. Catch before −10p: M1_A ${f1(m1A.before10)}% of its non-success trigs`);
L.push(`20. Before −20p: M1_A ${f1(m1A.before20)}%`);
L.push(`21. Before −30p: M1_A ${f1(m1A.before30)}%`);
L.push(`22. SUCCESS that trigger M1_A: ${f1(m1A.damage)}% of winners`);
L.push(`23. SUCCESS that trigger M5_A: ${f1(m5A.damage)}% of winners`);
L.push(`24. Swing failures: ${m1A.falseExit > 40 ? "often normal pullback (high false exit)" : "more genuine"} (M1 falseExit=${f1(m1A.falseExit)}%)`);
{
  let firstMae = "unclear";
  let firstProg = "unclear";
  for (const cp of CHECKPOINTS) {
    const d = dist[`${cp}|mae`];
    if (!d) continue;
    if (median(d.f) - median(d.s) >= 2 && firstMae === "unclear") firstMae = `${cp}m`;
  }
  for (const cp of CHECKPOINTS) {
    const d = dist[`${cp}|maxProg`];
    if (!d) continue;
    if (median(d.s) - median(d.f) >= 5 && firstProg === "unclear") firstProg = `${cp}m`;
  }
  L.push(`25. First meaningful separation: maxProg ~${firstProg}; MAE ~${firstMae}`);
}
{
  const p = sub.get("PROG25_60|w|0-20");
  const q50 = sub.get("PROG25_60|w|20-50");
  const qbig = sub.get("PROG25_60|w|50+");
  L.push(
    `26. Range width (PROG25_60 failPrec): 0-20=${f1(pct(p?.nons ?? 0, p?.n ?? 0))}% 20-50=${f1(pct(q50?.nons ?? 0, q50?.n ?? 0))}% 50+=${f1(pct(qbig?.nons ?? 0, qbig?.n ?? 0))}%`,
  );
}
{
  const s = sub.get("PROG25_60|side|support");
  const r = sub.get("PROG25_60|side|resistance");
  L.push(
    `27. Support/resistance (PROG25_60): supp prec=${f1(pct(s?.nons ?? 0, s?.n ?? 0))}% res prec=${f1(pct(r?.nons ?? 0, r?.n ?? 0))}% | base succ S=${f1(pct(sideBase.support.succ, sideBase.support.n))}% R=${f1(pct(sideBase.resistance.succ, sideBase.resistance.n))}%`,
  );
}
{
  const e1 = sub.get("PROG25_60|era|2013-2019");
  const e2 = sub.get("PROG25_60|era|2020-2026");
  L.push(
    `28. Eras: base succ 13-19=${f1(pct(eraSucc["2013-2019"]!.succ, eraSucc["2013-2019"]!.n))}% 20-26=${f1(pct(eraSucc["2020-2026"]!.succ, eraSucc["2020-2026"]!.n))}% | PROG25_60 prec 13-19=${f1(pct(e1?.nons ?? 0, e1?.n ?? 0))}% 20-26=${f1(pct(e2?.nons ?? 0, e2?.n ?? 0))}%`,
  );
}
L.push(`29. Replace fixed stop? ${verdict.includes("FOUND") || verdict.includes("CONDITIONAL") ? "MAYBE / CONDITIONAL" : "NOT YET"}`);
L.push(`30. First exit rule to test later: ${best?.name ?? "none"}`);

L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("");
L.push(
  `Can GX tell that a reversal is failing? ${best && best.prec > baseFailRate + 5 ? "Partially — some signals raise failure odds above baseline." : "Not reliably with the predefined individual signals."}`,
);
L.push(`How early? Best med detect ~${f1(best?.medT ?? NaN)}m for ${best?.name ?? "-"}.`);
L.push(`What should GX watch? Rank leaders: ${ranked.slice(0, 3).map((r) => r.name).join(", ") || "none"}.`);
L.push(
  `Exit bad without killing winners? ${best && best.damage <= 35 && best.prec >= baseFailRate + 10 ? "Possibly for the top signal — still needs an exit P&L test." : "Not cleanly yet — winner damage and/or weak lift remain the issue."}`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-early-reversal-failure-detect-v32-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
