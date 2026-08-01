"use client";

import { Download, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/api/url";
import { INSTRUMENT_CATALOG } from "@/lib/instruments/catalog";
import { ExperimentEquityChart } from "@/components/research/experiment-equity-chart";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { SelectMenu } from "@/components/ui/select-menu";
import type { MajorInstrument } from "@/types/forex";

type BaselineMetrics = { sample_size: number; win_rate: number | null; average_r: number | null; expectancy: number | null; profit_factor: number | null; drawdown_r: number };
type Summary = BaselineMetrics & { evaluations: number; valid_evaluations: number; blocked_evaluations: number; candidates: number; executable_candidates: number; overlapping_candidates: number; pending_candidates: number; target_first: number; stop_first: number; forced_close: number; unresolved: number; ambiguous: number; raw_baseline: BaselineMetrics; conservative_baseline: BaselineMetrics };
type ResearchRun = { details: { state?: string; phase?: string; months?: number; durable?: boolean; fetched?: Record<string, number>; timeframeProgress?: Record<string, number>; progressPercent?: number; note?: string; replayed?: number; validSetups?: number; labeled?: number; acceptedCandidates?: number; overlappingCandidates?: number; shadowLabeled?: number; candidates?: number }; error: string | null };
type ExperimentSummary = { raw_candidates: number; executable_candidates: number; overlapping_candidates: number; target_first: number; stop_first: number; unresolved: number; ambiguous: number; raw_baseline: BaselineMetrics; executable: BaselineMetrics; conservative?: BaselineMetrics; reference_candidates: number; reference: BaselineMetrics; reference_conservative?: BaselineMetrics; coverage_start: string; coverage_end: string | null };
type ResearchExperiment = { id: string; instrument: string; direction: "all" | "long" | "short"; sessions: string[]; lookback_months: number; experiment_version: string; summary: ExperimentSummary; decision: "pending" | "approved" | "rejected"; decision_note: string | null; decided_at: string | null; created_at: string };
type HoldoutSummary = { raw_candidates: number; executable_candidates: number; overlapping_candidates: number; target_first: number; stop_first: number; unresolved: number; ambiguous: number; raw_baseline: BaselineMetrics; executable: BaselineMetrics; conservative?: BaselineMetrics; coverage_start: string; coverage_end: string };
type ResearchHoldout = { id: string; source_experiment_id: string; instrument: string; direction: "all" | "long" | "short"; sessions: string[]; range_start: string; range_end: string; status: "queued" | "running" | "complete" | "failed"; summary: HoldoutSummary | null; error: string | null };
type WalkForwardMetrics = BaselineMetrics;
type WalkForwardRun = { id: string; instrument: string; configuration: { trainMonths?: number; testMonths?: number; minimumTrainingResolved?: number; candidatesEvaluated?: number }; summary: { aggregate: WalkForwardMetrics; stress: Array<{ extra_pips: number; metrics: WalkForwardMetrics }>; forced_session_exits?: number; validation_status?: "passed" | "failed" | "insufficient_sample"; folds: Array<{ train_start: string; train_end: string; test_start: string; test_end: string; selected: { direction: "all" | "long" | "short"; sessions: string[]; training: WalkForwardMetrics; test: WalkForwardMetrics; testCandidates: number; stress: Array<{ extra_pips: number; metrics: WalkForwardMetrics }> } | null }>; warning: string }; created_at: string };
type ExperimentMetricSet = BaselineMetrics & { candidates: number; target_first: number; stop_first: number; unresolved: number; ambiguous: number };
type ExperimentBreakdown = ExperimentMetricSet & { name: string };
type ExperimentAuditTrade = { candidateId: string; decisionTime: string; direction: "long" | "short"; entry: number; stop: number; target: number; plannedR: number; spreadPips: number; session: string; executionStatus: "accepted" | "overlapping"; blockedByCandidateId: string | null; simulatedEntryAt: string | null; simulatedExitAt: string | null; resolvedAt: string | null; outcome: "target_first" | "stop_first" | "unresolved" | "ambiguous"; resultR: number | null; mfeR: number | null; maeR: number | null };
type ExperimentDiagnostics = { breakdowns: { year: ExperimentBreakdown[]; session: ExperimentBreakdown[] }; equity: Array<{ candidateId: string; decisionTime: string; resultR: number; cumulativeR: number; drawdownR: number }>; retrospective: { cutoff: string; warning: string; development: ExperimentMetricSet; finalYear: ExperimentMetricSet }; audit: ExperimentAuditTrade[] };
type Breakdown = { name: string; candidates: number; sampleSize: number; wins: number; losses: number; unresolved: number; ambiguous: number; winRate: number | null; averageR: number | null; profitFactor: number | null; conservativeSampleSize: number; conservativeWinRate: number | null; conservativeAverageR: number | null; conservativeProfitFactor: number | null };
type DiagnosticTrade = { id: string; instrument: string; decisionTime: string; direction: "long" | "short"; entry: number; stop: number; target: number; plannedR: number; spreadPips: number; session: string; outcome: "target_first" | "stop_first" | "unresolved" | "ambiguous" | null; resultR: number | null; mfeR: number | null; maeR: number | null; executionStatus: "pending" | "accepted" | "overlapping"; blockedByCandidateId: string | null; simulatedEntryAt: string | null; simulatedExitAt: string | null; notEvaluated: string[] };
type ShadowTrade = DiagnosticTrade & { failedCondition: string };
type Diagnostics = {
  funnel: Array<{ name: string; count: number; total: number; totalRate: number | null; retention: number | null }>;
  nearMisses: Array<{ condition: string; count: number }>;
  excursion: { sampleSize: number; averageMfeR: number | null; medianMfeR: number | null; averageMaeR: number | null; medianMaeR: number | null };
  breakdowns: { direction: Breakdown[]; month: Breakdown[]; session: Breakdown[]; pair: Breakdown[] };
  shadow?: { byCondition: Breakdown[]; trades: ShadowTrade[] };
  trades: DiagnosticTrade[];
};
const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const emptyBaseline: BaselineMetrics = { sample_size: 0, win_rate: null, average_r: null, expectancy: null, profit_factor: null, drawdown_r: 0 };
const emptySummary: Summary = { ...emptyBaseline, evaluations: 0, valid_evaluations: 0, blocked_evaluations: 0, candidates: 0, executable_candidates: 0, overlapping_candidates: 0, pending_candidates: 0, target_first: 0, stop_first: 0, forced_close: 0, unresolved: 0, ambiguous: 0, raw_baseline: emptyBaseline, conservative_baseline: emptyBaseline };
const exactInstrument = (value: string) => INSTRUMENT_CATALOG.find((item) => {
  const normalized = clean(value);
  return normalized === clean(item.name) || normalized === clean(item.displayName);
});
const LOOKBACK_OPTIONS = [
  { value: 12 as const, label: "1 year" },
  { value: 36 as const, label: "3 years" },
  { value: 60 as const, label: "5 years" },
];
const EXPERIMENT_DIRECTION_OPTIONS = [
  { value: "all" as const, label: "All directions" },
  { value: "long" as const, label: "Long only" },
  { value: "short" as const, label: "Short only" },
];
const SESSION_OPTIONS = ["London", "London/New York overlap", "New York"] as const;

function ResearchSectionHead({
  title,
  description,
  descriptionClassName = "",
}: {
  title: string;
  description?: string;
  descriptionClassName?: string;
}) {
  return (
    <div className="research-section-head">
      <h2 className="research-section-title">{title}</h2>
      {description ? (
        <p className={`research-section-copy ${descriptionClassName}`}>{description}</p>
      ) : null}
    </div>
  );
}

function ResearchInlineStat({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="research-inline-stat">
      <span>{label}</span>
      <span className="metric-number text-[color:var(--foreground)]">{value}</span>
    </div>
  );
}

function ResearchPairSearch({
  pair,
  search,
  open,
  matches,
  onSearchChange,
  onOpenChange,
  onSelect,
}: {
  pair: MajorInstrument;
  search: string;
  open: boolean;
  matches: typeof INSTRUMENT_CATALOG;
  onSearchChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSelect: (instrument: MajorInstrument, displayName: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onOpenChange]);

  const showResults = open && matches.length > 0;

  return (
    <div ref={rootRef} className="relative w-[11.5rem] sm:w-48">
      <div className="signals-search">
        <Search className="size-3.5 shrink-0 text-[color:var(--muted)]" strokeWidth={2} />
        <input
          aria-label="Search forex pairs"
          aria-expanded={open}
          aria-controls="research-pair-search-results"
          className="min-w-0 flex-1 bg-transparent text-[color:var(--foreground)] outline-none placeholder:text-[color:var(--muted)]"
          placeholder="Search pairs"
          type="search"
          value={search}
          onChange={(event) => {
            const nextSearch = event.target.value;
            onSearchChange(nextSearch);
            onOpenChange(true);
            const exact = exactInstrument(nextSearch);
            if (exact) onSelect(exact.name, exact.displayName);
          }}
          onFocus={() => onOpenChange(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onOpenChange(false);
              event.currentTarget.blur();
            }

            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              onSelect(matches[0].name, matches[0].displayName);
              onOpenChange(false);
            }
          }}
        />
        {search ? (
          <button
            type="button"
            aria-label="Clear currency pair"
            className="signals-icon-btn pressable !size-6 shrink-0"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onSearchChange("");
              onOpenChange(true);
            }}
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {showResults ? (
        <div
          id="research-pair-search-results"
          role="listbox"
          aria-label="Forex pairs"
          className="menu-popover absolute left-0 right-0 top-[calc(100%+6px)] z-50 max-h-[min(16rem,50vh)] overflow-hidden rounded-2xl p-1.5"
        >
          <div className="max-h-[min(16rem,50vh)] overflow-y-auto overscroll-contain">
            {matches.map((item) => {
              const active = item.name === pair;

              return (
                <button
                  key={item.name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`pressable flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium tracking-[-0.02em] ${
                    active
                      ? "menu-item-active"
                      : "text-[color:var(--muted-strong)] hover:bg-[color:var(--surface-raised)] hover:text-[color:var(--foreground)]"
                  }`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    onSelect(item.name, item.displayName);
                    onOpenChange(false);
                  }}
                >
                  <PairAvatar instrument={item.name} size={26} />
                  <span className="min-w-0 flex-1 truncate">{item.displayName}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ResearchView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pair, setPair] = useState<MajorInstrument>("EUR_USD");
  const [search, setSearch] = useState("EUR/USD");
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [starting, setStarting] = useState(false);
  const [lookbackMonths, setLookbackMonths] = useState<12 | 36 | 60>(60);
  const [experimentDirection, setExperimentDirection] = useState<"all" | "long" | "short">("short");
  const [experimentSessions, setExperimentSessions] = useState<string[]>(["London", "London/New York overlap"]);
  const [experiment, setExperiment] = useState<ResearchExperiment | null>(null);
  const [experimentDiagnostics, setExperimentDiagnostics] = useState<ExperimentDiagnostics | null>(null);
  const [experimentDiagnosticsLoading, setExperimentDiagnosticsLoading] = useState(false);
  const [runningExperiment, setRunningExperiment] = useState(false);
  const [holdout, setHoldout] = useState<ResearchHoldout | null>(null);
  const [holdoutRun, setHoldoutRun] = useState<ResearchRun | null>(null);
  const [startingHoldout, setStartingHoldout] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [savingDecision, setSavingDecision] = useState(false);
  const [walkForward, setWalkForward] = useState<WalkForwardRun | null>(null);
  const [runningWalkForward, setRunningWalkForward] = useState(false);
  const matches = useMemo(() => INSTRUMENT_CATALOG.filter((item) => !clean(search) || clean(`${item.name} ${item.displayName}`).includes(clean(search))).slice(0, 12), [search]);
  const selectedInstrument = INSTRUMENT_CATALOG.find((item) => item.name === pair);
  const selectionIsValid = exactInstrument(search)?.name === selectedInstrument?.name;
  const loadOverview = useCallback(() => Promise.all([
    fetch(apiUrl(`/api/research/summary?instrument=${pair}`), { credentials: "include", cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ summary: Summary }> : Promise.reject(new Error(response.status === 401 ? "Your local API session has expired. Sign in again." : "Research data is unavailable."))).then((value) => setSummary(value.summary)),
    fetch(apiUrl(`/api/research/runs?instrument=${pair}`), { credentials: "include", cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ run: ResearchRun | null }> : Promise.reject(new Error("Research run is unavailable."))).then((value) => setRun(value.run)),
    Promise.resolve().then(() => setExperiment(null)),
  ]), [pair]);
  const loadDiagnostics = useCallback(() => fetch(apiUrl(`/api/research/diagnostics?instrument=${pair}`), { credentials: "include", cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<{ diagnostics: Diagnostics }> : Promise.reject(new Error("Research diagnostics are unavailable.")))
    .then((value) => setDiagnostics(value.diagnostics)), [pair]);
  const loadHoldout = useCallback(() => {
    if (!experiment?.id) return Promise.resolve();
    return fetch(apiUrl(`/api/research/holdouts?experimentId=${experiment.id}`), { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ holdout: ResearchHoldout | null; run: ResearchRun | null }> : Promise.reject(new Error("Locked holdout is unavailable.")))
      .then((value) => { setHoldout(value.holdout); setHoldoutRun(value.run); });
  }, [experiment?.id]);
  const loadWalkForward = useCallback(() => fetch(apiUrl(`/api/research/day-validation?instrument=${pair}`), { credentials: "include", cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<{ run: WalkForwardRun | null }> : Promise.reject(new Error("Day-trading validation is unavailable.")))
    .then((value) => setWalkForward(value.run)), [pair]);

  useEffect(() => { void Promise.all([loadOverview(), loadDiagnostics()]).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Unable to load research.")); }, [loadOverview, loadDiagnostics]);
  useEffect(() => { if (!run || !["queued", "running"].includes(run.details.state ?? "")) return; const timer = window.setInterval(() => void loadOverview(), 3_000); return () => window.clearInterval(timer); }, [run, loadOverview]);
  useEffect(() => { if (run?.details.state === "complete") void loadDiagnostics(); }, [run?.details.state, loadDiagnostics]);
  useEffect(() => {
    if (!experiment?.id) {
      setExperimentDiagnostics(null);
      setExperimentDiagnosticsLoading(false);
      return;
    }

    setExperimentDiagnostics(null);
    setExperimentDiagnosticsLoading(true);

    void fetch(apiUrl(`/api/research/experiments/diagnostics?experimentId=${experiment.id}`), { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ diagnostics: ExperimentDiagnostics }> : Promise.reject(new Error("Experiment diagnostics are unavailable.")))
      .then((value) => setExperimentDiagnostics(value.diagnostics))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Experiment diagnostics are unavailable."))
      .finally(() => setExperimentDiagnosticsLoading(false));
  }, [experiment?.id]);
  useEffect(() => {
    if (!experiment?.id) { setHoldout(null); setHoldoutRun(null); return; }
    void loadHoldout().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Locked holdout is unavailable."));
  }, [experiment?.id, loadHoldout]);
  useEffect(() => { setDecisionNote(experiment?.decision_note ?? ""); }, [experiment?.id, experiment?.decision_note]);
  useEffect(() => { if (!holdout || !["queued", "running"].includes(holdout.status)) return; const timer = window.setInterval(() => void loadHoldout(), 3_000); return () => window.clearInterval(timer); }, [holdout, loadHoldout]);
  useEffect(() => { void loadWalkForward().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Day-trading validation is unavailable.")); }, [loadWalkForward]);

  function selectInstrument(instrument: MajorInstrument) {
    if (instrument !== pair) {
      setSummary(null);
      setRun(null);
      setDiagnostics(null);
      setExperiment(null);
      setExperimentDiagnostics(null);
      setExperimentDiagnosticsLoading(false);
      setHoldout(null);
      setHoldoutRun(null);
      setWalkForward(null);
    }
    setPair(instrument);
    setError(null);
  }

  async function start() {
    const instrument = exactInstrument(search);
    if (!instrument || instrument.name !== pair) {
      setError("Select a currency pair from the search results before starting research.");
      setOpen(true);
      return;
    }
    setStarting(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/research/runs"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument: pair, months: lookbackMonths }) });
      if (!response.ok) throw new Error("Could not start research.");
      setRun((await response.json() as { run: ResearchRun }).run);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start research."); }
    finally { setStarting(false); }
  }

  function toggleExperimentSession(session: string) {
    setExperimentSessions((current) => current.includes(session) ? current.filter((value) => value !== session) : [...current, session]);
  }

  async function runExperiment() {
    if (!experimentSessions.length) { setError("Choose at least one session for the experiment."); return; }
    setRunningExperiment(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/research/experiments"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument: pair, direction: experimentDirection, sessions: experimentSessions, months: lookbackMonths }) });
      const payload = await response.json() as { experiment?: ResearchExperiment; error?: string };
      if (!response.ok || !payload.experiment) throw new Error(payload.error ?? "Could not run the research experiment.");
      setExperiment(payload.experiment);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not run the research experiment."); }
    finally { setRunningExperiment(false); }
  }

  async function startLockedHoldout() {
    if (!experiment) return;
    setStartingHoldout(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/research/holdouts"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experimentId: experiment.id }) });
      const payload = await response.json() as { holdout?: ResearchHoldout; run?: ResearchRun; error?: string };
      if (!response.ok || !payload.holdout) throw new Error(payload.error ?? "Could not start the locked holdout.");
      setHoldout(payload.holdout); setHoldoutRun(payload.run ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start the locked holdout."); }
    finally { setStartingHoldout(false); }
  }

  async function saveExperimentDecision(decision: ResearchExperiment["decision"]) {
    if (!experiment) return;
    setSavingDecision(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/research/experiments/decision"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experimentId: experiment.id, decision, note: decisionNote }) });
      const payload = await response.json() as { experiment?: ResearchExperiment; error?: string };
      if (!response.ok || !payload.experiment) throw new Error(payload.error ?? "Could not save the research decision.");
      setExperiment(payload.experiment);
      setDecisionNote(payload.experiment.decision_note ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save the research decision."); }
    finally { setSavingDecision(false); }
  }

  async function runWalkForward() {
    setRunningWalkForward(true); setError(null);
    try {
      const response = await fetch(apiUrl("/api/research/day-validation"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument: pair }) });
      const payload = await response.json() as { run?: WalkForwardRun; error?: string };
      if (!response.ok || !payload.run) throw new Error(payload.error ?? "Could not run day-trading validation.");
      setWalkForward(payload.run);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not run day-trading validation."); }
    finally { setRunningWalkForward(false); }
  }

  function downloadExperimentJson() {
    if (!experiment || !experimentDiagnostics) {
      setError("Wait for the saved experiment diagnostics to finish loading before downloading it.");
      return;
    }

    const payload = {
      schemaVersion: "goldenxperience-research-export-v1",
      exportedAt: new Date().toISOString(),
      scope: "historical-price-only-research-experiment",
      caveats: [
        "News was not evaluated.",
        "The experiment was selected after inspecting the same historical dataset, so its final-year split is retrospective rather than untouched validation.",
        experimentDiagnostics.retrospective.warning,
        "This export is research evidence only and does not authorize live trading.",
      ],
      experiment,
      diagnostics: experimentDiagnostics,
    };
    const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `goldenxperience-${experiment.instrument.toLowerCase()}-${experiment.direction}-${experiment.created_at.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
  }

  const value = summary ?? emptySummary;
  const working = ["queued", "running"].includes(run?.details.state ?? "");
  const holdoutWorking = !!holdout && ["queued", "running"].includes(holdout.status);
  const metrics: Array<[string, string | number]> = [
    ["Sample size", value.sample_size],
    ["Win rate", value.win_rate === null ? "—" : `${(value.win_rate * 100).toFixed(1)}%`],
    ["Average R", value.average_r === null ? "—" : `${value.average_r.toFixed(2)}R`],
    ["Max drawdown", `${value.drawdown_r.toFixed(2)}R`],
    ["Evaluations", value.evaluations],
    ["Valid setups", value.valid_evaluations],
    ["Expectancy", value.expectancy === null ? "—" : `${value.expectancy.toFixed(2)}R`],
    ["Profit factor", value.profit_factor === null ? "—" : value.profit_factor.toFixed(2)],
  ];
  const percent = (metric: number | null) => metric === null ? "—" : `${(metric * 100).toFixed(1)}%`;
  const rValue = (metric: number | null) => metric === null ? "—" : `${metric.toFixed(2)}R`;
  const optionalSample = (metric: BaselineMetrics | null) => metric?.sample_size ?? "Not recorded";
  const optionalPercent = (metric: BaselineMetrics | null) => metric ? percent(metric.win_rate) : "Not recorded";
  const optionalR = (metric: BaselineMetrics | null, field: "average_r" | "drawdown_r") => metric ? rValue(metric[field]) : "Not recorded";
  const optionalProfitFactor = (metric: BaselineMetrics | null) => metric ? (metric.profit_factor === null ? "—" : metric.profit_factor.toFixed(2)) : "Not recorded";
  const outcomeLabel = (outcome: DiagnosticTrade["outcome"]) => outcome === "target_first" ? "Target first" : outcome === "stop_first" ? "Stop first" : outcome === "ambiguous" ? "Ambiguous" : outcome === "unresolved" ? "Unresolved" : "Not labeled";
  const price = (metric: number, instrument: string) => metric.toFixed(instrument.endsWith("JPY") ? 3 : 5);
  const experimentEquity = experimentDiagnostics?.equity ?? [];
  const experimentConservative = experiment?.summary.conservative ?? null;
  const holdoutConservative = holdout?.summary?.conservative ?? null;

  return (
    <div className="research-view space-y-5">
      <section className="app-card p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <ResearchSectionHead
            title="Start day-trading research"
            description="Collect M15, H1, and H4 candles, then replay the active same-day strategy. Entries stop at noon ET and open trades are forced out at 16:45 ET. News is not evaluated."
          />
          <div className="research-toolbar">
            <SelectMenu
              ariaLabel="Research history range"
              value={lookbackMonths}
              onChange={setLookbackMonths}
              options={LOOKBACK_OPTIONS}
            />
            <ResearchPairSearch
              pair={pair}
              search={search}
              open={open}
              matches={matches}
              onSearchChange={setSearch}
              onOpenChange={setOpen}
              onSelect={(instrument, displayName) => {
                selectInstrument(instrument);
                setSearch(displayName);
              }}
            />
            <button
              type="button"
              onClick={start}
              disabled={starting || working || !selectionIsValid}
              className="research-primary-btn"
            >
              {starting ? "Starting…" : working ? "Research running" : selectionIsValid ? `Start ${lookbackMonths / 12}-year research` : "Select a pair"}
            </button>
          </div>
        </div>
        {run && <div className="research-notice"><div className="flex justify-between gap-3"><b>{pair.replace("_", "/")} · {run.details.phase ?? "Research"}</b><span className="text-[color:var(--accent)]">{run.details.state}</span></div><p className="mt-2">{run.error ?? run.details.note}</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[color:var(--border)]" role="progressbar" aria-label="Research progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={run.details.progressPercent ?? 0}><div className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-500" style={{ width: `${run.details.progressPercent ?? 0}%` }} /></div><div className="mt-2 flex justify-between text-xs"><span>M15: {run.details.timeframeProgress?.M15 ?? 0}% · H1: {run.details.timeframeProgress?.H1 ?? 0}% · H4: {run.details.timeframeProgress?.H4 ?? 0}%</span><b>{run.details.progressPercent ?? 0}%</b></div><p className="mt-1 text-xs">Candles — M15: {run.details.fetched?.M15 ?? 0} · H1: {run.details.fetched?.H1 ?? 0} · H4: {run.details.fetched?.H4 ?? 0}{run.details.replayed !== undefined ? ` · Replayed: ${run.details.replayed}` : ""}{run.details.labeled !== undefined ? ` · Candidates labeled: ${run.details.labeled}` : ""}{run.details.acceptedCandidates !== undefined ? ` · Accepted: ${run.details.acceptedCandidates}` : ""}{run.details.overlappingCandidates !== undefined ? ` · Overlapping: ${run.details.overlappingCandidates}` : ""}{run.details.shadowLabeled !== undefined ? ` · Shadows labeled: ${run.details.shadowLabeled}` : ""}</p></div>}
      </section>
      {error && <p className="research-error">{error}</p>}
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead
          title={`Baseline · ${selectedInstrument?.displayName ?? pair.replace("_", "/")}`}
          description="Only one trade may be open per pair. Overlapping, unresolved, and ambiguous accepted trades are excluded from performance metrics."
        />
        <div className="research-metric-grid mt-5">{metrics.map(([label, metric]) => <div key={label} className="research-metric-cell"><p className="research-stat-label">{label}</p><p className="research-stat-value metric-number">{metric}</p></div>)}</div>
        <p className="research-footnote">Raw setups: {value.candidates} · Executable: {value.executable_candidates} · Overlapping: {value.overlapping_candidates} · Pending: {value.pending_candidates} · Target first: {value.target_first} · Stop first: {value.stop_first} · Forced 16:45 exits: {value.forced_close} · Unresolved: {value.unresolved} · Ambiguous: {value.ambiguous}</p>
      </section>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Raw versus executable" description="Raw results label every valid setup independently. Position-aware results accept the first setup and block new entries until it exits." />
        <div className="research-compare-grid">{[["Sample", value.raw_baseline.sample_size, value.sample_size], ["Win rate", percent(value.raw_baseline.win_rate), percent(value.win_rate)], ["Average R", rValue(value.raw_baseline.average_r), rValue(value.average_r)], ["Profit factor", value.raw_baseline.profit_factor === null ? "—" : value.raw_baseline.profit_factor.toFixed(2), value.profit_factor === null ? "—" : value.profit_factor.toFixed(2)], ["Drawdown", rValue(value.raw_baseline.drawdown_r), rValue(value.drawdown_r)]].map(([label, raw, executable]) => <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><ResearchInlineStat label="Raw" value={raw} /><ResearchInlineStat label="Executable" value={executable} /></div>)}</div>
      </section>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Resolved-only versus conservative" description="Resolved-only counts target, stop, and mandatory 16:45 ET exits. Conservative also counts ambiguous bars as losses and keeps any missing-price row visible rather than inventing an outcome." />
        <div className="research-compare-grid">{[["Sample", value.sample_size, value.conservative_baseline.sample_size], ["Win rate", percent(value.win_rate), percent(value.conservative_baseline.win_rate)], ["Average R", rValue(value.average_r), rValue(value.conservative_baseline.average_r)], ["Profit factor", value.profit_factor === null ? "—" : value.profit_factor.toFixed(2), value.conservative_baseline.profit_factor === null ? "—" : value.conservative_baseline.profit_factor.toFixed(2)], ["Drawdown", rValue(value.drawdown_r), rValue(value.conservative_baseline.drawdown_r)]].map(([label, resolved, conservative]) => <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><ResearchInlineStat label="Resolved only" value={resolved} /><ResearchInlineStat label="Conservative" value={conservative} /></div>)}</div>
        <p className="research-footnote !px-0">Both columns use the same accepted, position-aware trades. Re-label an existing run to populate the conservative column for research completed before this basis existed.</p>
      </section>
      <section className="app-card hidden p-5 md:p-6" aria-hidden="true">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <ResearchSectionHead title="Retired strategy experiment controls" description="Retired / rejected evidence is retained in the database, but cannot create new active research." />
          <div className="research-toolbar">
            {experiment && <button type="button" onClick={downloadExperimentJson} disabled={!experimentDiagnostics} title={experimentDiagnostics ? "Download the complete saved experiment as JSON" : "Experiment diagnostics are still loading"} className="research-secondary-btn"><Download className="size-4" />Download JSON</button>}
            <button type="button" onClick={runExperiment} disabled={runningExperiment || working || !experimentSessions.length} className="research-primary-btn">{runningExperiment ? "Running experiment…" : "Run experiment"}</button>
          </div>
        </div>
        <div className="research-form-grid">
          <label><span className="research-field-label">Direction</span><SelectMenu ariaLabel="Experiment direction" value={experimentDirection} onChange={setExperimentDirection} options={EXPERIMENT_DIRECTION_OPTIONS} fullWidth className="mt-2" /></label>
          <fieldset>
            <legend className="research-field-label">Sessions</legend>
            <div className="workspace-segment mt-2 max-w-full">{SESSION_OPTIONS.map((session) => <button key={session} type="button" aria-pressed={experimentSessions.includes(session)} onClick={() => toggleExperimentSession(session)} className={`workspace-segment-btn pressable ${experimentSessions.includes(session) ? "workspace-segment-btn-active" : ""}`}>{session}</button>)}</div>
          </fieldset>
        </div>
        {experiment && <div className="research-panel"><p className="research-panel-title">Latest experiment · {experiment.direction === "all" ? "All directions" : `${experiment.direction} only`} · {experiment.lookback_months / 12} years</p><p className="research-panel-copy">{experiment.sessions.join(" + ")} · Version {experiment.experiment_version} · News not evaluated</p><div className="research-compare-grid">{[["Resolved sample", experiment.summary.reference.sample_size, experiment.summary.executable.sample_size, optionalSample(experimentConservative)], ["Win rate", percent(experiment.summary.reference.win_rate), percent(experiment.summary.executable.win_rate), optionalPercent(experimentConservative)], ["Average R", rValue(experiment.summary.reference.average_r), rValue(experiment.summary.executable.average_r), optionalR(experimentConservative, "average_r")], ["Profit factor", experiment.summary.reference.profit_factor === null ? "—" : experiment.summary.reference.profit_factor.toFixed(2), experiment.summary.executable.profit_factor === null ? "—" : experiment.summary.executable.profit_factor.toFixed(2), optionalProfitFactor(experimentConservative)], ["Drawdown", rValue(experiment.summary.reference.drawdown_r), rValue(experiment.summary.executable.drawdown_r), optionalR(experimentConservative, "drawdown_r")]].map(([label, baseline, filtered, conservative]) => <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><ResearchInlineStat label="Same-range baseline" value={baseline} /><ResearchInlineStat label="Experiment" value={filtered} /><ResearchInlineStat label="Experiment (conservative)" value={conservative} /></div>)}</div>{!experimentConservative && <p className="mt-4 text-xs text-[color:var(--muted)]">Conservative outcomes were not recorded when this older experiment was saved. Its resolved-only result remains available.</p>}<p className="research-footnote !px-0">Eligible raw setups: {experiment.summary.raw_candidates} · Executable: {experiment.summary.executable_candidates} · Overlapping: {experiment.summary.overlapping_candidates} · Target first: {experiment.summary.target_first} · Stop first: {experiment.summary.stop_first} · Unresolved: {experiment.summary.unresolved} · Ambiguous: {experiment.summary.ambiguous}</p><div className="mt-5 border-t border-[color:var(--border)] pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="research-panel-title">Research decision</p><p className="research-panel-copy">Status: <b className={experiment.decision === "approved" ? "text-[color:var(--accent)]" : experiment.decision === "rejected" ? "text-[color:var(--danger)]" : "text-[color:var(--muted)]"}>{experiment.decision}</b>{experiment.decided_at ? ` · saved ${new Date(experiment.decided_at).toLocaleDateString()}` : ""}</p></div></div><label className="mt-3 block"><span className="research-field-label">Decision note</span><textarea aria-label="Experiment decision note" value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="Explain why this experiment is approved or rejected." className="mt-2 min-h-24 w-full resize-y rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] px-3 py-2 text-sm outline-none" /></label><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => saveExperimentDecision("rejected")} disabled={savingDecision} className="rounded-xl border border-[color:var(--danger)] px-4 py-2 text-sm font-semibold text-[color:var(--danger)] disabled:opacity-50">Reject</button><button type="button" onClick={() => saveExperimentDecision("pending")} disabled={savingDecision} className="research-secondary-btn">Mark pending</button><button type="button" onClick={() => saveExperimentDecision("approved")} disabled={savingDecision || holdout?.status !== "complete"} title={holdout?.status === "complete" ? "Record approval only; this does not change Signals." : "Complete the locked holdout before approval."} className="research-primary-btn">Approve</button></div><p className="mt-2 text-xs text-[color:var(--muted)]">Approval records a research decision only. It never changes the Signals strategy automatically.</p></div></div>}
      </section>
      {experiment && <section className="app-card p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <ResearchSectionHead title="Locked earlier holdout" description="Downloads the equally long period immediately before this experiment and replays its saved pair, direction, sessions, and one-position rule without allowing edits." />
          <button type="button" onClick={startLockedHoldout} disabled={startingHoldout || holdoutWorking || holdout?.status === "complete"} className="research-primary-btn">{startingHoldout ? "Locking holdout…" : holdoutWorking ? "Holdout running" : holdout?.status === "complete" ? "Holdout complete" : holdout?.status === "failed" ? "Retry locked holdout" : "Start locked holdout"}</button>
        </div>
        {holdout ? <div className="research-panel mt-5"><p className="research-panel-title">{holdout.instrument.replace("_", "/")} · {holdout.direction === "all" ? "All directions" : `${holdout.direction} only`} · locked before development data</p><p className="research-panel-copy">{new Date(holdout.range_start).toISOString().slice(0, 10)} to {new Date(holdout.range_end).toISOString().slice(0, 10)} · {holdout.sessions.join(" + ")} · News not evaluated</p>{holdoutWorking && <><div className="mt-4 h-2 overflow-hidden rounded-full bg-[color:var(--border)]"><div className="h-full rounded-full bg-[color:var(--accent)] transition-[width] duration-500" style={{ width: `${holdoutRun?.details.progressPercent ?? 0}%` }} /></div><p className="mt-2 text-xs text-[color:var(--muted)]">{holdoutRun?.details.phase ?? "Starting locked holdout"} · {holdoutRun?.details.progressPercent ?? 0}%</p></>}{holdout.status === "failed" && <p className="mt-4 text-sm text-[color:var(--danger)]">{holdout.error ?? holdoutRun?.error ?? "The locked holdout failed."}</p>}{holdout.summary && <><div className="research-compare-grid mt-5">{[["Resolved sample", holdout.summary.executable.sample_size, optionalSample(holdoutConservative)], ["Win rate", percent(holdout.summary.executable.win_rate), optionalPercent(holdoutConservative)], ["Average R", rValue(holdout.summary.executable.average_r), optionalR(holdoutConservative, "average_r")], ["Profit factor", holdout.summary.executable.profit_factor === null ? "—" : holdout.summary.executable.profit_factor.toFixed(2), optionalProfitFactor(holdoutConservative)], ["Drawdown", rValue(holdout.summary.executable.drawdown_r), optionalR(holdoutConservative, "drawdown_r")]].map(([label, metric, conservative]) => <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><ResearchInlineStat label="Resolved only" value={metric} /><ResearchInlineStat label="Conservative" value={conservative} /></div>)}</div>{!holdoutConservative && <p className="mt-4 text-xs text-[color:var(--muted)]">Conservative outcomes were not recorded when this older holdout was saved.</p>}<p className="research-footnote !px-0">Eligible raw setups: {holdout.summary.raw_candidates} · Executable: {holdout.summary.executable_candidates} · Overlapping: {holdout.summary.overlapping_candidates} · Target first: {holdout.summary.target_first} · Stop first: {holdout.summary.stop_first} · Unresolved: {holdout.summary.unresolved} · Ambiguous: {holdout.summary.ambiguous}</p></>}</div> : <p className="mt-4 text-sm text-[color:var(--muted)]">This is the honest next test: it uses older OANDA history that was not part of the experiment you selected.</p>}
      </section>}
      <section className="app-card p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <ResearchSectionHead
            title="Locked day-trading validation"
            description="Uses the active day strategy exactly as written: four years of development history, followed by one final locked out-of-sample year. No filters are selected from the data."
          />
          <button type="button" onClick={runWalkForward} disabled={runningWalkForward || working} className="research-primary-btn">
            {runningWalkForward ? "Running validation…" : "Run 4-year / 1-year validation"}
          </button>
        </div>
        {walkForward ? <div className="research-panel mt-5">
          <p className="research-panel-title">Latest locked validation · {walkForward.instrument.replace("_", "/")}</p>
          <p className="research-panel-copy">Four-year development history · final one-year out-of-sample test · active day-intraday-v1 only</p>
          <div className="research-compare-grid mt-5">
            {[["Resolved sample", walkForward.summary.aggregate.sample_size], ["Win rate", percent(walkForward.summary.aggregate.win_rate)], ["Average R", rValue(walkForward.summary.aggregate.average_r)], ["Profit factor", walkForward.summary.aggregate.profit_factor === null ? "—" : walkForward.summary.aggregate.profit_factor.toFixed(2)], ["Drawdown", rValue(walkForward.summary.aggregate.drawdown_r)]].map(([label, metric]) => <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{label}</p><p className="metric-number mt-2 text-lg">{metric}</p></div>)}
          </div>
          {walkForward.summary.validation_status ? <p className={`mt-4 text-sm font-semibold ${walkForward.summary.validation_status === "passed" ? "text-[color:var(--accent)]" : walkForward.summary.validation_status === "failed" ? "text-[color:var(--danger)]" : "text-[color:var(--muted)]"}`}>Automatic status: {walkForward.summary.validation_status.replace("_", " ")} · Forced session exits: {walkForward.summary.forced_session_exits ?? 0}</p> : null}
          <div className="mt-5 border-t border-[color:var(--border)] pt-5">
            <p className="research-panel-title">Execution stress</p>
            <p className="research-panel-copy">A simple adverse-cost check applied only to walk-forward trades. It deducts extra cost from each resolved trade; it is not a full fill simulation.</p>
            <div className="research-compare-grid mt-4">
              {walkForward.summary.stress.map((stress) => <div key={stress.extra_pips} className="research-compare-item"><p className="research-compare-label">+{stress.extra_pips.toFixed(1)} pip per trade</p><ResearchInlineStat label="Resolved" value={stress.metrics.sample_size} /><ResearchInlineStat label="Average R" value={rValue(stress.metrics.average_r)} /><ResearchInlineStat label="Profit factor" value={stress.metrics.profit_factor === null ? "—" : stress.metrics.profit_factor.toFixed(2)} /><ResearchInlineStat label="Drawdown" value={rValue(stress.metrics.drawdown_r)} /></div>)}
            </div>
          </div>
          <p className="research-footnote !px-0">{walkForward.summary.warning}</p>
          <div className="research-table-wrap mt-5"><table className="research-table min-w-[58rem]"><thead><tr>{["Training", "Test", "Selected filter", "Test sample", "Test avg R", "Test PF"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{walkForward.summary.folds.map((fold) => <tr key={`${fold.train_start}-${fold.test_start}`}><td className="whitespace-nowrap">{fold.train_start.slice(0, 10)} → {fold.train_end.slice(0, 10)}</td><td className="whitespace-nowrap">{fold.test_start.slice(0, 10)} → {fold.test_end.slice(0, 10)}</td>{fold.selected ? <><td>{fold.selected.direction === "all" ? "All directions" : `${fold.selected.direction} only`} · {fold.selected.sessions.join(" + ")}</td><td>{fold.selected.test.sample_size}</td><td>{rValue(fold.selected.test.average_r)}</td><td>{fold.selected.test.profit_factor === null ? "—" : fold.selected.test.profit_factor.toFixed(2)}</td></> : <><td className="text-[color:var(--muted)]">No eligible training filter</td><td>0</td><td>—</td><td>—</td></>}</tr>)}</tbody></table></div>
        </div> : <p className="mt-4 text-sm text-[color:var(--muted)]">Run this after five years of active day-strategy research is complete. It measures the final year without changing strategy rules or selecting filters.</p>}
      </section>
      {experiment && <>
        {experimentDiagnostics && <section className="app-card p-5 md:p-6"><ResearchSectionHead title="Experiment stability" description="Accepted trades only. Small yearly samples are descriptive evidence, not proof of a stable edge." /><div className="research-split-grid mt-5">{[{ title: "Year", rows: experimentDiagnostics.breakdowns.year }, { title: "Session", rows: experimentDiagnostics.breakdowns.session }].map((group) => <div key={group.title}><h3 className="research-section-title">{group.title}</h3><div className="research-table-wrap mt-3"><table className="research-table min-w-[30rem]"><thead><tr>{["Group", "Sample", "Win rate", "Avg R", "PF", "DD"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{group.rows.map((row) => <tr key={row.name}><td className="font-medium">{row.name}</td><td>{row.sample_size}</td><td>{percent(row.win_rate)}</td><td>{rValue(row.average_r)}</td><td>{row.profit_factor === null ? "—" : row.profit_factor.toFixed(2)}</td><td>{rValue(row.drawdown_r)}</td></tr>)}</tbody></table></div></div>)}</div></section>}
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="app-card p-5 md:p-6">
            <ResearchSectionHead title="Equity progression" description="Cumulative result in R for accepted experiment trades." />
            <div className="mt-4"><ExperimentEquityChart series={experimentEquity} loading={experimentDiagnosticsLoading} /></div>
            <div className="research-meta-row">{experimentDiagnosticsLoading ? <><span className="inline-flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-[color:var(--accent)]" />Loading trades…</span><span>Ending result <b className="text-[color:var(--foreground)]">—</b></span></> : <><span>{experimentEquity.length} resolved trades</span><span>Ending result <b className="text-[color:var(--foreground)]">{rValue(experimentEquity.at(-1)?.cumulativeR ?? null)}</b></span></>}</div>
          </section>
          {experimentDiagnostics ? <section className="app-card p-5 md:p-6"><ResearchSectionHead title="Retrospective time split" description={experimentDiagnostics.retrospective.warning} descriptionClassName="text-[color:var(--danger)]" /><div className="research-mini-grid">{[["Earlier history", experimentDiagnostics.retrospective.development], [`Final year from ${new Date(experimentDiagnostics.retrospective.cutoff).toISOString().slice(0, 10)}`, experimentDiagnostics.retrospective.finalYear]].map(([label, period]) => { const periodMetrics = period as ExperimentMetricSet; return <div key={String(label)} className="research-compare-item"><p className="research-compare-label">{String(label)}</p><ResearchInlineStat label="Resolved" value={periodMetrics.sample_size} /><ResearchInlineStat label="Average R" value={rValue(periodMetrics.average_r)} /><ResearchInlineStat label="PF" value={periodMetrics.profit_factor === null ? "—" : periodMetrics.profit_factor.toFixed(2)} /><ResearchInlineStat label="Drawdown" value={rValue(periodMetrics.drawdown_r)} /></div>; })}</div></section> : <section className="app-card p-5 md:p-6"><ResearchSectionHead title="Retrospective time split" /><div className="research-mini-grid">{[0, 1].map((slot) => <div key={slot} className="research-compare-item"><div className="h-3 w-24 animate-pulse rounded bg-[color:var(--surface-raised)]" /><div className="mt-4 space-y-2">{[0, 1, 2, 3].map((row) => <div key={row} className="h-3 animate-pulse rounded bg-[color:var(--surface-raised)]" style={{ width: `${88 - row * 8}%` }} />)}</div></div>)}</div></section>}
        </div>
        {experimentDiagnostics && <section className="app-card p-5 md:p-6"><ResearchSectionHead title="Experiment trade audit" description="Accepted trades enter experiment metrics. Overlapping setups remain visible but are excluded." /><div className="research-table-wrap mt-5"><table className="research-table min-w-[72rem]"><thead><tr>{["Date (UTC)", "Execution", "Session", "Side", "Entry", "Stop", "Target", "Plan", "Spread", "Outcome", "Result", "MFE", "MAE", "Exit (UTC)"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{experimentDiagnostics.audit.map((trade) => <tr key={trade.candidateId}><td className="whitespace-nowrap">{trade.decisionTime.replace("T", " ").slice(0, 16)}</td><td className="font-medium capitalize">{trade.executionStatus}</td><td className="whitespace-nowrap">{trade.session}</td><td className="capitalize">{trade.direction}</td><td>{price(trade.entry, pair)}</td><td>{price(trade.stop, pair)}</td><td>{price(trade.target, pair)}</td><td>{trade.plannedR.toFixed(2)}R</td><td>{trade.spreadPips.toFixed(1)}p</td><td className="whitespace-nowrap">{outcomeLabel(trade.outcome)}</td><td>{rValue(trade.resultR)}</td><td>{rValue(trade.mfeR)}</td><td>{rValue(trade.maeR)}</td><td className="whitespace-nowrap">{trade.simulatedExitAt ? trade.simulatedExitAt.replace("T", " ").slice(0, 16) : "—"}</td></tr>)}</tbody></table></div></section>}
      </>}
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Condition funnel" description="Cumulative required conditions in strategy order. News is excluded because it was not evaluated." />
        <div className="mt-5 space-y-3">{diagnostics?.funnel.length ? diagnostics.funnel.map((stage) => <div key={stage.name} className="research-funnel-row"><div className="text-sm font-medium">{stage.name}</div><div className="research-funnel-bar"><div style={{ width: `${Math.max(0, Math.min(100, (stage.totalRate ?? 0) * 100))}%` }} /></div><div className="text-xs text-[color:var(--muted)] sm:text-right">{stage.count.toLocaleString()} · {percent(stage.totalRate)}</div></div>) : <p className="text-sm text-[color:var(--muted)]">Run research for this pair to create the funnel.</p>}</div>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="app-card p-5 md:p-6">
          <ResearchSectionHead title="Near misses" description="Only evaluations that reached the final risk/reward stage qualify." />
          <div className="mt-4">{diagnostics?.nearMisses.length ? diagnostics.nearMisses.map((item) => <div key={item.condition} className="research-list-row"><span>{item.condition}</span><b>{item.count.toLocaleString()}</b></div>) : <p className="text-sm text-[color:var(--muted)]">No one-condition near misses are available.</p>}</div>
        </section>
        <section className="app-card p-5 md:p-6">
          <ResearchSectionHead title="Trade excursion" description="MFE and MAE measured in initial-risk units before the recorded outcome." />
          <div className="research-mini-grid">{[["Average MFE", diagnostics?.excursion.averageMfeR ?? null], ["Median MFE", diagnostics?.excursion.medianMfeR ?? null], ["Average MAE", diagnostics?.excursion.averageMaeR ?? null], ["Median MAE", diagnostics?.excursion.medianMaeR ?? null]].map(([label, metric]) => <div key={String(label)} className="research-compare-item"><p className="research-stat-label">{label}</p><p className="research-stat-value metric-number">{rValue(metric as number | null)}</p></div>)}</div>
          <p className="research-meta-row">Labeled candidates: {diagnostics?.excursion.sampleSize ?? 0}</p>
        </section>
      </div>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Shadow outcomes" description="Hypothetical audit only. Each group failed exactly the named rule and was never a valid setup or order." />
        <div className="research-table-wrap mt-5"><table className="research-table min-w-[54rem]"><thead><tr><th>Failed condition</th><th>Rejected</th><th>Resolved</th><th>Win rate</th><th>Average R</th><th>Profit factor</th><th>Unresolved</th><th>Cons. sample</th><th>Cons. win rate</th><th>Cons. avg R</th></tr></thead><tbody>{diagnostics?.shadow?.byCondition.map((row) => <tr key={row.name}><td className="font-medium">{row.name}</td><td>{row.candidates}</td><td>{row.sampleSize}</td><td>{percent(row.winRate)}</td><td>{rValue(row.averageR)}</td><td>{row.profitFactor === null ? "—" : row.profitFactor.toFixed(2)}</td><td>{row.unresolved}</td><td>{row.conservativeSampleSize}</td><td>{percent(row.conservativeWinRate)}</td><td>{rValue(row.conservativeAverageR)}</td></tr>)}</tbody></table>{!diagnostics?.shadow?.byCondition.length && <p className="research-table-empty">No persisted shadow outcomes are available. Run research again to label them.</p>}</div>
        <p className="research-footnote !px-0">Shadow rows are labeled raw: they never receive position-aware blocking, so compare them against the raw baseline rather than the executable one. The conservative columns count ambiguous and timed-out rejections that the resolved columns drop.</p>
      </section>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Performance breakdowns" description="Only accepted, resolved trades determine win rate, average R, and profit factor." />
        <div className="research-stack mt-5">{[{ title: "Direction", rows: diagnostics?.breakdowns.direction ?? [] }, { title: "Session", rows: diagnostics?.breakdowns.session ?? [] }, { title: "Pair comparison", rows: diagnostics?.breakdowns.pair ?? [] }, { title: "Month", rows: diagnostics?.breakdowns.month ?? [] }].map((group) => <div key={group.title}><h3 className="research-section-title">{group.title}</h3><div className="research-table-wrap mt-3"><table className="research-table min-w-[28rem]"><thead><tr><th>Group</th><th>Sample</th><th>Win rate</th><th>Avg R</th><th>PF</th></tr></thead><tbody>{group.rows.map((row) => <tr key={row.name}><td className="font-medium">{row.name.replace("_", "/")}</td><td>{row.sampleSize}</td><td>{percent(row.winRate)}</td><td>{rValue(row.averageR)}</td><td>{row.profitFactor === null ? "—" : row.profitFactor.toFixed(2)}</td></tr>)}</tbody></table></div></div>)}</div>
      </section>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title={`Candidate audit · ${selectedInstrument?.displayName ?? pair.replace("_", "/")}`} description="Accepted rows entered the position-aware baseline. Overlapping rows were blocked by an already-open simulated trade." />
        <div className="research-table-wrap mt-5"><table className="research-table min-w-[76rem]"><thead><tr>{["Date (UTC)", "Execution", "Side", "Entry", "Stop", "Target", "Plan", "Spread", "Session", "Outcome", "Result", "MFE", "MAE", "Evidence gap"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{diagnostics?.trades.map((trade) => <tr key={trade.id}><td className="whitespace-nowrap">{new Date(trade.decisionTime).toISOString().replace("T", " ").slice(0, 16)}</td><td className="font-medium capitalize">{trade.executionStatus}</td><td className="capitalize">{trade.direction}</td><td>{price(trade.entry, trade.instrument)}</td><td>{price(trade.stop, trade.instrument)}</td><td>{price(trade.target, trade.instrument)}</td><td>{trade.plannedR.toFixed(2)}R</td><td>{trade.spreadPips.toFixed(1)}p</td><td className="whitespace-nowrap">{trade.session}</td><td className="whitespace-nowrap font-medium">{outcomeLabel(trade.outcome)}</td><td>{rValue(trade.resultR)}</td><td>{rValue(trade.mfeR)}</td><td>{rValue(trade.maeR)}</td><td className="whitespace-nowrap text-[color:var(--muted)]">{trade.notEvaluated.length ? `${trade.notEvaluated.join(", ")} not evaluated` : "None"}</td></tr>)}</tbody></table>{!diagnostics?.trades.length && <p className="research-table-empty">No valid candidates are available for this pair.</p>}</div>
      </section>
      <section className="app-card p-5 md:p-6">
        <ResearchSectionHead title="Shadow audit" description="Counterfactual research evidence for full-pipeline one-rule rejections." />
        <div className="research-table-wrap mt-5"><table className="research-table min-w-[76rem]"><thead><tr>{["Date (UTC)", "Failed rule", "Side", "Entry", "Stop", "Target", "Plan", "Spread", "Session", "Outcome", "Result", "MFE", "MAE"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{diagnostics?.shadow?.trades.map((trade) => <tr key={trade.id}><td className="whitespace-nowrap">{new Date(trade.decisionTime).toISOString().replace("T", " ").slice(0, 16)}</td><td className="font-medium">{trade.failedCondition}</td><td className="capitalize">{trade.direction}</td><td>{price(trade.entry, trade.instrument)}</td><td>{price(trade.stop, trade.instrument)}</td><td>{price(trade.target, trade.instrument)}</td><td>{trade.plannedR.toFixed(2)}R</td><td>{trade.spreadPips.toFixed(1)}p</td><td className="whitespace-nowrap">{trade.session}</td><td className="whitespace-nowrap">{outcomeLabel(trade.outcome)}</td><td>{rValue(trade.resultR)}</td><td>{rValue(trade.mfeR)}</td><td>{rValue(trade.maeR)}</td></tr>)}</tbody></table>{!diagnostics?.shadow?.trades.length && <p className="research-table-empty">No shadow trades are available for this pair.</p>}</div>
      </section>
    </div>
  );
}
