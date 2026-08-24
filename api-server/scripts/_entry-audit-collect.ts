/**
 * Entry-location audit, collection pass.
 *
 * One expensive walk-forward replay that records, for every entry all four
 * strategies would actually have taken, the full market state at the decision
 * bar and what price did afterwards. Analysis runs separately and cheaply off
 * this record, so re-cutting the data costs seconds instead of another replay.
 *
 * Discipline carried over from the rest of the research here:
 *   - No look-ahead. Every feature is computed from candles up to and including
 *     the decision bar; forward measurements come only from bars after it.
 *   - The spread is paid: entries fill at ask/bid, exits label against the
 *     opposite side, exactly as the live resolver does.
 *   - One open position per instrument per strategy, as the live pipeline
 *     enforces.
 *   - DEV/HOLDOUT is stamped on each row but NOT used here. The split exists so
 *     the analysis pass can honour it; this pass simply records everything.
 *
 * Writes a JSONL record. Reads candles from the database, writes nothing to it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { labelOutcome } = await import("../src/research.js");
const { classifyRegime } = await import("../../frontend/src/lib/strategy/regime.js");
const { calculateAtrValues, calculateEmaValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { evaluateEma, DEFAULT_EMA_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/ema.js");
const { evaluateBreakout, DEFAULT_BREAKOUT_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/breakout.js");
const { evaluateMomentum, DEFAULT_MOMENTUM_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/momentum.js");
const { evaluateMeanReversion, DEFAULT_MEANREV_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/meanrev.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT_START = Date.parse("2025-08-01T00:00:00Z");
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "entry-audit.jsonl");
const M15_WINDOW = 260;
const TF_WINDOW = 260;
/** Bars of forward price used for the post-exit "was the direction right" read. */
const POST_EXIT_BARS = 24;

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

/** Favourable/adverse excursion, in price units, over a slice of forward bars,
 *  measured on the side of the book the trade would actually exit against. */
function excursion(direction: "long" | "short", entry: number, forward: Quote[]) {
  let best = 0; let worst = 0;
  for (const q of forward) {
    const up = direction === "long" ? q.bidHigh - entry : entry - q.askLow;
    const down = direction === "long" ? q.bidLow - entry : entry - q.askHigh;
    if (up > best) best = up;
    if (down < worst) worst = down;
  }
  return { best, worst };
}

const rows: unknown[] = [];

