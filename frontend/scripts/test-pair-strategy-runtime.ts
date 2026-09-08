import assert from "node:assert/strict";
import {
  ENABLED_PAIR_STRATEGY_IDS,
  LIVE_EXECUTABLE_FAMILIES,
  PAIR_STRATEGY_REGISTRY,
  evaluateEnabledPairStrategies,
} from "../src/lib/strategy/strategies/index.js";
import { PairStrategyRuntimeState } from "../src/lib/strategy/strategies/pair-strategy-runtime-state.js";
import { submitPracticeMarketOrder } from "../src/lib/oanda/client.js";
import type { MajorInstrument } from "../src/types/forex.js";

async function main() {
const expected = ["EUR_USD", "USD_JPY", "GBP_USD", "AUD_USD", "USD_CAD", "USD_CHF", "NZD_USD", "EUR_JPY", "CAD_JPY", "NZD_JPY"] as const;
const frozenVersions: Record<(typeof expected)[number], string> = {
  EUR_USD: "v1",
  USD_JPY: "v6",
  GBP_USD: "v3",
  AUD_USD: "AUDUSD_STRONG_CONS_STRUCTURE_V1",
  USD_CAD: "V3",
  USD_CHF: "V1",
  NZD_USD: "V1",
  EUR_JPY: "V1",
  CAD_JPY: "V1",
  NZD_JPY: "V1",
};
const input = (instrument: MajorInstrument) => ({ instrument, accountBalance: 10_000, accountCurrency: "USD", dataSource: "mock" as const, candles15m: [], candles1h: [], candles4h: [], bid: null, ask: null, spreadPips: null, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null, newsRequired: false, evaluationMode: "historical_replay" as const, evaluatedAt: "2026-09-07T00:00:00.000Z" });

assert.deepEqual(LIVE_EXECUTABLE_FAMILIES, [], "all four legacy families are paused");
assert.deepEqual(Object.keys(PAIR_STRATEGY_REGISTRY).sort(), [...expected].sort(), "every required symbol has exactly one registry entry");
assert.deepEqual([...ENABLED_PAIR_STRATEGY_IDS].sort(), Object.values(PAIR_STRATEGY_REGISTRY).map((entry) => entry.id).sort(), "all and only the ten registered pair strategies are enabled");
for (const symbol of expected) {
  const entry = PAIR_STRATEGY_REGISTRY[symbol];
  assert.ok(entry, `${symbol} loads from the runtime registry`);
  assert.equal(typeof entry.evaluate, "function", `${symbol} has an evaluator`);
  assert.equal(entry.executionEnabled, true, `${symbol} has its own enabled flag set true`);
  assert.equal(entry.version, frozenVersions[symbol], `${symbol} uses the selected frozen version`);
  // The registry key is the runtime routing key.  Some pre-existing V1 configs
  // predate an explicit `symbol` field, so assert the key rather than invent it.
  assert.equal(symbol, Object.entries(PAIR_STRATEGY_REGISTRY).find(([, value]) => value === entry)?.[0]);
  const otherSymbol = expected.find((candidate) => candidate !== symbol)!;
  const result = entry.evaluate(input(otherSymbol));
  assert.notEqual(result.status, "valid", `${symbol} must reject another pair's candles`);
}

const simultaneousEvaluations = expected.map((symbol) => evaluateEnabledPairStrategies(input(symbol)));
assert.equal(simultaneousEvaluations.length, 10);
simultaneousEvaluations.forEach((results, index) => {
  assert.equal(results.length, 1, `${expected[index]} routes to exactly one pair evaluator`);
  assert.equal(results[0]!.family, PAIR_STRATEGY_REGISTRY[expected[index]!].id);
});

const usdchfRegistryEntry = PAIR_STRATEGY_REGISTRY.USD_CHF as { executionEnabled: boolean };
usdchfRegistryEntry.executionEnabled = false;
assert.deepEqual(evaluateEnabledPairStrategies(input("USD_CHF")), [], "disabling USDCHF stops only its evaluator");
assert.equal(evaluateEnabledPairStrategies(input("EUR_USD")).length, 1, "disabling USDCHF cannot stop EURUSD evaluation");
usdchfRegistryEntry.executionEnabled = true;

const runtime = new PairStrategyRuntimeState();
const entries = expected.map((symbol) => PAIR_STRATEGY_REGISTRY[symbol]);
for (const [symbol, entry] of expected.map((symbol) => [symbol, PAIR_STRATEGY_REGISTRY[symbol]] as const)) {
  runtime.setEnabled(entry.id, symbol, true);
  assert.equal(runtime.get(entry.id, symbol)?.enabled, true, `${symbol} can be enabled independently`);
}
const position = (hour: number) => ({ entryTimestamp: `2026-09-07T${String(hour).padStart(2, "0")}:00:00.000Z`, frozenAtr: .01, stop: 1, target: 1.02, maxHoldBars: 3 as const, cooldownUntil: null, lastTradeAt: null, enabled: true });
// Three independently valid mocked signals may hold at once; no global position key exists.
runtime.open(entries[0]!.id, expected[0], position(10));
runtime.open(entries[5]!.id, expected[5], position(11));
runtime.open(entries[8]!.id, expected[8], position(12));
assert.equal(runtime.hasOpen(entries[0]!.id, expected[0]), true);
assert.equal(runtime.hasOpen(entries[5]!.id, expected[5]), true);
assert.equal(runtime.hasOpen(entries[8]!.id, expected[8]), true);
runtime.close(entries[7]!.id, expected[7]);
assert.equal(runtime.hasOpen(entries[8]!.id, expected[8]), true, "closing EURJPY cannot clear CADJPY state");
runtime.setEnabled(entries[5]!.id, expected[5], false);
assert.equal(runtime.get(entries[5]!.id, expected[5])?.enabled, false);
assert.equal(runtime.get(entries[0]!.id, expected[0])?.enabled, true, "disabling USDCHF cannot disable EURUSD");

// Automatic broker execution must fail closed before any HTTP request when an
// environment is configured as live. This test uses dummy credentials and a
// fetch trap; no network call and no broker order can occur.
const previousEnvironment = process.env.OANDA_ENVIRONMENT;
const previousAccountId = process.env.OANDA_ACCOUNT_ID;
const previousApiKey = process.env.OANDA_API_KEY;
const originalFetch = globalThis.fetch;
let fetched = false;
try {
  process.env.OANDA_ENVIRONMENT = "live";
  process.env.OANDA_ACCOUNT_ID = "test-account";
  process.env.OANDA_API_KEY = "test-token";
  globalThis.fetch = (async () => { fetched = true; throw new Error("fetch must not run"); }) as typeof fetch;
  await assert.rejects(
    submitPracticeMarketOrder({ instrument: "EUR_USD", direction: "long", units: 1, stop: 1, target: 2, clientRequestId: "no-live-test" }),
    /locked to OANDA practice accounts/,
  );
  assert.equal(fetched, false, "live endpoint must never be called by automatic execution");
} finally {
  if (previousEnvironment === undefined) delete process.env.OANDA_ENVIRONMENT; else process.env.OANDA_ENVIRONMENT = previousEnvironment;
  if (previousAccountId === undefined) delete process.env.OANDA_ACCOUNT_ID; else process.env.OANDA_ACCOUNT_ID = previousAccountId;
  if (previousApiKey === undefined) delete process.env.OANDA_API_KEY; else process.env.OANDA_API_KEY = previousApiKey;
  globalThis.fetch = originalFetch;
}

console.log("pair strategy runtime isolation: PASS (10 modules, 10 routes, 3 simultaneous positions, live broker fail-closed)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
