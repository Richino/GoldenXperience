/**
 * CLI: autonomous V2 edge hunt (TRAIN/DEV iterate; sealed one-shot).
 *
 * Env:
 *   V2_MAX_COMBOS=24     — limit combos this run
 *   V2_ALLOW_SEALED=1    — evaluate sealed for DEV+robustness passers (default 1)
 *   V2_HYPOTHESES=H01,H02 — optional subset
 */
import "../src/env.js";
import { runHunt } from "../src/hunt/loop.js";
import { ensureRegistryDirs } from "../src/registry/store.js";
import { printFullReport } from "../src/hunt/report.js";

ensureRegistryDirs();

const maxCombos = Number(process.env.V2_MAX_COMBOS ?? "24");
const allowSealed = (process.env.V2_ALLOW_SEALED ?? "1") !== "0";
const hypothesisIds = process.env.V2_HYPOTHESES
  ? process.env.V2_HYPOTHESES.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

await runHunt({ maxCombos, allowSealed, hypothesisIds });
printFullReport();
process.exit(0);
