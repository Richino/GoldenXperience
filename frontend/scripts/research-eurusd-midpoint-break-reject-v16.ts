/**
 * EUR/USD — 15M RANGE MIDPOINT BREAK vs REJECT (V16, research-only).
 *
 * V15 is FROZEN — this script does not modify it.
 *
 * V15 finding preserved: after reclaim, price reaches 50% MID ~75.5%; opposite ~50%;
 * internal 5M S/R does not explain stopping. V16 asks what happens AT MID.
 *
 * Pipeline (identical to V15): exact project 15M S/R via assessMarketCondition,
 * freeze rangeLow/rangeHigh, minPen break, reclaim close inside, M5 mid path.
 * No TP/SL strategy. Controls at 40% and 60%.
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
const PIP = pipSizeFor(INSTRUMENT);
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15C = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5C = path.join(PAD, "eurusd-m5-mba-cache.json");
const OUT_DIR = PAD;

const WINDOW = 220;
const HORIZON_M15 = 96;
const PATH_M5 = 576;
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const HIT_PCTS = [5, 10, 15, 20, 25] as const;
const DEPTH_PCTS = [60, 70, 75, 90, 100] as const;
const V15_MID_REACH_REF = 75.5; // combined, for validation note

type Side = "long" | "short";
type SignalKind =
  | "touch"
  | "close1"
  | "close2"
  | "atr25"
  | "atr50"
  | "atr100"
  | "retestHold";
type WidthBin = "0-10" | "10-20" | "20-30" | "30-50" | "50+";
type SpeedBin = "fast" | "medium" | "slow";
type Hit = "cont" | "fail" | "amb" | "none";

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

interface Setup {
  side: Side;
  t0: number;
  support: number;
  resistance: number;
  atr15: number;
}

interface Reclaim {
  side: Side;
  support: number;
  resistance: number;
  mid: number;
  R: number;
  rangePips: number;
  reclaimIdx: number; // M5 index at reclaim close
  atr5: number;
  reachedMid: boolean;
  midTouchIdx: number; // first M5 that touches mid, or -1
}

interface Approach {
  mins: number;
  bars: number;
  speed: SpeedBin;
  consecToward: number;
  atrMove: number;
  crossBody: number;
  crossRange: number;
  crossBodyRatio: number;
  crossWick: number;
  crossClosedThru: boolean;
}

interface SignalRow {
  side: Side;
  kind: SignalKind;
  levelPct: number; // 40 / 50 / 60
  sigIdx: number;
  rangePips: number;
  width: WidthBin;
  approach: Approach | null;
  hits: Record<number, Hit>; // distance% -> outcome
  reach: Record<number, boolean>; // depth% of full range from support
  maxContPct: number; // max favorable % of R after signal
  maxAdvPct: number;
  t75Min: number;
  t100Min: number;
}

const raw: RC[] = JSON.parse(fs.readFileSync(M15C, "utf8"));
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

const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M5C, "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const mh = new Float64Array(M),
  ml = new Float64Array(M),
  mc = new Float64Array(M),
  mo = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
  mo[i] = i === 0 ? mc[i]! : mc[i - 1]!;
}
(m5raw as unknown as { length: number }).length = 0;

const m5candles: Candle[] = new Array(M);
for (let i = 0; i < M; i++) {
  m5candles[i] = {
    time: mt[i]!,
    open: mo[i]!,
    high: mh[i]!,
    low: ml[i]!,
    close: mc[i]!,
    volume: 0,
    complete: true,
  };
}

function lb(times: string[], t: string): number {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function pct(a: number, b: number): number {
  return b > 0 ? (a / b) * 100 : NaN;
}
function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2;
}
function widthBin(pips: number): WidthBin {
  if (pips < 10) return "0-10";
  if (pips < 20) return "10-20";
  if (pips < 30) return "20-30";
  if (pips < 50) return "30-50";
  return "50+";
}
function speedBin(mins: number): SpeedBin {
  if (mins <= 30) return "fast";
  if (mins <= 120) return "medium";
  return "slow";
}
function levelAt(support: number, R: number, side: Side, pctOfRange: number): number {
  // pctOfRange measured from original S/R toward opposite (0=origin, 100=opposite)
  return side === "long" ? support + (pctOfRange / 100) * R : support + R - (pctOfRange / 100) * R;
}
function thru(side: Side, close: number, level: number): boolean {
  return side === "long" ? close > level : close < level;
}
function touched(side: Side, i: number, level: number): boolean {
  return side === "long" ? mh[i]! >= level : ml[i]! <= level;
}
function beyond(side: Side, i: number, level: number): boolean {
  // wick beyond level in travel direction
  return side === "long" ? mh[i]! >= level : ml[i]! <= level;
}

// ---- fidelity (V15 identical) ----
const startT = WINDOW;
{
  const enc: Array<{ t0: number; side: "support" | "resistance"; L: number; atr: number }> = [];
  let aR = true,
    aS = true;
  for (let t = startT; t < n; t++) {
    const w = mids.slice(t - WINDOW + 1, t + 1);
    const a = assessMarketCondition({ candles: w, instrument: INSTRUMENT, timeframe: TIMEFRAME });
    const lv = a.levels;
    if (!lv) continue;
    const A = atr14Of(w);
    if (!(A > 0)) continue;
    const nearR = a.location === "NEAR_RESISTANCE",
      nearS = a.location === "NEAR_SUPPORT";
    if (nearR && aR) {
      const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= lv.current);
      if (c.length) {
        enc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - lv.current < p - lv.current ? q : p)), atr: A });
        aR = false;
      }
    } else if (!nearR) aR = true;
    if (nearS && aS) {
      const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= lv.current);
      if (c.length) {
        enc.push({ t0: t, side: "support", L: c.reduce((p, q) => (lv.current - q < lv.current - p ? q : p)), atr: A });
        aS = false;
      }
    } else if (!nearS) aS = true;
  }
  const v = { support: { s: 0, t: 0 }, resistance: { s: 0, t: 0 } };
  for (const e of enc) {
    const w = TOUCH_ATR * e.atr,
      top = e.L + w,
      bot = e.L - w;
    let bb = 0,
      adv = e.side === "resistance" ? -Infinity : Infinity,
      done = false,
      ok = false;
    const end = Math.min(e.t0 + HORIZON_M15, n - 1);
    for (let j = e.t0; j <= end && !done; j++) {
      const c = raw[j]!.mid;
      adv = e.side === "resistance" ? Math.max(adv, c.high) : Math.min(adv, c.low);
      const bcx = e.side === "resistance" ? c.close - e.L : e.L - c.close;
      if (bcx > w) bb++;
      else bb = 0;
      const acc = bb >= ACCEPT_MIN_BARS && bcx / e.atr >= ACCEPT_MIN_DIST_ATR;
      const pen = (e.side === "resistance" ? adv - e.L : e.L - adv) >= MIN_PEN_ATR * e.atr;
      const ins = e.side === "resistance" ? c.close <= top : c.close >= bot;
      if (acc) done = true;
      else if (pen && ins) {
        ok = true;
        done = true;
      }
    }
    v[e.side].t++;
    if (ok) v[e.side].s++;
  }
  const vS = pct(v.support.s, v.support.t),
    vR = pct(v.resistance.s, v.resistance.t);
  if (!(vS >= 78 && vS <= 84 && vR >= 78 && vR <= 84)) {
    console.error(`FIDELITY FAILED ${vS.toFixed(2)}/${vR.toFixed(2)}. STOP.`);
    process.exit(1);
  }
  (globalThis as { __fid?: { vS: number; vR: number } }).__fid = { vS, vR };
}

// ---- setups (V15 identical: freeze outer range at near encounter) ----
const setups: Setup[] = [];
let armedR = true,
  armedS = true;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const nearR = a.location === "NEAR_RESISTANCE",
    nearS = a.location === "NEAR_SUPPORT";
  if (nearS && armedS) {
    if (lv.rangeHigh > lv.rangeLow)
      setups.push({ side: "long", t0: t, support: lv.rangeLow, resistance: lv.rangeHigh, atr15: A });
    armedS = false;
  } else if (!nearS) armedS = true;
  if (nearR && armedR) {
    if (lv.rangeHigh > lv.rangeLow)
      setups.push({ side: "short", t0: t, support: lv.rangeLow, resistance: lv.rangeHigh, atr15: A });
    armedR = false;
  } else if (!nearR) armedR = true;
}

// ---- reclaim events (V15 identical break/reclaim) ----
const reclaims: Reclaim[] = [];
let noBreak = 0,
  noReclaim = 0;
for (const s of setups) {
  const isLong = s.side === "long";
  const endScan = Math.min(s.t0 + HORIZON_M15, n - 1);
  let tBreak = -1;
  for (let j = s.t0; j <= endScan; j++) {
    const c = raw[j]!.mid;
    const pen = isLong ? s.support - c.low : c.high - s.resistance;
    if (pen >= MIN_PEN_ATR * s.atr15) {
      tBreak = j;
      break;
    }
  }
  if (tBreak < 0) {
    noBreak++;
    continue;
  }
  let tReclaim = -1;
  for (let j = tBreak + 1; j <= endScan; j++) {
    const c = raw[j]!.mid;
    if (isLong ? c.close >= s.support : c.close <= s.resistance) {
      tReclaim = j;
      break;
    }
  }
  if (tReclaim < 0) {
    noReclaim++;
    continue;
  }
  const reclaimCloseTime = new Date(new Date(raw[tReclaim]!.time).getTime() + 15 * 60000).toISOString();
  const ri = lb(mt, reclaimCloseTime);
  if (ri < 30 || ri >= M - 2) continue;
  const m5Slice = m5candles.slice(Math.max(0, ri - WINDOW), ri);
  const atr5 = atr14Of(m5Slice);
  if (!(atr5 > 0)) continue;
  const R = s.resistance - s.support;
  const mid = (s.support + s.resistance) / 2;
  const pathEnd = Math.min(ri + PATH_M5, M - 1);
  let midTouchIdx = -1;
  for (let k = ri + 1; k <= pathEnd; k++) {
    if (touched(s.side, k, mid)) {
      midTouchIdx = k;
      break;
    }
  }
  reclaims.push({
    side: s.side,
    support: s.support,
    resistance: s.resistance,
    mid,
    R,
    rangePips: R / PIP,
    reclaimIdx: ri,
    atr5,
    reachedMid: midTouchIdx >= 0,
    midTouchIdx,
  });
}

function buildApproach(r: Reclaim): Approach | null {
  if (r.midTouchIdx < 0) return null;
  const bars = r.midTouchIdx - r.reclaimIdx;
  const mins = bars * 5;
  let consec = 0;
  for (let k = r.midTouchIdx; k > r.reclaimIdx; k--) {
    const toward =
      r.side === "long" ? mc[k]! >= mc[k - 1]! : mc[k]! <= mc[k - 1]!;
    if (toward) consec++;
    else break;
  }
  const move = Math.abs(mc[r.midTouchIdx]! - mc[r.reclaimIdx]!) / r.atr5;
  const i = r.midTouchIdx;
  const body = Math.abs(mc[i]! - mo[i]!);
  const range = Math.max(mh[i]! - ml[i]!, PIP * 0.1);
  const upperWick = mh[i]! - Math.max(mo[i]!, mc[i]!);
  const lowerWick = Math.min(mo[i]!, mc[i]!) - ml[i]!;
  const wick = r.side === "long" ? lowerWick : upperWick; // trailing wick vs travel
  return {
    mins,
    bars,
    speed: speedBin(mins),
    consecToward: consec,
    atrMove: move,
    crossBody: body / PIP,
    crossRange: range / PIP,
    crossBodyRatio: body / range,
    crossWick: wick / PIP,
    crossClosedThru: thru(r.side, mc[i]!, r.mid),
  };
}

/** Retest+hold: (1) close through level, (2) later touch level from far side without losing the half, (3) close through again. Signal = step-3 close bar. */
function findRetestHold(side: Side, level: number, from: number, end: number): number {
  let crossed = false;
  let retested = false;
  for (let k = from; k <= end; k++) {
    if (!crossed) {
      if (thru(side, mc[k]!, level)) crossed = true;
      continue;
    }
    if (!retested) {
      // come back to touch level from the far side
      if (side === "long") {
        if (ml[k]! <= level && mo[k]! >= level - (mh[k]! - ml[k]!)) retested = true;
        else if (ml[k]! <= level && mc[k]! >= level) retested = true;
        else if (ml[k]! <= level) retested = true;
      } else {
        if (mh[k]! >= level) retested = true;
      }
      // invalidate if closed fully back through to origin side before retest completes? allow touch
      continue;
    }
    if (thru(side, mc[k]!, level)) return k;
  }
  return -1;
}

