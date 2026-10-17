import { query } from "../database.js";
import { displayPair } from "../notifications.js";
import { notifyOnce } from "../trade-plan-notify.js";
import { researchContextForPlan, type PlanResearchContext } from "./plan-research.js";
import type { MarketIntelligence } from "./research-contract.js";

/**
 * How new research changes the evidence behind an approved plan.
 *
 * Each new research snapshot is compared, per active plan, with the evidence
 * the plan last had (its previous update, or the research frozen into it when
 * it was made). The result is stored as history and the user is told when it
 * strengthens, weakens or conflicts. It is information only: research never
 * changes a plan's levels, rules, expiry or approval, never counts as
 * technical confirmation, and never places or cancels anything.
 */

export type ThesisAssessment = "STRENGTHENING" | "WEAKENING" | "UNCHANGED" | "CONFLICTED" | "OUTDATED";
type Evidence = { weights: { supporting: number; opposing: number }; supportingIds: string[]; opposingIds: string[] };
type FactorBrief = { id: string; factor: string; sourceIds: string[] };

/** A shift of this many importance points in the net evidence counts as a change (one high-importance factor). */
export const THESIS_SHIFT = 3;

/** Compare the plan's previous evidence with the new research's. Pure. */
export function assessThesis(previous: Evidence | null, next: Evidence & { fresh: boolean; supporting: FactorBrief[]; opposing: FactorBrief[] }) {
  const netNext = next.weights.supporting - next.weights.opposing;
  const netPrevious = previous ? previous.weights.supporting - previous.weights.opposing : 0;
  const delta = netNext - netPrevious;
  const added = {
    supporting: next.supporting.filter((factor) => !previous?.supportingIds.includes(factor.id)),
    opposing: next.opposing.filter((factor) => !previous?.opposingIds.includes(factor.id)),
  };
  let assessment: ThesisAssessment;
  if (!next.fresh) assessment = "OUTDATED";
  else if (delta >= THESIS_SHIFT) assessment = "STRENGTHENING";
  else if (delta <= -THESIS_SHIFT) assessment = "WEAKENING";
  else if (next.weights.supporting >= THESIS_SHIFT && next.weights.opposing >= THESIS_SHIFT && Math.abs(netNext) < THESIS_SHIFT) assessment = "CONFLICTED";
  else assessment = "UNCHANGED";
  const lead = (factors: FactorBrief[]) => factors.slice(0, 2).map((factor) => factor.factor).join("; ");
  const summary =
    assessment === "STRENGTHENING" ? `More evidence now supports it${added.supporting.length ? `: ${lead(added.supporting)}` : ""}.`
    : assessment === "WEAKENING" ? `More evidence now weighs against it${added.opposing.length ? `: ${lead(added.opposing)}` : ""}.`
    : assessment === "CONFLICTED" ? "Strong evidence points both ways."
    : assessment === "OUTDATED" ? "The latest research is out of date."
    : "The evidence is broadly the same.";
  return { assessment, delta, summary, added };
}

type ActivePlan = {
  id: string; user_id: string; plan_version: number; monitoring_mode: string | null; instrument: string;
  direction: "BUY" | "SELL"; expires_at: Date; status: string; plan: Record<string, unknown>; stage: string | null;
};

const evidenceOf = (context: PlanResearchContext | null): Evidence | null =>
  context?.researchId ? { weights: context.weights, supportingIds: context.supporting.map((f) => f.id), opposingIds: context.opposing.map((f) => f.id) } : null;

/** Record and announce how a new research snapshot changed each active plan's evidence. Returns the number of plans updated. */
export async function updateThesesForResearch(instrument: string, intelligence: MarketIntelligence, now = Date.now()) {
  const plans = await query<ActivePlan>(
    `SELECT p.id,p.user_id,p.plan_version,p.monitoring_mode,p.instrument,p.direction,p.expires_at,p.status,p.plan,m.state->>'stage' AS stage
       FROM trade_plans p LEFT JOIN trade_plan_monitoring_state m ON m.plan_id=p.id
      WHERE p.instrument=$1 AND p.status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED')`,
    [instrument],
  );
  let updated = 0;
  for (const plan of plans.rows) {
    const previousRow = (await query<{ research_id: string; alignment: string; weights: Evidence["weights"]; changes: { supportingIds?: string[]; opposingIds?: string[] } }>(
      "SELECT research_id, alignment, weights, changes FROM trade_plan_thesis_updates WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 1",
      [plan.id],
    )).rows[0];
    const frozen = (plan.plan.intelligence ?? null) as PlanResearchContext | null;
    const previousResearchId = previousRow?.research_id ?? frozen?.researchId ?? null;
    if (previousResearchId === intelligence.research.id) continue;
    const previous: Evidence | null = previousRow
      ? { weights: previousRow.weights, supportingIds: previousRow.changes.supportingIds ?? [], opposingIds: previousRow.changes.opposingIds ?? [] }
      : evidenceOf(frozen);
    const context = researchContextForPlan({ instrument: plan.instrument, direction: plan.direction, expiresAt: new Date(plan.expires_at).toISOString() }, intelligence, { fresh: true, staleReason: null, technicalReadAt: null, now });
    const brief = (factors: PlanResearchContext["supporting"]) => factors.map((f) => ({ id: f.id, factor: f.factor, sourceIds: f.sourceIds }));
    const result = assessThesis(previous, {
      fresh: true, weights: context.weights,
      supportingIds: context.supporting.map((f) => f.id), opposingIds: context.opposing.map((f) => f.id),
      supporting: brief(context.supporting), opposing: brief(context.opposing),
    });
    const inserted = await query(
      `INSERT INTO trade_plan_thesis_updates(plan_id,user_id,plan_version,research_id,previous_research_id,assessment,previous_alignment,alignment,previous_weights,weights,changes)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb) ON CONFLICT (plan_id, research_id) DO NOTHING RETURNING id`,
      [plan.id, plan.user_id, plan.plan_version, intelligence.research.id, previousResearchId, result.assessment,
       previousRow?.alignment ?? frozen?.alignment ?? null, context.alignment, previous ? JSON.stringify(previous.weights) : null, JSON.stringify(context.weights),
       JSON.stringify({
         summary: result.summary, delta: result.delta,
         supportingIds: context.supporting.map((f) => f.id), opposingIds: context.opposing.map((f) => f.id),
         newSupporting: result.added.supporting, newOpposing: result.added.opposing,
       })],
    );
    if (!inserted.rows[0]) continue;
    updated += 1;
    if (result.assessment === "UNCHANGED" || result.assessment === "OUTDATED") continue;
    const technical = plan.status === "CONFIRMED" || plan.status === "NOTIFIED" ? "already confirmed" : plan.stage ? `still ${plan.stage.toLowerCase().replace(/_/g, " ")}` : "still waiting";
    const word = { STRENGTHENING: "strengthening", WEAKENING: "weakening", CONFLICTED: "conflicted" }[result.assessment];
    await notifyOnce(plan, {
      event: `THESIS_${result.assessment}_${intelligence.research.id.slice(0, 8)}`,
      notificationKind: "trade_update",
      title: `${displayPair(instrument)} ${plan.direction} thesis ${word}`,
      message: `${result.summary} Technical confirmation: ${technical}. Your plan's levels, rules and approval are unchanged; research never triggers or cancels a trade.`,
    });
  }
  return updated;
}
