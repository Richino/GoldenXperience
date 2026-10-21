"use client";

import Link from "next/link";
import { useHomeSectionReady } from "@/components/dashboard/home-loading-boundary";
import { useEffect, useState } from "react";
import type { SwingView } from "@/lib/swing-intelligence";
import { displayNameFor } from "@/lib/instruments/catalog";
import { swingPlanStatus } from "@/lib/swing-plan-flow";
import { SWING_CHANGED, swingRead } from "@/lib/swing-api";

/** Lives inside Home's Plans section, alongside any previously saved plans. */
export function SwingPlanRows({ onCount }: { onCount(count: number): void }) {
  const [plans, setPlans] = useState<SwingView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [initialSettled, setInitialSettled] = useState(false);
  useHomeSectionReady("swing", initialSettled);
  useEffect(() => {
    let active = true, pending = false;
    let pollingActive = true, lastLoadedAt = 0;
    const load = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const result = await swingRead<{ plans: SwingView[] }>("/plans");
        pollingActive = result.plans.some(view => swingPlanStatus(view) === "Analyzing" || Boolean(view.acceptedPlan && view.monitor?.active));
        lastLoadedAt = Date.now();
        if (active) { setPlans(result.plans); onCount(result.plans.length); setError(null); }
      } catch { if (active) setError("Swing plans could not be loaded. Retrying…"); }
      finally { pending = false; if (active) setInitialSettled(true); }
    };
    void load();
    const timer = window.setInterval(() => {
      if (pollingActive || Date.now() - lastLoadedAt >= 60_000) void load();
    }, 10000);
    const changed = () => void load();
    window.addEventListener(SWING_CHANGED, changed);
    document.addEventListener("visibilitychange", changed);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(SWING_CHANGED, changed); document.removeEventListener("visibilitychange", changed); };
  }, [onCount]);
  return <>
    {plans.length ? <div className="nl-plan-list">{plans.map(view => {
      const status = swingPlanStatus(view), generating = status === "Analyzing";
      const href = `/chart?instrument=${encodeURIComponent(view.instrument)}&swing=review`;
      return <article key={view.instrument} className="nl-plan" data-kind={generating ? "generating" : "review"}>
        <Link href={href} className="nl-plan-head"><b>{displayNameFor(view.instrument)} <small>· Swing</small></b>
          <span className={`nl-plan-state ${generating ? "is-generating" : "is-review"}`}>{generating ? <span className="nl-plan-dot" aria-hidden="true" /> : null}{status}</span></Link>
        <p className="nl-plan-foot">{generating ? "Analysis is running. You can leave this page and check back here." : view.job?.error ?? view.assessment?.interpretation.swingOutlook ?? "Open the analysis to check its status."}</p>
        <div className="nl-plan-bottom"><span className="nl-plan-foot">{view.acceptedPlan ? `Saved ${view.acceptedPlan.scenario.side} plan` : "Review before accepting"}</span>
          <Link href={href} className="nl-plan-cta is-primary">{generating ? "View progress" : "Review result"}</Link></div>
      </article>;
    })}</div> : null}
    {error ? <p className="nl-card-empty is-warn" role="status">{error}</p> : null}
  </>;
}
