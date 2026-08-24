/**
 * Fetch H1 MBA candles for missing majors into market_candles/quotes, then
 * re-test compress≤2.2ATR 1R with the expanded universe.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { labelOutcome } = await import("../src/research.js");
const { calculateAtrValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const TARGETS = ["AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP"];
const H1_MS = 60 * 60_000;
const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2016-01-01T00:00:00Z");
const FETCH_FROM = Date.parse("2021-01-01T00:00:00Z");

async function saveH1(instrument: string, candles: Awaited<ReturnType<typeof getResearchCandles>>) {
  const completed = candles.filter((c) => c.complete);
  for (let i = 0; i < completed.length; i += 400) {
    const batch = completed.slice(i, i + 400);
    const candlePh = batch.map((_, row) => `($${row * 8 + 1},$${row * 8 + 2},$${row * 8 + 3},$${row * 8 + 4},$${row * 8 + 5},$${row * 8 + 6},$${row * 8 + 7},$${row * 8 + 8},'oanda')`).join(",");
    const candleVals = batch.flatMap((c) => [
      instrument, "H1", new Date(new Date(c.time).getTime() + H1_MS).toISOString(),
      c.mid.open, c.mid.high, c.mid.low, c.mid.close, c.volume,
    ]);
    await query(
      `INSERT INTO market_candles(instrument,timeframe,close_time,open,high,low,close,volume,source)
       VALUES ${candlePh} ON CONFLICT(instrument,timeframe,close_time,source) DO NOTHING`,
      candleVals,
    );
    const quotePh = batch.map((_, row) => `($${row * 11 + 1},$${row * 11 + 2},$${row * 11 + 3},$${row * 11 + 4},$${row * 11 + 5},$${row * 11 + 6},$${row * 11 + 7},$${row * 11 + 8},$${row * 11 + 9},$${row * 11 + 10},$${row * 11 + 11},'oanda')`).join(",");
    const quoteVals = batch.flatMap((c) => [
      instrument, "H1", new Date(new Date(c.time).getTime() + H1_MS).toISOString(),
      c.bid.open, c.bid.high, c.bid.low, c.bid.close,
      c.ask.open, c.ask.high, c.ask.low, c.ask.close,
    ]);
    await query(
      `INSERT INTO market_candle_quotes(instrument,timeframe,close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,source)
       VALUES ${quotePh} ON CONFLICT DO NOTHING`,
      quoteVals,
    );
  }
}

async function backfill(instrument: string) {
  const existing = await query<{ n: number; first: string | null }>(
    `SELECT count(*)::int AS n, min(close_time)::text AS first FROM market_candles
     WHERE instrument=$1 AND timeframe='H1' AND source='oanda'`,
    [instrument],
  );
  const have = existing.rows[0]?.n ?? 0;
  if (have > 20_000) {
    console.log(`${instrument}: already ${have} H1 bars, skip fetch`);
    return;
  }
  await query(
    `INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING`,
    [instrument, instrument.replace("_", "/"), instrument.includes("JPY") ? 3 : 5],
  );

  let cursor = new Date().toISOString();
  let total = 0;
  let guard = 0;
  while (guard < 80) {
    guard += 1;
    const batch = await getResearchCandles(instrument as never, "H1", 5000, { to: cursor });
    if (!batch.length) break;
    const oldest = batch.reduce((min, c) => (c.time < min ? c.time : min), batch[0]!.time);
    await saveH1(instrument, batch);
    total += batch.length;
    console.log(`${instrument}: +${batch.length} (total fetched ~${total}), oldest ${oldest}`);
    if (Date.parse(oldest) <= FETCH_FROM) break;
    // Page older: set to just before oldest open time
    cursor = new Date(Date.parse(oldest) - 1000).toISOString();
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`${instrument}: fetch done`);
}

console.log("=== BACKFILL H1 ===");
for (const instrument of TARGETS) {
  try {
    await backfill(instrument);
  } catch (error) {
    console.error(instrument, "backfill failed", error instanceof Error ? error.message : error);
  }
}

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = { instrument: string; ms: number; direction: "long" | "short"; entry: number; stop: number; qi: number };

const instruments = (await query<{ instrument: string }>(
  `SELECT DISTINCT instrument FROM market_candles WHERE timeframe='H1' AND source='oanda' ORDER BY 1`,
)).rows.map((r) => r.instrument);
console.log("\nuniverse", instruments.join(","));

const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

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
  if (candles.length < 500 || quotes.length < 500) {
    console.log(instrument, "still thin", candles.length);
    continue;
  }
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
  let n = 0;
  for (let i = 25; i < candles.length; i += 1) {
    const bar = candles[i]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    const a = atr[i];
    if (a == null || !(a > 0)) continue;
    const qi = qIndex.get(bar.time);
    if (qi == null) continue;
    const quote = quotes[qi]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 4) continue;
    const window = candles.slice(i - 20, i);
    const rh = Math.max(...window.map((c) => c.high));
    const rl = Math.min(...window.map((c) => c.low));
    if ((rh - rl) / a > 2.2) continue;
    const brokeUp = bar.close > rh;
    const brokeDn = bar.close < rl;
    if (!brokeUp && !brokeDn) continue;
    const direction = brokeUp ? "long" as const : "short" as const;
    const entry = direction === "long" ? quote.askClose : quote.bidClose;
    const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
    setups.push({ instrument, ms: atMs, direction, entry, stop, qi });
    n += 1;
  }
  console.log(instrument, "compress setups", n);
}

function simulate(fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk : s.entry - risk;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 24);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { n, avg: "-", ci: "-", verdict: "too few" };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    n, avg: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
  };
}

console.log("\n=== compress≤2.2 1R ===");
const dev = simulate(REPLAY, HOLDOUT);
const hold = simulate(HOLDOUT, null);
console.log(`DEV  n=${dev.n} avg=${dev.avg} ${dev.verdict} ${dev.ci}`);
console.log(`HOLD n=${hold.n} avg=${hold.avg} ${hold.verdict} ${hold.ci}${hold.verdict === "WINS" ? " ★★★" : ""}`);
process.exit(0);
