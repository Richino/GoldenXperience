import { query, transaction } from "./database.js";
import { getStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";
import { ACTIVE_STRATEGY_VERSION as LEGACY_STRATEGY_VERSION, DAY_FORCED_EXIT_MINUTES, DAY_TRADING_TIME_ZONE, evaluateStrategy } from "../../frontend/src/lib/strategy/strategy-engine.js";
import { LIQUIDITY_STRATEGY_VERSION as ACTIVE_STRATEGY_VERSION, evaluateLiquiditySetup } from "../../frontend/src/lib/strategy/liquidity-strategy.js";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import type { Candle, MajorInstrument } from "../../frontend/src/types/forex.js";
import type { StrategySetup } from "../../frontend/src/lib/strategy/types.js";
import { displayNameFor, isKnownInstrument, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";

const INSTRUMENTS = [{ code: "EUR_USD", display: "EUR/USD", precision: 5 }, { code: "GBP_USD", display: "GBP/USD", precision: 5 }, { code: "USD_JPY", display: "USD/JPY", precision: 3 }];
const HISTORICAL_TIMEFRAMES = ["M15", "H1", "H4"] as const;
const EXPERIMENT_VERSION = "position-aware-filter-v1";
const RESEARCH_SESSIONS = ["London", "London/New York overlap", "New York"] as const;
const MINIMUM_CANDLES = 210;
const REPLAY_WINDOW = 260;
// Quotes are retained for two days only as a defensive data window. Every
// day-intraday position is actually resolved on its entry day by 16:45 ET.
const OUTCOME_HOURS = 48;
const WARMUP_DAYS = 60;
const activeBackfills = new Set<string>();

type HistoricalTimeframe = (typeof HISTORICAL_TIMEFRAMES)[number];
type CandleRow = { close_time: string | Date; open: string; high: string; low: string; close: string; volume: string };
type QuoteRow = { close_time: string | Date; bid_open: string; bid_high: string; bid_low: string; bid_close: string; ask_open: string; ask_high: string; ask_low: string; ask_close: string };
export type NormalizedQuote = { closeTime: string; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; askHigh: number; askLow: number; askClose: number };
type CandidateForLabel = { id: string; decision_time: string | Date; direction: "long" | "short"; entry: string; stop: string; target: string; risk_reward: string };
type ShadowForLabel = CandidateForLabel & { instrument: MajorInstrument; failed_condition: string };

export type ResearchRun = { id: string; kind: string; started_at: string; completed_at: string | null; details: Record<string, unknown>; error: string | null };
export type OutcomeResult = { outcome: "target_first" | "stop_first" | "forced_close" | "unresolved" | "ambiguous"; resultR: number | null; maxFavorableR: number | null; maxAdverseR: number | null; horizonEndsAt: string; resolvedAt: string | null };
export type PositionAwareCandidate = { id: string; decisionTime: string; resolvedAt: string | null; horizonEndsAt: string };
export type PositionAwareSelection = PositionAwareCandidate & { executionStatus: "accepted" | "overlapping"; blockedByCandidateId: string | null; simulatedEntryAt: string | null; simulatedExitAt: string | null };

function timeframeMilliseconds(timeframe: HistoricalTimeframe) {
  return timeframe === "M15" ? 15 * 60_000 : timeframe === "H1" ? 60 * 60_000 : 4 * 60 * 60_000;
}

function startDateForMonths(months: number) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

function iso(value: string | Date) { return new Date(value).toISOString(); }

async function updateRun(id: string, details: Record<string, unknown>, error: string | null = null, complete = false) {
  await query("UPDATE research_runs SET details=$2::jsonb, error=$3, completed_at=CASE WHEN $4 THEN now() ELSE completed_at END WHERE id=$1", [id, JSON.stringify({ ...details, updatedAt: new Date().toISOString() }), error, complete]);
}

// Regular VACUUM reclaims deleted row space for PostgreSQL to reuse without
// taking the long table lock or requiring the extra disk space of VACUUM FULL.
// Keep this list limited to research tables; auth, Journal, and retired records
// are intentionally outside the active research replacement lifecycle.
async function vacuumResearchTables() {
  for (const table of ["strategy_evaluations", "evaluation_features", "trade_candidates", "outcome_labels", "shadow_outcome_labels", "market_candle_quotes", "market_candles"]) {
    await query(`VACUUM (ANALYZE) ${table}`);
  }
}

async function saveResearchCandles(instrument: MajorInstrument, timeframe: HistoricalTimeframe, candles: ResearchCandle[]) {
  const completed = candles.filter((item) => item.complete);
  for (let index = 0; index < completed.length; index += 500) {
    const batch = completed.slice(index, index + 500);
    const candlePlaceholders = batch.map((_, row) => `($${row * 8 + 1},$${row * 8 + 2},$${row * 8 + 3},$${row * 8 + 4},$${row * 8 + 5},$${row * 8 + 6},$${row * 8 + 7},$${row * 8 + 8},'oanda')`).join(",");
    const candleValues = batch.flatMap((candle) => [instrument, timeframe, new Date(new Date(candle.time).getTime() + timeframeMilliseconds(timeframe)).toISOString(), candle.mid.open, candle.mid.high, candle.mid.low, candle.mid.close, candle.volume]);
    await query(`INSERT INTO market_candles(instrument,timeframe,close_time,open,high,low,close,volume,source) VALUES ${candlePlaceholders} ON CONFLICT(instrument,timeframe,close_time,source) DO NOTHING`, candleValues);

    const quotePlaceholders = batch.map((_, row) => `($${row * 11 + 1},$${row * 11 + 2},$${row * 11 + 3},$${row * 11 + 4},$${row * 11 + 5},$${row * 11 + 6},$${row * 11 + 7},$${row * 11 + 8},$${row * 11 + 9},$${row * 11 + 10},$${row * 11 + 11},'oanda')`).join(",");
    const quoteValues = batch.flatMap((candle) => [instrument, timeframe, new Date(new Date(candle.time).getTime() + timeframeMilliseconds(timeframe)).toISOString(), candle.bid.open, candle.bid.high, candle.bid.low, candle.bid.close, candle.ask.open, candle.ask.high, candle.ask.low, candle.ask.close]);
    await query(`INSERT INTO market_candle_quotes(instrument,timeframe,close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close,source) VALUES ${quotePlaceholders} ON CONFLICT DO NOTHING`, quoteValues);
  }
}

function rowToCandle(row: CandleRow, timeframe: HistoricalTimeframe): Candle {
  return { time: new Date(new Date(row.close_time).getTime() - timeframeMilliseconds(timeframe)).toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), complete: true };
}

function normalizeQuote(row: QuoteRow): NormalizedQuote {
  return { closeTime: iso(row.close_time), bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close), askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close) };
}

function forexMarketOpen(at: Date) {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  return !((day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22));
}

type ReplayRecord = { decision_time: string; status: string; direction: string | null; entry: number | null; stop: number | null; target: number | null; risk_reward: number | null; spread_pips: number; conditions: unknown; features: unknown; raw_units: number | null; applied_units: number | null };

function evaluateReplayRecord(instrument: MajorInstrument, decisionTime: string, candles15m: Candle[], candles1h: Candle[], candles4h: Candle[], quote: NormalizedQuote): ReplayRecord {
  const spreadPips = (quote.askClose - quote.bidClose) / pipSizeFor(instrument);
  // Rate snapshots were not retained historically. Treating today's monthly
  // FRED read as a historical input would manufacture evidence, so replays
  // record an unavailable macro tilt as neutral instead.
  const setup = evaluateLiquiditySetup({ instrument, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda", candles15m, candles1h, candles4h, bid: quote.bidClose, ask: quote.askClose, spreadPips, marketOpen: forexMarketOpen(new Date(decisionTime)), calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false, evaluationMode: "historical_replay", evaluatedAt: decisionTime, macroBias: "neutral", macroDetail: "Historical FRED snapshots were not retained; macro tilt is neutral in replay." });
  return { decision_time: decisionTime, status: setup.status, direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target, risk_reward: setup.riskReward, spread_pips: spreadPips, conditions: setup.conditions, features: { ...setup.features, summary: setup.summary, passedConditions: setup.passedConditions, failedConditions: setup.failedConditions, positionSize: setup.positionSize, newsEvaluated: false, newsStatus: "not_evaluated", candleCounts: { M15: candles15m.length, H1: candles1h.length, H4: candles4h.length } }, raw_units: setup.positionSize?.calculatedUnits ?? null, applied_units: setup.positionSize?.units ?? null };
}

async function persistReplayBatch(versionId: string, instrument: MajorInstrument, records: ReplayRecord[], sourceKind = "historical") {
  if (!records.length) return;
  await transaction(async (client) => {
    const saved = await client.query<{ id: string; decision_time: string | Date }>(`INSERT INTO strategy_evaluations(strategy_version_id,instrument,decision_time,source_kind,status,direction,entry,stop,target,risk_reward,spread_pips,conditions,candle_cutoff)
      SELECT $1,$2,x.decision_time,$3,x.status,x.direction,x.entry,x.stop,x.target,x.risk_reward,x.spread_pips,x.conditions,x.decision_time
      FROM jsonb_to_recordset($4::jsonb) AS x(decision_time timestamptz,status text,direction text,entry numeric,stop numeric,target numeric,risk_reward numeric,spread_pips numeric,conditions jsonb)
      ON CONFLICT(strategy_version_id,instrument,decision_time,source_kind) DO UPDATE SET status=EXCLUDED.status,direction=EXCLUDED.direction,entry=EXCLUDED.entry,stop=EXCLUDED.stop,target=EXCLUDED.target,risk_reward=EXCLUDED.risk_reward,spread_pips=EXCLUDED.spread_pips,conditions=EXCLUDED.conditions,candle_cutoff=EXCLUDED.candle_cutoff RETURNING id,decision_time`, [versionId, instrument, sourceKind, JSON.stringify(records)]);
    const recordByTime = new Map(records.map((record) => [record.decision_time, record]));
    // Detailed feature JSON is useful for valid candidates, but duplicating it
    // for every blocked M15 candle was the largest source of database growth.
    const features = saved.rows.flatMap((row) => {
      const record = recordByTime.get(iso(row.decision_time))!;
      return record.status === "valid" ? [{ evaluation_id: row.id, features: record.features }] : [];
    });
    await client.query(`INSERT INTO evaluation_features(evaluation_id,feature_version,features) SELECT x.evaluation_id,'day-intraday-output-v1',x.features FROM jsonb_to_recordset($1::jsonb) AS x(evaluation_id uuid,features jsonb) ON CONFLICT(evaluation_id) DO UPDATE SET feature_version=EXCLUDED.feature_version,features=EXCLUDED.features`, [JSON.stringify(features)]);
    // If a rerun changes a previously valid candle to blocked, remove its old
    // feature payload so stale JSON cannot survive the new evaluation result.
    await client.query(`DELETE FROM evaluation_features ef USING strategy_evaluations se WHERE ef.evaluation_id=se.id AND se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind=$3 AND se.status <> 'valid'`, [versionId, instrument, sourceKind]);
    const candidates = saved.rows.flatMap((row) => {
      const record = recordByTime.get(iso(row.decision_time))!;
      return record.status === "valid" && record.entry !== null && record.stop !== null && record.target !== null ? [{ evaluation_id: row.id, raw_units: record.raw_units, applied_units: record.applied_units }] : [];
    });
    if (candidates.length) await client.query(`INSERT INTO trade_candidates(evaluation_id,status,raw_units,applied_units) SELECT x.evaluation_id,'planned',x.raw_units,x.applied_units FROM jsonb_to_recordset($1::jsonb) AS x(evaluation_id uuid,raw_units numeric,applied_units numeric) ON CONFLICT(evaluation_id) DO UPDATE SET status=EXCLUDED.status,raw_units=EXCLUDED.raw_units,applied_units=EXCLUDED.applied_units`, [JSON.stringify(candidates)]);
  });
}

async function replayHistoricalStrategy(runId: string, instrument: MajorInstrument, decisionCutoff: Date, dataCutoff: Date, rangeEnd: Date, baseDetails: Record<string, unknown>) {
  const [m15Result, h1Result, h4Result, quoteResult] = await Promise.all([
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataCutoff, rangeEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H1' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataCutoff, rangeEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H4' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataCutoff, rangeEnd]),
    query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataCutoff, rangeEnd]),
  ]);
  const m15 = m15Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "M15") }));
  const h1 = h1Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H1") }));
  const h4 = h4Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H4") }));
  const quoteByTime = new Map(quoteResult.rows.map((row) => { const quote = normalizeQuote(row); return [quote.closeTime, quote]; }));
  if (m15.length < MINIMUM_CANDLES || h1.length < MINIMUM_CANDLES || h4.length < MINIMUM_CANDLES) throw new Error("The full M15/H1/H4 history is not available for replay.");

  const version = await query<{ id: string }>("INSERT INTO strategy_versions(name,version,configuration) VALUES('deterministic-forex',$1,$2::jsonb) ON CONFLICT(name,version) DO UPDATE SET configuration=strategy_versions.configuration || EXCLUDED.configuration RETURNING id", [ACTIVE_STRATEGY_VERSION, JSON.stringify({ timeframes: HISTORICAL_TIMEFRAMES, news: "not_evaluated", prices: "oanda_bid_ask", entrySessions: "London 08:00-17:00 Europe/London and New York 08:00-17:00 America/New_York", forcedExitEt: "16:45", holding: "same_day", macroReplay: "neutral_when_historical_rate_snapshot_unavailable" })]);
  const versionId = version.rows[0]!.id;
  await query("DELETE FROM strategy_evaluations WHERE strategy_version_id=$1 AND instrument=$2 AND source_kind='historical'", [versionId, instrument]);
  await vacuumResearchTables();

  let h1End = 0;
  let h4End = 0;
  let evaluated = 0;
  let valid = 0;
  let batch: ReplayRecord[] = [];
  for (let index = MINIMUM_CANDLES - 1; index < m15.length; index += 1) {
    const decisionTime = m15[index]!.closeTime;
    if (new Date(decisionTime) < decisionCutoff) continue;
    while (h1End < h1.length && h1[h1End]!.closeTime <= decisionTime) h1End += 1;
    while (h4End < h4.length && h4[h4End]!.closeTime <= decisionTime) h4End += 1;
    if (h1End < MINIMUM_CANDLES || h4End < MINIMUM_CANDLES) continue;
    const quote = quoteByTime.get(decisionTime);
    if (!quote) continue;
    const record = evaluateReplayRecord(instrument, decisionTime, m15.slice(Math.max(0, index + 1 - REPLAY_WINDOW), index + 1).map((item) => item.candle), h1.slice(Math.max(0, h1End - REPLAY_WINDOW), h1End).map((item) => item.candle), h4.slice(Math.max(0, h4End - REPLAY_WINDOW), h4End).map((item) => item.candle), quote);
    batch.push(record);
    evaluated += 1;
    if (record.status === "valid") valid += 1;
    if (batch.length >= 250) { await persistReplayBatch(versionId, instrument, batch); batch = []; }
    if (evaluated % 500 === 0) await updateRun(runId, { ...baseDetails, state: "running", phase: "Replaying deterministic strategy", replayed: evaluated, validSetups: valid, progressPercent: 50 + Math.round((index / m15.length) * 30) });
  }
  await persistReplayBatch(versionId, instrument, batch);
  return { versionId, evaluated, valid };
}

