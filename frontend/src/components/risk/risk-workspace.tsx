"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Layers3, RefreshCw, ShieldCheck, Target, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SectionLabel } from "@/components/ui/section-label";
import { SelectMenu } from "@/components/ui/select-menu";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
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

const collectionRules = [
  ["Nominal sizing", "Every accepted setup is sized from its calculated stop using the active risk-per-trade setting."],
  ["One trade per pair", "The collector cannot open a second position on a pair until its existing paper trade closes."],
  ["Cross-pair collection", "Different pairs may be open simultaneously, subject to the active position-count and total-exposure settings."],
  ["Fixed trade plan", "Accepted setups keep their original stop and fixed 1.5R target, with a forced 16:45 ET session exit when neither is reached."],
] as const;

const evidenceGaps = [
  "Currency tilts are directional nominal-risk sums, not a full correlation or portfolio-value-at-risk model.",
  "News is not evaluated, so this remains a price-only baseline.",
  "Paper sizing does not prove that the same position could be filled with acceptable margin, slippage, or liquidity live.",
  "No OANDA orders are submitted. These figures describe simulated research exposure only.",
] as const;

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

function RiskControlField({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col gap-2 text-xs text-[color:var(--muted)]">
      <span className="block min-h-10 leading-5">{label}</span>
      <div className="shrink-0">{children}</div>
      <p className="min-h-10 leading-5">{help}</p>
    </div>
  );
}

