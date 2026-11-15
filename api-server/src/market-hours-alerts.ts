import { NEW_YORK_TIME_ZONE, sessionHour } from "../../frontend/src/lib/strategy/session.js";
import { query } from "./database.js";
import { queueNotification, type QueueNotification } from "./notifications.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GRACE = 5 * MINUTE;

/** Regular OANDA forex week. Daily rollover pauses are separate. */
export function dueMarketHoursAlert(now: number) {
  const day = Math.floor(now / DAY) * DAY;
  const weekday = new Date(day).getUTCDay();
  if (weekday !== 0 && weekday !== 5) return null;

  // Both boundaries fall on the same UTC and New York calendar date.
  const opened = weekday === 0;
  const at = sessionHour(day, 17, NEW_YORK_TIME_ZONE) + (opened ? 5 : -1) * MINUTE;
  if (now < at || now >= at + GRACE) return null;

  return {
    kind: "market_hours",
    title: opened ? "Forex market opened" : "Forex market closed",
    message: opened
      ? "The scheduled forex trading week opened at 5:05 p.m. New York time."
      : "The scheduled forex trading week closed at 4:59 p.m. New York time.",
    instrument: null,
    paperTradeId: null,
    dedupeKey: `forex-week:${opened ? "open" : "close"}:${at}`,
    url: "/chart",
    expiresAt: at + GRACE,
  } satisfies Omit<QueueNotification, "userId">;
}

export function startMarketHoursAlerts() {
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active) return;
    const alert = dueMarketHoursAlert(Date.now());
    if (!alert) return;
    active = (async () => {
      const { rows } = await query<{ user_id: string }>("SELECT DISTINCT user_id FROM push_subscriptions");
      for (const { user_id } of rows) {
        if (Date.now() >= alert.expiresAt) break;
        await queueNotification({ ...alert, userId: user_id });
      }
    })().catch(error => console.error("[market-hours-alerts] cycle failed", error))
      .finally(() => { active = null; });
  };
  tick();
  const interval = setInterval(tick, MINUTE);
  return async () => { clearInterval(interval); await active; };
}
