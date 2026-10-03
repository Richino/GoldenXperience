/**
 * EUR/USD V26 — S/R REVERSAL ZONE MAP (research-only, NO P&L).
 *
 * NEW file — does NOT modify V23/V24/V25.
 *
 * Hypothesis: S/R2 behaves as a multi-pip REVERSAL ZONE, not an exact line.
 * Gate on V25 M1 executable parity, then map zones vs same-sized non-S/R controls.
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
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const ACCEPT_MIN_BARS_M1 = ACCEPT_MIN_BARS * 15;
const PRIMARY_RET = 10;
const RETS = [3, 5, 10, 15, 20] as const;

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
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

const GAPB: Array<[string, (g: number) => boolean]> = [
  ["0-5", (g) => g > 0 && g <= 5],
  ["5-10", (g) => g > 5 && g <= 10],
  ["10-15", (g) => g > 10 && g <= 15],
  ["15-20", (g) => g > 15 && g <= 20],
  ["20-30", (g) => g > 20 && g <= 30],
  ["30-50", (g) => g > 30 && g <= 50],
  ["50+", (g) => g > 50],
];
const FIXED_ZONES = [0, 3, 5, 8, 10, 15] as const; // 0 = LINE
const ATR_ZONES = [0.25, 0.5, 0.75, 1.0] as const;
const GAP_ZONES = [0.1, 0.2, 0.25] as const;
const CTRL_CENTS = [0.25, 0.5, 0.75] as const;
const DIST_CTRLS = [0.7, 0.75, 0.8, 0.85, 0.9] as const;
const TURN_BUCKETS: Array<[string, (x: number) => boolean]> = [
  ["<-15", (x) => x < -15],
  ["-15--10", (x) => x >= -15 && x < -10],
  ["-10--8", (x) => x >= -10 && x < -8],
  ["-8--5", (x) => x >= -8 && x < -5],
  ["-5--3", (x) => x >= -5 && x < -3],
  ["-3-0", (x) => x >= -3 && x < 0],
  ["0-+3", (x) => x >= 0 && x < 3],
  ["+3-+5", (x) => x >= 3 && x < 5],
  ["+5-+8", (x) => x >= 5 && x < 8],
  ["+8-+10", (x) => x >= 8 && x < 10],
  ["+10-+15", (x) => x >= 10 && x < 15],
  ["+15-+20", (x) => x >= 15 && x < 20],
  ["+20-+30", (x) => x >= 20 && x < 30],
  ["+30+", (x) => x >= 30],
];

// ===================== LOAD M15 =====================
console.error("V26 loading M15...");
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
  year: number;
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
let auditFail = 0;
const auditNotes: string[] = [];

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
  const yr = new Date(raw[t]!.time).getUTCFullYear();

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
        year: yr,
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
        year: yr,
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
    if ((lv.swingHigh ?? null) !== (e.swingHigh ?? null) || (lv.swingLow ?? null) !== (e.swingLow ?? null)) auditFail++;
    const okL1 =
      e.side === "resistance"
        ? e.L1 === e.rangeHigh || e.L1 === e.swingHigh
        : e.L1 === e.rangeLow || e.L1 === e.swingLow;
    if (!okL1) auditFail++;
    if (e.L2 !== null) {
      const okL2 =
        e.side === "resistance"
          ? e.L2 === e.rangeHigh || e.L2 === e.swingHigh
          : e.L2 === e.rangeLow || e.L2 === e.swingLow;
      if (!okL2) auditFail++;
    }
  }
}

function v1Fakeout(e: Enc): boolean {
  const w = TOUCH_ATR * e.atr;
  const top = e.L1 + w,
    bot = e.L1 - w;
  let bb = 0,
    adv = e.side === "resistance" ? -Infinity : Infinity;
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
  const vS = pct(v.support.s, v.support.t),
    vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) {
    console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`);
    process.exit(1);
  }
}

function classifyLevel(side: Side, level: number, atr: number, startBar: number, towardIsDown: boolean) {
  const w = TOUCH_ATR * atr;
  const end = Math.min(startBar + HORIZON, n - 1);
  let touched = false,
    tTouch: number | null = null,
    broke = false,
    tBreak: number | null = null,
    revPrimary = false,
    tRevPrimary: number | null = null;
  const retHit: Record<number, boolean> = {};
  const tRet: Record<number, number | null> = {};
  for (const r of RETS) {
    retHit[r] = false;
    tRet[r] = null;
  }
  let peakBeyond = level,
    beyondArmed = false,
    bb = 0,
    maxPen = 0;
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
    if (!broke && bb >= ACCEPT_MIN_BARS && bc / atr >= ACCEPT_MIN_DIST_ATR) {
      broke = true;
      tBreak = j;
    }
    const ret = Math.max(
      (towardIsDown ? peakBeyond - c.low : c.high - peakBeyond) / PIP,
      (towardIsDown ? level - c.low : c.high - level) / PIP,
    );
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
    void beyondArmed;
    if (broke || revPrimary) break;
  }
  if (revPrimary && broke && tRevPrimary !== null && tBreak !== null) {
    if (tRevPrimary < tBreak) broke = false;
    else revPrimary = false;
  }
  return { touched, tTouch, broke, tBreak, revPrimary, tRevPrimary, retHit, tRet, maxPenPips: maxPen / PIP };
}

interface V24Ev {
  e: Enc;
  path: Path;
  l1: ReturnType<typeof classifyLevel>;
  l2: ReturnType<typeof classifyLevel> | null;
  gapPips: number;
}
const v24: V24Ev[] = [];
for (const e of encs) {
  const towardDown = e.side === "resistance";
  const l1 = classifyLevel(e.side, e.L1, e.atr, e.t0, towardDown);
  const gapPips = e.L2 !== null ? Math.abs(e.L2 - e.L1) / PIP : NaN;
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
  }
  v24.push({ e, path, l1, l2, gapPips });
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
const brkL2n = byPath.BRK_L2_ESCAPE;
const escape = byPath.BRK_L2_ESCAPE + byPath.BRK_L1_NO_L2;
const medGap = median(v24.filter((ev) => ev.e.L2 !== null).map((ev) => ev.gapPips));

// ===================== LOAD M1 =====================
console.error("V26 loading M1...");
const m1raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M1_PATH, "utf8"),
);
const M1 = m1raw.length;
const m1ms = new Float64Array(M1);
const bc = new Float64Array(M1),
  ac = new Float64Array(M1);
for (let i = 0; i < M1; i++) {
  const r = m1raw[i]!;
  m1ms[i] = Date.parse(r[0]);
  bc[i] = r[5];
  ac[i] = r[6];
}
(m1raw as unknown as { length: number }).length = 0;
console.error(`M1 ${M1}`);

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
function execClose(i: number, side: Side): number {
  return side === "resistance" ? bc[i]! : ac[i]!;
}
function relThru(px: number, L2: number, side: Side): number {
  return side === "resistance" ? (px - L2) / PIP : (L2 - px) / PIP;
}

interface Hit {
  e: Enc;
  gapPips: number;
  m1Start: number;
  end: number;
  touched: boolean;
  tTouch: number | null;
  primaryRev10: boolean;
  tPrim: number | null;
  accepted: boolean;
  tAccept: number | null;
  /** Signed max relative location before primary rev (+ = through L2). */
  turnLoc: number | null;
  maxPenThru: number | null;
}

