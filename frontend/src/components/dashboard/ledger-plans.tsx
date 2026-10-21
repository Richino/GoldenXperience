"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { PlanConfirm, type PlanConfirmRequest } from "@/components/dashboard/plan-confirm";
import { JOB_RUNNING, STATUS_LABEL, researchJobWaitingForCalendar, tradePlansApi, type Lean, type MarketIntelligence, type ResearchJob, type TradePlan } from "@/lib/trade-plans/api";
import { FORWARD_LABEL, type MarketStateView } from "@/lib/trade-plans/market-state";

/**
 * Home: your trade plans, beside Pending and Open positions. A pair you
 * pressed Analyze on shows as Generating (with the real job stage) while its
 * research runs and the plans are built; then its plans appear to review;
 * accepted plans stay while GX watches them. Each pair carries a one-line
 * read from its stored research — no extra AI call. Everything opens that
 * pair's Analyze.
 */

const PLANS_CHANGED = "gx-trade-plans-changed";
const DONE_FAILED: ResearchJob["status"][] = ["FAILED", "EXPIRED", "CANCELLED"];
/** The job stages in order; "Building plans" is a completed job whose plans are not stored yet. */
const STEPS = ["Queued", "Researching", "Checking", "Building plans"] as const;
const stepOf = (job: ResearchJob) => (job.status === "QUEUED" ? 0 : job.status === "RESEARCHING" ? 1 : job.status === "VALIDATING" ? 2 : 3);
const LEAN: Record<Lean, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral", unresolved: "Unresolved" };
const SUMMARY_TTL_MS = 5 * 60_000;

type Row =
  | { kind: "generating"; instrument: string; job: ResearchJob }
  | { kind: "failed"; instrument: string; job: ResearchJob }
  | { kind: "completed"; instrument: string; job: ResearchJob }
  | { kind: "review"; instrument: string; plans: TradePlan[] }
  | { kind: "watching"; instrument: string; plans: TradePlan[] };

type Brief = { text: string; nearTerm: Lean | null; swing: Lean | null; researchedAt: string; fresh: boolean; marketState?: MarketStateView | null };

function ago(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** The first sentence of the research's own read, kept short. */
export function briefOf(report: MarketIntelligence): string {
  const source = (report.assessment?.rationale || report.summary || "").replace(/\s+/g, " ").trim();
  // Drop the model's boilerplate disclaimers ("…, not a price forecast."): the card already says what this is.
  const sentences = (source.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [source])
    .map((sentence) => sentence.replace(/,?\s*(?:and\s+)?not an? (?:price )?(?:forecast|prediction)/gi, "").trim())
    .filter((sentence) => sentence && !/^this is (?:an? )?(?:evidence|research)/i.test(sentence) && !/no (?:trade direction|price prediction)/i.test(sentence));
  const first = sentences[0] ?? source;
  return first.length > 150 ? `${first.slice(0, 147).trimEnd()}…` : first;
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
    // A completed analysis is still a result when no trade qualified. Keep it
    // visible until dismissed. PLANS without awaiting rows were removed or
    // expired and must not be resurrected as a completed research card.
    if (!seen.has(instrument) && job.status === "COMPLETED" && job.plans
      && ["NO_VALID_SETUP", "TECHNICAL_DATA_UNAVAILABLE", "DATA_VALIDATION_FAILED", "ERROR"].includes(job.plans.result)) {
      rows.push({ kind: "completed", instrument, job });
      seen.add(instrument);
    }
    const recent = now - Date.parse(job.completedAt ?? job.createdAt) < 6 * 3_600_000;
    if (!seen.has(instrument) && DONE_FAILED.includes(job.status) && recent) rows.push({ kind: "failed", instrument, job });
  }
  return rows;
}

/**
 * A price range with the part both ends share faded in the second number,
 * so the digits that differ stand out: 158.726 – 158.7·82. Both prices stay
 * complete, so nothing can be misread.
 */
export function splitShared(low: string, high: string) {
  let shared = 0;
  while (shared < low.length && shared < high.length && low[shared] === high[shared]) shared += 1;
  // Keep at least two characters of the second price in full weight.
  shared = Math.min(shared, Math.max(0, high.length - 2));
  return { shared: high.slice(0, shared), rest: high.slice(shared) };
}

