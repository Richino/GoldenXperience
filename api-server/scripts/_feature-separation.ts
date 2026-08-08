/**
 * Does anything the strategy already measures separate its winners from its
 * losers?
 *
 * The entry rules are a filter: every setup that reaches a trade passed all of
 * them. So the question is not "do the rules fire" but "among the trades they
 * let through, does any recorded feature line up with the outcome". If one
 * does, it is a candidate filter and the seed of a strategy with an edge. If
 * none does, there is no signal hiding in this setup to find.
 *
 * Reported as a correlation with the trade's result in R, plus the mean for
 * winners against losers. Many features are tested at once, so a couple will
 * look interesting by chance: with this many, treat |t| under about 3 as noise.
 *
 * Writes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { labelOutcome, selectPositionAwareCandidates } = await import("../src/research.js");
const { evaluateStrategy } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const HOLDOUT_START = "2025-08-01T00:00:00Z";
const WINDOW = 260;
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };
type Quote = { closeTime: string; bidHigh: number; bidLow: number; bidClose: number; askHigh: number; askLow: number; askClose: number; bidOpen: number; askOpen: number };

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

type Trade = { id: string; instrument: string; decisionTime: string; resultR: number; features: Record<string, number>; labels: Record<string, string> };

const trades: Trade[] = [];

for (const instrument of PAIRS) {
  const started = Date.now();
  const [m15, h1, h4, quotes] = await Promise.all([
    loadCandles(instrument, "M15"), loadCandles(instrument, "H1"), loadCandles(instrument, "H4"), loadQuotes(instrument),
  ]);
  const quoteByTime = new Map(quotes.map((quote) => [quote.closeTime, quote]));
  const pip = pipSizeFor(instrument);
  const pending: Array<{ id: string; decisionTime: string; resolvedAt: string | null; horizonEndsAt: string; resultR: number | null; features: Record<string, number>; labels: Record<string, string> }> = [];
  let h1Index = 0, h4Index = 0;

  for (let index = WINDOW; index < m15.length; index += 1) {
    const decision = m15[index]!.time;
    if (decision >= HOLDOUT_START) break; // the holdout stays sealed
    while (h1Index + 1 < h1.length && h1[h1Index + 1]!.time <= decision) h1Index += 1;
    while (h4Index + 1 < h4.length && h4[h4Index + 1]!.time <= decision) h4Index += 1;
    if (h1Index < WINDOW || h4Index < WINDOW) continue;
    const quote = quoteByTime.get(decision);
    if (!quote) continue;

    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    const setup = evaluateStrategy({
      instrument: instrument as never,
      accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: m15.slice(index - WINDOW + 1, index + 1),
      candles1h: h1.slice(h1Index - WINDOW + 1, h1Index + 1),
      candles4h: h4.slice(h4Index - WINDOW + 1, h4Index + 1),
      bid: quote.bidClose, ask: quote.askClose, spreadPips,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: decision,
    });
    if (setup.status !== "valid" || !setup.direction || setup.entry === null || setup.stop === null || setup.target === null) continue;

    const f = setup.features;
    const at = new Date(decision);
    const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const etHour = Number(et.find((p) => p.type === "hour")?.value ?? "0");
    const etMinutes = etHour * 60 + Number(et.find((p) => p.type === "minute")?.value ?? "0");
    const risk = Math.abs(setup.entry - setup.stop);

    const start = quotes.findIndex((q) => q.closeTime > decision);
    const result = labelOutcome(setup.direction, setup.entry, setup.stop, setup.target, decision, start < 0 ? [] : quotes.slice(start, start + 400) as never);

    pending.push({
      id: `${instrument}:${decision}`, decisionTime: decision,
      resolvedAt: result.resolvedAt, horizonEndsAt: result.horizonEndsAt, resultR: result.resultR,
      features: {
        rsi14: f.rsi14 ?? NaN,
        atrPips: f.atrPips ?? NaN,
        stopSizePips: risk / pip,
        spreadPips,
        spreadOverAtr: f.atrPips ? spreadPips / f.atrPips : NaN,
        structureHighs: f.structureHighs,
        structureLows: f.structureLows,
        etHour,
        runwayHours: (16 * 60 + 45 - etMinutes) / 60,
        // How stretched price is from the slow trend when the trade is taken.
        entryToEma200Atr: f.ema200 && f.atr14 ? Math.abs(setup.entry - f.ema200) / f.atr14 : NaN,
        emaSpreadAtr: f.ema21 && f.ema50 && f.atr14 ? Math.abs(f.ema21 - f.ema50) / f.atr14 : NaN,
      },
      labels: {
        direction: setup.direction,
        session: setup.conditions.find((item) => item.name === "Session")?.currentValue ?? "Unknown",
        trend4h: String(f.trend4h ?? "unknown"),
        instrument,
        weekday: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(at),
      },
    });
  }

  // One position at a time, as the live collector runs.
  const selections = selectPositionAwareCandidates(pending.map((item) => ({
    id: item.id, decisionTime: item.decisionTime, resolvedAt: item.resolvedAt, horizonEndsAt: item.horizonEndsAt,
  })) as never) as Array<{ id: string; executionStatus: string }>;
  const accepted = new Set(selections.filter((s) => s.executionStatus === "accepted").map((s) => s.id));
  for (const item of pending) {
    if (!accepted.has(item.id) || item.resultR === null) continue;
    trades.push({ id: item.id, instrument, decisionTime: item.decisionTime, resultR: item.resultR, features: item.features, labels: item.labels });
  }
  console.log(`${instrument}: ${trades.filter((t) => t.instrument === instrument).length} accepted trades (${Math.round((Date.now() - started) / 1000)}s)`);
}

const winners = trades.filter((t) => t.resultR > 0);
const losers = trades.filter((t) => t.resultR <= 0);
console.log(`\n${trades.length} trades · ${winners.length} winners · ${losers.length} losers · development period only\n`);

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

console.log("=== NUMERIC FEATURES — correlation with result ===");
const names = Object.keys(trades[0]?.features ?? {});
const rows = names.map((name) => {
  const pairs = trades.map((t) => [t.features[name]!, t.resultR] as const).filter(([x]) => Number.isFinite(x));
  const n = pairs.length;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  const cov = mean(pairs.map(([x, y]) => (x - mx) * (y - my)));
  const sx = Math.sqrt(mean(pairs.map(([x]) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(pairs.map(([, y]) => (y - my) ** 2)));
  const r = sx && sy ? cov / (sx * sy) : 0;
  const t = n > 2 ? r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r)) : 0;
  return {
    feature: name,
    winnerMean: Number(mean(winners.map((w) => w.features[name]!).filter(Number.isFinite)).toFixed(3)),
    loserMean: Number(mean(losers.map((l) => l.features[name]!).filter(Number.isFinite)).toFixed(3)),
    correlation: Number(r.toFixed(4)),
    t: Number(t.toFixed(2)),
    meaningful: Math.abs(t) > 3 ? "yes" : "",
  };
}).sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
console.table(rows);

console.log("=== CATEGORY FEATURES — average result by group ===");
for (const key of Object.keys(trades[0]?.labels ?? {})) {
  const groups = [...new Set(trades.map((t) => t.labels[key]!))].sort();
  console.log(`\n${key}:`);
  console.table(groups.map((group) => {
    const inGroup = trades.filter((t) => t.labels[key] === group);
    const values = inGroup.map((t) => t.resultR);
    const m = mean(values);
    const sd = Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
    const se = sd / Math.sqrt(values.length || 1);
    return { group, trades: inGroup.length, avgR: Number(m.toFixed(4)), stdErr: Number(se.toFixed(4)), seFromZero: Number((m / (se || 1)).toFixed(2)) };
  }));
}

console.log(`\nFeatures tested: ${names.length} numeric + ${Object.keys(trades[0]?.labels ?? {}).length} categorical. With that many, one or two will look interesting by chance.`);
process.exit(0);
