/**
 * Query recent legacy_confidence_v2_evaluations rows.
 * Usage: npx tsx scripts/_show_v2_audit_trail.ts [--hours N] [--pair X]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const args = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
}
const hours = Number(argVal("--hours") ?? "24");
const pairFilter = argVal("--pair");

console.log(`\n=== legacy_confidence_v2_evaluations — last ${hours}h${pairFilter ? ` for ${pairFilter}` : ""} ===\n`);

const params: unknown[] = [hours];
let where = `evaluated_at > now() - ($1 || ' hours')::interval`;
if (pairFilter) { params.push(pairFilter); where += ` AND instrument = $${params.length}`; }

const summary = await query<{ total: string; passed: string; dry_run_only: string; trades_opened: string; distinct_cycles: string }>(
  `SELECT count(*)::text AS total,
          count(*) FILTER (WHERE setup_passed)::text AS passed,
          count(*) FILTER (WHERE dry_run AND setup_passed)::text AS dry_run_only,
          count(*) FILTER (WHERE trade_id IS NOT NULL)::text AS trades_opened,
          count(DISTINCT cycle_id)::text AS distinct_cycles
     FROM legacy_confidence_v2_evaluations WHERE ${where}`, params);
const s = summary.rows[0]!;
console.log(`  cycles: ${s.distinct_cycles}   rows: ${s.total}   setups passed: ${s.passed}   trades opened: ${s.trades_opened}`);
if (Number(s.total) === 0) {
  console.log("  (no rows — daemon has not been enabled yet, or nothing in this window)");
  process.exit(0);
}

console.log(`\n--- REJECT REASONS by frequency ---`);
const reasons = await query<{ reject_reason: string; n: string; pairs: string }>(
  `SELECT reject_reason, count(*)::text AS n, string_agg(DISTINCT instrument, ',' ORDER BY instrument) AS pairs
     FROM legacy_confidence_v2_evaluations
    WHERE ${where} AND setup_passed = false
    GROUP BY reject_reason ORDER BY count(*) DESC`, params);
for (const r of reasons.rows) console.log(`  ${String(r.n).padStart(5)}  ${r.reject_reason ?? "(null)"}  [${r.pairs}]`);

console.log(`\n--- SETUPS THAT FIRED (setup_passed=true) ---`);
const fired = await query<{
  evaluated_at: string; instrument: string; direction: string; p_long: string | null;
  decision_action: string | null; executed_direction: string | null; inverted: boolean | null;
  entry: string | null; stop: string | null; target: string | null; risk_pips: string | null;
  trade_id: string | null; dry_run: boolean; error_message: string | null;
}>(
  `SELECT evaluated_at::text, instrument, direction, p_long::text,
          decision_action, executed_direction, inverted,
          entry::text, stop::text, target::text, risk_pips::text,
          trade_id::text, dry_run, error_message
     FROM legacy_confidence_v2_evaluations
    WHERE ${where} AND setup_passed = true
    ORDER BY evaluated_at DESC LIMIT 60`, params);
if (fired.rows.length === 0) console.log("  (none)");
else {
  console.log("  when                   pair     baselineDir  pLong   action              exec  inv?  trade?     dry?");
  for (const r of fired.rows) {
    const when = r.evaluated_at.slice(0, 19);
    const p = r.p_long !== null ? Number(r.p_long).toFixed(3) : "  -  ";
    const trade = r.trade_id ? r.trade_id.slice(0, 8) : (r.error_message ? "err" : "-");
    console.log(`  ${when}  ${r.instrument.padEnd(8)} ${(r.direction ?? "-").padEnd(11)} ${p}  ${(r.decision_action ?? "-").padEnd(18)} ${(r.executed_direction ?? "-").padEnd(5)} ${(r.inverted ? "yes" : "no ").padEnd(4)} ${trade.padEnd(10)} ${r.dry_run ? "yes" : "no"}`);
  }
}

console.log(`\n--- CYCLES (most recent 5) with per-pair reject-reason ---`);
const recentCycles = await query<{ cycle_id: string; n: string }>(
  `SELECT cycle_id, count(*)::text AS n FROM legacy_confidence_v2_evaluations
    WHERE ${where}
    GROUP BY cycle_id ORDER BY cycle_id DESC LIMIT 5`, params);
for (const c of recentCycles.rows) {
  console.log(`\n  cycle ${c.cycle_id.slice(0, 19)}Z  (${c.n} pairs)`);
  const pairs = await query<{ instrument: string; setup_passed: boolean; reject_reason: string | null; decision_action: string | null }>(
    `SELECT instrument, setup_passed, reject_reason, decision_action
       FROM legacy_confidence_v2_evaluations
      WHERE cycle_id = $1
      ORDER BY instrument`, [c.cycle_id]);
  for (const p of pairs.rows) {
    const status = p.setup_passed ? `PASSED → ${p.decision_action ?? "-"}` : `blocked: ${p.reject_reason ?? "(null)"}`;
    console.log(`    ${p.instrument.padEnd(8)} ${status}`);
  }
}

process.exit(0);
