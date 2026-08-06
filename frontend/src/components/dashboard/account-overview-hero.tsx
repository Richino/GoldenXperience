"use client";

import { useMemo, useState } from "react";
import {
  AccountAmountChart,
  buildAccountAmountSeries,
  type AccountChartRange,
} from "@/components/dashboard/account-amount-chart";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { SignOutButton } from "@/components/ui/sign-out-button";
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
}: {
  account: AccountSummary;
  userLabel: string;
  trades: PaperTradePoint[];
}) {
  const [range, setRange] = useState<AccountChartRange>("1w");
  const name = greetingName(userLabel);
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

  const baseline = account.nav - account.unrealizedPL;
  const changePercent = baseline !== 0 ? (account.unrealizedPL / baseline) * 100 : 0;
  const positive = changePercent >= 0;

  return (
    <section className="account-overview-hero" aria-label="Account overview">
      <header className="flex items-center justify-between gap-3 lg:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <div className="mobile-account-avatar" aria-hidden>
            {initials(userLabel)}
          </div>
          <p className="truncate text-[1.05rem] font-medium tracking-[-0.02em]">
            Hi, {name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <NotificationBell compact />
          <SignOutButton compact />
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
          {positive ? "+" : ""}
          {changePercent.toFixed(2)}% today
        </span>
      </div>

      <div className="mt-8 lg:mt-10">
        <AccountAmountChart
          series={series}
          currency={account.currency}
          range={range}
          onRangeChange={setRange}
        />
      </div>
    </section>
  );
}
