// Parameterised TrendPullback engine for the V2 research (EUR/USD).
//
// The concept is fixed: (1) read the trend, (2) trade only with it, (3) wait for
// a pullback against it, (4) enter on that pullback, (5) defined stop and target.
// Every decision is made at the close of a base-timeframe candle from candles
// that have closed by then; orders then work during the next base candle on
// M5 bid/ask (see lib.mts for the fill rules).
//
// Impulse leg (bull; bear is the same on negated prices):
//   A = leg origin (swing low), B = leg high, C = lowest low since B.
//   - a new high above B: if the dip since B was at least `zz` ATR, that dip's
//     low (C) becomes the new origin A (a higher low); B moves up; the leg id
//     changes, so a new pullback may be traded;
//   - a low below A breaks the leg: it restarts from that bar.
//   Retracement depth = (B - C) / (B - A). A leg is tradable when B - A is at
//   least `minImp` ATR. One entry per leg id.
import fs from "node:fs";
import { countLE, loadM5, loadMid, PIP, runPosition, SLIP, type Bars, type M5, type Trade } from "./lib.mts";

export type TF = "M15" | "H1" | "H4" | "D";
export const HIGHER: Record<TF, TF> = { M15: "H1", H1: "H4", H4: "D", D: "D" };
const MAX_HOLD: Record<TF, number> = { M15: 2 * 86_400_000, H1: 5 * 86_400_000, H4: 20 * 86_400_000, D: 40 * 86_400_000 };

export type TrendMethod = "NONE" | "SWING" | "EMA_STACK" | "EMA_PRICE" | "REG";
export type Config = {
  id?: string;
  base: TF;
  trend: TrendMethod;
  /** Where the trend is read: base TF, the next higher TF, or both must agree. */
  trendTf: "base" | "higher" | "both";
  swingReach?: number;
  regN?: number;
  regR2?: number;
  zz: number;
  minImp: number;
  /** FRACTION: depth = share of the impulse; ATR: B - C >= depth x ATR; EMA: price reaches EMA21 - depth x ATR. */
  pbMode: "FRACTION" | "ATR" | "EMA";
  depth: number;
  /** Deepest retracement still accepted (share of impulse); beyond A the leg is broken anyway. */
  maxDepth?: number;
  entry: "LIMIT" | "CANDLE" | "BREAK" | "STRUCT_BREAK" | "RECLAIM";
  stop: "ATR" | "PB" | "ORIGIN" | "PIPS";
  stopVal: number;
  tp: "RR" | "PIPS" | "STRUCT";
  tpVal: number;
  filters?: Filters;
  /** Trade the opposite direction with identical distances (control). */
  mirror?: boolean;
  /** Execute on mid prices, no slippage (gross). */
  mid?: boolean;
};
export type Filters = {
  hours?: [number, number]; // allowed UTC hour of the decision [from, to)
  noDow?: number[]; // UTC day of week excluded (0 = Sunday)
  maxSpreadPips?: number;
  atrPct?: [number, number]; // ATR percentile vs the trailing year of base candles
  minEr?: number; // efficiency ratio over 20 base candles
  newsBeforeMin?: number; // no entry this many minutes before a high-impact EUR/USD event
  newsAfterMin?: number; // ...or this many minutes after one
};

export type Data = {
  m5: M5;
  tf: Record<TF, Bars>;
  m5Start: Record<TF, Int32Array>; // first M5 bar at or after each candle's close
  cache: Map<string, Float64Array | Int8Array | Int32Array>;
  news: Float64Array;
  start: number;
  end: number;
};

export function loadData(dir: string, start: number, end: number, newsFile?: string): Data {
  const m5 = loadM5(dir);
  const tf = { M15: loadMid(dir, "M15"), H1: loadMid(dir, "H1"), H4: loadMid(dir, "H4"), D: loadMid(dir, "D") };
  const m5Start = {} as Record<TF, Int32Array>;
  for (const k of Object.keys(tf) as TF[]) {
    const b = tf[k];
    const arr = new Int32Array(b.n);
    for (let j = 0; j < b.n; j += 1) arr[j] = countLE(m5.a, b.end[j]! - 1, 9);
    m5Start[k] = arr;
  }
  let news = new Float64Array(0);
  if (newsFile) {
    const rows = JSON.parse(fs.readFileSync(newsFile, "utf8")) as Array<{ t: string; cur: string }>;
    news = Float64Array.from(rows.filter((e) => e.cur === "EUR" || e.cur === "USD").map((e) => Date.parse(e.t)).sort((x, y) => x - y));
  }
  return { m5, tf, m5Start, cache: new Map(), news, start, end };
}

