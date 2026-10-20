import type { MarketStateSnapshot } from "./market-state";

/** Research coverage is independent of whether required technical inputs passed. */
export function technicalAnalysisStatus(snapshot: MarketStateSnapshot) {
  if (snapshot.analysisStatus) return snapshot.analysisStatus;
  // Older persisted snapshots predate analysisStatus. Never infer a failure from optional gaps.
  if (!snapshot.quality.issues.length && ["VALID", "PARTIAL"].includes(snapshot.quality.status)) return "ANALYSIS_COMPLETE";
  return snapshot.observed.classification === "INSUFFICIENT_DATA" ? "TECHNICAL_DATA_UNAVAILABLE" : "ANALYSIS_PARTIAL";
}

export type AnalysisDiagnostic = {
  code: string;
  category: "DATA_INTEGRITY" | "STRATEGY" | "EXECUTION";
  input: string;
  status: "PASS" | "CAUTION" | "FAIL" | "UNKNOWN";
  reason: string;
  at?: string | null;
};
export type PlanDiagnostics = {
  snapshotId: string | null;
  checkedAt: string;
  checks: AnalysisDiagnostic[];
  sides: Array<{ direction: "BUY" | "SELL"; status: "CONDITIONAL_PLAN" | "NO_VALID_SETUP" | "SKIPPED"; reasons: Array<{ code: string; reason: string }> }>;
};

/** The pre-repair worker labelled input failures NO_VALID_SETUP. Preserve its reason, correct its meaning. */
export function storedPlanResult(result: string, reason: string | null) {
  return result === "NO_VALID_SETUP" && /^(Market data is not usable:|Not enough (?:H4|verified D1|closed H1))/i.test(reason ?? "")
    ? "TECHNICAL_DATA_UNAVAILABLE" : result;
}

export function sameAnalysisSnapshot(expected: string, interpreted: unknown, generated: unknown) {
  return interpreted === expected && generated === expected;
}
