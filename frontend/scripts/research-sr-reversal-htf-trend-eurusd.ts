/**
 * EUR/USD 15M — RANGE->SWING + H4/D1 HTF TREND + %-OF-RANGE TARGETS (V12, research-only).
 *
 * From frozen V11: same setup/execution/targets. ONLY change = trend source.
 * Do NOT use V11's M15 trend. Trend is determined independently on H4 and on D1,
 * using ONLY the most recently COMPLETED higher-TF candle at the M15 entry timestamp
 * (never the currently forming HTF candle).
 *
 * FROZEN from V11 (=V1-V10): M15 S/R detection, range->swing cohort, no-swing-between
 * (gap>20p), 20p entry, 40p SL, OANDA BID/ASK, M5 trade-path, no-lookahead, frozen S/R.
 *
 * TREND (H4 and D1 separately, frozen rules, no optimization):
 *   BULLISH: EMA20>EMA50 & EMA20 slope(3)>0 & HH/HL structure(20)
 *   BEARISH: EMA20<EMA50 & EMA20 slope(3)<0 & LH/LL structure(20)
 *   NEUTRAL: else
 *
 * Targets: 50/60/70% of frozen range; SL 40p. Also agreement groups and raw reachability.
 * Hypothesis test only — NOT a final strategy.
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
const M15C = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5C = path.join(PAD, "eurusd-m5-mba-cache.json");
const H4C = path.join(PAD, "eurusd-h4-mid-cache.json");
const D1C = path.join(PAD, "eurusd-d-mid-cache.json");
const OUT_DIR = PAD;
const WINDOW = 220;
const HORIZON = 96;
const PIP = pipSizeFor(INSTRUMENT);
const H5 = HORIZON * 3;
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;
const D = 20;
const SL_PIPS = 40;
const PCTS = [50, 60, 70];

type Side = "support" | "resistance";
type Kind = "range" | "swing";
type Trend = "bullish" | "bearish" | "neutral";
type Agree =
  | "both_bullish"
  | "both_bearish"
  | "disagree"
  | "any_neutral";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type MidBar = { time: string; open: number; high: number; low: number; close: number };

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

function emaOn(closes: Float64Array, period: number): Float64Array {
  const k = 2 / (period + 1);
  const out = new Float64Array(closes.length);
  out[0] = closes[0]!;
  for (let i = 1; i < closes.length; i++) out[i] = closes[i]! * k + out[i - 1]! * (1 - k);
  return out;
}

function trendAtSeries(
  highs: Float64Array,
  lows: Float64Array,
  ema20: Float64Array,
  ema50: Float64Array,
  i: number,
): Trend {
  if (i < 25) return "neutral";
  const slope = ema20[i]! - ema20[i - 3]!;
  let hiR = -Infinity,
    hiO = -Infinity,
    loR = Infinity,
    loO = Infinity;
  for (let j = i - 9; j <= i; j++) {
    hiR = Math.max(hiR, highs[j]!);
    loR = Math.min(loR, lows[j]!);
  }
  for (let j = i - 19; j <= i - 10; j++) {
    hiO = Math.max(hiO, highs[j]!);
    loO = Math.min(loO, lows[j]!);
  }
  const hhhl = hiR > hiO && loR > loO;
  const lhll = hiR < hiO && loR < loO;
  if (ema20[i]! > ema50[i]! && slope > 0 && hhhl) return "bullish";
  if (ema20[i]! < ema50[i]! && slope < 0 && lhll) return "bearish";
  return "neutral";
}

interface HtfSeries {
  label: "H4" | "D1";
  times: string[];
  trend: Trend[];
}

function loadHtf(label: "H4" | "D1", file: string): HtfSeries {
  const bars: MidBar[] = JSON.parse(fs.readFileSync(file, "utf8"));
  const m = bars.length;
  const times = bars.map((b) => b.time);
  const closes = new Float64Array(m);
  const highs = new Float64Array(m);
  const lows = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    closes[i] = bars[i]!.close;
    highs[i] = bars[i]!.high;
    lows[i] = bars[i]!.low;
  }
  const e20 = emaOn(closes, 20);
  const e50 = emaOn(closes, 50);
  const trend: Trend[] = new Array(m);
  for (let i = 0; i < m; i++) trend[i] = trendAtSeries(highs, lows, e20, e50, i);
  return { label, times, trend };
}

/** Index of most recently COMPLETED HTF bar at entry time T (never the forming bar). */
function lastCompletedIdx(times: string[], T: string): number {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < T) lo = mid + 1;
    else hi = mid;
  }
  // lo = first index with time >= T
  // Completed iff next bar has opened by T: times[i+1] <= T
  if (lo < times.length && times[lo] === T) return lo - 1;
  return lo - 2;
}

