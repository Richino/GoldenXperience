import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const root = resolve(process.cwd(), "../api-server/research-v2/additional-pairs-breakout-v1");
  const audits = [];
  for (const pair of ["USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY"] as const) {
  const result = JSON.parse(await readFile(resolve(root, `${pair}-DEVELOPMENT.json`), "utf8"));
  const gap = result.trades.find((t: { reason: string }) => t.reason === "DATA_GAP");
  if (!gap) continue;
  const start = Date.parse(gap.exitTime), to = new Date(start + 30 * 60_000).toISOString();
  const m15 = await getResearchCandles(pair, "M15", 10, { to });
  const m1 = await getResearchCandles(pair, "M1", 60, { to });
  const audit = { checkedAt: new Date().toISOString(), pair, missingBar: gap.exitTime,
    directlyReturnedM15: m15.some(c => Date.parse(c.time) === start),
    completedM1InsideMissingBar: m1.filter(c => c.complete && Date.parse(c.time) >= start && Date.parse(c.time) < start + 900_000).length,
    m15, m1, mutation: "NONE; diagnostic only" };
  audits.push(audit);
  console.log(JSON.stringify({ pair, missingBar: audit.missingBar, directlyReturnedM15: audit.directlyReturnedM15, completedM1InsideMissingBar: audit.completedM1InsideMissingBar }));
  }
  await writeFile(resolve(root, "GAP_AUDITS.json"), JSON.stringify(audits, null, 2) + "\n");
}
main().catch(() => { console.error("Gap verification failed; no data modified."); process.exitCode = 1; });
