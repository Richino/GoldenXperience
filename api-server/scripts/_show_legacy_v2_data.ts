import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

// 1) batches tagged legacy-confidence-v2
const batches = await query<{
  batch_number: number; status: string; assigned_count: number; strategy_family: string | null;
  experiment_id: string | null; started_at: string; completed_at: string | null;
}>(`SELECT batch_number, status, assigned_count, strategy_family, experiment_id, started_at, completed_at
     FROM paper_strategy_batches
    WHERE strategy_family = 'legacy-confidence-v2'
    ORDER BY batch_number`);
console.log(`=== legacy-confidence-v2 BATCHES: ${batches.rows.length} ===`);
for (const b of batches.rows) {
  console.log(`  #${b.batch_number} ${b.status} assigned=${b.assigned_count} exp=${b.experiment_id ?? "—"} started=${b.started_at} completed=${b.completed_at ?? "—"}`);
}

// 2) all trades tagged legacy-confidence-v2, most recent first
const trades = await query<{
  seq: string; batch: number; instrument: string; direction: string; decision_time: string;
  entry: string; stop: string; target: string; status: string; outcome: string | null;
  result_r: string | null; paper_pl: string | null; exit_reason: string | null; closed_at: string | null;
}>(`SELECT t.trade_sequence::text AS seq, b.batch_number AS batch, t.instrument, t.direction,
          t.decision_time, t.entry::text, t.stop::text, t.target::text, t.status, t.outcome,
          t.result_r::text, t.paper_pl::text, t.exit_reason, t.closed_at
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE t.strategy_family = 'legacy-confidence-v2'
    ORDER BY t.decision_time DESC LIMIT 60`);
console.log(`\n=== legacy-confidence-v2 TRADES (up to 60 most recent): ${trades.rows.length} ===`);
console.log("seq  batch  when              pair    dir    status   outcome        R      P/L     exit_reason");
for (const t of trades.rows) {
  const when = new Date(t.decision_time).toISOString().replace("T", " ").slice(0, 16);
  const R = t.result_r === null ? "—" : ((+t.result_r >= 0 ? "+" : "") + (+t.result_r).toFixed(2));
  const pl = t.paper_pl === null ? "—" : "$" + (+t.paper_pl).toFixed(0);
  console.log(`${t.seq.padStart(3)}  ${String(t.batch).padStart(3)}    ${when}  ${t.instrument.padEnd(7)} ${t.direction.padEnd(5)} ${t.status.padEnd(8)} ${(t.outcome ?? "-").padEnd(13)} ${R.padStart(6)} ${pl.padStart(7)}  ${t.exit_reason ?? ""}`);
}

// 3) summary of the whole legacy-confidence-v2 pool
const closed = trades.rows.filter((t) => t.status === "closed" && t.result_r !== null);
const totalCount = await query<{ n: number }>(`SELECT count(*)::int AS n FROM paper_strategy_trades WHERE strategy_family = 'legacy-confidence-v2'`);
const closedCount = await query<{ n: number; wins: number; losses: number; sum_r: string; sum_pl: string }>(
  `SELECT count(*)::int AS n,
          count(*) FILTER (WHERE result_r > 0)::int AS wins,
          count(*) FILTER (WHERE result_r < 0)::int AS losses,
          COALESCE(sum(result_r), 0)::text AS sum_r,
          COALESCE(sum(paper_pl), 0)::text AS sum_pl
     FROM paper_strategy_trades WHERE strategy_family='legacy-confidence-v2' AND status='closed' AND result_r IS NOT NULL`);
const c = closedCount.rows[0]!;
console.log(`\n=== legacy-confidence-v2 SUMMARY ===`);
console.log(`  total rows: ${totalCount.rows[0]!.n}`);
console.log(`  closed+resolved: ${c.n}   W: ${c.wins}   L: ${c.losses}`);
console.log(`  winrate: ${c.n ? (100 * c.wins / c.n).toFixed(1) + "%" : "n/a"}`);
console.log(`  total R: ${Number(c.sum_r).toFixed(2)}   total P/L: $${Number(c.sum_pl).toFixed(2)}`);

// 4) check any local decision-log file
try {
  const { existsSync, readFileSync } = await import("node:fs");
  const logDir = path.join(serviceRoot, "research-v2", "legacy-confidence-v2-live-log");
  const logPath = path.join(logDir, "decisions.jsonl");
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    console.log(`\n=== local decision log: ${lines.length} entries ===`);
    console.log("(most recent 10:)");
    for (const line of lines.slice(-10)) console.log("  " + line);
  } else {
    console.log(`\n(no local decision log at ${logPath} — daemon likely running server-side, not locally)`);
  }
} catch {}

process.exit(0);
