"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import type { Bias, MarketIntelligence, PlanResearchContext, ResearchFactor, ResearchObservation, ResearchResult, TradePlan } from "@/lib/trade-plans/api";
import styles from "./market-read.module.css";

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

export function MarketRead({ state, onRefresh }: { state: ResearchState; onRefresh: () => void }) {
  const research = state.result?.research ?? null;
  const intel = research?.report?.schemaVersion ? research.report : null;
  const notice = state.result?.budget ?? state.result?.error ?? state.error ?? null;

  if (state.loading && !intel) {
    return (
      <section className={styles.card} aria-busy="true" aria-label="Market read">
        <div className={styles.head}><span className={styles.label}>Market read</span><span className={styles.muted}>Researching news, central banks, data and sentiment…</span></div>
        <span className={styles.skel} />
        <span className={`${styles.skel} ${styles.short}`} />
      </section>
    );
  }
  if (!intel || !research) {
    return (
      <section className={styles.card} aria-label="Market read">
        <div className={styles.head}>
          <span className={styles.label}>Market read</span>
          <button type="button" className={styles.refresh} onClick={onRefresh} disabled={state.loading}><RefreshCw aria-hidden="true" />Research</button>
        </div>
        <p className={styles.muted}>{notice ?? (state.result?.configured === false ? "Research is not configured on the server." : "No research for this pair yet.")}</p>
      </section>
    );
  }

  const o = intel.outlook;
  const forPair = intel.factors.filter((factor) => factor.impactOnPair === "bullish");
  const againstPair = intel.factors.filter((factor) => factor.impactOnPair === "bearish");
  const otherFactors = intel.factors.filter((factor) => factor.impactOnPair !== "bullish" && factor.impactOnPair !== "bearish");

  return (
    <section className={styles.card} aria-label="Market read">
      <div className={styles.head}>
        <span className={styles.label}>Market read</span>
        <span className={styles.bias} data-bias={o.overall.toUpperCase()}>{BIAS_LABEL[o.overall]}</span>
        <span className={styles.muted}>{intel.research.quality} quality evidence</span>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={state.loading} aria-label="Refresh research">
          <RefreshCw aria-hidden="true" className={state.loading ? styles.spin : undefined} />
        </button>
      </div>
      <dl className={styles.outlook}>
        {([["Short term", o.shortTerm], ["Swing 2–5 days", o.swingTerm], ["Fundamental", o.fundamental], ["Technical", o.technical]] as const).map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd data-bias={value}>{BIAS_LABEL[value]}</dd></div>
        ))}
      </dl>
      <p className={styles.summary}>{intel.summary}</p>
      <p className={styles.fresh} data-stale={!research.fresh}>
        {research.fresh ? `Researched ${ago(research.createdAt)}` : `Stale — ${research.staleReason ?? "older than its refresh window"} (researched ${ago(research.createdAt)})`}
        {intel.research.status === "partial" ? " · partial" : ""}
        {notice ? ` · ${notice}` : ""}
      </p>

      <details className={styles.more}>
        <summary>Drivers, calendar and sentiment</summary>
        {o.explanation ? <p className={styles.text}>{o.explanation}</p> : null}

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
