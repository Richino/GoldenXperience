"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, CheckCircle2, Circle, X, XCircle } from "lucide-react";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import {
  SETUP_LABEL,
  STATUS_LABEL,
  tradePlansApi,
  type ConditionStatus,
  type GenerateResult,
  type MonitoringMode,
  type TradePlan,
} from "@/lib/trade-plans/api";
import styles from "./plan-analyze.module.css";

/**
 * The chart's Analyze: one press reads D1/H4/H1/M15 and returns a BUY and a
 * SELL plan (or no valid setup). One Accept approves both at the versions
 * shown; the server then watches both zones and, when one side confirms,
 * cancels the other — one trade per pair. Afterwards Analyze shows the
 * plans being watched, and the mascot narrates them.
 */

export const TRADE_PLANS_CHANGED = "gx-trade-plans-changed";
const announce = () => window.dispatchEvent(new Event(TRADE_PLANS_CHANGED));

type Phase =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "results"; result: GenerateResult }
  | { kind: "error"; message: string };

export function usePlanAnalyze(instrument: string, disabled = false) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [active, setActive] = useState<TradePlan[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const request = useRef(0);

  const refreshActive = useCallback(async () => {
    try {
      setActive(await tradePlansApi.list("active", instrument));
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, [instrument]);

  useEffect(() => {
    request.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ kind: "idle" });
    setOpen(false);
    setActionError(null);
    void refreshActive();
    const timer = window.setInterval(() => void refreshActive(), 20_000);
    const changed = () => void refreshActive();
    window.addEventListener(TRADE_PLANS_CHANGED, changed);
    return () => { window.clearInterval(timer); window.removeEventListener(TRADE_PLANS_CHANGED, changed); };
  }, [refreshActive]);

  const run = useCallback(async () => {
    if (disabled) return;
    setOpen(true);
    setActionError(null);
    // Plans already being watched: show them instead of analysing over them.
    if (active.length) { setPhase({ kind: "idle" }); return; }
    const id = ++request.current;
    setPhase({ kind: "analyzing" });
    try {
      const result = await tradePlansApi.generate(instrument);
      if (id === request.current) setPhase({ kind: "results", result });
    } catch (error) {
      if (id === request.current) setPhase({ kind: "error", message: error instanceof Error ? error.message : "Analysis failed." });
    }
  }, [active.length, disabled, instrument]);

  const act = useCallback(async (work: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      after();
      await refreshActive();
      announce();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }, [refreshActive]);

  const accept = (mode: MonitoringMode) => {
    if (phase.kind !== "results") return;
    const { result } = phase;
    void act(() => tradePlansApi.accept(result.analysisId, mode, result.plans), () => setPhase({ kind: "idle" }));
  };
  /** Not now: reject the offered plans so nothing lingers awaiting approval. */
  const dismiss = () => {
    if (phase.kind !== "results" || !phase.result.plans.length) { setPhase({ kind: "idle" }); setOpen(false); return; }
    const plans = phase.result.plans;
    void act(() => Promise.all(plans.map((plan) => tradePlansApi.reject(plan.id, "Not now"))), () => { setPhase({ kind: "idle" }); setOpen(false); });
  };
  const stopWatching = () => {
    const live = active.filter((plan) => plan.status !== "EXECUTION_PENDING" && plan.status !== "ORDER_SUBMITTED" && plan.status !== "PARTIALLY_FILLED");
    void act(() => Promise.all(live.map((plan) => tradePlansApi.cancel(plan.id, "Stopped watching from Analyze"))), () => setOpen(false));
  };
  const cancel = () => { request.current += 1; setPhase({ kind: "idle" }); setOpen(false); };

  return { phase, active, open, setOpen, busy, actionError, run, accept, dismiss, stopWatching, cancel, analyzing: phase.kind === "analyzing" };
}

export type PlanAnalyzeState = ReturnType<typeof usePlanAnalyze>;

const clock = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

function ConditionIcon({ status }: { status: ConditionStatus }) {
  if (status === "PASSED") return <CheckCircle2 className={`size-3.5 ${styles.passed}`} aria-hidden="true" />;
  if (status === "FAILED") return <XCircle className={`size-3.5 ${styles.failed}`} aria-hidden="true" />;
  if (status === "BLOCKED") return <Ban className={`size-3.5 ${styles.blocked}`} aria-hidden="true" />;
  return <Circle className={`size-3.5 ${styles.waiting}`} aria-hidden="true" />;
}

