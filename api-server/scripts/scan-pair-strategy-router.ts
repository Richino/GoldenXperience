import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPairStrategyRouter } from "../src/pair-strategy-scanner.js";

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "research-v2", "pair-strategy-router-v1", "LATEST_SCAN.json");
const scan = await scanPairStrategyRouter({ maxSelections: 1 });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(scan, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ scannedAt: scan.scannedAt, universe: scan.universeSize, validatedStrategies: scan.validatedStrategyPairs, selected: scan.selected.map((record) => ({ pair: record.instrument, direction: record.candidate?.direction, score: record.score })), safety: scan.safety, counts: scan.records.reduce<Record<string, number>>((result, record) => ({ ...result, [record.status]: (result[record.status] ?? 0) + 1 }), {}) }, null, 2));
