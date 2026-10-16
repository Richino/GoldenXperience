"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, CheckCircle2, Circle, X, XCircle } from "lucide-react";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import {
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
 *
 * The plans are drawn as a small price axis: the higher zone on top, the
 * live price as a line between them, so it reads like the chart.
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

/** What the setup is, in the trader's words. */
function setupName(plan: TradePlan) {
  const buy = plan.direction === "BUY";
  if (plan.setupType === "SR_REVERSAL") return buy ? "Bounce off support" : "Rejection at resistance";
  return buy ? "Break above, then retest" : "Break below, then retest";
}

/** What has to happen before the entry, in one line. */
function triggerLine(plan: TradePlan) {
  return plan.setupType === "SR_REVERSAL"
    ? `Enters after a rejection (or a sweep that is reclaimed) and an M15 break ${plan.direction === "BUY" ? "up" : "down"}.`
    : "Enters after an H1 close through the zone, a retest that holds, and an M15 continuation.";
}

/** Highest zone first, so the stack reads like the chart's price axis. */
const byZone = (plans: TradePlan[]) => [...plans].sort((a, b) => b.entryZoneHigh - a.entryZoneHigh);

function distance(plan: TradePlan, price: number | null) {
  if (price === null) return null;
  if (price >= plan.entryZoneLow && price <= plan.entryZoneHigh) return "in the zone";
  const above = plan.entryZoneLow > price;
  const pips = Math.round((above ? plan.entryZoneLow - price : price - plan.entryZoneHigh) / pipSizeFor(plan.instrument));
  return `${pips} pips ${above ? "above" : "below"}`;
}

export function PlanBlock({ plan, watching, price = null }: { plan: TradePlan; watching: boolean; price?: number | null }) {
  const digits = precisionFor(plan.instrument);
  const fmt = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
  const proposal = plan.monitorState?.proposal ?? null;
  const confirmed = plan.status === "CONFIRMED" || plan.status === "NOTIFIED";
  const away = distance(plan, price ?? plan.lastPrice);
  const met = plan.conditions.filter((item) => item.status === "PASSED").length;
  return (
    <section className={styles.plan} data-side={plan.direction} aria-label={`${plan.direction} plan`}>
      <header className={styles.planHead}>
        <span className={styles.side}>{plan.direction}</span>
        <span className={styles.setup}>{setupName(plan)}</span>
        <span className={styles.rr} title="Reward to risk">{plan.rewardRisk?.toFixed(1) ?? "—"}R</span>
      </header>
      <div className={styles.zoneRow}>
        <span className={styles.zone}>
          {fmt(plan.entryZoneLow)}<span aria-hidden="true"> – </span><span className="sr-only"> to </span>{fmt(plan.entryZoneHigh)}
        </span>
        {away ? <span className={styles.away}>{away}</span> : null}
      </div>
      <dl className={styles.levels}>
        <div><dt>Stop</dt><dd>{fmt(plan.stopLoss)}</dd></div>
        <div><dt>Target</dt><dd>{fmt(plan.takeProfit)}</dd></div>
      </dl>
      {watching && confirmed && proposal ? (
        <p className={styles.ready}>Confirmed. Enter near {fmt(proposal.entry)}.</p>
      ) : watching ? (
        <p className={styles.note}>
          {plan.monitorStage === "WAITING_FOR_ZONE"
            ? "Waiting for price to reach the zone."
            : plan.notTriggeredReason ?? `${STATUS_LABEL[plan.status]}. First check within a minute.`}
        </p>
      ) : (
        <p className={styles.note}>{triggerLine(plan)}</p>
      )}
      <details className={styles.details}>
        <summary>{watching ? `Conditions · ${met} of ${plan.conditions.length} met` : `Conditions (${plan.conditions.length})`}</summary>
        <ul className={styles.checks}>
          {plan.conditions.map((item) => (
            <li key={item.key}>
              <ConditionIcon status={item.status} />
              <span>{item.label}{item.detail ? <small>{item.detail}</small> : null}</span>
            </li>
          ))}
        </ul>
        {plan.plan.explanation?.[0] ? <p className={styles.fine}>{plan.plan.explanation[0]}</p> : null}
        {plan.plan.invalidation?.rules?.length ? <p className={styles.fine}>Cancelled if: {plan.plan.invalidation.rules.join(" ")}</p> : null}
        <p className={styles.fine}>Valid until {clock(plan.expiresAt)} · risk {plan.maxRiskPercent}%</p>
      </details>
    </section>
  );
}

/** The plans stacked like a price axis, with today's price as a line between the zones. */
function Ladder({ plans, price, watching }: { plans: TradePlan[]; price: number | null; watching: boolean }) {
  const ordered = byZone(plans);
  const now = price ?? plans.find((plan) => plan.lastPrice !== null)?.lastPrice ?? null;
  const digits = precisionFor(plans[0]!.instrument);
  // The price line sits under every zone that is above price.
  const split = now === null ? ordered.length : ordered.filter((plan) => plan.entryZoneLow > now).length;
  const line = (
    <div className={styles.now} key="now" aria-label={now === null ? "Live price unavailable" : `Price now ${now.toFixed(digits)}`}>
      <span className={styles.nowPrice}>{now === null ? "price —" : now.toFixed(digits)}</span>
    </div>
  );
  const blocks = ordered.map((plan) => <PlanBlock key={plan.id} plan={plan} watching={watching} price={now} />);
  return <div className={styles.ladder}>{[...blocks.slice(0, split), line, ...blocks.slice(split)]}</div>;
}