export function labelOutcome(direction: "long" | "short", entry: number, stop: number, target: number, decisionTime: string, futureQuotes: NormalizedQuote[]): OutcomeResult {
  const horizon = new Date(new Date(decisionTime).getTime() + OUTCOME_HOURS * 60 * 60_000);
  const risk = Math.abs(entry - stop);
  let maxFavorableR: number | null = null;
  let maxAdverseR: number | null = null;
  let lastInWindow: NormalizedQuote | null = null;
  for (const quote of futureQuotes) {
    const time = new Date(quote.closeTime);
    if (time <= new Date(decisionTime) || time > horizon) continue;
    lastInWindow = quote;
    const favorable = direction === "long" ? (quote.bidHigh - entry) / risk : (entry - quote.askLow) / risk;
    const adverse = direction === "long" ? (entry - quote.bidLow) / risk : (quote.askHigh - entry) / risk;
    maxFavorableR = Math.max(maxFavorableR ?? favorable, favorable);
    maxAdverseR = Math.max(maxAdverseR ?? adverse, adverse);
    const targetHit = direction === "long" ? quote.bidHigh >= target : quote.askLow <= target;
    const stopHit = direction === "long" ? quote.bidLow <= stop : quote.askHigh >= stop;
    // Both levels inside one M15 bar. The stop sits 1R from entry and the target
    // at least 2R away, so the nearer level is the conservative assumption about
    // which one traded first. Recording -1 keeps the row out of the resolved
    // basis while still giving it a result the conservative basis can count.
    if (targetHit && stopHit) return { outcome: "ambiguous", resultR: -1, maxFavorableR, maxAdverseR, horizonEndsAt: horizon.toISOString(), resolvedAt: quote.closeTime };
    if (targetHit) return { outcome: "target_first", resultR: Math.abs(target - entry) / risk, maxFavorableR, maxAdverseR, horizonEndsAt: horizon.toISOString(), resolvedAt: quote.closeTime };
    if (stopHit) return { outcome: "stop_first", resultR: -1, maxFavorableR, maxAdverseR, horizonEndsAt: horizon.toISOString(), resolvedAt: quote.closeTime };
    if (isForcedSessionExit(decisionTime, quote.closeTime)) {
      const forcedResult = direction === "long" ? (quote.bidClose - entry) / risk : (entry - quote.askClose) / risk;
      return { outcome: "forced_close", resultR: forcedResult, maxFavorableR, maxAdverseR, horizonEndsAt: quote.closeTime, resolvedAt: quote.closeTime };
    }
  }
  // Neither level traded inside the horizon. A real position is closed at the
  // horizon rather than deleted, so mark it to market on the exit side of the
  // book. resolvedAt stays null so position-aware blocking still releases at the
  // horizon, which is when that close would actually happen.
  const timedOutR = lastInWindow === null ? null : direction === "long" ? (lastInWindow.bidClose - entry) / risk : (entry - lastInWindow.askClose) / risk;
  return { outcome: "unresolved", resultR: timedOutR, maxFavorableR, maxAdverseR, horizonEndsAt: horizon.toISOString(), resolvedAt: null };
}

export function selectPositionAwareCandidates(candidates: PositionAwareCandidate[]): PositionAwareSelection[] {
  let activeCandidateId: string | null = null;
  let activeUntil = Number.NEGATIVE_INFINITY;
  return candidates.map((candidate) => {
    const decisionAt = new Date(candidate.decisionTime).getTime();
    if (decisionAt < activeUntil && activeCandidateId) {
      return { ...candidate, executionStatus: "overlapping", blockedByCandidateId: activeCandidateId, simulatedEntryAt: null, simulatedExitAt: null };
    }
    activeCandidateId = candidate.id;
    const exitAt = candidate.resolvedAt ?? candidate.horizonEndsAt;
    activeUntil = new Date(exitAt).getTime();
    return { ...candidate, executionStatus: "accepted", blockedByCandidateId: null, simulatedEntryAt: candidate.decisionTime, simulatedExitAt: exitAt };
  });
}

function lowerBoundQuotes(quotes: NormalizedQuote[], target: string) {
  let low = 0; let high = quotes.length;
  while (low < high) { const middle = (low + high) >>> 1; if (quotes[middle]!.closeTime <= target) low = middle + 1; else high = middle; }
  return low;
}

function newYorkClock(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: DAY_TRADING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

function isForcedSessionExit(decisionTime: string, quoteTime: string) {
  const decision = newYorkClock(decisionTime);
  const quote = newYorkClock(quoteTime);
  return decision.date === quote.date && quote.minutes >= DAY_FORCED_EXIT_MINUTES;
}

async function labelHistoricalOutcomes(runId: string, instrument: MajorInstrument, versionId: string, baseDetails: Record<string, unknown>) {
  const [candidateResult, quoteResult] = await Promise.all([
    query<CandidateForLabel>("SELECT tc.id,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical' AND se.status='valid' ORDER BY se.decision_time", [versionId, instrument]),
    query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time", [instrument]),
  ]);
  const quotes = quoteResult.rows.map(normalizeQuote);
  let labeled = 0;
  for (let index = 0; index < candidateResult.rows.length; index += 500) {
    const batch = candidateResult.rows.slice(index, index + 500).map((candidate) => {
      const decision = iso(candidate.decision_time);
      const start = lowerBoundQuotes(quotes, decision);
      const result = labelOutcome(candidate.direction, Number(candidate.entry), Number(candidate.stop), Number(candidate.target), decision, quotes.slice(start, start + 193));
      return { candidate_id: candidate.id, outcome: result.outcome, horizon_ends_at: result.horizonEndsAt, resolved_at: result.resolvedAt, result_r: result.resultR, max_favorable_r: result.maxFavorableR, max_adverse_r: result.maxAdverseR };
    });
    if (batch.length) await query(`INSERT INTO outcome_labels(candidate_id,outcome,horizon_ends_at,resolved_at,result_r,max_favorable_r,max_adverse_r) SELECT x.candidate_id,x.outcome,x.horizon_ends_at,x.resolved_at,x.result_r,x.max_favorable_r,x.max_adverse_r FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id uuid,outcome text,horizon_ends_at timestamptz,resolved_at timestamptz,result_r numeric,max_favorable_r numeric,max_adverse_r numeric) ON CONFLICT(candidate_id) DO UPDATE SET outcome=EXCLUDED.outcome,labeled_at=now(),horizon_ends_at=EXCLUDED.horizon_ends_at,resolved_at=EXCLUDED.resolved_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r`, [JSON.stringify(batch)]);
    labeled += batch.length;
    await updateRun(runId, { ...baseDetails, state: "running", phase: "Labeling same-day outcomes", labeled, candidates: candidateResult.rows.length, progressPercent: candidateResult.rows.length ? 80 + Math.round((labeled / candidateResult.rows.length) * 19) : 99 });
  }
  return labeled;
}

async function rebuildPositionAwareCandidates(instrument: MajorInstrument, versionId: string) {
  const result = await query<{ id: string; decision_time: string | Date; resolved_at: string | Date | null; horizon_ends_at: string | Date }>(`SELECT tc.id,se.decision_time,ol.resolved_at,ol.horizon_ends_at
    FROM trade_candidates tc
    JOIN strategy_evaluations se ON se.id=tc.evaluation_id
    JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical'
    ORDER BY se.decision_time,tc.id`, [versionId, instrument]);
  const selections = selectPositionAwareCandidates(result.rows.map((row) => ({ id: row.id, decisionTime: iso(row.decision_time), resolvedAt: row.resolved_at ? iso(row.resolved_at) : null, horizonEndsAt: iso(row.horizon_ends_at) })));
  await transaction(async (client) => {
    await client.query(`UPDATE trade_candidates tc SET execution_status='pending',blocked_by_candidate_id=NULL,simulated_entry_at=NULL,simulated_exit_at=NULL
      FROM strategy_evaluations se WHERE se.id=tc.evaluation_id AND se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical'`, [versionId, instrument]);
    if (selections.length) await client.query(`UPDATE trade_candidates tc SET execution_status=x.execution_status,blocked_by_candidate_id=x.blocked_by_candidate_id,simulated_entry_at=x.simulated_entry_at,simulated_exit_at=x.simulated_exit_at
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,execution_status text,blocked_by_candidate_id uuid,simulated_entry_at timestamptz,simulated_exit_at timestamptz)
      WHERE tc.id=x.id`, [JSON.stringify(selections.map((selection) => ({ id: selection.id, execution_status: selection.executionStatus, blocked_by_candidate_id: selection.blockedByCandidateId, simulated_entry_at: selection.simulatedEntryAt, simulated_exit_at: selection.simulatedExitAt })))]);
  });
  return { accepted: selections.filter((selection) => selection.executionStatus === "accepted").length, overlapping: selections.filter((selection) => selection.executionStatus === "overlapping").length };
}

export async function refreshPositionAwareReplay(instrument?: string) {
  if (instrument && !isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  const instruments = instrument ? [instrument as MajorInstrument] : (await query<{ instrument: MajorInstrument }>(`SELECT DISTINCT se.instrument
    FROM strategy_evaluations se JOIN strategy_versions sv ON sv.id=se.strategy_version_id
    WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'
    ORDER BY se.instrument`, [ACTIVE_STRATEGY_VERSION])).rows.map((row) => row.instrument);
  const refreshed: Array<{ instrument: MajorInstrument; labeled: number; accepted: number; overlapping: number }> = [];
  for (const currentInstrument of instruments) {
    const version = await query<{ id: string }>("SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1", [ACTIVE_STRATEGY_VERSION]);
    if (!version.rows[0]) continue;
    const [candidateResult, quoteResult] = await Promise.all([
      query<CandidateForLabel>("SELECT tc.id,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical' AND se.status='valid' ORDER BY se.decision_time,tc.id", [version.rows[0].id, currentInstrument]),
      query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time", [currentInstrument]),
    ]);
    const quotes = quoteResult.rows.map(normalizeQuote);
    for (let index = 0; index < candidateResult.rows.length; index += 500) {
      const batch = candidateResult.rows.slice(index, index + 500).map((candidate) => {
        const decision = iso(candidate.decision_time);
        const start = lowerBoundQuotes(quotes, decision);
        const result = labelOutcome(candidate.direction, Number(candidate.entry), Number(candidate.stop), Number(candidate.target), decision, quotes.slice(start, start + 193));
        return { candidate_id: candidate.id, outcome: result.outcome, horizon_ends_at: result.horizonEndsAt, resolved_at: result.resolvedAt, result_r: result.resultR, max_favorable_r: result.maxFavorableR, max_adverse_r: result.maxAdverseR };
      });
      if (batch.length) await query(`INSERT INTO outcome_labels(candidate_id,outcome,horizon_ends_at,resolved_at,result_r,max_favorable_r,max_adverse_r) SELECT x.candidate_id,x.outcome,x.horizon_ends_at,x.resolved_at,x.result_r,x.max_favorable_r,x.max_adverse_r FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id uuid,outcome text,horizon_ends_at timestamptz,resolved_at timestamptz,result_r numeric,max_favorable_r numeric,max_adverse_r numeric) ON CONFLICT(candidate_id) DO UPDATE SET outcome=EXCLUDED.outcome,labeled_at=now(),horizon_ends_at=EXCLUDED.horizon_ends_at,resolved_at=EXCLUDED.resolved_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r`, [JSON.stringify(batch)]);
    }
    const positionAware = await rebuildPositionAwareCandidates(currentInstrument, version.rows[0].id);
    refreshed.push({ instrument: currentInstrument, labeled: candidateResult.rows.length, ...positionAware });
  }
  return refreshed;
}

async function shadowEvaluations(instrument?: MajorInstrument, versionId?: string) {
  const values: unknown[] = [ACTIVE_STRATEGY_VERSION];
  let filters = "";
  if (instrument) { values.push(instrument); filters += ` AND se.instrument=$${values.length}`; }
  if (versionId) { values.push(versionId); filters += ` AND se.strategy_version_id=$${values.length}`; }
  return query<ShadowForLabel>(`SELECT se.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,failure.failed_condition
    FROM strategy_evaluations se JOIN strategy_versions sv ON sv.id=se.strategy_version_id
    CROSS JOIN LATERAL (
      SELECT condition->>'name' AS failed_condition
      FROM jsonb_array_elements(se.conditions) condition
      WHERE condition->>'required'='true' AND condition->>'passed'='false'
    ) failure
    WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'
      AND se.conditions @> '[{"name":"Confirmation"}]'::jsonb
      AND se.direction IN ('long','short') AND se.entry IS NOT NULL AND se.stop IS NOT NULL AND se.target IS NOT NULL AND se.risk_reward IS NOT NULL
      AND (SELECT count(*) FROM jsonb_array_elements(se.conditions) item WHERE item->>'required'='true' AND item->>'passed'='false')=1${filters}
    ORDER BY se.instrument,se.decision_time`, values);
}

async function labelHistoricalShadowOutcomes(instrument?: MajorInstrument, versionId?: string) {
  const evaluations = (await shadowEvaluations(instrument, versionId)).rows;
  let labeled = 0;
  for (const currentInstrument of [...new Set(evaluations.map((evaluation) => evaluation.instrument))]) {
    const quoteResult = await query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' ORDER BY close_time", [currentInstrument]);
    const quotes = quoteResult.rows.map(normalizeQuote);
    const instrumentEvaluations = evaluations.filter((evaluation) => evaluation.instrument === currentInstrument);
    for (let index = 0; index < instrumentEvaluations.length; index += 500) {
      const batch = instrumentEvaluations.slice(index, index + 500).map((evaluation) => {
        const decision = iso(evaluation.decision_time);
        const start = lowerBoundQuotes(quotes, decision);
        const result = labelOutcome(evaluation.direction, Number(evaluation.entry), Number(evaluation.stop), Number(evaluation.target), decision, quotes.slice(start, start + 193));
        return { evaluation_id: evaluation.id, failed_condition: evaluation.failed_condition, outcome: result.outcome, horizon_ends_at: result.horizonEndsAt, result_r: result.resultR, max_favorable_r: result.maxFavorableR, max_adverse_r: result.maxAdverseR };
      });
      if (batch.length) await query(`INSERT INTO shadow_outcome_labels(evaluation_id,failed_condition,outcome,horizon_ends_at,result_r,max_favorable_r,max_adverse_r)
        SELECT x.evaluation_id,x.failed_condition,x.outcome,x.horizon_ends_at,x.result_r,x.max_favorable_r,x.max_adverse_r
        FROM jsonb_to_recordset($1::jsonb) AS x(evaluation_id uuid,failed_condition text,outcome text,horizon_ends_at timestamptz,result_r numeric,max_favorable_r numeric,max_adverse_r numeric)
        ON CONFLICT(evaluation_id) DO UPDATE SET failed_condition=EXCLUDED.failed_condition,outcome=EXCLUDED.outcome,labeled_at=now(),horizon_ends_at=EXCLUDED.horizon_ends_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r,method_version='single-required-failure-v1'`, [JSON.stringify(batch)]);
      labeled += batch.length;
    }
  }
  return labeled;
}

export async function refreshHistoricalShadowOutcomes(instrument?: string) {
  if (instrument && !isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  return { labeled: await labelHistoricalShadowOutcomes(instrument as MajorInstrument | undefined) };
}

async function executeStrictHistoricalBackfill(run: ResearchRun, instrument: MajorInstrument, months: number) {
  const cutoff = startDateForMonths(months);
  // H4 needs 210 completed bars. Sixty calendar days safely covers forex weekends
  // so the first decision inside the requested range has a full warm-up window.
  const dataCutoff = new Date(cutoff.getTime() - WARMUP_DAYS * 24 * 60 * 60_000);
  const rangeEnd = new Date();
  const fetched: Record<string, number> = {};
  const timeframeProgress: Record<string, number> = { M15: 0, H1: 0, H4: 0 };
  const collectionProgress = () => Math.round(Object.values(timeframeProgress).reduce((sum, value) => sum + value, 0) / HISTORICAL_TIMEFRAMES.length / 2);
  const baseDetails = { state: "running", phase: "Fetching completed OANDA bid/ask candles", instrument, months, fetched, timeframeProgress, progressPercent: 0, note: "Day-intraday price-only baseline. News is not evaluated." };
  try {
    await updateRun(run.id, baseDetails);
    for (const timeframe of HISTORICAL_TIMEFRAMES) {
      let cursor = rangeEnd;
      let total = 0;
      let previousOldest = Number.POSITIVE_INFINITY;
      while (true) {
        const completed = (await getResearchCandles(instrument, timeframe, 5_000, { to: cursor.toISOString() })).filter((candle) => candle.complete);
        if (!completed.length) throw new Error(`OANDA returned no completed ${timeframe} candles before ${cursor.toISOString()}.`);
        const oldestMilliseconds = Math.min(...completed.map((candle) => new Date(candle.time).getTime()));
        if (oldestMilliseconds >= previousOldest) throw new Error(`OANDA ${timeframe} pagination did not move backward.`);
        previousOldest = oldestMilliseconds;
        const inRange = completed.filter((candle) => new Date(candle.time).getTime() + timeframeMilliseconds(timeframe) >= dataCutoff.getTime());
        await saveResearchCandles(instrument, timeframe, inRange);
        total += inRange.length;
        fetched[timeframe] = total;
        const coveredMilliseconds = rangeEnd.getTime() - Math.max(dataCutoff.getTime(), oldestMilliseconds);
        timeframeProgress[timeframe] = Math.min(99, Math.max(0, Math.round((coveredMilliseconds / (rangeEnd.getTime() - dataCutoff.getTime())) * 100)));
        await updateRun(run.id, { ...baseDetails, fetched, timeframeProgress, progressPercent: collectionProgress(), timeframe });
        if (oldestMilliseconds <= dataCutoff.getTime()) break;
        cursor = new Date(oldestMilliseconds - 1);
      }
      timeframeProgress[timeframe] = 100;
    }
    await updateRun(run.id, { ...baseDetails, phase: "Preparing historical replay", fetched, timeframeProgress, progressPercent: 50 });
    const replay = await replayHistoricalStrategy(run.id, instrument, cutoff, dataCutoff, rangeEnd, { ...baseDetails, fetched, timeframeProgress });
    const labeled = await labelHistoricalOutcomes(run.id, instrument, replay.versionId, { ...baseDetails, fetched, timeframeProgress, replayed: replay.evaluated, validSetups: replay.valid });
    const positionAware = await rebuildPositionAwareCandidates(instrument, replay.versionId);
    await updateRun(run.id, { ...baseDetails, state: "running", phase: "Labeling full-pipeline shadow outcomes", fetched, timeframeProgress, replayed: replay.evaluated, validSetups: replay.valid, labeled, progressPercent: 99 });
    const shadowLabeled = 0;
    await updateRun(run.id, { ...baseDetails, state: "complete", phase: "Position-aware day-trading research complete", fetched, timeframeProgress, replayed: replay.evaluated, validSetups: replay.valid, labeled, acceptedCandidates: positionAware.accepted, overlappingCandidates: positionAware.overlapping, shadowLabeled, progressPercent: 100 }, null, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical research failed.";
    await updateRun(run.id, { ...baseDetails, state: "failed", phase: "Research failed", fetched, timeframeProgress }, message, true);
  } finally { activeBackfills.delete(run.id); }
}

type DurableResearchJob = { run_id: string; instrument: MajorInstrument; months: number; phase: string; checkpoint: Record<string, unknown>; lease_token: string; attempts: number };
type DurableCheckpoint = {
  rangeStart: string; dataStart: string; rangeEnd: string; decisionEnd?: string; timeframeIndex: number; cursor: string;
  sourceKind?: string; holdoutId?: string;
  fetched: Record<string, number>; timeframeProgress: Record<string, number>; versionId?: string;
  replayCursor?: string | null; replayed?: number; validSetups?: number;
  labelCursorTime?: string | null; labelCursorId?: string | null; labeled?: number;
  acceptedCandidates?: number; overlappingCandidates?: number;
  shadowCursorTime?: string | null; shadowCursorId?: string | null; shadowLabeled?: number;
};

function durableDetails(job: DurableResearchJob, checkpoint: DurableCheckpoint, phase: string, progressPercent: number, note = "Day-intraday price-only baseline. News is not evaluated.") {
  return { state: "running", durable: true, phase, instrument: job.instrument, months: job.months, fetched: checkpoint.fetched, timeframeProgress: checkpoint.timeframeProgress, replayed: checkpoint.replayed, validSetups: checkpoint.validSetups, labeled: checkpoint.labeled, acceptedCandidates: checkpoint.acceptedCandidates, overlappingCandidates: checkpoint.overlappingCandidates, shadowLabeled: checkpoint.shadowLabeled, progressPercent, note };
}

async function saveDurableCheckpoint(job: DurableResearchJob, phase: string, checkpoint: DurableCheckpoint, details: Record<string, unknown>) {
  const saved = await query("UPDATE durable_research_jobs SET status='queued',phase=$3,checkpoint=$4::jsonb,lease_token=NULL,lease_until=NULL,attempts=0,last_error=NULL,available_at=now()+interval '750 milliseconds',updated_at=now() WHERE run_id=$1 AND lease_token=$2 AND status='running' RETURNING run_id", [job.run_id, job.lease_token, phase, JSON.stringify(checkpoint)]);
  if (!saved.rowCount) throw new Error("Research job lease expired before its checkpoint was saved.");
  await updateRun(job.run_id, details);
}

async function claimDurableResearchJob() {
  const result = await query<DurableResearchJob>(`UPDATE durable_research_jobs SET status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now()
    WHERE run_id=(SELECT run_id FROM durable_research_jobs WHERE status IN('queued','running') AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING run_id,instrument,months,phase,checkpoint,lease_token,attempts`);
  return result.rows[0] ?? null;
}

function dateProgress(start: string, end: string, cursor: string) {
  const startMs = new Date(start).getTime(); const endMs = new Date(end).getTime(); const cursorMs = new Date(cursor).getTime();
  return Math.max(0, Math.min(1, (cursorMs - startMs) / (endMs - startMs)));
}

async function processCollectionUnit(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  const timeframe = HISTORICAL_TIMEFRAMES[checkpoint.timeframeIndex];
  if (!timeframe) {
    await saveDurableCheckpoint(job, "prepare_replay", checkpoint, durableDetails(job, checkpoint, "Preparing resumable replay", 50));
    return;
  }
  const completed = (await getResearchCandles(job.instrument, timeframe, 5_000, { to: checkpoint.cursor })).filter((candle) => candle.complete);
  if (!completed.length) throw new Error(`OANDA returned no completed ${timeframe} candles before ${checkpoint.cursor}.`);
  const oldestMilliseconds = Math.min(...completed.map((candle) => new Date(candle.time).getTime()));
  const dataStartMs = new Date(checkpoint.dataStart).getTime();
  const inRange = completed.filter((candle) => new Date(candle.time).getTime() + timeframeMilliseconds(timeframe) >= dataStartMs);
  await saveResearchCandles(job.instrument, timeframe, inRange);
  checkpoint.fetched[timeframe] = (checkpoint.fetched[timeframe] ?? 0) + inRange.length;
  const covered = (new Date(checkpoint.rangeEnd).getTime() - Math.max(dataStartMs, oldestMilliseconds)) / (new Date(checkpoint.rangeEnd).getTime() - dataStartMs);
  checkpoint.timeframeProgress[timeframe] = Math.min(100, Math.max(0, Math.round(covered * 100)));
  checkpoint.cursor = new Date(oldestMilliseconds - 1).toISOString();
  if (oldestMilliseconds <= dataStartMs) {
    checkpoint.timeframeProgress[timeframe] = 100;
    checkpoint.timeframeIndex += 1;
    checkpoint.cursor = checkpoint.rangeEnd;
  }
  const progress = Math.round(Object.values(checkpoint.timeframeProgress).reduce((sum, value) => sum + value, 0) / HISTORICAL_TIMEFRAMES.length / 2);
  await saveDurableCheckpoint(job, "collect", checkpoint, durableDetails(job, checkpoint, `Fetching ${timeframe} OANDA history`, progress));
}

async function prepareDurableReplay(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  const version = await query<{ id: string }>("INSERT INTO strategy_versions(name,version,configuration) VALUES('deterministic-forex',$1,$2::jsonb) ON CONFLICT(name,version) DO UPDATE SET configuration=strategy_versions.configuration || EXCLUDED.configuration RETURNING id", [ACTIVE_STRATEGY_VERSION, JSON.stringify({ timeframes: HISTORICAL_TIMEFRAMES, news: "not_evaluated", prices: "oanda_bid_ask", entrySessions: "London 08:00-17:00 Europe/London and New York 08:00-17:00 America/New_York", forcedExitEt: "16:45", holding: "same_day", macroReplay: "neutral_when_historical_rate_snapshot_unavailable" })]);
  checkpoint.versionId = version.rows[0]!.id;
  await query("DELETE FROM strategy_evaluations WHERE strategy_version_id=$1 AND instrument=$2 AND source_kind=$3", [checkpoint.versionId, job.instrument, checkpoint.sourceKind ?? "historical"]);
  await vacuumResearchTables();
  checkpoint.replayCursor = null; checkpoint.replayed = 0; checkpoint.validSetups = 0;
  await saveDurableCheckpoint(job, "replay", checkpoint, durableDetails(job, checkpoint, "Replaying deterministic strategy", 50, "Active dataset replaced; PostgreSQL research-table vacuum completed. News is not evaluated."));
}

async function processReplayUnit(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  const decisionEnd = checkpoint.decisionEnd ?? checkpoint.rangeEnd;
  const decisions = await query<{ close_time: string | Date }>(`SELECT close_time FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 AND ($4::timestamptz IS NULL OR close_time>$4) ORDER BY close_time LIMIT 500`, [job.instrument, checkpoint.rangeStart, decisionEnd, checkpoint.replayCursor ?? null]);
  if (!decisions.rows.length) {
    checkpoint.labelCursorTime = null; checkpoint.labelCursorId = null; checkpoint.labeled = 0;
    await saveDurableCheckpoint(job, "label_candidates", checkpoint, durableDetails(job, checkpoint, "Labeling candidate outcomes", 80));
    return;
  }
  const decisionTimes = decisions.rows.map((row) => iso(row.close_time));
  const batchStart = new Date(decisionTimes[0]!); const batchEnd = decisionTimes.at(-1)!;
  const windowStart = (days: number) => new Date(Math.max(new Date(checkpoint.dataStart).getTime(), batchStart.getTime() - days * 24 * 60 * 60_000));
  const [m15Result, h1Result, h4Result, quoteResult] = await Promise.all([
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [job.instrument, windowStart(10), batchEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H1' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [job.instrument, windowStart(20), batchEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H4' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [job.instrument, windowStart(60), batchEnd]),
    query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [job.instrument, windowStart(10), batchEnd]),
  ]);
  const m15 = m15Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "M15") }));
  const h1 = h1Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H1") }));
  const h4 = h4Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H4") }));
  const quoteByTime = new Map(quoteResult.rows.map((row) => { const quote = normalizeQuote(row); return [quote.closeTime, quote]; }));
  const records: ReplayRecord[] = [];
  for (const decision of decisionTimes) {
    const candles15m = m15.filter((item) => item.closeTime <= decision).slice(-REPLAY_WINDOW).map((item) => item.candle);
    const candles1h = h1.filter((item) => item.closeTime <= decision).slice(-REPLAY_WINDOW).map((item) => item.candle);
    const candles4h = h4.filter((item) => item.closeTime <= decision).slice(-REPLAY_WINDOW).map((item) => item.candle);
    const quote = quoteByTime.get(decision);
    if (!quote || candles15m.length < MINIMUM_CANDLES || candles1h.length < MINIMUM_CANDLES || candles4h.length < MINIMUM_CANDLES) throw new Error(`Completed replay windows are missing at ${decision}.`);
    records.push(evaluateReplayRecord(job.instrument, decision, candles15m, candles1h, candles4h, quote));
  }
  await persistReplayBatch(checkpoint.versionId!, job.instrument, records, checkpoint.sourceKind ?? "historical");
  checkpoint.replayed = (checkpoint.replayed ?? 0) + records.length;
  checkpoint.validSetups = (checkpoint.validSetups ?? 0) + records.filter((record) => record.status === "valid").length;
  checkpoint.replayCursor = decisionTimes.at(-1)!;
  const progress = 50 + Math.round(dateProgress(checkpoint.rangeStart, decisionEnd, checkpoint.replayCursor) * 30);
  await saveDurableCheckpoint(job, "replay", checkpoint, durableDetails(job, checkpoint, "Replaying deterministic strategy", progress));
}

