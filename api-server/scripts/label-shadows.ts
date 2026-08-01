import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const [{ refreshHistoricalShadowOutcomes }, { db }] = await Promise.all([import("../src/research.js"), import("../src/database.js")]);
const instrument = process.argv[2]?.toUpperCase();
const result = await refreshHistoricalShadowOutcomes(instrument);
console.log(`Labeled ${result.labeled} full-pipeline shadow outcomes${instrument ? ` for ${instrument}` : ""}.`);
await db().end();
