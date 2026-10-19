import { candleEnd, candleHealth, intervalTraded, type CandleSchedule } from "@/lib/strategy/candle-clock";
import { getForexSessionStatus } from "@/lib/strategy/session";
import { TIMEFRAME_MS, type ModeConfig, type V2Timeframe } from "@/lib/strategy/analyze-v2/config";
import { spreadPipsOf, type Quote } from "@/lib/strategy/analyze-v2/instrument-math";
import type { Candle } from "@/types/forex";

/**
 * Market-data checks that run before any analysis. A missing source is
 * UNKNOWN, never a silent PASS; a stale or crossed quote is not executable.
 *
 * Weekends: forex is closed from Friday 17:00 to Sunday 17:00 New York time
 * (session.ts, DST-aware via Intl). Candles missing inside that window are
 * not gaps, and a market that is closed is not "stale".
 */

export type CheckStatus = "PASS" | "CAUTION" | "FAIL" | "UNKNOWN";

export interface DataCheck {
  id: string;
  status: CheckStatus;
  reason: string;
}

export interface NormalizedCandles {
  /** Completed candles, oldest first, one per open time. */
  closed: Candle[];
  /** The still-forming candle, if the feed sent one. Never used for confirmed signals. */
  forming: Candle | null;
  duplicates: number;
  malformed: number;
  /** True when the feed arrived out of time order. */
  reordered: boolean;
  /** Candles missing while the market was open (weekends excluded). */
  missing: number;
}

// Open/closed only changes on a New York hour boundary (whole-hour offsets),
// so one answer per UTC hour is exact. Replays ask this thousands of times.
const marketOpenByHour = new Map<number, boolean>();

export function isMarketOpen(at: number) {
  const hour = Math.floor(at / 3_600_000);
  let open = marketOpenByHour.get(hour);
  if (open === undefined) {
    if (marketOpenByHour.size > 50_000) marketOpenByHour.clear();
    open = getForexSessionStatus(new Date(hour * 3_600_000)).marketOpen;
    marketOpenByHour.set(hour, open);
  }
  return open;
}

/**
 * Sort, drop duplicate open times (the later copy wins, so a completed
 * version replaces a forming one), split off the forming candle and count
 * candles missing while the market was open.
 */
export function normalizeCandles(candles: Candle[], timeframe: V2Timeframe, schedule?: CandleSchedule): NormalizedCandles {
  let reordered = false;
  for (let index = 1; index < candles.length; index += 1) {
    if (Date.parse(candles[index]!.time) < Date.parse(candles[index - 1]!.time)) {
      reordered = true;
      break;
    }
  }
  let malformed = 0;
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    const at = Date.parse(candle.time);
    if (!Number.isFinite(at) || ![candle.open, candle.high, candle.low, candle.close].every(n => Number.isFinite(n) && n > 0) || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) { malformed++; continue; }
    const existing = byTime.get(at);
    // Prefer a completed copy over a forming one; otherwise the later copy.
    if (!existing || candle.complete !== false || existing.complete === false) byTime.set(at, candle);
  }
  const duplicates = candles.length - byTime.size - malformed;
  const ordered = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
  const closed = ordered.filter((candle) => candle.complete !== false);
  const last = ordered.at(-1);
  const forming = last && last.complete === false ? last : null;

  // Calendar-aligned boundaries account for daily DST rolls and broker closures.
  let missing = 0;
  {
    for (let index = 1; index < closed.length; index += 1) {
      const previous = Date.parse(closed[index - 1]!.time);
      const current = Date.parse(closed[index]!.time);
      if (current - previous > 32 * 86_400_000) { missing += 100_000; continue; }
      for (let at = candleEnd(previous, timeframe); at < current; at = candleEnd(at, timeframe)) {
        if (candleEnd(at, timeframe) <= current && intervalTraded(at, candleEnd(at, timeframe), schedule?.interruptions, schedule?.instrument)) missing += 1;
      }
    }
  }
  return { closed, forming, duplicates, reordered, missing, malformed };
}

/** Enough closed history to read structure. */
export function checkHistory(id: string, closed: Candle[], minBars: number): DataCheck {
  if (!closed.length) return { id, status: "UNKNOWN", reason: "No candles were returned." };
  if (closed.length < minBars) {
    return { id, status: "FAIL", reason: `Only ${closed.length} closed candles; at least ${minBars} are needed to read structure.` };
  }
  return { id, status: "PASS", reason: `${closed.length} closed candles.` };
}

/**
 * The latest closed candle should end within `maxLagBars` candles of now
 * while the market is open. While it is closed, old candles are expected.
 */
export function checkCandleFreshness(id: string, closed: Candle[], timeframe: V2Timeframe, now: number, _maxLagBars: number, schedule?: CandleSchedule): DataCheck {
  const last = closed.at(-1);
  if (!last) return { id, status: "UNKNOWN", reason: "No closed candles to check." };
  const health = candleHealth(Date.parse(last.time), timeframe, now, schedule?.interruptions, schedule?.instrument);
  const closedAt = health.end;
  if (!Number.isFinite(closedAt) || closedAt > now) return { id, status: "FAIL", reason: "Completed candle ends in the future or has an invalid timestamp." };
  // Count missing completed TRADING intervals, never closed weekend hours.
  if (health.missing > 0) return { id, status: "FAIL", reason: `Missing ${health.missing} completed ${timeframe} trading intervals after ${new Date(closedAt).toISOString()}; candle retrieval is stale or interrupted.` };
  return { id, status: isMarketOpen(now) ? "PASS" : "CAUTION", reason: `Last completed ${timeframe}: ${new Date(closedAt).toISOString()}. ${health.missing === 0 ? "No expected completed trading candle is missing; prior-session structure is historical context." : "One completion is pending refresh."}` };
}

