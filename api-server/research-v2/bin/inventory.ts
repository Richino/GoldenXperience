/**
 * CLI: inventory candle/quote coverage for V2 zone planning.
 */
import { inventoryCounts } from "../src/data.js";
import { ensureRegistryDirs } from "../src/registry/store.js";
import "../src/env.js";

ensureRegistryDirs();
const rows = await inventoryCounts();
console.log("market_candles coverage (source=oanda):\n");
console.log("instrument\ttimeframe\tn\tmin\tmax");
for (const r of rows) {
  console.log(`${r.instrument}\t${r.timeframe}\t${r.n}\t${r.min_t}\t${r.max_t}`);
}

const h1 = rows.filter((r) => r.timeframe === "H1");
console.log(`\nH1 pairs: ${h1.length}`);
for (const r of h1) console.log(`  ${r.instrument}: ${r.n} bars`);
