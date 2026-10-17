import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import type { QueryResult, QueryResultRow } from "pg";
import { currenciesOf, isKnownInstrument } from "../../../frontend/src/lib/instruments/catalog.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import { getForexSessionStatus } from "../../../frontend/src/lib/strategy/session.js";
import { query } from "../database.js";
import { updateThesesForResearch } from "./thesis-updates.js";
import { displayPair, queueNotification } from "../notifications.js";
import { calendarRefs, buildCalendarSnapshot, type CalendarSnapshot } from "./calendar-snapshot.js";
import {
  cancelBackgroundResponse, fetchBackgroundResponse, interpretResearchResponse, researchConfig, submitBackgroundResearch,
  type FetchResult, type ResearchInput, type SubmitResult, type TechnicalSummary,
} from "./openai-research.js";
import {
  calendarEvents, latestResearch, latestCompleteRow, releasedOf, researchFreshness, researchUsage, technicalSummaryFor,
  JOB_COLUMNS, jobView, type JobRow, type Trigger,
} from "./research-service.js";

/**
 * Background market research. Analyze only creates (or joins) a job and
 * returns; the work happens here, on the server:
 *
 *   QUEUED      → the worker freezes the inputs (verified calendar, technical
 *                 read) and submits the run to OpenAI in background mode;
 *   RESEARCHING → OpenAI is working; the worker polls every few seconds, and a
 *                 signed completion webhook (when configured) wakes it early;
 *   VALIDATING  → the answer is checked against the contract, the search
 *                 results and the calendar, then stored as market_research;
 *   COMPLETED / FAILED / CANCELLED / EXPIRED.
 *
 * Every step is a compare-and-set on the job row under a worker lease, so a
 * restart, a second worker, a repeated webhook or a duplicate click never
 * runs or stores the same research twice. Each watcher gets plans built on
 * the result and one notification — only after the report is stored.
 */

type Db = { query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<T>> };
const pool: Db = { query: (text, values) => query(text, values ?? []) };

export const ACTIVE_STATUSES = ["QUEUED", "RESEARCHING", "VALIDATING"] as const;
const ACTIVE_SQL = "('QUEUED','RESEARCHING','VALIDATING')";
export const WORKER_ID = `${hostname()}:${process.pid}:research`;

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
export function jobSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    pollMs: num(env.RESEARCH_JOB_POLL_MS, 10_000),
    /** A run still unfinished after this is cancelled at OpenAI and failed. */
    timeoutMs: num(env.RESEARCH_JOB_TIMEOUT_MS, 30 * 60_000),
    /** Submissions that may be retried after a 429/5xx/network error. Never a retry once OpenAI accepted the run. */
    maxSubmitAttempts: num(env.RESEARCH_JOB_MAX_SUBMITS, 2),
    maxPollFailures: num(env.RESEARCH_JOB_MAX_POLL_FAILURES, 30),
    leaseSeconds: 120,
  };
}
export type JobSettings = ReturnType<typeof jobSettings>;

// ── Pure decisions (tested without a database or network) ──────────

export type SubmitDecision =
  | { kind: "researching"; responseId: string }
  | { kind: "requeue"; delayMs: number; error: string }
  | { kind: "fail"; error: string };

export function submitDecision(attempts: number, result: SubmitResult, settings: JobSettings): SubmitDecision {
  if (result.ok) return { kind: "researching", responseId: result.responseId };
  if (result.retryable && attempts < settings.maxSubmitAttempts) return { kind: "requeue", delayMs: 30_000 * attempts, error: result.error };
  return { kind: "fail", error: result.error };
}

export type PollDecision =
  | { kind: "wait"; delayMs: number }
  | { kind: "validate"; payload: Record<string, unknown> }
  | { kind: "timeout"; error: string }
  | { kind: "expire"; error: string }
  | { kind: "retry"; delayMs: number; pollFailures: number; error: string }
  | { kind: "fail"; error: string };

