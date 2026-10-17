"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { Ban, CheckCircle2, Circle, X, XCircle } from "lucide-react";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { toast } from "@/hooks/use-toast";
import {
  JOB_RUNNING,
  STATUS_LABEL,
  tradePlansApi,
  type ConditionStatus,
  type GenerateResult,
  type MarketIntelligence,
  type MonitoringMode,
  type TradePlan,
} from "@/lib/trade-plans/api";
import styles from "./plan-analyze.module.css";
import { MarketRead, PlanEvidence, type ResearchState } from "./market-read";

/**
 * The chart's Analyze (swing trades, 2–5 day holds): one press reads D1/H4/H1 and returns a BUY and a
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
  /** Research is running on the server; plans are built once it finishes. */
  | { kind: "researching" }
  | { kind: "results"; result: GenerateResult }
  | { kind: "error"; message: string };

export function usePlanAnalyze(instrument: string, disabled = false) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [active, setActive] = useState<TradePlan[]>([]);
  /** Plans built for this pair and waiting for your review. */
  const [awaitingCount, setAwaitingCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [research, setResearch] = useState<ResearchState>({ loading: false, result: null, error: null });
  const request = useRef(0);
  const researchRequest = useRef(0);
  const phaseKind = useRef<Phase["kind"]>("idle");
  useEffect(() => { phaseKind.current = phase.kind; }, [phase.kind]);

  /**
   * Start (or join) background research for the pair. The server returns at
   * once; the research runs there and survives leaving the page or closing
   * GX. The user is told it started and notified when it is done.
   */
  const runResearch = useCallback(async (force = false) => {
    const id = ++researchRequest.current;
    setResearch((current) => ({ ...current, loading: true, error: null }));
    try {
      const result = await tradePlansApi.refreshResearch(instrument, force);
      if (id !== researchRequest.current) return null;
      const pair = displayNameFor(instrument);
      if (result.state === "started") {
        toast({ title: `${pair} research started`, description: "We'll notify you when your analysis is ready. Keep using GX or close it — the research runs on the server." });
      } else if (result.state === "joined") {
        toast({ title: `${pair} research already running`, description: "You'll be notified when it's ready. No second research run was started." });
      }
      setResearch({ loading: false, result, error: result.budget ?? null });
      return result;
    } catch (error) {
      if (id === researchRequest.current) setResearch((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Research could not be started." }));
      return null;
    }
  }, [instrument]);

  /** Show the plans awaiting review for this pair. `force` replaces an "analyzing" placeholder too. */
  const loadAwaiting = useCallback(async (force = false) => {
    const plans = await tradePlansApi.list("awaiting", instrument).catch(() => null);
    if (!plans) return false;
    const latest = plans[0] ? plans.filter((plan) => plan.analysisId === plans[0]!.analysisId) : [];
    if (!latest.length) return false;
    setPhase((current) => (current.kind === "analyzing" && !force ? current : { kind: "results", result: { analysisId: latest[0]!.analysisId, plans: latest, result: "PLANS", reason: null, planIds: latest.map((plan) => plan.id), rejected: [] } }));
    return true;
  }, [instrument]);

  /** A research job ended: show the plans it built, why there are none, or why research failed. */
  const settleJob = useCallback(async (jobId: string) => {
    const found = await tradePlansApi.researchJob(jobId).catch(() => null);
    if (!found) return; // A transient read failure is retried by the poll.
    const job = found?.job;
    if (!job) {
      if (!(await loadAwaiting(true))) setPhase({ kind: "error", message: "This research run is no longer linked to your plans. Run Analyze to use the latest report." });
      return;
    }
    if (JOB_RUNNING.includes(job.status)) return;
    if (job.status !== "COMPLETED") {
      setPhase({ kind: "error", message: `Research did not finish: ${job.error ?? job.status.toLowerCase()}. No plans were built. You can try again.` });
      return;
    }
    // Completed: the plans are built right after the report is stored.
    if (!job.plans) return;
    if (job.plans.result === "PLANS" && (await loadAwaiting(true))) return;
    if (job.plans.result === "NO_VALID_SETUP") {
      setPhase({ kind: "results", result: { analysisId: job.id, plans: [], planIds: [], result: "NO_VALID_SETUP", reason: job.plans.reason, rejected: [] } });
      return;
    }
    if (job.plans.result === "WATCHING") { setPhase({ kind: "idle" }); return; }
    setPhase({ kind: "error", message: job.plans.reason ?? "Research finished, but the plans could not be built. Try again." });
  }, [loadAwaiting]);

  // While research runs (or Analyze waits for its plans), refresh what Analyze shows.
  // Display only: the job itself never depends on this page being open.
  const jobRunning = Boolean(research.result?.job && JOB_RUNNING.includes(research.result.job.status));
  const watchJob = jobRunning || phase.kind === "researching";
  useEffect(() => {
    if (!watchJob) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void tradePlansApi.research(instrument).then((next) => {
        if (stopped) return;
        setResearch((current) => ({ ...current, result: { ...next, state: current.result?.state } }));
        if (phaseKind.current === "researching" && next.job && !JOB_RUNNING.includes(next.job.status)) void settleJob(next.job.id);
        if (phaseKind.current === "researching" && !next.job) setPhase({ kind: "error", message: "The research run is no longer available. You can try Analyze again." });
      }).catch(() => undefined);
    }, 5_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [instrument, settleJob, watchJob]);

  const cancelResearch = useCallback(async () => {
    const job = research.result?.job;
    if (!job || !JOB_RUNNING.includes(job.status)) return;
    await tradePlansApi.cancelResearch(job.id).catch(() => undefined);
    const next = await tradePlansApi.research(instrument).catch(() => null);
    if (next) setResearch((current) => ({ ...current, result: next }));
    setPhase((current) => (current.kind === "researching" ? { kind: "error", message: "Research cancelled. No plans were built." } : current));
  }, [instrument, research.result?.job]);

  const refreshActive = useCallback(async () => {
    try {
      const [watching, waiting] = await Promise.all([tradePlansApi.list("active", instrument), tradePlansApi.list("awaiting", instrument)]);
      setActive(watching);
      setAwaitingCount(waiting.length);
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, [instrument]);

  useEffect(() => {
    request.current += 1;
    setPhase({ kind: "idle" });
    setOpen(false);
    setActionError(null);
    researchRequest.current += 1;
    setResearch({ loading: false, result: null, error: null });
    // Cached research only; nothing is researched until Analyze is pressed.
    void tradePlansApi.research(instrument).then((result) => setResearch((current) => (current.result ? current : { ...current, result }))).catch(() => undefined);
    void refreshActive();
    const timer = window.setInterval(() => void refreshActive(), 20_000);
    const changed = () => void refreshActive();
    window.addEventListener(TRADE_PLANS_CHANGED, changed);
    return () => { window.clearInterval(timer); window.removeEventListener(TRADE_PLANS_CHANGED, changed); };
  }, [instrument, refreshActive]);

  /**
   * Analyze, research first: fresh research → plans now (built once, from it
   * and fresh candles); otherwise a background research job starts and the
   * plans are built when it finishes. No preliminary plans are made.
   */
  const run = useCallback(async () => {
    if (disabled) return;
    setOpen(true);
    setActionError(null);
    // Plans already being watched: show them. Research may refresh their evidence; it never rebuilds them.
    if (active.length) { setPhase({ kind: "idle" }); void runResearch(); return; }
    const id = ++request.current;
    setPhase({ kind: "analyzing" });
    // Plans already built for this pair and waiting for you: open them instead of researching again.
    if (await loadAwaiting(true)) return;
    if (id !== request.current) return;
    // The request endpoint joins an existing run AND registers this user as a
    // watcher. Merely displaying a scheduled/other user's job left Analyze
    // waiting forever for plans that were never requested for this user.
    const started = await runResearch();
    if (id !== request.current) return;
    if (!started) { setPhase({ kind: "error", message: "Research could not be started. No plans were built." }); return; }
    if (started.state === "started" || started.state === "joined") { setPhase({ kind: "researching" }); return; }
    if (started.state === "budget") { setPhase({ kind: "error", message: `${started.budget ?? "The research budget is used up."} No plans were built.` }); return; }
    if (started.state === "unconfigured") { setPhase({ kind: "error", message: "Research is not configured on the server, so no plans can be built." }); return; }
    // Fresh research already exists: build the plans from it now.
    try {
      const result = await tradePlansApi.generate(instrument);
      if (id === request.current) setPhase({ kind: "results", result });
    } catch (error) {
      if (id === request.current) setPhase({ kind: "error", message: error instanceof Error ? error.message : "Analysis failed." });
    }
  }, [active.length, disabled, instrument, loadAwaiting, runResearch]);

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

  /** Accept both plans, or only one side (the other is declined). Each keeps its own rules. */
  const accept = (mode: MonitoringMode, only?: "BUY" | "SELL") => {
    if (phase.kind !== "results") return;
    const { result } = phase;
    const chosen = only ? result.plans.filter((plan) => plan.direction === only) : result.plans;
    if (!chosen.length) return;
    void act(() => tradePlansApi.accept(result.analysisId, mode, chosen), () => setPhase({ kind: "idle" }));
  };
  /** Not now: reject the offered plans so nothing lingers awaiting approval. */
  const dismiss = () => {
    if (phase.kind !== "results" || !phase.result.plans.length) { setPhase({ kind: "idle" }); setOpen(false); return; }
    const plans = phase.result.plans;
    void act(() => Promise.all(plans.map((plan) => tradePlansApi.reject(plan.id, "Not now"))), () => { setPhase({ kind: "idle" }); setOpen(false); });
  };
  const stopWatching = () => {
    // Trades being placed or already open are left alone; stopping only ends the watching.
    const live = active.filter((plan) => ["APPROVED", "MONITORING", "CONFIRMED", "NOTIFIED"].includes(plan.status));
    void act(() => Promise.all(live.map((plan) => tradePlansApi.cancel(plan.id, "Stopped watching from Analyze"))), () => setOpen(false));
  };
  const cancel = () => { request.current += 1; setPhase({ kind: "idle" }); setOpen(false); };
  /** Open Analyze on the latest report and its plans (the research notification links here). */
  const review = useCallback(() => {
    // Open on the loading skeleton, then straight to the plans: never the empty Analyze sheet first.
    const id = ++request.current;
    setPhase({ kind: "analyzing" });
    setOpen(true);
    const settled = () => setPhase((current) => (current.kind === "analyzing" && id === request.current ? { kind: "idle" } : current));
    void (async () => {
      if (await loadAwaiting(true)) return;
      const result = await tradePlansApi.research(instrument).catch(() => null);
      if (id !== request.current) return;
      if (result) setResearch((current) => ({ ...current, result }));
      if (result?.job && JOB_RUNNING.includes(result.job.status)) {
        const joined = await runResearch();
        if (id !== request.current) return;
        if (joined?.running) setPhase({ kind: "researching" });
        else if (!joined) setPhase({ kind: "error", message: "Research could not be joined. Please try Analyze again." });
        else settled();
        return;
      }
      if (result?.job) await settleJob(result.job.id);
      settled();
    })();
  }, [instrument, loadAwaiting, runResearch, settleJob]);

  // What the chart's Analyze button opens: research in progress, plans to review, plans being watched, or a new analysis.
  const status: "generating" | "review" | "watching" | "new" =
    jobRunning || phase.kind === "researching" ? "generating" : awaitingCount > 0 || (phase.kind === "results" && phase.result.plans.length > 0) ? "review" : active.length ? "watching" : "new";
  return { phase, active, status, open, setOpen, busy, actionError, run, accept, dismiss, stopWatching, cancel, analyzing: phase.kind === "analyzing", research, refreshResearch: () => void runResearch(true), cancelResearch: () => void cancelResearch(), review };
}

export type PlanAnalyzeState = ReturnType<typeof usePlanAnalyze>;

const clock = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

const THESIS_WORD: Record<NonNullable<TradePlan["thesisUpdate"]>["assessment"], string> = {
  STRENGTHENING: "strengthening", WEAKENING: "weakening", UNCHANGED: "unchanged", CONFLICTED: "conflicted", OUTDATED: "out of date",
};

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
  // Timeframes come from the plan itself: H4/H1 for swing plans, H1/M15 for plans made before swing mode.
  const rules = (plan.plan.rules ?? {}) as Record<string, unknown>;
  const tf = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  return plan.setupType === "SR_REVERSAL"
    ? `Enters after a rejection (or a sweep that is reclaimed) and an ${tf(rules.confirmTimeframe, "M15")} break ${plan.direction === "BUY" ? "up" : "down"}.`
    : `Enters after an ${tf(rules.breakoutTimeframe, "H1")} close through the zone, a retest that holds, and an ${tf(rules.retestTimeframe, "M15")} continuation.`;
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

export function PlanBlock({ plan, watching, price = null, report = null }: { plan: TradePlan; watching: boolean; price?: number | null; report?: MarketIntelligence | null }) {
  const digits = precisionFor(plan.instrument);
  const fmt = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
  const proposal = plan.monitorState?.proposal ?? null;
  const progress = plan.monitorState?.progress ?? null;
  const safety = plan.monitorState?.safety ?? null;
  const confirmed = plan.status === "CONFIRMED" || plan.status === "NOTIFIED";
  const away = distance(plan, price ?? plan.lastPrice);
  const met = plan.conditions.filter((item) => item.status === "PASSED").length;
  // Risk and reward from the middle of the zone, drawn to scale.
  const mid = (plan.entryZoneLow + plan.entryZoneHigh) / 2;
  const risk = plan.stopLoss === null ? 0 : Math.abs(mid - plan.stopLoss);
  const reward = plan.takeProfit === null ? 0 : Math.abs(plan.takeProfit - mid);
  return (
    <section className={styles.plan} data-side={plan.direction} aria-label={`${plan.direction} plan`}>
      <header className={styles.planHead}>
        <span className={styles.side}>{plan.direction}</span>
        <span className={styles.setup}>{setupName(plan)}</span>
        {away ? <span className={styles.away}>{away}</span> : null}
      </header>
      <div className={styles.zoneRow}>
        <span className={styles.zone}>
          {fmt(plan.entryZoneLow)}<span className={styles.dash} aria-hidden="true">–</span><span className="sr-only"> to </span>{fmt(plan.entryZoneHigh)}
        </span>
        <span className={styles.rr} title="Reward to risk">{plan.rewardRisk?.toFixed(1) ?? "—"}<small>R</small></span>
      </div>
      {risk > 0 && reward > 0 ? (
        <div className={styles.bar} aria-hidden="true">
          {/* Grow values must sum to at least 1 or flex leaves the rest empty. */}
          <span className={styles.barRisk} style={{ flexGrow: risk / (risk + reward) }} />
          <span className={styles.barReward} style={{ flexGrow: reward / (risk + reward) }} />
        </div>
      ) : null}
      <dl className={styles.levels}>
        <div><dt>Stop</dt><dd>{fmt(plan.stopLoss)}</dd></div>
        <div><dt>Target</dt><dd>{fmt(plan.takeProfit)}</dd></div>
      </dl>
      {watching && plan.status === "FILLED" ? (
        <p className={styles.ready}>In the trade (Auto trade). OANDA holds the stop and target.</p>
      ) : watching && (plan.status === "EXECUTION_PENDING" || plan.status === "ORDER_SUBMITTED" || plan.status === "PARTIALLY_FILLED") ? (
        <p className={styles.ready}>Confirmed. Placing the order on your practice account…</p>
      ) : watching && confirmed && proposal ? (
        <p className={styles.ready}>
          Confirmed. Enter near {fmt(proposal.entry)}.
          {safety && !safety.ok ? <small className={styles.blocked}> An order can&apos;t go in right now: {safety.blocks.join(" ")}</small> : null}
        </p>
      ) : watching ? (
        <p className={styles.note}>
          {plan.monitorStage === "WAITING_FOR_ZONE"
            ? "Waiting for price to reach the zone."
            : plan.notTriggeredReason ?? `${STATUS_LABEL[plan.status]}. First check within a minute.`}
        </p>
      ) : (
        <p className={styles.note}>{triggerLine(plan)}</p>
      )}
      {watching ? (
        <ul className={styles.progress}>
          {progress?.window ? <li>{progress.window.limit - progress.window.used} of {progress.window.limit} candles left for the {progress.window.window}</li> : null}
          {progress?.maxAttempts ? <li>Attempt {progress.attempt} of {progress.maxAttempts}</li> : null}
          <li>Ends {clock(plan.expiresAt)} if not triggered</li>
          {plan.latestEvent ? <li>Last: {plan.latestEvent.reason ?? plan.latestEvent.type.toLowerCase().replace(/_/g, " ")} ({clock(plan.latestEvent.at)})</li> : null}
        </ul>
      ) : null}
      {watching && plan.thesisUpdate && plan.thesisUpdate.assessment !== "UNCHANGED" ? (
        <p className={styles.thesis} data-assessment={plan.thesisUpdate.assessment}>
          <strong>Evidence {THESIS_WORD[plan.thesisUpdate.assessment]}</strong> {plan.thesisUpdate.summary} <small>Research never changes the plan&apos;s rules.</small>
        </p>
      ) : null}
      <PlanEvidence plan={plan} intel={report} />
      <details className={styles.details}>
        <summary>
          <span>Conditions</span>
          <span className={styles.count}>{watching ? `${met} of ${plan.conditions.length} met` : `${plan.conditions.length} steps`}</span>
        </summary>
        <ol className={styles.checks}>
          {plan.conditions.map((item) => (
            <li key={item.key} data-status={item.status}>
              <ConditionIcon status={item.status} />
              <span>{item.label}{item.detail ? <small>{item.detail}</small> : null}</span>
            </li>
          ))}
        </ol>
        <dl className={styles.facts}>
          {plan.plan.explanation?.[0] ? <div><dt>Why this zone</dt><dd>{plan.plan.explanation[0]}</dd></div> : null}
          {plan.plan.invalidation?.rules?.length ? (
            <div>
              <dt>Cancelled if</dt>
              <dd><ul>{plan.plan.invalidation.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul></dd>
            </div>
          ) : null}
          {typeof plan.plan.maxHoldTradingDays === "number" ? <div><dt>Hold</dt><dd>Up to {plan.plan.maxHoldTradingDays} trading days once you are in</dd></div> : null}
          <div><dt>Watching until</dt><dd>{clock(plan.expiresAt)} · risks {plan.maxRiskPercent}% of the account</dd></div>
        </dl>
      </details>
    </section>
  );
}

/** The plans stacked like a price axis, with today's price as a line between the zones. */
function Ladder({ plans, price, watching, report = null }: { plans: TradePlan[]; price: number | null; watching: boolean; report?: MarketIntelligence | null }) {
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
  const blocks = ordered.map((plan) => <PlanBlock key={plan.id} plan={plan} watching={watching} price={now} report={report} />);
  return <div className={styles.ladder}>{[...blocks.slice(0, split), line, ...blocks.slice(split)]}</div>;
}

function ModeSwitch({ mode, onChange, name }: { mode: MonitoringMode; onChange: (mode: MonitoringMode) => void; name: string }) {
  return (
    <fieldset className={styles.modeField}>
      <legend className="sr-only">When a plan confirms</legend>
      <div className={styles.segmented}>
        {([["NOTIFY", "Alert me"], ["AUTO", "Auto trade"]] as const).map(([value, label]) => (
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
        {top(`Analyze · ${pair}`)}
        <h2 id={titleId} className="sr-only">Loading {pair}</h2>
        <span className="nl-an-skel nl-an-skel-grid" />
        <span className="nl-an-skel nl-an-skel-line is-short" />
        <span className="nl-an-skel nl-an-skel-grid" />
      </div>
    );
  }

  if (phase.kind === "researching") {
    return (
      <div className="nl-an-body">
        {top(`Researching · ${pair}`)}
        <div className="nl-an-scroll">
          <h2 id={titleId} className={styles.quietTitle}>Researching {pair} first</h2>
          <p className={styles.lede}>When the research is checked and stored, GX reads fresh prices and builds the BUY and SELL plans once. You&apos;ll be notified; you can leave this page or close GX.</p>
          <MarketRead state={state.research} onRefresh={state.refreshResearch} onCancel={state.cancelResearch} />
        </div>
        <div className={styles.dock}>
          <div className={styles.footer}>
            <button type="button" className="nl-an-secondary pressable" onClick={() => state.setOpen(false)}>Close</button>
          </div>
        </div>
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
          <div className="nl-an-scroll">
            <h2 id={titleId} className={styles.quietTitle}>No setup worth watching right now</h2>
            {result.rejected.length ? (
              <ul className={styles.rejected}>
                {result.rejected.map((item) => <li key={`${item.direction}-${item.setupType}`}><strong>{item.direction}</strong> {item.reason}</li>)}
              </ul>
            ) : result.reason ? <p className={styles.lede}>{result.reason}</p> : null}
            {/* No setup to trade, but the market context is still worth reading. */}
            <MarketRead state={state.research} onRefresh={state.refreshResearch} onCancel={state.cancelResearch} />
          </div>
          <div className={styles.dock}>
            <div className={styles.footer}>
              <button type="button" className="nl-an-secondary pressable" onClick={state.dismiss}>Close</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="nl-an-body">
        {top(`Analyze · ${pair}`)}
        <h2 id={titleId} className="sr-only">{pair} plans</h2>
        {/* Only the plans scroll; the mode choice and the buttons stay pinned under them. */}
        <div className="nl-an-scroll">
          <MarketRead state={state.research} onRefresh={state.refreshResearch} onCancel={state.cancelResearch} />
          <Ladder plans={plans} price={price} watching={false} report={state.research.result?.research?.report?.schemaVersion ? state.research.result.research.report : null} />
        </div>
        <div className={styles.dock}>
          <ModeSwitch mode={mode} onChange={setMode} name={`plan-mode-${titleId}`} />
          {state.actionError ? (
            <p className={styles.error} role="alert">
              {state.actionError}
              {mode === "AUTO" && /Settings/.test(state.actionError) ? <> <Link href="/settings#auto-trade" className={styles.errorLink}>Open Settings</Link></> : null}
            </p>
          ) : null}
          <div className={styles.footer}>
            <button type="button" className={`nl-an-primary pressable ${styles.accept}`} disabled={state.busy} onClick={() => state.accept(mode)}>
              {state.busy ? "Accepting…" : "Accept"}
            </button>
            <button type="button" className={styles.textButton} disabled={state.busy} onClick={state.dismiss}>Not now</button>
          </div>
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
        <div className="nl-an-scroll">
          <MarketRead state={state.research} onRefresh={state.refreshResearch} onCancel={state.cancelResearch} />
          <Ladder plans={active} price={price} watching report={state.research.result?.research?.report?.schemaVersion ? state.research.result.research.report : null} />
          <p className={styles.footnote}>
            {auto ? "GX places the trade on your practice account when a plan confirms and the safety checks pass." : "You get one alert when a plan's approved conditions are met."}
            {active.length === 2 ? (auto ? " Each side keeps its own rules; once one is filled, the other is cancelled." : " Each side keeps its own rules; an alert on one does not cancel the other.") : ""}
          </p>
        </div>
        <div className={styles.dock}>
          {state.actionError ? <p className={styles.error} role="alert">{state.actionError}</p> : null}
          <div className={styles.footer}>
            <button type="button" className={`nl-an-secondary pressable ${styles.stop}`} disabled={state.busy} onClick={state.stopWatching}>
              {state.busy ? "Stopping…" : "Stop watching"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nl-an-body">
      {top("Analyze")}
      <h2 id={titleId} className="nl-an-decision">{phase.kind === "error" ? "Analysis failed" : "Analyze this market"}</h2>
      {phase.kind === "error" ? <p className={styles.error} role="alert">{phase.message}</p> : (
        <p className={styles.lede}>Get swing plans for {pair}, held 2–5 days: a BUY and a SELL. Nothing is watched until you accept.</p>
      )}
      <div className="nl-an-actions is-card">
        {onNewEntry ? <button type="button" className="nl-an-secondary pressable" onClick={onNewEntry}>New entry</button> : null}
        <button type="button" className="nl-an-primary pressable" onClick={() => void state.run()}>
          {phase.kind === "error" ? "Try again" : state.status === "generating" ? "Generating…" : state.status === "review" ? "Review plans" : "Analyze"}
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
