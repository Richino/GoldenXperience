/**
 * EUR_USD-only edge survey.
 * Enumerates all reasonable slices to find where EUR_USD has real, tradeable edge.
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
  direction: string; result: string; created_at: string;
  features: Record<string, unknown> | null; confidence: string | null;
  model_name: string; strategy_source: string | null;
};
const rows = (await query<Row>(`
  SELECT direction, result, created_at::text, features, confidence::text, model_name, strategy_source
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
     AND instrument = 'EUR_USD'
`)).rows;
console.log(`EUR_USD resolved: ${rows.length}`);
console.log(`overall winrate: ${(100 * rows.filter((r) => r.result === "won").length / rows.length).toFixed(1)}%\n`);

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "weekday")?.value ?? "?";
}
function session(hour: number): string {
  if (hour >= 8 && hour < 12) return "overlap";
  if (hour >= 3 && hour < 8) return "london";
  if (hour >= 12 && hour < 17) return "ny";
  return "off";
}

type Bucket = { n: number; w: number };
function add(m: Map<string, Bucket>, key: string, won: boolean) {
  const b = m.get(key) ?? { n: 0, w: 0 };
  b.n++; if (won) b.w++;
  m.set(key, b);
}
function report(label: string, m: Map<string, Bucket>, minN: number, hi: number, lo: number) {
  const rs = [...m.entries()]
    .filter(([_, b]) => b.n >= minN)
    .map(([k, b]) => ({ key: k, n: b.n, w: b.w, wr: 100 * b.w / b.n }))
    .filter((r) => r.wr >= hi || r.wr <= lo)
    .sort((a, b) => Math.abs(b.wr - 50) - Math.abs(a.wr - 50));
  if (!rs.length) return;
  console.log(`\n=== ${label}  (n>=${minN}, wr>=${hi}% or <=${lo}%) ===`);
  for (const r of rs.slice(0, 15)) {
    const action = r.wr >= 50 ? "follow" : "INVERT";
    console.log(`  ${r.key.padEnd(46)}  n=${String(r.n).padStart(4)}  W=${String(r.w).padStart(4)}  wr=${r.wr.toFixed(1).padStart(5)}%  ${action}`);
  }
}

const byDay = new Map<string, Bucket>();
const byDir = new Map<string, Bucket>();
const byDirDay = new Map<string, Bucket>();
const bySession = new Map<string, Bucket>();
const byHour = new Map<string, Bucket>();
const byDirSession = new Map<string, Bucket>();
const byDirHour = new Map<string, Bucket>();
const byDirDayHour = new Map<string, Bucket>();
const byDirDaySession = new Map<string, Bucket>();
const byConfBucket = new Map<string, Bucket>();
const byDirConf = new Map<string, Bucket>();
const byDayConf = new Map<string, Bucket>();
const byModel = new Map<string, Bucket>();
const byModelDir = new Map<string, Bucket>();
const byModelDay = new Map<string, Bucket>();
const bySource = new Map<string, Bucket>();
const bySourceDir = new Map<string, Bucket>();

function confBucket(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "na";
  if (v < 0.55) return "0.5-0.55";
  if (v < 0.60) return "0.55-0.60";
  if (v < 0.70) return "0.60-0.70";
  if (v < 0.80) return "0.70-0.80";
  if (v < 0.90) return "0.80-0.90";
  return "0.90+";
}

for (const r of rows) {
  const won = r.result === "won";
  const hour = etHour(r.created_at);
  const day = etDay(r.created_at);
  const sess = session(hour);
  const conf = r.confidence !== null ? Number(r.confidence) : null;
  const cb = confBucket(conf);
  const src = r.strategy_source ?? (r.features?.source as string) ?? "unknown";

  add(byDay, day, won);
  add(byDir, r.direction, won);
  add(byDirDay, `${r.direction} / ${day}`, won);
  add(bySession, sess, won);
  add(byHour, `h${hour.toString().padStart(2, "0")}`, won);
  add(byDirSession, `${r.direction} / ${sess}`, won);
  add(byDirHour, `${r.direction} / h${hour.toString().padStart(2, "0")}`, won);
  add(byDirDayHour, `${r.direction} / ${day} / h${hour.toString().padStart(2, "0")}`, won);
  add(byDirDaySession, `${r.direction} / ${day} / ${sess}`, won);
  add(byConfBucket, cb, won);
  add(byDirConf, `${r.direction} / ${cb}`, won);
  add(byDayConf, `${day} / ${cb}`, won);
  add(byModel, r.model_name, won);
  add(byModelDir, `${r.model_name} / ${r.direction}`, won);
  add(byModelDay, `${r.model_name} / ${day}`, won);
  add(bySource, src, won);
  add(bySourceDir, `${src} / ${r.direction}`, won);
}

const HI = 60, LO = 40, MIN = 30;
console.log(`(Threshold: n>=${MIN}, wr>=${HI}% or <=${LO}%)`);
report("BY DAY", byDay, MIN, HI, LO);
report("BY DIRECTION", byDir, MIN, HI, LO);
report("BY DIRECTION × DAY", byDirDay, MIN, HI, LO);
report("BY SESSION", bySession, MIN, HI, LO);
report("BY HOUR", byHour, MIN, HI, LO);
report("BY DIR × SESSION", byDirSession, MIN, HI, LO);
report("BY DIR × HOUR", byDirHour, MIN, HI, LO);
report("BY DIR × DAY × HOUR", byDirDayHour, MIN, HI, LO);
report("BY DIR × DAY × SESSION", byDirDaySession, MIN, HI, LO);
report("BY CONFIDENCE BUCKET", byConfBucket, MIN, HI, LO);
report("BY DIR × CONFIDENCE", byDirConf, MIN, HI, LO);
report("BY DAY × CONFIDENCE", byDayConf, MIN, HI, LO);
report("BY MODEL", byModel, MIN, HI, LO);
report("BY MODEL × DIRECTION", byModelDir, MIN, HI, LO);
report("BY MODEL × DAY", byModelDay, MIN, HI, LO);
report("BY SOURCE", bySource, MIN, HI, LO);
report("BY SOURCE × DIRECTION", bySourceDir, MIN, HI, LO);

process.exit(0);
