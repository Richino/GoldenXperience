#!/usr/bin/env npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}

import { ingestAllYields } from "../src/yields/store.js";

async function main() {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    console.error("DATA_BLOCKER: FRED_API_KEY missing");
    process.exit(2);
  }
  console.log("Ingesting FRED yields (point-in-time lags applied on write)...");
  const res = await ingestAllYields(key);
  console.log(`Wrote ${res.n} observations → ${res.path}`);
  console.log(JSON.stringify(res.bySeries, null, 2));
  const zeros = Object.entries(res.bySeries).filter(([, n]) => n === 0);
  if (zeros.length === Object.keys(res.bySeries).length) {
    console.error("DATA_BLOCKER: all series empty");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