for (const instrument of PAIRS) {
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  if (m15.length < M15_WINDOW || h1.length < TF_WINDOW || h4.length < TF_WINDOW) { console.log(instrument + ": insufficient history, skipped"); continue; }
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
    const session = dayTradingSession(new Date(atMs));
    if (!session.open) continue;
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
    const atr = regime.atr ?? 0;
    if (!(atr > 0)) continue;

    for (const strategy of STRATEGIES) {
      if (atMs < openUntil[strategy.name]!) continue;
      const candidate = strategy.run(input as never, regime as never);
      if (candidate.status !== "valid" || !candidate.direction) continue;
      if (candidate.entry === null || candidate.stop === null || candidate.target === null) continue;
      const forward = quotes.slice(quoteCursor + 1, quoteCursor + 400);
      if (forward.length < 20) continue;
      const outcome = labelOutcome(candidate.direction, candidate.entry, candidate.stop, candidate.target, bar.time, forward as never);
      if (outcome.outcome === "unresolved" || outcome.outcome === "ambiguous" || outcome.resultR === null) continue;
      openUntil[strategy.name] = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;

      const dir = candidate.direction;
      const sign = dir === "long" ? 1 : -1;
      const entry = candidate.entry;
      const risk = Math.abs(entry - candidate.stop);
      const closes = candles15m.map((c) => c.close);
      const last = candles15m.at(-1)!;

      // --- location inside recent range, at several honest lookbacks ---------
      const location: Record<string, number> = {};
      for (const look of [10, 20, 50]) {
        const w = candles15m.slice(-look);
        const hi = Math.max(...w.map((c) => c.high));
        const lo = Math.min(...w.map((c) => c.low));
        const span = hi - lo;
        // 1.0 always means "extreme in the direction being traded": the top of
        // the range for a long, the bottom for a short. So a high number is a
        // bad location for either side without needing to remember which.
        const raw = span > 0 ? (entry - lo) / span : 0.5;
        location["rangePos" + look] = dir === "long" ? raw : 1 - raw;
        location["distToExtreme" + look] = (dir === "long" ? hi - entry : entry - lo) / atr;
        location["distToOpposite" + look] = (dir === "long" ? entry - lo : hi - entry) / atr;
      }

      // --- how far the move had already gone before the entry ---------------
      const preMove: Record<string, number> = {};
      for (const n of [1, 3, 6]) {
        const before = closes.at(-1 - n);
        preMove["preMove" + n] = before === undefined ? 0 : (sign * (last.close - before)) / atr;
      }

      // --- the signal candle itself -----------------------------------------
      const range = last.high - last.low;
      const body = Math.abs(last.close - last.open);
      const upperWick = last.high - Math.max(last.open, last.close);
      const lowerWick = Math.min(last.open, last.close) - last.low;
      let consecutive = 0;
      for (let k = candles15m.length - 1; k >= 0; k -= 1) {
        const c = candles15m[k]!;
        const inDir = dir === "long" ? c.close > c.open : c.close < c.open;
        if (inDir) consecutive += 1; else break;
      }

      // --- volatility percentile and distance from the rolling mean ---------
      const atrSeries = calculateAtrValues(candles15m, 14).filter((v): v is number => typeof v === "number" && v > 0);
      const volPct = atrSeries.length ? atrSeries.filter((v) => v <= atr).length / atrSeries.length : 0.5;
      const ema20 = calculateEmaValues(closes, 20).at(-1) ?? last.close;
      const distFromMeanAtr = (sign * (entry - ema20)) / atr;

      // --- breakout structure, using the same 20-bar level breakout uses ----
      const levelWindow = candles15m.slice(-(DEFAULT_BREAKOUT_CONFIG.lookbackBars + 1), -1);
      const level = dir === "long" ? Math.max(...levelWindow.map((c) => c.high)) : Math.min(...levelWindow.map((c) => c.low));
      const beyondAtr = (sign * (last.close - level)) / atr;
      const fwdCandles = m15.slice(index + 1, index + 1 + 12);
      const nextBeyond = fwdCandles[0] ? sign * (fwdCandles[0].close - level) > 0 : false;
      let retestIndex = -1; let barsBackInside = -1;
      for (const [k, c] of fwdCandles.entries()) {
        const touched = dir === "long" ? c.low <= level + atr * 0.1 : c.high >= level - atr * 0.1;
        if (retestIndex < 0 && touched) retestIndex = k;
        if (barsBackInside < 0 && sign * (c.close - level) < 0) barsBackInside = k + 1;
      }
      let retestHeld: boolean | null = null;
      if (retestIndex >= 0) {
        const after = fwdCandles.slice(retestIndex + 1, retestIndex + 7);
        retestHeld = after.some((c) => sign * (c.close - level) > atr * 0.1);
      }

      // --- forward follow-through at fixed horizons -------------------------
      const horizons: Record<string, number> = {};
      for (const n of [1, 2, 3, 6]) {
        const e = excursion(dir, entry, forward.slice(0, n));
        horizons["mfe" + n + "R"] = risk > 0 ? e.best / risk : 0;
        horizons["mae" + n + "R"] = risk > 0 ? -e.worst / risk : 0;
      }

      // --- did the direction come good AFTER the trade was already over? ----
      // Measured from the EXIT price, not the entry. A stopped-out trade is
      // already 1R offside when it closes, so measuring continuation from the
      // entry makes "kept going against me" almost automatic and "came good"
      // artificially hard — the two are not comparable and the asymmetry that
      // produces is an artefact of where the ruler was placed, not a finding.
      const exitMs = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      const exitQuoteIndex = forward.findIndex((q) => Date.parse(q.closeTime) >= exitMs);
      const exitQuote = exitQuoteIndex >= 0 ? forward[exitQuoteIndex]! : forward.at(-1)!;
      const exitPrice = dir === "long" ? exitQuote.bidClose : exitQuote.askClose;
      const postExit = exitQuoteIndex >= 0 ? forward.slice(exitQuoteIndex + 1, exitQuoteIndex + 1 + POST_EXIT_BARS) : [];
      const postExcursion = postExit.length ? excursion(dir, exitPrice, postExit) : { best: 0, worst: 0 };

      // --- the pure directional test, free of stops, targets and path -------
      // Signed return in the traded direction at fixed horizons. If the entry
      // rule knows anything about direction at all, these are positive on
      // average; no exit policy can rescue a rule whose mean forward move is
      // zero, and none is needed for one whose mean forward move is positive.
      const forwardReturn: Record<string, number> = {};
      for (const n of [1, 3, 6, 12, 24]) {
        const q = forward[n - 1];
        if (!q) { forwardReturn["fwdRet" + n + "Atr"] = 0; continue; }
        const mark = dir === "long" ? q.bidClose : q.askClose;
        forwardReturn["fwdRet" + n + "Atr"] = (sign * (mark - entry)) / atr;
      }

      // --- data integrity at the decision bar -------------------------------
      const prevBar = m15[index - 1]!;
      const gapMinutes = (atMs - Date.parse(prevBar.time)) / 60_000;
      let missingInWindow = 0;
      for (let k = index - 49; k <= index; k += 1) {
        const delta = (Date.parse(m15[k]!.time) - Date.parse(m15[k - 1]!.time)) / 60_000;
        if (delta > 15.5) missingInWindow += 1;
      }

      rows.push({
        family: strategy.name, instrument, direction: dir,
        decisionTime: bar.time, dev: atMs < HOLDOUT_START,
        session: session.label,
        entry, stop: candidate.stop, target: candidate.target,
        riskPips: risk / pip, atrPips: regime.atrPips ?? 0, spreadPips,
        plannedR: candidate.riskReward, regime: regime.regime, trendStrength: regime.trendStrength,
        ...location, ...preMove, ...horizons, ...forwardReturn,
        bodyAtr: body / atr, candleRangeAtr: range / atr,
        upperWickRatio: range > 0 ? upperWick / range : 0,
        lowerWickRatio: range > 0 ? lowerWick / range : 0,
        consecutive, volPct, distFromMeanAtr,
        beyondAtr, nextBeyond, retested: retestIndex >= 0, retestHeld, barsBackInside,
        outcome: outcome.outcome, resultR: outcome.resultR,
        mfeR: outcome.maxFavorableR, maeR: outcome.maxAdverseR,
        postExitBestR: risk > 0 ? postExcursion.best / risk : 0,
        postExitWorstR: risk > 0 ? -postExcursion.worst / risk : 0,
        gapMinutes, missingInWindow,
      });
    }
  }
  console.log(instrument + " done, rows=" + rows.length);
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
console.log("wrote " + rows.length + " entries to " + OUT);
process.exit(0);
