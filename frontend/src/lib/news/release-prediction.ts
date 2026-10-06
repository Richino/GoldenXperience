import { isSameSeries, type TradingViewEvent } from "@/lib/calendar/forex-factory-actuals";
import { eventCurrencyPolarity } from "@/lib/news/event-polarity";
import { parseCalendarValue } from "@/lib/news/surprise-hint";

/**
 * Beat/miss votes for a scheduled release, from data published before it only,
 * so they are the same before and after the number comes out. Each vote is +1
 * (beat: print above forecast), −1 (miss) or 0 (no view):
 *  - previous: previous reading vs forecast;
 *  - momentum: the series' last three prints projected forward vs forecast;
 *  - streak: whether this series has recently been beating its forecasts;
 *  - related: surprises in linked releases from the month before (S&P PMIs
 *    before ISM, ADP/claims before payrolls, PPI before CPI).
 *
 * A one-year backtest found none of these better than ~52% on its own, so the
 * news journal decides which one to trust from its own logged record.
 */

export type ReleasePredictionInput = {
  title: string;
  currency: string;
  timestamp: string;
  forecast: string | null;
  previous: string | null;
};

export const SIGNALS = ["previous", "momentum", "streak", "related"] as const;
export type SignalName = (typeof SIGNALS)[number];
export type SignalVotes = Record<SignalName, -1 | 0 | 1>;

/** Related series for each kind of release, matched on TradingView titles. */
const RELATED: Array<{ target: RegExp; related: RegExp[] }> = [
  { target: /services pmi|non.?manufacturing/i, related: [/services pmi/i, /composite pmi/i] },
  { target: /manufacturing pmi|ism manufacturing/i, related: [/manufacturing pmi/i, /empire state|ny empire/i, /philadelphia|philly/i, /richmond|kansas|dallas fed/i] },
  { target: /non.?farm|employment change|payroll|unemployment rate/i, related: [/adp/i, /jobless claims|claimant/i, /jolts|job openings/i, /challenger/i] },
  { target: /\bcpi\b|consumer price|inflation rate/i, related: [/\bppi\b|producer price/i, /import price/i, /\bpce\b/i] },
  { target: /retail sales/i, related: [/consumer (confidence|sentiment)|michigan/i, /redbook/i] },
  { target: /\bgdp\b/i, related: [/retail sales/i, /industrial production/i, /composite pmi/i] },
  { target: /claims/i, related: [/claims/i] },
];

const RELATED_LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;

function sign(value: number, scale: number): -1 | 0 | 1 {
  const epsilon = Math.max(Math.abs(scale) * 0.001, 1e-9);
  return value > epsilon ? 1 : value < -epsilon ? -1 : 0;
}

function released(event: TradingViewEvent): event is TradingViewEvent & { actual: number } {
  return typeof event.actual === "number" && Number.isFinite(event.actual);
}

/**
 * The votes, plus the TradingView title of the series (a stable key for its
 * track record). Null when the event has no beat/miss meaning or no forecast.
 */
export function releaseVotes(
  target: ReleasePredictionInput,
  history: TradingViewEvent[],
): { votes: SignalVotes; seriesTitle: string | null } | null {
  const polarity = eventCurrencyPolarity(target.title);
  const forecast = parseCalendarValue(target.forecast);
  if (polarity === null || forecast === null) return null;
  const time = Date.parse(target.timestamp);
  const before = history.filter((event) => Date.parse(event.date) < time - 60_000);
  const votes: SignalVotes = { previous: 0, momentum: 0, streak: 0, related: 0 };

  const series = before
    .filter((event) => released(event) && isSameSeries(target, event))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date)) as Array<TradingViewEvent & { actual: number }>;

  const previous = parseCalendarValue(target.previous);
  if (previous !== null) votes.previous = sign(previous - forecast, forecast);

  // TradingView rescales some series (claims in thousands); bring its prints
  // onto the forecast's scale using the latest print against "previous".
  const last = series.at(-1);
  const scale = last && previous !== null && last.actual !== 0 ? previous / last.actual : 1;
  if (Number.isFinite(scale) && scale > 0 && series.length >= 3) {
    const recent = series.slice(-3).map((event) => event.actual * scale);
    votes.momentum = sign(recent[2]! + (recent[2]! - recent[0]!) / 4 - forecast, forecast);
  }

  const surprises = series
    .slice(-3)
    .filter((event) => typeof event.forecast === "number")
    .map((event) => sign(event.actual - event.forecast!, event.forecast!));
  if (surprises.length >= 2) votes.streak = sign(surprises.reduce<number>((sum, value) => sum + value, 0), 1);

  const family = RELATED.find((entry) => entry.target.test(target.title));
  if (family) {
    let related = 0;
    for (const event of before) {
      if (!released(event) || typeof event.forecast !== "number") continue;
      if (event.currency !== target.currency || time - Date.parse(event.date) > RELATED_LOOKBACK_MS) continue;
      if (isSameSeries(target, event) || !family.related.some((pattern) => pattern.test(event.title))) continue;
      const relatedPolarity = eventCurrencyPolarity(event.title);
      const surprise = sign(event.actual - event.forecast, event.forecast);
      // Good-for-the-currency news there suggests good news here too.
      if (relatedPolarity !== null) related += relatedPolarity * surprise * polarity;
    }
    votes.related = sign(related, 1);
  }

  return { votes, seriesTitle: last?.title ?? null };
}