export function PlanBlock({ plan, watching }: { plan: TradePlan; watching: boolean }) {
  const digits = precisionFor(plan.instrument);
  const price = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
  const proposal = plan.monitorState?.proposal ?? null;
  const confirmed = plan.status === "CONFIRMED" || plan.status === "NOTIFIED";
  return (
    <section className={styles.plan} data-side={plan.direction}>
      <header className={styles.planHead}>
        <span className={styles.side}>{plan.direction}</span>
        <span className={styles.setup}>{SETUP_LABEL[plan.setupType]}</span>
        <span className={styles.rr}>{plan.rewardRisk?.toFixed(2) ?? "—"}R</span>
      </header>
      <dl className={styles.levels}>
        <div><dt>Zone</dt><dd>{price(plan.entryZoneLow)}–{price(plan.entryZoneHigh)}</dd></div>
        <div><dt>Stop</dt><dd>{price(plan.stopLoss)}</dd></div>
        <div><dt>Target</dt><dd>{price(plan.takeProfit)}</dd></div>
      </dl>
      {watching ? (
        <p className={confirmed ? styles.ready : styles.status}>
          {confirmed && proposal
            ? `Confirmed — enter near ${price(proposal.entry)}, stop ${price(proposal.stopLoss)}, target ${price(proposal.takeProfit)}.`
            : plan.notTriggeredReason ?? `${STATUS_LABEL[plan.status]} — first check within a minute.`}
        </p>
      ) : (
        <p className={styles.why}>{plan.plan.explanation?.[0]}</p>
      )}
      <details className={styles.details}>
        <summary>What has to happen</summary>
        <ul className={styles.checks}>
          {plan.conditions.map((item) => (
            <li key={item.key}>
              <ConditionIcon status={item.status} />
              <span>{item.label}{item.detail ? <small>{item.detail}</small> : null}</span>
            </li>
          ))}
        </ul>
        {plan.plan.invalidation?.rules?.length ? <p className={styles.fine}>Cancelled if: {plan.plan.invalidation.rules.join(" ")}</p> : null}
        <p className={styles.fine}>Valid until {clock(plan.expiresAt)} · risk {plan.maxRiskPercent}%</p>
      </details>
    </section>
  );
}

