import { getMarketSelectionCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { EconomicCalendarEvent } from "../../frontend/src/lib/oanda/calendar.js";
import { query } from "./database.js";
import { queueNotification, type QueueNotification } from "./notifications.js";

const MINUTE = 60_000;
// Allow a short restart/network delay, without flooding devices with old reminders.
const GRACE_MS = 5 * MINUTE;
type Reminder = Omit<QueueNotification, "userId">;

export function dueNewsReminders(events: EconomicCalendarEvent[], now: number): Reminder[] {
  const groups = new Map<string, EconomicCalendarEvent[]>();
  for (const event of events) {
    const at = Date.parse(event.timestamp);
    if (event.impact < 2 || !Number.isFinite(event.impact) || event.timingVerified !== true || !event.title.trim()
      || !Number.isFinite(at) || at <= now || at > now + 60 * MINUTE || event.actual !== null) continue;
    const key = `${event.currency}:${at}`;
    const group = groups.get(key) ?? [];
    if (!group.some(row => row.title === event.title)) group.push(event);
    groups.set(key, group);
  }
  const reminders: Reminder[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => b.impact - a.impact || a.title.localeCompare(b.title));
    const first = group[0]!;
    const at = Date.parse(first.timestamp);
    for (const lead of [60, 30]) {
      const dueAt = at - lead * MINUTE;
      if (now < dueAt || now - dueAt >= GRACE_MS) continue;
      const title = group.length <= 2 ? group.map(row => row.title).join(" + ") : `${first.title} + ${group.length - 1} more`;
      const minutes = Math.ceil((at - now) / MINUTE);
      reminders.push({
        kind: "news_reminder",
        title: `${first.currency} news in ${minutes === 60 ? "1 hour" : `${minutes} minutes`}`,
        message: `${title}. ${first.impact >= 3 ? "High" : "Medium"} impact. Scheduled for ${new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short",
        }).format(new Date(at))}.`,
        instrument: null,
        paperTradeId: null,
        dedupeKey: `news-reminder:${key}:${lead}`,
        url: "/",
        expiresAt: Math.min(at, dueAt + GRACE_MS),
      });
    }
  }
  return reminders;
}

type Dependencies = {
  calendar: () => Promise<{ events: EconomicCalendarEvent[] }>;
  recipients: () => Promise<string[]>;
  enqueue: (event: QueueNotification) => Promise<boolean>;
  now: () => number;
};

export async function runNewsReminders(deps: Dependencies): Promise<number> {
  // Strict feed read rejects stale/unavailable calendars. Reuses the shared 15-minute cache.
  const calendar = await deps.calendar();
  const reminders = dueNewsReminders(calendar.events, deps.now());
  if (!reminders.length) return 0;
  const users = new Set(await deps.recipients());
  let sent = 0;
  for (const userId of users) {
    for (const reminder of reminders) {
      // Recheck after I/O so a slow queue cannot announce a release that already happened.
      if (reminder.expiresAt! <= deps.now()) continue;
      if (await deps.enqueue({ ...reminder, userId })) sent++;
    }
  }
  return sent;
}

export function startNewsReminders() {
  let active: Promise<unknown> | null = null;
  const tick = () => {
    if (active) return;
    active = runNewsReminders({
      calendar: getMarketSelectionCalendar,
      recipients: async () => (await query<{ user_id: string }>("SELECT DISTINCT user_id FROM push_subscriptions")).rows.map(row => row.user_id),
      enqueue: queueNotification,
      now: Date.now,
    }).catch(error => console.error("[news-reminders] cycle failed", error)).finally(() => { active = null; });
  };
  tick();
  const interval = setInterval(tick, MINUTE);
  return async () => { clearInterval(interval); await active; };
}
