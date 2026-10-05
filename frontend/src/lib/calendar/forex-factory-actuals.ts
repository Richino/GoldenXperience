import type { EconomicCalendarEvent } from "@/lib/oanda/calendar";

/**
 * Released values ("actual") for the Forex Factory events.
 *
 * The weekly Forex Factory export carries only scheduled entries, never a
 * released value, and its calendar page refuses server requests. TradingView's
 * public economic calendar has the actuals, so each released event is matched
 * to a TradingView event in the same currency (and euro-area country), at the
 * same time, with the most similar title, and its actual is copied over.
 */
const TRADINGVIEW_URL = "https://economic-calendar.tradingview.com/events";
const COUNTRIES = "US,EU,DE,FR,IT,ES,GB,JP,AU,NZ,CA,CH";

/** Values land within a minute or two of a release; refetch at most this often. */
const ACTUALS_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Only events released this recently trigger a fetch for their value. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Below this title similarity a same-minute event is a different release. */
const MIN_TITLE_SIMILARITY = 0.5;
/**
 * Forex Factory lists some releases at a placeholder time (German state-led
 * CPI, for one). Off the minute, a same-day event must match much more closely.
 */
const SAME_DAY_WINDOW_MS = 12 * 60 * 60 * 1000;
const SAME_DAY_MIN_SIMILARITY = 0.7;

export type TradingViewEvent = {
  title: string;
  country: string;
  currency: string;
  date: string;
  actual: number | null;
  unit?: string | null;
  scale?: string | null;
};

/** Forex Factory names that share no useful words with TradingView's. */
const TITLE_ALIASES: Record<string, string> = {
  "unemployment claims": "initial jobless claims",
  "non-farm employment change": "non farm payrolls",
  "fomc meeting minutes": "fomc minutes",
  "prelim uom consumer sentiment": "michigan consumer sentiment prel",
  "prelim uom inflation expectations": "michigan inflation expectations prel",
  "revised uom consumer sentiment": "michigan consumer sentiment final",
  "revised uom inflation expectations": "michigan inflation expectations final",
};

/** Central-bank rate decisions: each bank's own name for its rate. */
const RATE_DECISION = /\b(cash|federal funds|main refinancing|official bank|policy|overnight) rate\b/;

const WORD_SYNONYMS: Record<string, string> = {
  "m/m": "mom", "y/y": "yoy", "q/q": "qoq", cpi: "inflation", prelim: "prel", flash: "prel", advance: "adv",
};

const PERIODS = new Set(["mom", "yoy", "qoq"]);

/** Words too generic to tell two releases apart ("GDP Growth Rate" vs "GDP"). */
const IGNORED_WORDS = new Set(["the", "of", "and", "rate", "growth", "estimate"]);

/** Euro-area releases name the country in the title; TradingView splits them by country. */
const EURO_COUNTRY_WORDS: Record<string, string> = { german: "DE", french: "FR", italian: "IT", spanish: "ES" };

function tokens(title: string) {
  return new Set(
    title.toLowerCase()
      .replace(/s&p global|hcob/g, " ")
      .split(/[\s,()]+/)
      .map((word) => WORD_SYNONYMS[word] ?? word.replace(/[^a-z0-9]/g, ""))
      .filter((word) => word && !IGNORED_WORDS.has(word)),
  );
}

function similarity(left: Set<string>, right: Set<string>) {
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / new Set([...left, ...right]).size;
}

/** TradingView's number in Forex Factory's style: the decimals of the forecast/previous. */
function formatActual(match: TradingViewEvent, like: EconomicCalendarEvent) {
  if (match.actual === null || !Number.isFinite(match.actual)) return null;
  const sample = like.forecast ?? like.previous ?? "";
  const decimals = sample.match(/\.(\d+)/)?.[1]?.length ?? (/\d/.test(sample) ? 0 : null);
  const value = decimals === null ? String(match.actual) : match.actual.toFixed(decimals);
  return `${value}${match.scale ?? ""}${match.unit === "%" ? "%" : ""}`;
}

