export type EntrySession = "London" | "London/New York overlap" | "New York";

export interface ForexSessionStatus {
  marketOpen: boolean;
  entrySession: EntrySession | null;
  label: string;
}

export const LONDON_TIME_ZONE = "Europe/London";
export const NEW_YORK_TIME_ZONE = "America/New_York";

/** Both centres keep 08:00–17:00 on their own wall clock. */
const SESSION_OPEN_MINUTES = 8 * 60;
const SESSION_CLOSE_MINUTES = 17 * 60;

/** Minutes past local midnight in the given zone. */
export function localMinutes(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function centreOpen(at: Date, timeZone: string) {
  const minutes = localMinutes(at, timeZone);
  return minutes >= SESSION_OPEN_MINUTES && minutes < SESSION_CLOSE_MINUTES;
}

/**
 * Forex has a Sunday 17:00 ET open and Friday 17:00 ET close. Inside that,
 * London and New York are each resolved against their own zone rather than a
 * fixed Eastern offset: the UK and US change daylight saving on different
 * dates, so for a few weeks every spring and autumn an ET-anchored boundary
 * sits an hour away from the London open it is meant to track.
 *
 * This reports which centre is trading. It does not decide entries — the
 * day-trading entry window is `dayTradingSession` in the strategy engine,
 * which also stops entries at the forced exit.
 */
export function getForexSessionStatus(now = new Date()): ForexSessionStatus {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  const marketOpen = Boolean(
    weekday && Number.isFinite(hour) &&
      weekday !== "Sat" &&
      !(weekday === "Sun" && hour < 17) &&
      !(weekday === "Fri" && hour >= 17),
  );

  if (!marketOpen) {
    return { marketOpen: false, entrySession: null, label: "Forex market closed" };
  }

  const london = centreOpen(now, LONDON_TIME_ZONE);
  const newYork = centreOpen(now, NEW_YORK_TIME_ZONE);
  const entrySession: EntrySession | null = london && newYork
    ? "London/New York overlap"
    : london
      ? "London"
      : newYork
        ? "New York"
        : null;

  return { marketOpen: true, entrySession, label: entrySession ?? "Outside London/New York sessions" };
}