/** Malformed prices fail closed; normalized ordering and historical gaps are reported independently. */
export function checkIntegrity(id: string, normalized: NormalizedCandles, maxGapShare: number): DataCheck {
  if (normalized.malformed) return { id, status: "FAIL", reason: `${normalized.malformed} malformed candles rejected.` };
  const notes: string[] = [];
  if (normalized.duplicates) notes.push(`${normalized.duplicates} duplicate candle${normalized.duplicates === 1 ? "" : "s"} removed`);
  if (normalized.reordered) notes.push("candles arrived out of order and were sorted");
  const expected = normalized.closed.length + normalized.missing;
  const share = expected ? normalized.missing / expected : 0;
  if (normalized.missing) notes.push(`${normalized.missing} candle${normalized.missing === 1 ? "" : "s"} missing while the market was open`);
  if (share > maxGapShare) return { id, status: "FAIL", reason: `${notes.join("; ")} (${Math.round(share * 100)}% of the window).` };
  return { id, status: "PASS", reason: notes.length ? `${notes.join("; ")}.` : "No duplicates or gaps." };
}

export interface QuoteCheck extends DataCheck {
  /** The quote when it is fresh and valid; null when it must not be used as a price. */
  executable: (Quote & { mid: number; spreadPips: number; ageMs: number }) | null;
}

/** A live quote is executable only when present, uncrossed and fresh. */
export function checkQuote(instrument: string, quote: Quote | null | undefined, now: number, maxAgeMs: number): QuoteCheck {
  const id = "quote";
  if (!quote) return { id, status: "UNKNOWN", reason: "No live quote; prices cannot be executed from candles.", executable: null };
  if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || !(quote.bid > 0) || !(quote.ask > 0) || quote.ask < quote.bid) {
    return { id, status: "FAIL", reason: `Invalid quote (bid ${quote.bid}, ask ${quote.ask}).`, executable: null };
  }
  const at = Date.parse(quote.time);
  if (!Number.isFinite(at)) return { id, status: "FAIL", reason: "The quote has no valid time.", executable: null };
  const ageMs = now - at;
  if (ageMs > maxAgeMs) {
    return {
      id,
      status: "FAIL",
      reason: isMarketOpen(now)
        ? `The quote is ${Math.round(ageMs / 1000)}s old; a stale quote is not an executable price.`
        : "Forex is closed; the last quote is not executable.",
      executable: null,
    };
  }
  if (ageMs < -30_000) return { id, status: "FAIL", reason: "The quote is time-stamped in the future.", executable: null };
  const spreadPips = spreadPipsOf(instrument, quote);
  return {
    id,
    status: "PASS",
    reason: `Live quote ${Math.max(0, Math.round(ageMs / 1000))}s old, spread ${spreadPips.toFixed(1)} pips.`,
    executable: { ...quote, mid: (quote.bid + quote.ask) / 2, spreadPips, ageMs },
  };
}

/** All data checks for one timeframe's candles. */
export function checkTimeframe(role: string, candles: Candle[] | undefined, timeframe: V2Timeframe, now: number, config: ModeConfig, required: boolean, schedule?: CandleSchedule) {
  const normalized = normalizeCandles((candles ?? []).filter(c => !Number.isFinite(Date.parse(c.time)) || c.complete === false || candleEnd(Date.parse(c.time), timeframe) <= now), timeframe, schedule);
  const checks: DataCheck[] = [];
  if (!candles?.length) {
    checks.push({ id: `${role}-candles`, status: required ? "UNKNOWN" : "CAUTION", reason: `No ${timeframe} candles were returned.` });
    return { normalized, checks };
  }
  checks.push(checkHistory(`${role}-history`, normalized.closed, role === "primary" ? config.data.minPrimaryBars : Math.min(30, config.data.minPrimaryBars)));
  checks.push(checkCandleFreshness(`${role}-freshness`, normalized.closed, timeframe, now, config.data.maxCandleLagBars, schedule));
  checks.push(checkIntegrity(`${role}-integrity`, normalized, config.data.maxGapShare));
  checks.push(checkSpacing(`${role}-spacing`, normalized.closed, timeframe));
  return { normalized, checks };
}

/**
 * The candles really are the timeframe they claim: the most common spacing
 * between consecutive candles matches it (daily candles may be 23–25h apart
 * across a DST change).
 */
export function checkSpacing(id: string, closed: Candle[], timeframe: V2Timeframe): DataCheck {
  if (closed.length < 3) return { id, status: "UNKNOWN", reason: `Too few ${timeframe} candles to verify their spacing.` };
  const counts = new Map<number, number>();
  for (let index = 1; index < closed.length; index += 1) {
    const diff = Date.parse(closed[index]!.time) - Date.parse(closed[index - 1]!.time);
    counts.set(diff, (counts.get(diff) ?? 0) + 1);
  }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const step = TIMEFRAME_MS[timeframe];
  const ok = timeframe === "D1" ? common >= 23 * 3_600_000 && common <= 25 * 3_600_000 : common === step;
  return ok
    ? { id, status: "PASS", reason: `${timeframe} spacing confirmed.` }
    : { id, status: "FAIL", reason: `Candles labelled ${timeframe} are ${Math.round(common / 60_000)} min apart.` };
}
