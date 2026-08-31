/**
 * Read-only audit: does the bot's EUR/USD trade direction agree with the
 * direction of the actual 72-hour mid-price path after its decision?
 *
 * This is a direction diagnostic, not a tradability or swing-strategy replay:
 * it deliberately does not alter the original entry, stop, target, or exits.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

type Direction = "long" | "short";
type Trade = {
  trade_sequence: string;
  decision_time: string | Date;
  closed_at: string | Date | null;
  direction: Direction;
  entry: string;
  stop: string;
  target: string;
  result_r: string;
  strategy_family: string | null;
};
type Quote = { closeTime: string; bidClose: number; askClose: number };

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js");
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const outputDir = path.join(serviceRoot, "research-v2", "eur-usd-72h-trend-alignment");
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

const HORIZON_HOURS = 72;
const msHour = 3_600_000;
const mid = (quote: Quote) => (quote.bidClose + quote.askClose) / 2;

function pct(numerator: number, denominator: number) {
  return denominator === 0 ? null : Number((100 * numerator / denominator).toFixed(1));
}

function summarize(rows: Array<{ botFollows72hPath: boolean; materialNetMove: boolean; botDirection: Direction }>) {
  const matched = rows.filter((row) => row.botFollows72hPath).length;
  const material = rows.filter((row) => row.materialNetMove);
  const long = rows.filter((row) => row.botDirection === "long");
  const short = rows.filter((row) => row.botDirection === "short");
  return {
    n: rows.length,
    matched,
    matchRatePct: pct(matched, rows.length),
    materialNetMoveN: material.length,
    materialNetMoveMatched: material.filter((row) => row.botFollows72hPath).length,
    materialNetMoveMatchRatePct: pct(material.filter((row) => row.botFollows72hPath).length, material.length),
    long: { n: long.length, matched: long.filter((row) => row.botFollows72hPath).length, matchRatePct: pct(long.filter((row) => row.botFollows72hPath).length, long.length) },
    short: { n: short.length, matched: short.filter((row) => row.botFollows72hPath).length, matchRatePct: pct(short.filter((row) => row.botFollows72hPath).length, short.length) },
  };
}

const trades = await query<Trade>(`
  SELECT trade_sequence::text, decision_time, closed_at, direction, entry::text,
         stop::text, target::text, result_r::text, strategy_family
  FROM paper_strategy_trades
  WHERE instrument = 'EUR_USD'
    AND status = 'closed'
    AND decision_time <= now() - interval '72 hours'
  ORDER BY decision_time
`);

const rows: Array<Record<string, unknown>> = [];
let unavailableQuoteCoverage = 0;
for (const trade of trades.rows) {
  const decisionMs = new Date(trade.decision_time).getTime();
  const targetMs = decisionMs + HORIZON_HOURS * msHour;
  const targetIso = new Date(targetMs).toISOString();
  let quotes: Quote[];
  try {
    quotes = (await getResearchCandles("EUR_USD", "M15", 500, { to: targetIso }))
      .filter((candle) => candle.complete)
      .map((candle) => ({
        closeTime: new Date(Date.parse(candle.time) + 15 * 60_000).toISOString(),
        bidClose: candle.bid.close,
        askClose: candle.ask.close,
      }))
      .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime));
  } catch {
    unavailableQuoteCoverage += 1;
    continue;
  }
  const start = [...quotes].reverse().find((quote) => Date.parse(quote.closeTime) <= decisionMs);
  const end = [...quotes].reverse().find((quote) => Date.parse(quote.closeTime) <= targetMs);
  if (!start || !end || targetMs - Date.parse(end.closeTime) > 30 * 60_000) {
    unavailableQuoteCoverage += 1;
    continue;
  }
  const startMid = mid(start);
  const endMid = mid(end);
  const netChange = endMid - startMid;
  if (netChange === 0) {
    unavailableQuoteCoverage += 1;
    continue;
  }
  const pathDirection: Direction = netChange > 0 ? "long" : "short";
  const risk = Math.abs(Number(trade.entry) - Number(trade.stop));
  const botFollows72hPath = trade.direction === pathDirection;
  rows.push({
    tradeSequence: trade.trade_sequence,
    decisionTime: new Date(trade.decision_time).toISOString(),
    closedAt: trade.closed_at ? new Date(trade.closed_at).toISOString() : null,
    family: trade.strategy_family,
    botDirection: trade.direction,
    pathDirection,
    botFollows72hPath,
    startMid,
    endMid,
    netChangePips: netChange / 0.0001,
    originalRiskPips: risk / 0.0001,
    netMoveInOriginalRisk: risk > 0 ? Math.abs(netChange) / risk : null,
    materialNetMove: risk > 0 && Math.abs(netChange) >= risk,
    actualResultR: Number(trade.result_r),
  });
}

const typedRows = rows as Array<{ botFollows72hPath: boolean; materialNetMove: boolean; botDirection: Direction; family: string | null }>;
const byFamily = Object.fromEntries([...new Set(typedRows.map((row) => row.family ?? "unknown"))].map((family) => [family, summarize(typedRows.filter((row) => (row.family ?? "unknown") === family))]));
const report = {
  generatedAt: new Date().toISOString(),
  scope: {
    source: "all closed EUR_USD paper_strategy_trades at least 72 hours old, matched to raw OANDA M15 bid/ask candles",
    definition: "72-hour path direction is the sign of mid-price change from the final completed M15 close at or before the decision to the final completed M15 close at or before 72 hours later",
    materialMoveDefinition: "absolute 72-hour mid-price movement is at least the trade's original stop distance",
    excludes: "trade writes, execution simulation, stop/target changes, and any claim that endpoint direction made the original trade executable",
  },
  coverage: { eligibleClosedEurUsdTrades: trades.rows.length, analyzableWith72hQuotes: rows.length, unavailableQuoteCoverage },
  summary: summarize(typedRows),
  byStrategyFamily: byFamily,
  trades: rows,
};
writeFileSync(path.join(outputDir, "RESULTS.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
