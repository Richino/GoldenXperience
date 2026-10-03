/**
 * EUR/USD — MULTI-TIMEFRAME S/R PATH TEST (V15, research-only, behavioral).
 *
 * Hypothesis: after a 15M S/R breakout reclaims back inside its range, price often
 * travels through the range but stops/rejects at an INTERNAL 5M S/R rather than
 * reaching the opposite 15M S/R.
 *
 * 15M S/R: EXACT project algorithm via assessMarketCondition / computeSupportResistanceLevels.
 * 5M S/R at reclaim: SAME computeSupportResistanceLevels (+ same pivot constants) on
 * COMPLETED M5 candles only — frozen at reclaim, no future bars.
 *
 * No TP/SL, no P&L strategy. Controls: fixed 25/50/75% of the frozen 15M range.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { assessMarketCondition } from "../src/lib/strategy/market-condition";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";
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
const HORIZON_M15 = 96; // scan for break+reclaim
const PATH_M5 = 576; // ~2d path after reclaim
const TOUCH_ATR = PR.touchAtr;
const MIN_PEN_ATR = PR.minPenetrationAtr;
const ACCEPT_MIN_BARS = PR.acceptMinBars;
const ACCEPT_MIN_DIST_ATR = PR.acceptMinDistanceAtr;

/** Exact constants from support-resistance.ts (do not invent new S/R). */
const PIVOT_REACH = 5;
const RANGE_LOOKBACK = 60;
const VISIBLE_LOOKBACK = 160;

type Side = "long" | "short"; // long = support break+reclaim; short = resistance break+reclaim
type LocBin = "0-20" | "20-40" | "40-60" | "60-80" | "80-100";
type RejKind = "atr25" | "atr50" | "closeAway" | "noCloseThru2";

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

interface Setup {
  side: Side;
  t0: number; // M15 encounter index
  support: number;
  resistance: number;
  atr15: number;
}

interface LevelHit {
  label: string;
  price: number;
  locPct: number;
  locBin: LocBin;
  distFromReclaimPips: number;
  reached: boolean;
  broke: boolean;
  rej: Record<RejKind, boolean>;
}

interface Event {
  side: Side;
  reclaimTime: string;
  support: number;
  resistance: number;
  rangePips: number;
  atr5: number;
  spreadPips: number;
  hasInternal: boolean;
  nInternal: number;
  first: LevelHit | null;
  second: LevelHit | null;
  controls: LevelHit[];
  reached50: boolean;
  reachedOpp: boolean;
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

// M5: reconstruct MID from BID/ASK averages (structure/path study). Opens chained from prior close.
const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M5C, "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const mh = new Float64Array(M),
  ml = new Float64Array(M),
  mc = new Float64Array(M),
  mo = new Float64Array(M);
const spreadClose = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  const bh = r[1],
    bl = r[2],
    ah = r[3],
    al = r[4],
    bc = r[5],
    ac = r[6];
  mh[i] = (bh + ah) / 2;
  ml[i] = (bl + al) / 2;
  mc[i] = (bc + ac) / 2;
  spreadClose[i] = (ac - bc) / PIP;
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
function locBin(p: number): LocBin {
  if (p < 20) return "0-20";
  if (p < 40) return "20-40";
  if (p < 60) return "40-60";
  if (p < 80) return "60-80";
  return "80-100";
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}
function median(xs: number[]): number {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2;
}

/**
 * Full set of levels the project S/R algorithm considers on a completed series:
 * rangeHigh/rangeLow (RANGE_LOOKBACK) + every confirmed swing pivot (PIVOT_REACH)
 * inside VISIBLE_LOOKBACK — same constants/loop as support-resistance.ts.
 * Live API returns nearest swing; here we keep all pivots so first/second internals exist.
 */
function extractSrLevels(candles: Candle[]): { rangeHigh: number; rangeLow: number; swings: number[] } | null {
  const api = computeSupportResistanceLevels(candles, INSTRUMENT);
  if (!api) return null;
  const visible = candles.slice(-VISIBLE_LOOKBACK);
  const swings: number[] = [];
  for (let index = PIVOT_REACH; index < visible.length - PIVOT_REACH; index += 1) {
    const candle = visible[index]!;
    const window = visible.slice(index - PIVOT_REACH, index + PIVOT_REACH + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) swings.push(candle.high);
    if (window.every((other) => other === candle || other.low >= candle.low)) swings.push(candle.low);
  }
  return { rangeHigh: api.rangeHigh, rangeLow: api.rangeLow, swings };
}

function uniqueSorted(xs: number[]): number[] {
  const s = [...xs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) if (!out.length || Math.abs(x - out[out.length - 1]!) > PIP * 0.1) out.push(x);
  return out;
}

// ---- 15M fidelity (same as V11-V14 family) ----
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

// ---- detect 15M near-level encounters; freeze outer range ----
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
    // Outer 15M range frozen at encounter (exact algorithm rangeHigh/rangeLow).
    if (lv.rangeHigh > lv.rangeLow) {
      setups.push({ side: "long", t0: t, support: lv.rangeLow, resistance: lv.rangeHigh, atr15: A });
    }
    armedS = false;
  } else if (!nearS) armedS = true;
  if (nearR && armedR) {
    if (lv.rangeHigh > lv.rangeLow) {
      setups.push({ side: "short", t0: t, support: lv.rangeLow, resistance: lv.rangeHigh, atr15: A });
    }
    armedR = false;
  } else if (!nearR) armedR = true;
}

