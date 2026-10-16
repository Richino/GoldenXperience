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
const { evaluateConfirmation } = await import("../src/trade-plan-confirmation.js");
const limits = { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 };

const pairs = process.argv.slice(2).length ? process.argv.slice(2) : ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD"];
for (const instrument of pairs) {
  const market = await loadGeneratorMarket(instrument as never);
  const result = generateTradePlans({ instrument, ...market, maxRiskPercent: 1 });
  const c = result.context;
  console.log(`\n${instrument}: ${result.result}${c ? ` · price ${c.price} (${c.priceSource}) · D1 ${c.trend.D1} H4 ${c.trend.H4} H1 ${c.trend.H1} · news ${c.news.state}` : ""}`);
  if (!result.plans.length) console.log(`  ${result.reason}`);
  for (const plan of result.plans) {
    console.log(`  ${plan.direction} ${plan.setupType} entry ${plan.entryZoneLow}–${plan.entryZoneHigh} SL ${plan.stopLoss} TP ${plan.takeProfit} RR ${plan.rewardRisk} expires ${plan.expiresAt}`);
    for (const line of plan.plan.explanation as string[]) console.log(`    · ${line}`);
    // As if approved now: nothing has closed since, so it should be waiting, with a reason.
    const check = evaluateConfirmation({
      plan: { ...plan, stopLoss: plan.stopLoss!, takeProfit: plan.takeProfit!, createdAt: new Date(market.now).toISOString() },
      candles: market.candles, quote: market.quote, news: market.news, now: market.now, limits,
    });
    console.log(`    confirmation: ${check.outcome} / ${check.stage} — ${check.notTriggeredReason}`);
  }
  for (const item of result.rejected) console.log(`  rejected ${item.direction} ${item.setupType}: ${item.reason}`);
}
process.exit(0);
