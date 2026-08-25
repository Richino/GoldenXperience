import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const rows = await query<{
  seq: string; instrument: string; direction: string; decision_time: string;
  entry: string; stop: string; target: string; exit: string | null;
  outcome: string; result_r: string | null; paper_pl: string | null;
  exit_reason: string | null; spread_pips: string | null; config_version: string | null;
  session: string | null; conditions: unknown; features: unknown; closed_at: string | null;
}>(
  `SELECT t.trade_sequence::text AS seq, t.instrument, t.direction, t.decision_time,
          t.entry::text, t.stop::text, t.target::text, t.exit::text,
          t.outcome, t.result_r::text, t.paper_pl::text, t.exit_reason,
          t.spread_pips::text, t.config_version, t.session, t.conditions, t.features, t.closed_at
     FROM paper_strategy_trades t
     JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE b.batch_number = 1
    ORDER BY t.trade_sequence`);

function pct(n: number, d: number) { return d ? (100 * n / d).toFixed(0) + "%" : "0%"; }

console.log(`Batch 1: ${rows.rows.length} trades\n`);

// One-line per trade
console.log("seq  when                pair    dir    entry     stop     target    R      P/L        exit_reason");
for (const r of rows.rows) {
  const when = new Date(r.decision_time).toISOString().replace("T", " ").slice(0, 16);
  const R = r.result_r === null ? "—" : ((+r.result_r >= 0 ? "+" : "") + (+r.result_r).toFixed(2));
  const pl = r.paper_pl === null ? "—" : "$" + (+r.paper_pl).toFixed(0);
  console.log(
    `${r.seq.padStart(3)}  ${when}  ${r.instrument.padEnd(7)} ${r.direction.padEnd(5)} ${Number(r.entry).toFixed(5).padStart(9)} ${Number(r.stop).toFixed(5).padStart(9)} ${Number(r.target).toFixed(5).padStart(9)} ${R.padStart(6)} ${pl.padStart(8)}  ${r.exit_reason ?? r.outcome}`,
  );
}

// Direction split
let longs = 0, shorts = 0, longW = 0, shortW = 0;
for (const r of rows.rows) {
  if (r.direction === "long") { longs++; if (r.result_r && +r.result_r > 0) longW++; }
  else { shorts++; if (r.result_r && +r.result_r > 0) shortW++; }
}
console.log(`\nDirection split: longs=${longs} (${longW}W, ${pct(longW, longs)}), shorts=${shorts} (${shortW}W, ${pct(shortW, shorts)})`);

// Per-pair
const byPair = new Map<string, { n: number; w: number; r: number }>();
for (const r of rows.rows) {
  const p = byPair.get(r.instrument) ?? { n: 0, w: 0, r: 0 };
  p.n++; p.r += r.result_r ? +r.result_r : 0;
  if (r.result_r && +r.result_r > 0) p.w++;
  byPair.set(r.instrument, p);
}
console.log("\nBy pair:");
for (const [pair, s] of byPair) console.log(`  ${pair}: ${s.n} trades, ${s.w}W (${pct(s.w, s.n)}), totalR=${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}`);

// Session distribution
const bySession = new Map<string, { n: number; w: number; r: number }>();
for (const r of rows.rows) {
  const s = r.session ?? "(none)";
  const cur = bySession.get(s) ?? { n: 0, w: 0, r: 0 };
  cur.n++; cur.r += r.result_r ? +r.result_r : 0;
  if (r.result_r && +r.result_r > 0) cur.w++;
  bySession.set(s, cur);
}
console.log("\nBy session:");
for (const [s, v] of bySession) console.log(`  ${s}: ${v.n} trades, ${v.w}W (${pct(v.w, v.n)}), totalR=${v.r >= 0 ? "+" : ""}${v.r.toFixed(2)}`);

// Config version
const byCfg = new Map<string, number>();
for (const r of rows.rows) byCfg.set(r.config_version ?? "(none)", (byCfg.get(r.config_version ?? "(none)") ?? 0) + 1);
console.log("\nConfig versions used:", [...byCfg.entries()].map(([k, v]) => `${k}(${v})`).join(", "));

// Show first trade's conditions/features (they should reveal what setup fired)
if (rows.rows[0]) {
  console.log("\nFirst trade conditions/features (representative):");
  console.log(" conditions:", JSON.stringify(rows.rows[0].conditions));
  console.log(" features:  ", JSON.stringify(rows.rows[0].features));
}

process.exit(0);
