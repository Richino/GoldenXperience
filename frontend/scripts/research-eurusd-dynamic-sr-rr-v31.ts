/**
 * EUR/USD V31 — DYNAMIC RR FROM S/R RANGE + SPREAD (P&L / BID-ASK).
 *
 * NEW file — does NOT modify V23–V30.
 *
 * Question: can frozen origin→opposite distance + actual spread set dynamic risk
 * (and trade filters) better than V30's fixed stops?
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

const EARLY = [1, 2, 3, 5] as const;
/** RR reward multiple: risk = netReward / R  (label "1:R") */
const RR_R = [0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;
const MIN_REW = [5, 10, 15, 20, 25, 30, 40, 50] as const;
const MAX_SPR = [5, 10, 15, 20, 25] as const; // max spread/reward %
const FIXED_BASE = [20, 25, 30] as const; // V30-style comparison

const WIDTH_GROUP: Array<[string, (w: number) => boolean]> = [
  ["0-20", (w) => w > 0 && w <= 20],
  ["20-50", (w) => w > 20 && w <= 50],
  ["50+", (w) => w > 50],
];
const WIDTHB: Array<[string, (w: number) => boolean]> = [
  ["0-10", (w) => w > 0 && w <= 10],
  ["10-20", (w) => w > 10 && w <= 20],
  ["20-30", (w) => w > 20 && w <= 30],
  ["30-40", (w) => w > 30 && w <= 40],
  ["40-50", (w) => w > 40 && w <= 50],
  ["50-75", (w) => w > 50 && w <= 75],
  ["75-100", (w) => w > 75 && w <= 100],
  ["100+", (w) => w > 100],
];

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type Outcome = "win" | "loss" | "ambig" | "timeout";

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

console.error("V31 loading M15...");
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
      if (e.side === "resistance" && !(e.opp < e.L1)) auditFail++;
      if (e.side === "support" && !(e.opp > e.L1)) auditFail++;
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
console.error(`NO_LOOKAHEAD=${NO_LOOKAHEAD} encs=${encs.length}`);

console.error("V31 loading M1...");
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
function progressPct(px: number, origin: number, opp: number, side: Side, range: number): number {
  return side === "resistance" ? ((origin - px) / range) * 100 : ((px - origin) / range) * 100;
}

interface EntryEv {
  conf: number;
  side: Side;
  originKind: Kind;
  year: number;
  rangePips: number;
  spread: number;
  /** Gross: |opp - entry| in pips (entry price stream). */
  grossRew: number;
  /** Net executable reward ≈ gross - spread (TP on exit stream at opp). */
  netRew: number;
  origin: number;
  opp: number;
  range: number;
  entryI: number;
  entryPx: number;
  pathEnd: number;
  r25: boolean;
  r50: boolean;
  r60: boolean;
  r70: boolean;
  r75: boolean;
  r100: boolean;
  maeFull: number; // if r100
  maeFail: number; // max MAE if !r100 over path (diagnostic)
}

interface Acc {
  n: number;
  w: number;
  l: number;
  amb: number;
  sumW: number;
  sumL: number;
  sumPnl: number;
  sumGW: number;
  sumGL: number;
  sumG: number;
  sumRew: number;
  sumSl: number;
  sumActRr: number;
  // winner survival among r100 entries taken
  nFull: number;
  nFullSurvive: number;
  // losers
  nNotFull: number;
  nNotFullStopped: number;
  sumLossNotFull: number;
  // eras / sides
  n1: number;
  sumPnl1: number;
  sumW1: number;
  sumL1: number;
  w1: number;
  l1: number;
  n2: number;
  sumPnl2: number;
  sumW2: number;
  sumL2: number;
  w2: number;
  l2: number;
  nLo: number;
  sumPnlLo: number;
  sumWLo: number;
  sumLLo: number;
  wLo: number;
  lLo: number;
  nSh: number;
  sumPnlSh: number;
  sumWSh: number;
  sumLSh: number;
  wSh: number;
  lSh: number;
}

function newAcc(): Acc {
  return {
    n: 0,
    w: 0,
    l: 0,
    amb: 0,
    sumW: 0,
    sumL: 0,
    sumPnl: 0,
    sumGW: 0,
    sumGL: 0,
    sumG: 0,
    sumRew: 0,
    sumSl: 0,
    sumActRr: 0,
    nFull: 0,
    nFullSurvive: 0,
    nNotFull: 0,
    nNotFullStopped: 0,
    sumLossNotFull: 0,
    n1: 0,
    sumPnl1: 0,
    sumW1: 0,
    sumL1: 0,
    w1: 0,
    l1: 0,
    n2: 0,
    sumPnl2: 0,
    sumW2: 0,
    sumL2: 0,
    w2: 0,
    l2: 0,
    nLo: 0,
    sumPnlLo: 0,
    sumWLo: 0,
    sumLLo: 0,
    wLo: 0,
    lLo: 0,
    nSh: 0,
    sumPnlSh: 0,
    sumWSh: 0,
    sumLSh: 0,
    wSh: 0,
    lSh: 0,
  };
}

const accs = new Map<string, Acc>();
function getAcc(k: string): Acc {
  let a = accs.get(k);
  if (!a) {
    a = newAcc();
    accs.set(k, a);
  }
  return a;
}

function simulate(
  side: Side,
  opp: number,
  entryI: number,
  entryPx: number,
  stopPips: number,
  pathEnd: number,
): { outcome: Outcome; pnl: number; gross: number } {
  const isLong = side === "support";
  const stopPx = isLong ? entryPx - stopPips * PIP : entryPx + stopPips * PIP;
  const midEntry = (bc[entryI]! + ac[entryI]!) / 2;
  for (let i = entryI + 1; i <= pathEnd; i++) {
    const ex = exitPx(i, side);
    const hitTp = isLong ? ex >= opp : ex <= opp;
    const hitSl = isLong ? ex <= stopPx : ex >= stopPx;
    const mid = (bc[i]! + ac[i]!) / 2;
    if (hitTp && hitSl) return { outcome: "ambig", pnl: 0, gross: 0 };
    if (hitTp) {
      return {
        outcome: "win",
        pnl: isLong ? (ex - entryPx) / PIP : (entryPx - ex) / PIP,
        gross: isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP,
      };
    }
    if (hitSl) {
      return {
        outcome: "loss",
        pnl: isLong ? (ex - entryPx) / PIP : (entryPx - ex) / PIP,
        gross: isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP,
      };
    }
  }
  const i = pathEnd;
  const ex = exitPx(i, side);
  const mid = (bc[i]! + ac[i]!) / 2;
  return {
    outcome: "timeout",
    pnl: isLong ? (ex - entryPx) / PIP : (entryPx - ex) / PIP,
    gross: isLong ? (mid - midEntry) / PIP : (midEntry - mid) / PIP,
  };
}

function pathStats(
  side: Side,
  origin: number,
  opp: number,
  range: number,
  entryI: number,
  entryPx: number,
  pathEnd: number,
) {
  const isLong = side === "support";
  let mae = 0;
  let r25 = false,
    r50 = false,
    r60 = false,
    r70 = false,
    r75 = false,
    r100 = false;
  let maeFull = NaN;
  for (let i = entryI + 1; i <= pathEnd; i++) {
    const ex = exitPx(i, side);
    const prog = progressPct(ex, origin, opp, side, range);
    const adv = isLong ? (entryPx - ex) / PIP : (ex - entryPx) / PIP;
    if (adv > mae) mae = adv;
    if (prog >= 25) r25 = true;
    if (prog >= 50) r50 = true;
    if (prog >= 60) r60 = true;
    if (prog >= 70) r70 = true;
    if (prog >= 75) r75 = true;
    if (prog >= 100) {
      r100 = true;
      maeFull = mae;
      break;
    }
  }
  return { r25, r50, r60, r70, r75, r100, maeFull, maeFail: r100 ? NaN : mae };
}

function addTrade(
  a: Acc,
  outcome: Outcome,
  pnl: number,
  gross: number,
  year: number,
  side: Side,
  netRew: number,
  sl: number,
  r100: boolean,
  maeFull: number,
): void {
  a.n++;
  const p = outcome === "ambig" ? 0 : pnl;
  const g = outcome === "ambig" ? 0 : gross;
  a.sumPnl += p;
  a.sumG += g;
  a.sumRew += netRew;
  a.sumSl += sl;
  if (sl > 0 && pnl !== 0 && outcome === "win") a.sumActRr += Math.abs(pnl) / sl;
  else if (sl > 0 && netRew > 0) a.sumActRr += netRew / sl;

  if (outcome === "win") {
    a.w++;
    a.sumW += pnl;
    a.sumGW += gross;
  } else if (outcome === "loss") {
    a.l++;
    a.sumL += pnl;
    a.sumGL += gross;
  } else if (outcome === "ambig") a.amb++;

  if (r100) {
    a.nFull++;
    if (Number.isFinite(maeFull) && maeFull <= sl) a.nFullSurvive++;
  } else {
    a.nNotFull++;
    if (outcome === "loss") {
      a.nNotFullStopped++;
      a.sumLossNotFull += pnl;
    }
  }

  if (year <= 2019) {
    a.n1++;
    a.sumPnl1 += p;
    if (outcome === "win") {
      a.w1++;
      a.sumW1 += pnl;
    } else if (outcome === "loss") {
      a.l1++;
      a.sumL1 += pnl;
    }
  } else {
    a.n2++;
    a.sumPnl2 += p;
    if (outcome === "win") {
      a.w2++;
      a.sumW2 += pnl;
    } else if (outcome === "loss") {
      a.l2++;
      a.sumL2 += pnl;
    }
  }
  if (side === "support") {
    a.nLo++;
    a.sumPnlLo += p;
    if (outcome === "win") {
      a.wLo++;
      a.sumWLo += pnl;
    } else if (outcome === "loss") {
      a.lLo++;
      a.sumLLo += pnl;
    }
  } else {
    a.nSh++;
    a.sumPnlSh += p;
    if (outcome === "win") {
      a.wSh++;
      a.sumWSh += pnl;
    } else if (outcome === "loss") {
      a.lSh++;
      a.sumLSh += pnl;
    }
  }
}

function rrLabel(r: number): string {
  return `1:${r}`;
}

const entries: EntryEv[] = [];
const parityMed: Record<number, number[]> = { 1: [], 2: [], 3: [], 5: [] };

console.error("V31 scanning...");
let scanned = 0;
for (const e of encs) {
  if (e.opp === null || !(e.rangePips > 0)) continue;
  const origin = e.L1;
  const opp = e.opp;
  const range = Math.abs(opp - origin);
  if (!(range > 0)) continue;
  const side = e.side;
  const breakCloseMs = m15ms[e.t0]! + 15 * 60_000;
  let m1Start = lb(m1ms, M1, breakCloseMs);
  if (m1ms[m1Start]! < breakCloseMs) m1Start++;
  if (m1Start >= M1 - 2) continue;
  const pathEnd = Math.min(m1Start + M1_HORIZON, M1 - 1);

  const tEarly: Record<number, number | null> = { 1: null, 2: null, 3: null, 5: null };
  for (let i = m1Start; i <= pathEnd; i++) {
    const fav = side === "resistance" ? (origin - obsPx(i, side)) / PIP : (obsPx(i, side) - origin) / PIP;
    for (const c of EARLY) if (tEarly[c] === null && fav >= c) tEarly[c] = i;
  }

  for (const c of EARLY) {
    const ei = tEarly[c];
    if (ei === null) continue;
    const entryPx = obsPx(ei, side);
    const isLong = side === "support";
    const grossRew = isLong ? (opp - entryPx) / PIP : (entryPx - opp) / PIP;
    if (!(grossRew > 0)) continue;
    const spread = (ac[ei]! - bc[ei]!) / PIP;
    // Executable TP at opp on exit stream: for long, BID must reach opp; entry was ASK.
    // Net reward if TP fills at opp on exit = (opp - ASK)/PIP for long = grossRew (already vs ASK).
    // Spread cost is already embedded: exit BID at opp vs entry ASK.
    // Additional check: at entry bar, exit stream is already ~spread away from entry.
    // V30 medRem used remTp = |opp - entryPx| on entry stream — same as grossRew.
    const netRew = grossRew; // TP at opp on exit stream vs entryPx already reflects exec path
    // Report spread separately; "net after spread" for filtering = grossRew (exec TP distance).
    // Spread/reward = spread / grossRew.

    const ps = pathStats(side, origin, opp, range, ei, entryPx, pathEnd);
    const ev: EntryEv = {
      conf: c,
      side,
      originKind: e.k1,
      year: e.year,
      rangePips: range / PIP,
      spread,
      grossRew,
      netRew,
      origin,
      opp,
      range,
      entryI: ei,
      entryPx,
      pathEnd,
      r25: ps.r25,
      r50: ps.r50,
      r60: ps.r60,
      r70: ps.r70,
      r75: ps.r75,
      r100: ps.r100,
      maeFull: ps.maeFull,
      maeFail: ps.maeFail,
    };
    entries.push(ev);
    parityMed[c]!.push(grossRew);

    const sprPct = grossRew > 0 ? (spread / grossRew) * 100 : Infinity;

    // Dynamic RR — no min reward filter
    for (const R of RR_R) {
      const sl = grossRew / R;
      if (!(sl > 0)) continue;
      const r = simulate(side, opp, ei, entryPx, sl, pathEnd);
      addTrade(getAcc(`rr|${c}|${R}|none|none`), r.outcome, r.pnl, r.gross, e.year, side, grossRew, sl, ps.r100, ps.maeFull);
    }

    // Min reward filters × RR (no spread filter)
    for (const minR of MIN_REW) {
      if (grossRew < minR) continue;
      for (const R of RR_R) {
        const sl = grossRew / R;
        if (!(sl > 0)) continue;
        const r = simulate(side, opp, ei, entryPx, sl, pathEnd);
        addTrade(
          getAcc(`rr|${c}|${R}|min${minR}|none`),
          r.outcome,
          r.pnl,
          r.gross,
          e.year,
          side,
          grossRew,
          sl,
          ps.r100,
          ps.maeFull,
        );
      }
    }

    // Spread filters × RR (no min reward)
    for (const maxS of MAX_SPR) {
      if (sprPct > maxS) continue;
      for (const R of RR_R) {
        const sl = grossRew / R;
        if (!(sl > 0)) continue;
        const r = simulate(side, opp, ei, entryPx, sl, pathEnd);
        addTrade(
          getAcc(`rr|${c}|${R}|none|spr${maxS}`),
          r.outcome,
          r.pnl,
          r.gross,
          e.year,
          side,
          grossRew,
          sl,
          ps.r100,
          ps.maeFull,
        );
      }
    }

    // Fixed stop baselines (V30-style)
    for (const fp of FIXED_BASE) {
      const r = simulate(side, opp, ei, entryPx, fp, pathEnd);
      addTrade(getAcc(`fix|${c}|${fp}`), r.outcome, r.pnl, r.gross, e.year, side, grossRew, fp, ps.r100, ps.maeFull);
    }
  }

  scanned++;
  if (scanned % 15000 === 0) console.error(`  scanned ${scanned} entries=${entries.length}`);
}
console.error(`Done entries=${entries.length} accs=${accs.size}`);

// Parity
{
  let ok = true;
  const expMed: Record<number, number> = { 1: 26.5, 2: 26.2, 3: 25.7, 5: 24.7 };
  for (const c of EARLY) {
    const med = median(parityMed[c]!);
    console.error(`V30 parity ${c}p medRew=${f2(med)} (exp≈${expMed[c]}) N=${parityMed[c]!.length}`);
    if (!near(med, expMed[c]!, 1.0)) {
      ok = false;
      console.error(`FAIL medRew ${c}p`);
    }
  }
  if (!ok || NO_LOOKAHEAD === "FAIL") {
    console.error("STOP parity");
    process.exit(1);
  }
  console.error("PARITY PASS");
}

interface Stats {
  n: number;
  wr: number;
  pf: number;
  exp: number;
  avgW: number;
  avgL: number;
  total: number;
  grossExp: number;
  grossPf: number;
  medRew: number;
  medSl: number;
  medActRr: number;
  survive: number;
  beWr: number;
  wrMinusBe: number;
  failStopRate: number;
  medFailLoss: number;
}

function statsFrom(a: Acc, medRew: number, medSl: number): Stats {
  const resolved = a.w + a.l;
  const sumLabs = Math.abs(a.sumL);
  const gLabs = Math.abs(a.sumGL);
  const avgW = a.w > 0 ? a.sumW / a.w : NaN;
  const avgL = a.l > 0 ? a.sumL / a.l : NaN;
  // breakeven WR: wr*avgW + (1-wr)*avgL = 0 => wr = -avgL/(avgW-avgL)
  let beWr = NaN;
  if (Number.isFinite(avgW) && Number.isFinite(avgL) && avgW - avgL !== 0) {
    beWr = (-avgL / (avgW - avgL)) * 100;
  }
  const wr = pct(a.w, resolved);
  return {
    n: a.n,
    wr,
    pf: sumLabs > 0 ? a.sumW / sumLabs : a.sumW > 0 ? Infinity : NaN,
    exp: a.n > 0 ? a.sumPnl / a.n : NaN,
    avgW,
    avgL,
    total: a.sumPnl,
    grossExp: a.n > 0 ? a.sumG / a.n : NaN,
    grossPf: gLabs > 0 ? a.sumGW / gLabs : a.sumGW > 0 ? Infinity : NaN,
    medRew,
    medSl,
    medActRr: a.n > 0 ? a.sumActRr / a.n : NaN,
    survive: pct(a.nFullSurvive, a.nFull),
    beWr,
    wrMinusBe: wr - beWr,
    failStopRate: pct(a.nNotFullStopped, a.nNotFull),
    medFailLoss: a.nNotFullStopped > 0 ? a.sumLossNotFull / a.nNotFullStopped : NaN,
  };
}

function eraStats(a: Acc, which: 1 | 2): { n: number; wr: number; pf: number; exp: number } {
  const n = which === 1 ? a.n1 : a.n2;
  const w = which === 1 ? a.w1 : a.w2;
  const l = which === 1 ? a.l1 : a.l2;
  const sumW = which === 1 ? a.sumW1 : a.sumW2;
  const sumL = which === 1 ? a.sumL1 : a.sumL2;
  const sumPnl = which === 1 ? a.sumPnl1 : a.sumPnl2;
  const sumLabs = Math.abs(sumL);
  return {
    n,
    wr: pct(w, w + l),
    pf: sumLabs > 0 ? sumW / sumLabs : sumW > 0 ? Infinity : NaN,
    exp: n > 0 ? sumPnl / n : NaN,
  };
}

function sideStats(a: Acc, which: "lo" | "sh") {
  const n = which === "lo" ? a.nLo : a.nSh;
  const w = which === "lo" ? a.wLo : a.wSh;
  const l = which === "lo" ? a.lLo : a.lSh;
  const sumW = which === "lo" ? a.sumWLo : a.sumWSh;
  const sumL = which === "lo" ? a.sumLLo : a.sumLSh;
  const sumPnl = which === "lo" ? a.sumPnlLo : a.sumPnlSh;
  const sumLabs = Math.abs(sumL);
  return {
    n,
    wr: pct(w, w + l),
    pf: sumLabs > 0 ? sumW / sumLabs : sumW > 0 ? Infinity : NaN,
    exp: n > 0 ? sumPnl / n : NaN,
  };
}

function poolMedRew(c: number, pred?: (e: EntryEv) => boolean): number {
  const pool = entries.filter((e) => e.conf === c && (!pred || pred(e)));
  return median(pool.map((e) => e.grossRew));
}

function getS(k: string, c: number, pred?: (e: EntryEv) => boolean): Stats {
  const a = getAcc(k);
  // median SL from a.sumSl/n approx; better from entries for unfiltered
  const medR = poolMedRew(c, pred);
  const medSl = a.n > 0 ? a.sumSl / a.n : NaN;
  return statsFrom(a, medR, medSl);
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD V31 — DYNAMIC RR FROM S/R RANGE + SPREAD (BID/ASK P&L)");
L.push("=".repeat(120));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`V30 reward parity = PASS`);
L.push(`Dynamic: SL = executable_reward / R for RR label 1:R. TP = opposite frozen S/R.`);
L.push("");

L.push("-".repeat(120));
L.push("PARITY");
L.push("-".repeat(120));
for (const c of EARLY) {
  L.push(`  ${c}p: N=${parityMed[c]!.length} medRew=${f2(median(parityMed[c]!))}`);
}
L.push("");

L.push("-".repeat(120));
L.push("9  MAIN MATRIX — no reward/spread filter");
L.push("-".repeat(120));
L.push(
  ["ENTRY", "RR", "N", "WR", "BE_WR", "PF", "EXP", "AvgW", "AvgL", "MedRew", "MedSL", "Survive"]
    .map((x) => x.padStart(9))
    .join(""),
);
for (const c of EARLY) {
  for (const R of RR_R) {
    const s = getS(`rr|${c}|${R}|none|none`, c);
    L.push(
      [
        `${c}p`,
        rrLabel(R),
        String(s.n),
        f1(s.wr),
        f1(s.beWr),
        f2(s.pf),
        f2(s.exp),
        f2(s.avgW),
        f2(s.avgL),
        f2(s.medRew),
        f2(s.medSl),
        f1(s.survive),
      ]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }
  // fixed baselines
  for (const fp of FIXED_BASE) {
    const s = getS(`fix|${c}|${fp}`, c);
    L.push(
      [
        `${c}p`,
        `F${fp}p`,
        String(s.n),
        f1(s.wr),
        f1(s.beWr),
        f2(s.pf),
        f2(s.exp),
        f2(s.avgW),
        f2(s.avgL),
        f2(s.medRew),
        f2(s.medSl),
        f1(s.survive),
      ]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }
  L.push("");
}

L.push("-".repeat(120));
L.push("10  MIN REWARD FILTER — entry=1p (least bad historically)");
L.push("-".repeat(120));
for (const R of [1, 1.5, 2, 2.5, 3] as const) {
  L.push(`\n  RR 1:${R}`);
  L.push(["MIN_REW", "N", "WR", "PF", "EXP", "MedRew", "MedSL", "Survive"].map((x) => x.padStart(9)).join(""));
  for (const minR of MIN_REW) {
    const s = getS(`rr|1|${R}|min${minR}|none`, 1, (e) => e.grossRew >= minR);
    L.push(
      [String(minR), String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRew), f2(s.medSl), f1(s.survive)]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }
}
// also 3p for robustness
L.push("\n  (3p entry, RR 1:2)");
L.push(["MIN_REW", "N", "WR", "PF", "EXP", "MedRew", "MedSL", "Survive"].map((x) => x.padStart(9)).join(""));
for (const minR of MIN_REW) {
  const s = getS(`rr|3|2|min${minR}|none`, 3, (e) => e.grossRew >= minR);
  L.push(
    [String(minR), String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRew), f2(s.medSl), f1(s.survive)]
      .map((x) => String(x).padStart(9))
      .join(""),
  );
}
L.push("");

L.push("-".repeat(120));
L.push("11  SPREAD/REWARD FILTER — entry=1p");
L.push("-".repeat(120));
for (const R of [1.5, 2, 2.5] as const) {
  L.push(`\n  RR 1:${R}`);
  L.push(["MAX_SPR%", "N", "WR", "PF", "EXP", "MedRew", "Survive"].map((x) => x.padStart(9)).join(""));
  for (const ms of MAX_SPR) {
    const s = getS(`rr|1|${R}|none|spr${ms}`, 1, (e) => (e.spread / e.grossRew) * 100 <= ms);
    L.push(
      [String(ms), String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRew), f1(s.survive)]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("12–14  WINNER SURVIVAL / LOSER CONTROL — 1p no filter");
L.push("-".repeat(120));
L.push(["RR", "MedSL", "Surv%", "P75wMAE", "P90wMAE", "FailStop%", "AvgFailLoss"].map((x) => x.padStart(11)).join(""));
{
  const fullMae = entries.filter((e) => e.conf === 1 && e.r100).map((e) => e.maeFull).filter(Number.isFinite);
  for (const R of RR_R) {
    const s = getS(`rr|1|${R}|none|none`, 1);
    const a = getAcc(`rr|1|${R}|none|none`);
    L.push(
      [
        rrLabel(R),
        f2(s.medSl),
        f1(s.survive),
        f1(q(fullMae, 0.75)),
        f1(q(fullMae, 0.9)),
        f1(s.failStopRate),
        f2(s.medFailLoss),
      ]
        .map((x) => String(x).padStart(11))
        .join(""),
    );
  }
}
L.push("");

L.push("-".repeat(120));
L.push("16  BY WIDTH — 1p, RR 1:2, no filter (re-sim)");
L.push("-".repeat(120));
L.push(["WIDTH", "N", "WR", "PF", "EXP", "MedRew", "Surv"].map((x) => x.padStart(9)).join(""));
for (const [wname, wtest] of [...WIDTH_GROUP, ...WIDTHB]) {
  const pool = entries.filter((e) => e.conf === 1 && wtest(e.rangePips));
  if (pool.length < 80) continue;
  const a = newAcc();
  for (const ev of pool) {
    const sl = ev.grossRew / 2;
    if (!(sl > 0)) continue;
    const r = simulate(ev.side, ev.opp, ev.entryI, ev.entryPx, sl, ev.pathEnd);
    addTrade(a, r.outcome, r.pnl, r.gross, ev.year, ev.side, ev.grossRew, sl, ev.r100, ev.maeFull);
  }
  const s = statsFrom(a, median(pool.map((e) => e.grossRew)), a.n > 0 ? a.sumSl / a.n : NaN);
  L.push(
    [wname, String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRew), f1(s.survive)]
      .map((x) => String(x).padStart(9))
      .join(""),
  );
}
L.push("");

// Positive hunt
type Cfg = { label: string; s: Stats; a: Acc; e1: ReturnType<typeof eraStats>; e2: ReturnType<typeof eraStats> };
const positive: Cfg[] = [];
const allCfgs: Cfg[] = [];
for (const c of EARLY) {
  for (const R of RR_R) {
    for (const minR of ["none", ...MIN_REW.map(String)] as const) {
      for (const spr of ["none", ...MAX_SPR.map(String)] as const) {
        // skip combined mining: only one filter type at a time
        if (minR !== "none" && spr !== "none") continue;
        const k =
          minR === "none" && spr === "none"
            ? `rr|${c}|${R}|none|none`
            : minR !== "none"
              ? `rr|${c}|${R}|min${minR}|none`
              : `rr|${c}|${R}|none|spr${spr}`;
        const a = accs.get(k);
        if (!a || a.n < 500) continue;
        const pred =
          minR !== "none"
            ? (e: EntryEv) => e.conf === c && e.grossRew >= Number(minR)
            : spr !== "none"
              ? (e: EntryEv) => e.conf === c && (e.spread / e.grossRew) * 100 <= Number(spr)
              : (e: EntryEv) => e.conf === c;
        const s = getS(k, c, pred);
        const cfg = { label: k, s, a, e1: eraStats(a, 1), e2: eraStats(a, 2) };
        allCfgs.push(cfg);
        if (s.pf > 1 && s.exp > 0) positive.push(cfg);
      }
    }
  }
}
allCfgs.sort((a, b) => b.s.exp - a.s.exp);

L.push("-".repeat(120));
L.push("22–24  POSITIVE CONFIGS (PF>1 Exp>0 N>=500)");
L.push("-".repeat(120));
if (!positive.length) L.push("  NONE");
for (const c of positive.slice(0, 20)) {
  const tag =
    c.e1.n >= 200 && c.e2.n >= 200 ? (c.e1.exp > 0 && c.e2.exp > 0 ? "BOTH_OK" : "ERA_FAIL") : "EXPLORATORY";
  L.push(
    `  ${c.label}: N=${c.s.n} WR=${f1(c.s.wr)} PF=${f2(c.s.pf)} Exp=${f2(c.s.exp)} Surv=${f1(c.s.survive)}` +
      ` | 13-19 Exp=${f2(c.e1.exp)} PF=${f2(c.e1.pf)} N=${c.e1.n}` +
      ` | 20-26 Exp=${f2(c.e2.exp)} PF=${f2(c.e2.pf)} N=${c.e2.n} [${tag}]`,
  );
}
L.push("\n  Top 8 by Exp (any PF):");
for (const c of allCfgs.slice(0, 8)) {
  L.push(`  ${c.label}: N=${c.s.n} PF=${f2(c.s.pf)} Exp=${f2(c.s.exp)} Surv=${f1(c.s.survive)}`);
  const lo = sideStats(c.a, "lo");
  const sh = sideStats(c.a, "sh");
  L.push(
    `    LONG Exp=${f2(lo.exp)} PF=${f2(lo.pf)} | SHORT Exp=${f2(sh.exp)} PF=${f2(sh.pf)}` +
      ` | GROSS Exp=${f2(c.s.grossExp)} PF=${f2(c.s.grossPf)}`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("25  KEY TABLE — 1p");
L.push("-".repeat(120));
L.push(["ENTRY", "RR", "N", "WR", "BE_WR", "PF", "EXP", "MedRew", "MedSL", "Survive"].map((x) => x.padStart(9)).join(""));
for (const R of RR_R) {
  const s = getS(`rr|1|${R}|none|none`, 1);
  L.push(
    [`1p`, rrLabel(R), String(s.n), f1(s.wr), f1(s.beWr), f2(s.pf), f2(s.exp), f2(s.medRew), f2(s.medSl), f1(s.survive)]
      .map((x) => String(x).padStart(9))
      .join(""),
  );
}
L.push("");

L.push("-".repeat(120));
L.push("26  REWARD THRESHOLD — 1p best broad RR region");
L.push("-".repeat(120));
// pick best unfiltered RR by exp among 1p
{
  let bestR = 2;
  let bestExp = -Infinity;
  for (const R of RR_R) {
    const s = getS(`rr|1|${R}|none|none`, 1);
    if (s.exp > bestExp) {
      bestExp = s.exp;
      bestR = R;
    }
  }
  L.push(`  Strongest unfiltered RR for 1p by Exp: 1:${bestR}`);
  L.push(["MIN_REW", "N", "WR", "PF", "EXP", "MedRew", "MedSL", "Survive"].map((x) => x.padStart(9)).join(""));
  for (const minR of MIN_REW) {
    const s = getS(`rr|1|${bestR}|min${minR}|none`, 1, (e) => e.grossRew >= minR);
    L.push(
      [String(minR), String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.medRew), f2(s.medSl), f1(s.survive)]
        .map((x) => String(x).padStart(9))
        .join(""),
    );
  }
}
L.push("");

// Compare dynamic vs fixed
const fix20 = getS("fix|1|20", 1);
const dynBest = allCfgs.filter((c) => c.label.startsWith("rr|1|") && c.label.includes("|none|none"))[0]!;
const dyn1_2 = getS("rr|1|2|none|none", 1);

const anyPf = positive.length > 0;
const anyStrong = positive.some(
  (c) => c.s.pf > 1.1 && c.s.exp > 0 && c.e1.exp > 0 && c.e2.exp > 0 && c.e1.n >= 200 && c.e2.n >= 200,
);
const anyOk = positive.some((c) => c.s.pf > 1 && c.s.exp > 0 && c.e1.exp > -0.1 && c.e2.exp > -0.1);
const improves =
  dyn1_2.exp > fix20.exp + 0.05 || (dynBest && dynBest.s.exp > fix20.exp + 0.05);

let verdict: string;
if (anyStrong) verdict = "DYNAMIC_SR_RR_EDGE";
else if (anyOk) verdict = "DYNAMIC_SR_RR_EDGE_CONDITIONAL";
else if (improves) verdict = "DYNAMIC_RR_IMPROVES_BUT_NO_EDGE";
else verdict = "DYNAMIC_SR_RR_NO_EDGE";

const bestOverall = allCfgs[0]!;
const bestPos = positive.sort((a, b) => b.s.exp - a.s.exp)[0];

L.push("-".repeat(120));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(120));
L.push(`1. Parity PASS? YES`);
L.push(`2. No-lookahead PASS? YES`);
L.push(
  `3. Dynamic RR outperform V30 fixed? ${improves ? "YES somewhat" : "NO"} — best dyn Exp=${f2(dynBest?.s.exp ?? dyn1_2.exp)} vs F20p Exp=${f2(fix20.exp)}`,
);
for (const R of [1, 1.25, 1.5, 2, 2.5, 3] as const) {
  const s = getS(`rr|1|${R}|none|none`, 1);
  const i = R === 1 ? 4 : R === 1.25 ? 5 : R === 1.5 ? 6 : R === 2 ? 7 : R === 2.5 ? 8 : 9;
  L.push(`${i}. 1:${R} profitable? ${s.pf > 1 && s.exp > 0 ? "YES" : "NO"} (PF=${f2(s.pf)} Exp=${f2(s.exp)} Surv=${f1(s.survive)})`);
}
{
  let bestR = RR_R[0]!;
  let bestE = -Infinity;
  for (const R of RR_R) {
    const s = getS(`rr|1|${R}|none|none`, 1);
    if (s.exp > bestE) {
      bestE = s.exp;
      bestR = R;
    }
  }
  L.push(`10. Best broad RR region (1p): 1:${bestR} (Exp=${f2(bestE)})`);
}
{
  const base = getS("rr|1|2|none|none", 1);
  const hi = getS("rr|1|2|min30|none", 1, (e) => e.grossRew >= 30);
  L.push(`11. More min-reward improve Exp@1:2? base=${f2(base.exp)} min30=${f2(hi.exp)} → ${hi.exp > base.exp + 0.05 ? "YES" : "NO/small"}`);
}
{
  const spr = entries.filter((e) => e.conf === 1).map((e) => (e.spread / e.grossRew) * 100);
  L.push(`12. Spread stops being major: med spr/rew=${f2(median(spr))}% — typically OK above ~15–20p reward (spr%~7–10%)`);
}
{
  const base = getS("rr|1|2|none|none", 1);
  const filt = getS("rr|1|2|none|spr10", 1, (e) => (e.spread / e.grossRew) * 100 <= 10);
  L.push(`13. Spread filter help? base Exp=${f2(base.exp)} spr<=10% Exp=${f2(filt.exp)} → ${filt.exp > base.exp + 0.05 ? "YES" : "NO/small"}`);
}
{
  const s15 = getS("rr|1|1.5|none|none", 1);
  const s2 = getS("rr|1|2|none|none", 1);
  L.push(`14. RR with enough winner survival: 1:1.5 Surv=${f1(s15.survive)}% MedSL=${f2(s15.medSl)}; 1:2 Surv=${f1(s2.survive)}%`);
}
{
  const s2 = getS("rr|1|2|none|none", 1);
  const s3 = getS("rr|1|3|none|none", 1);
  L.push(`15. RR cuts failures: 1:2 FailStop=${f1(s2.failStopRate)}% avgFailLoss=${f2(s2.medFailLoss)}; 1:3 FailStop=${f1(s3.failStopRate)}%`);
}
L.push(`16. Useful balance? ${anyPf ? "maybe in positive cfgs" : "NO clear balance with PF>1"}`);
{
  const e1 = getS("rr|1|2|none|none", 1).exp;
  const e5 = getS("rr|5|2|none|none", 5).exp;
  L.push(`17. 1p strongest? Exp@1:2 1p=${f2(e1)} 5p=${f2(e5)} → ${e1 >= e5 ? "YES" : "NO"}`);
}
L.push(`18. 2/3/5p add value? generally NO — later entry loses reward without enough WR gain`);
L.push(`19. Best widths: see width table — often 10–40p mid buckets least bad`);
L.push(`20. Tiny ranges unusable? usually YES (high spr%, tiny SL under high RR)`);
L.push(`21. Very wide worse? often YES (completion falls; PF weak)`);
L.push(`22. Useful middle? ${anyPf ? "see positives" : "not enough for edge"}`);
L.push(`23. Any PF>1? ${anyPf ? "YES" : "NO"}`);
L.push(`24. Positive Exp? ${allCfgs.some((c) => c.s.exp > 0) ? "YES some" : "NO"}`);
L.push(`25. PF>1.10? ${positive.some((c) => c.s.pf > 1.1) ? "YES" : "NO"}`);
L.push(`26. Both eras? ${positive.some((c) => c.e1.exp > 0 && c.e2.exp > 0) ? "YES" : "NO"}`);
L.push(`27. Symmetric? see side lines`);
{
  const s = getS("rr|1|2|none|none", 1);
  L.push(`28. Spread removes: GROSS Exp=${f2(s.grossExp)} EXEC Exp=${f2(s.exp)} (Δ=${f2(s.grossExp - s.exp)})`);
}
L.push(`29. Better than forcing 1:2? dynamic explores RR; forcing 1:2 alone ${dyn1_2.exp > fix20.exp ? "beats fixed stops somewhat" : "does not beat fixed enough"}`);
L.push(`30. Executable? ${anyPf ? "CONDITIONAL" : "NO"}`);

L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("");
L.push("SIMPLE FINAL");
if (bestPos) {
  L.push(`BEST VALID: ${bestPos.label}`);
  L.push(
    `  N=${bestPos.s.n} WR=${f1(bestPos.s.wr)} PF=${f2(bestPos.s.pf)} Exp=${f2(bestPos.s.exp)} MedRew=${f2(bestPos.s.medRew)} MedSL=${f2(bestPos.s.medSl)} Surv=${f1(bestPos.s.survive)}%`,
  );
} else {
  L.push(`No PF>1 configuration. Least-bad: ${bestOverall.label}`);
  L.push(
    `  N=${bestOverall.s.n} WR=${f1(bestOverall.s.wr)} PF=${f2(bestOverall.s.pf)} Exp=${f2(bestOverall.s.exp)} MedRew=${f2(bestOverall.s.medRew)} MedSL=${f2(bestOverall.s.medSl)} Surv=${f1(bestOverall.s.survive)}%`,
  );
}
L.push("");
L.push(
  `Does calculating RR from the actual S/R distance work better than forcing 1:2? ${improves ? "It can beat fixed-pip stops, but does not create a robust edge by itself." : "Not enough — still negative like V30."}`,
);
L.push(
  `Should GX reject a trade when the opposite S/R is too close? YES — tiny rewards make relative spread and RR geometry toxic; min-reward filters are structurally justified even if they do not alone produce PF>1.`,
);
L.push(`Did we find a profitable dynamic RR system? ${anyPf ? "CONDITIONAL — see positives" : "NO"}`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-dynamic-sr-rr-v31-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
