import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const batches = await query<{
  id: string;
  batch_number: number;
  status: string;
  assigned_count: number;
  started_at: string;
  completed_at: string | null;
  summary: unknown;
  recommendation: string | null;
  decision: string | null;
}>(`SELECT id, batch_number, status, assigned_count, started_at, completed_at, summary, recommendation, decision
     FROM paper_strategy_batches ORDER BY batch_number DESC LIMIT 8`);

console.log("=== RECENT BATCHES ===");
for (const b of batches.rows) {
  console.log(`  #${b.batch_number} ${b.status} assigned=${b.assigned_count} started=${b.started_at} completed=${b.completed_at ?? "—"} decision=${b.decision ?? "—"}`);
}

async function summarizeBatch(batchId: string, batchNumber: number, status: string) {
  const trades = await query<{
    instrument: string;
    direction: string;
    status: string;
    outcome: string | null;
    result_r: number | null;
    paper_pl: number | null;
    strategy_family: string | null;
  }>(
    `SELECT instrument, direction, status, outcome, result_r::float, paper_pl::float, strategy_family
       FROM paper_strategy_trades WHERE batch_id=$1 ORDER BY trade_sequence`,
    [batchId],
  );
  const closed = trades.rows.filter((t) => t.status === "closed");
  const open = trades.rows.filter((t) => t.status === "open");
  const wins = closed.filter((t) => (t.result_r ?? 0) > 0);
  const losses = closed.filter((t) => (t.result_r ?? 0) < 0);
  const netR = closed.reduce((s, t) => s + (t.result_r ?? 0), 0);
  const netPl = closed.reduce((s, t) => s + (t.paper_pl ?? 0), 0);
  const winR = wins.reduce((s, t) => s + (t.result_r ?? 0), 0);
  const lossR = losses.reduce((s, t) => s + (t.result_r ?? 0), 0);
  console.log(`\n=== BATCH #${batchNumber} (${status}) ===`);
  console.log(`Closed: ${closed.length} | Open: ${open.length} | Wins: ${wins.length} | Losses: ${losses.length}`);
  console.log(`Won: +${winR.toFixed(2)} R | Lost: ${lossR.toFixed(2)} R | NET: ${netR >= 0 ? "+" : ""}${netR.toFixed(2)} R ($${netPl.toFixed(2)})`);
}

// Summarize all in-progress "new" batches (5+)
for (const b of batches.rows.filter((x) => x.batch_number >= 5)) {
  await summarizeBatch(b.id, b.batch_number, b.status);
}

const latest = batches.rows[0];
if (!latest) {
  console.log("No batches found.");
  process.exit(0);
}

// Detailed breakdown for latest batch only
const trades = await query<{
  instrument: string;
  direction: string;
  status: string;
  outcome: string | null;
  result_r: number | null;
  paper_pl: number | null;
  strategy_family: string | null;
  exit_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}>(
  `SELECT instrument, direction, status, outcome, result_r::float, paper_pl::float,
          strategy_family, exit_reason, opened_at, closed_at
     FROM paper_strategy_trades WHERE batch_id=$1 ORDER BY trade_sequence`,
  [latest.id],
);

const closed = trades.rows.filter((t) => t.status === "closed");
const open = trades.rows.filter((t) => t.status === "open");
const wins = closed.filter((t) => (t.result_r ?? 0) > 0);
const losses = closed.filter((t) => (t.result_r ?? 0) < 0);
const flat = closed.filter((t) => (t.result_r ?? 0) === 0);
const netR = closed.reduce((s, t) => s + (t.result_r ?? 0), 0);
const winR = wins.reduce((s, t) => s + (t.result_r ?? 0), 0);
const lossR = losses.reduce((s, t) => s + (t.result_r ?? 0), 0);
const netPl = closed.reduce((s, t) => s + (t.paper_pl ?? 0), 0);
const winPl = wins.reduce((s, t) => s + (t.paper_pl ?? 0), 0);
const lossPl = losses.reduce((s, t) => s + (t.paper_pl ?? 0), 0);

console.log(`\n=== BATCH #${latest.batch_number} (${latest.status}) ===`);
console.log(`Closed: ${closed.length} | Open: ${open.length}`);
console.log(`Wins: ${wins.length} (+${winR.toFixed(2)} R, $${winPl.toFixed(2)} paper P/L)`);
console.log(`Losses: ${losses.length} (${lossR.toFixed(2)} R, $${lossPl.toFixed(2)} paper P/L)`);
if (flat.length) console.log(`Flat: ${flat.length}`);
console.log(`NET: ${netR >= 0 ? "+" : ""}${netR.toFixed(2)} R | $${netPl.toFixed(2)} paper P/L`);

console.log("\n--- Closed trades ---");
for (const t of closed) {
  const r = t.result_r ?? 0;
  const pl = t.paper_pl ?? 0;
  const tag = r > 0 ? "WIN" : r < 0 ? "LOSS" : "FLAT";
  console.log(`  ${tag} ${t.instrument} ${t.direction} [${t.strategy_family ?? "?"}] ${r >= 0 ? "+" : ""}${r.toFixed(2)}R $${pl.toFixed(2)} (${t.outcome})`);
}

if (open.length) {
  console.log("\n--- Still open ---");
  for (const t of open) {
    console.log(`  OPEN ${t.instrument} ${t.direction} [${t.strategy_family ?? "?"}] since ${t.opened_at}`);
  }
}

const byFam = new Map<string, { w: number; l: number; netR: number; netPl: number }>();
for (const t of closed) {
  const f = t.strategy_family ?? "legacy";
  const cur = byFam.get(f) ?? { w: 0, l: 0, netR: 0, netPl: 0 };
  const r = t.result_r ?? 0;
  if (r > 0) cur.w++;
  else if (r < 0) cur.l++;
  cur.netR += r;
  cur.netPl += t.paper_pl ?? 0;
  byFam.set(f, cur);
}
console.log("\n--- By strategy ---");
for (const [f, s] of byFam) {
  console.log(`  ${f}: ${s.w}W/${s.l}L net ${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(2)}R ($${s.netPl.toFixed(2)})`);
}

process.exit(0);
