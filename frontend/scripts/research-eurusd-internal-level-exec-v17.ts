/**
 * EUR/USD — 15M RANGE INTERNAL-LEVEL EXECUTION (V17, research-only).
 *
 * V16 is FROZEN. Two SEPARATE families (never combined):
 *   A) CONFIRMED CONTINUATION after MID acceptance
 *   B) FAILED-MID REVERSAL with REAL-TIME failure signals
 *
 * Aggregates on-the-fly (no multi-million trade array). BID/ASK M5 execution.
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
const OUT_DIR = PAD;
const WINDOW = 220;
const HORIZON_M15 = 96;
const PATH_SCAN = 576;
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const HOLD: Record<string, number> = { h6: 72, h12: 144, h24: 288 };
const V16_MID_REF = 75.5;

type PathSide = "long" | "short";
type TradeDir = "long" | "short";
type Family = "A" | "B";
type Speed = "fast" | "medium" | "slow";
type Width = "0-10" | "10-20" | "20-30" | "30-50" | "50+";
type OC = "win" | "loss" | "timeout" | "ambiguous";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

interface Acc {
  n: number;
  wins: number;
  losses: number;
  timeouts: number;
  amb: number;
  sumPnl: number;
  sumW: number;
  sumL: number; // negative sum of losses
  eq: number;
  peak: number;
  dd: number;
}

const raw: RC[] = JSON.parse(fs.readFileSync(path.join(PAD, "eurusd-m15-mba-cache.json"), "utf8"));
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
  fs.readFileSync(path.join(PAD, "eurusd-m5-mba-cache.json"), "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const bh = new Float64Array(M),
  bl = new Float64Array(M),
  ah = new Float64Array(M),
  al = new Float64Array(M),
  bc = new Float64Array(M),
  ac = new Float64Array(M);
const mh = new Float64Array(M),
  ml = new Float64Array(M),
  mc = new Float64Array(M);
const m5candles: Candle[] = new Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
  mh[i] = (r[1] + r[3]) / 2;
  ml[i] = (r[2] + r[4]) / 2;
  mc[i] = (r[5] + r[6]) / 2;
  const open = i === 0 ? mc[i]! : mc[i - 1]!;
  m5candles[i] = { time: mt[i]!, open, high: mh[i]!, low: ml[i]!, close: mc[i]!, volume: 0, complete: true };
}
(m5raw as unknown as { length: number }).length = 0;

function lb(times: string[], t: string): number {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (times[m]! < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function pct(a: number, b: number): number {
  return b > 0 ? (a / b) * 100 : NaN;
}
function widthOf(p: number): Width {
  if (p < 10) return "0-10";
  if (p < 20) return "10-20";
  if (p < 30) return "20-30";
  if (p < 50) return "30-50";
  return "50+";
}
function speedOf(mins: number): Speed {
  if (mins <= 30) return "fast";
  if (mins <= 120) return "medium";
  return "slow";
}
function f1(x: number) {
  return Number.isFinite(x) ? x.toFixed(1) : "-";
}
function f2(x: number) {
  return Number.isFinite(x) ? x.toFixed(2) : "-";
}
function sizeTag(nn: number): string {
  if (nn < 100) return "SMALL";
  if (nn < 300) return "MODERATE";
  return "LARGE";
}
function newAcc(): Acc {
  return { n: 0, wins: 0, losses: 0, timeouts: 0, amb: 0, sumPnl: 0, sumW: 0, sumL: 0, eq: 0, peak: 0, dd: 0 };
}
function add(a: Acc, pnl: number, oc: OC): void {
  if (oc === "ambiguous") {
    a.amb++;
    return;
  }
  a.n++;
  a.sumPnl += pnl;
  if (oc === "timeout") a.timeouts++;
  if (pnl > 0) {
    a.wins++;
    a.sumW += pnl;
  } else if (pnl < 0) {
    a.losses++;
    a.sumL += -pnl;
  }
  a.eq += pnl;
  a.peak = Math.max(a.peak, a.eq);
  a.dd = Math.max(a.dd, a.peak - a.eq);
}
function snap(a: Acc, years: number) {
  const decided = a.wins + a.losses;
  return {
    n: a.n,
    wins: a.wins,
    losses: a.losses,
    timeouts: a.timeouts,
    amb: a.amb,
    wr: pct(a.wins, decided),
    avgW: a.wins ? a.sumW / a.wins : NaN,
    avgL: a.losses ? -a.sumL / a.losses : NaN,
    pf: a.sumL > 0 ? a.sumW / a.sumL : a.sumW > 0 ? Infinity : NaN,
    exp: a.n ? a.sumPnl / a.n : NaN,
    total: a.sumPnl,
    dd: a.dd,
    perYr: a.n / years,
  };
}

const cells = new Map<string, Acc>();
function bump(key: string, pnl: number, oc: OC): void {
  let a = cells.get(key);
  if (!a) {
    a = newAcc();
    cells.set(key, a);
  }
  add(a, pnl, oc);
}
/** Emit one trade into the relevant aggregation keys (chronological because reclaims scanned in order). */
function emit(
  family: Family,
  signal: string,
  dir: TradeDir,
  width: Width,
  speed: Speed,
  target: string,
  stop: string,
  hold: string,
  year: number,
  pnl: number,
  oc: OC,
): void {
  const period = year <= 2019 ? "p1" : "p2";
  const base = `${family}|${signal}|${target}|${stop}|${hold}`;
  // core both/long/short
  bump(`${base}|both|ALL|ALL|ALL|ALL`, pnl, oc);
  bump(`${base}|${dir}|ALL|ALL|ALL|ALL`, pnl, oc);
  // period
  bump(`${base}|both|ALL|ALL|${period}|ALL`, pnl, oc);
  bump(`${base}|${dir}|ALL|ALL|${period}|ALL`, pnl, oc);
  // year
  bump(`${base}|both|ALL|ALL|ALL|${year}`, pnl, oc);
  // speed / width (both only)
  bump(`${base}|both|${width}|ALL|ALL|ALL`, pnl, oc);
  bump(`${base}|both|ALL|${speed}|ALL|ALL`, pnl, oc);
}

