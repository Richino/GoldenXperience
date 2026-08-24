/**
 * EMA direction experiment — collection pass.
 *
 * Walks the three pairs with deep history IN LOCKSTEP, so cross-pair currency
 * strength is read at the same instant for all of them. Misaligning that is one
 * of the easiest ways to leak the future into a currency-strength feature, so
 * the loop is driven by a shared timestamp rather than per-pair cursors.
 *
 * For every EMA OPPORTUNITY it records the point-in-time feature vector and the
 * forward labels at 1/3/6/12/24 bars. Labels are stored three ways on purpose:
 * mid-price (does directional information exist at all), and executable long and
 * short returns paying the real spread (does it survive costs). Conflating those
 * two questions is how a "predictive" model turns out to be unprofitable.
 *
 * Every feature comes from candles up to and including the decision bar. Every
 * label comes strictly from bars after it. Nothing is written to the database.
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
const { detectEmaOpportunity, currencyStrength } = await import("../../frontend/src/lib/strategy/research/ema-opportunity-v2.js");
const { calculateEmaValues } = await import("../../frontend/src/lib/strategy/indicators.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const REPLAY_START = Date.parse(process.env.REPLAY_START ?? "2022-08-01T00:00:00Z");
const OUT = process.env.OUT ?? path.join(serviceRoot, "..", "ema-direction.jsonl");
const HORIZONS = [1, 3, 6, 12, 24];
const WINDOW = 260;
/** Sampled at random-but-reproducible non-opportunity bars, for the timing control. */
const CONTROL_EVERY = 7;

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidClose: number; askClose: number; bidHigh: number; bidLow: number; askHigh: number; askLow: number };

async function loadCandles(instrument: string, timeframe: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
       FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`, [instrument, timeframe]);
  return rows.rows.map((r) => ({
    time: new Date(r.close_time as string).toISOString(),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume ?? 0), complete: true,
  }));
}
async function loadQuotes(instrument: string): Promise<Quote[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_close::float, ask_close::float, bid_high::float, bid_low::float, ask_high::float, ask_low::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time`, [instrument]);
  return rows.rows.map((r) => ({
    closeTime: new Date(r.close_time as string).toISOString(),
    bidClose: Number(r.bid_close), askClose: Number(r.ask_close),
    bidHigh: Number(r.bid_high), bidLow: Number(r.bid_low), askHigh: Number(r.ask_high), askLow: Number(r.ask_low),
  }));
}

const m15: Record<string, Candle[]> = {}; const h1: Record<string, Candle[]> = {}; const qt: Record<string, Quote[]> = {};
for (const p of PAIRS) {
  [m15[p], h1[p], qt[p]] = await Promise.all([loadCandles(p, "M15"), loadCandles(p, "H1"), loadQuotes(p)]);
  console.log(p + ": " + m15[p]!.length + " M15, " + h1[p]!.length + " H1, " + qt[p]!.length + " quotes");
}

// Index every series by timestamp so the lockstep walk is exact, never "nearest".
const idx = (arr: { time?: string; closeTime?: string }[]) => {
  const m = new Map<number, number>();
  arr.forEach((x, i) => m.set(Date.parse((x.time ?? x.closeTime)!), i));
  return m;
};
const m15Idx: Record<string, Map<number, number>> = {}; const qtIdx: Record<string, Map<number, number>> = {};
const h1Times: Record<string, number[]> = {};
for (const p of PAIRS) { m15Idx[p] = idx(m15[p]!); qtIdx[p] = idx(qt[p]!); h1Times[p] = h1[p]!.map((c) => Date.parse(c.time)); }

/** Log return of a pair over `n` bars ending at index i, for currency strength. */
function logRet(series: Candle[], i: number, n: number) {
  const a = series[i - n]?.close; const b = series[i]?.close;
  return a && b && a > 0 && b > 0 ? Math.log(b / a) : 0;
}
function lastClosed(times: number[], atMs: number, from: number) {
  let i = from; while (i + 1 < times.length && times[i + 1]! <= atMs) i += 1; return i;
}

const rows: unknown[] = [];
const anchor = m15.EUR_USD!;
const h1Cursor: Record<string, number> = { EUR_USD: 0, GBP_USD: 0, USD_JPY: 0 };
let opportunities = 0; let controls = 0;

