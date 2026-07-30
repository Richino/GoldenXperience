import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/database.js";

const directory = path.resolve(process.cwd(), "migrations");
const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
await db().query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
for (const file of files) {
  const done = await db().query("SELECT 1 FROM schema_migrations WHERE id=$1", [file]);
  if (done.rowCount) continue;
  const client = await db().connect();
  try { await client.query("BEGIN"); await client.query(await fs.readFile(path.join(directory, file), "utf8")); await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [file]); await client.query("COMMIT"); console.log(`Applied ${file}`); }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
await db().end();
