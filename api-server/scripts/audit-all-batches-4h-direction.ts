/**
 * Read-only four-hour direction audit for every recorded paper-strategy batch.
 * It measures the direction actually selected by each batch against the
 * underlying mid-price path; it is not an execution or stop/target replay.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Direction = "long" | "short";
type Trade = { trade_sequence: string; batch_number: number; batch_family: string | null; batch_status: string; version_name: string | null; version: string | null; instrument: string; decision_time: string | Date; direction: Direction; strategy_family: string | null; result_r: string | null };
type Quote = { closeTime: string; bidClose: number; askClose: number };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const output = path.join(root, "research-v2", "all-batches-4h-direction");
if (!existsSync(output)) mkdirSync(output, { recursive: true });

const HORIZON_MS = 4 * 3_600_000;
const mid = (quote: Quote) => (quote.bidClose + quote.askClose) / 2;
const ruleKind = (family: string | null) => family === "meanrev" ? "reversal" : !family || family === "legacy-or-unspecified" ? "legacy-or-unspecified" : "directional";
function pct(value: number, total: number) { return total ? Number((value * 100 / total).toFixed(1)) : null; }
type ResultRow = { batch: number; family: string; instrument: string; direction: Direction; follows4hPath: boolean; ruleKind: string };
function summarize(rows: ResultRow[]) {
  const matched = rows.filter((row) => row.follows4hPath).length;
  const longs = rows.filter((row) => row.direction === "long");
  const shorts = rows.filter((row) => row.direction === "short");
  return {
    n: rows.length, matched, matchRatePct: pct(matched, rows.length),
    long: { n: longs.length, matched: longs.filter((row) => row.follows4hPath).length, matchRatePct: pct(longs.filter((row) => row.follows4hPath).length, longs.length) },
    short: { n: shorts.length, matched: shorts.filter((row) => row.follows4hPath).length, matchRatePct: pct(shorts.filter((row) => row.follows4hPath).length, shorts.length) },
  };
}

const trades = await query<Trade>(`
  SELECT t.trade_sequence::text, b.batch_number, b.strategy_family AS batch_family,
         b.status AS batch_status, sv.name AS version_name, sv.version,
         t.instrument, t.decision_time, t.direction, t.strategy_family, t.result_r::text
    FROM paper_strategy_trades t
    JOIN paper_strategy_batches b ON b.id = t.batch_id
    LEFT JOIN strategy_versions sv ON sv.id = COALESCE(t.strategy_version_id, b.strategy_version_id)
   WHERE t.direction IN ('long', 'short')
     AND t.decision_time <= now() - interval '4 hours'
   ORDER BY b.batch_number, t.decision_time, t.trade_sequence
`);

const results: Array<ResultRow & Record<string, unknown>> = [];
let unavailableQuoteCoverage = 0;
for (const trade of trades.rows) {
  const decisionMs = new Date(trade.decision_time).getTime();
  const targetMs = decisionMs + HORIZON_MS;
  let quotes: Quote[];
  try {
    quotes = (await getResearchCandles(trade.instrument as never, "M15", 500, { to: new Date(targetMs).toISOString() }))
      .filter((candle) => candle.complete)
      .map((candle) => ({ closeTime: new Date(Date.parse(candle.time) + 15 * 60_000).toISOString(), bidClose: candle.bid.close, askClose: candle.ask.close }))
      .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
  } catch { unavailableQuoteCoverage += 1; continue; }
  const start = [...quotes].reverse().find((quote) => Date.parse(quote.closeTime) <= decisionMs);
  const end = [...quotes].reverse().find((quote) => Date.parse(quote.closeTime) <= targetMs);
  if (!start || !end || targetMs - Date.parse(end.closeTime) > 30 * 60_000 || mid(end) === mid(start)) { unavailableQuoteCoverage += 1; continue; }
  const pathDirection: Direction = mid(end) > mid(start) ? "long" : "short";
  const family = trade.strategy_family ?? trade.batch_family ?? "legacy-or-unspecified";
  results.push({
    batch: trade.batch_number, family, instrument: trade.instrument, direction: trade.direction,
    follows4hPath: trade.direction === pathDirection, ruleKind: ruleKind(family),
    tradeSequence: trade.trade_sequence, decisionTime: new Date(trade.decision_time).toISOString(),
    strategyVersion: trade.version_name && trade.version ? `${trade.version_name}/${trade.version}` : null,
    batchStatus: trade.batch_status, pathDirection, netMidPips: (mid(end) - mid(start)) / (trade.instrument.endsWith("JPY") ? 0.01 : 0.0001), actualResultR: trade.result_r === null ? null : Number(trade.result_r),
  });
}
const typed = results as ResultRow[];
const byBatch = Object.fromEntries([...new Set(typed.map((row) => row.batch))].map((batch) => [batch, summarize(typed.filter((row) => row.batch === batch))]));
const byFamily = Object.fromEntries([...new Set(typed.map((row) => row.family))].map((family) => [family, { ruleKind: ruleKind(family), ...summarize(typed.filter((row) => row.family === family)) }]));
const byInstrument = Object.fromEntries([...new Set(typed.map((row) => row.instrument))].map((instrument) => [instrument, summarize(typed.filter((row) => row.instrument === instrument))]));
const report = {
  generatedAt: new Date().toISOString(),
  scope: {
    source: "every recorded paper_strategy_trade with a direction at least four hours old, grouped by its original paper strategy batch",
    label: "mid-price at the final completed M15 close at or before four hours later is above or below the final completed M15 close at or before the recorded decision",
    meaning: "direction-only audit of the actual batch decision; not a P&L result, trade replay, or proof that a later price direction was executable",
    ruleClassification: "EMA, momentum and breakout are labelled directional; meanrev is labelled reversal; missing family metadata is legacy-or-unspecified",
    excludes: "all trade writes, stop/target changes, inversion shortcuts, and post-result rule changes",
  },
  coverage: { eligibleRecordedBatchTrades: trades.rows.length, analyzableWithFourHourQuotes: typed.length, unavailableQuoteCoverage },
  overall: summarize(typed), byBatch, byStrategyFamily: byFamily, byInstrument, trades: results,
};
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ coverage: report.coverage, overall: report.overall, byBatch: report.byBatch, byStrategyFamily: report.byStrategyFamily, byInstrument: report.byInstrument }, null, 2));
