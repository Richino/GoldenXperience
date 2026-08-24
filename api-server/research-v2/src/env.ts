import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(serviceRoot, name), override: false });
}
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
}

export const RESEARCH_V2_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXPERIMENTS_DIR = path.join(RESEARCH_V2_ROOT, "experiments");
export const CANDIDATES_DIR = path.join(RESEARCH_V2_ROOT, "candidates");
export const REGISTRY_PATH = path.join(EXPERIMENTS_DIR, "registry.jsonl");

export async function getDb() {
  const { query } = await import("../../src/database.js");
  return { query };
}
