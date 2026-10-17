"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { JOB_RUNNING, researchJobWaitingForCalendar, type Bias, type Lean, type MarketIntelligence, type PlanResearchContext, type ResearchFactor, type ResearchJob, type ResearchObservation, type ResearchResult, type ResearchThesis, type TradePlan } from "@/lib/trade-plans/api";
import styles from "./market-read.module.css";
import { MarketStateRead } from "./market-state-read";
import { OBSERVED_LABEL } from "@/lib/trade-plans/market-state";

/**
 * Market intelligence in the Analyze sheet (contract v2): the outlook by
 * horizon, the cited drivers for and against the pair, verified releases,
 * sentiment by source type, and gaps. Each plan shows the factors for and
 * against its own side. Research is context: it never changes plan rules.
 */

export type ResearchState = { loading: boolean; result: ResearchResult | null; error: string | null };

const BIAS_LABEL: Record<Bias, string> = { bullish: "Bullish", bearish: "Bearish", mixed: "Mixed", neutral: "Neutral", unknown: "Unknown" };
const EVIDENCE: Record<ResearchFactor["evidenceType"], string> = { verified_data: "Data", attributed_analysis: "Analysis", hypothesis: "Inference" };

function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
const local = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

function Sources({ ids, intel }: { ids: string[]; intel: MarketIntelligence }) {
  const sources = ids.map((id) => intel.sources.find((source) => source.id === id)).filter((source): source is NonNullable<typeof source> => Boolean(source));
  return (
    <span className={styles.sources}>
      {sources.slice(0, 3).map((source) => (
        <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" title={source.title ?? source.url}>
          {source.publisher}<ExternalLink aria-hidden="true" />
        </a>
      ))}
    </span>
  );
}

function Factors({ items, intel }: { items: ResearchFactor[]; intel: MarketIntelligence }) {
  return (
    <ul className={styles.points}>
      {items.map((factor) => (
        <li key={factor.id}>
          <strong>{factor.factor}</strong> <span className={styles.tag}>{factor.currency} {factor.effectOnCurrency}</span>{" "}
          <span className={styles.tag} data-kind={factor.evidenceType === "verified_data" ? "FACT" : undefined}>{EVIDENCE[factor.evidenceType]}</span>
          {factor.description ? <span className={styles.newsText}> {factor.description}</span> : null}
          {factor.uncertainty ? <span className={styles.meta}> Uncertain: {factor.uncertainty}</span> : null}
          <Sources ids={factor.sourceIds} intel={intel} />
        </li>
      ))}
    </ul>
  );
}

function Observations({ title, items, intel }: { title: string; items: ResearchObservation[]; intel: MarketIntelligence }) {
  if (!items.length) return null;
  return (
    <>
      <h5 className={styles.evHead}>{title}</h5>
      <ul className={styles.points}>
        {items.map((item) => <li key={item.text}><span className={styles.tag}>{item.stance}</span> {item.text} <Sources ids={item.sourceIds} intel={intel} /></li>)}
      </ul>
    </>
  );
}

const JOB_STATUS: Record<ResearchJob["status"], string> = {
  QUEUED: "Waiting to start", RESEARCHING: "Researching", VALIDATING: "Checking the results", COMPLETED: "Complete", FAILED: "Failed", CANCELLED: "Cancelled", EXPIRED: "Expired",
};
const LEAN_LABEL: Record<Lean, string> = { bullish: "Bullish", bearish: "Bearish", neutral: "Neutral", unresolved: "Unresolved" };

/** A running background job: only states the server has confirmed, no progress estimate. */
function JobStrip({ job, onCancel }: { job: ResearchJob; onCancel?: () => void }) {
  const waitingForCalendar = researchJobWaitingForCalendar(job);
  return (
    <div className={styles.job} role="status">
      <p className={styles.jobTitle}>{job.instrument.replace("_", "/")} — {waitingForCalendar ? "Waiting for calendar" : "Research in progress"}</p>
      <p className={styles.jobMeta}>
        Status: <strong>{waitingForCalendar ? "Waiting for calendar" : JOB_STATUS[job.status]}</strong> · Model: {job.model} · Reasoning: {job.effort} · {waitingForCalendar ? "queued" : "started"} {ago(job.startedAt ?? job.createdAt)}
      </p>
      <p className={styles.fine}>{waitingForCalendar ? "The economic calendar is temporarily unavailable. Retrying automatically; GPT research has not started." : job.error ?? (job.status === "QUEUED" ? "Waiting to start. A stalled OpenAI queue is cancelled before one automatic retry." : "Research is running in the background. You can keep using GX or close it — you'll be notified when it's ready.")}</p>
      {onCancel ? <button type="button" className={styles.cancel} onClick={onCancel}>Cancel research</button> : null}
    </div>
  );
}