export function RiskWorkspace({
  initialAccount,
  initialStatus,
  initialExposure,
  initialPolicy,
}: {
  initialAccount: AccountSummary;
  initialStatus: ConnectionStatus;
  initialExposure: PaperExposure;
  initialPolicy: PaperRiskPolicy;
}) {
  const [account, setAccount] = useState(initialAccount);
  const [status, setStatus] = useState(initialStatus);
  const [exposure, setExposure] = useState(initialExposure);
  const [policy, setPolicy] = useState(initialPolicy);
  const initialForm = initialPolicy.pending ?? initialPolicy.active;
  const [riskPercent, setRiskPercent] = useState(String(initialForm.riskPercent));
  const [maxPositions, setMaxPositions] = useState(initialForm.maxSimultaneousPositions === null ? "unlimited" : String(initialForm.maxSimultaneousPositions));
  const [maxExposure, setMaxExposure] = useState(initialForm.maxTotalNominalRiskPercent === null ? "" : String(initialForm.maxTotalNominalRiskPercent));
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
      setStatus(accountPayload.status);
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

  function setFormFromPolicy(nextPolicy: PaperRiskPolicy) {
    const configuration = nextPolicy.pending ?? nextPolicy.active;
    setRiskPercent(String(configuration.riskPercent));
    setMaxPositions(configuration.maxSimultaneousPositions === null ? "unlimited" : String(configuration.maxSimultaneousPositions));
    setMaxExposure(configuration.maxTotalNominalRiskPercent === null ? "" : String(configuration.maxTotalNominalRiskPercent));
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
      const payload = await response.json() as { policy?: PaperRiskPolicy; error?: string };
      if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Risk settings could not be saved.");
      setPolicy(payload.policy);
      setFormFromPolicy(payload.policy);
      setSaveMessage(payload.policy.applied === "next_batch" ? "Risk sizing and exposure changes are queued for the next batch. The pause switch applied immediately." : "Risk settings are active now.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Risk settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const largestTilt = exposure.currencyExposure[0] ?? null;
  const maxTilt = useMemo(() => Math.max(1, ...exposure.currencyExposure.map((item) => Math.abs(item.nominalRiskPercent))), [exposure.currencyExposure]);

  return (
    <div className="space-y-5">
      <section className="app-card-hero p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-[color:var(--accent)]">Automatic paper exposure</p>
            <h2 className="text-display mt-2">What the strategy is risking now</h2>
            <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">Exposure comes from accepted database trades. The controls below govern future paper entries; no setting submits an order.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="secondary-button pressable inline-flex items-center gap-2"><RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</button>
        </div>
        {error ? <p className="research-error mt-4">{error} Existing values remain visible.</p> : null}
      </section>

      <section className="app-card p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <SectionLabel title="Paper risk controls" variant="minimal" />
            <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">These settings control whether the automatic collector may create a trade and how that trade is sized. They never authorize live orders.</p>
          </div>
          <span className={`status-pill ${collectionPaused ? "status-pill-danger" : "status-pill-success"}`}>{collectionPaused ? "New entries paused" : "Accepting new entries"}</span>
        </div>

        <div className="mt-5 grid gap-4 border-t border-[color:var(--border)] pt-5 md:grid-cols-3 md:items-stretch">
          <RiskControlField
            label="Risk per trade"
            help="Allowed range: 0.1%–5%. This changes calculated paper size."
          >
            <div className="relative">
              <input
                aria-label="Risk per trade"
                type="number"
                min="0.1"
                max="5"
                step="0.1"
                value={riskPercent}
                onChange={(event) => setRiskPercent(event.target.value)}
                className="control-track h-11 w-full rounded-xl px-3 pr-9 font-mono text-sm text-[color:var(--foreground)] outline-none"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">%</span>
            </div>
          </RiskControlField>

          <RiskControlField
            label="Maximum simultaneous positions"
            help="One open trade per individual pair still applies."
          >
            <SelectMenu
              ariaLabel="Maximum simultaneous positions"
              value={maxPositions}
              onChange={setMaxPositions}
              options={maxPositionOptions}
              fullWidth
              size="control"
            />
          </RiskControlField>

          <RiskControlField
            label="Maximum total nominal exposure"
            help="Leave blank for unlimited. A cap blocks only new entries."
          >
            <div className="relative">
              <input
                aria-label="Maximum total nominal exposure"
                type="number"
                min={riskPercent || "0.1"}
                max="50"
                step="0.1"
                value={maxExposure}
                onChange={(event) => setMaxExposure(event.target.value)}
                placeholder="Unlimited"
                className="control-track h-11 w-full rounded-xl px-3 pr-9 font-mono text-sm text-[color:var(--foreground)] outline-none placeholder:font-sans placeholder:text-[color:var(--muted)]"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">%</span>
            </div>
          </RiskControlField>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-[color:var(--border)] pt-4">
          <label className="flex cursor-pointer items-center gap-3 text-sm font-medium"><input type="checkbox" checked={!collectionPaused} onChange={(event) => setCollectionPaused(!event.target.checked)} className="size-4 accent-[color:var(--accent)]" />Allow the collector to open new paper trades</label>
          <button type="button" onClick={() => void savePolicy()} disabled={saving} className="primary-button pressable">{saving ? "Saving…" : "Save risk settings"}</button>
        </div>

        <div className="mt-4 rounded-2xl bg-[color:var(--surface-raised)] px-4 py-3 text-xs leading-5 text-[color:var(--muted)]">
          <p><span className="font-semibold text-[color:var(--foreground)]">Active:</span> {policy.active.riskPercent.toFixed(2)}% per trade · {policy.active.maxSimultaneousPositions === null ? "unlimited positions" : `${policy.active.maxSimultaneousPositions} positions max`} · {policy.active.maxTotalNominalRiskPercent === null ? "unlimited total nominal exposure" : `${policy.active.maxTotalNominalRiskPercent.toFixed(2)}% total nominal exposure max`}.</p>
          {policy.pending ? <p className="mt-1 text-[color:var(--accent)]">Queued for Batch {(policy.currentBatch?.batchNumber ?? 0) + 1}: {policy.pending.riskPercent.toFixed(2)}% per trade · {policy.pending.maxSimultaneousPositions === null ? "unlimited positions" : `${policy.pending.maxSimultaneousPositions} positions max`} · {policy.pending.maxTotalNominalRiskPercent === null ? "unlimited exposure" : `${policy.pending.maxTotalNominalRiskPercent.toFixed(2)}% exposure max`}.</p> : null}
          {saveMessage ? <p className="mt-1 font-medium text-[color:var(--success)]">{saveMessage}</p> : null}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Open paper trades", value: exposure.openTrades, detail: "Maximum one per pair", icon: Layers3 },
          { label: "Simultaneous nominal risk", value: `${exposure.totalNominalRiskPercent.toFixed(2)}%`, detail: "Sum across open trades", icon: Target },
          { label: "Nominal risk amount", value: money(exposure.totalNominalRiskAmount, account.currency), detail: `Practice balance ${money(account.balance, account.currency)}`, icon: WalletCards },
          { label: "Largest currency tilt", value: largestTilt ? `${largestTilt.code} ${signedPercent(largestTilt.nominalRiskPercent)}` : "None", detail: "Directional nominal sum", icon: ShieldCheck },
        ].map((item) => { const Icon = item.icon; return <article key={item.label} className="app-card p-5"><div className="flex items-start justify-between gap-3"><p className="text-xs text-[color:var(--muted)]">{item.label}</p><div className="icon-tile-accent grid size-9 place-items-center rounded-2xl"><Icon className="size-4" /></div></div><p className="metric-number mt-4 text-2xl font-semibold tracking-[-0.04em]">{item.value}</p><p className="mt-2 text-xs text-[color:var(--muted)]">{item.detail}</p></article>; })}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <section className="app-card overflow-hidden">
          <div className="flex items-start justify-between gap-3 px-5 py-5 md:px-6"><div><SectionLabel title="Open paper positions" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">Persisted positions created automatically by day-exploration-v1.</p></div><span className="status-pill status-pill-neutral">{status.state === "connected" ? "OANDA practice connected" : status.label}</span></div>
          {exposure.positions.length ? <div>{exposure.positions.map((position) => <Link key={position.instrument} href={`/signals?instrument=${position.instrument}`} className="dashboard-row pressable grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto_20px] md:items-center md:px-6"><div><p className="text-sm font-semibold">{displayNameFor(position.instrument)} <span className={position.direction === "long" ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}>{position.direction}</span></p><p className="mt-0.5 text-xs text-[color:var(--muted)]">Automatic paper position</p></div><div><p className="text-xs text-[color:var(--muted)]">Risk</p><p className="metric-number mt-0.5 text-sm font-semibold">{position.nominalRiskPercent.toFixed(2)}%</p></div><div><p className="text-xs text-[color:var(--muted)]">Amount</p><p className="metric-number mt-0.5 text-sm font-semibold">{money(position.nominalRiskAmount, account.currency)}</p></div><div><p className="text-xs text-[color:var(--muted)]">Calculated size</p><p className="metric-number mt-0.5 text-sm font-semibold">{position.calculatedStandardLots.toFixed(2)} lots</p></div><ArrowUpRight className="hidden size-4 text-[color:var(--muted)] md:block" /></Link>)}</div> : <div className="border-t border-[color:var(--border)] px-5 py-8 md:px-6"><p className="empty-state"><span className="empty-state-dot" />No open automatic paper positions. Exposure will appear after the first accepted completed-M15 setup.</p></div>}
        </section>

        <section className="app-card p-5 md:p-6">
          <SectionLabel title="Currency concentration" variant="minimal" />
          <p className="mt-1 text-sm text-[color:var(--muted)]">Net directional contribution from current nominal risk—not a correlation model.</p>
          {exposure.currencyExposure.length ? <div className="mt-5 space-y-4">{exposure.currencyExposure.map((item) => <div key={item.code}><div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold">{item.code}</span><span className={`metric-number ${item.nominalRiskPercent >= 0 ? "text-[color:var(--success)]" : "text-[color:var(--danger)]"}`}>{signedPercent(item.nominalRiskPercent)}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[color:var(--surface-raised)]"><div className={`h-full rounded-full ${item.nominalRiskPercent >= 0 ? "bg-[color:var(--success)]" : "bg-[color:var(--danger)]"}`} style={{ width: `${Math.max(3, Math.abs(item.nominalRiskPercent) / maxTilt * 100)}%` }} /></div></div>)}</div> : <div className="mt-5 rounded-2xl bg-[color:var(--surface-raised)] px-4 py-6 text-center text-xs text-[color:var(--muted)]">No currency exposure while there are no open trades.</div>}
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="app-card p-5 md:p-6">
          <SectionLabel title="Rules that actually govern collection" variant="minimal" />
          <div className="mt-4 space-y-4">{collectionRules.map(([title, body], index) => <div key={title} className="flex gap-4"><span className="metric-number mt-0.5 text-xs font-semibold text-[color:var(--accent)]">0{index + 1}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">{body}</p></div></div>)}</div>
        </section>

        <section className="app-card border-[color:var(--danger)]/20 p-5 md:p-6">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0 text-[color:var(--danger)]" /><div><SectionLabel title="What these numbers do not prove" variant="minimal" /><p className="mt-1 text-sm text-[color:var(--muted)]">Uncapped collection is available for research, but it is not evidence that the same exposure would be safe in live trading.</p></div></div>
          <ul className="mt-4 space-y-3 text-xs leading-5 text-[color:var(--muted)]">{evidenceGaps.map((gap) => <li key={gap} className="flex gap-2"><span className="text-[color:var(--danger)]">•</span><span>{gap}</span></li>)}</ul>
        </section>
      </div>

      <div className="flex flex-wrap justify-end gap-2"><Link href="/watchlist" className="secondary-button pressable">Open watchlist</Link><Link href="/research" className="primary-button pressable">Review batch evidence</Link></div>
    </div>
  );
}
