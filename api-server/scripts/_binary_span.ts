import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const r = await query<{ mn: string; mx: string; n: string }>(
  "SELECT min(created_at)::text AS mn, max(created_at)::text AS mx, count(*)::text AS n FROM binary_predictions WHERE result IN ('won','lost')",
);
const { mn, mx, n } = r.rows[0]!;
const days = (Date.parse(mx) - Date.parse(mn)) / 86400e3;
console.log(`min: ${mn}`);
console.log(`max: ${mx}`);
console.log(`n: ${n}`);
console.log(`span: ${days.toFixed(1)} days`);
console.log(`rate: ${(Number(n) / days).toFixed(2)} predictions/day`);
process.exit(0);
