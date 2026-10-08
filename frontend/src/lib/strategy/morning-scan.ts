import type { PairTradability } from "./ny-tradability";
import { getForexSessionStatus, localMinutes, NEW_YORK_TIME_ZONE } from "./session";

export const MORNING_SCAN_CADENCE_MS = 5 * 60_000;
export const MORNING_SCAN_STALE_MS = 7 * 60_000;
export function morningDateKey(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: NEW_YORK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function morningScanSlot(now: Date, closedDates: readonly string[] = []) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: NEW_YORK_TIME_ZONE, weekday: "short" }).format(now);
  const minutes = localMinutes(now, NEW_YORK_TIME_ZONE);
  if (weekday === "Sat" || weekday === "Sun" || !getForexSessionStatus(now).marketOpen || closedDates.includes(morningDateKey(now)) || minutes < 390 || minutes >= 660) return null;
  return `${morningDateKey(now)}:${Math.floor((minutes - 390) / 5)}`;
}
export interface MorningScanRun {
  id: string;
  dateEt: string;
  version: string;
  mode: "Normal";
  startedAt: string;
  completedAt: string;
  evaluatedAt: string;
  durationMs: number;
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "CLOSED";
  pairs: PairTradability[];
  shortlist: string[];
  sharedCurrencies: string[];
  newsFetchedAt: string | null;
  newsCoverageUntil: string | null;
  failures: string[];
  error: string | null;
}
export interface MorningPicksSnapshot {
  state: "READY" | "STALE" | "UNAVAILABLE" | "CLOSED" | "OUTSIDE_WINDOW";
  current: MorningScanRun | null;
  lastAttempt: { status: string; startedAt: string; error: string | null } | null;
  refreshing: boolean;
  checkedAt: string;
}
export function morningPicksState(run: MorningScanRun | null, failed: boolean, now: Date, closedDates: readonly string[] = []): MorningPicksSnapshot["state"] {
  if (!getForexSessionStatus(now).marketOpen || closedDates.includes(morningDateKey(now)) || run?.status === "CLOSED" && morningDateKey(now) === run.dateEt) return "CLOSED";
  if (run && (failed || now.getTime() - Date.parse(run.evaluatedAt) > MORNING_SCAN_STALE_MS || run.dateEt !== morningDateKey(now))) return "STALE";
  if (!morningScanSlot(now, closedDates)) return "OUTSIDE_WINDOW";
  return run ? "READY" : "UNAVAILABLE";
}
export function morningChartHref(instrument: string) {
  return `/chart?instrument=${encodeURIComponent(instrument)}`;
}
