import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { evidenceBalance, validateResearch } from "../src/intelligence/research-contract.js";
import type { FetchResult } from "../src/intelligence/openai-research.js";
import type { JobDeps } from "../src/intelligence/research-jobs.js";

/**
 * Background research jobs.
 *
 * Part 1 (always): the pure decisions — submission retries, polling,
 * timeouts, expiry, webhook signatures, completion copy, and the
 * evidence-checked directional lean.
 *
 * Part 2 (when DATABASE_URL is set): the real job SQL — create/join,
 * submit, restart recovery, completion, idempotent replays, invalid output,
 * notification ordering — inside ONE transaction that is always rolled back
 * (the migration is applied inside it too). OpenAI, plans and notifications
 * are mocked; nothing is written.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
process.env.OPENAI_API_KEY ||= "test-key";
const jobs = await import("../src/intelligence/research-jobs.js");
const { submitDecision, pollDecision, verifyWebhook, completionNotice, jobSettings } = jobs;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}
const settings = { ...jobSettings({} as NodeJS.ProcessEnv), pollMs: 10_000, timeoutMs: 30 * 60_000, maxSubmitAttempts: 2, maxPollFailures: 3 };
const NOW = Date.parse("2026-10-16T12:00:00Z");

// ── Part 1: pure decisions ────────────────────────────────────────
await test("submission: accepted → researching; 429/5xx retried once; then failed; 4xx never retried", () => {
  assert.deepEqual(submitDecision(1, { ok: true, responseId: "resp_1", status: "queued" }, settings), { kind: "researching", responseId: "resp_1" });
  assert.equal(submitDecision(1, { ok: false, error: "429", retryable: true }, settings).kind, "requeue");
  assert.equal(submitDecision(2, { ok: false, error: "429", retryable: true }, settings).kind, "fail", "bounded: no third expensive attempt");
  assert.equal(submitDecision(1, { ok: false, error: "400 bad request", retryable: false }, settings).kind, "fail");
});

await test("polling: pending waits, done validates, gone expires, overdue times out, errors back off then fail", () => {
  const job = { startedAt: NOW - 60_000, pollFailures: 0 };
  assert.deepEqual(pollDecision(job, { kind: "pending", status: "in_progress" }, NOW, settings), { kind: "wait", delayMs: 10_000 });
  assert.equal(pollDecision(job, { kind: "done", payload: {} }, NOW, settings).kind, "validate");
  assert.equal(pollDecision(job, { kind: "gone" }, NOW, settings).kind, "expire");
  assert.equal(pollDecision({ startedAt: NOW - 31 * 60_000, pollFailures: 0 }, { kind: "pending", status: "in_progress" }, NOW, settings).kind, "timeout");
  const retry = pollDecision(job, { kind: "error", error: "502" }, NOW, settings);
  assert.ok(retry.kind === "retry" && retry.delayMs === 20_000 && retry.pollFailures === 1);
  assert.equal(pollDecision({ ...job, pollFailures: 3 }, { kind: "error", error: "502" }, NOW, settings).kind, "fail");
  // A finished answer is still used even if it arrives after the time limit.
  assert.equal(pollDecision({ startedAt: NOW - 40 * 60_000, pollFailures: 0 }, { kind: "done", payload: {} }, NOW, settings).kind, "validate");
});

const SECRET = `whsec_${Buffer.from("gx-test-secret-key").toString("base64")}`;
function signed(body: string, id = "wh_1", at = Math.floor(NOW / 1000)) {
  const signature = createHmac("sha256", Buffer.from("gx-test-secret-key")).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${signature}` };
}
await test("webhook: valid signature accepted; tampered body, wrong secret and old timestamps refused", () => {
  const body = JSON.stringify({ type: "response.completed", data: { id: "resp_1" } });
  const ok = verifyWebhook(body, signed(body), SECRET, NOW);
  assert.ok(ok.ok && ok.event.responseId === "resp_1" && ok.event.type === "response.completed");
  assert.equal(verifyWebhook(body.replace("resp_1", "resp_2"), signed(body), SECRET, NOW).ok, false);
  assert.equal(verifyWebhook(body, signed(body), `whsec_${Buffer.from("other").toString("base64")}`, NOW).ok, false);
  assert.equal(verifyWebhook(body, signed(body, "wh_1", Math.floor(NOW / 1000) - 600), SECRET, NOW).ok, false);
  assert.equal(verifyWebhook(body, {}, SECRET, NOW).ok, false);
  // Several signatures (key rotation): any match is enough.
  const headers = signed(body);
  assert.equal(verifyWebhook(body, { ...headers, "webhook-signature": `v1,AAAA ${headers["webhook-signature"]}` }, SECRET, NOW).ok, true);
});

await test("completion copy: plans, no setup, watched plans, and failures say plans are unchanged", () => {
  assert.match(completionNotice("EUR_USD", "COMPLETED", null, "PLANS").message, /BUY\/SELL scenarios are ready/);
  assert.match(completionNotice("EUR_USD", "COMPLETED", null, "NO_VALID_SETUP").message, /No setup meets/);
  assert.match(completionNotice("EUR_USD", "COMPLETED", null, "WATCHING").message, /watched plans are unchanged/);
  const failed = completionNotice("EUR_USD", "FAILED", "Research rejected: Missing required field: summary.", null);
  assert.equal(failed.title, "EUR/USD research did not finish");
  assert.match(failed.message, /plans are unchanged/);
});

// The directional lean must be carried by cited evidence.
const SEARCH = [
  { url: "https://www.reuters.com/markets/a/", title: "a" },
  { url: "https://www.fxstreet.com/b", title: "b" },
  { url: "https://www.ecb.europa.eu/c", title: "c" },
];
function answer(assessment: Record<string, unknown>, factors?: unknown[]) {
  const t = { hypothesis: "h", supportingFactorIds: [], opposingFactorIds: [], catalysts: [], strengthensIf: [], weakensIf: [] };
  return {
    quality: "medium", missingData: [], outlook: { overall: "mixed", shortTerm: "mixed", swingTerm: "mixed", fundamental: "mixed", explanation: "" },
    factors: factors ?? [
      { id: "F1", factor: "USD softer", currency: "USD", effectOnCurrency: "weakens", importance: "high", evidenceType: "verified_data", description: "", observedAt: null, uncertainty: null, urls: [SEARCH[0]!.url] },
      { id: "F2", factor: "ECB hawkish", currency: "EUR", effectOnCurrency: "strengthens", importance: "medium", evidenceType: "attributed_analysis", description: "", observedAt: null, uncertainty: null, urls: [SEARCH[2]!.url] },
      { id: "F3", factor: "Fiscal risk", currency: "EUR", effectOnCurrency: "weakens", importance: "low", evidenceType: "attributed_analysis", description: "", observedAt: null, uncertainty: null, urls: [SEARCH[1]!.url] },
    ],
    eventImplications: [], sentiment: { professional: [], retail: [], positioning: [], expectations: "", limitations: "" },
    bullishThesis: t, bearishThesis: t,
    assessment: { nearTermLean: "unresolved", swingLean: "unresolved", drivers: ["USD yields"], strongestOpposing: "Fiscal risk", changeTriggers: ["Hot CPI"], rationale: "r", supportingFactorIds: [], ...assessment },
    sourceDates: [], summary: "s",
  };
}
const check = (raw: unknown) => validateResearch(raw, { pair: "EUR_USD", searchUrls: SEARCH, calendar: [], technicalTrend: { D1: "DOWNTREND", H4: "UNCLEAR" }, meta: { id: "r", createdAt: new Date(NOW).toISOString(), model: "m", effort: "high", durationMs: 1 } });

await test("directional lean: kept only when cited factors on that side outweigh the other; never forced", () => {
  const supported = check(answer({ nearTermLean: "bullish", swingLean: "bullish", supportingFactorIds: ["F1", "F2"] }));
  assert.ok(supported.ok);
  if (supported.ok) {
    assert.equal(supported.intelligence.schemaVersion, "2.1");
    assert.equal(supported.intelligence.assessment!.nearTermLean, "bullish");
    assert.deepEqual(supported.intelligence.assessment!.evidenceBalance, { bullish: 5, bearish: 1, strongerSide: "bullish" });
  }
  // A bearish lean with only bullish-side citations, or no citations, is not supported.
  const unsupported = check(answer({ nearTermLean: "bearish", swingLean: "bullish", supportingFactorIds: ["F1"] }));
  assert.ok(unsupported.ok && unsupported.intelligence.assessment!.nearTermLean === "unresolved" && unsupported.intelligence.assessment!.swingLean === "bullish");
  assert.ok(unsupported.ok && unsupported.drops.some((d) => d.where === "assessment.nearTermLean"));
  const uncited = check(answer({ nearTermLean: "bullish", supportingFactorIds: [] }));
  assert.ok(uncited.ok && uncited.intelligence.assessment!.nearTermLean === "unresolved");
  // Balanced evidence: a lean is refused even with a citation; unresolved and neutral pass through.
  const balanced = [
    { id: "F1", factor: "a", currency: "USD", effectOnCurrency: "weakens", importance: "high", evidenceType: "verified_data", description: "", observedAt: null, uncertainty: null, urls: [SEARCH[0]!.url] },
    { id: "F2", factor: "b", currency: "EUR", effectOnCurrency: "weakens", importance: "high", evidenceType: "verified_data", description: "", observedAt: null, uncertainty: null, urls: [SEARCH[1]!.url] },
  ];
  const tie = check(answer({ nearTermLean: "bullish", swingLean: "neutral", supportingFactorIds: ["F1"] }, balanced));
  assert.ok(tie.ok && tie.intelligence.assessment!.nearTermLean === "unresolved" && tie.intelligence.assessment!.swingLean === "neutral");
  assert.equal(evidenceBalance([]).strongerSide, "neither");
});

// ── Part 2: the job SQL, rolled back ──────────────────────────────
if (!process.env.DATABASE_URL) {
  console.log(`research jobs: ${passed} checks passed (database checks skipped: no DATABASE_URL)`);
  process.exit(0);
}
const { db } = await import("../src/database.js");
const client = await db().connect();
const tx = { query: (text: string, values?: unknown[]) => client.query(text, values ?? []) } as unknown as NonNullable<JobDeps["db"]>;
// The pool must not touch tables this transaction has locked: the cached-research and budget reads are stubbed.
const reads = {
  latest: async () => ({ research: null, configured: true, job: null, running: false }),
  usage: async () => ({ verdict: { allowed: true, reason: null } }) as never,
};
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query(fs.readFileSync(path.join(root, "migrations", "059_research_jobs.sql"), "utf8"));
  const user = (await client.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1")).rows[0];
  assert.ok(user, "needs one user row");
  const technical = { instrument: "GBP_USD", readAt: new Date().toISOString(), price: 1.3, trend: { D1: "DOWNTREND", H4: "UNCLEAR" }, atr: {}, zones: [], plans: [] };
  const calendar = { available: false, readAt: new Date().toISOString(), source: "test", currencies: ["GBP", "USD"], upcoming: [], released: [], note: "Calendar unavailable in the test." };
  const calls = { submit: 0, fetch: 0, cancel: 0, plans: 0, notify: [] as Array<Record<string, unknown>>, warn: 0 };
  let nextFetch: FetchResult = { kind: "pending", status: "in_progress" };
  const deps = (workerId = "test-worker-a") => ({
    db: tx, workerId, settings,
    inputs: async () => ({ technical, calendar }) as never,
    submit: async () => { calls.submit += 1; return { ok: true as const, responseId: `resp_test_${calls.submit}`, status: "queued" }; },
    fetchResponse: async () => { calls.fetch += 1; return nextFetch; },
    cancel: async () => { calls.cancel += 1; return true; },
    generatePlans: async () => { calls.plans += 1; return "PLANS"; },
    notify: async (event: Record<string, unknown>) => {
      // Notifications go out only after the report and the job's final state are stored.
      const stored = await client.query<{ status: string; job_status: string }>(
        "SELECT r.status, j.status AS job_status FROM research_jobs j LEFT JOIN market_research r ON r.id=j.research_id WHERE j.instrument=$1 ORDER BY j.created_at DESC LIMIT 1", [event.instrument]);
      assert.ok(stored.rows[0] && stored.rows[0].job_status !== "RESEARCHING" && stored.rows[0].job_status !== "VALIDATING", "job is final before notifying");
      calls.notify.push(event);
      return true;
    },
    warn: async () => { calls.warn += 1; return 0; },
  }) as never;
  const payload = (body: unknown) => ({
    status: "completed",
    output: [
      { type: "web_search_call", action: { sources: SEARCH.map(({ url }) => ({ type: "url", url })) } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(body), annotations: [] }] },
    ],
    usage: { input_tokens: 9000, output_tokens: 3000, output_tokens_details: { reasoning_tokens: 2000 } },
  });
  const valid = { ...answer({ nearTermLean: "unresolved" }), factors: answer({}).factors.map((f) => ({ ...(f as object), currency: (f as { currency: string }).currency === "EUR" ? "GBP" : "USD" })) };

  await test("Test 1/6 — Analyze returns a job at once; a second Analyze joins it instead of paying again", async () => {
    const first = await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads });
    assert.equal(first.state, "started");
    assert.ok(first.job?.id && first.job.status === "QUEUED");
    const second = await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads });
    assert.equal(second.state, "joined");
    assert.equal(second.job?.id, first.job?.id);
    const count = await client.query("SELECT count(*)::int AS n FROM research_jobs WHERE instrument='GBP_USD' AND status IN ('QUEUED','RESEARCHING','VALIDATING')");
    assert.equal(count.rows[0].n, 1);
    assert.equal(calls.submit, 0, "no OpenAI call happens inside the request");
  });

  const jobId = (await client.query<{ id: string }>("SELECT id FROM research_jobs WHERE instrument='GBP_USD' AND status='QUEUED'")).rows[0]!.id;
  const statusOf = async (id = jobId) => (await client.query<{ status: string; lease_owner: string | null; submit_attempts: number; openai_response_id: string | null }>("SELECT status, lease_owner, submit_attempts, openai_response_id FROM research_jobs WHERE id=$1", [id])).rows[0]!;

  await test("the worker submits once in background mode and stores the response id", async () => {
    assert.equal(await jobs.processResearchJob(jobId, deps()), "RESEARCHING");
    const row = await statusOf();
    assert.equal(row.openai_response_id, "resp_test_1");
    assert.equal(row.submit_attempts, 1);
    assert.equal(row.lease_owner, null, "lease released after the step");
    assert.equal(calls.submit, 1);
  });

  await test("Test 5 — restart: a live lease blocks a second worker; an expired lease is taken over", async () => {
    await client.query("UPDATE research_jobs SET lease_owner='dead-worker', lease_until=now() + interval '1 minute' WHERE id=$1", [jobId]);
    assert.equal(await jobs.processResearchJob(jobId, deps("test-worker-b")), null, "no double processing");
    await client.query("UPDATE research_jobs SET lease_until=now() - interval '1 second' WHERE id=$1", [jobId]);
    nextFetch = { kind: "pending", status: "in_progress" };
    assert.equal(await jobs.processResearchJob(jobId, deps("test-worker-b")), "RESEARCHING");
    assert.equal(calls.submit, 1, "recovery polls the existing run; it never resubmits");
  });

  await test("Tests 8/10/11 — completion: validated, stored, plans rebuilt, watcher notified once with a deep link", async () => {
    nextFetch = { kind: "done", payload: payload(valid) };
    assert.equal(await jobs.processResearchJob(jobId, deps()), "COMPLETED");
    const job = await client.query("SELECT status, research_id, input_tokens, reasoning_tokens, sources_count, completed_at FROM research_jobs WHERE id=$1", [jobId]);
    assert.equal(job.rows[0].status, "COMPLETED");
    assert.equal(job.rows[0].reasoning_tokens, 2000);
    const report = await client.query("SELECT status, job_id, report->>'schemaVersion' AS v, report->'assessment' AS a FROM market_research WHERE id=$1", [job.rows[0].research_id]);
    assert.equal(report.rows[0].status, "COMPLETE");
    assert.equal(report.rows[0].job_id, jobId);
    assert.equal(report.rows[0].v, "2.1");
    assert.ok(report.rows[0].a);
    assert.equal(calls.plans, 1);
    assert.equal(calls.warn, 1, "active plans are only evaluated for warnings");
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.notify[0]!.kind, "research_ready");
    assert.equal(calls.notify[0]!.url, "/chart?instrument=GBP_USD&analyze=1");
    assert.equal(calls.notify[0]!.dedupeKey, `research-job:${jobId}`);
  });

  await test("Test 7 — replayed completion (webhook replay, second worker) changes nothing and notifies nobody", async () => {
    assert.equal(await jobs.processResearchJob(jobId, deps()), null);
    assert.equal(await jobs.deliverCompletion(jobId, deps()), 0);
    await jobs.runResearchJobsTick(deps());
    assert.equal(calls.notify.length, 1);
    assert.equal(calls.plans, 1);
    const reports = await client.query("SELECT count(*)::int AS n FROM market_research WHERE job_id=$1", [jobId]);
    assert.equal(reports.rows[0].n, 1);
  });

  await test("Test 9 — invalid output (uncited claims, missing fields) fails the job; no report reaches plans", async () => {
    const started = await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads });
    const id = started.job!.id;
    await jobs.processResearchJob(id, deps());
    const { summary: _drop, ...broken } = valid;
    nextFetch = { kind: "done", payload: payload(broken) };
    assert.equal(await jobs.processResearchJob(id, deps()), "FAILED");
    const row = await client.query("SELECT j.status, j.error, r.status AS research_status, r.report FROM research_jobs j JOIN market_research r ON r.id=j.research_id WHERE j.id=$1", [id]);
    assert.equal(row.rows[0].status, "FAILED");
    assert.match(row.rows[0].error, /Research rejected/);
    assert.equal(row.rows[0].research_status, "FAILED");
    assert.equal(row.rows[0].report, null);
    assert.equal(calls.plans, 1, "no plans rebuilt from rejected research");
    assert.match(String(calls.notify.at(-1)!.title), /did not finish/);
  });

  await test("Test 13 — a failed notification does not lose the report; the tick retries delivery", async () => {
    const started = await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads });
    const id = started.job!.id;
    await jobs.processResearchJob(id, deps());
    nextFetch = { kind: "done", payload: payload(valid) };
    const failing = { ...(deps() as object), notify: async () => { throw new Error("push service down"); } } as never;
    await assert.rejects(jobs.processResearchJob(id, failing));
    assert.equal((await statusOf(id)).status, "COMPLETED", "the report is stored regardless");
    const before = calls.notify.length;
    await jobs.runResearchJobsTick(deps());
    assert.equal(calls.notify.length, before + 1, "delivered on the next tick");
  });

  await test("timeouts cancel at OpenAI; vanished runs expire; submit errors are retried within the limit", async () => {
    const a = (await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads })).job!.id;
    await jobs.processResearchJob(a, deps());
    await client.query("UPDATE research_jobs SET started_at=now() - interval '31 minutes' WHERE id=$1", [a]);
    nextFetch = { kind: "pending", status: "in_progress" };
    assert.equal(await jobs.processResearchJob(a, deps()), "FAILED");
    assert.equal(calls.cancel, 1);

    const b = (await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads })).job!.id;
    await jobs.processResearchJob(b, deps());
    nextFetch = { kind: "gone" };
    assert.equal(await jobs.processResearchJob(b, deps()), "EXPIRED");

    const c = (await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads })).job!.id;
    const flaky = { ...(deps() as object), submit: async () => ({ ok: false as const, error: "OpenAI returned 503.", retryable: true }) } as never;
    assert.equal(await jobs.processResearchJob(c, flaky), "QUEUED");
    assert.equal(await jobs.processResearchJob(c, flaky), "FAILED", "second failure ends it; no endless paid retries");
    assert.equal((await statusOf(c)).submit_attempts, 2);
  });

  await test("cancel: stops a running job for its watcher", async () => {
    const id = (await jobs.requestResearch(user.id, "GBP_USD", { force: true, db: tx, kick: false, ...reads })).job!.id;
    await jobs.processResearchJob(id, deps());
    const cancelled = await jobs.cancelResearchJob(user.id, id, tx);
    assert.equal(cancelled.cancelled, true);
    assert.equal((await statusOf(id)).status, "CANCELLED");
    assert.equal((await jobs.cancelResearchJob(user.id, id, tx)).cancelled, false);
  });
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db().end();
}
console.log(`research jobs: ${passed} checks passed (database checks rolled back)`);
