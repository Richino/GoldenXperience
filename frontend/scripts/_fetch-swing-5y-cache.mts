// Cache 5y+ of OANDA candles for the swing-mode backtest:
// mid H1/H4/D (rule input) and bid/ask M5 (fills and exits), 14 majors.
// Output: <dir>/<INST>_<GRAN>.json (mid) and <INST>_M5BA.bin (Float64 columns).
import fs from "node:fs";

process.loadEnvFile("../api-server/.env");
const HOST = "https://api-fxpractice.oanda.com";
const H = { Authorization: `Bearer ${process.env.OANDA_API_KEY}` };
const OUT = process.argv[2]!;
const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "CAD_JPY", "NZD_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"];
const MID_FROM = "2020-06-01T00:00:00Z";
const DAILY_FROM = "2020-01-01T00:00:00Z";
const M5_FROM = "2021-09-25T00:00:00Z";
const END = Date.now();

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
      if (attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

async function series(inst: string, gran: string, price: "M" | "BA", from: string) {
  const out: Raw[] = [];
  let cursor = from;
  for (;;) {
    const extra = gran === "D" ? "&alignmentTimezone=America/New_York&dailyAlignment=17" : "";
    const batch = await get(`${HOST}/v3/instruments/${inst}/candles?price=${price}&granularity=${gran}&from=${encodeURIComponent(cursor)}&count=5000${extra}`);
    const fresh = batch.filter((c) => !out.length || Date.parse(c.time) > Date.parse(out.at(-1)!.time));
    out.push(...fresh.filter((c) => c.complete));
    if (batch.length < 5000 || !fresh.length) break;
    cursor = batch.at(-1)!.time;
    if (Date.parse(cursor) >= END) break;
  }
  return out;
}

async function pair(inst: string) {
  for (const gran of ["H1", "H4", "D"]) {
    const file = `${OUT}/${inst}_${gran}.json`;
    if (fs.existsSync(file)) continue;
    const rows = await series(inst, gran, "M", gran === "D" ? DAILY_FROM : MID_FROM);
    fs.writeFileSync(file, JSON.stringify(rows.map((c) => [Date.parse(c.time), +c.mid!.o, +c.mid!.h, +c.mid!.l, +c.mid!.c])));
  }
  const bin = `${OUT}/${inst}_M5BA.bin`;
  if (!fs.existsSync(bin)) {
    const rows = await series(inst, "M5", "BA", M5_FROM);
    // Columns: time, bidOpen, bidHigh, bidLow, bidClose, askOpen, askHigh, askLow, askClose
    const data = new Float64Array(rows.length * 9);
    rows.forEach((c, i) => {
      data.set([Date.parse(c.time), +c.bid!.o, +c.bid!.h, +c.bid!.l, +c.bid!.c, +c.ask!.o, +c.ask!.h, +c.ask!.l, +c.ask!.c], i * 9);
    });
    fs.writeFileSync(bin, Buffer.from(data.buffer));
  }
  console.log(`${inst} done`);
}

fs.mkdirSync(OUT, { recursive: true });
const queue = [...PAIRS];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await pair(queue.shift()!);
}));
console.log("all done");