async function processCandidateLabelUnit(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  const candidates = await query<CandidateForLabel>(`SELECT tc.id,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind=$3 AND se.status='valid' AND ($4::timestamptz IS NULL OR (se.decision_time,tc.id) > ($4,$5::uuid)) ORDER BY se.decision_time,tc.id LIMIT 500`, [checkpoint.versionId, job.instrument, checkpoint.sourceKind ?? "historical", checkpoint.labelCursorTime ?? null, checkpoint.labelCursorId ?? null]);
  if (!candidates.rows.length) {
    await saveDurableCheckpoint(job, "position_aware", checkpoint, durableDetails(job, checkpoint, "Building one-position-at-a-time replay", 89));
    return;
  }
  const first = iso(candidates.rows[0]!.decision_time); const last = iso(candidates.rows.at(-1)!.decision_time);
  const quotes = (await query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time>$2 AND close_time<=$3 ORDER BY close_time", [job.instrument, first, new Date(new Date(last).getTime() + OUTCOME_HOURS * 60 * 60_000)])).rows.map(normalizeQuote);
  const batch = candidates.rows.map((candidate) => {
    const decision = iso(candidate.decision_time); const result = labelOutcome(candidate.direction, Number(candidate.entry), Number(candidate.stop), Number(candidate.target), decision, quotes.slice(lowerBoundQuotes(quotes, decision)));
    return { candidate_id: candidate.id, outcome: result.outcome, horizon_ends_at: result.horizonEndsAt, resolved_at: result.resolvedAt, result_r: result.resultR, max_favorable_r: result.maxFavorableR, max_adverse_r: result.maxAdverseR };
  });
  await query(`INSERT INTO outcome_labels(candidate_id,outcome,horizon_ends_at,resolved_at,result_r,max_favorable_r,max_adverse_r) SELECT x.candidate_id,x.outcome,x.horizon_ends_at,x.resolved_at,x.result_r,x.max_favorable_r,x.max_adverse_r FROM jsonb_to_recordset($1::jsonb) AS x(candidate_id uuid,outcome text,horizon_ends_at timestamptz,resolved_at timestamptz,result_r numeric,max_favorable_r numeric,max_adverse_r numeric) ON CONFLICT(candidate_id) DO UPDATE SET outcome=EXCLUDED.outcome,labeled_at=now(),horizon_ends_at=EXCLUDED.horizon_ends_at,resolved_at=EXCLUDED.resolved_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r`, [JSON.stringify(batch)]);
  checkpoint.labeled = (checkpoint.labeled ?? 0) + batch.length; checkpoint.labelCursorTime = last; checkpoint.labelCursorId = candidates.rows.at(-1)!.id;
  await saveDurableCheckpoint(job, "label_candidates", checkpoint, durableDetails(job, checkpoint, "Labeling candidate outcomes", 85));
}

async function finalizeLockedHoldout(holdoutId: string, instrument: MajorInstrument, versionId: string, sourceKind: string) {
  const holdout = await query<{ id: string; direction: ExperimentDirection; sessions: ResearchSession[]; range_start: string | Date; range_end: string | Date }>("SELECT id,direction,sessions,range_start,range_end FROM research_holdouts WHERE id=$1", [holdoutId]);
  if (!holdout.rows[0]) throw new Error("Locked holdout record was not found.");
  const definition = holdout.rows[0];
  const candidates = await query<ExperimentCandidateRow>(`SELECT tc.id,se.decision_time,se.direction,se.conditions,ol.outcome,ol.result_r,ol.resolved_at,ol.horizon_ends_at
    FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind=$3
    ORDER BY se.decision_time,tc.id`, [versionId, instrument, sourceKind]);
  const eligible = candidates.rows.filter((candidate) => (definition.direction === "all" || candidate.direction === definition.direction) && definition.sessions.includes(candidateSession(candidate) as ResearchSession));
  const selections = selectPositionAwareCandidates(eligible.map((candidate) => ({ id: candidate.id, decisionTime: iso(candidate.decision_time), resolvedAt: candidate.resolved_at ? iso(candidate.resolved_at) : null, horizonEndsAt: iso(candidate.horizon_ends_at) })));
  const byId = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  const accepted = selections.filter((selection) => selection.executionStatus === "accepted").map((selection) => byId.get(selection.id)!);
  const rawResults = outcomeResults(eligible, "resolved_only");
  const executableResults = outcomeResults(accepted, "resolved_only");
  const summary = {
    raw_candidates: eligible.length,
    executable_candidates: accepted.length,
    overlapping_candidates: selections.filter((selection) => selection.executionStatus === "overlapping").length,
    target_first: accepted.filter((candidate) => candidate.outcome === "target_first").length,
    stop_first: accepted.filter((candidate) => candidate.outcome === "stop_first").length,
    unresolved: accepted.filter((candidate) => candidate.outcome === "unresolved").length,
    ambiguous: accepted.filter((candidate) => candidate.outcome === "ambiguous").length,
    raw_baseline: resultMetrics(rawResults),
    executable: resultMetrics(executableResults),
    conservative: resultMetrics(outcomeResults(accepted, "conservative")),
    coverage_start: iso(definition.range_start),
    coverage_end: iso(definition.range_end),
  };
  await transaction(async (client) => {
    await client.query(`UPDATE trade_candidates tc SET execution_status='pending',blocked_by_candidate_id=NULL,simulated_entry_at=NULL,simulated_exit_at=NULL
      FROM strategy_evaluations se WHERE se.id=tc.evaluation_id AND se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind=$3`, [versionId, instrument, sourceKind]);
    if (selections.length) await client.query(`UPDATE trade_candidates tc SET execution_status=x.execution_status,blocked_by_candidate_id=x.blocked_by_candidate_id,simulated_entry_at=x.simulated_entry_at,simulated_exit_at=x.simulated_exit_at
      FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,execution_status text,blocked_by_candidate_id uuid,simulated_entry_at timestamptz,simulated_exit_at timestamptz)
      WHERE tc.id=x.id`, [JSON.stringify(selections.map((selection) => ({ id: selection.id, execution_status: selection.executionStatus, blocked_by_candidate_id: selection.blockedByCandidateId, simulated_entry_at: selection.simulatedEntryAt, simulated_exit_at: selection.simulatedExitAt })))]);
    await client.query("DELETE FROM research_holdout_trades WHERE holdout_id=$1", [holdoutId]);
    if (selections.length) await client.query(`INSERT INTO research_holdout_trades(holdout_id,candidate_id,execution_status,blocked_by_candidate_id,simulated_entry_at,simulated_exit_at)
      SELECT $1,x.candidate_id,x.execution_status,x.blocked_by_candidate_id,x.simulated_entry_at,x.simulated_exit_at
      FROM jsonb_to_recordset($2::jsonb) AS x(candidate_id uuid,execution_status text,blocked_by_candidate_id uuid,simulated_entry_at timestamptz,simulated_exit_at timestamptz)`, [holdoutId, JSON.stringify(selections.map((selection) => ({ candidate_id: selection.id, execution_status: selection.executionStatus, blocked_by_candidate_id: selection.blockedByCandidateId, simulated_entry_at: selection.simulatedEntryAt, simulated_exit_at: selection.simulatedExitAt })))]);
    await client.query("UPDATE research_holdouts SET status='complete',summary=$2::jsonb,error=NULL,completed_at=now() WHERE id=$1", [holdoutId, JSON.stringify(summary)]);
  });
  return { accepted: accepted.length, overlapping: selections.length - accepted.length, summary };
}

async function completeDurableHoldoutJob(job: DurableResearchJob, checkpoint: DurableCheckpoint, completed: { accepted: number; overlapping: number }) {
  await query("UPDATE durable_research_jobs SET status='complete',phase='complete',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE run_id=$1 AND lease_token=$2", [job.run_id, job.lease_token]);
  await updateRun(job.run_id, { ...durableDetails(job, checkpoint, "Locked historical holdout complete", 100), state: "complete", acceptedCandidates: completed.accepted, overlappingCandidates: completed.overlapping, note: "Locked holdout complete. The original experiment configuration was replayed without rule changes; news was not evaluated." }, null, true);
}

async function processPositionAwareUnit(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  if (checkpoint.holdoutId) {
    const completed = await finalizeLockedHoldout(checkpoint.holdoutId, job.instrument, checkpoint.versionId!, checkpoint.sourceKind ?? "historical");
    checkpoint.acceptedCandidates = completed.accepted;
    checkpoint.overlappingCandidates = completed.overlapping;
    await completeDurableHoldoutJob(job, checkpoint, completed);
    return;
  }
  const positionAware = await rebuildPositionAwareCandidates(job.instrument, checkpoint.versionId!);
  checkpoint.acceptedCandidates = positionAware.accepted;
  checkpoint.overlappingCandidates = positionAware.overlapping;
  await query("UPDATE durable_research_jobs SET status='complete',phase='complete',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE run_id=$1 AND lease_token=$2", [job.run_id, job.lease_token]);
  await updateRun(job.run_id, { ...durableDetails(job, checkpoint, "Day-trading research complete", 100, "Active price-only research complete. Detailed shadow outcomes are disabled to control storage."), state: "complete", acceptedCandidates: positionAware.accepted, overlappingCandidates: positionAware.overlapping, shadowLabeled: 0 }, null, true);
}

async function processShadowLabelUnit(job: DurableResearchJob, checkpoint: DurableCheckpoint) {
  const shadows = await query<ShadowForLabel>(`SELECT se.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,failure.failed_condition FROM strategy_evaluations se CROSS JOIN LATERAL (SELECT condition->>'name' AS failed_condition FROM jsonb_array_elements(se.conditions) condition WHERE condition->>'required'='true' AND condition->>'passed'='false') failure WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical' AND se.conditions @> '[{"name":"Confirmation"}]'::jsonb AND se.direction IN('long','short') AND se.entry IS NOT NULL AND se.stop IS NOT NULL AND se.target IS NOT NULL AND se.risk_reward IS NOT NULL AND (SELECT count(*) FROM jsonb_array_elements(se.conditions) item WHERE item->>'required'='true' AND item->>'passed'='false')=1 AND ($3::timestamptz IS NULL OR (se.decision_time,se.id) > ($3,$4::uuid)) ORDER BY se.decision_time,se.id LIMIT 500`, [checkpoint.versionId, job.instrument, checkpoint.shadowCursorTime ?? null, checkpoint.shadowCursorId ?? null]);
  if (!shadows.rows.length) {
    await query("UPDATE durable_research_jobs SET status='complete',phase='complete',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE run_id=$1 AND lease_token=$2", [job.run_id, job.lease_token]);
    await updateRun(job.run_id, { ...durableDetails(job, checkpoint, "Multi-year day-trading research complete", 100), state: "complete" }, null, true);
    return;
  }
  const first = iso(shadows.rows[0]!.decision_time); const last = iso(shadows.rows.at(-1)!.decision_time);
  const quotes = (await query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time>$2 AND close_time<=$3 ORDER BY close_time", [job.instrument, first, new Date(new Date(last).getTime() + OUTCOME_HOURS * 60 * 60_000)])).rows.map(normalizeQuote);
  const batch = shadows.rows.map((shadow) => {
    const decision = iso(shadow.decision_time); const result = labelOutcome(shadow.direction, Number(shadow.entry), Number(shadow.stop), Number(shadow.target), decision, quotes.slice(lowerBoundQuotes(quotes, decision)));
    return { evaluation_id: shadow.id, failed_condition: shadow.failed_condition, outcome: result.outcome, horizon_ends_at: result.horizonEndsAt, result_r: result.resultR, max_favorable_r: result.maxFavorableR, max_adverse_r: result.maxAdverseR };
  });
  await query(`INSERT INTO shadow_outcome_labels(evaluation_id,failed_condition,outcome,horizon_ends_at,result_r,max_favorable_r,max_adverse_r) SELECT x.evaluation_id,x.failed_condition,x.outcome,x.horizon_ends_at,x.result_r,x.max_favorable_r,x.max_adverse_r FROM jsonb_to_recordset($1::jsonb) AS x(evaluation_id uuid,failed_condition text,outcome text,horizon_ends_at timestamptz,result_r numeric,max_favorable_r numeric,max_adverse_r numeric) ON CONFLICT(evaluation_id) DO UPDATE SET failed_condition=EXCLUDED.failed_condition,outcome=EXCLUDED.outcome,labeled_at=now(),horizon_ends_at=EXCLUDED.horizon_ends_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r,method_version='single-required-failure-v1'`, [JSON.stringify(batch)]);
  checkpoint.shadowLabeled = (checkpoint.shadowLabeled ?? 0) + batch.length; checkpoint.shadowCursorTime = last; checkpoint.shadowCursorId = shadows.rows.at(-1)!.id;
  await saveDurableCheckpoint(job, "label_shadows", checkpoint, durableDetails(job, checkpoint, "Labeling full-pipeline shadow outcomes", 95));
}

async function failDurableUnit(job: DurableResearchJob, error: unknown) {
  const message = error instanceof Error ? error.message : "Durable research unit failed.";
  const holdoutId = (job.checkpoint as DurableCheckpoint).holdoutId;
  const attempts = job.attempts + 1;
  if (attempts < 5) {
    const delaySeconds = Math.min(300, 2 ** attempts * 5);
    await query("UPDATE durable_research_jobs SET status='queued',lease_token=NULL,lease_until=NULL,attempts=$3,last_error=$4,available_at=now()+($5 || ' seconds')::interval,updated_at=now() WHERE run_id=$1 AND lease_token=$2", [job.run_id, job.lease_token, attempts, message, String(delaySeconds)]);
    await updateRun(job.run_id, { state: "running", durable: true, phase: "Retrying a saved research step", instrument: job.instrument, months: job.months, note: message });
  } else {
    await query("UPDATE durable_research_jobs SET status='failed',lease_token=NULL,lease_until=NULL,attempts=$3,last_error=$4,updated_at=now() WHERE run_id=$1 AND lease_token=$2", [job.run_id, job.lease_token, attempts, message]);
    if (holdoutId) await query("UPDATE research_holdouts SET status='failed',error=$2,completed_at=now() WHERE id=$1", [holdoutId, message]);
    await updateRun(job.run_id, { state: "failed", durable: true, phase: "Research failed after bounded retries", instrument: job.instrument, months: job.months }, message, true);
  }
}

export async function processNextResearchJob() {
  const job = await claimDurableResearchJob();
  if (!job) return { processed: false };
  const checkpoint = job.checkpoint as DurableCheckpoint;
  try {
    if (checkpoint.holdoutId) await query("UPDATE research_holdouts SET status='running',error=NULL WHERE id=$1 AND status='queued'", [checkpoint.holdoutId]);
    if (job.phase === "collect") await processCollectionUnit(job, checkpoint);
    else if (job.phase === "prepare_replay") await prepareDurableReplay(job, checkpoint);
    else if (job.phase === "replay") await processReplayUnit(job, checkpoint);
    else if (job.phase === "label_candidates") await processCandidateLabelUnit(job, checkpoint);
    else if (job.phase === "position_aware") await processPositionAwareUnit(job, checkpoint);
    else if (job.phase === "label_shadows") await processShadowLabelUnit(job, checkpoint);
    else throw new Error(`Unknown durable research phase: ${job.phase}`);
    return { processed: true, runId: job.run_id, phase: job.phase };
  } catch (error) { await failDurableUnit(job, error); return { processed: false, runId: job.run_id, error }; }
}

export async function startStrictHistoricalBackfill(instrument: string, months = 12) {
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  const safeMonths = [12, 36, 60].includes(Math.floor(months)) ? Math.floor(months) : 12;
  const existing = await query<ResearchRun>("SELECT id,kind,started_at,completed_at,details,error FROM research_runs WHERE kind='historical_backfill' AND details->>'instrument'=$1 AND details->>'state' IN ('queued','running') ORDER BY started_at DESC LIMIT 1", [instrument]);
  if (existing.rows[0]) {
    const durable = await query<{ status: string }>("SELECT status FROM durable_research_jobs WHERE run_id=$1", [existing.rows[0].id]);
    if (durable.rows[0] && ["queued", "running"].includes(durable.rows[0].status)) return existing.rows[0];
    if (activeBackfills.has(existing.rows[0].id)) return existing.rows[0];
    await markInterrupted(existing.rows[0]);
  }
  await query("INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING", [instrument, displayNameFor(instrument), precisionFor(instrument)]);
  const rangeEnd = new Date(); const rangeStart = startDateForMonths(safeMonths); const dataStart = new Date(rangeStart.getTime() - WARMUP_DAYS * 24 * 60 * 60_000);
  const details = { state: "queued", durable: true, phase: "Waiting for the research worker", instrument, months: safeMonths, fetched: {}, timeframeProgress: { M15: 0, H1: 0, H4: 0 }, progressPercent: 0, note: "Day-intraday price-only baseline. News is not evaluated." };
  const created = await query<ResearchRun>("INSERT INTO research_runs(kind,details) VALUES('historical_backfill',$1::jsonb) RETURNING id,kind,started_at,completed_at,details,error", [JSON.stringify(details)]);
  const run = created.rows[0]!;
  const checkpoint: DurableCheckpoint = { rangeStart: rangeStart.toISOString(), dataStart: dataStart.toISOString(), rangeEnd: rangeEnd.toISOString(), timeframeIndex: 0, cursor: rangeEnd.toISOString(), fetched: {}, timeframeProgress: { M15: 0, H1: 0, H4: 0 } };
  await query("INSERT INTO durable_research_jobs(run_id,instrument,months,checkpoint) VALUES($1,$2,$3,$4::jsonb)", [run.id, instrument, safeMonths, JSON.stringify(checkpoint)]);
  return run;
}

export async function stopResearchRun(instrument: string) {
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported currency pair.");
  return transaction(async (client) => {
    const job = await client.query<{ run_id: string }>("SELECT run_id FROM durable_research_jobs WHERE instrument=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [instrument]);
    if (!job.rows[0]) return null;
    await client.query("UPDATE durable_research_jobs SET status='cancelled',phase='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE run_id=$1", [job.rows[0].run_id]);
    const result = await client.query<ResearchRun>(`UPDATE research_runs
      SET details=jsonb_set(jsonb_set(details,'{state}','"stopped"'::jsonb),'{phase}','"Research stopped by owner"'::jsonb),
          error='Research stopped by owner.', completed_at=now()
      WHERE id=$1
      RETURNING id,kind,started_at,completed_at,details,error`, [job.rows[0].run_id]);
    return result.rows[0] ?? null;
  });
}

export type ResearchHoldout = {
  id: string; source_experiment_id: string; run_id: string | null; instrument: string; direction: ExperimentDirection; sessions: ResearchSession[];
  range_start: string | Date; range_end: string | Date; configuration: Record<string, unknown>; status: "queued" | "running" | "complete" | "failed";
  summary: Record<string, unknown> | null; error: string | null; created_at: string | Date; completed_at: string | Date | null;
};

export async function latestResearchHoldout(userId: string, sourceExperimentId: string) {
  const result = await query<ResearchHoldout>("SELECT id,source_experiment_id,run_id,instrument,direction,sessions,range_start,range_end,configuration,status,summary,error,created_at,completed_at FROM research_holdouts WHERE user_id=$1 AND source_experiment_id=$2", [userId, sourceExperimentId]);
  const holdout = result.rows[0] ?? null;
  if (!holdout) return { holdout: null, run: null };
  const run = holdout.run_id ? await query<ResearchRun>("SELECT id,kind,started_at,completed_at,details,error FROM research_runs WHERE id=$1", [holdout.run_id]) : null;
  return { holdout, run: run?.rows[0] ?? null };
}

export async function startLockedResearchHoldout(userId: string, sourceExperimentId: string) {
  const existing = await latestResearchHoldout(userId, sourceExperimentId);
  if (existing.holdout && existing.holdout.status !== "failed") return existing;
  const source = await query<ResearchExperiment>("SELECT id,instrument,direction,sessions,lookback_months,experiment_version,configuration,summary,decision,decision_note,decided_at,created_at,completed_at FROM research_experiments WHERE id=$1 AND user_id=$2", [sourceExperimentId, userId]);
  const experiment = source.rows[0];
  if (!experiment) throw new Error("Save the research experiment before starting a locked holdout.");
  const developmentStart = typeof experiment.summary.coverage_start === "string" ? new Date(experiment.summary.coverage_start) : null;
  if (!developmentStart || Number.isNaN(developmentStart.getTime())) throw new Error("The saved experiment does not have a valid development range.");
  const holdoutEnd = new Date(developmentStart.getTime() - timeframeMilliseconds("M15"));
  const holdoutStart = new Date(holdoutEnd);
  holdoutStart.setUTCMonth(holdoutStart.getUTCMonth() - experiment.lookback_months);
  const dataStart = new Date(holdoutStart.getTime() - WARMUP_DAYS * 24 * 60 * 60_000);
  const collectionEnd = new Date(holdoutEnd.getTime() + OUTCOME_HOURS * 60 * 60_000);
  const configuration = {
    locked: true,
    sourceExperimentId: experiment.id,
    sourceExperimentVersion: experiment.experiment_version,
    baseStrategyVersion: ACTIVE_STRATEGY_VERSION,
    instrument: experiment.instrument,
    direction: experiment.direction,
    sessions: experiment.sessions,
    oneOpenPositionPerPair: true,
    strategyRulesChanged: false,
    news: "not_evaluated",
    holdoutRange: { start: holdoutStart.toISOString(), end: holdoutEnd.toISOString() },
  };
  await query("INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING", [experiment.instrument, displayNameFor(experiment.instrument as MajorInstrument), precisionFor(experiment.instrument as MajorInstrument)]);
  if (existing.holdout?.status === "failed") await query("DELETE FROM research_holdouts WHERE id=$1", [existing.holdout.id]);
  const created = await query<ResearchHoldout>(`INSERT INTO research_holdouts(user_id,source_experiment_id,strategy_version_id,instrument,direction,sessions,range_start,range_end,configuration,status)
    SELECT $1,$2,sv.id,$3,$4,$5,$6,$7,$8::jsonb,'queued' FROM strategy_versions sv WHERE sv.name='deterministic-forex' AND sv.version=$9
    RETURNING id,source_experiment_id,run_id,instrument,direction,sessions,range_start,range_end,configuration,status,summary,error,created_at,completed_at`, [userId, experiment.id, experiment.instrument, experiment.direction, experiment.sessions, holdoutStart.toISOString(), holdoutEnd.toISOString(), JSON.stringify(configuration), ACTIVE_STRATEGY_VERSION]);
  const holdout = created.rows[0];
  if (!holdout) throw new Error("Run the price-only baseline before starting a locked holdout.");
  const details = { state: "queued", durable: true, phase: "Waiting for locked holdout worker", instrument: experiment.instrument, months: experiment.lookback_months, fetched: {}, timeframeProgress: { M15: 0, H1: 0, H4: 0 }, progressPercent: 0, note: "Locked earlier holdout. The saved experiment rules cannot be changed; news is not evaluated.", holdoutId: holdout.id, rangeStart: holdoutStart.toISOString(), rangeEnd: holdoutEnd.toISOString() };
  const run = (await query<ResearchRun>("INSERT INTO research_runs(kind,details) VALUES('locked_holdout_backfill',$1::jsonb) RETURNING id,kind,started_at,completed_at,details,error", [JSON.stringify(details)])).rows[0]!;
  await query("UPDATE research_holdouts SET run_id=$2 WHERE id=$1", [holdout.id, run.id]);
  const checkpoint: DurableCheckpoint = { rangeStart: holdoutStart.toISOString(), dataStart: dataStart.toISOString(), rangeEnd: collectionEnd.toISOString(), decisionEnd: holdoutEnd.toISOString(), timeframeIndex: 0, cursor: collectionEnd.toISOString(), sourceKind: `holdout:${holdout.id}`, holdoutId: holdout.id, fetched: {}, timeframeProgress: { M15: 0, H1: 0, H4: 0 } };
  await query("INSERT INTO durable_research_jobs(run_id,instrument,months,checkpoint) VALUES($1,$2,$3,$4::jsonb)", [run.id, experiment.instrument, experiment.lookback_months, JSON.stringify(checkpoint)]);
  return { holdout: { ...holdout, run_id: run.id }, run };
}

export async function latestResearchRun(instrument?: string) {
  const result = await query<ResearchRun>(instrument ? "SELECT id,kind,started_at,completed_at,details,error FROM research_runs WHERE kind='historical_backfill' AND details->>'instrument'=$1 ORDER BY started_at DESC LIMIT 1" : "SELECT id,kind,started_at,completed_at,details,error FROM research_runs WHERE kind='historical_backfill' ORDER BY started_at DESC LIMIT 1", instrument ? [instrument] : []);
  const run = result.rows[0];
  if (run && ["queued", "running"].includes(String(run.details.state))) {
    const durable = await query<{ status: string }>("SELECT status FROM durable_research_jobs WHERE run_id=$1", [run.id]);
    if (durable.rows[0] && ["queued", "running"].includes(durable.rows[0].status)) return run;
    if (activeBackfills.has(run.id)) return run;
    return markInterrupted(run);
  }
  if (run?.details.state === "complete" && run.details.replayed === undefined) return { ...run, details: { ...run.details, state: "incomplete", phase: "Candle collection only — replay required", progressPercent: 50, note: "This older run downloaded candles but did not replay or label the strategy. Start research again to create the price-only baseline." } };
  return run ?? null;
}

async function markInterrupted(run: ResearchRun) {
  const details = { ...run.details, state: "failed", phase: "Research interrupted", note: "The API restarted before this run completed. Start a new run to resume safely.", updatedAt: new Date().toISOString() };
  const result = await query<ResearchRun>("UPDATE research_runs SET details=$2::jsonb,error='Research was interrupted by an API restart.',completed_at=now() WHERE id=$1 RETURNING id,kind,started_at,completed_at,details,error", [run.id, JSON.stringify(details)]);
  return result.rows[0]!;
}

export type LabelingMode = "resolved_only" | "conservative";
const RESOLVED_OUTCOMES = new Set(["target_first", "stop_first", "forced_close"]);

/**
 * `resolved_only` is the original reporting basis: only trades that reached the
 * target or the stop. It silently drops ambiguous bars and timed-out trades,
 * and both of those lean toward losses, so it reads optimistically.
 * `conservative` counts every row that carries a result. Comparing the two is
 * the point — an edge that exists only under `resolved_only` is a measurement
 * artifact, not an edge.
 */
function outcomeResults(rows: Array<{ outcome: string; result_r: string | number | null }>, mode: LabelingMode) {
  return rows
    .filter((row) => row.result_r !== null && (mode === "conservative" || RESOLVED_OUTCOMES.has(row.outcome)))
    .map((row) => Number(row.result_r))
    .filter((value) => Number.isFinite(value));
}

function resultMetrics(results: number[]) {
  const wins = results.filter((value) => value > 0);
  const losses = results.filter((value) => value < 0);
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const result of results) { equity += result; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  return { sample_size: results.length, win_rate: results.length ? wins.length / results.length : null, average_r: results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : null, expectancy: results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : null, profit_factor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null, drawdown_r: maxDrawdown };
}

type WalkForwardCandidate = ExperimentCandidateRow & { entry: string; stop: string };
type WalkForwardSelection = { direction: ExperimentDirection; sessions: ResearchSession[]; training: ReturnType<typeof resultMetrics>; test: ReturnType<typeof resultMetrics>; testCandidates: number; stress: Array<{ extra_pips: number; metrics: ReturnType<typeof resultMetrics> }> };

function sessionCombinations() {
  return Array.from({ length: 2 ** RESEARCH_SESSIONS.length - 1 }, (_, mask) => RESEARCH_SESSIONS.filter((_, index) => (mask & (1 << index)) !== 0));
}

function filterExperimentCandidates(candidates: WalkForwardCandidate[], direction: ExperimentDirection, sessions: ResearchSession[]) {
  return candidates.filter((candidate) => (direction === "all" || candidate.direction === direction) && sessions.includes(candidateSession(candidate) as ResearchSession));
}

function positionAwareResults(candidates: WalkForwardCandidate[]) {
  const selected = selectPositionAwareCandidates(candidates.map((candidate) => ({ id: candidate.id, decisionTime: iso(candidate.decision_time), resolvedAt: candidate.resolved_at ? iso(candidate.resolved_at) : null, horizonEndsAt: iso(candidate.horizon_ends_at) })));
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted = selected.filter((item) => item.executionStatus === "accepted").map((item) => byId.get(item.id)!);
  return { accepted, metrics: resultMetrics(accepted.filter((candidate) => RESOLVED_OUTCOMES.has(candidate.outcome)).map((candidate) => Number(candidate.result_r))) };
}

function stressMetrics(candidates: WalkForwardCandidate[], instrument: MajorInstrument, extraPips: number) {
  const results = candidates.filter((candidate) => RESOLVED_OUTCOMES.has(candidate.outcome)).map((candidate) => Number(candidate.result_r) - extraPips / (Math.abs(Number(candidate.entry) - Number(candidate.stop)) / pipSizeFor(instrument)));
  return resultMetrics(results);
}

export type ResearchWalkForwardRun = { id: string; instrument: string; configuration: Record<string, unknown>; summary: { folds: Array<{ train_start: string; train_end: string; test_start: string; test_end: string; selected: WalkForwardSelection | null }>; aggregate: ReturnType<typeof resultMetrics>; stress: Array<{ extra_pips: number; metrics: ReturnType<typeof resultMetrics> }>; forced_session_exits?: number; validation_status?: "passed" | "failed" | "insufficient_sample"; warning: string }; created_at: string | Date };

export async function runWalkForwardResearch(userId: string, requestedInstrument: string) {
  const instrument = requestedInstrument.toUpperCase() as MajorInstrument;
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  const version = await query<{ id: string }>("SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1", [ACTIVE_STRATEGY_VERSION]);
  if (!version.rows[0]) throw new Error("Run price-only research before walk-forward testing.");
  const coverage = await query<{ first_close: string | Date | null; last_close: string | Date | null }>("SELECT min(close_time) AS first_close,max(close_time) AS last_close FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda'", [instrument]);
  if (!coverage.rows[0]?.first_close || !coverage.rows[0]?.last_close) throw new Error("At least four years of OANDA history are required for walk-forward testing.");
  const candidates = await query<WalkForwardCandidate>(`SELECT tc.id,se.decision_time,se.direction,se.conditions,se.entry,se.stop,ol.outcome,ol.result_r,ol.resolved_at,ol.horizon_ends_at
    FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND (se.source_kind='historical' OR se.source_kind LIKE 'holdout:%')
    ORDER BY se.decision_time,tc.id`, [version.rows[0].id, instrument]);
  const configurations = (["all", "long", "short"] as ExperimentDirection[]).flatMap((direction) => sessionCombinations().map((sessions) => ({ direction, sessions })));
  const trainMonths = 36; const testMonths = 12; const minimumTrainingResolved = 8;
  const coverageEnd = new Date(coverage.rows[0].last_close);
  let trainStart = new Date(coverage.rows[0].first_close);
  const folds: ResearchWalkForwardRun["summary"]["folds"] = [];
  const aggregateCandidates: WalkForwardCandidate[] = [];
  while (true) {
    const trainEnd = new Date(trainStart); trainEnd.setUTCMonth(trainEnd.getUTCMonth() + trainMonths);
    const testEnd = new Date(trainEnd); testEnd.setUTCMonth(testEnd.getUTCMonth() + testMonths);
    if (testEnd > coverageEnd) break;
    const trainingRows = candidates.rows.filter((candidate) => new Date(candidate.decision_time) >= trainStart && new Date(candidate.decision_time) < trainEnd);
    const ranked = configurations.map((configuration) => ({ ...configuration, ...positionAwareResults(filterExperimentCandidates(trainingRows, configuration.direction, configuration.sessions)) }))
      .filter((candidate) => candidate.metrics.sample_size >= minimumTrainingResolved)
      .sort((left, right) => (right.metrics.average_r ?? -Infinity) - (left.metrics.average_r ?? -Infinity) || right.metrics.sample_size - left.metrics.sample_size);
    const selected = ranked[0];
    if (!selected) { folds.push({ train_start: trainStart.toISOString(), train_end: trainEnd.toISOString(), test_start: trainEnd.toISOString(), test_end: testEnd.toISOString(), selected: null }); trainStart = new Date(trainEnd); continue; }
    const testRows = filterExperimentCandidates(candidates.rows.filter((candidate) => new Date(candidate.decision_time) >= trainEnd && new Date(candidate.decision_time) < testEnd), selected.direction, selected.sessions);
    const test = positionAwareResults(testRows);
    aggregateCandidates.push(...test.accepted);
    folds.push({ train_start: trainStart.toISOString(), train_end: trainEnd.toISOString(), test_start: trainEnd.toISOString(), test_end: testEnd.toISOString(), selected: { direction: selected.direction, sessions: selected.sessions, training: selected.metrics, test: test.metrics, testCandidates: test.accepted.length, stress: [0.2, 0.5].map((extra_pips) => ({ extra_pips, metrics: stressMetrics(test.accepted, instrument, extra_pips) })) } });
    trainStart = new Date(trainEnd);
  }
  if (!folds.length) throw new Error("Not enough complete history for a 3-year train / 1-year test walk-forward run.");
  const summary = { folds, aggregate: resultMetrics(aggregateCandidates.filter((candidate) => RESOLVED_OUTCOMES.has(candidate.outcome)).map((candidate) => Number(candidate.result_r))), stress: [0.2, 0.5].map((extra_pips) => ({ extra_pips, metrics: stressMetrics(aggregateCandidates, instrument, extra_pips) })), warning: "Walk-forward selections are made from a fixed 21-configuration direction/session grid using only the preceding 36 months. Stress metrics deduct extra execution cost from resolved outcomes; they do not re-simulate intrabar fills." };
  const configuration = { version: "walk-forward-v1", trainMonths, testMonths, minimumTrainingResolved, candidatesEvaluated: configurations.length, sourceKinds: ["historical", "holdout"], strategyRulesChanged: false, news: "not_evaluated" };
  const saved = await query<ResearchWalkForwardRun>("INSERT INTO research_walk_forward_runs(user_id,strategy_version_id,instrument,configuration,summary) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id,instrument,configuration,summary,created_at", [userId, version.rows[0].id, instrument, JSON.stringify(configuration), JSON.stringify(summary)]);
  return saved.rows[0]!;
}

export async function latestWalkForwardResearch(userId: string, instrument: string) {
  const result = await query<ResearchWalkForwardRun>("SELECT id,instrument,configuration,summary,created_at FROM research_walk_forward_runs WHERE user_id=$1 AND instrument=$2 ORDER BY created_at DESC LIMIT 1", [userId, instrument]);
  return result.rows[0] ?? null;
}

/**
 * Fixed 4-year development / 1-year out-of-sample validation for the active
 * day strategy. Unlike the retired walk-forward tool, it chooses no direction
 * or session filter from the data.
 */
export async function runDayTradingValidation(userId: string, requestedInstrument: string) {
  const instrument = requestedInstrument.toUpperCase() as MajorInstrument;
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  const version = await query<{ id: string }>("SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1", [ACTIVE_STRATEGY_VERSION]);
  if (!version.rows[0]) throw new Error("Run the active day-trading research first.");
  const coverage = await query<{ first_close: string | Date | null; last_close: string | Date | null }>("SELECT min(close_time) AS first_close,max(close_time) AS last_close FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda'", [instrument]);
  if (!coverage.rows[0]?.first_close || !coverage.rows[0]?.last_close) throw new Error("Five years of OANDA M15 history are required.");
  const testEnd = new Date(coverage.rows[0].last_close);
  const testStart = new Date(testEnd); testStart.setUTCMonth(testStart.getUTCMonth() - 12);
  const developmentStart = new Date(testStart); developmentStart.setUTCMonth(developmentStart.getUTCMonth() - 48);
  if (developmentStart < new Date(coverage.rows[0].first_close)) throw new Error("Five complete years are required: four development years plus one locked final year.");
  const rows = await query<WalkForwardCandidate>(`SELECT tc.id,se.decision_time,se.direction,se.conditions,se.entry,se.stop,ol.outcome,ol.result_r,ol.resolved_at,ol.horizon_ends_at
    FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical'
    ORDER BY se.decision_time,tc.id`, [version.rows[0].id, instrument]);
  const sessions: ResearchSession[] = ["London", "London/New York overlap"];
  const inDevelopment = filterExperimentCandidates(rows.rows.filter((row) => new Date(row.decision_time) >= developmentStart && new Date(row.decision_time) < testStart), "all", sessions);
  const inTest = filterExperimentCandidates(rows.rows.filter((row) => new Date(row.decision_time) >= testStart && new Date(row.decision_time) <= testEnd), "all", sessions);
  const development = positionAwareResults(inDevelopment);
  const outOfSample = positionAwareResults(inTest);
  const aggregate = outOfSample.metrics;
  const stress = [{ extra_pips: 0.5, metrics: stressMetrics(outOfSample.accepted, instrument, 0.5) }];
  const validation_status = aggregate.sample_size < 50 ? "insufficient_sample" : (aggregate.average_r ?? -Infinity) > 0 && (aggregate.profit_factor ?? 0) >= 1.15 && (stress[0]!.metrics.average_r ?? -Infinity) > 0 ? "passed" : "failed";
  const summary = {
    folds: [{ train_start: developmentStart.toISOString(), train_end: testStart.toISOString(), test_start: testStart.toISOString(), test_end: testEnd.toISOString(), selected: { direction: "all" as const, sessions, training: development.metrics, test: outOfSample.metrics, testCandidates: outOfSample.accepted.length, stress } }],
    aggregate,
    stress,
    forced_session_exits: outOfSample.accepted.filter((row) => row.outcome === "forced_close").length,
    validation_status,
    warning: "Fixed validation only: the first four years are development evidence and the final year is locked out-of-sample. No filter or parameter selection is performed. The +0.5-pip stress deducts cost from each resolved trade; it does not simulate intrabar fills.",
  };
  const configuration = { version: "day-intraday-validation-v1", strategyVersion: ACTIVE_STRATEGY_VERSION, developmentMonths: 48, outOfSampleMonths: 12, sessions, direction: "all", news: "not_evaluated" };
  const saved = await query<ResearchWalkForwardRun>("INSERT INTO research_walk_forward_runs(user_id,strategy_version_id,instrument,configuration,summary) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING id,instrument,configuration,summary,created_at", [userId, version.rows[0].id, instrument, JSON.stringify(configuration), JSON.stringify(summary)]);
  return saved.rows[0]!;
}

export async function latestDayTradingValidation(userId: string, instrument: string) {
  const result = await query<ResearchWalkForwardRun>("SELECT id,instrument,configuration,summary,created_at FROM research_walk_forward_runs WHERE user_id=$1 AND instrument=$2 AND configuration->>'version'='day-intraday-validation-v1' ORDER BY created_at DESC LIMIT 1", [userId, instrument]);
  return result.rows[0] ?? null;
}

const GBP_CANDIDATE_VERSION = "day-intraday-v2-candidate";

export async function runGbpRiskRewardCandidate() {
  const instrument: MajorInstrument = "GBP_USD";
  const coverage = await query<{ first_close: string | Date | null; last_close: string | Date | null }>("SELECT min(close_time) AS first_close,max(close_time) AS last_close FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda'", [instrument]);
  if (!coverage.rows[0]?.first_close || !coverage.rows[0]?.last_close) throw new Error("Five years of stored GBP/USD OANDA history are required.");
  const testEnd = new Date(coverage.rows[0].last_close);
  const testStart = new Date(testEnd); testStart.setUTCMonth(testStart.getUTCMonth() - 12);
  const developmentStart = new Date(testStart); developmentStart.setUTCMonth(developmentStart.getUTCMonth() - 48);
  if (developmentStart < new Date(coverage.rows[0].first_close)) throw new Error("Five complete years are required for the GBP/USD candidate test.");
  const dataStart = new Date(developmentStart.getTime() - WARMUP_DAYS * 24 * 60 * 60_000);
  const [m15Result, h1Result, h4Result, quoteResult] = await Promise.all([
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataStart, testEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H1' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataStart, testEnd]),
    query<CandleRow>("SELECT close_time,open,high,low,close,volume FROM market_candles WHERE instrument=$1 AND timeframe='H4' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataStart, testEnd]),
    query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time BETWEEN $2 AND $3 ORDER BY close_time", [instrument, dataStart, testEnd]),
  ]);
  const m15 = m15Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "M15") }));
  const h1 = h1Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H1") }));
  const h4 = h4Result.rows.map((row) => ({ closeTime: iso(row.close_time), candle: rowToCandle(row, "H4") }));
  const quotes = quoteResult.rows.map(normalizeQuote);
  const quoteByTime = new Map(quotes.map((quote) => [quote.closeTime, quote]));
  const candidates: Array<{ id: string; decisionTime: string; direction: "long" | "short"; entry: number; stop: number; target: number; plannedR: number; spreadPips: number; outcome: OutcomeResult; samplePeriod: "development" | "holdout" }> = [];
  let h1End = 0; let h4End = 0;
  for (let index = 0; index < m15.length; index += 1) {
    const decisionTime = m15[index]!.closeTime;
    if (new Date(decisionTime) < developmentStart) continue;
    while (h1End < h1.length && h1[h1End]!.closeTime <= decisionTime) h1End += 1;
    while (h4End < h4.length && h4[h4End]!.closeTime <= decisionTime) h4End += 1;
    const quote = quoteByTime.get(decisionTime);
    const candles15m = m15.slice(Math.max(0, index - REPLAY_WINDOW + 1), index + 1).map((item) => item.candle);
    const candles1h = h1.slice(Math.max(0, h1End - REPLAY_WINDOW), h1End).map((item) => item.candle);
    const candles4h = h4.slice(Math.max(0, h4End - REPLAY_WINDOW), h4End).map((item) => item.candle);
    if (!quote || candles15m.length < MINIMUM_CANDLES || candles1h.length < MINIMUM_CANDLES || candles4h.length < MINIMUM_CANDLES) continue;
    const spreadPips = (quote.askClose - quote.bidClose) / pipSizeFor(instrument);
    const setup = evaluateStrategy({ instrument, accountBalance: 10_000, accountCurrency: "USD", dataSource: "oanda", candles15m, candles1h, candles4h, bid: quote.bidClose, ask: quote.askClose, spreadPips, marketOpen: forexMarketOpen(new Date(decisionTime)), calendarConnected: false, highImpactNewsWithinMinutes: null, newsRequired: false, evaluatedAt: decisionTime }, { minimumRiskReward: 1.5 });
    if (setup.status !== "valid" || !setup.direction || setup.entry === null || setup.stop === null || setup.target === null || setup.riskReward === null) continue;
    const outcome = labelOutcome(setup.direction, setup.entry, setup.stop, setup.target, decisionTime, quotes.slice(lowerBoundQuotes(quotes, decisionTime)));
    candidates.push({ id: decisionTime, decisionTime, direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target, plannedR: setup.riskReward, spreadPips, outcome, samplePeriod: new Date(decisionTime) < testStart ? "development" : "holdout" });
  }
  const acceptedIds = new Set(selectPositionAwareCandidates(candidates.map((item) => ({ id: item.id, decisionTime: item.decisionTime, resolvedAt: item.outcome.resolvedAt, horizonEndsAt: item.outcome.horizonEndsAt }))).filter((item) => item.executionStatus === "accepted").map((item) => item.id));
  const accepted = candidates.filter((item) => acceptedIds.has(item.id));
  const candidateDevelopment = accepted.filter((item) => item.samplePeriod === "development");
  const candidateHoldout = accepted.filter((item) => item.samplePeriod === "holdout");
  const candidateResults = (rows: typeof candidateHoldout) => rows.filter((item) => RESOLVED_OUTCOMES.has(item.outcome.outcome) && item.outcome.resultR !== null).map((item) => item.outcome.resultR!);
  const candidateDevelopmentMetrics = resultMetrics(candidateResults(candidateDevelopment));
  const candidateHoldoutMetrics = resultMetrics(candidateResults(candidateHoldout));
  const candidateStress = resultMetrics(candidateHoldout.filter((item) => RESOLVED_OUTCOMES.has(item.outcome.outcome) && item.outcome.resultR !== null).map((item) => item.outcome.resultR! - 0.5 / (Math.abs(item.entry - item.stop) / pipSizeFor(instrument))));
  const positiveResults = candidateResults(candidateHoldout).filter((value) => value > 0);
  const grossPositive = positiveResults.reduce((sum, value) => sum + value, 0);
  const largestProfitShare = grossPositive > 0 ? Math.max(...positiveResults, 0) / grossPositive : null;
  const activeVersion = await query<{ id: string }>("SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1", [LEGACY_STRATEGY_VERSION]);
  if (!activeVersion.rows[0]) throw new Error("The legacy baseline strategy record is missing.");
  const baselineRows = await query<WalkForwardCandidate>(`SELECT tc.id,se.decision_time,se.direction,se.conditions,se.entry,se.stop,ol.outcome,ol.result_r,ol.resolved_at,ol.horizon_ends_at FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical' AND se.decision_time BETWEEN $3 AND $4 ORDER BY se.decision_time,tc.id`, [activeVersion.rows[0].id, instrument, developmentStart, testEnd]);
  const baselineDevelopment = positionAwareResults(baselineRows.rows.filter((row) => new Date(row.decision_time) < testStart));
  const baselineHoldout = positionAwareResults(baselineRows.rows.filter((row) => new Date(row.decision_time) >= testStart));
  const baselineStress = stressMetrics(baselineHoldout.accepted, instrument, 0.5);
  const decisionStatus = candidateHoldoutMetrics.sample_size < 50 ? "insufficient_sample" : (candidateHoldoutMetrics.average_r ?? -Infinity) > 0 && (candidateHoldoutMetrics.profit_factor ?? 0) >= 1.15 && (candidateStress.average_r ?? -Infinity) > 0 && candidateHoldoutMetrics.drawdown_r <= 10 && (largestProfitShare ?? 1) < 0.5 ? "eligible" : "rejected";
  const configuration = { version: GBP_CANDIDATE_VERSION, active: false, researchOnly: true, instrument, minimumRiskReward: 1.5, baselineMinimumRiskReward: 2, developmentStart: developmentStart.toISOString(), holdoutStart: testStart.toISOString(), holdoutEnd: testEnd.toISOString(), news: "not_evaluated" };
  const baselineSummary = { development: baselineDevelopment.metrics, holdout: baselineHoldout.metrics, stress05Pips: baselineStress };
  const candidateSummary = { rawCandidates: candidates.length, acceptedCandidates: accepted.length, overlappingCandidates: candidates.length - accepted.length, development: candidateDevelopmentMetrics, holdout: candidateHoldoutMetrics, stress05Pips: candidateStress, largestProfitShare, forcedSessionExits: candidateHoldout.filter((item) => item.outcome.outcome === "forced_close").length };
  return transaction(async (client) => {
    const version = await client.query<{ id: string }>("INSERT INTO strategy_versions(name,version,configuration) VALUES('deterministic-forex',$1,$2::jsonb) ON CONFLICT(name,version) DO UPDATE SET configuration=EXCLUDED.configuration RETURNING id", [GBP_CANDIDATE_VERSION, JSON.stringify(configuration)]);
    await client.query("DELETE FROM research_strategy_candidate_runs WHERE strategy_version_id=$1 AND instrument=$2", [version.rows[0]!.id, instrument]);
    const run = await client.query<{ id: string }>("INSERT INTO research_strategy_candidate_runs(strategy_version_id,instrument,configuration,baseline_summary,candidate_summary,decision_status) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6) RETURNING id", [version.rows[0]!.id, instrument, JSON.stringify(configuration), JSON.stringify(baselineSummary), JSON.stringify(candidateSummary), decisionStatus]);
    if (candidates.length) await client.query(`INSERT INTO research_strategy_candidate_trades(run_id,decision_time,sample_period,direction,entry,stop,target,planned_r,spread_pips,outcome,result_r,resolved_at,execution_status) SELECT $1,x.decision_time,x.sample_period,x.direction,x.entry,x.stop,x.target,x.planned_r,x.spread_pips,x.outcome,x.result_r,x.resolved_at,x.execution_status FROM jsonb_to_recordset($2::jsonb) AS x(decision_time timestamptz,sample_period text,direction text,entry numeric,stop numeric,target numeric,planned_r numeric,spread_pips numeric,outcome text,result_r numeric,resolved_at timestamptz,execution_status text)`, [run.rows[0]!.id, JSON.stringify(candidates.map((item) => ({ decision_time: item.decisionTime, sample_period: item.samplePeriod, direction: item.direction, entry: item.entry, stop: item.stop, target: item.target, planned_r: item.plannedR, spread_pips: item.spreadPips, outcome: item.outcome.outcome, result_r: item.outcome.resultR, resolved_at: item.outcome.resolvedAt, execution_status: acceptedIds.has(item.id) ? "accepted" : "overlapping" })))]);
    return { runId: run.rows[0]!.id, decisionStatus, baseline: baselineSummary, candidate: candidateSummary };
  });
}

