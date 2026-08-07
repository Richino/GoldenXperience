"use client";

import { useMemo, useState } from "react";
import {
  AccountAmountChart,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { tradingDayKey } from "@/lib/format/datetime";
import { useScrolledPast } from "@/lib/use-scrolled-past";
import type { AccountSummary } from "@/types/forex";

type PaperTradePoint = {
  paperPl: number | null;
  closedAt: string | null;
  openedAt: string;
  status: string;
};

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
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
  trades,
  todayKey,
}: {
  account: AccountSummary;
  userLabel: string;
  trades: PaperTradePoint[];
  /**
   * The current ET day, resolved on the server. Reading the clock during render
   * would make the server and the browser disagree across a midnight boundary
   * and break hydration.
   */
  todayKey: string;
}) {
  const [range, setRange] = useState<AccountChartRange>("1w");
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
        trades,
        range,
      }),
    [account.nav, account.unrealizedPL, trades, range],
  );

  // "Today" is everything the account actually moved this session: paper trades
  // banked since the ET day opened, plus whatever is still floating on open
  // positions. Unrealized alone is why this read +0.00% on any day that closed
  // its trades — the realized part was missing.
  const dayPL = useMemo(() => {
    const realized = trades.reduce(
      (sum, trade) =>
        trade.closedAt &&
        trade.paperPl !== null &&
        tradingDayKey(trade.closedAt) === todayKey
          ? sum + trade.paperPl
          : sum,
      0,
    );

    return realized + account.unrealizedPL;
  }, [account.unrealizedPL, todayKey, trades]);

  const baseline = account.nav - dayPL;
  const changePercent = baseline !== 0 ? (dayPL / baseline) * 100 : 0;
  const positive = dayPL >= 0;

  return (
    <section
      className="account-overview-hero"
      data-tone={positive ? "positive" : "negative"}
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

      <div className="mt-7 lg:mt-0">
        <p className="hidden text-sm text-[color:var(--muted)] lg:block">Hi, {name}</p>
        <p className="metric-number mt-0 text-[2.65rem] font-semibold leading-none tracking-[-0.05em] lg:mt-3 lg:text-[3.25rem]">
          {money(account.nav, account.currency)}
        </p>
        <span
          className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
            positive
              ? "bg-[color:var(--success-soft)] text-[color:var(--success)]"
              : "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
          }`}
        >
          {positive ? "+" : "−"}
          {money(Math.abs(dayPL), account.currency)}
          <span className="mx-1.5 opacity-45">·</span>
          {positive ? "+" : "−"}
          {Math.abs(changePercent).toFixed(2)}% today
        </span>
      </div>

      <div className="mt-5 lg:mt-7">
        <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
          positive={positive}
        />
      </div>
    </section>
  );
}
