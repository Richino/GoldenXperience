import type { Candle } from "@/types/forex";
import { NEW_YORK_TIME_ZONE } from "@/lib/strategy/session";

/**
 * Previous-day high/low overlay. Visual only — not fed to any evaluator.
 *
 * Days are keyed in America/New_York (standard forex PDH/PDL clock). Levels
 * come from the most recently *completed* ET calendar day only, so today's
 * developing range never moves the lines. Once that day closes, its high and
 * low stay fixed until the next ET day completes.
 */

export interface LastDaySrLevels {
  /** ET calendar day of the completed session (YYYY-MM-DD). */
  day: string;
  high: number;
  low: number;
}

function etDayKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEW_YORK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * High and low of the latest completed New York calendar day in the candle
 * series. Returns null when fewer than two ET days are present (no completed
 * prior day to freeze yet).
 */
export function computeLastDaySrLevels(candles: Candle[]): LastDaySrLevels | null {
  const byDay = new Map<string, { high: number; low: number }>();

  for (const candle of candles) {
    const at = new Date(candle.time);
    if (!Number.isFinite(at.getTime())) continue;
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) continue;

    const day = etDayKey(at);
    const existing = byDay.get(day);
    if (!existing) {
      byDay.set(day, { high: candle.high, low: candle.low });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
  }

  // The newest candle's ET day is still forming — exclude it so the lines stay
  // on yesterday's fixed high/low no matter where price trades today.
  const lastAt = candles.length ? new Date(candles[candles.length - 1]!.time) : null;
  const inProgressDay =
    lastAt && Number.isFinite(lastAt.getTime()) ? etDayKey(lastAt) : null;

  const completedDays = [...byDay.keys()]
    .filter((day) => day !== inProgressDay)
    .sort();
  const frozenDay = completedDays.at(-1);
  if (!frozenDay) return null;
  const range = byDay.get(frozenDay);
  if (!range) return null;

  return {
    day: frozenDay,
    high: range.high,
    low: range.low,
  };
}
