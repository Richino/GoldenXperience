// Shared execution + metrics for the TrendPullback V2 research (EUR/USD).
//
// Execution is on OANDA M5 bid/ask bars:
//   long entry at ASK, long exit at BID; short entry at BID, short exit at ASK.
// Market entries, stop-order entries and stop-loss exits pay SLIP on top of the
// quoted price (they are market orders at the broker). Limit entries and
// take-profits fill at the limit price, or better when a bar gaps through it.
// When one M5 bar touches both the stop and the target, the stop wins.
// On the bar a limit/stop order fills, the stop can be hit but the target cannot
// (we do not know whether the high came before the fill).
// OANDA standard accounts are spread-only: no commission. Financing (swap) is not modelled.
import fs from "node:fs";

export const PIP = 0.0001;
export const SLIP = 0.2 * PIP;

export type Bars = { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; end: Float64Array; n: number };

export function loadMid(dir: string, gran: "M15" | "H1" | "H4" | "D"): Bars {
  const ms = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D: 86_400_000 }[gran];
  const rows = JSON.parse(fs.readFileSync(`${dir}/EUR_USD_${gran}.json`, "utf8")) as number[][];
  const n = rows.length;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), end: new Float64Array(n), n };
  rows.forEach(([t, o, h, l, c], i) => { b.t[i] = t!; b.o[i] = o!; b.h[i] = h!; b.l[i] = l!; b.c[i] = c!; b.end[i] = t! + ms; });
  return b;
}

/** M5 bid/ask: cols 0 t, 1 bo, 2 bh, 3 bl, 4 bc, 5 ao, 6 ah, 7 al, 8 ac. */
export type M5 = { a: Float64Array; n: number };
export function loadM5(dir: string): M5 {
  const buf = fs.readFileSync(`${dir}/EUR_USD_M5BA.bin`);
  const a = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  return { a, n: a.length / 9 };
}

/** Number of items in sorted `arr` (stride) that are <= x. */
export function countLE(arr: ArrayLike<number>, x: number, stride = 1) {
  let lo = 0, hi = Math.floor(arr.length / stride);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride]! <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export type Exit = { r: number; out: "SL" | "TP" | "time" | "end"; endT: number; px: number };

/**
 * Walk M5 bars from `i` with a filled position. `fillBarIntrabar` = the order
 * filled inside bar i (limit/stop order), so the target cannot fill on bar i.
 * Returns R relative to riskDist on executable prices.
 */
export function runPosition(m5: M5, i: number, long: boolean, fill: number, stop: number, target: number | null,
  riskDist: number, fillBarIntrabar: boolean, maxHoldMs: number, endMs: number, mid = false): Exit {
  const a = m5.a;
  const t0 = a[i * 9]!;
  // Exit side: a long closes on the bid (cols 1-4), a short on the ask (5-8); `mid` averages them, no slippage.
  const px = (b: number, col: number) => mid ? (a[b + col]! + a[b + col + 4]!) / 2 : a[b + col + (long ? 0 : 4)]!;
  const slip = mid ? 0 : SLIP;
  for (let k = i; k < m5.n; k += 1) {
    const b = k * 9;
    const t = a[b]!;
    if (t >= endMs) {
      const p = px((k - 1) * 9, 4);
      return { r: (long ? p - fill : fill - p) / riskDist, out: "end", endT: t, px: p };
    }
    const o = px(b, 1), h = px(b, 2), l = px(b, 3), c = px(b, 4);
    const intrabar = k === i && fillBarIntrabar;
    const open = intrabar ? fill : o;
    if (long ? l <= stop : h >= stop) {
      const px = long ? Math.min(open, stop) - slip : Math.max(open, stop) + slip;
      return { r: (long ? px - fill : fill - px) / riskDist, out: "SL", endT: t, px };
    }
    if (target !== null && !intrabar && (long ? h >= target : l <= target)) {
      const px = long ? Math.max(open, target) : Math.min(open, target);
      return { r: (long ? px - fill : fill - px) / riskDist, out: "TP", endT: t, px };
    }
    if (t - t0 >= maxHoldMs) return { r: (long ? c - fill : fill - c) / riskDist, out: "time", endT: t + 300_000, px: c };
  }
  const k = m5.n - 1;
  const p = px(k * 9, 4);
  return { r: (long ? p - fill : fill - p) / riskDist, out: "end", endT: a[k * 9]!, px: p };
}

export type Trade = { t: number; year: number; long: boolean; r: number; out: string; holdH: number; riskPips: number; spreadPips: number; [k: string]: unknown };

export type Summary = {
  n: number; wins: number; losses: number; winPct: number; avgWin: number; avgLoss: number; expR: number;
  pf: number; totalR: number; maxDD: number; maxLoseStreak: number; perYear: number; ci95lo: number; tstat: number;
};

export function summarize(list: Trade[], years?: number): Summary {
  const n = list.length;
  if (!n) return { n: 0, wins: 0, losses: 0, winPct: 0, avgWin: 0, avgLoss: 0, expR: 0, pf: 0, totalR: 0, maxDD: 0, maxLoseStreak: 0, perYear: 0, ci95lo: 0, tstat: 0 };
  const sorted = [...list].sort((x, y) => x.t - y.t);
  let total = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0, gw = 0, gl = 0, nw = 0;
  for (const x of sorted) {
    total += x.r;
    peak = Math.max(peak, total);
    dd = Math.max(dd, peak - total);
    if (x.r > 0) { nw += 1; gw += x.r; streak = 0; } else { gl -= x.r; streak += 1; maxStreak = Math.max(maxStreak, streak); }
  }
  const mean = total / n;
  const sd = Math.sqrt(sorted.reduce((s, x) => s + (x.r - mean) ** 2, 0) / Math.max(1, n - 1));
  const span = years ?? Math.max(1, (sorted.at(-1)!.t - sorted[0]!.t) / (365.25 * 86_400_000));
  return {
    n, wins: nw, losses: n - nw, winPct: +(100 * nw / n).toFixed(1),
    avgWin: nw ? +(gw / nw).toFixed(3) : 0, avgLoss: n - nw ? +(-gl / (n - nw)).toFixed(3) : 0,
    expR: +mean.toFixed(4), pf: +(gw / Math.max(gl, 1e-9)).toFixed(3), totalR: +total.toFixed(1),
    maxDD: +dd.toFixed(1), maxLoseStreak: maxStreak, perYear: +(n / span).toFixed(1),
    ci95lo: +(mean - 1.96 * sd / Math.sqrt(n)).toFixed(4), tstat: +(sd > 0 ? mean / sd * Math.sqrt(n) : 0).toFixed(2),
  };
}

export function byYear(list: Trade[], from: number, to: number) {
  const rows: Array<{ year: number; n: number; winPct: number; expR: number; totalR: number; pf: number; maxDD: number }> = [];
  for (let y = from; y <= to; y += 1) {
    const s = summarize(list.filter((x) => x.year === y), 1);
    rows.push({ year: y, n: s.n, winPct: s.winPct, expR: s.expR, totalR: s.totalR, pf: s.pf, maxDD: s.maxDD });
  }
  return rows;
}
