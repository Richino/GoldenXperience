/**
 * eurusdbot3-1 — data layer.
 *
 * Loads the pre-existing stored EUR/USD bid/ask candle JSONs that already ship
 * in the repo (backtest-legacy-expanded/candles), resamples H1 → H4 / Daily on
 * the fly with strict "completed-bar-only" semantics (no look-ahead), and loads
 * the ForexFactory high-impact EUR/USD news events, computing a look-ahead-safe
 * surprise where actual/forecast exist.
 *
 * Reuse note: the candle files and format (closeTime + bid/ask OHLC) are exactly
 * the artifacts the existing legacy/breakout backtests consume. Nothing here is
 * fetched at runtime, so the whole experiment is reproducible offline.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PIP = 0.0001;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type Bar = {
  t: number; // close time, ms epoch
  iso: string;
  open: number; high: number; low: number; close: number; // mid
  bidClose: number; bidHigh: number; bidLow: number; bidOpen: number;
  askClose: number; askHigh: number; askLow: number; askOpen: number;
};

type RawBar = {
  closeTime: string;
  open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export function loadCandles(tf: "M15" | "H1" | "H4"): Bar[] {
  const file = path.join(REPO_ROOT, "backtest-legacy-expanded", "candles", `EUR_USD_${tf}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { bars: RawBar[] };
  const bars = parsed.bars.map((b): Bar => ({
    t: Date.parse(b.closeTime),
    iso: b.closeTime,
    open: b.open, high: b.high, low: b.low, close: b.close,
    bidOpen: b.bidOpen, bidHigh: b.bidHigh, bidLow: b.bidLow, bidClose: b.bidClose,
    askOpen: b.askOpen, askHigh: b.askHigh, askLow: b.askLow, askClose: b.askClose,
  }));
  bars.sort((a, b) => a.t - b.t);
  // De-dupe identical timestamps (keep last).
  const out: Bar[] = [];
  for (const b of bars) {
    if (out.length && out.at(-1)!.t === b.t) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}

/**
 * Resample H1 → a higher timeframe by a fixed UTC bucketing so that a bar is
 * only emitted once fully complete. Returns completed HTF bars in order. The
 * caller aligns them to an H1 index with `lastCompletedIndexByTime`.
 *
 * bucketHours: 4 → H4 aligned to 0/4/8/12/16/20 UTC; 24 → Daily aligned to 00 UTC.
 */
export function resampleUp(h1: Bar[], bucketHours: number): Bar[] {
  const bucketMs = bucketHours * 3_600_000;
  const groups = new Map<number, Bar[]>();
  for (const b of h1) {
    // A H1 bar closing at time t covers (t-1h, t]; assign to the bucket of its
    // open instant so a bucket contains exactly the hours inside it.
    const openMs = b.t - 3_600_000;
    const bucket = Math.floor(openMs / bucketMs) * bucketMs;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket)!.push(b);
  }
  const buckets = [...groups.keys()].sort((a, b) => a - b);
  const out: Bar[] = [];
  for (const start of buckets) {
    const members = groups.get(start)!;
    const expected = bucketHours; // number of H1 bars in a full bucket
    // Only keep fully-complete buckets to avoid partial-bar look-ahead ambiguity.
    if (members.length < expected) continue;
    const closeMs = start + bucketMs;
    const first = members[0]!;
    const last = members.at(-1)!;
    out.push({
      t: closeMs,
      iso: new Date(closeMs).toISOString(),
      open: first.open, close: last.close,
      high: Math.max(...members.map((m) => m.high)),
      low: Math.min(...members.map((m) => m.low)),
      bidOpen: first.bidOpen, bidClose: last.bidClose,
      bidHigh: Math.max(...members.map((m) => m.bidHigh)),
      bidLow: Math.min(...members.map((m) => m.bidLow)),
      askOpen: first.askOpen, askClose: last.askClose,
      askHigh: Math.max(...members.map((m) => m.askHigh)),
      askLow: Math.min(...members.map((m) => m.askLow)),
    });
  }
  return out;
}

/** Largest index i with bars[i].t <= time (binary search). -1 if none. */
export function lastIndexAtOrBefore(bars: Bar[], time: number): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Smallest index i with bars[i].t > time (first strictly-future bar). */
export function firstIndexAfter(bars: Bar[], time: number): number {
  let lo = 0, hi = bars.length - 1, found = bars.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t > time) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found;
}

// ---- News -----------------------------------------------------------------

export type NewsEvent = {
  t: number;            // releaseTimeUtc, ms
  currency: "EUR" | "USD" | string;
  name: string;
  category: string;     // coarse bucket: cpi / employment / gdp / rate / pmi / retail / other
  impact: "high";
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  surprise: number | null; // actual - forecast (raw units), null if either missing
};

function parseNumeric(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  // strip %, K, M, B, commas; keep sign and decimal.
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/K/i.test(v)) n *= 1e3;
  else if (/M/i.test(v)) n *= 1e6;
  else if (/B/i.test(v)) n *= 1e9;
  return Number.isFinite(n) ? n : null;
}

function categorize(name: string): string {
  const s = name.toLowerCase();
  if (/(cpi|inflation|ppi|price index|hicp)/.test(s)) return "cpi";
  if (/(non-farm|nonfarm|nfp|payroll|unemploy|employ|jobless|claims|jobs)/.test(s)) return "employment";
  if (/(gdp|growth)/.test(s)) return "gdp";
  if (/(rate|fomc|ecb|interest|policy|monetary)/.test(s)) return "rate";
  if (/(pmi|manufacturing|services|ism)/.test(s)) return "pmi";
  if (/(retail sales)/.test(s)) return "retail";
  return "other";
}

export function loadNews(): NewsEvent[] {
  const files = [
    "eurusd-ff-high-impact-aug2024-jul2025",
    "eurusd-ff-high-impact-aug2025-jul2026",
  ];
  const out: NewsEvent[] = [];
  for (const dir of files) {
    const file = path.join(REPO_ROOT, "api-server", "research-v2", dir, "events.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      events: Array<{ releaseTimeUtc: string; currency: string; eventName: string; actual: string; forecast: string; previous: string }>;
    };
    for (const e of parsed.events) {
      const actual = parseNumeric(e.actual);
      const forecast = parseNumeric(e.forecast);
      out.push({
        t: Date.parse(e.releaseTimeUtc),
        currency: e.currency,
        name: e.eventName,
        category: categorize(e.eventName),
        impact: "high",
        actual, forecast, previous: parseNumeric(e.previous),
        surprise: actual != null && forecast != null ? actual - forecast : null,
      });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Standardize surprise per (currency, category) using ONLY events strictly before `asOf`. */
export function surpriseZScoreHistory(news: NewsEvent[]): Map<NewsEvent, number> {
  // For each event, compute z of its surprise vs the running mean/std of prior
  // same-currency+category surprises (look-ahead safe: only prior events).
  const running = new Map<string, number[]>();
  const z = new Map<NewsEvent, number>();
  for (const e of news) {
    const key = `${e.currency}:${e.category}`;
    const hist = running.get(key) ?? [];
    if (e.surprise != null) {
      if (hist.length >= 3) {
        const mean = hist.reduce((s, x) => s + x, 0) / hist.length;
        const variance = hist.reduce((s, x) => s + (x - mean) ** 2, 0) / hist.length;
        const std = Math.sqrt(variance) || 1;
        z.set(e, (e.surprise - mean) / std);
      }
      hist.push(e.surprise);
      running.set(key, hist);
    }
  }
  return z;
}
