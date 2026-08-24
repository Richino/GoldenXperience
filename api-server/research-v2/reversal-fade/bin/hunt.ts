#!/usr/bin/env npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(root, name), override: false });
}

import { runHunt } from "../src/hunt.js";

runHunt().catch((e) => {
  console.error(e);
  process.exit(1);
});