export function pollDecision(job: { startedAt: number | null; pollFailures: number }, result: FetchResult, now: number, settings: JobSettings): PollDecision {
  if (result.kind === "done") return { kind: "validate", payload: result.payload };
  if (result.kind === "gone") return { kind: "expire", error: "OpenAI no longer holds this research run, so it cannot be recovered." };
  const overdue = job.startedAt !== null && now - job.startedAt > settings.timeoutMs;
  if (overdue) return { kind: "timeout", error: `The research did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes.` };
  if (result.kind === "pending") return { kind: "wait", delayMs: settings.pollMs };
  const pollFailures = job.pollFailures + 1;
  if (pollFailures > settings.maxPollFailures) return { kind: "fail", error: result.error };
  return { kind: "retry", delayMs: Math.min(settings.pollMs * 2 ** Math.min(pollFailures, 5), 5 * 60_000), pollFailures, error: result.error };
}

/**
 * OpenAI webhooks follow the Standard Webhooks scheme: HMAC-SHA256 over
 * "id.timestamp.body" with the base64 secret after "whsec_", sent as
 * space-separated "v1,<base64>" signatures. Old timestamps are refused.
 */
export function verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string, now = Date.now(), toleranceSeconds = 300):
  { ok: true; event: { id: string; type: string; responseId: string | null } } | { ok: false; reason: string } {
  const header = (name: string) => { const value = headers[name]; return Array.isArray(value) ? value[0] : value; };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "Missing webhook signature headers." };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > toleranceSeconds) return { ok: false, reason: "Webhook timestamp is outside the allowed window." };
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  const matched = signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) return { ok: false, reason: "Webhook signature does not match." };
  let parsed: { type?: unknown; data?: { id?: unknown } };
  try { parsed = JSON.parse(rawBody); } catch { return { ok: false, reason: "Webhook body is not JSON." }; }
  return { ok: true, event: { id, type: String(parsed.type ?? ""), responseId: typeof parsed.data?.id === "string" ? parsed.data.id : null } };
}

/** What the watcher is told when a job ends. Pure. */
export function completionNotice(instrument: string, status: string, error: string | null, plans: string | null) {
  const pair = displayPair(instrument);
  if (status !== "COMPLETED") {
    return { title: `${pair} research did not finish`, message: `${error ?? "The research run stopped."} Your plans are unchanged.` };
  }
  const message =
    plans === "WATCHING" ? "Your market report is ready. Your watched plans are unchanged; check whether the research supports them."
    : plans === "PLANS" ? "Your market report and BUY/SELL scenarios are ready for review."
    : plans === "NO_VALID_SETUP" ? "Your market report is ready. No setup meets the trading rules right now; both scenarios are explained."
    : "Your market report is ready. Plans could not be rebuilt; run Analyze to see them.";
  return { title: `${pair} analysis complete`, message };
}

// ── Starting or joining a job ─────────────────────────────────────

export type ResearchRequestResult = Awaited<ReturnType<typeof latestResearch>> & {
  state: "cached" | "started" | "joined" | "budget" | "unconfigured";
  budget: string | null;
};

/**
 * Analyze → research. Fresh research is reused; a running job for the pair is
 * joined (the user is added as a watcher); otherwise one job is created within
 * the budget. Returns at once — nothing here waits for OpenAI.
 */
