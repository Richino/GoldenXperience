"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Eye, LoaderCircle, Radar } from "lucide-react";
import { PlanAnalyzeSheet, usePlanAnalyze } from "@/components/trade-plans/plan-analyze";
import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/use-toast";
import { displayNameFor } from "@/lib/instruments/catalog";
import { JOB_RUNNING, tradePlansApi, type ResearchJob, type TradePlan } from "@/lib/trade-plans/api";

/**
 * Markets: Analyze runs the same research-first flow as the chart. A pair
 * that already has a setup (research running, plans to review, or plans being
 * watched) shows a badge instead, and tapping it opens that pair's Analyze
 * sheet right here, so a second setup is never started over the first.
 */

const PLANS_CHANGED = "gx-trade-plans-changed";
export type PairSetup = "generating" | "review" | "watching";

/** Which pairs already have a setup. Polls, and refreshes whenever a plan changes. */
export function usePairSetups() {
  const [setups, setSetups] = useState<Record<string, PairSetup>>({});
  const refresh = useCallback(async () => {
    const [jobs, awaiting, active] = await Promise.all([
      tradePlansApi.researchJobs().then((result) => result.jobs).catch(() => [] as ResearchJob[]),
      tradePlansApi.list("awaiting").catch(() => [] as TradePlan[]),
      tradePlansApi.list("active").catch(() => [] as TradePlan[]),
    ]);
    const next: Record<string, PairSetup> = {};
    for (const plan of active) next[plan.instrument] = "watching";
    for (const plan of awaiting) next[plan.instrument] = "review";
    const latest = new Map<string, ResearchJob>();
    for (const job of jobs) if (!latest.has(job.instrument)) latest.set(job.instrument, job);
    for (const [instrument, job] of latest) {
      if (JOB_RUNNING.includes(job.status) || (job.status === "COMPLETED" && !job.plans)) next[instrument] = "generating";
    }
    setSetups(next);
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 10_000);
    const changed = () => void refresh();
    window.addEventListener(PLANS_CHANGED, changed);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener(PLANS_CHANGED, changed); };
  }, [refresh]);
  return { setups, refresh };
}

/** Start research for a pair: spinner at once, a toast that says what happened, never two runs. */
export function useMarketAnalyze(refresh: () => Promise<void>, openSheet: (instrument: string) => void) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const inFlight = useRef(new Set<string>());
  const start = useCallback(async (instrument: string) => {
    if (inFlight.current.has(instrument)) return;
    inFlight.current.add(instrument);
    setBusy((current) => ({ ...current, [instrument]: true }));
    const pair = displayNameFor(instrument);
    const view = <ToastAction altText={`View ${pair}`} onClick={() => openSheet(instrument)}>View</ToastAction>;
    const note = toast({ title: `Analyzing ${pair}…`, description: "Checking for research and plans." });
    try {
      const result = await tradePlansApi.refreshResearch(instrument);
      if (result.state === "started") {
        note.update({ id: note.id, open: true, title: `${pair} research started`, description: "GX is researching in the background. We'll notify you when the plans are ready.", action: view });
      } else if (result.state === "joined") {
        note.update({ id: note.id, open: true, title: `${pair} research already running`, description: "No second run was started. You'll be notified when it's ready.", action: view });
      } else if (result.state === "budget") {
        note.update({ id: note.id, open: true, title: `${pair}: research not started`, description: `${result.budget ?? "The research budget is used up."} No plans were built.`, tone: "is-down" });
      } else if (result.state === "unconfigured") {
        note.update({ id: note.id, open: true, title: `${pair}: research unavailable`, description: "Research is not configured on the server.", tone: "is-down" });
      } else {
        // Fresh research already exists: build the plans from it now.
        const plans = await tradePlansApi.generate(instrument);
        note.update(plans.plans.length
          ? { id: note.id, open: true, title: `${pair} plans ready`, description: "Your BUY and SELL plans are ready to review.", action: view }
          : { id: note.id, open: true, title: `${pair}: no setup right now`, description: plans.reason ?? "No setup met the trading rules.", action: view });
      }
    } catch (error) {
      note.update({ id: note.id, open: true, title: `${pair}: couldn't analyze`, description: error instanceof Error ? error.message : "Try again in a moment.", tone: "is-down" });
    } finally {
      inFlight.current.delete(instrument);
      setBusy((current) => ({ ...current, [instrument]: false }));
      await refresh();
      window.dispatchEvent(new Event(PLANS_CHANGED));
    }
  }, [openSheet, refresh]);
  return { busy, start };
}

const SETUP_LABEL: Record<PairSetup, string> = { generating: "Generating", review: "Review", watching: "Watching" };

export function MarketAnalyzeButton({ instrument, setup, busy, onAnalyze, onOpen }: {
  instrument: string;
  setup: PairSetup | undefined;
  busy: boolean;
  onAnalyze: (instrument: string) => void;
  onOpen: (instrument: string) => void;
}) {
  const name = displayNameFor(instrument);
  if (setup) {
    return (
      <button
        type="button"
        className="nl-mk-analyze pressable has-setup"
        data-setup={setup}
        onClick={() => onOpen(instrument)}
        aria-label={`${name}: ${SETUP_LABEL[setup].toLowerCase()} — open its plans`}
        title={`Open ${name} · ${SETUP_LABEL[setup]}`}
      >
        {setup === "generating" ? <LoaderCircle className="nl-mk-analyze-icon animate-spin" aria-hidden="true" />
          : setup === "review" ? <CheckCircle2 className="nl-mk-analyze-icon" aria-hidden="true" />
            : <Eye className="nl-mk-analyze-icon" aria-hidden="true" />}
        <span className="nl-mk-analyze-label">{SETUP_LABEL[setup]}</span>
        <span className="nl-mk-setup-badge" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`nl-mk-analyze pressable${busy ? " is-busy" : ""}`}
      disabled={busy}
      onClick={() => onAnalyze(instrument)}
      aria-label={`Analyze ${name}`}
      aria-busy={busy}
      title={`Analyze ${name}: research, then BUY and SELL plans`}
    >
      {busy ? <LoaderCircle className="nl-mk-analyze-icon animate-spin" aria-hidden="true" /> : <Radar className="nl-mk-analyze-icon" aria-hidden="true" />}
      <span className="nl-mk-analyze-label">{busy ? "Starting…" : "Analyze"}</span>
    </button>
  );
}

/** The pair's Analyze sheet, opened in place on Markets. */
export function MarketAnalyzeSheet({ instrument, onClose }: { instrument: string | null; onClose: () => void }) {
  const state = usePlanAnalyze(instrument ?? "EUR_USD", !instrument);
  const { review, open } = state;
  const shown = useRef(false);
  useEffect(() => {
    if (!instrument) return;
    shown.current = false;
    // After the hook has reset for this pair: open on the skeleton, then its plans or research.
    const timer = window.setTimeout(() => review(), 0);
    return () => window.clearTimeout(timer);
  }, [instrument, review]);
  useEffect(() => {
    if (open) shown.current = true;
    else if (shown.current) { shown.current = false; onClose(); }
  }, [open, onClose]);
  if (!instrument) return null;
  return <PlanAnalyzeSheet state={state} instrument={instrument} price={null} />;
}
