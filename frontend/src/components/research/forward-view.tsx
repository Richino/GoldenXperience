"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";

type Metrics = { assigned: number; open: number; ambiguous: number; resolved: number; winRate: number | null; averageR: number | null; profitFactor: number | null; netR: number; maxDrawdownR: number };
type Breakdown = Metrics & { group: string; evidenceEligible: boolean };
type Batch = {
  id: string;
  batchNumber: number;
  status: "collecting" | "resolving" | "complete";
  assignedCount: number;
  configuration: { targetR: number; excludedPairs: string[]; excludedSessions: string[]; sourceRecommendationBatch: number | null; riskPercent?: number; maxSimultaneousPositions?: number | null; maxTotalNominalRiskPercent?: number | null };
  summary: (Metrics & { breakdowns?: { pair: Breakdown[]; direction: Breakdown[]; session: Breakdown[]; weekday: Breakdown[]; volatility: Breakdown[]; spread: Breakdown[]; confirmation: Breakdown[] } }) | null;
  recommendation: { type: "exclude_pair" | "exclude_session"; value: string; sampleSize: number; averageR: number; profitFactor: number | null; rationale: string } | null;
  decision: "pending" | "approved" | "rejected" | "not_applicable";
  decisionNote: string | null;
  startedAt: string;
  completedAt: string | null;
};
type Trade = { id: string; tradeSequence: string; instrument: string; direction: string; status: string; outcome: string; entry: number; stop: number; target: number; exit: number | null; resultR: number | null; nominalRiskPercent: number; nominalRiskAmount: number; paperPl: number | null; spreadPips: number; session: string; weekday: string; plannedR: number; checklistScore: number; newsStatus: string; openedAt: string; closedAt: string | null; review: Record<string, unknown> };
type Overview = { strategyVersion: string; batchSize: number; lifetimeSummary: Metrics; current: (Batch & { liveSummary: Metrics; remaining: number }) | null; batches: Batch[]; trades: Trade[] };

const metric = (value: number | null, suffix = "") => value === null ? "—" : `${value.toFixed(2)}${suffix}`;
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

function BreakdownTable({ title, rows }: { title: string; rows: Breakdown[] }) {
  if (!rows.length) return null;
  return <div className="inset-panel rounded-2xl p-4"><h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--muted)]">{title}</h4><div className="mt-3 space-y-2">{rows.map((row) => <div key={row.group} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"><span className="truncate" title={row.group}>{row.group}</span><span className="metric-number">n={row.resolved}</span><span className={row.evidenceEligible ? "metric-number" : "text-[color:var(--muted)]"}>{row.evidenceEligible ? `${metric(row.averageR, "R")} · PF ${metric(row.profitFactor)}` : "Needs 20"}</span></div>)}</div></div>;
}

