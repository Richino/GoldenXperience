import { currenciesOf } from "@/lib/instruments/catalog";

/**
 * News impact tagging — the deterministic core.
 *
 * Pure: no clock, no database, no network. The same trade and the same set of
 * calendar events always produce the same tag, which is what lets a backfill be
 * re-run safely and lets research trust that a tag reflects the calendar rather
 * than when the tagger happened to run.
 *
 * RESEARCH ONLY. Nothing here is consulted by strategy evaluation, the risk
 * engine, position sizing, or execution. It answers one question after the
 * fact: was there important news near this trade?
 */

export const NEWS_IMPACT_TAGS = ["NO_NEWS", "NEAR_NEWS", "HIGH_IMPACT_NEWS"] as const;
export type NewsImpactTag = (typeof NEWS_IMPACT_TAGS)[number];

/** Severity order, so "the most important tag matched" is well defined. */
const TAG_SEVERITY: Record<NewsImpactTag, number> = {
  NO_NEWS: 0,
  NEAR_NEWS: 1,
  HIGH_IMPACT_NEWS: 2,
};

/**
 * Impact levels follow the calendar normalizer's existing numeric scale
 * (high 3, medium 2, low 1, holiday 0) so no translation layer is needed
 * between the feed and the tagger.
 */
export const IMPACT_LEVEL = { high: 3, medium: 2, low: 1, holiday: 0 } as const;

export interface NewsWindowConfig {
  /** High-impact news inside this window is the strongest classification. */
  highImpactWindowMinutes: number;
  /** Medium-or-better news inside this window is proximity, not a headline hit. */
  nearWindowMinutes: number;
  /**
   * High-impact news "slightly outside" the main window still counts as near.
   * Wider than nearWindowMinutes on purpose: an NFP release keeps moving price
   * well after the print, so a trade an hour later is not cleanly news-free.
   */
  highImpactNearWindowMinutes: number;
  /** Minimum impact level treated as high impact. */
  highImpactMinLevel: number;
  /** Minimum impact level worth considering at all. Below this is ignored. */
  minimumRelevantLevel: number;
}

/**
 * The default windows. Every threshold lives here rather than being repeated at
 * call sites, so widening the study to ±60 minutes is a one-line change and the
 * tags stay reproducible from a recorded configuration.
 */
export const DEFAULT_NEWS_WINDOWS: NewsWindowConfig = {
  highImpactWindowMinutes: 30,
  nearWindowMinutes: 30,
  highImpactNearWindowMinutes: 90,
  highImpactMinLevel: IMPACT_LEVEL.high,
  minimumRelevantLevel: IMPACT_LEVEL.medium,
};

/**
 * Currencies whose releases are tracked. Every currency in the traded catalog
 * appears, NZD included — NZD_USD is a live instrument, and omitting it would
 * silently tag its trades NO_NEWS through an RBNZ release.
 */
export const TRACKED_NEWS_CURRENCIES = ["AUD", "CAD", "CHF", "EUR", "GBP", "JPY", "NZD", "USD"] as const;

export interface NewsEventInput {
  id: string;
  title: string;
  currency: string;
  /** Numeric impact on the IMPACT_LEVEL scale. */
  impact: number;
  /** Any parseable instant. Normalized to epoch before any comparison. */
  timestamp: string | Date;
}

export interface NewsTagResult {
  tag: NewsImpactTag;
  /** The single event the tag is attributed to; null when NO_NEWS. */
  eventId: string | null;
  currency: string | null;
  eventName: string | null;
  /** ISO-8601 UTC. */
  eventTime: string | null;
  /**
   * Signed minutes from the news to the trade entry. Positive means the trade
   * was opened AFTER the release, negative means before it.
   */
  minutesFromNews: number | null;
  impactLevel: number | null;
  /** Every relevant event inside a window, sorted for a stable record. */
  matchedEventIds: string[];
}

const NO_NEWS_RESULT: NewsTagResult = {
  tag: "NO_NEWS", eventId: null, currency: null, eventName: null,
  eventTime: null, minutesFromNews: null, impactLevel: null, matchedEventIds: [],
};

/**
 * Normalize any accepted time representation to epoch milliseconds.
 *
 * Comparison is always numeric and always in UTC. Raw local-time strings are
 * never compared: "2026-08-24T12:30:00Z" and "2026-08-24T08:30:00-04:00" are
 * the same instant and must tag identically, which only holds once both sides
 * are reduced to an epoch.
 */
