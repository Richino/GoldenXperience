#!/usr/bin/env npx tsx
/**
 * D1 cross-sectional carry + momentum portfolio research (wave 2).
 * RESEARCH_ONLY — LIVE_EXECUTABLE_FAMILIES stays [].
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}

import { runWave2 } from "../src/portfolio/run.js";

runWave2(process.env.FRED_API_KEY).catch((e) => {
  console.error(e);
  process.exit(1);
});
