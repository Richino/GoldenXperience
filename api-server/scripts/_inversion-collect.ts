/**
 * Four-family direction inversion audit — collection. RESEARCH ONLY.
 *
 * Takes every opportunity the FOUR REAL strategy engines generate and builds two
 * trades from the identical signal:
 *      A = the direction the engine chose
 *      B = the exact opposite
 * Same bar, same timestamp, same risk geometry mirrored around the inverted
 * entry. Nothing about when a signal occurs is changed.
 *
 * The inverted trade is recomputed from actual historical bid/ask, NEVER by
 * negating the original P&L. That distinction is the whole point: a long pays
 * ask and receives bid, a short receives bid and pays ask, so flipping direction
 * does not flip the spread — both sides pay it. Multiplying by -1 would hand the
 * inverted arm a free +2x spread and manufacture an edge out of nothing.
 *
 * Gross (pre-cost) outcomes are produced by re-running the identical resolver
 * over a mid-price quote series, so gross and net differ ONLY by execution cost.
 *
 * No position-occupancy filter is applied: both arms must see the identical
 * opportunity set for the A/B to be exact. This deliberately differs from the
 * position-aware replay in _strategy-validation.ts and is noted in the report.
 *
 * Writes CSV. Reads the database, writes nothing to it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
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

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const START = Date.parse(process.env.START ?? "2022-08-01T00:00:00Z");
/** Sealed begins here and is NOT collected. */
const SEALED_START = Date.parse(process.env.SEALED_START ?? "2025-08-01T00:00:00Z");
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "inversion.csv");
const M15_WINDOW = 260;
const TF_WINDOW = 260;
const HORIZONS = [1, 3, 6, 12, 24];

