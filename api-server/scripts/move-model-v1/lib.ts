/**
 * MOVE_MODEL — shared research library.
 *
 * Isolated, read-only research. This module never imports a collector,
 * execution adapter, paper-cycle, or production/direction strategy. Its only
 * job is to answer: "will EUR/USD make a meaningful (volatility-normalized)
 * move within the next N minutes?" — direction is deliberately NOT modelled.
 *
 * Everything here is causal: every feature at prediction time T is computed
 * from completed bars at or before T (plus the ECONOMIC CALENDAR, whose event
 * TIMES are published ahead of time and are therefore legitimately known at T;
 * only the actual released VALUE is withheld until release).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const PIP = 0.0001;
export const WARMUP = 240;

export type RawBar = {
  closeTime: string;
  open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};
export type Bar = RawBar & { t: number };
export type News = { time: number; currency: string; name: string; surprise: number };

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
export function loadBars(relative: string): Bar[] {
  const parsed = JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as { bars: RawBar[] };
  const map = new Map<number, Bar>();
  for (const raw of parsed.bars) { const t = Date.parse(raw.closeTime); if (Number.isFinite(t)) map.set(t, { ...raw, t }); }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function readHistoricalFile(relative: string) {
  try { return { text: readFileSync(path.join(ROOT, relative), "utf8"), source: relative }; }
  catch {
    const text = execFileSync("git", ["show", `master:${relative.replaceAll("\\", "/")}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { text, source: `master:${relative.replaceAll("\\", "/")}` };
  }
}
function parseNumber(raw: unknown): number | null {
  const s = String(raw ?? "").trim(); if (!s) return null;
  const m = /^(-?[\d,.]+)\s*([KMBT%]?)/i.exec(s); if (!m) return null;
  const n = Number(m[1]!.replaceAll(",", "")); if (!Number.isFinite(n)) return null;
  const mult = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[(m[2] ?? "").toUpperCase()] ?? 1;
  return n * mult;
}
function polarity(name: string) { return /unemploy|jobless|claims/i.test(name) ? -1 : 1; }
export function loadNews() {
  const files = [
    "api-server/research-v2/eurusd-ff-high-impact-aug2024-jul2025/events.json",
    "api-server/research-v2/eurusd-ff-high-impact-aug2025-jul2026/events.json",
  ];
  const sources: Array<{ source: string; sha256: string; rows: number }> = [];
  const events: News[] = [];
  for (const file of files) {
    const found = readHistoricalFile(file); const parsed = JSON.parse(found.text); const rows = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    sources.push({ source: found.source, sha256: sha(found.text), rows: rows.length });
    for (const e of rows) {
      const time = Date.parse(e.releaseTimeUtc ?? ""); if (!Number.isFinite(time)) continue;
      const actual = parseNumber(e.actual), forecast = parseNumber(e.forecast), previous = parseNumber(e.previous);
      const base = forecast ?? previous; const scale = Math.max(Math.abs(base ?? 0), Math.abs(previous ?? 0), 1e-9);
      const surprise = (actual != null && base != null) ? Math.tanh(2 * polarity(e.eventName ?? "") * (actual - base) / scale) : 0;
      events.push({ time, currency: e.currency ?? "", name: e.eventName ?? "", surprise });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, sources, coverageFrom: events[0]?.time ?? 0, coverageTo: events.at(-1)?.time ?? 0 };
}

// ---------------------------------------------------------------------------
// Rolling series & small helpers
// ---------------------------------------------------------------------------
function ema(values: number[], period: number) {
  const out = new Float64Array(values.length); const a = 2 / (period + 1);
  for (let i = 0; i < values.length; i += 1) out[i] = i ? a * values[i]! + (1 - a) * out[i - 1]! : values[i]!;
  return out;
}
function rollingAtr(bars: Bar[], period: number) {
  const out = new Float64Array(bars.length).fill(Number.NaN); const tr = new Float64Array(bars.length); let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const pc = i ? bars[i - 1]!.close : bars[i]!.close;
    tr[i] = Math.max(bars[i]!.high - bars[i]!.low, Math.abs(bars[i]!.high - pc), Math.abs(bars[i]!.low - pc));
    sum += tr[i]!; if (i >= period) sum -= tr[i - period]!; if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
export type Series = ReturnType<typeof prepareSeries>;
export function prepareSeries(bars: Bar[]) {
  const closes = bars.map((b) => b.close);
  return { closes, ema20: ema(closes, 20), ema50: ema(closes, 50), atr14: rollingAtr(bars, 14), atr56: rollingAtr(bars, 56) };
}
function efficiency(closes: number[], i: number, look: number) {
  const disp = Math.abs(closes[i]! - closes[i - look]!); let travel = 0;
  for (let c = i - look + 1; c <= i; c += 1) travel += Math.abs(closes[c]! - closes[c - 1]!);
  return travel ? disp / travel : 0;
}
function rangeStats(bars: Bar[], i: number, look: number, includeCurrent = true) {
  let hi = -Infinity, lo = Infinity; const end = includeCurrent ? i : i - 1;
  for (let c = end - look + 1; c <= end; c += 1) { hi = Math.max(hi, bars[c]!.high); lo = Math.min(lo, bars[c]!.low); }
  return { high: hi, low: lo, width: hi - lo };
}
function realizedStd(closes: number[], i: number, look: number) {
  let m = 0; for (let c = i - look + 1; c <= i; c += 1) m += Math.log(closes[c]! / closes[c - 1]!);
  m /= look; let v = 0; for (let c = i - look + 1; c <= i; c += 1) { const r = Math.log(closes[c]! / closes[c - 1]!); v += (r - m) ** 2; }
  return Math.sqrt(v / look);
}
function bollWidth(closes: number[], i: number, look: number) {
  let m = 0; for (let c = i - look + 1; c <= i; c += 1) m += closes[c]!; m /= look;
  let v = 0; for (let c = i - look + 1; c <= i; c += 1) v += (closes[c]! - m) ** 2;
  return m ? Math.sqrt(v / look) / m : 0;
}
function lastAtOrBefore(rows: Bar[], t: number) { let l = 0, h = rows.length; while (l < h) { const m = (l + h) >>> 1; rows[m]!.t <= t ? l = m + 1 : h = m; } return l - 1; }

// ---------------------------------------------------------------------------
// Feature definition (all direction-agnostic where possible)
// ---------------------------------------------------------------------------
export const FEATURES: Array<{ name: string; group: string }> = [
  { name: "abs_ret1", group: "momentum" }, { name: "abs_ret4", group: "momentum" }, { name: "abs_ret16", group: "momentum" },
  { name: "ret1_signed", group: "momentum" }, { name: "ret4_signed", group: "momentum" },
  { name: "atr_pips", group: "volatility" }, { name: "atr14_56", group: "volatility" },
  { name: "rstd16", group: "volatility" }, { name: "rstd64", group: "volatility" }, { name: "volofvol", group: "volatility" },
  { name: "range_atr", group: "range" }, { name: "avg_range8_atr", group: "range" },
  { name: "width16_atr", group: "range" }, { name: "width64_atr", group: "range" },
  { name: "eff8", group: "range" }, { name: "eff32", group: "range" }, { name: "boll_width20", group: "range" },
  { name: "body_ratio", group: "candle" }, { name: "wick_ratio", group: "candle" }, { name: "consec_abs", group: "candle" },
  { name: "range_pos32_abs", group: "location" }, { name: "dist_hi16_atr", group: "location" }, { name: "dist_lo16_atr", group: "location" },
  { name: "min_edge16_atr", group: "location" }, { name: "dist_hi64_atr", group: "location" }, { name: "dist_lo64_atr", group: "location" },
  { name: "hour_sin", group: "time" }, { name: "hour_cos", group: "time" }, { name: "dow_sin", group: "time" }, { name: "dow_cos", group: "time" },
  { name: "sess_asia", group: "time" }, { name: "sess_london", group: "time" }, { name: "sess_overlap", group: "time" }, { name: "sess_ny", group: "time" },
  { name: "h1_atr_ratio", group: "multitf" }, { name: "h1_absret4", group: "multitf" }, { name: "m5_rstd12", group: "multitf" }, { name: "m5_available", group: "multitf" },
  { name: "spread_atr", group: "spread" },
  { name: "news_available", group: "news" }, { name: "news_imminent", group: "news" }, { name: "mins_to_next", group: "news" },
  { name: "events_next120", group: "news" }, { name: "mins_since_last", group: "news" }, { name: "last_surprise_mag", group: "news" },
];
export const FEATURE_GROUPS = [...new Set(FEATURES.map((f) => f.group))];

function newsFeatures(events: News[], covFrom: number, covTo: number, t: number) {
  const available = t >= covFrom && t <= covTo ? 1 : 0;
  // binary search next / last
  let lo = 0, hi = events.length; while (lo < hi) { const m = (lo + hi) >>> 1; events[m]!.time <= t ? lo = m + 1 : hi = m; }
  const last = lo > 0 ? events[lo - 1]! : null; const next = lo < events.length ? events[lo]! : null;
  const minsToNext = next ? (next.time - t) / 60_000 : 720;
  const minsSince = last ? (t - last.time) / 60_000 : 720;
  let events120 = 0; for (let k = lo; k < events.length && events[k]!.time <= t + 120 * 60_000; k += 1) events120 += 1;
  return {
    news_available: available,
    news_imminent: available ? Math.exp(-Math.min(minsToNext, 720) / 30) : 0,
    mins_to_next: available ? Math.min(minsToNext, 720) / 720 : 1,
    events_next120: available ? Math.min(events120, 5) / 5 : 0,
    mins_since_last: available ? Math.min(minsSince, 720) / 720 : 1,
    last_surprise_mag: available && last ? Math.abs(last.surprise) : 0,
  };
}

export type Sample = {
  t: number; iso: string; day: string;
  x: number[];
  norm: number[]; // max excursion / instantaneous ATR14_T (per horizon)
  normSlow: number[]; // max excursion / SLOW vol scale (per horizon) — denominator cannot compress on the current bar
  excPips: number[]; // raw max excursion in pips (per horizon)
  contiguous: boolean[]; // whether the horizon window had no unexpected gap
  volRatio: number; // atr14/atr56 (raw, for regime bucketing)
  hourBucket: number; // 0..47 half-hour-of-day bucket (for the seasonal baseline)
  hour: number; session: string;
  newsAdjacent: boolean; newsAvailable: boolean;
};

export const HORIZONS = [
  { label: "15m", bars: 1 }, { label: "30m", bars: 2 }, { label: "60m", bars: 4 }, { label: "120m", bars: 8 },
] as const;
const MAX_H = 8;

/** Build every prediction sample with features + per-horizon normalized excursion labels. */
export function buildSamples(bars: Bar[], h1: Bar[], m5: Bar[], news: ReturnType<typeof loadNews>, from: number, to: number): Sample[] {
  const s = prepareSeries(bars); const h1s = prepareSeries(h1);
  const m5closes = m5.map((b) => b.close); // precompute once (was rebuilt per-sample — O(N*M))
  // SLOW vol scale: EMA(period 480 ≈ 5 trading days) of ATR14, so the denominator
  // reflects the recent typical range and does NOT compress on the current bar.
  const atr14Filled = Array.from(s.atr14, (v) => (Number.isFinite(v) ? v : 0));
  const atrSlow = ema(atr14Filled, 480);
  const out: Sample[] = [];
  const barMs = 15 * 60_000;
  for (let i = WARMUP; i < bars.length - MAX_H - 1; i += 1) {
    const t = bars[i]!.t; if (t < from || t >= to) continue;
    const atr = s.atr14[i]!; if (!Number.isFinite(atr) || atr <= 0) continue;
    const bar = bars[i]!; const close = bar.close;
    const range = bar.high - bar.low || atr; const body = bar.close - bar.open;
    const upper = bar.high - Math.max(bar.open, bar.close); const lower = Math.min(bar.open, bar.close) - bar.low;
    let consec = 0; const lastDir = Math.sign(s.closes[i]! - s.closes[i - 1]!);
    for (let c = i; c > i - 8; c -= 1) { const d = Math.sign(s.closes[c]! - s.closes[c - 1]!); if (!d || d !== lastDir) break; consec += d; }
    const r32 = rangeStats(bars, i, 32); const prior16 = rangeStats(bars, i, 16, false); const r64 = rangeStats(bars, i, 64);
    let avgRange8 = 0; for (let c = i - 7; c <= i; c += 1) avgRange8 += bars[c]!.high - bars[c]!.low; avgRange8 /= 8;
    const date = new Date(t); const hour = date.getUTCHours() + date.getUTCMinutes() / 60; const dow = date.getUTCDay();
    const session = hour < 6 ? "ASIA" : hour < 11 ? "LONDON" : hour < 13 ? "OVERLAP" : hour < 17 ? "NEW_YORK" : "ASIA";
    const spread = bars[i + 1]!.askOpen - bars[i + 1]!.bidOpen;

    // multi-timeframe
    const hi = lastAtOrBefore(h1, t); const h1atr = hi >= 56 ? h1s.atr14[hi]! : NaN;
    const h1_atr_ratio = hi >= 56 && Number.isFinite(h1s.atr56[hi]!) && h1s.atr56[hi]! > 0 ? h1s.atr14[hi]! / h1s.atr56[hi]! : 1;
    const h1_absret4 = hi >= 4 && Number.isFinite(h1atr) && h1atr > 0 ? Math.abs(Math.log(h1[hi]!.close / h1[hi - 4]!.close)) / (h1atr / h1[hi]!.close) : 0;
    const mi = lastAtOrBefore(m5, t); const m5ok = mi >= 20 && m5[mi]!.t >= t - barMs; // m5 must be recent (coverage)
    const m5_rstd12 = m5ok ? realizedStd(m5closes, mi, 12) / (atr / close) : 0;

    const nf = newsFeatures(news.events, news.coverageFrom, news.coverageTo, t);

    const minEdge16 = Math.min(Math.abs(bar.close - prior16.high), Math.abs(bar.close - prior16.low));
    const x: number[] = [
      Math.abs(s.closes[i]! - s.closes[i - 1]!) / atr, Math.abs(s.closes[i]! - s.closes[i - 4]!) / atr, Math.abs(s.closes[i]! - s.closes[i - 16]!) / atr,
      (s.closes[i]! - s.closes[i - 1]!) / atr, (s.closes[i]! - s.closes[i - 4]!) / atr,
      atr / PIP, atr / s.atr56[i]!,
      realizedStd(s.closes, i, 16) / (atr / close), realizedStd(s.closes, i, 64) / (atr / close), realizedStd(s.closes, i, 16) / Math.max(1e-9, realizedStd(s.closes, i, 64)),
      range / atr, avgRange8 / atr, rangeStats(bars, i, 16).width / atr, r64.width / atr,
      efficiency(s.closes, i, 8), efficiency(s.closes, i, 32), bollWidth(s.closes, i, 20),
      Math.abs(body) / range, (upper + lower) / range, Math.abs(consec) / 8,
      Math.abs(r32.width ? 2 * (bar.close - r32.low) / r32.width - 1 : 0), Math.abs(bar.close - prior16.high) / atr, Math.abs(bar.close - prior16.low) / atr,
      minEdge16 / atr, Math.abs(bar.close - r64.high) / atr, Math.abs(bar.close - r64.low) / atr,
      Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24), Math.sin(2 * Math.PI * dow / 7), Math.cos(2 * Math.PI * dow / 7),
      hour < 6 ? 1 : 0, hour >= 6 && hour < 11 ? 1 : 0, hour >= 11 && hour < 13 ? 1 : 0, hour >= 13 && hour < 17 ? 1 : 0,
      h1_atr_ratio, h1_absret4, m5_rstd12, m5ok ? 1 : 0,
      spread / atr,
      nf.news_available, nf.news_imminent, nf.mins_to_next, nf.events_next120, nf.mins_since_last, nf.last_surprise_mag,
    ];
    if (x.length !== FEATURES.length) throw new Error(`feature width ${x.length} != ${FEATURES.length}`);
    if (!x.every(Number.isFinite)) continue;

    // labels: max excursion per horizon under three scales + contiguity guard
    const norm: number[] = []; const normSlow: number[] = []; const excPips: number[] = []; const contiguous: boolean[] = [];
    const slow = Math.max(atrSlow[i]!, 1e-9);
    for (const h of HORIZONS) {
      let maxHigh = -Infinity, minLow = Infinity; let ok = true;
      for (let j = i + 1; j <= i + h.bars; j += 1) {
        if (bars[j]!.t - bars[j - 1]!.t > barMs * 1.5) ok = false;
        maxHigh = Math.max(maxHigh, bars[j]!.high); minLow = Math.min(minLow, bars[j]!.low);
      }
      const excursion = Math.max(maxHigh - close, close - minLow);
      norm.push(excursion / atr); normSlow.push(excursion / slow); excPips.push(excursion / PIP); contiguous.push(ok);
    }
    out.push({
      t, iso: new Date(t).toISOString(), day: new Date(t).toISOString().slice(0, 10),
      x, norm, normSlow, excPips, contiguous, volRatio: atr / s.atr56[i]!,
      hourBucket: date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0), hour, session,
      newsAdjacent: nf.news_available === 1 && (nf.mins_to_next * 720 <= 60 || nf.mins_since_last * 720 <= 60),
      newsAvailable: nf.news_available === 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
function standardize(rows: number[][]) {
  const w = rows[0]!.length; const mean = new Array(w).fill(0); const std = new Array(w).fill(0);
  for (const r of rows) for (let i = 0; i < w; i += 1) mean[i] += r[i]!;
  for (let i = 0; i < w; i += 1) mean[i] /= Math.max(1, rows.length);
  for (const r of rows) for (let i = 0; i < w; i += 1) std[i] += (r[i]! - mean[i]) ** 2;
  for (let i = 0; i < w; i += 1) std[i] = Math.sqrt(std[i] / Math.max(1, rows.length)) || 1;
  return { mean, std };
}
const sigmoid = (v: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, v))));

