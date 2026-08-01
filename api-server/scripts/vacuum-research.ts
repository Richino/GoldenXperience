import { config as loadDotenv } from "dotenv";
import { db } from "../src/database.js";

for (const name of [".env", ".env.local"]) loadDotenv({ path: new URL(`../${name}`, import.meta.url), override: false });

const pool = db();
for (const table of ["strategy_evaluations", "evaluation_features", "trade_candidates", "outcome_labels", "shadow_outcome_labels", "market_candle_quotes", "market_candles"]) {
  console.log(`Vacuuming ${table}...`);
  await pool.query(`VACUUM (ANALYZE) ${table}`);
}
await pool.end();
console.log("Research-table vacuum complete.");
