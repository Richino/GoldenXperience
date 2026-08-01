import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });

const [{ latestResearchExperiment, researchExperimentDiagnostics, runResearchExperiment }, { db, query }] = await Promise.all([import("../src/research.js"), import("../src/database.js")]);
const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
if (!owner.rows[0]) throw new Error("Create the owner before running a research experiment.");
const instrument = process.argv[2]?.toUpperCase() || "EUR_USD";
const direction = process.argv[3] || "short";
const sessions = (process.argv[4] || "London,London/New York overlap").split(",").map((value) => value.trim()).filter(Boolean);
const months = Number(process.argv[5] || 60);
const latestOnly = process.argv.includes("--latest");
const experiment = latestOnly ? await latestResearchExperiment(owner.rows[0].id, instrument) : await runResearchExperiment(owner.rows[0].id, { instrument, direction, sessions, months });
if (!experiment) throw new Error(`No saved research experiment exists for ${instrument}.`);
const summary = experiment.summary as { executable_candidates: number; overlapping_candidates: number; executable: { sample_size: number; average_r: number | null; profit_factor: number | null }; reference: { average_r: number | null } };
console.log(`${experiment.instrument}: ${summary.executable_candidates} executable, ${summary.overlapping_candidates} overlapping, ${summary.executable.sample_size} resolved, ${summary.executable.average_r === null ? "no expectancy" : `${summary.executable.average_r.toFixed(2)}R expectancy`}, PF ${summary.executable.profit_factor === null ? "—" : summary.executable.profit_factor.toFixed(2)}; same-range baseline ${summary.reference.average_r === null ? "has no expectancy" : `${summary.reference.average_r.toFixed(2)}R`}.`);
const diagnostics = await researchExperimentDiagnostics(owner.rows[0].id, experiment.id);
if (diagnostics) {
  console.log(`Years: ${diagnostics.breakdowns.year.map((row) => `${row.name} ${row.sample_size} trades ${row.average_r === null ? "—" : `${row.average_r.toFixed(2)}R`}`).join("; ")}`);
  console.log(`Sessions: ${diagnostics.breakdowns.session.map((row) => `${row.name} ${row.sample_size} trades ${row.average_r === null ? "—" : `${row.average_r.toFixed(2)}R`}`).join("; ")}`);
  console.log(`Retrospective final year: ${diagnostics.retrospective.finalYear.sample_size} trades, ${diagnostics.retrospective.finalYear.average_r === null ? "—" : `${diagnostics.retrospective.finalYear.average_r.toFixed(2)}R expectancy`}.`);
}
await db().end();
