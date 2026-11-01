import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
config({ path: ".env", quiet: true }); config({ path: ".env.local", override: true, quiet: true });
const { db, query } = await import("../src/database.js");
const { projectRiskReporting } = await import("../src/risk-reporting.js");
const { journalTradeLog } = await import("../src/paper-cycle.js");
try {
  const rows = await query(`SELECT id::text,user_id::text,opened_at AS "openedAt",closed_at AS "closedAt",result_r::float AS "resultR",paper_pl::float AS "paperPl",pair,status
    FROM paper_trades
    UNION ALL SELECT id::text,user_id::text,opened_at AS "openedAt",closed_at AS "closedAt",result_r::float AS "resultR",paper_pl::float AS "paperPl",instrument AS pair,status FROM paper_strategy_trades ORDER BY "openedAt"`);
  const fingerprint = async () => (await query(`SELECT md5(COALESCE(string_agg(concat_ws(':',id,paper_pl,result_r,entry,stop,target,exit,closed_at),',' ORDER BY id),'')) AS hash FROM (SELECT id,paper_pl,result_r,entry,stop,target,exit,closed_at,status FROM paper_trades UNION ALL SELECT id,paper_pl,result_r,entry,stop,target,exit,closed_at,status FROM paper_strategy_trades) history WHERE status='closed'`)).rows[0].hash;
  const before = await fingerprint();
  const projected: Record<string, any>[] = [];
  for (const userId of new Set(rows.rows.map(row => row.user_id as string))) projected.push(...await projectRiskReporting(userId, rows.rows.filter(row => row.user_id === userId)));
  const after = await fingerprint();
  const journal: Record<string, any>[] = [];
  for (const userId of new Set(rows.rows.map(row => row.user_id as string))) journal.push(...await journalTradeLog(userId, { limit: null }));
  const closed = projected.filter(row => row.status === "closed");
  const windowRows = projected.filter(row => new Date(row.openedAt).getTime() >= Date.parse("2026-10-14T00:00:00-04:00") && new Date(row.openedAt).getTime() < Date.parse("2026-10-30T00:00:00-04:00"));
  const output = { allTimeRows: projected.length, windowRows: windowRows.length, window: "October 14–29, 2026 (New York)", rows: projected.length, closed: closed.length,
    verifiedR: closed.filter(row => row.resultR !== null).length, excludedR: closed.filter(row => row.resultR === null).length,
    estimatedR: closed.filter(row => row.estimatedRMultiple !== null).length,
    eligibleJournalClosed: journal.filter(row => row.status === "closed" && row.brokerExecutionStatus !== "rejected").length,
    estimatedJournalClosed: journal.filter(row => row.status === "closed" && row.brokerExecutionStatus !== "rejected" && row.estimatedRMultiple !== null).length,
    realizedPlPreserved: projected.every(row => row.paperPl === rows.rows.find(source => source.id === row.id)?.paperPl), storedClosedFinancialFieldsUnchanged: before === after,
    examples: closed.slice(-12).map(row => ({ id: row.id, pair: row.pair, realizedPl: row.paperPl, legacyR: row.legacyR, correctedR: row.resultR, estimatedR: row.estimatedRMultiple, estimatedRiskUsd: row.estimatedRiskUsd, riskDataQuality: row.riskDataQuality })) };
  await writeFile("../outputs/risk-historical-audit.json", JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
} finally { await db().end(); }
