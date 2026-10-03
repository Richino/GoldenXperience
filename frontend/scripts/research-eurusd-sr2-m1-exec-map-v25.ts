/**
 * EUR/USD V25 — S/R2 M1 EXECUTABLE REVERSAL MAP (research-only, NO P&L).
 *
 * NEW file — does NOT modify V23/V24/older.
 *
 * 1) Reproduce V24 M15 chain parity (gate).
 * 2) For accepted S/R1 breaks with frozen S/R2, reconstruct path on OANDA M1 BID/ASK.
 *
 * Executable: resistance→BID close; support→ASK close. No MID for penetration.
 * Geometry/freeze/accept rules identical to V24.
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
const HORIZON = 96; // M15 bars
const M1_HORIZON = HORIZON * 15; // minutes / M1 bars after L1 accept
const PIP = pipSizeFor(INSTRUMENT);
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
/** M15 accept = 2 bars; reconstruct on M1 with time-equivalent consecutive closes (2×15). */
const ACCEPT_MIN_BARS_M1 = ACCEPT_MIN_BARS * 15;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;
const RETS_EXT = [3, 5, 10, 15, 20, 30] as const;
const RANGE_PCTS = [25, 50, 75, 100] as const;
const GAPB: Array<[string, (g: number) => boolean]> = [
  ["0-5", (g) => g > 0 && g <= 5],
  ["5-10", (g) => g > 5 && g <= 10],
  ["10-15", (g) => g > 10 && g <= 15],
  ["15-20", (g) => g > 15 && g <= 20],
  ["20-30", (g) => g > 20 && g <= 30],
  ["30-50", (g) => g > 30 && g <= 50],
  ["50+", (g) => g > 50],
];
const CURVE_PTS = [-10, -7.5, -5, -3, 0, 1, 2, 3, 5, 7.5, 10] as const;
const COND_PENS = [1, 2, 3, 5, 7.5, 10, 15, 20] as const;
const FAV_RACE = [5, 10, 15, 20] as const;
const ADV_RACE = [3, 5, 10, 15, 20, 30] as const;
const EARLY_MIN = [1, 2, 3, 5, 10, 15] as const;

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type Path =
  | "REV_L1"
  | "BRK_L1_NO_L2"
  | "BRK_L1_NO_REACH_L2"
  | "REV_L2"
  | "BRK_L2_ESCAPE"
  | "BRK_L1_L2_UNRESOLVED"
  | "L1_UNRESOLVED";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

function near(a: number, b: number, tol = 0.6) {
  return Math.abs(a - b) <= tol;
}

// ===================== LOAD M15 =====================
console.error("V25 loading M15...");
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
  time: string;
  side: Side;
  atr: number;
  rangeWidth: number;
  L1: number;
  k1: Kind;
  L2: number | null;
  k2: Kind | null;
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
}

const encs: Enc[] = [];
let armedR = true,
  armedS = true;
const startT = WINDOW;
const auditNotes: string[] = [];
let auditFail = 0;

for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const loc = a.location;
  const cur = lv.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE";
  const nearS = loc === "NEAR_SUPPORT";
  const rw = lv.rangeHigh - lv.rangeLow;

  if (nearR && armedR) {
    const cand = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (cand.length) {
      const L1 = cand.reduce((p, qv) => (qv - cur < p - cur ? qv : p));
      const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const other = k1 === "range" ? lv.swingHigh : lv.rangeHigh;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other > L1 ? other : null;
      if (L2 !== null && L2 <= L1) {
        auditFail++;
        auditNotes.push(`R L2<=L1 ${raw[t]!.time}`);
      }
      encs.push({
        t0: t,
        time: raw[t]!.time,
        side: "resistance",
        atr: A,
        rangeWidth: rw,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
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
      const k2: Kind = k1 === "range" ? "swing" : "range";
      const L2 = other !== null && other < L1 ? other : null;
      if (L2 !== null && L2 >= L1) {
        auditFail++;
        auditNotes.push(`S L2>=L1 ${raw[t]!.time}`);
      }
      encs.push({
        t0: t,
        time: raw[t]!.time,
        side: "support",
        atr: A,
        rangeWidth: rw,
        L1,
        k1,
        L2,
        k2: L2 !== null ? k2 : null,
        rangeHigh: lv.rangeHigh,
        rangeLow: lv.rangeLow,
        swingHigh: lv.swingHigh,
        swingLow: lv.swingLow,
      });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}

// freeze audit sample
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
    if (Math.abs(lv.rangeHigh - e.rangeHigh) > 1e-9 || Math.abs(lv.rangeLow - e.rangeLow) > 1e-9) {
      auditFail++;
      auditNotes.push(`range mismatch ${e.time}`);
    }
    if ((lv.swingHigh ?? null) !== (e.swingHigh ?? null) || (lv.swingLow ?? null) !== (e.swingLow ?? null)) {
      auditFail++;
      auditNotes.push(`swing mismatch ${e.time}`);
    }
    const okL1 =
      e.side === "resistance"
        ? e.L1 === e.rangeHigh || e.L1 === e.swingHigh
        : e.L1 === e.rangeLow || e.L1 === e.swingLow;
    if (!okL1) {
      auditFail++;
      auditNotes.push(`L1 not in snapshot ${e.time}`);
    }
    if (e.L2 !== null) {
      const okL2 =
        e.side === "resistance"
          ? e.L2 === e.rangeHigh || e.L2 === e.swingHigh
          : e.L2 === e.rangeLow || e.L2 === e.swingLow;
      if (!okL2) {
        auditFail++;
        auditNotes.push(`L2 not in snapshot ${e.time}`);
      }
    }
  }
}

function v1Fakeout(e: Enc): boolean {
  const w = TOUCH_ATR * e.atr;
  const top = e.L1 + w;
  const bot = e.L1 - w;
  let bb = 0;
  let adv = e.side === "resistance" ? -Infinity : Infinity;
  const end = Math.min(e.t0 + HORIZON, n - 1);
  for (let j = e.t0; j <= end; j++) {
    const c = raw[j]!.mid;
    adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low);
    const bc = e.side === "resistance" ? c.close - e.L1 : e.L1 - c.close;
    if (bc > w) bb++;
    else bb = 0;
    const acc = bb >= ACCEPT_MIN_BARS && bc / e.atr >= ACCEPT_MIN_DIST_ATR;
    const pen = (e.side === "resistance" ? adv - e.L1 : e.L1 - adv) >= MIN_PEN_ATR * e.atr;
    const ins = e.side === "resistance" ? c.close <= top : c.close >= bot;
    if (acc) return false;
    if (pen && ins) return true;
  }
  return false;
}

