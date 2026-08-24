/**
 * Linear feature → forward return model on H1.
 * Train on pre-2025, score holdout. Trade only when predicted move clears
 * estimated round-trip cost. One position/instrument.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { calculateAtrValues, calculateEmaValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");
const { labelOutcome } = await import("../src/research.js");

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2021-01-01T00:00:00Z");
const HORIZON = 8; // H1 bars

const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H1' AND source='oanda'
   GROUP BY 1 HAVING count(*) > 8000 ORDER BY 1`,
)).rows.map((r) => r.instrument);

type Row = {
  instrument: string; ms: number; qi: number;
  x: number[]; // features
  y: number; // forward mid return / ATR
  atr: number; spreadAtr: number;
  quoteAsk: number; quoteBid: number;
};

const rows: Row[] = [];
const quotesBy = new Map<string, Array<{
  closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
}>>();

for (const instrument of instruments) {
  let pip: number;
  try { pip = pipSizeFor(instrument as never); } catch { continue; }
  const candles = (await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  const quotes = (await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidOpen: Number(r.bid_open), bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open), askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
  }));
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));

  for (let i = 60; i < candles.length - HORIZON; i += HORIZON) { // non-overlapping
    const bar = candles[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    const a = atr[i]; const e21 = ema21[i]; const e50 = ema50[i];
    if (a == null || !(a > 0) || e21 == null || e50 == null) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spread = quote.askClose - quote.bidClose;
    const spreadAtr = spread / a;
    if (!(spreadAtr > 0) || spreadAtr > 0.3) continue;

    const ret1 = (bar.close - candles[i - 1]!.close) / a;
    const ret4 = (bar.close - candles[i - 4]!.close) / a;
    const ret12 = (bar.close - candles[i - 12]!.close) / a;
    const emaDiff = (e21 - e50) / a;
    const distEma = (bar.close - e21) / a;
    const range = (Math.max(...candles.slice(i - 20, i).map((c) => c.high)) - Math.min(...candles.slice(i - 20, i).map((c) => c.low))) / a;
    const hour = new Date(atMs).getUTCHours() / 24;

    const fwd = (candles[i + HORIZON]!.close - bar.close) / a;
    rows.push({
      instrument, ms: atMs, qi,
      x: [1, ret1, ret4, ret12, emaDiff, distEma, range, hour, spreadAtr],
      y: fwd, atr: a, spreadAtr,
      quoteAsk: quote.askClose, quoteBid: quote.bidClose,
    });
  }
  console.log(instrument, "samples");
}

function fitOLS(data: Row[]) {
  const k = data[0]!.x.length;
  // Normal equations X'X b = X'y (Gaussian elimination)
  const xtx: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const xty: number[] = Array(k).fill(0);
  for (const row of data) {
    for (let i = 0; i < k; i += 1) {
      xty[i]! += row.x[i]! * row.y;
      for (let j = 0; j < k; j += 1) xtx[i]![j]! += row.x[i]! * row.x[j]!;
    }
  }
  // Augment and eliminate
  const m = xtx.map((row, i) => [...row, xty[i]!]);
  for (let col = 0; col < k; col += 1) {
    let piv = col;
    for (let r = col + 1; r < k; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    [m[col], m[piv]] = [m[piv]!, m[col]!];
    const div = m[col]![col]!;
    if (Math.abs(div) < 1e-12) continue;
    for (let j = col; j <= k; j += 1) m[col]![j]! /= div;
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = m[r]![col]!;
      for (let j = col; j <= k; j += 1) m[r]![j]! -= f * m[col]![j]!;
    }
  }
  return m.map((row) => row[k]!);
}

function predict(beta: number[], x: number[]) {
  return beta.reduce((s, b, i) => s + b * x[i]!, 0);
}

const train = rows.filter((r) => r.ms < HOLDOUT);
const test = rows.filter((r) => r.ms >= HOLDOUT);
console.log(`train ${train.length} test ${test.length}`);
const beta = fitOLS(train);
console.log("beta", beta.map((b) => b.toFixed(4)).join(", "));

// Trade when |pred| > cost threshold (round trip ~ spreadAtr)
const thresholds = [0.15, 0.25, 0.35, 0.5];
for (const thr of thresholds) {
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  const sorted = [...test].sort((a, b) => a.ms - b.ms);
  for (const row of sorted) {
    if (row.ms < (openUntil.get(row.instrument) ?? 0)) continue;
    const pred = predict(beta, row.x);
    const need = thr + row.spreadAtr;
    if (Math.abs(pred) < need) continue;
    const direction = pred > 0 ? "long" as const : "short" as const;
    const entry = direction === "long" ? row.quoteAsk : row.quoteBid;
    const stop = direction === "long" ? entry - row.atr : entry + row.atr;
    const target = direction === "long" ? entry + row.atr * 1.0 : entry - row.atr * 1.0;
    const quotes = quotesBy.get(row.instrument)!;
    const forward = quotes.slice(row.qi + 1, row.qi + 1 + HORIZON);
    if (!forward.length) continue;
    const outcome = labelOutcome(direction, entry, stop, target, new Date(row.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(row.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : row.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) { console.log(`thr ${thr}: too few`); continue; }
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const verdict = n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge";
  console.log(`thr ${thr}: n=${n} avg=${mean.toFixed(3)} ${verdict} [${lo.toFixed(3)}, ${hi.toFixed(3)}]${verdict === "WINS" ? " ★★★" : ""}`);
}

// Also: correlation of pred vs y on holdout (signal quality before costs)
{
  const preds = test.map((r) => predict(beta, r.x));
  const ys = test.map((r) => r.y);
  const mp = preds.reduce((a, b) => a + b, 0) / preds.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0; let dp = 0; let dy = 0;
  for (let i = 0; i < preds.length; i += 1) {
    num += (preds[i]! - mp) * (ys[i]! - my);
    dp += (preds[i]! - mp) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  const corr = num / Math.sqrt(dp * dy);
  console.log(`holdout pred↔fwd corr=${corr.toFixed(4)}`);
}
process.exit(0);
