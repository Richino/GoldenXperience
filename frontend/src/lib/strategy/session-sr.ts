import type { Candle, MajorInstrument } from "@/types/forex";
import {
  LONDON_TIME_ZONE,
  NEW_YORK_TIME_ZONE,
  TOKYO_TIME_ZONE,
  localMinutes,
} from "@/lib/strategy/session";
import { computeSupportResistanceLevels } from "@/lib/strategy/support-resistance";

/**
 * Session S/R overlays — visual only, never fed to an evaluator.
 *
 * At each Asia / London / New York open (08:00 local in that centre's zone),
 * the project's existing `computeSupportResistanceLevels` runs once against the
 * previous 220 *completed* M15 candles whose close is at or before that
 * session start. The returned range/swing levels are frozen for that session
 * day. A refresh mid-session reconstructs the same snapshot from the same
 * pre-session candles (no candle that closes after session start may enter).
 */

export type SessionSrCentre = "asia" | "london" | "newyork";

export interface SessionSrDebug {
  session: SessionSrCentre;
  sessionStart: string;
  snapshotCalculationTime: string;
  lastM15CandleAllowed: string | null;
  historicalCandleCount: number;
  rangeResistance: number;
  swingResistance: number | null;
  rangeSupport: number;
  swingSupport: number | null;
  frozen: true;
}

export interface SessionSrLevels {
  centre: SessionSrCentre;
  /** Local calendar day of this session instance (YYYY-MM-DD in centre TZ). */
  day: string;
  /** Absolute session-open boundary used for the freeze (ISO). */
  sessionStart: string;
  rangeHigh: number;
  rangeLow: number;
  swingHigh: number | null;
  swingLow: number | null;
  debug: SessionSrDebug;
}

/** Match `session.ts` centre hours: open inclusive, close exclusive. */
const SESSION_OPEN_MINUTES = 8 * 60;
const SESSION_CLOSE_MINUTES = 17 * 60;

/** How many completed pre-session M15 candles to feed the S/R engine. */
export const SESSION_SR_PRE_LOOKBACK = 220;

/** M15 bar length — OANDA `time` is bar open; close = open + 15m. */
const M15_MS = 15 * 60 * 1000;

const CENTRE_TIME_ZONE: Record<SessionSrCentre, string> = {
  asia: TOKYO_TIME_ZONE,
  london: LONDON_TIME_ZONE,
  newyork: NEW_YORK_TIME_ZONE,
};

export function sessionSrTimeZone(centre: SessionSrCentre): string {
  return CENTRE_TIME_ZONE[centre];
}

function localDayKey(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Offset of `timeZone` from UTC at `date`, in ms (positive east of UTC).
 * Used to convert a wall-clock local civil time into an absolute UTC instant.
 */
function timezoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/**
 * Absolute UTC ms for `YYYY-MM-DD` at `minutesFromMidnight` in `timeZone`,
 * respecting DST the same way `session.ts` does (Intl, not a fixed offset).
 */
function zonedLocalToUtcMs(
  dayKey: string,
  minutesFromMidnight: number,
  timeZone: string,
): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  // First guess: treat the civil time as UTC, then correct by the zone offset
  // at that instant. One re-pass handles DST transition edges.
  let utc = Date.UTC(year!, month! - 1, day!, hour, minute, 0);
  utc -= timezoneOffsetMs(new Date(utc), timeZone);
  utc = Date.UTC(year!, month! - 1, day!, hour, minute, 0)
    - timezoneOffsetMs(new Date(utc), timeZone);
  return utc;
}

function candleOpenMs(candle: Candle): number {
  return Date.parse(candle.time);
}

function candleCloseMs(candle: Candle): number {
  return candleOpenMs(candle) + M15_MS;
}

function isCompletedM15(candle: Candle): boolean {
  return candle.complete !== false && Number.isFinite(candleOpenMs(candle));
}

function inSessionWindow(at: Date, timeZone: string): boolean {
  const minutes = localMinutes(at, timeZone);
  return minutes >= SESSION_OPEN_MINUTES && minutes < SESSION_CLOSE_MINUTES;
}

/**
 * Completed M15 candles only, oldest → newest. Forming bars are dropped so
 * they can never enter a freeze snapshot.
 */
