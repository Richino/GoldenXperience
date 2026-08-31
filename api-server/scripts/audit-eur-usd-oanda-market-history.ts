/** Read-only coverage audit for stored OANDA EUR/USD bid/ask market data. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const result = await query<{ timeframe: string; rows: number; first: string | null; last: string | null; completeBidAsk: number }>(
  `SELECT timeframe, count(*)::int AS rows, min(close_time)::text AS first, max(close_time)::text AS last,
     count(*) FILTER (WHERE bid_open IS NOT NULL AND bid_high IS NOT NULL AND bid_low IS NOT NULL AND bid_close IS NOT NULL AND ask_open IS NOT NULL AND ask_high IS NOT NULL AND ask_low IS NOT NULL AND ask_close IS NOT NULL)::int AS "completeBidAsk"
   FROM market_candle_quotes WHERE instrument='EUR_USD' AND source='oanda' GROUP BY timeframe ORDER BY timeframe`,
);
console.log(JSON.stringify({ source: "market_candle_quotes; OANDA", instrument: "EUR_USD", timeframes: result.rows }, null, 2));
