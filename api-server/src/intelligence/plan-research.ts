import type { Bias, CalendarEventRef, Factor, MarketIntelligence, ResearchThesis } from "./research-contract.js";

/**
 * How validated market intelligence meets one trade plan. Pure and
 * deterministic: no GPT involved at this step.
 *
 * It answers, for the plan's side: which cited factors support it, which
 * oppose it, what the research thesis for that side says, which verified
 * releases fall inside the plan's window, and whether research and the
 * technical read are about the same pair and moment. The result is evidence
 * and context; it never changes a plan's entry, stop, target or confirmation
 * rules, never confirms anything, and never picks a side.
 *
 * Alignment is a weighted count of cited factors (importance high 3,
 * medium 2, low 1; hypotheses count half): support at least twice the
 * opposition is "supports", the reverse is "opposes", anything between is
 * "mixed", and no directional factors is "no_evidence". It is a summary of
 * the research, not a probability that the trade works.
 */

export type Alignment = "supports" | "opposes" | "mixed" | "no_evidence" | "no_research";

export type PlanResearchContext = {
  researchId: string | null;
  researchedAt: string | null;
  schemaVersion: string | null;
  fresh: boolean;
  staleReason: string | null;
  /** Same pair and close enough in time to the technical read to compare. */
  compatible: boolean;
  compatibilityNote: string | null;
  alignment: Alignment;
  weights: { supporting: number; opposing: number };
  outlook: MarketIntelligence["outlook"] | null;
  supporting: Factor[];
  opposing: Factor[];
  thesis: ResearchThesis | null;
  /** Verified high-impact releases between now and the plan's expiry. */
  catalysts: CalendarEventRef[];
  note: string;
};

const WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const weightOf = (factor: Factor) => WEIGHT[factor.importance] * (factor.evidenceType === "hypothesis" ? 0.5 : 1);
const MAX_GAP_MS = 24 * 3_600_000;
const NOTE = "Research is context for this plan. It does not change the entry, stop, target or confirmation rules, and it never places or cancels a trade.";

export function alignmentOf(supporting: number, opposing: number): Alignment {
  if (supporting === 0 && opposing === 0) return "no_evidence";
  if (supporting >= 2 * opposing) return "supports";
  if (opposing >= 2 * supporting) return "opposes";
  return "mixed";
}

export function researchContextForPlan(
  plan: { instrument: string; direction: "BUY" | "SELL"; expiresAt: string },
  intelligence: MarketIntelligence | null,
  options: { fresh: boolean; staleReason: string | null; technicalReadAt: string | null; now: number },
): PlanResearchContext {
  if (!intelligence) {
    return {
      researchId: null, researchedAt: null, schemaVersion: null, fresh: false, staleReason: options.staleReason ?? "No research.",
      compatible: false, compatibilityNote: "No research for this pair.", alignment: "no_research", weights: { supporting: 0, opposing: 0 },
      outlook: null, supporting: [], opposing: [], thesis: null, catalysts: [], note: NOTE,
    };
  }
  const forSide: Bias = plan.direction === "BUY" ? "bullish" : "bearish";
  const against: Bias = plan.direction === "BUY" ? "bearish" : "bullish";
  const supporting = intelligence.factors.filter((factor) => factor.impactOnPair === forSide);
  const opposing = intelligence.factors.filter((factor) => factor.impactOnPair === against);
  const weights = {
    supporting: supporting.reduce((sum, factor) => sum + weightOf(factor), 0),
    opposing: opposing.reduce((sum, factor) => sum + weightOf(factor), 0),
  };

  let compatible = true;
  let compatibilityNote: string | null = null;
  if (intelligence.pair !== plan.instrument.toUpperCase()) {
    compatible = false;
    compatibilityNote = `Research is for ${intelligence.pair}, not ${plan.instrument}.`;
  } else if (options.technicalReadAt) {
    const gap = Math.abs(Date.parse(options.technicalReadAt) - Date.parse(intelligence.research.createdAt));
    if (gap > MAX_GAP_MS) {
      compatible = false;
      compatibilityNote = `Research and the technical read are ${Math.round(gap / 3_600_000)} h apart.`;
    }
  }
  const expires = Date.parse(plan.expiresAt);
  const catalysts = intelligence.events.filter((event) => event.status === "scheduled" && event.impact >= 3
    && Date.parse(event.at) >= options.now && Date.parse(event.at) <= expires);

  return {
    researchId: intelligence.research.id,
    researchedAt: intelligence.research.createdAt,
    schemaVersion: intelligence.schemaVersion,
    fresh: options.fresh,
    staleReason: options.fresh ? null : options.staleReason,
    compatible,
    compatibilityNote,
    alignment: compatible ? alignmentOf(weights.supporting, weights.opposing) : "no_research",
    weights,
    outlook: intelligence.outlook,
    supporting,
    opposing,
    thesis: plan.direction === "BUY" ? intelligence.bullishThesis : intelligence.bearishThesis,
    catalysts,
    note: NOTE,
  };
}
