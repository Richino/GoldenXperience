import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/**
 * Runs the trade plan generator on live OANDA data for a few pairs and
 * prints the plans. Read-only: fetches candles, pricing and the calendar,
 * writes nothing to the database and places nothing.
 *
 *   npm run trade-plans:live-dry-run -- EUR_USD GBP_USD
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
const { loadGeneratorMarket } = await import("../src/trade-plan-service.js");
const { generateTradePlans } = await import("../src/trade-plan-generator.js");

const pairs = process.argv.slice(2).length ? process.argv.slice(2) : ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"];
for (const instrument of pairs) {
  const market = await loadGeneratorMarket(instrument as never);
  const result = generateTradePlans({ instrument, ...market, maxRiskPercent: 1 });
  const c = result.context;
  console.log(`\n${instrument}: ${result.result}${c ? ` · price ${c.price} (${c.priceSource}) · D1 ${c.trend.D1} H4 ${c.trend.H4} H1 ${c.trend.H1} M15 ${c.trend.M15} · news ${c.news.state}` : ""}`);
  if (!result.plans.length) console.log(`  ${result.reason}`);
  for (const plan of result.plans) {
    console.log(`  ${plan.direction} ${plan.setupType} entry ${plan.entryZoneLow}–${plan.entryZoneHigh} SL ${plan.stopLoss} TP ${plan.takeProfit} RR ${plan.rewardRisk} expires ${plan.expiresAt}`);
    for (const line of plan.plan.explanation as string[]) console.log(`    · ${line}`);
  }
  for (const item of result.rejected) console.log(`  rejected ${item.direction} ${item.setupType}: ${item.reason}`);
}
process.exit(0);
