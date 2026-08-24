/**
 * Walk-forward replay of Momentum V1 against Momentum V2.
 *
 * V2 was designed from V1's failure mode (it bought local extremes; average
 * peak pain 0.93R against average peak gain 0.56R), not fitted to any result.
 * This is the test of that hypothesis, and it is allowed to fail.
 *
 * The rules that make the number mean anything:
 *
 * - Everything from HOLDOUT_START is sealed. V2 is judged on the development
 *   period; the holdout is read once, at the end, and only to confirm or refute
 *   what development already claimed. A number that has been optimised against
 *   is not evidence.
 * - Both versions replay through the identical harness, over the identical
 *   bars, resolved by the identical labeller. The only difference is the entry.
 * - No look-ahead: every evaluation sees M15 candles up to the decision bar and
 *   only those H1/H4 candles that had actually closed by then, which is the
 *   trap a naive replay falls into.
 * - One open position per instrument, as the live pipeline enforces, so a
 *   version cannot look good by stacking overlapping trades.
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
const { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/momentum.js");
const { evaluateMomentumV2, DEFAULT_MOMENTUM_V2_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/momentum-v2.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT_START = Date.parse("2025-08-01T00:00:00Z");
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const M15_WINDOW = 260;
const TF_WINDOW = 260;

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

/** Index of the last candle that had CLOSED at or before `atMs`. The whole
 *  point of the replay: an H1 bar that closes after the decision does not exist
 *  yet, and letting one in is the classic way a backtest invents an edge. */
function lastClosedIndex(times: number[], atMs: number, from: number): number {
  let index = from;
  while (index + 1 < times.length && times[index + 1]! <= atMs) index += 1;
  return index;
}

type Trade = { decisionTime: string; instrument: string; direction: "long" | "short"; resultR: number; mfe: number | null; mae: number | null; outcome: string; openUntil: number };

function summarise(label: string, trades: Trade[]) {
  const n = trades.length;
  if (!n) return { variant: label, trades: 0, win_rate: "-", net_R: "0.00", avg_R: "-", avg_mfe: "-", avg_mae: "-", profit_factor: "-" };
  const wins = trades.filter((t) => t.resultR > 0);
  const losses = trades.filter((t) => t.resultR < 0);
  const gross = wins.reduce((s, t) => s + t.resultR, 0);
  const bad = Math.abs(losses.reduce((s, t) => s + t.resultR, 0));
  const net = trades.reduce((s, t) => s + t.resultR, 0);
  const mfe = trades.filter((t) => t.mfe !== null);
  const mae = trades.filter((t) => t.mae !== null);
  return {
    variant: label, trades: n,
    win_rate: (100 * wins.length / n).toFixed(0) + "%",
    net_R: net.toFixed(2), avg_R: (net / n).toFixed(3),
    avg_mfe: mfe.length ? (mfe.reduce((s, t) => s + t.mfe!, 0) / mfe.length).toFixed(2) : "-",
    avg_mae: mae.length ? (mae.reduce((s, t) => s + t.mae!, 0) / mae.length).toFixed(2) : "-",
    profit_factor: bad > 0 ? (gross / bad).toFixed(2) : "inf",
  };
}

const results: Record<string, Trade[]> = { v1: [], v2: [] };