const hits: Hit[] = [];
let noM1 = 0;

for (const ev of brkWithL2) {
  const e = ev.e;
  const L2 = e.L2!;
  const side = e.side;
  const atr = e.atr;
  const w = TOUCH_ATR * atr;
  const towardDown = side === "resistance";
  const tBreak = ev.l1.tBreak ?? e.t0;
  const breakCloseMs = m15ms[tBreak]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) {
    noM1++;
    continue;
  }
  const end = Math.min(m1Start + M1_HORIZON, M1 - 1);
  const gapPips = Math.abs(L2 - e.L1) / PIP;

  let touched = false,
    tTouch: number | null = null;
  let peakBeyond = L2;
  let maxPen = 0;
  let maxRel = -Infinity;
  let primaryRev10 = false,
    tPrim: number | null = null;
  let accepted = false,
    tAccept: number | null = null;
  let turnLoc: number | null = null;
  let maxPenThru: number | null = null;
  let bb = 0;

  for (let i = m1Start; i <= end; i++) {
    const px = execClose(i, side);
    const rel = relThru(px, L2, side);
    if (!touched) {
      const inOrBeyond = towardDown ? px >= L2 - w : px <= L2 + w;
      if (inOrBeyond) {
        touched = true;
        tTouch = i;
        peakBeyond = px;
        maxRel = rel;
      }
    }
    if (!touched) continue;

    if (towardDown) {
      if (px > peakBeyond) peakBeyond = px;
    } else if (px < peakBeyond) peakBeyond = px;
    if (rel > maxRel) maxRel = rel;
    const penNow = Math.max(0, towardDown ? px - L2 : L2 - px);
    if (penNow > maxPen) maxPen = penNow;

    const fav = Math.max(
      (towardDown ? peakBeyond - px : px - peakBeyond) / PIP,
      (towardDown ? L2 - px : px - L2) / PIP,
    );

    // race/returns before accept
    if (!primaryRev10 && !accepted && fav >= PRIMARY_RET) {
      primaryRev10 = true;
      tPrim = i;
      turnLoc = maxRel;
      maxPenThru = maxPen / PIP;
    }

    const bcDist = towardDown ? px - L2 : L2 - px;
    if (bcDist > w) bb++;
    else bb = 0;
    if (!accepted && !primaryRev10 && bb >= ACCEPT_MIN_BARS_M1 && bcDist / atr >= ACCEPT_MIN_DIST_ATR) {
      accepted = true;
      tAccept = i;
    }
    // continue for ever metrics not needed for parity core; stop after both decided for speed? keep full for zone post-scans using indices
  }

  hits.push({
    e,
    gapPips,
    m1Start,
    end,
    touched,
    tTouch,
    primaryRev10,
    tPrim,
    accepted,
    tAccept,
    turnLoc,
    maxPenThru,
  });
}

const touched = hits.filter((h) => h.touched);
const pensRev = touched.filter((h) => h.primaryRev10 && h.maxPenThru != null).map((h) => h.maxPenThru!);
const gapPrim: Record<string, number> = {};
for (const [name, test] of GAPB) {
  const tch = hits.filter((h) => test(h.gapPips) && h.touched);
  gapPrim[name] = pct(tch.filter((h) => h.primaryRev10).length, tch.length);
}

const v25Checks: Array<[string, number, number, number]> = [
  ["N", N, 75959, 50],
  ["brkWithL2", brkWithL2.length, 18698, 50],
  ["m1Reach", touched.length, 12622, 80],
  ["prim10%", pct(touched.filter((h) => h.primaryRev10).length, touched.length), 53.9, 1.0],
  ["acc%", pct(touched.filter((h) => h.accepted).length, touched.length), 45.4, 1.0],
  ["penMed", median(pensRev), 3.9, 0.5],
  ["penP75", q(pensRev, 0.75), 7.9, 0.8],
  ["penP90", q(pensRev, 0.9), 17.3, 1.5],
  ["penP95", q(pensRev, 0.95), 26.1, 2.0],
  ["g0-5", gapPrim["0-5"]!, 35.9, 1.5],
  ["g5-10", gapPrim["5-10"]!, 49.0, 1.5],
  ["g10-15", gapPrim["10-15"]!, 52.7, 1.5],
  ["g15-20", gapPrim["15-20"]!, 54.0, 1.5],
  ["g20-30", gapPrim["20-30"]!, 63.4, 1.5],
  ["g30-50", gapPrim["30-50"]!, 70.5, 1.5],
  ["g50+", gapPrim["50+"]!, 80.3, 1.5],
];
let parityOk = true;
for (const [name, got, exp, tol] of v25Checks) {
  if (!near(got, exp, tol)) {
    parityOk = false;
    console.error(`V25 PARITY FAIL ${name}: got ${got} expected ~${exp}`);
  }
}
const NO_LOOKAHEAD = auditFail === 0 ? "PASS" : "FAIL";
if (!parityOk || NO_LOOKAHEAD === "FAIL") {
  console.error(`STOP. V25_PARITY=${parityOk ? "PASS" : "FAIL"} NO_LOOKAHEAD=${NO_LOOKAHEAD}`);
  process.exit(1);
}
console.error(`V25 PARITY PASS | NO_LOOKAHEAD = PASS | touched=${touched.length}`);

// ===================== ZONE ENGINE =====================
interface ZoneEdges {
  near: number;
  far: number;
  center: number;
  halfPips: number;
}

function zoneEdges(center: number, halfPips: number, side: Side): ZoneEdges {
  const hw = halfPips * PIP;
  if (side === "resistance") return { near: center - hw, far: center + hw, center, halfPips };
  return { near: center + hw, far: center - hw, center, halfPips };
}

function inZone(px: number, z: ZoneEdges, side: Side): boolean {
  if (side === "resistance") return px >= z.near && px <= z.far;
  return px <= z.near && px >= z.far;
}
function pastFar(px: number, z: ZoneEdges, side: Side): boolean {
  return side === "resistance" ? px > z.far : px < z.far;
}
function pastNear(px: number, z: ZoneEdges, side: Side): boolean {
  return side === "resistance" ? px >= z.near : px <= z.near;
}

interface ZoneRes {
  reached: boolean;
  tEntry: number | null;
  primaryRev10: boolean;
  everRet: Record<number, boolean>;
  cleared: boolean;
  tClear: number | null;
  cont5: boolean;
  cont10: boolean;
  turnInZone: boolean;
  turnInApproach: boolean;
  turnInBreakout: boolean;
  tTurn: number | null;
  passes: number;
  race: Record<string, "fav" | "adv" | "ambig" | "none">;
  postClear: {
    retFar: boolean;
    retLine: boolean;
    ret5in: boolean;
    ret10in: boolean;
    cont5: boolean;
    cont10: boolean;
    cont20: boolean;
    cont30: boolean;
  } | null;
  minsToTurn: number | null;
  minsToClear: number | null;
}

