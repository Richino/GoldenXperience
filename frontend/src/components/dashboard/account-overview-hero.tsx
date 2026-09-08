"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AccountAmountChart,
  AccountRangeControl,
  accountSeriesTone,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { BrandMark } from "@/components/ui/brand-mark";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { tradingDayKey } from "@/lib/format/datetime";
import { getMarketCondition } from "@/lib/strategy/session";
import type { AccountBalanceHistoryPoint, AccountSummary } from "@/types/forex";

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function signedMoney(value: number, currency: string) {
  const formatted = money(Math.abs(value), currency);
  if (Math.abs(value) < 0.005) return formatted;
  return `${value > 0 ? "+" : "−"}${formatted}`;
}

function signedTone(value: number) {
  if (Math.abs(value) < 0.005) return "is-flat";
  return value > 0 ? "is-positive" : "is-negative";
}

export function AccountOverviewHero({
  account,
  history,
  todayKey,
  openPL,
  riskTodayPercent,
  riskLimitPercent,
}: {
  account: AccountSummary;
  userLabel: string;
  history: AccountBalanceHistoryPoint[];
  /**
   * The current ET day, resolved on the server. Reading the clock during render
   * would make the server and the browser disagree across a midnight boundary
   * and break hydration.
   */
  todayKey: string;
  openPL: number;
  /** Open nominal risk as a percent of the account, e.g. 1.0. */
  riskTodayPercent: number;
  /** The daily-loss guard, shown as the "limit" alongside risk today. */
  riskLimitPercent: number;
}) {
  const [range, setRange] = useState<AccountChartRange>("1d");
  // Client-only so the server and first client render agree; the label depends
  // on the wall clock, which the server cannot know for the viewer's minute.
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => setMarketOpen(getMarketCondition().marketOpen);
    read();
    const timer = window.setInterval(read, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const series = useMemo(
    () =>
      buildAccountAmountSeries({
        nav: account.nav,
        unrealizedPL: account.unrealizedPL,
        history,
        range,
      }),
    [account.nav, account.unrealizedPL, history, range],
  );

  // "Today" is every broker-reported balance movement this session plus the
  // still-floating value on open positions. Strategy estimates are deliberately
  // excluded because they can differ from the executed practice-account fill.
  const dayPL = useMemo(() => {
    const realized = history.reduce(
      (sum, point) =>
        tradingDayKey(point.time) === todayKey
          ? sum + point.change
          : sum,
      0,
    );

    return realized + account.unrealizedPL;
  }, [account.unrealizedPL, todayKey, history]);

  const baseline = account.nav - dayPL;
  const changePercent = baseline !== 0 ? (dayPL / baseline) * 100 : 0;
  const positive = dayPL >= 0;
  // The card's tint follows the chart it wraps, not the day's P/L. Those are
  // different questions and they disagree often — a flat day around a losing
  // month painted the card green while the line inside it was red.
  const chartTone = accountSeriesTone(series);
  const heroTone = (() => {
    switch (chartTone) {
      case "up":
        return "positive";
      case "down":
        return "negative";
      case "flat":
        return "flat";
      default: {
        const _never: never = chartTone;
        return _never;
      }
    }
  })();

  return (
    <section
      className="account-overview-hero"
      data-tone={heroTone}
      aria-label="Account overview"
    >
      <header className="home-hero-topbar lg:hidden">
        <BrandMark compact />
        <div className="home-hero-topbar-end">
          <span
            className={`home-market-pill ${marketOpen === false ? "is-closed" : "is-open"}`}
          >
            <span className="home-market-dot" aria-hidden="true" />
            {marketOpen === false ? "Market closed" : "Market open"}
          </span>
          <NotificationBell compact className="home-hero-bell" />
        </div>
      </header>

      <div className="home-hero-head mt-6 lg:mt-0">
        <div className="home-hero-copy">
          <p className="home-hero-label">Total balance</p>
          <p className="home-hero-nav metric-number">
            {money(account.nav, account.currency)}
          </p>
          <p className={`home-hero-today ${positive ? "is-positive" : "is-negative"}`}>
            {positive ? "+" : "−"}
            {money(Math.abs(dayPL), account.currency)}
            <span>
              ({positive ? "+" : "−"}
              {Math.abs(changePercent).toFixed(2)}%) Today
            </span>
          </p>
        </div>
        <AccountRangeControl
          range={range}
          onRangeChange={setRange}
          className="home-hero-range"
        />
      </div>

      <div className="mt-5 lg:mt-7">
        {/* The pill is today's result; the chart colours its selected period. */}
        <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
          hideRangeRow
        />
        <dl className="home-chart-stats">
          <div>
            <dt>Available</dt>
            <dd className="metric-number">
              {money(account.marginAvailable, account.currency)}
            </dd>
          </div>
          <div>
            <dt>Open P&amp;L</dt>
            <dd className={`metric-number ${signedTone(openPL)}`}>
              {signedMoney(openPL, account.currency)}
            </dd>
          </div>
          <div className="home-stat-desktop">
            <dt>Margin used</dt>
            <dd className="metric-number">{money(account.marginUsed, account.currency)}</dd>
          </div>
          <div>
            <dt>Risk today</dt>
            <dd className="metric-number">
              {riskTodayPercent.toFixed(1)}%
              <span className="home-stat-sub">{riskLimitPercent.toFixed(1)}% limit</span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
