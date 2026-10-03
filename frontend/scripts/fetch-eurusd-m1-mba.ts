/**
 * Data acquisition only: EUR/USD M1 BID/ASK compact via getResearchCandles.
 * Format: [t, bh, bl, ah, al, bc, ac] — same as M5 MBA cache.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const OUT =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const START = "2013-01-01T00:00:00Z";
const BATCH = 5000;
const MAX_ROUNDS = 1200;

async function main() {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const byTime = new Map<string, [string, number, number, number, number, number, number]>();
  let cursor: string | undefined;
  let round = 0;
  while (true) {
    round++;
    const batch = await getResearchCandles("EUR_USD", "M1", BATCH, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) {
      if (c.complete) {
        byTime.set(c.time, [
          c.time,
          c.bid.high,
          c.bid.low,
          c.ask.high,
          c.ask.low,
          c.bid.close,
          c.ask.close,
        ]);
      }
    }
    const earliest = batch[0]!.time;
    if (round % 20 === 0) {
      process.stderr.write(`round ${round}: total ${byTime.size} oldest=${earliest}\n`);
    }
    if (earliest <= START) break;
    if (cursor && earliest === cursor) break;
    cursor = earliest;
    if (round > MAX_ROUNDS) break;
  }
  const rows = [...byTime.values()]
    .filter((r) => r[0] >= START)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  fs.writeFileSync(OUT, JSON.stringify(rows));
  process.stderr.write(
    `[written] ${OUT}\n${rows.length} M1 candles  ${rows[0]?.[0]} -> ${rows[rows.length - 1]?.[0]}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
