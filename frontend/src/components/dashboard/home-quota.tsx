"use client";

import { useEffect, useMemo, useState } from "react";
import { tradingDayKey } from "@/lib/format/datetime";
import type { AccountBalanceHistoryPoint, AccountSummary } from "@/types/forex";

/**
 * 10× in one year, compounding: 10^(1/252) per trading day, 10^(1/52) per
 * week. Each target is a share of the equity at the start of its period, so
 * the dollar quota grows with the account.
 */
const DAILY_RATE = Math.pow(10, 1 / 252) - 1; // ≈ 0.92%
const WEEKLY_RATE = Math.pow(10, 1 / 52) - 1; // ≈ 4.53%

/**
 * Quota days run 1:00 AM to 1:00 AM New York time, so shifting a timestamp
 * back an hour and reading its ET date gives the quota day it belongs to.
 */
const QUOTA_DAY_START_MS = 60 * 60 * 1000;

export function quotaDayKey(value: string | number | Date) {
  return tradingDayKey(new Date(value).getTime() - QUOTA_DAY_START_MS);
}

/** Quota weeks run Sunday 1:00 AM through Saturday, ET: keyed by their Sunday. */
export function quotaWeekKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.toISOString().slice(0, 10);
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

function signedMoney(value: number, currency: string) {
  return `${value >= 0 ? "+" : "−"}${money(Math.abs(value), currency)}`;
}

/**
 * Today's target with the week carried in: where the daily plan says the
 * balance should be by the end of today, minus what this week already made
 * before today. A good day lowers tomorrow's target, a losing day raises it;
 * it starts over with the week. Sunday's evening session shares Monday's
 * plan day, and Saturday has no session of its own.
 */
export function carriedDailyTarget(weekOpening: number, madeEarlierThisWeek: number, todayKey: string) {
  const [year, month, day] = todayKey.split("-").map(Number);
  const planDay = Math.min(5, Math.max(1, new Date(Date.UTC(year, month - 1, day)).getUTCDay()));
  const pace = weekOpening * (Math.pow(1 + DAILY_RATE, planDay) - 1);
  // Negative when already ahead of plan: shown as $0, but a loss today still
  // has to be measured against that lead.
  return { pace, target: pace - madeEarlierThisWeek };
}

function QuotaRow({ label, rate, pl, target, open, currency }: { label: string; rate: number; pl: number; target: number; open: number; currency: string }) {
  const met = pl >= target;
  const remaining = target - pl;
  const progress = target > 0 ? Math.max(0, Math.min(1, pl / target)) : met ? 1 : 0;
  return (
    <div className={`nl-quota-row${met ? " is-met" : ""}`}>
      <div className="nl-quota-top">
        <span className="nl-quota-label">{label}</span>
        <span className="nl-quota-rate metric-number">+{(rate * 100).toFixed(2)}%</span>
      </div>
      <div className="nl-quota-amounts metric-number">
        <b className={pl > 0.005 ? "is-up" : pl < -0.005 ? "is-down" : "is-flat"}>{signedMoney(pl, currency)}</b>
        <span> / {money(Math.max(0, target), currency)}</span>
      </div>
      <div className="nl-quota-bar" role="progressbar" aria-label={`${label} quota`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="nl-quota-note metric-number">
        {met ? `Quota met · +${money(pl - target, currency)} over` : `${money(remaining, currency)} to go · ${Math.round(progress * 100)}%`}
        {/* Floating P/L is shown, never counted, until the trade closes. */}
        {Math.abs(open) >= 0.5 ? <span className={open > 0 ? "is-up" : "is-down"}> · {signedMoney(open, currency)} open</span> : null}
      </span>
    </div>
  );
}

/** The current quota day, re-read every 30 s so an open page rolls over at 1 AM. */
function useQuotaDayKey() {
  const [key, setKey] = useState(() => quotaDayKey(Date.now()));
  useEffect(() => {
    const id = window.setInterval(() => setKey(quotaDayKey(Date.now())), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return key;
}

export function HomeQuota({
  account,
  history,
}: {
  account: AccountSummary;
  history: AccountBalanceHistoryPoint[];
}) {
  const todayKey = useQuotaDayKey();
  // Only balance movements booked in this quota day / week count: what you
  // actually made. Open positions are listed beside it, not added in.
  const { dayRealized, weekRealized } = useMemo(() => {
    const weekKey = quotaWeekKey(todayKey);
    let day = 0;
    let week = 0;
    for (const point of history) {
      const key = quotaDayKey(point.time);
      if (key === todayKey) day += point.change;
      if (key >= weekKey && key <= todayKey) week += point.change;
    }
    return { dayRealized: day, weekRealized: week };
  }, [history, todayKey]);

  const weekOpening = account.balance - weekRealized;
  const earlier = weekRealized - dayRealized;
  const daily = carriedDailyTarget(weekOpening, earlier, todayKey);

  return (
    <section className="nl-quota" aria-labelledby="nl-quota-title">
      <div className="nl-quota-head">
        <h2 id="nl-quota-title">Quota</h2>
      </div>
      <div className="nl-quota-grid">
        <QuotaRow label="Today" rate={DAILY_RATE} pl={dayRealized} target={daily.target}open={account.unrealizedPL} currency={account.currency} />
        <QuotaRow label="This week" rate={WEEKLY_RATE} pl={weekRealized} target={weekOpening * WEEKLY_RATE} open={account.unrealizedPL} currency={account.currency} />
      </div>
    </section>
  );
}