export function completedM15Candles(candles: Candle[]): Candle[] {
  return candles
    .filter(isCompletedM15)
    .slice()
    .sort((left, right) => candleOpenMs(left) - candleOpenMs(right));
}

/**
 * Local session days that have already opened in this M15 series (first
 * in-session bar seen for that day).
 */
function sessionDaysStarted(
  completed: Candle[],
  timeZone: string,
): string[] {
  const days: string[] = [];
  let prevInSession = false;

  for (const candle of completed) {
    const at = new Date(candle.time);
    const inside = inSessionWindow(at, timeZone);
    if (inside && !prevInSession) {
      days.push(localDayKey(at, timeZone));
    }
    prevInSession = inside;
  }

  return days;
}

/**
 * Active session day for this centre: the latest local day whose 08:00 open
 * is at or before the newest completed M15. Mid-session and after the close
 * both keep that day's frozen snapshot until the next day's open replaces it.
 */
function activeSessionDay(
  completed: Candle[],
  timeZone: string,
): string | null {
  const days = sessionDaysStarted(completed, timeZone);
  if (days.length === 0) return null;

  const last = completed[completed.length - 1]!;
  const lastMs = candleOpenMs(last);

  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index]!;
    const startMs = zonedLocalToUtcMs(day, SESSION_OPEN_MINUTES, timeZone);
    if (startMs <= lastMs + M15_MS) return day;
  }

  return days[days.length - 1] ?? null;
}

/**
 * Frozen S/R for the active Asia / London / New York session day.
 *
 * Deterministic: given the same completed M15 history covering the session
 * open, a refresh one hour into the session returns the identical levels —
 * only bars with close time <= sessionStart and complete === true are used.
 */
export function computeSessionSrLevels(
  candles: Candle[],
  centre: SessionSrCentre,
  instrument: MajorInstrument,
): SessionSrLevels | null {
  const completed = completedM15Candles(candles);
  if (completed.length < 20) return null;

  const timeZone = CENTRE_TIME_ZONE[centre];
  const day = activeSessionDay(completed, timeZone);
  if (!day) return null;

  const sessionStartMs = zonedLocalToUtcMs(day, SESSION_OPEN_MINUTES, timeZone);
  const sessionStartIso = new Date(sessionStartMs).toISOString();

  // Spec: candle close time <= session start T. Forming bar at T is incomplete
  // and already stripped; any bar that closes after T is excluded here.
  const preSession = completed.filter(
    (candle) => candleCloseMs(candle) <= sessionStartMs,
  );

  const history = preSession.slice(-SESSION_SR_PRE_LOOKBACK);
  if (history.length < 20) return null;

  // Existing project S/R engine — unchanged.
  const levels = computeSupportResistanceLevels(history, instrument);
  if (!levels) return null;

  const lastAllowed = history.at(-1) ?? null;
  const snapshotCalculationTime = new Date().toISOString();

  const debug: SessionSrDebug = {
    session: centre,
    sessionStart: sessionStartIso,
    snapshotCalculationTime,
    lastM15CandleAllowed: lastAllowed?.time ?? null,
    historicalCandleCount: history.length,
    rangeResistance: levels.rangeHigh,
    swingResistance: levels.swingHigh,
    rangeSupport: levels.rangeLow,
    swingSupport: levels.swingLow,
    frozen: true,
  };

  return {
    centre,
    day,
    sessionStart: sessionStartIso,
    rangeHigh: levels.rangeHigh,
    rangeLow: levels.rangeLow,
    swingHigh: levels.swingHigh,
    swingLow: levels.swingLow,
    debug,
  };
}

/** Dev-facing dump so a session's freeze can be verified in the console. */
export function logSessionSrDebug(levels: SessionSrLevels): void {
  const d = levels.debug;
  console.info("[session-sr]", {
    Session: d.session,
    "Session start": d.sessionStart,
    "Snapshot calculation time": d.snapshotCalculationTime,
    "Last M15 candle allowed": d.lastM15CandleAllowed,
    "Number of historical candles": d.historicalCandleCount,
    "Range Resistance": d.rangeResistance,
    "Swing Resistance": d.swingResistance,
    "Range Support": d.rangeSupport,
    "Swing Support": d.swingSupport,
    Frozen: d.frozen,
  });
}
