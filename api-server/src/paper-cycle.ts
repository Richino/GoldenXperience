import type { PoolClient } from "pg";

import { query, transaction } from "./database.js";
import { getClosedPracticeTrades } from "../../frontend/src/lib/oanda/client.js";
import { labelOutcome, type NormalizedQuote } from "./research.js";
import { displayPair, queueNotification, sendPushNotification } from "./notifications.js";
import { closePracticeTradeForPaperTrade, processPendingPracticeOrders, queuePracticeOrderIntent, requestPracticeTradeCloseForPaperTrade } from "./practice-execution.js";
import { currenciesOf, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculatePositionSize, usdPerUnitOfCurrency } from "../../frontend/src/lib/risk/engine.js";
import { getPracticeTradeState, getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { DAY_TRADING_TIME_ZONE, dayTradingSession } from "../../frontend/src/lib/strategy/strategy-engine.js";
// The strategy that is allowed to create trades. Changing this starts a new
// batch on its own: batches are scoped to the version that produced them.
import { LIQUIDITY_STRATEGY_VERSION as ACTIVE_STRATEGY_VERSION, RISK as LIQUIDITY_RISK } from "../../frontend/src/lib/strategy/liquidity-strategy.js";
import { RULES as LIQUIDITY_RULES } from "../../frontend/src/lib/strategy/liquidity-confirmation.js";
const MAX_TRADES_PER_DAY = LIQUIDITY_RISK.maxTradesPerDay;
import { getMultiStrategySnapshot, getStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";
import type { StrategyFamily, StrategyId, StrategySetup } from "../../frontend/src/lib/strategy/types.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import {
  ENABLED_PAIR_STRATEGY_IDS, ENABLED_PAIR_STRATEGY_SEEDS, MULTISTRATEGY_EXPERIMENT_LABEL,
  MULTISTRATEGY_NAME, REPORTING_STRATEGY_IDS, SEED_STRATEGY_CONFIGS, STRATEGY_FAMILIES,
} from "../../frontend/src/lib/strategy/strategies/index.js";
import { USDJPY_STRATEGY_ID, resolveUsdjpyExit } from "../../frontend/src/lib/strategy/strategies/usdjpy-strategy.js";
import {
  AUDUSD_MAX_HOLD_BARS, AUDUSD_STRATEGY_ID, resolveAudusdExit,
} from "../../frontend/src/lib/strategy/strategies/audusd-strategy.js";
import {
  NZDUSD_MAX_HOLD_BARS, NZDUSD_STRATEGY_ID, resolveNzdusdExit,
} from "../../frontend/src/lib/strategy/strategies/nzdusd-strategy.legacy.js";
import {
  GBPUSD_MAX_HOLD_BARS, GBPUSD_STRATEGY_ID, gbpusdOverlapDecision, resolveGbpusdExit,
  type GbpusdExecutionBlockReason, type GbpusdOriginCode,
} from "../../frontend/src/lib/strategy/strategies/gbpusd-strategy.js";
import { USDCAD_STRATEGY_ID, resolveUsdcadExit } from "../../frontend/src/lib/strategy/strategies/usdcad-strategy.js";
import { USDCHF_STRATEGY_ID, resolveUsdchfExit } from "../../frontend/src/lib/strategy/strategies/usdchf-strategy.js";
import { NZDUSD_CONSENSUS_STRATEGY_ID, resolveNzdusdConsensusExit } from "../../frontend/src/lib/strategy/strategies/nzdusd-consensus-strategy.js";
import { EURJPY_STRATEGY_ID, resolveEurjpyExit } from "../../frontend/src/lib/strategy/strategies/eurjpy-strategy.js";
import { CADJPY_STRATEGY_ID, resolveCadjpyExit } from "../../frontend/src/lib/strategy/strategies/cadjpy-strategy.js";
import { AUDJPY_STRATEGY_ID, resolveAudjpyExit } from "../../frontend/src/lib/strategy/strategies/audjpy-strategy.js";
import { EURAUD_STRATEGY_ID, resolveEuraudExit } from "../../frontend/src/lib/strategy/strategies/euraud-strategy.js";
import { NZDJPY_STRATEGY_ID, resolveNzdjpyExit } from "../../frontend/src/lib/strategy/strategies/nzdjpy-strategy.js";
import type { FrozenH1ExitInput, FrozenH1ExitResult } from "../../frontend/src/lib/strategy/strategies/frozen-h1-pair.js";
import { decideInstrument, loadAdaptiveEvidence, toAdaptiveCandidate } from "./adaptive-engine.js";
import { resolveShadowOutcome } from "./shadow-outcomes.js";
import { recordMomentumShortPair, resolveMomentumShortInversion } from "./momentum-short-inversion.js";
import { applyMomentumInversion, ensureMomentumInversionActivation, MOMENTUM_INVERSION_EXPERIMENT } from "./momentum-inversion.js";
import { tagNewTradeSafely } from "./news-tagging.js";
import { armForExecutedDirection, spreadCostR } from "./evidence-integrity.js";
import { attachMomentumExecution, recordMomentumInversionArms, resolveMomentumInversionArms } from "./momentum-arms.js";
import { recordMomentumDirection10m, resolveMomentumDirection10m } from "./momentum-direction-10m.js";
import { runEurUsdMoveGateV1Shadow } from "./eur-usd-move-gate-v1-shadow.js";
import { MAJOR_INSTRUMENTS, type MajorInstrument } from "../../frontend/src/types/forex.js";
import { measureBrokerExecution, requiresBrokerCloseConfirmation } from "./execution-measurement.js";
import { reconcileClosedExecutionMeasurements } from "./reconcile-execution-measurements.js";

const STRATEGY_NAME = "deterministic-forex";
const BATCH_SIZE = 100;
const COLLECTOR_LOCK = 24_100_001;

/**
 * Explicit strategy attribution written onto a multi-strategy trade/evaluation.
 * When absent, a call is the legacy single-strategy (liquidity) path and the
 * new columns stay null.
 */
export type StrategyAttribution = {
  versionId: string;
  family: string;
  version: string;
  configVersion: string;
  experimentId: string;
  regime: string | null;
  trendStrength: number | null;
  volatilityBucket: string | null;
  atrPips: number | null;
  /** What the strategy predicted, when an execution policy changed it. */
  originalDirection?: "long" | "short" | null;
  inverted?: boolean;
  inversionExperimentId?: string | null;
};

export type PaperRiskConfiguration = {
  riskPercent: number;
  maxSimultaneousPositions: number | null;
  maxTotalNominalRiskPercent: number | null;
};

const DEFAULT_PAPER_RISK: PaperRiskConfiguration = {
  riskPercent: 1,
  maxSimultaneousPositions: null,
  maxTotalNominalRiskPercent: null,
};

type BatchConfiguration = {
  targetR: 2;
  excludedPairs: string[];
  excludedSessions: string[];
  sourceRecommendationBatch: number | null;
  riskPercent: number;
  maxSimultaneousPositions: number | null;
  maxTotalNominalRiskPercent: number | null;
};

function finiteNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePaperRiskConfiguration(value: unknown): PaperRiskConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Risk settings are required.");
  const input = value as Record<string, unknown>;
  const riskPercent = finiteNumber(input.riskPercent);
  if (riskPercent === null || riskPercent < 0.1 || riskPercent > 5) throw new Error("Risk per trade must be between 0.1% and 5%.");

  const maxPositions = input.maxSimultaneousPositions === null ? null : finiteNumber(input.maxSimultaneousPositions);
  if (input.maxSimultaneousPositions !== null && maxPositions === null) throw new Error("Choose a maximum position count or unlimited.");
  if (maxPositions !== null && (!Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > MAJOR_INSTRUMENTS.length)) {
    throw new Error(`Maximum simultaneous positions must be unlimited or between 1 and ${MAJOR_INSTRUMENTS.length}.`);
  }

  const maxExposure = input.maxTotalNominalRiskPercent === null ? null : finiteNumber(input.maxTotalNominalRiskPercent);
  if (input.maxTotalNominalRiskPercent !== null && maxExposure === null) throw new Error("Choose a total nominal exposure cap or unlimited.");
  if (maxExposure !== null && (maxExposure < riskPercent || maxExposure > 50)) throw new Error("Total nominal exposure must be unlimited or between the per-trade risk and 50%.");

  return { riskPercent, maxSimultaneousPositions: maxPositions, maxTotalNominalRiskPercent: maxExposure };
}

export function paperRiskAllowsEntry(configuration: PaperRiskConfiguration, openPositions: number, openNominalRiskPercent: number) {
  if (configuration.maxSimultaneousPositions !== null && openPositions >= configuration.maxSimultaneousPositions) return false;
  if (configuration.maxTotalNominalRiskPercent !== null && openNominalRiskPercent + configuration.riskPercent > configuration.maxTotalNominalRiskPercent + 1e-9) return false;
  return true;
}

function storedRiskConfiguration(value: unknown): PaperRiskConfiguration {
  try { return parsePaperRiskConfiguration(value); }
  catch { return { ...DEFAULT_PAPER_RISK }; }
}

