"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SelectMenu } from "@/components/ui/select-menu";
import { apiUrl } from "@/lib/api/url";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";

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

const AUTO_SAVE_DELAY_MS = 500;

function configurationKey(configuration: PaperRiskConfiguration, collectionPaused: boolean) {
  return JSON.stringify({ configuration, collectionPaused });
}

function configurationFromForm(riskPercent: string, maxPositions: string, maxExposure: string) {
  const risk = Number(riskPercent);
  const positions = maxPositions === "unlimited" ? null : Number(maxPositions);
  const exposure = maxExposure.trim() ? Number(maxExposure) : null;
  if (!Number.isFinite(risk) || risk < 0.1 || risk > 5) return null;
  if (positions !== null && (!Number.isInteger(positions) || positions < 1 || positions > 12)) return null;
  if (exposure !== null && (!Number.isFinite(exposure) || exposure < risk || exposure > 50)) return null;
  return { riskPercent: risk, maxSimultaneousPositions: positions, maxTotalNominalRiskPercent: exposure };
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
  initialPolicy,
}: {
  initialPolicy: PaperRiskPolicy;
}) {
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
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastSavedKeyRef = useRef(configurationKey(initialForm, initialPolicy.collectionPaused));
  const saveSequenceRef = useRef(0);

  const setFormFromPolicy = useCallback((nextPolicy: PaperRiskPolicy) => {
    const configuration = nextPolicy.pending ?? nextPolicy.active;
    lastSavedKeyRef.current = configurationKey(configuration, nextPolicy.collectionPaused);
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
  }, []);

  const refresh = useCallback(async () => {
    try {
      const riskResponse = await fetch(apiUrl("/api/paper-risk"), { credentials: "include", cache: "no-store" });
      if (!riskResponse.ok) throw new Error("Risk settings are temporarily unavailable.");
      const riskPayload = await riskResponse.json() as { policy: PaperRiskPolicy };
      setPolicy(riskPayload.policy);
      setFormFromPolicy(riskPayload.policy);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Risk settings are temporarily unavailable.");
    }
  }, [setFormFromPolicy]);

  useForegroundRefresh(refresh);

  useEffect(() => {
    const sequence = ++saveSequenceRef.current;
    const configuration = configurationFromForm(riskPercent, maxPositions, maxExposure);
    if (!configuration) return;
    const key = configurationKey(configuration, collectionPaused);
    if (key === lastSavedKeyRef.current) return;

    const timer = window.setTimeout(async () => {
      setError(null);
      setSaveMessage(null);
      try {
        const response = await fetch(apiUrl("/api/paper-risk/settings"), {
          method: "PATCH",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ configuration, collectionPaused }),
        });
        const payload = (await response.json()) as { policy?: PaperRiskPolicy; error?: string };
        if (!response.ok || !payload.policy) throw new Error(payload.error ?? "Risk settings could not be saved.");
        if (sequence !== saveSequenceRef.current) return;
        lastSavedKeyRef.current = key;
        setPolicy(payload.policy);
        setSaveMessage(
          payload.policy.applied === "next_batch"
            ? "Saved · risk limits apply next batch; entry pause applies now."
            : "Saved automatically.",
        );
      } catch (reason) {
        if (sequence === saveSequenceRef.current) {
          setError(reason instanceof Error ? reason.message : "Risk settings could not be saved.");
        }
      }
    }, AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [collectionPaused, maxExposure, maxPositions, riskPercent]);

  const formIsValid = configurationFromForm(riskPercent, maxPositions, maxExposure) !== null;

  return (
    <div className="risk-view risk-embedded space-y-6 lg:space-y-8">
      <header>
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Risk</h2>
          <p className="mt-1 text-xs text-[color:var(--muted)]">Paper-trading limits</p>
        </div>
      </header>

      {error ? <p className="research-error">{error}</p> : null}

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
          <span
            className={`text-xs ${formIsValid ? "text-[color:var(--muted)]" : "text-[color:var(--danger)]"}`}
            role="status"
            aria-live="polite"
          >
            {formIsValid ? "Changes save automatically" : "Enter valid limits"}
          </span>
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
    </div>
  );
}
