import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
const { query, db } = await import("../src/database.js");
// Read-only audit: no research submission, plan creation, or broker mutations.
try {
  if (process.argv.includes("--refresh-view")) {
    const { refreshMarketStateForResearch } = await import("../src/trade-plan-service.js");
    const snapshot = await refreshMarketStateForResearch("EUR_USD");
    console.log(JSON.stringify({refreshedView:snapshot?.id,analysisStatus:snapshot?.analysisStatus,quality:snapshot?.quality,costs:snapshot?.costs}));
  }
  const research = (await query("SELECT id,created_at,expires_at,report,sources,dropped,calendar_snapshot,technical_summary,web_search_calls,duration_ms FROM market_research WHERE instrument='EUR_USD' AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const snapshots = (await query("SELECT snapshot FROM market_state_snapshots WHERE instrument='EUR_USD' ORDER BY created_at DESC LIMIT 8")).rows.map(r => r.snapshot);
  const jobs = (await query("SELECT j.id,j.created_at,j.status,j.effort,j.validation_drops,j.sources_count,j.error,w.plans_result,w.plans_reason,w.notified_at FROM research_jobs j LEFT JOIN research_job_watchers w ON j.id=w.job_id WHERE j.instrument='EUR_USD' ORDER BY j.created_at DESC LIMIT 8")).rows;
  const plans = (await query("SELECT id,analysis_id,direction,setup_type,status,created_at,entry_zone_low,entry_zone_high,stop_loss,take_profit,plan,analysis_inputs FROM trade_plans WHERE instrument='EUR_USD' ORDER BY created_at DESC LIMIT 6")).rows;
  await writeFile("../outputs/analyze-status-audit.json", JSON.stringify({research,snapshots,jobs,plans},null,2));
  if (process.argv.includes("--provider")) {
    const job = (await query("SELECT openai_response_id FROM research_jobs WHERE research_id=$1",[research.id])).rows[0];
    const { fetchBackgroundResponse } = await import("../src/intelligence/openai-research.js");
    const response = await fetchBackgroundResponse(job.openai_response_id);
    if (response.kind === "done") {
      const searches = (response.payload.output as Array<{type:string;action?:unknown}>).filter(i=>i.type==="web_search_call").map(i=>i.action);
      await writeFile("../outputs/analyze-research-search-audit.json",JSON.stringify(searches,null,2));
      console.log(JSON.stringify({searches}));
    } else console.log(JSON.stringify({providerRead:response.kind}));
  }
  console.log(JSON.stringify({researchId:research.id,cutoff:research.report.research.cutoffAt,missingData:research.report.research.missingData,calendar:research.calendar_snapshot,technical:research.technical_summary,jobs,plans:plans.map(({plan,analysis_inputs,...rest})=>rest),snapshots:snapshots.map(s=>({id:s.id,at:s.generatedAt,analysisStatus:s.analysisStatus,quality:s.quality}))},null,2));
} finally { await db().end(); }
