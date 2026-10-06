import { getAllCalendarEvents } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { TradingViewEvent } from "../../frontend/src/lib/calendar/forex-factory-actuals.js";
import { eventCurrencyPolarity } from "../../frontend/src/lib/news/event-polarity.js";
import { releaseVotes, SIGNALS, type SignalName, type SignalVotes } from "../../frontend/src/lib/news/release-prediction.js";
import { newsSurpriseHint, parseCalendarValue } from "../../frontend/src/lib/news/surprise-hint.js";
import { databaseConfigured, query } from "./database.js";

/**
 * News prediction journal.
 *
 * Every scheduled release with a beat/miss meaning gets one row: the call is
 * made and frozen before the release, then scored once the actual is out. The
 * call comes from whichever signal (or its inverse) has the best logged record
 * — per series once it has enough history, otherwise across all releases — so
 * the picker keeps learning as results come in. A year of TradingView history
 * is seeded once as "backfill" rows so learning does not start from zero.
 */

const TRADINGVIEW_URL = "https://economic-calendar.tradingview.com/events";
const COUNTRIES = "US,EU,DE,FR,IT,ES,GB,JP,AU,NZ,CA,CH";
const HISTORY_DAYS = 400;
/** TradingView caps a response at 2,000 events; ten days stays well under. */
const CHUNK_DAYS = 10;
const HISTORY_REFRESH_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A series needs this many scored releases before its own record is used. */
const MIN_SERIES_SAMPLES = 8;

type Candidate = `${SignalName}` | `${SignalName}:inverse`;

let history: { events: TradingViewEvent[]; fetchedAt: number } | null = null;