const STRATEGIES = [
  { name: "ema", run: (i: never, r: never) => evaluateEma(i, r, DEFAULT_EMA_CONFIG) },
  { name: "breakout", run: (i: never, r: never) => evaluateBreakout(i, r, DEFAULT_BREAKOUT_CONFIG) },
  { name: "momentum", run: (i: never, r: never) => evaluateMomentum(i, r, DEFAULT_MOMENTUM_CONFIG) },
  { name: "meanrev", run: (i: never, r: never) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };

async function candles(instrument: string, tf: string): Promise<Candle[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`, [instrument, tf]);
  return r.rows.map((x) => ({ time: new Date(x.close_time as string).toISOString(), open: Number(x.open), high: Number(x.high),
    low: Number(x.low), close: Number(x.close), volume: Number(x.volume ?? 0), complete: true }));
}
async function quotes(instrument: string): Promise<Quote[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument]);
  return r.rows.map((x) => ({ closeTime: new Date(x.close_time as string).toISOString(),
    bidOpen: Number(x.bid_open), bidHigh: Number(x.bid_high), bidLow: Number(x.bid_low), bidClose: Number(x.bid_close),
    askOpen: Number(x.ask_open), askHigh: Number(x.ask_high), askLow: Number(x.ask_low), askClose: Number(x.ask_close) }));
}
function lastClosed(times: number[], atMs: number, from: number) {
  let i = from; while (i + 1 < times.length && times[i + 1]! <= atMs) i += 1; return i;
}
/** Mid-price twin of a quote series: gross outcomes come from the SAME resolver. */
const toMid = (c: Candle): Quote => ({
  closeTime: c.time, bidOpen: c.open, bidHigh: c.high, bidLow: c.low, bidClose: c.close,
  askOpen: c.open, askHigh: c.high, askLow: c.low, askClose: c.close,
});

const stream = createWriteStream(OUT);
let header: string[] | null = null;
let written = 0;

for (const instrument of PAIRS) {
  const [m15, h1, h4, qt] = await Promise.all([
    candles(instrument, "M15"), candles(instrument, "H1"), candles(instrument, "H4"), quotes(instrument)]);
  const qIdx = new Map<number, number>(); qt.forEach((q, i) => qIdx.set(Date.parse(q.closeTime), i));
  const mid = m15.map(toMid);
  const midIdx = new Map<number, number>(); m15.forEach((c, i) => midIdx.set(Date.parse(c.time), i));
  const h1T = h1.map((c) => Date.parse(c.time)); const h4T = h4.map((c) => Date.parse(c.time));
  const pip = pipSizeFor(instrument as never);
  let c1 = 0; let c4 = 0;

  for (let i = M15_WINDOW; i < m15.length; i += 1) {
    const bar = m15[i]!; const atMs = Date.parse(bar.time);
    if (atMs < START || atMs >= SEALED_START) continue;         // sealed never collected
    c1 = lastClosed(h1T, atMs, c1); c4 = lastClosed(h4T, atMs, c4);
    if (c1 < TF_WINDOW || c4 < TF_WINDOW) continue;
    const session = dayTradingSession(new Date(atMs));
    if (!session.open) continue;                                 // the live gate, unchanged
    const qi = qIdx.get(atMs); if (qi === undefined) continue;
    const q = qt[qi]!;
    const spreadPips = (q.askClose - q.bidClose) / pip;
    if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

    const candles15m = m15.slice(i - M15_WINDOW + 1, i + 1);
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m, candles1h: h1.slice(c1 - TF_WINDOW + 1, c1 + 1), candles4h: h4.slice(c4 - TF_WINDOW + 1, c4 + 1),
      bid: q.bidClose, ask: q.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candles15m, bar.time);
    const atr = regime.atr ?? 0;
    if (!(atr > 0)) continue;

    for (const strategy of STRATEGIES) {
      const cand = strategy.run(input as never, regime as never);
      if (cand.status !== "valid" || !cand.direction) continue;
      if (cand.entry === null || cand.stop === null || cand.target === null) continue;

      const fwd = qt.slice(qi + 1, qi + 400);
      const fwdMid = mid.slice(i + 1, i + 400);
      if (fwd.length < 20 || fwdMid.length < 20) continue;

      const dir = cand.direction;
      const inv = dir === "long" ? "short" as const : "long" as const;
      const stopDist = Math.abs(cand.entry - cand.stop);
      const tgtDist = Math.abs(cand.target - cand.entry);
      // The inverted trade fills on the OTHER side of the book at the same bar,
      // then mirrors the same distances around that entry.
      const invEntry = inv === "long" ? q.askClose : q.bidClose;
      const invStop = inv === "long" ? invEntry - stopDist : invEntry + stopDist;
      const invTarget = inv === "long" ? invEntry + tgtDist : invEntry - tgtDist;
      // Gross twin: identical geometry priced at mid on both legs.
      const midEntry = bar.close;
      const oStopM = dir === "long" ? midEntry - stopDist : midEntry + stopDist;
      const oTgtM = dir === "long" ? midEntry + tgtDist : midEntry - tgtDist;
      const iStopM = inv === "long" ? midEntry - stopDist : midEntry + stopDist;
      const iTgtM = inv === "long" ? midEntry + tgtDist : midEntry - tgtDist;

      const oNet = labelOutcome(dir, cand.entry, cand.stop, cand.target, bar.time, fwd as never);
      const iNet = labelOutcome(inv, invEntry, invStop, invTarget, bar.time, fwd as never);
      const oGro = labelOutcome(dir, midEntry, oStopM, oTgtM, bar.time, fwdMid as never);
      const iGro = labelOutcome(inv, midEntry, iStopM, iTgtM, bar.time, fwdMid as never);
      const usable = (o: { outcome: string; resultR: number | null }) =>
        o.outcome !== "unresolved" && o.outcome !== "ambiguous" && o.resultR !== null;
      if (!usable(oNet) || !usable(iNet) || !usable(oGro) || !usable(iGro)) continue;

      // Fixed-horizon forward returns, executable and gross, for BOTH directions.
      const fh: Record<string, number> = {};
      let ok = true;
      for (const h of HORIZONS) {
        const fq = qt[qi + h]; const fm = m15[i + h];
        if (!fq || !fm) { ok = false; break; }
        const sgn = dir === "long" ? 1 : -1;
        fh[`oGross${h}`] = (sgn * (fm.close - bar.close)) / atr;
        fh[`iGross${h}`] = (-sgn * (fm.close - bar.close)) / atr;
        fh[`oNet${h}`] = dir === "long" ? (fq.bidClose - q.askClose) / atr : (q.bidClose - fq.askClose) / atr;
        fh[`iNet${h}`] = inv === "long" ? (fq.bidClose - q.askClose) / atr : (q.bidClose - fq.askClose) / atr;
      }
      if (!ok) continue;

      const row: Record<string, string | number> = {
        family: strategy.name, pair: instrument, ts: bar.time, session: session.label,
        direction: dir, regime: regime.regime, trendStrength: regime.trendStrength,
        volPct: 0, atrPips: regime.atrPips ?? 0, spreadPips, spreadAtr: spreadPips / ((regime.atrPips ?? 1) || 1),
        stopAtr: stopDist / atr, targetAtr: tgtDist / atr, plannedR: cand.riskReward ?? 0,
        oOutcome: oNet.outcome, oNetR: oNet.resultR!, oMfe: oNet.maxFavorableR ?? 0, oMae: oNet.maxAdverseR ?? 0,
        iOutcome: iNet.outcome, iNetR: iNet.resultR!, iMfe: iNet.maxFavorableR ?? 0, iMae: iNet.maxAdverseR ?? 0,
        oGrossR: oGro.resultR!, iGrossR: iGro.resultR!,
        ...fh,
      };
      if (!header) { header = Object.keys(row); stream.write(header.join(",") + "\n"); }
      stream.write(header.map((k) => { const v = row[k]; return typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(6) : "0") : v; }).join(",") + "\n");
      written += 1;
      if (written % 20000 === 0) console.log("  rows " + written);
    }
  }
  console.log(instrument + " done, total " + written);
}
await new Promise<void>((res, rej) => { stream.on("finish", () => res()); stream.on("error", rej); stream.end(); });
console.log("wrote " + written + " signal rows to " + path.resolve(OUT));
process.exit(0);
