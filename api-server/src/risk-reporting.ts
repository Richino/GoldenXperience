import { query } from "./database.js";
import { estimatedRiskMetrics, verifiedInitialRisk, verifiedTradeR, type InitialRiskPlan, type HistoricalRiskEstimate } from "../../frontend/src/lib/risk-metrics.js";
import { strategyRiskEstimate } from "./historical-risk-estimates.js";
import type { OpenPosition } from "../../frontend/src/types/forex.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getAccountSummary } from "../../frontend/src/lib/oanda/client.js";
import { readRiskNetCash } from "./risk-net-cash.js";
type Cash = Awaited<ReturnType<typeof readRiskNetCash>>;
/**
 * A CLOSED trade's fills never change, so its net cash is cached for the life
 * of the process. Each read is 3+ sequential OANDA calls; a 5-minute TTL made
 * the journal re-pay ~58 of them (~11s) on every cold load. The map holds the
 * in-flight promise too, so the journal page and its summary — which project
 * the same rows concurrently — share one read per trade. A failed or
 * not-yet-closed read is dropped so the next request retries it.
 */
const CLOSED_CASH_LIMIT = 2048;
const CLOSED_CASH_CONCURRENCY = 8;
const closedCash = new Map<string, Promise<Cash>>();
function readClosedCash(accountId: string, tradeId: string): Promise<Cash> {
  const key = `${accountId}:${tradeId}`, cached = closedCash.get(key);
  if (cached) return cached;
  const pending = readRiskNetCash(tradeId).catch(() => null).then(value => value?.state === "CLOSED" ? value : null);
  if (closedCash.size >= CLOSED_CASH_LIMIT) closedCash.delete(closedCash.keys().next().value!);
  closedCash.set(key, pending);
  void pending.then(value => { if (!value && closedCash.get(key) === pending) closedCash.delete(key); });
  return pending;
}

/** Reads every key with at most `limit` OANDA reads in flight at once. */
async function readClosedCashAll(accountId: string, tradeIds: string[], limit = CLOSED_CASH_CONCURRENCY) {
  const results = new Map<string, Cash>();
  const queue = [...new Set(tradeIds)];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) results.set(id, await readClosedCash(accountId, id));
  }));
  return results;
}

/**
 * Risk reporting only reads the account's id, currency and connection state,
 * which do not move between requests, so one OANDA summary serves a minute of
 * journal reads. A disconnected result is never cached, so it retries at once.
 */
const RISK_ACCOUNT_TTL_MS = 60_000;
let riskAccountCache: { until: number; value: Promise<Awaited<ReturnType<typeof getAccountSummary>>> } | null = null;
function riskAccount() {
  if (riskAccountCache && riskAccountCache.until > Date.now()) return riskAccountCache.value;
  const value = getAccountSummary();
  const entry = { until: Date.now() + RISK_ACCOUNT_TTL_MS, value };
  riskAccountCache = entry;
  void value.then(
    result => { if (result.status.state !== "connected" && riskAccountCache === entry) riskAccountCache = null; },
    () => { if (riskAccountCache === entry) riskAccountCache = null; },
  );
  return value;
}

