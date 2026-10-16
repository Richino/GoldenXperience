import { getEconomicCalendar } from "../../../frontend/src/lib/calendar/forex-factory.js";
import { currenciesOf, isKnownInstrument } from "../../../frontend/src/lib/instruments/catalog.js";
import type { EconomicCalendarEvent } from "../../../frontend/src/lib/oanda/calendar.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import { databaseConfigured, query } from "../database.js";
import { generateTradePlans } from "../trade-plan-generator.js";
import { loadGeneratorMarket } from "../trade-plan-service.js";
import { buildCalendarSnapshot, type CalendarSnapshot } from "./calendar-snapshot.js";
import { researchConfig, runResearch, type TechnicalSummary } from "./openai-research.js";
import type { IntelligenceReport } from "./research-report.js";

/**
 * Market intelligence orchestration: cache, freshness, budget and schedule.
 *
 * Research is expensive, so it runs only when it is needed:
 *   - Analyze reuses the latest research for the pair while it is fresh;
 *   - it is stale after RESEARCH_TTL_HOURS, or as soon as a high-impact
 *     release for either currency has come out since it was made;
 *   - the scheduler refreshes stale research only for pairs with accepted plans;
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
  report: IntelligenceReport | null;
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
  };
}

/** Freshness of a research row against the clock and the calendar. Pure. */
export function researchFreshness(row: { created_at: Date | string; expires_at: Date | string | null; currencies: string[] } | null, released: Array<{ currency: string; impact: number; at: string }>, now: number) {
  if (!row) return { fresh: false, reason: "No research yet." };
  const created = new Date(row.created_at).getTime();
  if (row.expires_at && now >= new Date(row.expires_at).getTime()) return { fresh: false, reason: "Research is older than its refresh window." };
  const newer = released.find((event) => event.impact >= 3 && row.currencies.includes(event.currency) && Date.parse(event.at) > created && Date.parse(event.at) <= now);
  if (newer) return { fresh: false, reason: `New high-impact ${newer.currency} release since the research.` };
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
  const r = rows.rows[0]!;
  const usage = {
    todayRuns: Number(r.today_runs), todayUsd: Number(r.today_usd ?? 0), monthRuns: Number(r.month_runs), monthUsd: Number(r.month_usd ?? 0),
    unknownCostRuns: Number(r.unknown_cost), monthInputTokens: Number(r.tokens_in ?? 0), monthOutputTokens: Number(r.tokens_out ?? 0), monthWebSearches: Number(r.searches ?? 0),
  };
  const settings = researchSettings();
  return { ...usage, settings, verdict: budgetVerdict(usage, settings), pricesConfigured: researchConfig().prices.inputPerMTok !== null };
}

