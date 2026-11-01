import fs from "node:fs/promises";
import { chronologicalValidation } from "../../frontend/src/lib/technical-analyzer/validation.js";
import type { HistoryRow } from "../../frontend/src/lib/technical-analyzer/types.js";

const [input, splitAt, flag] = process.argv.slice(2);
if (!input || !splitAt) throw new Error("Usage: tsx scripts/validate-technical-analyzer.ts history.json 2026-12-01T00:00:00Z [--reapply-rules]");
const payload = JSON.parse(await fs.readFile(input, "utf8")) as HistoryRow[] | { rows: HistoryRow[] };
const rows = Array.isArray(payload) ? payload : payload.rows;
if (!Array.isArray(rows)) throw new Error("Input must contain frozen forecast history rows.");
console.log(JSON.stringify(chronologicalValidation(rows, splitAt, flag === "--reapply-rules"), null, 2));
