import { tradingDayKey } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint } from "@/types/forex";

const DAILY_RATE = Math.pow(10, 1 / 252) - 1;
const WEEKLY_RATE = Math.pow(10, 1 / 52) - 1;
const HOUR_MS = 60 * 60_000;

/** Quota periods roll over at 1 AM New York time. Weeks start on Sunday. */
export function quotaDayKey(time: number) {
  return tradingDayKey(time - HOUR_MS);
}

export function accountQuota(balance: number, history: AccountBalanceHistoryPoint[], dayKey: string) {
  const day = new Date(`${dayKey}T00:00:00Z`);
  const weekday = day.getUTCDay();
  day.setUTCDate(day.getUTCDate() - weekday);
  const weekKey = day.toISOString().slice(0, 10);
  let dailyRealized = 0;
  let weeklyRealized = 0;
  for (const point of history) {
    const key = quotaDayKey(Date.parse(point.time));
    if (key === dayKey) dailyRealized += point.change;
    if (key >= weekKey && key <= dayKey) weeklyRealized += point.change;
  }

  const weekOpening = balance - weeklyRealized;
  const earlierRealized = weeklyRealized - dailyRealized;
  // Sunday evening shares Monday's target; Saturday uses Friday's target.
  const planDay = Math.min(5, Math.max(1, weekday));
  const dailyPace = weekOpening * (Math.pow(1 + DAILY_RATE, planDay) - 1);
  return {
    daily: { realized: dailyRealized, target: dailyPace - earlierRealized },
    weekly: { realized: weeklyRealized, target: weekOpening * WEEKLY_RATE },
  };
}
