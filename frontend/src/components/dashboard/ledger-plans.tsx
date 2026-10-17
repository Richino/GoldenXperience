"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { JOB_RUNNING, STATUS_LABEL, tradePlansApi, type ResearchJob, type TradePlan } from "@/lib/trade-plans/api";

/**
 * Home: your trade plans, beside Pending and Open positions. A pair you
 * pressed Analyze on shows as Generating while its research runs and the
 * plans are built; then its plans appear here to review; accepted plans stay
 * here while GX watches them. Everything links to that pair's Analyze.
 */

const PLANS_CHANGED = "gx-trade-plans-changed";
const DONE_FAILED: ResearchJob["status"][] = ["FAILED", "EXPIRED", "CANCELLED"];
const JOB_WORD: Record<ResearchJob["status"], string> = {
  QUEUED: "Queued", RESEARCHING: "Researching the market", VALIDATING: "Checking the research", COMPLETED: "Building the plans",
  FAILED: "Failed", CANCELLED: "Cancelled", EXPIRED: "Expired",
};

type Row =
  | { kind: "generating"; instrument: string; job: ResearchJob }
  | { kind: "failed"; instrument: string; job: ResearchJob }
  | { kind: "review"; instrument: string; plans: TradePlan[] }
  | { kind: "watching"; instrument: string; plans: TradePlan[] };

function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** One row per pair, most urgent first: generating, ready to review, watching, then a recent failure. */
export function planRows(jobs: ResearchJob[], awaiting: TradePlan[], active: TradePlan[], now = Date.now()): Row[] {
  const latestJob = new Map<string, ResearchJob>();
  for (const job of jobs) if (!latestJob.has(job.instrument)) latestJob.set(job.instrument, job);
  const byPair = (plans: TradePlan[]) => {
    const groups = new Map<string, TradePlan[]>();
    for (const plan of plans) groups.set(plan.instrument, [...(groups.get(plan.instrument) ?? []), plan]);
    return groups;
  };
  const review = byPair(awaiting);
  const watching = byPair(active);
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const [instrument, job] of latestJob) {
    // Still researching, or researched and the plans are being built right now.
    if (JOB_RUNNING.includes(job.status) || (job.status === "COMPLETED" && !job.plans)) {
      rows.push({ kind: "generating", instrument, job });
      seen.add(instrument);
    }
  }
  for (const [instrument, plans] of review) {
    if (seen.has(instrument)) continue;
    const analysis = plans[0]!.analysisId;
    rows.push({ kind: "review", instrument, plans: plans.filter((plan) => plan.analysisId === analysis) });
    seen.add(instrument);
  }
  for (const [instrument, plans] of watching) {
    rows.push({ kind: "watching", instrument, plans });
    seen.add(instrument);
  }
  for (const [instrument, job] of latestJob) {
    const recent = now - Date.parse(job.completedAt ?? job.createdAt) < 6 * 3_600_000;
    if (!seen.has(instrument) && DONE_FAILED.includes(job.status) && recent) rows.push({ kind: "failed", instrument, job });
  }
  return rows;
}

