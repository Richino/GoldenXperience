/**
 * DIRECTION_MODEL — shared research library.
 *
 * Question: once EUR/USD is (about to be) making a meaningful move, can we
 * predict UP vs DOWN from information available BEFORE the move?
 *
 * MOVE_MODEL is FROZEN. This module imports MOVE_MODEL's frozen data loaders,
 * feature/label definitions and model recipe from ../move-model-v1/lib.js and
 * NEVER modifies, retrains for optimization, or replaces it. The frozen MOVE
 * recipe is re-run ONLY to emit causal out-of-sample MOVE probabilities that
 * DIRECTION_MODEL consumes as a feature and as a selection filter.
 *
 * Everything is causal: features at T use only completed bars <= T; the economic
 * calendar's event TIMES are known ahead, only released VALUES are withheld.
 */
import {
  HORIZONS, PIP, WARMUP, buildSamples, loadBars, loadNews, prepareSeries,
  predictGBT, trainGBT, type Bar, type News, type Sample, type Series,
} from "../move-model-v1/lib.js";

// Frozen MOVE_MODEL primary thresholds (ATR units), read from
// research-v2/MOVE_MODEL/RESULTS.json — treated as immutable here.
export const FROZEN_MOVE_THRESHOLD = [0.75, 1, 1.5, 2] as const;
export { HORIZONS, PIP, WARMUP, buildSamples, loadBars, loadNews, prepareSeries };
export type { Bar, News, Sample, Series };

const barMs = 15 * 60_000;

function rangeStats(bars: Bar[], i: number, look: number, includeCurrent = true) {
  let hi = -Infinity, lo = Infinity; const end = includeCurrent ? i : i - 1;
  for (let c = end - look + 1; c <= end; c += 1) { hi = Math.max(hi, bars[c]!.high); lo = Math.min(lo, bars[c]!.low); }
  return { high: hi, low: lo, width: hi - lo };
}
function lastAtOrBefore(rows: Bar[], t: number) { let l = 0, h = rows.length; while (l < h) { const m = (l + h) >>> 1; rows[m]!.t <= t ? l = m + 1 : h = m; } return l - 1; }
function slope(a: Float64Array, i: number, lag: number, atr: number) { return i >= lag ? (a[i]! - a[i - lag]!) / atr : 0; }

// ---------------------------------------------------------------------------
// Signed directional feature set
// ---------------------------------------------------------------------------
export const DIR_FEATURES: Array<{ name: string; group: string }> = [
  // trend
  { name: "close_ema20", group: "trend" }, { name: "close_ema50", group: "trend" },
  { name: "ema20_ema50", group: "trend" }, { name: "ema20_slope4", group: "trend" }, { name: "ema50_slope16", group: "trend" },
  // momentum
  { name: "ret1", group: "momentum" }, { name: "ret4", group: "momentum" }, { name: "ret16", group: "momentum" }, { name: "ret48", group: "momentum" }, { name: "consecutive", group: "momentum" },
  // structure
  { name: "range_pos32", group: "structure" }, { name: "range_pos64", group: "structure" },
  { name: "dist_prior16_high", group: "structure" }, { name: "dist_prior16_low", group: "structure" },
  { name: "breakout_pressure", group: "structure" },
  // volatility (context)
  { name: "atr14_56", group: "volatility" }, { name: "range_atr", group: "volatility" }, { name: "body_signed", group: "volatility" }, { name: "wick_skew", group: "volatility" },
  // multi-timeframe
  { name: "h1_ret4", group: "multitf" }, { name: "h1_ema20_50", group: "multitf" }, { name: "m5_ret6", group: "multitf" },
  // time
  { name: "hour_sin", group: "time" }, { name: "hour_cos", group: "time" }, { name: "sess_asia", group: "time" }, { name: "sess_london", group: "time" }, { name: "sess_overlap", group: "time" }, { name: "sess_ny", group: "time" },
  // news (SIGNED by currency: +EUR bullish / -USD bullish)
  { name: "news_signed_recent", group: "news" }, { name: "news_imminent", group: "news" },
  // liquidity
  { name: "spread_atr", group: "liquidity" },
  // MOVE_MODEL confidence (horizon-matched); appended last at model-build time
  { name: "move_prob", group: "move_conf" },
];
export const DIR_GROUPS = [...new Set(DIR_FEATURES.map((f) => f.group))];