for (let a = WINDOW; a < anchor.length; a += 1) {
  const atMs = Date.parse(anchor[a]!.time);
  if (atMs < REPLAY_START) continue;

  // Every pair must have this exact bar, and enough history behind it.
  const present = PAIRS.every((p) => { const i = m15Idx[p]!.get(atMs); return i !== undefined && i >= WINDOW && qtIdx[p]!.has(atMs); });
  if (!present) continue;

  const strengths: Record<number, ReturnType<typeof currencyStrength>> = {};
  for (const n of [12, 24]) {
    strengths[n] = currencyStrength(
      logRet(m15.EUR_USD!, m15Idx.EUR_USD!.get(atMs)!, n),
      logRet(m15.GBP_USD!, m15Idx.GBP_USD!.get(atMs)!, n),
      logRet(m15.USD_JPY!, m15Idx.USD_JPY!.get(atMs)!, n),
    );
  }
  const session = dayTradingSession(new Date(atMs));
  const d = new Date(atMs);

  for (const pair of PAIRS) {
    const i = m15Idx[pair]!.get(atMs)!;
    const qi = qtIdx[pair]!.get(atMs)!;
    const candles = m15[pair]!.slice(i - WINDOW + 1, i + 1);
    const quote = qt[pair]![qi]!;
    const pip = pipSizeFor(pair as never);
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || !Number.isFinite(spreadPips)) continue;

    h1Cursor[pair] = lastClosed(h1Times[pair]!, atMs, h1Cursor[pair]!);
    const hc = h1Cursor[pair]!;
    if (hc < 60) continue;

    const prev = m15[pair]![i - 1]!;
    const gapMinutes = (atMs - Date.parse(prev.time)) / 60_000;
    let missing = 0;
    for (let k = i - 49; k <= i; k += 1) if ((Date.parse(m15[pair]![k]!.time) - Date.parse(m15[pair]![k - 1]!.time)) / 60_000 > 15.5) missing += 1;

    const opp = detectEmaOpportunity({
      candles15m: candles, candles1h: h1[pair]!.slice(hc - 59, hc + 1),
      spreadPips, pipSize: pip, gapMinutes, missingInWindow: missing,
    });
    const isOpportunity = opp.verdict === "OPPORTUNITY";
    // Controls are non-opportunity bars sampled on a fixed stride: same pairs,
    // same sessions, same period, no EMA condition. They answer whether the EMA
    // detector is choosing better moments or merely choosing moments.
    const isControl = !isOpportunity && opp.features === null && i % CONTROL_EVERY === 0;
    if (!isOpportunity && !isControl) continue;

    // Controls still need a feature vector to be scored by the same model, so
    // they are re-read with the gating relaxed. The features are computed by the
    // identical code path; only the verdict differed.
    const features = isOpportunity ? opp.features! : detectEmaOpportunity(
      { candles15m: candles, candles1h: h1[pair]!.slice(hc - 59, hc + 1), spreadPips, pipSize: pip, gapMinutes, missingInWindow: missing },
      { emaFast: 20, emaSlow: 50, atrPeriod: 14, zonePadAtr: 1e9, maxDistanceAtr: 1e9, maxSpreadOverAtr: 1e9, minAtrPips: 0, minHistoryBars: WINDOW },
    ).features;
    if (!features) continue;

    const atr = features.atr!;
    const labels: Record<string, number> = {};
    let usable = true;
    for (const h of HORIZONS) {
      const fq = qt[pair]![qi + h];
      const fm = m15[pair]![i + h];
      if (!fq || !fm) { usable = false; break; }
      labels["midRet" + h] = (fm.close - m15[pair]![i]!.close) / atr;
      // Executable: a long pays ask now and receives bid later; a short is the
      // mirror. Both carry the real spread of the moment, not an average.
      labels["longRet" + h] = (fq.bidClose - quote.askClose) / atr;
      labels["shortRet" + h] = (quote.bidClose - fq.askClose) / atr;
      const fwd = qt[pair]!.slice(qi + 1, qi + 1 + h);
      let bestUp = 0; let worstDown = 0;
      for (const q of fwd) {
        bestUp = Math.max(bestUp, (q.bidHigh - quote.askClose) / atr);
        worstDown = Math.min(worstDown, (q.bidLow - quote.askClose) / atr);
      }
      labels["mfeLong" + h] = bestUp; labels["maeLong" + h] = -worstDown;
    }
    if (!usable) continue;

    const s12 = strengths[12]!; const s24 = strengths[24]!;
    const base = pair.slice(0, 3).toLowerCase() as "eur" | "gbp" | "usd";
    const quoteCcy = pair.slice(4).toLowerCase() as "usd" | "jpy";
    rows.push({
      pair, ts: anchor[a]!.time, isOpportunity, session: session.label,
      hour: d.getUTCHours(), dayOfWeek: d.getUTCDay(),
      ...features,
      strBase12: s12[base], strQuote12: s12[quoteCcy], strDiff12: s12[base] - s12[quoteCcy],
      strBase24: s24[base], strQuote24: s24[quoteCcy], strDiff24: s24[base] - s24[quoteCcy],
      strUsd24: s24.usd, strEur24: s24.eur, strGbp24: s24.gbp, strJpy24: s24.jpy,
      ...labels,
    });
    if (isOpportunity) opportunities += 1; else controls += 1;
  }
  if (rows.length && rows.length % 20000 === 0) console.log("  ...rows " + rows.length);
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
console.log("opportunities=" + opportunities + " controls=" + controls + " -> " + OUT);
process.exit(0);
