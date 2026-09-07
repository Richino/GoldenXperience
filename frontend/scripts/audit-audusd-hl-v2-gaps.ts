import { loadEnvConfig } from "@next/env";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
type Candle = { time: string; complete: boolean; mid?: unknown; bid?: unknown; ask?: unknown };
async function main() {
  const root = resolve(process.cwd(), "../api-server/research-v2/audusd-hl-v2-spread-validation");
  const cache = JSON.parse(await readFile(resolve(root, "data/AUD_USD-M1-TV219-MBA.json"), "utf8")) as { windows: Record<string, Array<{ time: string }>> };
  const raw = JSON.parse(await readFile(resolve(root, "RAW_RESULTS.json"), "utf8")) as { trades: Array<{ trade_number: number; resolved_utc_entry: string; execExitTime: string }> };
  const gaps: Array<{ tradeNumber: number; minute: string; beforeOrAtExit: boolean }> = [];
  for (const trade of raw.trades) {
    const start = Date.parse(trade.resolved_utc_entry) + 60 * 60_000, end = start + 3 * 60 * 60_000;
    const available = new Set((cache.windows[String(trade.trade_number)] ?? []).map(c => Date.parse(c.time)));
    for (let time = start; time < end; time += 60_000) if (!available.has(time)) gaps.push({ tradeNumber: trade.trade_number, minute: new Date(time).toISOString(), beforeOrAtExit: time < Date.parse(trade.execExitTime) });
  }
  loadEnvConfig(resolve(process.cwd(), "../api-server")); loadEnvConfig(process.cwd());
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA credentials unavailable");
  const host = process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const details = [];
  for (const gap of gaps) {
    const start = Date.parse(gap.minute), result: Record<string, number> = {};
    for (const granularity of ["M1", "S5"] as const) {
      const url = new URL(`${host}/v3/instruments/AUD_USD/candles`);
      for (const [key, value] of Object.entries({ price: "MBA", granularity, from: new Date(start).toISOString(), to: new Date(start + 60_000).toISOString(), includeFirst: "true" })) url.searchParams.set(key, value);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`OANDA gap audit ${granularity} failed HTTP ${response.status}`);
      const body = await response.json() as { candles?: Candle[] };
      result[granularity] = (body.candles ?? []).filter(c => c.complete && c.mid && c.bid && c.ask).length;
    }
    details.push({ ...gap, returnedCompletedCandles: result });
  }
  const artifact = { checkedAt: new Date().toISOString(), source: "Read-only targeted OANDA MBA requests", replayGaps: gaps.length,
    gapsBeforeOrAtExecutableExit: gaps.filter(g => g.beforeOrAtExit).length, details,
    interpretation: details.every(d => d.returnedCompletedCandles.M1 === 0 && d.returnedCompletedCandles.S5 === 0)
      ? "OANDA returned no M1 or S5 price candles in these isolated minutes; no executable tick path exists to replay in the broker history."
      : "At least one missing M1 interval has finer S5 data and requires replay refinement." };
  await writeFile(resolve(root, "GAP_AUDIT.json"), JSON.stringify(artifact, null, 2) + "\n");
  console.log(JSON.stringify(artifact, null, 2));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