async function policyRow(client: PoolClient, userId: string, lock = false) {
  await client.query("INSERT INTO paper_risk_policies(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
  const result = await client.query<{ active_configuration: unknown; pending_configuration: unknown; collection_paused: boolean }>(
    `SELECT active_configuration,pending_configuration,collection_paused FROM paper_risk_policies WHERE user_id=$1${lock ? " FOR UPDATE" : ""}`,
    [userId],
  );
  const row = result.rows[0]!;
  return {
    active: storedRiskConfiguration(row.active_configuration),
    pending: row.pending_configuration ? storedRiskConfiguration(row.pending_configuration) : null,
    collectionPaused: row.collection_paused,
  };
}

type OpenTradeRow = {
  id: string;
  user_id: string;
  instrument: MajorInstrument;
  decision_time: string | Date;
  direction: "long" | "short";
  entry: string;
  stop: string;
  target: string;
  nominal_risk_amount: string;
  strategy_family: string | null;
};

async function queueNotificationInTransaction(client: PoolClient, event: { userId: string; kind: "setup_ready" | "paper_opened" | "paper_closed" | "system_issue"; title: string; message: string; instrument: string | null; paperTradeId: string | null; dedupeKey: string }) {
  const inserted = await client.query(
    `INSERT INTO notification_events(user_id,kind,title,message,instrument,paper_trade_id,dedupe_key)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [event.userId, event.kind, event.title, event.message, event.instrument, event.paperTradeId, event.dedupeKey],
  );
  if (inserted.rowCount) void sendPushNotification(event).catch((error) => console.error("[push] delivery error", error));
}

export type StoredTrade = {
  id: string;
  trade_sequence: string;
  instrument: string;
  direction: "long" | "short";
  status: string;
  outcome: string;
  result_r: string | null;
  session: string;
  weekday: string;
  spread_pips: string;
  opened_at: string | Date;
  closed_at: string | Date | null;
  features?: Record<string, unknown>;
  conditions?: Array<{ name?: string; reason?: string; currentValue?: string }>;
};

function iso(value: string | Date) {
  return new Date(value).toISOString();
}

function closeTime(candleTime: string) {
  return new Date(new Date(candleTime).getTime() + 15 * 60_000).toISOString();
}

function toQuote(candle: Awaited<ReturnType<typeof getResearchCandles>>[number]): NormalizedQuote {
  return {
    closeTime: closeTime(candle.time),
    bidOpen: candle.bid.open,
    bidHigh: candle.bid.high,
    bidLow: candle.bid.low,
    bidClose: candle.bid.close,
    askOpen: candle.ask.open,
    askHigh: candle.ask.high,
    askLow: candle.ask.low,
    askClose: candle.ask.close,
  };
}

function toM30Quote(candle: Awaited<ReturnType<typeof getResearchCandles>>[number]): NormalizedQuote {
  return {
    closeTime: new Date(new Date(candle.time).getTime() + 30 * 60_000).toISOString(),
    bidOpen: candle.bid.open,
    bidHigh: candle.bid.high,
    bidLow: candle.bid.low,
    bidClose: candle.bid.close,
    askOpen: candle.ask.open,
    askHigh: candle.ask.high,
    askLow: candle.ask.low,
    askClose: candle.ask.close,
  };
}

function toH1Quote(candle: Awaited<ReturnType<typeof getResearchCandles>>[number]): NormalizedQuote {
  return {
    closeTime: new Date(new Date(candle.time).getTime() + 60 * 60_000).toISOString(),
    bidOpen: candle.bid.open,
    bidHigh: candle.bid.high,
    bidLow: candle.bid.low,
    bidClose: candle.bid.close,
    askOpen: candle.ask.open,
    askHigh: candle.ask.high,
    askLow: candle.ask.low,
    askClose: candle.ask.close,
  };
}

type FrozenH1Resolver = (input: FrozenH1ExitInput) => FrozenH1ExitResult | null;
const FROZEN_THREE_H1_RESOLVERS: Readonly<Record<string, FrozenH1Resolver>> = {
  [USDCAD_STRATEGY_ID]: resolveUsdcadExit,
  [USDCHF_STRATEGY_ID]: resolveUsdchfExit,
  [NZDUSD_CONSENSUS_STRATEGY_ID]: resolveNzdusdConsensusExit,
  [EURJPY_STRATEGY_ID]: resolveEurjpyExit,
  [CADJPY_STRATEGY_ID]: resolveCadjpyExit,
  [NZDJPY_STRATEGY_ID]: resolveNzdjpyExit,
  [AUDJPY_STRATEGY_ID]: resolveAudjpyExit,
  [EURAUD_STRATEGY_ID]: resolveEuraudExit,
};

function weekdayAt(value: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: DAY_TRADING_TIME_ZONE, weekday: "long" }).format(new Date(value));
}

/** Legacy column: v2 has no weighted score, so store required-gate completion. */
function checklistScore(setup: StrategySetup) {
  const liquidity = setup.features.liquidity;
  if (liquidity && liquidity.scoreOutOf > 0) return liquidity.score / liquidity.scoreOutOf;
  const required = setup.conditions.filter((item) => item.required);
  return required.length ? required.filter((item) => item.passed).length / required.length : 0;
}

/**
 * What the trade was taken on, in words — the level swept and how it confirmed.
 *
 * This was a hardcoded "Bundled EMA pullback day strategy" left behind by the
 * retired strategy, which would have stamped every macro-liquidity-v1 trade
 * with the name of the system it replaced.
 */
function setupNameFor(setup: StrategySetup) {
  const liquidity = setup.features.liquidity;
  if (!liquidity) return ACTIVE_STRATEGY_VERSION;
  const confirmation = liquidity.rejection && liquidity.displacement ? "rejection + displacement"
    : liquidity.rejection ? "rejection"
      : liquidity.displacement ? "displacement"
        : "no confirmation";
  return `${liquidity.sweptLevelKind} sweep, ${confirmation}`;
}

export function paperBatchMetrics(rows: StoredTrade[]) {
  const resolved = rows
    .filter((row) => row.status === "closed" && row.result_r !== null)
    .map((row) => ({ ...row, resultR: Number(row.result_r) }))
    .filter((row) => Number.isFinite(row.resultR));
  const wins = resolved.filter((row) => row.resultR > 0);
  const losses = resolved.filter((row) => row.resultR < 0);
  const totalR = resolved.reduce((sum, row) => sum + row.resultR, 0);
  const grossProfit = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, row) => sum + row.resultR, 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const row of resolved.sort((a, b) => Number(a.trade_sequence) - Number(b.trade_sequence))) {
    equity += row.resultR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    assigned: rows.length,
    open: rows.filter((row) => row.status === "open").length,
    ambiguous: rows.filter((row) => row.status === "ambiguous").length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolved.length ? wins.length / resolved.length : null,
    averageR: resolved.length ? totalR / resolved.length : null,
    expectancyR: resolved.length ? totalR / resolved.length : null,
    netR: totalR,
    averageWinR: wins.length ? grossProfit / wins.length : null,
    averageLossR: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdownR,
  };
}

export function paperBreakdown(rows: StoredTrade[], field: "instrument" | "direction" | "session" | "weekday") {
  const groups = new Map<string, StoredTrade[]>();
  for (const row of rows) {
    const key = String(row[field]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([group, trades]) => {
    const summary = paperBatchMetrics(trades);
    return { group, ...summary, evidenceEligible: summary.resolved >= 20 };
  }).sort((a, b) => b.resolved - a.resolved || a.group.localeCompare(b.group));
}

function customBreakdown(rows: StoredTrade[], groupFor: (row: StoredTrade) => string) {
  const groups = new Map<string, StoredTrade[]>();
  for (const row of rows) {
    const group = groupFor(row);
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return [...groups.entries()].map(([group, trades]) => {
    const summary = paperBatchMetrics(trades);
    return { group, ...summary, evidenceEligible: summary.resolved >= 20 };
  }).sort((a, b) => b.resolved - a.resolved || a.group.localeCompare(b.group));
}

function volatilityGroup(row: StoredTrade) {
  const atr = Number(row.features?.atrPips);
  if (!Number.isFinite(atr)) return "Unavailable";
  return atr < 5 ? "Low (<5 ATR pips)" : atr < 10 ? "Normal (5–10 ATR pips)" : "High (10+ ATR pips)";
}

function spreadGroup(row: StoredTrade) {
  const spread = Number(row.spread_pips);
  return spread < 1 ? "Under 1 pip" : spread <= 2 ? "1–2 pips" : "Over 2 pips";
}

function confirmationGroup(row: StoredTrade) {
  // The live strategy records how the reclaim confirmed (rejection, displacement,
  // or both) on the setup's features; the retired "Confirmation candle" gate it
  // used to read no longer exists, so every trade grouped as "Unavailable".
  const liquidity = row.features?.liquidity as { confirmationType?: string } | undefined;
  return liquidity?.confirmationType ? liquidity.confirmationType.replaceAll("_", " ") : "Unavailable";
}

export function buildPaperRecommendation(rows: StoredTrade[]) {
  const candidates = [
    ...paperBreakdown(rows, "instrument").map((item) => ({ ...item, type: "exclude_pair" as const })),
    ...paperBreakdown(rows, "session").map((item) => ({ ...item, type: "exclude_session" as const })),
  ].filter((item) => item.evidenceEligible && item.averageR !== null && item.averageR < 0)
    .sort((left, right) => (left.averageR ?? 0) - (right.averageR ?? 0));
  const worst = candidates[0];
  if (!worst) return null;
  return {
    type: worst.type,
    value: worst.group,
    sampleSize: worst.resolved,
    averageR: worst.averageR,
    profitFactor: worst.profitFactor,
    rationale: `${worst.group} produced ${worst.averageR!.toFixed(2)}R average across ${worst.resolved} resolved trades. Exclusion is a hypothesis for the next unopened batch, not proof.`,
  };
}

/**
 * The strategy's row, created on first use.
 *
 * Changing ACTIVE_STRATEGY_VERSION used to require someone to remember to
 * insert a row by hand, and the failure said "the migration has not been
 * applied" — which sent you looking at migrations that were fine. Registering
 * it here means switching strategies is a code change and nothing else.
 *
 * The stored configuration is the numbers the strategy actually ran with, so a
 * batch can always be traced back to the thresholds that produced it. Those
 * numbers are what the next batch is meant to change: a version that quietly
 * ran two different rule sets would make its hundred trades unreadable.
 */
async function strategyVersionId(client?: PoolClient) {
  const configuration = JSON.stringify({
    direction: "confirmed H1 market structure",
    pullback: "ATR-normalized counter-trend move with H1 structure intact",
    admission: "explicit technical and safety gates; no weighted score",
    risk: LIQUIDITY_RISK,
    rules: LIQUIDITY_RULES,
    sessions: "London and New York, flat at 16:45 ET",
    macro: "FRED long-term rate differential, monthly",
  });
  const upsert = `INSERT INTO strategy_versions(name,version,configuration) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(name,version) DO UPDATE
       SET configuration=strategy_versions.configuration || EXCLUDED.configuration
     RETURNING id`;
  const values = [STRATEGY_NAME, ACTIVE_STRATEGY_VERSION, configuration];
  const result = client
    ? await client.query<{ id: string }>(upsert, values)
    : await query<{ id: string }>(upsert, values);
  return result.rows[0]!.id;
}

async function ensureCollectingBatch(client: PoolClient, versionId: string, userId: string, attribution?: StrategyAttribution) {
  const existing = await client.query<{ id: string; batch_number: number; configuration: BatchConfiguration }>(
    // Scoped to the strategy version. Without this a strategy change appends
    // its trades to whatever batch happens to be collecting, and the hundred
    // that get analysed together describe two different systems mixed.
    "SELECT id,batch_number,configuration FROM paper_strategy_batches WHERE status='collecting' AND assigned_count<100 AND strategy_version_id=$1 ORDER BY batch_number DESC LIMIT 1 FOR UPDATE",
    [versionId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const next = await client.query<{ number: number }>("SELECT COALESCE(max(batch_number),0)+1 AS number FROM paper_strategy_batches");
  const batchNumber = Number(next.rows[0]!.number);
  const approved = await client.query<{ id: string; batch_number: number; recommendation: { type: string; value: string } }>(
    "SELECT id,batch_number,recommendation FROM paper_strategy_batches WHERE decision='approved' AND recommendation IS NOT NULL AND applied_to_batch_id IS NULL AND status='complete' ORDER BY batch_number LIMIT 1 FOR UPDATE",
  );
  const source = approved.rows[0];
  const policy = await policyRow(client, userId, true);
  const risk = policy.pending ?? policy.active;
  if (policy.pending) {
    await client.query("UPDATE paper_risk_policies SET active_configuration=$2::jsonb,pending_configuration=NULL,updated_at=now() WHERE user_id=$1", [userId, JSON.stringify(risk)]);
  }
  const configuration: BatchConfiguration = {
    targetR: 2,
    excludedPairs: source?.recommendation.type === "exclude_pair" ? [source.recommendation.value] : [],
    excludedSessions: source?.recommendation.type === "exclude_session" ? [source.recommendation.value] : [],
    sourceRecommendationBatch: source?.batch_number ?? null,
    ...risk,
  };
  const created = await client.query<{ id: string; batch_number: number; configuration: BatchConfiguration }>(
    "INSERT INTO paper_strategy_batches(batch_number,strategy_version_id,universe,configuration,experiment_id,strategy_family) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) RETURNING id,batch_number,configuration",
    [batchNumber, versionId, JSON.stringify(MAJOR_INSTRUMENTS), JSON.stringify(configuration), attribution?.experimentId ?? null, attribution?.family ?? null],
  );
  if (source) await client.query("UPDATE paper_strategy_batches SET applied_to_batch_id=$2 WHERE id=$1", [source.id, created.rows[0]!.id]);
  return created.rows[0]!;
}

async function persistWatchSnapshot(setup: StrategySetup, quote: { bid: number; ask: number; time: string } | undefined, versionId: string) {
  const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(setup.instrument) : null;
  const open = await query<{ id: string; batch_number: number }>(
    "SELECT trade.id,batch.batch_number FROM paper_strategy_trades trade JOIN paper_strategy_batches batch ON batch.id=trade.batch_id WHERE trade.instrument=$1 AND trade.status='open' LIMIT 1",
    [setup.instrument],
  );
  const fresh = quote && Date.now() - new Date(quote.time).getTime() <= 2 * 60_000;
  await query(
    `INSERT INTO paper_watch_snapshots(instrument,strategy_version_id,evaluated_at,data_status,setup_status,direction,bid,ask,spread_pips,entry,stop,target,session,conditions,features,open_trade_id,batch_number)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17)
     ON CONFLICT(instrument) DO UPDATE SET strategy_version_id=EXCLUDED.strategy_version_id,evaluated_at=EXCLUDED.evaluated_at,data_status=EXCLUDED.data_status,setup_status=EXCLUDED.setup_status,direction=EXCLUDED.direction,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread_pips=EXCLUDED.spread_pips,entry=EXCLUDED.entry,stop=EXCLUDED.stop,target=EXCLUDED.target,session=EXCLUDED.session,conditions=EXCLUDED.conditions,features=EXCLUDED.features,open_trade_id=EXCLUDED.open_trade_id,batch_number=EXCLUDED.batch_number,updated_at=now()`,
    [setup.instrument, versionId, setup.evaluatedAt, setup.dataSource === "oanda" && fresh ? "connected" : "unavailable", setup.status, setup.direction, quote?.bid ?? null, quote?.ask ?? null, spreadPips, setup.entry, setup.stop, setup.target, strategySession(setup), JSON.stringify(setup.conditions), JSON.stringify(setup.features), open.rows[0]?.id ?? null, open.rows[0]?.batch_number ?? null],
  );
}

function setupRejectionReason(setup: StrategySetup) {
  return setup.conditions.find((item) => item.required && !item.passed)?.reason ?? null;
}

function strategySession(setup: StrategySetup) {
  return setup.features.gbpusdStrategy?.origin
    ? `GBPUSD_${setup.features.gbpusdStrategy.originCode}_UTC`
    : setup.features.audusdStrategy ? "AUDUSD_11_UTC"
    : setup.features.nzdusdStrategy ? "NZDUSD_11_UTC"
    : setup.features.frozenPairStrategy
      ? `${setup.features.frozenPairStrategy.strategyId.toUpperCase()}_${String(setup.features.frozenPairStrategy.originHourUtc).padStart(2, "0")}_UTC`
    : setup.features.usdjpyStrategy?.session
    ?? setup.features.eurusdStrategy?.session
    ?? dayTradingSession(new Date(setup.evaluatedAt)).label;
}

type OpenExecutionLeg = {
  strategy_family: string | null;
  direction: "long" | "short";
  features: Record<string, any> | null;
};

type ExecutionBlock = { code: GbpusdExecutionBlockReason | "SPREAD_BLOCK" | "POSITION_LIMIT"; message: string };

function gbpusdExecutionBlock(
  setup: StrategySetup,
  openLegs: readonly OpenExecutionLeg[],
  hedgingEnabled: boolean,
  strategyFamily?: string | null,
): ExecutionBlock | null {
  if (strategyFamily !== GBPUSD_STRATEGY_ID || !setup.direction) {
    return openLegs.length ? { code: "GLOBAL_RISK_BLOCK", message: "Execution blocked: this instrument already has an open position." } : null;
  }
  const originCode = setup.features.gbpusdStrategy?.originCode;
  if (!originCode) {
    return { code: "GLOBAL_RISK_BLOCK", message: "Execution blocked: GBPUSD origin identity is unavailable." };
  }
  const verdict = gbpusdOverlapDecision({
    originCode,
    direction: setup.direction,
    hedgingEnabled,
    openLegs: openLegs.map((leg) => ({
      strategyId: leg.strategy_family,
      direction: leg.direction,
      originCode: leg.features?.gbpusdStrategy?.originCode ?? null,
    })),
  });
  if (verdict.allowed) return null;
  if (verdict.blockReason === "BLOCKED_OPPOSITE_POSITION") {
    return { code: verdict.blockReason, message: "BLOCKED_OPPOSITE_POSITION: OANDA account netting would alter the existing GBPUSD leg." };
  }
  if (verdict.blockReason === "DUPLICATE_SIGNAL") {
    return { code: verdict.blockReason, message: "Duplicate GBPUSD origin signal: this UTC-day origin is already active." };
  }
  return { code: "GLOBAL_RISK_BLOCK", message: "Execution blocked: another strategy already owns GBPUSD exposure." };
}

/**
 * How `execution_status` may change when the same decision is written again.
 *
 * `decision_time` is the completed M15 bar, but the collector runs far more
 * often than every fifteen minutes, so every later tick inside the same bar
 * rewrites this very row. By then the trade this decision opened is itself open,
 * the instrument reads as busy, and the candidate re-evaluates as 'blocked' —
 * which used to overwrite the 'selected' the executing tick had written moments
 * earlier. Every executed multi-strategy trade ended up filed as blocked.
 *
 * An execution that already happened is settled history; only a row that has not
 * executed may be restated by a later look at the same bar. Exported so the
 * regression test exercises this exact clause rather than a copy of it.
 */
export const EXECUTION_STATUS_CONFLICT_RULE =
  "execution_status=CASE WHEN paper_strategy_evaluations.execution_status='selected' THEN paper_strategy_evaluations.execution_status ELSE EXCLUDED.execution_status END";

/** A traded signal's decision-time facts must survive later ticks in the bar. */
export const EVALUATION_SNAPSHOT_CONFLICT_RULE = [
  'setup_status','direction','entry','stop','target','risk_reward','spread_pips',
  'conditions','features','strategy_family','config_version','regime','trend_strength',
  'volatility_bucket','atr_pips','experiment_id',
].map((field) => `${field}=CASE WHEN paper_strategy_evaluations.setup_status='valid' OR paper_strategy_evaluations.execution_status='selected' OR paper_strategy_evaluations.trade_created OR paper_strategy_evaluations.paper_trade_id IS NOT NULL THEN paper_strategy_evaluations.${field} ELSE EXCLUDED.${field} END`).join(',')
  + ",rejection_reason=CASE WHEN paper_strategy_evaluations.setup_status='valid' OR paper_strategy_evaluations.execution_status='selected' THEN paper_strategy_evaluations.rejection_reason ELSE COALESCE(EXCLUDED.rejection_reason,paper_strategy_evaluations.rejection_reason) END";

async function persistPaperEvaluation(
  setup: StrategySetup,
  versionId: string,
  spreadPips: number | null,
  attribution?: StrategyAttribution,
  executionStatus?: string,
  executionRejectionReason?: string | null,
  executionBlockCode?: ExecutionBlock["code"] | null,
) {
  const persistedFeatures = executionBlockCode && executionBlockCode !== "DUPLICATE_SIGNAL"
    ? setup.features.gbpusdStrategy ? {
      ...setup.features,
      gbpusdStrategy: { ...setup.features.gbpusdStrategy, exitReason: executionBlockCode },
    } : setup.features.audusdStrategy ? {
      ...setup.features,
      audusdStrategy: { ...setup.features.audusdStrategy, exitReason: executionBlockCode },
    } : setup.features.nzdusdStrategy ? {
      ...setup.features,
      nzdusdStrategy: { ...setup.features.nzdusdStrategy, blockReason: executionBlockCode },
    } : setup.features
    : setup.features;
  await query(
    `INSERT INTO paper_strategy_evaluations(strategy_version_id,instrument,decision_time,setup_status,direction,entry,stop,target,risk_reward,rejection_reason,trade_created,spread_pips,conditions,features,strategy_family,config_version,regime,trend_strength,volatility_bucket,atr_pips,experiment_id,execution_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT(strategy_version_id,instrument,decision_time) DO UPDATE SET ${EVALUATION_SNAPSHOT_CONFLICT_RULE},${EXECUTION_STATUS_CONFLICT_RULE},updated_at=now()`,
    [versionId, setup.instrument, setup.evaluatedAt, setup.status, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, executionRejectionReason ?? setupRejectionReason(setup), spreadPips, JSON.stringify(setup.conditions), JSON.stringify(persistedFeatures), attribution?.family ?? null, attribution?.configVersion ?? null, attribution?.regime ?? null, attribution?.trendStrength ?? null, attribution?.volatilityBucket ?? null, attribution?.atrPips ?? null, attribution?.experimentId ?? null, executionStatus ?? null],
  );
}

/**
 * The cost/net columns, written by every close path from what the row already
 * holds.
 *
 * `net_result_r` is set EQUAL to `result_r`, which is not a shortcut. Entry is
 * taken on the executable side (ask for a long, bid for a short) and
 * `labelOutcome` resolves the exit against the opposite side of the book, so a
 * full spread is already charged inside the stored figure. Subtracting a spread
 * cost from it would charge the spread twice and invent a loss that was never
 * paid; the reconstruction runs the other way, and `gross_result_r` is what the
 * trade would have made mid-to-mid.
 *
 * `result_basis` records which resolver produced the number. A broker close
 * derives R from the cash OANDA booked and therefore carries real exit slippage;
 * a paper close derives it from the modelled level. Both are legitimate, but
 * they are different measurements and evidence must be able to tell them apart.
 */
function costColumnsSql(resultParam: string, basis: "broker" | "model") {
  const r = `${resultParam}::numeric`;
  return `net_result_r=${r},`
    + "total_cost_r=spread_cost_r,"
    + `gross_result_r=CASE WHEN ${r} IS NULL OR spread_cost_r IS NULL THEN NULL ELSE ${r}+spread_cost_r END,`
    + "cost_basis=CASE WHEN spread_cost_r IS NULL THEN 'unknown' ELSE 'spread_only' END,"
    + `result_basis='${basis}'`;
}

/** Keep pair-specific structured journal payloads aligned with ledger closes. */
function pairExitFeaturesSql(input: {
  exitParam: string;
  resultRParam: string;
  pnlParam: string;
  closedAtSql: string;
  exitReasonParam: string;
}) {
  const gbpusd = "jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(features,"
    + `'{gbpusdStrategy,actualExit}',COALESCE(to_jsonb(${input.exitParam}::numeric),'null'::jsonb),true),`
    + `'{gbpusdStrategy,exitTimeUtc}',to_jsonb((${input.closedAtSql})::timestamptz),true),`
    + `'{gbpusdStrategy,exitReason}',to_jsonb(${input.exitReasonParam}::text),true),`
    + `'{gbpusdStrategy,realizedPnL}',COALESCE(to_jsonb(${input.pnlParam}::numeric),'null'::jsonb),true),`
    + `'{gbpusdStrategy,realizedR}',COALESCE(to_jsonb(${input.resultRParam}::numeric),'null'::jsonb),true)`;
  const audusd = "jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(features,"
    + `'{audusdStrategy,actualExit}',COALESCE(to_jsonb(${input.exitParam}::numeric),'null'::jsonb),true),`
    + `'{audusdStrategy,exitTimeUtc}',to_jsonb((${input.closedAtSql})::timestamptz),true),`
    + `'{audusdStrategy,exitReason}',to_jsonb(${input.exitReasonParam}::text),true),`
    + `'{audusdStrategy,realizedPnL}',COALESCE(to_jsonb(${input.pnlParam}::numeric),'null'::jsonb),true),`
    + `'{audusdStrategy,realizedR}',COALESCE(to_jsonb(${input.resultRParam}::numeric),'null'::jsonb),true)`;
  const nzdusd = "jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(features,"
    + `'{nzdusdStrategy,actualExit}',COALESCE(to_jsonb(${input.exitParam}::numeric),'null'::jsonb),true),`
    + `'{nzdusdStrategy,exitTimeUtc}',to_jsonb((${input.closedAtSql})::timestamptz),true),`
    + `'{nzdusdStrategy,exitReason}',to_jsonb(${input.exitReasonParam}::text),true),`
    + `'{nzdusdStrategy,realizedPnL}',COALESCE(to_jsonb(${input.pnlParam}::numeric),'null'::jsonb),true),`
    + `'{nzdusdStrategy,realizedR}',COALESCE(to_jsonb(${input.resultRParam}::numeric),'null'::jsonb),true)`;
  const frozenH1 = "jsonb_set(jsonb_set(jsonb_set(jsonb_set(features,"
    + `'{frozenPairStrategy,actualExit}',COALESCE(to_jsonb(${input.exitParam}::numeric),'null'::jsonb),true),`
    + `'{frozenPairStrategy,exitTimeUtc}',to_jsonb((${input.closedAtSql})::timestamptz),true),`
    + `'{frozenPairStrategy,exitReason}',to_jsonb(${input.exitReasonParam}::text),true),`
    + `'{frozenPairStrategy,realizedR}',COALESCE(to_jsonb(${input.resultRParam}::numeric),'null'::jsonb),true)`;
  return `features=CASE WHEN strategy_family='${GBPUSD_STRATEGY_ID}' THEN ${gbpusd} `
    + `WHEN strategy_family='${AUDUSD_STRATEGY_ID}' THEN ${audusd} `
    + `WHEN strategy_family='${NZDUSD_STRATEGY_ID}' THEN ${nzdusd} `
    + `WHEN features ? 'frozenPairStrategy' THEN ${frozenH1} `
    + "ELSE features END";
}

async function openPaperTrade(
  setup: StrategySetup,
  userId: string,
  versionId: string,
  spreadPips: number,
  accountBalance: number,
  quoteToUsdRate: number | null,
  attribution?: StrategyAttribution,
  hedgingEnabled = false,
): Promise<string | null> {
  if (setup.status !== "valid" || !setup.direction || setup.entry === null || setup.stop === null || setup.target === null || setup.riskReward === null) return null;
  const entry = setup.entry;
  const stop = setup.stop;
  const usdjpyMetadata = setup.features.usdjpyStrategy;
  const gbpusdMetadata = setup.features.gbpusdStrategy;
  const audusdMetadata = setup.features.audusdStrategy;
  const nzdusdMetadata = setup.features.nzdusdStrategy;
  const nzdjpyMetadata = setup.features.nzdjpyStrategy;
  const cadjpyMetadata = setup.features.cadjpyStrategy;
  const eurjpyMetadata = setup.features.eurjpyStrategy;
  const usdchfMetadata = setup.features.usdchfStrategy;
  const usdcadMetadata = setup.features.usdcadStrategy;
  const nzdusdConsensusMetadata = setup.features.nzdusdConsensusStrategy;
  const frozenH1Metadata = setup.features.frozenPairStrategy;
  const session = strategySession(setup);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COLLECTOR_LOCK]);
    const reject = async (reason: string, code: "GLOBAL_RISK_BLOCK" | "BLOCKED_OPPOSITE_POSITION" | "SPREAD_BLOCK" | "POSITION_LIMIT" | "EXECUTION_ERROR" | null = null) => {
      await client.query(
        `UPDATE paper_strategy_evaluations
            SET rejection_reason=$1,
                features=CASE WHEN $5::text IS NOT NULL AND strategy_family=$6
                  THEN jsonb_set(features,'{gbpusdStrategy,exitReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$7
                  THEN jsonb_set(features,'{audusdStrategy,exitReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$8
                  THEN jsonb_set(features,'{nzdusdStrategy,blockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$9
                  THEN jsonb_set(
                    jsonb_set(features,'{nzdjpyStrategy,executionAllowed}','false'::jsonb,true),
                    '{nzdjpyStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$10
                  THEN jsonb_set(
                    jsonb_set(features,'{cadjpyStrategy,executionAllowed}','false'::jsonb,true),
                    '{cadjpyStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$11
                  THEN jsonb_set(
                    jsonb_set(features,'{eurjpyStrategy,executionAllowed}','false'::jsonb,true),
                    '{eurjpyStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$12
                  THEN jsonb_set(
                    jsonb_set(features,'{usdchfStrategy,executionAllowed}','false'::jsonb,true),
                    '{usdchfStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$13
                  THEN jsonb_set(
                    jsonb_set(features,'{usdcadStrategy,executionAllowed}','false'::jsonb,true),
                    '{usdcadStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  WHEN $5::text IS NOT NULL AND strategy_family=$14
                  THEN jsonb_set(
                    jsonb_set(features,'{nzdusdConsensusStrategy,executionAllowed}','false'::jsonb,true),
                    '{nzdusdConsensusStrategy,executionBlockReason}',to_jsonb($5::text),true)
                  ELSE features END,
                updated_at=now()
          WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4 AND trade_created=false`,
        [reason, versionId, setup.instrument, setup.evaluatedAt, code, GBPUSD_STRATEGY_ID, AUDUSD_STRATEGY_ID, NZDUSD_STRATEGY_ID, NZDJPY_STRATEGY_ID, CADJPY_STRATEGY_ID, EURJPY_STRATEGY_ID, USDCHF_STRATEGY_ID, USDCAD_STRATEGY_ID, NZDUSD_CONSENSUS_STRATEGY_ID],
      );
      return null;
    };
    const policy = await policyRow(client, userId, true);
    if (policy.collectionPaused) return reject("Risk blocked: paper collection is paused.", "GLOBAL_RISK_BLOCK");
    const open = await client.query<OpenExecutionLeg>(
      "SELECT strategy_family,direction,features FROM paper_strategy_trades WHERE instrument=$1 AND status='open' FOR UPDATE",
      [setup.instrument],
    );
    const overlapBlock = gbpusdExecutionBlock(setup, open.rows, hedgingEnabled, attribution?.family);
    if (overlapBlock?.code === "DUPLICATE_SIGNAL") return null;
    if (overlapBlock) return reject(overlapBlock.message, overlapBlock.code);
    const duplicate = await client.query("SELECT 1 FROM paper_strategy_trades WHERE strategy_version_id=$1 AND instrument=$2 AND decision_time=$3", [versionId, setup.instrument, setup.evaluatedAt]);
    if (duplicate.rowCount) return null;
    const batch = await ensureCollectingBatch(client, versionId, userId, attribution);
    if (batch.configuration.excludedPairs.includes(setup.instrument) || batch.configuration.excludedSessions.includes(session)) return reject("Risk blocked: the active batch excludes this pair or session.", "GLOBAL_RISK_BLOCK");
    const risk = storedRiskConfiguration(batch.configuration);
    const portfolio = await client.query<{ open_count: string; nominal_risk: string }>("SELECT count(*)::text AS open_count,COALESCE(sum(nominal_risk_percent),0)::text AS nominal_risk FROM paper_strategy_trades WHERE status='open'");
    const openCount = Number(portfolio.rows[0]!.open_count);
    const nominalRisk = Number(portfolio.rows[0]!.nominal_risk);
    if (!paperRiskAllowsEntry(risk, openCount, nominalRisk)) return reject(
      "Risk blocked: the portfolio position or nominal-risk limit was reached.",
      attribution?.family === AUDUSD_STRATEGY_ID || attribution?.family === NZDUSD_STRATEGY_ID ? "POSITION_LIMIT" : "GLOBAL_RISK_BLOCK",
    );

    // A cap on how many the day is allowed to produce, so a busy morning cannot
    // spend the batch. Counted on the ET day the strategy trades in, not UTC.
    // Null lifts it entirely and skips the count, which otherwise runs on every
    // qualifying setup — see `RISK.maxTradesPerDay` for why it is off.
    if (MAX_TRADES_PER_DAY !== null) {
      const takenToday = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM paper_strategy_trades
         WHERE strategy_version_id=$1 AND (opened_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`,
        [versionId],
      );
      if (Number(takenToday.rows[0]!.count) >= MAX_TRADES_PER_DAY) return reject("Risk blocked: the daily trade limit was reached.", "GLOBAL_RISK_BLOCK");
    }
    // A true cross (EUR_GBP, EUR_JPY, GBP_JPY) is quoted in a non-USD currency
    // whose USD value cannot be read from its own price, so without the cross
    // rate its size — and every R and lot figure derived from it — is wrong.
    // Fail the entry closed rather than record a mis-sized trade into the data.
    const { base, quote } = currenciesOf(setup.instrument);
    const isTrueCross = base !== "USD" && quote !== "USD";
    if (isTrueCross && (quoteToUsdRate === null || !Number.isFinite(quoteToUsdRate) || quoteToUsdRate <= 0)) {
      return reject("Risk blocked: no USD conversion rate for the quote currency, so position size cannot be trusted.", "GLOBAL_RISK_BLOCK");
    }
    const positionSize = calculatePositionSize({ instrument: setup.instrument, accountBalance, riskPercent: risk.riskPercent, entry, stop, applyPaperCap: false, quoteToUsdRate: quoteToUsdRate ?? undefined });
    if (!positionSize) return reject("Risk blocked: no valid position size could be calculated.", "GLOBAL_RISK_BLOCK");
    const nextSequence = await client.query<{ value: string }>("SELECT (COALESCE(max(trade_sequence),0)+1)::text AS value FROM paper_strategy_trades");
    const setupName = gbpusdMetadata?.signalLabel
      ?? usdjpyMetadata?.setup
      ?? audusdMetadata?.strategyName
      ?? nzdusdMetadata?.strategyName
      ?? frozenH1Metadata?.strategyName
      ?? setup.features.eurusdStrategy?.setup
      ?? (attribution ? `${attribution.family} ${setup.direction}` : setupNameFor(setup));
    // The canonical executed link, resolved BEFORE the insert so the trade
    // carries it from birth. The UPDATE further down still stamps the evaluation
    // side, but that UPDATE is exactly what silently matched zero rows for 48 of
    // 55 multi-strategy trades; a column on the trade, backed by a unique index,
    // cannot drift the same way. Null only when no evaluation row exists at all
    // (the legacy pre-evaluations path), and that stays honestly null.
    const evaluation = await client.query<{ id: string }>(
      "SELECT id FROM paper_strategy_evaluations WHERE strategy_version_id=$1 AND instrument=$2 AND decision_time=$3",
      [versionId, setup.instrument, setup.evaluatedAt],
    );
    const evaluationId = evaluation.rows[0]?.id ?? null;
    // Computed at open, from the spread actually quoted at the decision. Waiting
    // until close would mean reading a spread that no longer exists.
    const spreadCost = spreadCostR({ instrument: setup.instrument, entry, stop, spreadPips });
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO paper_strategy_trades(trade_sequence,user_id,batch_id,strategy_version_id,instrument,decision_time,direction,entry,stop,target,planned_r,nominal_risk_percent,nominal_risk_amount,calculated_units,calculated_standard_lots,spread_pips,session,weekday,setup_name,checklist_score,conditions,features,news_status,opened_at,strategy_family,config_version,regime,trend_strength,volatility_bucket,atr_pips,experiment_id,original_direction,inverted,inversion_experiment_id,evaluation_id,spread_cost_r,signal_price,actual_fill_price,max_hold_bars,bars_held)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
       RETURNING id`,
      [nextSequence.rows[0]!.value, userId, batch.id, versionId, setup.instrument, setup.evaluatedAt, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, risk.riskPercent, positionSize.calculatedEstimatedRisk, positionSize.calculatedUnits, positionSize.calculatedStandardLots, spreadPips, session, weekdayAt(setup.evaluatedAt), setupName, checklistScore(setup), JSON.stringify(setup.conditions), JSON.stringify(setup.features), setup.features.newsStatus ?? "not_evaluated", setup.evaluatedAt, attribution?.family ?? null, attribution?.configVersion ?? null, attribution?.regime ?? null, attribution?.trendStrength ?? null, attribution?.volatilityBucket ?? null, attribution?.atrPips ?? null, attribution?.experimentId ?? null,
       attribution?.originalDirection ?? null, attribution?.inverted ?? false, attribution?.inversionExperimentId ?? null, evaluationId, spreadCost,
         gbpusdMetadata?.signalClose ?? usdjpyMetadata?.signalPrice ?? audusdMetadata?.signalClose ?? nzdusdMetadata?.signalClose ?? nzdjpyMetadata?.signalMidClose ?? cadjpyMetadata?.signalMidClose ?? eurjpyMetadata?.signalMidClose ?? usdchfMetadata?.signalMidClose ?? usdcadMetadata?.signalMidClose ?? nzdusdConsensusMetadata?.signalMidClose ?? (frozenH1Metadata ? setup.entry : null), null,
         gbpusdMetadata?.maxHoldBars ?? usdjpyMetadata?.maximumHoldBars ?? audusdMetadata?.maximumHoldBars ?? nzdusdMetadata?.maximumHoldBars ?? nzdjpyMetadata?.maxHoldBars ?? cadjpyMetadata?.maxHoldBars ?? eurjpyMetadata?.maxHoldBars ?? usdchfMetadata?.maxHoldBars ?? usdcadMetadata?.maxHoldBars ?? nzdusdConsensusMetadata?.maxHoldBars ?? frozenH1Metadata?.maxHoldBars ?? null,
         gbpusdMetadata || usdjpyMetadata || audusdMetadata || nzdusdMetadata || frozenH1Metadata ? 0 : null],
    );
    const tradeId = inserted.rows[0]!.id;
    // The row this updates is written before execution is attempted, so it is
    // here — on a confirmed insert — that a decision becomes 'selected'. Keying
    // on the family's own strategy_version_id keeps it to the one candidate that
    // traded; the other families evaluated at this same instrument and
    // decision_time have their own version ids and are left alone.
    await client.query("UPDATE paper_strategy_evaluations SET trade_created=true,paper_trade_id=$1,execution_status='selected',rejection_reason=NULL,updated_at=now() WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4", [tradeId, versionId, setup.instrument, setup.evaluatedAt]);
    await queueNotificationInTransaction(client, {
      userId,
      kind: "paper_opened",
      title: `${displayPair(setup.instrument)} paper trade opened`,
      message: `${setup.direction === "long" ? "Long" : "Short"} plan accepted. Entry, target, and stop are available on Signals.`,
      instrument: setup.instrument,
      paperTradeId: tradeId,
      dedupeKey: `paper_opened:${tradeId}`,
    });
    const updated = await client.query<{ assigned_count: number }>("UPDATE paper_strategy_batches SET assigned_count=assigned_count+1,status=CASE WHEN assigned_count+1>=100 THEN 'resolving' ELSE status END WHERE id=$1 RETURNING assigned_count", [batch.id]);
    if (Number(updated.rows[0]!.assigned_count) > BATCH_SIZE) throw new Error("Paper batch exceeded 100 trades.");
    return tradeId;
  });
}

type BrokerClose = {
  outcome: "target_first" | "stop_first" | "forced_close";
  exit: number;
  resultR: number | null;
  paperPl: number | null;
  closedAt: string | null;
};

/**
 * What the broker actually did with a trade it executed, if it is finished.
 *
 * Preferred over reading candles for two reasons. The broker knows the instant
 * its own stop or take-profit fills, where a candle scan has to wait for the
 * M15 to complete and can sit up to fifteen minutes behind a position that no
 * longer exists. And it reports the price it filled at and the cash it booked,
 * rather than the level the order rested on: a stop that slips fills worse than
 * its trigger, and recording the trigger understates the loss.
 *
 * Returns null when the trade has no broker order or is still open, and the
 * caller falls back to the candle scan.
 */
async function brokerCloseFor(trade: OpenTradeRow): Promise<BrokerClose | null> {
  const intent = await query<{ broker_trade_id: string | null; calculated_units: string; inverted: boolean }>(
    "SELECT i.broker_trade_id,t.calculated_units,t.inverted FROM practice_order_intents i JOIN paper_strategy_trades t ON t.id=i.paper_trade_id WHERE i.paper_trade_id=$1 AND i.status='submitted'",
    [trade.id],
  );
  const brokerTradeId = intent.rows[0]?.broker_trade_id;
  if (!brokerTradeId) return null;

  let state: Awaited<ReturnType<typeof getPracticeTradeState>>;
  try {
    state = await getPracticeTradeState(brokerTradeId);
  } catch {
    // An unreachable broker must not strand the trade; the scan still runs.
    return null;
  }
  if (!state?.closed || state.averageClosePrice === null) return null;

  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const exit = state.averageClosePrice;
  // A fill slips past its trigger rather than short of it, so the comparison is
  // one-sided. The tolerance only covers a target filled marginally worse.
  const slack = Math.abs(entry - stop) * 0.05;
  const outcome: BrokerClose["outcome"] = trade.direction === "long"
    ? exit >= target - slack ? "target_first" : exit <= stop + slack ? "stop_first" : "forced_close"
    : exit <= target + slack ? "target_first" : exit >= stop - slack ? "stop_first" : "forced_close";

  const nominalRisk = Number(trade.nominal_risk_amount);
  const measurement = measureBrokerExecution({
    instrument: trade.instrument,
    direction: trade.direction,
    signalEntry: entry,
    stop,
    nominalRiskAmount: nominalRisk,
    requestedUnits: Number(intent.rows[0]!.calculated_units),
    inverted: intent.rows[0]!.inverted,
  }, state);
  if (measurement) {
    await query(
      "UPDATE paper_strategy_trades SET features=COALESCE(features,'{}'::jsonb)||jsonb_build_object('executionMeasurementV2',$2::jsonb) WHERE id=$1",
      [trade.id, JSON.stringify(measurement)],
    );
  }
  return {
    outcome,
    exit,
    // A capped broker order has less cash at risk than its paper sizing budget.
    // Use the executed fill's own size and stop distance, not that original
    // budget, so a real target cannot be reported as a fractional-R win.
    resultR: measurement?.cashRiskR ?? (
      state.realizedPL !== null && Number.isFinite(nominalRisk) && nominalRisk !== 0
        ? state.realizedPL / nominalRisk
        : null
    ),
    paperPl: state.realizedPL,
    closedAt: state.closeTime,
  };
}

/** Writes a broker-reported close onto the paper trade and notifies once. The
 *  status='open' guard makes it idempotent, so the 60s scan and the fast
 *  near-level check below can both call it without double-closing. */
async function bookBrokerClose(
  trade: OpenTradeRow,
  broker: BrokerClose,
  excursion: { maxFavorableR: number | null; maxAdverseR: number | null },
  strategyExit?: { exitReason: string; barsHeld: number },
): Promise<boolean> {
  const closed = await query<{ id: string }>(
    `UPDATE paper_strategy_trades SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,max_favorable_r=$6,max_adverse_r=$7,closed_at=COALESCE($8,now()),exit_reason=$9,bars_held=COALESCE($10,bars_held),${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "COALESCE($8::timestamptz,now())", exitReasonParam: "$9" })},${costColumnsSql("$4", "broker")},updated_at=now() WHERE id=$1 AND status='open'`,
    [trade.id, broker.outcome, broker.exit, broker.resultR, broker.paperPl, excursion.maxFavorableR, excursion.maxAdverseR, broker.closedAt, strategyExit?.exitReason ?? broker.outcome, strategyExit?.barsHeld ?? null],
  );
  if (!closed.rowCount) return false;
  const label = broker.outcome === "target_first" ? "target reached" : broker.outcome === "stop_first" ? "stop reached" : "session exit";
  const resultText = broker.resultR === null ? "Result unavailable" : `${broker.resultR >= 0 ? "+" : ""}${broker.resultR.toFixed(2)}R`;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${label} · ${resultText}`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

/** Max-favorable/adverse excursion from the M15 scan. The broker does not report
 *  it, so the fast path reads it once, only after a fill is confirmed. */
async function excursionForTrade(trade: OpenTradeRow): Promise<{ maxFavorableR: number | null; maxAdverseR: number | null }> {
  try {
    const candles = (await getResearchCandles(trade.instrument, "M15", 500)).filter((item) => item.complete);
    const quotes = candles.map(toQuote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
    if (!quotes.length) return { maxFavorableR: null, maxAdverseR: null };
    const result = labelOutcome(trade.direction, Number(trade.entry), Number(trade.stop), Number(trade.target), iso(trade.decision_time), quotes);
    return { maxFavorableR: result.maxFavorableR, maxAdverseR: result.maxAdverseR };
  } catch {
    return { maxFavorableR: null, maxAdverseR: null };
  }
}

/** How close, as a fraction of the stop distance, price must come to the target
 *  or stop before the fast check starts polling the broker for a fill. */
const FAST_CHECK_PROXIMITY_FRACTION = 0.2;

function nearBrokerLevel(trade: OpenTradeRow, price: { bid: number; ask: number }): boolean {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return false;
  const band = risk * FAST_CHECK_PROXIMITY_FRACTION;
  // Exit side of the book: a long is closed on the bid, a short on the ask —
  // the same side labelOutcome and the broker fill against.
  const mark = trade.direction === "long" ? price.bid : price.ask;
  return trade.direction === "long"
    ? mark >= target - band || mark <= stop + band
    : mark <= target + band || mark >= stop - band;
}

/**
 * The impatient close. Practice execution places a real take-profit/stop at the
 * broker, so a position is already gone the instant price touches its level —
 * but the 60s scan only notices on its next tick, and only once the M15 candle
 * completes. This runs far more often: for a trade whose live price is within a
 * fraction of its stop distance from a level, it asks the broker whether the
 * order filled and books it immediately, cutting the close from up to a minute
 * (or a candle) down to seconds. Untouched trades cost one indexed query.
 */
export async function fastResolveFilledTrades(priceOf: (instrument: MajorInstrument) => { bid: number; ask: number } | null) {
  const open = await query<OpenTradeRow>(
    `SELECT trade.id,trade.user_id,trade.instrument,trade.decision_time,trade.direction,trade.entry,trade.stop,trade.target,trade.nominal_risk_amount,trade.strategy_family
     FROM paper_strategy_trades trade
     JOIN practice_order_intents intent ON intent.paper_trade_id=trade.id
     WHERE trade.status='open' AND intent.status='submitted' AND intent.broker_trade_id IS NOT NULL`,
  );
  let closed = 0;
  for (const trade of open.rows) {
    const price = priceOf(trade.instrument);
    if (!price || !nearBrokerLevel(trade, price)) continue;
    const broker = await brokerCloseFor(trade);
    if (!broker) continue;
    const excursion = await excursionForTrade(trade);
    const closedAtMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const strategyExit = trade.strategy_family === GBPUSD_STRATEGY_ID ? {
      exitReason: broker.outcome === "target_first" ? "TP" : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT",
      barsHeld: Math.max(1, Math.min(6, Math.ceil((closedAtMs - Date.parse(iso(trade.decision_time))) / (30 * 60_000)))),
    } : trade.strategy_family === USDJPY_STRATEGY_ID ? {
      exitReason: broker.outcome === "target_first" ? "TAKE_PROFIT" : broker.outcome === "stop_first" ? "STOP_LOSS" : "TIME_EXIT",
      barsHeld: Math.max(1, Math.min(3, Math.ceil((closedAtMs - Date.parse(iso(trade.decision_time))) / (60 * 60_000)))),
    } : trade.strategy_family === AUDUSD_STRATEGY_ID ? {
      exitReason: broker.outcome === "target_first" ? "TP" : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT",
      barsHeld: Math.max(1, Math.min(AUDUSD_MAX_HOLD_BARS, Math.ceil((closedAtMs - Date.parse(iso(trade.decision_time))) / (60 * 60_000)))),
    } : trade.strategy_family === NZDUSD_STRATEGY_ID ? {
      exitReason: broker.outcome === "target_first" ? "TP" : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT",
      barsHeld: Math.max(1, Math.min(NZDUSD_MAX_HOLD_BARS, Math.ceil((closedAtMs - Date.parse(iso(trade.decision_time))) / (60 * 60_000)))),
    } : undefined;
    if (await bookBrokerClose(trade, broker, excursion, strategyExit)) closed += 1;
  }
  return closed;
}

/** Outcome of a paper-only trade under a single live tick: the target or stop
 *  the tick has already crossed, or null while price is still between them. A
 *  long exits on the bid and a short on the ask — the same side the M15 scan and
 *  the broker fill against. Target and stop sit on opposite sides of entry, so a
 *  single tick can touch at most one, and none of the within-bar ambiguity the
 *  candle scan has to reason about arises here. */
function tickOutcome(trade: OpenTradeRow, price: { bid: number; ask: number }): "target_first" | "stop_first" | null {
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const mark = trade.direction === "long" ? price.bid : price.ask;
  if (trade.direction === "long") {
    if (mark >= target) return "target_first";
    if (mark <= stop) return "stop_first";
  } else {
    if (mark <= target) return "target_first";
    if (mark >= stop) return "stop_first";
  }
  return null;
}

/**
 * The live-tick close for paper-only trades — the ones with no broker order
 * behind them. They have no fast path of their own: resolveOpenTrades is their
 * only resolver, and it reads completed M15 candles, so a target or stop touch
 * goes unrecorded until the fifteen-minute bar closes, up to fifteen minutes
 * after the level was hit. This runs on the same 5s cadence as the broker fast
 * resolver, checks the live bid/ask against every open paper trade's levels, and
 * books the close at the level the instant a tick crosses it. The exit and
 * result_r are exactly what the candle scan would have written once the bar
 * completed — only sooner. Timeouts and the 16:45 forced exit stay with the M15
 * scan, which still owns everything that is not a clean level touch.
 */
export async function liveResolvePaperTrades(priceOf: (instrument: MajorInstrument) => { bid: number; ask: number } | null) {
  const open = await query<OpenTradeRow>(
    `SELECT trade.id,trade.user_id,trade.instrument,trade.decision_time,trade.direction,trade.entry,trade.stop,trade.target,trade.nominal_risk_amount,trade.strategy_family
     FROM paper_strategy_trades trade
     WHERE trade.status='open'
       AND NOT EXISTS(
         SELECT 1 FROM practice_order_intents intent
         WHERE intent.paper_trade_id=trade.id AND intent.status IN('pending','sending','submitted','unknown')
       )`,
  );
  let closed = 0;
  for (const trade of open.rows) {
    const price = priceOf(trade.instrument);
    if (!price) continue;
    const outcome = tickOutcome(trade, price);
    if (!outcome) continue;

    const entry = Number(trade.entry);
    const stop = Number(trade.stop);
    const target = Number(trade.target);
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    // Booked at the level, not the tick, so a tick-closed trade is scored
    // identically to one the candle scan closes: a stop is exactly -1R and a
    // target is its reward multiple, matching labelOutcome.
    const exit = outcome === "target_first" ? target : stop;
    const resultR = outcome === "target_first" ? Math.abs(target - entry) / risk : -1;
    const riskAmount = Number(trade.nominal_risk_amount);
    const paperPl = Number.isFinite(riskAmount) ? riskAmount * resultR : null;
    const strategyExitReason = trade.strategy_family === GBPUSD_STRATEGY_ID
      ? outcome === "target_first" ? "TP" : "SL"
      : trade.strategy_family === USDJPY_STRATEGY_ID
        ? outcome === "target_first" ? "TAKE_PROFIT" : "STOP_LOSS"
        : trade.strategy_family === AUDUSD_STRATEGY_ID
          ? outcome === "target_first" ? "TP" : "SL"
        : trade.strategy_family === NZDUSD_STRATEGY_ID
          ? outcome === "target_first" ? "TP" : "SL"
        : outcome;
    const strategyBarsHeld = trade.strategy_family === GBPUSD_STRATEGY_ID
      ? Math.max(1, Math.min(6, Math.ceil((Date.now() - Date.parse(iso(trade.decision_time))) / (30 * 60_000))))
      : trade.strategy_family === USDJPY_STRATEGY_ID
        ? Math.max(1, Math.min(3, Math.ceil((Date.now() - Date.parse(iso(trade.decision_time))) / (60 * 60_000))))
        : trade.strategy_family === AUDUSD_STRATEGY_ID
          ? Math.max(1, Math.min(AUDUSD_MAX_HOLD_BARS, Math.ceil((Date.now() - Date.parse(iso(trade.decision_time))) / (60 * 60_000))))
        : trade.strategy_family === NZDUSD_STRATEGY_ID
          ? Math.max(1, Math.min(NZDUSD_MAX_HOLD_BARS, Math.ceil((Date.now() - Date.parse(iso(trade.decision_time))) / (60 * 60_000))))
        : null;
    // Excursion comes from the M15 scan, which may not yet include the bar that
    // just touched the level, so floor it at the outcome we are booking — the
    // recorded excursion can never contradict the close.
    const excursion = await excursionForTrade(trade);
    const maxFavorableR = outcome === "target_first" ? Math.max(excursion.maxFavorableR ?? resultR, resultR) : excursion.maxFavorableR;
    const maxAdverseR = outcome === "stop_first" ? Math.max(excursion.maxAdverseR ?? 1, 1) : excursion.maxAdverseR;

    // status='open' guard makes this idempotent against the 60s candle scan, so
    // the two can never double-close the same trade.
    const updated = await query<{ id: string }>(
      `UPDATE paper_strategy_trades SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,max_favorable_r=$6,max_adverse_r=$7,closed_at=now(),exit_reason=$8,bars_held=COALESCE($9,bars_held),${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "now()", exitReasonParam: "$8" })},${costColumnsSql("$4", "model")},updated_at=now() WHERE id=$1 AND status='open'`,
      [trade.id, outcome, exit, resultR, paperPl, maxFavorableR, maxAdverseR, strategyExitReason, strategyBarsHeld],
    );
    if (!updated.rowCount) continue;
    await queueNotification({
      userId: trade.user_id,
      kind: "paper_closed",
      title: `${displayPair(trade.instrument)} paper trade closed`,
      message: `${outcome === "target_first" ? "target reached" : "stop reached"} · ${resultR >= 0 ? "+" : ""}${resultR.toFixed(2)}R`,
      instrument: trade.instrument,
      paperTradeId: trade.id,
      dedupeKey: `paper_closed:${trade.id}`,
    });
    closed += 1;
  }
  return closed;
}

/** Resolve one durable GBPUSD origin leg against its own six future M30 bars. */
async function resolveGbpusdOpenTrade(trade: OpenTradeRow, quotes: NormalizedQuote[]): Promise<boolean> {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const decisionTime = iso(trade.decision_time);
  const result = resolveGbpusdExit({
    direction: trade.direction,
    entry,
    stop,
    target,
    decisionTime,
    quotes,
    now: new Date(),
  });

  const broker = await brokerCloseFor(trade);
  if (broker) {
    const resolvedMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const barsHeld = Math.max(1, Math.min(6, Math.ceil((resolvedMs - Date.parse(decisionTime)) / (30 * 60_000))));
    const exitReason = broker.outcome === "target_first" ? "TP"
      : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT";
    return bookBrokerClose(trade, broker, {
      maxFavorableR: result?.maxFavorableR ?? null,
      maxAdverseR: result?.maxAdverseR ?? null,
    }, { exitReason, barsHeld });
  }
  if (!result) return false;

  if (result.outcome === "time_exit") {
    try {
      const closeState = await requestPracticeTradeCloseForPaperTrade(trade.id);
      if (closeState === "pending_confirmation") {
        await queueNotification({
          userId: trade.user_id,
          kind: "system_issue",
          title: `${displayPair(trade.instrument)} practice close needs attention`,
          message: "The GBPUSD six-M30-bar time exit was not sent because the broker order is not confirmed. The logical leg remains open.",
          instrument: trade.instrument,
          paperTradeId: trade.id,
          dedupeKey: `gbpusd_time_exit_unconfirmed:${trade.id}`,
        });
        return false;
      }
      if (closeState === "requested") {
        const confirmedClose = await brokerCloseFor(trade);
        if (!confirmedClose) return false;
        return bookBrokerClose(trade, confirmedClose, {
          maxFavorableR: result.maxFavorableR,
          maxAdverseR: result.maxAdverseR,
        }, { exitReason: "TIME_EXIT", barsHeld: GBPUSD_MAX_HOLD_BARS });
      }
    } catch (error) {
      console.error("[gbpusd-strategy] time exit failed", error);
      await queueNotification({
        userId: trade.user_id,
        kind: "system_issue",
        title: `${displayPair(trade.instrument)} practice close needs attention`,
        message: "The GBPUSD six-M30-bar broker close failed. The logical leg remains open.",
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `gbpusd_time_exit_failed:${trade.id}`,
      });
      return false;
    }
  }

  const riskAmount = Number(trade.nominal_risk_amount);
  const paperPl = Number.isFinite(riskAmount) ? riskAmount * result.resultR : null;
  const updated = await query<{ id: string }>(
    `UPDATE paper_strategy_trades
        SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,
            max_favorable_r=$6,max_adverse_r=$7,closed_at=$8,exit_reason=$9,
            bars_held=$10,${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "$8::timestamptz", exitReasonParam: "$9" })},${costColumnsSql("$4", "model")},updated_at=now()
      WHERE id=$1 AND status='open'`,
    [trade.id, result.outcome, result.exit, result.resultR, paperPl, result.maxFavorableR,
     result.maxAdverseR, result.resolvedAt, result.exitReason, result.barsHeld],
  );
  if (!updated.rowCount) return false;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${result.exitReason.replaceAll("_", " ").toLowerCase()} · ${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

/** Resolve the frozen USDJPY strategy without the generic 48h/16:45 ET horizon. */
async function resolveUsdjpyOpenTrade(trade: OpenTradeRow, quotes: NormalizedQuote[]): Promise<boolean> {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const decisionTime = iso(trade.decision_time);
  const result = resolveUsdjpyExit({
    direction: trade.direction,
    entry,
    stop,
    target,
    decisionTime,
    quotes,
    now: new Date(),
  });

  // A broker-reported fill is stronger evidence than the candle model and keeps
  // real slippage in realized R/P&L. The frozen three-bar horizon still supplies
  // the strategy-specific bars-held and exit-reason labels.
  const broker = await brokerCloseFor(trade);
  if (broker) {
    const resolvedMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const barsHeld = Math.max(1, Math.min(3, Math.ceil((resolvedMs - Date.parse(decisionTime)) / (60 * 60_000))));
    const exitReason = broker.outcome === "target_first" ? "TAKE_PROFIT"
      : broker.outcome === "stop_first" ? "STOP_LOSS" : "TIME_EXIT";
    return bookBrokerClose(trade, broker, {
      maxFavorableR: result?.maxFavorableR ?? null,
      maxAdverseR: result?.maxAdverseR ?? null,
    }, { exitReason, barsHeld });
  }
  if (!result) return false;

  if (result.outcome === "time_exit") {
    try {
      if (!(await closePracticeTradeForPaperTrade(trade.id))) {
        await queueNotification({
          userId: trade.user_id,
          kind: "system_issue",
          title: `${displayPair(trade.instrument)} practice close needs attention`,
          message: "The USDJPY three-H1-bar time exit was not sent because the broker order is not confirmed. The internal trade remains open.",
          instrument: trade.instrument,
          paperTradeId: trade.id,
          dedupeKey: `practice_time_exit_unconfirmed:${trade.id}`,
        });
        return false;
      }
    } catch (error) {
      console.error("[usdjpy-strategy] time exit failed", error);
      await queueNotification({
        userId: trade.user_id,
        kind: "system_issue",
        title: `${displayPair(trade.instrument)} practice close needs attention`,
        message: "The USDJPY three-H1-bar broker close failed. The internal trade remains open.",
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `practice_time_exit_failed:${trade.id}`,
      });
      return false;
    }
  }

  const riskAmount = Number(trade.nominal_risk_amount);
  const paperPl = Number.isFinite(riskAmount) ? riskAmount * result.resultR : null;
  const updated = await query<{ id: string }>(
    `UPDATE paper_strategy_trades
        SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,
            max_favorable_r=$6,max_adverse_r=$7,closed_at=$8,exit_reason=$9,
            bars_held=$10,${costColumnsSql("$4", "model")},updated_at=now()
      WHERE id=$1 AND status='open'`,
    [trade.id, result.outcome, result.exit, result.resultR, paperPl, result.maxFavorableR,
     result.maxAdverseR, result.resolvedAt, result.exitReason, result.barsHeld],
  );
  if (!updated.rowCount) return false;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${result.exitReason.replaceAll("_", " ").toLowerCase()} · ${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

/** Resolve frozen AUDUSD after exactly three future completed H1 bars. */
async function resolveAudusdOpenTrade(trade: OpenTradeRow, quotes: NormalizedQuote[]): Promise<boolean> {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const decisionTime = iso(trade.decision_time);
  const result = resolveAudusdExit({ entry, stop, target, decisionTime, quotes, now: new Date() });

  const broker = await brokerCloseFor(trade);
  if (broker) {
    const resolvedMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const barsHeld = Math.max(1, Math.min(AUDUSD_MAX_HOLD_BARS,
      Math.ceil((resolvedMs - Date.parse(decisionTime)) / (60 * 60_000))));
    const exitReason = broker.outcome === "target_first" ? "TP"
      : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT";
    return bookBrokerClose(trade, broker, {
      maxFavorableR: result?.maxFavorableR ?? null,
      maxAdverseR: result?.maxAdverseR ?? null,
    }, { exitReason, barsHeld });
  }
  if (!result) return false;

  if (result.outcome === "time_exit") {
    try {
      const closeState = await requestPracticeTradeCloseForPaperTrade(trade.id);
      if (closeState === "pending_confirmation") {
        await queueNotification({
          userId: trade.user_id,
          kind: "system_issue",
          title: `${displayPair(trade.instrument)} practice close needs attention`,
          message: "The AUDUSD three-H1-bar time exit was not sent because the broker order is not confirmed. The trade remains open.",
          instrument: trade.instrument,
          paperTradeId: trade.id,
          dedupeKey: `audusd_time_exit_unconfirmed:${trade.id}`,
        });
        return false;
      }
      if (closeState === "requested") {
        const confirmedClose = await brokerCloseFor(trade);
        if (!confirmedClose) return false;
        return bookBrokerClose(trade, confirmedClose, {
          maxFavorableR: result.maxFavorableR,
          maxAdverseR: result.maxAdverseR,
        }, { exitReason: "TIME_EXIT", barsHeld: AUDUSD_MAX_HOLD_BARS });
      }
    } catch (error) {
      console.error("[audusd-strategy] time exit failed", error);
      await queueNotification({
        userId: trade.user_id,
        kind: "system_issue",
        title: `${displayPair(trade.instrument)} practice close needs attention`,
        message: "The AUDUSD three-H1-bar broker close failed. The trade remains open.",
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `audusd_time_exit_failed:${trade.id}`,
      });
      return false;
    }
  }

  const riskAmount = Number(trade.nominal_risk_amount);
  const paperPl = Number.isFinite(riskAmount) ? riskAmount * result.resultR : null;
  const updated = await query<{ id: string }>(
    `UPDATE paper_strategy_trades
        SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,
            max_favorable_r=$6,max_adverse_r=$7,closed_at=$8,exit_reason=$9,
            bars_held=$10,${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "$8::timestamptz", exitReasonParam: "$9" })},${costColumnsSql("$4", "model")},updated_at=now()
      WHERE id=$1 AND status='open'`,
    [trade.id, result.outcome, result.exit, result.resultR, paperPl, result.maxFavorableR,
     result.maxAdverseR, result.resolvedAt, result.exitReason, result.barsHeld],
  );
  if (!updated.rowCount) return false;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${result.exitReason.replaceAll("_", " ").toLowerCase()} · ${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

/** Resolve frozen NZDUSD after exactly three future completed H1 bars. */
async function resolveNzdusdOpenTrade(trade: OpenTradeRow, quotes: NormalizedQuote[]): Promise<boolean> {
  const entry = Number(trade.entry);
  const stop = Number(trade.stop);
  const target = Number(trade.target);
  const decisionTime = iso(trade.decision_time);
  const result = resolveNzdusdExit({ direction: trade.direction, entry, stop, target, decisionTime, quotes, now: new Date() });

  const broker = await brokerCloseFor(trade);
  if (broker) {
    const resolvedMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const barsHeld = Math.max(1, Math.min(NZDUSD_MAX_HOLD_BARS,
      Math.ceil((resolvedMs - Date.parse(decisionTime)) / (60 * 60_000))));
    const exitReason = broker.outcome === "target_first" ? "TP"
      : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT";
    return bookBrokerClose(trade, broker, {
      maxFavorableR: result?.maxFavorableR ?? null,
      maxAdverseR: result?.maxAdverseR ?? null,
    }, { exitReason, barsHeld });
  }
  if (!result) return false;

  if (result.outcome === "time_exit") {
    try {
      const closeState = await requestPracticeTradeCloseForPaperTrade(trade.id);
      if (closeState === "pending_confirmation") {
        await queueNotification({
          userId: trade.user_id,
          kind: "system_issue",
          title: `${displayPair(trade.instrument)} practice close needs attention`,
          message: "The NZDUSD three-H1-bar time exit was not sent because the broker order is not confirmed. The trade remains open.",
          instrument: trade.instrument,
          paperTradeId: trade.id,
          dedupeKey: `nzdusd_time_exit_unconfirmed:${trade.id}`,
        });
        return false;
      }
      if (closeState === "requested") {
        const confirmedClose = await brokerCloseFor(trade);
        if (!confirmedClose) return false;
        return bookBrokerClose(trade, confirmedClose, {
          maxFavorableR: result.maxFavorableR,
          maxAdverseR: result.maxAdverseR,
        }, { exitReason: "TIME_EXIT", barsHeld: NZDUSD_MAX_HOLD_BARS });
      }
    } catch (error) {
      console.error("[nzdusd-strategy] time exit failed", error);
      await queueNotification({
        userId: trade.user_id,
        kind: "system_issue",
        title: `${displayPair(trade.instrument)} practice close needs attention`,
        message: "The NZDUSD three-H1-bar broker close failed. The trade remains open.",
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `nzdusd_time_exit_failed:${trade.id}`,
      });
      return false;
    }
  }

  const riskAmount = Number(trade.nominal_risk_amount);
  const paperPl = Number.isFinite(riskAmount) ? riskAmount * result.resultR : null;
  const updated = await query<{ id: string }>(
    `UPDATE paper_strategy_trades
        SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,
            max_favorable_r=$6,max_adverse_r=$7,closed_at=$8,exit_reason=$9,
            bars_held=$10,${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "$8::timestamptz", exitReasonParam: "$9" })},${costColumnsSql("$4", "model")},updated_at=now()
      WHERE id=$1 AND status='open'`,
    [trade.id, result.outcome, result.exit, result.resultR, paperPl, result.maxFavorableR,
     result.maxAdverseR, result.resolvedAt, result.exitReason, result.barsHeld],
  );
  if (!updated.rowCount) return false;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${result.exitReason.replaceAll("_", " ").toLowerCase()} · ${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

/** Resolve the frozen three-H1-bar modules that share executable-side exit mechanics. */
async function resolveFrozenH1OpenTrade(
  trade: OpenTradeRow,
  quotes: NormalizedQuote[],
  resolver: FrozenH1Resolver,
): Promise<boolean> {
  const decisionTime = iso(trade.decision_time);
  const result = resolver({
    direction: trade.direction,
    entry: Number(trade.entry),
    stop: Number(trade.stop),
    target: Number(trade.target),
    decisionTime,
    quotes,
    now: new Date(),
  });
  const broker = await brokerCloseFor(trade);
  if (broker) {
    const resolvedMs = broker.closedAt ? Date.parse(broker.closedAt) : Date.now();
    const barsHeld = Math.max(1, Math.min(3, Math.ceil((resolvedMs - Date.parse(decisionTime)) / (60 * 60_000))));
    const exitReason = broker.outcome === "target_first" ? "TP"
      : broker.outcome === "stop_first" ? "SL" : "TIME_EXIT";
    return bookBrokerClose(trade, broker, {
      maxFavorableR: result?.maxFavorableR ?? null,
      maxAdverseR: result?.maxAdverseR ?? null,
    }, { exitReason, barsHeld });
  }
  if (!result) return false;

  if (result.outcome === "time_exit") {
    try {
      const closeState = await requestPracticeTradeCloseForPaperTrade(trade.id);
      if (closeState === "pending_confirmation") return false;
      if (closeState === "requested") {
        const confirmedClose = await brokerCloseFor(trade);
        if (!confirmedClose) return false;
        return bookBrokerClose(trade, confirmedClose, {
          maxFavorableR: result.maxFavorableR,
          maxAdverseR: result.maxAdverseR,
        }, { exitReason: "TIME_EXIT", barsHeld: 3 });
      }
    } catch (error) {
      console.error(`[${trade.strategy_family ?? "frozen-h1"}] time exit failed`, error);
      await queueNotification({
        userId: trade.user_id,
        kind: "system_issue",
        title: `${displayPair(trade.instrument)} practice close needs attention`,
        message: "The frozen three-H1-bar broker close failed. The logical trade remains open.",
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `frozen_h1_time_exit_failed:${trade.id}`,
      });
      return false;
    }
  }

  const riskAmount = Number(trade.nominal_risk_amount);
  const paperPl = Number.isFinite(riskAmount) ? riskAmount * result.resultR : null;
  const updated = await query<{ id: string }>(
    `UPDATE paper_strategy_trades
        SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,
            max_favorable_r=$6,max_adverse_r=$7,closed_at=$8,exit_reason=$9,
            bars_held=$10,${pairExitFeaturesSql({ exitParam: "$3", resultRParam: "$4", pnlParam: "$5", closedAtSql: "$8::timestamptz", exitReasonParam: "$9" })},${costColumnsSql("$4", "model")},updated_at=now()
      WHERE id=$1 AND status='open'`,
    [trade.id, result.outcome, result.exit, result.resultR, paperPl, result.maxFavorableR,
     result.maxAdverseR, result.resolvedAt, result.exitReason, result.barsHeld],
  );
  if (!updated.rowCount) return false;
  await queueNotification({
    userId: trade.user_id,
    kind: "paper_closed",
    title: `${displayPair(trade.instrument)} paper trade closed`,
    message: `${result.exitReason.replaceAll("_", " ").toLowerCase()} · ${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`,
    instrument: trade.instrument,
    paperTradeId: trade.id,
    dedupeKey: `paper_closed:${trade.id}`,
  });
  return true;
}

async function resolveOpenTrades() {
  const open = await query<OpenTradeRow>("SELECT id,user_id,instrument,decision_time,direction,entry,stop,target,nominal_risk_amount,strategy_family FROM paper_strategy_trades WHERE status='open' ORDER BY opened_at");
  let resolved = 0;
  for (const trade of open.rows) {
    const frozenH1Resolver = trade.strategy_family ? FROZEN_THREE_H1_RESOLVERS[trade.strategy_family] : undefined;
    if (frozenH1Resolver) {
      const candles = (await getResearchCandles(trade.instrument, "H1", 500)).filter((item) => item.complete);
      const quotes = candles.map(toH1Quote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
      if (quotes.length && await resolveFrozenH1OpenTrade(trade, quotes, frozenH1Resolver)) resolved += 1;
      continue;
    }
    if (trade.strategy_family === NZDUSD_STRATEGY_ID) {
      const candles = (await getResearchCandles(trade.instrument, "H1", 500)).filter((item) => item.complete);
      const quotes = candles.map(toH1Quote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
      if (quotes.length && await resolveNzdusdOpenTrade(trade, quotes)) resolved += 1;
      continue;
    }
    if (trade.strategy_family === AUDUSD_STRATEGY_ID) {
      const candles = (await getResearchCandles(trade.instrument, "H1", 500)).filter((item) => item.complete);
      const quotes = candles.map(toH1Quote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
      if (quotes.length && await resolveAudusdOpenTrade(trade, quotes)) resolved += 1;
      continue;
    }
    if (trade.strategy_family === GBPUSD_STRATEGY_ID) {
      const candles = (await getResearchCandles(trade.instrument, "M30", 500)).filter((item) => item.complete);
      const quotes = candles.map(toM30Quote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
      if (quotes.length && await resolveGbpusdOpenTrade(trade, quotes)) resolved += 1;
      continue;
    }
    const candles = (await getResearchCandles(trade.instrument, "M15", 500)).filter((item) => item.complete);
    const quotes = candles.map(toQuote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
    if (!quotes.length) continue;
    if (trade.strategy_family === USDJPY_STRATEGY_ID) {
      if (await resolveUsdjpyOpenTrade(trade, quotes)) resolved += 1;
      continue;
    }
    const result = labelOutcome(trade.direction, Number(trade.entry), Number(trade.stop), Number(trade.target), iso(trade.decision_time), quotes);

    // The broker is asked first and wins when it has already finished the
    // trade. The scan above still runs, because the excursion figures it
    // produces are not something the broker reports.
    const broker = await brokerCloseFor(trade);
    if (broker) {
      await bookBrokerClose(trade, broker, { maxFavorableR: result.maxFavorableR, maxAdverseR: result.maxAdverseR });
      resolved += 1;
      continue;
    }

    // Still open and still inside the 48h horizon: nothing to record yet.
    if (result.outcome === "unresolved" && Date.now() < new Date(result.horizonEndsAt).getTime()) continue;

    // A trade that reaches the horizon without hitting a level means the same-day
    // 16:45 exit was never seen — almost always an M15 gap around the close.
    // Leaving it open freezes the instrument (no new entry runs while one is
    // open) and its whole batch (a batch files only once every trade closes), so
    // close it to market at the horizon rather than dropping it, as before.
    const timedOut = result.outcome === "unresolved";
    // forced_close and a timed-out close both exit a live position mid-flight,
    // so both must square the broker order before the internal trade closes.
    const needsBrokerClose = result.outcome === "forced_close" || timedOut;

    if (STRATEGY_FAMILIES.includes(trade.strategy_family as StrategyFamily)) {
      const intent = (await query<{ status: string; broker_trade_id: string | null }>(
        "SELECT status,broker_trade_id FROM practice_order_intents WHERE paper_trade_id=$1", [trade.id])).rows[0];
      if (requiresBrokerCloseConfirmation(intent)) {
        // Request a time exit, then let a confirmed broker fill book it on the
        // next cycle. A successful close request does not reveal the fill price.
        if (needsBrokerClose) await requestPracticeTradeCloseForPaperTrade(trade.id);
        continue;
      }
    }

    const entryPrice = Number(trade.entry);
    const riskDistance = Math.abs(entryPrice - Number(trade.stop));
    const resolvedQuote = result.resolvedAt ? quotes.find((quote) => quote.closeTime === result.resolvedAt) : undefined;
    const exit = result.outcome === "target_first" ? Number(trade.target)
      : result.outcome === "stop_first" ? Number(trade.stop)
        : result.outcome === "forced_close" && resolvedQuote ? (trade.direction === "long" ? resolvedQuote.bidClose : resolvedQuote.askClose)
          // Reconstruct the horizon mark from the R labelOutcome timed out on, so
          // the recorded exit and result_r can never disagree.
          : timedOut && result.resultR !== null ? (trade.direction === "long" ? entryPrice + result.resultR * riskDistance : entryPrice - result.resultR * riskDistance)
            : null;
    const status = result.outcome === "ambiguous" ? "ambiguous" : "closed";
    const closedAt = timedOut ? result.horizonEndsAt : result.resolvedAt;
    if (needsBrokerClose) {
      const closeContext = timedOut ? "horizon timeout" : "forced 16:45 ET";
      try {
        if (!(await closePracticeTradeForPaperTrade(trade.id))) {
          await queueNotification({ userId: trade.user_id, kind: "system_issue", title: `${displayPair(trade.instrument)} practice close needs attention`, message: `The ${closeContext} exit was not sent because the broker order is not confirmed. The internal trade remains open.`, instrument: trade.instrument, paperTradeId: trade.id, dedupeKey: `practice_close_unconfirmed:${trade.id}` });
          continue;
        }
      } catch (error) {
        console.error("[paper-cycle] practice close failed", error);
        await queueNotification({ userId: trade.user_id, kind: "system_issue", title: `${displayPair(trade.instrument)} practice close needs attention`, message: `The ${closeContext} broker close failed. The internal trade remains open.`, instrument: trade.instrument, paperTradeId: trade.id, dedupeKey: `practice_close_failed:${trade.id}` });
        continue;
      }
    }
    const updated = await query<{ id: string }>(
      `UPDATE paper_strategy_trades SET status=$2,outcome=$3,exit=$4,result_r=$5,paper_pl=$6,max_favorable_r=$7,max_adverse_r=$8,closed_at=$9,exit_reason=$10,${costColumnsSql("$5", "model")},updated_at=now() WHERE id=$1 AND status='open'`,
      [trade.id, status, result.outcome, exit, status === "ambiguous" ? null : result.resultR, status === "ambiguous" || result.resultR === null ? null : Number(trade.nominal_risk_amount) * result.resultR, result.maxFavorableR, result.maxAdverseR, closedAt, result.outcome],
    );
    if (updated.rowCount) {
      const outcomeLabel = result.outcome === "target_first" ? "target reached" : result.outcome === "stop_first" ? "stop reached" : result.outcome === "forced_close" ? "session exit" : timedOut ? "closed at horizon" : "ambiguous outcome";
      const resultText = result.resultR === null ? "Result unavailable" : `${result.resultR >= 0 ? "+" : ""}${result.resultR.toFixed(2)}R`;
      await queueNotification({
        userId: trade.user_id,
        kind: "paper_closed",
        title: `${displayPair(trade.instrument)} paper trade closed`,
        message: `${outcomeLabel} · ${resultText}`,
        instrument: trade.instrument,
        paperTradeId: trade.id,
        dedupeKey: `paper_closed:${trade.id}`,
      });
    }
    resolved += 1;
  }
  return resolved;
}

/** Scores a batch and files it. Shared so a batch retired early is summarised
 *  exactly the way a batch that ran its full hundred is. */
async function completeBatch(batchId: string) {
  const rows = await query<StoredTrade>("SELECT id,trade_sequence::text,instrument,direction,status,outcome,result_r::text,session,weekday,spread_pips::text,opened_at,closed_at,features,conditions FROM paper_strategy_trades WHERE batch_id=$1 ORDER BY trade_sequence", [batchId]);
  const summary = {
    ...paperBatchMetrics(rows.rows),
    breakdowns: {
      pair: paperBreakdown(rows.rows, "instrument"),
      direction: paperBreakdown(rows.rows, "direction"),
      session: paperBreakdown(rows.rows, "session"),
      weekday: paperBreakdown(rows.rows, "weekday"),
      volatility: customBreakdown(rows.rows, volatilityGroup),
      spread: customBreakdown(rows.rows, spreadGroup),
      confirmation: customBreakdown(rows.rows, confirmationGroup),
    },
  };
  const recommendation = buildPaperRecommendation(rows.rows);
  await query("UPDATE paper_strategy_batches SET status='complete',summary=$2::jsonb,recommendation=$3::jsonb,decision=$4,completed_at=now() WHERE id=$1", [batchId, JSON.stringify(summary), JSON.stringify(recommendation), recommendation ? "pending" : "not_applicable"]);
  return { trades: rows.rows.length, recommendation };
}

async function completeReadyBatches() {
  // A batch reaches resolving either at its 100-trade cap or when its strategy
  // is retired. In both cases, it is ready once every assigned trade is closed.
  const ready = await query<{ id: string }>(`SELECT batch.id FROM paper_strategy_batches batch WHERE batch.status='resolving' AND NOT EXISTS(SELECT 1 FROM paper_strategy_trades trade WHERE trade.batch_id=batch.id AND trade.status='open')`);
  for (const batch of ready.rows) await completeBatch(batch.id);
}

/**
 * Files the collecting batch before it reaches a hundred trades.
 *
 * Retiring the strategy is the reason this exists: a batch is the unit the
 * results are read in, and one holding trades from two different strategies
 * describes a system nobody ran. `assigned_count` keeps the honest record of
 * how far it actually got.
 *
 * Refuses while a trade is still open, because a batch summarised with an
 * unresolved trade in it understates or overstates that trade as zero.
 */
export async function retireCollectingBatch() {
  const batch = await query<{ id: string; batch_number: number; assigned_count: number }>(
    "SELECT id,batch_number,assigned_count FROM paper_strategy_batches WHERE status='collecting' ORDER BY batch_number DESC LIMIT 1",
  );
  const row = batch.rows[0];
  if (!row) return null;

  const open = await query("SELECT 1 FROM paper_strategy_trades WHERE batch_id=$1 AND status='open' LIMIT 1", [row.id]);
  if (open.rowCount) throw new Error(`Batch ${row.batch_number} still has an open trade. Let it resolve before retiring the batch.`);

  const result = await completeBatch(row.id);
  return { batchNumber: row.batch_number, assignedCount: row.assigned_count, ...result };
}

export async function collectPaperCycle() {
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
  if (!owner.rows[0]) return { opened: 0, resolved: 0, reason: "Owner account is unavailable" };
  const versionId = await strategyVersionId();
  let resolved = 0;
  try { resolved = await resolveOpenTrades(); }
  catch (error) { console.error("[paper-cycle] outcome refresh failed", error); }
  await completeReadyBatches();

  const snapshot = await getStrategySnapshot();
  const quoteByInstrument = new Map(snapshot.quotes.map((quote) => [quote.instrument, quote]));
  // Mid price of any streamed major, so pip value on a cross can be converted to
  // USD through a second pair (e.g. EUR_JPY sized via USD_JPY).
  const midByInstrument = (instrument: string) => {
    const quote = quoteByInstrument.get(instrument);
    return quote ? (quote.bid + quote.ask) / 2 : null;
  };
  let opened = 0;
  let reportedDataIssue = false;
  for (const setup of snapshot.strategy.setups) {
    const quote = quoteByInstrument.get(setup.instrument);
    await persistWatchSnapshot(setup, quote, versionId);
    await persistPaperEvaluation(setup, versionId, quote ? (quote.ask - quote.bid) / pipSizeFor(setup.instrument) : null);
    if (setup.dataSource !== "oanda" || !quote) {
      if (!reportedDataIssue) {
        await queueNotification({
          userId: owner.rows[0].id,
          kind: "system_issue",
          title: "Market data unavailable",
          message: "OANDA data is unavailable or stale. Watchlist entries and paper trades are fail-closed until it recovers.",
          instrument: null,
          paperTradeId: null,
          dedupeKey: "market_data_unavailable",
        });
        reportedDataIssue = true;
      }
      continue;
    }
    const spreadPips = (quote.ask - quote.bid) / pipSizeFor(setup.instrument);
    const quoteToUsdRate = usdPerUnitOfCurrency(currenciesOf(setup.instrument).quote, midByInstrument);
    const openedTradeId = await openPaperTrade(setup, owner.rows[0].id, versionId, spreadPips, snapshot.account.balance, quoteToUsdRate);
    if (openedTradeId) {
      opened += 1;
      await queuePracticeOrderIntent(owner.rows[0].id, openedTradeId);
      // Research annotation only, and deliberately after the trade exists: it
      // records what the calendar looked like around the entry and can neither
      // change nor prevent the trade. Runs outside openPaperTrade's transaction
      // so a calendar failure cannot roll a trade back.
      await tagNewTradeSafely({ id: openedTradeId, instrument: setup.instrument, openedAt: setup.evaluatedAt });
    }
    else if (setup.status === "valid") {
      await queueNotification({
        userId: owner.rows[0].id,
        kind: "setup_ready",
        title: `${displayPair(setup.instrument)} setup ready`,
        message: `${setup.direction === "long" ? "Long" : "Short"} plan is valid. Entry, target, and stop are available on Signals.`,
        instrument: setup.instrument,
        paperTradeId: null,
        dedupeKey: `setup_ready:${versionId}:${setup.instrument}:${new Date(setup.evaluatedAt).toISOString().slice(0, 10)}`,
      });
    }
  }
  if (opened) {
    for (const setup of snapshot.strategy.setups) await persistWatchSnapshot(setup, quoteByInstrument.get(setup.instrument), versionId);
  }
  const execution = await processPendingPracticeOrders();
  return { opened, resolved, execution };
}

const EMPTY_WATCH_ROW = {
  evaluatedAt: null,
  dataStatus: "unavailable" as const,
  setupStatus: "invalid" as const,
  direction: null,
  bid: null,
  ask: null,
  spreadPips: null,
  entry: null,
  stop: null,
  target: null,
  session: "Unavailable",
  conditions: [],
  features: {},
  openTradeId: null,
  batchNumber: null,
  tradeSequence: null,
  updatedAt: null,
};

export async function watchlistSnapshot() {
  const paper = await query(`SELECT watch.instrument,watch.evaluated_at AS "evaluatedAt",watch.data_status AS "dataStatus",watch.setup_status AS "setupStatus",COALESCE(trade.direction,watch.direction) AS direction,watch.bid::float,watch.ask::float,watch.spread_pips::float AS "spreadPips",COALESCE(trade.entry,watch.entry)::float AS entry,COALESCE(trade.stop,watch.stop)::float AS stop,COALESCE(trade.target,watch.target)::float AS target,watch.session,watch.conditions,watch.features,watch.open_trade_id AS "openTradeId",watch.batch_number AS "batchNumber",watch.updated_at AS "updatedAt",trade.trade_sequence::text AS "tradeSequence" FROM paper_watch_snapshots watch LEFT JOIN paper_strategy_trades trade ON trade.id=watch.open_trade_id ORDER BY array_position($1::text[],watch.instrument)`, [MAJOR_INSTRUMENTS]);
  // The live collector writes here. Prefer it so pairs added after the last
  // liquidity-cycle snapshot still appear as connected once they have been evaluated.
  const multi = await query(
    `SELECT DISTINCT ON (watch.instrument)
            watch.instrument,
            watch.evaluated_at AS "evaluatedAt",
            watch.data_status AS "dataStatus",
            watch.setup_status AS "setupStatus",
            COALESCE(trade.direction, watch.direction) AS direction,
            watch.bid::float,
            watch.ask::float,
            watch.spread_pips::float AS "spreadPips",
            COALESCE(trade.entry, watch.entry)::float AS entry,
            COALESCE(trade.stop, watch.stop)::float AS stop,
            COALESCE(trade.target, watch.target)::float AS target,
            watch.session,
            watch.conditions,
            watch.features,
            watch.open_trade_id AS "openTradeId",
            NULL::int AS "batchNumber",
            watch.updated_at AS "updatedAt",
            trade.trade_sequence::text AS "tradeSequence"
       FROM multistrategy_watch_snapshots watch
       LEFT JOIN paper_strategy_trades trade ON trade.id = watch.open_trade_id
      ORDER BY watch.instrument, watch.selected DESC, watch.updated_at DESC`,
  );
  const paperByInstrument = new Map(paper.rows.map((row: any) => [row.instrument, row]));
  const multiByInstrument = new Map(multi.rows.map((row: any) => [row.instrument, row]));
  return MAJOR_INSTRUMENTS.map((instrument) =>
    multiByInstrument.get(instrument)
    ?? paperByInstrument.get(instrument)
    ?? { instrument, ...EMPTY_WATCH_ROW },
  );
}

export async function paperCycleOverview() {
  const batches = await query(`SELECT id,batch_number AS "batchNumber",status,assigned_count AS "assignedCount",configuration,summary,recommendation,decision,decision_note AS "decisionNote",started_at AS "startedAt",completed_at AS "completedAt" FROM paper_strategy_batches ORDER BY batch_number DESC LIMIT 20`);
  // Multi-strategy opens one collecting batch per family. Picking only the
  // highest batch_number then showed a brand-new family batch as 1/100 while
  // older collecting batches held the real trades (and the dashboard still
  // labelled lifetime opens onto that empty batch). Prefer the fullest
  // collecting batch; fall back to the fullest non-complete.
  const incomplete = (batches.rows as Array<{ id: string; batchNumber: number; status: string; assignedCount: number | string }>).filter(
    (batch) => batch.status !== "complete",
  );
  const byAssignedThenNumber = (
    a: { assignedCount: number | string; batchNumber: number },
    b: { assignedCount: number | string; batchNumber: number },
  ) => Number(b.assignedCount) - Number(a.assignedCount) || Number(b.batchNumber) - Number(a.batchNumber);
  const collecting = incomplete.filter((batch) => batch.status === "collecting");
  const current = (collecting.length ? collecting : incomplete).slice().sort(byAssignedThenNumber)[0] ?? null;
  const currentTrades = current ? await query(`SELECT id,trade_sequence::text AS "tradeSequence",instrument,direction,status,outcome,entry::float,stop::float,target::float,exit::float,result_r::float AS "resultR",nominal_risk_percent::float AS "nominalRiskPercent",nominal_risk_amount::float AS "nominalRiskAmount",paper_pl::float AS "paperPl",spread_pips::float AS "spreadPips",session,weekday,planned_r::float AS "plannedR",checklist_score::float AS "checklistScore",news_status AS "newsStatus",max_favorable_r::float AS "maxFavorableR",max_adverse_r::float AS "maxAdverseR",opened_at AS "openedAt",closed_at AS "closedAt",exit_reason AS "exitReason",review FROM paper_strategy_trades WHERE batch_id=$1 ORDER BY trade_sequence DESC`, [(current as any).id]) : { rows: [] };
  const liveSummary = paperBatchMetrics((currentTrades.rows as any[]).map((row) => ({ ...row, trade_sequence: row.tradeSequence, result_r: row.resultR, spread_pips: row.spreadPips, opened_at: row.openedAt, closed_at: row.closedAt })) as StoredTrade[]);
  // Trust the live trade rows over the denormalised counter for display. The
  // counter can lag if a write path inserted without bumping assigned_count.
  const assignedCount = liveSummary.assigned;
  // Dashboard "Open trades" lists every still-open position (any batch), with
  // family + batch so the row can show EMA / Breakout / Mean rev / Momentum.
  const openTrades = await query(
    `SELECT trade.id,trade.trade_sequence::text AS "tradeSequence",trade.instrument,trade.direction,trade.status,trade.outcome,
            trade.entry::float,trade.stop::float,trade.target::float,trade.exit::float,trade.result_r::float AS "resultR",
            trade.nominal_risk_percent::float AS "nominalRiskPercent",trade.nominal_risk_amount::float AS "nominalRiskAmount",
            trade.paper_pl::float AS "paperPl",trade.spread_pips::float AS "spreadPips",trade.session,trade.weekday,
            trade.planned_r::float AS "plannedR",trade.checklist_score::float AS "checklistScore",trade.news_status AS "newsStatus",
            trade.max_favorable_r::float AS "maxFavorableR",trade.max_adverse_r::float AS "maxAdverseR",
            trade.opened_at AS "openedAt",trade.closed_at AS "closedAt",trade.exit_reason AS "exitReason",trade.review,
            trade.strategy_family AS "strategyFamily",batch.batch_number AS "batchNumber"
     FROM paper_strategy_trades trade
     JOIN paper_strategy_batches batch ON batch.id = trade.batch_id
     WHERE trade.status = 'open'
     ORDER BY trade.opened_at DESC
     LIMIT 20`,
  );
  const lifetimeRows = await query<StoredTrade>("SELECT id,trade_sequence::text,instrument,direction,status,outcome,result_r::text,session,weekday,spread_pips::text,opened_at,closed_at FROM paper_strategy_trades ORDER BY trade_sequence");
  // The account chart plots balance over time, which does not belong to any one
  // batch: sourced from the collecting batch it emptied the moment a batch was
  // filed, and every completed batch would erase the account's history.
  const accountTrades = await query(
    `SELECT trade_sequence::int AS "tradeSequence", paper_pl::float AS "paperPl", closed_at AS "closedAt", opened_at AS "openedAt", status
     FROM paper_strategy_trades WHERE opened_at > now() - interval '90 days' ORDER BY opened_at`,
  );
  return {
    strategyVersion: ACTIVE_STRATEGY_VERSION,
    batchSize: BATCH_SIZE,
    lifetimeSummary: paperBatchMetrics(lifetimeRows.rows),
    current: current
      ? {
          ...current,
          assignedCount,
          liveSummary,
          remaining: Math.max(0, BATCH_SIZE - assignedCount),
        }
      : null,
    batches: batches.rows,
    trades: currentTrades.rows,
    openTrades: openTrades.rows,
    accountTrades: accountTrades.rows,
  };
}

/**
 * The journal log: manually written entries plus every strategy trade the cycle
 * placed, so a trade lands in the journal as soon as it resolves. Ambiguous
 * strategy trades are left out until the resolver settles them.
 */
export type JournalTradeFilter = "all" | "wins" | "losses" | "active";

/**
 * Bring direct OANDA Practice-account trades into the durable journal.
 *
 * Strategy orders already carry a broker trade id in `practice_order_intents`,
 * so they are explicitly excluded. The broker id is used as a stable legacy id
 * for direct/manual orders, making every refresh idempotent and allowing a
 * later closed-trade update to correct the same journal row.
 */
export async function syncPracticeBrokerHistory(userId: string) {
  let brokerTrades: Awaited<ReturnType<typeof getClosedPracticeTrades>>;
  try {
    brokerTrades = await getClosedPracticeTrades();
  } catch {
    // A journal read must remain available when OANDA is temporarily down.
    return { imported: 0, unavailable: true };
  }
  if (!brokerTrades.length) return { imported: 0, unavailable: false };

  const linked = await query<{ broker_trade_id: string }>(
    "SELECT broker_trade_id FROM practice_order_intents WHERE broker_trade_id IS NOT NULL",
  );
  const linkedIds = new Set(linked.rows.map((row) => row.broker_trade_id));
  let imported = 0;

  for (const trade of brokerTrades) {
    if (linkedIds.has(trade.brokerTradeId)) continue;
    const pair = trade.instrument.replace("_", "/");
    const result = trade.realizedPL === null ? "breakeven" : trade.realizedPL > 0 ? "win" : trade.realizedPL < 0 ? "loss" : "breakeven";
    const saved = await query<{ id: string }>(
      `INSERT INTO paper_trades(
         user_id,legacy_id,origin,pair,direction,status,result,opened_at,closed_at,entry,stop,target,exit,result_r,reason,notes
       ) VALUES($1,$2,'manual',$3,$4,'closed',$5,$6,$7,$8,$8,$8,$9,NULL,'OANDA Practice account history',$10)
       ON CONFLICT(user_id,legacy_id) DO UPDATE SET
         closed_at=EXCLUDED.closed_at, exit=EXCLUDED.exit, result=EXCLUDED.result, updated_at=now()
       RETURNING id`,
      [
        userId,
        `oanda-trade:${trade.brokerTradeId}`,
        pair,
        trade.direction,
        result,
        trade.openedAt,
        trade.closedAt,
        trade.entry,
        trade.exit,
        trade.realizedPL === null ? "Broker P&L unavailable." : `Broker realized P&L: ${trade.realizedPL.toFixed(2)} USD.`,
      ],
    );
    if (saved.rowCount) imported += 1;
  }
  return { imported, unavailable: false };
}

/**
 * A saved setup is the first valid, completed-candle evaluation for an
 * executable pair. Its levels are immutable: it is evidence of a plan, not a
 * live quote or a broker order. A setup remains actionable only until the next
 * strategy candle begins (M30 for GBPUSD, H1 for every other enabled pair).
 */
export async function savedExecutableSetups() {
  const rows = await query<{
    id: string;
    instrument: MajorInstrument;
    direction: "long" | "short";
    entry: number;
    stop: number;
    target: number;
    decisionTime: string;
    expiresAt: string;
  }>(
    `SELECT DISTINCT ON (evaluation.instrument)
            evaluation.id,
            evaluation.instrument,
            evaluation.direction,
            evaluation.entry::float AS entry,
            evaluation.stop::float AS stop,
            evaluation.target::float AS target,
            evaluation.decision_time AS "decisionTime",
            (evaluation.decision_time + CASE WHEN evaluation.strategy_family=$2 THEN interval '30 minutes' ELSE interval '1 hour' END) AS "expiresAt"
       FROM paper_strategy_evaluations evaluation
      WHERE evaluation.strategy_family = ANY($1::text[])
        AND evaluation.setup_status='valid'
        AND evaluation.direction IS NOT NULL
        AND evaluation.entry IS NOT NULL
        AND evaluation.stop IS NOT NULL
        AND evaluation.target IS NOT NULL
        AND evaluation.trade_created=false
        AND evaluation.paper_trade_id IS NULL
        AND now() < evaluation.decision_time + CASE WHEN evaluation.strategy_family=$2 THEN interval '30 minutes' ELSE interval '1 hour' END
      ORDER BY evaluation.instrument, evaluation.decision_time DESC`,
    [ENABLED_PAIR_STRATEGY_IDS, GBPUSD_STRATEGY_ID],
  );
  return rows.rows.map((row) => ({ ...row, state: "setup" as const }));
}

function journalTradeWhere(filter: JournalTradeFilter): string {
  // Wins/losses use raw result_r (open trades are NULL and fall out of both).
  // Active is status-based so closed-but-null-R edge cases stay out.
  switch (filter) {
    case "wins":
      return "WHERE result_r > 0";
    case "losses":
      return "WHERE result_r < 0";
    case "active":
      return "WHERE status = 'open'";
    case "all":
      return "";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

export async function journalTradeLog(
  userId: string,
  { limit = 20, offset = 0, filter = "all" }: { limit?: number; offset?: number; filter?: JournalTradeFilter } = {},
) {
  const where = journalTradeWhere(filter);
  const rows = await query(
    `SELECT id, origin, pair, direction, status, result, opened_at AS "openedAt", closed_at AS "closedAt",
            entry, stop, target, exit, result_r AS "resultR", paper_pl AS "paperPl", reason, notes, sequence, outcome,
            instrument_code AS "instrument", nominal_risk_amount AS "nominalRiskAmount",
            signal_price AS "signalPrice", actual_fill_price AS "actualFillPrice",
            max_hold_bars AS "maxHoldBars", bars_held AS "barsHeld",
            strategy_family AS "strategyFamily", batch_number AS "batchNumber",
            "brokerExecutionStatus", "brokerFailureReason"
     FROM (
       SELECT id::text, origin, pair, direction, status, result, opened_at, closed_at,
              entry::float, stop::float, target::float, exit::float, result_r::float,
              paper_pl::float, reason, notes, NULL::text AS sequence, NULL::text AS outcome,
               NULL::text AS instrument_code, NULL::float AS nominal_risk_amount,
               NULL::float AS signal_price, NULL::float AS actual_fill_price,
               NULL::int AS max_hold_bars, NULL::int AS bars_held,
               NULL::text AS strategy_family, NULL::int AS batch_number,
               NULL::text AS "brokerExecutionStatus", NULL::text AS "brokerFailureReason"
       FROM paper_trades WHERE user_id=$1
       UNION ALL
       SELECT trade.id::text, 'strategy', instrument.display_name, trade.direction,
              trade.status, CASE WHEN intent.status='rejected' THEN 'breakeven'
                                 WHEN trade.status <> 'closed' OR trade.result_r IS NULL THEN 'open'
                                 WHEN trade.result_r > 0.01 THEN 'win'
                                 WHEN trade.result_r < -0.01 THEN 'loss' ELSE 'breakeven' END,
              trade.opened_at, trade.closed_at,
              trade.entry::float, trade.stop::float, trade.target::float, trade.exit::float,
              CASE WHEN intent.status='rejected' THEN NULL ELSE trade.result_r::float END,
              CASE WHEN intent.status='rejected' THEN NULL ELSE trade.paper_pl::float END,
              trade.setup_name || ' · ' || trade.session,
              CASE WHEN trade.exit_reason IS NULL THEN ''
                   ELSE 'Broker outcome: ' || replace(trade.exit_reason, '_', ' ') END,
              trade.trade_sequence::text, trade.outcome,
              -- Carried so an open row can be marked to the live quote: the code
              -- matches the watchlist snapshot, the risk amount sets the scale.
               trade.instrument, trade.nominal_risk_amount::float,
               trade.signal_price::float, trade.actual_fill_price::float,
               trade.max_hold_bars, trade.bars_held,
               trade.strategy_family, batch.batch_number,
               CASE WHEN intent.status='rejected' THEN 'rejected' ELSE NULL END,
               CASE WHEN intent.status='rejected' THEN intent.failure_reason ELSE NULL END
       FROM paper_strategy_trades trade
       JOIN instruments instrument ON instrument.code = trade.instrument
       JOIN paper_strategy_batches batch ON batch.id = trade.batch_id
       LEFT JOIN practice_order_intents intent ON intent.paper_trade_id = trade.id
       WHERE trade.user_id=$1 AND trade.status IN ('open', 'closed')
     ) log
     ${where}
     ORDER BY CASE WHEN status = 'closed' THEN closed_at ELSE opened_at END DESC, opened_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return rows.rows;
}

/**
 * Whole-journal totals for the stats card, computed over every trade regardless
 * of the current page or filter so the header stays accurate as the list is
 * paged in. Mirrors the set `journalTradeLog` draws from.
 */
export async function journalTradeSummary(userId: string) {
  const rows = await query<{ total: string; closed: string; wins: string; sumR: string | null }>(
    `SELECT count(*) FILTER (WHERE NOT broker_rejected)::text AS total,
            count(*) FILTER (WHERE status='closed' AND result_r IS NOT NULL AND NOT broker_rejected)::text AS closed,
            count(*) FILTER (WHERE result_r > 0 AND NOT broker_rejected)::text AS wins,
            sum(result_r) FILTER (WHERE status='closed' AND result_r IS NOT NULL AND NOT broker_rejected)::text AS "sumR"
     FROM (
       SELECT status, result_r::float AS result_r, false AS broker_rejected FROM paper_trades WHERE user_id=$1
       UNION ALL
       SELECT trade.status, trade.result_r::float, COALESCE(intent.status='rejected',false)
       FROM paper_strategy_trades trade
       LEFT JOIN practice_order_intents intent ON intent.paper_trade_id=trade.id
       WHERE trade.user_id=$1 AND trade.status IN ('open', 'closed')
     ) log`,
    [userId],
  );
  const row = rows.rows[0];
  const total = Number(row?.total ?? 0);
  const closed = Number(row?.closed ?? 0);
  const wins = Number(row?.wins ?? 0);
  const sumR = Number(row?.sumR ?? 0);
  // The journal is presented in the New York trading day everywhere else in
  // the app. Keep the server aggregate in that same zone so the header does
  // not roll over at UTC midnight for a New York session.
  const todayRows = await query<{
    wins: string;
    losses: string;
    realizedPL: string | null;
  }>(
    `SELECT count(*) FILTER (WHERE result_r > 0 AND NOT broker_rejected)::text AS wins,
            count(*) FILTER (WHERE result_r < 0 AND NOT broker_rejected)::text AS losses,
            sum(paper_pl) FILTER (WHERE NOT broker_rejected)::text AS "realizedPL"
     FROM (
       SELECT result_r::float AS result_r, paper_pl::float, closed_at, false AS broker_rejected
       FROM paper_trades
       WHERE user_id=$1 AND status='closed'
       UNION ALL
       SELECT trade.result_r::float, trade.paper_pl::float, trade.closed_at, COALESCE(intent.status='rejected',false)
       FROM paper_strategy_trades trade
       LEFT JOIN practice_order_intents intent ON intent.paper_trade_id=trade.id
       WHERE trade.user_id=$1 AND trade.status='closed'
     ) log
     WHERE (closed_at AT TIME ZONE 'America/New_York')::date =
           (now() AT TIME ZONE 'America/New_York')::date`,
    [userId],
  );
  const today = todayRows.rows[0];
  // Active trades may have fallen beyond the first journal page, but their
  // live cash value still belongs in the exposure total at the top of Journal.
  const openTrades = await journalTradeLog(userId, { limit: 500, filter: "active" });

  return {
    total,
    winRate: closed ? wins / closed : null,
    avgR: closed ? sumR / closed : 0,
    today: {
      wins: Number(today?.wins ?? 0),
      losses: Number(today?.losses ?? 0),
      realizedPL: today?.realizedPL === null || today?.realizedPL === undefined
        ? null
        : Number(today.realizedPL),
    },
    openTrades,
  };
}

/** Entry and exit points for one pair, used to draw trade markers on the chart. */
export async function paperTradesForInstrument(userId: string, instrument: string, limit = 40) {
  const rows = await query(
    `SELECT trade.id,trade.trade_sequence::text AS "tradeSequence",trade.instrument,trade.direction,trade.status,trade.outcome,trade.entry::float,trade.stop::float,trade.target::float,trade.exit::float,trade.result_r::float AS "resultR",trade.opened_at AS "openedAt",trade.closed_at AS "closedAt",trade.exit_reason AS "exitReason",batch.batch_number AS "batchNumber"
     FROM paper_strategy_trades trade JOIN paper_strategy_batches batch ON batch.id=trade.batch_id
     WHERE trade.user_id=$1 AND trade.instrument=$2 ORDER BY trade.opened_at DESC LIMIT $3`,
    [userId, instrument, limit],
  );
  return rows.rows;
}

export async function paperRiskExposure(userId: string) {
  const rows = await query<{ instrument: string; direction: "long" | "short"; nominal_risk_percent: string; nominal_risk_amount: string; calculated_standard_lots: string }>("SELECT instrument,direction,nominal_risk_percent,nominal_risk_amount,calculated_standard_lots FROM paper_strategy_trades WHERE user_id=$1 AND status='open'", [userId]);
  const currency = new Map<string, number>();
  for (const row of rows.rows) {
    const [base, quote] = row.instrument.split("_");
    const risk = Number(row.nominal_risk_percent);
    const sign = row.direction === "long" ? 1 : -1;
    currency.set(base!, (currency.get(base!) ?? 0) + sign * risk);
    currency.set(quote!, (currency.get(quote!) ?? 0) - sign * risk);
  }
  return {
    openTrades: rows.rowCount,
    totalNominalRiskPercent: rows.rows.reduce((sum, row) => sum + Number(row.nominal_risk_percent), 0),
    totalNominalRiskAmount: rows.rows.reduce((sum, row) => sum + Number(row.nominal_risk_amount), 0),
    positions: rows.rows.map((row) => ({ instrument: row.instrument, direction: row.direction, nominalRiskPercent: Number(row.nominal_risk_percent), nominalRiskAmount: Number(row.nominal_risk_amount), calculatedStandardLots: Number(row.calculated_standard_lots) })),
    currencyExposure: [...currency.entries()].map(([code, nominalRiskPercent]) => ({ code, nominalRiskPercent })).sort((a, b) => Math.abs(b.nominalRiskPercent) - Math.abs(a.nominalRiskPercent)),
  };
}

export async function paperRiskPolicy(userId: string) {
  return transaction(async (client) => {
    const policy = await policyRow(client, userId);
    const batch = await client.query<{ batch_number: number; assigned_count: number }>("SELECT batch_number,assigned_count FROM paper_strategy_batches WHERE status='collecting' ORDER BY batch_number DESC LIMIT 1");
    return {
      ...policy,
      pendingAppliesTo: policy.pending ? "next_batch" as const : null,
      currentBatch: batch.rows[0] ? { batchNumber: batch.rows[0].batch_number, assignedCount: batch.rows[0].assigned_count } : null,
    };
  });
}

export async function updatePaperRiskPolicy(userId: string, configuration: PaperRiskConfiguration, collectionPaused: boolean) {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COLLECTOR_LOCK]);
    await policyRow(client, userId, true);
    const batch = await client.query<{ id: string; batch_number: number; assigned_count: number }>("SELECT id,batch_number,assigned_count FROM paper_strategy_batches WHERE status='collecting' ORDER BY batch_number DESC LIMIT 1 FOR UPDATE");
    const current = batch.rows[0];
    const applyNow = !current || current.assigned_count === 0;
    if (applyNow) {
      await client.query("UPDATE paper_risk_policies SET active_configuration=$2::jsonb,pending_configuration=NULL,collection_paused=$3,updated_at=now() WHERE user_id=$1", [userId, JSON.stringify(configuration), collectionPaused]);
      if (current) {
        await client.query("UPDATE paper_strategy_batches SET configuration=configuration || $2::jsonb WHERE id=$1", [current.id, JSON.stringify(configuration)]);
      }
    } else {
      await client.query("UPDATE paper_risk_policies SET pending_configuration=$2::jsonb,collection_paused=$3,updated_at=now() WHERE user_id=$1", [userId, JSON.stringify(configuration), collectionPaused]);
    }
    return { ...(await policyRow(client, userId)), pendingAppliesTo: applyNow ? null : "next_batch" as const, currentBatch: current ? { batchNumber: current.batch_number, assignedCount: current.assigned_count } : null, applied: applyNow ? "immediately" as const : "next_batch" as const };
  });
}

export async function reviewPaperTrade(userId: string, tradeId: string, review: Record<string, unknown>) {
  const shortText = (value: unknown, max = 2_000) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const normalized = {
    whyTaken: shortText(review.whyTaken),
    wentWell: shortText(review.wentWell),
    wentWrong: shortText(review.wentWrong),
    takeAgain: typeof review.takeAgain === "boolean" ? review.takeAgain : null,
    lesson: shortText(review.lesson),
    notes: shortText(review.notes),
    executionTags: Array.isArray(review.executionTags) ? review.executionTags.filter((item): item is string => typeof item === "string").slice(0, 12).map((item) => item.slice(0, 64)) : [],
  };
  const before = shortText(review.screenshotBeforeUrl, 2_048) || null;
  const after = shortText(review.screenshotAfterUrl, 2_048) || null;
  const saved = await query(`UPDATE paper_strategy_trades SET review=$3::jsonb,rule_compliance='reviewed',screenshot_before_url=$4,screenshot_after_url=$5,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,review`, [tradeId, userId, JSON.stringify(normalized), before, after]);
  return saved.rows[0] ?? null;
}

export async function decidePaperBatch(batchId: string, decision: "approved" | "rejected", note: string) {
  const saved = await query(`UPDATE paper_strategy_batches SET decision=$2,decision_note=$3,decided_at=now() WHERE id=$1 AND status='complete' AND recommendation IS NOT NULL AND decision='pending' RETURNING id,batch_number AS "batchNumber",decision,recommendation`, [batchId, decision, note]);
  return saved.rows[0] ?? null;
}

// ===========================================================================
// Multi-strategy + adaptive engine collector (Phase 2).
//
// A parallel collector to `collectPaperCycle`. It evaluates the four preserved
// research families plus the enabled frozen pair modules. The legacy families
// have an empty execution allowlist; only a qualifying pair candidate can reach
// the shared paper/practice opening path. It opens through the exact same
// risk/execution path (`openPaperTrade` → `queuePracticeOrderIntent`). The one-
// open-position-per-instrument rule is unchanged and still enforced by the
// existing open-trade check and the unique index. The legacy liquidity path is
// left completely intact; a runtime flag in server.ts chooses which runs.
// ===========================================================================

type MultiVersion = { versionId: string; version: string; configVersion: string };
let multiVersionCache: Map<string, MultiVersion> | null = null;
let experimentIdCache: string | null = null;
let pairExperimentIdsCache: Map<string, string> | null = null;
let configsSeeded = false;
const EXECUTION_STRATEGY_SEEDS = [...SEED_STRATEGY_CONFIGS, ...ENABLED_PAIR_STRATEGY_SEEDS];

function isAdaptiveFamily(value: StrategyId): value is StrategyFamily {
  return (STRATEGY_FAMILIES as readonly string[]).includes(value);
}

function isAdaptiveCandidate(candidate: StrategyCandidate<StrategyId>): candidate is StrategyCandidate<StrategyFamily> {
  return isAdaptiveFamily(candidate.family);
}

const SHARED_EXECUTION_GATE_NAMES = new Set(["Market data", "Session", "Spread", "News"]);

export function sharedExecutionRejectionFor(candidate: StrategyCandidate<StrategyId>) {
  const failed = candidate.conditions.find((item) =>
    item.required && !item.passed && SHARED_EXECUTION_GATE_NAMES.has(item.name));
  return failed ? `Execution blocked: ${failed.name}: ${failed.reason}` : null;
}

/** Register (once per process) a strategy_versions row per family. */
async function multiStrategyVersionIds(): Promise<Map<string, MultiVersion>> {
  if (multiVersionCache) return multiVersionCache;
  const map = new Map<string, MultiVersion>();
  for (const seed of EXECUTION_STRATEGY_SEEDS) {
    const adaptive = isAdaptiveFamily(seed.family);
    const experiment = adaptive ? MULTISTRATEGY_EXPERIMENT_LABEL : `${seed.family}-v1`;
    const configuration = JSON.stringify({ status: adaptive ? "paused" : "active", family: seed.family, configVersion: seed.configVersion, experiment, configuration: seed.configuration });
    const result = await query<{ id: string }>(
      `INSERT INTO strategy_versions(name,version,configuration) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(name,version) DO UPDATE SET configuration=strategy_versions.configuration || EXCLUDED.configuration
       RETURNING id`,
      [adaptive ? MULTISTRATEGY_NAME : seed.family, seed.version, configuration],
    );
    map.set(seed.family, { versionId: result.rows[0]!.id, version: seed.version, configVersion: seed.configVersion });
  }
  multiVersionCache = map;
  return map;
}

async function ensureExperiment(): Promise<string> {
  if (experimentIdCache) return experimentIdCache;
  const result = await query<{ id: string }>(
    `INSERT INTO strategy_experiments(label,description) VALUES($1,$2)
     ON CONFLICT(label) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
    [MULTISTRATEGY_EXPERIMENT_LABEL, "Four independent V1 strategies (EMA, Breakout, Momentum, Mean Reversion) feeding the cold-start adaptive engine."],
  );
  experimentIdCache = result.rows[0]!.id;
  return experimentIdCache;
}

async function ensurePairStrategyExperiments(): Promise<Map<string, string>> {
  if (pairExperimentIdsCache) return pairExperimentIdsCache;
  const map = new Map<string, string>();
  for (const seed of ENABLED_PAIR_STRATEGY_SEEDS) {
    const label = seed.family === GBPUSD_STRATEGY_ID ? seed.configVersion : `${seed.family}-v1`;
    const result = await query<{ id: string }>(
      `INSERT INTO strategy_experiments(label,description) VALUES($1,$2)
       ON CONFLICT(label) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
      [label, `${seed.family} ${seed.configVersion} frozen pair-specific paper/practice cohort. Not an adaptive input.`],
    );
    map.set(seed.family, result.rows[0]!.id);
  }
  pairExperimentIdsCache = map;
  return map;
}

/** Seed the immutable V1 configs. ON CONFLICT DO NOTHING preserves history. */
async function ensureStrategyConfigsSeeded(): Promise<void> {
  if (configsSeeded) return;
  for (const seed of EXECUTION_STRATEGY_SEEDS) {
    const status = isAdaptiveFamily(seed.family) ? "retired" : "active";
    await query(
      `INSERT INTO strategy_configs(family,strategy_version,config_version,configuration,status) VALUES($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT(family,config_version) DO UPDATE SET status=EXCLUDED.status`,
      [seed.family, seed.version, seed.configVersion, JSON.stringify(seed.configuration), status],
    );
  }
  configsSeeded = true;
}

function attributionFor(candidate: StrategyCandidate<StrategyId>, versionIds: Map<string, MultiVersion>, experimentId: string, pairExperimentIds: Map<string, string>): StrategyAttribution {
  const version = versionIds.get(candidate.family)!;
  return {
    versionId: version.versionId, family: candidate.family, version: candidate.version, configVersion: candidate.configVersion,
    experimentId: pairExperimentIds.get(candidate.family) ?? experimentId,
    regime: candidate.regime.regime, trendStrength: candidate.regime.trendStrength,
    volatilityBucket: candidate.regime.volatility, atrPips: candidate.regime.atrPips,
  };
}

async function persistMultiWatchSnapshot(candidate: StrategyCandidate<StrategyId>, quote: { bid: number; ask: number; time: string } | undefined, attribution: StrategyAttribution, selected: boolean, selectionReason: string, session: string, openTradeId: string | null) {
  const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(candidate.instrument) : null;
  const fresh = quote && Date.now() - new Date(quote.time).getTime() <= 2 * 60_000;
  await query(
    `INSERT INTO multistrategy_watch_snapshots(instrument,strategy_family,strategy_version,config_version,evaluated_at,data_status,setup_status,direction,entry,stop,target,risk_reward,regime,trend_strength,volatility_bucket,atr_pips,session,selected,selection_reason,bid,ask,spread_pips,conditions,features,open_trade_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,$25)
     ON CONFLICT(instrument,strategy_family) DO UPDATE SET strategy_version=EXCLUDED.strategy_version,config_version=EXCLUDED.config_version,evaluated_at=EXCLUDED.evaluated_at,data_status=EXCLUDED.data_status,setup_status=EXCLUDED.setup_status,direction=EXCLUDED.direction,entry=EXCLUDED.entry,stop=EXCLUDED.stop,target=EXCLUDED.target,risk_reward=EXCLUDED.risk_reward,regime=EXCLUDED.regime,trend_strength=EXCLUDED.trend_strength,volatility_bucket=EXCLUDED.volatility_bucket,atr_pips=EXCLUDED.atr_pips,session=EXCLUDED.session,selected=EXCLUDED.selected,selection_reason=EXCLUDED.selection_reason,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread_pips=EXCLUDED.spread_pips,conditions=EXCLUDED.conditions,features=EXCLUDED.features,open_trade_id=EXCLUDED.open_trade_id,updated_at=now()`,
    [candidate.instrument, attribution.family, attribution.version, attribution.configVersion, candidate.evaluatedAt, candidate.dataSource === "oanda" && fresh ? "connected" : "unavailable", candidate.status, candidate.direction, candidate.entry, candidate.stop, candidate.target, candidate.riskReward, attribution.regime, attribution.trendStrength, attribution.volatilityBucket, attribution.atrPips, session, selected, selectionReason, quote?.bid ?? null, quote?.ask ?? null, spreadPips, JSON.stringify(candidate.conditions), JSON.stringify(candidate.features), openTradeId],
  );
}

async function logAdaptiveDecision(experimentId: string, instrument: string, decisionTime: string, decision: ReturnType<typeof decideInstrument>, regime: unknown, candidates: StrategyCandidate<StrategyFamily>[], selectedTradeId: string | null, statusByKey: (candidate: StrategyCandidate<StrategyId>) => string) {
  const candidateViews = candidates.map((candidate) => ({
    family: candidate.family, version: candidate.version, configVersion: candidate.configVersion,
    direction: candidate.direction, status: candidate.status, executionStatus: statusByKey(candidate),
    entry: candidate.entry, stop: candidate.stop, target: candidate.target, riskReward: candidate.riskReward,
  }));
  await query(
    `INSERT INTO adaptive_decisions(experiment_id,instrument,decision_time,adaptive_state,regime,candidates,selected,suppressed,evidence,reason,selected_trade_id)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11)
     ON CONFLICT(instrument,decision_time) DO UPDATE SET adaptive_state=EXCLUDED.adaptive_state,regime=EXCLUDED.regime,candidates=EXCLUDED.candidates,selected=EXCLUDED.selected,suppressed=EXCLUDED.suppressed,evidence=EXCLUDED.evidence,reason=EXCLUDED.reason,selected_trade_id=COALESCE(EXCLUDED.selected_trade_id,adaptive_decisions.selected_trade_id)`,
    [experimentId, instrument, decisionTime, decision.state, JSON.stringify(regime), JSON.stringify(candidateViews), decision.selected ? JSON.stringify(decision.selected) : null, JSON.stringify(decision.suppressed), JSON.stringify(decision.evidenceUsed), decision.reason, selectedTradeId],
  );
}

/**
 * Resolve hypothetical outcomes for suppressed/blocked valid candidates.
 *
 * Only candidates that were valid but not executed are considered, and only ones
 * without an outcome yet. Candles are fetched once per instrument (the same
 * source and completed-candle filter the live resolver uses) and each candidate
 * is labelled with the pure `resolveShadowOutcome`, which returns null while the
 * outcome is not yet known. Nothing here places an order, opens a position, or
 * reads/writes risk — it only writes shadow_candidate_outcomes.
 *
 * THE EXECUTED-ARM GUARD. `execution_status` alone was never a safe test for
 * "this did not trade". The status is written BEFORE execution is attempted and
 * promoted to 'selected' only on a confirmed insert — and when that promoting
 * UPDATE silently matched zero rows, 48 real trades stayed filed as 'blocked'
 * and were handed a hypothetical outcome on top of the real one they already
 * had. The engine then counted the same opportunity twice, disagreeing with
 * itself in five cases.
 *
 * So the guard below does not trust a status column. It asks the trade ledger
 * directly, three independent ways: no evaluation that backs a trade
 * (`evaluation_id`), no evaluation that names one (`paper_trade_id` /
 * `trade_created`), and no trade sitting on the same (instrument, bar, family).
 * Any one of those being true is enough to disqualify the row, so a future drift
 * in any single marker cannot resurrect the defect.
 */
async function resolveShadowCandidates(): Promise<number> {
  const pending = await query<{ id: string; instrument: MajorInstrument; direction: "long" | "short"; entry: string; stop: string; target: string; decision_time: string | Date; spread_pips: string | null }>(
    `SELECT evaluation.id, evaluation.instrument, evaluation.direction, evaluation.entry::text, evaluation.stop::text, evaluation.target::text, evaluation.decision_time, evaluation.spread_pips::text
       FROM paper_strategy_evaluations evaluation
       LEFT JOIN shadow_candidate_outcomes shadow ON shadow.evaluation_id = evaluation.id
      WHERE evaluation.strategy_family IS NOT NULL
        AND evaluation.strategy_family = ANY($1::text[])
        AND evaluation.execution_status IN ('suppressed','blocked')
        AND evaluation.setup_status = 'valid'
        AND evaluation.direction IS NOT NULL
        AND evaluation.entry IS NOT NULL AND evaluation.stop IS NOT NULL AND evaluation.target IS NOT NULL
        AND shadow.evaluation_id IS NULL
        AND evaluation.paper_trade_id IS NULL
        AND evaluation.trade_created = false
        AND NOT EXISTS (SELECT 1 FROM paper_strategy_trades linked WHERE linked.evaluation_id = evaluation.id)
        AND NOT EXISTS (
          SELECT 1 FROM paper_strategy_trades traded
           WHERE traded.instrument = evaluation.instrument
             AND traded.decision_time = evaluation.decision_time
             AND traded.strategy_family = evaluation.strategy_family)
      ORDER BY evaluation.instrument
      LIMIT 300`,
    [STRATEGY_FAMILIES],
  );
  if (!pending.rows.length) return 0;

  const byInstrument = new Map<MajorInstrument, typeof pending.rows>();
  for (const row of pending.rows) byInstrument.set(row.instrument, [...(byInstrument.get(row.instrument) ?? []), row]);

  const now = new Date();
  let resolved = 0;
  for (const [instrument, rows] of byInstrument) {
    let quotes: NormalizedQuote[];
    try {
      const candles = (await getResearchCandles(instrument, "M15", 500)).filter((candle) => candle.complete);
      quotes = candles.map(toQuote);
    } catch { continue; }
    for (const row of rows) {
      const decisionTime = iso(row.decision_time);
      const future = quotes.filter((quote) => new Date(quote.closeTime) > new Date(decisionTime));
      if (!future.length) continue;
      const outcome = resolveShadowOutcome(row.direction, Number(row.entry), Number(row.stop), Number(row.target), decisionTime, future, now);
      if (!outcome) continue; // still pending — its outcome is not known yet
      // The shadow arm crosses the same spread a real fill would have: its entry
      // is the executable side of the book at the decision and labelOutcome
      // resolves it against the other side. Recording the decomposition here
      // keeps a shadow observation comparable with an executed one on cost, not
      // only on outcome.
      const spreadCost = spreadCostR({
        instrument: row.instrument, entry: Number(row.entry), stop: Number(row.stop),
        spreadPips: row.spread_pips === null ? null : Number(row.spread_pips),
      });
      const grossR = outcome.resultR === null || spreadCost === null ? null : outcome.resultR + spreadCost;
      await query(
        `INSERT INTO shadow_candidate_outcomes(evaluation_id,outcome,result_r,max_favorable_r,max_adverse_r,exit,resolved_at,horizon_ends_at,exit_reason,spread_cost_r,total_cost_r,gross_result_r,net_result_r,cost_basis)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$3,$12) ON CONFLICT(evaluation_id) DO NOTHING`,
        [row.id, outcome.outcome, outcome.resultR, outcome.maxFavorableR, outcome.maxAdverseR, outcome.exit, outcome.resolvedAt, outcome.horizonEndsAt, outcome.exitReason,
         spreadCost, grossR, spreadCost === null ? "unknown" : "spread_only"],
      );
      resolved += 1;
    }
  }
  return resolved;
}

export async function collectMultiStrategyCycle() {
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
  if (!owner.rows[0]) return { opened: 0, resolved: 0, reason: "Owner account is unavailable" };
  const userId = owner.rows[0].id;

  let resolved = 0;
  // EUR/USD Stage 1 only: record a frozen MOVE/WAIT decision, then label it
  // after four hours. This has no direction and never reaches risk/execution.
  try {
    const moveGate = await runEurUsdMoveGateV1Shadow(await getResearchCandles("EUR_USD", "M15", 500));
    if (moveGate.recorded || moveGate.resolved) console.log(`[eur-usd-move-gate-v1] recorded ${moveGate.recorded}, resolved ${moveGate.resolved}`);
  } catch (error) { console.error("[eur-usd-move-gate-v1] shadow cycle failed", error); }
  try { resolved = await resolveOpenTrades(); }
  catch (error) { console.error("[multi-strategy] outcome refresh failed", error); }
  // Resolve hypothetical outcomes for suppressed/blocked valid candidates. Pure
  // research: reads candles, writes shadow_candidate_outcomes, never OANDA/risk.
  try { const shadow = await resolveShadowCandidates(); if (shadow) console.log(`[multi-strategy] resolved ${shadow} shadow candidates`); }
  catch (error) { console.error("[multi-strategy] shadow resolution failed", error); }
  // Same contract for the Momentum SHORT inversion forward test: both arms are
  // replayed independently against real bid/ask, written to their own research
  // table, and never surfaced to risk or the adaptive engine.
  try { const inv = await resolveMomentumShortInversion(); if (inv) console.log(`[momentum-short-inversion] resolved ${inv} pairs`); }
  catch (error) { console.error("[momentum-short-inversion] resolution failed", error); }
  // Close out the paired original/inverted arms. The executed arm COPIES the
  // real trade's outcome rather than being re-simulated — an actual result is
  // better evidence than a modelled one, and silently swapping the two is the
  // exact confusion this repair exists to remove. The other arm is labelled by
  // the same pure shadow resolver, which stays null until its outcome would
  // genuinely have been known.
  try {
    const arms = await resolveMomentumInversionArms(async (instrument) =>
      (await getResearchCandles(instrument, "M15", 500)).filter((candle) => candle.complete).map(toQuote));
    if (arms) console.log(`[momentum-arms] resolved ${arms} arms`);
  } catch (error) { console.error("[momentum-arms] resolution failed", error); }
  // Fixed-horizon direction experiment. Unlike momentum-arms, this scores only
  // the raw M1 midpoint move at +10 minutes; it has no entry, spread, stop,
  // target, R, risk, or adaptive-evidence role.
  try {
    const direction = await resolveMomentumDirection10m(async (instrument) =>
      (await getResearchCandles(instrument, "M1", 500)).filter((candle) => candle.complete).map((candle) => ({
        closeTime: new Date(new Date(candle.time).getTime() + 60_000).toISOString(), midClose: candle.mid.close,
      })));
    if (direction) console.log(`[momentum-direction-10m] resolved ${direction} observations`);
  } catch (error) { console.error("[momentum-direction-10m] resolution failed", error); }
  // Stamp the inversion activation boundary once, so "Momentum trades before
  // inversion" and "after" is a database fact rather than a remembered date.
  try { await ensureMomentumInversionActivation(); }
  catch (error) { console.error("[momentum-inversion] activation stamp failed", error); }
  await completeReadyBatches();

  const experimentId = await ensureExperiment();
  const pairExperimentIds = await ensurePairStrategyExperiments();
  await ensureStrategyConfigsSeeded();
  const versionIds = await multiStrategyVersionIds();
  try { await reconcileClosedExecutionMeasurements(); }
  catch (error) { console.error('[execution-measurement] reconciliation failed', error); }
  const evidence = await loadAdaptiveEvidence(experimentId);

  const snapshot = await getMultiStrategySnapshot();
  const quoteByInstrument = new Map(snapshot.quotes.map((quote) => [quote.instrument, quote]));
  const midByInstrument = (instrument: string) => {
    const quote = quoteByInstrument.get(instrument);
    return quote ? (quote.bid + quote.ask) / 2 : null;
  };

  let opened = 0;
  let reportedDataIssue = false;
  for (const item of snapshot.instruments) {
    const { instrument, quote, regime, candidates } = item;
    if (!candidates.length) continue;
    const evaluatedAt = candidates[0]!.evaluatedAt;
    const session = dayTradingSession(new Date(evaluatedAt)).label;
    const spreadPips = quote ? (quote.ask - quote.bid) / pipSizeFor(instrument) : null;
    const liveData = candidates[0]!.dataSource === "oanda" && Boolean(quote);

    const adaptiveCandidates = candidates.filter(isAdaptiveCandidate);
    const pairCandidates = candidates.filter((candidate) =>
      (ENABLED_PAIR_STRATEGY_IDS as readonly string[]).includes(candidate.family));
    const decision = decideInstrument({ instrument, session, regime, candidates: adaptiveCandidates.map(toAdaptiveCandidate), evidence });
    const pairSelection = pairCandidates.find((candidate) => candidate.status === "valid" && candidate.direction !== null) ?? null;
    const adaptiveSelection = decision.selected === null ? null : adaptiveCandidates.find((candidate) =>
      candidate.family === decision.selected!.family && candidate.direction === decision.selected!.direction && candidate.status === "valid") ?? null;
    // A frozen pair strategy is not an adaptive arm. When it fires it gets the
    // instrument's execution opportunity; adaptive candidates remain recorded
    // but cannot suppress or retune the frozen signal.
    const selectedCandidate = pairSelection ?? adaptiveSelection;
    const isSelected = (candidate: StrategyCandidate<StrategyId>) => selectedCandidate !== null
      && candidate.family === selectedCandidate.family
      && candidate.direction === selectedCandidate.direction
      && candidate.evaluatedAt === selectedCandidate.evaluatedAt
      && candidate.status === "valid";
    const selectionReason = pairSelection
      ? `Frozen ${pairSelection.family} pair strategy has execution priority; adaptive candidates remain observational.`
      : decision.reason;

    // The global default remains one open position per instrument. GBPUSD V3 is
    // the sole exception: its 10:30, 11:00, and 11:30 legs may overlap when the frozen
    // overlap policy says doing so cannot net or overwrite another position.
    const openRows = await query<OpenExecutionLeg>(
      "SELECT strategy_family,direction,features FROM paper_strategy_trades WHERE instrument=$1 AND status='open'",
      [instrument],
    );
    // The state as it stands BEFORE execution is attempted, which is when the row
    // is now written. A candidate the engine chose is recorded as not-executed;
    // openPaperTrade promotes it to 'selected' if — and only if — a trade is
    // actually created. So 'selected' means "this traded" rather than "we meant
    // to trade this", and a selection the risk gates turn away stays honestly
    // blocked with its reason attached, instead of being frozen as selected.
    const executionStatusFor = (candidate: StrategyCandidate<StrategyId>): string => {
      if (isSelected(candidate)) return "blocked";
      if (candidate.status !== "valid") return "no_setup";
      return "suppressed";
    };
    const preExecutionRejectionFor = (candidate: StrategyCandidate<StrategyId>): ExecutionBlock | null => {
      if (!isSelected(candidate)) return null;
      const overlap = gbpusdExecutionBlock(candidate, openRows.rows, snapshot.account.hedgingEnabled, candidate.family);
      if (overlap) return overlap;
      if (!liveData || !quote) return { code: "GLOBAL_RISK_BLOCK", message: "Execution blocked: OANDA data or the executable quote is unavailable." };
      const sharedGateRejection = sharedExecutionRejectionFor(candidate);
      if (sharedGateRejection) {
        const spreadFailed = candidate.conditions.some((item) => item.required && !item.passed && item.name === "Spread");
        return { code: spreadFailed ? "SPREAD_BLOCK" : "GLOBAL_RISK_BLOCK", message: sharedGateRejection };
      }
      return null;
    };

    // Record every candidate: the executed one, the suppressed ones, the blocked
    // ones. Suppressed candidates are preserved in the evaluations table so their
    // hypothetical outcome can be labelled later (shadow research).
    //
    // This runs BEFORE execution, and the order is load-bearing. openPaperTrade
    // stamps trade_created, paper_trade_id and any risk rejection onto this row
    // with an UPDATE, so the row has to exist by the time it runs. Opening the
    // trade first meant those updates matched zero rows and were lost in silence:
    // every executed multi-strategy trade was filed as never having been created,
    // and the reason a risk-blocked selection failed was never recorded at all.
    // The legacy single-strategy cycle above persists in this order for the same
    // reason, which is why its trade_created was the only one that worked.
    for (const candidate of candidates) {
      const attribution = attributionFor(candidate, versionIds, experimentId, pairExperimentIds);
      const executionBlock = preExecutionRejectionFor(candidate);
      const recordedReason = executionBlock?.message ?? (candidate.status === 'valid' && !isSelected(candidate) ? selectionReason : undefined);
      await persistPaperEvaluation(candidate, attribution.versionId, spreadPips, attribution, executionStatusFor(candidate), recordedReason, executionBlock?.code);
      // Forward shadow A/B on the Momentum SHORT inversion hypothesis. Records
      // only; it opens nothing, sizes nothing, and its table is read by neither
      // the risk engine nor the adaptive engine's evidence loader, so it cannot
      // influence what this cycle decides. Wrapped so a research failure can
      // never interrupt trading.
      if (isAdaptiveCandidate(candidate)) {
        try { await recordMomentumShortPair({ candidate, quote, spreadPips, session }); }
        catch (error) { console.error("[momentum-short-inversion] record failed", error); }
      // Paired original/inverted arms for EVERY eligible Momentum opportunity,
      // written before execution is attempted so the pair exists whether or not
      // anything trades. At most one arm is later marked executed; the other is
      // shadow-resolved. Research-only and outside the evidence loader, so it
      // cannot influence this or any later decision.
        try { await recordMomentumInversionArms({ candidate, quote, spreadPips, session }); }
        catch (error) { console.error("[momentum-arms] record failed", error); }
      // Separate fixed +10m direction cohort. Valid Momentum candidates are
      // recorded before selection, so suppressed and risk-blocked signals are
      // in the same honest denominator as signals that become paper trades.
        try { await recordMomentumDirection10m({ candidate, session }); }
        catch (error) { console.error("[momentum-direction-10m] record failed", error); }
      }
    }

    let openedTradeId: string | null = null;
    const selectedExecutionRejection = selectedCandidate ? preExecutionRejectionFor(selectedCandidate) : null;
    if (selectedCandidate && liveData && quote && !selectedExecutionRejection) {
      // The single point where an execution policy may change direction. The
      // adaptive engine has already chosen using the strategy's OWN verdict, so
      // selection is unaffected; only the trade that gets built changes. The
      // policy rebuilds geometry on the opposite side of the book rather than
      // negating anything, so the inverted trade pays its own real spread.
      const policy = isAdaptiveCandidate(selectedCandidate) && selectedCandidate.family === "momentum"
        ? applyMomentumInversion(selectedCandidate, quote) : null;
      const chosen = policy?.candidate ?? selectedCandidate;
      if (chosen && chosen.entry !== null) {
        const attribution = {
          ...attributionFor(chosen, versionIds, experimentId, pairExperimentIds),
          originalDirection: policy?.originalDirection ?? null,
          inverted: policy?.inverted ?? false,
          inversionExperimentId: policy?.inverted ? MOMENTUM_INVERSION_EXPERIMENT : null,
        };
        const quoteToUsdRate = usdPerUnitOfCurrency(currenciesOf(instrument).quote, midByInstrument);
        openedTradeId = await openPaperTrade(chosen, userId, attribution.versionId, spreadPips ?? 0, snapshot.account.balance, quoteToUsdRate, attribution, snapshot.account.hedgingEnabled);
        if (openedTradeId) {
          opened += 1;
          // Mark WHICH arm of the Momentum pair actually traded. The arm is
          // decided by comparing the executed direction with what Momentum
          // itself concluded, so an un-inverted trade lands on 'original' and an
          // inverted one on 'inverted' — and a partial unique index guarantees
          // the pair can never end up with two executed arms.
          if (selectedCandidate?.family === "momentum" && selectedCandidate.direction && chosen.direction) {
            try {
              await attachMomentumExecution({
                instrument: selectedCandidate.instrument,
                decisionTime: selectedCandidate.evaluatedAt,
                arm: armForExecutedDirection(selectedCandidate.direction, chosen.direction),
                paperTradeId: openedTradeId,
              });
            } catch (error) { console.error("[momentum-arms] execution attach failed", error); }
          }
          await queuePracticeOrderIntent(userId, openedTradeId);
          // Research annotation only. Tagged with the direction-agnostic entry
          // time, so an inverted Momentum trade carries the same news context
          // its original signal did — which is what makes the two comparable.
          await tagNewTradeSafely({ id: openedTradeId, instrument: chosen.instrument, openedAt: chosen.evaluatedAt });
        }
      }
    }

    // Written after execution, because the watch snapshot carries the opened
    // trade's id. `selected` here means the candidate the engine chose AND that
    // a trade actually exists for it — the same pair of facts the previous
    // single-loop form expressed as execStatus === "selected" && openedTradeId.
    for (const candidate of candidates) {
      const attribution = attributionFor(candidate, versionIds, experimentId, pairExperimentIds);
      await persistMultiWatchSnapshot(candidate, quote, attribution, isSelected(candidate) && openedTradeId !== null, selectionReason, strategySession(candidate), isSelected(candidate) ? openedTradeId : null);
    }

    // Dashboard /api/watchlist still reads paper_watch_snapshots. Mirror the
    // selected (or best) candidate there so newly added majors are not left as
    // "unavailable" just because the live collector writes a different table.
    const representative =
      candidates.find(isSelected)
      ?? candidates.find((candidate) => candidate.status === "valid")
      ?? candidates[0];
    if (representative) {
      await persistWatchSnapshot(representative, quote, attributionFor(representative, versionIds, experimentId, pairExperimentIds).versionId);
    }

    if (!liveData && !reportedDataIssue) {
      await queueNotification({ userId, kind: "system_issue", title: "Market data unavailable", message: "OANDA data is unavailable or stale. Multi-strategy candidates and trades are fail-closed until it recovers.", instrument: null, paperTradeId: null, dedupeKey: "market_data_unavailable" });
      reportedDataIssue = true;
    }

    const adaptiveTradeId = openedTradeId && selectedCandidate && isAdaptiveFamily(selectedCandidate.family) ? openedTradeId : null;
    await logAdaptiveDecision(experimentId, instrument, evaluatedAt, decision, regime, adaptiveCandidates, adaptiveTradeId, executionStatusFor);
  }

  const execution = await processPendingPracticeOrders();
  return { opened, resolved, execution };
}

/** Per-(instrument, family) live view for the multi-strategy watchlist UI. */
export async function multiStrategyWatchlist() {
  const snaps = await query(`SELECT instrument,strategy_family AS "family",strategy_version AS "version",config_version AS "configVersion",setup_status AS "setupStatus",direction,entry::float,stop::float,target::float,risk_reward::float AS "riskReward",regime,trend_strength::float AS "trendStrength",volatility_bucket AS "volatilityBucket",atr_pips::float AS "atrPips",session,selected,data_status AS "dataStatus",spread_pips::float AS "spreadPips",open_trade_id AS "openTradeId",evaluated_at AS "evaluatedAt",updated_at AS "updatedAt" FROM multistrategy_watch_snapshots ORDER BY array_position($1::text[],instrument),strategy_family`, [MAJOR_INSTRUMENTS]);
  const decisions = await query(`SELECT DISTINCT ON (instrument) instrument,adaptive_state AS "adaptiveState",reason,selected,decision_time AS "decisionTime" FROM adaptive_decisions ORDER BY instrument,decision_time DESC`);
  const decisionByInstrument = new Map(decisions.rows.map((row: any) => [row.instrument, row]));
  const byInstrument = new Map<string, any[]>();
  for (const row of snaps.rows as any[]) byInstrument.set(row.instrument, [...(byInstrument.get(row.instrument) ?? []), row]);
  return MAJOR_INSTRUMENTS.map((instrument) => {
    const strategies = byInstrument.get(instrument) ?? [];
    const decision = decisionByInstrument.get(instrument) ?? null;
    const selectedPair = strategies.find((strategy) => strategy.selected
      && (ENABLED_PAIR_STRATEGY_IDS as readonly string[]).includes(strategy.family));
    const displayedDecision = selectedPair ? {
      adaptiveState: "pair_specific",
      reason: "Frozen pair-specific strategy selected outside adaptive ranking.",
      selected: { family: selectedPair.family, direction: selectedPair.direction },
      decisionTime: selectedPair.evaluatedAt,
    } : decision;
    const first = strategies[0];
    return {
      instrument,
      session: first?.session ?? "Unavailable",
      dataStatus: first?.dataStatus ?? "unavailable",
      regime: first?.regime ?? null,
      trendStrength: first?.trendStrength ?? null,
      volatilityBucket: first?.volatilityBucket ?? null,
      atrPips: first?.atrPips ?? null,
      updatedAt: first?.updatedAt ?? null,
      strategies,
      adaptive: displayedDecision,
    };
  });
}

/** Per-family cohort statistics for the fresh experiment. */
export async function multiStrategyOverview() {
  const experiment = await query<{ id: string; label: string; status: string; created_at: string }>("SELECT id,label,status,created_at AS \"createdAt\" FROM strategy_experiments WHERE label=$1", [MULTISTRATEGY_EXPERIMENT_LABEL]);
  if (!experiment.rows[0]) return { experiment: null, families: [] };
  const experimentId = experiment.rows[0].id;
  const pairIds = [...ENABLED_PAIR_STRATEGY_IDS];
  const trades = await query<StoredTrade & { strategy_family: string }>("SELECT id,trade_sequence::text,instrument,direction,status,outcome,result_r::text,session,weekday,spread_pips::text,opened_at,closed_at,features,strategy_family FROM paper_strategy_trades WHERE experiment_id=$1 OR strategy_family=ANY($2::text[]) ORDER BY trade_sequence", [experimentId, pairIds]);
  const evals = await query<{ strategy_family: string; execution_status: string | null; count: string }>("SELECT strategy_family,execution_status,count(*)::text FROM paper_strategy_evaluations WHERE experiment_id=$1 OR strategy_family=ANY($2::text[]) GROUP BY strategy_family,execution_status", [experimentId, pairIds]);
  const batches = await query<{ strategy_family: string; batch_number: number; status: string; assigned_count: number }>("SELECT strategy_family,batch_number AS \"batchNumber\",status,assigned_count AS \"assignedCount\" FROM paper_strategy_batches WHERE experiment_id=$1 OR strategy_family=ANY($2::text[]) ORDER BY strategy_family,batch_number", [experimentId, pairIds]);
  const gbpusdEvaluations = await query<{
    setup_status: string; direction: string | null; execution_status: string | null;
    rejection_reason: string | null; features: Record<string, any>;
  }>(
    `SELECT setup_status,direction,execution_status,rejection_reason,features
       FROM paper_strategy_evaluations WHERE strategy_family=$1 ORDER BY decision_time`,
    [GBPUSD_STRATEGY_ID],
  );
  const gbpusdBrokerIntents = await query<{ status: string; count: string }>(
    `SELECT intent.status,count(*)::text
       FROM practice_order_intents intent
       JOIN paper_strategy_trades trade ON trade.id=intent.paper_trade_id
      WHERE trade.strategy_family=$1 GROUP BY intent.status`,
    [GBPUSD_STRATEGY_ID],
  );
  // Shadow (hypothetical) outcomes of suppressed/blocked valid candidates, kept
  // separate from executed results so the two can be compared per family.
  const shadow = await query<{ strategy_family: string; resolved: string; wins: string; net_r: string }>(
    `SELECT evaluation.strategy_family,
            count(*)::text AS resolved,
            count(*) FILTER (WHERE shadow.result_r > 0)::text AS wins,
            COALESCE(sum(shadow.result_r),0)::text AS net_r
       FROM shadow_candidate_outcomes shadow
       JOIN paper_strategy_evaluations evaluation ON evaluation.id = shadow.evaluation_id
      WHERE evaluation.experiment_id=$1 AND shadow.result_r IS NOT NULL
        AND shadow.outcome IN ('target_first','stop_first','forced_close','timeout')
      GROUP BY evaluation.strategy_family`,
    [experimentId],
  );
  const families = REPORTING_STRATEGY_IDS.map((family) => {
    const rows = trades.rows.filter((row) => row.strategy_family === family);
    const familyEvals = evals.rows.filter((row) => row.strategy_family === family);
    const totalCandidates = familyEvals.reduce((sum, row) => sum + Number(row.count), 0);
    const countFor = (status: string) => familyEvals.filter((row) => row.execution_status === status).reduce((sum, row) => sum + Number(row.count), 0);
    const shadowRow = shadow.rows.find((row) => row.strategy_family === family);
    const shadowResolved = shadowRow ? Number(shadowRow.resolved) : 0;
    const shadowNetR = shadowRow ? Number(shadowRow.net_r) : 0;
    const shadowWins = shadowRow ? Number(shadowRow.wins) : 0;
    return {
      family,
      ...paperBatchMetrics(rows),
      candidates: totalCandidates,
      selectedCandidates: countFor("selected"),
      suppressedCandidates: countFor("suppressed"),
      blockedCandidates: countFor("blocked"),
      shadowResolved,
      shadowWins,
      shadowWinRate: shadowResolved ? shadowWins / shadowResolved : null,
      shadowExpectancyR: shadowResolved ? shadowNetR / shadowResolved : null,
      batches: batches.rows.filter((row) => row.strategy_family === family),
    };
  });
  const rawGbpusd = gbpusdEvaluations.rows.filter((row) => row.setup_status === "valid" && row.direction !== null);
  const gbpusdTrades = trades.rows.filter((row) => row.strategy_family === GBPUSD_STRATEGY_ID);
  const originOf = (row: { features?: Record<string, unknown> }) =>
    (row.features as any)?.gbpusdStrategy?.originCode as GbpusdOriginCode | undefined;
  const confidenceOf = (row: { features?: Record<string, unknown> }) =>
    (row.features as any)?.gbpusdStrategy?.confidenceTag as "BASE" | "PEN_EXTREME" | undefined;
  const blockedByReason: Record<string, number> = {};
  for (const row of rawGbpusd.filter((item) => item.execution_status === "blocked")) {
    const explicit = row.features?.gbpusdStrategy?.exitReason as string | undefined;
    const reason = explicit
      ?? (/opposite/i.test(row.rejection_reason ?? "") ? "BLOCKED_OPPOSITE_POSITION"
        : /spread/i.test(row.rejection_reason ?? "") ? "SPREAD_BLOCK" : "GLOBAL_RISK_BLOCK");
    blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
  }
  const brokerCount = (status: string) => Number(gbpusdBrokerIntents.rows.find((row) => row.status === status)?.count ?? 0);
  const gbpusdStrategy = {
    rawSignals: rawGbpusd.length,
    paperExecutedTrades: gbpusdTrades.length,
    brokerExecutedTrades: brokerCount("submitted"),
    blockedSignals: rawGbpusd.filter((row) => row.execution_status === "blocked").length,
    blockedByReason,
    executionErrors: brokerCount("failed") + brokerCount("rejected") + brokerCount("unknown"),
    penExtremeSignals: rawGbpusd.filter((row) => row.features?.gbpusdStrategy?.confidenceTag === "PEN_EXTREME").length,
    byOrigin: Object.fromEntries(["1030", "1100", "1130"].map((origin) => [origin, {
      rawSignals: rawGbpusd.filter((row) => row.features?.gbpusdStrategy?.originCode === origin).length,
      ...paperBatchMetrics(gbpusdTrades.filter((row) => originOf(row) === origin)),
    }])),
    byConfidence: Object.fromEntries(["BASE", "PEN_EXTREME"].map((tag) => [tag, {
      rawSignals: rawGbpusd.filter((row) => row.features?.gbpusdStrategy?.confidenceTag === tag).length,
      ...paperBatchMetrics(gbpusdTrades.filter((row) => confidenceOf(row) === tag)),
    }])),
  };
  return { experiment: experiment.rows[0], families, gbpusdStrategy };
}
