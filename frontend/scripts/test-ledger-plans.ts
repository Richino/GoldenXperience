import assert from "node:assert/strict";
import { planRows } from "../src/components/dashboard/ledger-plans";
import { fixturePlan } from "../src/lib/trade-plans/fixtures";
import type { ResearchJob } from "../src/lib/trade-plans/api";

const now = Date.parse("2026-10-17T03:00:00Z");
const job = (patch: Partial<ResearchJob> = {}): ResearchJob => ({
  id: "job-new", instrument: "EUR_USD", status: "COMPLETED", trigger: "MANUAL",
  horizon: "2-5 trading days", model: "test", effort: "high", researchId: "report-new", error: null,
  createdAt: new Date(now - 240_000).toISOString(), startedAt: new Date(now - 230_000).toISOString(),
  completedAt: new Date(now - 10_000).toISOString(),
  usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, webSearchCalls: 0, sources: 0, costUsd: null, validationDrops: 0 },
  plans: { result: "NO_VALID_SETUP", reason: "No setup meets the rules." }, ...patch,
});

assert.equal(planRows([job()], [], [], now)[0]?.kind, "completed", "a successful analysis without a trade remains visible");
assert.equal(planRows([job({ plans: { result: "ERROR", reason: "Plan generation failed" } })], [], [], now)[0]?.kind, "completed");
assert.equal(planRows([job({ status: "RESEARCHING", plans: null })], [], [], now)[0]?.kind, "generating");
assert.equal(planRows([job({ plans: null })], [], [], now)[0]?.kind, "generating", "completion waits for the plan outcome");
assert.equal(planRows([job()], [fixturePlan("BUY")], [], now)[0]?.kind, "review", "actual awaiting plans take priority");
assert.equal(planRows([job()], [], [fixturePlan("BUY", { status: "MONITORING" })], now)[0]?.kind, "watching");
assert.equal(planRows([job({ plans: { result: "PLANS", reason: null } })], [], [], now).length, 0, "removed/expired trade plans do not reappear as completed research");
assert.equal(planRows([job(), job({ id: "job-old" })], [], [], now).length, 1, "one completed card per pair");
assert.equal(planRows([job({ createdAt: new Date(now - 3 * 86_400_000).toISOString(), completedAt: new Date(now - 2 * 86_400_000).toISOString() })], [], [], now)[0]?.kind, "completed", "a saved completion does not expire like a failure notice");
assert.equal(planRows([], [], [], now).length, 0);
console.log("Home Plans: 10 lifecycle checks passed");
