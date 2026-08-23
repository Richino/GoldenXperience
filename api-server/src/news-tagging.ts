import { query } from "./database.js";
import {
  classifyNewsImpact, currenciesForPair, DEFAULT_NEWS_WINDOWS,
  type NewsEventInput, type NewsTagResult, type NewsWindowConfig,
} from "../../frontend/src/lib/news/impact-tagging.js";

/**
 * News impact tagging — database glue around the pure classifier.
 *
 * RESEARCH ONLY. Nothing in this module is consulted before or during a trade
 * decision. It records what the calendar looked like around a trade so a later
 * analyst can ask whether news explains the losses. Every entry point is
 * written to fail soft: a calendar problem must never interrupt trading.
 */

export interface CalendarEventRecord {
  id: string;
  currency: string;
  title: string;
  timestamp: string;
  impact: number;
  region?: string | null;
  forecast?: string | null;
  previous?: string | null;
  actual?: string | null;
}

/**
 * Persist calendar events.
 *
 * Upsert on the feed's natural key, so re-ingesting the same week refreshes
 * values rather than duplicating rows. The feed only ever publishes the current
 * week, so this is the only mechanism by which a historical calendar comes to
 * exist at all — every ingest widens what can later be backfilled.
 */
export async function ingestCalendarEvents(events: readonly CalendarEventRecord[], source = "forex_factory") {
  let stored = 0;
  for (const event of events) {
    if (!event?.id || !event.currency || !event.timestamp) continue;
    const eventTime = new Date(event.timestamp);
    if (Number.isNaN(eventTime.getTime())) continue;
    const result = await query(
      `INSERT INTO economic_calendar_events(id,currency,title,event_time,impact,region,forecast,previous,actual,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id) DO UPDATE SET
         impact=EXCLUDED.impact, forecast=EXCLUDED.forecast, previous=EXCLUDED.previous,
         actual=EXCLUDED.actual, title=EXCLUDED.title, updated_at=now()`,
      [event.id, event.currency.trim().toUpperCase(), event.title, eventTime.toISOString(),
       Number.isFinite(Number(event.impact)) ? Number(event.impact) : 0,
       event.region ?? null, event.forecast ?? null, event.previous ?? null, event.actual ?? null, source],
    );
    stored += result.rowCount ?? 0;
  }
  return { stored, received: events.length };
}

/** The widest window any rule can reach, so the candidate query loads enough. */
function lookbackMinutes(config: NewsWindowConfig) {
  return Math.max(config.highImpactWindowMinutes, config.nearWindowMinutes, config.highImpactNearWindowMinutes);
}

/**
 * Load the events that could possibly match a trade.
 *
 * Filtered to the pair's own two currencies and to the widest window, so the
 * classifier receives a small candidate set. Relevance is still decided by the
 * pure function — this only avoids reading the entire calendar per trade.
 */
export async function loadCandidateEvents(
  pair: string,
  entryTime: string | Date,
  config: NewsWindowConfig = DEFAULT_NEWS_WINDOWS,
): Promise<NewsEventInput[]> {
  const currencies = currenciesForPair(pair);
  if (currencies.length === 0) return [];
  const entry = new Date(entryTime);
  if (Number.isNaN(entry.getTime())) return [];
  const rows = await query<{ id: string; title: string; currency: string; impact: number; event_time: string }>(
    `SELECT id,title,currency,impact,event_time::text AS event_time
     FROM economic_calendar_events
     WHERE currency = ANY($1::text[])
       AND event_time BETWEEN $2::timestamptz - make_interval(mins => $3::int)
                          AND $2::timestamptz + make_interval(mins => $3::int)
     ORDER BY event_time, id`,
    [currencies, entry.toISOString(), lookbackMinutes(config)],
  );
  return rows.rows.map((row) => ({
    id: row.id, title: row.title, currency: row.currency,
    impact: Number(row.impact), timestamp: row.event_time,
  }));
}

/**
 * Compute and store the news context for one trade.
 *
 * Idempotent: the classifier is pure and the write is a plain UPDATE of the
 * news columns only, so running it again over the same trade and the same
 * calendar rewrites identical values. No other column is touched, and no row
 * is inserted or deleted.
 */