export async function requestResearch(userId: string | null, instrument: string, options: { force?: boolean; trigger?: Trigger; now?: number; db?: Db; kick?: boolean; latest?: typeof latestResearch; usage?: typeof researchUsage } = {}): Promise<ResearchRequestResult> {
  if (!isKnownInstrument(instrument)) throw new Error("Unknown currency pair.");
  const db = options.db ?? pool;
  const now = options.now ?? Date.now();
  const trigger = options.trigger ?? "MANUAL";
  const config = researchConfig();
  const latest = await (options.latest ?? latestResearch)(instrument, now);
  if (!config.apiKey) return { ...latest, state: "unconfigured", budget: null };

  const join = async (jobId: string) => {
    if (userId) await db.query("INSERT INTO research_job_watchers(job_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [jobId, userId]);
  };
  const active = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM research_jobs WHERE instrument=$1 AND status IN ${ACTIVE_SQL}`, [instrument]);
  if (active.rows[0]) {
    await join(active.rows[0].id);
    return { ...latest, job: jobView(active.rows[0]), running: true, state: "joined", budget: null };
  }
  if (latest.research?.fresh && !options.force) return { ...latest, state: "cached", budget: null };

  const usage = await (options.usage ?? researchUsage)(now);
  if (!usage.verdict.allowed) return { ...latest, state: "budget", budget: usage.verdict.reason };

  const { base, quote } = currenciesOf(instrument as MajorInstrument);
  const inserted = await db.query<JobRow>(
    `INSERT INTO research_jobs(instrument,currencies,trigger,model,effort,research_id)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (instrument) WHERE status IN ${ACTIVE_SQL} DO NOTHING
     RETURNING ${JOB_COLUMNS}`,
    [instrument, [base, quote], trigger, config.model, config.effort, randomUUID()],
  );
  // Lost a race with another request: join the job that won.
  const job = inserted.rows[0] ?? (await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM research_jobs WHERE instrument=$1 AND status IN ${ACTIVE_SQL}`, [instrument])).rows[0];
  if (!job) throw new Error("The research job could not be created.");
  await join(job.id);
  // Start straight away; if this process dies, the worker tick picks the job up from the database.
  if (inserted.rows[0] && options.kick !== false) setImmediate(() => void processResearchJob(job.id).catch((error) => console.error("[research-jobs] start failed", error)));
  return { ...latest, job: jobView(job), running: true, state: inserted.rows[0] ? "started" : "joined", budget: null };
}

/** Cancel a running job the user is watching (best effort at OpenAI). */
export async function cancelResearchJob(userId: string, jobId: string, db: Db = pool) {
  const watched = await db.query("SELECT 1 FROM research_job_watchers WHERE job_id=$1 AND user_id=$2", [jobId, userId]);
  if (!watched.rows[0]) return { cancelled: false, reason: "Research job not found." };
  const updated = await db.query<{ openai_response_id: string | null }>(
    `UPDATE research_jobs SET status='CANCELLED', completed_at=now(), updated_at=now(), error='Cancelled by the user.', lease_owner=NULL, lease_until=NULL
      WHERE id=$1 AND status IN ${ACTIVE_SQL} RETURNING openai_response_id`,
    [jobId],
  );
  if (!updated.rows[0]) return { cancelled: false, reason: "The research has already finished." };
  if (updated.rows[0].openai_response_id) await cancelBackgroundResponse(updated.rows[0].openai_response_id);
  // The canceller asked for it; nobody needs a "did not finish" alert.
  await db.query("UPDATE research_job_watchers SET notified_at=now() WHERE job_id=$1", [jobId]);
  return { cancelled: true, reason: null };
}

/** Remove a finished job from your Plans card (a running one is cancelled instead). */
export async function dismissResearchJob(userId: string, jobId: string, db: Db = pool) {
  const updated = await db.query(
    `UPDATE research_job_watchers w SET dismissed_at=now() FROM research_jobs j
      WHERE w.job_id=$1 AND w.user_id=$2 AND j.id=w.job_id AND j.status NOT IN ${ACTIVE_SQL}`,
    [jobId, userId],
  );
  return { dismissed: (updated.rowCount ?? 0) > 0 };
}

/** A job the user asked for, with the plans it built for them (or why none). */
export async function researchJobForUser(userId: string, jobId: string, db: Db = pool) {
  const found = await db.query<JobRow & { plans_result: string | null; plans_reason: string | null }>(
    `SELECT ${JOB_COLUMNS.split(",").map((column) => `j.${column.trim()}`).join(",")}, w.plans_result, w.plans_reason FROM research_jobs j
       JOIN research_job_watchers w ON w.job_id=j.id AND w.user_id=$2 WHERE j.id=$1`,
    [jobId, userId],
  );
  const row = found.rows[0];
  return row ? { ...jobView(row), plans: row.plans_result ? { result: row.plans_result, reason: row.plans_reason } : null } : null;
}

