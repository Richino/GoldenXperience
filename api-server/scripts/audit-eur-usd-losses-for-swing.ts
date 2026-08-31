/**
 * Read-only diagnostic of all closed paper-strategy losses. It does
 * not claim that a later target touch was tradable: the original stop remains
 * part of every path calculation.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
type Direction = "long" | "short";
type Trade = { trade_sequence: string; instrument: string; strategy_family: string | null; decision_time: string | Date; closed_at: string | Date | null; direction: Direction; entry: string; stop: string; target: string; result_r: string; outcome: string | null; exit_reason: string | null };
type Quote = { closeTime: string; bidHigh: number; bidLow: number; askHigh: number; askLow: number };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false }); if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const { query } = await import("../src/database.js"); const output = path.join(root, "research-v2", "eur-usd-losses-swing-diagnostic"); if (!existsSync(output)) mkdirSync(output, { recursive: true });
const { getResearchCandles } = await import("../../frontend/src/lib/oanda/client.js");
const HORIZON_HOURS = 72;
function firstIndex<T>(items: T[], predicate: (item: T) => boolean) { const index = items.findIndex(predicate); return index < 0 ? null : index; }
function analyze(trade: Trade, quotes: Quote[]) {
  const entry = Number(trade.entry), stop = Number(trade.stop), target = Number(trade.target), risk = Math.abs(entry - stop); if (!(risk > 0)) return null;
  const direction = trade.direction; let maxFavorableR = Number.NEGATIVE_INFINITY, maxAdverseR = Number.NEGATIVE_INFINITY; let targetTouchAt: string | null = null, stopTouchAt: string | null = null, firstOutcome: "target_first" | "stop_first" | "ambiguous" | "neither" = "neither";
  for (const quote of quotes) {
    const targetHit = direction === "long" ? quote.bidHigh >= target : quote.askLow <= target;
    const stopHit = direction === "long" ? quote.bidLow <= stop : quote.askHigh >= stop;
    if (!targetTouchAt && targetHit) targetTouchAt = quote.closeTime;
    if (!stopTouchAt && stopHit) stopTouchAt = quote.closeTime;
    const favorable = direction === "long" ? (quote.bidHigh - entry) / risk : (entry - quote.askLow) / risk;
    const adverse = direction === "long" ? (entry - quote.bidLow) / risk : (quote.askHigh - entry) / risk;
    maxFavorableR = Math.max(maxFavorableR, favorable); maxAdverseR = Math.max(maxAdverseR, adverse);
    if (firstOutcome === "neither" && (targetHit || stopHit)) firstOutcome = targetHit && stopHit ? "ambiguous" : targetHit ? "target_first" : "stop_first";
  }
  const decisionMs = new Date(trade.decision_time).getTime();
  return { seq: trade.trade_sequence, instrument: trade.instrument, family: trade.strategy_family, decisionTime: new Date(trade.decision_time).toISOString(), closedAt: trade.closed_at ? new Date(trade.closed_at).toISOString() : null, direction, actualResultR: Number(trade.result_r), originalOutcome: trade.outcome, originalExitReason: trade.exit_reason, originalRiskPrice: risk, originalTargetR: Math.abs(target - entry) / risk, firstOutcomeWithin72h: firstOutcome, targetTouchedWithin72h: targetTouchAt !== null, targetTouchedAt: targetTouchAt, targetTouchHoursAfterEntry: targetTouchAt ? (new Date(targetTouchAt).getTime() - decisionMs) / 3_600_000 : null, stopTouchedWithin72h: stopTouchAt !== null, stopTouchedAt: stopTouchAt, maxFavorableR, maxAdverseR, requiredStopMultiplierToSurvive: Math.max(0, maxAdverseR) };
}
const losses = await query<Trade>(`SELECT trade_sequence::text,instrument,strategy_family,decision_time,closed_at,direction,entry::text,stop::text,target::text,result_r::text,outcome,exit_reason FROM paper_strategy_trades WHERE status='closed' AND result_r < 0 AND decision_time <= now() - interval '72 hours' ORDER BY decision_time`);
const rows: ReturnType<typeof analyze>[] = []; let unavailable = 0;
for (const trade of losses.rows) {
  const end = new Date(new Date(trade.decision_time).getTime() + HORIZON_HOURS * 3_600_000).toISOString();
  let quotes: Quote[];
  try {
    quotes = (await getResearchCandles(trade.instrument as never, "M15", 500, { to: end }))
      .filter((candle) => candle.complete)
      .map((candle) => ({ closeTime: new Date(Date.parse(candle.time) + 15 * 60_000).toISOString(), bidHigh: candle.bid.high, bidLow: candle.bid.low, askHigh: candle.ask.high, askLow: candle.ask.low }))
      .filter((quote) => quote.closeTime > new Date(trade.decision_time).toISOString() && quote.closeTime <= end)
      .sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
  } catch (error) { console.error("[loss-swing-diagnostic] OANDA history unavailable", trade.trade_sequence, trade.instrument, error); unavailable += 1; continue; }
  const last = quotes.at(-1); if (!last || Date.parse(last.closeTime) < Date.parse(end) - 30 * 60_000) { unavailable += 1; continue; }
  const result = analyze(trade, quotes); if (result) rows.push(result);
}
const decided = rows.filter(Boolean) as NonNullable<(typeof rows)[number]>[];
const count = (predicate: (row: typeof decided[number]) => boolean) => decided.filter(predicate).length;
const report = { generatedAt: new Date().toISOString(), scope: { source: "actual closed paper_strategy_trades with negative result_r, matched to raw OANDA M15 bid/ask history", horizonHours: HORIZON_HOURS, purpose: "continuation diagnostic only; a target touch after a stop is not a valid swing win", excludes: "all trade writes, strategy changes, and target/stop optimization" }, coverage: { actualLossesEligibleByAge: losses.rows.length, analyzableWith72hQuotes: decided.length, unavailableQuoteCoverage: unavailable }, summary: { targetTouchedWithin72h: count((row) => row.targetTouchedWithin72h), targetFirstBeforeOriginalStop: count((row) => row.firstOutcomeWithin72h === "target_first"), stopFirstBeforeTarget: count((row) => row.firstOutcomeWithin72h === "stop_first"), ambiguousFirstTouch: count((row) => row.firstOutcomeWithin72h === "ambiguous"), targetTouchedOnlyAfterStop: count((row) => row.targetTouchedWithin72h && row.firstOutcomeWithin72h === "stop_first"), medianRequiredStopMultiplierForAllLosses: decided.length ? [...decided].map((row) => row.requiredStopMultiplierToSurvive).sort((a, b) => a - b)[Math.floor(decided.length / 2)] : null }, trades: decided };
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
