import type { PoolClient } from "pg";

import { query, transaction } from "./database.js";
import { labelOutcome, type NormalizedQuote } from "./research.js";
import { displayPair, queueNotification, sendPushNotification } from "./notifications.js";
import { closePracticeTradeForPaperTrade, processPendingPracticeOrders, queuePracticeOrderIntent } from "./practice-execution.js";
import { currenciesOf, pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculatePositionSize, usdPerUnitOfCurrency } from "../../frontend/src/lib/risk/engine.js";
import { getPracticeTradeState, getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import { DAY_TRADING_TIME_ZONE, dayTradingSession } from "../../frontend/src/lib/strategy/strategy-engine.js";
// The strategy that is allowed to create trades. Changing this starts a new
// batch on its own: batches are scoped to the version that produced them.
import { LIQUIDITY_STRATEGY_VERSION as ACTIVE_STRATEGY_VERSION, RISK as LIQUIDITY_RISK } from "../../frontend/src/lib/strategy/liquidity-strategy.js";
import { RULES as LIQUIDITY_RULES } from "../../frontend/src/lib/strategy/liquidity-confirmation.js";
const MAX_TRADES_PER_DAY = LIQUIDITY_RISK.maxTradesPerDay;
import { getStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";
import type { StrategySetup } from "../../frontend/src/lib/strategy/types.js";
import { MAJOR_INSTRUMENTS, type MajorInstrument } from "../../frontend/src/types/forex.js";

const STRATEGY_NAME = "deterministic-forex";
const BATCH_SIZE = 100;
const COLLECTOR_LOCK = 24_100_001;

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
  if (maxPositions !== null && (!Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > MAJOR_INSTRUMENTS.length)) throw new Error("Maximum simultaneous positions must be unlimited or between 1 and 10.");

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

async function ensureCollectingBatch(client: PoolClient, versionId: string, userId: string) {
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
    "INSERT INTO paper_strategy_batches(batch_number,strategy_version_id,universe,configuration) VALUES($1,$2,$3::jsonb,$4::jsonb) RETURNING id,batch_number,configuration",
    [batchNumber, versionId, JSON.stringify(MAJOR_INSTRUMENTS), JSON.stringify(configuration)],
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
    [setup.instrument, versionId, setup.evaluatedAt, setup.dataSource === "oanda" && fresh ? "connected" : "unavailable", setup.status, setup.direction, quote?.bid ?? null, quote?.ask ?? null, spreadPips, setup.entry, setup.stop, setup.target, dayTradingSession(new Date(setup.evaluatedAt)).label, JSON.stringify(setup.conditions), JSON.stringify(setup.features), open.rows[0]?.id ?? null, open.rows[0]?.batch_number ?? null],
  );
}

function setupRejectionReason(setup: StrategySetup) {
  return setup.conditions.find((item) => item.required && !item.passed)?.reason ?? null;
}

async function persistPaperEvaluation(setup: StrategySetup, versionId: string, spreadPips: number | null) {
  await query(
    `INSERT INTO paper_strategy_evaluations(strategy_version_id,instrument,decision_time,setup_status,direction,entry,stop,target,risk_reward,rejection_reason,trade_created,spread_pips,conditions,features)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12::jsonb,$13::jsonb)
     ON CONFLICT(strategy_version_id,instrument,decision_time) DO UPDATE SET setup_status=EXCLUDED.setup_status,direction=EXCLUDED.direction,entry=EXCLUDED.entry,stop=EXCLUDED.stop,target=EXCLUDED.target,risk_reward=EXCLUDED.risk_reward,rejection_reason=EXCLUDED.rejection_reason,spread_pips=EXCLUDED.spread_pips,conditions=EXCLUDED.conditions,features=EXCLUDED.features,updated_at=now()`,
    [versionId, setup.instrument, setup.evaluatedAt, setup.status, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, setupRejectionReason(setup), spreadPips, JSON.stringify(setup.conditions), JSON.stringify(setup.features)],
  );
}

async function openPaperTrade(setup: StrategySetup, userId: string, versionId: string, spreadPips: number, accountBalance: number, quoteToUsdRate: number | null): Promise<string | null> {
  if (setup.status !== "valid" || !setup.direction || setup.entry === null || setup.stop === null || setup.target === null || setup.riskReward === null) return null;
  const entry = setup.entry;
  const stop = setup.stop;
  const session = dayTradingSession(new Date(setup.evaluatedAt)).label;
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [COLLECTOR_LOCK]);
    const reject = async (reason: string) => {
      await client.query("UPDATE paper_strategy_evaluations SET rejection_reason=$1,updated_at=now() WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4 AND trade_created=false", [reason, versionId, setup.instrument, setup.evaluatedAt]);
      return null;
    };
    const policy = await policyRow(client, userId, true);
    if (policy.collectionPaused) return reject("Risk blocked: paper collection is paused.");
    const open = await client.query("SELECT 1 FROM paper_strategy_trades WHERE instrument=$1 AND status='open'", [setup.instrument]);
    if (open.rowCount) return reject("Risk blocked: this instrument already has an open position.");
    const duplicate = await client.query("SELECT 1 FROM paper_strategy_trades WHERE strategy_version_id=$1 AND instrument=$2 AND decision_time=$3", [versionId, setup.instrument, setup.evaluatedAt]);
    if (duplicate.rowCount) return reject("Duplicate evaluation: this decision was already collected.");
    const batch = await ensureCollectingBatch(client, versionId, userId);
    if (batch.configuration.excludedPairs.includes(setup.instrument) || batch.configuration.excludedSessions.includes(session)) return reject("Risk blocked: the active batch excludes this pair or session.");
    const risk = storedRiskConfiguration(batch.configuration);
    const portfolio = await client.query<{ open_count: string; nominal_risk: string }>("SELECT count(*)::text AS open_count,COALESCE(sum(nominal_risk_percent),0)::text AS nominal_risk FROM paper_strategy_trades WHERE status='open'");
    const openCount = Number(portfolio.rows[0]!.open_count);
    const nominalRisk = Number(portfolio.rows[0]!.nominal_risk);
    if (!paperRiskAllowsEntry(risk, openCount, nominalRisk)) return reject("Risk blocked: the portfolio position or nominal-risk limit was reached.");

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
      if (Number(takenToday.rows[0]!.count) >= MAX_TRADES_PER_DAY) return reject("Risk blocked: the daily trade limit was reached.");
    }
    // A true cross (EUR_GBP, EUR_JPY, GBP_JPY) is quoted in a non-USD currency
    // whose USD value cannot be read from its own price, so without the cross
    // rate its size — and every R and lot figure derived from it — is wrong.
    // Fail the entry closed rather than record a mis-sized trade into the data.
    const { base, quote } = currenciesOf(setup.instrument);
    const isTrueCross = base !== "USD" && quote !== "USD";
    if (isTrueCross && (quoteToUsdRate === null || !Number.isFinite(quoteToUsdRate) || quoteToUsdRate <= 0)) {
      return reject("Risk blocked: no USD conversion rate for the quote currency, so position size cannot be trusted.");
    }
    const positionSize = calculatePositionSize({ instrument: setup.instrument, accountBalance, riskPercent: risk.riskPercent, entry, stop, applyPaperCap: false, quoteToUsdRate: quoteToUsdRate ?? undefined });
    if (!positionSize) return reject("Risk blocked: no valid position size could be calculated.");
    const nextSequence = await client.query<{ value: string }>("SELECT (COALESCE(max(trade_sequence),0)+1)::text AS value FROM paper_strategy_trades");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO paper_strategy_trades(trade_sequence,user_id,batch_id,strategy_version_id,instrument,decision_time,direction,entry,stop,target,planned_r,nominal_risk_percent,nominal_risk_amount,calculated_units,calculated_standard_lots,spread_pips,session,weekday,setup_name,checklist_score,conditions,features,news_status,opened_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23,$24)
       RETURNING id`,
      [nextSequence.rows[0]!.value, userId, batch.id, versionId, setup.instrument, setup.evaluatedAt, setup.direction, setup.entry, setup.stop, setup.target, setup.riskReward, risk.riskPercent, positionSize.calculatedEstimatedRisk, positionSize.calculatedUnits, positionSize.calculatedStandardLots, spreadPips, session, weekdayAt(setup.evaluatedAt), setupNameFor(setup), checklistScore(setup), JSON.stringify(setup.conditions), JSON.stringify(setup.features), setup.features.newsStatus ?? "not_evaluated", setup.evaluatedAt],
    );
    const tradeId = inserted.rows[0]!.id;
    await client.query("UPDATE paper_strategy_evaluations SET trade_created=true,paper_trade_id=$1,rejection_reason=NULL,updated_at=now() WHERE strategy_version_id=$2 AND instrument=$3 AND decision_time=$4", [tradeId, versionId, setup.instrument, setup.evaluatedAt]);
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
  const intent = await query<{ broker_trade_id: string | null }>(
    "SELECT broker_trade_id FROM practice_order_intents WHERE paper_trade_id=$1 AND status='submitted'",
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

  const risk = Number(trade.nominal_risk_amount);
  return {
    outcome,
    exit,
    // R is derived from the cash the broker booked, so it carries the slippage
    // the modelled ±1R never showed.
    resultR: state.realizedPL !== null && Number.isFinite(risk) && risk !== 0 ? state.realizedPL / risk : null,
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
): Promise<boolean> {
  const closed = await query<{ id: string }>(
    `UPDATE paper_strategy_trades SET status='closed',outcome=$2,exit=$3,result_r=$4,paper_pl=$5,max_favorable_r=$6,max_adverse_r=$7,closed_at=COALESCE($8,now()),exit_reason=$2,updated_at=now() WHERE id=$1 AND status='open'`,
    [trade.id, broker.outcome, broker.exit, broker.resultR, broker.paperPl, excursion.maxFavorableR, excursion.maxAdverseR, broker.closedAt],
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
    `SELECT trade.id,trade.user_id,trade.instrument,trade.decision_time,trade.direction,trade.entry,trade.stop,trade.target,trade.nominal_risk_amount
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
    if (await bookBrokerClose(trade, broker, excursion)) closed += 1;
  }
  return closed;
}

