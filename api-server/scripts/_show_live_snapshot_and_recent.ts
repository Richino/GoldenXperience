import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

// Current snapshot: latest paper_watch_snapshots row per pair
const snap = await query<{
  instrument: string; evaluated_at: string; setup_status: string; direction: string | null;
  spread_pips: string | null; session: string | null; entry: string | null; stop: string | null; target: string | null;
  conditions: unknown;
}>(`WITH latest AS (
      SELECT DISTINCT ON (instrument) *
        FROM paper_watch_snapshots
       ORDER BY instrument, evaluated_at DESC)
    SELECT instrument, evaluated_at, setup_status, direction, spread_pips::text, session, entry::text, stop::text, target::text, conditions
      FROM latest ORDER BY instrument`);

console.log(`=== CURRENT 15-MIN SNAPSHOT (${snap.rows.length} pairs) ===`);
console.log(`evaluated_at (most recent per pair):`);
const groupTime = snap.rows[0]?.evaluated_at ?? "n/a";
console.log(`  ${groupTime}`);
console.log(`pair       status     dir     spread  session                   entry / stop / target`);
for (const r of snap.rows) {
  const eSt = [r.entry, r.stop, r.target].filter(Boolean).length === 3 ? `${r.entry} / ${r.stop} / ${r.target}` : "-";
  console.log(`  ${r.instrument.padEnd(8)} ${r.setup_status.padEnd(10)} ${(r.direction ?? "-").padEnd(6)} ${(r.spread_pips ?? "-").padStart(5)}  ${(r.session ?? "-").padEnd(22)}  ${eSt}`);
}

// Summarize which required gates are failing across pairs, from the conditions JSON
console.log(`\n=== FAILED REQUIRED GATES across current pairs ===`);
const failures: Record<string, number> = {};
for (const r of snap.rows) {
  const cs = Array.isArray(r.conditions) ? r.conditions as Array<{ name: string; passed: boolean; required: boolean }> : [];
  for (const c of cs) {
    if (c.required && !c.passed) failures[c.name] = (failures[c.name] ?? 0) + 1;
  }
}
for (const [name, count] of Object.entries(failures).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(30)}  fails on ${count}/${snap.rows.length} pairs`);
}

// Recent evaluations activity (last 24h, grouped by family + status)
console.log(`\n=== paper_strategy_evaluations activity by family (last 24h) ===`);
const evalByFam = await query<{ strategy_family: string | null; setup_status: string; n: string; latest: string | null }>(
  `SELECT strategy_family, setup_status, count(*)::text AS n, max(decision_time)::text AS latest
     FROM paper_strategy_evaluations
    WHERE decision_time > now() - interval '24 hours'
    GROUP BY strategy_family, setup_status
    ORDER BY strategy_family, setup_status`);
for (const r of evalByFam.rows) {
  console.log(`  ${(r.strategy_family ?? "(null)").padEnd(20)} ${r.setup_status.padEnd(14)} rows=${String(r.n).padStart(5)}  latest=${r.latest ?? "-"}`);
}

// Recent trades — last 24h
console.log(`\n=== paper_strategy_trades opened in last 24h ===`);
const recent = await query<{ seq: string; batch: string; family: string | null; instrument: string; direction: string; decision_time: string; status: string; outcome: string | null; result_r: string | null; paper_pl: string | null; exit_reason: string | null }>(
  `SELECT t.trade_sequence::text AS seq, b.batch_number::text AS batch, t.strategy_family AS family,
          t.instrument, t.direction, t.decision_time, t.status, t.outcome,
          t.result_r::text, t.paper_pl::text, t.exit_reason
     FROM paper_strategy_trades t JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE t.decision_time > now() - interval '24 hours'
    ORDER BY t.decision_time DESC`);
console.log("seq  batch  family        when              pair    dir    status   outcome        R       exit_reason");
for (const r of recent.rows) {
  const when = new Date(r.decision_time).toISOString().replace("T", " ").slice(0, 16);
  const R = r.result_r === null ? "—" : ((+r.result_r >= 0 ? "+" : "") + (+r.result_r).toFixed(2));
  console.log(`${r.seq.padStart(3)}  ${r.batch.padStart(3)}   ${(r.family ?? "-").padEnd(12)}  ${when}  ${r.instrument.padEnd(7)} ${r.direction.padEnd(5)} ${r.status.padEnd(8)} ${(r.outcome ?? "-").padEnd(13)} ${R.padStart(6)}  ${r.exit_reason ?? ""}`);
}

// batch composition (latest 5 batches)
console.log(`\n=== latest batches (top 5, most recent first) ===`);
const b = await query<{ batch_number: number; status: string; assigned_count: number; strategy_family: string | null; started_at: string; completed_at: string | null }>(
  `SELECT batch_number, status, assigned_count, strategy_family, started_at, completed_at
     FROM paper_strategy_batches ORDER BY batch_number DESC LIMIT 5`);
for (const r of b.rows) {
  console.log(`  #${r.batch_number} ${r.status} assigned=${r.assigned_count} family=${r.strategy_family ?? "-"} started=${r.started_at} completed=${r.completed_at ?? "-"}`);
}

process.exit(0);
