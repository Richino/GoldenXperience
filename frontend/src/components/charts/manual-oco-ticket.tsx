"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { precisionFor } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { NEWS_TERMINAL, type PublicNewsRun } from "@/lib/news/news-straddle-v3";
import styles from "./pending-entry-dialog.module.css";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "OCO request failed.");
  return payload as T;
}

export function ManualOcoTicket({ instrument, header, blocked, onCancel, onCreated }: {
  instrument: string; header: ReactNode; blocked: boolean; onCancel(): void; onCreated(message: string): void;
}) {
  const [buyEntry, setBuy] = useState(""), [sellEntry, setSell] = useState(""), [riskAmount, setRisk] = useState("");
  const [retry, setRetry] = useState(0);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; run: PublicNewsRun } | null>(null);
  const key = JSON.stringify({ instrument, buyEntry: Number(buyEntry), sellEntry: Number(sellEntry), riskAmount: Number(riskAmount) });
  const complete = [buyEntry, sellEntry, riskAmount].every(value => value.trim() && Number.isFinite(Number(value)) && Number(value) > 0);
  useEffect(() => {
    if (!complete || blocked) return;
    let active = true;
    const timer = window.setTimeout(() => {
      requestId.current ??= crypto.randomUUID();
      void post<PublicNewsRun>("/api/pending-entries/oco/preview", { ...JSON.parse(key), requestId: requestId.current })
        .then(run => { if (active) { setPreview({ key, run }); setError(null); } })
        .catch(reason => { if (active) { setPreview(null); setError(reason instanceof Error ? reason.message : "Cannot preview OCO."); } });
    }, 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [key, complete, blocked, retry]);
  const current = complete && preview?.key === key ? preview.run : null;
  const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: current?.risk?.currency ?? "USD" }).format(amount);
  async function create() {
    if (!current || busy || blocked || submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const result = await post<{ run: PublicNewsRun }>("/api/pending-entries/oco", { ...JSON.parse(key), requestId: requestId.current });
      if (!result.run || NEWS_TERMINAL.includes(result.run.state)) throw new Error("This request has ended. Reopen the ticket to create a new setup.");
      onCreated("Linked OCO entries accepted");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "OCO could not start."); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <>
    <div className={`nl-pe-plan nl-pe-ticket ${styles.ticket} ${styles.minimalTicket}`}>
      {header}
      <p className={styles.ocoNote}>First fill cancels the opposite pending order.</p>
      <div className={styles.levelsCard}><div className={`nl-pe-levels ${styles.levels}`}>
        <label><span>Buy stop · above market</span><input inputMode="decimal" aria-label="OCO buy entry" value={buyEntry} disabled={busy} onChange={e => setBuy(e.target.value)} placeholder="Entry price" /></label>
        <label><span>Sell stop · below market</span><input inputMode="decimal" aria-label="OCO sell entry" value={sellEntry} disabled={busy} onChange={e => setSell(e.target.value)} placeholder="Entry price" /></label>
        <label><span>Cash risk per order</span><input inputMode="decimal" aria-label="OCO cash risk per order" value={riskAmount} disabled={busy} onChange={e => setRisk(e.target.value)} placeholder="e.g. 300" /></label>
      </div></div>
      <dl className={`nl-an-rows ${styles.summary}`}>
      {current ? <>
        <div><dt>Long stop · at planned entry</dt><dd>{(current.legs.long.entry! - current.legs.long.stopDistance!).toFixed(precisionFor(instrument))}</dd></div>
        <div><dt>Short stop · at planned entry</dt><dd>{(current.legs.short.entry! + current.legs.short.stopDistance!).toFixed(precisionFor(instrument))}</dd></div>
      </> : null}
        <div><dt>Risk per order</dt><dd>{current?.risk ? `${money(current.risk.perLegCash)} (${current.risk.perLegPercent.toFixed(2)}%)` : complete ? "Checking broker…" : "Set prices to preview"}</dd></div>
        {current?.risk ? <div><dt>If both fill</dt><dd>{money(current.risk.perLegCash * 2)} planned risk</dd></div> : null}
        <div><dt>Unfilled orders expire</dt><dd>After 24 hours</dd></div>
      </dl>
      <p className={styles.ocoNote}>Practice account only. Stops use 2× completed 4H ATR; units are sized to your cash risk. No fixed target or automatic trailing stop. Slippage can exceed planned cash risk. If both fill, GX attempts to close this setup’s exposure.</p>
      {blocked ? <p className="nl-pe-error" role="alert">This pair already has a trade or setup.</p> : null}
      {error ? <div><p className="nl-pe-error" role="alert">{error}</p><button type="button" className="nl-an-secondary pressable" style={{ minHeight: 44 }} disabled={busy || !complete} onClick={() => setRetry(value => value + 1)}>Retry preview</button></div> : null}
    </div>
    <footer className="nl-an-actions is-card nl-pe-actions">
      <button type="button" className="nl-an-secondary pressable" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className="nl-an-primary pressable" disabled={busy || blocked || !current} onClick={() => void create()}>{busy ? "Creating…" : "Create linked entries"}</button>
    </footer>
  </>;
}
