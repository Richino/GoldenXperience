/** Ported from frontend/src/lib/strategy/session.ts and lib/format/datetime.ts. */

export const NEW_YORK_TIME_ZONE = 'America/New_York';
export const LONDON_TIME_ZONE = 'Europe/London';
export const TOKYO_TIME_ZONE = 'Asia/Tokyo';
export const SYDNEY_TIME_ZONE = 'Australia/Sydney';
export const DAY_TRADING_TIME_ZONE = NEW_YORK_TIME_ZONE;

const SESSION_OPEN_MINUTES = 8 * 60;
const SESSION_CLOSE_MINUTES = 17 * 60;

function localMinutes(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function centreOpen(at: Date, timeZone: string) {
  const minutes = localMinutes(at, timeZone);
  return minutes >= SESSION_OPEN_MINUTES && minutes < SESSION_CLOSE_MINUTES;
}

function weekdayAt(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
}

function centreBusinessOpen(at: Date, timeZone: string) {
  const weekday = weekdayAt(at, timeZone);
  return weekday !== 'Sat' && weekday !== 'Sun' && centreOpen(at, timeZone);
}

type EntrySession = 'London' | 'London/New York overlap' | 'New York';

function getForexSessionStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);

  const marketOpen = Boolean(
    weekday &&
      Number.isFinite(hour) &&
      weekday !== 'Sat' &&
      !(weekday === 'Sun' && hour < 17) &&
      !(weekday === 'Fri' && hour >= 17),
  );

  if (!marketOpen) {
    return { marketOpen: false, entrySession: null as EntrySession | null };
  }

  const london = centreOpen(now, LONDON_TIME_ZONE);
  const newYork = centreOpen(now, NEW_YORK_TIME_ZONE);
  let entrySession: EntrySession | null = null;
  if (london && newYork) entrySession = 'London/New York overlap';
  else if (london) entrySession = 'London';
  else if (newYork) entrySession = 'New York';

  return { marketOpen, entrySession };
}

export type MarketCondition = { marketOpen: boolean; label: string };

export function getMarketCondition(now = new Date()): MarketCondition {
  // Determine the geographic session first. This prevents a stale or
  // platform-specific global-market calculation from masking a live Asian
  // weekday session as "Market closed".
  const tokyo = centreBusinessOpen(now, TOKYO_TIME_ZONE);
  const sydney = centreBusinessOpen(now, SYDNEY_TIME_ZONE);
  if (tokyo || sydney) return { marketOpen: true, label: 'Asia' };

  const status = getForexSessionStatus(now);
  if (!status.marketOpen) return { marketOpen: false, label: 'Closed' };
  if (status.entrySession === 'London/New York overlap') return { marketOpen: true, label: 'London / New York' };
  if (status.entrySession === 'London') return { marketOpen: true, label: 'London' };
  if (status.entrySession === 'New York') return { marketOpen: true, label: 'New York' };
  return { marketOpen: true, label: 'Open' };
}

const PINNED = { timeZone: DAY_TRADING_TIME_ZONE, hourCycle: 'h12' as const };

export function formatShortDay(value: string | number | Date) {
  return new Intl.DateTimeFormat('en-US', { ...PINNED, month: 'short', day: 'numeric' }).format(new Date(value));
}

export function tradingDayKey(value: string | number | Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAY_TRADING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

export function currentTradingDayKey() {
  return tradingDayKey(Date.now());
}

function zonedClockParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Midnight at the start of the trading day that contains `value`. */
export function startOfTradingDay(value: string | number | Date = Date.now()): Date {
  const key = tradingDayKey(value);
  const [year, month, day] = key.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let utc = desired;
  for (let step = 0; step < 4; step += 1) {
    const shown = zonedClockParts(new Date(utc), DAY_TRADING_TIME_ZONE);
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    utc += desired - shownAsUtc;
  }
  return new Date(utc);
}

export function eventTime(timestamp: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: NEW_YORK_TIME_ZONE }).format(
    new Date(timestamp),
  );
}

export function eventDay(timestamp: string) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: NEW_YORK_TIME_ZONE,
  }).format(new Date(timestamp));
}
