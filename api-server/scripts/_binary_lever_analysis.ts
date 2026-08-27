/**
 * Lever analysis: what boosts winrate above 60%, what drags it below?
 * Tests each candidate filter on the AUD_JPY overlap pocket (n=153, 63.4% baseline).
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

type Row = {
  instrument: string; direction: string; result: string; created_at: string;
  features: Record<string, unknown> | null; strategy_source: string | null;
  model_name: string; confidence: string | null;
};
const rows = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text, features, strategy_source,
         model_name, confidence::text
    FROM binary_predictions
   WHERE result IN ('won', 'lost')
`)).rows;

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}

// Filter to the AUD_JPY up overlap pocket
const pocket = rows.filter((r) => r.instrument === "AUD_JPY" && r.direction === "up" && sessionOf(etHour(r.created_at)) === "overlap");
console.log(`AUD_JPY / up / overlap pocket: n=${pocket.length}  winrate=${(100 * pocket.filter((r) => r.result === "won").length / pocket.length).toFixed(1)}%\n`);

function stats(sub: Row[], label: string): void {
  if (!sub.length) { console.log(`  ${label}: n=0`); return; }
  const wins = sub.filter((r) => r.result === "won").length;
  const wr = 100 * wins / sub.length;
  console.log(`  ${label.padEnd(46)} n=${String(sub.length).padStart(4)}  W=${String(wins).padStart(3)}  wr=${wr.toFixed(1).padStart(5)}%`);
}

// ---- Lever 1: hour precision within overlap ----
console.log("=== LEVER 1: NARROW HOUR WITHIN OVERLAP ===");
for (const h of [8, 9, 10, 11]) {
  const sub = pocket.filter((r) => etHour(r.created_at) === h);
  stats(sub, `hour ${h}am ET only`);
}

// ---- Lever 2: confidence bucket ----
console.log("\n=== LEVER 2: CONFIDENCE THRESHOLD ===");
for (const thr of [0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]) {
  const sub = pocket.filter((r) => r.confidence !== null && Number(r.confidence) >= thr);
  stats(sub, `confidence >= ${thr}`);
}

// ---- Lever 3: RSI regime ----
console.log("\n=== LEVER 3: RSI VALUE AT PREDICTION ===");
const rsiRanges: [number, number, string][] = [
  [0, 20, "RSI < 20 (deeply oversold)"],
  [20, 30, "RSI 20-30 (oversold)"],
  [30, 50, "RSI 30-50 (neutral-low)"],
  [50, 70, "RSI 50-70 (neutral-high)"],
  [70, 80, "RSI 70-80 (overbought)"],
  [80, 100, "RSI 80+ (deeply overbought)"],
];
for (const [lo, hi, label] of rsiRanges) {
  const sub = pocket.filter((r) => {
    const rsi = r.features?.rsi as number | undefined;
    return typeof rsi === "number" && rsi >= lo && rsi < hi;
  });
  stats(sub, label);
}

// ---- Lever 4: ADX bucket ----
console.log("\n=== LEVER 4: ADX (TREND STRENGTH) ===");
const adxRanges: [number, number, string][] = [
  [0, 15, "ADX < 15 (no trend)"],
  [15, 20, "ADX 15-20 (weak)"],
  [20, 25, "ADX 20-25 (mild)"],
  [25, 30, "ADX 25-30 (moderate)"],
  [30, 40, "ADX 30-40 (strong)"],
  [40, 100, "ADX 40+ (very strong)"],
];
for (const [lo, hi, label] of adxRanges) {
  const sub = pocket.filter((r) => {
    const adx = r.features?.adx as number | undefined;
    return typeof adx === "number" && adx >= lo && adx < hi;
  });
  stats(sub, label);
}

// ---- Lever 5: model type ----
console.log("\n=== LEVER 5: MODEL SOURCE ===");
const models = [...new Set(pocket.map((r) => r.model_name))];
for (const m of models) stats(pocket.filter((r) => r.model_name === m), m);

const sources = [...new Set(pocket.map((r) => r.strategy_source ?? (r.features?.source as string) ?? "unknown"))];
for (const s of sources) stats(pocket.filter((r) => (r.strategy_source ?? (r.features?.source as string) ?? "unknown") === s), `source: ${s}`);

// ---- Lever 6: branch ----
console.log("\n=== LEVER 6: BRANCH (feature-driven strategy branch) ===");
const branches = [...new Set(pocket.map((r) => (r.features?.branch as string) ?? "none"))];
for (const b of branches) stats(pocket.filter((r) => ((r.features?.branch as string) ?? "none") === b), `branch: ${b}`);

// ---- Lever 7: day of week within overlap ----
console.log("\n=== LEVER 7: DAY OF WEEK ===");
for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
  const sub = pocket.filter((r) => {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(r.created_at));
    return wd === d;
  });
  stats(sub, d);
}

// ---- Lever 8: combined stack (narrow every dimension) ----
console.log("\n=== LEVER 8: STACKED FILTERS (fewer trades, tighter edge) ===");
const stacked1 = pocket.filter((r) => {
  const rsi = r.features?.rsi as number | undefined;
  return typeof rsi === "number" && rsi < 30;
});
stats(stacked1, "overlap × RSI<30");

const stacked2 = pocket.filter((r) => {
  const adx = r.features?.adx as number | undefined;
  return typeof adx === "number" && adx >= 25;
});
stats(stacked2, "overlap × ADX>=25");

const stacked3 = pocket.filter((r) => {
  const conf = r.confidence !== null ? Number(r.confidence) : null;
  return conf !== null && conf >= 0.70;
});
stats(stacked3, "overlap × confidence>=0.70");

const stacked4 = pocket.filter((r) => {
  const rsi = r.features?.rsi as number | undefined;
  const adx = r.features?.adx as number | undefined;
  return typeof rsi === "number" && rsi < 30 && typeof adx === "number" && adx >= 25;
});
stats(stacked4, "overlap × RSI<30 × ADX>=25");

process.exit(0);