function cached<T extends Float64Array | Int8Array | Int32Array>(d: Data, key: string, make: () => T): T {
  let v = d.cache.get(key) as T | undefined;
  if (!v) { v = make(); d.cache.set(key, v); }
  return v;
}

function ema(c: Float64Array, p: number) {
  const out = new Float64Array(c.length);
  const k = 2 / (p + 1);
  let e = c[0]!;
  for (let i = 0; i < c.length; i += 1) { e = i === 0 ? c[0]! : c[i]! * k + e * (1 - k); out[i] = e; }
  return out;
}
export const emaOf = (d: Data, t: TF, p: number) => cached(d, `ema${t}${p}`, () => ema(d.tf[t].c, p));
export const atrOf = (d: Data, t: TF) => cached(d, `atr${t}`, () => {
  const b = d.tf[t];
  const out = new Float64Array(b.n);
  let a = b.h[0]! - b.l[0]!;
  for (let i = 0; i < b.n; i += 1) {
    const tr = i === 0 ? b.h[0]! - b.l[0]! : Math.max(b.h[i]! - b.l[i]!, Math.abs(b.h[i]! - b.c[i - 1]!), Math.abs(b.l[i]! - b.c[i - 1]!));
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14;
    out[i] = a;
  }
  return out;
});
/** ATR percentile vs the previous ~1 year of the same TF's candles (250 samples). */
export const atrPctOf = (d: Data, t: TF) => cached(d, `atrPct${t}`, () => {
  const a = atrOf(d, t);
  const per = { M15: 25_000, H1: 6_250, H4: 1_500, D: 250 }[t];
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    const lo = Math.max(0, i - per);
    let below = 0, total = 0;
    for (let k = lo; k < i; k += per / 250) { total += 1; if (a[k]! < a[i]!) below += 1; }
    out[i] = total ? below / total : 0.5;
  }
  return out;
});
export const erOf = (d: Data, t: TF, n = 20) => cached(d, `er${t}${n}`, () => {
  const c = d.tf[t].c;
  const out = new Float64Array(c.length);
  for (let i = n; i < c.length; i += 1) {
    let path = 0;
    for (let k = i - n + 1; k <= i; k += 1) path += Math.abs(c[k]! - c[k - 1]!);
    out[i] = path > 0 ? Math.abs(c[i]! - c[i - n]!) / path : 0;
  }
  return out;
});

/** Trend direction per candle (+1/-1/0) on one TF, from candles closed by then. */
function trendOn(d: Data, t: TF, m: TrendMethod, cfg: Config): Int8Array {
  const key = `trend${t}${m}${cfg.swingReach ?? 3}_${cfg.regN ?? 50}_${cfg.regR2 ?? 0.3}`;
  return cached(d, key, () => {
    const b = d.tf[t];
    const out = new Int8Array(b.n);
    if (m === "NONE") return out.fill(0);
    if (m === "EMA_STACK" || m === "EMA_PRICE") {
      const e21 = emaOf(d, t, 21), e50 = emaOf(d, t, 50), e200 = emaOf(d, t, 200);
      for (let i = 200; i < b.n; i += 1) {
        if (m === "EMA_STACK") out[i] = e21[i]! > e50[i]! && e50[i]! > e200[i]! ? 1 : e21[i]! < e50[i]! && e50[i]! < e200[i]! ? -1 : 0;
        else out[i] = e50[i]! > e200[i]! && b.c[i]! > e50[i]! ? 1 : e50[i]! < e200[i]! && b.c[i]! < e50[i]! ? -1 : 0;
      }
      return out;
    }
    if (m === "REG") {
      const n = cfg.regN ?? 50, thr = cfg.regR2 ?? 0.3;
      const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6;
      for (let i = n - 1; i < b.n; i += 1) {
        let sy = 0, sxy = 0, syy = 0;
        for (let k = 0; k < n; k += 1) { const y = b.c[i - n + 1 + k]!; sy += y; sxy += k * y; syy += y * y; }
        const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
        const slope = cov / vx;
        const r2 = vy > 0 ? (cov * cov) / (vx * vy) : 0;
        out[i] = r2 >= thr ? (slope > 0 ? 1 : -1) : 0;
      }
      return out;
    }
    // SWING: last two confirmed pivot highs and lows; HH+HL up, LH+LL down.
    const k = cfg.swingReach ?? 3;
    let h1 = NaN, h2 = NaN, l1 = NaN, l2 = NaN;
    for (let i = 0; i < b.n; i += 1) {
      const p = i - k; // pivot candidate confirmed at close of bar i
      if (p >= k) {
        let isH = true, isL = true;
        for (let q = p - k; q <= p + k; q += 1) {
          if (q === p) continue;
          if (q < p ? b.h[q]! > b.h[p]! : b.h[q]! >= b.h[p]!) isH = false;
          if (q < p ? b.l[q]! < b.l[p]! : b.l[q]! <= b.l[p]!) isL = false;
        }
        if (isH) { h1 = h2; h2 = b.h[p]!; }
        if (isL) { l1 = l2; l2 = b.l[p]!; }
      }
      out[i] = h2 > h1 && l2 > l1 ? 1 : h2 < h1 && l2 < l1 ? -1 : 0;
    }
    return out;
  });
}