function evaluateLevel(
  side: Side,
  level: number,
  label: string,
  support: number,
  resistance: number,
  reclaimIdx: number,
  reclaimPrice: number,
  atr5: number,
): LevelHit {
  const R = resistance - support;
  const locPct = side === "long" ? ((level - support) / R) * 100 : ((resistance - level) / R) * 100;
  const distFromReclaimPips = Math.abs(level - reclaimPrice) / PIP;
  const touchZ = TOUCH_ATR * atr5;
  const end = Math.min(reclaimIdx + PATH_M5, M - 1);

  let touchI = -1;
  for (let k = reclaimIdx + 1; k <= end; k++) {
    if (side === "long") {
      if (mh[k]! >= level - touchZ) {
        touchI = k;
        break;
      }
    } else if (ml[k]! <= level + touchZ) {
      touchI = k;
      break;
    }
  }
  const reached = touchI >= 0;
  let broke = false;
  const rej: Record<RejKind, boolean> = {
    atr25: false,
    atr50: false,
    closeAway: false,
    noCloseThru2: false,
  };

  if (touchI >= 0) {
    // Scan forward: measure reject-before-break, then whether a close-through occurs.
    let maxAdvBeforeBreak = 0;
    let sawCloseAwayBeforeBreak = false;
    let holdNoThru = 0;
    let noCloseThru2 = false;
    let brokenAt = -1;
    for (let k = touchI; k <= end; k++) {
      const thru = side === "long" ? mc[k]! > level : mc[k]! < level;
      if (thru) {
        brokenAt = k;
        broke = true;
        break;
      }
      if (side === "long") {
        maxAdvBeforeBreak = Math.max(maxAdvBeforeBreak, level - ml[k]!);
        if (mc[k]! < level - touchZ) sawCloseAwayBeforeBreak = true;
      } else {
        maxAdvBeforeBreak = Math.max(maxAdvBeforeBreak, mh[k]! - level);
        if (mc[k]! > level + touchZ) sawCloseAwayBeforeBreak = true;
      }
      holdNoThru++;
      if (holdNoThru >= 2) noCloseThru2 = true;
    }
    // If never broke, continue adverse over full window (already done in loop).
    if (brokenAt < 0) {
      // already accumulated over full path without break
    }
    rej.atr25 = maxAdvBeforeBreak >= 0.25 * atr5;
    rej.atr50 = maxAdvBeforeBreak >= 0.5 * atr5;
    rej.closeAway = sawCloseAwayBeforeBreak;
    rej.noCloseThru2 = noCloseThru2 && !broke;
  }

  return {
    label,
    price: level,
    locPct,
    locBin: locBin(locPct),
    distFromReclaimPips,
    reached,
    broke,
    rej,
  };
}

