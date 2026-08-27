/**
 * Extended-dimension edge search on binary predictions.
 * Tries buckets we haven't hit yet: raw ADX, raw RSI, confidence, bbReentry.side,
 * secondary 5-min mark (leading indicator), resolution_source, model_version,
 * day-of-week, plus 2-way and 3-way combos.
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
  features: Record<string, unknown> | null;
  market_context: Record<string, unknown> | null;
  secondary_marks: Record<string, { result?: string }> | null;
  strategy_source: string | null;
  model_name: string;
  model_version: string;
  resolution_source: string | null;
  confidence: string | null;
};
const rows = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text, features, market_context, secondary_marks,
         strategy_source, model_name, model_version, resolution_source, confidence::text
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
`)).rows;
console.log(`resolved trades: ${rows.length}`);

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "weekday")?.value ?? "?";
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}
function bucketRsi(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "na";
  if (v < 10) return "0-10";
  if (v < 20) return "10-20";
  if (v < 30) return "20-30";
  if (v < 40) return "30-40";
  if (v < 60) return "40-60";
  if (v < 70) return "60-70";
  if (v < 80) return "70-80";
  if (v < 90) return "80-90";
  return "90+";
}
function bucketAdx(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "na";
  if (v < 15) return "<15";
  if (v < 20) return "15-20";
  if (v < 25) return "20-25";
  if (v < 30) return "25-30";
  if (v < 40) return "30-40";
  if (v < 50) return "40-50";
  return "50+";
}
function bucketConf(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "na";
  if (v < 0.55) return "0.5-0.55";
  if (v < 0.60) return "0.55-0.60";
  if (v < 0.65) return "0.60-0.65";
  if (v < 0.70) return "0.65-0.70";
  if (v < 0.75) return "0.70-0.75";
  if (v < 0.80) return "0.75-0.80";
  if (v < 0.90) return "0.80-0.90";
  return "0.90+";
}

type Dims = {
  source: string; model: string; instrument: string; direction: string;
  session: string; hourET: string; dayOfWeek: string;
  rsiBucket: string; adxBucket: string; confBucket: string;
  branch: string; rsiSeverity: string; bbReentrySide: string;
  resolutionSource: string; secondary300: string;
};

const dimData: Array<{ d: Dims; won: boolean }> = rows.map((r) => {
  const hour = etHour(r.created_at);
  const feats = r.features ?? {};
  const source = r.strategy_source ?? (feats.source as string) ?? "unknown";
  const branch = (feats.branch as string) ?? "none";
  const rsiSev = (feats.rsiSeverity as string) ?? "none";
  const rsiRaw = typeof feats.rsi === "number" ? feats.rsi as number : null;
  const adxRaw = typeof feats.adx === "number" ? feats.adx as number : null;
  const bbReentry = (feats.bbReentry as { side?: string } | undefined)?.side ?? "none";
  const secondary300 = r.secondary_marks?.["300s"]?.result ?? "none";
  const conf = r.confidence !== null ? Number(r.confidence) : null;
  return {
    d: {
      source, model: r.model_name, instrument: r.instrument, direction: r.direction,
      session: sessionOf(hour),
      hourET: `h${hour.toString().padStart(2, "0")}`,
      dayOfWeek: etDay(r.created_at),
      rsiBucket: bucketRsi(rsiRaw),
      adxBucket: bucketAdx(adxRaw),
      confBucket: bucketConf(conf),
      branch, rsiSeverity: rsiSev, bbReentrySide: bbReentry,
      resolutionSource: r.resolution_source ?? "none",
      secondary300,
    },
    won: r.result === "won",
  };
});

// NOTE: secondary300 (5-min mark result) is EXCLUDED — it is only known
// after 5 minutes of the trade have elapsed, so using it at prediction
// time is a look-ahead leak. resolutionSource similarly may leak.
const DIMS = [
  "source", "model", "instrument", "direction", "session", "hourET", "dayOfWeek",
  "rsiBucket", "adxBucket", "confBucket", "branch", "rsiSeverity", "bbReentrySide",
] as const;
type DimKey = typeof DIMS[number];

const MIN_N = Number(process.env.MIN_N ?? "100");
const HI = Number(process.env.HI ?? "65");
const LO = Number(process.env.LO ?? "35");
const MAX_COMBO = Number(process.env.MAX_COMBO ?? "3");
const NA_VALUES = new Set(["none", "na", "unknown"]);

type Hit = { keys: DimKey[]; values: string[]; n: number; w: number; wr: number };
const hits: Hit[] = [];

function findCombos(size: number) {
  const combos: DimKey[][] = [];
  const build = (start: number, current: DimKey[]) => {
    if (current.length === size) { combos.push([...current]); return; }
    for (let i = start; i < DIMS.length; i++) {
      current.push(DIMS[i]!);
      build(i + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return combos;
}

for (let sz = 1; sz <= MAX_COMBO; sz++) {
  for (const combo of findCombos(sz)) {
    const map = new Map<string, { n: number; w: number; vs: string[] }>();
    for (const row of dimData) {
      const vs = combo.map((k) => row.d[k]);
      // Skip if any NA
      if (vs.some((v) => NA_VALUES.has(v))) continue;
      const key = vs.join("|");
      const b = map.get(key) ?? { n: 0, w: 0, vs };
      b.n++; if (row.won) b.w++;
      map.set(key, b);
    }
    for (const b of map.values()) {
      if (b.n < MIN_N) continue;
      const wr = 100 * b.w / b.n;
      if (wr >= HI || wr <= LO) hits.push({ keys: combo, values: b.vs, n: b.n, w: b.w, wr });
    }
  }
}

hits.sort((a, b) => Math.abs(b.wr - 50) - Math.abs(a.wr - 50));

console.log(`\n=== extended search  (n >= ${MIN_N}, wr >= ${HI}% or <= ${LO}%, up to ${MAX_COMBO}-way) ===`);
console.log(`  ${hits.length} slice(s) found`);
if (hits.length) {
  console.log(`  keys                                          values                                              n     W    winrate  action`);
  for (const h of hits.slice(0, 40)) {
    const keyStr = h.keys.join("/");
    const valStr = h.values.join("|");
    const action = h.wr >= 50 ? "follow" : "INVERT";
    console.log(`  ${keyStr.padEnd(46)}  ${valStr.padEnd(50)}  ${String(h.n).padStart(4)}  ${String(h.w).padStart(4)}  ${h.wr.toFixed(1).padStart(5)}%  ${action}`);
  }
}

process.exit(0);
