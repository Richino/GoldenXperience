import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { storedPlanResult } from "../../../frontend/src/lib/trade-plans/analysis-status.js";
import type { QueryResult, QueryResultRow } from "pg";
import { currenciesOf, isKnownInstrument } from "../../../frontend/src/lib/instruments/catalog.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import { getForexSessionStatus } from "../../../frontend/src/lib/strategy/session.js";
import { query } from "../database.js";
import { updateThesesForResearch } from "./thesis-updates.js";
import type { MarketIntelligence } from "./research-contract.js";
import { displayPair, queueNotification } from "../notifications.js";
import { calendarRefs, buildCalendarSnapshot, type CalendarSnapshot } from "./calendar-snapshot.js";
import {
  cancelBackgroundResponse, fetchBackgroundResponse, interpretResearchResponse, researchConfig, submitBackgroundResearch,
  type FetchResult, type ResearchInput, type SubmitResult, type TechnicalSummary,
} from "./openai-research.js";
import {
  calendarEvents, cachedCurrencyEvidence, latestResearch, latestCompleteRow, releasedOf, researchFreshness, researchUsage, technicalSummaryFor,
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
    /** Provider queue time is separate from high-effort generation time. */
    queueTimeoutMs: num(env.RESEARCH_JOB_QUEUE_TIMEOUT_MS, 3 * 60_000),
    /** Total submissions, including a replacement after a confirmed queue cancellation. */
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
  | { kind: "queue-timeout"; error: string }
  | { kind: "expire"; error: string }
  | { kind: "retry"; delayMs: number; pollFailures: number; error: string }
  | { kind: "fail"; error: string };

export function pollDecision(job: { startedAt: number | null; pollFailures: number }, result: FetchResult, now: number, settings: JobSettings): PollDecision {
  if (result.kind === "done") return { kind: "validate", payload: result.payload };
  if (result.kind === "gone") return { kind: "expire", error: "OpenAI no longer holds this research run, so it cannot be recovered." };
  const overdue = job.startedAt !== null && now - job.startedAt > settings.timeoutMs;
  if (overdue) return { kind: "timeout", error: `The research did not finish within ${Math.round(settings.timeoutMs / 60_000)} minutes.` };
  if (result.kind === "pending" && result.status === "queued" && job.startedAt !== null && now - job.startedAt >= settings.queueTimeoutMs) {
    return { kind: "queue-timeout", error: `OpenAI did not start the research within ${Math.round(settings.queueTimeoutMs / 60_000)} minutes.` };
  }
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
export function completionNotice(instrument: string, status: string, error: string | null, plans: string | null, planReason: string | null = null) {
  const pair = displayPair(instrument);
  if (status !== "COMPLETED") {
    return { title: `${pair} research did not finish`, message: `${error ?? "The research run stopped."} Your plans are unchanged.` };
  }
  const message =
    plans === "WATCHING" ? "Your market report is ready. Your watched plans are unchanged; check whether the research supports them."
    : plans === "PLANS" ? "Your market report and BUY/SELL scenarios are ready for review."
    : plans === "NO_VALID_SETUP" ? "Your market report is ready. No setup meets the trading rules right now; both scenarios are explained."
    : `Research is saved. Swing plans are paused.${planReason ? ` ${planReason}` : " Required technical checks did not pass."} Retry technical analysis to reuse the saved research.`;
  return { title: `${pair} ${["PLANS", "NO_VALID_SETUP", "WATCHING"].includes(plans ?? "") ? "analysis complete" : "research ready · analysis incomplete"}`, message };
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

/** A job the user asked for, with the plans it built for them (or why none). */
/** Remove a finished job from your Plans card (a running one is cancelled instead). */
export async function dismissResearchJob(userId: string, jobId: string, db: Db = pool) {
  const updated = await db.query(
    `UPDATE research_job_watchers w SET dismissed_at=now() FROM research_jobs j
      WHERE w.job_id=$1 AND w.user_id=$2 AND j.id=w.job_id AND j.status NOT IN ${ACTIVE_SQL}`,
    [jobId, userId],
  );
  return { dismissed: (updated.rowCount ?? 0) > 0 };
}

export async function researchJobForUser(userId: string, jobId: string, db: Db = pool) {
  const found = await db.query<JobRow & { plans_result: string | null; plans_reason: string | null }>(
    `SELECT ${JOB_COLUMNS.split(",").map((column) => `j.${column.trim()}`).join(",")}, w.plans_result, w.plans_reason FROM research_jobs j
       JOIN research_job_watchers w ON w.job_id=j.id AND w.user_id=$2 WHERE j.id=$1`,
    [jobId, userId],
  );
  const row = found.rows[0];
  return row ? { ...jobView(row), plans: row.plans_result ? { result: storedPlanResult(row.plans_result, row.plans_reason), reason: row.plans_reason } : null } : null;
}

/** Latest watched job per pair. Completed analyses without plans remain until dismissed. */
export async function researchJobsForUser(userId: string, db: Db = pool) {
  const found = await db.query<JobRow & { plans_result: string | null; plans_reason: string | null }>(
    `SELECT ${JOB_COLUMNS.split(",").map((column) => `j.${column.trim()}`).join(",")}, j.plans_result, j.plans_reason FROM (
       SELECT DISTINCT ON (r.instrument) r.*, w.plans_result, w.plans_reason, w.dismissed_at
       FROM research_jobs r JOIN research_job_watchers w ON w.job_id=r.id AND w.user_id=$1
       ORDER BY r.instrument, (r.status IN ${ACTIVE_SQL}) DESC, r.created_at DESC, w.requested_at DESC, r.id DESC
     ) j
      WHERE j.dismissed_at IS NULL AND (j.status IN ${ACTIVE_SQL} OR j.created_at > now() - interval '1 day'
        OR (j.status='COMPLETED' AND j.plans_result IN ('NO_VALID_SETUP','TECHNICAL_DATA_UNAVAILABLE','DATA_VALIDATION_FAILED','ERROR')))
      ORDER BY j.created_at DESC LIMIT 30`,
    [userId],
  );
  return found.rows.map((row) => ({ ...jobView(row), plans: row.plans_result ? { result: storedPlanResult(row.plans_result, row.plans_reason), reason: row.plans_reason } : null }));
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
  generatePlans?: (userId: string, instrument: string, jobId?: string) => Promise<string | { result: string; reason: string | null }>;
  notify?: typeof queueNotification;
  /** Record how the new research changed each active plan's evidence (never the plan). */
  warn?: typeof updateThesesForResearch;
};

async function defaultInputs(instrument: string, currencies: [string, string], now: number) {
  const [technical, events] = await Promise.all([technicalSummaryFor(instrument as MajorInstrument), calendarEvents()]);
  // Ordinary research can disclose an unavailable schedule; execution and News
  // Mode keep their independent verified-calendar requirements.
  const cached = await cachedCurrencyEvidence(currencies, events, now).catch(() => []);
  return { technical: { ...technical, cachedCurrencyEvidenceForDiscovery: cached }, calendar: buildCalendarSnapshot({ events, currencies, now }) };
}

async function defaultGeneratePlans(userId: string, instrument: string, jobId?: string) {
  // Watched plans are left exactly as they are; research only updates their evidence.
  const active = await query("SELECT 1 FROM trade_plans WHERE user_id=$1 AND instrument=$2 AND status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED') LIMIT 1", [userId, instrument]);
  if (active.rows[0]) return { result: "WATCHING", reason: "Your watched plans are unchanged; research only updates their evidence." };
  const { generateAndStoreTradePlans } = await import("../trade-plan-service.js");
  // Fresh OANDA candles are read here, after the research is stored: the plans are built once, now.
  const result = await generateAndStoreTradePlans(userId, instrument as MajorInstrument, { skipCooldown: true, analysisId: jobId, jobId });
  return { result: result.result, reason: result.reason };
}

/** Scheduled/accepted-plan research updates interpretation, never approved conditions. */
async function updateResearchContext(instrument: string, intelligence: MarketIntelligence, now: number) {
  const active = await query("SELECT 1 FROM trade_plans WHERE instrument=$1 AND status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','EXECUTION_PENDING','ORDER_SUBMITTED','PARTIALLY_FILLED','FILLED') LIMIT 1", [instrument]);
  if (active.rows[0]) {
    const { refreshMarketStateForResearch } = await import("../trade-plan-service.js");
    await refreshMarketStateForResearch(instrument as MajorInstrument).catch(error => console.error("[market-state] update failed", error));
  }
  return updateThesesForResearch(instrument, intelligence, now);
}

/** Advance one job by one step under a lease. Safe to call from the tick, the kick and the webhook at once. */
export async function processResearchJob(jobId: string, deps: JobDeps = {}) {
  const db = deps.db ?? pool;
  // A webhook and a timer in the same process must not share ownership.
  const workerId = `${deps.workerId ?? WORKER_ID}:${randomUUID()}`;
  const settings = deps.settings ?? jobSettings();
  const now = deps.now ?? Date.now;
  const claimed = await db.query<JobRow>(
    `UPDATE research_jobs SET lease_owner=$2, lease_until=now() + make_interval(secs => $3), updated_at=now()
      WHERE id=$1 AND status IN ${ACTIVE_SQL} AND (lease_until IS NULL OR lease_until < now())
      RETURNING ${JOB_COLUMNS}`,
    [jobId, workerId, settings.leaseSeconds],
  );
  const job = claimed.rows[0];
  if (!job) return null;
  const set = async (sql: string, values: unknown[]) =>
    (await db.query(`UPDATE research_jobs SET ${sql}, updated_at=now() WHERE id=$1 AND status=$2 AND lease_owner=$3`, [job.id, job.status, workerId, ...values])).rowCount ?? 0;
  try {
    if (job.status === "QUEUED" && !job.openai_response_id) {
      if (now() - new Date(job.created_at).getTime() >= settings.timeoutMs) {
        await set("status='FAILED', completed_at=now(), error='Research inputs could not be prepared within the time limit.'", []);
        await deliverCompletion(job.id, deps, workerId);
        return "FAILED";
      }
      if (job.submit_attempts >= settings.maxSubmitAttempts) {
        await set("status='FAILED', completed_at=now(), error=coalesce(error,'The research could not be started.')", []);
        await deliverCompletion(job.id, deps, workerId);
        return "FAILED";
      }
      let technical = job.technical_summary;
      let calendar = job.calendar_snapshot;
      if (!technical || !calendar || !calendar.available) {
        const inputs = await (deps.inputs ?? defaultInputs)(job.instrument, job.currencies as [string, string], now());
        technical = inputs.technical;
        calendar = inputs.calendar;
      }
      // Record the attempt before calling OpenAI, so a crash mid-call is counted.
      if (!(await set("submit_attempts=submit_attempts+1, technical_summary=$4::jsonb, calendar_snapshot=$5::jsonb", [JSON.stringify(technical), JSON.stringify(calendar)]))) return null;
      const input = jobInput(job, technical, calendar, now());
      const result = await (deps.submit ?? submitBackgroundResearch)(input, job.id);
      const decision = submitDecision(job.submit_attempts + 1, result, settings);
      if (decision.kind === "researching") {
        const providerStatus = result.ok && result.status === "queued" ? "queued" : "in_progress";
        // Older workers interpret QUEUED as unsubmitted even when it has a
        // response id. Keep the accepted lifecycle state backward compatible.
        const stored = await set("status='RESEARCHING', provider_status=$6, openai_response_id=$4, started_at=now(), next_check_at=now() + make_interval(secs => $5), poll_failures=0, error=NULL", [decision.responseId, settings.pollMs / 1000, providerStatus]);
        // Cancellation during submission must not leave an orphaned paid run.
        if (!stored) await (deps.cancel ?? cancelBackgroundResponse)(decision.responseId);
        return stored ? "RESEARCHING" : null;
      }
      if (decision.kind === "requeue") {
        await set("next_check_at=now() + make_interval(secs => $4), error=$5", [decision.delayMs / 1000, decision.error]);
        return "QUEUED";
      }
      await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
      await deliverCompletion(job.id, deps, workerId);
      return "FAILED";
    }

    if (!job.openai_response_id) {
      await set("status='FAILED', completed_at=now(), error='The research run id was lost.'", []);
      await deliverCompletion(job.id, deps, workerId);
      return "FAILED";
    }
    const fetched = await (deps.fetchResponse ?? fetchBackgroundResponse)(job.openai_response_id);
    const decision = pollDecision({ startedAt: new Date(job.started_at ?? job.created_at).getTime(), pollFailures: job.poll_failures }, fetched, now(), settings);
    switch (decision.kind) {
      case "wait":
        {
          const providerStatus = fetched.kind === "pending" && fetched.status === "queued" ? "queued" : "in_progress";
          await set("status='RESEARCHING', provider_status=$5, next_check_at=now() + make_interval(secs => $4), poll_failures=0, error=NULL", [decision.delayMs / 1000, providerStatus]);
          return "RESEARCHING";
        }
      case "retry":
        await set("next_check_at=now() + make_interval(secs => $4), poll_failures=$5, error=$6", [decision.delayMs / 1000, decision.pollFailures, decision.error]);
        return job.status;
      case "timeout":
        await (deps.cancel ?? cancelBackgroundResponse)(job.openai_response_id);
        await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps, workerId);
        return "FAILED";
      case "queue-timeout": {
        const cancelled = await (deps.cancel ?? cancelBackgroundResponse)(job.openai_response_id);
        if (!cancelled) {
          // Completion can race the cancel request. Use the completed answer
          // instead of discarding it or submitting a duplicate.
          const latest = await (deps.fetchResponse ?? fetchBackgroundResponse)(job.openai_response_id);
          if (latest.kind === "done") {
            if (!(await set("status='VALIDATING'", []))) return null;
            const final = await storeResult({ ...job, status: "VALIDATING" }, latest.payload, deps);
            await deliverCompletion(job.id, deps, workerId);
            return final;
          }
        }
        // Never overlap two provider runs. Retry only after confirmed cancellation,
        // within the same job/watchers, and with freshly read market inputs.
        if (cancelled && job.submit_attempts < settings.maxSubmitAttempts) {
          await set("status='QUEUED', provider_status=NULL, openai_response_id=NULL, started_at=NULL, technical_summary=NULL, calendar_snapshot=NULL, poll_failures=0, next_check_at=now(), error=$4", [`${decision.error} Retrying once.`]);
          return "QUEUED";
        }
        await set("status='FAILED', completed_at=now(), error=$4", [`${decision.error} ${cancelled ? "The retry limit was reached. You can try again." : "Cancellation could not be confirmed, so no second run was started."}`]);
        await deliverCompletion(job.id, deps, workerId);
        return "FAILED";
      }
      case "expire":
        await set("status='EXPIRED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps, workerId);
        return "EXPIRED";
      case "fail":
        await (deps.cancel ?? cancelBackgroundResponse)(job.openai_response_id);
        await set("status='FAILED', completed_at=now(), error=$4", [decision.error]);
        await deliverCompletion(job.id, deps, workerId);
        return "FAILED";
      case "validate": {
        if (job.status !== "VALIDATING" && !(await set("status='VALIDATING'", []))) return null;
        const final = await storeResult({ ...job, status: "VALIDATING" }, decision.payload, deps);
        await deliverCompletion(job.id, deps, workerId);
        return final;
      }
    }
  } catch (error) {
    // Input/validation/database exceptions used to leave jobs active forever.
    const failures = job.poll_failures + 1;
    const message = error instanceof Error ? error.message.slice(0, 300) : "Research processing failed.";
    const failed = failures > settings.maxPollFailures || now() - new Date(job.started_at ?? job.created_at).getTime() >= settings.timeoutMs;
    const updated = await set(
      failed
        ? "status='FAILED', completed_at=now(), poll_failures=$4, error=$5"
        : "next_check_at=now() + make_interval(secs => $6), poll_failures=$4, error=$5",
      failed ? [failures, message] : [failures, message, settings.pollMs / 1000],
    );
    if (!updated) throw error; // A terminal job's failed delivery is retried separately.
    if (failed && job.openai_response_id) await (deps.cancel ?? cancelBackgroundResponse)(job.openai_response_id);
    if (failed) await deliverCompletion(job.id, deps, workerId);
    return failed ? "FAILED" : job.status;
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
    // A queued job retains the model/effort it was created with across restarts.
    env: { ...process.env, OPENAI_RESEARCH_MODEL: job.model, OPENAI_RESEARCH_EFFORT: job.effort },
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
  if (outcome.ok) await (deps.warn ?? updateResearchContext)(job.instrument, outcome.intelligence, now).catch((error) => console.error("[research-jobs] context updates failed", error));
  return status;
}

/**
 * Tell each watcher once, after the job's final state is stored. A completed
 * job first rebuilds that user's plans on the new research (pending plans only).
 * Retried by the tick until every watcher is marked notified.
 */
export async function deliverCompletion(jobId: string, deps: JobDeps = {}, heldLease?: string) {
  const db = deps.db ?? pool;
  const owner = heldLease ?? `${deps.workerId ?? WORKER_ID}:delivery:${randomUUID()}`;
  const job = (await db.query<JobRow>(
    `UPDATE research_jobs SET lease_owner=$2, lease_until=now() + interval '120 seconds'
      WHERE id=$1 AND status NOT IN ${ACTIVE_SQL} AND (lease_until IS NULL OR lease_until < now() OR lease_owner=$2)
      RETURNING ${JOB_COLUMNS}`, [jobId, owner],
  )).rows[0];
  if (!job) return 0;
  try {
  const watchers = await db.query<{ user_id: string; plans_result: string | null; plans_reason: string | null }>("SELECT user_id, plans_result, plans_reason FROM research_job_watchers WHERE job_id=$1 AND notified_at IS NULL", [jobId]);
  let sent = 0;
  for (const watcher of watchers.rows) {
    let plans = watcher.plans_result;
    let planReason = watcher.plans_reason;
    if (job.status === "COMPLETED" && !plans) {
      const built = await (deps.generatePlans ?? defaultGeneratePlans)(watcher.user_id, job.instrument, job.id).catch((error) => {
        console.error("[research-jobs] plan generation failed", error);
        return { result: "ERROR", reason: error instanceof Error ? error.message : "Plans could not be built." };
      });
      const outcome = typeof built === "string" ? { result: built, reason: null } : built;
      plans = outcome.result;
      planReason = outcome.reason;
      await db.query("UPDATE research_job_watchers SET plans_result=$3, plans_reason=$4 WHERE job_id=$1 AND user_id=$2", [jobId, watcher.user_id, plans, outcome.reason]);
    }
    const notice = completionNotice(job.instrument, job.status, job.error, plans, planReason);
    await (deps.notify ?? queueNotification)({
      userId: watcher.user_id, kind: "research_ready", title: notice.title, message: notice.message, instrument: job.instrument,
      paperTradeId: null, dedupeKey: `research-job:${jobId}`, url: `/chart?instrument=${encodeURIComponent(job.instrument)}&analyze=1`,
    });
    await db.query("UPDATE research_job_watchers SET notified_at=now() WHERE job_id=$1 AND user_id=$2", [jobId, watcher.user_id]);
    sent += 1;
  }
  return sent;
  } finally {
    await db.query("UPDATE research_jobs SET lease_owner=NULL, lease_until=NULL WHERE id=$1 AND lease_owner=$2", [jobId, owner]);
  }
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
