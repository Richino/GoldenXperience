"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { formatClockTime } from "@/lib/format/datetime";
import { parseCashCloseAmounts, readCashCloseConditions, type CashCloseConditions } from "@/lib/trade-close-conditions";
import type { PendingManualEntry } from "@/types/pending-entry";
import styles from "./close-conditions-form.module.css";

interface Settings {
  conditions: CashCloseConditions | null;
  currency: string | null;
  monitoringEnabled: boolean;
  unavailableReason: string | null;
  checkIntervalSeconds: number;
}

export function CloseConditionsForm({ entry, onChanged }: { entry: PendingManualEntry; onChanged: (message: string) => void }) {
  const fieldId = useId();
  const initial = readCashCloseConditions(entry.metadata.cashCloseConditions);
  const [profit, setProfit] = useState(initial?.profitAmount?.toString() ?? "");
  const [loss, setLoss] = useState(initial?.lossAmount?.toString() ?? "");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  const generation = useRef(0);
  const saveInFlight = useRef(false);
  const endpoint = apiUrl(`/api/pending-entries/${entry.id}/close-conditions`);

  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    if (!editing.current) {
      setProfit(next.conditions?.profitAmount?.toString() ?? "");
      setLoss(next.conditions?.lossAmount?.toString() ?? "");
    }
  }, [setSettings, setProfit, setLoss]);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (busy || saveInFlight.current) return;
      busy = true;
      const requestGeneration = generation.current;
      controller = new AbortController();
      try {
        const response = await fetch(endpoint, { credentials: "include", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        const payload = await response.json() as Settings & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Close conditions could not be loaded.");
        if (!disposed && requestGeneration === generation.current) { applySettings(payload); setLoadError(null); }
      } catch {
        if (!disposed && requestGeneration === generation.current) setLoadError("Close conditions could not be refreshed. Try reopening this trade.");
      } finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => { disposed = true; controller?.abort(); window.clearInterval(timer); };
  }, [applySettings, endpoint]);

  const closing = settings?.conditions?.state === "closing";
  const unavailable = settings?.unavailableReason ?? null;
  const canSave = Boolean(settings?.monitoringEnabled && settings.currency && !unavailable && !closing && !loadError);

  async function save(remove = false) {
    if (saving || closing || (!remove && !canSave)) return;
    setNotice(null);
    try {
      const amounts = parseCashCloseAmounts({ profitAmount: remove ? null : profit.trim(), lossAmount: remove ? null : loss.trim() });
      generation.current++;
      saveInFlight.current = true;
      setSaving(true);
      const response = await fetch(endpoint, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(amounts), signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json() as Settings & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Close conditions could not be saved.");
      editing.current = false;
      applySettings(payload);
      setError(null);
      const message = payload.conditions ? "Close conditions saved for this trade." : "Close conditions removed.";
      setNotice(message);
      onChanged(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Close conditions could not be saved. Refresh to check their status.");
    } finally { saveInFlight.current = false; setSaving(false); }
  }

  const currency = settings?.currency ?? initial?.currency ?? null;
  return (
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void save(); }} aria-labelledby={`${fieldId}-title`}>
      <div className={styles.heading}>
        <h3 id={`${fieldId}-title`}>Close conditions</h3>
        <span>{closing ? "Closing…" : settings?.conditions?.state === "armed" ? "Saved" : "Off"}</span>
      </div>
      <p className={styles.description}>Automatically close this trade when its open P/L reaches either amount{currency ? ` (${currency})` : ""}.</p>
      <div className={styles.fields}>
        <label htmlFor={`${fieldId}-profit`}>
          <span>Profit reaches</span>
          <div className={styles.inputWrap}><span aria-hidden="true">+</span><input
            id={`${fieldId}-profit`} type="text" inputMode="decimal" autoComplete="off" placeholder="e.g. 300"
            value={profit} disabled={saving || closing} aria-describedby={`${fieldId}-help`}
            onChange={event => { editing.current = true; setProfit(event.target.value); setNotice(null); setError(null); }}
          /></div>
        </label>
        <label htmlFor={`${fieldId}-loss`}>
          <span>Loss reaches</span>
          <div className={styles.inputWrap}><span aria-hidden="true">−</span><input
            id={`${fieldId}-loss`} type="text" inputMode="decimal" autoComplete="off" placeholder="e.g. 300"
            value={loss} disabled={saving || closing} aria-describedby={`${fieldId}-help`}
            onChange={event => { editing.current = true; setLoss(event.target.value); setNotice(null); setError(null); }}
          /></div>
        </label>
      </div>
      <p id={`${fieldId}-help`} className={styles.help}>Leave either blank to keep it off. Saving a limit already reached can close the trade immediately.</p>
      {unavailable ? <p className={styles.warning} role="status">{unavailable}</p> : null}
      {settings?.conditions?.lastError ? <p className={styles.warning} role="status">{settings.conditions.lastError}</p> : null}
      {closing ? <p className={styles.help}>A limit was reached. Waiting for the broker to confirm the close.</p> : null}
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      {loadError ? <p className={styles.warning} role="alert">{loadError}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      <div className={styles.actions}>
        {settings?.conditions ? <button type="button" className={styles.remove} disabled={saving || closing} onClick={() => void save(true)}>Remove limits</button> : null}
        <button type="submit" className={styles.save} disabled={saving || !canSave}>{saving ? "Saving…" : "Save close conditions"}</button>
      </div>
      <p className={styles.help}>Checks about every {settings?.checkIntervalSeconds ?? 5} seconds while the monitoring server is online, even with the app closed. Final P/L may differ. Existing stop and target orders still apply.</p>
      {settings?.conditions?.lastCheckedAt ? <p className={styles.help}>Last checked {formatClockTime(settings.conditions.lastCheckedAt)} ET</p> : null}
    </form>
  );
}