/** Read-time compatibility only; never rewrite a legacy financial record. */
export async function projectRiskReporting(userId: string, rows: Record<string, any>[]): Promise<Record<string, any>[]> {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  // Independent reads: run them together instead of one round trip after another.
  const [plans, strategies, cachedAccount] = await Promise.all([
    query<{ paper_trade_id: string; metadata: Record<string, any> }>(
      "SELECT paper_trade_id,metadata FROM pending_manual_entries WHERE user_id=$1 AND paper_trade_id=ANY($2::uuid[])",
      [userId, ids],
    ),
    query<{ id: string; risk: number | null; decision_time: Date }>("SELECT t.id,t.nominal_risk_amount::float AS risk,t.decision_time FROM paper_strategy_trades t WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM practice_order_intents i WHERE i.paper_trade_id=t.id AND i.status='rejected')", [userId, ids]),
    // Only rows with a risk plan need it; an OANDA failure must not fail the rest.
    riskAccount().catch(() => null),
  ]);
  const evidence = new Map(plans.rows.map(row => [row.paper_trade_id, row.metadata]));
  const strategyEvidence = new Map(strategies.rows.map(row => [row.id, strategyRiskEstimate(row.id, row.risk, row.decision_time)]));
  const account = plans.rows.some(row => row.metadata?.initialRiskPlan) ? cachedAccount : null;
  const prepared = rows.map(row => {
    const metadata = evidence.get(String(row.id));
    const plan = metadata?.initialRiskPlan as InitialRiskPlan | undefined;
    const openedAt = new Date(row.openedAt).toISOString();
    const documentedRisk = verifiedInitialRisk(plan, openedAt, plan?.positionKey ?? String(row.id));
    const cashTradeId = row.status === "closed" && documentedRisk !== null && account?.status.state === "connected" && account.data.currency === "USD" && plan?.brokerAccountId === account.data.id && typeof metadata?.brokerTradeId === "string"
      ? metadata.brokerTradeId as string : null;
    return { row, metadata, plan, openedAt, cashTradeId };
  });
  const cashByTrade = account?.status.state === "connected"
    ? await readClosedCashAll(account.data.id, prepared.flatMap(item => item.cashTradeId ? [item.cashTradeId] : []))
    : new Map<string, Cash>();
  const output: Record<string, any>[] = [];
  for (const { row, metadata, plan, openedAt, cashTradeId } of prepared) {
    const cash = cashTradeId ? cashByTrade.get(cashTradeId) ?? null : null;
    const corrected = verifiedTradeR({ ...row, id: String(row.id), openedAt, resultR: row.resultR ?? null,
      maxAdverseExcursionUsd: metadata?.observedExcursions?.maeUsd ?? null,
      maxFavorableExcursionUsd: metadata?.observedExcursions?.mfeUsd ?? null,
      maePips: metadata?.observedExcursions?.maePips ?? null, mfePips: metadata?.observedExcursions?.mfePips ?? null,
      excursionDataQuality: metadata?.observedExcursions ? "estimated" : "missing",
      initialRiskPlan: plan ?? null, riskPositionKey: plan?.positionKey ?? String(row.id),
      realizedNetPnlUsd: cash?.realizedNetPnlUsd ?? null,
    });
    const estimate = metadata?.historicalRiskEstimate as HistoricalRiskEstimate | undefined ?? strategyEvidence.get(String(row.id));
    const estimated = estimatedRiskMetrics(estimate, String(row.id), row.status === "closed" && row.brokerExecutionStatus !== "rejected" ? row.paperPl : null);
    // A verified denominator with missing costs must not silently fall back to
    // a historical estimate. Keep original and reconstructed evidence separate.
    output.push({ ...corrected, ...estimated, riskDataQuality: corrected.initialPlannedRiskUsd === null && estimated.estimatedRMultiple !== null ? "estimated" : corrected.riskDataQuality });
  }
  // Early manual fills were logged twice: the app's own row (price-distance R,
  // no cash) and an OANDA-import row (cash, no R). Show the import row its
  // twin's stored R. Display only; nothing is rewritten.
  const bare = output.filter(row => row.status === "closed" && row.resultR == null && row.estimatedRMultiple == null && row.legacyR == null);
  if (bare.length) {
    const twins = await query<{ id: string; r: number }>(
      `SELECT DISTINCT ON (p.id) p.id, t.result_r::float AS r FROM paper_trades p
       JOIN paper_trades t ON t.user_id=p.user_id AND t.id<>p.id AND t.pair=p.pair AND t.direction=p.direction AND t.entry=p.entry
         AND abs(extract(epoch FROM t.opened_at - p.opened_at)) < 5 AND t.result_r IS NOT NULL
       WHERE p.user_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.id, abs(extract(epoch FROM t.opened_at - p.opened_at))`,
      [userId, bare.map(row => String(row.id))],
    );
    const twinR = new Map(twins.rows.map(row => [row.id, row.r]));
    for (const row of bare) if (twinR.has(String(row.id))) row.legacyR = twinR.get(String(row.id));
  }
  return output;
}

