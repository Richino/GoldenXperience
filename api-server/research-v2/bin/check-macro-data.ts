/**
 * Probe whether historical yield / FRED-like data exists for V2 macro features.
 * Does not invent yields. Prints DATA_BLOCKER if unavailable.
 */
import "../src/env.js";
import { getDb } from "../src/env.js";

const { query } = await getDb();

const tables = await query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema='public'
      AND (table_name ILIKE '%fred%'
        OR table_name ILIKE '%yield%'
        OR table_name ILIKE 'research_v2%macro%'
        OR table_name ILIKE 'research_v2%yield%'
        OR table_name = 'macro_series'
        OR table_name = 'interest_rates')
    ORDER BY 1`,
);

console.log("Macro/yield-related tables:", tables.rows.map((r) => r.table_name));

let blocker = tables.rows.length === 0;
for (const t of tables.rows) {
  const n = await query<{ c: string }>(`SELECT count(*)::text AS c FROM "${t.table_name}"`);
  console.log(`  ${t.table_name}: ${n.rows[0]?.c ?? 0} rows`);
  if (Number(n.rows[0]?.c ?? 0) > 0) blocker = false;
}

if (blocker) {
  console.log("\nDATA_BLOCKER: No historical yield/FRED series in DB.");
  console.log("H21 macro hypotheses will run with macro_available=0 (no rate signal).");
  console.log("Next step when ready: ingest US/JP/EU 2Y yields into research_v2_yields.");
} else {
  console.log("\nYield-like data present — wire research-v2/src/features/macro-events.ts loaders.");
}

process.exit(0);
