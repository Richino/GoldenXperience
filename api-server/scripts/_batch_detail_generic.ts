import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const { query } = await import("../src/database.js");

const BATCH = Number(process.env.BATCH ?? "2");

const rows = await query<{
  seq: string; instrument: string; direction: string; decision_time: string;
  entry: string; stop: string; target: string; exit: string | null;
  outcome: string; result_r: string | null; paper_pl: string | null;
  exit_reason: string | null; session: string | null; config_version: string | null;
}>(
  `SELECT t.trade_sequence::text AS seq, t.instrument, t.direction, t.decision_time,
          t.entry::text, t.stop::text, t.target::text, t.exit::text,
          t.outcome, t.result_r::text, t.paper_pl::text, t.exit_reason,
          t.session, t.config_version
     FROM paper_strategy_trades t
     JOIN paper_strategy_batches b ON b.id = t.batch_id
    WHERE b.batch_number = $1
    ORDER BY t.trade_sequence`, [BATCH]);

function pct(n: number, d: number) { return d ? (100 * n / d).toFixed(0) + "%" : "0%"; }

console.log(`Batch ${BATCH}: ${rows.rows.length} trades\n`);

console.log("seq  when                pair    dir    entry     stop     target    R      P/L        exit_reason");
let wins = 0, losses = 0, winPL = 0, lossPL = 0, totalR = 0, unresolved = 0;
for (const r of rows.rows) {
  const when = new Date(r.decision_time).toISOString().replace("T", " ").slice(0, 16);
  const rr = r.result_r === null ? null : +r.result_r;
  const R = rr === null ? "—" : ((rr >= 0 ? "+" : "") + rr.toFixed(2));
  const pl = r.paper_pl === null ? null : +r.paper_pl;
  const plStr = pl === null ? "—" : "$" + pl.toFixed(0);
  console.log(
    `${r.seq.padStart(3)}  ${when}  ${r.instrument.padEnd(7)} ${r.direction.padEnd(5)} ${Number(r.entry).toFixed(5).padStart(9)} ${Number(r.stop).toFixed(5).padStart(9)} ${Number(r.target).toFixed(5).padStart(9)} ${R.padStart(6)} ${plStr.padStart(8)}  ${r.exit_reason ?? r.outcome}`,
  );
  if (rr !== null) totalR += rr; else unresolved++;
  if (pl !== null) {
    if (pl > 0) { wins++; winPL += pl; }
    else if (pl < 0) { losses++; lossPL += pl; }
  }
}

console.log(`\nWins:   ${wins}  total $${winPL.toFixed(0)}`);
console.log(`Losses: ${losses}  total $${lossPL.toFixed(0)}`);
console.log(`Net:    $${(winPL + lossPL).toFixed(0)}   totalR: ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}   (unresolved: ${unresolved})`);

let longs = 0, shorts = 0, longW = 0, shortW = 0;
for (const r of rows.rows) {
  if (r.direction === "long") { longs++; if (r.result_r && +r.result_r > 0) longW++; }
  else { shorts++; if (r.result_r && +r.result_r > 0) shortW++; }
}
console.log(`\nDirection: longs=${longs} (${longW}W, ${pct(longW, longs)}), shorts=${shorts} (${shortW}W, ${pct(shortW, shorts)})`);

const byPair = new Map<string, { n: number; w: number; r: number }>();
for (const r of rows.rows) {
  const p = byPair.get(r.instrument) ?? { n: 0, w: 0, r: 0 };
  p.n++; p.r += r.result_r ? +r.result_r : 0;
  if (r.result_r && +r.result_r > 0) p.w++;
  byPair.set(r.instrument, p);
}
console.log("\nBy pair:");
for (const [pair, s] of byPair) console.log(`  ${pair}: ${s.n} trades, ${s.w}W (${pct(s.w, s.n)}), totalR=${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}`);

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

const cfg = new Map<string, number>();
for (const r of rows.rows) cfg.set(r.config_version ?? "(none)", (cfg.get(r.config_version ?? "(none)") ?? 0) + 1);
console.log("\nConfig versions:", [...cfg.entries()].map(([k, v]) => `${k}(${v})`).join(", "));

process.exit(0);