export async function tagTradeWithNews(
  trade: { id: string; instrument: string; openedAt: string | Date },
  config: NewsWindowConfig = DEFAULT_NEWS_WINDOWS,
): Promise<NewsTagResult | null> {
  const events = await loadCandidateEvents(trade.instrument, trade.openedAt, config);
  const result = classifyNewsImpact({ pair: trade.instrument, entryTime: trade.openedAt }, events, config);
  await query(
    `UPDATE paper_strategy_trades SET
       news_impact_tag=$2, news_currency=$3, news_event_name=$4, news_event_time=$5,
       news_minutes_from_news=$6, news_impact_level=$7, news_matched_event_ids=$8::text[],
       news_tagged_at=now(), news_window_config=$9::jsonb, updated_at=now()
     WHERE id=$1`,
    [trade.id, result.tag, result.currency, result.eventName, result.eventTime,
     result.minutesFromNews, result.impactLevel, result.matchedEventIds,
     JSON.stringify(config)],
  );
  return result;
}

/**
 * Fire-and-forget tagging for a freshly opened trade.
 *
 * Deliberately swallows every error and returns void. This runs AFTER the trade
 * exists and cannot alter it: the feature is research-only, and a calendar
 * outage must never propagate into the trading path.
 */
export async function tagNewTradeSafely(trade: { id: string; instrument: string; openedAt: string | Date }) {
  try {
    await tagTradeWithNews(trade);
  } catch (error) {
    console.error("[news-tagging] could not tag trade", trade.id, error);
  }
}

export interface BackfillOptions {
  config?: NewsWindowConfig;
  /** Re-tag trades that already carry a tag. Off by default. */
  force?: boolean;
  /** Restrict to one instrument. */
  instrument?: string;
}

/**
 * Backfill news tags across existing trades.
 *
 * Safe to run repeatedly. Without `force` it only fills trades that have no tag
 * yet, so a re-run is a no-op; with `force` it recomputes every trade, which is
 * the correct move after the windows change. Either way the classifier is
 * deterministic, so the same trades and calendar yield the same tags.
 */
export async function backfillNewsTags(options: BackfillOptions = {}) {
  const config = options.config ?? DEFAULT_NEWS_WINDOWS;
  const rows = await query<{ id: string; instrument: string; opened_at: string }>(
    `SELECT id,instrument,COALESCE(opened_at,decision_time)::text AS opened_at
     FROM paper_strategy_trades
     WHERE ($1::boolean OR news_impact_tag IS NULL)
       AND ($2::text IS NULL OR instrument=$2)
       AND COALESCE(opened_at,decision_time) IS NOT NULL
     ORDER BY COALESCE(opened_at,decision_time)`,
    [options.force ?? false, options.instrument ?? null],
  );

  const counts: Record<string, number> = { NO_NEWS: 0, NEAR_NEWS: 0, HIGH_IMPACT_NEWS: 0 };
  let tagged = 0;
  for (const row of rows.rows) {
    const result = await tagTradeWithNews({ id: row.id, instrument: row.instrument, openedAt: row.opened_at }, config);
    if (result) { counts[result.tag] = (counts[result.tag] ?? 0) + 1; tagged += 1; }
  }
  return { considered: rows.rows.length, tagged, counts };
}

/**
 * How much of the trade history the stored calendar can actually speak to.
 *
 * Reported alongside every backfill because a NO_NEWS tag on a trade that falls
 * outside the calendar's coverage means "no data", not "no news", and the two
 * must never be read as the same thing.
 */
export async function calendarCoverage() {
  const calendar = await query<{ events: number; first_event: string | null; last_event: string | null }>(
    `SELECT count(*)::int AS events, min(event_time)::text AS first_event, max(event_time)::text AS last_event
     FROM economic_calendar_events`,
  );
  const trades = await query<{ trades: number; first_trade: string | null; last_trade: string | null }>(
    `SELECT count(*)::int AS trades, min(COALESCE(opened_at,decision_time))::text AS first_trade,
            max(COALESCE(opened_at,decision_time))::text AS last_trade
     FROM paper_strategy_trades`,
  );
  const covered = await query<{ covered: number }>(
    `SELECT count(*)::int AS covered FROM paper_strategy_trades t
     WHERE EXISTS (
       SELECT 1 FROM economic_calendar_events e
       WHERE e.event_time BETWEEN COALESCE(t.opened_at,t.decision_time) - interval '1 day'
                              AND COALESCE(t.opened_at,t.decision_time) + interval '1 day')`,
  );
  return {
    ...calendar.rows[0]!,
    ...trades.rows[0]!,
    tradesWithCalendarNearby: covered.rows[0]!.covered,
  };
}