function simulate(
  dir: TradeDir,
  ei: number,
  entry: number,
  tp: number,
  sl: number,
  holdBars: number,
): { pnl: number; oc: OC } {
  const end = Math.min(ei + holdBars, M - 1);
  for (let k = ei + 1; k <= end; k++) {
    const tpHit = dir === "long" ? bh[k]! >= tp : al[k]! <= tp;
    const slHit = dir === "long" ? bl[k]! <= sl : ah[k]! >= sl;
    if (tpHit && slHit) return { pnl: 0, oc: "ambiguous" };
    if (tpHit) return { pnl: (dir === "long" ? tp - entry : entry - tp) / PIP, oc: "win" };
    if (slHit) return { pnl: (dir === "long" ? sl - entry : entry - sl) / PIP, oc: "loss" };
  }
  const exit = dir === "long" ? bc[end]! : ac[end]!;
  return { pnl: (dir === "long" ? exit - entry : entry - exit) / PIP, oc: "timeout" };
}

// ---- fidelity ----
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

process.stderr.write("scanning setups/reclaims...\n");
type Setup = { side: PathSide; t0: number; support: number; resistance: number; atr15: number };
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

let allReclaims = 0,
  midReached = 0,
  tradeCount = 0;
const yearsSpan =
  (new Date(raw[n - 1]!.time).getTime() - new Date(raw[startT]!.time).getTime()) / (365.25 * 864e5);

function priceAtPct(path: PathSide, support: number, resistance: number, R: number, p: number): number {
  return path === "long" ? support + (p / 100) * R : resistance - (p / 100) * R;
}
function locPct(path: PathSide, support: number, resistance: number, R: number, price: number): number {
  return path === "long" ? ((price - support) / R) * 100 : ((resistance - price) / R) * 100;
}