function ZoneRange({ low, high }: { low: string; high: string }) {
  const { shared, rest } = splitShared(low, high);
  return (
    <span className="nl-plan-zone metric-number" aria-label={`${low} to ${high}`}>
      <span aria-hidden="true">{low}<i>–</i>{shared ? <span className="nl-plan-shared">{shared}</span> : null}{rest}</span>
    </span>
  );
}

function Sides({ plans }: { plans: TradePlan[] }) {
  return (
    <ul className="nl-plan-sides">
      {[...plans].sort((a, b) => b.entryZoneHigh - a.entryZoneHigh).map((plan) => {
        const digits = precisionFor(plan.instrument);
        const f = (value: number | null) => (value === null ? "—" : value.toFixed(digits));
        return (
          <li key={plan.id} data-side={plan.direction}>
            <span className="nl-plan-side">{plan.direction}</span>
            <ZoneRange low={f(plan.entryZoneLow)} high={f(plan.entryZoneHigh)} />
            <span className="nl-plan-rr metric-number">{plan.rewardRisk?.toFixed(1) ?? "—"}<small>R</small></span>
            <span className="nl-plan-sl metric-number">SL {f(plan.stopLoss)} · TP {f(plan.takeProfit)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Read({ brief, loading }: { brief: Brief | undefined; loading: boolean }) {
  if (!brief) {
    return loading ? (
      <div className="nl-plan-read is-loading" aria-hidden="true"><span /><span /></div>
    ) : null;
  }
  return (
    <div className="nl-plan-read">
      <p>
        <Sparkles aria-hidden="true" className="nl-plan-spark" />
        <span className="sr-only">Research read: </span>
        {brief.text}
      </p>
      {brief.marketState ? <p className="nl-plan-leans">
        {brief.marketState.usable ? <><span>Near term {FORWARD_LABEL[brief.marketState.snapshot.forward.shortTerm.classification]}</span><span>Swing {FORWARD_LABEL[brief.marketState.snapshot.forward.swing.classification]}</span></> : <span className="is-stale">Current interpretation unavailable</span>}
        <span className={brief.fresh ? undefined : "is-stale"}>{brief.fresh ? `Researched ${ago(brief.researchedAt)}` : "Research out of date"}</span>
      </p> : brief.nearTerm || brief.swing ? (
        <p className="nl-plan-leans">
          {brief.nearTerm ? <span data-lean={brief.nearTerm}>Near term {LEAN[brief.nearTerm]}</span> : null}
          {brief.swing ? <span data-lean={brief.swing}>Swing {LEAN[brief.swing]}</span> : null}
          <span className={brief.fresh ? undefined : "is-stale"}>{brief.fresh ? `Researched ${ago(brief.researchedAt)}` : "Research out of date"}</span>
        </p>
      ) : null}
    </div>
  );
}

export function LedgerPlans() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [briefs, setBriefs] = useState<Record<string, Brief>>({});
  /** Pairs whose research has been looked up (with or without a read). */
  const [checked, setChecked] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  const pollingActive = useRef(true);
  const lastLoadedAt = useRef(0);
  /** The Cancel or Remove waiting for confirmation. */
  const [confirm, setConfirm] = useState<PlanConfirmRequest | null>(null);
  const fetchedAt = useRef<Record<string, number>>({});
  const researchVersions = useRef<Record<string, string>>({});

  const loadBriefs = useCallback(async (instruments: string[]) => {
    const due = instruments.filter((instrument) => Date.now() - (fetchedAt.current[instrument] ?? 0) > SUMMARY_TTL_MS);
    if (!due.length) return;
    for (const instrument of due) fetchedAt.current[instrument] = Date.now();
    const results = await Promise.all(due.map((instrument) => tradePlansApi.research(instrument).then((result) => [instrument, result] as const).catch(() => null)));
    setBriefs((current) => {
      const next = { ...current };
      for (const entry of results) {
        const report = entry?.[1].research?.report;
        if (!entry || !report?.schemaVersion) continue;
        next[entry[0]] = {
          text: entry[1].marketState ? entry[1].marketState.usable ? entry[1].marketState.snapshot.summary : `Market interpretation unavailable: ${entry[1].marketState.reasons[0] ?? "data checks did not pass"}` : briefOf(report),
          marketState: entry[1].marketState,
          nearTerm: report.assessment?.nearTermLean ?? null,
          swing: report.assessment?.swingLean ?? null,
          researchedAt: entry[1].research!.createdAt,
          fresh: entry[1].research!.fresh,
        };
      }
      return next;
    });
    setChecked((current) => ({ ...current, ...Object.fromEntries(due.map((instrument) => [instrument, true as const])) }));
  }, []);

  const load = useCallback(async () => {
    try {
      const [jobs, awaiting, active] = await Promise.all([
        tradePlansApi.researchJobs().then((result) => result.jobs).catch(() => [] as ResearchJob[]),
        tradePlansApi.list("awaiting"),
        tradePlansApi.list("active"),
      ]);
      const next = planRows(jobs, awaiting, active);
      pollingActive.current = jobs.some(job => JOB_RUNNING.includes(job.status) || job.status === "COMPLETED" && !job.plans)
        || awaiting.length > 0 || active.length > 0;
      for (const job of jobs) {
        if (job.status !== "COMPLETED" || !job.researchId || researchVersions.current[job.instrument] === job.researchId) continue;
        researchVersions.current[job.instrument] = job.researchId;
        fetchedAt.current[job.instrument] = 0;
      }
      setRows(next);
      setError(null);
      lastLoadedAt.current = Date.now();
      void loadBriefs(next.filter((row) => row.kind === "review" || row.kind === "watching" || row.kind === "completed").map((row) => row.instrument));
    } catch {
      setError("Plans could not be loaded. Retrying…");
    }
  }, [loadBriefs]);

  useEffect(() => {
    let busy = false;
    let stopped = false;
    let refreshPending = false;
    const changed = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (busy) { refreshPending = true; return; }
      busy = true;
      refreshPending = false;
      try { await load(); } finally {
        busy = false;
        if (refreshPending && !stopped) void changed();
      }
    };
    const first = window.setTimeout(() => void changed(), 0);
    const timer = window.setInterval(() => {
      if (pollingActive.current || Date.now() - lastLoadedAt.current >= 60_000) void changed();
    }, 10_000);
    window.addEventListener(PLANS_CHANGED, changed);
    document.addEventListener("visibilitychange", changed);
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void changed(); };
    window.addEventListener("pageshow", restored);
    return () => {
      stopped = true;
      window.clearTimeout(first); window.clearInterval(timer);
      window.removeEventListener(PLANS_CHANGED, changed);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("pageshow", restored);
    };
  }, [load]);

  /** Ask first; the action runs (and the list reloads) only after the user confirms. */
  const ask = (request: Omit<PlanConfirmRequest, "run"> & { work: () => Promise<unknown> }) =>
    setConfirm({ ...request, run: async () => { await request.work(); await load(); } });

  const count = rows?.length ?? 0;
  return (
    <section className="nl-card nl-plans" aria-labelledby="nl-plans-title" aria-busy={rows === null}>
      <div className="nl-card-head">
        <h2 id="nl-plans-title">Plans</h2>
        <span className="nl-card-meta metric-number">{count} {count === 1 ? "pair" : "pairs"}</span>
      </div>
      {rows === null ? (
        <div className="nl-plan-read is-loading" aria-hidden="true"><span /><span /></div>
      ) : rows.length ? (
        <div className="nl-plan-list">
          {rows.map((row) => {
            const pair = displayNameFor(row.instrument);
            const href = `/chart?instrument=${encodeURIComponent(row.instrument)}&analyze=1`;
            if (row.kind === "generating") {
              const step = stepOf(row.job);
              const waitingForCalendar = researchJobWaitingForCalendar(row.job);
              return (
                <article key={`g-${row.instrument}`} className="nl-plan" data-kind="generating">
                  <Link href={href} className="nl-plan-head">
                    <b>{pair}</b>
                    <span className="nl-plan-state is-generating"><span className="nl-plan-dot" aria-hidden="true" />{waitingForCalendar ? "Waiting for calendar" : "Generating"}</span>
                  </Link>
                  <ol className="nl-plan-steps" aria-label="Progress">
                    {STEPS.map((label, index) => (
                      <li key={label} data-state={index < step ? "done" : index === step ? "now" : "next"} aria-current={index === step ? "step" : undefined}>{waitingForCalendar && index === 0 ? "Calendar" : label}</li>
                    ))}
                  </ol>
                  {!waitingForCalendar ? <div className="nl-plan-read is-loading" aria-hidden="true"><span /><span /></div> : null}
                  <div className="nl-plan-bottom">
                  <p className="nl-plan-foot">{waitingForCalendar
                    ? `The economic calendar is temporarily unavailable. Retrying automatically; GPT research has not started. Queued ${ago(row.job.createdAt)}.`
                    : <>{row.job.error ? `${row.job.error} ` : ""}Started {ago(row.job.startedAt ?? row.job.createdAt)}. We&apos;ll notify you when the plans are ready.</>}</p>
                    {JOB_RUNNING.includes(row.job.status) ? (
                      <button type="button" className="nl-plan-cta is-quiet" aria-label={`Cancel the ${pair} research`} onClick={() => ask({
                        eyebrow: `Plans · ${pair}`, title: `Cancel the ${pair} research?`,
                        body: "The research stops now and no plans are built. You can analyze the pair again later.",
                        keepLabel: "Keep researching", confirmLabel: "Cancel research", busyLabel: "Cancelling…",
                        work: () => tradePlansApi.cancelResearch(row.job.id),
                      })}>
                        Cancel
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            }
            if (row.kind === "failed") {
              return (
                <article key={`f-${row.instrument}`} className="nl-plan" data-kind="failed">
                  <Link href={href} className="nl-plan-head">
                    <b>{pair}</b>
                    <span className="nl-plan-state is-failed">Not generated</span>
                  </Link>
                  <p className="nl-plan-foot">{row.job.error ?? "The research did not finish."} No plans were built.</p>
                  <div className="nl-plan-actions">
                    <Link href={`/chart?instrument=${encodeURIComponent(row.instrument)}`} className="nl-plan-cta">Try again <ArrowUpRight aria-hidden="true" /></Link>
                    <button type="button" className="nl-plan-cta is-quiet" aria-label={`Remove ${pair} from Plans`} onClick={() => ask({
                      eyebrow: `Plans · ${pair}`, title: `Remove ${pair} from Plans?`,
                      body: "This clears the unfinished research from your Plans. Nothing else changes.",
                      keepLabel: "Keep it", confirmLabel: "Remove", busyLabel: "Removing…",
                      work: () => tradePlansApi.dismissResearch(row.job.id),
                    })}>
                      Remove
                    </button>
                  </div>
                </article>
              );
            }
            if (row.kind === "review") {
              const conditional = row.plans.some((plan) => plan.plan.entryReadiness?.status === "WAITING_FOR_RISK_REWARD");
              return (
                <article key={`r-${row.instrument}`} className="nl-plan" data-kind="review">
                  <Link href={href} className="nl-plan-head">
                    <b>{pair}</b>
                    <span className="nl-plan-state is-review">{conditional ? "Conditional plans" : "Ready to review"}</span>
                  </Link>
                  <Read brief={briefs[row.instrument]} loading={!checked[row.instrument]} />
                  <Sides plans={row.plans} />
                  {conditional ? <p className="nl-plan-foot">Each side needs its own confirmation and at least {row.plans.find((plan) => plan.plan.entryReadiness)?.plan.entryReadiness?.minRewardRisk ?? 1.5}R at entry.{new Set(row.plans.map((plan) => plan.direction)).size > 1 ? " If one invalidates, the other remains available." : ""}</p> : null}
                  <div className="nl-plan-bottom">
                    <span className="nl-plan-foot">Built {ago(row.plans[0]!.createdAt)} · nothing is watched until you accept</span>
                    <div className="nl-plan-actions">
                      {/* Remove declines these plans (recorded as rejected); nothing was being watched. */}
                      <button type="button" className="nl-plan-cta is-quiet" aria-label={`Remove the ${pair} plans`} onClick={() => ask({
                        eyebrow: `Plans · ${pair}`, title: `Remove the ${pair} plans?`,
                        body: `This declines the ${row.plans.map((plan) => plan.direction).join(" and ")} plan${row.plans.length > 1 ? "s" : ""}. They were not being watched and can't be restored; analyze the pair again for new ones.`,
                        keepLabel: "Keep them", confirmLabel: "Remove plans", busyLabel: "Removing…",
                        work: () => Promise.all(row.plans.map((plan) => tradePlansApi.reject(plan.id, "Removed from Plans"))),
                      })}>
                        Remove
                      </button>
                      <Link href={href} className="nl-plan-cta is-primary">Review <ArrowUpRight aria-hidden="true" /></Link>
                    </div>
                  </div>
                </article>
              );
            }
            if (row.kind === "completed") {
              const noSetup = row.job.plans?.result === "NO_VALID_SETUP";
              return (
                <article key={`c-${row.instrument}`} className="nl-plan" data-kind="completed">
                  <Link href={href} className="nl-plan-head">
                    <b>{pair}</b>
                    <span className="nl-plan-state is-review">{noSetup ? "No valid setup" : "Analysis incomplete"}</span>
                  </Link>
                  <Read brief={briefs[row.instrument]} loading={!checked[row.instrument]} />
                  <p className="nl-plan-foot">{noSetup ? "Research finished. No trade setup met the rules; review the analysis for details." : row.job.plans?.reason ?? "Research finished, but plans could not be built. Open the analysis for details."}</p>
                  <div className="nl-plan-bottom">
                    <span className="nl-plan-foot">Completed {ago(row.job.completedAt ?? row.job.createdAt)}</span>
                    <div className="nl-plan-actions">
                      <button type="button" className="nl-plan-cta is-quiet" aria-label={`Remove ${pair} from Plans`} onClick={() => ask({
                        eyebrow: `Plans · ${pair}`, title: `Remove ${pair} from Plans?`,
                        body: "This removes the completed analysis from Home. The saved research remains available on the chart.",
                        keepLabel: "Keep it", confirmLabel: "Remove", busyLabel: "Removing…",
                        work: () => tradePlansApi.dismissResearch(row.job.id),
                      })}>Remove</button>
                      <Link href={href} className="nl-plan-cta is-primary">Review <ArrowUpRight aria-hidden="true" /></Link>
                    </div>
                  </div>
                </article>
              );
            }
            const lead = row.plans.find((plan) => plan.status !== "MONITORING" && plan.status !== "APPROVED") ?? row.plans[0]!;
            const auto = row.plans.some((plan) => plan.monitoringMode === "AUTO");
            return (
              <article key={`w-${row.instrument}`} className="nl-plan" data-kind="watching">
                <Link href={href} className="nl-plan-head">
                  <b>{pair}</b>
                  <span className="nl-plan-state is-watching">{lead.status === "MONITORING" || lead.status === "APPROVED" ? "Watching" : STATUS_LABEL[lead.status]}</span>
                </Link>
                <Read brief={briefs[row.instrument]} loading={!checked[row.instrument]} />
                <Sides plans={row.plans} />
                <div className="nl-plan-bottom">
                  <span className="nl-plan-foot">{auto ? "Auto trade" : "Alert me"} · {lead.notTriggeredReason ?? "Checking the conditions."}</span>
                  <div className="nl-plan-actions">
                    {/* Remove stops watching (plans already sending an order or in a trade are left alone). */}
                    {row.plans.some((plan) => ["APPROVED", "MONITORING", "CONFIRMED", "NOTIFIED"].includes(plan.status)) ? (
                      <button type="button" className="nl-plan-cta is-quiet" aria-label={`Remove the ${pair} plans`} onClick={() => ask({
                        eyebrow: `Plans · ${pair}`, title: `Stop watching ${pair}?`,
                        body: "GX stops watching these plans and nothing is placed from them. Their history, results and research stay saved; any trade already open or being placed is not touched.",
                        keepLabel: "Keep watching", confirmLabel: "Remove plans", busyLabel: "Removing…",
                        work: () => Promise.all(row.plans
                          .filter((plan) => ["APPROVED", "MONITORING", "CONFIRMED", "NOTIFIED"].includes(plan.status))
                          .map((plan) => tradePlansApi.cancel(plan.id, "Removed from Plans"))),
                      })}>
                        Remove
                      </button>
                    ) : null}
                    <Link href={href} className="nl-plan-cta is-primary">Open <ArrowUpRight aria-hidden="true" /></Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="nl-card-empty">No plans yet. Press Analyze on a chart: GX researches the pair, then builds its BUY and SELL plans here.</p>
      )}
      {error ? <p className="nl-card-empty is-warn" role="status">{error}</p> : null}
      <PlanConfirm request={confirm} onDone={() => setConfirm(null)} />
    </section>
  );
}
