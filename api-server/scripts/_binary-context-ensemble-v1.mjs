import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import pg from "pg";

/**
 * Research-only orchestrator for binary-context-ensemble-v1.
 *
 * The database is queried in two stages. TRAIN+DEV labels are made available to
 * the Python search first. HOLDOUT labels are not queried unless the selected
 * DEV candidate clears the predeclared evidence gate.
 */

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = path.join(serviceRoot, "research-v2", "binary-context-ensemble-v1");
const reportPath = path.join(reportDir, "FINAL_REPORT.txt");
const pythonScript = path.join(serviceRoot, "scripts", "_binary-context-ensemble-v1.py");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

for (const name of [".env", ".env.local"]) loadEnv(path.join(serviceRoot, name));
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");

const COHORT_SQL = `
  status = 'resolved'
  AND result IN ('won', 'lost', 'tie')
  AND features IS NOT NULL
  AND resolution_price IS NOT NULL
  AND is_shadow = false
  AND COALESCE(is_authoritative, true) = true
  AND model_name = 'binary-baseline-v1'
  AND model_version = '1.0.0'
  AND duration_seconds = 600
`;

const ROW_COLUMNS = `
  id,
  COALESCE(opportunity_id::text, id::text) AS opportunity_key,
  instrument,
  direction,
  result,
  confidence::float AS confidence,
  entry_price::float AS entry_price,
  resolution_price::float AS resolution_price,
  price_precision,
  tie_tolerance,
  features,
  market_context,
  start_at,
  intended_expiration,
  resolution_price_time,
  resolution_source,
  resolved_at,
  created_at
`;

function boundaryAtFraction(groups, total, fraction) {
  const target = total * fraction;
  let cumulative = 0;
  for (const group of groups) {
    cumulative += Number(group.n);
    if (cumulative >= target) return new Date(group.start_at);
  }
  return new Date(groups.at(-1).start_at);
}

function runPython(args) {
  const command = process.env.GX_PYTHON_COMMAND || "py";
  const prefix = command.toLowerCase().endsWith("py") ? ["-3"] : [];
  const run = spawnSync(command, [...prefix, pythonScript, ...args], {
    cwd: serviceRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (run.status !== 0) {
    throw new Error(`Python audit failed (${run.status}).\n${run.stdout}\n${run.stderr}`);
  }
  if (run.stdout.trim()) process.stdout.write(run.stdout);
  if (run.stderr.trim()) process.stderr.write(run.stderr);
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

fs.mkdirSync(reportDir, { recursive: true });

const token = randomUUID();
const discoveryInput = path.join(os.tmpdir(), `gx-binary-context-discovery-${token}.json`);
const holdoutInput = path.join(os.tmpdir(), `gx-binary-context-holdout-${token}.json`);
const statePath = path.join(os.tmpdir(), `gx-binary-context-state-${token}.joblib`);
const statusPath = path.join(os.tmpdir(), `gx-binary-context-status-${token}.json`);
const tempFiles = [discoveryInput, holdoutInput, statePath, statusPath];

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  // Only timestamps and counts are read here; no HOLDOUT features or outcomes.
  const metadata = await client.query(`
    SELECT start_at, count(*)::int AS n
    FROM binary_predictions
    WHERE ${COHORT_SQL}
    GROUP BY start_at
    ORDER BY start_at ASC
  `);
  if (!metadata.rows.length) throw new Error("No eligible authoritative baseline predictions found.");

  const totalRows = metadata.rows.reduce((sum, row) => sum + Number(row.n), 0);
  const trainBoundary = boundaryAtFraction(metadata.rows, totalRows, 0.60);
  const holdoutBoundary = boundaryAtFraction(metadata.rows, totalRows, 0.80);
  const purgeMs = 10 * 60_000;
  const discoveryLabelEnd = new Date(holdoutBoundary.getTime() - purgeMs);

  const discovery = await client.query(
    `SELECT ${ROW_COLUMNS}
       FROM binary_predictions
      WHERE ${COHORT_SQL}
        AND start_at < $1
      ORDER BY start_at ASC, instrument ASC, id ASC`,
    [discoveryLabelEnd.toISOString()],
  );

  writeJson(discoveryInput, {
    experiment: "binary-context-ensemble-v1",
    generatedAt: new Date().toISOString(),
    metadata: {
      totalCohortRows: totalRows,
      trainBoundary: trainBoundary.toISOString(),
      holdoutBoundary: holdoutBoundary.toISOString(),
      purgeMinutes: 10,
      cohort: "authoritative binary-baseline-v1@1.0.0, resolved, 600 seconds, non-shadow",
    },
    rows: discovery.rows,
  });

  runPython([
    "--phase", "discovery",
    "--input", discoveryInput,
    "--state", statePath,
    "--status", statusPath,
    "--report", reportPath,
  ]);

  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  if (status.gatePassed === true) {
    // This is the first query in the run that reads HOLDOUT outcomes/features.
    const full = await client.query(
      `SELECT ${ROW_COLUMNS}
         FROM binary_predictions
        WHERE ${COHORT_SQL}
        ORDER BY start_at ASC, instrument ASC, id ASC`,
    );
    writeJson(holdoutInput, {
      experiment: "binary-context-ensemble-v1",
      generatedAt: new Date().toISOString(),
      metadata: {
        totalCohortRows: totalRows,
        trainBoundary: trainBoundary.toISOString(),
        holdoutBoundary: holdoutBoundary.toISOString(),
        purgeMinutes: 10,
        cohort: "authoritative binary-baseline-v1@1.0.0, resolved, 600 seconds, non-shadow",
      },
      rows: full.rows,
    });
    runPython([
      "--phase", "holdout",
      "--input", holdoutInput,
      "--state", statePath,
      "--status", statusPath,
      "--report", reportPath,
    ]);
  }

  console.log(`Audit report: ${reportPath}`);
  console.log(fs.readFileSync(reportPath, "utf8"));
} finally {
  await client.end().catch(() => undefined);
  for (const file of tempFiles) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
