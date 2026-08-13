"use client";

import Link from "next/link";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SelectMenu } from "@/components/ui/select-menu";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import type { AccountSummary, ConnectionStatus } from "@/types/forex";

type PaperPosition = {
  instrument: string;
  direction: "long" | "short";
  nominalRiskPercent: number;
  nominalRiskAmount: number;
  calculatedStandardLots: number;
};

export type PaperExposure = {
  openTrades: number;
  totalNominalRiskPercent: number;
  totalNominalRiskAmount: number;
  positions: PaperPosition[];
  currencyExposure: Array<{ code: string; nominalRiskPercent: number }>;
};

export type PaperRiskConfiguration = {
  riskPercent: number;
  maxSimultaneousPositions: number | null;
  maxTotalNominalRiskPercent: number | null;
};

export type PaperRiskPolicy = {
  active: PaperRiskConfiguration;
  pending: PaperRiskConfiguration | null;
  collectionPaused: boolean;
  pendingAppliesTo: "next_batch" | null;
  currentBatch: { batchNumber: number; assignedCount: number } | null;
  applied?: "immediately" | "next_batch";
};

const maxPositionOptions = [
  { value: "unlimited" as const, label: "Unlimited" },
  ...Array.from({ length: 10 }, (_, index) => {
    const count = String(index + 1);
    return { value: count, label: count };
  }),
];

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function signedPercent(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function RiskField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-medium text-[color:var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

export function RiskWorkspace({
  initialAccount,
  initialExposure,
  initialPolicy,
}: {
  initialAccount: AccountSummary;
  initialStatus?: ConnectionStatus;
  initialExposure: PaperExposure;
  initialPolicy: PaperRiskPolicy;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [exposure, setExposure] = useState(initialExposure);
  const [policy, setPolicy] = useState(initialPolicy);
  const initialForm = initialPolicy.pending ?? initialPolicy.active;
  const [riskPercent, setRiskPercent] = useState(String(initialForm.riskPercent));
  const [maxPositions, setMaxPositions] = useState(
    initialForm.maxSimultaneousPositions === null ? "unlimited" : String(initialForm.maxSimultaneousPositions),
  );
  const [maxExposure, setMaxExposure] = useState(
    initialForm.maxTotalNominalRiskPercent === null ? "" : String(initialForm.maxTotalNominalRiskPercent),
  );
  const [collectionPaused, setCollectionPaused] = useState(initialPolicy.collectionPaused);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [accountResponse, riskResponse] = await Promise.all([
        fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/paper-risk"), { credentials: "include", cache: "no-store" }),
      ]);
      if (!accountResponse.ok || !riskResponse.ok) throw new Error("Paper exposure is temporarily unavailable.");
      const [accountPayload, riskPayload] = await Promise.all([
        accountResponse.json() as Promise<{ data: AccountSummary; status: ConnectionStatus }>,
        riskResponse.json() as Promise<{ exposure: PaperExposure; policy: PaperRiskPolicy }>,
      ]);
      setAccount(accountPayload.data);
      setExposure(riskPayload.exposure);
      setPolicy(riskPayload.policy);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Paper exposure is temporarily unavailable.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useForegroundRefresh(refresh);

  function setFormFromPolicy(nextPolicy: PaperRiskPolicy) {
    const configuration = nextPolicy.pending ?? nextPolicy.active;
    setRiskPercent(String(configuration.riskPercent));
    setMaxPositions(
      configuration.maxSimultaneousPositions === null
        ? "unlimited"
        : String(configuration.maxSimultaneousPositions),
    );
    setMaxExposure(
      configuration.maxTotalNominalRiskPercent === null
        ? ""
        : String(configuration.maxTotalNominalRiskPercent),
    );
    setCollectionPaused(nextPolicy.collectionPaused);
  }

  async function savePolicy() {
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const configuration: PaperRiskConfiguration = {
        riskPercent: Number(riskPercent),
        maxSimultaneousPositions: maxPositions === "unlimited" ? null : Number(maxPositions),
        maxTotalNominalRiskPercent: maxExposure.trim() ? Number(maxExposure) : null,
      };
      const response = await fetch(apiUrl("/api/paper-risk/settings"), {
        method: "PATCH",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configuration, collectionPaused }),
      });
      const payload = (await response.json()) as { policy?: PaperRiskPolicy; error?: string };
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Risk settings could not be saved.");
      setPolicy(payload.policy);
      setFormFromPolicy(payload.policy);
      setSaveMessage(
        payload.policy.applied === "next_batch"
          ? "Queued for the next batch. Pause applied now."
          : "Settings active.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Risk settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const largestTilt = exposure.currencyExposure[0] ?? null;
  const maxTilt = useMemo(
    () => Math.max(1, ...exposure.currencyExposure.map((item) => Math.abs(item.nominalRiskPercent))),
    [exposure.currencyExposure],
  );

  return (
    <div className="risk-view risk-minimal space-y-8 lg:space-y-10">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-display">Risk</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">Paper exposure</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="mobile-icon-btn pressable text-[color:var(--muted-strong)] hover:text-[color:var(--foreground)]"
          aria-label="Refresh"
        >
          <RefreshCw className={`size-[18px] ${refreshing ? "animate-spin" : ""}`} strokeWidth={1.9} />
        </button>
      </header>

      {error ? <p className="research-error">{error}</p> : null}

      <section className="risk-stats-card" aria-label="Exposure summary">
        {(
          [
            ["Open", String(exposure.openTrades)],
            ["Nominal", `${exposure.totalNominalRiskPercent.toFixed(2)}%`],
            ["Amount", money(exposure.totalNominalRiskAmount, account.currency)],
            [
              "Tilt",
              largestTilt ? `${largestTilt.code} ${signedPercent(largestTilt.nominalRiskPercent)}` : "—",
            ],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="risk-stat">
            <p className="text-xs text-[color:var(--muted)]">{label}</p>
            <p className="metric-number mt-1 text-xl font-semibold tracking-[-0.03em]">{value}</p>
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section" aria-label="Risk controls">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Controls</h2>
          <span
            className={`text-xs font-medium ${
              collectionPaused ? "text-[color:var(--danger)]" : "text-[color:var(--success)]"
            }`}
          >
            {collectionPaused ? "Paused" : "Accepting"}
          </span>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <RiskField label="Risk / trade">
            <div className="relative">
              <input
                type="number"
                min="0.1"
                max="5"
                step="0.1"
                value={riskPercent}
                onChange={(event) => setRiskPercent(event.target.value)}
                className="control-track h-11 w-full rounded-xl px-3 pr-9 font-mono text-sm text-[color:var(--foreground)] outline-none"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[color:var(--muted)]">
                %
              </span>
            </div>
          </RiskField>

          <RiskField label="Max positions">
            <SelectMenu
              ariaLabel="Maximum simultaneous positions"
              value={maxPositions}
              onChange={setMaxPositions}
              options={maxPositionOptions}
              fullWidth
              size="control"
            />
          </RiskField>

          <RiskField label="Max exposure">
            <div className="relative">
              <input
                type="number"
                min={riskPercent || "0.1"}
                max="50"
                step="0.1"
                value={maxExposure}
                onChange={(event) => setMaxExposure(event.target.value)}
                placeholder="Unlimited"
                className="control-track h-11 w-full rounded-xl px-3 pr-9 font-mono text-sm text-[color:var(--foreground)] outline-none placeholder:font-sans placeholder:text-[color:var(--muted)]"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[color:var(--muted)]">
                %
              </span>
            </div>
          </RiskField>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={!collectionPaused}
              onChange={(event) => setCollectionPaused(!event.target.checked)}
              className="size-4 accent-[color:var(--accent)]"
            />
            Allow new entries
          </label>
          <button type="button" onClick={() => void savePolicy()} disabled={saving} className="primary-button pressable">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {(policy.pending || saveMessage) && (
          <p className="mt-3 text-xs text-[color:var(--muted)]">
            {saveMessage ??
              `Queued for Batch ${(policy.currentBatch?.batchNumber ?? 0) + 1}: ${policy.pending!.riskPercent.toFixed(2)}% · ${
                policy.pending!.maxSimultaneousPositions === null
                  ? "unlimited"
                  : `${policy.pending!.maxSimultaneousPositions} max`
              }`}
          </p>
        )}
      </section>

      <div className="dashboard-minimal-grid">
        <section className="dashboard-minimal-section" aria-label="Open positions">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold tracking-[-0.01em]">Open positions</h2>
            <p className="metric-number text-xs text-[color:var(--muted)]">{exposure.openTrades}</p>
          </div>
          {exposure.positions.length ? (
            <div className="mt-3">
              {exposure.positions.map((position) => (
                <Link
                  key={position.instrument}
                  href={`/signals?instrument=${position.instrument}`}
                  className="dashboard-minimal-row pressable flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {displayNameFor(position.instrument)}{" "}
                      <span className={position.direction === "long" ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>
                        {position.direction}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                      {position.calculatedStandardLots.toFixed(2)} lots
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="metric-number text-sm font-semibold">{position.nominalRiskPercent.toFixed(2)}%</p>
                    <p className="metric-number mt-0.5 text-[0.68rem] text-[color:var(--muted)]">
                      {money(position.nominalRiskAmount, account.currency)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[color:var(--muted)]">No open paper positions.</p>
          )}
        </section>

        <section className="dashboard-minimal-section" aria-label="Currency concentration">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Currency</h2>
          {exposure.currencyExposure.length ? (
            <div className="mt-4 space-y-3">
              {exposure.currencyExposure.map((item) => (
                <div key={item.code}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium">{item.code}</span>
                    <span
                      className={`metric-number ${
                        item.nominalRiskPercent >= 0
                          ? "text-[color:var(--success)]"
                          : "text-[color:var(--danger)]"
                      }`}
                    >
                      {signedPercent(item.nominalRiskPercent)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[color:var(--surface-raised)]">
                    <div
                      className={`h-full rounded-full ${
                        item.nominalRiskPercent >= 0
                          ? "bg-[color:var(--success)]"
                          : "bg-[color:var(--danger)]"
                      }`}
                      style={{
                        width: `${Math.max(3, (Math.abs(item.nominalRiskPercent) / maxTilt) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-[color:var(--muted)]">No currency exposure.</p>
          )}
        </section>
      </div>

      <section className="dashboard-minimal-actions" aria-label="Shortcuts">
        <Link href="/watchlist" className="dashboard-minimal-action pressable">
          <span>Watchlist</span>
          <ArrowUpRight className="ml-auto size-3.5 text-[color:var(--muted)]" />
        </Link>
        <Link href="/research" className="dashboard-minimal-action pressable">
          <span>Research</span>
          <ArrowUpRight className="ml-auto size-3.5 text-[color:var(--muted)]" />
        </Link>
      </section>
    </div>
  );
}
