import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const output = resolve(process.cwd(), "../api-server/research-v2/additional-pairs-breakout-v1");
  await mkdir(output, { recursive: true });
  const rows = [];
  for (const pair of ["USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY"] as const) {
    const checkedAt = new Date().toISOString();
    try {
      const candles = await getResearchCandles(pair, "M15", 10, { to: "2026-09-01T00:00:00Z" });
      if (!candles.length || candles.some(c => !c.complete)) throw new Error("Missing completed historical MBA candles");
      rows.push({ pair, checkedAt, status: "AVAILABLE", count: candles.length, first: candles[0].time, last: candles.at(-1)!.time });
    } catch (error) {
      // Broker errors can include response bodies. Do not persist or print those.
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = message.match(/\b[45]\d\d\b/)?.[0] ?? null;
      rows.push({ pair, checkedAt, status: "UNAVAILABLE", httpStatus: status });
    }
    console.log(JSON.stringify(rows.at(-1)));
  }
  await writeFile(resolve(output, "DATA_ACCESS.json"), JSON.stringify(rows, null, 2) + "\n");
  if (rows.some(r => r.status !== "AVAILABLE")) process.exitCode = 1;
}
main().catch(() => { console.error("Probe failed before completion; no broker operations were requested."); process.exitCode = 1; });
