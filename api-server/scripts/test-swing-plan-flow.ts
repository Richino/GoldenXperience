import assert from "node:assert/strict";
import type { SwingScenario, SwingView, SwingZone } from "../../frontend/src/lib/swing-intelligence.js";
import { canSaveSwingPlan, swingPlanStatus, swingPlanTerms } from "../../frontend/src/lib/swing-plan-flow.js";
import { SwingIntelligenceService } from "../src/swing/service.js";

const scenario = { id: "scenario", zoneId: "zone", instrument: "EUR_USD", side: "BUY", style: "BALANCED", entry: 1.12,
  stop: 1.10, firstTarget: 1.16, secondTarget: null, eligibility: "WATCHING", asOf: new Date().toISOString() } as SwingScenario;
const zone = { id: "zone", lower: 1.115, upper: 1.125, status: "WATCHING", expiresAt: new Date(Date.now() + 3600000).toISOString() } as SwingZone;
const view = { enabled: true, runtime: { available: true, reason: null }, monitor: { active: true, style: "BALANCED" },
  assessment: { id: "assessment" }, assessmentFresh: true, zones: [zone], scenarios: [scenario], job: null } as SwingView;
const accepted = { assessmentId: "assessment", acceptedAt: new Date().toISOString(), scenario: structuredClone(scenario), zone: structuredClone(zone) };
assert.equal(swingPlanStatus({ ...view, assessment: null, job: { status: "RUNNING" } as SwingView["job"] }), "Analyzing");
assert.equal(swingPlanStatus(view), "Ready to review");
assert.equal(canSaveSwingPlan(view, scenario), true);
assert.equal(canSaveSwingPlan({ ...view, assessmentFresh: false }, scenario), false);
assert.equal(canSaveSwingPlan(view, { ...scenario, stop: 1.13 }), false);
assert.equal(canSaveSwingPlan(view, { ...scenario, firstTarget: null }), false);
assert.equal(canSaveSwingPlan({ ...view, zones: [{ ...zone, expiresAt: new Date(0).toISOString() }] }, scenario), false);
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted }), "Watching entry conditions");
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, scenarios: [{ ...scenario, eligibility: "ELIGIBLE" }] }), "Entry conditions met");
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, scenarios: [{ ...scenario, eligibility: "BLOCKED" }] }), "Watching · entry blocked");
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, scenarios: [{ ...scenario, stop: 1.09 }] }), "Needs review");
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, assessmentFresh: false }), "Needs review");
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, monitor: { active: false, style: "BALANCED" } }), "Stopped");
// A moving executable quote does not silently change the saved zone or targets.
assert.equal(swingPlanTerms({ ...scenario, entry: 1.121 }), swingPlanTerms(scenario));
assert.equal(swingPlanStatus({ ...view, acceptedPlan: accepted, scenarios: [{ ...scenario, entry: 1.121 }] }), "Watching entry conditions");

const service = new SwingIntelligenceService();
let saves = 0;
service.view = async () => view;
service.repo.acceptPlan = async (scope, assessmentId, savedScenario, savedZone) => {
  assert.equal(scope.userId, "user-a"); assert.equal(scope.instrument, "EUR_USD");
  assert.equal(assessmentId, "assessment"); assert.equal(savedScenario.id, "scenario"); assert.equal(savedZone.id, "zone");
  saves++; return accepted;
};
await service.accept("user-a", "EUR_USD", "assessment", "scenario", swingPlanTerms(scenario), zone.lower, zone.upper);
assert.equal(saves, 1);
await assert.rejects(service.accept("user-a", "EUR_USD", "other-assessment", "scenario", swingPlanTerms(scenario), zone.lower, zone.upper));
await assert.rejects(service.accept("user-a", "EUR_USD", "assessment", "foreign-scenario", swingPlanTerms(scenario), zone.lower, zone.upper));
await assert.rejects(service.accept("user-a", "EUR_USD", "assessment", "scenario", "changed terms", zone.lower, zone.upper));
await assert.rejects(service.accept("user-a", "EUR_USD", "assessment", "scenario", swingPlanTerms(scenario), 1.0, zone.upper));
assert.equal(saves, 1);
service.view = async () => ({ ...view, assessmentFresh: false });
await assert.rejects(service.accept("user-a", "EUR_USD", "assessment", "scenario", swingPlanTerms(scenario), zone.lower, zone.upper));
assert.equal(saves, 1);
console.log("Swing plan flow checks passed: progress, acceptance, stale/changed plans, saved watch status, scoped saves.");

// Analyze starts a monitor only when needed, then joins the server's deduped job.
let starts = 0, requests = 0;
service.view = async () => ({ ...view, monitor: null });
service.monitor = async (_user, _instrument, active, style) => { assert.equal(active, true); starts++; return { active, style, analysisOnly: true }; };
service.request = async () => { requests++; return { cached: false, job: { id: "job", status: "QUEUED" } as NonNullable<SwingView["job"]> }; };
await service.analyze("user-a", "EUR_USD");
assert.equal(starts, 1); assert.equal(requests, 1);
service.view = async () => view;
await service.analyze("user-a", "EUR_USD");
assert.equal(starts, 1); assert.equal(requests, 2);
console.log("Analyze start/rejoin checks passed.");
