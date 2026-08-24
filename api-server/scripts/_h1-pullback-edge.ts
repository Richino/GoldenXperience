/**
 * Clean-sheet H1 edge hunt: D1 trend + H1 pullback to EMA, spread paid, 0.75–1.5R.
 * Not a parameter tweak of V1 — a different entry rule sized for H1 geometry.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateEmaValues, calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2022-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

async function loadCandles(instrument: string, timeframe: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`,
    [instrument, timeframe],
  );
  return rows.rows.map((row) => ({
    time: new Date(row.close_time as string).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
  }));
}
async function loadQuotes(instrument: string): Promise<Quote[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`,
    [instrument],
  );
  return rows.rows.map((row) => ({
    closeTime: new Date(row.close_time as string).toISOString(),
    bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
    askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
  }));
}

type Variant = {
  name: string;
  emaFast: number; emaSlow: number;
  pullbackPadAtr: number; maxExtensionAtr: number;
  minStopAtr: number; targetR: number;
  requireD1Align: boolean;
};

const VARIANTS: Variant[] = [
  { name: "H1 pullback 21/50 · 1.0R · D1", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.0, targetR: 1.0, requireD1Align: true },
  { name: "H1 pullback 21/50 · 0.75R · D1", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.0, targetR: 0.75, requireD1Align: true },
  { name: "H1 pullback 21/50 · 1.25R · D1", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.0, targetR: 1.25, requireD1Align: true },
  { name: "H1 pullback 8/21 · 1.0R · D1", emaFast: 8, emaSlow: 21, pullbackPadAtr: 0.4, maxExtensionAtr: 1.2, minStopAtr: 1.0, targetR: 1.0, requireD1Align: true },
  { name: "H1 pullback 21/50 · 1.0R · no D1", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.0, targetR: 1.0, requireD1Align: false },
  { name: "H1 pullback 21/50 · 1.0R · D1 · stop1.5", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.5, targetR: 1.0, requireD1Align: true },
  { name: "H1 pullback 21/50 · 0.75R · D1 · stop1.5", emaFast: 21, emaSlow: 50, pullbackPadAtr: 0.35, maxExtensionAtr: 1.5, minStopAtr: 1.5, targetR: 0.75, requireD1Align: true },
];

type Trade = { ms: number; resultR: number };

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n < 2) return { label, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = trades.reduce((s, t) => s + t.resultR, 0) / n;
  const se = Math.sqrt(trades.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    label, n,
    avg: mean.toFixed(3),
    win: ((100 * trades.filter((t) => t.resultR > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

function lastClosed(times: number[], atMs: number, from: number) {
  let i = from;
  while (i + 1 < times.length && times[i + 1]! <= atMs) i += 1;
  return i;
}

async function runVariant(variant: Variant, fromMs: number, toMs: number | null): Promise<Trade[]> {
  const trades: Trade[] = [];
  for (const instrument of PAIRS) {
    const [h1, d, quotes] = await Promise.all([
      loadCandles(instrument, "H1"),
      loadCandles(instrument, "D"),
      loadQuotes(instrument),
    ]);
    if (h1.length < 100 || quotes.length < 100) continue;
    const dTimes = d.map((c) => Date.parse(c.time));
    const qTimes = quotes.map((q) => Date.parse(q.closeTime));
    const closes = h1.map((c) => c.close);
    const atr = calculateAtrValues(h1 as never, 14);
    const emaFast = calculateEmaValues(closes, variant.emaFast);
    const emaSlow = calculateEmaValues(closes, variant.emaSlow);
    const dCloses = d.map((c) => c.close);
    const dEmaFast = calculateEmaValues(dCloses, 21);
    const dEmaSlow = calculateEmaValues(dCloses, 50);
    let dCursor = 0; let qCursor = 0;
    let openUntil = 0;
    const pip = pipSizeFor(instrument as never);

    for (let i = 60; i < h1.length; i += 1) {
      const bar = h1[i]!;
      const atMs = Date.parse(bar.time);
      if (atMs < fromMs) continue;
      if (toMs !== null && atMs >= toMs) continue;
      if (atMs < openUntil) continue;
      if (!dayTradingSession(new Date(atMs)).open) continue;
      qCursor = lastClosed(qTimes, atMs, qCursor);
      dCursor = lastClosed(dTimes, atMs, dCursor);
      if (qTimes[qCursor] !== atMs) continue;
      const quote = quotes[qCursor]!;
      const spreadPips = (quote.askClose - quote.bidClose) / pip;
      if (!(spreadPips > 0) || spreadPips > 2.5) continue;

      const a = atr[i];
      const ef = emaFast[i];
      const es = emaSlow[i];
      if (a == null || !(a > 0) || ef == null || es == null) continue;

      const bullish = ef > es;
      const bearish = ef < es;
      if (!bullish && !bearish) continue;

      if (variant.requireD1Align && dCursor >= 50) {
        const df = dEmaFast[dCursor];
        const ds = dEmaSlow[dCursor];
        if (df == null || ds == null) continue;
        if (bullish && !(df > ds)) continue;
        if (bearish && !(df < ds)) continue;
      }

      const zoneLow = Math.min(ef, es) - a * variant.pullbackPadAtr;
      const zoneHigh = Math.max(ef, es) + a * variant.pullbackPadAtr;
      const touched = bar.low <= zoneHigh && bar.high >= zoneLow;
      if (!touched) continue;
      const ext = Math.abs(bar.close - ef) / a;
      if (ext > variant.maxExtensionAtr) continue;

      // Confirmation: close back in trend direction
      const confirmed = bullish ? bar.close > bar.open && bar.close >= ef : bar.close < bar.open && bar.close <= ef;
      if (!confirmed) continue;

      const direction = bullish ? "long" as const : "short" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const swing = direction === "long"
        ? Math.min(...h1.slice(i - 5, i + 1).map((c) => c.low))
        : Math.max(...h1.slice(i - 5, i + 1).map((c) => c.high));
      let stop = direction === "long" ? Math.min(swing, entry - a * variant.minStopAtr) : Math.max(swing, entry + a * variant.minStopAtr);
      if (direction === "long" && entry - stop < a * variant.minStopAtr) stop = entry - a * variant.minStopAtr;
      if (direction === "short" && stop - entry < a * variant.minStopAtr) stop = entry + a * variant.minStopAtr;
      const risk = Math.abs(entry - stop);
      const target = direction === "long" ? entry + risk * variant.targetR : entry - risk * variant.targetR;

      const forward = quotes.slice(qCursor + 1, qCursor + 80);
      if (!forward.length) continue;
      const outcome = labelOutcome(direction, entry, stop, target, bar.time, forward as never);
      if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
      openUntil = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      trades.push({ ms: atMs, resultR: outcome.resultR });
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

console.log("\n=== HOLDOUT ===");
for (const row of [...dev].sort((a, b) => b._mean - a._mean).slice(0, 5)) {
  const hold = summarise(row.label, await runVariant(row.variant, HOLDOUT, null));
  console.log(`${row.label}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ci=${hold.ci}`);
}

process.exit(0);
