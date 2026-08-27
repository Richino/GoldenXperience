/**
 * Winrate by (major pair × direction × day of week × session).
 * Answers: what pairs / directions / days have consistent 60%+ or 40%- edges?
 * RESEARCH ONLY.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const MAJORS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
  "EUR_GBP", "EUR_JPY", "AUD_JPY", "EUR_AUD", "GBP_JPY",
];

type Row = {
  instrument: string; direction: string; result: string; created_at: string;
};
const rows = (await query<Row>(`
  SELECT instrument, direction, result, created_at::text
    FROM binary_predictions
   WHERE result IN ('won', 'lost') AND direction IN ('up', 'down')
     AND instrument = ANY($1::text[])
`, [MAJORS])).rows;
console.log(`resolved trades on majors: ${rows.length}\n`);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
function etDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  return parts.find((p) => p.type === "weekday")?.value ?? "?";
}
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

// === Overall by pair × day (all directions combined) ===
console.log("=== WINRATE BY PAIR × DAY (both directions) ===");
console.log(`  pair       Mon        Tue        Wed        Thu        Fri        weekly`);
for (const p of MAJORS) {
  const line: string[] = [];
  let total = 0, totalW = 0;
  for (const d of DAYS) {
    const sub = rows.filter((r) => r.instrument === p && etDay(r.created_at) === d);
    if (sub.length < 20) { line.push(`      n=${sub.length}`.padStart(11)); continue; }
    const wins = sub.filter((r) => r.result === "won").length;
    const wr = 100 * wins / sub.length;
    line.push(`${wr.toFixed(0).padStart(3)}%(n=${sub.length})`.padStart(11));
    total += sub.length; totalW += wins;
  }
  const overall = total > 0 ? `${(100 * totalW / total).toFixed(1)}% (n=${total})` : "n=0";
  console.log(`  ${p.padEnd(10)} ${line.join("  ")}  ${overall}`);
}

// === Best follow slices ===
console.log("\n=== BEST FOLLOW SLICES (pair × direction × day, n>=30, wr>=60%) ===");
const followHits: Array<{ label: string; n: number; w: number; wr: number }> = [];
for (const p of MAJORS) {
  for (const dir of ["up", "down"] as const) {
    for (const day of DAYS) {
      const sub = rows.filter((r) => r.instrument === p && r.direction === dir && etDay(r.created_at) === day);
      if (sub.length < 30) continue;
      const wins = sub.filter((r) => r.result === "won").length;
      const wr = 100 * wins / sub.length;
      if (wr >= 60) followHits.push({ label: `${p} / ${dir} / ${day}`, n: sub.length, w: wins, wr });
    }
  }
}
followHits.sort((a, b) => b.wr - a.wr);
console.log(`  ${followHits.length} slices`);
for (const h of followHits.slice(0, 25)) {
  console.log(`  ${h.label.padEnd(30)}  n=${String(h.n).padStart(3)}  W=${String(h.w).padStart(3)}  wr=${h.wr.toFixed(1).padStart(5)}%`);
}

// === Best invert slices (winrate <= 40% → invert to 60%+) ===
console.log("\n=== BEST INVERT SLICES (pair × direction × day, n>=30, wr<=40%) ===");
const invertHits: Array<{ label: string; n: number; w: number; wr: number }> = [];
for (const p of MAJORS) {
  for (const dir of ["up", "down"] as const) {
    for (const day of DAYS) {
      const sub = rows.filter((r) => r.instrument === p && r.direction === dir && etDay(r.created_at) === day);
      if (sub.length < 30) continue;
      const wins = sub.filter((r) => r.result === "won").length;
      const wr = 100 * wins / sub.length;
      if (wr <= 40) invertHits.push({ label: `${p} / ${dir} / ${day}`, n: sub.length, w: wins, wr });
    }
  }
}
invertHits.sort((a, b) => a.wr - b.wr);
console.log(`  ${invertHits.length} slices  (invert → ${100 - invertHits[0]!.wr}% winrate)`);
for (const h of invertHits.slice(0, 25)) {
  const invertedWr = 100 - h.wr;
  console.log(`  ${h.label.padEnd(30)}  n=${String(h.n).padStart(3)}  L=${String(h.n - h.w).padStart(3)}  wr=${h.wr.toFixed(1).padStart(5)}%  → invert=${invertedWr.toFixed(1)}%`);
}

// === Combined stack: composite strategy across all pockets ===
console.log("\n=== COMPOSITE STRATEGY (all follow pockets + all invert pockets) ===");
type Pocket = { key: string; action: "follow" | "invert" };
const pockets: Pocket[] = [
  ...followHits.map((h) => ({ key: h.label, action: "follow" as const })),
  ...invertHits.map((h) => ({ key: h.label, action: "invert" as const })),
];
let totalN = 0, totalW = 0;
for (const r of rows) {
  const day = etDay(r.created_at);
  const key = `${r.instrument} / ${r.direction} / ${day}`;
  const p = pockets.find((x) => x.key === key);
  if (!p) continue;
  totalN++;
  const won = r.result === "won";
  const finalWin = p.action === "follow" ? won : !won;
  if (finalWin) totalW++;
}
const compositeWr = totalN > 0 ? 100 * totalW / totalN : 0;
console.log(`  pockets active: ${pockets.length}`);
console.log(`  total trades:   ${totalN}`);
console.log(`  wins:           ${totalW}`);
console.log(`  winrate:        ${compositeWr.toFixed(1)}%`);

// rate estimate
const mn = Math.min(...rows.map((r) => Date.parse(r.created_at)));
const mx = Math.max(...rows.map((r) => Date.parse(r.created_at)));
const spanDays = (mx - mn) / 86400e3;
const tradingDays = spanDays * (5/7);
console.log(`  ~trading days:  ${tradingDays.toFixed(1)}`);
console.log(`  trades/day:     ${(totalN / tradingDays).toFixed(1)}`);

process.exit(0);
