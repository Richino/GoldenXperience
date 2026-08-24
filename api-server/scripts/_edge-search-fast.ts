/**
 * Fast edge search: record V1 setups once, re-label variants with O(1) quote index.
 * Sealed holdout from 2025-08-01. Rank on development only.
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
  family: string; instrument: string; decisionTime: string; decisionMs: number;
  direction: "long" | "short"; entry: number; stop: number; target: number;
  regime: string; session: string; trendStrength: number; plannedR: number; quoteIndex: number;
};

type Variant = {
  family: string; name: string; targetR?: number; regimes?: string[]; sessions?: string[];
  minTrendStrength?: number; invert?: boolean;
};

const VARIANTS: Variant[] = [
  { family: "ema", name: "ema baseline" },
  { family: "ema", name: "ema 0.75R", targetR: 0.75 },
  { family: "ema", name: "ema 1.0R", targetR: 1.0 },
  { family: "ema", name: "ema trending + 0.75R", regimes: ["trending"], targetR: 0.75 },
  { family: "ema", name: "ema trending + 1.0R", regimes: ["trending"], targetR: 1.0 },
  { family: "ema", name: "ema trending + R²≥0.5 + 0.75R", regimes: ["trending"], minTrendStrength: 0.5, targetR: 0.75 },
  { family: "ema", name: "ema invert + 0.75R", invert: true, targetR: 0.75 },
  { family: "ema", name: "ema trending invert + 0.75R", regimes: ["trending"], invert: true, targetR: 0.75 },

  { family: "breakout", name: "breakout baseline" },
  { family: "breakout", name: "breakout 0.75R", targetR: 0.75 },
  { family: "breakout", name: "breakout 1.0R", targetR: 1.0 },
  { family: "breakout", name: "breakout trending + 0.75R", regimes: ["trending"], targetR: 0.75 },
  { family: "breakout", name: "breakout trending + 1.0R", regimes: ["trending"], targetR: 1.0 },
  { family: "breakout", name: "breakout overlap + trending + 0.75R", regimes: ["trending"], sessions: ["London/New York overlap"], targetR: 0.75 },
  { family: "breakout", name: "breakout invert + 0.75R", invert: true, targetR: 0.75 },

  { family: "momentum", name: "momentum baseline" },
  { family: "momentum", name: "momentum 0.5R", targetR: 0.5 },
  { family: "momentum", name: "momentum 0.75R", targetR: 0.75 },
  { family: "momentum", name: "momentum overlap + 0.5R", sessions: ["London/New York overlap"], targetR: 0.5 },
  { family: "momentum", name: "momentum invert + 0.5R", invert: true, targetR: 0.5 },
  { family: "momentum", name: "momentum invert + 0.75R", invert: true, targetR: 0.75 },

  { family: "meanrev", name: "meanrev baseline" },
  { family: "meanrev", name: "meanrev ranging-only", regimes: ["ranging"] },
  { family: "meanrev", name: "meanrev ranging + keep target", regimes: ["ranging"] },
  { family: "meanrev", name: "meanrev invert (fade the fade) 0.75R", invert: true, targetR: 0.75 },
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
  const quoteIndexByMs = new Map(quoteTimes.map((t, i) => [t, i]));
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
    const qIndex = quoteIndexByMs.get(atMs);
    if (qIndex === undefined) continue;

    for (const strategy of STRATEGIES) {
      const candidate = strategy.run(input as never, regime as never);
      if (candidate.status !== "valid" || !candidate.direction) continue;
      if (candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
      setups.push({
        family: strategy.name, instrument, decisionTime: bar.time, decisionMs: atMs,
        direction: candidate.direction, entry: candidate.entry, stop: candidate.stop, target: candidate.target,
        regime: regime.regime, session: dayTradingSession(at).label, trendStrength: regime.trendStrength,
        plannedR: Math.abs(candidate.target - candidate.entry) / Math.abs(candidate.entry - candidate.stop),
        quoteIndex: qIndex,
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
    if (setup.decisionMs < fromMs) return false;
    if (toMs !== null && setup.decisionMs >= toMs) return false;
    if (variant.regimes && !variant.regimes.includes(setup.regime)) return false;
    if (variant.sessions && !variant.sessions.includes(setup.session)) return false;
    if (variant.minTrendStrength !== undefined && setup.trendStrength < variant.minTrendStrength) return false;
    return true;
  }).sort((a, b) => a.decisionMs - b.decisionMs);

  const openUntil = new Map<string, number>();
  const results: number[] = [];
  let wins = 0;

  for (const setup of eligible) {
    const key = `${setup.family}|${setup.instrument}`;
    if (setup.decisionMs < (openUntil.get(key) ?? 0)) continue;

    const risk = Math.abs(setup.entry - setup.stop);
    const targetR = variant.targetR ?? setup.plannedR;
    let direction = setup.direction;
    let entry = setup.entry;
    let stop = setup.stop;
    let target = direction === "long" ? entry + risk * targetR : entry - risk * targetR;

    if (variant.invert) {
      // Fade the signal: flip direction, swap stop/target geometry around entry.
      direction = direction === "long" ? "short" : "long";
      stop = direction === "long" ? entry - risk : entry + risk;
      target = direction === "long" ? entry + risk * targetR : entry - risk * targetR;
    }

    const quotes = quotesByPair.get(setup.instrument)!;
    const forward = quotes.slice(setup.quoteIndex + 1, setup.quoteIndex + 401);
    if (!forward.length) continue;
    const outcome = labelOutcome(direction, entry, stop, target, setup.decisionTime, forward as never);
    if (outcome.outcome === "unresolved" || outcome.outcome === "ambiguous" || outcome.resultR === null) continue;
    openUntil.set(key, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : setup.decisionMs);
    results.push(outcome.resultR);
    if (outcome.resultR > 0) wins += 1;
  }

  const n = results.length;
  if (n < 2) return { name: variant.name, family: variant.family, trades: n, win_pct: "-", avg_r: "-", ci95: "-", net_r: "-", verdict: "too few", _mean: -999, _lo: -999, _hi: -999 };
  const net = results.reduce((s, v) => s + v, 0);
  const mean = net / n;
  const variance = results.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const lo = mean - 1.96 * se;
  const hi = mean + 1.96 * se;
  return {
    name: variant.name, family: variant.family, trades: n,
    win_pct: ((100 * wins) / n).toFixed(0) + "%",
    avg_r: mean.toFixed(3),
    ci95: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    net_r: net.toFixed(1),
    verdict: hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean, _lo: lo, _hi: hi,
  };
}

console.log("\n=== DEVELOPMENT ===");
const devRows = VARIANTS.map((v) => simulate(v, REPLAY_START, HOLDOUT_START));
console.table(devRows.map(({ _mean, _lo, _hi, ...row }) => row));

console.log("\n=== Best per family → HOLDOUT ===");
for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
  const ranked = devRows
    .filter((r) => r.family === family && typeof r.trades === "number" && r.trades >= 40)
    .sort((a, b) => b._mean - a._mean);
  const best = ranked[0];
  const baseline = ranked.find((r) => r.name.includes("baseline"));
  if (!best) { console.log(`${family}: no variant with ≥40 trades`); continue; }
  const holdBest = simulate(VARIANTS.find((v) => v.name === best.name)!, HOLDOUT_START, null);
  const holdBase = baseline ? simulate(VARIANTS.find((v) => v.name === baseline.name)!, HOLDOUT_START, null) : null;
  console.log(`${family}: BEST "${best.name}" dev=${best.avg_r} (${best.verdict}, n=${best.trades}) holdout=${holdBest.avg_r} (${holdBest.verdict}, n=${holdBest.trades})`);
  if (holdBase) console.log(`         baseline holdout=${holdBase.avg_r} (${holdBase.verdict}, n=${holdBase.trades})`);
}

console.log("\n=== HOLDOUT for every WINS-on-dev variant ===");
const winners = devRows.filter((r) => r.verdict === "WINS");
if (!winners.length) console.log("(none won on development)");
else console.table(winners.map((row) => {
  const hold = simulate(VARIANTS.find((v) => v.name === row.name)!, HOLDOUT_START, null);
  return { name: row.name, dev_avg: row.avg_r, hold_avg: hold.avg_r, hold_n: hold.trades, hold_verdict: hold.verdict, hold_ci: hold.ci95 };
}));

process.exit(0);
