import type { Candle } from "@/types/forex";

/**
 * The prices other traders' orders sit around.
 *
 * A stop above yesterday's high is not interesting because the number is round
 * — it is interesting because a crowd put stops there, and price reaching it
 * releases them. These are the levels the strategy watches for that.
 *
 * Each level is read from the timeframe that can actually see it: a week of M15
 * candles does not fit in the 260 the evaluator is handed, so weekly extremes
 * come from H4 and daily extremes from H1.
 */
export type LiquidityKind =
  | "asian-high" | "asian-low"
  | "previous-day-high" | "previous-day-low"
  | "previous-week-high" | "previous-week-low"
  | "swing-high" | "swing-low";

export interface LiquidityLevel {
  kind: LiquidityKind;
  price: number;
  /** Above the current price or below it — which side its stops sit on. */
  side: "high" | "low";
  label: string;
}

const ET = "America/New_York";

function etParts(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** Trading days in ET, most recent last. */
function daysOf(candles: Candle[]) {
  const byDay = new Map<string, Candle[]>();
  for (const candle of candles) {
    const { day } = etParts(candle.time);
    byDay.set(day, [...(byDay.get(day) ?? []), candle]);
  }
  return [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right));
}

const highest = (candles: Candle[]) => Math.max(...candles.map((candle) => candle.high));
const lowest = (candles: Candle[]) => Math.min(...candles.map((candle) => candle.low));

/**
 * Swing points, defined by a pivot with `reach` candles either side that do not
 * exceed it. Larger reach finds fewer, more significant turns; this is the knob
 * that decides what "the last swing high" even means.
 */
export function swingPoints(candles: Candle[], reach = 5) {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = reach; index < candles.length - reach; index += 1) {
    const candle = candles[index]!;
    const window = candles.slice(index - reach, index + reach + 1);
    if (window.every((other) => other === candle || other.high <= candle.high)) highs.push(candle.high);
    if (window.every((other) => other === candle || other.low >= candle.low)) lows.push(candle.low);
  }
  return { highs, lows };
}

/**
 * The Asian range: 19:00 to 03:00 ET, so it spans midnight and belongs to the
 * ET day it ends on. It is the session the London open trades against, which
 * is what makes its extremes worth watching.
 */
function asianRange(candles15m: Candle[]) {
  const days = daysOf(candles15m);
  const today = days.at(-1);
  if (!today) return null;

  const [, todayCandles] = today;
  const previous = days.at(-2);
  const overnight = [
    ...(previous ? previous[1].filter((candle) => etParts(candle.time).minutes >= 19 * 60) : []),
    ...todayCandles.filter((candle) => etParts(candle.time).minutes < 3 * 60),
  ];
  return overnight.length ? { high: highest(overnight), low: lowest(overnight) } : null;
}

export function mapLiquidityLevels(
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];

  const asian = asianRange(candles15m);
  if (asian) {
    levels.push({ kind: "asian-high", price: asian.high, side: "high", label: "Asian high" });
    levels.push({ kind: "asian-low", price: asian.low, side: "low", label: "Asian low" });
  }

  const hourDays = daysOf(candles1h);
  const previousDay = hourDays.at(-2);
  if (previousDay) {
    levels.push({ kind: "previous-day-high", price: highest(previousDay[1]), side: "high", label: "Prev day high" });
    levels.push({ kind: "previous-day-low", price: lowest(previousDay[1]), side: "low", label: "Prev day low" });
  }

  // Weeks keyed by the Monday-start block each candle falls in.
  const weeks = new Map<string, Candle[]>();
  for (const candle of candles4h) {
    const at = new Date(candle.time);
    const monday = new Date(at);
    monday.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    weeks.set(key, [...(weeks.get(key) ?? []), candle]);
  }
  const orderedWeeks = [...weeks.entries()].sort(([left], [right]) => left.localeCompare(right));
  const previousWeek = orderedWeeks.at(-2);
  if (previousWeek) {
    levels.push({ kind: "previous-week-high", price: highest(previousWeek[1]), side: "high", label: "Prev week high" });
    levels.push({ kind: "previous-week-low", price: lowest(previousWeek[1]), side: "low", label: "Prev week low" });
  }

  // Only the most recent swing either side: older ones have already been
  // traded through and their stops are gone.
  const swings = swingPoints(candles15m.slice(-120));
  const lastHigh = swings.highs.at(-1);
  const lastLow = swings.lows.at(-1);
  if (lastHigh !== undefined) levels.push({ kind: "swing-high", price: lastHigh, side: "high", label: "Swing high" });
  if (lastLow !== undefined) levels.push({ kind: "swing-low", price: lastLow, side: "low", label: "Swing low" });

  return levels;
}
