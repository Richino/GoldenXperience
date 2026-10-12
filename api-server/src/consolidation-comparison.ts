import type { Candle } from "../../frontend/src/types/forex.js";
import type { ConsolidationComparison, ObserverRead } from "../../frontend/src/lib/market-observer-types.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

/** Experimental thresholds, frozen at discovery. Not calibrated probabilities or trade instructions. */
export function freezeConsolidation(instrument: string, candles: Candle[], at: string): ConsolidationComparison | null {
  const now = Date.parse(at), bars = candles.filter(c => c.complete && Date.parse(c.time) + 300_000 <= now)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-12);
  if (bars.length !== 12 || now - Date.parse(bars.at(-1)!.time) > 600_000
    || bars.some((c, i) => ![c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0)
      || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)
      || i > 0 && Date.parse(c.time) - Date.parse(bars[i - 1].time) !== 300_000)) return null;
  const low = Math.min(...bars.map(c => c.low)), high = Math.max(...bars.map(c => c.high));
  const atr = bars.reduce((sum, c, i) => sum + Math.max(c.high - c.low,
    Math.abs(c.high - (bars[i - 1]?.close ?? c.open)), Math.abs(c.low - (bars[i - 1]?.close ?? c.open))), 0) / bars.length;
  const changes = bars.slice(1).map((c, i) => c.close - bars[i].close);
  const path = changes.reduce((sum, n) => sum + Math.abs(n), 0);
  const turns = changes.slice(1).filter((n, i) => n * changes[i] < 0).length;
  const efficiency = path ? Math.abs(bars.at(-1)!.close - bars[0].close) / path : 0;
  const pip = pipSizeFor(instrument);
  if (efficiency > 0.3 || turns < 3 || high - low > atr * 4 || high - low < pip * 4) return null;
  return { rules: "consolidation-comparison@1", low, high, buffer: Math.max(pip, atr * 0.1),
    followThrough: Math.max(pip * 2, atr * 0.25), holdSeconds: 10, createdAt: at,
    expiresAt: new Date(now + 7_200_000).toISOString(), lastQuoteAt: null, lastQuoteKey: null,
    state: "inside", attempts: [], truncated: false };
}