function signedNews(events: News[], t: number) {
  // last event <= t, signed by currency (EUR:+1, USD:-1) * surprise; imminent = exp(-minsToNext/30)
  let lo = 0, hi = events.length; while (lo < hi) { const m = (lo + hi) >>> 1; events[m]!.time <= t ? lo = m + 1 : hi = m; }
  const last = lo > 0 ? events[lo - 1]! : null; const next = lo < events.length ? events[lo]! : null;
  const cur = last ? (last.currency === "EUR" ? 1 : last.currency === "USD" ? -1 : 0) : 0;
  const ageH = last ? (t - last.time) / 3_600_000 : 99; const decay = Math.pow(0.5, ageH / 2);
  const signed = last ? cur * last.surprise * decay : 0;
  const minsToNext = next ? (next.time - t) / 60_000 : 720;
  return { signed, imminent: Math.exp(-Math.min(minsToNext, 720) / 30) };
}

/** Signed feature row + UP/DOWN labels + ground-truth MOVE flags for one bar. */
export type DirRecord = {
  t: number; iso: string;
  dirX: number[]; // signed features WITHOUT move_prob (appended per-horizon later)
  moveProb: number[]; // frozen MOVE_MODEL OOS probability per horizon (NaN if unavailable)
  upLabel: boolean[]; // per horizon: max excursion was to the UP side
  moveGT: boolean[]; // per horizon: ground-truth meaningful move (frozen threshold)
  netUp: boolean[]; // per horizon: net displacement (close_{T+H} > close_T) — robustness label
  contiguous: boolean[];
  session: string; volRatio: number; trendRegime: string; hourBucket: number;
  newsAdjacent: boolean; newsAvailable: boolean;
};

