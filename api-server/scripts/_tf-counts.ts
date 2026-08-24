import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
for (const inst of ["EUR_USD", "GBP_USD", "USD_JPY"]) {
  const rows = await query(
    `SELECT timeframe, count(*)::int AS n FROM market_candles WHERE instrument=$1 AND source='oanda' GROUP BY timeframe ORDER BY 1`,
    [inst],
  );
  const q = await query(
    `SELECT timeframe, count(*)::int AS n FROM market_candle_quotes WHERE instrument=$1 AND source='oanda' GROUP BY timeframe ORDER BY 1`,
    [inst],
  );
  console.log(inst, "candles", rows.rows, "quotes", q.rows);
}
process.exit(0);
