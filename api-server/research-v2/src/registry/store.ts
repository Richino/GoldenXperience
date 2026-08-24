import fs from "node:fs";
import path from "node:path";

import { CANDIDATES_DIR, EXPERIMENTS_DIR, REGISTRY_PATH } from "../env.js";
import type { ExperimentRecord } from "../types.js";

export function ensureRegistryDirs() {
  fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, "", "utf8");
}

export function appendExperiment(record: ExperimentRecord): void {
  ensureRegistryDirs();
  fs.appendFileSync(REGISTRY_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

export function readExperiments(): ExperimentRecord[] {
  ensureRegistryDirs();
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExperimentRecord);
}

export function nextExperimentId(): string {
  const n = readExperiments().length + 1;
  return `exp-${String(n).padStart(4, "0")}`;
}

export function freezeCandidate(candidateId: string, payload: unknown): string {
  ensureRegistryDirs();
  const file = path.join(CANDIDATES_DIR, `${candidateId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

export function nextCandidateId(): string {
  const existing = fs.existsSync(CANDIDATES_DIR)
    ? fs.readdirSync(CANDIDATES_DIR).filter((f) => f.startsWith("gx-v2-") && f.endsWith(".json"))
    : [];
  const n = existing.length + 1;
  return `gx-v2-${String(n).padStart(3, "0")}`;
}
