import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExperimentRow } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RF_ROOT = path.resolve(HERE, "..");
export const REGISTRY = path.join(RF_ROOT, "experiments", "registry.jsonl");
export const CANDIDATES = path.join(RF_ROOT, "candidates");
export const REPORT_PATH = path.join(RF_ROOT, "FINAL_REPORT.txt");

export function appendExperiment(row: ExperimentRow): void {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
  fs.appendFileSync(REGISTRY, JSON.stringify(row) + "\n", "utf8");
}

export function freezeCandidate(id: string, payload: unknown): string {
  fs.mkdirSync(CANDIDATES, { recursive: true });
  const p = path.join(CANDIDATES, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
  return p;
}

export function writeReport(text: string): void {
  fs.writeFileSync(REPORT_PATH, text, "utf8");
}
