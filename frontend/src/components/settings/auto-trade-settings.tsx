"use client";

import { useEffect, useState } from "react";
import { tradePlansApi, type AutoTradeLimits, type AutoTradeSettings } from "@/lib/trade-plans/api";
import styles from "./auto-trade-settings.module.css";

/**
 * Settings → Auto trade. Turning it on approves the limits shown with it;
 * only then can an Analyze plan be accepted as "Auto trade". Practice
 * accounts only. One card for desktop and phone.
 */

const FIELDS: Array<{ key: keyof AutoTradeLimits; label: string; hint: string; suffix: string; step: string; min: number; max: number }> = [
  { key: "maxRiskPercent", label: "Risk per trade", hint: "Of the account, from entry to stop.", suffix: "%", step: "0.1", min: 0.1, max: 5 },
  { key: "maxAggregateRiskPercent", label: "Total open risk", hint: "All open Auto trades together.", suffix: "%", step: "0.5", min: 0.1, max: 20 },
  { key: "maxOpenPositions", label: "Open trades", hint: "At most at once.", suffix: "", step: "1", min: 1, max: 20 },
  { key: "dailyLossLimitPercent", label: "Daily loss limit", hint: "No new Auto trades after this loss in a day.", suffix: "%", step: "0.5", min: 0.1, max: 20 },
];

const asText = (limits: AutoTradeLimits) =>
  Object.fromEntries(FIELDS.map((field) => [field.key, String(limits[field.key])])) as Record<keyof AutoTradeLimits, string>;

export function AutoTradeSettingsCard() {
  const [settings, setSettings] = useState<AutoTradeSettings | null>(null);
  const [draft, setDraft] = useState<Record<keyof AutoTradeLimits, string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    tradePlansApi.autoTrade()
      .then((value) => { if (live) { setSettings(value); setDraft(asText(value.limits)); } })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load Auto trade settings."); });
    return () => { live = false; };
  }, []);

  if (!settings || !draft) {
    return (
      <section id="auto-trade" className={`nl-st-card ${styles.card}`} aria-labelledby="nl-st-auto-title" aria-busy={!error}>
        <div className="nl-st-card-head"><div><h2 id="nl-st-auto-title">Auto trade</h2><p>{error ?? "Loading…"}</p></div></div>
      </section>
    );
  }

  const limits = Object.fromEntries(FIELDS.map((field) => [field.key, Number(draft[field.key])])) as unknown as AutoTradeLimits;
  const changed = FIELDS.some((field) => limits[field.key] !== settings.limits[field.key]);
  const brokerReady = settings.broker.environment === "practice";

  const save = async (autoTrade: boolean, message: string) => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await tradePlansApi.saveAutoTrade({ ...limits, autoTrade });
      setSettings(next);
      setDraft(asText(next.limits));
      setConfirming(false);
      setSaved(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const approved = settings.approvedAt
    ? new Date(settings.approvedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section id="auto-trade" className={`nl-st-card ${styles.card}`} aria-labelledby="nl-st-auto-title">
      <div className="nl-st-card-head">
        <div>
          <h2 id="nl-st-auto-title">Auto trade</h2>
          <p>Lets an accepted Analyze plan place its own trade on your OANDA practice account, within these limits.</p>
        </div>
        <span className={styles.status} data-on={settings.autoTrade}>
          <i aria-hidden="true" />{settings.autoTrade ? "On" : "Off"}
        </span>
      </div>

      <div className={styles.switchRow}>
        <div>
          <span className={styles.switchLabel} id="auto-trade-switch-label">Auto trade</span>
          <span className={styles.switchHint}>
            {settings.autoTrade ? `On since ${approved}, with the limits below.` : "Off: plans can only alert you."}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.autoTrade}
          aria-labelledby="auto-trade-switch-label"
          className={styles.switch}
          disabled={busy || (!settings.autoTrade && !brokerReady)}
          onClick={() => {
            setSaved(null);
            if (settings.autoTrade) void save(false, "Auto trade is off. Plans you accept can only alert you.");
            else setConfirming(true);
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>

      {!brokerReady ? (
        <p className={styles.warn}>
          {settings.broker.environment === "live"
            ? "This server is connected to a live OANDA account. Auto trade only runs on a practice account."
            : "No OANDA account is connected. Connect a practice account to use Auto trade."}
        </p>
      ) : null}

      <fieldset className={styles.limits} disabled={busy}>
        <legend className={styles.legend}>Limits</legend>
        {FIELDS.map((field) => (
          <label key={field.key} className={styles.field}>
            <span className={styles.fieldLabel}>{field.label}</span>
            <span className={styles.inputWrap}>
              <input
                type="number"
                inputMode="decimal"
                min={field.min}
                max={field.max}
                step={field.step}
                value={draft[field.key]}
                onChange={(event) => { setSaved(null); setDraft({ ...draft, [field.key]: event.target.value }); }}
              />
              {field.suffix ? <span className={styles.suffix}>{field.suffix}</span> : null}
            </span>
            <span className={styles.fieldHint}>{field.hint}</span>
          </label>
        ))}
      </fieldset>

      {changed && settings.autoTrade && !confirming ? (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void save(true, "New limits saved and approved.")}>
            {busy ? "Saving…" : "Save and approve new limits"}
          </button>
          <button type="button" className={styles.ghost} disabled={busy} onClick={() => setDraft(asText(settings.limits))}>Undo</button>
        </div>
      ) : null}
      {changed && !settings.autoTrade && !confirming ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void save(false, "Limits saved.")}>{busy ? "Saving…" : "Save limits"}</button>
          <button type="button" className={styles.ghost} disabled={busy} onClick={() => setDraft(asText(settings.limits))}>Undo</button>
        </div>
      ) : null}

      {confirming ? (
        <div className={styles.confirm} role="group" aria-label="Turn on Auto trade">
          <p>
            Turn on Auto trade with {limits.maxRiskPercent}% per trade, {limits.maxAggregateRiskPercent}% total, up to {limits.maxOpenPositions} open
            trades and a {limits.dailyLossLimitPercent}% daily loss limit? Plans you accept as Auto trade may then place trades on your practice
            account within these limits.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} disabled={busy} onClick={() => void save(true, "Auto trade is on.")}>
              {busy ? "Turning on…" : "Turn on Auto trade"}
            </button>
            <button type="button" className={styles.ghost} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : null}

      {settings.autoTrade && settings.executorAvailable ? (
        <p className={styles.note}>
          When an Auto trade plan confirms, GX re-checks everything on fresh prices, then places a market order with the stop and target
          attached. If any check fails, nothing is sent and you are told why.
        </p>
      ) : null}
      {settings.autoTrade && !settings.executorAvailable ? (
        <p className={styles.note}>
          Placing the order is the next part being built. Until it ships, an Auto trade plan that confirms alerts you and places nothing.
        </p>
      ) : null}
      {settings.suspended ? <p className={styles.warn}>Paused after broker errors: {settings.suspended.reason ?? "check the broker connection"}. Turning Auto trade on again resumes it.</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {saved ? <p className={styles.saved} role="status">{saved}</p> : null}
    </section>
  );
}
