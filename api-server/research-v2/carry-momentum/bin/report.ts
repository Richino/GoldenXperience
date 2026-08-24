#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const report = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../FINAL_REPORT_D1.txt");
const legacy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../FINAL_REPORT.txt");
const p = fs.existsSync(report) ? report : legacy;
if (!fs.existsSync(p)) {
  console.error("No report. Run npm run cm:hunt");
  process.exit(1);
}
console.log(fs.readFileSync(p, "utf8"));