/** Your research jobs that are running, or ended in the last day (with the plans each built for you). */
export async function researchJobsForUser(userId: string, db: Db = pool) {
  const found = await db.query<JobRow & { plans_result: string | null; plans_reason: string | null }>(
    `SELECT ${JOB_COLUMNS.split(",").map((column) => `j.${column.trim()}`).join(",")}, w.plans_result, w.plans_reason FROM research_jobs j
       JOIN research_job_watchers w ON w.job_id=j.id AND w.user_id=$1 AND w.dismissed_at IS NULL
      WHERE j.status IN ${ACTIVE_SQL} OR j.created_at > now() - interval '1 day'
      ORDER BY j.created_at DESC LIMIT 30`,
    [userId],
  );
  return found.rows.map((row) => ({ ...jobView(row), plans: row.plans_result ? { result: row.plans_result, reason: row.plans_reason } : null }));
}

// ── The worker ────────────────────────────────────────────────────

export type JobDeps = {
  db?: Db;
  workerId?: string;
  now?: () => number;
  settings?: JobSettings;
  submit?: typeof submitBackgroundResearch;
  fetchResponse?: typeof fetchBackgroundResponse;
  cancel?: typeof cancelBackgroundResponse;
  /** Frozen inputs for a new job. */
  inputs?: (instrument: string, currencies: [string, string], now: number) => Promise<{ technical: TechnicalSummary; calendar: CalendarSnapshot }>;
  /** Build plans for a watcher on the stored research (never touches approved plans). */
  generatePlans?: (userId: string, instrument: string) => Promise<string | { result: string; reason: string | null }>;
  notify?: typeof queueNotification;
  /** Record how the new research changed each active plan's evidence (never the plan). */
  warn?: typeof updateThesesForResearch;
};

async function defaultInputs(instrument: string, currencies: [string, string], now: number) {
  const [technical, events] = await Promise.all([technicalSummaryFor(instrument as MajorInstrument), calendarEvents()]);
  return { technical, calendar: buildCalendarSnapshot({ events, currencies, now }) };
}

async function defaultGeneratePlans(userId: string, instrument: string) {
  // Watched plans are left exactly as they are; research only updates their evidence.
  const active = await query("SELECT 1 FROM trade_plans WHERE user_id=$1 AND instrument=$2 AND status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED') LIMIT 1", [userId, instrument]);
  if (active.rows[0]) return { result: "WATCHING", reason: "Your watched plans are unchanged; research only updates their evidence." };
  const { generateAndStoreTradePlans } = await import("../trade-plan-service.js");
  // Fresh OANDA candles are read here, after the research is stored: the plans are built once, now.
  const result = await generateAndStoreTradePlans(userId, instrument as MajorInstrument, { skipCooldown: true });
  return { result: result.result, reason: result.reason };
}

