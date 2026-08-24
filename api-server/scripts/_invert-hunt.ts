/**
 * Invert the confident losers: fade H1 thrusts / fade EMA pullbacks.
 * If V1 momentum loses -0.11R after costs, the opposite path may clear zero.
 * Holdout sealed.
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
const REPLAY = Date.parse("2018-01-01T00:00:00Z");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Setup = {
  name: string; instrument: string; ms: number; direction: "long" | "short";
  entry: number; stop: number; qi: number; targetR: number;
};

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

for (const instrument of PAIRS) {
  const { candles, quotes } = await load(instrument);
  quotesBy.set(instrument, quotes);
  const atr = calculateAtrValues(candles as never, 14);
  const closes = candles.map((c) => c.close);
  const ema21 = calculateEmaValues(closes, 21);
  const ema50 = calculateEmaValues(closes, 50);
  const qIndex = new Map(quotes.map((q, i) => [q.closeTime, i]));
  const pip = pipSizeFor(instrument as never);

  for (let i = 50; i < candles.length; i += 1) {
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

    const ret4 = (bar.close - candles[i - 4]!.close) / a;

    // Fade strong thrust (meanrev from momentum loser)
    if (Math.abs(ret4) >= 1.5) {
      const direction = ret4 > 0 ? "short" as const : "long" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? entry - a * 1.2 : entry + a * 1.2;
      for (const targetR of [0.5, 0.75, 1.0]) {
        setups.push({ name: `fade thrust≥1.5ATR ${targetR}R`, instrument, ms: atMs, direction, entry, stop, qi, targetR });
      }
    }

    // Fade thrust only in ranging (ema flat-ish): |ema21-ema50| < 0.3 ATR
    if (Math.abs(ret4) >= 1.2 && Math.abs(e21 - e50) < a * 0.3) {
      const direction = ret4 > 0 ? "short" as const : "long" as const;
      const entry = direction === "long" ? quote.askClose : quote.bidClose;
      const stop = direction === "long" ? entry - a : entry + a;
      setups.push({ name: "fade thrust ranging 0.75R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75 });
    }

    // Breakout failure: prior bar broke 20-range, this bar closes back inside
    const prior = candles.slice(i - 21, i - 1);
    if (prior.length === 20) {
      const rh = Math.max(...prior.map((c) => c.high));
      const rl = Math.min(...prior.map((c) => c.low));
      const prev = candles[i - 1]!;
      const failedUp = prev.close > rh && bar.close < rh;
      const failedDn = prev.close < rl && bar.close > rl;
      if (failedUp || failedDn) {
        const direction = failedUp ? "short" as const : "long" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? entry - a : entry + a;
        setups.push({ name: "breakout failure fade 0.75R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75 });
        setups.push({ name: "breakout failure fade 1R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 1 });
      }
    }

    // Compressed breakout keep (best prior hint) L20 ≤2.2
    {
      const window = candles.slice(i - 20, i);
      const rh = Math.max(...window.map((c) => c.high));
      const rl = Math.min(...window.map((c) => c.low));
      const rangeAtr = (rh - rl) / a;
      if (rangeAtr <= 2.2 && (bar.close > rh || bar.close < rl)) {
        const direction = bar.close > rh ? "long" as const : "short" as const;
        const entry = direction === "long" ? quote.askClose : quote.bidClose;
        const stop = direction === "long" ? Math.min(rl, entry - a * 0.9) : Math.max(rh, entry + a * 0.9);
        setups.push({ name: "compress L20≤2.2 1R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 1 });
        setups.push({ name: "compress L20≤2.2 0.75R", instrument, ms: atMs, direction, entry, stop, qi, targetR: 0.75 });
      }
    }
  }
  console.log(instrument, "done");
}

function simulate(name: string, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((s) => s.name === name && s.ms >= fromMs && (toMs === null || s.ms < toMs)).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const rs: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    const target = s.direction === "long" ? s.entry + risk * s.targetR : s.entry - risk * s.targetR;
    const quotes = quotesBy.get(s.instrument)!;
    const forward = quotes.slice(s.qi + 1, s.qi + 24);
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

const names = [...new Set(setups.map((s) => s.name))];
console.log("setups", setups.length, "variants", names.length);
console.log("=== DEV ===");
const dev = names.map((n) => simulate(n, REPLAY, HOLDOUT));
console.table(dev.map(({ _mean, ...r }) => r));

console.log("\n=== HOLDOUT ===");
let anyWin = false;
for (const row of [...dev].sort((a, b) => b._mean - a._mean)) {
  if (row.n < 30) continue;
  const hold = simulate(row.name, HOLDOUT, null);
  const mark = hold.verdict === "WINS" ? " ★★★" : "";
  if (hold.verdict === "WINS") anyWin = true;
  console.log(`${row.name}: dev ${row.avg} → hold ${hold.avg} (${hold.verdict}, n=${hold.n}) ${hold.ci}${mark}`);
}
console.log(anyWin ? "FOUND WINS" : "no WINS");
process.exit(0);