const events: Event[] = [];
let noBreak = 0,
  noReclaim = 0,
  noM5 = 0;

for (const s of setups) {
  const isLong = s.side === "long";
  const endScan = Math.min(s.t0 + HORIZON_M15, n - 1);
  // Break: penetrate beyond frozen outer level
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
  // Reclaim: first close back inside the frozen 15M range
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

  // Reclaim confirmed at M15 bar close → M5 path starts after that close.
  const reclaimCloseTime = new Date(new Date(raw[tReclaim]!.time).getTime() + 15 * 60000).toISOString();
  const m5Reclaim = lb(mt, reclaimCloseTime);
  if (m5Reclaim <= VISIBLE_LOOKBACK || m5Reclaim >= M - 2) {
    noM5++;
    continue;
  }

  // 5M S/R on COMPLETED candles strictly before reclaim close (no forming bar).
  const m5Slice = m5candles.slice(Math.max(0, m5Reclaim - WINDOW), m5Reclaim);
  const sr = extractSrLevels(m5Slice);
  const atr5 = atr14Of(m5Slice);
  if (!sr || !(atr5 > 0)) {
    noM5++;
    continue;
  }

  const R = s.resistance - s.support;
  const reclaimPrice = isLong ? s.support : s.resistance;
  // Internal: strictly inside frozen 15M range (exclude the boundaries themselves).
  const eps = PIP * 0.5;
  const rawLevels = uniqueSorted([sr.rangeHigh, sr.rangeLow, ...sr.swings]).filter(
    (L) => L > s.support + eps && L < s.resistance - eps,
  );
  // Order by travel: LONG upward from support; SHORT downward from resistance.
  const ordered = isLong ? rawLevels : [...rawLevels].reverse();
  // Keep only levels still ahead of reclaim (in travel direction)
  const ahead = ordered.filter((L) => (isLong ? L > reclaimPrice + eps : L < reclaimPrice - eps));

  const first = ahead[0]
    ? evaluateLevel(s.side, ahead[0], "m5_first", s.support, s.resistance, m5Reclaim, reclaimPrice, atr5)
    : null;
  const second = ahead[1]
    ? evaluateLevel(s.side, ahead[1], "m5_second", s.support, s.resistance, m5Reclaim, reclaimPrice, atr5)
    : null;

  const controls: LevelHit[] = [];
  for (const p of [25, 50, 75]) {
    const lvl = isLong ? s.support + (p / 100) * R : s.resistance - (p / 100) * R;
    controls.push(
      evaluateLevel(s.side, lvl, `ctrl_${p}`, s.support, s.resistance, m5Reclaim, reclaimPrice, atr5),
    );
  }

  // 50% of range & opposite 15M S/R reachability from reclaim
  const mid50 = s.support + 0.5 * R;
  const opp = isLong ? s.resistance : s.support;
  let reached50 = false,
    reachedOpp = false;
  const pathEnd = Math.min(m5Reclaim + PATH_M5, M - 1);
  for (let k = m5Reclaim + 1; k <= pathEnd; k++) {
    if (isLong) {
      if (mh[k]! >= mid50) reached50 = true;
      if (mh[k]! >= opp - eps) reachedOpp = true;
    } else {
      if (ml[k]! <= mid50) reached50 = true;
      if (ml[k]! <= opp + eps) reachedOpp = true;
    }
  }

  events.push({
    side: s.side,
    reclaimTime: mt[m5Reclaim]!,
    support: s.support,
    resistance: s.resistance,
    rangePips: R / PIP,
    atr5,
    spreadPips: spreadClose[m5Reclaim]!,
    hasInternal: ahead.length > 0,
    nInternal: ahead.length,
    first,
    second,
    controls,
    reached50,
    reachedOpp,
  });
}

// ---- reporting ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const fid = (globalThis as { __fid: { vS: number; vR: number } }).__fid;
const L: string[] = [];

