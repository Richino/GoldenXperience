/**
 * End-to-end smoke: fetch real M1 candles + a quote, compute enriched features,
 * and run the fade model against each pair. Prints the decision, extension,
 * RSI and streak so the wiring is verifiable at a glance.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const n of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, n), override: false });

const { getPricing, getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { MAJOR_INSTRUMENTS } = await import("../../frontend/src/types/forex.js");
const { computeBinaryFeatures, BINARY_MODEL_NAME, BINARY_MODEL_VERSION } = await import("../src/binary-engine.js");
const { createFadeModel } = await import("../src/binary-fade-v1.js");

const now = new Date();
console.log("model registered as " + BINARY_MODEL_NAME + " v" + BINARY_MODEL_VERSION);
const model = createFadeModel();
const pricing = await getPricing([...MAJOR_INSTRUMENTS]);
const quoteBy = new Map(pricing.data.map((q) => [q.instrument, q]));

console.log("pair       dir  ext(atr)  rsi   streak  decision  score  rationale");
for (const instrument of MAJOR_INSTRUMENTS) {
  const q = quoteBy.get(instrument);
  const quote = q ? { bid: q.bid, ask: q.ask, mid: q.mid } : null;
  const bars = (await getResearchCandles(instrument, "M1", 80)).map((c) => ({
    time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: c.complete,
  })).filter((c) => c.complete);
  const features = computeBinaryFeatures(instrument, bars, quote, now);
  if (!features) { console.log(instrument.padEnd(10) + "  no features"); continue; }
  const dec = model.evaluate(features);
  const bb = features.bollinger;
  console.log(
    instrument.padEnd(10) +
    " " + (bb ? String(bb.dir).padStart(3) : "  ?") +
    "   " + (bb ? bb.extAtr.toFixed(2).padStart(6) : "     ?") +
    "  " + (features.rsi14 !== null ? features.rsi14.toFixed(1).padStart(5) : "    ?") +
    "  " + (bb ? String(bb.streak).padStart(6) : "     ?") +
    "  " + dec.direction.padEnd(8) +
    "  " + dec.score.toFixed(2) +
    "  " + dec.rationale,
  );
}
process.exit(0);
