import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import type { Candle } from "../../frontend/src/types/forex.js";
import { freezeConsolidation } from "../src/consolidation-comparison.js";
const root = new URL("../../", import.meta.url), directory = new URL("data/market-recordings/", root);
const files = (await readdir(directory)).filter(n => n.endsWith(".ndjson"));
const unique = new Map<string, Candle>(); let quoteRecords = 0;
for (const file of files) for (const line of (await readFile(new URL(file, directory), "utf8")).split(/\r?\n/).filter(Boolean)) {
  const record = JSON.parse(line);
  if (record.kind === "quote") quoteRecords++;
  if (record.kind === "candles" && record.data.instrument === "EUR_USD" && record.data.granularity === "M5") {
    for (const c of record.data.snapshot.candles as Candle[]) if (c.complete) unique.set(c.time, c);
  }
}
const candles = [...unique.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
const days = [...new Set(candles.map(c => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(c.time))))];
const results: Array<{ createdAt: string; low: number; high: number; laterBars: number; attemptAt: string | null; confirmationAt: string | null; delaySecondsAfterFirstOutsideClose: number | null; outcome: string }> = [];
let nextEligible = -Infinity;
for (let i = 12; i < candles.length; i++) {
  const at = Date.parse(candles[i - 1].time) + 300_000;
  if (at < nextEligible) continue;
  const box = freezeConsolidation("EUR_USD", candles.slice(0, i), new Date(at).toISOString()); if (!box) continue;
  nextEligible = Date.parse(box.expiresAt);
  const later = candles.slice(i).filter(c => Date.parse(c.time) + 300_000 <= nextEligible);
  let attemptAt: string | null = null, confirmationAt: string | null = null, side: "up" | "down" | null = null;
  let outcome = "unresolved", delay: number | null = null;
  let expectedStart = at;
  for (const c of later) {
    if (Date.parse(c.time) !== expectedStart) { outcome = "unknown_after_data_gap"; break; }
    expectedStart += 300_000;
    const end = new Date(Date.parse(c.time) + 300_000).toISOString();
    if (!side) { side = c.close > box.high + box.buffer ? "up" : c.close < box.low - box.buffer ? "down" : null; if (side) attemptAt = end; continue; }
    if (c.close >= box.low && c.close <= box.high) { outcome = confirmationAt ? "returned_inside_on_close" : "attempt_failed_before_confirmation"; break; }
    if (!confirmationAt && (side === "up" ? c.close > box.high + box.buffer : c.close < box.low - box.buffer)) {
      confirmationAt = end; delay = (Date.parse(end) - Date.parse(attemptAt!)) / 1000;
    }
    if (confirmationAt && (side === "up" ? c.close - box.high : box.low - c.close) >= box.buffer + (box.high - box.low) * 0.5) { outcome = "extended_on_close"; break; }
  }
  results.push({ createdAt: box.createdAt, low: box.low, high: box.high, laterBars: later.length, attemptAt, confirmationAt, delaySecondsAfterFirstOutsideClose: delay, outcome });
}
const report = { instrument: "EUR_USD", recordedDaysNewYork: days, sourceFiles: files, quoteRecords, closedM5Candles: candles.length,
  boxesByDayNewYork: Object.fromEntries(days.map(day => [day, results.filter(r => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(r.createdAt)) === day).length])),
  holdMethod: "Not evaluable: no recorded intrabar quote path for these candle snapshots.",
  candleMethod: "Close-only baseline. First outside close marks an attempt; a subsequent full M5 outside close confirms. Outcomes use later closes, not intrabar highs/lows. This cannot measure true crossing-to-confirmation latency.",
  limitations: ["Stored candle snapshots cover only part of Friday; this is not a full-session comparison.", "Unresolved and insufficient future coverage remain unresolved.", "No method winner or profitability conclusion can be established."], results };
const output = new URL("outputs/consolidation-comparison/friday-candle-replay.json", root);
await mkdir(new URL("outputs/consolidation-comparison/", root), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ report: output.pathname, quoteRecords, closedM5Candles: candles.length, boxes: results.length, days }, null, 2));