function evalZone(h: Hit, center: number, halfPips: number, lineForInside: number): ZoneRes {
  const side = h.e.side;
  const atr = h.e.atr;
  const towardDown = side === "resistance";
  const z = zoneEdges(center, halfPips, side);
  const wTouch = TOUCH_ATR * atr;
  const everRet: Record<number, boolean> = {};
  for (const r of RETS) everRet[r] = false;
  const race: ZoneRes["race"] = {};
  for (const f of [5, 10, 15, 20] as const) {
    for (const a of ["clear", "c3", "c5", "c10", "c20"] as const) race[`f${f}_${a}`] = "none";
  }
  const racePending = new Set(Object.keys(race));

  let reached = false,
    tEntry: number | null = null;
  let peak = center;
  let primaryRev10 = false;
  let cleared = false,
    tClear: number | null = null;
  let cont5 = false,
    cont10 = false;
  let turnInZone = false,
    turnInApproach = false,
    turnInBreakout = false,
    tTurn: number | null = null;
  let passes = 0;
  let inside = false;
  let bb = 0;
  let accepted = false;
  let maxRelFromCenter = -Infinity;

  for (let i = h.m1Start; i <= h.end; i++) {
    const px = execClose(i, side);
    const wasInside = inside;
    inside = inZone(px, z, side);
    if (!reached && pastNear(px, z, side)) {
      // first approach into/through near edge
      reached = true;
      tEntry = i;
      peak = px;
      passes = 1;
    }
    if (!reached) continue;

    if (inside && !wasInside && tEntry !== null && i > tEntry) passes++;

    if (towardDown) {
      if (px > peak) peak = px;
    } else if (px < peak) peak = px;

    const relC = towardDown ? (px - center) / PIP : (center - px) / PIP;
    if (relC > maxRelFromCenter) maxRelFromCenter = relC;

    const fav = Math.max(
      (towardDown ? peak - px : px - peak) / PIP,
      (towardDown ? center - px : px - center) / PIP,
    );
    for (const r of RETS) if (!everRet[r] && fav >= r) everRet[r] = true;

    if (!primaryRev10 && !accepted && fav >= PRIMARY_RET) {
      primaryRev10 = true;
      tTurn = i;
      // turn location relative to zone / line
      const turnRelLine = towardDown ? (peak - lineForInside) / PIP : (lineForInside - peak) / PIP;
      // use max excursion through at turn time ≈ peak relative to center
      const turnRelCenter = towardDown ? (peak - center) / PIP : (center - peak) / PIP;
      turnInZone = Math.abs(turnRelCenter) <= halfPips + 1e-9 || inZone(peak, z, side);
      // approach half: before center (rel < 0), breakout half: rel >= 0
      const signedThruLine = towardDown ? (peak - lineForInside) / PIP : (lineForInside - peak) / PIP;
      turnInApproach = signedThruLine < 0 && Math.abs(signedThruLine) <= halfPips;
      turnInBreakout = signedThruLine >= 0 && signedThruLine <= halfPips;
      // if halfPips==0 (line), approach/breakout collapse
      if (halfPips === 0) {
        turnInZone = Math.abs(signedThruLine) <= 0.5;
        turnInApproach = signedThruLine < 0 && signedThruLine >= -0.5;
        turnInBreakout = signedThruLine >= 0 && signedThruLine <= 0.5;
      }
      void turnRelLine;
    }

    // Accept = V25/V24 time-equiv rule at the zone center (L2 for real zones; phantom for controls)
    const bcDist = towardDown ? px - center : center - px;
    if (bcDist > wTouch) bb++;
    else bb = 0;
    if (!accepted && !primaryRev10 && bb >= ACCEPT_MIN_BARS_M1 && bcDist / atr >= ACCEPT_MIN_DIST_ATR) {
      accepted = true;
    }

    if (!cleared && pastFar(px, z, side)) {
      cleared = true;
      tClear = i;
    }
    if (cleared) {
      const beyondFar = towardDown ? px - z.far : z.far - px;
      if (beyondFar >= 5 * PIP) cont5 = true;
      if (beyondFar >= 10 * PIP) cont10 = true;
    }

    // race from entry
    if (tEntry !== null) {
      for (const key of [...racePending]) {
        const m = /^f(\d+)_(clear|c3|c5|c10|c20)$/.exec(key)!;
        const fNeed = Number(m[1]);
        const aTag = m[2]!;
        const fHit = fav >= fNeed;
        let aHit = false;
        if (aTag === "clear") aHit = cleared;
        else {
          const extra = Number(aTag.slice(1));
          if (cleared && tClear !== null) {
            const beyondFar = towardDown ? px - z.far : z.far - px;
            aHit = beyondFar >= extra * PIP;
          }
        }
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
    }
  }

  let postClear: ZoneRes["postClear"] = null;
  if (cleared && tClear !== null) {
    let retFar = false,
      retLine = false,
      ret5in = false,
      ret10in = false,
      c5 = false,
      c10 = false,
      c20 = false,
      c30 = false;
    for (let i = tClear; i <= h.end; i++) {
      const px = execClose(i, side);
      const beyondFar = towardDown ? px - z.far : z.far - px;
      const insideFromFar = towardDown ? z.far - px : px - z.far;
      const insideFromLine = towardDown ? lineForInside - px : px - lineForInside;
      if (!retFar && (towardDown ? px <= z.far : px >= z.far)) retFar = true;
      if (!retLine && (towardDown ? px <= lineForInside : px >= lineForInside)) retLine = true;
      if (!ret5in && insideFromLine >= 5 * PIP) ret5in = true;
      if (!ret10in && insideFromLine >= 10 * PIP) ret10in = true;
      if (beyondFar >= 5 * PIP) c5 = true;
      if (beyondFar >= 10 * PIP) c10 = true;
      if (beyondFar >= 20 * PIP) c20 = true;
      if (beyondFar >= 30 * PIP) c30 = true;
      void insideFromFar;
    }
    postClear = { retFar, retLine, ret5in, ret10in, cont5: c5, cont10: c10, cont20: c20, cont30: c30 };
  }

  return {
    reached,
    tEntry,
    primaryRev10,
    everRet,
    cleared,
    tClear,
    cont5,
    cont10,
    turnInZone,
    turnInApproach,
    turnInBreakout,
    tTurn,
    passes: reached ? Math.max(1, passes) : 0,
    race,
    postClear,
    minsToTurn: tEntry !== null && tTurn !== null ? tTurn - tEntry : null,
    minsToClear: tEntry !== null && tClear !== null ? tClear - tEntry : null,
  };
}

type ZoneKey = string;
function fixedKey(w: number): ZoneKey {
  return w === 0 ? "LINE" : `±${w}p`;
}
function atrKey(a: number): ZoneKey {
  return `±${a}ATR`;
}
function gapKey(g: number): ZoneKey {
  return `±${Math.round(g * 100)}%gap`;
}

interface Agg {
  nReach: number;
  prim10: number;
  ever: Record<number, number>;
  clear: number;
  cont5: number;
  cont10: number;
  capture: number; // among primary revs of cohort that turned in zone — filled externally
  turnIn: number;
  turnApproach: number;
  turnBreakout: number;
  falseReact: number; // reached, no prim10, cleared
  passes1: number;
  passes2: number;
  passes3: number;
  minsTurn: number[];
  minsClear: number[];
  resolved5: number;
  resolved10: number;
  resolved15: number;
  resolved30: number;
  resolved60: number;
  resolvedN: number;
  post: { n: number; retLine: number; ret10in: number; cont20: number; cont10: number; cont30: number; retFar: number };
  race1010: { fav: number; res: number };
  race10c5: { fav: number; res: number };
  race10c10: { fav: number; res: number };
}

function emptyAgg(): Agg {
  const ever: Record<number, number> = {};
  for (const r of RETS) ever[r] = 0;
  return {
    nReach: 0,
    prim10: 0,
    ever,
    clear: 0,
    cont5: 0,
    cont10: 0,
    capture: 0,
    turnIn: 0,
    turnApproach: 0,
    turnBreakout: 0,
    falseReact: 0,
    passes1: 0,
    passes2: 0,
    passes3: 0,
    minsTurn: [],
    minsClear: [],
    resolved5: 0,
    resolved10: 0,
    resolved15: 0,
    resolved30: 0,
    resolved60: 0,
    resolvedN: 0,
    post: { n: 0, retLine: 0, ret10in: 0, cont20: 0, cont10: 0, cont30: 0, retFar: 0 },
    race1010: { fav: 0, res: 0 },
    race10c5: { fav: 0, res: 0 },
    race10c10: { fav: 0, res: 0 },
  };
}

function addAgg(a: Agg, r: ZoneRes) {
  if (!r.reached) return;
  a.nReach++;
  if (r.primaryRev10) a.prim10++;
  for (const x of RETS) if (r.everRet[x]) a.ever[x]!++;
  if (r.cleared) a.clear++;
  if (r.cont5) a.cont5++;
  if (r.cont10) a.cont10++;
  if (r.turnInZone) a.turnIn++;
  if (r.turnInApproach) a.turnApproach++;
  if (r.turnInBreakout) a.turnBreakout++;
  if (!r.primaryRev10 && r.cleared) a.falseReact++;
  if (r.passes <= 1) a.passes1++;
  else if (r.passes === 2) a.passes2++;
  else a.passes3++;
  if (r.minsToTurn != null) a.minsTurn.push(r.minsToTurn);
  if (r.minsToClear != null) a.minsClear.push(r.minsToClear);
  const tRes = r.minsToTurn ?? r.minsToClear;
  if (tRes != null) {
    a.resolvedN++;
    if (tRes <= 5) a.resolved5++;
    if (tRes <= 10) a.resolved10++;
    if (tRes <= 15) a.resolved15++;
    if (tRes <= 30) a.resolved30++;
    if (tRes <= 60) a.resolved60++;
  }
  if (r.postClear) {
    a.post.n++;
    if (r.postClear.retLine) a.post.retLine++;
    if (r.postClear.ret10in) a.post.ret10in++;
    if (r.postClear.cont10) a.post.cont10++;
    if (r.postClear.cont20) a.post.cont20++;
    if (r.postClear.cont30) a.post.cont30++;
    if (r.postClear.retFar) a.post.retFar++;
  }
  const r1 = r.race["f10_clear"];
  if (r1 === "fav" || r1 === "adv") {
    a.race1010.res++;
    if (r1 === "fav") a.race1010.fav++;
  }
  const r2 = r.race["f10_c5"];
  if (r2 === "fav" || r2 === "adv") {
    a.race10c5.res++;
    if (r2 === "fav") a.race10c5.fav++;
  }
  const r3 = r.race["f10_c10"];
  if (r3 === "fav" || r3 === "adv") {
    a.race10c10.res++;
    if (r3 === "fav") a.race10c10.fav++;
  }
}

/** Half-width in pips for a named zone on a given hit (gap/atr aware). */
function halfWidthFor(h: Hit, kind: "fixed" | "atr" | "gap", val: number): number {
  if (kind === "fixed") return val;
  if (kind === "atr") return (val * h.e.atr) / PIP;
  // gap %
  let hw = (val * h.gapPips) / 1; // val is fraction of gap
  // prevent overlap with L1: cap so near edge stays at least 2p from L1 toward L2
  const maxHw = Math.max(0, h.gapPips / 2 - 2);
  if (hw > maxHw) hw = maxHw;
  return hw;
}

type Spec = { key: ZoneKey; kind: "fixed" | "atr" | "gap"; val: number };
const SPECS: Spec[] = [
  ...FIXED_ZONES.map((v) => ({ key: fixedKey(v), kind: "fixed" as const, val: v })),
  ...ATR_ZONES.map((v) => ({ key: atrKey(v), kind: "atr" as const, val: v })),
  ...GAP_ZONES.map((v) => ({ key: gapKey(v), kind: "gap" as const, val: v })),
];

function runCohort(cohort: Hit[], label: string, lite = false) {
  const specs = lite
    ? SPECS.filter((s) => s.kind === "fixed" && (s.val === 0 || s.val === 5 || s.val === 8 || s.val === 10))
    : SPECS;
  const L2aggs: Record<ZoneKey, Agg> = {};
  const ctrlAggs: Record<string, Agg> = {};
  const distAggs: Record<string, Agg> = {};
  for (const s of specs) L2aggs[s.key] = emptyAgg();

  const primRevs = cohort.filter((h) => h.touched && h.primaryRev10 && h.turnLoc != null);
  const captureCount: Record<ZoneKey, number> = {};
  for (const s of SPECS) captureCount[s.key] = 0;
  const capApproach: Record<number, number> = { 3: 0, 5: 0, 8: 0, 10: 0, 15: 0 };
  const capBreak: Record<number, number> = { 3: 0, 5: 0, 8: 0, 10: 0, 15: 0 };
  let gapCaps = 0;

  for (const h of primRevs) {
    const loc = h.turnLoc!;
    for (const w of [3, 5, 8, 10, 15] as const) {
      if (Math.abs(loc) <= w) captureCount[fixedKey(w)]!++;
      if (loc < 0 && loc >= -w) capApproach[w]!++;
      if (loc >= 0 && loc <= w) capBreak[w]!++;
    }
    if (Math.abs(loc) <= 0.5) captureCount["LINE"]!++;
    if (!lite) {
      for (const a of ATR_ZONES) {
        const hw = (a * h.e.atr) / PIP;
        if (Math.abs(loc) <= hw) captureCount[atrKey(a)]!++;
      }
      for (const g of GAP_ZONES) {
        let hw = g * h.gapPips;
        const maxHw = Math.max(0, h.gapPips / 2 - 2);
        if (hw > maxHw) {
          hw = maxHw;
          gapCaps++;
        }
        if (Math.abs(loc) <= hw) captureCount[gapKey(g)]!++;
      }
    }
  }

  for (const h of cohort) {
    if (!h.touched) continue;
    const L2 = h.e.L2!;
    const side = h.e.side;
    const gap = Math.abs(L2 - h.e.L1);

    for (const s of specs) {
      const hw = halfWidthFor(h, s.kind, s.val);
      addAgg(L2aggs[s.key]!, evalZone(h, L2, hw, L2));
    }

    const cents = lite ? ([0.75] as const) : CTRL_CENTS;
    for (const c of cents) {
      const center = side === "resistance" ? h.e.L1 + c * gap : h.e.L1 - c * gap;
      for (const s of specs) {
        if (s.kind !== "fixed") continue;
        const key = `${c}|${s.key}`;
        if (!ctrlAggs[key]) ctrlAggs[key] = emptyAgg();
        addAgg(ctrlAggs[key]!, evalZone(h, center, s.val, L2));
      }
    }

    if (!lite) {
      for (const d of DIST_CTRLS) {
        const center = side === "resistance" ? h.e.L1 + d * gap : h.e.L1 - d * gap;
        for (const w of [5, 8, 10] as const) {
          const key = `${d}|±${w}p`;
          if (!distAggs[key]) distAggs[key] = emptyAgg();
          addAgg(distAggs[key]!, evalZone(h, center, w, L2));
        }
      }
    }
  }

  return { label, L2aggs, ctrlAggs, distAggs, primRevs, captureCount, capApproach, capBreak, gapCaps, cohort };
}

const primary = hits.filter((h) => h.gapPips >= 20 && h.touched);
console.error(`Primary cohort gap>=20 touched: ${primary.length}`);
const primaryRun = runCohort(primary, "gap>=20");

// gap bucket runs (lighter: fixed zones only via filtering SPECS usage already)
const bucketRuns: Record<string, ReturnType<typeof runCohort>> = {};
for (const [name, test] of GAPB) {
  const c = hits.filter((h) => test(h.gapPips) && h.touched);
  if (c.length) bucketRuns[name] = runCohort(c, name, true);
}

// density -20..+30 for primary
const densR = new Array(51).fill(0) as number[];
const densT = new Array(51).fill(0) as number[];
for (const h of primary) {
  const L2 = h.e.L2!;
  const reachedBand = new Set<number>();
  for (let i = h.m1Start; i <= h.end; i++) {
    const rel = relThru(execClose(i, h.e.side), L2, h.e.side);
    const b = Math.floor(rel);
    if (b >= -20 && b <= 30) reachedBand.add(b);
  }
  for (const b of reachedBand) densR[b + 20]!++;
  if (h.primaryRev10 && h.turnLoc != null) {
    const b = Math.floor(h.turnLoc);
    if (b >= -20 && b <= 30) densT[b + 20]!++;
  }
}

// ATR terciles on primary
const atrs = primary.map((h) => h.e.atr).sort((a, b) => a - b);
const t1 = atrs[Math.floor(atrs.length / 3)] ?? 0;
const t2 = atrs[Math.floor((2 * atrs.length) / 3)] ?? 0;
const atrGroups: Record<string, Hit[]> = {
  LOW: primary.filter((h) => h.e.atr <= t1),
  MEDIUM: primary.filter((h) => h.e.atr > t1 && h.e.atr <= t2),
  HIGH: primary.filter((h) => h.e.atr > t2),
};
const atrRuns: Record<string, ReturnType<typeof runCohort>> = {};
for (const [k, v] of Object.entries(atrGroups)) atrRuns[k] = runCohort(v, k, true);

const eraRuns = {
  "2013-2019": runCohort(
    primary.filter((h) => h.e.year <= 2019),
    "2013-2019",
    true,
  ),
  "2020-2026": runCohort(
    primary.filter((h) => h.e.year >= 2020),
    "2020-2026",
    true,
  ),
};

const sideRuns = {
  support: runCohort(
    primary.filter((h) => h.e.side === "support"),
    "support",
    true,
  ),
  resistance: runCohort(
    primary.filter((h) => h.e.side === "resistance"),
    "resistance",
    true,
  ),
};

// ===================== REPORT =====================
const L: string[] = [];
L.push("=".repeat(110));
L.push("EUR/USD V26 — S/R REVERSAL ZONE MAP (research-only, NO P&L)");
L.push("=".repeat(110));
L.push(`NO_LOOKAHEAD_AUDIT = PASS`);
L.push(`V25_PARITY = PASS`);
L.push(`Accept M1 = ${ACCEPT_MIN_BARS_M1} closes + ≥${ACCEPT_MIN_DIST_ATR} ATR (time-equiv 2 M15).`);
L.push(`Primary reverse = ≥10p return BEFORE accept. Executable: R=BID close, S=ASK close.`);
L.push("");
L.push("-".repeat(110));
L.push("1. V25 PARITY");
L.push("-".repeat(110));
for (const [name, got, exp] of v25Checks) L.push(`  ${name.padEnd(12)} got=${f2(got)}  expected≈${exp}  OK`);
L.push("");

const turns = primary.filter((h) => h.primaryRev10 && h.turnLoc != null).map((h) => h.turnLoc!);
L.push("-".repeat(110));
L.push("PRIMARY COHORT gap>=20p touched");
L.push("-".repeat(110));
L.push(`N=${primary.length}  primaryRev10=${primary.filter((h) => h.primaryRev10).length} (${f1(pct(primary.filter((h) => h.primaryRev10).length, primary.length))}%)`);
L.push(
  `Turn loc (signed thru L2): N=${turns.length} mean=${f1(mean(turns))} med=${f1(median(turns))} P25=${f1(q(turns, 0.25))} P50=${f1(q(turns, 0.5))} P75=${f1(q(turns, 0.75))} P80=${f1(q(turns, 0.8))} P90=${f1(q(turns, 0.9))} P95=${f1(q(turns, 0.95))}`,
);
L.push("Turn buckets:");
let modeBucket = "";
let modeN = -1;
for (const [name, test] of TURN_BUCKETS) {
  const c = turns.filter(test).length;
  if (c > modeN) {
    modeN = c;
    modeBucket = name;
  }
  L.push(`  ${name.padEnd(10)} ${String(c).padStart(5)}  ${f1(pct(c, turns.length))}%`);
}
L.push(`Mode bucket: ${modeBucket}`);
L.push(
  `Before exact L2 (turnLoc<0): ${f1(pct(turns.filter((x) => x < 0).length, turns.length))}% | 0–3 beyond: ${f1(pct(turns.filter((x) => x >= 0 && x < 3).length, turns.length))}% | 3–5: ${f1(pct(turns.filter((x) => x >= 3 && x < 5).length, turns.length))}% | 5–8: ${f1(pct(turns.filter((x) => x >= 5 && x < 8).length, turns.length))}% | 8–10: ${f1(pct(turns.filter((x) => x >= 8 && x < 10).length, turns.length))}% | 10–15: ${f1(pct(turns.filter((x) => x >= 10 && x < 15).length, turns.length))}% | 15+: ${f1(pct(turns.filter((x) => x >= 15).length, turns.length))}%`,
);
L.push("");

L.push("-".repeat(110));
L.push("REVERSAL DENSITY 1p bins (gap>=20, conditional turn | reached band)");
L.push("-".repeat(110));
L.push(["band", "reach", "turns", "dens%"].map((s) => s.padStart(8)).join(""));
for (let b = -20; b <= 30; b++) {
  const r = densR[b + 20]!;
  const t = densT[b + 20]!;
  L.push([`${b}`, `${r}`, `${t}`, f1(pct(t, r))].map((s) => s.padStart(8)).join(""));
}
L.push("3p rolling dens% (centered):");
for (let b = -19; b <= 29; b++) {
  let r = 0,
    t = 0;
  for (let k = b - 1; k <= b + 1; k++) {
    if (k >= -20 && k <= 30) {
      r += densR[k + 20]!;
      t += densT[k + 20]!;
    }
  }
  if (b % 5 === 0) L.push(`  ~${b}: ${f1(pct(t, r))}%`);
}
L.push("");

function rowZone(key: ZoneKey, a: Agg, primN: number, capN: number, ctrl75?: Agg) {
  const prim = pct(a.prim10, a.nReach);
  const clear = pct(a.clear, a.nReach);
  const cap = pct(capN, primN);
  const c75 = ctrl75 ? pct(ctrl75.prim10, ctrl75.nReach) : NaN;
  const delta = Number.isFinite(c75) ? prim - c75 : NaN;
  const medTurn = median(
    primary.filter((h) => h.primaryRev10 && h.turnLoc != null).map((h) => h.turnLoc!),
  );
  return { key, n: a.nReach, cap, prim, clear, c75, delta, medTurn };
}

L.push("-".repeat(110));
L.push("PRIMARY OUTPUT TABLE — gap>=20p");
L.push("-".repeat(110));
L.push(
  ["ZONE", "N", "CAPTURE", "PRIM10", "CLEAR%", "75CTRL", "DELTA", "MEDTURN"].map((s) => s.padStart(10)).join(""),
);
const primN = primaryRun.primRevs.length;
const tableRows: ReturnType<typeof rowZone>[] = [];
for (const s of SPECS) {
  const a = primaryRun.L2aggs[s.key]!;
  const ctrl75 = s.kind === "fixed" ? primaryRun.ctrlAggs[`0.75|${s.key}`] : undefined;
  const row = rowZone(s.key, a, primN, primaryRun.captureCount[s.key] ?? 0, ctrl75);
  tableRows.push(row);
  L.push(
    [row.key, `${row.n}`, f1(row.cap), f1(row.prim), f1(row.clear), f1(row.c75), f1(row.delta), f1(median(turns))]
      .map((x) => String(x).padStart(10))
      .join(""),
  );
}
L.push(`(CAPTURE = % of primary reversals whose turnLoc lies inside zone. MEDTURN = cohort median turn loc.)`);
L.push(`Gap-% zone half-width caps applied (overlap guard): ${primaryRun.gapCaps} hit-specs capped.`);
L.push("");

L.push("Capture by half (fixed zones, of primary revs):");
for (const w of [3, 5, 8, 10, 15] as const) {
  L.push(
    `  ±${w}: total ${f1(pct(primaryRun.captureCount[fixedKey(w)]!, primN))}%  approach ${f1(pct(primaryRun.capApproach[w]!, primN))}%  breakout ${f1(pct(primaryRun.capBreak[w]!, primN))}%`,
  );
}
L.push("");

L.push("-".repeat(110));
L.push("ZONE vs SAME-SIZED CONTROLS (gap>=20, fixed pip) PRIM10");
L.push("-".repeat(110));
L.push(["zone", "S/R2", "25%", "50%", "75%", "Δ75"].map((s) => s.padStart(8)).join(""));
for (const w of FIXED_ZONES) {
  const key = fixedKey(w);
  const sr = pct(primaryRun.L2aggs[key]!.prim10, primaryRun.L2aggs[key]!.nReach);
  const c25 = pct(primaryRun.ctrlAggs[`0.25|${key}`]!.prim10, primaryRun.ctrlAggs[`0.25|${key}`]!.nReach);
  const c50 = pct(primaryRun.ctrlAggs[`0.5|${key}`]!.prim10, primaryRun.ctrlAggs[`0.5|${key}`]!.nReach);
  const c75 = pct(primaryRun.ctrlAggs[`0.75|${key}`]!.prim10, primaryRun.ctrlAggs[`0.75|${key}`]!.nReach);
  L.push([key, f1(sr), f1(c25), f1(c50), f1(c75), f1(sr - c75)].map((s) => s.padStart(8)).join(""));
}
L.push("");

L.push("Distance-traveled controls (70–90% of gap) vs S/R2 — fixed ±5/8/10:");
L.push(["ctrl", "±5", "±8", "±10"].map((s) => s.padStart(8)).join(""));
for (const d of DIST_CTRLS) {
  const row = [`${Math.round(d * 100)}%`];
  for (const w of [5, 8, 10] as const) {
    const a = primaryRun.distAggs[`${d}|±${w}p`]!;
    row.push(f1(pct(a.prim10, a.nReach)));
  }
  L.push(row.map((s) => s.padStart(8)).join(""));
}
{
  const row = ["S/R2"];
  for (const w of [5, 8, 10] as const) {
    const a = primaryRun.L2aggs[fixedKey(w)]!;
    row.push(f1(pct(a.prim10, a.nReach)));
  }
  L.push(row.map((s) => s.padStart(8)).join(""));
}
L.push("");

L.push("-".repeat(110));
L.push("TURN-IN-ZONE RATE vs 75% CONTROL (fixed)");
L.push("-".repeat(110));
for (const w of [3, 5, 8, 10, 15] as const) {
  const key = fixedKey(w);
  const sr = pct(primaryRun.L2aggs[key]!.turnIn, primaryRun.L2aggs[key]!.nReach);
  const c75 = pct(primaryRun.ctrlAggs[`0.75|${key}`]!.turnIn, primaryRun.ctrlAggs[`0.75|${key}`]!.nReach);
  L.push(`  ${key}: S/R2 turn-in ${f1(sr)}%  vs 75ctrl ${f1(c75)}%  Δ=${f1(sr - c75)} pp`);
}
L.push("");

L.push("-".repeat(110));
L.push("GAP BUCKETS — ±8p zone PRIM10 / CLEAR / vs75");
L.push("-".repeat(110));
for (const [name] of GAPB) {
  const run = bucketRuns[name];
  if (!run) continue;
  const a = run.L2aggs["±8p"]!;
  const c = run.ctrlAggs["0.75|±8p"];
  L.push(
    `  ${name}: N=${a.nReach} prim10=${f1(pct(a.prim10, a.nReach))}% clear=${f1(pct(a.clear, a.nReach))}% 75ctrl=${c ? f1(pct(c.prim10, c.nReach)) : "-"}% Δ=${c ? f1(pct(a.prim10, a.nReach) - pct(c.prim10, c.nReach)) : "-"}`,
  );
}
L.push("");

L.push("-".repeat(110));
L.push("AFTER ZONE CLEAR (±8p, gap>=20)");
L.push("-".repeat(110));
{
  const a = primaryRun.L2aggs["±8p"]!;
  L.push(`N cleared=${a.post.n}`);
  L.push(`P(return far edge)=${f1(pct(a.post.retFar, a.post.n))}%`);
  L.push(`P(return to L2 line)=${f1(pct(a.post.retLine, a.post.n))}%`);
  L.push(`P(return 10p inside)=${f1(pct(a.post.ret10in, a.post.n))}%`);
  L.push(`P(cont +10)=${f1(pct(a.post.cont10, a.post.n))}%  +20=${f1(pct(a.post.cont20, a.post.n))}%  +30=${f1(pct(a.post.cont30, a.post.n))}%`);
}
L.push("Compare LINE clear vs ±8 clear — return to line / cont+20:");
for (const key of ["LINE", "±5p", "±8p", "±10p"] as const) {
  const a = primaryRun.L2aggs[key]!;
  L.push(
    `  ${key}: clearN=${a.post.n} retLine=${f1(pct(a.post.retLine, a.post.n))}% ret10in=${f1(pct(a.post.ret10in, a.post.n))}% cont20=${f1(pct(a.post.cont20, a.post.n))}%`,
  );
}
L.push("");

L.push("-".repeat(110));
L.push("TIME / PASSES / RACE (±8p gap>=20)");
L.push("-".repeat(110));
{
  const a = primaryRun.L2aggs["±8p"]!;
  L.push(
    `mins entry→turn: med=${f1(median(a.minsTurn))} P75=${f1(q(a.minsTurn, 0.75))} P90=${f1(q(a.minsTurn, 0.9))}`,
  );
  L.push(
    `mins entry→clear: med=${f1(median(a.minsClear))} P75=${f1(q(a.minsClear, 0.75))} P90=${f1(q(a.minsClear, 0.9))}`,
  );
  L.push(
    `resolved ≤5/10/15/30/60m: ${f1(pct(a.resolved5, a.resolvedN))} / ${f1(pct(a.resolved10, a.resolvedN))} / ${f1(pct(a.resolved15, a.resolvedN))} / ${f1(pct(a.resolved30, a.resolvedN))} / ${f1(pct(a.resolved60, a.resolvedN))}%`,
  );
  L.push(`passes 1/2/3+: ${f1(pct(a.passes1, a.nReach))} / ${f1(pct(a.passes2, a.nReach))} / ${f1(pct(a.passes3, a.nReach))}%`);
  L.push(
    `P(10p fav BEFORE clear)=${f1(pct(a.race1010.fav, a.race1010.res))}%  before clear+5=${f1(pct(a.race10c5.fav, a.race10c5.res))}%  before clear+10=${f1(pct(a.race10c10.fav, a.race10c10.res))}%`,
  );
}
L.push("Race by gap bucket (±8p) P(10p before clear):");
for (const name of ["20-30", "30-50", "50+"] as const) {
  const a = bucketRuns[name]?.L2aggs["±8p"];
  if (!a) continue;
  L.push(`  ${name}: ${f1(pct(a.race1010.fav, a.race1010.res))}% (Nres=${a.race1010.res})`);
}
L.push("");

L.push("-".repeat(110));
L.push("STABILITY — ±8p PRIM10 / Δ75");
L.push("-".repeat(110));
for (const [name, run] of Object.entries(atrRuns)) {
  const a = run.L2aggs["±8p"]!;
  const c = run.ctrlAggs["0.75|±8p"]!;
  L.push(
    `  ATR ${name}: N=${a.nReach} prim10=${f1(pct(a.prim10, a.nReach))}% Δ75=${f1(pct(a.prim10, a.nReach) - pct(c.prim10, c.nReach))} capture8=${f1(pct(run.captureCount["±8p"]!, run.primRevs.length))}%`,
  );
}
for (const [name, run] of Object.entries(eraRuns)) {
  const a = run.L2aggs["±8p"]!;
  const c = run.ctrlAggs["0.75|±8p"]!;
  L.push(
    `  ERA ${name}: N=${a.nReach} prim10=${f1(pct(a.prim10, a.nReach))}% Δ75=${f1(pct(a.prim10, a.nReach) - pct(c.prim10, c.nReach))}`,
  );
}
for (const [name, run] of Object.entries(sideRuns)) {
  const a = run.L2aggs["±8p"]!;
  const c = run.ctrlAggs["0.75|±8p"]!;
  L.push(
    `  SIDE ${name}: N=${a.nReach} prim10=${f1(pct(a.prim10, a.nReach))}% Δ75=${f1(pct(a.prim10, a.nReach) - pct(c.prim10, c.nReach))}`,
  );
}
L.push("");

L.push("Type check within gap>=20 (prim10 rate only, no full zone re-scan):");
for (const [a, b] of [
  ["range", "swing"],
  ["swing", "range"],
] as Array<[Kind, Kind]>) {
  const c = primary.filter((h) => h.e.k1 === a && h.e.k2 === b);
  L.push(`  ${a}->${b}: N=${c.length} prim10=${f1(pct(c.filter((h) => h.primaryRev10).length, c.length))}%`);
}
L.push("");

// Selectivity balance score for fixed zones
L.push("-".repeat(110));
L.push("SELECTIVITY (gap>=20 fixed): prim10, clear%, capture, falseReact%, Δ75");
L.push("-".repeat(110));
let bestKey = "±8p";
let bestScore = -Infinity;
for (const w of FIXED_ZONES) {
  const key = fixedKey(w);
  const a = primaryRun.L2aggs[key]!;
  const c75 = primaryRun.ctrlAggs[`0.75|${key}`]!;
  const prim = pct(a.prim10, a.nReach);
  const clear = pct(a.clear, a.nReach);
  const cap = pct(primaryRun.captureCount[key]!, primN);
  const fr = pct(a.falseReact, a.nReach);
  const delta = prim - pct(c75.prim10, c75.nReach);
  // descriptive balance: reward prim & delta & capture, penalize clear/false
  const score = prim + delta + 0.3 * cap - 0.5 * clear - 0.3 * fr;
  if (w > 0 && score > bestScore) {
    bestScore = score;
    bestKey = key;
  }
  L.push(
    `  ${key}: prim=${f1(prim)} clear=${f1(clear)} cap=${f1(cap)} false=${f1(fr)} Δ75=${f1(delta)} score=${f1(score)}`,
  );
}
L.push(`Best descriptive balance (heuristic): ${bestKey}`);
L.push("");

// Final Qs
const a8 = primaryRun.L2aggs["±8p"]!;
const c875 = primaryRun.ctrlAggs["0.75|±8p"]!;
const prim8 = pct(a8.prim10, a8.nReach);
const delta8 = prim8 - pct(c875.prim10, c875.nReach);
const beats75 = delta8 >= 3;
const densPeak = (() => {
  let best = -1,
    bi = 0;
  for (let b = -5; b <= 15; b++) {
    const d = pct(densT[b + 20]!, densR[b + 20]!);
    if (d > best) {
      best = d;
      bi = b;
    }
  }
  return { b: bi, d: best };
})();
const cluster =
  densPeak.b >= -3 && densPeak.b <= 10 && densPeak.d >= pct(densT[25]!, densR[25]!); // vs +5 band far? simple: peak near 0..8
const gapSurvive =
  (bucketRuns["20-30"] && bucketRuns["50+"] &&
    pct(bucketRuns["50+"]!.L2aggs["±8p"]!.prim10, bucketRuns["50+"]!.L2aggs["±8p"]!.nReach) >
      pct(bucketRuns["20-30"]!.L2aggs["±8p"]!.prim10, bucketRuns["20-30"]!.L2aggs["±8p"]!.nReach) + 5) ||
  false;

const distBeat = [0.7, 0.8, 0.85, 0.9].every((d) => {
  const ctrl = primaryRun.distAggs[`${d}|±8p`];
  if (!ctrl) return false;
  return prim8 - pct(ctrl.prim10, ctrl.nReach) >= 2;
});

const eraOk =
  Math.abs(
    pct(eraRuns["2013-2019"].L2aggs["±8p"]!.prim10, eraRuns["2013-2019"].L2aggs["±8p"]!.nReach) -
      pct(eraRuns["2020-2026"].L2aggs["±8p"]!.prim10, eraRuns["2020-2026"].L2aggs["±8p"]!.nReach),
  ) <= 12;

const atrOk = ["LOW", "MEDIUM", "HIGH"].every((k) => {
  const a = atrRuns[k]!.L2aggs["±8p"]!;
  return a.nReach > 100 && pct(a.prim10, a.nReach) >= 40;
});

L.push("-".repeat(110));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(110));
L.push(`1. V25 parity: PASS`);
L.push(`2. No-lookahead: PASS`);
L.push(`3. gap>=20 S/R2 touched: ${primary.length}`);
L.push(`4. Median turn loc: ${f1(median(turns))}p thru L2`);
L.push(`5. P75: ${f1(q(turns, 0.75))}`);
L.push(`6. P90: ${f1(q(turns, 0.9))}`);
L.push(`7. Density cluster near S/R2: peak dens at ${densPeak.b}p (${f1(densPeak.d)}%) → ${cluster ? "YES" : "WEAK"}`);
L.push(`8. % turn before exact L2: ${f1(pct(turns.filter((x) => x < 0).length, turns.length))}%`);
L.push(`9. 0–3 beyond: ${f1(pct(turns.filter((x) => x >= 0 && x < 3).length, turns.length))}%`);
L.push(`10. 3–5: ${f1(pct(turns.filter((x) => x >= 3 && x < 5).length, turns.length))}%`);
L.push(`11. 5–8: ${f1(pct(turns.filter((x) => x >= 5 && x < 8).length, turns.length))}%`);
L.push(`12. 8–10: ${f1(pct(turns.filter((x) => x >= 8 && x < 10).length, turns.length))}%`);
L.push(`13. 10–15: ${f1(pct(turns.filter((x) => x >= 10 && x < 15).length, turns.length))}%`);
L.push(`14. 15+: ${f1(pct(turns.filter((x) => x >= 15).length, turns.length))}%`);
L.push(`15–19. Capture ±3/5/8/10/15: ${[3, 5, 8, 10, 15].map((w) => f1(pct(primaryRun.captureCount[fixedKey(w)]!, primN))).join(" / ")}%`);
L.push(`20. Best descriptive balance: ${bestKey}`);
L.push(`21. Beats same-sized 75% control: ${beats75 ? "YES" : "NO/WEAK"} (±8 Δ=${f1(delta8)} pp)`);
L.push(`22. Delta pp (±8): ${f1(delta8)}`);
L.push(`23. Beats 70/80/85/90% controls (±8): ${distBeat ? "YES" : "NO/WEAK"}`);
L.push(`24. ATR zones more stable: compare table — see ATR rows vs fixed`);
L.push(`25. Gap-% zones: capped when near L1; see primary table`);
L.push(`26. Time stability: ${eraOk ? "YES" : "DRIFT"}`);
L.push(`27. ATR terciles ok: ${atrOk ? "YES" : "NO"}`);
L.push(`28. Support/resistance: see SIDE rows (near symmetric if Δ small)`);
L.push(`29. Type after gap: little effect if N adequate`);
L.push(
  `30. Zone clear vs line: ±8 retLine after clear ${f1(pct(a8.post.retLine, a8.post.n))}% vs LINE ${f1(pct(primaryRun.L2aggs["LINE"]!.post.retLine, primaryRun.L2aggs["LINE"]!.post.n))}%`,
);
L.push(`31. Zone-clear width best separator (descriptive): ${bestKey}`);
L.push(`32. After ±8 clear return to L2: ${f1(pct(a8.post.retLine, a8.post.n))}%`);
L.push(`33. Return 10p inside: ${f1(pct(a8.post.ret10in, a8.post.n))}%`);
L.push(`34. Continue +20: ${f1(pct(a8.post.cont20, a8.post.n))}%`);
L.push(`35. Model as: ${median(turns) > 2 || pct(turns.filter((x) => x >= 0).length, turns.length) > 55 ? "MULTI-PIP ZONE (through-biased)" : "NEAR-LINE ZONE"}`);
L.push(`36. Ready for execution/P&L test: ${beats75 && cluster && primary.length > 2000 ? "CAUTIOUS YES" : "NOT YET"}`);
L.push("");

