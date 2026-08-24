import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CmExperiment } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CM_REGISTRY = path.resolve(HERE, "../experiments/registry.jsonl");
export const CM_CANDIDATES = path.resolve(HERE, "../candidates");

export function appendExperiment(exp: CmExperiment): void {
  fs.mkdirSync(path.dirname(CM_REGISTRY), { recursive: true });
  fs.appendFileSync(CM_REGISTRY, JSON.stringify(exp) + "\n", "utf8");
}

export function loadExperiments(): CmExperiment[] {
  if (!fs.existsSync(CM_REGISTRY)) return [];
  return fs
    .readFileSync(CM_REGISTRY, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CmExperiment);
}

export function freezeCandidate(id: string, payload: unknown): string {
  fs.mkdirSync(CM_CANDIDATES, { recursive: true });
  const p = path.join(CM_CANDIDATES, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
  return p;
}