/** Independent shadow observations. These never change a plan into an entry signal. */
export function evaluateConsolidation(seed: ConsolidationComparison, read: ObserverRead, candles: Candle[]): ConsolidationComparison {
  const next = structuredClone(seed), now = Date.parse(read.asOf);
  if (!Number.isFinite(now) || now < Date.parse(seed.createdAt) || seed.lastQuoteAt && now < Date.parse(seed.lastQuoteAt) || seed.state === "expired") return next;
  let attempt = next.attempts.at(-1);
  const unknown = () => {
    if (attempt && !attempt.endedAt) { attempt.endedAt = read.asOf; attempt.continuousSince = null;
      for (const method of [attempt.hold, attempt.candle]) if (method.outcome === "pending") method.outcome = "unknown"; }
  };
  if (now >= Date.parse(seed.expiresAt)) { unknown(); next.state = "expired"; return next; }
  const q = read.quote;
  if (read.state === "paused" || !q || !Number.isFinite(Date.parse(q.time)) || Date.parse(q.time) < Date.parse(seed.createdAt)
    || now - Date.parse(q.time) > 5000 || Date.parse(q.time) > now || ![q.bid, q.ask].every(Number.isFinite) || q.bid <= 0 || q.ask < q.bid) {
    unknown(); next.state = "unavailable"; return next;
  }
  if (next.lastQuoteAt && Date.parse(q.time) < Date.parse(next.lastQuoteAt)) return next;
  const key = `${q.time}:${q.bid}:${q.ask}`, fresh = key !== next.lastQuoteKey;
  if (fresh && next.lastQuoteAt && Date.parse(q.time) - Date.parse(next.lastQuoteAt) > 5000) { unknown(); attempt = undefined; }
  if (fresh) { next.lastQuoteAt = q.time; next.lastQuoteKey = key; }
  // A full spread outside the box avoids treating a widened ask/bid as a breakout.
  const side = q.bid > next.high + next.buffer ? "up" : q.ask < next.low - next.buffer ? "down" : null;
  const inside = q.bid <= next.high && q.ask >= next.low;
  if (attempt && !attempt.endedAt && inside) {
    attempt.endedAt = read.asOf;
    for (const method of [attempt.hold, attempt.candle]) if (method.at && method.outcome === "pending") method.outcome = "returned_inside";
  }
  // A quote can jump across the entire box without an observed return inside.
  // End the old attempt as unknown rather than inventing an intrabar path.
  if (attempt && !attempt.endedAt && side && side !== attempt.side) unknown();
  if ((!attempt || attempt.endedAt) && side && fresh) {
    if (next.attempts.length >= 20) { next.truncated = true; next.state = "unavailable"; return next; }
    attempt = { side, startedAt: read.asOf, endedAt: null, continuousSince: q.time, samples: 0,
      hold: { at: null, blockers: [], outcome: "pending" }, candle: { at: null, blockers: [], outcome: "pending" } };
    next.attempts.push(attempt);
  }
  next.state = attempt && !attempt.endedAt ? "attempt" : "inside";
  if (!attempt || attempt.endedAt) return next;
  if (side !== attempt.side) { attempt.continuousSince = null; attempt.samples = 0; }
  else if (fresh) { attempt.continuousSince ??= q.time; attempt.samples++; }
  const progress = attempt.side === "up" ? q.bid - next.high : next.low - q.ask;
  if (!attempt.hold.at && fresh && attempt.continuousSince && attempt.samples >= 3
    && Date.parse(q.time) - Date.parse(attempt.continuousSince) >= next.holdSeconds * 1000
    && progress >= next.buffer + next.followThrough) {
    attempt.hold.at = read.asOf; attempt.hold.blockers = [...read.blockers];
  }
  const last = candles.filter(c => c.complete && Date.parse(c.time) >= Date.parse(attempt.startedAt)
    && Date.parse(c.time) + 300_000 <= now && Date.parse(c.time) + 600_000 > now).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).at(-1);
  if (!attempt.candle.at && last && (attempt.side === "up" ? last.close > next.high + next.buffer : last.close < next.low - next.buffer)) {
    attempt.candle.at = read.asOf; attempt.candle.blockers = [...read.blockers];
  }
  // Same outcome definition for both rules: first return inside, or an additional half-box extension.
  if (progress >= next.buffer + (next.high - next.low) * 0.5) for (const method of [attempt.hold, attempt.candle]) {
    if (method.at && method.outcome === "pending") method.outcome = "extended";
  }
  return next;
}

export function comparisonSummary(value: ConsolidationComparison) {
  return Object.fromEntries((["hold", "candle"] as const).map(name => {
    const confirmed = value.attempts.filter(a => a[name].at);
    const delays = confirmed.map(a => (Date.parse(a[name].at!) - Date.parse(a.startedAt)) / 1000);
    return [name, { attempts: value.attempts.length, confirmations: confirmed.length,
      returnedInside: confirmed.filter(a => a[name].outcome === "returned_inside").length,
      extended: confirmed.filter(a => a[name].outcome === "extended").length,
      unresolved: confirmed.filter(a => ["pending", "unknown"].includes(a[name].outcome)).length,
      meanDelaySeconds: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null }];
  }));
}

export function interruptConsolidation(value: ConsolidationComparison, at: string): ConsolidationComparison {
  const next = structuredClone(value), attempt = next.attempts.at(-1);
  if (attempt && !attempt.endedAt) {
    attempt.endedAt = at; attempt.continuousSince = null;
    for (const method of [attempt.hold, attempt.candle]) if (method.outcome === "pending") method.outcome = "unknown";
  }
  next.lastQuoteAt = at; next.lastQuoteKey = null;
  next.state = Date.parse(at) >= Date.parse(next.expiresAt) ? "expired" : "unavailable";
  return next;
}
