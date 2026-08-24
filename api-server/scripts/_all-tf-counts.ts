import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const rows = await query(
  `SELECT instrument, timeframe, count(*)::int AS n,
          min(close_time)::text AS first, max(close_time)::text AS last
     FROM market_candles WHERE source='oanda'
    GROUP BY 1,2 ORDER BY 1,2`,
);
console.table(rows.rows);
process.exit(0);
