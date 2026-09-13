import { INSTRUMENT_CATALOG, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getAccountSummary, getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { highImpactMinutesFor } from "../../frontend/src/lib/macro/rates.js";
import { getPaperTradingAvailability } from "../../frontend/src/lib/strategy/strategy-engine.js";
import { evaluateEnabledPairStrategies, PAIR_STRATEGY_REGISTRY } from "../../frontend/src/lib/strategy/strategies/index.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { StrategyEvaluationInput, StrategyId } from "../../frontend/src/lib/strategy/types.js";
import type { Candle, MajorInstrument, PriceQuote } from "../../frontend/src/types/forex.js";

export type PairScanStatus = "NO_VALIDATED_STRATEGY" | "NO_SETUP" | "SAFETY_BLOCKED" | "SELECTED" | "CORRELATED_DUPLICATE" | "DATA_ERROR";
export type PairScanRecord = { instrument: string; status: PairScanStatus; strategyId: string | null; reason: string; score: number | null; candidate: StrategyCandidate<StrategyId> | null; aiExplanationInput: string | null };
export type PairStrategyScan = { scannedAt: string; universeSize: number; validatedStrategyPairs: number; selected: PairScanRecord[]; records: PairScanRecord[]; safety: { marketOpen: boolean; calendarConnected: boolean; pricingConnected: boolean } };

const CANDLE_COUNT = 260;
const strategyPairs = Object.keys(PAIR_STRATEGY_REGISTRY) as MajorInstrument[];

function live(status: { state: string; source: string }) { return status.state === "connected" && status.source === "oanda"; }
function pairCurrencies(pair: string) { return new Set(pair.split("_")); }
function overlaps(left: string, right: string) { const rightCurrencies = pairCurrencies(right); return [...pairCurrencies(left)].some((currency) => rightCurrencies.has(currency)); }

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length); let cursor = 0;
  async function worker() { while (cursor < items.length) { const index = cursor++; out[index] = await work(items[index]!); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker())); return out;
}

function dataError(instrument: string, error: unknown): PairScanRecord {
  return { instrument, status: "DATA_ERROR", strategyId: null, reason: error instanceof Error ? error.message : String(error), score: null, candidate: null, aiExplanationInput: null };
}

function safetyBlock(candidate: StrategyCandidate<StrategyId>, input: StrategyEvaluationInput, marketOpen: boolean) {
  if (!marketOpen) return "FOREX_MARKET_CLOSED";
  if (!input.calendarConnected) return "CALENDAR_UNAVAILABLE";
  if (input.highImpactNewsWithinMinutes !== null && input.highImpactNewsWithinMinutes <= 30) return "HIGH_IMPACT_NEWS_BUFFER";
  if (candidate.entry === null || candidate.stop === null || candidate.direction === null || input.bid === null || input.ask === null) return "EXECUTABLE_PRICE_UNAVAILABLE";
  const risk = Math.abs(candidate.entry - candidate.stop); const spread = input.ask - input.bid;
  if (!(risk > 0) || !(spread >= 0)) return "INVALID_RISK_OR_SPREAD";
  if (spread / risk > 0.1) return "SPREAD_EXCEEDS_10_PERCENT_OF_RISK";
  return null;
}

function score(candidate: StrategyCandidate<StrategyId>, input: StrategyEvaluationInput) {
  if (candidate.entry === null || candidate.stop === null || input.bid === null || input.ask === null) return null;
  const risk = Math.abs(candidate.entry - candidate.stop); if (!(risk > 0)) return null;
  // The score is deterministic. Reward/risk remains the primary tie-breaker; lower spread cost wins.
  return Number(((candidate.riskReward ?? 0) * 100 - ((input.ask - input.bid) / risk) * 100).toFixed(4));
}

/**
 * Scans the full broker universe, but only routes instruments with a dedicated
 * frozen strategy. Unsupported pairs are an explicit block, never a generic
 * strategy fallback. This function never creates an order.
 */
