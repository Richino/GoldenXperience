import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/**
 * One live market-intelligence run for a pair: real OANDA technical read,
 * real calendar, real OpenAI web search. Prints the validated report.
 * Writes NOTHING to the database. Costs one research call.
 *
 *   npx tsx scripts/dry-run-market-research.ts EUR_USD
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const { technicalSummaryFor } = await import("../src/intelligence/research-service.js");
const { buildCalendarSnapshot } = await import("../src/intelligence/calendar-snapshot.js");
const { runResearch, researchConfig } = await import("../src/intelligence/openai-research.js");
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
const outcome = await runResearch({ instrument, currencies: [base, quote], technical, calendar: snapshot, now });
console.log(`took ${Math.round((Date.now() - started) / 1000)}s · searches ${outcome.usage.webSearchCalls} · tokens in ${outcome.usage.inputTokens} out ${outcome.usage.outputTokens} · cost ${outcome.usage.costUsd ?? "unknown (prices not configured)"} · sources ${outcome.sources.length}`);
if (!outcome.ok) { console.log("FAILED:", outcome.error); process.exit(0); }
const r = outcome.report;
console.log(`\nbias ${r.overallBias} (${r.confidence}) — ${r.summary}`);
console.log(`${base}: ${r.baseCurrency.label} — ${r.baseCurrency.summary}`);
console.log(`${quote}: ${r.quoteCurrency.label} — ${r.quoteCurrency.summary}`);
console.log(`technical vs fundamental: ${r.technicalVsFundamental}`);
console.log(`\nnews (${r.news.length}):`); for (const n of r.news) console.log(`  [${n.kind}] ${n.publisher} ${n.publishedAt?.slice(0, 10) ?? "?"} — ${n.headline} <${n.url}>`);
console.log(`bullish evidence (${r.bullishEvidence.length}):`); for (const e of r.bullishEvidence) console.log(`  + ${e.point} (${e.urls.length} src)`);
console.log(`bearish evidence (${r.bearishEvidence.length}):`); for (const e of r.bearishEvidence) console.log(`  - ${e.point} (${e.urls.length} src)`);
console.log(`sentiment: ${r.sentiment.summary} · ${r.sentiment.observations.length} observations · limits: ${r.sentiment.limitations}`);
console.log(`dropped by validator: ${outcome.dropped.length}`); for (const d of outcome.dropped.slice(0, 8)) console.log(`  x ${JSON.stringify(d).slice(0, 160)}`);
process.exit(0);
