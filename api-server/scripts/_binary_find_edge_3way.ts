/**
 * Deep 3-way combinatorial search for edge pockets in binary predictions.
 * Enumerates all triples of feature dimensions, computes winrate per triple,
 * filters to n >= MIN_N and winrate outside [LO, HI].
 * RESEARCH ONLY — read-only DB query.
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
  model_name: string;
};
const rows = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text, features, strategy_source, model_name
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
`)).rows;
console.log(`resolved trades: ${rows.length}`);

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

// Extract dimensions per row
type Dims = {
  source: string; model: string; instrument: string; direction: string;
  session: string; branch: string; adx: string; rsi: string;
  hourBucket: string; // rough 4h bucket
};

const dimData: Array<{ d: Dims; won: boolean }> = rows.map((r) => {
  const hour = etHour(r.created_at);
  const source = r.strategy_source ?? (r.features?.source as string) ?? "unknown";
  const branch = (r.features?.branch as string) ?? "none";
  const adx = (r.features?.adxBucket as string) ?? "none";
  const rsi = (r.features?.rsiSeverity as string) ?? "none";
  return {
    d: {
      source, model: r.model_name, instrument: r.instrument, direction: r.direction,
      session: sessionOf(hour),
      branch, adx, rsi,
      hourBucket: `${Math.floor(hour / 4) * 4}h`,
    },
    won: r.result === "won",
  };
});

const DIMS = ["source", "model", "instrument", "direction", "session", "branch", "adx", "rsi", "hourBucket"] as const;
type DimKey = typeof DIMS[number];

const MIN_N = Number(process.env.MIN_N ?? "100");
const HI = Number(process.env.HI ?? "65");
const LO = Number(process.env.LO ?? "35");

type Hit = { keys: [DimKey, DimKey, DimKey]; values: [string, string, string]; n: number; w: number; wr: number };
const hits: Hit[] = [];

for (let i = 0; i < DIMS.length; i++) {
  for (let j = i + 1; j < DIMS.length; j++) {
    for (let k = j + 1; k < DIMS.length; k++) {
      const [dA, dB, dC] = [DIMS[i]!, DIMS[j]!, DIMS[k]!];
      const map = new Map<string, { n: number; w: number; vA: string; vB: string; vC: string }>();
      for (const row of dimData) {
        const vA = row.d[dA];
        const vB = row.d[dB];
        const vC = row.d[dC];
        if (vA === "none" || vB === "none" || vC === "none") continue;
        const key = `${vA}|${vB}|${vC}`;
        const b = map.get(key) ?? { n: 0, w: 0, vA, vB, vC };
        b.n++; if (row.won) b.w++;
        map.set(key, b);
      }
      for (const b of map.values()) {
        if (b.n < MIN_N) continue;
        const wr = 100 * b.w / b.n;
        if (wr >= HI || wr <= LO) {
          hits.push({ keys: [dA, dB, dC], values: [b.vA, b.vB, b.vC], n: b.n, w: b.w, wr });
        }
      }
    }
  }
}

hits.sort((a, b) => Math.abs(b.wr - 50) - Math.abs(a.wr - 50));

console.log(`\n=== 3-way pockets  (n >= ${MIN_N}, wr >= ${HI}% or <= ${LO}%) ===`);
console.log(`  ${hits.length} slice(s) found`);
if (hits.length) {
  console.log(`  ${"keys".padEnd(40)}  ${"values".padEnd(45)}   n     W    winrate  action`);
  for (const h of hits.slice(0, 40)) {
    const keyStr = `${h.keys[0]}/${h.keys[1]}/${h.keys[2]}`;
    const valStr = `${h.values[0]}|${h.values[1]}|${h.values[2]}`;
    const action = h.wr >= 50 ? "follow" : "INVERT";
    console.log(`  ${keyStr.padEnd(40)}  ${valStr.padEnd(45)}   ${String(h.n).padStart(4)}  ${String(h.w).padStart(4)}  ${h.wr.toFixed(1).padStart(5)}%  ${action}`);
  }
}

process.exit(0);
