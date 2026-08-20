import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Derives frozen regime boundaries from resolved binary predictions.
 * Output: src/data/binary-regimes-v1.json
 *
 * Usage:
 *   node scripts/_binary-regime-calibration.mjs
 *   node scripts/_binary-regime-calibration.mjs --export=src/data/binary-regimes-v1.json
 */

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.resolve("./.env"));
loadEnv(path.resolve("./.env.local"));

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * p);
  return sorted[index] ?? null;
}

function emaGapPct(features) {
  if (num(features.emaFast) == null || num(features.emaSlow) == null || !features.referenceClose) return null;
  return (features.emaFast - features.emaSlow) / features.referenceClose;
}

const exportPath = process.argv.find((arg) => arg.startsWith("--export="))?.slice("--export=".length)
  ?? path.resolve("src/data/binary-regimes-v1.json");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(`
  SELECT features, confidence::float AS confidence, score_kind, model_name, is_shadow
  FROM binary_predictions
  WHERE status='resolved' AND result IN ('won','lost','tie') AND features IS NOT NULL
  ORDER BY created_at ASC
`);
await client.end();

const atrValues = [];
const volatilityValues = [];
const gapValues = [];
const baselineConfidence = [];
const logisticConfidence = [];

for (const row of rows) {
  const features = row.features ?? {};
  const atr = num(features.atrPips);
  const vol = num(features.volatilityPips);
  const gap = emaGapPct(features);
  if (atr != null) atrValues.push(atr);
  if (vol != null) volatilityValues.push(vol);
  if (gap != null) gapValues.push(gap);
  if (row.is_shadow || row.model_name === "binary-logistic-v1") logisticConfidence.push(row.confidence);
  else baselineConfidence.push(row.confidence);
}

const atrLowUpper = quantile(atrValues, 1 / 3);
const atrHighLower = quantile(atrValues, 2 / 3);
const volLowUpper = quantile(volatilityValues, 1 / 3);
const volHighLower = quantile(volatilityValues, 2 / 3);
const trendDownUpper = quantile(gapValues, 1 / 3);
const trendUpLower = quantile(gapValues, 2 / 3);

const artifact = {
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
  sampleSize: rows.length,
  method: "tertile_quantiles_from_resolved_predictions",
  sessions: {
    known: ["London", "New York", "London/New York overlap"],
    fallback: "OTHER",
  },
  atrPips: {
    labels: ["LOW", "NORMAL", "HIGH"],
    lowUpper: atrLowUpper,
    highLower: atrHighLower,
  },
  volatilityPips: {
    labels: ["LOW", "NORMAL", "HIGH"],
    lowUpper: volLowUpper,
    highLower: volHighLower,
  },
  trend: {
    labels: ["DOWN", "FLAT", "UP"],
    downUpper: trendDownUpper,
    upLower: trendUpLower,
    note: "Derived from emaGapPct = (emaFast - emaSlow) / referenceClose",
  },
  confidenceBuckets: {
    heuristic_score: [
      { label: "0.58-0.65", min: 0.58, max: 0.65, maxInclusive: false },
      { label: "0.65-0.70", min: 0.65, max: 0.70, maxInclusive: false },
      { label: "0.70-0.80", min: 0.70, max: 0.80, maxInclusive: false },
      { label: "0.80+", min: 0.80, max: null, maxInclusive: true },
    ],
    probability: [
      { label: "0.50-0.55", min: 0.50, max: 0.55, maxInclusive: false },
      { label: "0.55-0.60", min: 0.55, max: 0.60, maxInclusive: false },
      { label: "0.60-0.70", min: 0.60, max: 0.70, maxInclusive: false },
      { label: "0.70+", min: 0.70, max: null, maxInclusive: true },
    ],
  },
  distributionSummary: {
    atrPips: { count: atrValues.length, min: Math.min(...atrValues), max: Math.max(...atrValues) },
    volatilityPips: { count: volatilityValues.length, min: Math.min(...volatilityValues), max: Math.max(...volatilityValues) },
    emaGapPct: { count: gapValues.length, min: Math.min(...gapValues), max: Math.max(...gapValues) },
    baselineConfidence: {
      count: baselineConfidence.length,
      min: baselineConfidence.length ? Math.min(...baselineConfidence) : null,
      max: baselineConfidence.length ? Math.max(...baselineConfidence) : null,
    },
    logisticConfidence: {
      count: logisticConfidence.length,
      min: logisticConfidence.length ? Math.min(...logisticConfidence) : null,
      max: logisticConfidence.length ? Math.max(...logisticConfidence) : null,
    },
  },
};

fs.mkdirSync(path.dirname(path.resolve(exportPath)), { recursive: true });
fs.writeFileSync(path.resolve(exportPath), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`Exported regime config → ${path.resolve(exportPath)}`);
console.log(`Sample size: ${rows.length}`);
console.log(`ATR tertiles: LOW ≤ ${atrLowUpper?.toFixed(4)}, HIGH ≥ ${atrHighLower?.toFixed(4)}`);
console.log(`Volatility tertiles: LOW ≤ ${volLowUpper?.toFixed(4)}, HIGH ≥ ${volHighLower?.toFixed(4)}`);
console.log(`Trend tertiles: DOWN ≤ ${trendDownUpper?.toExponential(4)}, UP ≥ ${trendUpLower?.toExponential(4)}`);
