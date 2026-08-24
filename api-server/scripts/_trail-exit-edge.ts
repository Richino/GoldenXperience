/**
 * H1 path management: fixed R vs ATR trail vs time stop.
 * Uses simple momentum / meanrev / breakout / EMA-proxy signals (z and EMA).
 * Question: does exit style flip a flat entry into holdout-positive expectancy?
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

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2022-08-01T00:00:00Z");
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];

type Candle = { time: string; open: number; high: number; low: number; close: number };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

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

type Family = "ema" | "breakout" | "momentum" | "meanrev";
type ExitMode = "fixed_1r" | "trail_1atr" | "trail_1.5atr" | "time_8h";

type Setup = {
  family: Family; instrument: string; ms: number; direction: "long" | "short";
  entry: number; stop: number; qi: number; atr: number;
};

function summarise(label: string, rs: number[]) {
  const n = rs.length;
  if (n < 2) return { label, n, avg: "-", win: "-", ci: "-", verdict: "too few", _mean: -999 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(rs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    label, n, avg: mean.toFixed(3),
    win: ((100 * rs.filter((r) => r > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

/** Resolve with bid/ask path. Returns R vs initial risk. */
function resolve(
  direction: "long" | "short",
  entry: number,
  initialStop: number,
  atr: number,
  quotes: Quote[],
  from: number,
  mode: ExitMode,
): { resultR: number; bars: number } | null {
  const risk = Math.abs(entry - initialStop);
  if (!(risk > 0)) return null;
  const maxBars = mode === "time_8h" ? 8 : 48;
  let stop = initialStop;
  let peak = entry;
  const target = mode === "fixed_1r"
    ? (direction === "long" ? entry + risk : entry - risk)
    : null;
  const trailMult = mode === "trail_1atr" ? 1.0 : mode === "trail_1.5atr" ? 1.5 : 0;

  for (let i = from; i < Math.min(quotes.length, from + maxBars); i += 1) {
    const q = quotes[i]!;
    if (direction === "long") {
      const hi = q.bidHigh; const lo = q.bidLow; const close = q.bidClose;
      if (lo <= stop) return { resultR: (stop - entry) / risk, bars: i - from + 1 };
      if (target !== null && hi >= target) return { resultR: 1, bars: i - from + 1 };
      peak = Math.max(peak, hi);
      if (trailMult > 0) stop = Math.max(stop, peak - atr * trailMult);
      if (mode === "time_8h" && i === from + maxBars - 1) return { resultR: (close - entry) / risk, bars: maxBars };
    } else {
      const hi = q.askHigh; const lo = q.askLow; const close = q.askClose;
      if (hi >= stop) return { resultR: (entry - stop) / risk, bars: i - from + 1 };
      if (target !== null && lo <= target) return { resultR: 1, bars: i - from + 1 };
      peak = Math.min(peak, lo);
      if (trailMult > 0) stop = Math.min(stop, peak + atr * trailMult);
      if (mode === "time_8h" && i === from + maxBars - 1) return { resultR: (entry - close) / risk, bars: maxBars };
    }
  }
  const last = quotes[Math.min(quotes.length - 1, from + maxBars - 1)];
  if (!last) return null;
  const close = direction === "long" ? last.bidClose : last.askClose;
  return { resultR: direction === "long" ? (close - entry) / risk : (entry - close) / risk, bars: maxBars };
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

  for (let i = 60; i < candles.length; i += 1) {
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

    const prior = candles.slice(i - 20, i);
    const rangeHigh = Math.max(...prior.map((c) => c.high));
    const rangeLow = Math.min(...prior.map((c) => c.low));
    const ret4 = (bar.close - candles[i - 4]!.close) / a;
    const zWindow = closes.slice(i - 19, i + 1);
    const zMean = zWindow.reduce((s, v) => s + v, 0) / zWindow.length;
    const zSd = Math.sqrt(zWindow.reduce((s, v) => s + (v - zMean) ** 2, 0) / (zWindow.length - 1));
    const z = zSd > 0 ? (bar.close - zMean) / zSd : 0;

    const candidates: Array<{ family: Family; direction: "long" | "short"; stop: number }> = [];

    // ema: pullback to EMA21 in direction of EMA21>EMA50
    if (e21 > e50 && bar.low <= e21 && bar.close > e21) {
      candidates.push({ family: "ema", direction: "long", stop: Math.min(...candles.slice(i - 5, i + 1).map((c) => c.low), bar.close - a) });
    }
    if (e21 < e50 && bar.high >= e21 && bar.close < e21) {
      candidates.push({ family: "ema", direction: "short", stop: Math.max(...candles.slice(i - 5, i + 1).map((c) => c.high), bar.close + a) });
    }

    // breakout: close outside 20-bar range
    if (bar.close > rangeHigh) {
      candidates.push({ family: "breakout", direction: "long", stop: rangeLow });
    }
    if (bar.close < rangeLow) {
      candidates.push({ family: "breakout", direction: "short", stop: rangeHigh });
    }

    // momentum: 4h return ≥ 1 ATR
    if (ret4 >= 1.0) candidates.push({ family: "momentum", direction: "long", stop: bar.close - a });
    if (ret4 <= -1.0) candidates.push({ family: "momentum", direction: "short", stop: bar.close + a });

    // meanrev: |z| ≥ 2 fade
    if (z >= 2) candidates.push({ family: "meanrev", direction: "short", stop: bar.close + a });
    if (z <= -2) candidates.push({ family: "meanrev", direction: "long", stop: bar.close - a });

    for (const c of candidates) {
      const entry = c.direction === "long" ? quote.askClose : quote.bidClose;
      // ensure stop on correct side with min 0.8 ATR
      let stop = c.stop;
      if (c.direction === "long" && entry - stop < a * 0.8) stop = entry - a;
      if (c.direction === "short" && stop - entry < a * 0.8) stop = entry + a;
      setups.push({ family: c.family, instrument, ms: atMs, direction: c.direction, entry, stop, qi, atr: a });
    }
  }
  console.log(instrument, "setups so far", setups.filter((s) => s.instrument === instrument).length);
}