type ExperimentDirection = "all" | "long" | "short";
type ResearchSession = (typeof RESEARCH_SESSIONS)[number];
type ExperimentCandidateRow = {
  id: string;
  decision_time: string | Date;
  direction: "long" | "short";
  conditions: Array<{ name?: string; currentValue?: string }>;
  outcome: "target_first" | "stop_first" | "forced_close" | "unresolved" | "ambiguous";
  result_r: string | null;
  resolved_at: string | Date | null;
  horizon_ends_at: string | Date;
};
export type ResearchExperiment = {
  id: string; instrument: string; direction: ExperimentDirection; sessions: ResearchSession[]; lookback_months: number;
  experiment_version: string; configuration: Record<string, unknown>; summary: Record<string, unknown>; decision: "pending" | "approved" | "rejected"; decision_note: string | null; decided_at: string | Date | null; created_at: string | Date; completed_at: string | Date;
};

function candidateSession(candidate: { conditions: Array<{ name?: string; currentValue?: string }> }) {
  return (Array.isArray(candidate.conditions) ? candidate.conditions : []).find((condition) => condition.name === "Session")?.currentValue ?? "Unknown";
}

export async function runResearchExperiment(userId: string, input: { instrument: string; direction?: string; sessions?: unknown; months?: number }) {
  const instrument = input.instrument.toUpperCase();
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported OANDA currency pair.");
  const direction: ExperimentDirection = input.direction === "long" || input.direction === "short" ? input.direction : "all";
  const requestedSessions = Array.isArray(input.sessions) ? input.sessions.filter((session): session is ResearchSession => typeof session === "string" && RESEARCH_SESSIONS.includes(session as ResearchSession)) : [];
  const sessions = [...new Set(requestedSessions)];
  if (!sessions.length) throw new Error("Choose at least one trading session.");
  const months = [12, 36, 60].includes(Number(input.months)) ? Number(input.months) : 60;
  const cutoff = startDateForMonths(months);
  const version = await query<{ id: string }>("SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1", [ACTIVE_STRATEGY_VERSION]);
  if (!version.rows[0]) throw new Error("Run the baseline research before creating an experiment.");
  const coverage = await query<{ first_close: string | Date | null; last_close: string | Date | null }>("SELECT min(close_time) AS first_close,max(close_time) AS last_close FROM market_candles WHERE instrument=$1 AND timeframe='M15' AND source='oanda'", [instrument]);
  if (!coverage.rows[0]?.first_close || new Date(coverage.rows[0].first_close) > cutoff) throw new Error(`Run the ${months / 12}-year baseline for this pair before creating this experiment.`);
  const candidates = await query<ExperimentCandidateRow>(`SELECT tc.id,se.decision_time,se.direction,se.conditions,ol.outcome,ol.result_r,ol.resolved_at,ol.horizon_ends_at
    FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=$1 AND se.instrument=$2 AND se.source_kind='historical' AND se.decision_time>=$3
    ORDER BY se.decision_time,tc.id`, [version.rows[0].id, instrument, cutoff]);
  const referenceSelections = selectPositionAwareCandidates(candidates.rows.map((candidate) => ({ id: candidate.id, decisionTime: iso(candidate.decision_time), resolvedAt: candidate.resolved_at ? iso(candidate.resolved_at) : null, horizonEndsAt: iso(candidate.horizon_ends_at) })));
  const eligible = candidates.rows.filter((candidate) => (direction === "all" || candidate.direction === direction) && sessions.includes(candidateSession(candidate) as ResearchSession));
  const selections = selectPositionAwareCandidates(eligible.map((candidate) => ({ id: candidate.id, decisionTime: iso(candidate.decision_time), resolvedAt: candidate.resolved_at ? iso(candidate.resolved_at) : null, horizonEndsAt: iso(candidate.horizon_ends_at) })));
  const candidateById = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  const rawResults = outcomeResults(eligible, "resolved_only");
  const acceptedRows = selections.filter((selection) => selection.executionStatus === "accepted").map((selection) => candidateById.get(selection.id)!);
  const executableResults = outcomeResults(acceptedRows, "resolved_only");
  const allCandidateById = new Map(candidates.rows.map((candidate) => [candidate.id, candidate]));
  const referenceRows = referenceSelections.filter((selection) => selection.executionStatus === "accepted").map((selection) => allCandidateById.get(selection.id)!);
  const referenceResults = outcomeResults(referenceRows, "resolved_only");
  const configuration = { experimentVersion: EXPERIMENT_VERSION, baseStrategyVersion: ACTIVE_STRATEGY_VERSION, instrument, direction, sessions, lookbackMonths: months, oneOpenPositionPerPair: true, strategyRulesChanged: false, news: "not_evaluated" };
  const summary = {
    raw_candidates: eligible.length,
    executable_candidates: acceptedRows.length,
    overlapping_candidates: selections.filter((selection) => selection.executionStatus === "overlapping").length,
    target_first: acceptedRows.filter((candidate) => candidate.outcome === "target_first").length,
    stop_first: acceptedRows.filter((candidate) => candidate.outcome === "stop_first").length,
    unresolved: acceptedRows.filter((candidate) => candidate.outcome === "unresolved").length,
    ambiguous: acceptedRows.filter((candidate) => candidate.outcome === "ambiguous").length,
    raw_baseline: resultMetrics(rawResults),
    executable: resultMetrics(executableResults),
    conservative: resultMetrics(outcomeResults(acceptedRows, "conservative")),
    reference_candidates: referenceRows.length,
    reference: resultMetrics(referenceResults),
    reference_conservative: resultMetrics(outcomeResults(referenceRows, "conservative")),
    coverage_start: iso(coverage.rows[0].first_close),
    coverage_end: coverage.rows[0].last_close ? iso(coverage.rows[0].last_close) : null,
  };
  return transaction(async (client) => {
    const saved = await client.query<ResearchExperiment>(`INSERT INTO research_experiments(user_id,strategy_version_id,experiment_version,instrument,direction,sessions,lookback_months,configuration,summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
      RETURNING id,instrument,direction,sessions,lookback_months,experiment_version,configuration,summary,decision,decision_note,decided_at,created_at,completed_at`, [userId, version.rows[0]!.id, EXPERIMENT_VERSION, instrument, direction, sessions, months, JSON.stringify(configuration), JSON.stringify(summary)]);
    if (selections.length) await client.query(`INSERT INTO research_experiment_trades(experiment_id,candidate_id,execution_status,blocked_by_candidate_id,simulated_entry_at,simulated_exit_at)
      SELECT $1,x.candidate_id,x.execution_status,x.blocked_by_candidate_id,x.simulated_entry_at,x.simulated_exit_at
      FROM jsonb_to_recordset($2::jsonb) AS x(candidate_id uuid,execution_status text,blocked_by_candidate_id uuid,simulated_entry_at timestamptz,simulated_exit_at timestamptz)`, [saved.rows[0]!.id, JSON.stringify(selections.map((selection) => ({ candidate_id: selection.id, execution_status: selection.executionStatus, blocked_by_candidate_id: selection.blockedByCandidateId, simulated_entry_at: selection.simulatedEntryAt, simulated_exit_at: selection.simulatedExitAt })))]);
    return saved.rows[0]!;
  });
}

