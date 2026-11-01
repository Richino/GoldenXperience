import type { ContinuationRisk, DirectionalLean, Forecast, LevelRisk } from "./types";

/** Informational trend lean, not a relaxed strict forecast or an entry signal. */
export const LEAN_RULES = Object.freeze({ neutralBand: .15 });
export const EVIDENCE_RULES = Object.freeze({ strongTrend:.6, moderateTrend:.3, momentumConfirmation:.12, opposingMomentum:.12, minAdx:18, opposingFrameTrend:.3, materialTimeframeWeight:.35 });

export function buildOutlook(input: { trend: number; momentum:number; strength:number; available: boolean;
  exhausted: boolean; levelRisk: LevelRisk; reversalRisk: boolean; materialOppositionWeight:number }): { lean: DirectionalLean; continuationRisk: ContinuationRisk } {
  const { trend, momentum, strength, available, exhausted, levelRisk, reversalRisk, materialOppositionWeight } = input;
  if (!available) return { lean: { direction:"UNAVAILABLE", evidence:"UNAVAILABLE", score:trend, rationale:"Required completed candles are missing or unreliable." },
    continuationRisk:{severity:"UNAVAILABLE",factors:["Restore reliable candle data before assessing continuation."]} };
  const direction = Math.abs(trend) < LEAN_RULES.neutralBand ? "UNCLEAR" : trend > 0 ? "BULLISH" : "BEARISH";
  const support = direction === "UNCLEAR" ? 0 : (trend > 0 ? 1 : -1) * momentum;
  const momentumOpposes = direction !== "UNCLEAR" && support <= -EVIDENCE_RULES.opposingMomentum;
  const timeframesOppose = direction !== "UNCLEAR" && materialOppositionWeight >= EVIDENCE_RULES.materialTimeframeWeight;
  // Grade independent directional groups. Location, exhaustion and reversal
  // cautions are recorded below, not converted into automatic evidence vetoes.
  const evidence = direction === "UNCLEAR" ? "WEAK" : momentumOpposes || timeframesOppose ? "MIXED"
    : Math.abs(trend) >= EVIDENCE_RULES.strongTrend && support >= EVIDENCE_RULES.momentumConfirmation && strength >= EVIDENCE_RULES.minAdx ? "STRONG"
    : Math.abs(trend) >= EVIDENCE_RULES.moderateTrend && (support > 0 || strength >= EVIDENCE_RULES.minAdx) ? "MODERATE" : "WEAK";
  const evidenceReasons = [`Horizon-weighted trend/structure ${trend.toFixed(2)}; momentum agreement ${support.toFixed(2)}; ADX ${strength.toFixed(1)}.`,
    `Clearly opposing timeframes carry ${(materialOppositionWeight*100).toFixed(0)}% of horizon weight.`];
  if (momentumOpposes) evidenceReasons.push("Momentum materially opposes the directional lean.");
  if (timeframesOppose) evidenceReasons.push("A substantial share of timeframe trend/structure evidence points the other way.");
  if (evidence === "STRONG") evidenceReasons.push("Trend/structure, momentum and strength meet the strong-agreement thresholds.");
  if (evidence === "MODERATE") evidenceReasons.push("Direction is supported, but full strong-agreement thresholds are not met.");
  if (evidence === "WEAK") evidenceReasons.push("Directional alignment is limited or unresolved.");
  const factors: string[] = [];
  if (levelRisk.zone) factors.push(levelRisk.explanation);
  if (exhausted) factors.push("Price or momentum is extended; pullback risk is elevated.");
  if (direction !== "UNCLEAR" && support < EVIDENCE_RULES.momentumConfirmation) factors.push("Momentum does not sufficiently support the trend lean.");
  if (reversalRisk) factors.push("Confirmed divergence or a failed breakout adds reversal risk.");
  if (evidence === "WEAK") factors.push("Weak or unresolved trend evidence limits continuation reliability.");
  if (direction !== "UNCLEAR" && strength < EVIDENCE_RULES.minAdx) factors.push("Trend strength is weak; continuation may lack persistence.");
  if (timeframesOppose) factors.push("Material timeframe trend/structure disagreement increases continuation uncertainty.");
  const severity = exhausted || levelRisk.severity === "HIGH" ? "HIGH" : factors.length ? "CAUTION" : "LOW";
  return { lean: { direction, evidence, score:trend, evidenceReasons,
    rationale: direction === "UNCLEAR" ? "Trend and structure are too balanced to establish a directional lean."
      : `${direction === "BULLISH" ? "Bullish" : "Bearish"} lean. ${evidence === "STRONG" ? "Strong directional evidence: trend/structure, momentum and strength agree." : evidence === "MODERATE" ? "Moderate directional evidence: direction is supported, with incomplete confirmation." : evidence === "MIXED" ? "Mixed directional evidence: material momentum or timeframe opposition remains." : "Weak directional evidence: alignment is limited."}` },
    continuationRisk:{severity,factors:factors.length ? factors : ["No elevated continuation-risk factors detected by these rules; uncertainty remains."]} };
}

/** Older saved forecasts retain their original display and assessment. */
export const outlookDirection = (f: Forecast) => f.lean?.direction ?? f.bias;
export const outlookEvidence = (f: Forecast) => f.lean?.evidence ?? f.evidence;
export const continuationRiskLabel = (f: Forecast) => f.continuationRisk ? `${f.continuationRisk.severity} continuation risk` : "Legacy risk assessment";
