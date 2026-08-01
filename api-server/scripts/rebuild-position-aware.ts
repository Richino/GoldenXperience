import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const [{ refreshPositionAwareReplay, researchSummary }, { db }] = await Promise.all([import("../src/research.js"), import("../src/database.js")]);
const instrument = process.argv[2]?.toUpperCase();
const results = await refreshPositionAwareReplay(instrument);
for (const result of results) {
  const summary = await researchSummary(result.instrument);
  console.log(`${result.instrument}: ${result.accepted} accepted, ${result.overlapping} overlapping, ${result.labeled} labeled; ${summary.sample_size} resolved, ${summary.average_r === null ? "no expectancy" : `${summary.average_r.toFixed(2)}R expectancy`}.`);
}
await db().end();
