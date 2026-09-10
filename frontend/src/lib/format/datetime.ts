import { DAY_TRADING_TIME_ZONE } from "@/lib/strategy/strategy-engine";

/**
 * Display formatters for anything rendered during SSR.
 *
 * Both options here are load-bearing for hydration, not cosmetics:
 *
 * - `timeZone` — without it the server formats in the host's zone and the
 *   browser in the device's, so any travelling phone renders a different string
 *   than the HTML it is hydrating. Pinning to the trading zone also matches the
 *   session labels ("London", "London/New York overlap", "New York"), whose
 *   boundaries are read off each centre's own clock rather than this one.
 * - `hourCycle` — iOS Safari honours the system "24-Hour Time" switch even for
 *   an explicit en-US locale. With that switch on, the phone renders "13:00"
 *   where the server rendered "1:00 PM": a mismatch that shows up on iPhone
 *   only, and never reproduces on a desktop browser.
 */
const PINNED = {
  timeZone: DAY_TRADING_TIME_ZONE,
  hourCycle: "h12",
} as const;

/** "1:00 PM" */
export function formatClockTime(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** "21:14 ET" — 24-hour Eastern clock for the top bar. */
export function formatEtClock(value: string | number | Date = Date.now()) {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: DAY_TRADING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
  return `${clock} ET`;
}

/** "Aug 6, 1:00 PM" */
export function formatDayAndTime(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** "Aug 6" */
export function formatShortDay(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

/** "Thu" */
export function formatWeekday(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    weekday: "short",
  }).format(new Date(value));
}

/**
 * "2026-08-06" — the calendar day in the trading zone.
 *
 * Comparing these keys is what "closed today" means here: a trade that closed at
 * 16:45 ET is the same session day for every viewer, however their own clock is
 * set.
 */
export function tradingDayKey(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_TRADING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

/**
 * The trading day as of now. Call this on the server and pass the result down:
 * resolving "today" once per request is what keeps a client render from
 * disagreeing with the HTML it hydrates.
 */
export function currentTradingDayKey() {
  return tradingDayKey(Date.now());
}

function zonedClockParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * Midnight at the start of the trading day that contains `value`.
 *
 * The Home 1D chart and the "Today" P/L line must share this instant; a
 * rolling 24-hour window would paint yesterday's ledger into today's curve.
 */
export function startOfTradingDay(value: string | number | Date = Date.now()): Date {
  const key = tradingDayKey(value);
  const [year, month, day] = key.split("-").map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utc = desired;
  for (let step = 0; step < 4; step += 1) {
    const shown = zonedClockParts(new Date(utc), DAY_TRADING_TIME_ZONE);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    utc += desired - shownAsUtc;
  }
  return new Date(utc);
}

/** "1 PM" */
export function formatHour(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    hour: "numeric",
  }).format(new Date(value));
}