/** Advance one job by one step under a lease. Safe to call from the tick, the kick and the webhook at once. */
export async function processResearchJob(jobId: string, deps: JobDeps = {}) {
  const db = deps.db ?? pool;
  const workerId = deps.workerId ?? WORKER_ID;
  const settings = deps.settings ?? jobSettings();
  const now = deps.now ?? Date.now;
  const claimed = await db.query<JobRow>(
    `UPDATE research_jobs SET lease_owner=$2, lease_until=now() + make_interval(secs => $3), updated_at=now()
      WHERE id=$1 AND status IN ${ACTIVE_SQL} AND (lease_until IS NULL OR lease_until < now() OR lease_owner=$2)
      RETURNING ${JOB_COLUMNS}`,
    [jobId, workerId, settings.leaseSeconds],
  );
  const job = claimed.rows[0];
  if (!job) return null;
  const set = async (sql: string, values: unknown[]) =>
    (await db.query(`UPDATE research_jobs SET ${sql}, updated_at=now() WHERE id=$1 AND status=$2 AND lease_owner=$3`, [job.id, job.status, workerId, ...values])).rowCount ?? 0;
  try {
    if (job.status === "QUEUED") {
      if (job.submit_attempts >= settings.maxSubmitAttempts) {
        await set("status='FAILED', completed_at=now(), error=coalesce(error,'The research could not be started.')", []);
        return "FAILED";
      }
      let technical = job.technical_summary;
      let calendar = job.calendar_snapshot;
      if (!technical || !calendar) {
        const inputs = await (deps.inputs ?? defaultInputs)(job.instrument, job.currencies as [string, string], now());
        technical = inputs.technical;
        calendar = inputs.calendar;
      }
      // Record the attempt before calling OpenAI, so a crash mid-call is counted.
      await set("submit_attempts=submit_attempts+1, technical_summary=$4::jsonb, calendar_snapshot=$5::jsonb", [JSON.stringify(technical), JSON.stringify(calendar)]);
      const input = jobInput(job, technical, calendar, now());
      const result = await (deps.submit ?? submitBackgroundResearch)(input, job.id);
      const decision = submitDecision(job.submit_attempts + 1, result, settings);
      if (decision.kind === "researching") {
        await set("status='RESEARCHING', openai_response_id=$4, started_at=now(), next_check_at=now() + make_interval(secs => $5), error=NULL", [decision.responseId, settings.pollMs / 1000]);
        return "RESEARCHING";
      }
      if (decision.kind === "requeue") {
        await set("next_check_at=now() + make_interval(secs => $4), error=$5", [decision.delayMs / 1000, decision.error]);
        return "QUEUED";
      }
      await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
      await deliverCompletion(job.id, deps);
      return "FAILED";
    }

    if (!job.openai_response_id) {
      await set("status='FAILED', completed_at=now(), error='The research run id was lost.'", []);
      await deliverCompletion(job.id, deps);
      return "FAILED";
    }
    const fetched = await (deps.fetchResponse ?? fetchBackgroundResponse)(job.openai_response_id);
    const decision = pollDecision({ startedAt: job.started_at ? new Date(job.started_at).getTime() : null, pollFailures: job.poll_failures }, fetched, now(), settings);
    switch (decision.kind) {
      case "wait":
        await set("next_check_at=now() + make_interval(secs => $4), poll_failures=0", [decision.delayMs / 1000]);
        return job.status;
      case "retry":
        await set("next_check_at=now() + make_interval(secs => $4), poll_failures=$5, error=$6", [decision.delayMs / 1000, decision.pollFailures, decision.error]);
        return job.status;
      case "timeout":
        await (deps.cancel ?? cancelBackgroundResponse)(job.openai_response_id);
        await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps);
        return "FAILED";
      case "expire":
        await set("status='EXPIRED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps);
        return "EXPIRED";
      case "fail":
        await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps);
        return "FAILED";
      case "validate": {
        if (job.status === "RESEARCHING" && !(await set("status='VALIDATING'", []))) return null;
        const final = await storeResult({ ...job, status: "VALIDATING" }, decision.payload, deps);
        await deliverCompletion(job.id, deps);
        return final;
      }
    }
  } finally {
    await db.query("UPDATE research_jobs SET lease_owner=NULL, lease_until=NULL WHERE id=$1 AND lease_owner=$2", [job.id, workerId]);
  }
  return null;
}

function jobInput(job: JobRow, technical: TechnicalSummary, calendar: CalendarSnapshot, now: number): ResearchInput {
  return {
    instrument: job.instrument,
    currencies: job.currencies as [string, string],
    technical,
    calendar: calendarRefs(calendar),
    calendarNote: calendar.note,
    researchId: job.research_id,
    now: job.started_at ? new Date(job.started_at).getTime() : now,
  };
}