function firstHit(
  side: Side,
  support: number,
  R: number,
  levelPct: number,
  sigIdx: number,
  distPct: number,
): Hit {
  const contLvl = levelAt(support, R, side, levelPct + distPct);
  const failLvl = levelAt(support, R, side, levelPct - distPct);
  const end = Math.min(sigIdx + PATH_M5, M - 1);
  for (let k = sigIdx + 1; k <= end; k++) {
    const hitC = beyond(side, k, contLvl);
    const hitF =
      side === "long" ? ml[k]! <= failLvl : mh[k]! >= failLvl;
    if (hitC && hitF) return "amb";
    if (hitC) return "cont";
    if (hitF) return "fail";
  }
  return "none";
}

function forwardMetrics(
  side: Side,
  support: number,
  R: number,
  levelPct: number,
  sigIdx: number,
): Pick<SignalRow, "reach" | "maxContPct" | "maxAdvPct" | "t75Min" | "t100Min"> {
  const end = Math.min(sigIdx + PATH_M5, M - 1);
  const reach: Record<number, boolean> = {};
  for (const d of DEPTH_PCTS) reach[d] = false;
  let maxCont = 0,
    maxAdv = 0;
  let t75 = NaN,
    t100 = NaN;
  const sigLevel = levelAt(support, R, side, levelPct);
  for (let k = sigIdx + 1; k <= end; k++) {
    const mins = (k - sigIdx) * 5;
    const loc =
      side === "long"
        ? ((Math.max(mh[k]!, mc[k]!) - support) / R) * 100
        : ((support + R - Math.min(ml[k]!, mc[k]!)) / R) * 100;
    const fav = side === "long" ? ((mh[k]! - sigLevel) / R) * 100 : ((sigLevel - ml[k]!) / R) * 100;
    const adv = side === "long" ? ((sigLevel - ml[k]!) / R) * 100 : ((mh[k]! - sigLevel) / R) * 100;
    maxCont = Math.max(maxCont, fav);
    maxAdv = Math.max(maxAdv, adv);
    for (const d of DEPTH_PCTS) {
      if (!reach[d] && loc >= d) {
        reach[d] = true;
        if (d === 75 && !Number.isFinite(t75)) t75 = mins;
        if (d === 100 && !Number.isFinite(t100)) t100 = mins;
      }
    }
  }
  return { reach, maxContPct: maxCont, maxAdvPct: maxAdv, t75Min: t75, t100Min: t100 };
}

