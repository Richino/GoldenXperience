import { readFileSync } from "node:fs";
import { evaluateNzdjpy23UtcBullBreakV1 } from "../src/lib/strategy/strategies/nzdjpy-strategy.js";
import type { Candle } from "../src/types/forex.js";

const START = "2023-01-01T00:00:00.000Z";
const END = "2026-08-21T00:00:00.000Z";
const TRADES_PATH = "../api-server/research-v2/nzdjpy-23utc-bull-break-v1-spread-validation/TRADES.csv";

function environmentValue(name: string): string | null {
  if (process.env[name]?.trim()) return process.env[name]!.trim();
  const line = readFileSync("../api-server/.env", "utf8").split(/\r?\n/).find((value) => value.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || null;
}

function expectedOrigins(): Set<string> {
  const rows = readFileSync(TRADES_PATH, "utf8").trim().split(/\r?\n/);
  const originColumn = rows[0]!.split(",").indexOf("resolved_utc_entry");
  if (originColumn < 0) throw new Error("The frozen NZDJPY cohort has no resolved_utc_entry column.");
  return new Set(rows.slice(1).map((row) => new Date(row.split(",")[originColumn]!).toISOString()));
}

async function fetchMidpointH1(token: string): Promise<Candle[]> {
  const byTime = new Map<string, Candle>();
  let cursor = START;
  for (let page = 0; page < 8; page += 1) {
    const params = new URLSearchParams({ price: "M", granularity: "H1", count: "5000", from: cursor, to: END });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/NZD_JPY/candles?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA midpoint candle request failed: HTTP ${response.status}.`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; volume: number; mid: { o: string; h: string; l: string; c: string } }> };
    const batch = (payload.candles ?? []).filter((candle) => candle.complete).map((candle): Candle => ({ time: new Date(candle.time).toISOString(), open: Number(candle.mid.o), high: Number(candle.mid.h), low: Number(candle.mid.l), close: Number(candle.mid.c), volume: candle.volume, complete: true }));
    if (!batch.length) break;
    for (const candle of batch) byTime.set(candle.time, candle);
    const last = batch.at(-1)!;
    if (batch.length < 5000) break;
    cursor = new Date(Date.parse(last.time) + 1).toISOString();
  }
  return [...byTime.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

async function main() {
  const token = environmentValue("OANDA_API_KEY");
  if (!token) throw new Error("OANDA_API_KEY is required for this read-only parity replay.");
  const expected = expectedOrigins();
  const candles = await fetchMidpointH1(token);
  const actual: string[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    if (new Date(candles[index]!.time).getUTCHours() !== 23) continue;
    if (evaluateNzdjpy23UtcBullBreakV1(candles.slice(0, index + 1)).strategySignalQualified) actual.push(candles[index]!.time);
  }
  const actualSet = new Set(actual);
  const tvOnly = [...expected].filter((origin) => !actualSet.has(origin));
  const tsOnly = actual.filter((origin) => !expected.has(origin));
  const matched = actual.length - tsOnly.length;
  console.log(JSON.stringify({ tvSignals: expected.size, tsSignals: actual.length, exactTimestampMatches: matched, tvOnly, tsOnly, verdict: tvOnly.length === 0 && tsOnly.length === 0 ? "NZDJPY_PINE_PARITY_CONFIRMED" : "NZDJPY_PINE_PARITY_MISMATCH" }, null, 2));
  if (tvOnly.length || tsOnly.length) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
