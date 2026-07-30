"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";

type Summary = { evaluations: number; valid_evaluations: number; blocked_evaluations: number; target_first: number; stop_first: number; unresolved: number; average_r: number | null };

export function ResearchView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch(apiUrl("/api/research/summary"), { credentials: "include", cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error(response.status === 401 ? "Sign in to view private research." : "Research data is not available yet.");
    return response.json() as Promise<{ summary: Summary }>;
  }).then(({ summary }) => setSummary(summary)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load research.")); }, []);
  const resolved = summary ?? { evaluations: 0, valid_evaluations: 0, blocked_evaluations: 0, target_first: 0, stop_first: 0, unresolved: 0, average_r: null };
  const decided = resolved.target_first + resolved.stop_first;
  return <div className="space-y-6"><header><h1 className="text-display tracking-[-0.05em]">Research</h1><p className="mt-1.5 max-w-2xl text-sm text-[color:var(--muted)]">One deterministic strategy. Completed OANDA candles only. Unresolved and ambiguous outcomes are excluded from performance rates.</p></header>
    {error ? <p className="app-card p-5 text-sm text-[color:var(--danger)]">{error}</p> : null}
    <section className="app-card grid gap-px overflow-hidden sm:grid-cols-2 lg:grid-cols-4">{[["Evaluations", resolved.evaluations], ["Valid setups", resolved.valid_evaluations], ["Target first", decided ? `${((resolved.target_first / decided) * 100).toFixed(1)}%` : "—"], ["Average R", resolved.average_r === null ? "—" : `${resolved.average_r >= 0 ? "+" : ""}${resolved.average_r.toFixed(2)}R`]].map(([label, value]) => <div key={String(label)} className="p-5"><p className="text-xs text-[color:var(--muted)]">{label}</p><p className="metric-number mt-2 text-2xl font-semibold">{value}</p></div>)}</section>
    <section className="app-card p-5"><h2 className="font-semibold">Outcome integrity</h2><dl className="mt-4 grid grid-cols-3 gap-4 text-sm"><div><dt className="text-[color:var(--muted)]">Target first</dt><dd className="mt-1 font-medium">{resolved.target_first}</dd></div><div><dt className="text-[color:var(--muted)]">Stop first</dt><dd className="mt-1 font-medium">{resolved.stop_first}</dd></div><div><dt className="text-[color:var(--muted)]">Unresolved</dt><dd className="mt-1 font-medium">{resolved.unresolved}</dd></div></dl></section></div>;
}