function PlanAnalyzeBody({ state, instrument, titleId, onClose, onNewEntry }: {
  state: PlanAnalyzeState;
  instrument: string;
  titleId: string;
  onClose?: () => void;
  onNewEntry?: () => void;
}) {
  const [mode, setMode] = useState<MonitoringMode>("NOTIFY");
  const pair = displayNameFor(instrument);
  const { phase, active } = state;
  const top = (label: string) => (
    <div className="nl-an-top">
      <span className="nl-an-eyebrow"><AnalyzeIcon className="size-3.5" />{label}</span>
      {onClose ? <button type="button" className="nl-an-close" onClick={onClose} aria-label="Close"><X aria-hidden="true" /></button> : null}
    </div>
  );

  if (phase.kind === "analyzing") {
    return (
      <div className="nl-an-body" aria-busy="true">
        {top(`Analyzing ${pair}…`)}
        <span className="nl-an-skel nl-an-skel-title" id={titleId} />
        <span className="nl-an-skel nl-an-skel-grid" />
        <span className="nl-an-skel nl-an-skel-line" />
      </div>
    );
  }

  if (phase.kind === "results") {
    const { result } = phase;
    const plans = result.plans;
    if (!plans.length) {
      return (
        <div className="nl-an-body">
          {top(`Analyze · ${pair}`)}
          <h2 id={titleId} className="nl-an-decision">No valid setup right now</h2>
          <ul className={styles.rejected}>
            {result.rejected.map((item) => <li key={`${item.direction}-${item.setupType}`}><strong>{item.direction}</strong> {item.reason}</li>)}
          </ul>
          <div className="nl-an-actions is-card">
            <button type="button" className="nl-an-secondary pressable" onClick={state.dismiss}>Close</button>
          </div>
        </div>
      );
    }
    return (
      <div className="nl-an-body">
        {top(`Analyze · ${pair}`)}
        <h2 id={titleId} className="nl-an-decision">
          {plans.length === 2 ? "Two plans: BUY and SELL" : `One plan: ${plans[0]!.direction}`}
        </h2>
        <p className={styles.lede}>
          {plans.length === 2
            ? "Accept watches both zones. Whichever side confirms first wins; the other plan is cancelled."
            : "Accept watches this zone until it confirms, fails or expires."}
        </p>
        {plans.map((plan) => <PlanBlock key={plan.id} plan={plan} watching={false} />)}
        <div className={styles.modes} role="radiogroup" aria-label="When a plan confirms">
          <label className={styles.mode}>
            <input type="radio" name={`plan-mode-${titleId}`} checked={mode === "NOTIFY"} onChange={() => setMode("NOTIFY")} />
            <span><strong>Alert me</strong><small>You place the trade yourself.</small></span>
          </label>
          <label className={styles.mode}>
            <input type="radio" name={`plan-mode-${titleId}`} checked={mode === "AUTO"} onChange={() => setMode("AUTO")} />
            <span><strong>GX places it</strong><small>OANDA practice account, after every check passes.</small></span>
          </label>
        </div>
        {state.actionError ? <p className={styles.error} role="alert">{state.actionError}</p> : null}
        <div className="nl-an-actions is-card">
          <button type="button" className="nl-an-secondary pressable" disabled={state.busy} onClick={state.dismiss}>Not now</button>
          <button type="button" className="nl-an-primary pressable" disabled={state.busy} onClick={() => state.accept(mode)}>
            {state.busy ? "Accepting…" : plans.length === 2 ? "Accept both" : "Accept"}
          </button>
        </div>
      </div>
    );
  }

  if (active.length) {
    return (
      <div className="nl-an-body">
        {top(`Watching · ${pair}`)}
        <h2 id={titleId} className="nl-an-decision">
          {active.some((plan) => plan.status === "NOTIFIED" || plan.status === "CONFIRMED") ? "A plan confirmed" : `Watching ${active.length === 2 ? "both zones" : "the zone"}`}
        </h2>
        <p className={styles.lede}>
          {active[0]!.monitoringMode === "AUTO" ? "GX places the trade on your practice account when a plan confirms." : "You get an alert when a plan confirms; the trade is yours to place."}
          {active.length === 2 ? " Whichever side confirms first cancels the other." : ""}
        </p>
        {active.map((plan) => <PlanBlock key={plan.id} plan={plan} watching />)}
        {state.actionError ? <p className={styles.error} role="alert">{state.actionError}</p> : null}
        <div className="nl-an-actions is-card">
          <button type="button" className="nl-an-secondary pressable" disabled={state.busy} onClick={state.stopWatching}>
            {state.busy ? "Stopping…" : "Stop watching"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="nl-an-body">
      {top("Analyze")}
      <h2 id={titleId} className="nl-an-decision">{phase.kind === "error" ? "Analysis failed" : "Analyze this market"}</h2>
      {phase.kind === "error" ? <p className={styles.error} role="alert">{phase.message}</p> : (
        <p className={styles.lede}>Get a BUY and a SELL plan for {pair}. Nothing is watched until you accept.</p>
      )}
      <div className="nl-an-actions is-card">
        {onNewEntry ? <button type="button" className="nl-an-secondary pressable" onClick={onNewEntry}>New entry</button> : null}
        <button type="button" className="nl-an-primary pressable" onClick={() => void state.run()}>
          {phase.kind === "error" ? "Try again" : "Analyze"}
        </button>
      </div>
    </div>
  );
}

/** Desktop: the first card in the chart's side column. */
export function PlanAnalyzeCard({ state, instrument, onNewEntry }: { state: PlanAnalyzeState; instrument: string; onNewEntry: () => void }) {
  return (
    <section className="nl-an-card" aria-labelledby="plan-analyze-card-title">
      <PlanAnalyzeBody state={state} instrument={instrument} titleId="plan-analyze-card-title" onNewEntry={onNewEntry} />
    </section>
  );
}

/** Phone: a bottom sheet over the dimmed chart; drag the grip to dismiss. */
export function PlanAnalyzeSheet({ state, instrument }: { state: PlanAnalyzeState; instrument: string }) {
  const { open } = state;
  const close = state.analyzing ? state.cancel : () => state.setOpen(false);
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({ open, onDismiss: close, handleSelector: ".nl-an-grip, .nl-an-top" });
  if (!open) return null;
  return createPortal(
    <div ref={setBackdrop} className="nl-an-backdrop" data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section ref={setSheet} className="nl-an-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-analyze-sheet-title" {...handlers}>
        <div className="nl-an-grip" aria-hidden="true" />
        <PlanAnalyzeBody state={state} instrument={instrument} titleId="plan-analyze-sheet-title" onClose={requestClose} />
      </section>
    </div>,
    document.body,
  );
}
