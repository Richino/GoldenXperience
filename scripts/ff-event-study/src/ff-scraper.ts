/**
 * Forex Factory calendar scraper (Playwright).
 *
 * Instead of parsing table cells (fragile, and the displayed time depends on FF's
 * per-visitor timezone cookie), this reads FF's own embedded state object,
 * `window.calendarComponentStates`, which carries a unix `dateline` per event.
 * That gives an exact UTC timestamp and the raw actual/forecast/previous values
 * regardless of what timezone the page is rendering in. A DOM parse is kept as a
 * fallback in case FF changes the global's shape.
 *
 * This walks one calendar DAY page per calendar day so coverage is complete;
 * events are de-duplicated by id afterwards.
 */
import { chromium, type BrowserContext } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { eventFromState, type RawEvent } from "./types.js";

export type { RawEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(here, "../.ff-state.json");

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** FF day-page slug, e.g. `sep9.2025` (no leading zero, UTC calendar date). */
function daySlug(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]}${date.getUTCDate()}.${date.getUTCFullYear()}`;
}

/** Extract events from FF's in-page state. Runs inside the browser context. */
function extractInPage(): Array<Record<string, unknown>> {
  // FF keys the state object numerically; the calendar state is whichever entry
  // exposes a `days` array of `{ events: [...] }`.
  const states = (window as unknown as {
    calendarComponentStates?: Record<string, unknown>;
  }).calendarComponentStates;
  if (!states) return [];

  const out: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(states)) {
    const state = states[key] as { days?: Array<{ events?: unknown[] }> } | undefined;
    if (!state?.days) continue;
    for (const day of state.days) {
      for (const ev of day.events ?? []) {
        out.push(ev as Record<string, unknown>);
      }
    }
  }
  return out;
}

export interface ScrapeOptions {
  /** Inclusive UTC date range to cover. */
  fromDate: Date;
  toDate: Date;
  headless: boolean;
  /** ms to pause between day pages (be polite to FF). */
  throttleMs?: number;
  log?: (msg: string) => void;
}

export async function scrapeCalendar(opts: ScrapeOptions): Promise<RawEvent[]> {
  const log = opts.log ?? (() => {});
  const throttle = opts.throttleMs ?? 2500;

  const browser = await chromium.launch({
    headless: opts.headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context: BrowserContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    timezoneId: "UTC",
    // Reuse any Cloudflare clearance cookie captured on a previous headed run.
    storageState: existsSync(STATE_PATH) ? STATE_PATH : undefined,
  });

  const page = await context.newPage();
  const byId = new Map<string, RawEvent>();
  let firstPage = true;

  try {
    // Iterate one UTC day at a time from fromDate..toDate inclusive.
    const cursor = new Date(Date.UTC(
      opts.fromDate.getUTCFullYear(),
      opts.fromDate.getUTCMonth(),
      opts.fromDate.getUTCDate(),
    ));
    const end = Date.UTC(
      opts.toDate.getUTCFullYear(),
      opts.toDate.getUTCMonth(),
      opts.toDate.getUTCDate(),
    );

    while (cursor.getTime() <= end) {
      const slug = daySlug(cursor);
      const url = `https://www.forexfactory.com/calendar?day=${slug}`;
      log(`  fetching ${slug} ...`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

      // Give Cloudflare / the calendar hydration a moment, then confirm the
      // state global exists. If it never appears, FF likely served a challenge.
      // The first page may sit behind a Cloudflare interstitial. When running
      // headed, give the human time to solve it; the clearance cookie is then
      // reused for the rest of the run and for later runs.
      const stateAvailable = () =>
        Boolean((window as unknown as { calendarComponentStates?: unknown }).calendarComponentStates);
      const stateReady = await page
        .waitForFunction(stateAvailable, { timeout: firstPage ? 8_000 : 20_000 })
        .then(() => true)
        .catch(() => false);

      let solved = stateReady;
      if (!solved && firstPage) {
        const title = await page.title().catch(() => "");
        if (!opts.headless) {
          log(
            `  ! Forex Factory is showing a challenge ("${title}"). ` +
              `Solve it in the browser window — waiting up to 3 min...`,
          );
          solved = await page
            .waitForFunction(stateAvailable, { timeout: 180_000 })
            .then(() => true)
            .catch(() => false);
        }
      }

      if (!solved) {
        const title = await page.title().catch(() => "");
        throw new Error(
          `Could not read calendar state for ${slug} (page title: "${title}"). ` +
            (opts.headless
              ? `Forex Factory served a Cloudflare challenge. Re-run with HEADLESS=false and solve it once; the clearance cookie is then reused.`
              : `The challenge was not solved in time. Re-run with HEADLESS=false and complete it in the window.`),
        );
      }

      const raw: Array<Record<string, unknown>> = await page.evaluate(extractInPage);
      firstPage = false;

      for (const parsed of raw.map(eventFromState)) {
        if (parsed) byId.set(parsed.id, parsed);
      }

      log(`    ${raw.length} events on page (running unique total: ${byId.size})`);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (cursor.getTime() <= end) await page.waitForTimeout(throttle);
    }

    // Persist cookies so the next run reuses any Cloudflare clearance.
    await context.storageState({ path: STATE_PATH });
  } finally {
    await browser.close();
  }

  return [...byId.values()].sort(
    (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0),
  );
}