process.stderr.write(`setups=${setups.length}, simulating...\n`);
for (const s of setups) {
  const isLongPath = s.side === "long";
  const endScan = Math.min(s.t0 + HORIZON_M15, n - 1);
  let tBreak = -1;
  for (let j = s.t0; j <= endScan; j++) {
    const c = raw[j]!.mid;
    const pen = isLongPath ? s.support - c.low : c.high - s.resistance;
    if (pen >= MIN_PEN_ATR * s.atr15) {
      tBreak = j;
      break;
    }
  }
  if (tBreak < 0) continue;
  let tReclaim = -1;
  for (let j = tBreak + 1; j <= endScan; j++) {
    const c = raw[j]!.mid;
    if (isLongPath ? c.close >= s.support : c.close <= s.resistance) {
      tReclaim = j;
      break;
    }
  }
  if (tReclaim < 0) continue;
  allReclaims++;
  const reclaimCloseTime = new Date(new Date(raw[tReclaim]!.time).getTime() + 15 * 60000).toISOString();
  const ri = lb(mt, reclaimCloseTime);
  if (ri < 30 || ri >= M - 2) continue;
  const atr5 = atr14Of(m5candles.slice(Math.max(0, ri - WINDOW), ri));
  if (!(atr5 > 0)) continue;
  const R = s.resistance - s.support;
  const mid = (s.support + s.resistance) / 2;
  const pathEnd = Math.min(ri + PATH_SCAN, M - 1);
  let midTouchIdx = -1;
  for (let k = ri + 1; k <= pathEnd; k++) {
    if (isLongPath ? mh[k]! >= mid : ml[k]! <= mid) {
      midTouchIdx = k;
      break;
    }
  }
  if (midTouchIdx < 0) continue;
  midReached++;
  const speed = speedOf((midTouchIdx - ri) * 5);
  const rangePips = R / PIP;
  const width = widthOf(rangePips);
  const year = new Date(mt[midTouchIdx]!).getUTCFullYear();

  // ---- Family A signals ----
  const aSigs: Array<{ name: string; idx: number }> = [{ name: "touch", idx: midTouchIdx }];
  let c1 = -1;
  for (let k = midTouchIdx; k <= pathEnd; k++) {
    if (isLongPath ? mc[k]! > mid : mc[k]! < mid) {
      c1 = k;
      break;
    }
  }
  if (c1 >= 0) aSigs.push({ name: "close1", idx: c1 });
  let c2 = -1;
  if (c1 >= 0) {
    if (c1 + 1 <= pathEnd && (isLongPath ? mc[c1 + 1]! > mid : mc[c1 + 1]! < mid)) c2 = c1 + 1;
    else {
      for (let k = c1 + 1; k < pathEnd; k++) {
        if (
          (isLongPath ? mc[k]! > mid : mc[k]! < mid) &&
          (isLongPath ? mc[k + 1]! > mid : mc[k + 1]! < mid)
        ) {
          c2 = k + 1;
          break;
        }
      }
    }
  }
  if (c2 >= 0) aSigs.push({ name: "close2", idx: c2 });
  const atrLvl = isLongPath ? mid + atr5 : mid - atr5;
  let a1 = -1;
  for (let k = midTouchIdx; k <= pathEnd; k++) {
    if (isLongPath ? mh[k]! >= atrLvl : ml[k]! <= atrLvl) {
      a1 = k;
      break;
    }
  }
  if (a1 >= 0) aSigs.push({ name: "atr100", idx: a1 });

  const dirA: TradeDir = s.side;
  for (const sig of aSigs) {
    const entry = dirA === "long" ? ac[sig.idx]! : bc[sig.idx]!;
    const entryP = locPct(s.side, s.support, s.resistance, R, entry);
    const halfRemPct = entryP + (100 - entryP) * 0.5;
    const targets: Array<[string, number]> = [
      ["70%", priceAtPct(s.side, s.support, s.resistance, R, 70)],
      ["75%", priceAtPct(s.side, s.support, s.resistance, R, 75)],
      ["100%", priceAtPct(s.side, s.support, s.resistance, R, 100)],
      ["halfRem", priceAtPct(s.side, s.support, s.resistance, R, halfRemPct)],
    ];
    const stops: Array<[string, number]> = [
      ["mid", mid],
      ["back10", priceAtPct(s.side, s.support, s.resistance, R, 40)],
      ["back20", priceAtPct(s.side, s.support, s.resistance, R, 30)],
      ["origin", s.side === "long" ? s.support : s.resistance],
      ["atr0.5", dirA === "long" ? entry - 0.5 * atr5 : entry + 0.5 * atr5],
      ["atr1.0", dirA === "long" ? entry - atr5 : entry + atr5],
      ["atr1.5", dirA === "long" ? entry - 1.5 * atr5 : entry + 1.5 * atr5],
      ["atr2.0", dirA === "long" ? entry - 2 * atr5 : entry + 2 * atr5],
    ];
    for (const [tName, tp] of targets) {
      if (dirA === "long" ? !(tp > entry) : !(tp < entry)) continue;
      for (const [sName, sl] of stops) {
        if (dirA === "long" ? !(sl < entry) : !(sl > entry)) continue;
        for (const [hName, hBars] of Object.entries(HOLD)) {
          const { pnl, oc } = simulate(dirA, sig.idx, entry, tp, sl, hBars);
          emit("A", sig.name, dirA, width, speed, tName, sName, hName, year, pnl, oc);
          tradeCount++;
        }
      }
    }
  }

  // ---- Family B real-time fails ----
  const bSigs: Array<{ name: string; idx: number }> = [];
  for (let k = midTouchIdx + 1; k <= pathEnd; k++) {
    if (isLongPath ? mc[k]! < mid : mc[k]! > mid) {
      bSigs.push({ name: "failA", idx: k });
      break;
    }
  }
  for (let k = midTouchIdx + 1; k < pathEnd; k++) {
    if (
      (isLongPath ? mc[k]! < mid : mc[k]! > mid) &&
      (isLongPath ? mc[k + 1]! < mid : mc[k + 1]! > mid)
    ) {
      bSigs.push({ name: "failB", idx: k + 1 });
      break;
    }
  }
  for (const [name, mult] of [
    ["failC", 0.5],
    ["failD", 1.0],
  ] as Array<[string, number]>) {
    const lvl = isLongPath ? mid - mult * atr5 : mid + mult * atr5;
    for (let k = midTouchIdx + 1; k <= pathEnd; k++) {
      if (isLongPath ? ml[k]! <= lvl : mh[k]! >= lvl) {
        bSigs.push({ name, idx: k });
        break;
      }
    }
  }

  const dirB: TradeDir = s.side === "long" ? "short" : "long";
  for (const sig of bSigs) {
    const entry = dirB === "long" ? ac[sig.idx]! : bc[sig.idx]!;
    const origin = s.side === "long" ? s.support : s.resistance;
    const rem = Math.abs(entry - origin);
    const targets: Array<[string, number]> = [
      ["25%", priceAtPct(s.side, s.support, s.resistance, R, 25)],
      ["10%", priceAtPct(s.side, s.support, s.resistance, R, 10)],
      ["0%", origin],
      ["halfRem", dirB === "long" ? entry + 0.5 * rem : entry - 0.5 * rem],
    ];
    const stops: Array<[string, number]> = [
      ["beyond10", priceAtPct(s.side, s.support, s.resistance, R, 60)],
      ["beyond20", priceAtPct(s.side, s.support, s.resistance, R, 70)],
      ["atr0.5", dirB === "long" ? entry - 0.5 * atr5 : entry + 0.5 * atr5],
      ["atr1.0", dirB === "long" ? entry - atr5 : entry + atr5],
      ["atr1.5", dirB === "long" ? entry - 1.5 * atr5 : entry + 1.5 * atr5],
      ["atr2.0", dirB === "long" ? entry - 2 * atr5 : entry + 2 * atr5],
    ];
    for (const [tName, tp] of targets) {
      if (dirB === "long" ? !(tp > entry) : !(tp < entry)) continue;
      for (const [sName, sl] of stops) {
        if (dirB === "long" ? !(sl < entry) : !(sl > entry)) continue;
        for (const [hName, hBars] of Object.entries(HOLD)) {
          const { pnl, oc } = simulate(dirB, sig.idx, entry, tp, sl, hBars);
          emit("B", sig.name, dirB, width, speed, tName, sName, hName, year, pnl, oc);
          tradeCount++;
        }
      }
    }
  }
}