function ModeSwitch({ mode, onChange, name }: { mode: MonitoringMode; onChange: (mode: MonitoringMode) => void; name: string }) {
  return (
    <fieldset className={styles.modeField}>
      <legend className="sr-only">When a plan confirms</legend>
      <div className={styles.segmented}>
        {([["NOTIFY", "Alert me"], ["AUTO", "GX places it"]] as const).map(([value, label]) => (
          <label key={value} className={styles.segment}>
            <input type="radio" name={name} value={value} checked={mode === value} onChange={() => onChange(value)} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <p className={styles.modeHint}>
        {mode === "NOTIFY"
          ? "You get an alert with the entry, stop and target, and place the trade yourself."
          : "GX places the trade on your OANDA practice account once every check passes."}
      </p>
    </fieldset>
  );
}

function PlanAnalyzeBody({ state, instrument, price, titleId, onClose, onNewEntry }: {
  state: PlanAnalyzeState;
  instrument: string;
  price: number | null;
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
        {top(`Reading ${pair}…`)}
        <h2 id={titleId} className="sr-only">Analyzing {pair}</h2>
        <span className="nl-an-skel nl-an-skel-grid" />
        <span className="nl-an-skel nl-an-skel-line is-short" />
        <span className="nl-an-skel nl-an-skel-grid" />
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
          <h2 id={titleId} className={styles.quietTitle}>No setup worth watching right now</h2>
          <ul className={styles.rejected}>
            {result.rejected.map((item) => <li key={`${item.direction}-${item.setupType}`}><strong>{item.direction}</strong> {item.reason}</li>)}
          </ul>
          <div className={styles.footer}>
            <button type="button" className="nl-an-secondary pressable" onClick={state.dismiss}>Close</button>
          </div>
        </div>
      );
    }
    return (
      <div className="nl-an-body">
        {top(`Analyze · ${pair}`)}
        <h2 id={titleId} className="sr-only">{pair} plans</h2>
        <Ladder plans={plans} price={price} watching={false} />
        <ModeSwitch mode={mode} onChange={setMode} name={`plan-mode-${titleId}`} />
        {state.actionError ? <p className={styles.error} role="alert">{state.actionError}</p> : null}
        <div className={styles.footer}>
          <button type="button" className={`nl-an-primary pressable ${styles.accept}`} disabled={state.busy} onClick={() => state.accept(mode)}>
            {state.busy ? "Accepting…" : plans.length === 2 ? "Accept both" : "Accept"}
          </button>
          <button type="button" className={styles.textButton} disabled={state.busy} onClick={state.dismiss}>Not now</button>
        </div>
      </div>
    );
  }

  if (active.length) {
    const auto = active[0]!.monitoringMode === "AUTO";
    return (
      <div className="nl-an-body">
        {top(`Watching · ${pair}`)}
        <h2 id={titleId} className="sr-only">Watching {pair}</h2>
        <Ladder plans={active} price={price} watching />
        <p className={styles.footnote}>
          {auto ? "GX places the trade on your practice account when a plan confirms." : "You get an alert when a plan confirms."}
          {active.length === 2 ? " The first side to confirm cancels the other." : ""}
        </p>
        {state.actionError ? <p className={styles.error} role="alert">{state.actionError}</p> : null}
        <div className={styles.footer}>
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
export function PlanAnalyzeCard({ state, instrument, price = null, onNewEntry }: {
  state: PlanAnalyzeState;
  instrument: string;
  price?: number | null;
  onNewEntry: () => void;
}) {
  return (
    <section className="nl-an-card" aria-labelledby="plan-analyze-card-title">
      <PlanAnalyzeBody state={state} instrument={instrument} price={price} titleId="plan-analyze-card-title" onNewEntry={onNewEntry} />
    </section>
  );
}

/** Phone: a bottom sheet over the dimmed chart; drag the grip to dismiss. */
export function PlanAnalyzeSheet({ state, instrument, price = null }: { state: PlanAnalyzeState; instrument: string; price?: number | null }) {
  const { open } = state;
  const close = state.analyzing ? state.cancel : () => state.setOpen(false);
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({ open, onDismiss: close, handleSelector: ".nl-an-grip, .nl-an-top" });
  if (!open) return null;
  return createPortal(
    <div ref={setBackdrop} className="nl-an-backdrop" data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section ref={setSheet} className="nl-an-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-analyze-sheet-title" {...handlers}>
        <div className="nl-an-grip" aria-hidden="true" />
        <PlanAnalyzeBody state={state} instrument={instrument} price={price} titleId="plan-analyze-sheet-title" onClose={requestClose} />
      </section>
    </div>,
    document.body,
  );
}
