import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(root, n), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");
const r = await query(
  `SELECT model_name, is_authoritative, status, count(*)::int AS n
     FROM binary_predictions GROUP BY 1,2,3 ORDER BY n DESC`,
);
const out = JSON.stringify(r.rows, null, 2);
fs.writeFileSync(path.join(root, "research-v2", "_probe-counts.json"), out);
console.log(out);
process.exit(0);