/** Each side's case, whether or not a plan qualified: why it could move, what would strengthen or break it. */
function Scenario({ side, thesis }: { side: "BUY" | "SELL"; thesis: ResearchThesis }) {
  if (!thesis.hypothesis) return null;
  return (
    <div className={styles.scenario} data-side={side}>
      <h5 className={styles.evHead}>{side === "BUY" ? "If it rises — BUY case" : "If it falls — SELL case"}</h5>
      <p className={styles.text}>{thesis.hypothesis}</p>
      {thesis.strengthensIf.length ? <p className={styles.meta}>Strengthens if: {thesis.strengthensIf.join("; ")}</p> : null}
      {thesis.weakensIf.length ? <p className={styles.meta}>Weakens if: {thesis.weakensIf.join("; ")}</p> : null}
    </div>
  );
}

export function MarketRead({ state, onRefresh, onCancel }: { state: ResearchState; onRefresh: () => void; onCancel?: () => void }) {
  const research = state.result?.research ?? null;
  const intel = research?.report?.schemaVersion ? research.report : null;
  const job = state.result?.job ?? null;
  const running = Boolean(job && JOB_RUNNING.includes(job.status));
  // A run that ended badly after the research shown: say so (the last good report stays visible).
  const failedJob = job && !running && job.status !== "COMPLETED" && (!research || Date.parse(job.createdAt) > Date.parse(research.createdAt)) ? job : null;
  const notice = state.result?.budget ?? state.result?.error ?? state.error ?? (failedJob ? `Last research run ${JOB_STATUS[failedJob.status].toLowerCase()}: ${failedJob.error ?? "it did not finish"}` : null);

  if (!intel || !research) {
    return (
      <section className={styles.card} aria-label="Market read" aria-busy={state.loading || running}>
        <div className={styles.head}>
          <span className={styles.label}>Market read</span>
          {running ? null : <button type="button" className={styles.refresh} onClick={onRefresh} disabled={state.loading}><RefreshCw aria-hidden="true" className={state.loading ? styles.spin : undefined} />Research</button>}
        </div>
        {running && job ? <JobStrip job={job} onCancel={onCancel} /> : (
          <p className={styles.muted}>{notice ?? (state.result?.configured === false ? "Research is not configured on the server." : state.loading ? "Starting research…" : "No research for this pair yet.")}</p>
        )}
      </section>
    );
  }
  const assessment = intel.assessment ?? null;
  const marketState = state.result?.marketState ?? null;

  const o = intel.outlook;
  const forPair = intel.factors.filter((factor) => factor.impactOnPair === "bullish");
  const againstPair = intel.factors.filter((factor) => factor.impactOnPair === "bearish");
  const otherFactors = intel.factors.filter((factor) => factor.impactOnPair !== "bullish" && factor.impactOnPair !== "bearish");
  const horizons = [
    ["Short term", assessment?.nearTermLean ?? o.shortTerm],
    ["Swing 2–5 days", assessment?.swingLean ?? o.swingTerm],
    ["Fundamental", o.fundamental],
    ["Technical", o.technical],
  ] as const;
  const unresolvedHorizons = assessment ? [
    assessment.nearTermLean === "unresolved" ? "near-term" : null,
    assessment.swingLean === "unresolved" ? "swing" : null,
  ].filter(Boolean).join(" and ") : "";
  const balance = assessment?.evidenceBalance;
  const unresolvedReason = balance && unresolvedHorizons
    ? `The ${unresolvedHorizons} direction is unresolved. Bullish evidence scores ${balance.bullish} points; bearish evidence scores ${balance.bearish} points. ${balance.bullish === balance.bearish
      ? balance.bullish > 0 ? "The scores are tied, so neither side outweighs the other." : "No cited factor establishes a directional edge."
      : "Despite the difference in scores, the cited research does not establish a clear direction for this horizon."}`
    : null;

  return (
    <section className={styles.card} aria-label="Market read">
      <div className={styles.head}>
        <span className={styles.label}>Market read</span>
        <span className={styles.bias} data-bias={marketState ? undefined : o.overall.toUpperCase()}>{marketState ? marketState.usable ? OBSERVED_LABEL[marketState.snapshot.observed.classification] : "Data check" : BIAS_LABEL[o.overall]}</span>
        <span className={styles.muted}>{intel.research.quality} quality evidence</span>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={state.loading || running} aria-label="Refresh research">
          <RefreshCw aria-hidden="true" className={state.loading || running ? styles.spin : undefined} />
        </button>
      </div>
      {running && job ? <JobStrip job={job} onCancel={onCancel} /> : null}
      {marketState ? <MarketStateRead view={marketState} intel={intel} /> : <>
      <dl className={styles.outlook}>
        {horizons.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd data-bias={value}>{value === "unresolved" ? LEAN_LABEL[value] : BIAS_LABEL[value]}</dd></div>
        ))}
      </dl>
      {assessment ? (
        <p className={styles.leans}>
          Evidence lean — near term <strong data-lean={assessment.nearTermLean}>{LEAN_LABEL[assessment.nearTermLean]}</strong>
          {" · "}swing <strong data-lean={assessment.swingLean}>{LEAN_LABEL[assessment.swingLean]}</strong>
        </p>
      ) : null}
      <p className={styles.summary}>{assessment?.nearTermLean === "unresolved" ? unresolvedReason : assessment?.rationale || intel.summary}</p>
      {unresolvedReason && assessment?.nearTermLean !== "unresolved" ? <p className={styles.meta}>{unresolvedReason}</p> : null}
      {unresolvedReason ? <p className={styles.meta}>Points weight the cited evidence; they are not win probabilities. Expand the details below for the factors on each side.</p> : null}
      {assessment?.strongestOpposing ? <p className={styles.meta}>Strongest opposing evidence: {assessment.strongestOpposing}</p> : null}
      </>}
      <p className={styles.fresh} data-stale={!research.fresh}>
        {research.fresh ? `Researched ${ago(research.createdAt)}` : `Stale — ${research.staleReason ?? "older than its refresh window"} (researched ${ago(research.createdAt)})`}
        {intel.research.status === "partial" ? " · partial" : ""}
        {notice ? ` · ${notice}` : ""}
      </p>

      <details className={styles.more}>
        <summary>{marketState ? "Research sources, scenarios and calendar" : "Scenarios, drivers, calendar and sentiment"}</summary>
        {assessment?.rationale && intel.summary !== assessment.rationale ? <p className={styles.text}>{intel.summary}</p> : null}
        {o.explanation ? <p className={styles.text}>{o.explanation}</p> : null}

        <h4 className={styles.sub}>Both scenarios</h4>
        <Scenario side="BUY" thesis={intel.bullishThesis} />
        <Scenario side="SELL" thesis={intel.bearishThesis} />
        <p className={styles.fine}>Research cases only. A plan enters only when its own price conditions confirm and the risk checks pass.</p>

        {assessment?.drivers.length ? <><h4 className={styles.sub}>What is driving it</h4><ul className={styles.points}>{assessment.drivers.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
        {assessment?.changeTriggers.length ? <><h4 className={styles.sub}>What would change the view</h4><ul className={styles.points}>{assessment.changeTriggers.map((item) => <li key={item}>{item}</li>)}</ul></> : null}

        {forPair.length ? <><h4 className={styles.sub}>For {intel.pair.replace("_", "/")} rising</h4><Factors items={forPair} intel={intel} /></> : null}
        {againstPair.length ? <><h4 className={styles.sub}>For {intel.pair.replace("_", "/")} falling</h4><Factors items={againstPair} intel={intel} /></> : null}
        {otherFactors.length ? <><h4 className={styles.sub}>Mixed or unclear</h4><Factors items={otherFactors} intel={intel} /></> : null}

        <h4 className={styles.sub}>Calendar</h4>
        {intel.events.length ? (
          <ul className={styles.calendar}>
            {intel.events.slice(0, 8).map((event) => (
              <li key={event.id}>
                <span className={styles.cal}>{event.impact >= 3 ? "● " : ""}{event.currency} {event.title}</span>
                <span className={styles.meta}>
                  {local(event.at)} · {event.status === "released" ? `actual ${event.actual ?? "—"} vs forecast ${event.forecast ?? "—"}` : `forecast ${event.forecast ?? "—"}, previous ${event.previous ?? "—"}`}
                </span>
                {event.implication ? <span className={styles.newsText}>{event.implication}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className={styles.fine}>No verified releases for these currencies in the window (or the calendar was unavailable).</p>}

        <h4 className={styles.sub}>Sentiment</h4>
        <Observations title="Analysts" items={intel.sentiment.professional} intel={intel} />
        <Observations title="Positioning data" items={intel.sentiment.positioning} intel={intel} />
        <Observations title="Retail forums" items={intel.sentiment.retail} intel={intel} />
        {intel.sentiment.expectations ? <p className={styles.text}>{intel.sentiment.expectations}</p> : null}
        <p className={styles.fine}>{intel.sentiment.limitations}</p>

        {intel.research.missingData.length ? (
          <>
            <h4 className={styles.sub}>Could not verify</h4>
            <ul className={styles.points}>{intel.research.missingData.map((item) => <li key={item}>{item}</li>)}</ul>
          </>
        ) : null}
        <p className={styles.fine}>
          {intel.sources.length} sources · {intel.research.model} ({intel.research.effort}) · {research.usage.webSearchCalls ?? 0} searches · {Math.round(intel.research.durationMs / 1000)}s
          {research.usage.costUsd !== null ? ` · about $${research.usage.costUsd.toFixed(3)}` : ""}. Research is context only: it never changes a plan&apos;s rules.
        </p>
      </details>
    </section>
  );
}

const ALIGNMENT: Record<PlanResearchContext["alignment"], string> = {
  supports: "Research supports this side",
  opposes: "Research weighs against this side",
  mixed: "Research is mixed for this side",
  no_evidence: "No directional research",
  no_research: "No research",
};

/** The research for and against one plan's side, its thesis, and how it looked when the plan was made. */
export function PlanEvidence({ plan, intel }: { plan: TradePlan; intel: MarketIntelligence | null }) {
  const frozen = (plan.plan.intelligence ?? null) as PlanResearchContext | null;
  if (!intel && !frozen) return null;
  const side: Bias = plan.direction === "BUY" ? "bullish" : "bearish";
  const other: Bias = plan.direction === "BUY" ? "bearish" : "bullish";
  const supporting = intel?.factors.filter((factor) => factor.impactOnPair === side) ?? [];
  const opposing = intel?.factors.filter((factor) => factor.impactOnPair === other) ?? [];
  const thesis = intel ? (plan.direction === "BUY" ? intel.bullishThesis : intel.bearishThesis) : null;
  const alignment = frozen?.researchId && frozen.researchId === intel?.research.id ? frozen.alignment : null;
  return (
    <details className={styles.evidence}>
      <summary>
        <span>Research</span>
        <span className={styles.count}>{supporting.length} for · {opposing.length} against</span>
      </summary>
      {alignment ? <p className={styles.align} data-alignment={alignment}>{ALIGNMENT[alignment]}</p> : null}
      {frozen && frozen.researchId !== (intel?.research.id ?? null) ? (
        <p className={styles.fine}>When this plan was made: {ALIGNMENT[frozen.alignment].toLowerCase()}{frozen.researchedAt ? ` (research ${ago(frozen.researchedAt)})` : ""}.</p>
      ) : null}
      {thesis?.hypothesis ? <p className={styles.text}>{thesis.hypothesis}</p> : null}
      {intel && supporting.length ? <><h5 className={styles.evHead}>For the {plan.direction}</h5><Factors items={supporting.slice(0, 4)} intel={intel} /></> : null}
      {intel && opposing.length ? <><h5 className={styles.evHead}>Against it</h5><Factors items={opposing.slice(0, 3)} intel={intel} /></> : null}
      {thesis?.strengthensIf.length ? <><h5 className={styles.evHead}>Strengthens if</h5><ul className={styles.points}>{thesis.strengthensIf.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
      {thesis?.weakensIf.length ? <><h5 className={styles.evHead}>Weakens if</h5><ul className={styles.points}>{thesis.weakensIf.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
      <p className={styles.fine}>Context only. The plan enters only when its own price conditions confirm.</p>
    </details>
  );
}
