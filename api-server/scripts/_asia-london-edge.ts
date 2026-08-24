/**
 * Asian-range → London continuation / fade hunt.
 *
 * Classic day-trade geometry with H1 quotes for costs:
 * - Measure Asia range (00:00–07:00 UTC) high/low
 * - At first London H1 close (08:00 UTC), take breakout or fade if range is
 *   compressed (ATR-normalized), stop beyond range, target 0.75–1.5R
 * Holdout sealed. Maps to breakout / meanrev families if either survives.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2022-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

async function loadCandles(instrument: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float
       FROM market_candles WHERE instrument=$1 AND timeframe='H1' AND source='oanda' ORDER BY close_time`,
    [instrument],
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

type Variant = { name: string; mode: "breakout" | "fade"; maxRangeAtr: number; minRangeAtr: number; targetR: number; padAtr: number };
const VARIANTS: Variant[] = [
  { name: "breakout range≤1.0ATR 1.0R", mode: "breakout", maxRangeAtr: 1.0, minRangeAtr: 0.25, targetR: 1.0, padAtr: 0.1 },
  { name: "breakout range≤0.8ATR 0.75R", mode: "breakout", maxRangeAtr: 0.8, minRangeAtr: 0.2, targetR: 0.75, padAtr: 0.1 },
  { name: "breakout range≤1.2ATR 1.5R", mode: "breakout", maxRangeAtr: 1.2, minRangeAtr: 0.3, targetR: 1.5, padAtr: 0.15 },
  { name: "fade range≥1.2ATR 0.75R", mode: "fade", maxRangeAtr: 99, minRangeAtr: 1.2, targetR: 0.75, padAtr: 0.1 },
  { name: "fade range≥1.5ATR 1.0R", mode: "fade", maxRangeAtr: 99, minRangeAtr: 1.5, targetR: 1.0, padAtr: 0.1 },
  { name: "fade range 1.0-2.0ATR 0.75R", mode: "fade", maxRangeAtr: 2.0, minRangeAtr: 1.0, targetR: 0.75, padAtr: 0.1 },
];

type Trade = { ms: number; resultR: number };

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

function utcHour(iso: string) { return new Date(iso).getUTCHours(); }
function utcDateKey(iso: string) { return iso.slice(0, 10); }

async function runVariant(variant: Variant, fromMs: number, toMs: number | null): Promise<Trade[]> {
  const trades: Trade[] = [];
  for (const instrument of PAIRS) {
    const [h1, quotes] = await Promise.all([loadCandles(instrument), loadQuotes(instrument)]);
    if (h1.length < 100) continue;
    const atr = calculateAtrValues(h1 as never, 14);
    const qByTime = new Map(quotes.map((q) => [q.closeTime, q]));
    const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
    const pip = pipSizeFor(instrument as never);
    let openUntil = 0;

    // Group bars by UTC date
    const byDay = new Map<string, number[]>();
    for (let i = 0; i < h1.length; i += 1) {
      const key = utcDateKey(h1[i]!.time);
      const list = byDay.get(key) ?? [];
      list.push(i);
      byDay.set(key, list);
    }

    for (const [, indices] of byDay) {
      const asia = indices.filter((i) => { const h = utcHour(h1[i]!.time); return h >= 0 && h < 7; });
      const london = indices.find((i) => utcHour(h1[i]!.time) === 8);
      if (asia.length < 4 || london == null) continue;
      const bar = h1[london]!;
      const atMs = Date.parse(bar.time);
      if (atMs < fromMs || (toMs !== null && atMs >= toMs) || atMs < openUntil) continue;
      const a = atr[london];
      if (a == null || !(a > 0)) continue;

      const asiaHigh = Math.max(...asia.map((i) => h1[i]!.high));
      const asiaLow = Math.min(...asia.map((i) => h1[i]!.low));
      const rangeAtr = (asiaHigh - asiaLow) / a;
      if (rangeAtr < variant.minRangeAtr || rangeAtr > variant.maxRangeAtr) continue;

      const quote = qByTime.get(bar.time);
      const qi = qIndex.get(bar.time);
      if (!quote || qi == null) continue;
      const spreadPips = (quote.askClose - quote.bidClose) / pip;
      if (!(spreadPips > 0) || spreadPips > 2.5) continue;

      let direction: "long" | "short" | null = null;
      if (variant.mode === "breakout") {
        if (bar.close > asiaHigh) direction = "long";
        else if (bar.close < asiaLow) direction = "short";
      } else {
        // Fade: price poked outside and closed back inside, or closed near extreme
        if (bar.close > asiaHigh || (bar.high > asiaHigh && bar.close < asiaHigh)) direction = "short";
        else if (bar.close < asiaLow || (bar.low < asiaLow && bar.close > asiaLow)) direction = "long";
      }
      if (!direction) continue;

      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long"
        ? asiaLow - a * variant.padAtr
        : asiaHigh + a * variant.padAtr;
      const risk = Math.abs(entry - stop);
      if (!(risk > a * 0.4)) continue;
      const target = direction === "long" ? entry + risk * variant.targetR : entry - risk * variant.targetR;
      const forward = quotes.slice(qi + 1, qi + 12); // rest of London day
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
for (const row of [...dev].sort((a, b) => b._mean - a._mean)) {
  if (row.n < 40) continue;
  const hold = summarise(row.label, await runVariant(row.variant, HOLDOUT, null));
  console.log(`${row.label}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n})`);
}
process.exit(0);
