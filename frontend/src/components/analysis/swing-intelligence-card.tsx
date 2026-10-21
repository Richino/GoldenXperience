"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { canSaveSwingPlan, swingPlanStatus, swingPlanTerms } from "@/lib/swing-plan-flow";
import { SWING_CHANGED, swingChanged, swingRead } from "@/lib/swing-api";
import type { SwingScenario, SwingView, SwingZone } from "@/lib/swing-intelligence";
import styles from "./swing-intelligence.module.css";

const words = (value: string) => value.replaceAll("_", " ").toLowerCase();

export function SwingIntelligenceCard({ instrument, onZones, open = false, onClose, startRequest = 0, onBusyChange, onRequestComplete }: {
  instrument: string; onZones?(zones: SwingZone[]): void; open?: boolean; onClose(): void;
  startRequest?: number; onBusyChange?(busy: boolean): void; onRequestComplete?(sequence: number): void;
}) {
  const [view, setView] = useState<SwingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const handledStart = useRef(0);
  const handledRetry = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const digits = precisionFor(instrument);
  const price = (value: number | null | undefined) => value == null ? "—" : value.toFixed(digits);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await swingRead<SwingView>(`?instrument=${encodeURIComponent(instrument)}`);
        if (active) { setView(next); setLoadError(null); }
      } catch (e) { if (active) setLoadError(e instanceof Error ? e.message : "Analysis is unavailable."); }
      finally { pending = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10000);
    const changed = () => void refresh();
    window.addEventListener(SWING_CHANGED, changed);
    document.addEventListener("visibilitychange", changed);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(SWING_CHANGED, changed); document.removeEventListener("visibilitychange", changed); };
  }, [instrument]);
  useEffect(() => { onZones?.(!loadError && view?.monitor?.active ? view.zones : []); }, [loadError, onZones, view]);
  useEffect(() => () => onZones?.([]), [onZones]);

  useEffect(() => {
    if ((!startRequest || handledStart.current === startRequest) && handledRetry.current === retry) return;
    if (startRequest) handledStart.current = startRequest;
    handledRetry.current = retry;
    let active = true;
    onBusyChange?.(true);
    setError(null);
    void swingRead<{ cached: boolean; job: SwingView["job"] }>("/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument }),
    }).then(async result => {
      if (!active) return;
      if (result.job && ["FAILED", "BUDGET_BLOCKED"].includes(result.job.status) && !result.cached) throw new Error(result.job.error ?? "Research could not start. Try again later.");
      setNotice(result.cached ? "Your latest analysis is ready" : "Analysis has begun");
      swingChanged(instrument);
      await refreshRef.current();
    }).catch(e => {
      if (active) { setError(e instanceof Error ? e.message : "Analysis could not start."); setNotice("Analysis could not start"); }
    }).finally(() => { if (active) { onBusyChange?.(false); onRequestComplete?.(startRequest); } });
    return () => { active = false; onBusyChange?.(false); onRequestComplete?.(startRequest); };
  }, [instrument, onBusyChange, onRequestComplete, retry, startRequest]);

  const close = () => { setNotice(null); onClose(); };
  const accept = async (scenario: SwingScenario) => {
    const zone = view?.zones.find(zone => zone.id === scenario.zoneId);
    if (!view?.assessment || !zone || busy) return;
    setBusy(true); setError(null);
    try {
      await swingRead("/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        instrument, assessmentId: view.assessment.id, scenarioId: scenario.id, terms: swingPlanTerms(scenario), lower: zone.lower, upper: zone.upper,
      }) });
      await refreshRef.current();
      swingChanged(instrument);
    } catch (e) { setError(e instanceof Error ? e.message : "The plan could not be saved."); }
    finally { setBusy(false); }
  };
  const status = view ? swingPlanStatus(view) : "Loading analysis…";
  const displayError = error ?? loadError;
  const assessment = view?.assessment;
  const accepted = view?.acceptedPlan;
  return <MobileSheet open={open || notice !== null} onClose={close} title={notice ?? `Swing plan · ${displayNameFor(instrument)}`}
    eyebrow="Analyze · 2–5 trading days" lockPageScroll={false} className={notice ? styles.notice : styles.sheet}>
    <section className={styles.card} aria-label={`${displayNameFor(instrument)} swing analysis`}>
      {displayError ? <p className={styles.warning} role="alert">{displayError}</p> : null}
      {notice ? <>
        {!error ? <p>{notice === "Analysis has begun" ? `GX is analyzing ${displayNameFor(instrument)}. You can keep using the chart. Follow its progress in Plans and review the result when it is ready.` : "Open Plans to review the result on the chart."}</p> : null}
        <div className={styles.actions}>
          {error ? <button type="button" onClick={() => { setNotice(null); setRetry(value => value + 1); }}>Try again</button> : <Link href="/#nl-plans-title" onClick={close}>View Plans</Link>}
          <button type="button" onClick={close}>Back to chart</button>
        </div>
      </> : <>
        <header className={styles.header}><div><p className={styles.eyebrow}>Swing analysis</p><h2>{displayNameFor(instrument)}</h2></div><span className={styles.badge} role="status">{status}</span></header>
        {!assessment ? <p>{!view ? "Loading your analysis…" : view.job?.error ?? view.runtime.reason ?? (view.monitor?.active ? "Research is running. The result will appear in Plans when it is ready." : "Press Analyze to begin researching this pair.")}</p> : <>
          <p>{assessment.interpretation.swingOutlook}</p>
          <p className={styles.note}>Updated {new Date(assessment.createdAt).toLocaleString()} · {words(view?.preference ?? "")}</p>
          {!view?.assessmentFresh ? <p className={styles.warning}>This result needs fresh research before you can accept a plan.</p> : null}
          {accepted ? <p className={styles.note}>Saved {accepted.scenario.side} plan · zone {price(accepted.zone.lower)}–{price(accepted.zone.upper)} · stop {price(accepted.scenario.stop)} · target {price(accepted.scenario.firstTarget)}. {status === "Needs review" ? "Conditions or levels changed. Review and accept the updated plan to replace it." : status === "Entry conditions met" ? "Entry conditions are met. Review current pricing before taking action." : "GX checks its entry conditions in the background."}</p> : null}
          <div className={styles.columns}>{view?.scenarios.map(scenario => {
            const zone = view.zones.find(zone => zone.id === scenario.zoneId);
            const saved = accepted?.scenario.id === scenario.id && accepted.assessmentId === assessment.id && swingPlanTerms(accepted.scenario) === swingPlanTerms(scenario)
              && zone?.lower === accepted.zone.lower && zone?.upper === accepted.zone.upper;
            return <article className={styles.scenario} key={scenario.id}>
              <h3>{scenario.side} plan</h3>
              <dl><div><dt>Entry zone</dt><dd>{price(zone?.lower)}–{price(zone?.upper)}</dd></div>
                <div><dt>Stop loss</dt><dd>{price(scenario.stop)}</dd></div><div><dt>Target</dt><dd>{price(scenario.firstTarget)}</dd></div>
                <div><dt>Reward / risk now</dt><dd>{scenario.rewardRisk?.toFixed(2) ?? "—"}R</dd></div></dl>
              <p>{zone?.reason}</p>
              <p className={styles.note}>{scenario.support.at(-1)}</p>
              {scenario.blockers.length ? <details><summary>Waiting conditions ({scenario.blockers.length})</summary><ul>{scenario.blockers.map(text => <li key={text}>{text}</li>)}</ul></details> : null}
              <div className={styles.actions}><button type="button" disabled={busy || saved || Boolean(displayError) || !canSaveSwingPlan(view, scenario)} onClick={() => void accept(scenario)}>{saved ? "Plan accepted" : busy ? "Saving…" : `Accept ${scenario.side} plan`}</button></div>
              {!canSaveSwingPlan(view, scenario) && !saved ? <p className={styles.note}>A current assessment and valid entry, stop and target are required to save this plan.</p> : null}
            </article>;
          })}</div>
          {!view?.scenarios.length ? <p>No valid plan is available yet. {view?.unavailableZones.join(" ")}</p> : null}
          <p className={styles.note}>Accept saves one plan and watches its entry conditions. It does not place an order. Accepting another plan replaces the saved watch.</p>
          <details><summary>Research and supporting evidence</summary><p>{assessment.interpretation.explanation}</p><p>{assessment.fundamentalSummary}</p>
            <h3>Risks and invalidation</h3><ul>{[...assessment.interpretation.contradictions, ...assessment.interpretation.invalidation, ...assessment.limitations].map((text, index) => <li key={index}>{text}</li>)}</ul>
            <h3>Sources</h3><ul>{assessment.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.publisher} · {source.title ?? source.url}</a></li>)}</ul>
          </details>
        </>}
        <div className={styles.actions}><button type="button" onClick={() => void refreshRef.current()}>Refresh status</button>
          {view?.enabled && view.runtime.available && (!view.assessmentFresh || !view.monitor?.active) ? <button type="button" onClick={() => { onClose(); setRetry(value => value + 1); }}>Analyze again</button> : null}
          {view?.monitor?.active ? <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); setError(null);
            try { await swingRead(`/monitor?instrument=${encodeURIComponent(instrument)}`, { method: "DELETE" }); await refreshRef.current(); swingChanged(instrument); }
            catch (e) { setError(e instanceof Error ? e.message : "Watching could not be stopped."); }
            finally { setBusy(false); }
          }}>Stop watching</button> : null}
          <button type="button" onClick={close}>Back to chart</button></div>
      </>}
    </section>
  </MobileSheet>;
}