export async function latestResearchExperiment(userId: string, instrument?: string) {
  const values: unknown[] = [userId];
  const filter = instrument && isKnownInstrument(instrument) ? ` AND instrument=$${values.push(instrument)}` : "";
  const result = await query<ResearchExperiment>(`SELECT id,instrument,direction,sessions,lookback_months,experiment_version,configuration,summary,decision,decision_note,decided_at,created_at,completed_at FROM research_experiments WHERE user_id=$1${filter} ORDER BY created_at DESC LIMIT 1`, values);
  return result.rows[0] ?? null;
}

export async function decideResearchExperiment(userId: string, input: { experimentId: string; decision: string; note: string }) {
  const decision = input.decision === "approved" || input.decision === "rejected" ? input.decision : input.decision === "pending" ? "pending" : null;
  if (!decision) throw new Error("Choose Pending, Approved, or Rejected.");
  const note = input.note.trim();
  if (decision !== "pending" && note.length < 8) throw new Error("Add a short decision note explaining the approval or rejection.");
  const experiment = await query<{ id: string }>("SELECT id FROM research_experiments WHERE id=$1 AND user_id=$2", [input.experimentId, userId]);
  if (!experiment.rows[0]) throw new Error("Research experiment not found.");
  if (decision === "approved") {
    const holdout = await query<{ status: string }>("SELECT status FROM research_holdouts WHERE source_experiment_id=$1 AND user_id=$2", [input.experimentId, userId]);
    if (holdout.rows[0]?.status !== "complete") throw new Error("Complete the locked holdout before approving an experiment.");
  }
  const saved = await query<ResearchExperiment>(`UPDATE research_experiments
    SET decision=$3,decision_note=$4,decided_at=CASE WHEN $3='pending' THEN NULL ELSE now() END
    WHERE id=$1 AND user_id=$2
    RETURNING id,instrument,direction,sessions,lookback_months,experiment_version,configuration,summary,decision,decision_note,decided_at,created_at,completed_at`, [input.experimentId, userId, decision, note || null]);
  return saved.rows[0]!;
}

