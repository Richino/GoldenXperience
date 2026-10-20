import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
config({ path: ".env", quiet: true }); config({ path: ".env.local", quiet: true });
const { getCandles } = await import("../../frontend/src/lib/oanda/client.js");
const { candleEnd } = await import("../../frontend/src/lib/strategy/candle-clock.js");
const cutoff = "2026-10-18T22:42:59.990Z";
// Historical broker reads only. Historical complete flags are filtered against the replay cutoff.
const timeframes = await Promise.all((["D1", "H4", "H1", "M15"] as const).map(async tf => {
  const response = await getCandles("EUR_USD",tf === "D1" ? "D" : tf,300,{to:cutoff});
  if (response.data.source !== "oanda" || response.status.state !== "connected") throw new Error(`${tf}: ${response.status.message}`);
  return [tf,{provenance:response.data.provenance,candles:response.data.candles.filter(c=>c.complete === true && candleEnd(Date.parse(c.time),tf)<=Date.parse(cutoff))}] as const;
}));
const recorded = {instrument:"EUR_USD",cutoff,recordedAt:new Date().toISOString(),timeframes:Object.fromEntries(timeframes)};
await writeFile("scripts/fixtures/oct18-oanda-analysis.json",JSON.stringify(recorded));
console.log(JSON.stringify(timeframes.map(([tf,r])=>({tf,count:r.candles.length,lastOpen:r.candles.at(-1)?.time,lastClose:new Date(candleEnd(Date.parse(r.candles.at(-1)!.time),tf)).toISOString()}))));
