"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Minus, Plus } from "lucide-react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
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

const RISK_PRESETS = [0.25, 0.5, 1, 2] as const;
const POSITION_CHOICES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "unlimited"] as const;

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}


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

/** Steps a percent string within the input's own 0.1–5% bounds. */
function stepRisk(value: string, delta: number) {
  const current = Number(value);
  const base = Number.isFinite(current) ? current : 1;
  const next = Math.min(5, Math.max(0.1, Math.round((base + delta) * 100) / 100));
  return String(next);
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
  // The last numeric limit, restored when "No limit" is switched off.
  const lastPositionsRef = useRef(maxPositions === "unlimited" ? "3" : maxPositions);
  const [error, setError] = useState<string | null>(null);
  const [riskSheetOpen, setRiskSheetOpen] = useState(false);
  // Read once for the "≈ $ per trade" line; risk is a share of the balance.
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/oanda/account-summary"), { credentials: "include", cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { data?: { balance?: number } } | null) => {
        const value = payload?.data?.balance;
        if (!cancelled && typeof value === "number" && Number.isFinite(value)) setBalance(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
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
      } catch (reason) {
        if (sequence === saveSequenceRef.current) {
          setError(reason instanceof Error ? reason.message : "Risk settings could not be saved.");
        }
      }
    }, AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [collectionPaused, maxExposure, maxPositions, riskPercent]);

  const formIsValid = configurationFromForm(riskPercent, maxPositions, maxExposure) !== null;

  const riskValue = Number(riskPercent);
  const riskMoney =
    balance !== null && Number.isFinite(riskValue) && riskValue > 0 ? (balance * riskValue) / 100 : null;
  const statusNote = policy.pending
    ? `Queued for Batch ${(policy.currentBatch?.batchNumber ?? 0) + 1}: ${policy.pending.riskPercent.toFixed(2)}% · ${
        policy.pending.maxSimultaneousPositions === null ? "no limit" : `${policy.pending.maxSimultaneousPositions} max`
      }`
    : "Changes save automatically and apply from the next batch.";

  // Shared pieces: the desktop card and the phone sheet draw the same controls.
  const stepper = (id: string) => (
    <div className="nl-st-stepper">
      <button
        type="button"
        className="nl-st-step pressable"
        aria-label="Lower risk by 0.25%"
        onClick={() => setRiskPercent((value) => stepRisk(value, -0.25))}
      >
        −
      </button>
      <span className="nl-st-risk-value">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min="0.1"
          max="5"
          step="0.1"
          value={riskPercent}
          onChange={(event) => setRiskPercent(event.target.value)}
          className="nl-st-risk-input"
          aria-label="Risk per trade percent"
        />
        <span aria-hidden="true">%</span>
      </span>
      <button
        type="button"
        className="nl-st-step pressable"
        aria-label="Raise risk by 0.25%"
        onClick={() => setRiskPercent((value) => stepRisk(value, 0.25))}
      >
        +
      </button>
    </div>
  );

  const presets = (
    <div className="nl-st-presets" role="group" aria-label="Quick risk presets">
      {RISK_PRESETS.map((preset) => {
        const active = Number(riskPercent) === preset;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={active}
            className={`nl-st-pill${active ? " is-active" : ""}`}
            onClick={() => setRiskPercent(String(preset))}
          >
            {preset}%
          </button>
        );
      })}
    </div>
  );

  const positionPills = (
    <div className="nl-st-positions" role="radiogroup" aria-label="Max open positions">
      {POSITION_CHOICES.map((choice) => {
        const active = maxPositions === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={active}
            className={`nl-st-pill${active ? " is-active" : ""}${choice === "unlimited" ? " is-wide" : ""}`}
            onClick={() => setMaxPositions(choice)}
          >
            {choice === "unlimited" ? "No limit" : choice}
          </button>
        );
      })}
    </div>
  );

  const exposureField = (id: string) => (
    <label className="nl-st-exposure" htmlFor={id}>
      <span className="nl-st-field-label">
        Max exposure <span className="nl-st-optional">Optional</span>
      </span>
      <span className="nl-st-input">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={riskPercent || "0.1"}
          max="50"
          step="0.1"
          value={maxExposure}
          onChange={(event) => setMaxExposure(event.target.value)}
          placeholder="No cap"
        />
        <span aria-hidden="true">% of balance</span>
      </span>
      <span className="nl-st-help">Total open risk across every position. Leave blank for no cap.</span>
    </label>
  );

  const allowSwitch = (labelId: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={!collectionPaused}
      aria-labelledby={labelId}
      className={`nl-st-switch${collectionPaused ? "" : " is-on"}`}
      onClick={() => setCollectionPaused((paused) => !paused)}
    >
      <span />
    </button>
  );

  const problems = (
    <>
      {error ? <p className="nl-st-error" role="alert">{error}</p> : null}
      {formIsValid ? null : <p className="nl-st-error" role="status">Enter valid limits</p>}
    </>
  );

  return (
    <>
      {/* Desktop: the Risk card. */}
      <section id="risk" className="nl-st-card is-risk nl-st-desk" aria-labelledby="nl-st-risk-title">
        <div className="nl-st-card-head">
          <div>
            <h2 id="nl-st-risk-title">Risk</h2>
            <p>Limits for paper-trading entries.</p>
          </div>
          {policy.currentBatch ? (
            <span className="nl-st-batch metric-number">
              Batch {policy.currentBatch.batchNumber} · {policy.currentBatch.assignedCount} assigned
            </span>
          ) : null}
        </div>

        <div className="nl-st-risk-hero">
          <div className="nl-st-risk-main">
            <label htmlFor="nl-st-risk" className="nl-st-risk-label">Risk per trade</label>
            {stepper("nl-st-risk")}
            <span className="nl-st-risk-money metric-number">
              {riskMoney === null ? " " : `≈ ${formatMoney(riskMoney)} per trade on ${formatMoney(balance ?? 0)}`}
            </span>
          </div>
          {presets}
        </div>

        <div className="nl-st-block">
          <div className="nl-st-block-head">
            <span className="nl-st-field-label">Max open positions</span>
            <span className="nl-st-note">
              {maxPositions === "unlimited"
                ? "No limit on simultaneous practice trades"
                : `Up to ${maxPositions} practice trade${maxPositions === "1" ? "" : "s"} at once`}
            </span>
          </div>
          {positionPills}
        </div>

        <div className="nl-st-split">
          {exposureField("nl-st-exposure")}
          <div className="nl-st-allow">
            <span className="nl-st-allow-copy">
              <span id="nl-st-allow-label" className="nl-st-field-label">Allow new entries</span>
              <span className="nl-st-note">
                {collectionPaused ? "Paused — open trades keep running." : "New practice entries are open."}
              </span>
            </span>
            {allowSwitch("nl-st-allow-label")}
          </div>
        </div>

        <div className="nl-st-status">
          <span className={`nl-st-state${collectionPaused ? " is-paused" : ""}`}>
            {collectionPaused ? "Paused" : "Accepting"}
          </span>
          <span className="nl-st-note">{statusNote}</span>
        </div>
        {problems}
      </section>

      {/* Phone: the Paper trading card; its limits open in a sheet. */}
      <section className="nl-st-mcard nl-st-phone" aria-labelledby="nl-st-mrisk-title">
        <h2 id="nl-st-mrisk-title" className="nl-st-mcard-title">Paper trading</h2>
        <button type="button" className="nl-st-mrisk pressable" onClick={() => setRiskSheetOpen(true)}>
          <span className="nl-st-mrisk-copy">
            <span className="nl-st-note">Risk per trade</span>
            <span className="nl-st-mrisk-value">{Number.isFinite(riskValue) ? `${riskValue.toFixed(2)}%` : "—"}</span>
            {riskMoney !== null ? (
              <span className="nl-st-mrisk-money metric-number">≈ {formatMoney(riskMoney)} per trade</span>
            ) : null}
          </span>
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="nl-st-mrow pressable" onClick={() => setRiskSheetOpen(true)}>
          <span>Max open positions</span>
          <span className="nl-st-mrow-end">
            {maxPositions === "unlimited" ? "No limit" : maxPositions}
            <ChevronRight aria-hidden="true" />
          </span>
        </button>
        <button type="button" className="nl-st-mrow pressable" onClick={() => setRiskSheetOpen(true)}>
          <span>Max exposure</span>
          <span className="nl-st-mrow-end">
            {maxExposure ? `${maxExposure}%` : "No cap"}
            <ChevronRight aria-hidden="true" />
          </span>
        </button>
        <div className="nl-st-mrow is-static">
          <span className="nl-st-allow-copy">
            <span id="nl-st-mallow-label">Allow new entries</span>
            <span className="nl-st-note">
              {collectionPaused ? "Paused — open trades keep running" : "New practice entries are open"}
            </span>
          </span>
          {allowSwitch("nl-st-mallow-label")}
        </div>
        {problems}
      </section>

      <MobileSheet
        open={riskSheetOpen}
        onClose={() => setRiskSheetOpen(false)}
        eyebrow="Paper trading"
        title="Paper trading limits"
      >
        {/* Phone limits: three cards (risk, positions, exposure) and Done. */}
        <div className="nl-st-sheet nl-lim">
          <section className="nl-lim-card" aria-labelledby="nl-lim-risk-label">
            <div className="nl-lim-head">
              <label id="nl-lim-risk-label" htmlFor="nl-st-mrisk-input">Risk per trade</label>
              {riskMoney !== null ? <span className="nl-lim-money metric-number">≈ {formatMoney(riskMoney)}</span> : null}
            </div>
            <div className="nl-lim-dial">
              <button
                type="button"
                className="nl-lim-round pressable"
                aria-label="Lower risk by 0.25%"
                onClick={() => setRiskPercent((value) => stepRisk(value, -0.25))}
              >
                <Minus aria-hidden="true" />
              </button>
              <span className="nl-lim-value">
                {/* The field is exactly as wide as its text: an invisible copy
                    of the value sizes the cell, the input fills it. */}
                <span className="nl-lim-fit">
                  <span className="nl-lim-mirror" aria-hidden="true">{riskPercent || "0"}</span>
                  <input
                    id="nl-st-mrisk-input"
                    type="number"
                    inputMode="decimal"
                    min="0.1"
                    max="5"
                    step="0.1"
                    value={riskPercent}
                    onChange={(event) => setRiskPercent(event.target.value)}
                    aria-label="Risk per trade percent"
                  />
                </span>
                <span aria-hidden="true">%</span>
              </span>
              <button
                type="button"
                className="nl-lim-round pressable"
                aria-label="Raise risk by 0.25%"
                onClick={() => setRiskPercent((value) => stepRisk(value, 0.25))}
              >
                <Plus aria-hidden="true" />
              </button>
            </div>
            <div className="nl-lim-seg" role="group" aria-label="Quick risk presets">
              {RISK_PRESETS.map((preset) => {
                const active = Number(riskPercent) === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={active}
                    className={`metric-number${active ? " is-active" : ""}`}
                    onClick={() => setRiskPercent(String(preset))}
                  >
                    {preset}%
                  </button>
                );
              })}
            </div>
          </section>

          <section className="nl-lim-card" aria-labelledby="nl-lim-pos-label">
            <div className="nl-lim-row">
              <div className="nl-lim-copy">
                <b id="nl-lim-pos-label">Max open positions</b>
                <span>Trades that can be open at once</span>
              </div>
              <div className="nl-lim-stepper" role="group" aria-labelledby="nl-lim-pos-label">
                <button
                  type="button"
                  className="pressable"
                  aria-label="One fewer position"
                  disabled={maxPositions === "unlimited" || Number(maxPositions) <= 1}
                  onClick={() => setMaxPositions((value) => String(Math.max(1, Number(value) - 1)))}
                >
                  <Minus aria-hidden="true" />
                </button>
                <output className="metric-number" aria-live="polite">{maxPositions === "unlimited" ? "∞" : maxPositions}</output>
                <button
                  type="button"
                  className="pressable"
                  aria-label="One more position"
                  disabled={maxPositions === "unlimited" || Number(maxPositions) >= 10}
                  onClick={() => setMaxPositions((value) => String(Math.min(10, Number(value) + 1)))}
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="nl-lim-row is-sub">
              <span id="nl-lim-nolimit-label">No limit</span>
              <button
                type="button"
                role="switch"
                aria-checked={maxPositions === "unlimited"}
                aria-labelledby="nl-lim-nolimit-label"
                className={`nl-st-switch${maxPositions === "unlimited" ? " is-on" : ""}`}
                onClick={() => {
                  if (maxPositions === "unlimited") {
                    setMaxPositions(lastPositionsRef.current);
                  } else {
                    lastPositionsRef.current = maxPositions;
                    setMaxPositions("unlimited");
                  }
                }}
              >
                <span />
              </button>
            </div>
          </section>

          <section className="nl-lim-card">
            <div className="nl-lim-row">
              <div className="nl-lim-copy">
                <label htmlFor="nl-st-mexposure"><b>Max exposure</b></label>
                <span>Total open risk across every position. Empty means no cap.</span>
              </div>
              <span className="nl-lim-input">
                <input
                  id="nl-st-mexposure"
                  type="number"
                  inputMode="decimal"
                  min={riskPercent || "0.1"}
                  max="50"
                  step="0.1"
                  value={maxExposure}
                  onChange={(event) => setMaxExposure(event.target.value)}
                  placeholder="No cap"
                  className="metric-number"
                />
                {maxExposure ? <span aria-hidden="true">%</span> : null}
              </span>
            </div>
          </section>

          {problems}
          <p className="nl-lim-note">{statusNote}</p>
          <button type="button" className="nl-st-primary nl-lim-done pressable" onClick={() => setRiskSheetOpen(false)}>
            Done
          </button>
        </div>
      </MobileSheet>
    </>
  );
}