type ExperimentDiagnosticRow = {
  candidate_id: string; decision_time: string | Date; direction: "long" | "short"; entry: string; stop: string; target: string; risk_reward: string; spread_pips: string;
  conditions: Array<{ name?: string; currentValue?: string }>; execution_status: "accepted" | "overlapping"; blocked_by_candidate_id: string | null;
  simulated_entry_at: string | Date | null; simulated_exit_at: string | Date | null; outcome: "target_first" | "stop_first" | "forced_close" | "unresolved" | "ambiguous";
  result_r: string | null; max_favorable_r: string | null; max_adverse_r: string | null; resolved_at: string | Date | null;
};

function experimentMetrics(rows: ExperimentDiagnosticRow[]) {
  const results = rows.filter((row) => RESOLVED_OUTCOMES.has(row.outcome)).map((row) => Number(row.result_r));
  return { candidates: rows.length, target_first: rows.filter((row) => row.outcome === "target_first").length, stop_first: rows.filter((row) => row.outcome === "stop_first").length, unresolved: rows.filter((row) => row.outcome === "unresolved").length, ambiguous: rows.filter((row) => row.outcome === "ambiguous").length, ...resultMetrics(results) };
}

function experimentBreakdown(rows: ExperimentDiagnosticRow[], key: (row: ExperimentDiagnosticRow) => string) {
  const groups = new Map<string, ExperimentDiagnosticRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()].map(([name, values]) => ({ name, ...experimentMetrics(values) })).sort((left, right) => left.name.localeCompare(right.name));
}