export type Logistic = { mean: number[]; std: number[]; w: number[]; b: number };
export function trainLogistic(X: number[][], y: number[], opts: { iters?: number; lr?: number; l2?: number } = {}): Logistic {
  const iters = opts.iters ?? 200, lr = opts.lr ?? 0.3, l2 = opts.l2 ?? 1e-3;
  const { mean, std } = standardize(X); const n = X.length, w = X[0]!.length;
  const Z = X.map((r) => r.map((v, i) => (v - mean[i]!) / std[i]!));
  const weights = new Array(w).fill(0); let bias = 0;
  // class balancing weights
  const pos = y.reduce((a, b) => a + b, 0) || 1; const neg = n - pos || 1;
  const wPos = n / (2 * pos), wNeg = n / (2 * neg);
  for (let it = 0; it < iters; it += 1) {
    const gw = new Array(w).fill(0); let gb = 0;
    for (let k = 0; k < n; k += 1) {
      const p = sigmoid(Z[k]!.reduce((a, v, i) => a + v * weights[i]!, bias));
      const cw = y[k]! ? wPos : wNeg; const err = (p - y[k]!) * cw;
      const zk = Z[k]!; for (let i = 0; i < w; i += 1) gw[i]! += err * zk[i]!; gb += err;
    }
    for (let i = 0; i < w; i += 1) weights[i]! -= lr * (gw[i]! / n + l2 * weights[i]!); bias -= lr * (gb / n);
  }
  return { mean, std, w: weights, b: bias };
}
export function predictLogistic(m: Logistic, x: number[]) {
  return sigmoid(x.reduce((a, v, i) => a + ((v - m.mean[i]!) / m.std[i]!) * m.w[i]!, m.b));
}

