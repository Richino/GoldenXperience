"use client";

import { useMemo, useState } from "react";
import {
  AlertOctagon,
  Calculator,
  Check,
  LockKeyhole,
  ShieldCheck,
  Target,
} from "lucide-react";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { usePaperJournalDay } from "@/lib/journal/use-paper-journal-day";
import { signals } from "@/lib/mock-data";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import {
  calculatePositionSize,
  DEFAULT_RISK_POLICY,
  deriveTradePermission,
  PAPER_TRADING_MAX_STANDARD_LOTS,
} from "@/lib/risk/engine";
import type {
  AccountSummary,
  ConnectionStatus,
  MajorInstrument,
} from "@/types/forex";

const rules = [
  {
    title: "Size from the stop",
    body: "Set invalidation first, then calculate size. Never widen the stop to justify a larger trade.",
  },
  {
    title: "Two losses ends the session",
    body: "Two consecutive losses block another paper trade for the session.",
  },
  {
    title: "No correlated stacking",
    body: "EUR/USD and GBP/USD in the same direction count as one USD idea.",
  },
  {
    title: "News is a hard filter",
    body: "Wait inside 30 minutes of high-impact news for either currency.",
  },
] as const;

function toNumber(value: string) {
  return Number.parseFloat(value);
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function PermissionCard({
  status,
  streamState,
}: {
  status: ConnectionStatus;
  streamState: ReturnType<typeof useMarketStream>["state"];
}) {
  const { snapshot: calendar } = useEconomicCalendar();
  const journalDay = usePaperJournalDay();
  const dailyLossPercent = journalDay.losingR * DEFAULT_RISK_POLICY.riskPercent;
  const decision = deriveTradePermission({
    restConnected: status.state === "connected",
    streamState,
    marketOpen: true,
    calendarConnected: calendar.connected,
    dailyLossPercent,
    tradesTaken: journalDay.tradesTaken,
    consecutiveLosses: journalDay.consecutiveLosses,
    setupValid: false,
    highImpactNewsWithinMinutes: calendar.highImpactNewsWithinMinutes,
    spreadPips: null,
  });
  const tone =
    decision.permission === "allowed"
      ? "text-[color:var(--success)] bg-[color:var(--success-soft)]"
      : "text-[color:var(--danger)] bg-[color:var(--danger-soft)]";

  return (
    <section className="app-card card-enter p-5">
      <div className="flex items-start gap-3">
        <div className={`grid size-11 shrink-0 place-items-center rounded-2xl ${tone}`}>
          <ShieldCheck className="size-5" />
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.12em] text-[color:var(--muted)]">
            Today&apos;s permission
          </div>
          <h2 className="text-section-title mt-1">
            {decision.label}
          </h2>
          <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">
            {decision.reason}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {[
          ["Daily loss used", `${dailyLossPercent.toFixed(2)}% / ${DEFAULT_RISK_POLICY.maxDailyLossPercent}%`],
          ["Trades taken", `${journalDay.tradesTaken} / ${DEFAULT_RISK_POLICY.maxTradesPerDay}`],
          ["Consecutive losses", `${journalDay.consecutiveLosses} / ${DEFAULT_RISK_POLICY.maxConsecutiveLosses}`],
        ].map(([label, value]) => (
          <div
            key={label}
            className="inset-panel flex items-center justify-between rounded-2xl px-3.5 py-3"
          >
            <span className="text-xs text-[color:var(--muted)]">{label}</span>
            <span className="metric-number text-xs font-semibold">{value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RiskWorkspace({
  account,
  status,
}: {
  account: AccountSummary;
  status: ConnectionStatus;
}) {
  const initialSignal = signals[0];
  const [instrument, setInstrument] = useState<MajorInstrument>(
    initialSignal.instrument,
  );
  const [balance, setBalance] = useState(String(account.balance));
  const [riskPercent, setRiskPercent] = useState(
    String(DEFAULT_RISK_POLICY.riskPercent),
  );
  const [entry, setEntry] = useState(String(initialSignal.entry));
  const [stop, setStop] = useState(String(initialSignal.stop));
  const stream = useMarketStream(instrument, undefined, { trackPrice: false });
  const result = useMemo(
    () =>
      calculatePositionSize({
        instrument,
        accountBalance: toNumber(balance),
        riskPercent: toNumber(riskPercent),
        entry: toNumber(entry),
        stop: toNumber(stop),
      }),
    [balance, entry, instrument, riskPercent, stop],
  );

  function selectInstrument(nextInstrument: MajorInstrument) {
    const signal =
      signals.find((item) => item.instrument === nextInstrument) ?? signals[0];
    setInstrument(nextInstrument);
    setEntry(String(signal.entry));
    setStop(String(signal.stop));
  }

  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          {
            label: "Risk per trade",
            value: `${DEFAULT_RISK_POLICY.riskPercent.toFixed(2)}%`,
            detail: "Hard maximum",
            icon: Target,
          },
          {
            label: "Daily loss limit",
            value: `${DEFAULT_RISK_POLICY.maxDailyLossPercent.toFixed(2)}%`,
            detail: formatMoney(
              account.balance *
                (DEFAULT_RISK_POLICY.maxDailyLossPercent / 100),
              account.currency,
            ),
            icon: AlertOctagon,
          },
          {
            label: "Maximum trades",
            value: String(DEFAULT_RISK_POLICY.maxTradesPerDay),
            detail: "Per trading day",
            icon: LockKeyhole,
          },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.label} className="app-card card-enter p-5">
              <div className="flex items-start justify-between">
                <div className="text-xs text-[color:var(--muted)]">
                  {item.label}
                </div>
                <div className="icon-tile-accent grid size-9 place-items-center rounded-2xl">
                  <Icon className="size-4" />
                </div>
              </div>
              <div className="metric-number text-metric-hero mt-4">
                {item.value}
              </div>
              <div className="mt-2 text-xs text-[color:var(--muted)]">
                {item.detail}
              </div>
            </article>
          );
        })}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="app-card card-enter overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[color:var(--border)] px-4 py-4 md:px-5">
            <div className="flex items-center gap-3">
              <span className="icon-tile-accent grid size-10 place-items-center rounded-2xl">
                <Calculator className="size-4.5" />
              </span>
              <div>
                <h2 className="text-section-title">
                  Position size
                </h2>
                <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                  USD account · pip value calculated from the selected pair
                </p>
              </div>
            </div>
            <span className="status-pill status-pill-neutral">
              {account.source === "mock" ? "Demo balance" : "OANDA balance"}
            </span>
          </div>

          <div className="grid gap-4 p-4 md:grid-cols-2 md:p-5">
            <label className="space-y-1.5 text-xs text-[color:var(--muted)]">
              Pair
              <select
                value={instrument}
                onChange={(event) =>
                  selectInstrument(event.target.value as MajorInstrument)
                }
                className="control-track h-11 w-full rounded-xl px-3 text-sm text-[color:var(--foreground)] outline-none"
              >
                <option value="EUR_USD">EUR/USD</option>
                <option value="GBP_USD">GBP/USD</option>
                <option value="USD_JPY">USD/JPY</option>
              </select>
            </label>
            {[
              ["Account balance", balance, setBalance],
              ["Risk percent", riskPercent, setRiskPercent],
              ["Entry", entry, setEntry],
              ["Stop", stop, setStop],
            ].map(([label, value, setter]) => (
              <label
                key={label as string}
                className="space-y-1.5 text-xs text-[color:var(--muted)]"
              >
                {label as string}
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  step="any"
                  value={value as string}
                  onChange={(event) =>
                    (setter as (next: string) => void)(event.target.value)
                  }
                  className="control-track h-11 w-full rounded-xl px-3 font-mono text-sm text-[color:var(--foreground)] outline-none"
                />
              </label>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-[color:var(--border)] p-4 sm:grid-cols-3 md:p-5">
            {result ? (
              [
                ["Risk amount", formatMoney(result.riskAmount, account.currency)],
                ["Stop distance", `${result.stopDistancePips.toFixed(1)} pips`],
                ["Pip value / lot", formatMoney(result.pipValuePerStandardLot)],
                ["Calculated lots", result.calculatedStandardLots.toFixed(2)],
                ["Paper lots", result.standardLots.toFixed(2)],
                ["Paper cap", `${result.capStandardLots.toFixed(2)} lots`],
                ["Units", result.units.toLocaleString("en-US")],
                ["Estimated risk", formatMoney(result.estimatedRisk, account.currency)],
              ].map(([label, value]) => (
                <div key={label} className="inset-panel rounded-2xl p-3">
                  <div className="text-xs uppercase tracking-[0.1em] text-[color:var(--muted)]">
                    {label}
                  </div>
                  <div className="metric-number mt-1.5 text-sm font-semibold">
                    {value}
                  </div>
                </div>
              ))
            ) : (
              <p className="col-span-full py-4 text-center text-xs text-[color:var(--danger)]">
                Enter a positive balance, risk percent, entry, and a different stop.
              </p>
            )}
          </div>
          {result?.capped ? (
            <p className="mx-4 mb-4 rounded-xl bg-[color:var(--accent-soft)] px-3 py-2 text-xs leading-5 text-[color:var(--accent)] md:mx-5 md:mb-5">
              Simulation cap applied: calculated {result.calculatedStandardLots.toFixed(2)} lots, using {result.standardLots.toFixed(2)} paper lots. This reduces estimated paper risk to {formatMoney(result.estimatedRisk, account.currency)}.
            </p>
          ) : null}
        </section>

        <PermissionCard status={status} streamState={stream.state} />
      </div>

      <p className="text-center text-xs text-[color:var(--muted)]">
        Paper simulation cap: {PAPER_TRADING_MAX_STANDARD_LOTS.toFixed(2)} standard lots. Change <code>NEXT_PUBLIC_PAPER_MAX_STANDARD_LOTS</code> in your local environment to adjust it.
      </p>

      <section className="app-card card-enter overflow-hidden">
        <div className="px-5 py-4">
          <h2 className="text-section-title">Execution rules</h2>
          <p className="mt-1 text-xs text-[color:var(--muted)]">
            Review before every paper trade
          </p>
        </div>
        <div className="grid md:grid-cols-2">
          {rules.map((rule, index) => (
            <div key={rule.title} className="flex gap-4 px-5 py-4">
              <span className="metric-number mt-0.5 text-xs font-semibold text-[color:var(--accent)]">
                0{index + 1}
              </span>
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Check className="size-3.5 text-[color:var(--success)]" />
                  {rule.title}
                </h3>
                <p className="mt-1.5 text-xs leading-5 text-[color:var(--muted)]">
                  {rule.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