/** Combined trend per base candle. NONE = no trend read: every impulse leg is traded in its own direction. */
function trendFor(d: Data, cfg: Config): Int8Array {
  const key = `tf${cfg.base}${cfg.trend}${cfg.trendTf}${cfg.swingReach ?? 3}_${cfg.regN ?? 50}_${cfg.regR2 ?? 0.3}`;
  return cached(d, key, () => {
    const b = d.tf[cfg.base];
    const own = trendOn(d, cfg.base, cfg.trend, cfg);
    if (cfg.trendTf === "base") return own;
    const ht = HIGHER[cfg.base];
    const hb = d.tf[ht];
    const htr = trendOn(d, ht, cfg.trend, cfg);
    const out = new Int8Array(b.n);
    for (let j = 0; j < b.n; j += 1) {
      const hi = countLE(hb.end, b.end[j]!) - 1;
      const h = hi >= 0 ? htr[hi]! : 0;
      out[j] = cfg.trendTf === "higher" ? h : h === own[j] ? h : 0;
    }
    return out;
  });
}

/** Leg state per candle for one direction. dir = 1 bull on real prices, -1 bear on negated prices. */
function legs(d: Data, t: TF, zz: number, dir: 1 | -1) {
  const key = `leg${t}${zz}${dir}`;
  const A = cached(d, key + "A", () => new Float64Array(d.tf[t].n));
  const B = cached(d, key + "B", () => new Float64Array(d.tf[t].n));
  const C = cached(d, key + "C", () => new Float64Array(d.tf[t].n));
  const id = cached(d, key + "id", () => new Int32Array(d.tf[t].n));
  if (d.cache.has(key + "done")) return { A, B, C, id };
  const b = d.tf[t];
  const atr = atrOf(d, t);
  const hi = (i: number) => dir === 1 ? b.h[i]! : -b.l[i]!;
  const lo = (i: number) => dir === 1 ? b.l[i]! : -b.h[i]!;
  let a = lo(0), bb = hi(0), c = Infinity, leg = 0;
  for (let i = 0; i < b.n; i += 1) {
    if (lo(i) < a) { a = lo(i); bb = hi(i); c = Infinity; leg += 1; }
    else if (hi(i) > bb) {
      if (bb - c >= zz * atr[i]!) a = c;
      bb = hi(i); c = Infinity; leg += 1;
    } else c = Math.min(c, lo(i));
    A[i] = a; B[i] = bb; C[i] = c; id[i] = leg;
  }
  d.cache.set(key + "done", new Int8Array(1));
  return { A, B, C, id };
}

export type SimTrade = Trade & { hour: number; dow: number; atrPct: number; er: number; newsNext: number; newsPrev: number };

