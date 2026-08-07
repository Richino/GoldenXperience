import { DAY_TRADING_TIME_ZONE } from "@/lib/strategy/strategy-engine";

/**
 * Display formatters for anything rendered during SSR.
 *
 * Both options here are load-bearing for hydration, not cosmetics:
 *
 * - `timeZone` — without it the server formats in the host's zone and the
 *   browser in the device's, so any travelling phone renders a different string
 *   than the HTML it is hydrating. Pinning to the trading zone also matches the
 *   session labels ("London", "London/New York overlap"), which are already ET.
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

/** "1 PM" */
export function formatHour(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    ...PINNED,
    hour: "numeric",
  }).format(new Date(value));
}