async function resolveOpenTrades() {
  const open = await query<OpenTradeRow>("SELECT id,user_id,instrument,decision_time,direction,entry,stop,target,nominal_risk_amount FROM paper_strategy_trades WHERE status='open' ORDER BY opened_at");
  let resolved = 0;
  for (const trade of open.rows) {
    const candles = (await getResearchCandles(trade.instrument, "M15", 500)).filter((item) => item.complete);
    const quotes = candles.map(toQuote).filter((quote) => new Date(quote.closeTime) > new Date(trade.decision_time));
    if (!quotes.length) continue;
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
        await queueNotification({ userId: trade.user_id, kind: "system_issue", title: `${displayPair(trade.instrument)} practice close needs attention`, message: error instanceof Error ? error.message.slice(0, 180) : `The ${closeContext} broker close failed. The internal trade remains open.`, instrument: trade.instrument, paperTradeId: trade.id, dedupeKey: `practice_close_failed:${trade.id}` });
        continue;
      }
    }
    const updated = await query<{ id: string }>(
      `UPDATE paper_strategy_trades SET status=$2,outcome=$3,exit=$4,result_r=$5,paper_pl=$6,max_favorable_r=$7,max_adverse_r=$8,closed_at=$9,exit_reason=$10,updated_at=now() WHERE id=$1 AND status='open'`,
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

export async function watchlistSnapshot() {
  const rows = await query(`SELECT watch.instrument,watch.evaluated_at AS "evaluatedAt",watch.data_status AS "dataStatus",watch.setup_status AS "setupStatus",COALESCE(trade.direction,watch.direction) AS direction,watch.bid::float,watch.ask::float,watch.spread_pips::float AS "spreadPips",COALESCE(trade.entry,watch.entry)::float AS entry,COALESCE(trade.stop,watch.stop)::float AS stop,COALESCE(trade.target,watch.target)::float AS target,watch.session,watch.conditions,watch.features,watch.open_trade_id AS "openTradeId",watch.batch_number AS "batchNumber",watch.updated_at AS "updatedAt",trade.trade_sequence::text AS "tradeSequence" FROM paper_watch_snapshots watch LEFT JOIN paper_strategy_trades trade ON trade.id=watch.open_trade_id ORDER BY array_position($1::text[],watch.instrument)`, [MAJOR_INSTRUMENTS]);
  const byInstrument = new Map(rows.rows.map((row: any) => [row.instrument, row]));
  return MAJOR_INSTRUMENTS.map((instrument) => byInstrument.get(instrument) ?? { instrument, evaluatedAt: null, dataStatus: "unavailable", setupStatus: "invalid", direction: null, bid: null, ask: null, spreadPips: null, entry: null, stop: null, target: null, session: "Unavailable", conditions: [], features: {}, openTradeId: null, batchNumber: null, tradeSequence: null, updatedAt: null });
}

export async function paperCycleOverview() {
  const batches = await query(`SELECT id,batch_number AS "batchNumber",status,assigned_count AS "assignedCount",configuration,summary,recommendation,decision,decision_note AS "decisionNote",started_at AS "startedAt",completed_at AS "completedAt" FROM paper_strategy_batches ORDER BY batch_number DESC LIMIT 20`);
  const current = batches.rows.find((batch: any) => batch.status !== "complete") ?? null;
  const currentTrades = current ? await query(`SELECT id,trade_sequence::text AS "tradeSequence",instrument,direction,status,outcome,entry::float,stop::float,target::float,exit::float,result_r::float AS "resultR",nominal_risk_percent::float AS "nominalRiskPercent",nominal_risk_amount::float AS "nominalRiskAmount",paper_pl::float AS "paperPl",spread_pips::float AS "spreadPips",session,weekday,planned_r::float AS "plannedR",checklist_score::float AS "checklistScore",news_status AS "newsStatus",max_favorable_r::float AS "maxFavorableR",max_adverse_r::float AS "maxAdverseR",opened_at AS "openedAt",closed_at AS "closedAt",exit_reason AS "exitReason",review FROM paper_strategy_trades WHERE batch_id=$1 ORDER BY trade_sequence DESC`, [(current as any).id]) : { rows: [] };
  const liveSummary = paperBatchMetrics((currentTrades.rows as any[]).map((row) => ({ ...row, trade_sequence: row.tradeSequence, result_r: row.resultR, spread_pips: row.spreadPips, opened_at: row.openedAt, closed_at: row.closedAt })) as StoredTrade[]);
  const lifetimeRows = await query<StoredTrade>("SELECT id,trade_sequence::text,instrument,direction,status,outcome,result_r::text,session,weekday,spread_pips::text,opened_at,closed_at FROM paper_strategy_trades ORDER BY trade_sequence");
  // The account chart plots balance over time, which does not belong to any one
  // batch: sourced from the collecting batch it emptied the moment a batch was
  // filed, and every completed batch would erase the account's history.
  const accountTrades = await query(
    `SELECT trade_sequence::int AS "tradeSequence", paper_pl::float AS "paperPl", closed_at AS "closedAt", opened_at AS "openedAt", status
     FROM paper_strategy_trades WHERE opened_at > now() - interval '90 days' ORDER BY opened_at`,
  );
  return { strategyVersion: ACTIVE_STRATEGY_VERSION, batchSize: BATCH_SIZE, lifetimeSummary: paperBatchMetrics(lifetimeRows.rows), current: current ? { ...current, liveSummary, remaining: BATCH_SIZE - Number((current as any).assignedCount) } : null, batches: batches.rows, trades: currentTrades.rows, accountTrades: accountTrades.rows };
}

/**
 * The journal log: manually written entries plus every strategy trade the cycle
 * placed, so a trade lands in the journal as soon as it resolves. Ambiguous
 * strategy trades are left out until the resolver settles them.
 */
export async function journalTradeLog(userId: string) {
  const rows = await query(
    `SELECT id, origin, pair, direction, status, result, opened_at AS "openedAt", closed_at AS "closedAt",
            entry, stop, target, exit, result_r AS "resultR", paper_pl AS "paperPl", reason, notes, sequence, outcome,
            instrument_code AS "instrument", nominal_risk_amount AS "nominalRiskAmount"
     FROM (
       SELECT id::text, origin, pair, direction, status, result, opened_at, closed_at,
              entry::float, stop::float, target::float, exit::float, result_r::float,
              NULL::float AS paper_pl, reason, notes, NULL::text AS sequence, NULL::text AS outcome,
              NULL::text AS instrument_code, NULL::float AS nominal_risk_amount
       FROM paper_trades WHERE user_id=$1
       UNION ALL
       SELECT trade.id::text, 'strategy', instrument.display_name, trade.direction,
              trade.status, CASE WHEN trade.status <> 'closed' OR trade.result_r IS NULL THEN 'open'
                                 WHEN trade.result_r > 0.01 THEN 'win'
                                 WHEN trade.result_r < -0.01 THEN 'loss' ELSE 'breakeven' END,
              trade.opened_at, trade.closed_at,
              trade.entry::float, trade.stop::float, trade.target::float, trade.exit::float, trade.result_r::float, trade.paper_pl::float,
              trade.setup_name || ' · ' || trade.session,
              CASE WHEN trade.exit_reason IS NULL THEN ''
                   ELSE 'Broker outcome: ' || replace(trade.exit_reason, '_', ' ') END,
              trade.trade_sequence::text, trade.outcome,
              -- Carried so an open row can be marked to the live quote: the code
              -- matches the watchlist snapshot, the risk amount sets the scale.
              trade.instrument, trade.nominal_risk_amount::float
       FROM paper_strategy_trades trade
       JOIN instruments instrument ON instrument.code = trade.instrument
       WHERE trade.user_id=$1 AND trade.status IN ('open', 'closed')
     ) log
     ORDER BY "openedAt" DESC`,
    [userId],
  );
  return rows.rows;
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
