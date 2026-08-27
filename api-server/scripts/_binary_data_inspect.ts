import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const tables = await query<{ table_name: string }>(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'binary%' ORDER BY table_name",
);
console.log("Binary tables:");
for (const t of tables.rows) console.log("  " + t.table_name);

console.log();

for (const tbl of tables.rows) {
  try {
    const c = await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl.table_name}`);
    console.log(`${tbl.table_name}: ${c.rows[0]!.n} rows`);
  } catch (e) { console.log(`${tbl.table_name}: err ${(e as Error).message}`); }
}

// Inspect main predictions table
const cols = await query<{ column_name: string; data_type: string }>(
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'binary_predictions' ORDER BY ordinal_position",
);
console.log("\nbinary_predictions columns:");
for (const c of cols.rows) console.log(`  ${c.column_name}  ${c.data_type}`);

const sample = await query("SELECT * FROM binary_predictions ORDER BY created_at DESC LIMIT 1");
console.log("\nsample row:", JSON.stringify(sample.rows[0], null, 2));

process.exit(0);
