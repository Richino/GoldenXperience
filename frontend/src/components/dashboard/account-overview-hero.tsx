"use client";

import { useMemo, useState } from "react";
import {
  AccountAmountChart,
  accountSeriesTone,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { ACCOUNT_STARTING_BALANCE } from "@/lib/account-starting-balance";
import { tradingDayKey } from "@/lib/format/datetime";
import { useScrolledPast } from "@/lib/use-scrolled-past";
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

function greetingName(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "trader";
  const local = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned;
  const token = local.split(/[.\s_-]+/).find(Boolean) ?? local;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function initials(value: string) {
  const name = greetingName(value);
  return name.slice(0, 1).toUpperCase();
}

export function AccountOverviewHero({
  account,
  userLabel,
  history,
  todayKey,
  openPL,
  riskToday,
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
  riskToday: number;
}) {
  const [range, setRange] = useState<AccountChartRange>("1d");
  const name = greetingName(userLabel);
  // The bell is fixed to the viewport, so the greeting row it was lifted out of
  // is what decides when it stops reading as part of the header.
  const { ref: greetingRef, scrolledPast: greetingScrolledPast } =
    useScrolledPast<HTMLElement>();
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
  // All-time result: where the account sits now versus the opening deposit,
  // floating P&L included (NAV already carries it). This is the "am I up
  // overall?" figure, which the day pill above never answers.
  const allTimePL = account.nav - ACCOUNT_STARTING_BALANCE;
  const allTimePositive = allTimePL >= 0;
  const allTimePercent = (allTimePL / ACCOUNT_STARTING_BALANCE) * 100;
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
      <header
        ref={greetingRef}
        className="flex items-center justify-between gap-3 lg:hidden"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="mobile-account-avatar" aria-hidden>
            {initials(userLabel)}
          </div>
          <p className="truncate text-[1.05rem] font-medium tracking-[-0.02em]">
            Hi, {name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <NotificationBell
            compact
            className={`mobile-floating-icon mobile-floating-icon-end${
              greetingScrolledPast ? " is-lifted" : ""
            }`}
          />
        </div>
      </header>

      <div className="home-hero-copy mt-7 lg:mt-0">
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
        <p className={`home-hero-alltime ${allTimePositive ? "is-positive" : "is-negative"}`}>
          {allTimePositive ? "+" : "−"}
          {money(Math.abs(allTimePL), account.currency)}
          <span>
            ({allTimePositive ? "+" : "−"}
            {Math.abs(allTimePercent).toFixed(2)}%) all-time
          </span>
        </p>
      </div>

      <div className="mt-5 lg:mt-7">
        {/* The pill is today's result; the chart colours its selected period. */}
        <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
        />
        <dl className="home-chart-stats">
          <div>
            <dt>Unrealized</dt>
            <dd className={`metric-number ${signedTone(account.unrealizedPL)}`}>
              {signedMoney(account.unrealizedPL, account.currency)}
            </dd>
          </div>
          <div>
            <dt>Open P/L</dt>
            <dd className={`metric-number ${signedTone(openPL)}`}>
              {signedMoney(openPL, account.currency)}
            </dd>
          </div>
          <div>
            <dt>Margin used</dt>
            <dd className="metric-number">{money(account.marginUsed, account.currency)}</dd>
          </div>
          <div>
            <dt>Risk today</dt>
            <dd className="metric-number">{money(riskToday, account.currency)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
