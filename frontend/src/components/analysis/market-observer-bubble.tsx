"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { precisionFor } from "@/lib/instruments/catalog";
import type { ObserverSnapshot } from "@/lib/market-observer-types";
import styles from "./market-observer-bubble.module.css";

function ScoutFace({ paused }: { paused: boolean }) {
  return <svg className={styles.face} viewBox="0 0 48 48" aria-hidden="true">
    <path d="M12 17 8 7l13 7M36 17 40 7 27 14" fill="currentColor" />
    <rect x="7" y="13" width="34" height="28" rx="13" fill="currentColor" />
    <path d={paused ? "M15 25h5m8 0h5" : "M17 23v4m14-4v4"} stroke="var(--scout-ink)" strokeWidth="3" strokeLinecap="round" />
    <path d="m21 32 3 2 3-2" fill="none" stroke="var(--scout-ink)" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

/** Polls a shared server observer. Pair changes, replay and hidden tabs cannot show stale live reads. */
export function MarketObserverBubble({ instrument, replayActive = false }: { instrument: string; replayActive?: boolean }) {
  const [value, setValue] = useState<{ instrument: string; snapshot: ObserverSnapshot } | null>(null);
  const [failure, setFailure] = useState<{ instrument: string; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (replayActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.visibilityState !== "hidden") {
          const response = await fetch(apiUrl(`/api/market-observer?instrument=${encodeURIComponent(instrument)}`), { credentials: "include", cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Live observer is unavailable.");
          const snapshot = await response.json() as ObserverSnapshot;
          if (!controller.signal.aborted) { setValue({ instrument, snapshot }); setFailure(null); }
        }
      } catch {
        if (!controller.signal.aborted) setFailure({ instrument, text: "Connection interrupted. Live observations are paused." });
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 1000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); actionRef.current?.abort(); };
  }, [instrument, replayActive]);
  const snapshot = !replayActive && value?.instrument === instrument ? value.snapshot : null;
  const error = failure?.instrument === instrument ? failure.text : null;
  if (replayActive || snapshot?.enabled === false) return null;
  const read = snapshot?.read, plan = snapshot?.plan;
  const paused = Boolean(error) || read?.state !== "live";
  const headline = error ? "Live analysis paused" : read?.headline ?? "Connecting the live observer";
  const price = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toFixed(precisionFor(instrument));
  const active = plan && !["CLOSED", "EXPIRED", "INVALIDATED"].includes(plan.status);
  const monitor = async (mode: "NORMAL" | "SWING") => {
    actionRef.current?.abort();
    const controller = new AbortController(); actionRef.current = controller; setBusy(true); setActionError(null);
    try {
      const response = await fetch(apiUrl("/api/market-observer/analyze"), { method: "POST", credentials: "include", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument, mode }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The plan could not be saved.");
    } catch (e) { if (!controller.signal.aborted) setActionError(e instanceof Error ? e.message : "Plan could not be saved."); }
    finally { if (actionRef.current === controller) setBusy(false); }
  };
  const cancel = async () => {
    actionRef.current?.abort(); const controller = new AbortController(); actionRef.current = controller; setBusy(true); setActionError(null);
    try {
      const response = await fetch(apiUrl(`/api/market-observer/plan?instrument=${encodeURIComponent(instrument)}`), { method: "DELETE", credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("Monitoring could not be stopped.");
      const next = await response.json() as ObserverSnapshot;
      if (!controller.signal.aborted) setValue({ instrument, snapshot: next });
    } catch (e) { if (!controller.signal.aborted) setActionError(e instanceof Error ? e.message : "Could not stop monitoring."); }
    finally { if (actionRef.current === controller) setBusy(false); }
  };
  const body = error ?? (read?.blockers[0] || (plan && active ? `${plan.status.toLowerCase()}: ${plan.reason}` : read?.facts.find(f => f.category === "structure")?.text) || "Watching received quotes, candles and patterns.");
  return <aside className={`${styles.scout} ${minimized ? styles.minimized : ""}`} data-market-observer data-state={paused ? "paused" : "live"}>
    {open && <section className={styles.panel} aria-label={`${instrument.replace("_", "/")} live analysis`}>
      <header className={styles.panelHead}><div><small>LIVE OBSERVER · PAPER</small><h3>{instrument.replace("_", "/")} · {headline}</h3></div><button aria-label="Close observer details" onClick={() => setOpen(false)}><X size={18} /></button></header>
      {error && <p className={styles.notice} role="status">{error}</p>}
      {actionError && <p className={styles.notice} role="status">{actionError}</p>}
      {!error && read && <>
        <p className={styles.timestamp}>Read {new Date(read.asOf).toLocaleTimeString()} · {read.state}</p>
        {read.movement.length > 0 && <div className={styles.metrics}>{read.movement.map(w => <div key={w.seconds}><small>{w.seconds}s net</small><strong>{w.netPips > 0 ? "+" : ""}{w.netPips.toFixed(2)}p</strong><span>{w.ready ? `${Math.round(w.efficiency * 100)}% retained` : "warming"}</span></div>)}</div>}
        <h4>What the market is doing</h4>
        <ul>{read.facts.filter(f => f.category === "structure" || f.category === "risk").map(f => <li key={f.id}>{f.text}</li>)}</ul>
        <h4>Detected patterns</h4>
        {read.patterns.length ? <ul>{read.patterns.map(p => <li key={p.id}><strong>{p.timeframe} {p.kind.replaceAll("_", " ")}</strong> · {p.state}{p.historical ? " · historical" : ""}</li>)}</ul> : <p>No active shape meets the defined rules.</p>}
        <p className={styles.caption}>Forming shapes can change. A pattern alone is not an entry.</p>
        {read.ai.text ? <><h4>AI highlights</h4><p>{read.ai.text}</p><p className={styles.caption}>Evidence as of {new Date(read.ai.at!).toLocaleTimeString()}.</p></> : <p className={styles.caption}>{read.ai.state === "limited" ? "AI highlight budget reached. Measurements continue." : read.ai.state === "error" ? "AI highlights unavailable. Measurements continue." : read.ai.state === "disabled" ? "Measured evidence is shown above." : "AI highlights are being prepared."}</p>}
        <h4>What would change the read</h4><ul>{read.changeConditions.map(c => <li key={c}>{c}</li>)}</ul>
      </>}
      <h4>Monitored Analyze plan</h4>
      {plan ? <div className={styles.plan}>
        <div className={styles.planHead}><strong>{plan.direction?.toUpperCase() ?? "WATCH CONDITION"} · {plan.mode}</strong><span>{plan.status}</span></div>
        <p>{plan.reason}</p>
        {plan.zone && <p>Entry zone {price(plan.zone.low)} – {price(plan.zone.high)}</p>}
        {plan.trigger && <p>Trigger: a new {plan.trigger.timeframe} close {plan.direction === "long" ? "above" : "below"} {price(plan.trigger.boundary)}, with executable price in the zone.</p>}
        {plan.entry !== null && <p>Entry reference {price(plan.entry)} · stop {price(plan.stop)} · target {price(plan.target)}</p>}
        <p>{plan.invalidation}</p><small>Version {plan.version} · expires {new Date(plan.expiresAt).toLocaleString()}</small>
        <p className={styles.caption}>Monitoring a hypothesis. Triggered means the condition was observed; no order was placed.</p>
        {active && <button disabled={busy} onClick={() => void cancel()}>Stop monitoring</button>}
      </div> : <p>Analyze creates a versioned plan. Missing checks produce a watch condition with no entry signal.</p>}
      {snapshot?.storage === "unavailable" && <p className={styles.notice}>Plan journal is unavailable. Monitoring cannot be saved.</p>}
      <div className={styles.actions}><button disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor("NORMAL")}>{busy ? "Saving…" : "Analyze & monitor"}</button><button disabled={busy || snapshot?.storage !== "ready"} onClick={() => void monitor("SWING")}>Swing plan</button></div>
      {snapshot?.history.length ? <><h4>Plan history</h4><ul>{snapshot.history.slice(0, 8).map(e => <li key={e.id}><strong>{e.status}</strong> · {new Date(e.at).toLocaleTimeString()}<br />{e.reason}</li>)}</ul></> : null}
    </section>}
    <div className={styles.bubbleRow}>
      <button className={styles.bubble} aria-expanded={open} aria-label={`${headline}. Open live observer details`} onClick={() => { setOpen(!open); setMinimized(false); }}>
        <ScoutFace paused={paused} /><span><strong>{headline}</strong>{!minimized && <span className={styles.copy}>{body}</span>}</span>{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
      {!open && !minimized && <button className={styles.minimize} aria-label="Minimize observer bubble" onClick={() => setMinimized(true)}><X size={13} /></button>}
    </div>
  </aside>;
}