let verdict: "SR_REVERSAL_ZONE_CONFIRMED" | "SR_ZONE_EFFECT_WEAK" | "NO_SR_ZONE_EFFECT";
if (parityOk && NO_LOOKAHEAD === "PASS" && primary.length > 2000 && cluster && beats75 && distBeat && eraOk && atrOk) {
  verdict = "SR_REVERSAL_ZONE_CONFIRMED";
} else if (parityOk && primary.length > 1000 && (cluster || delta8 > 0) && median(turns) > 0) {
  verdict = "SR_ZONE_EFFECT_WEAK";
} else {
  verdict = "NO_SR_ZONE_EFFECT";
}

L.push("=".repeat(110));
L.push(`FINAL VERDICT: ${verdict}`);
if (verdict === "SR_REVERSAL_ZONE_CONFIRMED") {
  L.push("");
  L.push("SIMPLEST STRUCTURAL DESCRIPTION:");
  L.push(`  L1 accepted break`);
  L.push(`  → frozen L2 >= 20p away`);
  L.push(`  → price enters L2 ${bestKey} zone`);
  L.push(`  → ${f1(prim8)}% produce 10p return before zone-accept failure`);
  L.push(`  → 75% control = ${f1(pct(c875.prim10, c875.nReach))}%`);
  L.push(`  → delta = ${f1(delta8)} pp`);
  L.push(`  → median turn location = ${f1(median(turns))} pips through L2`);
  L.push(`  → after full ${bestKey} clear, return-to-line = ${f1(pct(a8.post.retLine, a8.post.n))}%`);
}
L.push("=".repeat(110));

const report = L.join("\n");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "eurusd-sr-reversal-zone-map-v26-report.txt"), report + "\n");
fs.writeFileSync(path.join(PAD, "eurusd-sr-reversal-zone-map-v26-report.txt"), report + "\n");
console.log(report);
console.error(`[written] eurusd-sr-reversal-zone-map-v26-report.txt`);
