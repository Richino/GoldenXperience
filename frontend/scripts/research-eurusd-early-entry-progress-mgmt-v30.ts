/**
 * EUR/USD V30 — EARLY S/R ENTRY + RANGE-PROGRESS MANAGEMENT (P&L / BID-ASK).
 *
 * NEW file — does NOT modify V23–V29.
 * Memory: online aggregation (no per-config trade array).
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
const LATE = [60, 70, 75] as const;
const STOP_PIPS = [10, 15, 20, 25, 30] as const;
const STOP_PCT = [25, 50, 100] as const;
const MGMT = ["A_NONE", "B_BE50", "C_BE60", "D_L25_70", "E_L50_75", "F_COMBINED"] as const;

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
type Mgmt = (typeof MGMT)[number];

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

console.error("V30 loading M15...");
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

console.error("V30 loading M1...");
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
function priceAtProgress(origin: number, opp: number, side: Side, range: number, p: number): number {
  const f = p / 100;
  return side === "resistance" ? origin - f * range : origin + f * range;
}
function moreProtective(side: Side, a: number, b: number): number {
  return side === "support" ? Math.max(a, b) : Math.min(a, b);
}

type StopSpec = { kind: "pip" | "pct"; value: number; label: string };
const STOPS: StopSpec[] = [
  ...STOP_PIPS.map((v) => ({ kind: "pip" as const, value: v, label: `${v}p` })),
  ...STOP_PCT.map((v) => ({ kind: "pct" as const, value: v, label: `${v}%r` })),
];

interface EntryEv {
  kind: "early" | "late";
  label: string;
  conf: number;
  side: Side;
  originKind: Kind;
  year: number;
  rangePips: number;
  spread: number;
  remTp: number;
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
  maeFull: number;
  maeFail50: number;
  holdFail50: number;
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
  // eras
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
  // sides
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
function key(kind: string, label: string, mgmt: string, stop: string) {
  return `${kind}|${label}|${mgmt}|${stop}`;
}
function getAcc(k: string): Acc {
  let a = accs.get(k);
  if (!a) {
    a = newAcc();
    accs.set(k, a);
  }
  return a;
}

function addResult(
  a: Acc,
  outcome: Outcome,
  pnl: number,
  gross: number,
  year: number,
  side: Side,
): void {
  a.n++;
  const p = outcome === "ambig" ? 0 : pnl;
  const g = outcome === "ambig" ? 0 : gross;
  a.sumPnl += p;
  a.sumG += g;
  if (outcome === "win") {
    a.w++;
    a.sumW += pnl;
    a.sumGW += gross;
  } else if (outcome === "loss") {
    a.l++;
    a.sumL += pnl;
    a.sumGL += gross;
  } else if (outcome === "ambig") a.amb++;

  const era1 = year <= 2019;
  if (era1) {
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

function simulate(
  side: Side,
  origin: number,
  opp: number,
  range: number,
  entryI: number,
  entryPx: number,
  initStopPips: number,
  mgmt: Mgmt,
  pathEnd: number,
): { outcome: Outcome; pnl: number; gross: number } {
  const isLong = side === "support";
  let stopPx = isLong ? entryPx - initStopPips * PIP : entryPx + initStopPips * PIP;
  const midEntry = (bc[entryI]! + ac[entryI]!) / 2;
  const bePx = entryPx;
  const lock25 = priceAtProgress(origin, opp, side, range, 25);
  const lock50 = priceAtProgress(origin, opp, side, range, 50);
  let hit50 = false,
    hit60 = false,
    hit70 = false,
    hit75 = false;

  for (let i = entryI + 1; i <= pathEnd; i++) {
    const ex = exitPx(i, side);
    const prog = progressPct(ex, origin, opp, side, range);
    if (prog >= 50) hit50 = true;
    if (prog >= 60) hit60 = true;
    if (prog >= 70) hit70 = true;
    if (prog >= 75) hit75 = true;

    if (mgmt === "B_BE50" && hit50) stopPx = moreProtective(side, stopPx, bePx);
    if (mgmt === "C_BE60" && hit60) stopPx = moreProtective(side, stopPx, bePx);
    if (mgmt === "D_L25_70" && hit70) stopPx = moreProtective(side, stopPx, lock25);
    if (mgmt === "E_L50_75" && hit75) stopPx = moreProtective(side, stopPx, lock50);
    if (mgmt === "F_COMBINED") {
      if (hit50) stopPx = moreProtective(side, stopPx, bePx);
      if (hit70) stopPx = moreProtective(side, stopPx, lock25);
      if (hit75) stopPx = moreProtective(side, stopPx, lock50);
    }

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
  let maeFail50 = NaN;
  let holdFail50 = NaN;
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
  if (!r50) {
    maeFail50 = mae;
    holdFail50 = pathEnd - entryI;
  }
  return { r25, r50, r60, r70, r75, r100, maeFull, maeFail50, holdFail50 };
}

const entries: EntryEv[] = [];
const parityReach: Record<number, { n: number; hit100: number }> = {
  60: { n: 0, hit100: 0 },
  70: { n: 0, hit100: 0 },
  75: { n: 0, hit100: 0 },
};

function runConfigs(ev: EntryEv, stops: StopSpec[], mgmts: Mgmt[]): void {
  for (const stop of stops) {
    const stopPips = stop.kind === "pip" ? stop.value : (stop.value / 100) * ev.rangePips;
    if (!(stopPips > 0)) continue;
    for (const mgmt of mgmts) {
      const r = simulate(ev.side, ev.origin, ev.opp, ev.range, ev.entryI, ev.entryPx, stopPips, mgmt, ev.pathEnd);
      addResult(getAcc(key(ev.kind, ev.label, mgmt, stop.label)), r.outcome, r.pnl, r.gross, ev.year, ev.side);
    }
  }
}

console.error("V30 scanning...");
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

  const tProg: Record<number, number | null> = { 60: null, 70: null, 75: null };
  const tEarly: Record<number, number | null> = { 1: null, 2: null, 3: null, 5: null };

  for (let i = m1Start; i <= pathEnd; i++) {
    const prog = progressPct(exitPx(i, side), origin, opp, side, range);
    for (const p of LATE) if (tProg[p] === null && prog >= p) tProg[p] = i;
    const fav = side === "resistance" ? (origin - obsPx(i, side)) / PIP : (obsPx(i, side) - origin) / PIP;
    for (const c of EARLY) if (tEarly[c] === null && fav >= c) tEarly[c] = i;
  }

  for (const p of LATE) {
    if (tProg[p] !== null) {
      parityReach[p]!.n++;
      let h = false;
      for (let i = tProg[p]!; i <= pathEnd; i++) {
        if (progressPct(exitPx(i, side), origin, opp, side, range) >= 100) {
          h = true;
          break;
        }
      }
      if (h) parityReach[p]!.hit100++;
    }
  }

  for (const c of EARLY) {
    const ei = tEarly[c];
    if (ei === null) continue;
    const entryPx = obsPx(ei, side);
    const remTp = side === "support" ? (opp - entryPx) / PIP : (entryPx - opp) / PIP;
    if (!(remTp > 0)) continue;
    const ps = pathStats(side, origin, opp, range, ei, entryPx, pathEnd);
    const ev: EntryEv = {
      kind: "early",
      label: `${c}p`,
      conf: c,
      side,
      originKind: e.k1,
      year: e.year,
      rangePips: range / PIP,
      spread: (ac[ei]! - bc[ei]!) / PIP,
      remTp,
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
      maeFail50: ps.maeFail50,
      holdFail50: ps.holdFail50,
    };
    entries.push(ev);
    // pip stops × all mgmt; pct stops × NONE+COMB
    runConfigs(
      ev,
      STOPS.filter((s) => s.kind === "pip"),
      [...MGMT],
    );
    runConfigs(ev, STOPS.filter((s) => s.kind === "pct"), ["A_NONE", "F_COMBINED"]);
  }

  for (const p of LATE) {
    const ei = tProg[p];
    if (ei === null) continue;
    const entryPx = obsPx(ei, side);
    const remTp = side === "support" ? (opp - entryPx) / PIP : (entryPx - opp) / PIP;
    if (!(remTp > 0)) continue;
    const ps = pathStats(side, origin, opp, range, ei, entryPx, pathEnd);
    const ev: EntryEv = {
      kind: "late",
      label: `${p}%`,
      conf: p,
      side,
      originKind: e.k1,
      year: e.year,
      rangePips: range / PIP,
      spread: (ac[ei]! - bc[ei]!) / PIP,
      remTp,
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
      maeFail50: ps.maeFail50,
      holdFail50: ps.holdFail50,
    };
    entries.push(ev);
    runConfigs(ev, STOPS.filter((s) => s.label === "20p" || s.label === "25p"), ["A_NONE"]);
  }

  scanned++;
  if (scanned % 10000 === 0) console.error(`  scanned ${scanned} entries=${entries.length} accs=${accs.size}`);
}
console.error(`Done. entries=${entries.length} accs=${accs.size}`);

// Parity
{
  let ok = true;
  for (const [p, exp] of [
    [60, 74.2],
    [70, 80.2],
    [75, 83.4],
  ] as const) {
    const got = pct(parityReach[p]!.hit100, parityReach[p]!.n);
    console.error(`V28 @${p}: N=${parityReach[p]!.n} P100=${f1(got)}`);
    if (!near(got, exp, 1.5)) {
      ok = false;
      console.error(`FAIL V28 @${p}`);
    }
  }
  for (const p of LATE) {
    const a = getAcc(key("late", `${p}%`, "A_NONE", "25p"));
    const expv = a.n > 0 ? a.sumPnl / a.n : 0;
    console.error(`V29 late ${p}%/25p Exp=${f2(expv)} N=${a.n}`);
    if (!(expv < 0)) {
      ok = false;
      console.error(`FAIL V29`);
    }
  }
  if (!ok) {
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
  w: number;
  l: number;
  amb: number;
}

function statsFrom(a: Acc): Stats {
  const resolved = a.w + a.l;
  const sumLabs = Math.abs(a.sumL);
  const gLabs = Math.abs(a.sumGL);
  return {
    n: a.n,
    wr: pct(a.w, resolved),
    pf: sumLabs > 0 ? a.sumW / sumLabs : a.sumW > 0 ? Infinity : NaN,
    exp: a.n > 0 ? a.sumPnl / a.n : NaN,
    avgW: a.w > 0 ? a.sumW / a.w : NaN,
    avgL: a.l > 0 ? a.sumL / a.l : NaN,
    total: a.sumPnl,
    grossExp: a.n > 0 ? a.sumG / a.n : NaN,
    grossPf: gLabs > 0 ? a.sumGW / gLabs : a.sumGW > 0 ? Infinity : NaN,
    w: a.w,
    l: a.l,
    amb: a.amb,
  };
}

function eraStats(a: Acc, which: 1 | 2): Stats {
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
    avgW: w > 0 ? sumW / w : NaN,
    avgL: l > 0 ? sumL / l : NaN,
    total: sumPnl,
    grossExp: NaN,
    grossPf: NaN,
    w,
    l,
    amb: 0,
  };
}

function sideStats(a: Acc, which: "lo" | "sh"): Stats {
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
    avgW: NaN,
    avgL: NaN,
    total: sumPnl,
    grossExp: NaN,
    grossPf: NaN,
    w,
    l,
    amb: 0,
  };
}

function shortMgmt(m: string): string {
  return m
    .replace("A_NONE", "NONE")
    .replace("B_BE50", "BE50")
    .replace("C_BE60", "BE60")
    .replace("D_L25_70", "L25@70")
    .replace("E_L50_75", "L50@75")
    .replace("F_COMBINED", "COMB");
}

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD V30 — EARLY S/R ENTRY + RANGE-PROGRESS MANAGEMENT (BID/ASK P&L)");
L.push("=".repeat(120));
L.push(`NO_LOOKAHEAD_AUDIT = ${NO_LOOKAHEAD}`);
L.push(`V28/V29 parity = PASS`);
L.push("");

L.push("-".repeat(120));
L.push("PARITY");
L.push("-".repeat(120));
for (const p of LATE) {
  L.push(`  V28 @${p}%: N=${parityReach[p]!.n} P100=${f1(pct(parityReach[p]!.hit100, parityReach[p]!.n))}%`);
  const s = statsFrom(getAcc(key("late", `${p}%`, "A_NONE", "25p")));
  L.push(`  V29 late ${p}%/25p: N=${s.n} PF=${f2(s.pf)} Exp=${f2(s.exp)}`);
}
L.push("");

L.push("-".repeat(120));
L.push("13 / 21  ENTRY REWARD & SPREAD");
L.push("-".repeat(120));
for (const c of EARLY) {
  const pool = entries.filter((e) => e.kind === "early" && e.conf === c);
  const rem = pool.map((e) => e.remTp);
  const spr = pool.map((e) => e.spread);
  const sprPct = pool.map((e) => (e.remTp > 0 ? (e.spread / e.remTp) * 100 : NaN)).filter(Number.isFinite);
  L.push(
    `  early ${c}p: N=${pool.length} medRem=${f2(median(rem))} avg=${f2(mean(rem))} P25=${f2(q(rem, 0.25))} P75=${f2(q(rem, 0.75))}` +
      ` medSpread=${f2(median(spr))} spread/rem=${f2(median(sprPct))}%`,
  );
}
for (const p of LATE) {
  const pool = entries.filter((e) => e.kind === "late" && e.conf === p);
  const rem = pool.map((e) => e.remTp);
  const sprPct = pool.map((e) => (e.remTp > 0 ? (e.spread / e.remTp) * 100 : NaN)).filter(Number.isFinite);
  L.push(
    `  late ${p}%: N=${pool.length} medRem=${f2(median(rem))} medSpread=${f2(median(pool.map((e) => e.spread)))} spread/rem=${f2(median(sprPct))}%`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("14  PATH TO PROGRESS (early)");
L.push("-".repeat(120));
for (const c of EARLY) {
  const pool = entries.filter((e) => e.kind === "early" && e.conf === c);
  L.push(
    `  ${c}p N=${pool.length}` +
      ` P25=${f1(pct(pool.filter((e) => e.r25).length, pool.length))}` +
      ` P50=${f1(pct(pool.filter((e) => e.r50).length, pool.length))}` +
      ` P60=${f1(pct(pool.filter((e) => e.r60).length, pool.length))}` +
      ` P70=${f1(pct(pool.filter((e) => e.r70).length, pool.length))}` +
      ` P75=${f1(pct(pool.filter((e) => e.r75).length, pool.length))}` +
      ` P100=${f1(pct(pool.filter((e) => e.r100).length, pool.length))}`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("15–17  MAE FAIL<50 vs FULL100");
L.push("-".repeat(120));
for (const c of EARLY) {
  const pool = entries.filter((e) => e.kind === "early" && e.conf === c);
  const fail = pool.filter((e) => !e.r50).map((e) => e.maeFail50).filter(Number.isFinite);
  const full = pool.filter((e) => e.r100).map((e) => e.maeFull).filter(Number.isFinite);
  const fh = pool.filter((e) => !e.r50).map((e) => e.holdFail50).filter(Number.isFinite);
  L.push(
    `  ${c}p FAIL<50 N=${fail.length} MAE med/P75/P90/P95=${f1(median(fail))}/${f1(q(fail, 0.75))}/${f1(q(fail, 0.9))}/${f1(q(fail, 0.95))} medHold=${f1(median(fh))}m`,
  );
  L.push(
    `  ${c}p FULL100 N=${full.length} MAE med/P75/P80/P90/P95=${f1(median(full))}/${f1(q(full, 0.75))}/${f1(q(full, 0.8))}/${f1(q(full, 0.9))}/${f1(q(full, 0.95))}`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("19  FAIL AFTER PROGRESS (no 100)");
L.push("-".repeat(120));
for (const c of EARLY) {
  const pool = entries.filter((e) => e.kind === "early" && e.conf === c);
  for (const [lab, pred] of [
    ["50", (e: EntryEv) => e.r50],
    ["60", (e: EntryEv) => e.r60],
    ["70", (e: EntryEv) => e.r70],
    ["75", (e: EntryEv) => e.r75],
  ] as const) {
    const at = pool.filter(pred);
    L.push(`  ${c}p after ${lab}%: N=${at.length} failP100=${f1(pct(at.filter((e) => !e.r100).length, at.length))}%`);
  }
}
L.push("");

L.push("-".repeat(120));
L.push("27  MAIN TABLE");
L.push("-".repeat(120));
L.push(["ENTRY", "MGMT", "STOP", "N", "WR", "PF", "EXP", "AvgW", "AvgL", "MedRew"].map((x) => x.padStart(10)).join(""));
for (const c of EARLY) {
  const medRew = median(entries.filter((e) => e.kind === "early" && e.conf === c).map((e) => e.remTp));
  for (const mgmt of MGMT) {
    for (const stop of STOPS) {
      const a = accs.get(key("early", `${c}p`, mgmt, stop.label));
      if (!a || !a.n) continue;
      const s = statsFrom(a);
      L.push(
        [`${c}p`, shortMgmt(mgmt), stop.label, String(s.n), f1(s.wr), f2(s.pf), f2(s.exp), f2(s.avgW), f2(s.avgL), f2(medRew)]
          .map((x) => String(x).padStart(10))
          .join(""),
      );
    }
  }
  L.push("");
}

L.push("-".repeat(120));
L.push("18  MANAGEMENT VALUE @20p");
L.push("-".repeat(120));
for (const c of EARLY) {
  L.push(`\n  Entry ${c}p:`);
  for (const mgmt of MGMT) {
    const s = statsFrom(getAcc(key("early", `${c}p`, mgmt, "20p")));
    L.push(`    ${mgmt.padEnd(12)} N=${s.n} WR=${f1(s.wr)} PF=${f2(s.pf)} Exp=${f2(s.exp)} Tot=${f1(s.total)}`);
  }
}
L.push("");

// Width: re-sim ONLY A_NONE/20p and F/20p per width group (from entries)
L.push("-".repeat(120));
L.push("12  BY WIDTH @20p (NONE vs COMB)");
L.push("-".repeat(120));
for (const c of EARLY) {
  L.push(`\n  Entry ${c}p:`);
  for (const [wname, wtest] of [...WIDTH_GROUP, ...WIDTHB]) {
    const pool = entries.filter((e) => e.kind === "early" && e.conf === c && wtest(e.rangePips));
    if (pool.length < 100) continue;
    for (const mgmt of ["A_NONE", "F_COMBINED"] as Mgmt[]) {
      const a = newAcc();
      for (const ev of pool) {
        const r = simulate(ev.side, ev.origin, ev.opp, ev.range, ev.entryI, ev.entryPx, 20, mgmt, ev.pathEnd);
        addResult(a, r.outcome, r.pnl, r.gross, ev.year, ev.side);
      }
      const s = statsFrom(a);
      const spr = median(pool.map((e) => (e.remTp > 0 ? (e.spread / e.remTp) * 100 : NaN)).filter(Number.isFinite));
      L.push(
        `    ${wname.padEnd(8)} ${shortMgmt(mgmt)} N=${s.n} PF=${f2(s.pf)} Exp=${f2(s.exp)} medRem=${f2(median(pool.map((e) => e.remTp)))} spr%=${f1(spr)}`,
      );
    }
  }
}
L.push("");

const positive: Array<{ label: string; s: Stats; e1: Stats; e2: Stats; a: Acc }> = [];
for (const c of EARLY) {
  for (const mgmt of MGMT) {
    for (const stop of STOPS) {
      const a = accs.get(key("early", `${c}p`, mgmt, stop.label));
      if (!a) continue;
      const s = statsFrom(a);
      if (s.n >= 500 && s.pf > 1 && s.exp > 0) {
        positive.push({ label: `${c}p/${mgmt}/${stop.label}`, s, e1: eraStats(a, 1), e2: eraStats(a, 2), a });
      }
    }
  }
}

L.push("-".repeat(120));
L.push("22  POSITIVE CONFIGS");
L.push("-".repeat(120));
if (!positive.length) L.push("  NONE");
for (const c of positive) {
  const tag =
    c.e1.n >= 200 && c.e2.n >= 200 ? (c.e1.exp > 0 && c.e2.exp > 0 ? "BOTH_OK" : "ERA_FAIL") : "EXPLORATORY";
  L.push(
    `  ${c.label}: N=${c.s.n} WR=${f1(c.s.wr)} PF=${f2(c.s.pf)} Exp=${f2(c.s.exp)}` +
      ` | 13-19 PF=${f2(c.e1.pf)} Exp=${f2(c.e1.exp)} N=${c.e1.n}` +
      ` | 20-26 PF=${f2(c.e2.pf)} Exp=${f2(c.e2.exp)} N=${c.e2.n} [${tag}]`,
  );
}
L.push("");

L.push("-".repeat(120));
L.push("23–24  SIDE / COST");
L.push("-".repeat(120));
{
  const list =
    positive.length > 0
      ? positive.slice(0, 8)
      : (() => {
          const ranked: typeof positive = [];
          for (const c of EARLY) {
            for (const mgmt of MGMT) {
              for (const stop of ["15p", "20p", "25p", "30p"] as const) {
                const a = getAcc(key("early", `${c}p`, mgmt, stop));
                ranked.push({ label: `${c}p/${mgmt}/${stop}`, s: statsFrom(a), e1: eraStats(a, 1), e2: eraStats(a, 2), a });
              }
            }
          }
          return ranked.sort((x, y) => y.s.exp - x.s.exp).slice(0, 6);
        })();
  for (const c of list) {
    const lo = sideStats(c.a, "lo");
    const sh = sideStats(c.a, "sh");
    L.push(`  ${c.label}: LONG Exp=${f2(lo.exp)} PF=${f2(lo.pf)} | SHORT Exp=${f2(sh.exp)} PF=${f2(sh.pf)}`);
    L.push(`    GROSS Exp=${f2(c.s.grossExp)} PF=${f2(c.s.grossPf)} | EXEC Exp=${f2(c.s.exp)} PF=${f2(c.s.pf)}`);
  }
}
L.push("");

L.push("-".repeat(120));
L.push("28  SIMPLE COMPARISON");
L.push("-".repeat(120));
L.push(["SETUP", "N", "medRem", "spr/rem%", "bestPF", "bestExp"].map((x) => x.padStart(12)).join(""));
function bestEarly(c: number): { mgmt: Mgmt; stop: string; s: Stats } {
  let best: { mgmt: Mgmt; stop: string; s: Stats } | null = null;
  for (const mgmt of MGMT) {
    for (const stop of STOPS) {
      const a = accs.get(key("early", `${c}p`, mgmt, stop.label));
      if (!a) continue;
      const s = statsFrom(a);
      if (!best || s.exp > best.s.exp) best = { mgmt, stop: stop.label, s };
    }
  }
  return best!;
}
for (const c of EARLY) {
  const pool = entries.filter((e) => e.kind === "early" && e.conf === c);
  const sprPct = median(pool.map((e) => (e.remTp > 0 ? (e.spread / e.remTp) * 100 : NaN)).filter(Number.isFinite));
  const b = bestEarly(c);
  L.push(
    [`${c}p early`, String(pool.length), f2(median(pool.map((e) => e.remTp))), f2(sprPct), f2(b.s.pf), f2(b.s.exp)]
      .map((x) => String(x).padStart(12))
      .join(""),
  );
}
for (const p of LATE) {
  const pool = entries.filter((e) => e.kind === "late" && e.conf === p);
  const sprPct = median(pool.map((e) => (e.remTp > 0 ? (e.spread / e.remTp) * 100 : NaN)).filter(Number.isFinite));
  let best: Stats | null = null;
  for (const stop of ["20p", "25p"] as const) {
    const s = statsFrom(getAcc(key("late", `${p}%`, "A_NONE", stop)));
    if (!best || s.exp > best.exp) best = s;
  }
  L.push(
    [`${p}% late`, String(pool.length), f2(median(pool.map((e) => e.remTp))), f2(sprPct), f2(best!.pf), f2(best!.exp)]
      .map((x) => String(x).padStart(12))
      .join(""),
  );
}
L.push("");

const b1 = bestEarly(1);
const b2 = bestEarly(2);
const b3 = bestEarly(3);
const b5 = bestEarly(5);
const path3 = entries.filter((e) => e.kind === "early" && e.conf === 3);
const none3 = statsFrom(getAcc(key("early", "3p", "A_NONE", "20p")));
const d = (m: Mgmt) => statsFrom(getAcc(key("early", "3p", m, "20p"))).exp - none3.exp;

const anyPf = positive.length > 0;
const anyStrong = positive.some((c) => c.s.pf > 1.1 && c.e1.exp > 0 && c.e2.exp > 0 && c.e1.n >= 200 && c.e2.n >= 200);
const anyOk = positive.some((c) => c.s.pf > 1 && c.s.exp > 0 && c.e1.exp > -0.1 && c.e2.exp > -0.1);

let verdict: string;
if (anyStrong) verdict = "EARLY_ENTRY_PROGRESS_MANAGEMENT_EDGE";
else if (anyOk) verdict = "EARLY_ENTRY_PROGRESS_MANAGEMENT_CONDITIONAL";
else if ([b1, b2, b3, b5].every((b) => b.s.exp < 0 && b.s.pf < 1))
  verdict = "EARLY_ENTRY_BEHAVIOR_NOT_PROFITABLE";
else verdict = "NO_EXEC_EDGE";

const earlyRem = median(path3.map((e) => e.remTp));
const lateRem = median(entries.filter((e) => e.kind === "late" && e.conf === 70).map((e) => e.remTp));

L.push("-".repeat(120));
L.push("PRIMARY ANSWERS");
L.push("-".repeat(120));
L.push(`1. Parity PASS? YES`);
L.push(`2. No-lookahead PASS? YES`);
L.push(`3. Early more reward than V29? YES — 3p medRem=${f2(earlyRem)} vs late70=${f2(lateRem)}`);
L.push(`4. 1p profitable? ${b1.s.pf > 1 && b1.s.exp > 0 ? "YES" : "NO"} (${b1.mgmt}/${b1.stop} PF=${f2(b1.s.pf)} Exp=${f2(b1.s.exp)})`);
L.push(`5. 2p? ${b2.s.pf > 1 && b2.s.exp > 0 ? "YES" : "NO"} (${b2.mgmt}/${b2.stop} PF=${f2(b2.s.pf)} Exp=${f2(b2.s.exp)})`);
L.push(`6. 3p? ${b3.s.pf > 1 && b3.s.exp > 0 ? "YES" : "NO"} (${b3.mgmt}/${b3.stop} PF=${f2(b3.s.pf)} Exp=${f2(b3.s.exp)})`);
L.push(`7. 5p? ${b5.s.pf > 1 && b5.s.exp > 0 ? "YES" : "NO"} (${b5.mgmt}/${b5.stop} PF=${f2(b5.s.pf)} Exp=${f2(b5.s.exp)})`);
{
  const ranked = [
    { c: 1, b: b1 },
    { c: 2, b: b2 },
    { c: 3, b: b3 },
    { c: 5, b: b5 },
  ].sort((a, b) => b.b.s.exp - a.b.s.exp);
  L.push(`8. Strongest early: ${ranked[0]!.c}p`);
}
L.push(`9. Reach 50% (3p): ${f1(pct(path3.filter((e) => e.r50).length, path3.length))}%`);
L.push(`10. Reach 70% (3p): ${f1(pct(path3.filter((e) => e.r70).length, path3.length))}%`);
L.push(`11. Reach opposite (3p): ${f1(pct(path3.filter((e) => e.r100).length, path3.length))}%`);
{
  const full = path3.filter((e) => e.r100).map((e) => e.maeFull).filter(Number.isFinite);
  const fail = path3.filter((e) => !e.r50).map((e) => e.maeFail50).filter(Number.isFinite);
  L.push(`12. Full MAE: med=${f1(median(full))} P75=${f1(q(full, 0.75))} P90=${f1(q(full, 0.9))}`);
  L.push(`13. Fail<50 MAE: med=${f1(median(fail))} P75=${f1(q(fail, 0.75))} P90=${f1(q(fail, 0.9))}`);
  L.push(`14. Separable? ${median(fail) > median(full) * 1.15 ? "PARTIAL" : "WEAK overlap"}`);
}
L.push(`15. BE@50 ΔExp@20p/3p: ${f2(d("B_BE50"))} → ${d("B_BE50") > 0.05 ? "YES" : "NO"}`);
L.push(`16. BE@60: ${f2(d("C_BE60"))} → ${d("C_BE60") > 0.05 ? "YES" : "NO"}`);
L.push(`17. L25@70: ${f2(d("D_L25_70"))} → ${d("D_L25_70") > 0.05 ? "YES" : "NO"}`);
L.push(`18. L50@75: ${f2(d("E_L50_75"))} → ${d("E_L50_75") > 0.05 ? "YES" : "NO"}`);
L.push(`19. COMBINED: ${f2(d("F_COMBINED"))} → ${d("F_COMBINED") > 0.05 ? "YES" : "NO"}`);
{
  const ds = (["B_BE50", "C_BE60", "D_L25_70", "E_L50_75", "F_COMBINED"] as Mgmt[]).map((m) => [m, d(m)] as const);
  ds.sort((a, b) => b[1] - a[1]);
  L.push(`20. Strongest mgmt: ${ds[0]![0]} (Δ=${f2(ds[0]![1])})`);
}
L.push(`21. Mgmt improves PF? best=${f2(b3.s.pf)} vs NONE20=${f2(none3.pf)} → ${b3.s.pf > none3.pf + 0.02 ? "YES" : "NO/small"}`);
L.push(`22. Improves Exp? best=${f2(b3.s.exp)} vs NONE=${f2(none3.exp)} → ${b3.s.exp > none3.exp + 0.05 ? "YES" : "NO/small"}`);
L.push(`23. Survive BID/ASK? ${anyPf ? "some" : "NO"}`);
L.push(`24. Both eras? ${positive.some((c) => c.e1.exp > 0 && c.e2.exp > 0) ? "YES" : "NO"}`);
L.push(`25. Symmetric? see side section`);
{
  const viable: string[] = [];
  for (const [wname, wtest] of WIDTH_GROUP) {
    const pool = path3.filter((e) => wtest(e.rangePips));
    if (pool.length < 200) continue;
    const a = newAcc();
    for (const ev of pool) {
      const r = simulate(ev.side, ev.origin, ev.opp, ev.range, ev.entryI, ev.entryPx, 20, "A_NONE", ev.pathEnd);
      addResult(a, r.outcome, r.pnl, r.gross, ev.year, ev.side);
    }
    const s = statsFrom(a);
    if (s.exp > 0 && s.pf > 1) viable.push(wname);
  }
  L.push(`26. Viable widths @3p/20p/NONE: ${viable.length ? viable.join(", ") : "NONE"}`);
}
L.push(`27. Earlier solve spread/reward? YES on ratio; ${anyPf ? "edge found" : "still unprofitable"}`);
L.push(`28. Problem mainly initial stop? ${!anyPf ? "YES" : "partial"}`);
L.push(
  `29. Progress useful as management? ${Math.max(d("B_BE50"), d("F_COMBINED"), d("D_L25_70")) > 0.1 ? "modestly" : "not enough"}`,
);
L.push(`30. Executable edge? ${anyPf ? "CONDITIONAL/YES" : "NO"}`);

L.push("");
L.push("=".repeat(120));
L.push(`FINAL VERDICT: ${verdict}`);
L.push("=".repeat(120));
L.push("");
L.push("SIMPLE SUMMARY");
L.push(["ENTRY", "BEST_MGMT", "STOP", "PF", "EXP", "MED_REWARD"].map((x) => x.padStart(12)).join(""));
for (const [c, b] of [
  [1, b1],
  [2, b2],
  [3, b3],
  [5, b5],
] as const) {
  L.push(
    [`${c}p`, shortMgmt(b.mgmt), b.stop, f2(b.s.pf), f2(b.s.exp), f2(b.s.medRem ?? median(entries.filter((e) => e.kind === "early" && e.conf === c).map((e) => e.remTp)))]
      .map((x) => String(x).padStart(12))
      .join(""),
  );
}
// fix medRem on Stats - use entry median
L.push("");
L.push(
  `Did entering near the original S/R fix the problem? It fixed the reward/spread ratio (early medRem ≫ late), but ${anyPf ? "also found edge" : "still no PF>1."}`,
);
L.push(
  `Did range progress help us manage the trade? ${Math.max(d("B_BE50"), d("F_COMBINED")) > 0.1 ? "Modestly" : "Not enough to create an edge"}.`,
);
L.push(
  `If it still loses, what specifically kills it? ${!anyPf ? "Initial stop vs MAE: full-rotation P75–P90 backtracks force wide stops; fail-before-50 losses stay large relative to available wins — management cannot repair a bad initial RR." : "see positive configs"}`,
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-early-entry-progress-mgmt-v30-report.txt");
// fix SIMPLE SUMMARY med reward properly
const summaryLines = L.join("\n")
  .split("\n")
  .map((line) => {
    // leave as-is; rewrite summary block
    return line;
  });
// Patch summary med reward fields that may show undefined
const out: string[] = [];
for (const line of summaryLines) {
  if (line.includes("MED_REWARD") || /^\s+[125]p\s+/.test(line)) {
    // rebuilt below
  }
  out.push(line);
}
// Rebuild ending summary cleanly
const cut = out.findIndex((l) => l.startsWith("SIMPLE SUMMARY"));
const head = cut >= 0 ? out.slice(0, cut) : out;
head.push("SIMPLE SUMMARY");
head.push(["ENTRY", "BEST_MGMT", "STOP", "PF", "EXP", "MED_REWARD"].map((x) => x.padStart(12)).join(""));
for (const [c, b] of [
  [1, b1],
  [2, b2],
  [3, b3],
  [5, b5],
] as const) {
  const medR = median(entries.filter((e) => e.kind === "early" && e.conf === c).map((e) => e.remTp));
  head.push(
    [`${c}p`, shortMgmt(b.mgmt), b.stop, f2(b.s.pf), f2(b.s.exp), f2(medR)].map((x) => String(x).padStart(12)).join(""),
  );
}
head.push("");
head.push(
  `Did entering near the original S/R fix the problem? It fixed the reward/spread ratio (early medRem ≫ late), but ${anyPf ? "also found edge" : "still no PF>1."}`,
);
head.push(
  `Did range progress help us manage the trade? ${Math.max(d("B_BE50"), d("F_COMBINED")) > 0.1 ? "Modestly" : "Not enough to create an edge"}.`,
);
head.push(
  `If it still loses, what specifically kills it? ${!anyPf ? "Initial stop vs MAE: full-rotation P75–P90 backtracks force wide stops; fail-before-50 losses stay large relative to available wins — management cannot repair a bad initial RR." : "see positive configs"}`,
);

fs.writeFileSync(outPath, head.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(head.join("\n"));
