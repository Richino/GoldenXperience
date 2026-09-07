import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

import type { ResearchCandle } from "../src/lib/oanda/client";
import type { Candle } from "../src/types/forex";

export type PriceBar = { open: number; high: number; low: number; close: number };
export type AudusdHistoryCandle = Candle & { mid: PriceBar; bid: PriceBar; ask: PriceBar };
export type AudusdHistory = {
  symbol: "AUD_USD";
  timeframe: "H1";
  source: string;
  from: string;
  to: string;
  candles: AudusdHistoryCandle[];
};

function asHistoryCandle(bar: ResearchCandle): AudusdHistoryCandle {
  return { time: bar.time, volume: bar.volume, complete: bar.complete, ...bar.mid, mid: bar.mid, bid: bar.bid, ask: bar.ask };
}

/** Load a fixture, or page backward through OANDA's 5,000-candle limit. */
export async function loadAudusdHistory(fixturePath?: string): Promise<AudusdHistory> {
  if (fixturePath) {
    const parsed = JSON.parse(await readFile(resolve(fixturePath), "utf8")) as Omit<AudusdHistory, "source" | "from" | "to">;
    const candles = [...parsed.candles].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
    return {
      ...parsed,
      source: resolve(fixturePath),
      from: candles[0]?.time ?? "",
      to: candles.at(-1)?.time ?? "",
      candles,
    };
  }

  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const from = process.env.AUDUSD_PARITY_FROM ?? "2023-01-01T00:00:00.000Z";
  const configuredTo = process.env.AUDUSD_PARITY_TO;
  let cursor = configuredTo;
  let priorEarliest = "";
  const byTime = new Map<string, AudusdHistoryCandle>();

  for (let page = 0; page < 12; page += 1) {
    const batch = await getResearchCandles("AUD_USD", "H1", 5_000, cursor ? { to: cursor } : {});
    for (const bar of batch) byTime.set(bar.time, asHistoryCandle(bar));
    const earliest = batch.map((bar) => bar.time).sort()[0];
    if (!earliest || earliest === priorEarliest || Date.parse(earliest) <= Date.parse(from)) break;
    priorEarliest = earliest;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
  }

  const candles = [...byTime.values()]
    .filter((bar) => bar.complete && Date.parse(bar.time) >= Date.parse(from)
      && (!configuredTo || Date.parse(bar.time) <= Date.parse(configuredTo)))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  return {
    symbol: "AUD_USD", timeframe: "H1", source: "OANDA practice API H1 MBA candles", from,
    to: configuredTo ?? candles.at(-1)?.time ?? "", candles,
  };
}
