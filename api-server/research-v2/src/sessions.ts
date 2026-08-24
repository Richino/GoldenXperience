import { localMinutes, LONDON_TIME_ZONE, NEW_YORK_TIME_ZONE } from "../../../frontend/src/lib/strategy/session.js";
import type { RegimeSnapshot } from "./types.js";

const SESSION_OPEN = 8 * 60;
const SESSION_CLOSE = 17 * 60;
const ASIA_OPEN = 0;
const ASIA_CLOSE = 8 * 60; // Tokyo morning approx on London clock

function centreOpen(at: Date, timeZone: string) {
  const minutes = localMinutes(at, timeZone);
  return minutes >= SESSION_OPEN && minutes < SESSION_CLOSE;
}

export function classifySession(at: Date): RegimeSnapshot["session"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const marketOpen = Boolean(
    weekday && Number.isFinite(hour) &&
      weekday !== "Sat" &&
      !(weekday === "Sun" && hour < 17) &&
      !(weekday === "Fri" && hour >= 17),
  );
  if (!marketOpen) return "off";

  const london = centreOpen(at, LONDON_TIME_ZONE);
  const newYork = centreOpen(at, NEW_YORK_TIME_ZONE);
  if (london && newYork) return "overlap";
  if (london) return "london";
  if (newYork) return "newyork";

  const londonMinutes = localMinutes(at, LONDON_TIME_ZONE);
  if (londonMinutes >= ASIA_OPEN && londonMinutes < ASIA_CLOSE) return "asia";
  return "off";
}

export function sessionOneHot(session: RegimeSnapshot["session"]): Record<string, number> {
  return {
    sess_asia: session === "asia" ? 1 : 0,
    sess_london: session === "london" ? 1 : 0,
    sess_newyork: session === "newyork" ? 1 : 0,
    sess_overlap: session === "overlap" ? 1 : 0,
    sess_off: session === "off" ? 1 : 0,
  };
}