/** Validate the finished answer and store it: market_research first, then the job's final state. */
async function storeResult(job: JobRow, payload: Record<string, unknown>, deps: JobDeps) {
  const db = deps.db ?? pool;
  const now = (deps.now ?? Date.now)();
  const started = job.started_at ? new Date(job.started_at).getTime() : now;
  const config = { ...researchConfig(), model: job.model, effort: job.effort };
  const input = jobInput(job, job.technical_summary!, job.calendar_snapshot!, now);
  const outcome = interpretResearchResponse(payload, 200, input, config, now - started);
  const ttlHours = Number(process.env.RESEARCH_TTL_HOURS) > 0 ? Number(process.env.RESEARCH_TTL_HOURS) : 6;
  await db.query(
    `INSERT INTO market_research(id,instrument,currencies,trigger,status,model,report,sources,calendar_snapshot,technical_summary,dropped,
                                 input_tokens,output_tokens,web_search_calls,cost_usd,error,expires_at,job_id,reasoning_tokens,duration_ms,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (id) DO NOTHING`,
    [job.research_id, job.instrument, job.currencies, job.trigger, outcome.ok ? "COMPLETE" : "FAILED", job.model,
     outcome.ok ? JSON.stringify(outcome.intelligence) : null, JSON.stringify(outcome.sources), JSON.stringify(job.calendar_snapshot), JSON.stringify(job.technical_summary),
     JSON.stringify(outcome.drops), outcome.usage.inputTokens, outcome.usage.outputTokens, outcome.usage.webSearchCalls, outcome.usage.costUsd,
     outcome.ok ? null : outcome.error, new Date(started + ttlHours * 3_600_000).toISOString(), job.id, outcome.usage.reasoningTokens ?? null, now - started,
     new Date(started).toISOString()],
  );
  const status = outcome.ok ? "COMPLETED" : "FAILED";
  await db.query(
    `UPDATE research_jobs SET status=$2, completed_at=now(), updated_at=now(), error=$3, input_tokens=$4, output_tokens=$5, reasoning_tokens=$6,
            web_search_calls=$7, sources_count=$8, cost_usd=$9, validation_drops=$10
      WHERE id=$1 AND status='VALIDATING'`,
    [job.id, status, outcome.ok ? null : outcome.error, outcome.usage.inputTokens, outcome.usage.outputTokens, outcome.usage.reasoningTokens ?? null,
     outcome.usage.webSearchCalls, outcome.sources.length, outcome.usage.costUsd, outcome.drops.length],
  );
  if (outcome.ok) await (deps.warn ?? updateThesesForResearch)(job.instrument, outcome.intelligence, now).catch((error) => console.error("[research-jobs] thesis updates failed", error));
  return status;
}

/**
 * Tell each watcher once, after the job's final state is stored. A completed
 * job first rebuilds that user's plans on the new research (pending plans only).
 * Retried by the tick until every watcher is marked notified.
 */
