/**
 * Data acquisition only (no strategy logic): download EUR/USD M15 candles with
 * MID+BID+ASK (OANDA price="MBA") via the project's getResearchCandles, paginate
 * backward to a start date, dedup + sort ascending, cache as JSON.
 *
 * Credentials: loaded from api-server/.env (frontend/.env.local has no OANDA_*).
 */
import fs from "node:fs";
import path from "node:path";

// ---- load OANDA creds from api-server/.env BEFORE importing the client ----
const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const OUT = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json";
const START = process.env.SR_START ?? "2013-01-01T00:00:00Z"; // fetch back to here
const BATCH = 5000;

async function main() {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const byTime = new Map<string, any>();
  let cursor: string | undefined = undefined; // "to" cursor, walk backward
  let round = 0;
  while (true) {
    round++;
    const batch = await getResearchCandles("EUR_USD", "M15", BATCH, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) byTime.set(c.time, c);
    const earliest = batch[0]!.time; // ascending; batch[0] is oldest in this page
    process.stderr.write(`round ${round}: +${batch.length} (total ${byTime.size}) oldest=${earliest}\n`);
    if (earliest <= START) break;
    if (cursor && earliest === cursor) break; // no progress
    cursor = earliest; // next page ends just before this batch's oldest
    if (round > 120) break; // safety
  }
  const rows = [...byTime.values()]
    .filter((c) => c.complete && c.time >= START)
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rows));
  process.stderr.write(`\n[written] ${OUT}\n${rows.length} candles  ${rows[0]?.time} -> ${rows[rows.length - 1]?.time}\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
