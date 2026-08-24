/**
 * H4 primary replay of the four families — wider stops, lower spread/R.
 * Day-session decisions only, sealed holdout from 2025-08-01.
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

const HOLDOUT = Date.parse("2025-08-01T00:00:00Z");
const REPLAY = Date.parse("2021-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const W = 260; // hard gates require ≥210 candles on each series

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
async function loadQuotes(instrument: string, timeframe: string): Promise<Quote[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_open::float, bid_high::float, bid_low::float, bid_close::float,
            ask_open::float, ask_high::float, ask_low::float, ask_close::float
       FROM market_candle_quotes WHERE instrument=$1 AND timeframe=$2 AND source='oanda' ORDER BY close_time`,
    [instrument, timeframe],
  );
  return rows.rows.map((row) => ({
    closeTime: new Date(row.close_time as string).toISOString(),
    bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
    askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
  }));
}

/** Aggregate H4 → daily (UTC day). DB has no D/W store for majors. */
function aggregateDaily(h4: Candle[]): Candle[] {
  const byDay = new Map<string, Candle[]>();
  for (const bar of h4) {
    const key = bar.time.slice(0, 10);
    const list = byDay.get(key) ?? [];
    list.push(bar);
    byDay.set(key, list);
  }
  const out: Candle[] = [];
  for (const [, bars] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = bars[0]!;
    const last = bars.at(-1)!;
    out.push({
      time: last.time,
      open: first.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: last.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
      complete: true,
    });
  }
  return out;
}

function lastClosed(times: number[], atMs: number, from: number) {
  let i = from;
  while (i + 1 < times.length && times[i + 1]! <= atMs) i += 1;
  return i;
}

const STRATEGIES = [
  { name: "ema", run: (i: never, r: never) => evaluateEma(i, r, { ...DEFAULT_EMA_CONFIG, targetR: 1.0 }) },
  { name: "breakout", run: (i: never, r: never) => evaluateBreakout(i, r, { ...DEFAULT_BREAKOUT_CONFIG, targetR: 1.0 }) },
  { name: "momentum", run: (i: never, r: never) => evaluateMomentum(i, r, { ...DEFAULT_MOMENTUM_CONFIG, targetR: 1.0 }) },
  { name: "meanrev", run: (i: never, r: never) => evaluateMeanReversion(i, r, DEFAULT_MEANREV_CONFIG) },
];

type Setup = { family: string; instrument: string; ms: number; direction: "long" | "short"; entry: number; stop: number; quoteIndex: number; regime: string; spreadPips: number };
const setups: Setup[] = [];
const quotesByPair = new Map<string, Quote[]>();

for (const instrument of PAIRS) {
  const t0 = Date.now();
  const [h4, quotes] = await Promise.all([
    loadCandles(instrument, "H4"),
    loadQuotes(instrument, "H4"),
  ]);
  const d = aggregateDaily(h4);
  if (h4.length < W || quotes.length < W || d.length < 50) {
    console.log(instrument, `insufficient data h4=${h4.length} d=${d.length} q=${quotes.length}`);
    continue;
  }
  quotesByPair.set(instrument, quotes);
  const dTimes = d.map((c) => Date.parse(c.time));
  const qTimes = quotes.map((q) => Date.parse(q.closeTime));
  let dCursor = 0; let qCursor = 0;
  let n = 0;

  for (let index = W; index < h4.length; index += 1) {
    const bar = h4[index]!;
    const atMs = Date.parse(bar.time);
    if (atMs < REPLAY) continue;
    if (!dayTradingSession(new Date(atMs)).open) continue;
    dCursor = lastClosed(dTimes, atMs, dCursor);
    qCursor = lastClosed(qTimes, atMs, qCursor);
    if (dCursor < 50) continue;
    const quote = quotes[qCursor];
    if (!quote || qTimes[qCursor] !== atMs) continue;
    const pip = pipSizeFor(instrument as never);
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0) || spreadPips > 4) continue;

    const candlesPrimary = h4.slice(index - W + 1, index + 1);
    const candlesD = d.slice(Math.max(0, dCursor - W + 1), dCursor + 1);
    // Mid TF = last ~W H4 bars already; higher TF = daily aggregate.
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m: candlesPrimary, candles1h: candlesPrimary, candles4h: candlesD,
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candlesPrimary, bar.time);
    for (const strategy of STRATEGIES) {
      const c = strategy.run(input as never, regime as never);
      if (c.status !== "valid" || !c.direction || c.entry == null || c.stop == null) continue;
      setups.push({ family: strategy.name, instrument, ms: atMs, direction: c.direction, entry: c.entry, stop: c.stop, quoteIndex: qCursor, regime: regime.regime, spreadPips });
      n += 1;
    }
  }
  console.log(`${instrument}: ${n} H4 setups (${Math.round((Date.now() - t0) / 1000)}s)`);
}

