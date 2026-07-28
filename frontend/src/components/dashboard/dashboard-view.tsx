"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Radio,
  ShieldCheck,
} from "lucide-react";
import { SectionLabel } from "@/components/ui/section-label";
import { formatChartPrice, spreadInPips } from "@/lib/chart-utils";
import { usePaperJournalDay } from "@/lib/journal/use-paper-journal-day";
import { useJournalTrades } from "@/lib/journal/use-journal-trades";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import { DEFAULT_RISK_POLICY, deriveTradePermission } from "@/lib/risk/engine";
import type { StrategySetup } from "@/lib/strategy/types";
import type { AccountSummary, ConnectionStatus, JournalTrade } from "@/types/forex";

const DASHBOARD_INSTRUMENT = "EUR_USD";

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateTime(value: string | null) {
  if (!value) return "Waiting for an update";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function isForexMarketOpen(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  if (!weekday || !Number.isFinite(hour)) return false;
  if (weekday === "Sat") return false;
  if (weekday === "Sun") return hour >= 17;
  if (weekday === "Fri") return hour < 17;
  return true;
}

function connectionLabel(status: ConnectionStatus) {
  if (status.state === "connected") {
    return `OANDA ${status.environment === "practice" ? "Practice" : "Live"}`;
  }

  return status.label;
}

function streamLabel(state: ReturnType<typeof useMarketStream>["state"]) {
  if (state === "connected") return "Live";
  if (state === "mock") return "Mock";
  if (state === "connecting" || state === "idle") return "Connecting";
  return "Offline";
}

function statusTone(connected: boolean) {
  return connected
    ? "bg-[color:var(--success-soft)] text-[color:var(--success)]"
    : "bg-[color:var(--danger-soft)] text-[color:var(--danger)]";
}

function recentPaperTrades(trades: JournalTrade[]) {
  return [...trades]
    .filter((trade) => trade.origin === "manual")
    .sort(
      (left, right) =>
        Date.parse(right.closedAt ?? right.openedAt) -
        Date.parse(left.closedAt ?? left.openedAt),
    )
    .slice(0, 5);
}

export function DashboardView({
  status,
  account,
  strategy,
}: {
  status: ConnectionStatus;
  account: AccountSummary;
  strategy: StrategySetup;
}) {
  const journalDay = usePaperJournalDay();
  const trades = useJournalTrades();
  const { snapshot: calendar, loading: calendarLoading } = useEconomicCalendar();
  const marketStream = useMarketStream(DASHBOARD_INSTRUMENT, undefined, {
    trackPrice: true,
  });
  const livePrice = marketStream.price;
  const liveSpreadPips = livePrice
    ? Number(
        spreadInPips(DASHBOARD_INSTRUMENT, livePrice.bid, livePrice.ask),
      )
    : null;
  const usedRiskPercent = journalDay.losingR * DEFAULT_RISK_POLICY.riskPercent;
  const remainingRiskPercent = Math.max(
    0,
    DEFAULT_RISK_POLICY.maxDailyLossPercent - usedRiskPercent,
  );
  const remainingTrades = Math.max(
    0,
    DEFAULT_RISK_POLICY.maxTradesPerDay - journalDay.tradesTaken,
  );
  const marketOpen = isForexMarketOpen();
  const permission = deriveTradePermission({
    restConnected: status.state === "connected",
    streamState: marketStream.state,
    marketOpen,
    calendarConnected: !calendarLoading && calendar.connected,
    dailyLossPercent: usedRiskPercent,
    tradesTaken: journalDay.tradesTaken,
    consecutiveLosses: journalDay.consecutiveLosses,
    setupValid: strategy.status === "valid",
    highImpactNewsWithinMinutes: calendar.highImpactNewsWithinMinutes,
    spreadPips: liveSpreadPips,
  });
  const paperTrades = recentPaperTrades(trades);
  const riskUsedWidth = Math.min(
    100,
    (usedRiskPercent / DEFAULT_RISK_POLICY.maxDailyLossPercent) * 100,
  );
  const restConnected = status.state === "connected";
  const streamConnected = marketStream.state === "connected";

  return (
    <div className="dashboard-view space-y-5">
      <section className="app-card-hero p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-[color:var(--muted)]">
              GoldenXperience · personal forex cockpit
            </p>
            <h1 className="text-display mt-2">Today&apos;s trade readout</h1>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Connection, live market conditions, risk limits, and paper-trade history.
            </p>
          </div>
          <div
            className={`permission-pill ${
              permission.permission === "allowed"
                ? "bg-[color:var(--success-soft)] text-[color:var(--success)]"
                : "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
            }`}
            role="status"
          >
            <ShieldCheck className="size-3.5" strokeWidth={2.25} />
            {permission.label}
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel title="Connection status" variant="minimal" />
              <p className="mt-1 text-sm text-[color:var(--muted)]">
                Broker credentials stay on the server.
              </p>
            </div>
            <span
              className={`permission-pill shrink-0 ${statusTone(restConnected)}`}
            >
              <Radio className="size-3.5" />
              {connectionLabel(status)}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[color:var(--border)] pt-4">
            {[
              ["Account reachable", restConnected ? "Yes" : "No"],
              ["Pricing stream", streamLabel(marketStream.state)],
              ["Environment", status.environment],
              ["Account checked", formatDateTime(status.checkedAt)],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="text-xs text-[color:var(--muted)]">{label}</div>
                <div className="mt-0.5 text-sm font-medium">{value}</div>
              </div>
            ))}
          </div>

          {!restConnected || !streamConnected ? (
            <p className="mt-3 flex items-start gap-2 border-t border-[color:var(--border)] pt-3 text-xs leading-5 text-[color:var(--danger)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {streamConnected ? status.message : marketStream.message}
            </p>
          ) : null}
        </section>

        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel title="Live market status" variant="minimal" />
              <p className="mt-1 text-sm text-[color:var(--muted)]">
                {livePrice?.displayName ?? "EUR/USD"} ·{" "}
                {marketStream.source === "mock" ? "Mock quote" : "OANDA stream"}
              </p>
            </div>
            <span
              className={`permission-pill shrink-0 ${statusTone(streamConnected)}`}
            >
              <Activity className="size-3.5" />
              {streamLabel(marketStream.state)}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-4 border-t border-[color:var(--border)] pt-4">
            {[
              ["Bid", livePrice ? formatChartPrice(livePrice.bid, DASHBOARD_INSTRUMENT) : "—"],
              ["Ask", livePrice ? formatChartPrice(livePrice.ask, DASHBOARD_INSTRUMENT) : "—"],
              ["Spread", liveSpreadPips === null ? "—" : `${liveSpreadPips.toFixed(1)} pips`],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="text-xs text-[color:var(--muted)]">{label}</div>
                <div className="metric-number mt-0.5 text-sm font-semibold tracking-[-0.03em]">
                  {value}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 border-t border-[color:var(--border)] pt-3 text-xs text-[color:var(--muted)]">
            Last update {formatDateTime(marketStream.lastPriceAt)}
          </p>
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel title="Trade permission" variant="minimal" />
              <p className="mt-1 text-sm text-[color:var(--muted)]">
                Advisory only — no order placement is enabled in this app.
              </p>
            </div>
            <span
              className={`permission-pill shrink-0 ${
                permission.permission === "allowed"
                  ? "bg-[color:var(--success-soft)] text-[color:var(--success)]"
                  : "bg-[color:var(--danger-soft)] text-[color:var(--danger)]"
              }`}
              role="status"
            >
              {permission.permission === "allowed" ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <AlertTriangle className="size-3.5" />
              )}
              {permission.label}
            </span>
          </div>

          <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm font-medium leading-snug">
            {permission.reason}
          </p>

          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[color:var(--border)] pt-4">
            {[
              ["Market", marketOpen ? "Open" : "Closed"],
              [
                "News filter",
                calendarLoading
                  ? "Checking"
                  : calendar.connected
                    ? "ForexFactory connected"
                    : "Unavailable",
              ],
              [
                "Spread limit",
                liveSpreadPips === null
                  ? "Waiting for quote"
                  : `${liveSpreadPips.toFixed(1)} / 1.5 pips`,
              ],
              ["Strategy setup", strategy.status === "valid" ? "Verified" : strategy.status.replace("_", " ")],
            ].map(([label, value]) => (
              <div key={label}>
                <div className="text-xs text-[color:var(--muted)]">{label}</div>
                <div className="mt-0.5 text-sm font-medium">{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="app-card p-5 md:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SectionLabel title="Best current setup" variant="minimal" />
              <p className="mt-1 text-sm text-[color:var(--muted)]">
                Server-evaluated M15 confluence with 1H and 4H confirmation.
              </p>
            </div>
            <span className={`permission-pill shrink-0 ${strategy.status === "valid" ? "bg-[color:var(--success-soft)] text-[color:var(--success)]" : "bg-[color:var(--minimal-track)] text-[color:var(--muted)]"}`}>
              {strategy.status.replace("_", " ")}
            </span>
          </div>

          <div className="mt-4 border-t border-[color:var(--border)] pt-4">
            <p className="text-sm font-medium">{strategy.pair}{strategy.direction ? ` · ${strategy.direction}` : ""}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-[color:var(--muted)]">
              {strategy.summary}
            </p>
            {strategy.entry !== null && strategy.stop !== null && strategy.target !== null ? (
              <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                {[["Entry", strategy.entry], ["Stop", strategy.stop], ["Target", strategy.target]].map(([label, value]) => (
                  <div key={String(label)}><div className="text-[color:var(--muted)]">{label}</div><div className="mt-1 font-medium">{formatChartPrice(value as number, strategy.instrument)}</div></div>
                ))}
              </div>
            ) : null}
            {strategy.failedConditions.length ? <p className="mt-3 text-xs leading-5 text-[color:var(--muted)]">Blocked by: {strategy.failedConditions.map((item) => item.name).join(", ")}</p> : null}
            {strategy.positionSize ? (
              <p className="mt-3 text-xs text-[color:var(--muted)]">
                1% risk · {strategy.positionSize.stopDistancePips.toFixed(1)} pip stop · {strategy.positionSize.standardLots.toFixed(2)} paper lots
                {strategy.positionSize.capped ? ` (calculated ${strategy.positionSize.calculatedStandardLots.toFixed(2)}, capped at ${strategy.positionSize.capStandardLots.toFixed(2)})` : ""}
              </p>
            ) : null}
          </div>

          <div className="mt-3 flex justify-end border-t border-[color:var(--border)] pt-3">
            <Link
              href="/signals"
              className="link-quiet pressable inline-flex items-center gap-1 text-xs"
            >
              Review signals
              <ChevronRight className="size-3.5" />
            </Link>
          </div>
        </section>
      </div>

      <section className="app-card p-5 md:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <SectionLabel title="Daily risk status" variant="minimal" />
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Based on manually logged paper trades on this device.
            </p>
          </div>
          <span className="permission-pill shrink-0 bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
            {DEFAULT_RISK_POLICY.riskPercent}% per trade
          </span>
        </div>

        <div className="mt-4">
          <div className="dashboard-stat-label">Daily loss</div>
          <div className="metric-number mt-0.5 text-2xl font-semibold tracking-[-0.04em]">
            {usedRiskPercent.toFixed(2)}%
          </div>
          <div className="risk-bar mt-3">
            <div
              className="risk-bar-fill"
              style={{ width: `${riskUsedWidth}%` }}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 border-t border-[color:var(--border)] pt-4 sm:grid-cols-3">
          {[
            ["Account balance", formatMoney(account.balance, account.currency)],
            ["Remaining risk", `${remainingRiskPercent.toFixed(2)}%`],
            ["Trades today", String(journalDay.tradesTaken)],
            ["Consecutive losses", String(journalDay.consecutiveLosses)],
            ["Remaining trades", String(remainingTrades)],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="text-xs text-[color:var(--muted)]">{label}</div>
              <div className="metric-number mt-0.5 text-sm font-semibold tracking-[-0.03em]">
                {value}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-3 border-t border-[color:var(--border)] pt-3 text-xs text-[color:var(--muted)]">
          Max {DEFAULT_RISK_POLICY.maxDailyLossPercent}% daily ·{" "}
          {journalDay.tradesTaken}/{DEFAULT_RISK_POLICY.maxTradesPerDay} trades
        </p>
      </section>

      <section className="app-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-5 md:px-6">
          <div>
            <SectionLabel title="Recent paper trades" variant="minimal" />
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Manual records only. Demo trades are excluded.
            </p>
          </div>
          <Link href="/journal" className="link-quiet pressable text-sm">
            Open journal
          </Link>
        </div>
        {paperTrades.length ? (
          <div>
            {paperTrades.map((trade) => {
              const positive = (trade.resultR ?? 0) >= 0;
              return (
                <div key={trade.id} className="dashboard-row flex items-center justify-between gap-3 px-5 py-3.5 md:px-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{trade.pair}</span>
                      <span className={trade.direction === "long" ? "text-xs text-[color:var(--success)]" : "text-xs text-[color:var(--danger)]"}>
                        {trade.direction}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[color:var(--muted)]">{trade.reason}</p>
                  </div>
                  <div className="text-right">
                    <div className={trade.resultR === null ? "text-sm text-[color:var(--muted)]" : positive ? "metric-number text-sm font-medium text-[color:var(--success)]" : "metric-number text-sm font-medium text-[color:var(--danger)]"}>
                      {trade.resultR === null ? "Open" : `${positive ? "+" : ""}${trade.resultR.toFixed(2)}R`}
                    </div>
                    <div className="mt-0.5 text-xs text-[color:var(--muted)]">{formatDateTime(trade.closedAt ?? trade.openedAt)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border-t border-[color:var(--border)] px-5 py-7 md:px-6">
            <p className="empty-state">
              <span className="empty-state-dot" />
              No paper trades logged on this device yet.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