// Histogram gradient-boosted trees (logistic loss), pure JS, deterministic.
export type GBT = { base: number; trees: Tree[]; edges: number[][]; lr: number };
type Tree = { feat: number[]; thr: number[]; left: number[]; right: number[]; leaf: number[] }; // arrays indexed by node
export function trainGBT(X: number[][], y: number[], opts: { rounds?: number; depth?: number; lr?: number; bins?: number; lambda?: number; minChild?: number } = {}): GBT {
  const rounds = opts.rounds ?? 120, depth = opts.depth ?? 3, lr = opts.lr ?? 0.1, bins = opts.bins ?? 32, lambda = opts.lambda ?? 1, minChild = opts.minChild ?? 30;
  const n = X.length, F = X[0]!.length;
  // quantile bin edges per feature
  const edges: number[][] = [];
  for (let f = 0; f < F; f += 1) {
    const col = X.map((r) => r[f]!).sort((a, b) => a - b); const e: number[] = [];
    for (let q = 1; q < bins; q += 1) e.push(col[Math.floor(q / bins * (n - 1))]!);
    edges.push([...new Set(e)]);
  }
  const binned: Uint8Array[] = edges.map((e, f) => { const a = new Uint8Array(n); for (let k = 0; k < n; k += 1) { let b = 0; const v = X[k]![f]!; while (b < e.length && v > e[b]!) b += 1; a[k] = b; } return a; });
  const pos = y.reduce((a, b) => a + b, 0); const base = Math.log((pos + 1) / (n - pos + 1));
  const F0 = new Float64Array(n).fill(base); const trees: Tree[] = [];
  for (let r = 0; r < rounds; r += 1) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let k = 0; k < n; k += 1) { const p = sigmoid(F0[k]!); g[k] = p - y[k]!; h[k] = Math.max(p * (1 - p), 1e-6); }
    // grow one tree; nodes stored as index arrays
    const feat: number[] = [], thr: number[] = [], left: number[] = [], right: number[] = [], leaf: number[] = [];
    const build = (rows: number[]): number => {
      const id = feat.length; feat.push(-1); thr.push(0); left.push(-1); right.push(-1); leaf.push(0);
      let G = 0, H = 0; for (const k of rows) { G += g[k]!; H += h[k]!; }
      leaf[id] = -G / (H + lambda);
      return id;
    };
    type Frame = { id: number; rows: number[]; d: number };
    const allRows = [...Array(n).keys()];
    const root = build(allRows);
    const stack: Frame[] = [{ id: root, rows: allRows, d: 0 }];
    while (stack.length) {
      const { id, rows, d } = stack.pop()!;
      if (d >= depth || rows.length < 2 * minChild) continue;
      let G = 0, H = 0; for (const k of rows) { G += g[k]!; H += h[k]!; }
      const parent = G * G / (H + lambda);
      let bestGain = 1e-9, bestF = -1, bestBin = -1;
      for (let f = 0; f < F; f += 1) {
        const nb = edges[f]!.length + 1; const hg = new Float64Array(nb), hh = new Float64Array(nb); const hc = new Int32Array(nb);
        const bf = binned[f]!; for (const k of rows) { const b = bf[k]!; hg[b]! += g[k]!; hh[b]! += h[k]!; hc[b]! += 1; }
        let GL = 0, HL = 0, cL = 0;
        for (let b = 0; b < nb - 1; b += 1) {
          GL += hg[b]!; HL += hh[b]!; cL += hc[b]!; const cR = rows.length - cL; if (cL < minChild || cR < minChild) continue;
          const GR = G - GL, HR = H - HL; const gain = GL * GL / (HL + lambda) + GR * GR / (HR + lambda) - parent;
          if (gain > bestGain) { bestGain = gain; bestF = f; bestBin = b; }
        }
      }
      if (bestF < 0) continue;
      const threshold = edges[bestF]![bestBin]!; const lr2: number[] = [], rr: number[] = [];
      const bf = binned[bestF]!; for (const k of rows) (bf[k]! <= bestBin ? lr2 : rr).push(k);
      feat[id] = bestF; thr[id] = threshold;
      const li = build(lr2), ri = build(rr); left[id] = li; right[id] = ri;
      stack.push({ id: li, rows: lr2, d: d + 1 }, { id: ri, rows: rr, d: d + 1 });
    }
    // apply: traverse with raw-value thresholds
    for (let k = 0; k < n; k += 1) {
      let node = root; while (feat[node]! >= 0) node = X[k]![feat[node]!]! <= thr[node]! ? left[node]! : right[node]!;
      F0[k]! += lr * leaf[node]!;
    }
    trees.push({ feat, thr, left, right, leaf });
  }
  return { base, trees, edges, lr };
}
export function predictGBT(m: GBT, x: number[]) {
  let f = m.base;
  for (const t of m.trees) { let node = 0; while (t.feat[node]! >= 0) node = x[t.feat[node]!]! <= t.thr[node]! ? t.left[node]! : t.right[node]!; f += m.lr * t.leaf[node]!; }
  return sigmoid(f);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export type Metrics = {
  n: number; posRate: number; threshold05: { tp: number; fp: number; tn: number; fn: number };
  accuracy: number; moveRecall: number; noMoveRecall: number; precision: number; recall: number; f1: number;
  auc: number; prauc: number; brier: number;
};
export function evaluate(probs: number[], y: number[]): Metrics {
  const n = probs.length; let tp = 0, fp = 0, tn = 0, fn = 0, brier = 0;
  for (let k = 0; k < n; k += 1) {
    const pred = probs[k]! >= 0.5 ? 1 : 0; brier += (probs[k]! - y[k]!) ** 2;
    if (y[k]! && pred) tp += 1; else if (!y[k]! && pred) fp += 1; else if (!y[k]! && !pred) tn += 1; else fn += 1;
  }
  const pos = tp + fn, neg = tn + fp;
  // AUC via rank sum (Mann-Whitney)
  const idx = probs.map((p, i) => [p, y[i]!] as [number, number]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0; for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j]![0] === idx[i]![0]) j += 1; const avgRank = (i + j + 1) / 2; for (let k = i; k < j; k += 1) if (idx[k]![1] === 1) rankSum += avgRank; i = j; }
  const auc = pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : 0.5;
  // PR-AUC via sorted-descending thresholds
  const desc = probs.map((p, i) => [p, y[i]!] as [number, number]).sort((a, b) => b[0] - a[0]);
  let ctp = 0, cfp = 0; let prauc = 0; let prevRecall = 0, prevPrec = 1;
  for (let i = 0; i < desc.length;) { let j = i; while (j < desc.length && desc[j]![0] === desc[i]![0]) j += 1; for (let k = i; k < j; k += 1) desc[k]![1] === 1 ? ctp += 1 : cfp += 1; const recall = pos ? ctp / pos : 0; const prec = (ctp + cfp) ? ctp / (ctp + cfp) : 1; prauc += (recall - prevRecall) * (prec + prevPrec) / 2; prevRecall = recall; prevPrec = prec; i = j; }
  const precision = (tp + fp) ? tp / (tp + fp) : 0; const recall = pos ? tp / pos : 0;
  return {
    n, posRate: pos / n, threshold05: { tp, fp, tn, fn },
    accuracy: (tp + tn) / n, moveRecall: pos ? tp / pos : 0, noMoveRecall: neg ? tn / neg : 0,
    precision, recall, f1: (precision + recall) ? 2 * precision * recall / (precision + recall) : 0,
    auc, prauc, brier: brier / n,
  };
}
export function calibration(probs: number[], y: number[], nbins = 10) {
  const bins = Array.from({ length: nbins }, () => ({ sum: 0, count: 0, pos: 0 }));
  for (let k = 0; k < probs.length; k += 1) { const b = Math.min(nbins - 1, Math.floor(probs[k]! * nbins)); bins[b]!.sum += probs[k]!; bins[b]!.count += 1; bins[b]!.pos += y[k]!; }
  return bins.map((b, i) => ({ bin: `${(i / nbins).toFixed(1)}-${((i + 1) / nbins).toFixed(1)}`, predicted: b.count ? b.sum / b.count : 0, actual: b.count ? b.pos / b.count : 0, count: b.count }));
}

export const round = (v: unknown): unknown => typeof v === "number" ? (Number.isFinite(v) ? Number(v.toFixed(6)) : null) : Array.isArray(v) ? v.map(round) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v;
export const csv = (rows: Record<string, unknown>[]) => {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const q = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [keys.map(q).join(","), ...rows.map((r) => keys.map((k) => q(r[k])).join(","))].join("\n") + "\n";
};