process.stderr.write(`done. midReach=${midReached}/${allReclaims} cells=${cells.size} tradeEmissions=${tradeCount}\n`);

// ---- report ----
const L: string[] = [];
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;
const midReachPct = pct(midReached, allReclaims);
L.push("EUR/USD — 15M RANGE INTERNAL-LEVEL EXECUTION (V17, research-only)");
L.push(
  `FIDELITY PASS ${f2(fid.vS)}/${f2(fid.vR)}. Mid-reach ${f1(midReachPct)}% (V16 ref ${V16_MID_REF}%). Reclaims ${allReclaims}, mid-reached ${midReached}.`,
);
L.push(`Aggregation keys: ${cells.size}. Trade emissions: ${tradeCount}. Families A/B never combined.`);
L.push("");

function get(...parts: string[]) {
  const key = parts.join("|");
  const a = cells.get(key);
  return a ? snap(a, yearsSpan) : null;
}
function row(label: string, st: ReturnType<typeof snap>): string {
  return [
    label.padEnd(58),
    String(st.n).padStart(6),
    sizeTag(st.n).padStart(9),
    f1(st.wr).padStart(7),
    f2(st.avgW).padStart(8),
    f2(st.avgL).padStart(8),
    f2(st.pf).padStart(7),
    f2(st.exp).padStart(8),
    f1(st.total).padStart(9),
    f1(st.dd).padStart(8),
    String(st.amb).padStart(5),
    f1(st.perYr).padStart(7),
  ].join("");
}
const HDR = [
  "Cell".padEnd(58),
  "N".padStart(6),
  "Size".padStart(9),
  "WR%".padStart(7),
  "AvgW".padStart(8),
  "AvgL".padStart(8),
  "PF".padStart(7),
  "Exp".padStart(8),
  "Total".padStart(9),
  "MaxDD".padStart(8),
  "Amb".padStart(5),
  "/yr".padStart(7),
].join("");

