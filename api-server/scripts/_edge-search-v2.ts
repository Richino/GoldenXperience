/**
 * Edge search for EMA / Breakout / Momentum / MeanRev V2 candidates.
 *
 * One expensive replay records every valid V1 setup PLUS the features needed to
 * re-label cheaper variants (target R, regime filter, session filter). Variants
 * are pre-registered and ranked on development only; holdout is sealed.
 *
 * Writes nothing. Reads candles from the database.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { classifyRegime } = await import("../../frontend/src/lib/strategy/regime.js");
const { evaluateEma, DEFAULT_EMA_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/ema.js");
const { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/breakout.js");
const { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/momentum.js");
const { evaluateMeanReversion, DEFAULT_MEANREV_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/meanrev.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT_START = Date.parse("2025-08-01T00:00:00Z");
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2023-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const M15_WINDOW = 260;
const TF_WINDOW = 260;

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

type Setup = {
  family: string;
  instrument: string;
  decisionTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  regime: string;
  session: string;
  trendStrength: number;
  plannedR: number;
};

type Variant = {
  family: string;
  name: string;
  targetR?: number;
  regimes?: string[];
  sessions?: string[];
  minTrendStrength?: number;
};

const VARIANTS: Variant[] = [
  // EMA
  { family: "ema", name: "ema baseline" },
  { family: "ema", name: "ema trending-only", regimes: ["trending"] },
  { family: "ema", name: "ema trending + 1.5R", regimes: ["trending"], targetR: 1.5 },
  { family: "ema", name: "ema trending + 1.25R", regimes: ["trending"], targetR: 1.25 },
  { family: "ema", name: "ema trending + R²≥0.45", regimes: ["trending"], minTrendStrength: 0.45 },
  { family: "ema", name: "ema trending + 1.5R + R²≥0.45", regimes: ["trending"], targetR: 1.5, minTrendStrength: 0.45 },
  { family: "ema", name: "ema London+overlap", sessions: ["London", "London/New York overlap"], regimes: ["trending"], targetR: 1.5 },
  // Breakout
  { family: "breakout", name: "breakout baseline" },
  { family: "breakout", name: "breakout not-ranging", regimes: ["trending", "mixed"] },
  { family: "breakout", name: "breakout trending-only", regimes: ["trending"] },
  { family: "breakout", name: "breakout trending + 1.25R", regimes: ["trending"], targetR: 1.25 },
  { family: "breakout", name: "breakout trending + 1.0R", regimes: ["trending"], targetR: 1.0 },
  { family: "breakout", name: "breakout overlap + trending + 1.25R", regimes: ["trending"], sessions: ["London/New York overlap"], targetR: 1.25 },
  { family: "breakout", name: "breakout London+overlap + trending + 1.25R", regimes: ["trending"], sessions: ["London", "London/New York overlap"], targetR: 1.25 },
  // Momentum — geometry says paths lose; test short targets + filters anyway
  { family: "momentum", name: "momentum baseline" },
  { family: "momentum", name: "momentum 0.75R", targetR: 0.75 },
  { family: "momentum", name: "momentum 0.5R", targetR: 0.5 },
  { family: "momentum", name: "momentum overlap + 0.75R", sessions: ["London/New York overlap"], targetR: 0.75 },
  { family: "momentum", name: "momentum mixed+ranging + 0.75R", regimes: ["mixed", "ranging"], targetR: 0.75 },
  { family: "momentum", name: "momentum trending-only + 0.75R", regimes: ["trending"], targetR: 0.75 },
  // Meanrev
  { family: "meanrev", name: "meanrev baseline" },
  { family: "meanrev", name: "meanrev ranging-only", regimes: ["ranging"] },
];

async function loadCandles(instrument: string, timeframe: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`,
    [instrument, timeframe],
  );
  return rows.rows.map((row) => ({
    time: new Date(row.close_time as string).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    volume: Number(row.volume ?? 0), complete: true,
  }));
}

async function loadQuotes(instrument: string): Promise<Quote[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`,
    [instrument],
  );
  return rows.rows.map((row) => ({
    closeTime: new Date(row.close_time as string).toISOString(),
    bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
    askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
  }));
}

function lastClosedIndex(times: number[], atMs: number, from: number): number {
  let index = from;
  while (index + 1 < times.length && times[index + 1]! <= atMs) index += 1;
  return index;
}

function sessionName(at: Date): string {
  return dayTradingSession(at).label;
}

const STRATEGIES = [
  { name: "ema", run: (i: never, r: never) => evaluateEma(i, r, DEFAULT_EMA_CONFIG) },
  { name: "breakout", run: (i: never, r: never) => evaluateBreakout(i, r, DEFAULT_BREAKOUT_CONFIG) },
  { name: "momentum", run: (i: never, r: never) => evaluateMomentum(i, r, DEFAULT_MOMENTUM_CONFIG) },
  { name: "meanrev", run: (i: never, r: never) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

const setups: Setup[] = [];
const quotesByPair = new Map<string, Quote[]>();

for (const instrument of PAIRS) {
  const started = Date.now();
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  quotesByPair.set(instrument, quotes);
  if (m15.length < M15_WINDOW || h1.length < TF_WINDOW || h4.length < TF_WINDOW) {
    console.log(instrument + ": insufficient history, skipped");
    continue;
  }
  const h1Times = h1.map((c) => Date.parse(c.time));
  const h4Times = h4.map((c) => Date.parse(c.time));
  const quoteTimes = quotes.map((q) => Date.parse(q.closeTime));
  let h1Cursor = 0; let h4Cursor = 0; let quoteCursor = 0;
  let collected = 0;

  for (let index = M15_WINDOW; index < m15.length; index += 1) {
    const bar = m15[index]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY_START) continue;
    h1Cursor = lastClosedIndex(h1Times, atMs, h1Cursor);
    h4Cursor = lastClosedIndex(h4Times, atMs, h4Cursor);
    quoteCursor = lastClosedIndex(quoteTimes, atMs, quoteCursor);
    if (h1Cursor < TF_WINDOW || h4Cursor < TF_WINDOW) continue;
    const at = new Date(atMs);
    if (!dayTradingSession(at).open) continue;
    const quote = quotes[quoteCursor];
    if (!quote || quoteTimes[quoteCursor] !== atMs) continue;
    const pip = pipSizeFor(instrument as never);
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

    const candles15m = m15.slice(index - M15_WINDOW + 1, index + 1);
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m, candles1h: h1.slice(h1Cursor - TF_WINDOW + 1, h1Cursor + 1), candles4h: h4.slice(h4Cursor - TF_WINDOW + 1, h4Cursor + 1),
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candles15m, bar.time);

    for (const strategy of STRATEGIES) {
      const candidate = strategy.run(input as never, regime as never);
      if (candidate.status !== "valid" || !candidate.direction) continue;
      if (candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
      setups.push({
        family: strategy.name,
        instrument,
        decisionTime: bar.time,
        direction: candidate.direction,
        entry: candidate.entry,
        stop: candidate.stop,
        target: candidate.target,
        regime: regime.regime,
        session: sessionName(at),
        trendStrength: regime.trendStrength,
        plannedR: Math.abs(candidate.target - candidate.entry) / Math.abs(candidate.entry - candidate.stop),
      });
      collected += 1;
    }
  }
  console.log(`${instrument}: ${collected} valid setups (${Math.round((Date.now() - started) / 1000)}s)`);
}

console.log(`\nTotal setups: ${setups.length}`);

function simulate(variant: Variant, fromMs: number, toMs: number | null) {
  const eligible = setups.filter((setup) => {
    if (setup.family !== variant.family) return false;
    const t = Date.parse(setup.decisionTime);
    if (t < fromMs) return false;
    if (toMs !== null && t >= toMs) return false;
    if (variant.regimes && !variant.regimes.includes(setup.regime)) return false;
    if (variant.sessions && !variant.sessions.includes(setup.session)) return false;
    if (variant.minTrendStrength !== undefined && setup.trendStrength < variant.minTrendStrength) return false;
    return true;
  });

  const openUntil = new Map<string, number>();
  const results: number[] = [];
  let wins = 0;

  for (const setup of eligible.sort((a, b) => Date.parse(a.decisionTime) - Date.parse(b.decisionTime))) {
    const atMs = Date.parse(setup.decisionTime);
    const key = `${setup.family}|${setup.instrument}`;
    if (atMs < (openUntil.get(key) ?? 0)) continue;

    const risk = Math.abs(setup.entry - setup.stop);
    const targetR = variant.targetR ?? setup.plannedR;
    const target = setup.direction === "long" ? setup.entry + risk * targetR : setup.entry - risk * targetR;
    const quotes = quotesByPair.get(setup.instrument)!;
    const start = quotes.findIndex((q) => Date.parse(q.closeTime) > atMs);
    if (start < 0) continue;
    const outcome = labelOutcome(setup.direction, setup.entry, setup.stop, target, setup.decisionTime, quotes.slice(start, start + 400) as never);
    if (outcome.outcome === "unresolved" || outcome.outcome === "ambiguous" || outcome.resultR === null) continue;
    openUntil.set(key, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs);
    results.push(outcome.resultR);
    if (outcome.resultR > 0) wins += 1;
  }

  const n = results.length;
  if (n < 2) return { name: variant.name, family: variant.family, trades: n, win_pct: "-", avg_r: "-", ci95: "-", net_r: "-", verdict: "too few" };
  const net = results.reduce((s, v) => s + v, 0);
  const mean = net / n;
  const variance = results.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const lo = mean - 1.96 * se;
  const hi = mean + 1.96 * se;
  return {
    name: variant.name,
    family: variant.family,
    trades: n,
    win_pct: ((100 * wins) / n).toFixed(0) + "%",
    avg_r: mean.toFixed(3),
    ci95: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    net_r: net.toFixed(1),
    verdict: hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
    _lo: lo,
    _hi: hi,
    _n: n,
  };
}

console.log("\n=== DEVELOPMENT (rank here) ===");
const devRows = VARIANTS.map((v) => simulate(v, REPLAY_START, HOLDOUT_START));
console.table(devRows.map(({ _mean, _lo, _hi, _n, ...row }) => row));

console.log("\n=== HOLDOUT (sealed — report winners only once) ===");
const winners = devRows.filter((r) => r.verdict === "WINS");
const holdoutRows = (winners.length ? winners : devRows.filter((r) => r.name.includes("baseline") || r.verdict !== "too few"))
  .map((row) => {
    const variant = VARIANTS.find((v) => v.name === row.name)!;
    return simulate(variant, HOLDOUT_START, null);
  });
console.table(holdoutRows.map(({ _mean, _lo, _hi, _n, ...row }) => row));

console.log("\n=== Best per family on development (then holdout) ===");
for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
  const familyDev = devRows.filter((r) => r.family === family && r.trades !== "-" && Number(r.trades) >= 30)
    .sort((a, b) => (b as { _mean: number })._mean - (a as { _mean: number })._mean);
  const best = familyDev[0];
  if (!best) {
    console.log(`${family}: no variant with ≥30 trades`);
    continue;
  }
  const hold = simulate(VARIANTS.find((v) => v.name === best.name)!, HOLDOUT_START, null);
  console.log(`${family}: best="${best.name}" dev avgR=${best.avg_r} (${best.verdict}, n=${best.trades}) → holdout avgR=${hold.avg_r} (${hold.verdict}, n=${hold.trades})`);
}

process.exit(0);