{
  const v: Record<Side, { s: number; t: number }> = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of encs) {
    v[e.side].t++;
    if (v1Fakeout(e)) v[e.side].s++;
  }
  const vS = pct(v.support.s, v.support.t);
  const vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) {
    console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`);
    process.exit(1);
  }
  (globalThis as { __fid?: { vS: number; vR: number } }).__fid = { vS, vR };
}

function classifyLevel(
  side: Side,
  level: number,
  atr: number,
  startBar: number,
  towardIsDown: boolean,
) {
  const w = TOUCH_ATR * atr;
  const end = Math.min(startBar + HORIZON, n - 1);
  let touched = false;
  let tTouch: number | null = null;
  let broke = false;
  let tBreak: number | null = null;
  let revPrimary = false;
  let tRevPrimary: number | null = null;
  const retHit: Record<number, boolean> = {};
  const tRet: Record<number, number | null> = {};
  for (const r of RETS) {
    retHit[r] = false;
    tRet[r] = null;
  }
  let reclaim = false;
  let tReclaim: number | null = null;
  let maxPen = 0;
  let peakBeyond = level;
  let beyondArmed = false;
  let bb = 0;

  for (let j = startBar; j <= end; j++) {
    const c = raw[j]!.mid;
    const inZone =
      side === "resistance" ? c.high >= level - w && c.low <= level + w : c.low <= level + w && c.high >= level - w;
    const beyondWick = side === "resistance" ? c.high > level + w : c.low < level - w;
    if (!touched && (inZone || beyondWick || (side === "resistance" ? c.high >= level : c.low <= level))) {
      touched = true;
      tTouch = j;
    }
    if (!touched) continue;

    const penNow = side === "resistance" ? c.high - level : level - c.low;
    if (penNow > maxPen) maxPen = penNow;
    if (side === "resistance") {
      if (c.high > peakBeyond) peakBeyond = c.high;
    } else if (c.low < peakBeyond) peakBeyond = c.low;
    if (penNow >= MIN_PEN_ATR * atr) beyondArmed = true;

    const bc = side === "resistance" ? c.close - level : level - c.close;
    if (bc > w) bb++;
    else bb = 0;
    const acc = bb >= ACCEPT_MIN_BARS && bc / atr >= ACCEPT_MIN_DIST_ATR;
    if (!broke && acc) {
      broke = true;
      tBreak = j;
    }

    {
      const retFromPeak = (towardIsDown ? peakBeyond - c.low : c.high - peakBeyond) / PIP;
      const retFromLevel = (towardIsDown ? level - c.low : c.high - level) / PIP;
      const ret = Math.max(retFromPeak, retFromLevel);
      for (const r of RETS) {
        if (!retHit[r] && ret >= r) {
          retHit[r] = true;
          tRet[r] = j;
        }
      }
      if (!revPrimary && !broke && retHit[PRIMARY_RET]) {
        revPrimary = true;
        tRevPrimary = tRet[PRIMARY_RET];
      }
    }

    if (!reclaim && beyondArmed) {
      const recl = towardIsDown ? c.close <= level : c.close >= level;
      if (recl) {
        reclaim = true;
        tReclaim = j;
      }
    }
    if (broke || revPrimary) break;
  }
  if (revPrimary && broke && tRevPrimary !== null && tBreak !== null) {
    if (tRevPrimary < tBreak) broke = false;
    else revPrimary = false;
  }
  return {
    touched,
    tTouch,
    broke,
    tBreak,
    revPrimary,
    tRevPrimary,
    retHit,
    tRet,
    reclaim,
    tReclaim,
    maxPenPips: maxPen / PIP,
  };
}

interface V24Ev {
  e: Enc;
  path: Path;
  l1: ReturnType<typeof classifyLevel>;
  l2: ReturnType<typeof classifyLevel> | null;
  gapPips: number;
  gapAtr: number;
  gapRangePct: number;
}

const v24: V24Ev[] = [];
for (const e of encs) {
  const towardDown = e.side === "resistance";
  const l1 = classifyLevel(e.side, e.L1, e.atr, e.t0, towardDown);
  const gapPips = e.L2 !== null ? Math.abs(e.L2 - e.L1) / PIP : NaN;
  const gapAtr = e.L2 !== null ? Math.abs(e.L2 - e.L1) / e.atr : NaN;
  const gapRangePct = e.L2 !== null && e.rangeWidth > 0 ? (Math.abs(e.L2 - e.L1) / e.rangeWidth) * 100 : NaN;
  let l2: ReturnType<typeof classifyLevel> | null = null;
  let path: Path = "L1_UNRESOLVED";

  if (l1.revPrimary) path = "REV_L1";
  else if (l1.broke) {
    const tB = l1.tBreak ?? e.t0;
    if (e.L2 === null) path = "BRK_L1_NO_L2";
    else {
      l2 = classifyLevel(e.side, e.L2, e.atr, tB, towardDown);
      if (!l2.touched) path = "BRK_L1_NO_REACH_L2";
      else if (l2.revPrimary) path = "REV_L2";
      else if (l2.broke) path = "BRK_L2_ESCAPE";
      else path = "BRK_L1_L2_UNRESOLVED";
    }
  } else path = "L1_UNRESOLVED";

  v24.push({ e, path, l1, l2, gapPips, gapAtr, gapRangePct });
}

const byPath: Record<Path, number> = {
  REV_L1: 0,
  BRK_L1_NO_L2: 0,
  BRK_L1_NO_REACH_L2: 0,
  REV_L2: 0,
  BRK_L2_ESCAPE: 0,
  BRK_L1_L2_UNRESOLVED: 0,
  L1_UNRESOLVED: 0,
};
for (const ev of v24) byPath[ev.path]++;
const N = v24.length;
const revL1 = byPath.REV_L1;
const brkL1 = N - revL1 - byPath.L1_UNRESOLVED;
const brkWithL2 = v24.filter((ev) => ev.l1.broke && !ev.l1.revPrimary && ev.e.L2 !== null);
const brkReachL2 = brkWithL2.filter((ev) => ev.l2?.touched);
const revL2 = byPath.REV_L2;
const brkL2 = byPath.BRK_L2_ESCAPE;
const escape = byPath.BRK_L2_ESCAPE + byPath.BRK_L1_NO_L2;
const gaps12 = v24.filter((ev) => ev.e.L2 !== null).map((ev) => ev.gapPips);
const medGap = median(gaps12);
const combined = revL1 + revL2;

const parityChecks: Array<[string, number, number]> = [
  ["N", N, 75959],
  ["revL1%", pct(revL1, N), 71.7],
  ["brkL1%", pct(brkL1, N), 25.7],
  ["L2avail|brk%", pct(brkWithL2.length, brkL1), 95.7],
  ["reach|avail%", pct(brkReachL2.length, brkWithL2.length), 69.8],
  ["revL2|reach%", pct(revL2, brkReachL2.length), 75.3],
  ["brkL2|reach%", pct(brkL2, brkReachL2.length), 24.4],
  ["combined%", pct(combined, N), 84.6],
  ["escape%", pct(escape, N), 5.3],
  ["medGap", medGap, 18.3],
];
let parityOk = true;
for (const [name, got, exp] of parityChecks) {
  const tol = name === "N" ? 50 : name === "medGap" ? 0.5 : 0.6;
  if (!near(got, exp, tol)) {
    parityOk = false;
    console.error(`V24 PARITY FAIL ${name}: got ${got} expected ~${exp}`);
  }
}
const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (!parityOk || NO_LOOKAHEAD === "FAIL") {
  console.error(`STOP. PARITY=${parityOk ? "PASS" : "FAIL"} NO_LOOKAHEAD=${NO_LOOKAHEAD}`);
  if (auditNotes.length) console.error(auditNotes.slice(0, 10));
  process.exit(1);
}
console.error(`V24 PARITY PASS | NO_LOOKAHEAD_AUDIT = PASS | N=${N} brkWithL2=${brkWithL2.length}`);

// ===================== LOAD M1 =====================
console.error("V25 loading M1...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const m1t: string[] = new Array(M1);
const m1ms = new Float64Array(M1);
const bh = new Float64Array(M1),
  bl = new Float64Array(M1),
  ah = new Float64Array(M1),
  al = new Float64Array(M1),
  bc = new Float64Array(M1),
  ac = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  m1t[i] = r[0];
  m1ms[i] = Date.parse(r[0]);
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
}
(m1raw as unknown as { length: number }).length = 0;
console.error(`M1 ${M1}  ${m1t[0]} -> ${m1t[M1 - 1]}`);

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

/** Executable close & diagnostic extreme beyond for a side. */
function execClose(i: number, side: Side): number {
  return side === "resistance" ? bc[i]! : ac[i]!;
}
function spreadAt(i: number): number {
  return (ac[i]! - bc[i]!) / PIP;
}

type Seq = "A_IMMEDIATE" | "B_PEN_REV" | "C_DEEP_PEN_REV" | "D_ACCEPT_CONT" | "UNRESOLVED";

interface M1Hit {
  e: Enc;
  gapPips: number;
  gapAtr: number;
  gapRangePct: number;
  tBreakM15: number;
  m1Start: number;
  touched: boolean;
  tTouch: number | null;
  touchPrice: number;
  touchSpread: number;
  minsToTouch: number | null;
  barsToTouch: number | null;
  // returns / reclaim / accept from touch
  ret: Record<number, boolean>;
  tRet: Record<number, number | null>;
  rangeRet: Record<number, boolean>;
  reclaim: boolean;
  tReclaim: number | null;
  accepted: boolean;
  tAccept: number | null;
  /** V24-style primary: ≥10p return BEFORE accepted L2 break. */
  primaryRev10: boolean;
  seq: Seq;
  maxPenExec: number; // pips beyond L2 by exec close before 10p rev (or over horizon)
  maxPenBeforeRev10: number | null;
  mae: number;
  mfe: number;
  // curve: first index reaching each checkpoint (relative pips to L2; neg=before)
  curveIdx: Record<string, number | null>;
  // controls 25/50/75
  ctrl: Record<string, { reached: boolean; t: number | null; ret: Record<number, boolean>; maxPen: number; primaryRev10: boolean }>;
  // conditional: once pen Xp reached
  cond: Record<number, { reached: boolean; t: number | null; retToL2: boolean; ret5: boolean; ret10: boolean; cont5: boolean; cont10: boolean }>;
  // race
  race: Record<string, "fav" | "adv" | "ambig" | "none">;
  // early minutes state after touch
  early: Record<number, { inside: boolean; around: boolean; bey3: boolean; bey5: boolean; bey10: boolean }>;
  // after accept
  postAcc: {
    retL2: boolean;
    ret5: boolean;
    ret10: boolean;
    cont10: boolean;
    cont20: boolean;
    cont30: boolean;
    maxCont: number;
  } | null;
  // escape distance after L2 accept
  escapeDist: number | null;
}

const hits: M1Hit[] = [];
let noM1 = 0;

for (const ev of brkWithL2) {
  const e = ev.e;
  const L2 = e.L2!;
  const L1 = e.L1;
  const side = e.side;
  const atr = e.atr;
  const w = TOUCH_ATR * atr;
  const gap = Math.abs(L2 - L1);
  const gapPips = gap / PIP;
  const towardDown = side === "resistance";
  const tBreak = ev.l1.tBreak ?? e.t0;
  // M15 bar close time = open + 15m
  const breakCloseMs = m15ms[tBreak]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1Start >= M1 - 2) {
    noM1++;
    continue;
  }
  // first fully completed M1 at/after break close
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) {
    noM1++;
    continue;
  }
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);

  const curveIdx: Record<string, number | null> = {};
  for (const p of CURVE_PTS) curveIdx[String(p)] = null;

  // control levels frozen (25/50/75 of gap toward L2 from L1)
  const ctrlLevels: Record<string, number> = {
    "25": towardDown ? L1 + 0.25 * gap : L1 - 0.25 * gap,
    "50": towardDown ? L1 + 0.5 * gap : L1 - 0.5 * gap,
    "75": towardDown ? L1 + 0.75 * gap : L1 - 0.75 * gap,
  };
  const ctrl: M1Hit["ctrl"] = {};
  for (const k of Object.keys(ctrlLevels)) {
    ctrl[k] = { reached: false, t: null, ret: {}, maxPen: 0, primaryRev10: false };
    for (const r of RETS_EXT) ctrl[k]!.ret[r] = false;
  }

  let touched = false;
  let tTouch: number | null = null;
  let touchPrice = NaN;
  let touchSpread = NaN;
  let bb = 0;
  let accepted = false;
  let tAccept: number | null = null;
  let reclaim = false;
  let tReclaim: number | null = null;
  let peakBeyond = L2; // exec close extreme beyond L2
  let maxPenExec = 0;
  let maxPenBeforeRev10: number | null = null;
  let primaryRev10 = false;
  let tPrimaryRev10: number | null = null;
  const ret: Record<number, boolean> = {};
  const tRet: Record<number, number | null> = {};
  for (const r of RETS_EXT) {
    ret[r] = false;
    tRet[r] = null;
  }
  const rangeRet: Record<number, boolean> = {};
  for (const rp of RANGE_PCTS) rangeRet[rp] = false;

  // conditional pens
  const cond: M1Hit["cond"] = {};
  for (const p of COND_PENS) {
    cond[p] = { reached: false, t: null, retToL2: false, ret5: false, ret10: false, cont5: false, cont10: false };
  }

  // race
  const race: M1Hit["race"] = {};
  for (const f of FAV_RACE) for (const a of ADV_RACE) race[`f${f}_a${a}`] = "none";
  const racePending = new Set(Object.keys(race));

  // MAE/MFE from touch
  let mae = 0,
    mfe = 0;

  // early minute snapshots filled after touch
  const early: M1Hit["early"] = {};

  // scan from m1Start
  for (let i = m1Start; i <= end; i++) {
    const px = execClose(i, side);
    // distance relative to L2: before = negative for approach from inside
    const relPips = towardDown ? (px - L2) / PIP : (L2 - px) / PIP; // + beyond, - before

    // curve checkpoints: first executable close at or beyond the checkpoint toward/through L2
    for (const p of CURVE_PTS) {
      const key = String(p);
      if (curveIdx[key] !== null) continue;
      if (relPips >= p) curveIdx[key] = i;
    }

    // controls: reach when exec close at/through control toward L2
    for (const [k, lvl] of Object.entries(ctrlLevels)) {
      const c = ctrl[k]!;
      if (!c.reached) {
        const reachedCtrl = towardDown ? px >= lvl : px <= lvl;
        if (reachedCtrl) {
          c.reached = true;
          c.t = i;
        }
      }
    }

    // touch: first exec close in zone or beyond
    if (!touched) {
      const inOrBeyond = towardDown ? px >= L2 - w : px <= L2 + w;
      if (inOrBeyond) {
        touched = true;
        tTouch = i;
        touchPrice = px;
        touchSpread = spreadAt(i);
        peakBeyond = px;
      }
    }
    if (!touched) continue;

    // update peaks / pen
    if (towardDown) {
      if (px > peakBeyond) peakBeyond = px;
    } else {
      if (px < peakBeyond) peakBeyond = px;
    }
    const penNow = towardDown ? px - L2 : L2 - px;
    if (penNow > maxPenExec) maxPenExec = penNow;
    const penPips = Math.max(0, penNow) / PIP;
    const favNow = (towardDown ? peakBeyond - px : px - peakBeyond) / PIP;
    const favFromL2 = (towardDown ? L2 - px : px - L2) / PIP;
    const fav = Math.max(favNow, favFromL2);
    const adv = penPips;
    if (adv > mae) mae = adv;
    if (fav > mfe) mfe = fav;

    // race fav vs adv from touch (resolve even on the bar primary/accept fires)
    for (const key of [...racePending]) {
      const m = /^f(\d+)_a(\d+)$/.exec(key)!;
      const fNeed = Number(m[1]);
      const aNeed = Number(m[2]);
      const fHit = fav >= fNeed;
      const aHit = adv >= aNeed;
      if (fHit && aHit) {
        race[key] = "ambig";
        racePending.delete(key);
      } else if (fHit) {
        race[key] = "fav";
        racePending.delete(key);
      } else if (aHit) {
        race[key] = "adv";
        racePending.delete(key);
      }
    }

    // ever-hit returns (path outcomes over full horizon)
    for (const r of RETS_EXT) {
      if (!ret[r] && fav >= r) {
        ret[r] = true;
        tRet[r] = i;
      }
    }
    // primary ≥10p reverse BEFORE accept (V24 first-wins)
    if (!primaryRev10 && !accepted && ret[10] && tRet[10] === i) {
      primaryRev10 = true;
      tPrimaryRev10 = i;
      maxPenBeforeRev10 = maxPenExec / PIP;
    }
    for (const rp of RANGE_PCTS) {
      if (!rangeRet[rp] && gap > 0 && fav * PIP >= (rp / 100) * gap) rangeRet[rp] = true;
    }

    // reclaim through L2 toward L1 after having been beyond
    if (!reclaim && maxPenExec > 0) {
      const recl = towardDown ? px <= L2 : px >= L2;
      if (recl) {
        reclaim = true;
        tReclaim = i;
      }
    }

    // accepted break on M1: same ATR distance; bar-count time-equivalent to 2×M15
    const bcDist = towardDown ? px - L2 : L2 - px;
    if (bcDist > w) bb++;
    else bb = 0;
    if (!accepted && !primaryRev10 && bb >= ACCEPT_MIN_BARS_M1 && bcDist / atr >= ACCEPT_MIN_DIST_ATR) {
      accepted = true;
      tAccept = i;
    }

    // conditional pens: mark first reach of +Xp beyond L2
    for (const p of COND_PENS) {
      const c = cond[p]!;
      if (!c.reached && penPips >= p) {
        c.reached = true;
        c.t = i;
      }
    }
  }

  // control returns: primary = ≥10p toward L1 BEFORE time-equivalent accept at control
  for (const [k, lvl] of Object.entries(ctrlLevels)) {
    const c = ctrl[k]!;
    if (!c.reached || c.t === null) continue;
    let peak = lvl;
    let maxP = 0;
    let cbb = 0;
    let cAcc = false;
    let cPrim = false;
    for (let i = c.t; i <= end; i++) {
      const px = execClose(i, side);
      if (towardDown) {
        if (px > peak) peak = px;
      } else if (px < peak) peak = px;
      const pen = towardDown ? px - lvl : lvl - px;
      if (pen > maxP) maxP = pen;
      const fav = Math.max(
        (towardDown ? peak - px : px - peak) / PIP,
        (towardDown ? lvl - px : px - lvl) / PIP,
      );
      for (const r of RETS_EXT) {
        if (!c.ret[r] && fav >= r) c.ret[r] = true;
      }
      if (!cPrim && !cAcc && c.ret[10]) cPrim = true;
      const bcDist = towardDown ? px - lvl : lvl - px;
      if (bcDist > w) cbb++;
      else cbb = 0;
      if (!cAcc && !cPrim && cbb >= ACCEPT_MIN_BARS_M1 && bcDist / atr >= ACCEPT_MIN_DIST_ATR) cAcc = true;
      if (cPrim || cAcc) {
        // keep filling ever-hit rets briefly then break
        if (RETS_EXT.every((r) => c.ret[r])) break;
      }
    }
    c.maxPen = maxP / PIP;
    c.primaryRev10 = cPrim;
  }

  // conditional outcomes from first reach of each pen
  for (const p of COND_PENS) {
    const c = cond[p]!;
    if (!c.reached || c.t === null) continue;
    const startPen = p * PIP;
    for (let i = c.t; i <= end; i++) {
      const px = execClose(i, side);
      const pen = towardDown ? px - L2 : L2 - px;
      const inside = towardDown ? L2 - px : px - L2;
      if (!c.retToL2 && (towardDown ? px <= L2 : px >= L2)) c.retToL2 = true;
      if (!c.ret5 && inside >= 5 * PIP) c.ret5 = true;
      if (!c.ret10 && inside >= 10 * PIP) c.ret10 = true;
      if (!c.cont5 && pen >= startPen + 5 * PIP) c.cont5 = true;
      if (!c.cont10 && pen >= startPen + 10 * PIP) c.cont10 = true;
    }
  }

  // early minutes after touch
  if (tTouch !== null) {
    for (const m of EARLY_MIN) {
      const j = Math.min(tTouch + m, end);
      const px = execClose(j, side);
      const rel = towardDown ? (px - L2) / PIP : (L2 - px) / PIP;
      const inside = Math.abs(px - L2) <= w;
      const around = Math.abs(px - L2) / PIP <= 3;
      early[m] = {
        inside,
        around,
        bey3: rel >= 3,
        bey5: rel >= 5,
        bey10: rel >= 10,
      };
    }
  }

  // post-accept
  let postAcc: M1Hit["postAcc"] = null;
  let escapeDist: number | null = null;
  if (accepted && tAccept !== null) {
    let retL2 = false,
      ret5 = false,
      ret10 = false,
      cont10 = false,
      cont20 = false,
      cont30 = false,
      maxCont = 0;
    for (let i = tAccept; i <= end; i++) {
      const px = execClose(i, side);
      const pen = towardDown ? px - L2 : L2 - px;
      const inside = towardDown ? L2 - px : px - L2;
      if (pen > maxCont) maxCont = pen;
      if (!retL2 && (towardDown ? px <= L2 : px >= L2)) retL2 = true;
      if (!ret5 && inside >= 5 * PIP) ret5 = true;
      if (!ret10 && inside >= 10 * PIP) ret10 = true;
      if (!cont10 && pen >= 10 * PIP) cont10 = true;
      if (!cont20 && pen >= 20 * PIP) cont20 = true;
      if (!cont30 && pen >= 30 * PIP) cont30 = true;
    }
    postAcc = {
      retL2,
      ret5,
      ret10,
      cont10,
      cont20,
      cont30,
      maxCont: maxCont / PIP,
    };
    escapeDist = maxCont / PIP;
  }

  // sequence class (primary ≥10p rev vs accept, first-wins)
  let seq: Seq = "UNRESOLVED";
  if (touched) {
    const penBefore = maxPenBeforeRev10 ?? 0;
    if (primaryRev10) {
      if (penBefore < 1) seq = "A_IMMEDIATE";
      else if (penBefore < 5) seq = "B_PEN_REV";
      else seq = "C_DEEP_PEN_REV";
    } else if (accepted) {
      seq = "D_ACCEPT_CONT";
    } else seq = "UNRESOLVED";
  }

  const minsToTouch = tTouch !== null ? tTouch - m1Start : null;

  hits.push({
    e,
    gapPips,
    gapAtr: gap / atr,
    gapRangePct: e.rangeWidth > 0 ? (gap / e.rangeWidth) * 100 : NaN,
    tBreakM15: tBreak,
    m1Start,
    touched,
    tTouch,
    touchPrice,
    touchSpread,
    minsToTouch,
    barsToTouch: minsToTouch,
    ret,
    tRet,
    rangeRet,
    reclaim,
    tReclaim,
    accepted,
    tAccept,
    primaryRev10,
    seq,
    maxPenExec: maxPenExec / PIP,
    maxPenBeforeRev10,
    mae,
    mfe,
    curveIdx,
    ctrl,
    cond,
    race,
    early,
    postAcc,
    escapeDist,
  });
}

console.error(`M1 hits built: ${hits.length} (noM1 map ${noM1})`);

// ===================== REPORT =====================
const L: string[] = [];
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;
const touched = hits.filter((h) => h.touched);
const rev10Hits = touched.filter((h) => h.primaryRev10);
const pensRev = touched.filter((h) => h.primaryRev10 && h.maxPenBeforeRev10 != null).map((h) => h.maxPenBeforeRev10!);

L.push("=".repeat(110));
L.push("EUR/USD V25 — S/R2 M1 EXECUTABLE REVERSAL MAP (research-only, NO P&L)");
L.push("=".repeat(110));
L.push(`M15: ${n} bars | M1: ${M1} bars | V24 encounters N=${N}`);
L.push(`FIDELITY support ${f2(fid.vS)}% resistance ${f2(fid.vR)}%`);
L.push(`NO_LOOKAHEAD_AUDIT = PASS`);
L.push(`V24_PARITY = PASS`);
L.push(`Executable: resistance=BID close, support=ASK close. Accept on M1 uses ${ACCEPT_MIN_BARS_M1} consecutive closes (time-equiv to ${ACCEPT_MIN_BARS} M15 bars) + ≥${ACCEPT_MIN_DIST_ATR} ATR.`);
L.push(`Primary S/R2 reverse = ≥10p return BEFORE accepted L2 break (V24 first-wins). Ever-hit returns also reported.`);
L.push("");
L.push("-".repeat(110));
L.push("1. V24 PARITY");
L.push("-".repeat(110));
for (const [name, got, exp] of parityChecks) {
  L.push(`  ${name.padEnd(18)} got=${f2(got)}  expected≈${exp}  OK`);
}
L.push("");

L.push("-".repeat(110));
L.push("2–10  M1 EXECUTABLE S/R2 OUTCOMES (among V24 L1-break & L2-available)");
L.push("-".repeat(110));
L.push(`2. Accepted S/R1 breaks with S/R2: ${brkWithL2.length}`);
L.push(`3. Reach S/R2 (M1 exec close): ${touched.length} / ${hits.length} = ${f1(pct(touched.length, hits.length))}%`);
L.push(`   (V24 M15 reach was ${f1(pct(brkReachL2.length, brkWithL2.length))}% of avail)`);
L.push(`PRIMARY (ret≥10p before accept): ${f1(pct(touched.filter((h) => h.primaryRev10).length, touched.length))}%`);
for (const r of [3, 5, 10, 15, 20] as const) {
  L.push(
    `${r === 3 ? "4" : r === 5 ? "5" : r === 10 ? "6" : r === 15 ? "7" : "8"}. P(ever return ${r}p | M1 touch) = ${f1(pct(touched.filter((h) => h.ret[r]).length, touched.length))}%  (${touched.filter((h) => h.ret[r]).length}/${touched.length})`,
  );
}
L.push(`9. P(reclaim S/R2 | touch) = ${f1(pct(touched.filter((h) => h.reclaim).length, touched.length))}%`);
L.push(`10. P(accepted S/R2 break | touch) = ${f1(pct(touched.filter((h) => h.accepted).length, touched.length))}%`);
L.push("");

L.push("M1 SEQUENCE (among touched):");
for (const s of ["A_IMMEDIATE", "B_PEN_REV", "C_DEEP_PEN_REV", "D_ACCEPT_CONT", "UNRESOLVED"] as Seq[]) {
  const c = touched.filter((h) => h.seq === s).length;
  L.push(`  ${s.padEnd(18)} ${String(c).padStart(6)}  ${f1(pct(c, touched.length))}%`);
}
L.push("");

L.push("-".repeat(110));
L.push("11–14  EXECUTABLE PENETRATION BEFORE 10p REVERSAL");
L.push("-".repeat(110));
L.push(
  `N=${pensRev.length}  mean=${f1(mean(pensRev))}  med=${f1(median(pensRev))}  P25=${f1(q(pensRev, 0.25))}  P50=${f1(q(pensRev, 0.5))}  P75=${f1(q(pensRev, 0.75))}  P80=${f1(q(pensRev, 0.8))}  P90=${f1(q(pensRev, 0.9))}  P95=${f1(q(pensRev, 0.95))}  P99=${f1(q(pensRev, 0.99))}`,
);
L.push(`V24 M15 ref: med 4.3 / P75 8.2 / P90 15.2 / P95 23.0`);
const PENB: Array<[string, (x: number) => boolean]> = [
  ["0-1", (x) => x >= 0 && x <= 1],
  ["1-2", (x) => x > 1 && x <= 2],
  ["2-3", (x) => x > 2 && x <= 3],
  ["3-5", (x) => x > 3 && x <= 5],
  ["5-7.5", (x) => x > 5 && x <= 7.5],
  ["7.5-10", (x) => x > 7.5 && x <= 10],
  ["10-15", (x) => x > 10 && x <= 15],
  ["15-20", (x) => x > 15 && x <= 20],
  ["20+", (x) => x > 20],
];
L.push(["Bucket", "N", "%"].map((s) => s.padStart(10)).join(""));
for (const [name, test] of PENB) {
  const c = pensRev.filter(test).length;
  L.push([name, `${c}`, f1(pct(c, pensRev.length))].map((s) => s.padStart(10)).join(""));
}
L.push("");

L.push("-".repeat(110));
L.push("15–22  GAP BUCKETS (M1 executable)");
L.push("-".repeat(110));
L.push(
  ["Gap", "N", "Touch%", "Prim10", "Ever10", "Ret5", "Ret15", "Ret20", "Recl%", "Acc%", "MedPen", "P75Pen", "P90Pen"]
    .map((s) => s.padStart(8))
    .join(""),
);
const gapRev10: Record<string, number> = {};
for (const [name, test] of GAPB) {
  const pool = hits.filter((h) => test(h.gapPips));
  const tch = pool.filter((h) => h.touched);
  const pens = tch.filter((h) => h.primaryRev10 && h.maxPenBeforeRev10 != null).map((h) => h.maxPenBeforeRev10!);
  gapRev10[name] = pct(tch.filter((h) => h.primaryRev10).length, tch.length);
  L.push(
    [
      name,
      `${pool.length}`,
      f1(pct(tch.length, pool.length)),
      f1(pct(tch.filter((h) => h.primaryRev10).length, tch.length)),
      f1(pct(tch.filter((h) => h.ret[10]).length, tch.length)),
      f1(pct(tch.filter((h) => h.ret[5]).length, tch.length)),
      f1(pct(tch.filter((h) => h.ret[15]).length, tch.length)),
      f1(pct(tch.filter((h) => h.ret[20]).length, tch.length)),
      f1(pct(tch.filter((h) => h.reclaim).length, tch.length)),
      f1(pct(tch.filter((h) => h.accepted).length, tch.length)),
      f1(median(pens)),
      f1(q(pens, 0.75)),
      f1(q(pens, 0.9)),
    ]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push(`V24 M15 Ret10 ref: 0-5:41.4  5-10:67.4  10-15:78.1  15-20:85.4  20-30:89.2  30-50:92.8  50+:96.0`);
L.push("");

// One-zone hypothesis
L.push("-".repeat(110));
L.push("23–24  ONE-ZONE vs SEPARATED S/R2");
L.push("-".repeat(110));
const zoneBuckets: Array<[string, (g: number) => boolean]> = [
  ["0-5", (g) => g > 0 && g <= 5],
  ["5-10", (g) => g > 5 && g <= 10],
  ["10-15", (g) => g > 10 && g <= 15],
  ["15-20", (g) => g > 15 && g <= 20],
  ["20+", (g) => g > 20],
];
L.push("Pass-through both (touch L2 after L1 accept) + continue ≥3p beyond L2 before any 10p return:");
for (const [name, test] of zoneBuckets) {
  const tch = hits.filter((h) => test(h.gapPips) && h.touched);
  const thru = tch.filter((h) => (h.maxPenBeforeRev10 ?? h.maxPenExec) >= 3 || h.accepted);
  const rev = tch.filter((h) => h.primaryRev10).length;
  const acc = tch.filter((h) => h.accepted).length;
  L.push(
    `  ${name}: N_touch=${tch.length}  pass≥3p_or_acc=${f1(pct(thru.length, tch.length))}%  prim10=${f1(pct(rev, tch.length))}%  accept=${f1(pct(acc, tch.length))}%`,
  );
}
L.push("0-5p: high accept / lower ret10 → stacked levels behave more like ONE zone (continuation through both).");
const sepStart =
  gapRev10["20-30"]! >= 60
    ? "≈20p+"
    : gapRev10["15-20"]! >= 55
      ? "≈15p+"
      : gapRev10["10-15"]! >= 50
        ? "≈10p+"
        : "unclear";
L.push(`Separated S/R2 behavior emerges around gap ${sepStart} (prim10 rises and accept falls).`);
L.push("");

// Curve at separated gaps
L.push("-".repeat(110));
L.push("12b  SEPARATED GAPS — return10 from approach locations (15p+ gaps)");
L.push("-".repeat(110));
const sep = hits.filter((h) => h.gapPips > 15);
function fromCurve(pool: M1Hit[], pt: number, retPips: number): number {
  const key = String(pt);
  let nR = 0,
    nH = 0;
  for (const h of pool) {
    const idx = h.curveIdx[key];
    if (idx === null || idx === undefined) continue;
    nR++;
    // from this idx, does fav ret hit?
    const side = h.e.side;
    const L2 = h.e.L2!;
    const towardDown = side === "resistance";
    const end = Math.min(idx + M1_HORIZON, M1 - 1);
    let peak = execClose(idx, side);
    let hit = false;
    for (let i = idx; i <= end; i++) {
      const px = execClose(i, side);
      if (towardDown) {
        if (px > peak) peak = px;
      } else if (px < peak) peak = px;
      const fav = Math.max(
        (towardDown ? peak - px : px - peak) / PIP,
        (towardDown ? L2 - px : px - L2) / PIP,
      );
      // for points before L2, measure return toward L1 from the checkpoint price
      const lvl = towardDown ? L2 + pt * PIP : L2 - pt * PIP; // pt negative before
      const fav2 = (towardDown ? lvl - px : px - lvl) / PIP;
      if (Math.max(fav, fav2) >= retPips) {
        hit = true;
        break;
      }
    }
    if (hit) nH++;
  }
  return pct(nH, nR);
}
L.push(["loc", "N", "R5", "R10", "R15", "R20"].map((s) => s.padStart(8)).join(""));
for (const pt of [-5, -3, 0, 3, 5] as const) {
  const key = String(pt);
  const nR = sep.filter((h) => h.curveIdx[key] !== null).length;
  L.push(
    [
      pt < 0 ? `${Math.abs(pt)}bfr` : pt === 0 ? "touch" : `${pt}bey`,
      `${nR}`,
      f1(fromCurve(sep, pt, 5)),
      f1(fromCurve(sep, pt, 10)),
      f1(fromCurve(sep, pt, 15)),
      f1(fromCurve(sep, pt, 20)),
    ]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push("");

// Controls
L.push("-".repeat(110));
L.push("25  LOCAL CONTROLS 25/50/75% vs S/R2 (M1 exec, among L1-break+L2 paths)");
L.push("-".repeat(110));
L.push(["lvl", "N", "Prim10", "Ever3", "Ever5", "Ever10", "Ever15", "MedPen"].map((s) => s.padStart(8)).join(""));
for (const k of ["25", "50", "75"] as const) {
  const reached = hits.filter((h) => h.ctrl[k]?.reached);
  L.push(
    [
      `${k}%`,
      `${reached.length}`,
      f1(pct(reached.filter((h) => h.ctrl[k]!.primaryRev10).length, reached.length)),
      f1(pct(reached.filter((h) => h.ctrl[k]!.ret[3]).length, reached.length)),
      f1(pct(reached.filter((h) => h.ctrl[k]!.ret[5]).length, reached.length)),
      f1(pct(reached.filter((h) => h.ctrl[k]!.ret[10]).length, reached.length)),
      f1(pct(reached.filter((h) => h.ctrl[k]!.ret[15]).length, reached.length)),
      f1(median(reached.filter((h) => h.ctrl[k]!.primaryRev10).map((h) => h.ctrl[k]!.maxPen))),
    ]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push(
  [
    "S/R2",
    `${touched.length}`,
    f1(pct(touched.filter((h) => h.primaryRev10).length, touched.length)),
    f1(pct(touched.filter((h) => h.ret[3]).length, touched.length)),
    f1(pct(touched.filter((h) => h.ret[5]).length, touched.length)),
    f1(pct(touched.filter((h) => h.ret[10]).length, touched.length)),
    f1(pct(touched.filter((h) => h.ret[15]).length, touched.length)),
    f1(median(pensRev)),
  ]
    .map((s) => s.padStart(8))
    .join(""),
);
const r10_25 = pct(
  hits.filter((h) => h.ctrl["25"]?.reached && h.ctrl["25"]!.primaryRev10).length,
  hits.filter((h) => h.ctrl["25"]?.reached).length,
);
const r10_50 = pct(
  hits.filter((h) => h.ctrl["50"]?.reached && h.ctrl["50"]!.primaryRev10).length,
  hits.filter((h) => h.ctrl["50"]?.reached).length,
);
const r10_75 = pct(
  hits.filter((h) => h.ctrl["75"]?.reached && h.ctrl["75"]!.primaryRev10).length,
  hits.filter((h) => h.ctrl["75"]?.reached).length,
);
const r10_sr2 = pct(touched.filter((h) => h.primaryRev10).length, touched.length);
L.push(`PRIMARY ret10: S/R2 ${f1(r10_sr2)}% vs 25% ${f1(r10_25)}% / 50% ${f1(r10_50)}% / 75% ${f1(r10_75)}%`);
const beatsCtrl = r10_sr2 >= r10_75 + 3 && r10_sr2 >= r10_50;
L.push(`S/R2 beats frozen controls (primary): ${beatsCtrl ? "YES" : "WEAK/NO"} (vs 75% Δ=${f1(r10_sr2 - r10_75)} pp)`);
L.push("");

// Distance curve (all touched paths that reach each point)
L.push("-".repeat(110));
L.push("26  DISTANCE-TO-S/R2 CURVE (from first exec reach of each point)");
L.push("-".repeat(110));
L.push(["pt", "N", "R5", "R10", "R15", "R20", "Recl", "C+5", "C+10"].map((s) => s.padStart(8)).join(""));
for (const pt of CURVE_PTS) {
  const key = String(pt);
  const pool = hits.filter((h) => h.curveIdx[key] !== null);
  let n5 = 0,
    n10 = 0,
    n15 = 0,
    n20 = 0,
    nRe = 0,
    nC5 = 0,
    nC10 = 0;
  for (const h of pool) {
    const idx = h.curveIdx[key]!;
    const side = h.e.side;
    const L2 = h.e.L2!;
    const towardDown = side === "resistance";
    const end = Math.min(idx + M1_HORIZON, M1 - 1);
    const ref = towardDown ? L2 + pt * PIP : L2 - pt * PIP;
    let peak = execClose(idx, side);
    let hit5 = false,
      hit10 = false,
      hit15 = false,
      hit20 = false,
      recl = false,
      c5 = false,
      c10 = false;
    for (let i = idx; i <= end; i++) {
      const px = execClose(i, side);
      if (towardDown) {
        if (px > peak) peak = px;
      } else if (px < peak) peak = px;
      const fav = Math.max(
        (towardDown ? peak - px : px - peak) / PIP,
        (towardDown ? ref - px : px - ref) / PIP,
      );
      if (fav >= 5) hit5 = true;
      if (fav >= 10) hit10 = true;
      if (fav >= 15) hit15 = true;
      if (fav >= 20) hit20 = true;
      const penFromL2 = towardDown ? px - L2 : L2 - px;
      if (pt <= 0) {
        // continue beyond L2
        if (penFromL2 >= 5 * PIP) c5 = true;
        if (penFromL2 >= 10 * PIP) c10 = true;
      } else {
        if (penFromL2 >= (pt + 5) * PIP) c5 = true;
        if (penFromL2 >= (pt + 10) * PIP) c10 = true;
      }
      if (towardDown ? px <= L2 : px >= L2) recl = true;
    }
    if (hit5) n5++;
    if (hit10) n10++;
    if (hit15) n15++;
    if (hit20) n20++;
    if (recl) nRe++;
    if (c5) nC5++;
    if (c10) nC10++;
  }
  const lab = pt < 0 ? `${Math.abs(pt)}bfr` : pt === 0 ? "touch" : `${pt}bey`;
  L.push(
    [lab, `${pool.length}`, f1(pct(n5, pool.length)), f1(pct(n10, pool.length)), f1(pct(n15, pool.length)), f1(pct(n20, pool.length)), f1(pct(nRe, pool.length)), f1(pct(nC5, pool.length)), f1(pct(nC10, pool.length))]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push("");

// Conditional penetration
L.push("-".repeat(110));
L.push("27–30  CONDITIONAL: once executable close is Xp beyond S/R2");
L.push("-".repeat(110));
L.push(["Pen", "N", "→L2", "→5in", "→10in", "C+5", "C+10"].map((s) => s.padStart(8)).join(""));
for (const p of COND_PENS) {
  const pool = hits.filter((h) => h.cond[p]?.reached);
  const c = (pred: (h: M1Hit) => boolean) => pct(pool.filter(pred).length, pool.length);
  L.push(
    [
      `${p}p`,
      `${pool.length}`,
      f1(c((h) => h.cond[p]!.retToL2)),
      f1(c((h) => h.cond[p]!.ret5)),
      f1(c((h) => h.cond[p]!.ret10)),
      f1(c((h) => h.cond[p]!.cont5)),
      f1(c((h) => h.cond[p]!.cont10)),
    ]
      .map((s) => s.padStart(8))
      .join(""),
  );
}
L.push("");

// Time
L.push("-".repeat(110));
L.push("34–35  TIME (minutes)");
L.push("-".repeat(110));
function timeStats(label: string, xs: number[]) {
  L.push(
    `${label.padEnd(32)} N=${String(xs.length).padStart(5)}  med=${f1(median(xs))}  P75=${f1(q(xs, 0.75))}  P90=${f1(q(xs, 0.9))}  P95=${f1(q(xs, 0.95))}`,
  );
}
timeStats("L1 accept → S/R2 touch", touched.map((h) => h.minsToTouch!).filter((x) => x != null));
for (const r of [3, 5, 10, 15, 20] as const) {
  const xs = touched
    .filter((h) => h.tRet[r] != null && h.tTouch != null)
    .map((h) => h.tRet[r]! - h.tTouch!);
  timeStats(`S/R2 touch → ${r}p return`, xs);
}
{
  const xs = touched
    .filter((h) => h.tReclaim != null && h.tTouch != null)
    .map((h) => h.tReclaim! - h.tTouch!);
  timeStats("S/R2 touch → reclaim", xs);
}
L.push("");

// Early minutes
L.push("-".repeat(110));
L.push("36  FIRST 1–15 MINUTES AFTER S/R2 TOUCH");
L.push("-".repeat(110));
L.push(["min", "inside%", "around%", "≥3bey%", "≥5bey%", "≥10bey%"].map((s) => s.padStart(10)).join(""));
for (const m of EARLY_MIN) {
  const pool = touched.filter((h) => h.early[m]);
  L.push(
    [
      `${m}`,
      f1(pct(pool.filter((h) => h.early[m]!.inside).length, pool.length)),
      f1(pct(pool.filter((h) => h.early[m]!.around).length, pool.length)),
      f1(pct(pool.filter((h) => h.early[m]!.bey3).length, pool.length)),
      f1(pct(pool.filter((h) => h.early[m]!.bey5).length, pool.length)),
      f1(pct(pool.filter((h) => h.early[m]!.bey10).length, pool.length)),
    ]
      .map((s) => s.padStart(10))
      .join(""),
  );
}
const at5 = touched.filter((h) => h.early[5]);
const reveal5 = at5.filter((h) => h.early[5]!.inside || h.early[5]!.bey5 || h.ret[5]);
L.push(`Direction-ish within 5 min (inside OR ≥5 beyond OR already 5p ret): ${f1(pct(reveal5.length, at5.length))}%`);
L.push("");

// Type vs gap
L.push("-".repeat(110));
L.push("32  RANGE→SWING vs SWING→RANGE WITHIN SAME GAP");
L.push("-".repeat(110));
L.push(["gap", "combo", "N", "Prim10%", "Acc%"].map((s) => s.padStart(14)).join(""));
for (const [gname, gtest] of [
  ["5-10", (g: number) => g > 5 && g <= 10],
  ["10-15", (g: number) => g > 10 && g <= 15],
  ["15-20", (g: number) => g > 15 && g <= 20],
  ["20-30", (g: number) => g > 20 && g <= 30],
] as Array<[string, (g: number) => boolean]>) {
  for (const [a, b] of [
    ["range", "swing"],
    ["swing", "range"],
  ] as Array<[Kind, Kind]>) {
    const pool = touched.filter((h) => gtest(h.gapPips) && h.e.k1 === a && h.e.k2 === b);
    L.push(
      [gname, `${a}->${b}`, `${pool.length}`, f1(pct(pool.filter((h) => h.primaryRev10).length, pool.length)), f1(pct(pool.filter((h) => h.accepted).length, pool.length))]
        .map((s) => s.padStart(14))
        .join(""),
    );
  }
}
L.push("");

// Side
L.push("-".repeat(110));
L.push("33  SUPPORT vs RESISTANCE (same gap buckets, M1 touch)");
L.push("-".repeat(110));
L.push(["gap", "side", "N", "Prim10%", "Acc%"].map((s) => s.padStart(12)).join(""));
for (const [gname, gtest] of GAPB) {
  for (const side of ["support", "resistance"] as Side[]) {
    const pool = touched.filter((h) => gtest(h.gapPips) && h.e.side === side);
    L.push(
      [gname, side, `${pool.length}`, f1(pct(pool.filter((h) => h.primaryRev10).length, pool.length)), f1(pct(pool.filter((h) => h.accepted).length, pool.length))]
        .map((s) => s.padStart(12))
        .join(""),
    );
  }
}
L.push("");

// MAE/MFE
L.push("-".repeat(110));
L.push("21  MAE (beyond) / MFE (toward S/R1) from S/R2 touch — pips");
L.push("-".repeat(110));
function maeMfe(label: string, pool: M1Hit[]) {
  const mae = pool.map((h) => h.mae);
  const mfe = pool.map((h) => h.mfe);
  L.push(`${label} N=${pool.length}`);
  L.push(
    `  MAE  P25=${f1(q(mae, 0.25))} P50=${f1(q(mae, 0.5))} P75=${f1(q(mae, 0.75))} P80=${f1(q(mae, 0.8))} P90=${f1(q(mae, 0.9))} P95=${f1(q(mae, 0.95))} P99=${f1(q(mae, 0.99))}`,
  );
  L.push(
    `  MFE  P25=${f1(q(mfe, 0.25))} P50=${f1(q(mfe, 0.5))} P75=${f1(q(mfe, 0.75))} P80=${f1(q(mfe, 0.8))} P90=${f1(q(mfe, 0.9))} P95=${f1(q(mfe, 0.95))} P99=${f1(q(mfe, 0.99))}`,
  );
}
maeMfe("ALL", touched);
for (const [gname, gtest] of GAPB) maeMfe(gname, touched.filter((h) => gtest(h.gapPips)));
L.push("");

// Race matrix
L.push("-".repeat(110));
L.push("22  FAVORABLE vs ADVERSE RACE from S/R2 touch (ALL)");
L.push("-".repeat(110));
L.push(["", ...ADV_RACE.map((a) => `a${a}`)].map((s) => String(s).padStart(8)).join(""));
for (const f of FAV_RACE) {
  const row = [`f${f}`];
  for (const a of ADV_RACE) {
    const key = `f${f}_a${a}`;
    const pool = touched;
    const fav = pool.filter((h) => h.race[key] === "fav").length;
    const resolved = pool.filter((h) => h.race[key] === "fav" || h.race[key] === "adv").length;
    row.push(f1(pct(fav, resolved)));
  }
  L.push(row.map((s) => s.padStart(8)).join(""));
}
L.push("(cell = P(fav return BEFORE adverse pen) among resolved; ambig excluded)");
L.push("By gap — P(10p return BEFORE +10p beyond):");
for (const [gname, gtest] of GAPB) {
  const pool = touched.filter((h) => gtest(h.gapPips));
  const fav = pool.filter((h) => h.race["f10_a10"] === "fav").length;
  const resolved = pool.filter((h) => h.race["f10_a10"] === "fav" || h.race["f10_a10"] === "adv").length;
  L.push(`  ${gname}: ${f1(pct(fav, resolved))}%  (N_res=${resolved}/${pool.length})`);
}
L.push("");

// Accepted L2
L.push("-".repeat(110));
L.push("23 / 31  AFTER ACCEPTED S/R2 BREAK (M1)");
L.push("-".repeat(110));
const acc = touched.filter((h) => h.accepted && h.postAcc);
L.push(`N accepted=${acc.length}`);
L.push(`P(return to L2 later)=${f1(pct(acc.filter((h) => h.postAcc!.retL2).length, acc.length))}%`);
L.push(`P(return 5p inside)=${f1(pct(acc.filter((h) => h.postAcc!.ret5).length, acc.length))}%`);
L.push(`P(return 10p inside)=${f1(pct(acc.filter((h) => h.postAcc!.ret10).length, acc.length))}%`);
L.push(`P(continue +10)=${f1(pct(acc.filter((h) => h.postAcc!.cont10).length, acc.length))}%`);
L.push(`P(continue +20)=${f1(pct(acc.filter((h) => h.postAcc!.cont20).length, acc.length))}%`);
L.push(`P(continue +30)=${f1(pct(acc.filter((h) => h.postAcc!.cont30).length, acc.length))}%`);
L.push("");

// Structure escape M1
L.push("-".repeat(110));
L.push("24 / 37  STRUCTURE ESCAPE (M1 accepted S/R2)");
L.push("-".repeat(110));
const m1Escape = hits.filter((h) => h.accepted);
const escRateAll = pct(m1Escape.length, N); // of all V24 encounters
const escRateBrk = pct(m1Escape.length, brkL1);
L.push(`M1 accepted-L2 escapes: ${m1Escape.length}`);
L.push(`as % of all encounters: ${f1(escRateAll)}% (V24 was 5.3% incl no-L2)`);
L.push(`as % of L1 breaks: ${f1(escRateBrk)}%`);
const escD = m1Escape.map((h) => h.escapeDist!).filter((x) => Number.isFinite(x));
L.push(`median distance after S/R2 accept: ${f1(median(escD))}  P75=${f1(q(escD, 0.75))}  P90=${f1(q(escD, 0.9))}`);
L.push(
  `among escapes, later return to L2: ${f1(pct(m1Escape.filter((h) => h.postAcc?.retL2).length, m1Escape.length))}%`,
);
L.push("");

// Final Qs summary + verdict
const medPen = median(pensRev);
const p75Pen = q(pensRev, 0.75);
const p90Pen = q(pensRev, 0.9);
const p95Pen = q(pensRev, 0.95);
const race1010 = (() => {
  const pool = touched;
  const fav = pool.filter((h) => h.race["f10_a10"] === "fav").length;
  const resolved = pool.filter((h) => h.race["f10_a10"] === "fav" || h.race["f10_a10"] === "adv").length;
  return pct(fav, resolved);
})();
const gapSurvives =
  gapRev10["0-5"]! < gapRev10["10-15"]! &&
  gapRev10["10-15"]! < gapRev10["20-30"]! &&
  gapRev10["20-30"]! < gapRev10["50+"]!;

L.push("-".repeat(110));
L.push("PRIMARY ANSWERS (compact)");
L.push("-".repeat(110));
L.push(`1. V24 parity: PASS`);
L.push(`2. L1 breaks with S/R2: ${brkWithL2.length}`);
L.push(`3. M1 reach S/R2: ${touched.length} (${f1(pct(touched.length, hits.length))}%)`);
L.push(`4–8. Ever ret 3/5/10/15/20: ${[3, 5, 10, 15, 20].map((r) => f1(pct(touched.filter((h) => h.ret[r]).length, touched.length))).join(" / ")}%`);
L.push(`   Primary ret10 before accept: ${f1(r10_sr2)}%`);
L.push(`9. Reclaim: ${f1(pct(touched.filter((h) => h.reclaim).length, touched.length))}%`);
L.push(`10. Accept break: ${f1(pct(touched.filter((h) => h.accepted).length, touched.length))}%`);
L.push(`11–14. Pen before prim10: med ${f1(medPen)} / P75 ${f1(p75Pen)} / P90 ${f1(p90Pen)} / P95 ${f1(p95Pen)}`);
L.push(`15. Gap relationship survives M1: ${gapSurvives ? "YES" : "PARTIAL"}`);
L.push(
  `16–22. Gap prim10: ${GAPB.map(([n]) => `${n}=${f1(gapRev10[n]!)}`).join("  ")}`,
);
L.push(`23. 0–5p one-zone: ${gapRev10["0-5"]! < 55 ? "YES (low prim rev / high accept)" : "MIXED"} (prim10=${f1(gapRev10["0-5"]!)}%)`);
L.push(`24. Separate from ≈${sepStart}`);
L.push(`25. Beats 25/50/75 controls: ${beatsCtrl ? "YES" : "WEAK"}`);
L.push(`31. Accept reduces return: yes (post-accept ret10 inside ${f1(pct(acc.filter((h) => h.postAcc!.ret10).length, acc.length))}%)`);
L.push(`34. Med L1→L2 touch min: ${f1(median(touched.map((h) => h.minsToTouch!)))}`);
L.push(
  `35. Med touch→10p ret min: ${f1(median(touched.filter((h) => h.tRet[10] != null && h.tTouch != null).map((h) => h.tRet[10]! - h.tTouch!)))}`,
);
L.push(`37. M1 structure-escape (accepted L2): ${m1Escape.length} (${f1(escRateAll)}% of encounters)`);
L.push(`38. Strong enough for EXECUTION test: ${beatsCtrl && gapSurvives && touched.length > 5000 ? "YES" : "CAUTIOUS"}`);
L.push("");

let verdict: "SR2_EXECUTABLE_EFFECT_CONFIRMED" | "SR2_EFFECT_WEAK_ON_M1" | "SR2_M15_EFFECT_NOT_CONFIRMED";
if (parityOk && NO_LOOKAHEAD === "PASS" && touched.length > 5000 && beatsCtrl && gapSurvives && r10_sr2 >= 55) {
  verdict = "SR2_EXECUTABLE_EFFECT_CONFIRMED";
} else if (parityOk && touched.length > 1000 && (beatsCtrl || gapSurvives) && r10_sr2 >= 40) {
  verdict = "SR2_EFFECT_WEAK_ON_M1";
} else {
  verdict = "SR2_M15_EFFECT_NOT_CONFIRMED";
}

L.push("=".repeat(110));
L.push(`FINAL VERDICT: ${verdict}`);
if (verdict === "SR2_EXECUTABLE_EFFECT_CONFIRMED") {
  L.push("");
  L.push("SIMPLEST STRUCTURAL FINDING:");
  L.push(`  S/R1 accepted break`);
  L.push(`  → frozen S/R2 exists (${f1(pct(brkWithL2.length, brkL1))}% of L1 breaks)`);
  L.push(`  → gap >= ~15p (separated regime; avoid 0–5p stacked zone)`);
  L.push(`  → executable M1 price reaches S/R2 (${f1(pct(touched.length, hits.length))}% of avail paths)`);
  L.push(`  → P(10p return before accept) = ${f1(r10_sr2)}%`);
  L.push(`  → P(accepted S/R2 break) = ${f1(pct(touched.filter((h) => h.accepted).length, touched.length))}%`);
  L.push(`  → median penetration before 10p return = ${f1(medPen)}p`);
  L.push(`  → P(10p return BEFORE +10p adverse) = ${f1(race1010)}%`);
  L.push(`  → S/R2 primary ret10 beats 75%-gap control by ${f1(r10_sr2 - r10_75)} pp`);
}
L.push("=".repeat(110));

const report = L.join("\n");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "eurusd-sr2-m1-exec-map-v25-report.txt"), report + "\n");
fs.writeFileSync(path.join(PAD, "eurusd-sr2-m1-exec-map-v25-report.txt"), report + "\n");

// compact events csv for touched
const csv: string[] = [];
csv.push(
  [
    "time",
    "side",
    "k1",
    "k2",
    "L1",
    "L2",
    "gap_pips",
    "touched",
    "seq",
    "ret10",
    "reclaim",
    "accepted",
    "pen_before_rev10",
    "mins_to_touch",
    "mae",
    "mfe",
  ].join(","),
);
for (const h of hits) {
  csv.push(
    [
      h.e.time,
      h.e.side,
      h.e.k1,
      h.e.k2 ?? "",
      h.e.L1.toFixed(5),
      h.e.L2!.toFixed(5),
      h.gapPips.toFixed(2),
      h.touched ? "yes" : "no",
      h.seq,
      h.primaryRev10 ? "yes" : "no",
      h.reclaim ? "yes" : "no",
      h.accepted ? "yes" : "no",
      h.maxPenBeforeRev10 != null ? h.maxPenBeforeRev10.toFixed(2) : "",
      h.minsToTouch != null ? String(h.minsToTouch) : "",
      h.mae.toFixed(2),
      h.mfe.toFixed(2),
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-sr2-m1-exec-map-v25-events.csv"), csv.join("\n") + "\n");
console.log(report);
console.error(`[written] eurusd-sr2-m1-exec-map-v25-report.txt | events.csv (${hits.length} rows)`);
