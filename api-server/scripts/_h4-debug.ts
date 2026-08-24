import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { classifyRegime } = await import("../../frontend/src/lib/strategy/regime.js");
const { evaluateEma, DEFAULT_EMA_CONFIG } = await import("../../frontend/src/lib/strategy/strategies/ema.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");

const rows = await query<{ close_time: string; open: number; high: number; low: number; close: number; volume: number }>(
  `SELECT close_time, open::float, high::float, low::float, close::float, volume::float
     FROM market_candles WHERE instrument='EUR_USD' AND timeframe='H4' AND source='oanda' ORDER BY close_time`,
);
const quotes = await query<Record<string, number | string>>(
  `SELECT close_time, bid_close::float, ask_close::float FROM market_candle_quotes
     WHERE instrument='EUR_USD' AND timeframe='H4' AND source='oanda' ORDER BY close_time`,
);

const candles = rows.rows.map((r) => ({
  time: new Date(r.close_time).toISOString(),
  open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  volume: Number(r.volume ?? 0), complete: true,
}));
const qMap = new Map(quotes.rows.map((q) => [new Date(q.close_time as string).toISOString(), q]));

let sessionOpen = 0;
let hasQuote = 0;
let valid = 0;
let sampleReject = "";

for (let i = 120; i < candles.length; i += 1) {
  const bar = candles[i]!;
  const at = new Date(bar.time);
  const session = dayTradingSession(at);
  if (!session.open) continue;
  sessionOpen += 1;
  const quote = qMap.get(bar.time);
  if (!quote) continue;
  hasQuote += 1;
  const spreadPips = (Number(quote.ask_close) - Number(quote.bid_close)) / pipSizeFor("EUR_USD");
  const slice = candles.slice(i - 119, i + 1);
  const input = {
    instrument: "EUR_USD" as const, accountBalance: 10_000, accountCurrency: "USD" as const, dataSource: "oanda" as const,
    candles15m: slice, candles1h: slice, candles4h: slice,
    bid: Number(quote.bid_close), ask: Number(quote.ask_close), spreadPips,
    marketOpen: true, calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false,
    evaluatedAt: bar.time, evaluationMode: "historical_replay" as const,
  };
  const regime = classifyRegime("EUR_USD", slice, bar.time);
  const c = evaluateEma(input as never, regime, { ...DEFAULT_EMA_CONFIG, targetR: 1.0 });
  if (c.status === "valid") valid += 1;
  else if (!sampleReject) {
    sampleReject = `${bar.time} status=${c.status} failed=${c.failedConditions.map((f) => f.name).join(",")}`;
  }
}

console.log({ total: candles.length, sessionOpen, hasQuote, valid, sampleReject });
console.log("sample H4 closes", candles.slice(-6).map((c) => ({ t: c.time, session: dayTradingSession(new Date(c.time)) })));
process.exit(0);