function rejRate(list: LevelHit[], kind: RejKind): number {
  const reached = list.filter((x) => x.reached);
  return pct(reached.filter((x) => x.rej[kind]).length, reached.length);
}
function breakRate(list: LevelHit[]): number {
  const reached = list.filter((x) => x.reached);
  return pct(reached.filter((x) => x.broke).length, reached.length);
}
function reachRate(list: LevelHit[]): number {
  return pct(list.filter((x) => x.reached).length, list.length);
}

function summarize(title: string, pool: Event[]) {
  L.push("#".repeat(120));
  L.push(title);
  L.push("#".repeat(120));
  const nE = pool.length;
  const withI = pool.filter((e) => e.hasInternal);
  const noI = pool.filter((e) => !e.hasInternal);
  L.push(`Setups (reclaims): ${nE}`);
  L.push(`  with internal 5M S/R: ${withI.length} (${f1(pct(withI.length, nE))}%)`);
  L.push(`  no internal 5M S/R:   ${noI.length} (${f1(pct(noI.length, nE))}%)`);
  L.push(`  median spread at reclaim: ${f2(median(pool.map((e) => e.spreadPips)))} pips`);
  L.push(`  median 15M range: ${f1(median(pool.map((e) => e.rangePips)))} pips`);
  L.push(`  reach 50% of 15M range: ${f1(pct(pool.filter((e) => e.reached50).length, nE))}%`);
  L.push(`  reach opposite 15M S/R: ${f1(pct(pool.filter((e) => e.reachedOpp).length, nE))}%`);
  L.push(`  reach first 5M S/R (all setups): ${f1(pct(pool.filter((e) => e.first?.reached).length, nE))}%`);
  L.push(`  reach first 5M S/R (among with-internal): ${f1(pct(withI.filter((e) => e.first?.reached).length, withI.length))}%`);
  L.push("");

  const firsts = withI.map((e) => e.first!).filter(Boolean);
  const seconds = withI.map((e) => e.second).filter((x): x is LevelHit => !!x);

  L.push("-- FIRST internal 5M S/R --");
  L.push(`  n: ${firsts.length}`);
  L.push(`  median distance from reclaim: ${f1(median(firsts.map((x) => x.distFromReclaimPips)))} pips`);
  L.push(`  median location % across 15M range: ${f1(median(firsts.map((x) => x.locPct)))}%`);
  L.push(`  reach %: ${f1(reachRate(firsts))}`);
  L.push(`  among reached → break through %: ${f1(breakRate(firsts))}`);
  L.push(`  among reached → reject atr0.25 %: ${f1(rejRate(firsts, "atr25"))}`);
  L.push(`  among reached → reject atr0.50 %: ${f1(rejRate(firsts, "atr50"))}`);
  L.push(`  among reached → close-away %: ${f1(rejRate(firsts, "closeAway"))}`);
  L.push(`  among reached → no-close-thru-2bars %: ${f1(rejRate(firsts, "noCloseThru2"))}`);
  // reject vs break (atr25 as primary behavioral reject)
  {
    const reached = firsts.filter((x) => x.reached);
    const rejOnly = reached.filter((x) => x.rej.atr25 && !x.broke).length;
    const brk = reached.filter((x) => x.broke).length;
    const both = reached.filter((x) => x.rej.atr25 && x.broke).length;
    L.push(
      `  reject(atr25)-without-break / break / both-seen: ${f1(pct(rejOnly, reached.length))} / ${f1(pct(brk, reached.length))} / ${f1(pct(both, reached.length))}  (n_reached=${reached.length})`,
    );
  }
  L.push("");

  L.push("-- SECOND internal 5M S/R (among setups that have one) --");
  L.push(`  n: ${seconds.length} (${f1(pct(seconds.length, withI.length))}% of with-internal)`);
  if (seconds.length) {
    L.push(`  median location %: ${f1(median(seconds.map((x) => x.locPct)))}%`);
    L.push(`  reach %: ${f1(reachRate(seconds))}`);
    L.push(`  among reached → break %: ${f1(breakRate(seconds))}`);
    L.push(`  among reached → reject atr0.25 %: ${f1(rejRate(seconds, "atr25"))}`);
    L.push(`  among reached → reject atr0.50 %: ${f1(rejRate(seconds, "atr50"))}`);
    L.push(`  among reached → close-away %: ${f1(rejRate(seconds, "closeAway"))}`);
    L.push(`  among reached → no-close-thru-2 %: ${f1(rejRate(seconds, "noCloseThru2"))}`);
  }
  // Conditional: when first BREAKS, does second help?
  const firstBroke = withI.filter((e) => e.first && e.first.reached && e.first.broke && e.second);
  if (firstBroke.length) {
    const sec = firstBroke.map((e) => e.second!);
    L.push(`  WHEN FIRST BREAKS (n=${firstBroke.length}): second reach ${f1(reachRate(sec))}%, reject atr25 ${f1(rejRate(sec, "atr25"))}%, break ${f1(breakRate(sec))}%`);
  }
  L.push("");

  // Location bins for first 5M
  L.push("-- FIRST 5M S/R by location bin inside 15M range --");
  L.push(
    ["Bin", "n", "reach%", "brk%", "rej25%", "rej50%", "closeAway%", "noThru2%"].map((s) => s.padStart(10)).join(""),
  );
  for (const bin of ["0-20", "20-40", "40-60", "60-80", "80-100"] as LocBin[]) {
    const xs = firsts.filter((x) => x.locBin === bin);
    L.push(
      [
        bin,
        `${xs.length}`,
        f1(reachRate(xs)),
        f1(breakRate(xs)),
        f1(rejRate(xs, "atr25")),
        f1(rejRate(xs, "atr50")),
        f1(rejRate(xs, "closeAway")),
        f1(rejRate(xs, "noCloseThru2")),
      ]
        .map((x) => x.padStart(10))
        .join(""),
    );
  }
  L.push("");

  // Controls vs first 5M — SAME pool (with-internal only) for fair comparison
  L.push("-- CONTROL vs FIRST 5M S/R on with-internal setups (reach / break-among-reached / rej atr25-among-reached) --");
  const row = (name: string, xs: LevelHit[]) =>
    L.push(
      `  ${name.padEnd(16)} n=${String(xs.length).padStart(5)}  reach=${f1(reachRate(xs)).padStart(5)}%  break=${f1(breakRate(xs)).padStart(5)}%  rej25=${f1(rejRate(xs, "atr25")).padStart(5)}%  rej50=${f1(rejRate(xs, "atr50")).padStart(5)}%  closeAway=${f1(rejRate(xs, "closeAway")).padStart(5)}%`,
    );
  row("5M first", firsts);
  for (const p of [25, 50, 75]) {
    const xs = withI.map((e) => e.controls.find((c) => c.label === `ctrl_${p}`)!).filter(Boolean);
    row(`fixed ${p}%`, xs);
  }
  L.push("");
}