function emitSignalsForLevel(
  r: Reclaim,
  levelPct: number,
  touchIdx: number,
  approach: Approach | null,
  out: SignalRow[],
): void {
  const level = levelAt(r.support, r.R, r.side, levelPct);
  const end = Math.min(r.reclaimIdx + PATH_M5, M - 1);
  const atr5 = r.atr5;

  const kinds: Array<{ kind: SignalKind; idx: number }> = [];
  // A touch
  kinds.push({ kind: "touch", idx: touchIdx });
  // B close1
  let close1 = -1;
  for (let k = touchIdx; k <= end; k++) {
    if (thru(r.side, mc[k]!, level)) {
      close1 = k;
      break;
    }
  }
  if (close1 >= 0) kinds.push({ kind: "close1", idx: close1 });
  // B close2
  let close2 = -1;
  if (close1 >= 0) {
    for (let k = close1 + 1; k <= end; k++) {
      if (thru(r.side, mc[k]!, level) && thru(r.side, mc[k - 1]!, level)) {
        close2 = k;
        break;
      }
      if (!thru(r.side, mc[k]!, level)) {
        // streak broken; keep scanning for a fresh 2-close later? require consecutive from first streak
        // restart search after failure
      }
    }
    // cleaner: from close1, require close1 and next bar both through; else find any consecutive pair after touch
    if (close1 + 1 <= end && thru(r.side, mc[close1 + 1]!, level)) close2 = close1 + 1;
    else {
      for (let k = close1 + 1; k < end; k++) {
        if (thru(r.side, mc[k]!, level) && thru(r.side, mc[k + 1]!, level)) {
          close2 = k + 1;
          break;
        }
      }
    }
  }
  if (close2 >= 0) kinds.push({ kind: "close2", idx: close2 });

  // C ATR holds beyond mid
  for (const [kind, mult] of [
    ["atr25", 0.25],
    ["atr50", 0.5],
    ["atr100", 1.0],
  ] as Array<[SignalKind, number]>) {
    const holdLvl =
      r.side === "long" ? level + mult * atr5 : level - mult * atr5;
    let idx = -1;
    for (let k = touchIdx; k <= end; k++) {
      if (beyond(r.side, k, holdLvl)) {
        idx = k;
        break;
      }
    }
    if (idx >= 0) kinds.push({ kind, idx });
  }

  // D retest+hold
  const rh = findRetestHold(r.side, level, touchIdx, end);
  if (rh >= 0) kinds.push({ kind: "retestHold", idx: rh });

  for (const { kind, idx } of kinds) {
    const hits: Record<number, Hit> = {};
    for (const d of HIT_PCTS) hits[d] = firstHit(r.side, r.support, r.R, levelPct, idx, d);
    const fwd = forwardMetrics(r.side, r.support, r.R, levelPct, idx);
    out.push({
      side: r.side,
      kind,
      levelPct,
      sigIdx: idx,
      rangePips: r.rangePips,
      width: widthBin(r.rangePips),
      approach: levelPct === 50 ? approach : null,
      hits,
      reach: fwd.reach,
      maxContPct: fwd.maxContPct,
      maxAdvPct: fwd.maxAdvPct,
      t75Min: fwd.t75Min,
      t100Min: fwd.t100Min,
    });
  }
}

