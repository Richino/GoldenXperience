/**
 * M15 compressed-range breakout — same geometry as the H1 hint, more samples.
 * DEV selects; holdout sealed. Spread paid.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues, calculateEmaValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2022-08-01T00:00:00Z");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = {
  instrument: string; ms: number; direction: "long" | "short";
  entry: number; stop: number; qi: number; rangeAtr: number; emaAligned: boolean; bodyAtr: number;
};

async function load(instrument: string) {
  const candles = (await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float FROM market_candles
     WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  const quotes = (await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
     FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument],
  )).rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidOpen: Number(r.bid_open), bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), bidClose: Number(r.bid_close),
    askOpen: Number(r.ask_open), askHigh: Number(r.ask_high), askLow: Number(r.ask_low), askClose: Number(r.ask_close),
  }));
  return { candles, quotes };
}

const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

for (const instrument of PAIRS) {
  const { candles, quotes } = await load(instrument);
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
  const pip = pipSizeFor(instrument as never);
  let n = 0;
  for (let i = 40; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    const a = atr[i]; const e21 = ema21[i]; const e50 = ema50[i];
    if (a == null || !(a > 0) || e21 == null || e50 == null) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 2.5) continue;

    const look = 16; // 4h of M15
    const prior = candles.slice(i - look, i);
    const rangeHigh = Math.max(...prior.map((c) => c.high));
    const rangeLow = Math.min(...prior.map((c) => c.low));
    const rangeAtr = (rangeHigh - rangeLow) / a;
    let direction: "long" | "short" | null = null;
    let stop = 0;
    if (bar.close > rangeHigh) { direction = "long"; stop = Math.max(rangeLow, entryStop(bar, a, "long")); }
    else if (bar.close < rangeLow) { direction = "short"; stop = Math.min(rangeHigh, entryStop(bar, a, "short")); }
    else continue;

    const entry = direction === "long" ? quote.askClose : quote.bidClose;
    if (direction === "long") stop = Math.min(rangeLow, entry - a * 0.9);
    else stop = Math.max(rangeHigh, entry + a * 0.9);

    setups.push({
      instrument, ms: atMs, direction, entry, stop, qi, rangeAtr,
      emaAligned: direction === "long" ? e21 > e50 : e21 < e50,
      bodyAtr: Math.abs(bar.close - bar.open) / a,
    });
    n += 1;
  }
  console.log(instrument, n);
}

function entryStop(bar: Candle, a: number, d: "long" | "short") {
  return d === "long" ? bar.close - a : bar.close + a;
}

type Filter = (s: Setup) => boolean;
const variants: Array<{ name: string; targetR: number; filter: Filter }> = [
  { name: "all 1R", targetR: 1, filter: () => true },
  { name: "range≤2.5ATR 1R", targetR: 1, filter: (s) => s.rangeAtr <= 2.5 },
  { name: "range≤3.0ATR 1R", targetR: 1, filter: (s) => s.rangeAtr <= 3.0 },
  { name: "range≤3.5ATR 1R", targetR: 1, filter: (s) => s.rangeAtr <= 3.5 },
  { name: "range≤3.0ATR + EMA 1R", targetR: 1, filter: (s) => s.rangeAtr <= 3.0 && s.emaAligned },
  { name: "range≤3.0ATR + body 1R", targetR: 1, filter: (s) => s.rangeAtr <= 3.0 && s.bodyAtr >= 0.5 },
  { name: "range≤3.0ATR 0.75R", targetR: 0.75, filter: (s) => s.rangeAtr <= 3.0 },
  { name: "range≤2.5ATR + EMA 0.75R", targetR: 0.75, filter: (s) => s.rangeAtr <= 2.5 && s.emaAligned },
  { name: "range≤2.5ATR + EMA + body 1R", targetR: 1, filter: (s) => s.rangeAtr <= 2.5 && s.emaAligned && s.bodyAtr >= 0.45 },
];

function simulate(name: string, targetR: number, filter: Filter, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => filter(s) && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 32);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { name, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    name, n, avg: mean.toFixed(3),
    win: ((100 * rs.filter((r) => r > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

console.log("total setups", setups.length);
console.log("=== DEV ===");
const dev = variants.map((v) => ({ ...simulate(v.name, v.targetR, v.filter, REPLAY, HOLDOUT), variant: v }));
console.table(dev.map(({ _mean, variant, ...r }) => r));

console.log("\n=== HOLDOUT ===");
for (const row of [...dev].sort((a, b) => b._mean - a._mean)) {
  if (row.n < 40) continue;
  const hold = simulate(row.name, row.variant.targetR, row.variant.filter, HOLDOUT, null);
  const mark = hold.verdict === "WINS" ? " ★★★" : "";
  console.log(`${row.name}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ${hold.ci}${mark}`);
}
process.exit(0);