export function simulate(d: Data, cfg: Config, from = d.start, to = d.end): SimTrade[] {
  const b = d.tf[cfg.base];
  const atr = atrOf(d, cfg.base);
  const e21 = emaOf(d, cfg.base, 21);
  const trend = trendFor(d, cfg);
  const bull = legs(d, cfg.base, cfg.zz, 1), bear = legs(d, cfg.base, cfg.zz, -1);
  const m5s = d.m5Start[cfg.base];
  const a = d.m5.a;
  const f = cfg.filters;
  const atrPct = f?.atrPct ? atrPctOf(d, cfg.base) : null;
  const er = erOf(d, cfg.base);
  const out: SimTrade[] = [];
  const lastLeg = { 1: -1, [-1]: -1 } as Record<number, number>;
  const maxDepth = cfg.maxDepth ?? 1;
  let freeAt = 0; // first M5 index we may trade from
  const j0 = countLE(b.end, from - 1);
  const j1 = countLE(b.end, to - 1);
  for (let j = Math.max(j0, 1); j < j1 - 1; j += 1) {
    const k0 = m5s[j]!, k1 = m5s[j + 1]!;
    if (k0 < freeAt || k0 >= k1) continue;
    const tr = trend[j]!;
    // Directions to consider: the trend's, or with NONE both legs (deeper pullback first).
    const dirs: Array<1 | -1> = cfg.trend === "NONE" ? [1, -1] : tr === 0 ? [] : [tr as 1 | -1];
    const at = atr[j]!;
    if (!(at > 0)) continue;
    let best: null | { dir: 1 | -1; A: number; B: number; C: number; leg: number } = null;
    for (const dir of dirs) {
      const L = dir === 1 ? bull : bear;
      const A = L.A[j]!, B = L.B[j]!, C = L.C[j]!, leg = L.id[j]!;
      if (leg === lastLeg[dir]) continue;
      if (B - A < cfg.minImp * at) continue;
      const cand = { dir, A, B, C, leg };
      const depthOf = (x: typeof cand) => (x.B - Math.min(x.C, x.B)) / (x.B - x.A);
      if (!best || depthOf(cand) > depthOf(best)) best = cand;
    }
    if (!best) continue;
    const { dir, A, B, leg } = best;
    const s = dir; // price p in leg space = s * real price
    const close = s === 1 ? b.c[j]! : -b.c[j]!;
    const open = s === 1 ? b.o[j]! : -b.o[j]!;
    const high = s === 1 ? b.h[j]! : -b.l[j]!;
    const C = best.C === Infinity ? Infinity : best.C;
    const ema = s * e21[j]!;
    const depthNow = C === Infinity ? 0 : (B - C) / (B - A);
    if (depthNow >= maxDepth) continue;
    // Pullback level (leg space) and whether it has been reached.
    let level: number;
    if (cfg.pbMode === "FRACTION") level = B - cfg.depth * (B - A);
    else if (cfg.pbMode === "ATR") level = B - cfg.depth * at;
    else level = ema - cfg.depth * at;
    if (level <= A) continue;
    const reached = C !== Infinity && C <= level;

    // Filters at decision time.
    const tDec = b.end[j]!;
    if (f) {
      const dt = new Date(tDec);
      if (f.hours) { const h = dt.getUTCHours(); if (f.hours[0] <= f.hours[1] ? h < f.hours[0] || h >= f.hours[1] : h < f.hours[0] && h >= f.hours[1]) continue; }
      if (f.noDow?.includes(dt.getUTCDay())) continue;
      if (atrPct && (atrPct[j]! < f.atrPct![0] || atrPct[j]! > f.atrPct![1])) continue;
      if (f.minEr !== undefined && er[j]! < f.minEr) continue;
      if (f.newsBeforeMin !== undefined || f.newsAfterMin !== undefined) {
        const lo = countLE(d.news, tDec - (f.newsAfterMin ?? 0) * 60_000 - 1);
        const hi = countLE(d.news, tDec + (f.newsBeforeMin ?? 0) * 60_000);
        if (hi > lo) continue;
      }
    }

    // Order for the next base candle (leg space prices).
    let kind: "limit" | "stop" | "market";
    let px = 0;
    if (cfg.entry === "LIMIT") {
      if (reached || close <= level) continue;
      kind = "limit"; px = level;
    } else {
      if (!reached || close >= B) continue;
      if (cfg.entry === "CANDLE") { if (!(close > open)) continue; kind = "market"; }
      else if (cfg.entry === "RECLAIM") { if (!(close > open && close > ema)) continue; kind = "market"; }
      else if (cfg.entry === "BREAK") { kind = "stop"; px = high + 0.1 * PIP; }
      else {
        let h3 = high;
        for (let q = j - 2; q < j; q += 1) h3 = Math.max(h3, s === 1 ? b.h[q]! : -b.l[q]!);
        kind = "stop"; px = h3 + 0.1 * PIP;
      }
    }
    const long = (s === 1) !== !!cfg.mirror;
    const real = (p: number) => s * p;
    // Scan the next base candle's M5 bars for the fill (executable prices).
    let fill: number | null = null, fk = -1, intrabar = false;
    for (let k = k0; k < k1; k += 1) {
      const o = k * 9;
      const ask = (c: number) => a[o + 4 + c]!, bid = (c: number) => a[o + c]!;
      const midp = (c: number) => (a[o + c]! + a[o + 4 + c]!) / 2;
      if (kind === "market") {
        // Mirror trades fill at market the same way, opposite side.
        fill = cfg.mid ? midp(1) : long ? ask(1) + SLIP : bid(1) - SLIP; fk = k; break;
      }
      // Trigger on the side the order would execute on (leg direction, not mirror).
      const rp = real(px);
      if (kind === "limit") {
        const touched = s === 1 ? (cfg.mid ? midp(3) : ask(3)) <= rp : (cfg.mid ? midp(2) : bid(2)) >= rp;
        if (touched) {
          const oPx = s === 1 ? (cfg.mid ? midp(1) : ask(1)) : (cfg.mid ? midp(1) : bid(1));
          const legFill = s === 1 ? Math.min(oPx, rp) : Math.max(oPx, rp);
          // Mirror: enter the other way at that moment, at market on its own side.
          fill = !cfg.mirror || cfg.mid ? legFill : legFill + (long ? 1 : -1) * ((ask(4) - bid(4)) + SLIP);
          fk = k; intrabar = true; break;
        }
      } else {
        const touched = s === 1 ? (cfg.mid ? midp(2) : ask(2)) >= rp : (cfg.mid ? midp(3) : bid(3)) <= rp;
        if (touched) {
          const oPx = s === 1 ? (cfg.mid ? midp(1) : ask(1)) : (cfg.mid ? midp(1) : bid(1));
          const raw = s === 1 ? Math.max(oPx, rp) : Math.min(oPx, rp);
          fill = cfg.mid ? raw : !cfg.mirror ? raw + s * SLIP : raw + (long ? 1 : -1) * ((ask(4) - bid(4)) + SLIP);
          fk = k; intrabar = true; break;
        }
      }
    }
    if (fill === null) continue;
    // Stop and target, built in leg space from the entry the rule intended (fill in leg space).
    const fLeg = s * fill;
    const pbLow = Math.min(C === Infinity ? fLeg : C, kind === "limit" ? level : fLeg);
    let risk: number;
    if (cfg.stop === "ATR") risk = cfg.stopVal * at;
    else if (cfg.stop === "PIPS") risk = cfg.stopVal * PIP;
    else if (cfg.stop === "PB") risk = fLeg - (pbLow - cfg.stopVal * at);
    else risk = fLeg - (A - cfg.stopVal * at);
    if (cfg.stop !== "PIPS") risk = Math.max(risk, 5 * PIP);
    if (!(risk > 0) || risk > 6 * at) continue;
    let reward: number;
    if (cfg.tp === "RR") reward = cfg.tpVal * risk;
    else if (cfg.tp === "PIPS") reward = cfg.tpVal * PIP;
    else { reward = B - fLeg; if (reward < 0.5 * risk) continue; }
    // Leg-space stop/target → real; the mirror swaps them around the fill.
    const lsign = long ? 1 : -1;
    const stopPx = fill - lsign * risk;
    const targetPx = fill + lsign * reward;
    const ex = runPosition(d.m5, fk, long, fill, stopPx, targetPx, risk, intrabar, MAX_HOLD[cfg.base], to, !!cfg.mid);
    const ft = a[fk * 9]!;
    const dt = new Date(tDec);
    // Minutes to the next / since the last high-impact EUR or USD event (calendar covers 2013+).
    const ni = countLE(d.news, tDec);
    const newsNext = ni < d.news.length ? (d.news[ni]! - tDec) / 60_000 : Infinity;
    const newsPrev = ni > 0 ? (tDec - d.news[ni - 1]!) / 60_000 : Infinity;
    out.push({
      t: ft, year: new Date(ft).getUTCFullYear(), long, r: ex.r, out: ex.out, holdH: (ex.endT - ft) / 3_600_000,
      riskPips: risk / PIP, spreadPips: (a[fk * 9 + 8]! - a[fk * 9 + 4]!) / PIP,
      hour: dt.getUTCHours(), dow: dt.getUTCDay(), atrPct: atrPctOf(d, cfg.base)[j]!, er: er[j]!, newsNext, newsPrev,
    });
    lastLeg[dir] = leg;
    freeAt = countLE(a, ex.endT - 1, 9);
  }
  return out;
}