const signals: SignalRow[] = [];
/** Mid-touch failures: reached mid but never close1 */
const midFailBack: Array<{
  side: Side;
  rangePips: number;
  hit40: boolean;
  hit30: boolean;
  hit25: boolean;
  hit0: boolean;
}> = [];

for (const r of reclaims) {
  if (!r.reachedMid) continue;
  const approach = buildApproach(r);
  // 50% primary
  emitSignalsForLevel(r, 50, r.midTouchIdx, approach, signals);

  // Did we ever get close1 at 50%?
  const end = Math.min(r.reclaimIdx + PATH_M5, M - 1);
  let gotClose1 = false;
  for (let k = r.midTouchIdx; k <= end; k++) {
    if (thru(r.side, mc[k]!, r.mid)) {
      gotClose1 = true;
      break;
    }
  }
  if (!gotClose1) {
    let hit40 = false,
      hit30 = false,
      hit25 = false,
      hit0 = false;
    for (let k = r.midTouchIdx + 1; k <= end; k++) {
      const loc =
        r.side === "long"
          ? ((ml[k]! - r.support) / r.R) * 100
          : ((r.support + r.R - mh[k]!) / r.R) * 100;
      // retreat toward origin: lower loc%
      if (loc <= 40) hit40 = true;
      if (loc <= 30) hit30 = true;
      if (loc <= 25) hit25 = true;
      if (loc <= 0 + 0.5) hit0 = true; // back to original S/R
      // also wick to origin
      if (r.side === "long" ? ml[k]! <= r.support : mh[k]! >= r.resistance) hit0 = true;
    }
    midFailBack.push({ side: r.side, rangePips: r.rangePips, hit40, hit30, hit25, hit0 });
  }

  // Controls 40% and 60%: only if that level is reached after reclaim
  for (const lp of [40, 60]) {
    const lvl = levelAt(r.support, r.R, r.side, lp);
    let tIdx = -1;
    for (let k = r.reclaimIdx + 1; k <= end; k++) {
      if (touched(r.side, k, lvl)) {
        tIdx = k;
        break;
      }
    }
    if (tIdx >= 0) emitSignalsForLevel(r, lp, tIdx, null, signals);
  }
}