console.log("total setups", setups.length);

const EXITS: ExitMode[] = ["fixed_1r", "trail_1atr", "trail_1.5atr", "time_8h"];
const rows = [];

for (const family of ["ema", "breakout", "momentum", "meanrev"] as Family[]) {
  for (const exit of EXITS) {
    const eligible = setups.filter((s) => s.family === family).sort((a, b) => a.ms - b.ms);
    const run = (fromMs: number, toMs: number | null) => {
      const openUntil = new Map<string, number>();
      const rs: number[] = [];
      for (const s of eligible) {
        if (s.ms < fromMs || (toMs !== null && s.ms >= toMs)) continue;
        if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
        const quotes = quotesBy.get(s.instrument)!;
        const out = resolve(s.direction, s.entry, s.stop, s.atr, quotes, s.qi + 1, exit);
        if (!out) continue;
        openUntil.set(s.instrument, s.ms + out.bars * 3_600_000);
        rs.push(out.resultR);
      }
      return rs;
    };
    const dev = summarise(`${family} · ${exit}`, run(REPLAY, HOLDOUT));
    const holdRs = run(HOLDOUT, null);
    const hold = summarise(`${family} · ${exit}`, holdRs);
    rows.push({
      family, exit,
      dev_n: dev.n, dev_avg: dev.avg, dev: dev.verdict,
      hold_n: hold.n, hold_avg: hold.avg, hold: hold.verdict,
      _mean: hold._mean,
    });
    console.log(`${family} ${exit}: dev ${dev.avg} (${dev.verdict}, n=${dev.n}) → hold ${hold.avg} (${hold.verdict}, n=${hold.n})`);
  }
}

console.log("\n=== ranked by holdout mean ===");
console.table([...rows].sort((a, b) => b._mean - a._mean).map(({ _mean, ...r }) => r));
process.exit(0);
