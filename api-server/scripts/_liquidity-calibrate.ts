/**
 * How often does macro-liquidity-v1 actually fire, and at what scores?
 *
 * The score threshold is the one number that decides whether a batch of a
 * hundred fills in a month or in a year, and it cannot be reasoned about from
 * a blank page. This replays the real entry rules over stored candles and
 * reports the distribution, so the threshold is chosen from a trade rate rather
 * than a guess.
 *
 * It is not a backtest: no outcomes are labelled and nothing is scored for
 * profit. It only counts setups.
 *
 * Writes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const { query } = await import("../src/database.js");
const { evaluateLiquiditySetup } = await import("../../frontend/src/lib/strategy/liquidity-strategy.js");
const { macroBiasFor } = await import("../../frontend/src/lib/macro/rates.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const WINDOW = 260;
const PAIRS = (process.env.PAIRS ?? "EUR_USD,GBP_USD,USD_JPY").split(",");
const DAYS = Number(process.env.DAYS ?? 120);

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number; complete: boolean };

async function candles(instrument: string, timeframe: string): Promise<Candle[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
     FROM market_candles WHERE instrument=$1 AND timeframe=$2 AND source='oanda'
       AND close_time > now() - ($3 || ' days')::interval
     ORDER BY close_time`,
    [instrument, timeframe, String(DAYS + 60)],
  );
  return rows.rows.map((row) => ({
    time: new Date(row.close_time as string).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    volume: Number(row.volume ?? 0), complete: true,
  }));
}

async function quotes(instrument: string) {
  const rows = await query<Record<string, unknown>>(
    `SELECT close_time, bid_close::float, ask_close::float FROM market_candle_quotes
     WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time > now() - ($2 || ' days')::interval`,
    [instrument, String(DAYS + 60)],
  );
  return new Map(rows.rows.map((row) => [
    new Date(row.close_time as string).toISOString(),
    { bid: Number(row.bid_close), ask: Number(row.ask_close) },
  ]));
}

const scores = new Map<number, number>();
let evaluated = 0;
let sweeps = 0;
const perPair = new Map<string, { evaluated: number; sweeps: number; atOrAbove: Map<number, number> }>();

for (const instrument of PAIRS) {
  const [m15, h1, h4, quoteByTime] = await Promise.all([
    candles(instrument, "M15"), candles(instrument, "H1"), candles(instrument, "H4"), quotes(instrument),
  ]);
  const macro = await macroBiasFor(instrument as never);
  const pip = pipSizeFor(instrument);
  const stats = { evaluated: 0, sweeps: 0, atOrAbove: new Map<number, number>() };
  let h1Index = 0, h4Index = 0;

  for (let index = WINDOW; index < m15.length; index += 1) {
    const decision = m15[index]!.time;
    while (h1Index + 1 < h1.length && h1[h1Index + 1]!.time <= decision) h1Index += 1;
    while (h4Index + 1 < h4.length && h4[h4Index + 1]!.time <= decision) h4Index += 1;
    if (h1Index < WINDOW || h4Index < WINDOW) continue;
    const quote = quoteByTime.get(decision);
    if (!quote) continue;

    const setup = evaluateLiquiditySetup({
      instrument: instrument as never,
      accountBalance: 100_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: m15.slice(index - WINDOW + 1, index + 1),
      candles1h: h1.slice(h1Index - WINDOW + 1, h1Index + 1),
      candles4h: h4.slice(h4Index - WINDOW + 1, h4Index + 1),
      bid: quote.bid, ask: quote.ask,
      spreadPips: (quote.ask - quote.bid) / pip,
      marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
      evaluatedAt: decision,
      macroBias: macro.bias, macroDetail: macro.detail,
    });

    evaluated += 1; stats.evaluated += 1;
    const sweepCondition = setup.conditions.find((item) => item.name === "Liquidity sweep");
    if (!sweepCondition?.passed) continue;
    sweeps += 1; stats.sweeps += 1;

    const raw = setup.conditions.find((item) => item.name === "Setup score")?.currentValue ?? "0/8";
    const score = Number(raw.split("/")[0]);
    scores.set(score, (scores.get(score) ?? 0) + 1);
    for (let threshold = 0; threshold <= 8; threshold += 1) {
      if (score >= threshold) stats.atOrAbove.set(threshold, (stats.atOrAbove.get(threshold) ?? 0) + 1);
    }
  }
  perPair.set(instrument, stats);
  console.log(`${instrument}: ${stats.evaluated} decisions, ${stats.sweeps} sweeps`);
}

const tradingDays = DAYS * (5 / 7);
console.log(`\n${evaluated} decisions evaluated across ${PAIRS.length} pairs, ~${Math.round(tradingDays)} trading days`);
console.log(`${sweeps} carried a liquidity sweep (${((sweeps / evaluated) * 100).toFixed(2)}% of decisions)\n`);

console.log("=== SCORE DISTRIBUTION (sweeps only) ===");
console.table([...scores.entries()].sort(([a], [b]) => a - b).map(([score, count]) => ({
  score: `${score}/8`, setups: count, share: `${((count / sweeps) * 100).toFixed(1)}%`,
})));

console.log("=== TRADE RATE BY THRESHOLD ===");
console.table(Array.from({ length: 9 }, (_, threshold) => {
  const total = PAIRS.reduce((sum, pair) => sum + (perPair.get(pair)!.atOrAbove.get(threshold) ?? 0), 0);
  return {
    threshold: `>= ${threshold}`,
    setups: total,
    perDay: Number((total / tradingDays).toFixed(2)),
    "days to 100 trades": total ? Math.round(100 / (total / tradingDays)) : Infinity,
  };
}).filter((row) => row.setups > 0));

console.log("\nA setup is not a trade: the daily cap of 3 and one-position-per-pair still apply, so the live rate lands below these.");
process.exit(0);
