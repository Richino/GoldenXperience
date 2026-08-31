/**
 * eurusdbot3-1 — look-ahead-safe news features at an entry timestamp.
 *
 * At entry time T the model may only use: scheduled times/currencies of FUTURE
 * events (a calendar is known ahead) and the actual/surprise of events already
 * RELEASED (releaseTimeUtc <= T). No future actual is ever read.
 */
import type { NewsEvent } from "./data.js";

const CAP_MIN = 720; // cap look-back / look-ahead windows at 12h

export function buildNewsFeatures(
  news: NewsEvent[],
  zByEvent: Map<NewsEvent, number>,
  T: number,
): Record<string, number> {
  // events are sorted ascending by time
  let prevReleased: NewsEvent | null = null;
  let nextUpcoming: NewsEvent | null = null;
  let clusterCount = 0;
  let upcomingEur = 0, upcomingUsd = 0, upcoming60 = 0;

  for (const e of news) {
    if (e.t <= T) prevReleased = e; // last released with actual known
    else {
      if (!nextUpcoming) nextUpcoming = e;
      if (e.t - T <= 8 * 3_600_000) clusterCount++;
      if (e.t - T <= 60 * 60_000) {
        upcoming60 = 1;
        if (e.currency === "EUR") upcomingEur = 1;
        if (e.currency === "USD") upcomingUsd = 1;
      }
    }
  }

  const minsToHigh = nextUpcoming ? Math.min(CAP_MIN, (nextUpcoming.t - T) / 60000) : CAP_MIN;
  const minsSinceHigh = prevReleased ? Math.min(CAP_MIN, (T - prevReleased.t) / 60000) : CAP_MIN;

  // EURUSD-implied surprise direction from the most recent released event
  // (only if within the last 6h, else decayed to 0). USD-positive surprise is
  // USD-bullish → EURUSD-bearish (negative); EUR-positive → EURUSD-bullish.
  let surpriseDir = 0, surpriseMag = 0;
  if (prevReleased && zByEvent.has(prevReleased) && T - prevReleased.t <= 6 * 3_600_000) {
    const z = zByEvent.get(prevReleased)!;
    const sign = prevReleased.currency === "USD" ? -1 : 1;
    const decay = Math.exp(-(T - prevReleased.t) / (2 * 3_600_000)); // 2h decay
    surpriseDir = sign * Math.max(-4, Math.min(4, z)) * decay;
    surpriseMag = Math.min(4, Math.abs(z)) * decay;
  }

  return {
    mins_to_high: minsToHigh / CAP_MIN,
    mins_since_high: minsSinceHigh / CAP_MIN,
    upcoming_60: upcoming60,
    upcoming_eur: upcomingEur,
    upcoming_usd: upcomingUsd,
    cluster_8h: Math.min(6, clusterCount) / 6,
    news_surprise_dir: surpriseDir,
    news_surprise_mag: surpriseMag,
  };
}

/** True if a high-impact event releases within `window` minutes after T (for the avoidance filter). */
export function highImpactWithin(news: NewsEvent[], T: number, windowMin: number): boolean {
  const hi = T + windowMin * 60000;
  for (const e of news) {
    if (e.t < T) continue;
    if (e.t <= hi) return true;
    if (e.t > hi) break;
  }
  return false;
}