export function toEpochMs(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Does this currency move this pair?
 *
 * Derived from the instrument name rather than a hand-maintained table of pair
 * lists, so a newly traded instrument is covered the day it is added: USD is
 * relevant to EUR_USD and USD_JPY, GBP to GBP_USD and EUR_GBP, JPY to USD_JPY
 * and AUD_JPY, and nothing else matches.
 */
export function isCurrencyRelevantToPair(pair: string, currency: string): boolean {
  if (!pair || !currency) return false;
  const normalized = currency.trim().toUpperCase();
  const { base, quote } = currenciesOf(pair.trim().toUpperCase().replace("/", "_"));
  return normalized === base || normalized === quote;
}

/** The currencies a pair can be moved by. */
export function currenciesForPair(pair: string): string[] {
  const { base, quote } = currenciesOf(pair.trim().toUpperCase().replace("/", "_"));
  return [base, quote].filter((code) => code.length > 0);
}

/** What a single event would classify this trade as, ignoring every other event. */
function tagForEvent(absMinutes: number, impact: number, config: NewsWindowConfig): NewsImpactTag {
  const isHigh = impact >= config.highImpactMinLevel;
  if (isHigh && absMinutes <= config.highImpactWindowMinutes) return "HIGH_IMPACT_NEWS";
  if (isHigh && absMinutes <= config.highImpactNearWindowMinutes) return "NEAR_NEWS";
  if (impact >= config.minimumRelevantLevel && absMinutes <= config.nearWindowMinutes) return "NEAR_NEWS";
  return "NO_NEWS";
}

/**
 * Classify one trade against a calendar.
 *
 * The trade's tag is the most severe any single relevant event produces. The
 * event RECORDED alongside it is then chosen only from those events that
 * actually achieved that tag — so a NEAR_NEWS trade is never attributed to a
 * high-impact release that sat outside every window.
 *
 * Ties are broken deterministically and completely: higher impact first, then
 * closer to entry, then earlier event, then event id. Two events at identical
 * distance and impact can never swap places between runs.
 */
export function classifyNewsImpact(
  trade: { pair: string; entryTime: string | Date },
  events: readonly NewsEventInput[],
  config: NewsWindowConfig = DEFAULT_NEWS_WINDOWS,
): NewsTagResult {
  const entryMs = toEpochMs(trade.entryTime);
  if (entryMs === null || !trade.pair) return { ...NO_NEWS_RESULT };

  const matched: Array<{ event: NewsEventInput; tag: NewsImpactTag; minutes: number; absMinutes: number; eventMs: number }> = [];

  for (const event of events) {
    if (!isCurrencyRelevantToPair(trade.pair, event.currency)) continue;
    const eventMs = toEpochMs(event.timestamp);
    if (eventMs === null) continue;
    const impact = Number(event.impact);
    if (!Number.isFinite(impact)) continue;

    // Positive when the trade opened after the release.
    const minutes = (entryMs - eventMs) / 60_000;
    const absMinutes = Math.abs(minutes);
    const tag = tagForEvent(absMinutes, impact, config);
    if (tag === "NO_NEWS") continue;
    matched.push({ event, tag, minutes, absMinutes, eventMs });
  }

  if (matched.length === 0) return { ...NO_NEWS_RESULT };

  const tag = matched.reduce<NewsImpactTag>(
    (worst, item) => (TAG_SEVERITY[item.tag] > TAG_SEVERITY[worst] ? item.tag : worst),
    "NO_NEWS",
  );

  // Attribute the trade only to an event that reached the winning tag.
  const contenders = matched.filter((item) => item.tag === tag);
  contenders.sort((a, b) =>
    Number(b.event.impact) - Number(a.event.impact)
    || a.absMinutes - b.absMinutes
    || a.eventMs - b.eventMs
    || String(a.event.id).localeCompare(String(b.event.id)));
  const primary = contenders[0]!;

  return {
    tag,
    eventId: primary.event.id,
    currency: primary.event.currency.trim().toUpperCase(),
    eventName: primary.event.title,
    eventTime: new Date(primary.eventMs).toISOString(),
    // Rounded to whole minutes: the feed publishes to the minute, so extra
    // precision would imply an accuracy the source does not have.
    minutesFromNews: Math.round(primary.minutes),
    impactLevel: Number(primary.event.impact),
    matchedEventIds: matched.map((item) => String(item.event.id)).sort(),
  };
}

/** Human-readable label for the numeric impact scale. */
export function impactLevelName(level: number | null): string {
  if (level === null) return "none";
  if (level >= IMPACT_LEVEL.high) return "high";
  if (level >= IMPACT_LEVEL.medium) return "medium";
  if (level >= IMPACT_LEVEL.low) return "low";
  return "holiday";
}
