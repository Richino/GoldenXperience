/** Read-only OANDA validation. Does not notify or execute orders. */
import assert from "node:assert/strict";
import path from "node:path";
import { config } from "dotenv";
import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { calculateAbsorption, createAbsorptionEngine } from "../../frontend/src/lib/indicators/absorption.js";
for (const name of [".env", ".env.local"]) config({ path: path.resolve(process.cwd(), name), quiet: true });
assert.notEqual(process.env.OANDA_ENVIRONMENT, "live", "Use Practice credentials for this validation.");
for (const instrument of ["EUR_USD", "GBP_USD", "USD_JPY"] as const) {
  for (const timeframe of ["H1", "H4", "D"]) {
    const { data, status } = await getCandles(instrument, timeframe, 1000);
    assert.equal(status.state, "connected"); assert.equal(data.source, "oanda");
    const completed = data.candles.filter(c => c.complete);
    const full = calculateAbsorption(data.candles, instrument, timeframe);
    const engine = createAbsorptionEngine(instrument, timeframe);
    let frozen = new Map<string, string>();
    for (const candle of completed) {
      engine.append(candle); engine.append({ ...candle });
      for (const zone of engine.snapshot().zones) {
        if (frozen.has(zone.id)) assert.equal(JSON.stringify(zone), frozen.get(zone.id), "Confirmed zone repainted");
        if (zone.status === "Confirmed") { assert.ok(Date.parse(zone.confirmationTime!) > Date.parse(zone.time)); frozen.set(zone.id, JSON.stringify(zone)); }
      }
    }
    assert.deepEqual(engine.snapshot(), full);
    assert.equal(new Set(full.events.map(e => e.id)).size, full.events.length);
    console.log(JSON.stringify({ instrument, timeframe, candles: completed.length, candidates: full.events.filter(e => e.phase === "candidate").length, confirmations: full.events.filter(e => e.phase === "confirmed").length, first: completed[0]?.time, last: completed.at(-1)?.time, newestZone: full.zones.at(-1) ?? null }));
  }
}
