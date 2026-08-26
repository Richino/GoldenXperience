/**
 * Manual invocation of collectLegacyConfidenceV2Cycle() to verify the audit
 * trail is being written. Forces ENABLED=true so the cycle actually runs, and
 * keeps DRY_RUN=true so no paper trades are opened. Every pair produces one
 * row in legacy_confidence_v2_evaluations.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

process.env.LEGACY_CONFIDENCE_V2_ENABLED = "true";
process.env.LEGACY_CONFIDENCE_V2_DRY_RUN = process.env.LEGACY_CONFIDENCE_V2_DRY_RUN ?? "true";

const { collectLegacyConfidenceV2Cycle } = await import("../src/legacy-confidence-v2-collector.js");

const t0 = Date.now();
const res = await collectLegacyConfidenceV2Cycle();
console.log(`cycle result:`, res);
console.log(`took ${(Date.now() - t0)}ms`);
process.exit(0);
