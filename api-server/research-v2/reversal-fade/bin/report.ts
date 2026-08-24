#!/usr/bin/env npx tsx
import fs from "node:fs";
import { REPORT_PATH } from "../src/registry.js";

if (!fs.existsSync(REPORT_PATH)) {
  console.error("No report yet. Run npm run rf:hunt");
  process.exit(1);
}
console.log(fs.readFileSync(REPORT_PATH, "utf8"));
