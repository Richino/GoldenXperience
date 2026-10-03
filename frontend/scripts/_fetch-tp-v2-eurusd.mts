// Cache EUR/USD OANDA candles for the TrendPullback V2 research.
// Mid M15/H1/H4/D (rule input) and bid/ask M5 (fills and exits).
// Usage: node _fetch-tp-v2-eurusd.mts <outDir> <fromISO> <toISO-exclusive>
// The development fetch stops at 2024-01-01 so the locked 2024+ data is never on disk
// until the strategy is frozen.
import fs from "node:fs";

process.loadEnvFile("../api-server/.env");
const HOST = "https://api-fxpractice.oanda.com";
const H = { Authorization: `Bearer ${process.env.OANDA_API_KEY}` };
const [OUT, FROM, TO] = process.argv.slice(2) as [string, string, string];
const END = Date.parse(TO);
const INST = "EUR_USD";

type Raw = { time: string; complete: boolean; mid?: Record<string, string>; bid?: Record<string, string>; ask?: Record<string, string> };

async function get(url: string): Promise<Raw[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: H });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { candles?: Raw[]; errorMessage?: string };
      if (!json.candles) throw new Error(json.errorMessage ?? "no candles");
      return json.candles;
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

async function series(gran: string, price: "M" | "BA") {
  const out: Raw[] = [];
  let cursor = FROM;
  for (;;) {
    const extra = gran === "D" ? "&alignmentTimezone=America/New_York&dailyAlignment=17" : "";
    const batch = await get(`${HOST}/v3/instruments/${INST}/candles?price=${price}&granularity=${gran}&from=${encodeURIComponent(cursor)}&count=5000${extra}`);
    const fresh = batch.filter((c) => !out.length || Date.parse(c.time) > Date.parse(out.at(-1)!.time));
    // Hard cap: nothing at or after END is kept.
    out.push(...fresh.filter((c) => c.complete && Date.parse(c.time) < END));
    if (batch.length < 5000 || !fresh.length) break;
    cursor = batch.at(-1)!.time;
    if (Date.parse(cursor) >= END) break;
  }
  process.stderr.write(`${gran} ${price}: ${out.length} ${out[0]?.time} -> ${out.at(-1)?.time}\n`);
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
await Promise.all(["M15", "H1", "H4", "D"].map(async (gran) => {
  const file = `${OUT}/${INST}_${gran}.json`;
  if (fs.existsSync(file)) return;
  const rows = await series(gran, "M");
  fs.writeFileSync(file, JSON.stringify(rows.map((c) => [Date.parse(c.time), +c.mid!.o, +c.mid!.h, +c.mid!.l, +c.mid!.c])));
}));
const bin = `${OUT}/${INST}_M5BA.bin`;
if (!fs.existsSync(bin)) {
  const rows = await series("M5", "BA");
  // Columns: time, bidOpen, bidHigh, bidLow, bidClose, askOpen, askHigh, askLow, askClose
  const data = new Float64Array(rows.length * 9);
  rows.forEach((c, i) => {
    data.set([Date.parse(c.time), +c.bid!.o, +c.bid!.h, +c.bid!.l, +c.bid!.c, +c.ask!.o, +c.ask!.h, +c.ask!.l, +c.ask!.c], i * 9);
  });
  fs.writeFileSync(bin, Buffer.from(data.buffer));
}
console.log("done");