export function ForwardView() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [reviewTrade, setReviewTrade] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(apiUrl("/api/paper-cycle"), { credentials: "include", cache: "no-store" });
    const payload = await response.json() as Overview & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "Paper cycle unavailable.");
    setOverview(payload);
  }, []);

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Paper cycle unavailable."));
    const timer = window.setInterval(() => void load().catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function decide(batch: Batch, decision: "approved" | "rejected") {
    setSaving(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/paper-cycle/batches/decision"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batchId: batch.id, decision, note: decisionNote }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save the batch decision.");
      setDecisionNote(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the batch decision."); }
    finally { setSaving(false); }
  }

  async function saveReview(trade: Trade) {
    setSaving(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/paper-cycle/trades/review"), { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tradeId: trade.id, review: { notes: reviewNote } }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save the trade review.");
      setReviewTrade(null); setReviewNote(""); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the trade review."); }
    finally { setSaving(false); }
  }

  const current = overview?.current;
  const latestComplete = overview?.batches.find((batch) => batch.status === "complete") ?? null;
  const completedBatches = overview?.batches.filter((batch) => batch.status === "complete") ?? [];
  const previousComplete = completedBatches.length > 1 ? completedBatches[1]! : null;
  const summary = current?.liveSummary;
  const progress = current ? Math.min(100, current.assignedCount) : 0;

  return (
    <section className="app-card overflow-hidden">
      <div className="p-5 md:p-6">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--accent)]">Automatic paper cycle</p>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="research-section-title text-lg">One strategy · ten pairs · 100 trades</h2><p className="research-section-copy">Accepted setups are recorded automatically. News is not evaluated and no OANDA orders are submitted.</p></div>
          <Link href="/watchlist" className="secondary-button pressable">Open watchlist</Link>
        </div>

        {error ? <p className="research-error mt-4">{error}</p> : null}
        {!overview ? <p className="mt-5 text-sm text-[color:var(--muted)]">Loading paper cycle…</p> : !current ? <p className="mt-5 text-sm text-[color:var(--muted)]">The collector is waiting for its first valid automatic setup.</p> : <>
          <div className="mt-5 flex items-end justify-between gap-4"><div><p className="text-sm font-semibold">Batch {current.batchNumber}</p><p className="mt-1 text-xs text-[color:var(--muted)]">{current.status} · {overview.strategyVersion} · fixed {current.configuration.targetR.toFixed(1)}R target</p><p className="mt-1 text-xs text-[color:var(--muted)]">Frozen policy: {(current.configuration.riskPercent ?? 1).toFixed(2)}% risk · {current.configuration.maxSimultaneousPositions == null ? "unlimited positions" : `${current.configuration.maxSimultaneousPositions} positions max`} · {current.configuration.maxTotalNominalRiskPercent == null ? "unlimited total exposure" : `${current.configuration.maxTotalNominalRiskPercent.toFixed(2)}% total exposure max`}</p></div><p className="metric-number text-2xl font-semibold">{current.assignedCount}/100</p></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[color:var(--surface-raised)]"><div className="h-full rounded-full bg-[color:var(--accent)] transition-[width]" style={{ width: `${progress}%` }} /></div>
          {summary ? <div className="research-metric-grid mt-5">{[
            ["Resolved", summary.resolved], ["Open", summary.open], ["Remaining", current.remaining], ["Win rate", percent(summary.winRate)], ["Average R", metric(summary.averageR, "R")], ["Profit factor", metric(summary.profitFactor)], ["Net R", metric(summary.netR, "R")], ["Drawdown", metric(summary.maxDrawdownR, "R")],
          ].map(([label, value]) => <div key={label} className="research-metric-cell"><p className="research-stat-label">{label}</p><p className="research-stat-value metric-number">{value}</p></div>)}</div> : null}

          <div className="mt-6 border-t border-[color:var(--border)] pt-5"><h3 className="text-sm font-semibold">Latest trades</h3><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="text-[color:var(--muted)]"><tr>{["#", "Pair", "Side", "Session", "Plan", "Outcome", "Result", "Review"].map((label) => <th key={label} className="pb-3 pr-4 font-medium">{label}</th>)}</tr></thead><tbody>{overview.trades.slice(0, 20).map((trade) => <tr key={trade.id} className="border-t border-[color:var(--border)]"><td className="py-3 pr-4 metric-number">{trade.tradeSequence}</td><td className="py-3 pr-4"><Link className="font-semibold text-[color:var(--accent)]" href={`/signals?instrument=${trade.instrument}`}>{displayNameFor(trade.instrument)}</Link></td><td className="py-3 pr-4">{trade.direction}</td><td className="py-3 pr-4">{trade.session}</td><td className="py-3 pr-4 metric-number">{trade.plannedR.toFixed(1)}R</td><td className="py-3 pr-4">{trade.outcome.replaceAll("_", " ")}</td><td className="py-3 pr-4 metric-number">{trade.resultR === null ? "—" : `${trade.resultR.toFixed(2)}R`}</td><td className="py-3"><button className="text-[color:var(--accent)]" type="button" onClick={() => { setReviewTrade(trade.id); setReviewNote(String(trade.review.notes ?? "")); }}>Review</button></td></tr>)}</tbody></table></div></div>
        </>}

        {reviewTrade ? <div className="inset-panel mt-5 rounded-2xl p-4"><label className="text-xs font-medium">Optional owner review<textarea className="control-track mt-2 min-h-24 w-full rounded-xl p-3 text-sm" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="What went well, what went wrong, and whether you would take it again." /></label><div className="mt-3 flex gap-2"><button type="button" className="primary-button" disabled={saving} onClick={() => { const trade = overview?.trades.find((item) => item.id === reviewTrade); if (trade) void saveReview(trade); }}>Save review</button><button type="button" className="secondary-button" onClick={() => setReviewTrade(null)}>Cancel</button></div></div> : null}

        {latestComplete ? <div className="mt-6 border-t border-[color:var(--border)] pt-5"><h3 className="text-sm font-semibold">Latest completed batch · {latestComplete.batchNumber}</h3>{latestComplete.summary ? <><p className="mt-2 text-sm text-[color:var(--muted)]">{latestComplete.summary.resolved} resolved · {percent(latestComplete.summary.winRate)} win rate · {metric(latestComplete.summary.averageR, "R")} average · PF {metric(latestComplete.summary.profitFactor)}</p><div className="research-compare-grid mt-4">{[["Previous batch", previousComplete?.summary?.averageR ?? null, latestComplete.summary.averageR], ["Lifetime baseline", overview?.lifetimeSummary.averageR ?? null, latestComplete.summary.averageR]].map(([label, baseline, latest]) => { const change = typeof baseline === "number" && typeof latest === "number" ? latest - baseline : null; return <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><p className="metric-number mt-2 text-sm">{change === null ? "No comparison yet" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}R ${change > 0 ? "improved" : change < 0 ? "worse" : "unchanged"}`}</p></div>; })}</div>{latestComplete.summary.breakdowns ? <div className="mt-4 grid gap-3 lg:grid-cols-2"><BreakdownTable title="Pair" rows={latestComplete.summary.breakdowns.pair} /><BreakdownTable title="Session" rows={latestComplete.summary.breakdowns.session} /><BreakdownTable title="Direction" rows={latestComplete.summary.breakdowns.direction} /><BreakdownTable title="Weekday" rows={latestComplete.summary.breakdowns.weekday} /><BreakdownTable title="Volatility" rows={latestComplete.summary.breakdowns.volatility} /><BreakdownTable title="Spread" rows={latestComplete.summary.breakdowns.spread} /><BreakdownTable title="Confirmation" rows={latestComplete.summary.breakdowns.confirmation} /></div> : null}</> : null}{latestComplete.recommendation ? <div className="inset-panel mt-4 rounded-2xl p-4"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[color:var(--accent)]">One evidence-based hypothesis</p><p className="mt-2 text-sm">{latestComplete.recommendation.rationale}</p>{latestComplete.decision === "pending" ? <><textarea className="control-track mt-3 min-h-20 w-full rounded-xl p-3 text-sm" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="Optional reason for your decision" /><div className="mt-3 flex gap-2"><button className="primary-button" disabled={saving} onClick={() => void decide(latestComplete, "approved")}>Approve for next unopened batch</button><button className="secondary-button" disabled={saving} onClick={() => void decide(latestComplete, "rejected")}>Reject</button></div></> : <p className="mt-3 text-xs font-semibold uppercase text-[color:var(--muted)]">Decision: {latestComplete.decision}</p>}</div> : <p className="mt-2 text-sm text-[color:var(--muted)]">No subgroup reached 20 resolved trades with negative expectancy, so no rule change is supported.</p>}</div> : null}
      </div>
    </section>
  );
}
