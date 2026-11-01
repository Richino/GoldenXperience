import type { InitialRiskPlan } from "../../frontend/src/lib/risk-metrics.js";

/** Save the exact sizing-policy dollar budget before the broker request. An
 * explicit override or an already captured plan is never overwritten. */
export async function withRecordedSizingBudget<T>(input: {
  existingPlan: InitialRiskPlan | null; positionKey: string; recordedAt: string;
  accountId: string; balanceUsd: number; riskPercent: number; riskAmountUsd: number;
  plannedNetRewardUsd: number | null;
}, persist: (plan: InitialRiskPlan) => Promise<void>, submit: () => Promise<T>): Promise<T> {
  if (!input.existingPlan) {
    if (![input.balanceUsd, input.riskPercent, input.riskAmountUsd].every(n => Number.isFinite(n) && n > 0) ||
      !input.accountId || !Number.isFinite(Date.parse(input.recordedAt))) throw new Error("A verified sizing budget is required before submission.");
    const plan: InitialRiskPlan = Object.freeze({ version: 1, currency: "USD", source: "sizing_policy",
      positionKey: input.positionKey, recordedAt: input.recordedAt, initialPlannedRiskUsd: input.riskAmountUsd,
      entryEquityUsd: null, plannedNetRewardUsd: input.plannedNetRewardUsd, brokerAccountId: input.accountId,
      sizingBalanceUsd: input.balanceUsd, sizingRiskPercent: input.riskPercent });
    await persist(plan);
  }
  return submit();
}
