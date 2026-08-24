/**
 * Per-pair × regime × session breakdown of V1 strategies on sealed periods.
 * Looks for any pocket with confident positive expectancy to specialize into.
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
const REPLAY_START = Date.parse("2023-08-01T00:00:00Z");
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD").split(",");
const M15_WINDOW = 260;
const TF_WINDOW = 260;
const TARGET_R = Number(process.env.TARGET_R ?? 0.75);

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type Trade = { family: string; instrument: string; regime: string; session: string; ms: number; resultR: number };

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

const trades: Trade[] = [];

for (const instrument of PAIRS) {
  const started = Date.now();
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  if (m15.length < M15_WINDOW || h1.length < TF_WINDOW || h4.length < TF_WINDOW || quotes.length < M15_WINDOW) {
    console.log(instrument + ": skip"); continue;
  }
  const h1Times = h1.map((c) => Date.parse(c.time));
  const h4Times = h4.map((c) => Date.parse(c.time));
  const quoteTimes = quotes.map((q) => Date.parse(q.closeTime));
  let h1Cursor = 0; let h4Cursor = 0; let quoteCursor = 0;
  const openUntil: Record<string, number> = {};
  for (const s of STRATEGIES) openUntil[s.name] = 0;
  let n = 0;

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
    if (!(spreadPips > 0)) continue;
    const candles15m = m15.slice(index - M15_WINDOW + 1, index + 1);
    const input = {
      instrument: instrument as never, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
      candles15m, candles1h: h1.slice(h1Cursor - TF_WINDOW + 1, h1Cursor + 1), candles4h: h4.slice(h4Cursor - TF_WINDOW + 1, h4Cursor + 1),
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
    };
    const regime = classifyRegime(instrument as never, candles15m, bar.time);
    const session = dayTradingSession(at).label;

    for (const strategy of STRATEGIES) {
      if (atMs < openUntil[strategy.name]!) continue;
      const candidate = strategy.run(input as never, regime as never);
      if (candidate.status !== "valid" || !candidate.direction || candidate.entry == null || candidate.stop == null) continue;
      const risk = Math.abs(candidate.entry - candidate.stop);
      const target = candidate.direction === "long" ? candidate.entry + risk * TARGET_R : candidate.entry - risk * TARGET_R;
      const forward = quotes.slice(quoteCursor + 1, quoteCursor + 400);
      if (!forward.length) continue;
      const outcome = labelOutcome(candidate.direction, candidate.entry, candidate.stop, target, bar.time, forward as never);
      if (outcome.resultR === null || outcome.outcome === "ambiguous" || outcome.outcome === "unresolved") continue;
      openUntil[strategy.name] = outcome.resolvedAt ? Date.parse(outcome.resolvedAt) : atMs;
      trades.push({ family: strategy.name, instrument, regime: regime.regime, session, ms: atMs, resultR: outcome.resultR });
      n += 1;
    }
  }
  console.log(`${instrument}: ${n} trades (${Math.round((Date.now() - started) / 1000)}s)`);
}

function bucket(label: string, rows: Trade[]) {
  const n = rows.length;
  if (n < 2) return null;
  const net = rows.reduce((s, t) => s + t.resultR, 0);
  const mean = net / n;
  const se = Math.sqrt(rows.reduce((s, t) => s + (t.resultR - mean) ** 2, 0) / (n - 1) / n);
  const lo = mean - 1.96 * se; const hi = mean + 1.96 * se;
  return {
    pocket: label, n,
    avg_r: mean.toFixed(3),
    net_r: net.toFixed(1),
    win: ((100 * rows.filter((t) => t.resultR > 0).length) / n).toFixed(0) + "%",
    ci: `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
    verdict: n < 40 ? "too few" : hi < 0 ? "LOSES" : lo > 0 ? "WINS" : "no edge",
    _mean: mean, _lo: lo,
  };
}

const dev = trades.filter((t) => t.ms < HOLDOUT_START);
const hold = trades.filter((t) => t.ms >= HOLDOUT_START);

const pockets: NonNullable<ReturnType<typeof bucket>>[] = [];
for (const family of ["ema", "breakout", "momentum", "meanrev"]) {
  for (const instrument of PAIRS) {
    for (const regime of ["trending", "ranging", "mixed"]) {
      for (const session of ["London", "New York", "London/New York overlap"]) {
        const rows = dev.filter((t) => t.family === family && t.instrument === instrument && t.regime === regime && t.session === session);
        const row = bucket(`${family}|${instrument}|${regime}|${session}`, rows);
        if (row && row.n >= 40) pockets.push(row);
      }
      const rows = dev.filter((t) => t.family === family && t.instrument === instrument && t.regime === regime);
      const row = bucket(`${family}|${instrument}|${regime}|*`, rows);
      if (row && row.n >= 40) pockets.push(row);
    }
    const rows = dev.filter((t) => t.family === family && t.instrument === instrument);
    const row = bucket(`${family}|${instrument}|*|*`, rows);
    if (row && row.n >= 40) pockets.push(row);
  }
}

pockets.sort((a, b) => b._mean - a._mean);
console.log("\n=== TOP development pockets (n≥40), targetR=" + TARGET_R + " ===");
console.table(pockets.slice(0, 25).map(({ _mean, _lo, ...r }) => r));

console.log("\n=== WINS on development → holdout check ===");
const wins = pockets.filter((p) => p.verdict === "WINS").slice(0, 15);
if (!wins.length) console.log("No confident winning pockets on development.");
for (const w of wins) {
  const [family, instrument, regime, session] = w.pocket.split("|");
  const rows = hold.filter((t) =>
    t.family === family &&
    (instrument === "*" || t.instrument === instrument) &&
    (regime === "*" || t.regime === regime) &&
    (session === "*" || t.session === session),
  );
  const h = bucket(w.pocket, rows);
  console.log(`DEV ${w.pocket}: ${w.avg_r} (n=${w.n}) → HOLD ${h ? `${h.avg_r} (${h.verdict}, n=${h.n})` : "too few"}`);
}

process.exit(0);