function simulate(family: string, targetR: number, fromMs: number, toMs: number | null, regimes?: string[]) {
  const eligible = setups.filter((s) => s.family === family && s.ms >= fromMs && (toMs === null || s.ms < toMs) && (!regimes || regimes.includes(s.regime))).sort((a, b) => a.ms - b.ms);
  const openUntil = new Map<string, number>();
  const results: number[] = [];
  const spreadCosts: number[] = [];
  for (const s of eligible) {
    if (s.ms < (openUntil.get(s.instrument) ?? 0)) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    const target = s.direction === "long" ? s.entry + risk * targetR : s.entry - risk * targetR;
    const quotes = quotesByPair.get(s.instrument)!;
    const forward = quotes.slice(s.quoteIndex + 1, s.quoteIndex + 40);
    if (!forward.length) continue;
    const outcome = labelOutcome(s.direction, s.entry, s.stop, target, new Date(s.ms).toISOString(), forward as never);
    if (outcome.resultR == null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
    openUntil.set(s.instrument, outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : s.ms);
    results.push(outcome.resultR);
    const pip = pipSizeFor(s.instrument as never);
    spreadCosts.push(s.spreadPips / (risk / pip));
  }
  const n = results.length;
  if (n < 2) return { family, targetR, regimes: regimes?.join(",") ?? "*", n, avg: "-", win: "-", ci: "-", spreadCost: "-", verdict: "too few", _mean: -999 };
  const mean = results.reduce((a, b) => a + b, 0) / n;
  const se = Math.sqrt(results.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  const avgSpreadCost = spreadCosts.reduce((a, b) => a + b, 0) / n;
  return {
    family, targetR, regimes: regimes?.join(",") ?? "*", n,
    avg: mean.toFixed(3),
    win: ((100 * results.filter((r) => r > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    spreadCost: (-avgSpreadCost).toFixed(3),
    verdict: n < 30 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean,
  };
}

const variants: Array<{ family: string; targetR: number; regimes?: string[] }> = [];
for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
  for (const targetR of [0.75, 1.0, 1.5, 2.0]) {
    variants.push({ family, targetR });
    if (family === "meanrev") variants.push({ family, targetR, regimes: ["ranging"] });
    else variants.push({ family, targetR, regimes: ["trending"] });
  }
}

console.log("\n=== DEVELOPMENT (H4) ===");
const dev = variants.map((v) => simulate(v.family, v.targetR, REPLAY, HOLDOUT, v.regimes));
console.table(dev.map(({ _mean, ...r }) => r));

console.log("\n=== Best → HOLDOUT ===");
for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
  const ranked = dev.filter((r) => r.family === family && r.n >= 30).sort((a, b) => b._mean - a._mean);
  const best = ranked[0];
  if (!best) { console.log(family, "none"); continue; }
  const hold = simulate(best.family, best.targetR as number, HOLDOUT, null, best.regimes === "*" ? undefined : String(best.regimes).split(","));
  console.log(`${family}: ${best.regimes} @${best.targetR}R avg=${best.avg} (${best.verdict}, n=${best.n}, spread=${best.spreadCost}) → hold ${hold.avg} (${hold.verdict}, n=${hold.n})`);
}
process.exit(0);