export async function deliverCompletion(jobId: string, deps: JobDeps = {}) {
  const db = deps.db ?? pool;
  const job = (await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM research_jobs WHERE id=$1`, [jobId])).rows[0];
  if (!job || (ACTIVE_STATUSES as readonly string[]).includes(job.status)) return 0;
  const watchers = await db.query<{ user_id: string; plans_result: string | null }>("SELECT user_id, plans_result FROM research_job_watchers WHERE job_id=$1 AND notified_at IS NULL", [jobId]);
  let sent = 0;
  for (const watcher of watchers.rows) {
    let plans = watcher.plans_result;
    if (job.status === "COMPLETED" && !plans) {
      const built = await (deps.generatePlans ?? defaultGeneratePlans)(watcher.user_id, job.instrument).catch((error) => {
        console.error("[research-jobs] plan generation failed", error);
        return { result: "ERROR", reason: error instanceof Error ? error.message : "Plans could not be built." };
      });
      const outcome = typeof built === "string" ? { result: built, reason: null } : built;
      plans = outcome.result;
      await db.query("UPDATE research_job_watchers SET plans_result=$3, plans_reason=$4 WHERE job_id=$1 AND user_id=$2", [jobId, watcher.user_id, plans, outcome.reason]);
    }
    const notice = completionNotice(job.instrument, job.status, job.error, plans);
    await (deps.notify ?? queueNotification)({
      userId: watcher.user_id, kind: "research_ready", title: notice.title, message: notice.message, instrument: job.instrument,
      paperTradeId: null, dedupeKey: `research-job:${jobId}`, url: `/chart?instrument=${encodeURIComponent(job.instrument)}&analyze=1`,
    });
    await db.query("UPDATE research_job_watchers SET notified_at=now() WHERE job_id=$1 AND user_id=$2", [jobId, watcher.user_id]);
    sent += 1;
  }
  return sent;
}

/** One worker pass: advance due jobs, then finish any delivery a crash interrupted. */
export async function runResearchJobsTick(deps: JobDeps = {}) {
  const db = deps.db ?? pool;
  const due = await db.query<{ id: string }>(
    `SELECT id FROM research_jobs WHERE status IN ${ACTIVE_SQL} AND next_check_at <= now()
        AND (lease_until IS NULL OR lease_until < now()) ORDER BY next_check_at LIMIT 10`,
  );
  let advanced = 0;
  for (const { id } of due.rows) {
    try { if (await processResearchJob(id, deps)) advanced += 1; } catch (error) { console.error(`[research-jobs] job ${id} step failed`, error); }
  }
  const undelivered = await db.query<{ id: string }>(
    `SELECT DISTINCT j.id FROM research_jobs j JOIN research_job_watchers w ON w.job_id=j.id
      WHERE w.notified_at IS NULL AND j.status NOT IN ${ACTIVE_SQL} AND j.updated_at > now() - interval '1 day' LIMIT 10`,
  );
  for (const { id } of undelivered.rows) await deliverCompletion(id, deps).catch((error) => console.error(`[research-jobs] delivery ${id} failed`, error));
  return { advanced, delivered: undelivered.rows.length };
}

/** OpenAI completion webhook: verified, then it only wakes the job; the worker reads the result itself. */
export async function handleOpenAIWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>) {
  const secret = process.env.OPENAI_WEBHOOK_SECRET?.trim();
  if (!secret) return { status: 404, body: { error: "Webhook not configured." } };
  const verified = verifyWebhook(rawBody, headers, secret);
  if (!verified.ok) return { status: 400, body: { error: verified.reason } };
  if (!verified.event.type.startsWith("response.") || !verified.event.responseId) return { status: 200, body: { ignored: true } };
  // Replays and late events are harmless: only an active job is woken, and every step is compare-and-set.
  const woken = await query<{ id: string }>(
    `UPDATE research_jobs SET next_check_at=now(), updated_at=now() WHERE openai_response_id=$1 AND status IN ${ACTIVE_SQL} RETURNING id`,
    [verified.event.responseId],
  );
  for (const { id } of woken.rows) setImmediate(() => void processResearchJob(id).catch((error) => console.error("[research-jobs] webhook step failed", error)));
  return { status: 200, body: { received: true } };
}

/** Scheduled research runs only while the forex market is open. Pure. */
export function scheduleOpen(now: number) {
  return getForexSessionStatus(new Date(now)).marketOpen;
}

/**
 * Scheduled refresh: pairs with accepted plans whose research is stale get a
 * background job (no watcher: active plans are only warned, never changed).
 */
export async function refreshDueResearch(now = Date.now()) {
  if (process.env.RESEARCH_SCHEDULE_ENABLED === "false" || !researchConfig().apiKey) return { started: 0 };
  // No scheduled research while forex is closed (Fri 17:00 – Sun 17:00 New York): nothing trades, and the
  // first tick after the open refreshes anything that went stale over the weekend.
  if (!scheduleOpen(now)) return { started: 0 };
  const pairs = await query<{ instrument: string }>(
    `SELECT DISTINCT instrument FROM trade_plans WHERE status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','FILLED')`,
  );
  const events = await calendarEvents();
  let started = 0;
  for (const { instrument } of pairs.rows) {
    const row = await latestCompleteRow(instrument);
    const freshness = researchFreshness(row, releasedOf(events, now), now);
    if (freshness.fresh) continue;
    const trigger: Trigger = row && freshness.reason?.startsWith("New high-impact") ? "RELEASE" : row ? "STALE" : "SCHEDULED";
    const result = await requestResearch(null, instrument, { trigger, now });
    if (result.state === "budget") break;
    if (result.state === "started") started += 1;
  }
  return { started };
}

export function startResearchWorker(intervalMs = jobSettings().pollMs) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void runResearchJobsTick()
      .catch((error) => console.error("[research-jobs] tick failed", error))
      .finally(() => { busy = false; });
  };
  tick();
  return setInterval(tick, Math.max(2_000, intervalMs));
}
