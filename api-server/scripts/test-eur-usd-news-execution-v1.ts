import assert from "node:assert/strict";
import { createEurUsdNewsExecutionLevels, EUR_USD_NEWS_EXECUTION_V1 } from "../src/eur-usd-news-execution-v1.js";

assert.equal(EUR_USD_NEWS_EXECUTION_V1.status, "SHADOW_ONLY");
assert.equal(EUR_USD_NEWS_EXECUTION_V1.stopAtr, 1);
assert.equal(EUR_USD_NEWS_EXECUTION_V1.targetToStop, 2);

const long = createEurUsdNewsExecutionLevels({ direction: "long", executableEntry: 1.1, preNewsAtr: 0.0004 });
assert.ok(Math.abs(long.stop - 1.0996) < 1e-12);
assert.ok(Math.abs(long.target - 1.1008) < 1e-12);

const short = createEurUsdNewsExecutionLevels({ direction: "short", executableEntry: 1.1, preNewsAtr: 0.0004 });
assert.ok(Math.abs(short.stop - 1.1004) < 1e-12);
assert.ok(Math.abs(short.target - 1.0992) < 1e-12);
assert.throws(() => createEurUsdNewsExecutionLevels({ direction: "long", executableEntry: 1.1, preNewsAtr: 0 }));

console.log("EUR/USD news execution v1 tests passed.");
