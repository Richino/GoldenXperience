/**
 * Walk-forward validation of every registered strategy.
 *
 * The live sample sizes are far too small to judge these on: ema and breakout
 * looked profitable on 11 and 14 resolved trades, and momentum looked
 * catastrophic on 21 when a 3000-trade replay puts its true rate at about
 * -0.07R. A handful of trades cannot tell an edge from a run of luck, and
 * acting on one that can't is how a system talks itself into a losing strategy.
 *
 * The rules that make the numbers mean anything:
 *
 * - Everything from HOLDOUT_START is sealed and reported separately. Nothing
 *   here is tuned, so the holdout is a genuine out-of-sample read rather than
 *   the last step of a search.
 * - Every strategy replays through the identical harness, over the identical
 *   bars, resolved by the identical labeller. Only the entry rule differs.
 * - No look-ahead: each evaluation sees M15 candles up to the decision bar and
 *   only the H1/H4 candles that had actually closed by then.
 * - One open position per instrument per strategy, as the live pipeline
 *   enforces, so nothing flatters itself by stacking overlapping trades.
 * - The spread is paid: entries fill at ask/bid and exits are labelled against
 *   the opposite side, exactly as the live resolver does.
 *
 * The reported interval is the 95% confidence interval on mean R. An interval
 * that straddles zero means no edge has been demonstrated, however pretty the
 * point estimate looks.
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
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const M15_WINDOW = 260;
const TF_WINDOW = 260;

const STRATEGIES = [
  { name: "ema", run: (i: never, r: never) => evaluateEma(i, r, DEFAULT_EMA_CONFIG) },
  { name: "breakout", run: (i: never, r: never) => evaluateBreakout(i, r, DEFAULT_BREAKOUT_CONFIG) },
  { name: "momentum", run: (i: never, r: never) => evaluateMomentum(i, r, DEFAULT_MOMENTUM_CONFIG) },
  { name: "meanrev", run: (i: never, r: never) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

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

type Trade = { decisionTime: string; instrument: string; resultR: number; mfe: number | null; mae: number | null; outcome: string; stopPips: number; spreadPips: number; atrPips: number };

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (n < 2) return { strategy: label, trades: n, win_rate: "-", avg_R: "-", ci95: "-", net_R: "-", verdict: "too few" };
  const net = trades.reduce((s, t) => s + t.resultR, 0);
  const mean = net / n;
  const variance = trades.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const wins = trades.filter((t) => t.resultR > 0).length;
  return {
    strategy: label, trades: n,
    win_rate: (100 * wins / n).toFixed(0) + "%",
    avg_R: mean.toFixed(3),
    ci95: "[" + lo.toFixed(3) + ", " + hi.toFixed(3) + "]",
    net_R: net.toFixed(1),
    verdict: hi < 0 ? "LOSES (confident)" : lo > 0 ? "WINS (confident)" : "no edge shown",
  };
}

const results: Record<string, Trade[]> = {};
for (const s of STRATEGIES) results[s.name] = [];

for (const instrument of PAIRS) {
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  if (m15.length < M15_WINDOW || h1.length < TF_WINDOW || h4.length < TF_WINDOW) {
    console.log(instrument + ": insufficient history, skipped"); continue;
  }
  const h1Times = h1.map((c) => Date.parse(c.time));
  const h4Times = h4.map((c) => Date.parse(c.time));
  const quoteTimes = quotes.map((q) => Date.parse(q.closeTime));
  const pip = pipSizeFor(instrument as never);
  let h1Cursor = 0; let h4Cursor = 0; let quoteCursor = 0;
  const openUntil: Record<string, number> = {};
  for (const s of STRATEGIES) openUntil[s.name] = 0;

  for (let index = M15_WINDOW; index < m15.length; index += 1) {
    const bar = m15[index]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY_START) continue;
    h1Cursor = lastClosedIndex(h1Times, atMs, h1Cursor);
    h4Cursor = lastClosedIndex(h4Times, atMs, h4Cursor);
    quoteCursor = lastClosedIndex(quoteTimes, atMs, quoteCursor);
    if (h1Cursor < TF_WINDOW || h4Cursor < TF_WINDOW) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;

    const quote = quotes[quoteCursor];
    if (!quote || quoteTimes[quoteCursor] !== atMs) continue;
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
      if (atMs < openUntil[strategy.name]!) continue;
      const candidate = strategy.run(input as never, regime as never);
      if (candidate.status !== "valid" || !candidate.direction) continue;
      if (candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
      const forward = quotes.slice(quoteCursor + 1, quoteCursor + 400);
      if (!forward.length) continue;
      const outcome = labelOutcome(candidate.direction, candidate.entry, candidate.stop, candidate.target, bar.time, forward as never);
      if (outcome.outcome === "unresolved" || outcome.outcome === "ambiguous" || outcome.resultR === null) continue;
      openUntil[strategy.name] = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      results[strategy.name]!.push({
        decisionTime: bar.time, instrument, resultR: outcome.resultR,
        mfe: outcome.maxFavorableR, mae: outcome.maxAdverseR, outcome: outcome.outcome,
        stopPips: Math.abs(candidate.entry - candidate.stop) / pip, spreadPips, atrPips: regime.atrPips ?? 0,
      });
    }
  }
  console.log(instrument + " done: " + STRATEGIES.map((s) => s.name + "=" + results[s.name]!.filter((t) => t.instrument === instrument).length).join(" "));
}

const dev = (t: Trade) => Date.parse(t.decisionTime) < HOLDOUT_START;
console.log("\n=== DEVELOPMENT (" + new Date(REPLAY_START).toISOString().slice(0, 10) + " to " + new Date(HOLDOUT_START).toISOString().slice(0, 10) + ") ===");
console.table(STRATEGIES.map((s) => summarise(s.name, results[s.name]!.filter(dev))));

console.log("\n=== HOLDOUT (out of sample) ===");
console.table(STRATEGIES.map((s) => summarise(s.name, results[s.name]!.filter((t) => !dev(t)))));

console.log("\n=== FULL PERIOD ===");
console.table(STRATEGIES.map((s) => summarise(s.name, results[s.name]!)));

console.log("\n=== excursion + outcome mix, full period ===");
console.table(STRATEGIES.map((s) => {
  const t = results[s.name]!;
  const mfe = t.filter((x) => x.mfe !== null); const mae = t.filter((x) => x.mae !== null);
  return {
    strategy: s.name,
    avg_peak_gain: mfe.length ? (mfe.reduce((a, x) => a + x.mfe!, 0) / mfe.length).toFixed(2) : "-",
    avg_peak_pain: mae.length ? (mae.reduce((a, x) => a + x.mae!, 0) / mae.length).toFixed(2) : "-",
    target_first: t.filter((x) => x.outcome === "target_first").length,
    stop_first: t.filter((x) => x.outcome === "stop_first").length,
    forced_close: t.filter((x) => x.outcome === "forced_close").length,
  };
}));
console.log("\n=== IS THE LOSS JUST THE SPREAD? ===");
console.table(STRATEGIES.map((s) => {
  const trades = results[s.name]!;
  if (!trades.length) return { strategy: s.name };
  const avg = (pick: (x: Trade) => number) => trades.reduce((a, x) => a + pick(x), 0) / trades.length;
  // Crossing the spread costs a fixed fraction of the stop distance on every
  // trade, whatever the entry rule does: a stop 10 pips away with a 1.3 pip
  // spread starts 13% of the way to being wrong. If realised R matches that
  // fraction, the entry rule contributed nothing at all — and the ranking
  // between strategies is then just a ranking of how wide their stops are.
  const cost = avg((x) => x.stopPips > 0 ? x.spreadPips / x.stopPips : 0);
  const actual = avg((x) => x.resultR);
  return {
    strategy: s.name,
    stop_ATR: avg((x) => x.atrPips > 0 ? x.stopPips / x.atrPips : 0).toFixed(2),
    stop_pips: avg((x) => x.stopPips).toFixed(1),
    spread_pips: avg((x) => x.spreadPips).toFixed(2),
    predicted_R_from_spread: (-cost).toFixed(3),
    actual_R: actual.toFixed(3),
    edge_after_costs: (actual + cost).toFixed(3),
  };
}));
process.exit(0);
