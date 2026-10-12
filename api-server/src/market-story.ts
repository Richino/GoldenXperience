import type { Candle } from "../../frontend/src/types/forex.js";
import type { ObserverStory, QuotePressure } from "../../frontend/src/lib/market-observer-types.js";
import { confirmedPivots, meaningfulSwings } from "../../frontend/src/lib/strategy/market-regime.js";
import { pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";

const intervals = { H4: 14_400_000, H1: 3_600_000, M15: 900_000 };
/** Only information available at asOf may participate. This is a description, not an entry model. */
export function marketStory(instrument: string, history: Partial<Record<keyof typeof intervals, Candle[]>>, asOf: string): ObserverStory {
  const now = Date.parse(asOf), pip = pipSizeFor(instrument);
  const price = (value: number) => value.toFixed(precisionFor(instrument));
  const read = (tf: keyof typeof intervals, limit: number) => {
    const bars = [...(history[tf] ?? [])].filter(c => c.complete && Date.parse(c.time) + intervals[tf] <= now
      && [c.open, c.high, c.low, c.close].every(Number.isFinite) && c.low <= Math.min(c.open, c.close)
      && c.high >= Math.max(c.open, c.close)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-limit);
    const ranges = bars.slice(-14).map(c => {
      const index = bars.indexOf(c), previous = bars[index - 1]?.close ?? c.open;
      return Math.max(c.high - c.low, Math.abs(c.high - previous), Math.abs(c.low - previous));
    });
    const atr = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : pip;
    const swings = meaningfulSwings(confirmedPivots(bars, 2), Math.max(pip, atr * 0.5));
    const highs = swings.filter(s => s.type === "high").slice(-2), lows = swings.filter(s => s.type === "low").slice(-2);
    const tolerance = Math.max(pip, atr * 0.1);
    const hasStructure = highs.length === 2 && lows.length === 2;
    const direction: QuotePressure = bars.length < 20 ? "unknown" : !hasStructure ? "unknown"
      : highs[1].price > highs[0].price + tolerance && lows[1].price > lows[0].price + tolerance ? "up"
      : highs[1].price < highs[0].price - tolerance && lows[1].price < lows[0].price - tolerance ? "down" : "range";
    const net = bars.length ? bars.at(-1)!.close - bars[0].close : 0;
    const description = direction === "up" ? "Recent rises reach higher prices, and the dips also stop higher. Price is moving upward."
      : direction === "down" ? "Recent rises stop lower, and the dips reach lower prices. Price is moving downward."
      : direction === "range" ? "Price is moving back and forth without a clear direction."
      : bars.length < 20 ? "There is not enough completed price history to tell the direction yet."
      : "There are not enough clear turning points to tell the direction yet.";
    return { bars, atr, swings, direction, description, net, from: bars[0]?.time ?? null, to: bars.at(-1)?.time ?? null };
  };
  const broad = read("H4", 256), recent = read("H1", 128), current = read("M15", 64);
  const coverage = (r: typeof broad) => ({ bars: r.bars.length, from: r.from, to: r.to });
  const broaderSummary = broad.bars.length < 20 ? broad.description
    : `Over the dates shown, price is ${broad.net >= 0 ? "higher" : "lower"} overall. ${broad.description}${broad.net < 0 && broad.direction === "up" ? " It is recovering from the earlier fall; that does not prove the recovery will continue." : broad.net > 0 && broad.direction === "down" ? " It is dipping after the earlier rise; that does not prove the rise has ended." : ""} This covers the dates below, not all market history.`;
  const relation = recent.direction === "down" && broad.direction === "up" ? " This could be a temporary dip (pullback) within the bigger rise. A lasting change downward is not confirmed."
    : recent.direction === "up" && broad.direction === "down" ? " This could be a temporary bounce within the bigger fall. A lasting change upward is not confirmed."
    : ["up", "down"].includes(recent.direction) && recent.direction === broad.direction ? " The recent movement and bigger picture point the same way." : "";
  const levels: ObserverStory["current"]["levels"] = [];
  if (current.bars.length >= 20) for (const role of ["support", "resistance"] as const) {
    const anchor = current.swings.filter(s => s.type === (role === "support" ? "low" : "high")).at(-1);
    if (!anchor) continue;
    const knownAt = new Date(Date.parse(anchor.confirmedAt) + intervals.M15).toISOString();
    // Width is frozen from volatility available when this pivot became known.
    const knownBars = current.bars.filter(c => Date.parse(c.time) + intervals.M15 <= Date.parse(knownAt)).slice(-14);
    const width = Math.max(pip, knownBars.reduce((sum, c) => sum + c.high - c.low, 0) / knownBars.length * 0.15);
    const low = anchor.price - width, high = anchor.price + width;
    const after = current.bars.filter(c => Date.parse(c.time) >= Date.parse(knownAt));
    const broken = (c: Candle) => role === "support" ? c.close < low : c.close > high;
    const back = (c: Candle) => role === "support" ? c.close > high : c.close < low;
    let crossed = false, reclaimed = false;
    for (const c of after) { if (broken(c)) { crossed = true; reclaimed = false; } else if (crossed && back(c)) reclaimed = true; }
    const last = current.bars.at(-1)!;
    const testing = last.high >= low && last.low <= high;
    const state = crossed ? reclaimed ? "reclaimed" : "broken" : testing ? "testing" : "holding";
    levels.push({ role, price: anchor.price, low, high, time: anchor.time, knownAt, state,
      condition: role === "support" ? `If a new 15-minute period ends below ${price(low)}, price has passed below this floor. If a later period ends above ${price(high)}, price has moved back above the area.`
        : `If a new 15-minute period ends above ${price(high)}, price has passed above this ceiling. If a later period ends below ${price(low)}, price has moved back below the area.` });
  }
  const last = current.bars.at(-1), previous = current.bars.at(-2);
  const movement = !last || !previous ? "There is not enough recent data to describe the latest move." : last.close > previous.close ? "The latest completed 15-minute period ended higher than the previous one." : last.close < previous.close ? "The latest completed 15-minute period ended lower than the previous one." : "The latest completed 15-minute period ended at the same price as the previous one.";
  return { version: "market-story@1", broader: { timeframe: "H4", direction: broad.direction, summary: broaderSummary, ...coverage(broad) },
    recent: { timeframe: "H1", direction: recent.direction, summary: recent.description + relation, ...coverage(recent) },
    current: { timeframe: "M15", ...coverage(current), summary: movement,
      levels, watch: levels.length === 2 ? "Use the price at the end of each 15-minute period. Briefly crossing a level during the period is not enough. Passing a level does not automatically mean it is time to trade." : "More clear turning points are needed to identify both a possible floor and ceiling." } };
}