async function calendarEvents(): Promise<EconomicCalendarEvent[] | null> {
  try {
    const calendar = await getEconomicCalendar();
    if (calendar.status.state !== "connected" || !calendar.data.connected || calendar.data.source === "mock") return null;
    return [...calendar.data.events, ...(calendar.data.recentEvents ?? [])];
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

async function latestComplete(instrument: string) {
  return (await query<ResearchRow>(`SELECT ${COLUMNS} FROM market_research WHERE instrument=$1 AND status='COMPLETE' ORDER BY created_at DESC LIMIT 1`, [instrument])).rows[0] ?? null;
}

const releasedOf = (events: EconomicCalendarEvent[] | null, now: number) =>
  (events ?? []).filter((event) => event.actual !== null && Date.parse(event.timestamp) <= now).map((event) => ({ currency: event.currency, impact: event.impact, at: event.timestamp }));

/** Latest research for a pair with its freshness; never calls OpenAI. */
export async function latestResearch(instrument: string, now = Date.now()) {
  if (!databaseConfigured()) return { research: null, configured: false };
  const [row, events] = await Promise.all([latestComplete(instrument), calendarEvents()]);
  return { research: rowView(row, researchFreshness(row, releasedOf(events, now), now)), configured: researchConfig().apiKey !== null };
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * Research a pair if it needs it: returns the cached research while fresh
 * (unless forced), otherwise runs one research call within the budget.
 * Concurrent requests for one pair share the same run.
 */
export async function refreshResearch(instrument: string, trigger: Trigger, options: { force?: boolean; now?: number } = {}) {
  if (!isKnownInstrument(instrument)) throw new Error("Unknown currency pair.");
  const existing = inFlight.get(instrument);
  if (existing) return existing as ReturnType<typeof doRefresh>;
  const run = doRefresh(instrument as MajorInstrument, trigger, options).finally(() => inFlight.delete(instrument));
  inFlight.set(instrument, run);
  return run;
}

async function doRefresh(instrument: MajorInstrument, trigger: Trigger, options: { force?: boolean; now?: number }) {
  const now = options.now ?? Date.now();
  const { base, quote } = currenciesOf(instrument);
  const [row, events] = await Promise.all([latestComplete(instrument), calendarEvents()]);
  const freshness = researchFreshness(row, releasedOf(events, now), now);
  if (row && freshness.fresh && !options.force) return { cached: true, research: rowView(row, freshness)!, budget: null };

  const settings = researchSettings();
  const usage = await researchUsage(now);
  const calendar = buildCalendarSnapshot({ events, currencies: [base, quote], now });
  if (!usage.verdict.allowed) {
    await query(
      `INSERT INTO market_research(instrument,currencies,trigger,status,calendar_snapshot,error) VALUES($1,$2,$3,'BUDGET_BLOCKED',$4::jsonb,$5)`,
      [instrument, [base, quote], trigger, JSON.stringify(calendar), usage.verdict.reason],
    );
    return { cached: Boolean(row), research: rowView(row, freshness), budget: usage.verdict.reason };
  }

  const technical = await technicalSummaryFor(instrument);
  const outcome = await runResearch({ instrument, currencies: [base, quote], technical, calendar, now });
  const inserted = await query<ResearchRow>(
    `INSERT INTO market_research(instrument,currencies,trigger,status,model,report,sources,calendar_snapshot,technical_summary,dropped,
                                 input_tokens,output_tokens,web_search_calls,cost_usd,error,expires_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16)
     RETURNING ${COLUMNS}`,
    [instrument, [base, quote], trigger, outcome.ok ? "COMPLETE" : "FAILED", outcome.model,
     outcome.ok ? JSON.stringify(outcome.report) : null, JSON.stringify(outcome.sources), JSON.stringify(calendar), JSON.stringify(technical),
     JSON.stringify(outcome.ok ? outcome.dropped : []), outcome.usage.inputTokens, outcome.usage.outputTokens, outcome.usage.webSearchCalls,
     outcome.usage.costUsd, outcome.ok ? null : outcome.error, new Date(now + settings.ttlHours * 3_600_000).toISOString()],
  );
  const fresh = inserted.rows[0]!;
  if (!outcome.ok) {
    // Keep showing the last good research (marked stale) with the reason this run failed.
    return { cached: Boolean(row), research: rowView(row, freshness), budget: null, error: outcome.error };
  }
  return { cached: false, research: rowView(fresh, { fresh: true, reason: null })!, budget: null };
}

/**
 * Scheduled refresh: only pairs with accepted, still-active plans, only when
 * their research is stale. Runs serially so one tick costs at most a few calls.
 */
export async function refreshDueResearch(now = Date.now()) {
  const settings = researchSettings();
  if (!settings.scheduleEnabled || !researchConfig().apiKey) return { refreshed: 0 };
  const pairs = await query<{ instrument: string }>(
    `SELECT DISTINCT instrument FROM trade_plans WHERE status IN ('APPROVED','MONITORING','CONFIRMED','NOTIFIED','FILLED')`,
  );
  const events = await calendarEvents();
  let refreshed = 0;
  for (const { instrument } of pairs.rows) {
    const row = await latestComplete(instrument);
    const freshness = researchFreshness(row, releasedOf(events, now), now);
    if (freshness.fresh) continue;
    const trigger: Trigger = row && freshness.reason?.startsWith("New high-impact") ? "RELEASE" : row ? "STALE" : "SCHEDULED";
    const result = await refreshResearch(instrument, trigger, { now });
    if (result.budget) break;
    refreshed += 1;
  }
  return { refreshed };
}

/** The research a new plan is generated against, if fresh: frozen into the plan. */
export async function freshResearchFor(instrument: string, now = Date.now()) {
  const { research } = await latestResearch(instrument, now);
  return research && research.fresh && research.report ? research : null;
}
