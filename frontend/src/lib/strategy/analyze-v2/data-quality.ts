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
export function normalizeCandles(candles: Candle[], timeframe: V2Timeframe): NormalizedCandles {
  const step = TIMEFRAME_MS[timeframe];
  let reordered = false;
  for (let index = 1; index < candles.length; index += 1) {
    if (Date.parse(candles[index]!.time) < Date.parse(candles[index - 1]!.time)) {
      reordered = true;
      break;
    }
  }
  const byTime = new Map<number, Candle>();
  for (const candle of candles) {
    const at = Date.parse(candle.time);
    if (!Number.isFinite(at)) continue;
    const existing = byTime.get(at);
    // Prefer a completed copy over a forming one; otherwise the later copy.
    if (!existing || candle.complete !== false || existing.complete === false) byTime.set(at, candle);
  }
  const duplicates = candles.length - byTime.size;
  const ordered = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, candle]) => candle);
  const closed = ordered.filter((candle) => candle.complete !== false);
  const last = ordered.at(-1);
  const forming = last && last.complete === false ? last : null;

  // D1 candles align to the 17:00 New York roll, which moves with DST, so
  // only intraday timeframes are gap-checked.
  let missing = 0;
  if (timeframe !== "D1") {
    for (let index = 1; index < closed.length; index += 1) {
      const previous = Date.parse(closed[index - 1]!.time);
      const current = Date.parse(closed[index]!.time);
      for (let at = previous + step; at < current; at += step) {
        if (isMarketOpen(at) && isMarketOpen(at + step - 1)) missing += 1;
      }
    }
  }
  return { closed, forming, duplicates, reordered, missing };
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
export function checkCandleFreshness(id: string, closed: Candle[], timeframe: V2Timeframe, now: number, maxLagBars: number): DataCheck {
  const last = closed.at(-1);
  if (!last) return { id, status: "UNKNOWN", reason: "No closed candles to check." };
  const step = TIMEFRAME_MS[timeframe];
  const closedAt = Date.parse(last.time) + step;
  if (!isMarketOpen(now)) {
    return { id, status: "CAUTION", reason: `Forex is closed; the latest ${timeframe} candle closed ${new Date(closedAt).toISOString()}.` };
  }
  if (timeframe === "D1") {
    // The daily candle rolls at 17:00 New York; allow the forming day plus a weekend.
    return now - closedAt <= 4 * step
      ? { id, status: "PASS", reason: "Daily candles are current." }
      : { id, status: "FAIL", reason: `The latest daily candle closed ${Math.round((now - closedAt) / step)} days ago.` };
  }
  const lag = now - closedAt;
  if (lag <= maxLagBars * step) return { id, status: "PASS", reason: `Latest ${timeframe} candle closed ${Math.max(0, Math.round(lag / 60_000))} min ago.` };
  return { id, status: "FAIL", reason: `Latest ${timeframe} candle closed ${Math.round(lag / 60_000)} min ago; the feed looks stale.` };
}

/** Duplicates, reordering and missing candles. Never a FAIL: the analysis can still read structure. */
export function checkIntegrity(id: string, normalized: NormalizedCandles, maxGapShare: number): DataCheck {
  const notes: string[] = [];
  if (normalized.duplicates) notes.push(`${normalized.duplicates} duplicate candle${normalized.duplicates === 1 ? "" : "s"} removed`);
  if (normalized.reordered) notes.push("candles arrived out of order and were sorted");
  const expected = normalized.closed.length + normalized.missing;
  const share = expected ? normalized.missing / expected : 0;
  if (normalized.missing) notes.push(`${normalized.missing} candle${normalized.missing === 1 ? "" : "s"} missing while the market was open`);
  if (share > maxGapShare) return { id, status: "CAUTION", reason: `${notes.join("; ")} (${Math.round(share * 100)}% of the window).` };
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
  if (!(quote.bid > 0) || !(quote.ask > 0) || quote.ask < quote.bid) {
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
export function checkTimeframe(role: string, candles: Candle[] | undefined, timeframe: V2Timeframe, now: number, config: ModeConfig, required: boolean) {
  const normalized = normalizeCandles(candles ?? [], timeframe);
  const checks: DataCheck[] = [];
  if (!candles?.length) {
    checks.push({ id: `${role}-candles`, status: required ? "UNKNOWN" : "CAUTION", reason: `No ${timeframe} candles were returned.` });
    return { normalized, checks };
  }
  checks.push(checkHistory(`${role}-history`, normalized.closed, role === "primary" ? config.data.minPrimaryBars : Math.min(30, config.data.minPrimaryBars)));
  checks.push(checkCandleFreshness(`${role}-freshness`, normalized.closed, timeframe, now, config.data.maxCandleLagBars));
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
