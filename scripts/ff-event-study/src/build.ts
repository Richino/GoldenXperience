/**
 * Orchestrator: scrape the last N days of the Forex Factory calendar, enrich
 * each event with OANDA market context, and write one JSON dataset.
 *
 *   npx tsx src/build.ts [--days=10] [--min-impact=low] [--out=out/...] [--no-market]
 *
 * Env: HEADLESS=false runs the browser headed (needed the first time / when FF
 * shows a Cloudflare challenge). OANDA creds are read from api-server/.env.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { marketContext, type MarketContext } from "./market.js";
import { IMPACT_RANK } from "./config.js";
import { OANDA_ENVIRONMENT } from "./oanda.js";
import { loadSavedEvents } from "./saved-provider.js";
import type { RawEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

interface RelatedEvent {
  minutesBefore: number;
  currency: string;
  title: string;
  impact: RawEvent["impact"];
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  sameCurrency: boolean;
}

interface StudyEvent {
  id: string;
  timestampUtc: string | null;
  currency: string;
  impact: RawEvent["impact"];
  title: string;
  historical: {
    actual: string | null;
    forecast: string | null;
    previous: string | null;
    revised: string | null;
  };
  relatedBefore: RelatedEvent[];
  market: MarketContext | null;
}

/** Same-UTC-day releases that landed before this event (context "released before"). */
function relatedBefore(target: RawEvent, all: RawEvent[]): RelatedEvent[] {
  if (target.timestampMs === null) return [];
  const dayStart = new Date(target.timestampMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  return all
    .filter(
      (e) =>
        e.id !== target.id &&
        e.timestampMs !== null &&
        e.timestampMs >= dayStartMs &&
        e.timestampMs < target.timestampMs!,
    )
    .map((e) => ({
      minutesBefore: Math.round((target.timestampMs! - e.timestampMs!) / 60_000),
      currency: e.currency,
      title: e.title,
      impact: e.impact,
      actual: e.actual,
      forecast: e.forecast,
      previous: e.previous,
      sameCurrency: e.currency === target.currency,
    }))
    // Same-currency first, then most recent, cap the noise.
    .sort((a, b) =>
      a.sameCurrency === b.sameCurrency
        ? a.minutesBefore - b.minutesBefore
        : a.sameCurrency ? -1 : 1,
    )
    .slice(0, 12);
}

async function main() {
  const days = Number(arg("days") ?? "10");
  const minImpact = (arg("min-impact") ?? "low").toLowerCase();
  const withMarket = !hasFlag("no-market");
  const headless = process.env.HEADLESS !== "false";
  const minRank = IMPACT_RANK[minImpact] ?? IMPACT_RANK.low;
  const inputDir = arg("input");
  const useFeed = hasFlag("feed");
  const curated = Boolean(inputDir) || useFeed;

  const now = new Date();
  const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(
    `Forex Factory event study\n` +
      `  source     : ${
        useFeed ? "this-week feed" : inputDir ? `saved files (${inputDir})` : "live scrape"
      }\n` +
      `  range      : ${fromDate.toISOString().slice(0, 10)} -> ${now
        .toISOString()
        .slice(0, 10)} (${days} days)\n` +
      `  min impact : ${minImpact}\n` +
      `  market ctx : ${withMarket ? `yes (OANDA ${OANDA_ENVIRONMENT})` : "no"}\n` +
      (curated ? "" : `  headless   : ${headless}\n`),
  );

  let raw: RawEvent[];
  if (useFeed) {
    console.log("Fetching this week's feed...");
    const { fetchFeedEvents } = await import("./feed-provider.js");
    raw = await fetchFeedEvents((m) => console.log(m));
  } else if (inputDir) {
    console.log("Reading saved files...");
    const result = await loadSavedEvents(resolve(process.cwd(), inputDir), (m) => console.log(m));
    raw = result.events;
  } else {
    console.log("Scraping calendar...");
    // Import lazily so saved-file runs don't need Playwright/Chromium installed.
    const { scrapeCalendar } = await import("./ff-scraper.js");
    raw = await scrapeCalendar({
      fromDate,
      toDate: now,
      headless,
      log: (m) => console.log(m),
    });
  }

  // Live scrapes cover fixed day pages, so clip to the exact requested window.
  // Saved files are curated by the user — take whatever they provided as-is.
  const lower = fromDate.getTime();
  const upper = now.getTime();
  const inWindow = curated
    ? raw.filter((e) => e.timestampMs !== null)
    : raw.filter(
        (e) => e.timestampMs !== null && e.timestampMs >= lower && e.timestampMs <= upper,
      );
  const selected = inWindow.filter((e) => (IMPACT_RANK[e.impact] ?? 0) >= minRank);

  console.log(
    `\nScraped ${raw.length} events; ${inWindow.length} in window; ` +
      `${selected.length} at impact >= ${minImpact}.`,
  );

  const events: StudyEvent[] = [];
  let idx = 0;
  for (const e of selected) {
    idx++;
    let market: MarketContext | null = null;
    if (withMarket && e.timestampMs !== null) {
      process.stdout.write(
        `\r  market context ${idx}/${selected.length} (${e.currency} ${e.title.slice(0, 28)})           `,
      );
      try {
        market = await marketContext(e.currency, e.timestampMs);
      } catch (err) {
        console.warn(
          `\n  ! market context failed for "${e.title}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    events.push({
      id: e.id,
      timestampUtc: e.timestampMs !== null ? new Date(e.timestampMs).toISOString() : null,
      currency: e.currency,
      impact: e.impact,
      title: e.title,
      historical: {
        actual: e.actual,
        forecast: e.forecast,
        previous: e.previous,
        revised: e.revised,
      },
      relatedBefore: relatedBefore(e, inWindow),
      market,
    });
  }
  if (withMarket) process.stdout.write("\n");

  const outPath = resolve(
    here,
    "..",
    arg("out") ?? `out/ff-event-study-${now.toISOString().slice(0, 10)}.json`,
  );
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    JSON.stringify(
      {
        generatedAt: now.toISOString(),
        rangeDays: days,
        minImpact,
        marketSource: withMarket ? `oanda:${OANDA_ENVIRONMENT}` : null,
        eventCount: events.length,
        events,
      },
      null,
      2,
    ),
  );

  console.log(`\nWrote ${events.length} events -> ${outPath}`);
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
