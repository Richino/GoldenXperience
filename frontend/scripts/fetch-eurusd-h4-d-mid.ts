/**
 * Data acquisition only: EUR/USD H4 and D MID candles via getResearchCandles.
 * Used by V12 HTF-trend research (completed higher-TF bars only).
 */
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const START = "2013-01-01T00:00:00Z";
const BATCH = 5000;

type MidRow = { time: string; open: number; high: number; low: number; close: number };

async function fetchGranularity(granularity: "H4" | "D", outName: string, maxRounds: number) {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const byTime = new Map<string, MidRow>();
  let cursor: string | undefined;
  let round = 0;
  while (true) {
    round++;
    const batch = await getResearchCandles("EUR_USD", granularity, BATCH, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) {
      if (!c.complete) continue;
      byTime.set(c.time, {
        time: c.time,
        open: c.mid.open,
        high: c.mid.high,
        low: c.mid.low,
        close: c.mid.close,
      });
    }
    const earliest = batch[0]!.time;
    process.stderr.write(`${granularity} round ${round}: total ${byTime.size} oldest=${earliest}\n`);
    if (earliest <= START) break;
    if (cursor && earliest === cursor) break;
    cursor = earliest;
    if (round > maxRounds) break;
  }
  const rows = [...byTime.values()]
    .filter((r) => r.time >= START)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const out = path.join(PAD, outName);
  fs.writeFileSync(out, JSON.stringify(rows));
  process.stderr.write(`[written] ${out}\n${rows.length} ${granularity}  ${rows[0]?.time} -> ${rows[rows.length - 1]?.time}\n`);
}

async function main() {
  await fetchGranularity("H4", "eurusd-h4-mid-cache.json", 20);
  await fetchGranularity("D", "eurusd-d-mid-cache.json", 5);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
