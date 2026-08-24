/**
 * Classic rule scan: Donchian breakout (turtle-style) + RSI(2) mean-reversion.
 * H1, spread paid, holdout sealed 2025-01-01.
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

const HOLDOUT = Date.parse("2025-01-01T00:00:00Z");
const REPLAY = Date.parse("2018-01-01T00:00:00Z");
const instruments = ["EUR_USD", "GBP_USD", "USD_JPY"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = { name: string; family: string; instrument: string; ms: number; direction: "long" | "short"; entry: number; stop: number; qi: number; targetR: number };

function rsiWilder(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  let avgGain = 0; let avgLoss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = Math.max(0, change); const loss = Math.max(0, -change);
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

async function load(instrument: string) {
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
  return { candles, quotes };
}

const setups: Setup[] = [];
const quotesBy = new Map<string, Quote[]>();

for (const instrument of instruments) {
  const { candles, quotes } = await load(instrument);
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const rsi2 = rsiWilder(closes, 2);
  const rsi14 = rsiWilder(closes, 14);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
  const pip = pipSizeFor(instrument as never);

  for (let i = 55; i < candles.length; i += 1) {
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
    if (!(spreadPips > 0) || spreadPips > 2.5) continue;

    // Donchian N-bar break
    for (const n of [10, 20, 55] as const) {
      const prior = candles.slice(i - n, i);
      const hi = Math.max(...prior.map((c) => c.high));
      const lo = Math.min(...prior.map((c) => c.low));
      if (bar.close > hi) {
        const entry = quote.askClose;
        const stop = entry - a * 2;
        setups.push({ name: `donchian${n} break 2ATR 1R`, family: "breakout", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 1 });
        setups.push({ name: `donchian${n} break 2ATR 2R`, family: "breakout", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 2 });
        setups.push({ name: `donchian${n} break 1ATR 1R`, family: "momentum", instrument, ms: atMs, direction: "long", entry, stop: entry - a, qi, targetR: 1 });
      }
      if (bar.close < lo) {
        const entry = quote.bidClose;
        const stop = entry + a * 2;
        setups.push({ name: `donchian${n} break 2ATR 1R`, family: "breakout", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 1 });
        setups.push({ name: `donchian${n} break 2ATR 2R`, family: "breakout", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 2 });
        setups.push({ name: `donchian${n} break 1ATR 1R`, family: "momentum", instrument, ms: atMs, direction: "short", entry, stop: entry + a, qi, targetR: 1 });
      }
    }

    // RSI(2) mean reversion
    const r2 = rsi2[i];
    if (Number.isFinite(r2)) {
      if (r2! <= 10) {
        const entry = quote.askClose;
        const stop = entry - a * 1.5;
        setups.push({ name: "rsi2≤10 fade 1R", family: "meanrev", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 1 });
        setups.push({ name: "rsi2≤10 fade 0.75R", family: "meanrev", instrument, ms: atMs, direction: "long", entry, stop, qi, targetR: 0.75 });
      }
      if (r2! >= 90) {
        const entry = quote.bidClose;
        const stop = entry + a * 1.5;
        setups.push({ name: "rsi2≤10 fade 1R", family: "meanrev", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 1 });
        setups.push({ name: "rsi2≤10 fade 0.75R", family: "meanrev", instrument, ms: atMs, direction: "short", entry, stop, qi, targetR: 0.75 });
      }
      if (r2! <= 5) {
        const entry = quote.askClose;
        setups.push({ name: "rsi2≤5 fade 1R", family: "meanrev", instrument, ms: atMs, direction: "long", entry, stop: entry - a, qi, targetR: 1 });
      }
      if (r2! >= 95) {
        const entry = quote.bidClose;
        setups.push({ name: "rsi2≤5 fade 1R", family: "meanrev", instrument, ms: atMs, direction: "short", entry, stop: entry + a, qi, targetR: 1 });
      }
    }

    // RSI(14) extreme + EMA trend filter → ema family
    const r14 = rsi14[i];
    if (Number.isFinite(r14)) {
      if (r14! < 30 && bar.close > candles[i - 1]!.close) {
        const entry = quote.askClose;
        setups.push({ name: "rsi14<30 bounce 1R", family: "ema", instrument, ms: atMs, direction: "long", entry, stop: entry - a, qi, targetR: 1 });
        setups.push({ name: "rsi14<30 bounce 0.75R", family: "ema", instrument, ms: atMs, direction: "long", entry, stop: entry - a, qi, targetR: 0.75 });
      }
      if (r14! > 70 && bar.close < candles[i - 1]!.close) {
        const entry = quote.bidClose;
        setups.push({ name: "rsi14<30 bounce 1R", family: "ema", instrument, ms: atMs, direction: "short", entry, stop: entry + a, qi, targetR: 1 });
        setups.push({ name: "rsi14<30 bounce 0.75R", family: "ema", instrument, ms: atMs, direction: "short", entry, stop: entry + a, qi, targetR: 0.75 });
      }
    }
  }
  console.log(instrument, "ok");
}

function simulate(name: string, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.name === name && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(`${s.instrument}|${s.family}`) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 48);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(`${s.instrument}|${s.family}`, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    rs.push(outcome.resultR);
  }
  const n = rs.length;
  if (n < 2) return { name, family: eligible[0]?.family ?? "?", n, avg: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    name, family: eligible[0]?.family ?? "?", n,
    avg: mean.toFixed(3), ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const names = [...new Set(setups.map((s) => s.name))];
const dev = names.map((n) => simulate(n, REPLAY, HOLDOUT));
console.log("=== DEV top ===");
console.table([...dev].sort((a, b) => b._mean - a._mean).slice(0, 12).map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT by family ===");
const wins: string[] = [];
for (const family of ["breakout", "momentum", "meanrev", "ema"]) {
  console.log(`\n# ${family}`);
  for (const row of dev.filter((r) => r.family === family).sort((a, b) => b._mean - a._mean)) {
    if (row.n < 40) continue;
    const h = simulate(row.name, HOLDOUT, null);
    const mark = h.verdict === "WINS" ? " ★★★" : "";
    if (h.verdict === "WINS") wins.push(`${family}: ${row.name}`);
    console.log(`${row.name}: dev ${row.avg} → hold ${h.avg} (${h.verdict}, n=${h.n}) ${h.ci}${mark}`);
  }
}
console.log("\nWINS:", wins.length ? wins.join(" | ") : "none");
process.exit(0);