export function buildDirectionRecords(bars: Bar[], h1: Bar[], m5: Bar[], news: ReturnType<typeof loadNews>, moveSamples: Sample[], moveProbByT: Map<number, number[]>): DirRecord[] {
  const s = prepareSeries(bars); const h1s = prepareSeries(h1);
  const m5closes = m5.map((b) => b.close);
  const tIndex = new Map<number, number>(); for (let i = 0; i < bars.length; i += 1) tIndex.set(bars[i]!.t, i);
  const out: DirRecord[] = [];
  for (const ms of moveSamples) {
    const i = tIndex.get(ms.t); if (i == null || i < WARMUP) continue;
    const atr = s.atr14[i]!; if (!Number.isFinite(atr) || atr <= 0) continue;
    const bar = bars[i]!; const close = bar.close;
    const r32 = rangeStats(bars, i, 32); const r64 = rangeStats(bars, i, 64); const prior16 = rangeStats(bars, i, 16, false);
    let consec = 0; const lastDir = Math.sign(s.closes[i]! - s.closes[i - 1]!);
    for (let c = i; c > i - 8; c -= 1) { const d = Math.sign(s.closes[c]! - s.closes[c - 1]!); if (!d || d !== lastDir) break; consec += d; }
    const body = bar.close - bar.open; const upper = bar.high - Math.max(bar.open, bar.close); const lower = Math.min(bar.open, bar.close) - bar.low;
    const date = new Date(ms.t); const hour = date.getUTCHours() + date.getUTCMinutes() / 60; const dow = date.getUTCDay();
    const spread = bars[i + 1]!.askOpen - bars[i + 1]!.bidOpen;
    const hi = lastAtOrBefore(h1, ms.t); const h1atr = hi >= 56 && Number.isFinite(h1s.atr14[hi]!) ? h1s.atr14[hi]! : NaN;
    const h1_ret4 = hi >= 4 && Number.isFinite(h1atr) && h1atr > 0 ? (h1[hi]!.close - h1[hi - 4]!.close) / h1atr : 0;
    const h1_ema = hi >= 50 && Number.isFinite(h1atr) && h1atr > 0 ? (h1s.ema20[hi]! - h1s.ema50[hi]!) / h1atr : 0;
    const mi = lastAtOrBefore(m5, ms.t); const m5ok = mi >= 6 && m5[mi]!.t >= ms.t - barMs;
    const m5_ret6 = m5ok ? (m5closes[mi]! - m5closes[mi - 6]!) / atr : 0;
    const nf = signedNews(news.events, ms.t);

    const dirX = [
      (close - s.ema20[i]!) / atr, (close - s.ema50[i]!) / atr, (s.ema20[i]! - s.ema50[i]!) / atr, slope(s.ema20, i, 4, atr), slope(s.ema50, i, 16, atr),
      (s.closes[i]! - s.closes[i - 1]!) / atr, (s.closes[i]! - s.closes[i - 4]!) / atr, (s.closes[i]! - s.closes[i - 16]!) / atr, (s.closes[i]! - s.closes[i - 48]!) / atr, consec / 8,
      r32.width ? 2 * (close - r32.low) / r32.width - 1 : 0, r64.width ? 2 * (close - r64.low) / r64.width - 1 : 0,
      (close - prior16.high) / atr, (close - prior16.low) / atr, (close - (r64.high + r64.low) / 2) / atr,
      atr / s.atr56[i]!, (bar.high - bar.low) / atr, body / atr, (lower - upper) / atr,
      h1_ret4, h1_ema, m5_ret6,
      Math.sin(2 * Math.PI * hour / 24), Math.cos(2 * Math.PI * hour / 24),
      hour < 6 ? 1 : 0, hour >= 6 && hour < 11 ? 1 : 0, hour >= 11 && hour < 13 ? 1 : 0, hour >= 13 && hour < 17 ? 1 : 0,
      nf.signed, nf.imminent,
      spread / atr,
    ];
    if (dirX.length !== DIR_FEATURES.length - 1) throw new Error(`dirX width ${dirX.length} != ${DIR_FEATURES.length - 1}`);
    if (!dirX.every(Number.isFinite)) continue;

    // per-horizon UP/DOWN (side of the larger excursion) + net displacement + move GT
    const upLabel: boolean[] = [], moveGT: boolean[] = [], netUp: boolean[] = [];
    for (let hIdx = 0; hIdx < HORIZONS.length; hIdx += 1) {
      const H = HORIZONS[hIdx]!.bars; let maxHigh = -Infinity, minLow = Infinity;
      for (let j = i + 1; j <= i + H; j += 1) { maxHigh = Math.max(maxHigh, bars[j]!.high); minLow = Math.min(minLow, bars[j]!.low); }
      const up = maxHigh - close, down = close - minLow;
      upLabel.push(up >= down);
      netUp.push(bars[i + H]!.close > close);
      moveGT.push(ms.norm[hIdx]! >= FROZEN_MOVE_THRESHOLD[hIdx]!);
    }
    const trendMag = (s.ema20[i]! - s.ema50[i]!) / atr;
    out.push({
      t: ms.t, iso: ms.iso, dirX, moveProb: moveProbByT.get(ms.t) ?? [NaN, NaN, NaN, NaN],
      upLabel, moveGT, netUp, contiguous: ms.contiguous,
      session: ms.session, volRatio: ms.volRatio,
      trendRegime: trendMag > 0.3 ? "UPTREND" : trendMag < -0.3 ? "DOWNTREND" : "RANGE",
      hourBucket: ms.hourBucket, newsAdjacent: ms.newsAdjacent, newsAvailable: ms.newsAvailable,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frozen MOVE_MODEL out-of-sample probability generation (expanding walk-forward).
// This RE-RUNS the frozen MOVE recipe to emit causal probabilities. It does not
// change any MOVE_MODEL artifact.
// ---------------------------------------------------------------------------
function subsample<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows; const stride = rows.length / cap; const out: T[] = [];
  for (let k = 0; k < cap; k += 1) out.push(rows[Math.floor(k * stride)]!); return out;
}
export function generateMoveProbs(moveSamples: Sample[], firstProbFrom: number, to: number, opts: { rounds?: number; cap?: number } = {}): Map<number, number[]> {
  // Defaults reproduce the frozen recipe (rounds 100, cap 45k). Callers that only
  // need move_prob as an input FEATURE (not a MOVE_MODEL artifact) may pass a
  // lighter recipe for speed — this never touches any MOVE_MODEL output.
  const rounds = opts.rounds ?? 100, cap = opts.cap ?? 45_000;
  const map = new Map<number, number[]>();
  const ensure = (t: number) => { let a = map.get(t); if (!a) { a = [NaN, NaN, NaN, NaN]; map.set(t, a); } return a; };
  const stepMs = 182 * 24 * 3_600_000; // ~6 months
  for (let hIdx = 0; hIdx < HORIZONS.length; hIdx += 1) {
    const emb = HORIZONS[hIdx]!.bars * barMs;
    const all = moveSamples.filter((s) => s.contiguous[hIdx]).map((s) => ({ t: s.t, x: s.x, y: s.norm[hIdx]! >= FROZEN_MOVE_THRESHOLD[hIdx]! ? 1 : 0 }));
    for (let start = firstProbFrom; start < to; start += stepMs) {
      const next = start + stepMs;
      const tr = subsample(all.filter((r) => r.t < start - emb), cap);
      const te = all.filter((r) => r.t >= start && r.t < next);
      if (tr.length < 2000 || !te.length) continue;
      const model = trainGBT(tr.map((r) => r.x), tr.map((r) => r.y), { rounds, depth: 3, lr: 0.1 });
      for (const r of te) ensure(r.t)[hIdx] = predictGBT(model, r.x);
    }
  }
  return map;
}