// ---- reporting ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;
const L: string[] = [];

const midReach = pct(reclaims.filter((r) => r.reachedMid).length, reclaims.length);
L.push("EUR/USD — 15M RANGE MIDPOINT BREAK vs REJECT (V16, research-only)");
L.push(`FIDELITY: support ${f2(fid.vS)}% resistance ${f2(fid.vR)}% -> PASS.`);
L.push(
  `Reclaims: ${reclaims.length} (no-break ${noBreak}, no-reclaim ${noReclaim}). Reach MID: ${f1(midReach)}% (V15 ref ~${V15_MID_REACH_REF}%).`,
);
L.push(
  `Retest+hold rule: close through level → later M5 touches level from far side → subsequent completed M5 close through again. Signal = that second close bar.`,
);
L.push("First-hit: after signal, which hits first — +(X)% of range toward opposite vs -(X)% toward origin. Ambiguous = same M5 bar.");
L.push("");

type Pool = SignalRow[];
function filterPool(
  side: "long" | "short" | "both",
  levelPct: number,
  kind?: SignalKind,
  extra?: (s: SignalRow) => boolean,
): Pool {
  return signals.filter((s) => {
    if (side !== "both" && s.side !== side) return false;
    if (s.levelPct !== levelPct) return false;
    if (kind && s.kind !== kind) return false;
    if (extra && !extra(s)) return false;
    return true;
  });
}

