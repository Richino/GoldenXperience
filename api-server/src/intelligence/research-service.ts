import { getAllCalendarEvents, getMarketSelectionCalendar } from "../../../frontend/src/lib/calendar/forex-factory.js";
import type { EconomicCalendarEvent } from "../../../frontend/src/lib/oanda/calendar.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import { databaseConfigured, query } from "../database.js";
import { generateTradePlans } from "../trade-plan-generator.js";
import { loadGeneratorMarket } from "../trade-plan-service.js";
import type { CalendarSnapshot } from "./calendar-snapshot.js";
import { researchConfig, type TechnicalSummary } from "./openai-research.js";
import { isSupportedSchema, type MarketIntelligence } from "./research-contract.js";

/**
 * Market intelligence: cache, freshness, budget, and the read side of
 * research jobs. The runs themselves are background jobs (research-jobs.ts).
 *
 * Research is expensive, so it runs only when it is needed:
 *   - Analyze reuses the latest research for the pair while it is fresh;
 *   - it is stale after RESEARCH_TTL_HOURS, or as soon as a high-impact
 *     release for either currency has come out since it was made;
 *   - the scheduler refreshes stale research only for pairs with accepted plans;
 *   - at most one job runs per pair; a second Analyze joins it;
 *   - daily/monthly budgets (USD when prices are configured, and a run count
 *     always) stop optional research and say so.
 * Research never changes an accepted plan, and trading never waits on it
 * unless RESEARCH_REQUIRED_FOR_AUTO is set.
 */

export type Trigger = "MANUAL" | "SCHEDULED" | "RELEASE" | "STALE";

type ResearchRow = {
  id: string;
  instrument: string;
  currencies: string[];
  trigger: Trigger;
  status: "COMPLETE" | "FAILED" | "BUDGET_BLOCKED";
  model: string | null;
  /** Validated MarketIntelligence (schema v2); older rows hold the v1 report and count as stale. */
  report: MarketIntelligence | null;
  sources: Array<{ url: string; title: string | null }>;
  calendar_snapshot: CalendarSnapshot;
  technical_summary: TechnicalSummary;
  input_tokens: number | null;
  output_tokens: number | null;
  web_search_calls: number | null;
  cost_usd: string | null;
  error: string | null;
  created_at: Date;
  expires_at: Date | null;
};

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function researchSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    ttlHours: num(env.RESEARCH_TTL_HOURS, 6),
    dailyRunLimit: num(env.RESEARCH_DAILY_RUN_LIMIT, 12),
    dailyBudgetUsd: env.RESEARCH_DAILY_BUDGET_USD?.trim() ? num(env.RESEARCH_DAILY_BUDGET_USD, 0) : null,
    monthlyBudgetUsd: env.RESEARCH_MONTHLY_BUDGET_USD?.trim() ? num(env.RESEARCH_MONTHLY_BUDGET_USD, 0) : null,
    scheduleEnabled: env.RESEARCH_SCHEDULE_ENABLED !== "false",
    requiredForAuto: env.RESEARCH_REQUIRED_FOR_AUTO === "true",
    /** Off by default: research is context, not a filter, unless the user opts in. */
    blockAutoWhenOpposed: env.RESEARCH_BLOCK_AUTO_WHEN_OPPOSED === "true",
  };
}

