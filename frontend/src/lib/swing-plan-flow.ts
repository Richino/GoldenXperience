import type { SwingScenario, SwingView } from "./swing-intelligence";

/** Prices at review are indicative; the saved zone and conditions define the watch. */
export function swingPlanTerms(scenario: SwingScenario) {
  return JSON.stringify([scenario.id, scenario.zoneId, scenario.side, scenario.style, scenario.stop, scenario.firstTarget, scenario.secondTarget]);
}

export function canSaveSwingPlan(view: SwingView, scenario: SwingScenario) {
  const zone = view.zones.find(zone => zone.id === scenario.zoneId);
  const sign = scenario.side === "BUY" ? 1 : -1;
  return Boolean(view.runtime.available && view.monitor?.active && view.assessmentFresh && zone && zone.status !== "EXPIRED" && Date.parse(zone.expiresAt) > Date.now()
    && scenario.eligibility !== "INVALIDATED" && [scenario.entry, scenario.stop, scenario.firstTarget].every(value => value !== null && Number.isFinite(value) && value > 0)
    && sign * (scenario.entry! - scenario.stop!) > 0 && sign * (scenario.firstTarget! - scenario.entry!) > 0);
}

export function swingPlanStatus(view: SwingView) {
  if (view.monitor && !view.monitor.active) return "Stopped";
  const accepted = view.acceptedPlan;
  if (accepted) {
    const current = view.scenarios.find(scenario => scenario.id === accepted.scenario.id);
    const zone = view.zones.find(zone => zone.id === accepted.zone.id);
    if (!view.monitor?.active) return "Stopped";
    if (!view.assessmentFresh || view.assessment?.id !== accepted.assessmentId || !zone || zone.status === "EXPIRED"
      || !current || swingPlanTerms(current) !== swingPlanTerms(accepted.scenario)
      || zone.lower !== accepted.zone.lower || zone.upper !== accepted.zone.upper) return "Needs review";
    if (!view.runtime.available) return "Watch unavailable";
    return current.eligibility === "ELIGIBLE" ? "Entry conditions met" : current.eligibility === "BLOCKED" ? "Watching · entry blocked" : "Watching entry conditions";
  }
  if (view.job && ["QUEUED", "RUNNING"].includes(view.job.status)) return "Analyzing";
  if (view.job && ["FAILED", "BUDGET_BLOCKED"].includes(view.job.status)) return "Analysis interrupted";
  if (view.assessment) return view.assessmentFresh ? "Ready to review" : "Result needs refresh";
  return view.monitor?.active ? "Analyzing" : "Not started";
}