function trendAtEntry(series: HtfSeries, entryTime: string): Trend {
  const i = lastCompletedIdx(series.times, entryTime);
  if (i < 0) return "neutral";
  return series.trend[i]!;
}

function agreeOf(h4: Trend, d1: Trend): Agree {
  if (h4 === "neutral" || d1 === "neutral") return "any_neutral";
  if (h4 === "bullish" && d1 === "bullish") return "both_bullish";
  if (h4 === "bearish" && d1 === "bearish") return "both_bearish";
  return "disagree";
}

const h4s = loadHtf("H4", H4C);
const d1s = loadHtf("D1", D1C);

// M5
const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M5C, "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const bh = new Float64Array(M),
  bl = new Float64Array(M),
  ah = new Float64Array(M),
  al = new Float64Array(M),
  bc = new Float64Array(M),
  ac = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
}
(m5raw as unknown as { length: number }).length = 0;
function lb(t: string) {
  let lo = 0,
    hi = M;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (mt[m]! < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

interface Brk {
  t0: number;
  side: Side;
  atr: number;
  L1: number;
  L2: number;
  rangeHi: number;
  rangeLo: number;
  k1: Kind;
  k2: Kind;
}
const breaks: Brk[] = [];
let armedR = true,
  armedS = true;
const startT = WINDOW;
for (let t = startT; t < n; t++) {
  const window = mids.slice(t - WINDOW + 1, t + 1);
  const a = assessMarketCondition({ candles: window, instrument: INSTRUMENT, timeframe: TIMEFRAME });
  const lv = a.levels;
  if (!lv) continue;
  const loc = a.location;
  const cur = lv.current;
  const A = atr14Of(window);
  if (!(A > 0)) continue;
  const nearR = loc === "NEAR_RESISTANCE",
    nearS = loc === "NEAR_SUPPORT";
  if (nearR && armedR) {
    const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
    if (c.length) {
      const L1 = c.reduce((p, q) => (q - cur < p - cur ? q : p));
      const k1: Kind = L1 === lv.rangeHigh ? "range" : "swing";
      const o = k1 === "range" ? lv.swingHigh : lv.rangeHigh;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      if (o !== null && o > L1)
        breaks.push({ t0: t, side: "resistance", atr: A, L1, L2: o, rangeHi: lv.rangeHigh!, rangeLo: lv.rangeLow!, k1, k2 });
      armedR = false;
    }
  } else if (!nearR) armedR = true;
  if (nearS && armedS) {
    const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
    if (c.length) {
      const L1 = c.reduce((p, q) => (cur - q < cur - p ? q : p));
      const k1: Kind = L1 === lv.rangeLow ? "range" : "swing";
      const o = k1 === "range" ? lv.swingLow : lv.rangeLow;
      const k2: Kind = k1 === "range" ? "swing" : "range";
      if (o !== null && o < L1)
        breaks.push({ t0: t, side: "support", atr: A, L1, L2: o, rangeHi: lv.rangeHigh!, rangeLo: lv.rangeLow!, k1, k2 });
      armedS = false;
    }
  } else if (!nearS) armedS = true;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
{
  const enc: Array<{ t0: number; side: Side; L: number; atr: number }> = [];
  let aR = true,
    aS = true;
  for (let t = startT; t < n; t++) {
    const w = mids.slice(t - WINDOW + 1, t + 1);
    const a = assessMarketCondition({ candles: w, instrument: INSTRUMENT, timeframe: TIMEFRAME });
    const lv = a.levels;
    if (!lv) continue;
    const loc = a.location;
    const cur = lv.current;
    const A = atr14Of(w);
    if (!(A > 0)) continue;
    const nR = loc === "NEAR_RESISTANCE",
      nS = loc === "NEAR_SUPPORT";
    if (nR && aR) {
      const c = [lv.rangeHigh, lv.swingHigh].filter((x): x is number => x !== null && x >= cur);
      if (c.length) {
        enc.push({ t0: t, side: "resistance", L: c.reduce((p, q) => (q - cur < p - cur ? q : p)), atr: A });
        aR = false;
      }
    } else if (!nR) aR = true;
    if (nS && aS) {
      const c = [lv.rangeLow, lv.swingLow].filter((x): x is number => x !== null && x <= cur);
      if (c.length) {
        enc.push({ t0: t, side: "support", L: c.reduce((p, q) => (cur - q < cur - p ? q : p)), atr: A });
        aS = false;
      }
    } else if (!nS) aS = true;
  }
  const v: Record<Side, { s: number; t: number }> = {
    support: { s: 0, t: 0 },
    resistance: { s: 0, t: 0 },
  };
  for (const e of enc) {
    const w = TOUCH_ATR * e.atr,
      top = e.L + w,
      bot = e.L - w;
    let bb = 0,
      adv = e.side === "resistance" ? -Infinity : Infinity,
      done = false,
      ok = false;
    const end = Math.min(e.t0 + HORIZON, n - 1);
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
const rsBreaks = breaks.filter((b) => b.k1 === "range" && b.k2 === "swing");

// ---- simulate ----
type OC = "win" | "loss" | "timeout" | "ambiguous";
interface Trade {
  side: Side;
  h4: Trend;
  d1: Trend;
  agree: Agree;
  pctT: number;
  entryTime: string;
  pnl: number;
  oc: OC;
  rangePips: number;
}
interface Reach {
  side: Side;
  h4: Trend;
  d1: Trend;
  agree: Agree;
  r0: boolean;
  r25: boolean;
  r50: boolean;
  r60: boolean;
  r70: boolean;
  r100: boolean;
}
const trades: Trade[] = [];
const reaches: Reach[] = [];
let noBreakout = 0,
  noEntry = 0,
  swingBetween = 0;

for (const b of rsBreaks) {
  const isR = b.side === "resistance";
  const gapP = Math.abs(b.L2 - b.L1) / PIP;
  let tB = -1;
  const sEnd = Math.min(b.t0 + HORIZON, n - 1);
  for (let j = b.t0; j <= sEnd; j++) {
    const c = raw[j]!.mid;
    const pen = isR ? c.high - b.L1 : b.L1 - c.low;
    if (pen >= MIN_PEN_ATR * b.atr) {
      tB = j;
      break;
    }
  }
  if (tB < 0) {
    noBreakout++;
    continue;
  }
  if (gapP <= D) {
    swingBetween++;
    continue;
  }
  const entryLevel = isR ? b.L1 + D * PIP : b.L1 - D * PIP;
  const m5start = lb(new Date(new Date(raw[tB]!.time).getTime() + 15 * 60000).toISOString());
  if (m5start >= M) continue;
  let ei = -1;
  const eEnd = Math.min(m5start + H5, M - 1);
  for (let k = m5start; k <= eEnd; k++) {
    if (isR ? bh[k]! >= entryLevel : al[k]! <= entryLevel) {
      ei = k;
      break;
    }
  }
  if (ei < 0) {
    noEntry++;
    continue;
  }
  const entryTime = mt[ei]!;
  const h4 = trendAtEntry(h4s, entryTime);
  const d1 = trendAtEntry(d1s, entryTime);
  const agree = agreeOf(h4, d1);
  const R = b.rangeHi - b.rangeLo;
  const rangePips = R / PIP;
  const rEnd = Math.min(ei + H5, M - 1);
  const lvlAt = (p: number) => (isR ? b.rangeHi - p * R : b.rangeLo + p * R);
  const reached = (target: number) => {
    for (let k = ei + 1; k <= rEnd; k++) {
      if (isR ? al[k]! <= target : bh[k]! >= target) return true;
    }
    return false;
  };
  reaches.push({
    side: b.side,
    h4,
    d1,
    agree,
    r0: reached(lvlAt(0)),
    r25: reached(lvlAt(0.25)),
    r50: reached(lvlAt(0.5)),
    r60: reached(lvlAt(0.6)),
    r70: reached(lvlAt(0.7)),
    r100: reached(lvlAt(1.0)),
  });
  const slLevel = isR ? entryLevel + SL_PIPS * PIP : entryLevel - SL_PIPS * PIP;
  for (const P of PCTS) {
    const tp = isR ? b.rangeHi - (P / 100) * R : b.rangeLo + (P / 100) * R;
    let oc: OC = "timeout",
      pnl = 0;
    for (let k = ei + 1; k <= rEnd; k++) {
      const tpTouch = isR ? al[k]! <= tp : bh[k]! >= tp;
      const slTouch = isR ? ah[k]! >= slLevel : bl[k]! <= slLevel;
      if (tpTouch && slTouch) {
        oc = "ambiguous";
        break;
      }
      if (tpTouch) {
        oc = "win";
        pnl = (isR ? entryLevel - tp : tp - entryLevel) / PIP;
        break;
      }
      if (slTouch) {
        oc = "loss";
        pnl = -SL_PIPS;
        break;
      }
    }
    if (oc === "timeout") {
      const last = rEnd;
      pnl = (isR ? entryLevel - ac[last]! : bc[last]! - entryLevel) / PIP;
    }
    trades.push({ side: b.side, h4, d1, agree, pctT: P, entryTime, pnl, oc, rangePips });
  }
}

// ---- stats ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const years =
  (new Date(raw[n - 1]!.time).getTime() - new Date(raw[startT]!.time).getTime()) / (365.25 * 864e5);
function stats(list: Trade[]) {
  const res = list.filter((t) => t.oc !== "ambiguous");
  const wins = res.filter((t) => t.pnl > 0),
    losses = res.filter((t) => t.pnl < 0);
  const gW = wins.reduce((s, t) => s + t.pnl, 0),
    gL = -losses.reduce((s, t) => s + t.pnl, 0);
  const total = res.reduce((s, t) => s + t.pnl, 0);
  const seq = [...res].sort((a, b) => (a.entryTime < b.entryTime ? -1 : 1));
  let eq = 0,
    pk = 0,
    dd = 0;
  for (const t of seq) {
    eq += t.pnl;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, pk - eq);
  }
  return {
    n: res.length,
    wins: wins.length,
    losses: losses.length,
    amb: list.length - res.length,
    wr: pct(wins.length, wins.length + losses.length),
    avgW: mean(wins.map((t) => t.pnl)),
    avgL: mean(losses.map((t) => t.pnl)),
    pf: gL > 0 ? gW / gL : Infinity,
    exp: res.length ? total / res.length : NaN,
    total,
    dd,
    perYr: res.length / years,
  };
}
function row(label: string, s: ReturnType<typeof stats>) {
  return [label, `${s.n}`, f1(s.wr), f2(s.avgW), f2(s.avgL), f2(s.pf), f2(s.exp), f1(s.total), f1(s.dd), f1(s.perYr)]
    .map((x) => x.padStart(12))
    .join("");
}
function reachRow(label: string, r: Reach[]) {
  return [
    label,
    `${r.length}`,
    f1(pct(r.filter((x) => x.r0).length, r.length)),
    f1(pct(r.filter((x) => x.r25).length, r.length)),
    f1(pct(r.filter((x) => x.r50).length, r.length)),
    f1(pct(r.filter((x) => x.r60).length, r.length)),
    f1(pct(r.filter((x) => x.r70).length, r.length)),
    f1(pct(r.filter((x) => x.r100).length, r.length)),
  ]
    .map((x) => x.padStart(12))
    .join("");
}

const trends: Trend[] = ["bullish", "neutral", "bearish"];
const agrees: Agree[] = ["both_bullish", "both_bearish", "disagree", "any_neutral"];
const L: string[] = [];
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;

L.push("EUR/USD 15M — RANGE->SWING + H4/D1 HTF TREND + %-OF-RANGE TARGETS (V12, research-only)");
L.push(
  `FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}%  (81.37/81.56) -> PASS. Range->Swing breakouts (broke out): ${rsBreaks.length - noBreakout}.`,
);
L.push(
  `Setup FROZEN from V11: no-swing-between (gap>${D}p) 20p entry; SL ${SL_PIPS}p; target = % across frozen range. Trend = H4/D1 EMA20/50+slope+HH/HL on COMPLETED bars only. M5 path.`,
);
L.push(
  `HTF bars: H4 ${h4s.times.length} (${h4s.times[0]} -> ${h4s.times[h4s.times.length - 1]}), D1 ${d1s.times.length} (${d1s.times[0]} -> ${d1s.times[d1s.times.length - 1]}).`,
);
L.push(
  `No-swing-between entries taken: ${reaches.length} (swing-between skipped ${swingBetween}, no-entry ${noEntry}). ~${f1(reaches.length / years)}/yr. SMALL SAMPLE -> read cautiously.`,
);
L.push("");
L.push("V11 REFERENCE (M15 trend, strongest LONG ~60%): neutral PF~1.66 +10.4p/trd (n=59); bearish PF~1.58 +9.1p/trd (n=135). SHORT was weak.");
L.push("");

function grid(
  title: string,
  filterFn: (t: Trade) => boolean,
  groupLabels: string[],
  groupFn: (t: Trade) => string,
) {
  L.push("#".repeat(140));
  L.push(title);
  L.push("#".repeat(140));
  L.push(
    ["Group", "Target%", "Trades", "Win%", "AvgWin", "AvgLoss", "PF", "Exp/trd", "TotalPips", "MaxDD", "Trd/yr"]
      .map((s) => s.padStart(12))
      .join(""),
  );
  for (const g of groupLabels) {
    for (const P of PCTS) {
      const s = stats(trades.filter((t) => filterFn(t) && groupFn(t) === g && t.pctT === P));
      L.push(row(`${g}|${P}%`, s));
    }
    L.push("");
  }
}

function reachGrid(
  title: string,
  filterFn: (r: Reach) => boolean,
  groupLabels: string[],
  groupFn: (r: Reach) => string,
) {
  L.push("=".repeat(140));
  L.push(title);
  L.push("=".repeat(140));
  L.push(
    ["Group", "Setups", "reach0%(S/R)", "reach25%", "reach50%", "reach60%", "reach70%", "reach100%(opp)"]
      .map((s) => s.padStart(12))
      .join(""),
  );
  for (const g of groupLabels) {
    L.push(reachRow(g, reaches.filter((r) => filterFn(r) && groupFn(r) === g)));
  }
  L.push("");
}

// ---- LONG / SHORT x H4 ----
grid(
  "LONG (support break) × H4 trend",
  (t) => t.side === "support",
  trends,
  (t) => t.h4,
);
grid(
  "LONG (support break) × D1 trend",
  (t) => t.side === "support",
  trends,
  (t) => t.d1,
);
grid(
  "SHORT (resistance break) × H4 trend",
  (t) => t.side === "resistance",
  trends,
  (t) => t.h4,
);
grid(
  "SHORT (resistance break) × D1 trend",
  (t) => t.side === "resistance",
  trends,
  (t) => t.d1,
);

// ---- Agreement ----
grid(
  "LONG × H4+D1 agreement",
  (t) => t.side === "support",
  agrees,
  (t) => t.agree,
);
grid(
  "SHORT × H4+D1 agreement",
  (t) => t.side === "resistance",
  agrees,
  (t) => t.agree,
);

// ---- Baseline (all, no trend split) for comparison ----
L.push("#".repeat(140));
L.push("BASELINE (all entries, no HTF filter) — same cohort as V11 trades");
L.push("#".repeat(140));
L.push(
  ["Group", "Target%", "Trades", "Win%", "AvgWin", "AvgLoss", "PF", "Exp/trd", "TotalPips", "MaxDD", "Trd/yr"]
    .map((s) => s.padStart(12))
    .join(""),
);
for (const [dir, side] of [
  ["LONG", "support"],
  ["SHORT", "resistance"],
] as Array<[string, Side]>) {
  for (const P of PCTS) {
    const s = stats(trades.filter((t) => t.side === side && t.pctT === P));
    L.push(row(`${dir}|${P}%`, s));
  }
  L.push("");
}

// reachability
reachGrid(
  "REACHABILITY — LONG × H4 (no stop)",
  (r) => r.side === "support",
  trends,
  (r) => r.h4,
);
reachGrid(
  "REACHABILITY — LONG × D1 (no stop)",
  (r) => r.side === "support",
  trends,
  (r) => r.d1,
);
reachGrid(
  "REACHABILITY — SHORT × H4 (no stop)",
  (r) => r.side === "resistance",
  trends,
  (r) => r.h4,
);
reachGrid(
  "REACHABILITY — SHORT × D1 (no stop)",
  (r) => r.side === "resistance",
  trends,
  (r) => r.d1,
);
reachGrid(
  "REACHABILITY — LONG × agreement (no stop)",
  (r) => r.side === "support",
  agrees,
  (r) => r.agree,
);
reachGrid(
  "REACHABILITY — SHORT × agreement (no stop)",
  (r) => r.side === "resistance",
  agrees,
  (r) => r.agree,
);

// Trend distribution
L.push("=".repeat(140));
L.push("HTF TREND DISTRIBUTION at entry (unique setups)");
L.push("=".repeat(140));
for (const [dir, side] of [
  ["LONG", "support"],
  ["SHORT", "resistance"],
] as Array<[string, Side]>) {
  const rs = reaches.filter((r) => r.side === side);
  L.push(`${dir} n=${rs.length}`);
  for (const tr of trends) {
    L.push(
      `  H4 ${tr}: ${rs.filter((r) => r.h4 === tr).length}   D1 ${tr}: ${rs.filter((r) => r.d1 === tr).length}`,
    );
  }
  for (const a of agrees) L.push(`  agree ${a}: ${rs.filter((r) => r.agree === a).length}`);
  L.push("");
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-htf-trend-v12-report.txt"), report + "\n");
console.log(report);
const csv: string[] = [];
csv.push(
  ["entry_time", "side", "h4_trend", "d1_trend", "agree", "target_pct", "outcome", "pnl_pips", "range_pips"].join(
    ",",
  ),
);
for (const t of trades)
  csv.push(
    [t.entryTime, t.side, t.h4, t.d1, t.agree, t.pctT, t.oc, t.pnl.toFixed(2), t.rangePips.toFixed(1)].join(","),
  );
fs.writeFileSync(path.join(OUT_DIR, "eurusd-15m-sr-htf-trend-v12-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-15m-sr-htf-trend-v12-report.txt | eurusd-15m-sr-htf-trend-v12-events.csv`);