/** Freshness of a research row against the clock and the calendar. Pure. */
export function researchFreshness(row: { created_at: Date | string; expires_at: Date | string | null; currencies: string[]; report?: unknown; calendar_snapshot?: CalendarSnapshot | null } | null, released: Array<{ title?: string; currency: string; impact: number; at: string }>, now: number) {
  if (!row) return { fresh: false, reason: "No research yet." };
  if (row.report !== undefined && !isSupportedSchema((row.report as { schemaVersion?: string } | null)?.schemaVersion)) {
    return { fresh: false, reason: "Research is in an older format." };
  }
  const created = new Date(row.created_at).getTime();
  if (!Number.isFinite(created) || created > now || (row.expires_at && !Number.isFinite(new Date(row.expires_at).getTime()))) {
    return { fresh: false, reason: "Research timestamps are invalid." };
  }
  if (!row.expires_at && now - created >= researchSettings().ttlHours * 3_600_000) return { fresh: false, reason: "Research is older than its refresh window." };
  if (row.expires_at && now >= new Date(row.expires_at).getTime()) return { fresh: false, reason: "Research is older than its refresh window." };
  const newer = released.find((event) => event.impact >= 3 && row.currencies.includes(event.currency) && Date.parse(event.at) > created && Date.parse(event.at) <= now);
  if (newer) return { fresh: false, reason: `New high-impact ${newer.currency} release since the research.` };
  if (row.calendar_snapshot) {
    if (!row.calendar_snapshot.available) return { fresh: false, reason: "Research was generated without verified calendar data. Refresh before building plans." };
    const included = new Set((row.calendar_snapshot.released ?? []).map((event) => `${event.currency}|${event.title}|${event.at}`));
    const missing = released.some((event) => event.title && event.impact >= 2 && row.currencies.includes(event.currency)
      && Date.parse(event.at) <= created && Date.parse(event.at) >= created - 72 * 3_600_000
      && !included.has(`${event.currency}|${event.title}|${event.at}`));
    if (missing) return { fresh: false, reason: "Research is missing verified calendar releases. Refresh to include them." };
  }
  return { fresh: true, reason: null as string | null };
}

/** Budget verdict from this period's spend and runs. Pure. */
export function budgetVerdict(usage: { todayRuns: number; todayUsd: number; monthUsd: number; unknownCostRuns: number }, settings: ReturnType<typeof researchSettings>) {
  if (usage.todayRuns >= settings.dailyRunLimit) return { allowed: false, reason: `Daily research limit reached (${settings.dailyRunLimit} runs).` };
  if (settings.dailyBudgetUsd !== null && usage.todayUsd >= settings.dailyBudgetUsd) return { allowed: false, reason: `Daily research budget reached ($${settings.dailyBudgetUsd}).` };
  if (settings.monthlyBudgetUsd !== null && usage.monthUsd >= settings.monthlyBudgetUsd) return { allowed: false, reason: `Monthly research budget reached ($${settings.monthlyBudgetUsd}).` };
  return { allowed: true, reason: null as string | null };
}

