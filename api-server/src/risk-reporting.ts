import { query } from "./database.js";
import { estimatedRiskMetrics, verifiedInitialRisk, verifiedTradeR, type InitialRiskPlan, type HistoricalRiskEstimate } from "../../frontend/src/lib/risk-metrics.js";
import { strategyRiskEstimate } from "./historical-risk-estimates.js";
import type { OpenPosition } from "../../frontend/src/types/forex.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { getAccountSummary } from "../../frontend/src/lib/oanda/client.js";
import { readRiskNetCash } from "./risk-net-cash.js";
type Cash = Awaited<ReturnType<typeof readRiskNetCash>>;
const closedCash = new Map<string, { until: number; value: Cash }>();
async function readClosedCash(accountId: string, tradeId: string) {
  const key = `${accountId}:${tradeId}`, cached = closedCash.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = await readRiskNetCash(tradeId).catch(() => null);
  if (value?.state === "CLOSED") {
    if (closedCash.size >= 512) closedCash.delete(closedCash.keys().next().value!);
    closedCash.set(key, { until: Date.now() + 300_000, value });
  }
  return value?.state === "CLOSED" ? value : null;
}

/** Read-time compatibility only; never rewrite a legacy financial record. */
export async function projectRiskReporting(userId: string, rows: Record<string, any>[]): Promise<Record<string, any>[]> {
  if (!rows.length) return [];
  const plans = await query<{ paper_trade_id: string; metadata: Record<string, any> }>(
    "SELECT paper_trade_id,metadata FROM pending_manual_entries WHERE user_id=$1 AND paper_trade_id=ANY($2::uuid[])",
    [userId, rows.map(row => row.id)],
  );
  const evidence = new Map(plans.rows.map(row => [row.paper_trade_id, row.metadata]));
  const strategies = await query<{ id: string; risk: number | null; decision_time: Date }>("SELECT t.id,t.nominal_risk_amount::float AS risk,t.decision_time FROM paper_strategy_trades t WHERE t.user_id=$1 AND t.id=ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM practice_order_intents i WHERE i.paper_trade_id=t.id AND i.status='rejected')", [userId, rows.map(row => row.id)]);
  const strategyEvidence = new Map(strategies.rows.map(row => [row.id, strategyRiskEstimate(row.id, row.risk, row.decision_time)]));
  const account = plans.rows.some(row => row.metadata?.initialRiskPlan) ? await getAccountSummary() : null;
  const output: Record<string, any>[] = [];
  for (const row of rows) {
    const metadata = evidence.get(String(row.id));
    const plan = metadata?.initialRiskPlan as InitialRiskPlan | undefined;
    const openedAt = new Date(row.openedAt).toISOString();
    const documentedRisk = verifiedInitialRisk(plan, openedAt, plan?.positionKey ?? String(row.id));
    const cash = row.status === "closed" && documentedRisk !== null && account?.status.state === "connected" && account.data.currency === "USD" && plan?.brokerAccountId === account.data.id && typeof metadata?.brokerTradeId === "string"
      ? await readClosedCash(account.data.id, metadata.brokerTradeId) : null;
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
    // Never mix a newly changed position with an earlier financial frame.
    if (cash?.state === "OPEN" && cash.remainingUnits === position.units && Math.abs(cash.brokerUnrealizedPL - position.unrealizedPL) < .005) position.unrealizedNetPnlUsd = cash.unrealizedNetPnlUsd;
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
