import { newsImpactReport, type NewsMetrics } from "../src/news-research.js";
import { calendarCoverage } from "../src/news-tagging.js";

/**
 * Print the news-impact breakdowns.
 *
 *   npm run research:news-report
 *
 * Reports numbers only. Whether news explains the losses is a question for the
 * reader; a small sample in a bucket means the bucket says nothing yet.
 */
const MIN_INTERPRETABLE = 30;

const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

function show(title: string, rows: NewsMetrics[]) {
  console.log(`\n${title}`);
  if (rows.length === 0) { console.log("   (no trades)"); return; }
  console.table(rows.map((row) => ({
    group: row.group,
    trades: row.trades,
    wins: row.wins,
    losses: row.losses,
    win_rate: pct(row.winRate),
    total_R: row.totalR.toFixed(2),
    net_E: row.netE === null ? "-" : row.netE.toFixed(4),
    reliable: row.trades >= MIN_INTERPRETABLE ? "" : "too few",
  })));
}

const report = await newsImpactReport();

console.log("=".repeat(78));
console.log("FOREX NEWS IMPACT REPORT");
console.log("=".repeat(78));

show("OVERALL", [report.overall]);
show("BY NEWS TAG", report.byNewsTag);
show("BY FAMILY", report.byFamily);
show("BY FAMILY + NEWS TAG", report.byFamilyAndNews);
show("MOMENTUM: original vs inverted", report.momentumVariants);
show("MOMENTUM VARIANT + NEWS TAG  <- the experiment's question", report.momentumByNews);
show("BY PAIR + NEWS TAG", report.byPairAndNews);
show("BY NEWS CURRENCY", report.byNewsCurrency);
show("BY SESSION + NEWS TAG", report.bySessionAndNews);
show("BY NEWS EVENT NAME", report.byEventName);

const coverage = await calendarCoverage();
console.log("\n" + "-".repeat(78));
console.log("DATA COVERAGE — read before drawing any conclusion");
console.table([{
  resolved_trades: report.sampleSize,
  stored_events: coverage.events,
  calendar_from: coverage.first_event?.slice(0, 16) ?? "-",
  calendar_to: coverage.last_event?.slice(0, 16) ?? "-",
  trades_with_calendar_nearby: coverage.tradesWithCalendarNearby,
}]);

const uncovered = coverage.trades - coverage.tradesWithCalendarNearby;
if (uncovered > 0) {
  console.log(`\n  ${uncovered} of ${coverage.trades} trades have no calendar data within a day of entry.`);
  console.log("  Their NO_NEWS tag means 'nothing on record', NOT 'no news occurred'. The");
  console.log("  ForexFactory feed serves the current week only, so history accrues from the");
  console.log("  first ingest forward and earlier trades cannot be tagged retroactively.");
}
const thin = report.byNewsTag.filter((row) => row.trades > 0 && row.trades < MIN_INTERPRETABLE).map((row) => row.group);
if (thin.length) {
  console.log(`\n  Buckets below ${MIN_INTERPRETABLE} trades (${thin.join(", ")}) are not yet interpretable.`);
}

process.exit(0);