export async function attachRiskNetCash(userId: string, snapshot: { data: { id: string; currency: string }; positions: OpenPosition[] }) {
  if (snapshot.data.currency !== "USD" || !snapshot.positions.length) return;
  const entries = await query<{ metadata: Record<string, any> }>("SELECT metadata FROM pending_manual_entries WHERE user_id=$1 AND metadata->>'riskReportingVersion'='1' AND metadata->>'brokerTradeId'=ANY($2::text[])", [userId, snapshot.positions.map(p => p.id)]);
  for (const row of entries.rows) {
    const plan = row.metadata.initialRiskPlan as InitialRiskPlan | undefined;
    const position = snapshot.positions.find(p => p.id === row.metadata.brokerTradeId);
    if (!position || !plan || plan.brokerAccountId !== snapshot.data.id || verifiedInitialRisk(plan, position.openedAt, plan.positionKey) === null) continue;
    const cash = await readRiskNetCash(position.id).catch(() => null);
    // Never mix a newly changed position with an earlier financial frame: the
    // units must match. Floating P/L is not compared: it moves with every tick
    // (and the conversion rate) between the snapshot and the ledger read, so a
    // cent-level match almost never held. The snapshot keeps its own floating
    // P/L; the ledger contributes only financing and costs, which do not tick.
    if (cash?.state === "OPEN" && cash.remainingUnits === position.units) {
      position.unrealizedNetPnlUsd = position.unrealizedPL + (cash.unrealizedNetPnlUsd - cash.brokerUnrealizedPL);
    }
  }
}

/** Future entries only. Sample actual broker cash/exposure at each observation;
 * no reconstruction with final units, and no edits to historical trades. The
 * extrema are observation estimates, not claims about the unobserved path. */
export async function observeRiskExcursions(userId: string, positions: OpenPosition[], checkedAt: string, currency: string, accountId: string) {
  if (currency !== "USD") return;
  for (const p of positions) {
    const move = (p.direction === "long" ? (p.currentBid ?? p.currentPrice) - p.entryPrice : p.entryPrice - (p.currentAsk ?? p.currentPrice)) / pipSizeFor(p.instrument);
    if (![move, p.units, p.unrealizedPL].every(Number.isFinite)) continue;
    await query(`UPDATE pending_manual_entries SET metadata=jsonb_set(metadata,'{observedExcursions}',
      jsonb_build_object('quality','estimated','basis','sampled broker floating P/L; financing/cost completeness not asserted',
        'maeUsd',GREATEST(COALESCE((metadata#>>'{observedExcursions,maeUsd}')::numeric,0),$3::numeric),
        'mfeUsd',GREATEST(COALESCE((metadata#>>'{observedExcursions,mfeUsd}')::numeric,0),$4::numeric),
        'maePips',GREATEST(COALESCE((metadata#>>'{observedExcursions,maePips}')::numeric,0),$5::numeric),
        'mfePips',GREATEST(COALESCE((metadata#>>'{observedExcursions,mfePips}')::numeric,0),$6::numeric),
        'firstObservedAt',COALESCE(metadata#>>'{observedExcursions,firstObservedAt}',$7::text),
        'lastObservedAt',$7::text,'unitsAtLastObservation',$8::numeric))
      WHERE user_id=$1 AND metadata->>'brokerTradeId'=$2 AND metadata->>'riskReportingVersion'='1' AND metadata->>'reportingBrokerAccountId'=$9`,
    [userId, p.id, Math.max(0, -p.unrealizedPL), Math.max(0, p.unrealizedPL), Math.max(0, -move), Math.max(0, move), checkedAt, p.units, accountId]);
  }
}
