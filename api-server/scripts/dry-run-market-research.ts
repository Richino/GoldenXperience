import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/**
 * One live market-intelligence run for a pair: real OANDA technical read,
 * real calendar, real OpenAI web search. Prints the validated v2 snapshot.
 * Then generates the live plans (in memory) and attaches the snapshot, as
 * Analyze does, to show the engine consuming it. Writes NOTHING to the
 * database. Costs one research call.
 *
 *   npx tsx scripts/dry-run-market-research.ts EUR_USD
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const { technicalSummaryFor } = await import("../src/intelligence/research-service.js");
const { buildCalendarSnapshot, calendarRefs } = await import("../src/intelligence/calendar-snapshot.js");
const { runResearch, researchConfig } = await import("../src/intelligence/openai-research.js");
const { randomUUID } = await import("node:crypto");
const { getEconomicCalendar } = await import("../../frontend/src/lib/calendar/forex-factory.js");

const instrument = (process.argv[2] ?? "EUR_USD").toUpperCase();
const [base, quote] = instrument.split("_") as [string, string];
const now = Date.now();
const technical = await technicalSummaryFor(instrument as never);
const calendar = await getEconomicCalendar().catch(() => null);
const events = calendar && calendar.status.state === "connected" && calendar.data.connected ? [...calendar.data.events, ...(calendar.data.recentEvents ?? [])] : null;
const snapshot = buildCalendarSnapshot({ events, currencies: [base, quote], now });
console.log(`model: ${researchConfig().model} · calendar ${snapshot.available ? `${snapshot.upcoming.length} upcoming / ${snapshot.released.length} released` : "UNAVAILABLE"} · price ${technical.price} · H4 ${technical.trend.H4} D1 ${technical.trend.D1}`);
const started = Date.now();
const outcome = await runResearch({ instrument, currencies: [base, quote], technical, calendar: calendarRefs(snapshot), calendarNote: snapshot.note, researchId: randomUUID(), now });
console.log(`took ${Math.round((Date.now() - started) / 1000)}s · effort ${outcome.effort} · searches ${outcome.usage.webSearchCalls} · tokens in ${outcome.usage.inputTokens} out ${outcome.usage.outputTokens} · cost ${outcome.usage.costUsd ?? "unknown (prices not configured)"} · search results ${outcome.sources.length}`);
if (!outcome.ok) { console.log("FAILED:", outcome.error); process.exit(0); }
const r = outcome.intelligence;
const o = r.outlook;
console.log(`
schema ${r.schemaVersion} · ${r.research.status} · quality ${r.research.quality}`);
console.log(`outlook: overall ${o.overall} · short ${o.shortTerm} · swing ${o.swingTerm} · fundamental ${o.fundamental} · technical ${o.technical}`);
console.log(`summary: ${r.summary}`);
console.log(`
factors (${r.factors.length}):`); for (const f of r.factors) console.log(`  ${f.id} [${f.importance}/${f.evidenceType}] ${f.currency} ${f.effectOnCurrency} → pair ${f.impactOnPair}: ${f.factor} (${f.sourceIds.join(",")})`);
console.log(`events (${r.events.length}):`); for (const e of r.events) console.log(`  ${e.id} ${e.status} ${e.currency} ${e.title} actual ${e.actual ?? "-"} fc ${e.forecast ?? "-"}${e.implication ? ` — ${e.implication}` : ""}`);
console.log(`sentiment: pro ${r.sentiment.professional.length} · retail ${r.sentiment.retail.length} · positioning ${r.sentiment.positioning.length} · limits: ${r.sentiment.limitations}`);
console.log(`bull thesis: ${r.bullishThesis.hypothesis} [for ${r.bullishThesis.supportingFactorIds.join(",")}; against ${r.bullishThesis.opposingFactorIds.join(",")}]`);
console.log(`bear thesis: ${r.bearishThesis.hypothesis} [for ${r.bearishThesis.supportingFactorIds.join(",")}; against ${r.bearishThesis.opposingFactorIds.join(",")}]`);
console.log(`sources in registry: ${r.sources.length} · missing data: ${r.research.missingData.join("; ")}`);
console.log(`dropped by validator: ${outcome.drops.length}`); for (const d of outcome.drops.slice(0, 10)) console.log(`  x ${JSON.stringify(d).slice(0, 160)}`);

// The engine consuming the snapshot: live plans, research attached per side, levels unchanged.
const { loadGeneratorMarket, attachIntelligence } = await import("../src/trade-plan-service.js");
const { generateTradePlans } = await import("../src/trade-plan-generator.js");
const market = await loadGeneratorMarket(instrument as never);
const generated = generateTradePlans({ instrument, ...market, maxRiskPercent: 1 });
const levels = JSON.stringify(generated.plans.map((plan) => [plan.entryZoneLow, plan.entryZoneHigh, plan.stopLoss, plan.takeProfit, plan.expiresAt]));
attachIntelligence(generated.plans, r, { fresh: true, staleReason: null, technicalReadAt: generated.context?.candleTimes.H1 ?? null, now: Date.now() });
console.log(`
plans: ${generated.result}${generated.reason ? ` (${generated.reason})` : ""}`);
for (const plan of generated.plans) {
  const c = (plan.plan as Record<string, unknown>).intelligence as { researchId: string; compatible: boolean; alignment: string; weights: unknown; supporting: Array<{ id: string }>; opposing: Array<{ id: string }>; catalysts: unknown[] };
  console.log(`  ${plan.direction} ${plan.entryZoneLow}-${plan.entryZoneHigh} SL ${plan.stopLoss} TP ${plan.takeProfit} → research ${c.researchId.slice(0, 8)} compatible ${c.compatible} · ${c.alignment} ${JSON.stringify(c.weights)} · for ${c.supporting.map((f) => f.id).join(",")} against ${c.opposing.map((f) => f.id).join(",")} · catalysts ${c.catalysts.length} · analysisInputs.researchId ${String((plan.analysisInputs as Record<string, unknown>).researchId).slice(0, 8)}`);
}
console.log(`levels unchanged by research: ${levels === JSON.stringify(generated.plans.map((plan) => [plan.entryZoneLow, plan.entryZoneHigh, plan.stopLoss, plan.takeProfit, plan.expiresAt]))}`);
fs.writeFileSync(process.env.DRY_RUN_OUT ?? path.join(root, "..", "outputs", "dry-run-research.json"), JSON.stringify({ intelligence: r, drops: outcome.drops, plans: generated.plans }, null, 2));
process.exit(0);
