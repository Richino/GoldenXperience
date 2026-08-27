/**
 * Second-pass refinement: take each of the 13 baseline pockets and try to push
 * the winrate up by adding an internal filter (confidence, RSI, ADX, hour).
 * Reports best sub-filter per pocket, only if n after filter >= 20.
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
  features: Record<string, unknown> | null; confidence: string | null;
  model_name: string;
};

const rows = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text, features, confidence::text, model_name
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
`)).rows;

function etDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "weekday")?.value ?? "?";
}
function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}

// The 13 baseline pockets (pair, direction, day, action)
type Pocket = { pair: string; dir: "up" | "down"; day: string; action: "follow" | "invert"; baseWr: number; baseN: number };
const POCKETS: Pocket[] = [
  { pair: "GBP_JPY", dir: "up", day: "Thu", action: "follow", baseWr: 66.1, baseN: 115 },
  { pair: "AUD_JPY", dir: "down", day: "Mon", action: "follow", baseWr: 62.7, baseN: 67 },
  { pair: "EUR_AUD", dir: "down", day: "Mon", action: "follow", baseWr: 62.1, baseN: 58 },
  { pair: "AUD_JPY", dir: "up", day: "Fri", action: "follow", baseWr: 61.5, baseN: 96 },
  { pair: "GBP_JPY", dir: "down", day: "Thu", action: "invert", baseWr: 68.8, baseN: 32 },
  { pair: "AUD_USD", dir: "down", day: "Thu", action: "invert", baseWr: 66.7, baseN: 63 },
  { pair: "EUR_AUD", dir: "up", day: "Wed", action: "invert", baseWr: 63.6, baseN: 88 },
  { pair: "USD_CAD", dir: "down", day: "Mon", action: "invert", baseWr: 62.4, baseN: 85 },
  { pair: "AUD_JPY", dir: "down", day: "Thu", action: "invert", baseWr: 62.0, baseN: 50 },
  { pair: "EUR_GBP", dir: "down", day: "Mon", action: "invert", baseWr: 60.5, baseN: 114 },
  { pair: "EUR_GBP", dir: "up", day: "Fri", action: "invert", baseWr: 60.3, baseN: 78 },
  { pair: "EUR_AUD", dir: "up", day: "Fri", action: "invert", baseWr: 60.2, baseN: 88 },
  { pair: "AUD_JPY", dir: "down", day: "Tue", action: "invert", baseWr: 60.0, baseN: 55 },
];

const MIN_N_AFTER_FILTER = 20;

type FilterResult = { desc: string; n: number; w: number; wr: number };

function evalPocket(pocket: Pocket): void {
  const base = rows.filter((r) =>
    r.instrument === pocket.pair &&
    r.direction === pocket.dir &&
    etDay(r.created_at) === pocket.day,
  );
  const wonPredicate = pocket.action === "follow"
    ? (r: Row) => r.result === "won"
    : (r: Row) => r.result === "lost"; // inverting counts losses as wins

  const wr = (sub: Row[]): number => sub.length === 0 ? 0 : 100 * sub.filter(wonPredicate).length / sub.length;
  const winsOf = (sub: Row[]) => sub.filter(wonPredicate).length;

  const candidates: FilterResult[] = [];
  const add = (desc: string, sub: Row[]) => {
    if (sub.length < MIN_N_AFTER_FILTER) return;
    candidates.push({ desc, n: sub.length, w: winsOf(sub), wr: wr(sub) });
  };

  // Confidence thresholds
  for (const thr of [0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]) {
    add(`conf>=${thr}`, base.filter((r) => r.confidence !== null && Number(r.confidence) >= thr));
  }

  // Hour precision (any single hour)
  for (let h = 0; h < 24; h++) {
    add(`hour==${h}ET`, base.filter((r) => etHour(r.created_at) === h));
  }

  // RSI buckets
  const rsiBuckets: Array<[number, number, string]> = [
    [0, 20, "RSI<20"], [20, 30, "RSI 20-30"], [30, 40, "RSI 30-40"],
    [40, 50, "RSI 40-50"], [50, 60, "RSI 50-60"], [60, 70, "RSI 60-70"],
    [70, 80, "RSI 70-80"], [80, 100, "RSI 80+"],
  ];
  for (const [lo, hi, label] of rsiBuckets) {
    add(label, base.filter((r) => {
      const rsi = r.features?.rsi as number | undefined;
      return typeof rsi === "number" && rsi >= lo && rsi < hi;
    }));
  }

  // ADX buckets
  const adxBuckets: Array<[number, number, string]> = [
    [0, 20, "ADX<20"], [20, 25, "ADX 20-25"], [25, 30, "ADX 25-30"], [30, 40, "ADX 30-40"], [40, 100, "ADX 40+"],
  ];
  for (const [lo, hi, label] of adxBuckets) {
    add(label, base.filter((r) => {
      const adx = r.features?.adx as number | undefined;
      return typeof adx === "number" && adx >= lo && adx < hi;
    }));
  }

  // Model
  const models = [...new Set(base.map((r) => r.model_name))];
  for (const m of models) add(`model=${m}`, base.filter((r) => r.model_name === m));

  // Sort by winrate desc — best improvements first
  candidates.sort((a, b) => b.wr - a.wr);

  console.log(`\n=== ${pocket.pair} / ${pocket.dir} / ${pocket.day} / ${pocket.action}  (base wr=${pocket.baseWr}% on n=${pocket.baseN}) ===`);
  // Only show TOP filters that IMPROVE over baseline
  const improvements = candidates.filter((c) => c.wr > pocket.baseWr).slice(0, 5);
  if (!improvements.length) {
    console.log(`  no improving filter found at n>=${MIN_N_AFTER_FILTER}`);
    return;
  }
  console.log(`  ${"filter".padEnd(30)}  n     W    winrate    Δ vs base`);
  for (const c of improvements) {
    const delta = c.wr - pocket.baseWr;
    console.log(`  ${c.desc.padEnd(30)}  ${String(c.n).padStart(3)}   ${String(c.w).padStart(3)}   ${c.wr.toFixed(1).padStart(5)}%    +${delta.toFixed(1)}pp`);
  }
}

console.log("=== SECOND-PASS REFINEMENT — best sub-filter per pocket ===");
for (const p of POCKETS) evalPocket(p);

process.exit(0);
