/** Read-only inventory of bid/ask-complete stored OANDA M15 market history. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const result = await query<{ instrument: string; candles: number; first: string; last: string }>(
  `SELECT instrument,count(*)::int AS candles,min(close_time)::text AS first,max(close_time)::text AS last
     FROM market_candle_quotes
    WHERE source='oanda' AND timeframe='M15' AND bid_close IS NOT NULL AND ask_close IS NOT NULL
    GROUP BY instrument ORDER BY candles DESC,instrument`,
);
console.log(JSON.stringify({ source: "market_candle_quotes; OANDA", timeframe: "M15", instruments: result.rows }, null, 2));