export async function researchExperimentDiagnostics(userId: string, experimentId: string) {
  const experiment = await query<ResearchExperiment>("SELECT id,instrument,direction,sessions,lookback_months,experiment_version,configuration,summary,decision,decision_note,decided_at,created_at,completed_at FROM research_experiments WHERE id=$1 AND user_id=$2", [experimentId, userId]);
  if (!experiment.rows[0]) return null;
  const result = await query<ExperimentDiagnosticRow>(`SELECT ret.candidate_id,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,se.spread_pips,se.conditions,ret.execution_status,ret.blocked_by_candidate_id,ret.simulated_entry_at,ret.simulated_exit_at,ol.outcome,ol.result_r,ol.max_favorable_r,ol.max_adverse_r,ol.resolved_at
    FROM research_experiment_trades ret JOIN trade_candidates tc ON tc.id=ret.candidate_id JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE ret.experiment_id=$1 ORDER BY se.decision_time,tc.id`, [experimentId]);
  const accepted = result.rows.filter((row) => row.execution_status === "accepted");
  let cumulativeR = 0; let peakR = 0;
  const equity = accepted.filter((row) => row.outcome === "target_first" || row.outcome === "stop_first").map((row) => {
    cumulativeR += Number(row.result_r); peakR = Math.max(peakR, cumulativeR);
    return { candidateId: row.candidate_id, decisionTime: iso(row.decision_time), resultR: Number(row.result_r), cumulativeR, drawdownR: peakR - cumulativeR };
  });
  const latestDecision = accepted.length ? new Date(accepted.at(-1)!.decision_time) : new Date();
  const retrospectiveCutoff = new Date(latestDecision.getTime() - 365 * 24 * 60 * 60_000);
  const audit = result.rows.map((row) => ({
    candidateId: row.candidate_id, decisionTime: iso(row.decision_time), direction: row.direction, entry: Number(row.entry), stop: Number(row.stop), target: Number(row.target), plannedR: Number(row.risk_reward), spreadPips: Number(row.spread_pips), session: candidateSession(row), executionStatus: row.execution_status, blockedByCandidateId: row.blocked_by_candidate_id, simulatedEntryAt: row.simulated_entry_at ? iso(row.simulated_entry_at) : null, simulatedExitAt: row.simulated_exit_at ? iso(row.simulated_exit_at) : null, resolvedAt: row.resolved_at ? iso(row.resolved_at) : null, outcome: row.outcome, resultR: numberOrNull(row.result_r), mfeR: numberOrNull(row.max_favorable_r), maeR: numberOrNull(row.max_adverse_r),
  }));
  return {
    experiment: experiment.rows[0],
    breakdowns: { year: experimentBreakdown(accepted, (row) => iso(row.decision_time).slice(0, 4)), session: experimentBreakdown(accepted, (row) => candidateSession(row)) },
    equity,
    retrospective: { cutoff: retrospectiveCutoff.toISOString(), warning: "This final-year slice is retrospective and was visible when the filter was selected. It is not untouched validation data.", development: experimentMetrics(accepted.filter((row) => new Date(row.decision_time) < retrospectiveCutoff)), finalYear: experimentMetrics(accepted.filter((row) => new Date(row.decision_time) >= retrospectiveCutoff)) },
    audit,
  };
}

export async function researchSummary(instrument?: string) {
  const parameters: unknown[] = [ACTIVE_STRATEGY_VERSION];
  const instrumentClause = instrument ? " AND se.instrument=$2" : "";
  if (instrument) parameters.push(instrument);
  const aggregate = await query<{ evaluations: number; valid_evaluations: number; blocked_evaluations: number; candidates: number; executable_candidates: number; overlapping_candidates: number; pending_candidates: number; target_first: number; stop_first: number; forced_close: number; unresolved: number; ambiguous: number }>(`SELECT count(*)::int AS evaluations,count(*) FILTER(WHERE se.status='valid')::int AS valid_evaluations,count(*) FILTER(WHERE se.status<>'valid')::int AS blocked_evaluations,count(tc.*)::int AS candidates,count(tc.*) FILTER(WHERE tc.execution_status='accepted')::int AS executable_candidates,count(tc.*) FILTER(WHERE tc.execution_status='overlapping')::int AS overlapping_candidates,count(tc.*) FILTER(WHERE tc.execution_status='pending')::int AS pending_candidates,count(ol.*) FILTER(WHERE tc.execution_status='accepted' AND ol.outcome='target_first')::int AS target_first,count(ol.*) FILTER(WHERE tc.execution_status='accepted' AND ol.outcome='stop_first')::int AS stop_first,count(ol.*) FILTER(WHERE tc.execution_status='accepted' AND ol.outcome='forced_close')::int AS forced_close,count(ol.*) FILTER(WHERE tc.execution_status='accepted' AND ol.outcome='unresolved')::int AS unresolved,count(ol.*) FILTER(WHERE tc.execution_status='accepted' AND ol.outcome='ambiguous')::int AS ambiguous FROM strategy_evaluations se JOIN strategy_versions sv ON sv.id=se.strategy_version_id LEFT JOIN trade_candidates tc ON tc.evaluation_id=se.id LEFT JOIN outcome_labels ol ON ol.candidate_id=tc.id WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause}`, parameters);
  const outcomes = await query<{ outcome: string; result_r: string | null }>(`SELECT ol.outcome,ol.result_r FROM outcome_labels ol JOIN trade_candidates tc ON tc.id=ol.candidate_id JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical' AND tc.execution_status='accepted'${instrumentClause} ORDER BY se.decision_time`, parameters);
  const rawOutcomes = await query<{ outcome: string; result_r: string | null }>(`SELECT ol.outcome,ol.result_r FROM outcome_labels ol JOIN trade_candidates tc ON tc.id=ol.candidate_id JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause} ORDER BY se.decision_time`, parameters);
  return {
    ...aggregate.rows[0]!,
    ...resultMetrics(outcomeResults(outcomes.rows, "resolved_only")),
    raw_baseline: resultMetrics(outcomeResults(rawOutcomes.rows, "resolved_only")),
    conservative_baseline: resultMetrics(outcomeResults(outcomes.rows, "conservative")),
  };
}

export async function forwardResearchSummary(instrument: string) {
  if (!isKnownInstrument(instrument)) throw new Error("Choose a supported currency pair.");
  const rows = await query<{ outcome: string; result_r: string | null }>(`SELECT ol.outcome,ol.result_r FROM outcome_labels ol JOIN trade_candidates tc ON tc.id=ol.candidate_id JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='forward' AND se.instrument=$2 ORDER BY se.decision_time`, [ACTIVE_STRATEGY_VERSION, instrument]);
  const resolved = rows.rows.filter((row) => row.outcome === "target_first" || row.outcome === "stop_first" || row.outcome === "forced_close").map((row) => Number(row.result_r)).filter(Number.isFinite);
  const wins = rows.rows.filter((row) => row.outcome === "target_first").length;
  const losses = rows.rows.filter((row) => row.outcome === "stop_first").length;
  const grossWins = resolved.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLosses = Math.abs(resolved.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const value of resolved) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return { candidates: rows.rows.length, resolved: resolved.length, wins, losses, forcedClose: rows.rows.filter((row) => row.outcome === "forced_close").length, unresolved: rows.rows.filter((row) => row.outcome === "unresolved").length, ambiguous: rows.rows.filter((row) => row.outcome === "ambiguous").length, winRate: resolved.length ? wins / resolved.length : null, averageR: resolved.length ? resolved.reduce((sum, value) => sum + value, 0) / resolved.length : null, profitFactor: grossLosses ? grossWins / grossLosses : null, drawdownR: drawdown };
}