function contRate(pool: Pool, d: number): { n: number; cont: number; fail: number; amb: number; none: number; contPct: number } {
  let cont = 0,
    fail = 0,
    amb = 0,
    none = 0;
  for (const s of pool) {
    const h = s.hits[d]!;
    if (h === "cont") cont++;
    else if (h === "fail") fail++;
    else if (h === "amb") amb++;
    else none++;
  }
  const decided = cont + fail;
  return { n: pool.length, cont, fail, amb, none, contPct: pct(cont, decided) };
}

function summaryTable(side: "long" | "short" | "both", levelPct: number) {
  const label = side === "both" ? "COMBINED" : side.toUpperCase();
  L.push("#".repeat(120));
  L.push(`${label} @ ${levelPct}% level — signal summary (10% first-hit continue% among decided)`);
  L.push("#".repeat(120));
  L.push(
    ["Signal", "N", "Cont10%", "Fail10%", "Amb", "None", "R60%", "R75%", "R100%", "medMaxCont%", "medMaxAdv%", "medt75m"].map((s) => s.padStart(11)).join(""),
  );
  const kinds: SignalKind[] = ["touch", "close1", "close2", "atr25", "atr50", "atr100", "retestHold"];
  for (const kind of kinds) {
    const pool = filterPool(side, levelPct, kind);
    if (!pool.length) {
      L.push(`${kind.padEnd(11)}${String(0).padStart(11)}`);
      continue;
    }
    const h = contRate(pool, 10);
    const r60 = pct(pool.filter((s) => s.reach[60]).length, pool.length);
    const r75 = pct(pool.filter((s) => s.reach[75]).length, pool.length);
    const r100 = pct(pool.filter((s) => s.reach[100]).length, pool.length);
    L.push(
      [
        kind,
        `${h.n}`,
        f1(h.contPct),
        f1(pct(h.fail, h.cont + h.fail)),
        `${h.amb}`,
        `${h.none}`,
        f1(r60),
        f1(r75),
        f1(r100),
        f1(median(pool.map((s) => s.maxContPct))),
        f1(median(pool.map((s) => s.maxAdvPct))),
        f0(median(pool.map((s) => s.t75Min))),
      ]
        .map((x) => x.padStart(11))
        .join(""),
    );
  }
  L.push("");
}

