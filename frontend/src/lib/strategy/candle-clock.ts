import { getForexSessionStatus, localMinutes, sessionHour, NEW_YORK_TIME_ZONE } from "./session";

/** Versioned OANDA defaults, explicitly sent on every candle request. Times are opens. */
export const CANDLE_ALIGNMENT = { version: "oanda-ny17-v1", dailyAlignment: 17, alignmentTimezone: NEW_YORK_TIME_ZONE } as const;
const HOUR = 3_600_000, DAY = 24 * HOUR;
export type TradingInterruption = { from: number; to: number };
export type CandleSchedule = { instrument?: string; interruptions?: TradingInterruption[] };

/** OANDA opens must match the explicitly requested NY17 alignment. */
export function candleAligned(open: number, timeframe: string): boolean {
  if (!Number.isFinite(open)) return false;
  if (["D", "D1", "H4"].includes(timeframe)) {
    if (open % HOUR !== 0) return false;
    const hour = Math.floor(localMinutes(new Date(open), NEW_YORK_TIME_ZONE) / 60);
    return timeframe === "H4" ? (hour + 7) % 4 === 0 : hour === 17;
  }
  const minutes = ({ M1: 1, M5: 5, M15: 15, M30: 30, H1: 60 } as Record<string, number>)[timeframe];
  return minutes ? open % (minutes * 60_000) === 0 : true;
}

export function candleEnd(open: number, timeframe: string): number {
  if (!Number.isFinite(open)) return NaN;
  if (timeframe === "D" || timeframe === "D1") {
    const day = Math.floor(open / DAY) * DAY;
    const same = sessionHour(day, 17, NEW_YORK_TIME_ZONE);
    return same > open ? same : sessionHour(day + DAY, 17, NEW_YORK_TIME_ZONE);
  }
  if (timeframe === "H4") {
    // Wall-clock boundaries anchored to 17:00 New York. Scanning UTC hours also
    // handles the repeated/missing DST hour during the closed weekend.
    for (let at = Math.floor(open / HOUR) * HOUR + HOUR; at <= open + 6 * HOUR; at += HOUR) {
      if ((Math.floor(localMinutes(new Date(at), NEW_YORK_TIME_ZONE) / 60) + 7) % 4 === 0) return at;
    }
  }
  const minutes = ({ M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240 } as Record<string, number>)[timeframe];
  if (!minutes) throw new Error(`Unsupported candle clock: ${timeframe}`);
  return open + minutes * 60_000;
}

/** True only for a published FX trading minute, excluding explicit broker interruptions. */
export function brokerOpen(at: number, interruptions: TradingInterruption[] = [], instrument?: string): boolean {
  if (interruptions.some(i => at >= i.from && at < i.to)) return false;
  if (!getForexSessionStatus(new Date(at)).marketOpen) return false;
  const minute = localMinutes(new Date(at), NEW_YORK_TIME_ZONE);
  if (minute >= 16 * 60 + 59 && minute < 17 * 60 + 5) return false;
  if (instrument?.includes("NZD")) {
    const nz = localMinutes(new Date(at), "Pacific/Auckland");
    if (nz >= 6 * 60 + 59 && nz < 7 * 60 + 5) return false;
  }
  return true;
}

/** A bar can exist when any portion of its interval traded (including partial reopening bars). */
export function intervalTraded(from: number, to: number, interruptions: TradingInterruption[] = [], instrument?: string): boolean {
  for (let at = from; at < to;) {
    if (brokerOpen(at, interruptions, instrument)) return true;
    at += getForexSessionStatus(new Date(at)).marketOpen ? 60_000 : Math.min(3_600_000 - at % 3_600_000, to - at);
  }
  return false;
}

export function candleHealth(open: number, timeframe: string, now: number, interruptions: TradingInterruption[] = [], instrument?: string) {
  const end = candleEnd(open, timeframe);
  let missing = 0, nextCompletion: number | null = null;
  // A bounded scan fails closed for history older than a month.
  if (!Number.isFinite(open) || end > now || now - end > 32 * DAY) return { end, missing: Infinity, nextCompletion };
  for (let start = end; start <= now + 8 * DAY;) {
    const finish = candleEnd(start, timeframe);
    if (intervalTraded(start, finish, interruptions, instrument)) {
      if (finish <= now - 120_000) missing++;
      else { nextCompletion = finish; break; }
    }
    start = finish;
  }
  return { end, missing, nextCompletion };
}
