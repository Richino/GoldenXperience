/**
 * Data availability probe for 1-minute binary expiry audit.
 * Research only — does not modify binary strategy or production.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const tf = await query<{ timeframe: string; n: number; min_t: Date; max_t: Date }>(
  `SELECT timeframe, count(*)::int AS n, min(close_time) AS min_t, max(close_time) AS max_t
     FROM market_candles WHERE source='oanda' GROUP BY 1 ORDER BY 1`,
);
console.log("=== market_candles by TF ===");
for (const r of tf.rows) {
  console.log(`  ${r.timeframe}: n=${r.n} ${new Date(r.min_t).toISOString()} → ${new Date(r.max_t).toISOString()}`);
}

const m1 = await query<{ instrument: string; n: number; min_t: Date; max_t: Date }>(
  `SELECT instrument, count(*)::int AS n, min(close_time) AS min_t, max(close_time) AS max_t
     FROM market_candles WHERE source='oanda' AND timeframe='M1'
     GROUP BY 1 ORDER BY 1`,
);
console.log("\n=== M1 candles ===");
if (m1.rows.length === 0) console.log("  NONE");
else for (const r of m1.rows) console.log(`  ${r.instrument}: n=${r.n} ${new Date(r.min_t).toISOString()} → ${new Date(r.max_t).toISOString()}`);

const m1q = await query<{ n: string }>(
  `SELECT count(*)::text AS n FROM market_candle_quotes WHERE source='oanda' AND timeframe='M1'`,
);
console.log(`\nM1 quotes: ${m1q.rows[0]?.n}`);

const models = await query(
  `SELECT name, version, score_kind, configuration FROM binary_models ORDER BY name, version`,
);
console.log("\n=== binary_models ===");
console.log(JSON.stringify(models.rows, null, 2));

const pred = await query<{
  model_name: string;
  model_version: string;
  status: string;
  n: number;
  min_start: Date;
  max_start: Date;
}>(
  `SELECT model_name, model_version, status, count(*)::int AS n,
          min(start_at) AS min_start, max(start_at) AS max_start
     FROM binary_predictions
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`,
);
console.log("\n=== binary_predictions by model/status ===");
for (const r of pred.rows) {
  console.log(`  ${r.model_name}@${r.model_version} ${r.status}: n=${r.n} ${r.min_start ? new Date(r.min_start).toISOString() : "—"} → ${r.max_start ? new Date(r.max_start).toISOString() : "—"}`);
}

const sample = await query(
  `SELECT prediction_sequence, instrument, direction, start_at, entry_price, duration_seconds,
          intended_expiration, resolution_price, resolution_price_time, resolution_source,
          result, confidence, secondary_marks, model_name, model_version, is_authoritative, is_shadow
     FROM binary_predictions
    WHERE status='resolved'
    ORDER BY start_at DESC
    LIMIT 3`,
);
console.log("\n=== sample resolved ===");
console.log(JSON.stringify(sample.rows, null, 2));

process.exit(0);