function f0(x: number) {
  return Number.isFinite(x) ? x.toFixed(0) : "-";
}

function firstHitGrid(side: "long" | "short" | "both", levelPct: number) {
  const label = side === "both" ? "COMBINED" : side.toUpperCase();
  L.push(`-- ${label} @ ${levelPct}% — continuation-first % (decided only) / N / amb --`);
  L.push(["Signal", ...HIT_PCTS.map((d) => `${d}%`)].map((s) => s.padStart(14)).join(""));
  const kinds: SignalKind[] = ["touch", "close1", "close2", "atr25", "atr50", "atr100", "retestHold"];
  for (const kind of kinds) {
    const pool = filterPool(side, levelPct, kind);
    const cells = HIT_PCTS.map((d) => {
      const h = contRate(pool, d);
      return `${f1(h.contPct)}|n${h.n}|a${h.amb}`;
    });
    L.push([kind, ...cells].map((s) => s.padStart(14)).join(""));
  }
  L.push("");
}

for (const side of ["long", "short", "both"] as const) {
  summaryTable(side, 50);
  firstHitGrid(side, 50);
}

L.push("=".repeat(120));
L.push("CONTROLS: 40% vs 50% vs 60% (COMBINED, continuation-first at 10%/20%)");
L.push("=".repeat(120));
L.push(["Level", "Signal", "N", "Cont10%", "Cont20%", "R75%", "R100%"].map((s) => s.padStart(12)).join(""));
for (const lp of [40, 50, 60]) {
  for (const kind of ["touch", "close1", "close2", "atr50"] as SignalKind[]) {
    const pool = filterPool("both", lp, kind);
    const h10 = contRate(pool, 10);
    const h20 = contRate(pool, 20);
    L.push(
      [
        `${lp}%`,
        kind,
        `${pool.length}`,
        f1(h10.contPct),
        f1(h20.contPct),
        f1(pct(pool.filter((s) => s.reach[75]).length, pool.length)),
        f1(pct(pool.filter((s) => s.reach[100]).length, pool.length)),
      ]
        .map((x) => x.padStart(12))
        .join(""),
    );
  }
  L.push("");
}

L.push("=".repeat(120));
L.push("MID FAIL (reached MID, never 1 close through) — retreat toward origin");
L.push("=".repeat(120));
for (const side of ["long", "short", "both"] as const) {
  const pool = side === "both" ? midFailBack : midFailBack.filter((x) => x.side === side);
  L.push(
    `${side}: n=${pool.length}  →≤40%: ${f1(pct(pool.filter((x) => x.hit40).length, pool.length))}%  →≤30%: ${f1(pct(pool.filter((x) => x.hit30).length, pool.length))}%  →≤25%: ${f1(pct(pool.filter((x) => x.hit25).length, pool.length))}%  →origin: ${f1(pct(pool.filter((x) => x.hit0).length, pool.length))}%`,
  );
}
L.push("");