for (const instrument of PAIRS) {
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  if (m15.length < M15_WINDOW || h1.length < TF_WINDOW || h4.length < TF_WINDOW) {
    console.log(instrument + ": insufficient history (" + m15.length + "/" + h1.length + "/" + h4.length + "), skipped");
    continue;
  }
  const h1Times = h1.map((c) => Date.parse(c.time));
  const h4Times = h4.map((c) => Date.parse(c.time));
  const quoteTimes = quotes.map((q) => Date.parse(q.closeTime));
  const pip = pipSizeFor(instrument as never);
  let h1Cursor = 0; let h4Cursor = 0; let quoteCursor = 0;
  const openUntil: Record<string, number> = { v1: 0, v2: 0 };
  let evaluated = 0;

  for (let index = M15_WINDOW; index < m15.length; index += 1) {
    const bar = m15[index]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY_START) continue;

    h1Cursor = lastClosedIndex(h1Times, atMs, h1Cursor);
    h4Cursor = lastClosedIndex(h4Times, atMs, h4Cursor);
    quoteCursor = lastClosedIndex(quoteTimes, atMs, quoteCursor);
    if (h1Cursor < TF_WINDOW || h4Cursor < TF_WINDOW) continue;

    const session = dayTradingSession(new Date(atMs));
    if (!session.open) continue;                       // the live gate; skip early, it is most bars

    const quote = quotes[quoteCursor];
    if (!quote || quoteTimes[quoteCursor] !== atMs) continue;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

    const candles15m = m15.slice(index - M15_WINDOW + 1, index + 1);
    const candles1h = h1.slice(h1Cursor - TF_WINDOW + 1, h1Cursor + 1);
    const candles4h = h4.slice(h4Cursor - TF_WINDOW + 1, h4Cursor + 1);
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m, candles1h, candles4h,
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candles15m, bar.time);
    evaluated += 1;

    for (const [label, candidate] of [
      ["v1", evaluateMomentum(input, regime, DEFAULT_MOMENTUM_CONFIG)],
      ["v2", evaluateMomentumV2(input, regime, DEFAULT_MOMENTUM_V2_CONFIG)],
    ] as const) {
      if (candidate.status !== "valid" || !candidate.direction) continue;
      if (candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
      if (atMs < openUntil[label]!) continue;          // one open position per instrument

      const forward = quotes.slice(quoteCursor + 1, quoteCursor + 400);
      if (!forward.length) continue;
      const outcome = labelOutcome(candidate.direction, candidate.entry, candidate.stop, candidate.target, bar.time, forward as never);
      if (outcome.outcome === "unresolved" || outcome.outcome === "ambiguous" || outcome.resultR === null) continue;
      const closedMs = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      openUntil[label] = closedMs;
      results[label]!.push({
        decisionTime: bar.time, instrument, direction: candidate.direction, resultR: outcome.resultR,
        mfe: outcome.maxFavorableR, mae: outcome.maxAdverseR, outcome: outcome.outcome, openUntil: closedMs,
      });
    }
  }
  console.log(instrument + ": " + evaluated + " in-session bars evaluated, v1 " + results.v1!.filter((t) => t.instrument === instrument).length + " trades, v2 " + results.v2!.filter((t) => t.instrument === instrument).length);
}

const dev = (t: Trade) => Date.parse(t.decisionTime) < HOLDOUT_START;
console.log("\n=== DEVELOPMENT PERIOD (" + new Date(REPLAY_START).toISOString().slice(0, 10) + " to " + new Date(HOLDOUT_START).toISOString().slice(0, 10) + ") ===");
console.table([summarise("V1 (live today)", results.v1!.filter(dev)), summarise("V2 (pullback entry)", results.v2!.filter(dev))]);

console.log("\n=== HOLDOUT (sealed until now, read once) ===");
console.table([summarise("V1 (live today)", results.v1!.filter((t) => !dev(t))), summarise("V2 (pullback entry)", results.v2!.filter((t) => !dev(t)))]);

console.log("\n=== V2 by pair, development period ===");
console.table(PAIRS.map((p) => summarise(p, results.v2!.filter((t) => dev(t) && t.instrument === p))));

console.log("\n=== V2 outcome mix, development period ===");
const mix: Record<string, number> = {};
for (const t of results.v2!.filter(dev)) mix[t.outcome] = (mix[t.outcome] ?? 0) + 1;
console.table(Object.entries(mix).map(([outcome, n]) => ({ outcome, n })));
process.exit(0);
