import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
config({ path: ".env", quiet: true }); config({ path: ".env.local", override: true, quiet: true });
const { db, query } = await import("../src/database.js");
const { getAccountSummary, requestPracticeAccount } = await import("../../frontend/src/lib/oanda/client.js");
const { reconstructManualRiskEstimate } = await import("../src/historical-risk-estimates.js");
const apply = process.argv.includes("--apply");
try {
  const fingerprint = async () => (await query(`SELECT md5(COALESCE(string_agg(concat_ws(':',id,paper_pl,result_r,entry,stop,target,exit,closed_at),',' ORDER BY id),'')) AS hash FROM (SELECT id,paper_pl,result_r,entry,stop,target,exit,closed_at,status FROM paper_trades UNION ALL SELECT id,paper_pl,result_r,entry,stop,target,exit,closed_at,status FROM paper_strategy_trades) h WHERE status='closed'`)).rows[0].hash;
  const before = await fingerprint();
  const account = await getAccountSummary();
  if (account.status.state !== "connected" || account.data.source !== "oanda" || account.data.currency !== "USD") throw new Error("A connected USD practice account is required.");
  const rows = (await query(`SELECT e.id,e.user_id,e.paper_trade_id,e.instrument,e.direction,e.created_at,e.metadata FROM pending_manual_entries e JOIN paper_trades t ON t.id=e.paper_trade_id WHERE t.status='closed' AND e.metadata->>'initialRiskPlan' IS NULL ORDER BY t.opened_at`)).rows;
  const audit: Array<Record<string, unknown>> = [];
  // Two GETs per candidate; modest concurrency, with no broker writes.
  for (let offset = 0; offset < rows.length; offset += 4) {
    if (offset) await new Promise(resolve => setTimeout(resolve, 400));
    await Promise.all(rows.slice(offset, offset + 4).map(async entry => {
      if (entry.metadata?.historicalRiskEstimate?.positionKey === entry.paper_trade_id) { audit.push({ id: entry.paper_trade_id, status: "already_saved" }); return; }
      const orderId = entry.metadata?.brokerOrderId, tradeId = entry.metadata?.brokerTradeId;
      if (!/^\d+$/.test(orderId ?? "") || !/^\d+$/.test(tradeId ?? "")) { audit.push({ id: entry.paper_trade_id, status: "missing_broker_link" }); return; }
      try {
        const [order, fill] = await Promise.all([
          requestPracticeAccount<{ transaction: Record<string, any> }>(`/transactions/${orderId}`),
          requestPracticeAccount<{ transaction: Record<string, any> }>(`/transactions/${tradeId}`),
        ]);
        const estimate = reconstructManualRiskEstimate(entry as any, order.transaction, fill.transaction, account.data.id);
        if (!estimate) { audit.push({ id: entry.paper_trade_id, status: "insufficient_original_evidence" }); return; }
        if (apply) {
          const saved = await query(`UPDATE pending_manual_entries SET metadata=jsonb_set(metadata,'{historicalRiskEstimate}',$3::jsonb) WHERE id=$1 AND user_id=$2 AND paper_trade_id=$4 AND metadata->>'initialRiskPlan' IS NULL AND metadata->>'historicalRiskEstimate' IS NULL`, [entry.id,entry.user_id,JSON.stringify(estimate),entry.paper_trade_id]);
          if (saved.rowCount !== 1) { audit.push({ id: entry.paper_trade_id, status: "changed_during_audit" }); return; }
        }
        audit.push({ id: entry.paper_trade_id, status: apply ? "saved_estimate" : "supported_estimate", estimate });
      } catch (error) { audit.push({ id: entry.paper_trade_id, status: "broker_read_unavailable", httpStatus: typeof (error as any)?.status === "number" ? (error as any).status : null }); }
    }));
  }
  const after = await fingerprint();
  const counts = Object.fromEntries([...new Set(audit.map(r => r.status as string))].map(status => [status,audit.filter(r => r.status === status).length]));
  const output = { checkedAt: new Date().toISOString(), applied: apply, candidates: rows.length, counts, storedClosedFinancialFieldsUnchanged: before === after, rows: audit.sort((a,b) => String(a.id).localeCompare(String(b.id))) };
  await writeFile(`../outputs/historical-risk-estimates-${apply ? "applied" : "preview"}.json`, JSON.stringify(output,null,2));
  console.log(JSON.stringify({ ...output, rows: undefined }));
  if (before !== after) throw new Error("Closed financial source fingerprint changed during audit; inspect concurrent activity.");
} finally { await db().end(); }