L.push("=".repeat(120));
L.push("APPROACH SPEED → close1 @50% continuation-first 10% (COMBINED)");
L.push("=".repeat(120));
for (const sp of ["fast", "medium", "slow"] as SpeedBin[]) {
  const pool = filterPool("both", 50, "close1", (s) => s.approach?.speed === sp);
  const h = contRate(pool, 10);
  L.push(
    `${sp.padEnd(8)} n=${h.n} cont10=${f1(h.contPct)}% fail=${f1(pct(h.fail, h.cont + h.fail))}% amb=${h.amb}  med bars-to-mid=${f1(median(pool.map((s) => s.approach!.bars)))} medATR-move=${f2(median(pool.map((s) => s.approach!.atrMove)))} medBodyRatio=${f2(median(pool.map((s) => s.approach!.crossBodyRatio)))} closeThruOnTouch=${f1(pct(pool.filter((s) => s.approach!.crossClosedThru).length, pool.length))}%`,
  );
}
L.push("");

L.push("=".repeat(120));
L.push("RANGE WIDTH → close1 @50% cont10%/cont20% (COMBINED)");
L.push("=".repeat(120));
for (const w of ["0-10", "10-20", "20-30", "30-50", "50+"] as WidthBin[]) {
  const pool = filterPool("both", 50, "close1", (s) => s.width === w);
  const h10 = contRate(pool, 10);
  const h20 = contRate(pool, 20);
  L.push(
    `${w.padEnd(6)} n=${h10.n} cont10=${f1(h10.contPct)}% cont20=${f1(h20.contPct)}% R100=${f1(pct(pool.filter((s) => s.reach[100]).length, pool.length))}%`,
  );
}
L.push("");

// Candidate scan: >=55% cont at 10%+, both sides stable, n>=200 per side
L.push("=".repeat(120));
L.push("CANDIDATES: cont10%>=55, n_side>=200 both LONG&SHORT, level=50");
L.push("=".repeat(120));
let found = 0;
for (const kind of ["touch", "close1", "close2", "atr25", "atr50", "atr100", "retestHold"] as SignalKind[]) {
  for (const d of HIT_PCTS) {
    const Lpool = filterPool("long", 50, kind);
    const Spool = filterPool("short", 50, kind);
    const lh = contRate(Lpool, d);
    const sh = contRate(Spool, d);
    if (lh.n >= 200 && sh.n >= 200 && lh.contPct >= 55 && sh.contPct >= 55) {
      L.push(
        `  ${kind} @${d}%: LONG cont=${f1(lh.contPct)}% n=${lh.n} amb=${lh.amb} | SHORT cont=${f1(sh.contPct)}% n=${sh.n} amb=${sh.amb}`,
      );
      found++;
    }
  }
}
if (!found) L.push("  (none)");
L.push("");
L.push("No strategy. No entry/TP/SL optimization.");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-midpoint-break-reject-v16-report.txt"), report + "\n");
console.log(report);

// compact events csv for mid-50 signals only
const csv: string[] = [];
csv.push(
  [
    "side",
    "kind",
    "level_pct",
    "range_pips",
    "width",
    "speed",
    "hit5",
    "hit10",
    "hit15",
    "hit20",
    "hit25",
    "r60",
    "r75",
    "r100",
    "max_cont_pct",
    "max_adv_pct",
  ].join(","),
);
for (const s of signals) {
  if (s.levelPct !== 50) continue;
  csv.push(
    [
      s.side,
      s.kind,
      s.levelPct,
      s.rangePips.toFixed(1),
      s.width,
      s.approach?.speed ?? "",
      s.hits[5],
      s.hits[10],
      s.hits[15],
      s.hits[20],
      s.hits[25],
      s.reach[60] ? 1 : 0,
      s.reach[75] ? 1 : 0,
      s.reach[100] ? 1 : 0,
      s.maxContPct.toFixed(1),
      s.maxAdvPct.toFixed(1),
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-midpoint-break-reject-v16-events.csv"), csv.join("\n") + "\n");
console.error(
  `[written] eurusd-midpoint-break-reject-v16-report.txt | events.csv (reclaims=${reclaims.length}, midReach=${midReach.toFixed(1)}%, signals50=${signals.filter((s) => s.levelPct === 50).length})`,
);