function section(title: string, keys: Array<[string, string[]]>) {
  L.push("#".repeat(130));
  L.push(title);
  L.push("#".repeat(130));
  L.push(HDR);
  for (const [label, parts] of keys) {
    const st = get(...parts);
    if (st) L.push(row(label, st));
  }
  L.push("");
}

// Family A confirmation control
section(
  "FAMILY A — CONFIRMATION CONTROL (both, 75%, back10, h12)",
  (["touch", "close1", "close2", "atr100"] as const).map((sig) => [
    `A|${sig}|75%|back10|h12`,
    ["A", sig, "75%", "back10", "h12", "both", "ALL", "ALL", "ALL", "ALL"],
  ]),
);

{
  L.push("#".repeat(130));
  L.push("FAMILY A — close2 target × stop (both, h12)");
  L.push("#".repeat(130));
  L.push(HDR);
  for (const tgt of ["70%", "75%", "100%", "halfRem"]) {
    for (const stop of ["mid", "back10", "back20", "origin", "atr0.5", "atr1.0", "atr1.5", "atr2.0"]) {
      const st = get("A", "close2", tgt, stop, "h12", "both", "ALL", "ALL", "ALL", "ALL");
      if (st) L.push(row(`A|close2|${tgt}|${stop}|h12`, st));
    }
    L.push("");
  }
}

section(
  "FAMILY A — close2 / atr100 holds (75%, back10, both)",
  (["close2", "atr100"] as const).flatMap((sig) =>
    (["h6", "h12", "h24"] as const).map(
      (h) =>
        [`A|${sig}|75%|back10|${h}`, ["A", sig, "75%", "back10", h, "both", "ALL", "ALL", "ALL", "ALL"]] as [
          string,
          string[],
        ],
    ),
  ),
);

section(
  "FAMILY A — SPEED (close2, 75%, back10, h12)",
  (["fast", "medium", "slow"] as const).map((sp) => [
    `A|close2|${sp}`,
    ["A", "close2", "75%", "back10", "h12", "both", "ALL", sp, "ALL", "ALL"],
  ]),
);

section(
  "FAMILY A — WIDTH (close2, 75%, back10, h12)",
  (["10-20", "20-30", "30-50", "50+"] as const).map((w) => [
    `A|close2|${w}`,
    ["A", "close2", "75%", "back10", "h12", "both", w, "ALL", "ALL", "ALL"],
  ]),
);

section(
  "FAMILY B — FAIL SIGNALS (0% origin, beyond10, h12, both)",
  (["failA", "failB", "failC", "failD"] as const).map((sig) => [
    `B|${sig}|0%|beyond10|h12`,
    ["B", sig, "0%", "beyond10", "h12", "both", "ALL", "ALL", "ALL", "ALL"],
  ]),
);