/** The TradingView event that is this Forex Factory release, or null. */
export function matchTradingViewEvent(event: EconomicCalendarEvent, candidates: TradingViewEvent[]) {
  const time = Date.parse(event.timestamp);
  let title = event.title.toLowerCase();
  let country: string | null = event.currency === "EUR" ? "EU" : null;
  for (const [word, code] of Object.entries(EURO_COUNTRY_WORDS)) {
    if (title.startsWith(`${word} `)) {
      country = code;
      title = title.slice(word.length + 1);
    }
  }
  const wanted = tokens(TITLE_ALIASES[title] ?? (RATE_DECISION.test(title) ? "interest rate decision" : title));
  let best: { event: TradingViewEvent; score: number } | null = null;
  for (const candidate of candidates) {
    const offset = Math.abs(Date.parse(candidate.date) - time);
    if (candidate.currency !== event.currency || offset > SAME_DAY_WINDOW_MS) continue;
    if (country && candidate.country !== country) continue;
    const candidateTokens = tokens(candidate.title);
    // "Job Cuts y/y" is not "Job Cuts": a stated period must agree.
    if ([...wanted].some((word) => PERIODS.has(word) && !candidateTokens.has(word))) continue;
    const sameMinute = offset <= 60_000;
    const similar = similarity(wanted, candidateTokens);
    if (similar < (sameMinute ? MIN_TITLE_SIMILARITY : SAME_DAY_MIN_SIMILARITY)) continue;
    // A same-minute match always beats a closer title at another time.
    const score = similar + (sameMinute ? 1 : 0);
    if (!best || score > best.score) best = { event: candidate, score };
  }
  return best?.event ?? null;
}

let cache: { events: TradingViewEvent[]; fetchedAt: number } | null = null;
let inFlight: Promise<TradingViewEvent[]> | null = null;

async function fetchTradingView(from: number, to: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${TRADINGVIEW_URL}?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}&countries=${COUNTRIES}`;
    const response = await fetch(url, {
      headers: { Origin: "https://www.tradingview.com", "User-Agent": "Mozilla/5.0 (compatible; GoldenXperience/1.0)" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TradingView calendar returned ${response.status}.`);
    const body = (await response.json()) as { result?: TradingViewEvent[] };
    if (!Array.isArray(body.result)) throw new Error("TradingView calendar sent no events.");
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}

/** A data release still waiting for its value (speeches and holidays never get one). */
function awaitingActual(event: EconomicCalendarEvent, now: number) {
  const time = Date.parse(event.timestamp);
  return event.actual === null && (event.forecast !== null || event.previous !== null)
    && time <= now && now - time <= LOOKBACK_MS;
}

/**
 * The events with `actual` filled in for released data. Fetches only while a
 * recent release is still missing its value, at most every five minutes, and
 * never fails the calendar: on any error the events come back unchanged (or
 * with values from the last good fetch).
 */
export async function withActuals(events: EconomicCalendarEvent[], now = Date.now()) {
  const released = events.filter((event) => Date.parse(event.timestamp) <= now);
  if (!released.length) return events;
  const missing = released.some((event) => awaitingActual(event, now)
    && !(cache && matchTradingViewEvent(event, cache.events)?.actual != null));
  if (missing && (!cache || now - cache.fetchedAt >= ACTUALS_TTL_MS)) {
    const from = Math.min(...released.map((event) => Date.parse(event.timestamp))) - SAME_DAY_WINDOW_MS;
    try {
      const fetched = await (inFlight ??= fetchTradingView(from, now + SAME_DAY_WINDOW_MS).finally(() => {
        inFlight = null;
      }));
      cache = { events: fetched, fetchedAt: Date.now() };
    } catch (error) {
      console.warn("[calendar] actuals unavailable:", error instanceof Error ? error.message : error);
      // Back off for the TTL rather than retrying on every request.
      cache = { events: cache?.events ?? [], fetchedAt: Date.now() };
    }
  }
  if (!cache?.events.length) return events;
  const source = cache.events;
  return events.map((event) => {
    if (event.actual !== null || Date.parse(event.timestamp) > now) return event;
    const match = matchTradingViewEvent(event, source);
    const actual = match ? formatActual(match, event) : null;
    return actual ? { ...event, actual } : event;
  });
}