function Zones({ plans }: { plans: TradePlan[] }) {
  return (
    <ul className="nl-plan-sides">
      {[...plans].sort((a, b) => b.entryZoneHigh - a.entryZoneHigh).map((plan) => {
        const digits = precisionFor(plan.instrument);
        const f = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
        return (
          <li key={plan.id}>
            <span className={`nl-side ${plan.direction === "BUY" ? "is-up" : "is-down"}`}>{plan.direction}</span>
            <span className="metric-number">{f(plan.entryZoneLow)}–{f(plan.entryZoneHigh)}</span>
            <span className="nl-plan-sl metric-number">SL {f(plan.stopLoss)} · TP {f(plan.takeProfit)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function LedgerPlans() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [jobs, awaiting, active] = await Promise.all([
        tradePlansApi.researchJobs().then((result) => result.jobs).catch(() => [] as ResearchJob[]),
        tradePlansApi.list("awaiting"),
        tradePlansApi.list("active"),
      ]);
      setRows(planRows(jobs, awaiting, active));
      setError(null);
    } catch {
      setError("Plans could not be loaded. Retrying…");
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 10_000);
    const changed = () => void load();
    window.addEventListener(PLANS_CHANGED, changed);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener(PLANS_CHANGED, changed); };
  }, [load]);

  const count = rows?.length ?? 0;
  return (
    <section className="nl-card nl-plans" aria-labelledby="nl-plans-title" aria-busy={rows === null}>
      <div className="nl-card-head">
        <h2 id="nl-plans-title">Plans</h2>
        <span className="nl-card-meta metric-number">{count} {count === 1 ? "pair" : "pairs"}</span>
      </div>
      {rows === null ? (
        <p className="nl-card-empty">Loading plans…</p>
      ) : rows.length ? (
        rows.map((row) => {
          const pair = displayNameFor(row.instrument);
          const href = `/chart?instrument=${encodeURIComponent(row.instrument)}&analyze=1`;
          if (row.kind === "generating") {
            return (
              <div key={`g-${row.instrument}`} className="nl-pending-entry nl-plan-entry">
                <Link href={href} className="nl-pending-top">
                  <b>{pair}</b>
                  <span className="nl-plan-state is-generating"><span className="nl-plan-dot" aria-hidden="true" />Generating</span>
                </Link>
                <div className="nl-pending-foot">
                  <span>{JOB_WORD[row.job.status]} · {row.job.model} ({row.job.effort}) · started {ago(row.job.startedAt ?? row.job.createdAt)}</span>
                </div>
              </div>
            );
          }
          if (row.kind === "failed") {
            return (
              <div key={`f-${row.instrument}`} className="nl-pending-entry nl-plan-entry">
                <Link href={href} className="nl-pending-top">
                  <b>{pair}</b>
                  <span className="nl-plan-state is-failed">Not generated</span>
                </Link>
                <div className="nl-pending-foot">
                  <span>{row.job.error ?? "The research did not finish."} No plans were built.</span>
                  <Link href={`/chart?instrument=${encodeURIComponent(row.instrument)}`} className="nl-ghost-btn pressable nl-plan-link">Try again</Link>
                </div>
              </div>
            );
          }
          if (row.kind === "review") {
            return (
              <div key={`r-${row.instrument}`} className="nl-pending-entry nl-plan-entry">
                <Link href={href} className="nl-pending-top">
                  <b>{pair}</b>
                  <span className="nl-plan-state is-review">Ready to review</span>
                </Link>
                <Zones plans={row.plans} />
                <div className="nl-pending-foot">
                  <span>Built {ago(row.plans[0]!.createdAt)} · nothing is watched until you accept</span>
                  <Link href={href} className="nl-ghost-btn pressable nl-plan-link">Review</Link>
                </div>
              </div>
            );
          }
          const lead = row.plans.find((plan) => plan.status !== "MONITORING" && plan.status !== "APPROVED") ?? row.plans[0]!;
          const auto = row.plans.some((plan) => plan.monitoringMode === "AUTO");
          return (
            <div key={`w-${row.instrument}`} className="nl-pending-entry nl-plan-entry">
              <Link href={href} className="nl-pending-top">
                <b>{pair}</b>
                <span className="nl-plan-state is-watching">{lead.status === "MONITORING" || lead.status === "APPROVED" ? "Watching" : STATUS_LABEL[lead.status]}</span>
              </Link>
              <Zones plans={row.plans} />
              <div className="nl-pending-foot">
                <span>{auto ? "Auto trade · " : "Alert me · "}{lead.notTriggeredReason ?? "Checking the conditions."}</span>
              </div>
            </div>
          );
        })
      ) : (
        <p className="nl-card-empty">No plans yet. Press Analyze on a chart: GX researches the pair, then builds its BUY and SELL plans here.</p>
      )}
      {error ? <p className="nl-card-empty is-warn" role="status">{error}</p> : null}
    </section>
  );
}