// The live trend-pullback-liquidity strategy's required gates, in evaluation
// order — the funnel counts how many replayed evaluations survive each one.
// "News" is intentionally absent: historical_replay does not evaluate the news
// buffer (its condition is a non-required, always-failed placeholder), so
// including it would collapse the funnel to zero at that stage.
const RESEARCH_FUNNEL_STAGES = ["Market data", "H1 direction", "Session", "Spread", "Pullback", "Liquidity sweep", "Swept level location", "Confirmation"] as const;

type DiagnosticCondition = { name?: string; passed?: boolean; required?: boolean; currentValue?: string };
type DiagnosticCandidateRow = {
  id: string;
  instrument: string;
  decision_time: string | Date;
  direction: "long" | "short";
  entry: string;
  stop: string;
  target: string;
  risk_reward: string;
  spread_pips: string;
  conditions: DiagnosticCondition[];
  outcome: "target_first" | "stop_first" | "forced_close" | "unresolved" | "ambiguous" | null;
  result_r: string | null;
  max_favorable_r: string | null;
  max_adverse_r: string | null;
  execution_status: "pending" | "accepted" | "overlapping";
  blocked_by_candidate_id: string | null;
  simulated_entry_at: string | Date | null;
  simulated_exit_at: string | Date | null;
};
type ShadowDiagnosticRow = DiagnosticCandidateRow & { failed_condition: string };

type DiagnosticTrade = {
  id: string;
  instrument: string;
  decisionTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  plannedR: number;
  spreadPips: number;
  session: string;
  outcome: DiagnosticCandidateRow["outcome"];
  resultR: number | null;
  mfeR: number | null;
  maeR: number | null;
  executionStatus: DiagnosticCandidateRow["execution_status"];
  blockedByCandidateId: string | null;
  simulatedEntryAt: string | null;
  simulatedExitAt: string | null;
  notEvaluated: string[];
};

function numberOrNull(value: string | null) { return value === null ? null : Number(value); }

function diagnosticTrade(row: DiagnosticCandidateRow): DiagnosticTrade {
  const conditions = Array.isArray(row.conditions) ? row.conditions : [];
  return {
    id: row.id,
    instrument: row.instrument,
    decisionTime: iso(row.decision_time),
    direction: row.direction,
    entry: Number(row.entry),
    stop: Number(row.stop),
    target: Number(row.target),
    plannedR: Number(row.risk_reward),
    spreadPips: Number(row.spread_pips),
    session: conditions.find((item) => item.name === "Session")?.currentValue ?? "Unknown",
    outcome: row.outcome,
    resultR: numberOrNull(row.result_r),
    mfeR: numberOrNull(row.max_favorable_r),
    maeR: numberOrNull(row.max_adverse_r),
    executionStatus: row.execution_status,
    blockedByCandidateId: row.blocked_by_candidate_id,
    simulatedEntryAt: row.simulated_entry_at ? iso(row.simulated_entry_at) : null,
    simulatedExitAt: row.simulated_exit_at ? iso(row.simulated_exit_at) : null,
    notEvaluated: conditions.filter((item) => item.required === false && item.passed === false).map((item) => item.name ?? "Unknown"),
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function ratioMetrics(results: number[]) {
  const wins = results.filter((value) => value > 0);
  const losses = results.filter((value) => value < 0);
  return {
    sampleSize: results.length,
    wins: wins.length,
    losses: losses.length,
    winRate: results.length ? wins.length / results.length : null,
    averageR: results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : null,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
  };
}

function tradeMetrics(trades: DiagnosticTrade[]) {
  const resolved = ratioMetrics(trades.filter((trade) => trade.outcome !== null && RESOLVED_OUTCOMES.has(trade.outcome)).map((trade) => trade.resultR).filter((value): value is number => value !== null));
  // Every row that carries a result, including ambiguous bars and timed-out
  // trades that the resolved basis drops.
  const conservative = ratioMetrics(trades.map((trade) => trade.resultR).filter((value): value is number => value !== null));
  return {
    candidates: trades.length,
    ...resolved,
    unresolved: trades.filter((trade) => trade.outcome === "unresolved" || trade.outcome === null).length,
    ambiguous: trades.filter((trade) => trade.outcome === "ambiguous").length,
    conservativeSampleSize: conservative.sampleSize,
    conservativeWinRate: conservative.winRate,
    conservativeAverageR: conservative.averageR,
    conservativeProfitFactor: conservative.profitFactor,
  };
}

function groupedMetrics<T extends DiagnosticTrade>(trades: T[], key: (trade: T) => string) {
  const groups = new Map<string, T[]>();
  for (const trade of trades) groups.set(key(trade), [...(groups.get(key(trade)) ?? []), trade]);
  return [...groups.entries()].map(([name, values]) => ({ name, ...tradeMetrics(values) })).sort((left, right) => left.name.localeCompare(right.name));
}

export async function researchDiagnostics(instrument?: string) {
  const parameters: unknown[] = [ACTIVE_STRATEGY_VERSION];
  const instrumentClause = instrument ? " AND se.instrument=$2" : "";
  if (instrument) parameters.push(instrument);
  const stages = JSON.stringify(RESEARCH_FUNNEL_STAGES);
  const [funnelResult, nearMissResult, selectedCandidateResult, allCandidateResult, shadowResult] = await Promise.all([
    query<{ name: string; stage_order: number; passed: number; total: number }>(`WITH evaluations AS (
        SELECT se.conditions FROM strategy_evaluations se JOIN strategy_versions sv ON sv.id=se.strategy_version_id
        WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause}
      ), stages AS (SELECT value AS name, ordinality::int AS stage_order FROM jsonb_array_elements_text($${instrument ? 3 : 2}::jsonb) WITH ORDINALITY)
      SELECT stage.name,stage.stage_order,
        count(evaluations.*) FILTER (WHERE (SELECT count(*) FROM jsonb_array_elements(evaluations.conditions) condition JOIN stages required_stage ON required_stage.name=condition->>'name' WHERE required_stage.stage_order<=stage.stage_order AND condition->>'passed'='true')=stage.stage_order)::int AS passed,
        count(evaluations.*)::int AS total
      FROM stages stage CROSS JOIN evaluations GROUP BY stage.name,stage.stage_order ORDER BY stage.stage_order`, [...parameters, stages]),
    query<{ condition: string; count: number }>(`WITH evaluations AS (
        SELECT se.conditions FROM strategy_evaluations se JOIN strategy_versions sv ON sv.id=se.strategy_version_id
        WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause}
      ), failures AS (
        SELECT conditions,condition->>'name' AS condition FROM evaluations CROSS JOIN LATERAL jsonb_array_elements(conditions) condition
        WHERE condition->>'required'='true' AND condition->>'passed'='false'
      ) SELECT failure.condition,count(*)::int AS count FROM failures failure
      WHERE failure.conditions @> '[{"name":"Confirmation"}]'::jsonb
        AND (SELECT count(*) FROM jsonb_array_elements(failure.conditions) item WHERE item->>'required'='true' AND item->>'passed'='false')=1
      GROUP BY failure.condition ORDER BY count DESC`, parameters),
    query<DiagnosticCandidateRow>(`SELECT tc.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,se.spread_pips,se.conditions,tc.execution_status,tc.blocked_by_candidate_id,tc.simulated_entry_at,tc.simulated_exit_at,ol.outcome,ol.result_r,ol.max_favorable_r,ol.max_adverse_r
      FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id LEFT JOIN outcome_labels ol ON ol.candidate_id=tc.id
      WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause} ORDER BY se.decision_time DESC LIMIT 5000`, parameters),
    query<DiagnosticCandidateRow>(`SELECT tc.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,se.spread_pips,se.conditions,tc.execution_status,tc.blocked_by_candidate_id,tc.simulated_entry_at,tc.simulated_exit_at,ol.outcome,ol.result_r,ol.max_favorable_r,ol.max_adverse_r
      FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id LEFT JOIN outcome_labels ol ON ol.candidate_id=tc.id
      WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical' ORDER BY se.decision_time DESC LIMIT 5000`, [ACTIVE_STRATEGY_VERSION]),
    query<ShadowDiagnosticRow>(`SELECT se.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target,se.risk_reward,se.spread_pips,se.conditions,'pending'::text AS execution_status,NULL::uuid AS blocked_by_candidate_id,NULL::timestamptz AS simulated_entry_at,NULL::timestamptz AS simulated_exit_at,sol.failed_condition,sol.outcome,sol.result_r,sol.max_favorable_r,sol.max_adverse_r
      FROM shadow_outcome_labels sol JOIN strategy_evaluations se ON se.id=sol.evaluation_id JOIN strategy_versions sv ON sv.id=se.strategy_version_id
      WHERE sv.name='deterministic-forex' AND sv.version=$1 AND se.source_kind='historical'${instrumentClause} ORDER BY se.decision_time DESC LIMIT 5000`, parameters),
  ]);
  const trades = selectedCandidateResult.rows.map(diagnosticTrade);
  const allTrades = allCandidateResult.rows.map(diagnosticTrade);
  const executableTrades = trades.filter((trade) => trade.executionStatus === "accepted");
  const allExecutableTrades = allTrades.filter((trade) => trade.executionStatus === "accepted");
  const shadowTrades = shadowResult.rows.map((row) => ({ ...diagnosticTrade(row), failedCondition: row.failed_condition }));
  const mfe = executableTrades.map((trade) => trade.mfeR).filter((value): value is number => value !== null);
  const mae = executableTrades.map((trade) => trade.maeR).filter((value): value is number => value !== null);
  return {
    funnel: funnelResult.rows.map((stage, index) => ({ name: stage.name, count: stage.passed, total: stage.total, totalRate: stage.total ? stage.passed / stage.total : null, retention: index === 0 ? 1 : funnelResult.rows[index - 1]!.passed ? stage.passed / funnelResult.rows[index - 1]!.passed : null })),
    nearMisses: nearMissResult.rows,
    excursion: { sampleSize: Math.min(mfe.length, mae.length), averageMfeR: mfe.length ? mfe.reduce((sum, value) => sum + value, 0) / mfe.length : null, medianMfeR: median(mfe), averageMaeR: mae.length ? mae.reduce((sum, value) => sum + value, 0) / mae.length : null, medianMaeR: median(mae) },
    breakdowns: { direction: groupedMetrics(executableTrades, (trade) => trade.direction), month: groupedMetrics(executableTrades, (trade) => trade.decisionTime.slice(0, 7)), session: groupedMetrics(executableTrades, (trade) => trade.session), pair: groupedMetrics(allExecutableTrades, (trade) => trade.instrument) },
    shadow: { byCondition: groupedMetrics(shadowTrades, (trade) => trade.failedCondition), trades: shadowTrades },
    trades,
  };
}

function decisionTime(value: string) { const date = new Date(value); date.setUTCSeconds(0, 0); date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 15) * 15); return date.toISOString(); }

export async function collectForwardEvaluation() {
  const snapshot = await getStrategySnapshot();
  if (snapshot.accountStatus.source !== "oanda" || snapshot.accountStatus.state !== "connected") return { collected: 0, reason: "OANDA is not connected" };
  for (const instrument of INSTRUMENTS) {
    await query("INSERT INTO instruments(code,display_name,price_precision) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING", [instrument.code, instrument.display, instrument.precision]);
    // Keep a small rolling bid/ask candle window so forward candidates can be
    // labeled after their same-day exit or target/stop is reached.
    const recent = (await getResearchCandles(instrument.code as MajorInstrument, "M15", 500)).filter((candle) => candle.complete);
    await saveResearchCandles(instrument.code as MajorInstrument, "M15", recent);
  }
  const version = await query<{ id: string }>("INSERT INTO strategy_versions(name,version,configuration) VALUES('deterministic-forex',$1,$2::jsonb) ON CONFLICT(name,version) DO UPDATE SET configuration=strategy_versions.configuration || EXCLUDED.configuration RETURNING id", [ACTIVE_STRATEGY_VERSION, JSON.stringify({ timeframes: HISTORICAL_TIMEFRAMES, entryWindowEt: "03:00-12:00", forcedExitEt: "16:45", holding: "same_day", news: "not_evaluated", macroReplay: "neutral_when_historical_rate_snapshot_unavailable" })]);
  let collected = 0;
  for (const setup of snapshot.strategy.setups) {
    if (setup.dataSource !== "oanda") continue;
    const time = decisionTime(setup.evaluatedAt);
    await transaction(async (client) => {
      const saved = await client.query<{ id: string }>("INSERT INTO strategy_evaluations(strategy_version_id,instrument,decision_time,source_kind,status,direction,entry,stop,target,risk_reward,spread_pips,conditions,candle_cutoff) VALUES($1,$2,$3,'forward',$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(strategy_version_id,instrument,decision_time,source_kind) DO NOTHING RETURNING id", [version.rows[0]!.id, setup.instrument, time, setup.status, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, null, JSON.stringify(setup.conditions), time]);
      const id = saved.rows[0]?.id; if (!id) return;
      if (setup.status === "valid") {
        await client.query("INSERT INTO evaluation_features(evaluation_id,feature_version,features) VALUES($1,'day-intraday-output-v1',$2)", [id, JSON.stringify({ summary: setup.summary, passedConditions: setup.passedConditions, failedConditions: setup.failedConditions, positionSize: setup.positionSize })]);
        if (setup.entry !== null && setup.stop !== null && setup.target !== null) await client.query("INSERT INTO trade_candidates(evaluation_id,status,raw_units,applied_units) VALUES($1,'planned',$2,$3)", [id, setup.positionSize?.calculatedUnits ?? null, setup.positionSize?.units ?? null]);
      }
      collected += 1;
    });
  }
  await labelForwardOutcomes();
  return { collected };
}

async function labelForwardOutcomes() {
  const candidates = await query<CandidateForLabel & { instrument: MajorInstrument }>(`SELECT tc.id,se.instrument,se.decision_time,se.direction,se.entry,se.stop,se.target
    FROM trade_candidates tc JOIN strategy_evaluations se ON se.id=tc.evaluation_id
    LEFT JOIN outcome_labels ol ON ol.candidate_id=tc.id
    WHERE se.strategy_version_id=(SELECT id FROM strategy_versions WHERE name='deterministic-forex' AND version=$1)
      AND se.source_kind='forward' AND se.status='valid' AND ol.candidate_id IS NULL
      AND se.decision_time < now() - interval '15 minutes'`, [ACTIVE_STRATEGY_VERSION]);
  for (const candidate of candidates.rows) {
    const end = new Date(new Date(candidate.decision_time).getTime() + OUTCOME_HOURS * 60 * 60_000);
    const quotes = (await query<QuoteRow>("SELECT close_time,bid_open,bid_high,bid_low,bid_close,ask_open,ask_high,ask_low,ask_close FROM market_candle_quotes WHERE instrument=$1 AND timeframe='M15' AND source='oanda' AND close_time>$2 AND close_time<=$3 ORDER BY close_time", [candidate.instrument, candidate.decision_time, end])).rows.map(normalizeQuote);
    if (!quotes.length) continue;
    const result = labelOutcome(candidate.direction, Number(candidate.entry), Number(candidate.stop), Number(candidate.target), iso(candidate.decision_time), quotes);
    // Do not freeze an unresolved label while the trade's outcome window is
    // still open; the next polling cycle must be allowed to see later candles.
    if (result.outcome === "unresolved" && new Date(quotes.at(-1)!.closeTime).getTime() < end.getTime()) continue;
    await query(`INSERT INTO outcome_labels(candidate_id,outcome,horizon_ends_at,resolved_at,result_r,max_favorable_r,max_adverse_r)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(candidate_id) DO UPDATE SET outcome=EXCLUDED.outcome,horizon_ends_at=EXCLUDED.horizon_ends_at,resolved_at=EXCLUDED.resolved_at,result_r=EXCLUDED.result_r,max_favorable_r=EXCLUDED.max_favorable_r,max_adverse_r=EXCLUDED.max_adverse_r,labeled_at=now()`, [candidate.id, result.outcome, result.horizonEndsAt, result.resolvedAt, result.resultR, result.maxFavorableR, result.maxAdverseR]);
  }
}
