import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const cols = await query<{ column_name: string }>(
  `SELECT column_name FROM information_schema.columns WHERE table_name='binary_predictions' ORDER BY 1`,
);
console.log("cols", cols.rows.map((r) => r.column_name).join(", "));

const overall = await query(
  `SELECT count(*)::int AS n,
          count(*) FILTER (WHERE result='won')::int AS wins,
          count(*) FILTER (WHERE result='lost')::int AS losses,
          count(*) FILTER (WHERE result='tie')::int AS ties
     FROM binary_predictions
    WHERE status='resolved' AND COALESCE(is_authoritative, true)=true`,
);
console.log("overall", overall.rows[0]);

const byDir = await query(
  `SELECT direction, result, count(*)::int AS n
     FROM binary_predictions
    WHERE status='resolved' AND COALESCE(is_authoritative, true)=true
    GROUP BY 1,2 ORDER BY 1,2`,
);
console.log("by dir/result", byDir.rows);

const byConf = await query(
  `SELECT CASE
            WHEN confidence >= 0.7 THEN '0.70+'
            WHEN confidence >= 0.6 THEN '0.60-0.70'
            WHEN confidence >= 0.55 THEN '0.55-0.60'
            ELSE '<0.55'
          END AS band,
          count(*)::int AS n,
          count(*) FILTER (WHERE result='won')::int AS wins,
          round(100.0 * count(*) FILTER (WHERE result='won') / NULLIF(count(*) FILTER (WHERE result IN ('won','lost')),0), 1)::float AS win_pct
     FROM binary_predictions
    WHERE status='resolved' AND COALESCE(is_authoritative, true)=true AND confidence IS NOT NULL
    GROUP BY 1 ORDER BY 1`,
);
console.log("by conf", byConf.rows);

process.exit(0);