L.push("EUR/USD — MULTI-TIMEFRAME S/R PATH TEST (V15, research-only)");
L.push(
  `FIDELITY: support ${f2(fid.vS)}%  resistance ${f2(fid.vR)}% -> PASS. 15M encounters armed: ${setups.length}.`,
);
L.push(
  `Pipeline: near 15M S/R → freeze rangeLow/rangeHigh → break (minPen) → reclaim close inside → freeze 5M S/R on completed M5 → path ${PATH_M5} M5 bars.`,
);
L.push(
  `Dropped: no-break ${noBreak}, no-reclaim ${noReclaim}, no-M5 ${noM5}. Events kept: ${events.length}.`,
);
L.push(
  "5M levels = exact computeSupportResistanceLevels range + same-pivot swings (PIVOT_REACH=5, VISIBLE=160, RANGE=60), filtered strictly inside frozen 15M range.",
);
L.push("Rejection defs reported separately (not combined). MID path; spread logged only.");
L.push("");

summarize("LONG — reclaimed 15M support, path upward", events.filter((e) => e.side === "long"));
summarize("SHORT — reclaimed 15M resistance, path downward", events.filter((e) => e.side === "short"));
summarize("COMBINED", events);

// Highlight 40-60
L.push("=".repeat(120));
L.push("FOCUS: FIRST 5M S/R in 40–60% of 15M range (center band)");
L.push("=".repeat(120));
for (const [name, pool] of [
  ["LONG", events.filter((e) => e.side === "long")],
  ["SHORT", events.filter((e) => e.side === "short")],
  ["COMBINED", events],
] as Array<[string, Event[]]>) {
  const xs = pool.map((e) => e.first).filter((x): x is LevelHit => !!x && x.locBin === "40-60");
  L.push(
    `${name}: n=${xs.length}  reach=${f1(reachRate(xs))}%  break=${f1(breakRate(xs))}%  rej25=${f1(rejRate(xs, "atr25"))}%  rej50=${f1(rejRate(xs, "atr50"))}%  (share of firsts: ${f1(pct(xs.length, pool.filter((e) => e.first).length))}%)`,
  );
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-mtf-sr-path-v15-report.txt"), report + "\n");
console.log(report);

const csv: string[] = [];
csv.push(
  [
    "side",
    "reclaim_time",
    "range_pips",
    "spread_pips",
    "n_internal",
    "first_price",
    "first_loc_pct",
    "first_bin",
    "first_dist_pips",
    "first_reached",
    "first_broke",
    "first_rej25",
    "first_rej50",
    "first_close_away",
    "first_nothru2",
    "second_reached",
    "second_broke",
    "second_rej25",
    "ctrl25_reached",
    "ctrl25_broke",
    "ctrl25_rej25",
    "ctrl50_reached",
    "ctrl50_broke",
    "ctrl50_rej25",
    "ctrl75_reached",
    "ctrl75_broke",
    "ctrl75_rej25",
    "reached_50pct",
    "reached_opp",
  ].join(","),
);
for (const e of events) {
  const c25 = e.controls.find((c) => c.label === "ctrl_25");
  const c50 = e.controls.find((c) => c.label === "ctrl_50");
  const c75 = e.controls.find((c) => c.label === "ctrl_75");
  csv.push(
    [
      e.side,
      e.reclaimTime,
      e.rangePips.toFixed(1),
      e.spreadPips.toFixed(2),
      e.nInternal,
      e.first?.price.toFixed(5) ?? "",
      e.first ? e.first.locPct.toFixed(1) : "",
      e.first?.locBin ?? "",
      e.first ? e.first.distFromReclaimPips.toFixed(1) : "",
      e.first ? (e.first.reached ? 1 : 0) : "",
      e.first ? (e.first.broke ? 1 : 0) : "",
      e.first ? (e.first.rej.atr25 ? 1 : 0) : "",
      e.first ? (e.first.rej.atr50 ? 1 : 0) : "",
      e.first ? (e.first.rej.closeAway ? 1 : 0) : "",
      e.first ? (e.first.rej.noCloseThru2 ? 1 : 0) : "",
      e.second ? (e.second.reached ? 1 : 0) : "",
      e.second ? (e.second.broke ? 1 : 0) : "",
      e.second ? (e.second.rej.atr25 ? 1 : 0) : "",
      c25 ? (c25.reached ? 1 : 0) : "",
      c25 ? (c25.broke ? 1 : 0) : "",
      c25 ? (c25.rej.atr25 ? 1 : 0) : "",
      c50 ? (c50.reached ? 1 : 0) : "",
      c50 ? (c50.broke ? 1 : 0) : "",
      c50 ? (c50.rej.atr25 ? 1 : 0) : "",
      c75 ? (c75.reached ? 1 : 0) : "",
      c75 ? (c75.broke ? 1 : 0) : "",
      c75 ? (c75.rej.atr25 ? 1 : 0) : "",
      e.reached50 ? 1 : 0,
      e.reachedOpp ? 1 : 0,
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-mtf-sr-path-v15-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-mtf-sr-path-v15-report.txt | eurusd-mtf-sr-path-v15-events.csv (${events.length} events)`);
