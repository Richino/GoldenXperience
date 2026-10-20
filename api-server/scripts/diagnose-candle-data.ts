import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

/** Read-only diagnosis. Never submits research, persists plans or touches broker orders. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) config({ path: resolve(root, name), quiet: true });
const { query, db, databaseConfigured } = await import("../src/database.js");
try {
  if (databaseConfigured()) {
    const saved = await query<{snapshot: Record<string, unknown>}>("SELECT snapshot FROM market_state_snapshots WHERE instrument='EUR_USD' ORDER BY created_at DESC LIMIT 3");
    for (const { snapshot } of saved.rows) console.log(JSON.stringify({ event:"saved-candle-snapshot", id:snapshot.id, at:snapshot.generatedAt, quality:snapshot.quality, source:snapshot.source }));
  }
  if (process.argv.includes("--live")) {
    const { loadGeneratorMarket } = await import("../src/trade-plan-service.js");
    const { generateTradePlans } = await import("../src/trade-plan-generator.js");
    const { readMarketTechnicals, interpretMarketState } = await import("../src/intelligence/market-state-interpreter.js");
    const { latestResearch } = await import("../src/intelligence/research-service.js");
    const market = { instrument:"EUR_USD" as const, ...await loadGeneratorMarket("EUR_USD") };
    const result = generateTradePlans({...market,maxRiskPercent:1});
    const research = databaseConfigured() ? (await latestResearch("EUR_USD",market.now)).research : null;
    const interpreted = research?.report ? interpretMarketState({ intelligence:research.report, researchFresh:research.fresh, market, technical:readMarketTechnicals(market), calendar:market.calendarSnapshot, plans:result.plans }) : null;
    console.log(JSON.stringify({ event:"live-read-only", dataSnapshot:market.dataSnapshot, diagnostics:result.diagnostics, result:result.result, reason:result.reason, plans:result.plans.map(p=>({direction:p.direction,setup:p.setupType,entry:[p.entryZoneLow,p.entryZoneHigh],stop:p.stopLoss,target:p.takeProfit,readiness:p.plan.entryReadiness,confirmation:p.plan.confirmation,expiresAt:p.expiresAt,dataSnapshotId:p.analysisInputs?.dataSnapshotId})), researchId:research?.id??null, analysisStatus:interpreted?.analysisStatus??null, quality:interpreted?.quality??null, observed:interpreted?.observed??null, costs:interpreted?.costs??null }));
  }
} finally { if(databaseConfigured()) await db().end(); }
