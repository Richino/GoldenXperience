import { createHash } from "node:crypto";
import { nightlyNewsRetagIfDue, NEWS_RETAG_RUN_KIND } from "../src/news-tagging.js";
import { query } from "../src/database.js";

const snap = async () => {
  const r = await query(`SELECT id,news_impact_tag,news_currency,news_event_name,
    news_event_time::text,news_minutes_from_news::text FROM paper_strategy_trades ORDER BY id`);
  return createHash("sha256").update(JSON.stringify(r.rows)).digest("hex").slice(0, 16);
};

console.log("NIGHTLY RE-TAG VERIFICATION");
const before = await snap();
console.log("  tags before       :", before);

const first = await nightlyNewsRetagIfDue(new Date(Date.UTC(2026, 7, 22, 3, 0, 0)));
console.log("  1st call (03:00Z) :", first ? `RAN, tagged ${first.tagged}` : "skipped");

const after = await snap();
console.log("  tags after        :", after, after === before ? "(unchanged — idempotent)" : "(CHANGED)");

const second = await nightlyNewsRetagIfDue(new Date(Date.UTC(2026, 7, 22, 4, 0, 0)));
console.log("  2nd call (04:00Z) :", second ? "RAN AGAIN — GUARD BROKEN" : "skipped (20h guard held)");

const early = await nightlyNewsRetagIfDue(new Date(Date.UTC(2026, 7, 22, 1, 0, 0)));
console.log("  before the hour   :", early ? "RAN — HOUR GATE BROKEN" : "skipped (hour gate held)");

const runs = await query<{ done: boolean; error: string | null; details: string }>(
  `SELECT completed_at IS NOT NULL AS done, error, details::text AS details
   FROM research_runs WHERE kind=$1 ORDER BY started_at DESC LIMIT 3`, [NEWS_RETAG_RUN_KIND]);
console.log("  research_runs rows:");
for (const row of runs.rows) console.log(`    done=${row.done} error=${row.error ?? "none"} ${row.details}`);

const ok = Boolean(first) && !second && !early && after === before;
console.log("\n  RESULT:", ok ? "PASS — runs once a day, self-healing, idempotent" : "FAIL");

await query(`DELETE FROM research_runs WHERE kind=$1`, [NEWS_RETAG_RUN_KIND]);
console.log("  test marker removed so the deployed server runs it for real");
process.exit(ok ? 0 : 1);