export async function scanPairStrategyRouter(options: { maxSelections?: number } = {}): Promise<PairStrategyScan> {
  const [account, pricing, calendar] = await Promise.all([getAccountSummary(), getPricing(strategyPairs), getEconomicCalendar()]);
  const availability = getPaperTradingAvailability(); const pricingConnected = live(pricing.status); const accountConnected = live(account.status);
  const coverageUntil = calendar.data.coverageUntil ? Date.parse(calendar.data.coverageUntil) : Number.NaN;
  const calendarConnected = calendar.data.connected && Number.isFinite(coverageUntil) && coverageUntil - Date.now() >= 30 * 60_000;
  const quoteByPair = new Map(pricing.data.map((quote) => [quote.instrument, quote]));
  const records: PairScanRecord[] = INSTRUMENT_CATALOG.filter((item) => !strategyPairs.includes(item.name)).map((item) => ({ instrument: item.name, status: "NO_VALIDATED_STRATEGY", strategyId: null, reason: "No dedicated tested strategy is registered for this pair.", score: null, candidate: null, aiExplanationInput: null }));

  const evaluated = await mapWithConcurrency(strategyPairs, 4, async (instrument): Promise<{ record: PairScanRecord; input: StrategyEvaluationInput | null }> => {
    try {
      const [m15, h1, h4, m30] = await Promise.all([getCandles(instrument, "M15", CANDLE_COUNT), getCandles(instrument, "H1", CANDLE_COUNT), getCandles(instrument, "H4", CANDLE_COUNT), instrument === "GBP_USD" ? getCandles(instrument, "M30", CANDLE_COUNT) : Promise.resolve(null)]);
      const quote = quoteByPair.get(instrument); const candlesLive = [m15, h1, h4, m30].filter((result): result is NonNullable<typeof result> => result !== null).every((result) => live(result.status));
      const quoteFresh = Boolean(quote && Date.now() - Date.parse(quote.time) <= 2 * 60_000); const dataSource = accountConnected && pricingConnected && candlesLive && quoteFresh ? "oanda" : "mock";
      const input: StrategyEvaluationInput = { instrument, accountBalance: account.data.balance, accountCurrency: account.data.currency, dataSource, candles15m: m15.data.candles, candles30m: m30?.data.candles ?? [], candles1h: h1.data.candles, candles4h: h4.data.candles, bid: quote?.bid ?? null, ask: quote?.ask ?? null, spreadPips: quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null, marketOpen: availability.marketOpen, calendarConnected, highImpactNewsWithinMinutes: calendarConnected ? highImpactMinutesFor(instrument, calendar.data.events) : null, newsRequired: true, evaluationMode: "live", evaluatedAt: new Date().toISOString() };
      const candidate = evaluateEnabledPairStrategies(input)[0] ?? null;
      if (!candidate || candidate.status !== "valid") return { input, record: { instrument, status: "NO_SETUP", strategyId: candidate?.family ?? null, reason: candidate?.qualifyReason ?? "No strategy candidate returned.", score: null, candidate, aiExplanationInput: null } };
      const blocked = safetyBlock(candidate, input, availability.marketOpen);
      if (blocked) return { input, record: { instrument, status: "SAFETY_BLOCKED", strategyId: candidate.family, reason: blocked, score: null, candidate, aiExplanationInput: null } };
      const candidateScore = score(candidate, input);
      return { input, record: { instrument, status: "SELECTED", strategyId: candidate.family, reason: "Qualified by its dedicated frozen strategy and passed hard safety filters.", score: candidateScore, candidate, aiExplanationInput: `Explain only; do not change this paper candidate. ${instrument.replace("_", "/")} was selected by ${candidate.family}. Direction ${candidate.direction}; entry ${candidate.entry}; stop ${candidate.stop}; target ${candidate.target}; deterministic score ${candidateScore}.` } };
    } catch (error) { return { input: null, record: dataError(instrument, error) }; }
  });
  records.push(...evaluated.map((item) => item.record));
  const maxSelections = options.maxSelections ?? 1; const ranked = evaluated.map((item) => item.record).filter((record) => record.status === "SELECTED" && record.score !== null).sort((left, right) => right.score! - left.score! || left.instrument.localeCompare(right.instrument));
  const selected: PairScanRecord[] = [];
  for (const record of ranked) {
    if (selected.length >= maxSelections || selected.some((existing) => overlaps(existing.instrument, record.instrument))) { record.status = "CORRELATED_DUPLICATE"; record.reason = "Another selected setup already exposes one of this pair's currencies."; record.aiExplanationInput = null; continue; }
    selected.push(record);
  }
  return { scannedAt: new Date().toISOString(), universeSize: INSTRUMENT_CATALOG.length, validatedStrategyPairs: strategyPairs.length, selected, records: records.sort((left, right) => left.instrument.localeCompare(right.instrument)), safety: { marketOpen: availability.marketOpen, calendarConnected, pricingConnected } };
}