{
  L.push("#".repeat(130));
  L.push("FAMILY B — failB targets × stops (both, h12)");
  L.push("#".repeat(130));
  L.push(HDR);
  for (const tgt of ["25%", "10%", "0%", "halfRem"]) {
    for (const stop of ["beyond10", "beyond20", "atr0.5", "atr1.0", "atr1.5", "atr2.0"]) {
      const st = get("B", "failB", tgt, stop, "h12", "both", "ALL", "ALL", "ALL", "ALL");
      if (st) L.push(row(`B|failB|${tgt}|${stop}|h12`, st));
    }
    L.push("");
  }
}

// Positive cells scan
L.push("=".repeat(130));
L.push("POSITIVE CELLS (PF>1, exp>0, n>=200, both, ALL cohorts) ranked by Exp");
L.push("=".repeat(130));
L.push(HDR);
const positives: Array<{ label: string; st: ReturnType<typeof snap> }> = [];
for (const [key, acc] of cells) {
  const parts = key.split("|");
  // A|sig|tgt|stop|hold|dir|width|speed|period|year
  if (parts.length !== 10) continue;
  const [fam, sig, tgt, stop, hold, dir, width, speed, period, year] = parts;
  if (dir !== "both" || width !== "ALL" || speed !== "ALL" || period !== "ALL" || year !== "ALL") continue;
  const st = snap(acc, yearsSpan);
  if (st.n >= 200 && st.exp > 0 && st.pf > 1) positives.push({ label: `${fam}|${sig}|${tgt}|${stop}|${hold}`, st });
}
positives.sort((a, b) => b.st.exp - a.st.exp);
for (const p of positives.slice(0, 40)) L.push(row(p.label, p.st));
if (!positives.length) L.push("  (none)");
L.push("");

// Robustness blocks
L.push("=".repeat(130));
L.push("ROBUSTNESS — period + side + year for key candidates");
L.push("=".repeat(130));
const candidates: Array<[Family, string, string, string, string]> = [
  ["A", "close2", "75%", "back10", "h12"],
  ["A", "close2", "halfRem", "back10", "h12"],
  ["A", "close2", "75%", "atr1.0", "h12"],
  ["A", "close2", "100%", "back10", "h12"],
  ["A", "atr100", "75%", "back10", "h12"],
  ["A", "close1", "75%", "back10", "h12"],
  ["A", "touch", "75%", "back10", "h12"],
  ["B", "failB", "0%", "beyond10", "h12"],
  ["B", "failB", "25%", "beyond10", "h12"],
  ["B", "failC", "0%", "beyond10", "h12"],
  ["B", "failA", "0%", "beyond10", "h12"],
];
for (const [fam, sig, tgt, stop, hold] of candidates) {
  L.push(`-- ${fam}|${sig}|${tgt}|${stop}|${hold} --`);
  L.push(HDR);
  for (const period of ["ALL", "p1", "p2"]) {
    for (const dir of ["both", "long", "short"]) {
      const st = get(fam, sig, tgt, stop, hold, dir, "ALL", "ALL", period, "ALL");
      if (st) L.push(row(`${period}|${dir}`, st));
    }
  }
  L.push("  years:");
  for (let y = 2013; y <= 2026; y++) {
    const st = get(fam, sig, tgt, stop, hold, "both", "ALL", "ALL", "ALL", String(y));
    if (st && st.n > 0) L.push(row(`  ${y}`, st));
  }
  L.push("");
}

L.push("No final strategy. Period splits are robustness checks, not untouched OOS.");
const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-internal-level-exec-v17-report.txt"), report + "\n");
console.log(report);

const csv: string[] = [];
csv.push(["key", "n", "size", "wr", "avgW", "avgL", "pf", "exp", "total", "dd", "amb", "perYr"].join(","));
for (const [key, acc] of [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const st = snap(acc, yearsSpan);
  csv.push(
    [key, st.n, sizeTag(st.n), f1(st.wr), f2(st.avgW), f2(st.avgL), f2(st.pf), f2(st.exp), f1(st.total), f1(st.dd), st.amb, f1(st.perYr)].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-internal-level-exec-v17-cells.csv"), csv.join("\n") + "\n");
console.error(`[written] v17 report + cells (${cells.size})`);
