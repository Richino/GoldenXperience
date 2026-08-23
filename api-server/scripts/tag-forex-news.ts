import { backfillNewsTags, calendarCoverage, ingestCalendarEvents } from "../src/news-tagging.js";
import { getAllCalendarEvents } from "../../frontend/src/lib/calendar/forex-factory.js";
import { DEFAULT_NEWS_WINDOWS, type NewsWindowConfig } from "../../frontend/src/lib/news/impact-tagging.js";
import { query } from "../src/database.js";

/**
 * Populate or recalculate the news impact tags on existing Forex trades.
 *
 * Idempotent. The classifier is pure and order-independent, so re-running over
 * the same trades and the same calendar rewrites identical values; only the
 * news_* columns are written, and no row is ever inserted or deleted.
 *
 *   npm run research:tag-forex-news              fill untagged trades only
 *   npm run research:tag-forex-news -- --force   recompute every trade
 *   npm run research:tag-forex-news -- --ingest  fetch the live calendar first
 *   npm run research:tag-forex-news -- --instrument EUR_USD
 *   npm run research:tag-forex-news -- --high-window 60 --near-window 45
 *
 * RESEARCH ONLY: this touches no strategy, no risk figure and no execution.
 */
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const numeric = (name: string, fallback: number) => {
  const raw = value(name);
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const config: NewsWindowConfig = {
  ...DEFAULT_NEWS_WINDOWS,
  highImpactWindowMinutes: numeric("high-window", DEFAULT_NEWS_WINDOWS.highImpactWindowMinutes),
  nearWindowMinutes: numeric("near-window", DEFAULT_NEWS_WINDOWS.nearWindowMinutes),
  highImpactNearWindowMinutes: numeric("high-near-window", DEFAULT_NEWS_WINDOWS.highImpactNearWindowMinutes),
};

console.log("News impact tagging");
console.log(`  windows: high +/-${config.highImpactWindowMinutes}m, near +/-${config.nearWindowMinutes}m, `
  + `high-near +/-${config.highImpactNearWindowMinutes}m`);
console.log(`  mode   : ${flag("force") ? "FORCE (recompute every trade)" : "fill untagged only"}`);

if (flag("ingest")) {
  try {
    // The whole week, not the UI snapshot: that one is filtered to upcoming
    // events, which would store nothing at all when run after the week's
    // releases have passed.
    const events = await getAllCalendarEvents();
    const result = await ingestCalendarEvents(events);
    console.log(`  ingest : ${result.received} events received, ${result.stored} written`);
  } catch (error) {
    console.error("  ingest : FAILED —", error instanceof Error ? error.message : error);
  }
}

const before = await query<{ tag: string | null; n: number }>(
  `SELECT news_impact_tag AS tag, count(*)::int AS n FROM paper_strategy_trades GROUP BY 1 ORDER BY 1 NULLS FIRST`);

const result = await backfillNewsTags({ config, force: flag("force"), instrument: value("instrument") });

const after = await query<{ tag: string | null; n: number }>(
  `SELECT news_impact_tag AS tag, count(*)::int AS n FROM paper_strategy_trades GROUP BY 1 ORDER BY 1 NULLS FIRST`);

console.log(`\nconsidered ${result.considered} trades, tagged ${result.tagged}`);
console.log("\nBEFORE:");
console.table(before.rows.map((r) => ({ tag: r.tag ?? "(untagged)", trades: r.n })));
console.log("AFTER:");
console.table(after.rows.map((r) => ({ tag: r.tag ?? "(untagged)", trades: r.n })));

const coverage = await calendarCoverage();
console.log("\nCALENDAR COVERAGE");
console.table([{
  stored_events: coverage.events,
  calendar_from: coverage.first_event?.slice(0, 16) ?? "-",
  calendar_to: coverage.last_event?.slice(0, 16) ?? "-",
  trades: coverage.trades,
  trades_from: coverage.first_trade?.slice(0, 16) ?? "-",
  trades_to: coverage.last_trade?.slice(0, 16) ?? "-",
  trades_with_calendar_nearby: coverage.tradesWithCalendarNearby,
}]);

// The single most important caveat, printed every run so it cannot be missed.
const uncovered = coverage.trades - coverage.tradesWithCalendarNearby;
if (uncovered > 0) {
  console.log(`\n  WARNING: ${uncovered} of ${coverage.trades} trades have NO calendar data within a day of the entry.`);
  console.log("  Those trades are tagged NO_NEWS because nothing is on record, which is NOT the same as");
  console.log("  'no news occurred'. Exclude them, or treat NO_NEWS as 'unknown', when reading the report.");
  console.log("  The ForexFactory feed publishes the current week only, so history accrues from first ingest onward.");
}

process.exit(0);