async function fetchChunk(from: number, to: number) {
  const url = `${TRADINGVIEW_URL}?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}&countries=${COUNTRIES}`;
  const response = await fetch(url, {
    headers: { Origin: "https://www.tradingview.com", "User-Agent": "Mozilla/5.0 (compatible; GoldenXperience/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TradingView calendar returned ${response.status}.`);
  const body = (await response.json()) as { result?: TradingViewEvent[] & Array<{ id?: string }> };
  return Array.isArray(body.result) ? body.result : [];
}

/** A year of releases; after the first load only the last few weeks are refetched. */
async function loadHistory(now: number) {
  if (history && now - history.fetchedAt < HISTORY_REFRESH_MS) return history.events;
  const from = history ? now - 21 * DAY_MS : now - HISTORY_DAYS * DAY_MS;
  const fetched: TradingViewEvent[] = [];
  for (let start = from; start < now + 8 * DAY_MS; start += CHUNK_DAYS * DAY_MS) {
    fetched.push(...await fetchChunk(start, start + CHUNK_DAYS * DAY_MS));
  }
  const byId = new Map<string, TradingViewEvent>();
  const key = (event: TradingViewEvent) => (event as { id?: string }).id ?? `${event.currency}|${event.title}|${event.date}`;
  for (const event of history?.events ?? []) byId.set(key(event), event);
  for (const event of fetched) byId.set(key(event), event);
  history = { events: [...byId.values()], fetchedAt: now };
  return history.events;
}

function numberString(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function outcomeOf(actual: number | null, forecast: number | null) {
  if (actual === null || forecast === null) return null;
  const epsilon = Math.max(Math.abs(forecast) * 0.001, 1e-9);
  return actual - forecast > epsilon ? "beat" : forecast - actual > epsilon ? "miss" : "inline";
}

type SignalRecord = Record<string, { n: number; hits: number }>;

/** Per-candidate records, overall and per series, from every scored release. */
async function loadRecords() {
  const rows = await query<{ series_key: string; signals: SignalVotes; outcome: "beat" | "miss" }>(
    "SELECT series_key, signals, outcome FROM news_predictions WHERE outcome IN ('beat', 'miss')",
  );
  const overall: SignalRecord = {};
  const bySeries = new Map<string, SignalRecord>();
  for (const row of rows.rows) {
    const series = bySeries.get(row.series_key) ?? {};
    bySeries.set(row.series_key, series);
    for (const signal of SIGNALS) {
      const vote = row.signals?.[signal] ?? 0;
      if (!vote) continue;
      const right = (vote > 0) === (row.outcome === "beat");
      for (const [name, hit] of [[signal, right], [`${signal}:inverse`, !right]] as const) {
        for (const record of [overall, series]) {
          record[name] ??= { n: 0, hits: 0 };
          record[name].n += 1;
          if (hit) record[name].hits += 1;
        }
      }
    }
  }
  return { overall, bySeries };
}

/** The candidate with the best smoothed hit rate among those voting on this event. */
function chooseCall(votes: SignalVotes, seriesKey: string, records: Awaited<ReturnType<typeof loadRecords>>) {
  const series = records.bySeries.get(seriesKey) ?? {};
  let best: { name: Candidate; score: number; vote: 1 | -1 } | null = null;
  for (const signal of SIGNALS) {
    const vote = votes[signal];
    if (!vote) continue;
    for (const inverse of [false, true]) {
      const name = (inverse ? `${signal}:inverse` : signal) as Candidate;
      const record = (series[name]?.n ?? 0) >= MIN_SERIES_SAMPLES ? series[name]! : records.overall[name] ?? { n: 0, hits: 0 };
      // Laplace smoothing; the plain "previous" rule wins ties as the default.
      const score = (record.hits + 1) / (record.n + 2) + (name === "previous" ? 1e-6 : 0);
      if (!best || score > best.score) best = { name, score, vote: (inverse ? -vote : vote) as 1 | -1 };
    }
  }
  return best ? { signal: best.name, call: best.vote > 0 ? ("beat" as const) : ("miss" as const) } : null;
}

async function seedBackfillOnce(events: TradingViewEvent[], now: number) {
  const existing = await query<{ count: string }>("SELECT count(*) FROM news_predictions WHERE source = 'backfill'");
  if (Number(existing.rows[0]?.count ?? 0) > 0) return;
  let inserted = 0;
  for (const event of events) {
    if (Date.parse(event.date) >= now || (event as { importance?: number }).importance! < 0) continue;
    const outcome = outcomeOf(event.actual, event.forecast ?? null);
    if (!outcome || eventCurrencyPolarity(event.title) === null) continue;
    const target = { title: event.title, currency: event.currency, timestamp: event.date, forecast: numberString(event.forecast), previous: numberString(event.previous) };
    const result = releaseVotes(target, events);
    if (!result) continue;
    await query(
      `INSERT INTO news_predictions (event_key, series_key, title, currency, impact, event_time, forecast, previous, signals, source, actual, outcome, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'backfill', $10, $11, now()) ON CONFLICT (event_key) DO NOTHING`,
      [`tv:${(event as { id?: string }).id ?? `${event.currency}|${event.title}|${event.date}`}`, `${event.currency}|${event.title}`, event.title, event.currency,
        (event as { importance?: number }).importance ?? null, event.date, target.forecast, target.previous, JSON.stringify(result.votes), numberString(event.actual), outcome],
    );
    inserted += 1;
  }
  console.log(`[news-predictions] seeded ${inserted} historical releases`);
}

export function newsEventKey(event: { currency: string; title: string; timestamp: string }) {
  return `${event.currency}|${event.title}|${new Date(event.timestamp).toISOString()}`;
}

/** Freeze calls for upcoming releases and score released ones. Safe to run often. */
export async function runNewsPredictionJournal(now = Date.now()) {
  if (!databaseConfigured()) return;
  const [tradingView, calendar] = await Promise.all([loadHistory(now), getAllCalendarEvents()]);
  await seedBackfillOnce(tradingView, now);

  const records = await loadRecords();
  for (const event of calendar) {
    if (Date.parse(event.timestamp) <= now) continue;
    const result = releaseVotes(event, tradingView);
    if (!result) continue;
    const seriesKey = `${event.currency}|${result.seriesTitle ?? event.title}`;
    const choice = chooseCall(result.votes, seriesKey, records);
    const hint = newsSurpriseHint({ ...event, actual: null });
    const currencyCall = choice && hint.kind === "before"
      ? choice.call === "beat" ? hint.beatDirection : hint.missDirection
      : null;
    // DO NOTHING keeps the first call: a prediction is never rewritten.
    await query(
      `INSERT INTO news_predictions (event_key, series_key, title, currency, impact, event_time, forecast, previous, signals, chosen_signal, call, currency_call)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (event_key) DO NOTHING`,
      [newsEventKey(event), seriesKey, event.title, event.currency, event.impact, event.timestamp, event.forecast, event.previous,
        JSON.stringify(result.votes), choice?.signal ?? null, choice?.call ?? null, currencyCall],
    );
  }

  const open = await query<{ event_key: string; call: string | null; forecast: string | null }>(
    "SELECT event_key, call, forecast FROM news_predictions WHERE source = 'live' AND outcome IS NULL AND event_time <= now()",
  );
  const byKey = new Map(calendar.map((event) => [newsEventKey(event), event]));
  for (const row of open.rows) {
    const event = byKey.get(row.event_key);
    const outcome = event ? outcomeOf(parseCalendarValue(event.actual), parseCalendarValue(row.forecast)) : null;
    if (!event || !outcome) continue;
    await query(
      "UPDATE news_predictions SET actual = $2, outcome = $3, correct = $4, resolved_at = now() WHERE event_key = $1",
      [row.event_key, event.actual, outcome, row.call && outcome !== "inline" ? row.call === outcome : null],
    );
  }
}

/** Calls for the current calendar window plus the live track record, for the Home drawer. */
export async function newsPredictionsSnapshot() {
  if (!databaseConfigured()) return { predictions: [], record: { calls: 0, correct: 0 } };
  const [rows, record] = await Promise.all([
    query(
      `SELECT event_key, title, currency, event_time, chosen_signal, call, currency_call, actual, outcome, correct
       FROM news_predictions WHERE source = 'live' AND event_time >= now() - interval '8 days' ORDER BY event_time`,
    ),
    query<{ calls: string; correct: string }>(
      "SELECT count(*) FILTER (WHERE correct IS NOT NULL) AS calls, count(*) FILTER (WHERE correct) AS correct FROM news_predictions WHERE source = 'live'",
    ),
  ]);
  return {
    predictions: rows.rows,
    record: { calls: Number(record.rows[0]?.calls ?? 0), correct: Number(record.rows[0]?.correct ?? 0) },
  };
}