export async function researchUsage(now = Date.now()) {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const month = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  const rows = await query<{ today_runs: string; today_usd: string | null; month_runs: string; month_usd: string | null; unknown_cost: string; tokens_in: string | null; tokens_out: string | null; searches: string | null }>(
    `SELECT count(*) FILTER (WHERE created_at>=$1 AND status<>'BUDGET_BLOCKED')::text AS today_runs,
            sum(cost_usd) FILTER (WHERE created_at>=$1)::text AS today_usd,
            count(*) FILTER (WHERE status<>'BUDGET_BLOCKED')::text AS month_runs,
            sum(cost_usd)::text AS month_usd,
            count(*) FILTER (WHERE cost_usd IS NULL AND status<>'BUDGET_BLOCKED')::text AS unknown_cost,
            sum(input_tokens)::text AS tokens_in, sum(output_tokens)::text AS tokens_out, sum(web_search_calls)::text AS searches
       FROM market_research WHERE created_at>=$2`,
    [day.toISOString(), month.toISOString()],
  );
  const jobs = await query<{ active: string; avg_ms: string | null; failed: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('QUEUED','RESEARCHING','VALIDATING'))::text AS active,
            avg(extract(epoch FROM completed_at - started_at) * 1000) FILTER (WHERE status='COMPLETED' AND created_at>=$1)::text AS avg_ms,
            count(*) FILTER (WHERE status IN ('FAILED','EXPIRED') AND created_at>=$1)::text AS failed
       FROM research_jobs WHERE created_at>=$1 OR status IN ('QUEUED','RESEARCHING','VALIDATING')`,
    [month.toISOString()],
  ).catch(() => ({ rows: [{ active: "0", avg_ms: null, failed: "0" }] }));
  const r = rows.rows[0]!;
  const j = jobs.rows[0]!;
  const usage = {
    todayRuns: Number(r.today_runs) + Number(j.active), todayUsd: Number(r.today_usd ?? 0), monthRuns: Number(r.month_runs), monthUsd: Number(r.month_usd ?? 0),
    unknownCostRuns: Number(r.unknown_cost), monthInputTokens: Number(r.tokens_in ?? 0), monthOutputTokens: Number(r.tokens_out ?? 0), monthWebSearches: Number(r.searches ?? 0),
  };
  const settings = researchSettings();
  const config = researchConfig();
  return { ...usage, activeJobs: Number(j.active), monthAvgDurationMs: j.avg_ms === null ? null : Math.round(Number(j.avg_ms)), monthFailedJobs: Number(j.failed), cacheHitsSinceRestart: cacheHits, model: config.model, effort: config.effort, settings, verdict: budgetVerdict(usage, settings), pricesConfigured: config.prices.inputPerMTok !== null };
}

async function fullResearchCalendar() {
  // Check freshness/coverage before using the shared feed's stale UI fallback.
  await getMarketSelectionCalendar();
  // The display snapshot retains only today's released events. Research needs
  // the whole week so its own 72-hour lookback can include prior days.
  return getAllCalendarEvents();
}

export async function calendarEvents(load: () => Promise<EconomicCalendarEvent[]> = fullResearchCalendar): Promise<EconomicCalendarEvent[] | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

/** A compact technical read from the deterministic engine (no thousands of candles). */
export async function technicalSummaryFor(instrument: MajorInstrument): Promise<TechnicalSummary> {
  const market = await loadGeneratorMarket(instrument);
  const result = generateTradePlans({ instrument, ...market, maxRiskPercent: 1 });
  const context = result.context;
  return {
    instrument,
    readAt: new Date(market.now).toISOString(),
    price: context?.price ?? null,
    trend: context ? { D1: context.trend.D1, H4: context.trend.H4, H1: context.trend.H1 } : {},
    atr: context ? { D1: context.atr.D1, H4: context.atr.H4, H1: context.atr.H1 } : {},
    zones: (context?.zones ?? []).map((zone) => ({ low: zone.low, high: zone.high, type: zone.type, relevance: zone.relevance })),
    plans: result.plans.map((plan) => ({ direction: plan.direction, setup: plan.setupType, zone: [plan.entryZoneLow, plan.entryZoneHigh], stop: plan.stopLoss, target: plan.takeProfit })),
  };
}

function rowView(row: ResearchRow | null, freshness: { fresh: boolean; reason: string | null }) {
  if (!row) return null;
  return {
    id: row.id,
    instrument: row.instrument,
    status: row.status,
    trigger: row.trigger,
    model: row.model,
    report: row.report,
    sourceCount: row.sources.length,
    calendar: row.calendar_snapshot,
    technical: row.technical_summary,
    usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, webSearchCalls: row.web_search_calls, costUsd: row.cost_usd === null ? null : Number(row.cost_usd) },
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    fresh: freshness.fresh,
    staleReason: freshness.reason,
  };
}
export type ResearchView = NonNullable<ReturnType<typeof rowView>>;

const COLUMNS = `id,instrument,currencies,trigger,status,model,report,sources,calendar_snapshot,technical_summary,input_tokens,output_tokens,web_search_calls,cost_usd::text,error,created_at,expires_at`;

export async function latestCompleteRow(instrument: string) {
  return (await query<ResearchRow>(`SELECT ${COLUMNS} FROM market_research WHERE instrument=$1 AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1`, [instrument])).rows[0] ?? null;
}

export const releasedOf = (events: EconomicCalendarEvent[] | null, now: number) =>
  (events ?? []).filter((event) => event.actual !== null && Number.isFinite(Date.parse(event.timestamp)) && Date.parse(event.timestamp) <= now).map((event) => ({ title: event.title, currency: event.currency, impact: event.impact, at: new Date(event.timestamp).toISOString() }));

/** Latest research for a pair with its freshness; never calls OpenAI. */
export async function latestResearch(instrument: string, now = Date.now()) {
  if (!databaseConfigured()) return { research: null, configured: false, job: null, running: false };
  const [row, events, job] = await Promise.all([latestCompleteRow(instrument), calendarEvents(), latestJob(instrument)]);
  return {
    research: rowView(row, researchFreshness(row, releasedOf(events, now), now)),
    configured: researchConfig().apiKey !== null,
    job,
    running: job !== null && ACTIVE_JOB.includes(job.status),
  };
}

export type JobRow = {
  id: string; instrument: string; currencies: string[]; trigger: Trigger; horizon: string; model: string; effort: string;
  status: "QUEUED" | "RESEARCHING" | "VALIDATING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
  openai_response_id: string | null; research_id: string; calendar_snapshot: CalendarSnapshot | null; technical_summary: TechnicalSummary | null;
  provider_status: "queued" | "in_progress" | null;
  submit_attempts: number; poll_failures: number; lease_owner: string | null;
  input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; web_search_calls: number | null;
  sources_count: number | null; cost_usd: string | null; validation_drops: number | null; error: string | null;
  created_at: Date; started_at: Date | null; completed_at: Date | null;
};
export const JOB_COLUMNS = `id,instrument,currencies,trigger,horizon,model,effort,status,provider_status,openai_response_id,research_id,calendar_snapshot,technical_summary,
  submit_attempts,poll_failures,lease_owner,input_tokens,output_tokens,reasoning_tokens,web_search_calls,sources_count,cost_usd::text,validation_drops,error,
  created_at,started_at,completed_at`.replace(/\s+/g, "");
const ACTIVE_JOB: string[] = ["QUEUED", "RESEARCHING", "VALIDATING"];

/** A job as the app shows it: verified states only, no invented progress. */
export function jobView(row: JobRow) {
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
  const status = row.status === "RESEARCHING" && row.provider_status === "queued" ? "QUEUED" : row.status;
  return {
    id: row.id, instrument: row.instrument, status, trigger: row.trigger, horizon: row.horizon, model: row.model, effort: row.effort,
    researchId: row.status === "COMPLETED" ? row.research_id : null, error: row.error,
    createdAt: iso(row.created_at)!, startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
    usage: {
      inputTokens: row.input_tokens, outputTokens: row.output_tokens, reasoningTokens: row.reasoning_tokens, webSearchCalls: row.web_search_calls,
      sources: row.sources_count, costUsd: row.cost_usd === null ? null : Number(row.cost_usd), validationDrops: row.validation_drops,
    },
  };
}
export type ResearchJobView = ReturnType<typeof jobView>;

/** The pair's running job, else its latest job from the last day (to show a failure). */
async function latestJob(instrument: string): Promise<ResearchJobView | null> {
  const found = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM research_jobs WHERE instrument=$1 AND (status IN ('QUEUED','RESEARCHING','VALIDATING') OR created_at > now() - interval '1 day')
      ORDER BY (status IN ('QUEUED','RESEARCHING','VALIDATING')) DESC, created_at DESC LIMIT 1`,
    [instrument],
  ).catch(() => ({ rows: [] as JobRow[] }));
  return found.rows[0] ? jobView(found.rows[0]) : null;
}

/** Research served from cache since this server started (Analyze presses that cost nothing). */
export const cacheHits = { count: 0, since: new Date().toISOString() };

/** The research a new plan is generated against, if fresh: frozen into the plan. */
export async function freshResearchFor(instrument: string, now = Date.now()) {
  const { research } = await latestResearch(instrument, now);
  return research && research.fresh && isSupportedSchema(research.report?.schemaVersion) ? research : null;
}
