/**
 * Pure H4 z-score mean-reversion + H4 momentum continuation.
 * Clean-sheet rules (not V1 params). Spread paid. Holdout sealed.
 * If either survives, map to meanrev / momentum family V2.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2021-08-01T00:00:00Z");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H4' AND source='oanda' ORDER BY 1`,
)).rows.map((r) => r.instrument);
console.log("instruments", instruments.join(","));

async function load(instrument: string) {
  const candles = (await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='H4' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  const quotes = (await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='H4' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidOpen: Number(r.bid_open), bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open), askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
  }));
  return { candles, quotes };
}

type Variant = {
  name: string;
  family: "meanrev" | "momentum" | "ema" | "breakout";
  lookback: number;
  entryZ: number;
  stopAtr: number;
  targetR: number;
  mode: "fade" | "follow";
};

const VARIANTS: Variant[] = [
  { name: "z fade |z|≥2 · 1ATR · 1R", family: "meanrev", lookback: 20, entryZ: 2.0, stopAtr: 1.0, targetR: 1.0, mode: "fade" },
  { name: "z fade |z|≥2.5 · 1.2ATR · 0.75R", family: "meanrev", lookback: 20, entryZ: 2.5, stopAtr: 1.2, targetR: 0.75, mode: "fade" },
  { name: "z fade |z|≥1.75 · 1ATR · 0.75R", family: "meanrev", lookback: 40, entryZ: 1.75, stopAtr: 1.0, targetR: 0.75, mode: "fade" },
  { name: "z follow |z|≥2 · 1ATR · 1R", family: "momentum", lookback: 20, entryZ: 2.0, stopAtr: 1.0, targetR: 1.0, mode: "follow" },
  { name: "z follow |z|≥1.5 · 1.5ATR · 1.5R", family: "momentum", lookback: 20, entryZ: 1.5, stopAtr: 1.5, targetR: 1.5, mode: "follow" },
  { name: "z fade |z|≥2 · 1.5ATR · 1.5R", family: "meanrev", lookback: 20, entryZ: 2.0, stopAtr: 1.5, targetR: 1.5, mode: "fade" },
  { name: "z fade |z|≥2 · 1ATR · 2R", family: "meanrev", lookback: 20, entryZ: 2.0, stopAtr: 1.0, targetR: 2.0, mode: "fade" },
];

type Trade = { ms: number; resultR: number; instrument: string };

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n < 2) return { label, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = trades.reduce((s, t) => s + t.resultR, 0) / n;
  const se = Math.sqrt(trades.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    label, n, avg: mean.toFixed(3),
    win: ((100 * trades.filter((t) => t.resultR > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

function zScore(closes: number[], i: number, lookback: number) {
  const window = closes.slice(i - lookback + 1, i + 1);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / (window.length - 1));
  if (!(sd > 0)) return null;
  return (closes[i]! - mean) / sd;
}

async function runVariant(v: Variant, fromMs: number, toMs: number | null): Promise<Trade[]> {
  const trades: Trade[] = [];
  for (const instrument of instruments) {
    const { candles, quotes } = await load(instrument);
    if (candles.length < 100 || quotes.length < 100) continue;
    const atr = calculateAtrValues(candles as never, 14);
    const closes = candles.map((c) => c.close);
    const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
    const pip = pipSizeFor(instrument as never);
    let openUntil = 0;

    for (let i = Math.max(60, v.lookback + 5); i < candles.length; i += 1) {
      const bar = candles[i]!;
      const atMs = Date.parse(bar.time);
      if (atMs < fromMs || (toMs !== null && atMs >= toMs) || atMs < openUntil) continue;
      if (!dayTradingSession(new Date(atMs)).open) continue;
      const z = zScore(closes, i, v.lookback);
      const a = atr[i];
      if (z == null || a == null || !(a > 0)) continue;
      if (Math.abs(z) < v.entryZ) continue;

      const qi = qIndex.get(bar.time);
      if (qi == null) continue;
      const quote = quotes[qi]!;
      const spreadPips = (quote.askClose - quote.bidClose) / pip;
      if (!(spreadPips > 0) || spreadPips > 4) continue;

      let direction: "long" | "short";
      if (v.mode === "fade") direction = z > 0 ? "short" : "long";
      else direction = z > 0 ? "long" : "short";

      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? entry - a * v.stopAtr : entry + a * v.stopAtr;
      const risk = Math.abs(entry - stop);
      const target = direction === "long" ? entry + risk * v.targetR : entry - risk * v.targetR;
      const forward = quotes.slice(qi + 1, qi + 30);
      if (!forward.length) continue;
      const outcome = labelOutcome(direction, entry, stop, target, bar.time, forward as never);
      if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
      openUntil = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      trades.push({ ms: atMs, resultR: outcome.resultR, instrument });
    }
  }
  return trades;
}

console.log("=== DEVELOPMENT ===");
const dev = [];
for (const v of VARIANTS) {
  const trades = await runVariant(v, REPLAY, HOLDOUT);
  const row = summarise(v.name, trades);
  dev.push({ ...row, variant: v });
  console.log(`${v.name}: n=${row.n} avg=${row.avg} ${row.verdict}`);
}
console.table(dev.map(({ _mean, variant, ...r }) => r));

console.log("\n=== HOLDOUT (all + top) ===");
for (const row of [...dev].sort((a, b) => b._mean - a._mean)) {
  if (row.n < 30) continue;
  const hold = summarise(row.label, await runVariant(row.variant, HOLDOUT, null));
  console.log(`${row.label}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ci=${hold.ci}`);
}
process.exit(0);
