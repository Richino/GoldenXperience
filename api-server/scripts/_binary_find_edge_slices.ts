/**
 * Find pockets of edge in binary predictions.
 * Scans multiple slice dimensions and reports slices with:
 *   - n >= 200 (well above the 100-trade "samples lie" floor)
 *   - winrate >= 65% OR winrate <= 35%  (either direction useful; the low
 *     end is a "always invert this slice" signal)
 *
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
  id: string; model_name: string; instrument: string; direction: string;
  result: string; created_at: string; features: Record<string, unknown> | null;
  market_context: Record<string, unknown> | null; strategy_source: string | null;
  confidence: string | null; is_shadow: boolean; is_authoritative: boolean;
};

const rows = (await query<Row>(`
  SELECT id, model_name, instrument, direction, result, created_at::text,
         features, market_context, strategy_source, confidence::text, is_shadow, is_authoritative
    FROM binary_predictions
   WHERE result IN ('won', 'lost')
     AND direction IN ('up', 'down')
   ORDER BY created_at
`)).rows;

console.log(`resolved trades: ${rows.length}`);
const shadow = rows.filter((r) => r.is_shadow).length;
const auth = rows.filter((r) => r.is_authoritative).length;
console.log(`  shadow=${shadow}  authoritative=${auth}\n`);

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function sessionOf(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}

type Bucket = { n: number; w: number };
const noop: Bucket = { n: 0, w: 0 };
function add(m: Map<string, Bucket>, key: string, won: boolean) {
  const b = m.get(key) ?? { n: 0, w: 0 };
  b.n++; if (won) b.w++;
  m.set(key, b);
}
function report(label: string, m: Map<string, Bucket>, minN: number, hiThresh: number, loThresh: number) {
  const rows = [...m.entries()]
    .filter(([_, b]) => b.n >= minN)
    .map(([k, b]) => ({ key: k, n: b.n, w: b.w, wr: 100 * b.w / b.n }))
    .filter((r) => r.wr >= hiThresh || r.wr <= loThresh)
    .sort((a, b) => Math.abs(b.wr - 50) - Math.abs(a.wr - 50));
  if (!rows.length) return;
  console.log(`\n=== ${label}  (n>=${minN}, wr>=${hiThresh}% or <=${loThresh}%) ===`);
  console.log(`  slice                                              n     W    winrate  edge`);
  for (const r of rows.slice(0, 20)) {
    const edge = r.wr - 50;
    const direction = r.wr >= 50 ? "follow" : "invert";
    console.log(`  ${r.key.padEnd(50)} ${String(r.n).padStart(5)}  ${String(r.w).padStart(4)}  ${r.wr.toFixed(1).padStart(5)}%   ${direction} +${Math.abs(edge).toFixed(1)}pp`);
  }
}

// Baseline
const overall = new Map<string, Bucket>();
for (const r of rows) add(overall, "all", r.result === "won");
report("OVERALL", overall, 0, 0, 100);
console.log();

const MIN_N = Number(process.env.MIN_N ?? "200");
const HI = Number(process.env.HI ?? "55");
const LO = Number(process.env.LO ?? "45");

const byModel = new Map<string, Bucket>();
const byInstrument = new Map<string, Bucket>();
const byInstrumentDir = new Map<string, Bucket>();
const bySource = new Map<string, Bucket>();
const bySession = new Map<string, Bucket>();
const byHour = new Map<string, Bucket>();
const byDay = new Map<string, Bucket>();
const byModelInstrument = new Map<string, Bucket>();
const bySourceDirection = new Map<string, Bucket>();
const bySourceInstrument = new Map<string, Bucket>();
const bySourceSession = new Map<string, Bucket>();
const byBranch = new Map<string, Bucket>();
const byAdxBucket = new Map<string, Bucket>();
const byRsiSeverity = new Map<string, Bucket>();
const bySourceBranch = new Map<string, Bucket>();
const byModelSession = new Map<string, Bucket>();
const bySourceHour = new Map<string, Bucket>();

for (const r of rows) {
  const won = r.result === "won";
  const hour = etHour(r.created_at);
  const day = etDay(r.created_at);
  const session = sessionOf(hour);
  const source = r.strategy_source ?? (r.features?.source as string) ?? "unknown";
  const branch = (r.features?.branch as string) ?? "n/a";
  const adx = (r.features?.adxBucket as string) ?? "n/a";
  const rsi = (r.features?.rsiSeverity as string) ?? "n/a";

  add(byModel, r.model_name, won);
  add(byInstrument, r.instrument, won);
  add(byInstrumentDir, `${r.instrument} / ${r.direction}`, won);
  add(bySource, source, won);
  add(bySession, session, won);
  add(byHour, `hour${hour.toString().padStart(2, "0")} ET`, won);
  add(byDay, `day${day} ${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][day]}`, won);
  add(byModelInstrument, `${r.model_name} @ ${r.instrument}`, won);
  add(bySourceDirection, `${source} ${r.direction}`, won);
  add(bySourceInstrument, `${source} @ ${r.instrument}`, won);
  add(bySourceSession, `${source} in ${session}`, won);
  add(byBranch, branch, won);
  add(byAdxBucket, `adx=${adx}`, won);
  add(byRsiSeverity, `rsi=${rsi}`, won);
  add(bySourceBranch, `${source} / ${branch}`, won);
  add(byModelSession, `${r.model_name} in ${session}`, won);
  add(bySourceHour, `${source} @ hour${hour.toString().padStart(2, "0")}`, won);
}

report("BY MODEL", byModel, MIN_N, HI, LO);
report("BY INSTRUMENT", byInstrument, MIN_N, HI, LO);
report("BY INSTRUMENT × DIRECTION", byInstrumentDir, MIN_N, HI, LO);
report("BY STRATEGY SOURCE", bySource, MIN_N, HI, LO);
report("BY SESSION", bySession, MIN_N, HI, LO);
report("BY HOUR", byHour, MIN_N, HI, LO);
report("BY DAY OF WEEK", byDay, MIN_N, HI, LO);
report("BY MODEL × INSTRUMENT", byModelInstrument, MIN_N, HI, LO);
report("BY SOURCE × DIRECTION", bySourceDirection, MIN_N, HI, LO);
report("BY SOURCE × INSTRUMENT", bySourceInstrument, MIN_N, HI, LO);
report("BY SOURCE × SESSION", bySourceSession, MIN_N, HI, LO);
report("BY BRANCH", byBranch, MIN_N, HI, LO);
report("BY ADX BUCKET", byAdxBucket, MIN_N, HI, LO);
report("BY RSI SEVERITY", byRsiSeverity, MIN_N, HI, LO);
report("BY SOURCE × BRANCH", bySourceBranch, MIN_N, HI, LO);
report("BY MODEL × SESSION", byModelSession, MIN_N, HI, LO);
report("BY SOURCE × HOUR", bySourceHour, MIN_N, HI, LO);

process.exit(0);
