import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

console.log("DB set:", Boolean(process.env.DATABASE_URL));
const tables = await query<{ tablename: string }>(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '%binary%' ORDER BY 1`,
);
console.log("tables:", tables.rows.map((r) => r.tablename));

for (const table of tables.rows.map((r) => r.tablename)) {
  const cols = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  console.log(`\n${table} columns:`, cols.rows.map((c) => c.column_name).join(", "));
  try {
    const sample = await query(`SELECT * FROM ${table} LIMIT 1`);
    console.log(`${table} sample keys:`, sample.rows[0] ? Object.keys(sample.rows[0]) : "(empty)");
    const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    console.log(`${table} count:`, n.rows[0]?.n);
  } catch (e) {
    console.log(`${table} error:`, e instanceof Error ? e.message : e);
  }
}

process.exit(0);
