"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import type { EvidencePoint, IntelligenceReport, ResearchResult, TradePlan } from "@/lib/trade-plans/api";
import styles from "./market-read.module.css";

/**
 * Market intelligence in the Analyze sheet: a compact read (bias, confidence,
 * freshness, one-line summary) that opens into the full report — news,
 * verified calendar, sentiment, catalysts, uncertainties — with sources.
 * Research is context for the plans; it never changes their rules.
 */

export type ResearchState = { loading: boolean; result: ResearchResult | null; error: string | null };

const BIAS: Record<IntelligenceReport["overallBias"], string> = { BULLISH: "Bullish", BEARISH: "Bearish", MIXED: "Mixed", UNCLEAR: "Unclear" };
const STANCE: Record<string, string> = { POSITIONING: "Positioning", BULLISH_CALL: "Bullish call", BEARISH_CALL: "Bearish call", NEUTRAL: "Neutral", SPECULATION: "Speculation" };

function ago(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
const local = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; } };

function Sources({ urls }: { urls: string[] }) {
  return (
    <span className={styles.sources}>
      {urls.slice(0, 3).map((url) => (
        <a key={url} href={url} target="_blank" rel="noopener noreferrer">{host(url)}<ExternalLink aria-hidden="true" /></a>
      ))}
    </span>
  );
}

function Points({ items }: { items: EvidencePoint[] }) {
  return <ul className={styles.points}>{items.map((item) => <li key={item.point}>{item.point} <Sources urls={item.urls} /></li>)}</ul>;
}

export function MarketRead({ state, onRefresh }: { state: ResearchState; onRefresh: () => void }) {
  const research = state.result?.research ?? null;
  const report = research?.report ?? null;
  const notice = state.result?.budget ?? state.result?.error ?? state.error ?? null;

  if (state.loading && !report) {
    return (
      <section className={styles.card} aria-busy="true" aria-label="Market read">
        <div className={styles.head}><span className={styles.label}>Market read</span><span className={styles.muted}>Researching news, central banks, data and sentiment…</span></div>
        <span className={styles.skel} />
        <span className={`${styles.skel} ${styles.short}`} />
      </section>
    );
  }
  if (!report) {
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

  return (
    <section className={styles.card} aria-label="Market read">
      <div className={styles.head}>
        <span className={styles.label}>Market read</span>
        <span className={styles.bias} data-bias={report.overallBias}>{BIAS[report.overallBias]}</span>
        <span className={styles.muted}>{report.confidence.toLowerCase()} confidence</span>
        <button type="button" className={styles.refresh} onClick={onRefresh} disabled={state.loading} aria-label="Refresh research">
          <RefreshCw aria-hidden="true" className={state.loading ? styles.spin : undefined} />
        </button>
      </div>
      <p className={styles.summary}>{report.summary}</p>
      <p className={styles.fresh} data-stale={!research!.fresh}>
        {research!.fresh ? `Researched ${ago(research!.createdAt)}` : `Stale — ${research!.staleReason ?? "older than its refresh window"} (researched ${ago(research!.createdAt)})`}
        {notice ? ` · ${notice}` : ""}
      </p>

      <details className={styles.more}>
        <summary>Full market read</summary>
        <dl className={styles.facts}>
          <div><dt>{report.baseCurrency.label ? `Base · ${report.baseCurrency.label}` : "Base currency"}</dt><dd>{report.baseCurrency.summary}</dd></div>
          <div><dt>{report.quoteCurrency.label ? `Quote · ${report.quoteCurrency.label}` : "Quote currency"}</dt><dd>{report.quoteCurrency.summary}</dd></div>
          {report.ratesAndYields ? <div><dt>Rates and yields</dt><dd>{report.ratesAndYields}</dd></div> : null}
          {report.riskSentiment ? <div><dt>Risk mood</dt><dd>{report.riskSentiment}</dd></div> : null}
          {report.technicalVsFundamental ? <div><dt>Technical vs fundamental</dt><dd>{report.technicalVsFundamental}</dd></div> : null}
        </dl>

        {report.news.length ? (
          <>
            <h4 className={styles.sub}>News</h4>
            <ul className={styles.news}>
              {report.news.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">{item.headline}</a>
                  <span className={styles.meta}>
                    {item.publisher}{item.publishedAt ? ` · ${local(item.publishedAt)}` : ""} · <span className={styles.tag} data-kind={item.kind}>{item.kind === "FACT" ? "Report" : "Analysis"}</span>
                  </span>
                  <span className={styles.newsText}>{item.summary}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {research!.calendar.available ? (
          <>
            <h4 className={styles.sub}>Calendar</h4>
            <ul className={styles.calendar}>
              {research!.calendar.released.slice(-4).map((row) => (
                <li key={`${row.currency}${row.title}${row.at}`}>
                  <span className={styles.cal}>{row.currency} {row.title}</span>
                  <span className={styles.meta}>
                    {local(row.at)} · actual {row.actual ?? "—"} vs forecast {row.forecast ?? "—"}
                    {row.surprise.side !== "UNKNOWN" ? ` (${row.surprise.side === "IN_LINE" ? "in line" : row.surprise.side.toLowerCase() + " forecast"})` : ""}
                  </span>
                </li>
              ))}
              {research!.calendar.upcoming.slice(0, 5).map((row) => (
                <li key={`${row.currency}${row.title}${row.at}`}>
                  <span className={styles.cal}>{row.impact >= 3 ? "● " : ""}{row.currency} {row.title}</span>
                  <span className={styles.meta}>{local(row.at)} · forecast {row.forecast ?? "—"}, previous {row.previous ?? "—"}</span>
                </li>
              ))}
            </ul>
            <p className={styles.fine}>From {research!.calendar.source}. Revisions are not available from this feed.</p>
          </>
        ) : <p className={styles.fine}>{research!.calendar.note ?? "The calendar was unavailable."}</p>}

        <h4 className={styles.sub}>Sentiment</h4>
        {report.sentiment.summary ? <p className={styles.text}>{report.sentiment.summary}</p> : null}
        {report.sentiment.observations.length ? (
          <ul className={styles.points}>
            {report.sentiment.observations.map((item) => (
              <li key={item.url + item.text}><span className={styles.tag}>{STANCE[item.stance] ?? item.stance}</span> {item.text} <Sources urls={[item.url]} /></li>
            ))}
          </ul>
        ) : null}
        <p className={styles.fine}>{report.sentiment.limitations}</p>

        {report.catalysts.length ? (
          <>
            <h4 className={styles.sub}>Catalysts</h4>
            <ul className={styles.points}>{report.catalysts.map((item) => <li key={item.event}><strong>{item.event}</strong> — {item.why}</li>)}</ul>
          </>
        ) : null}
        {report.uncertainties.length ? (
          <>
            <h4 className={styles.sub}>Uncertainties</h4>
            <ul className={styles.points}>{report.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul>
          </>
        ) : null}
        <h4 className={styles.sub}>Conclusion</h4>
        <dl className={styles.facts}>
          <div><dt>Evidence supports</dt><dd>{report.conclusion.supports}</dd></div>
          <div><dt>Invalidated by</dt><dd>{report.conclusion.invalidatedBy}</dd></div>
          <div><dt>Price must still confirm</dt><dd>{report.conclusion.needsPriceConfirmation}</dd></div>
        </dl>
        <p className={styles.fine}>
          {research!.sourceCount} sources searched · {research!.model ?? "model"} · {research!.usage.webSearchCalls ?? 0} searches
          {research!.usage.costUsd !== null ? ` · about $${research!.usage.costUsd.toFixed(3)}` : ""}. Research is context only: it does not change any plan&apos;s rules.
        </p>
      </details>
    </section>
  );
}

/** The research points for and against one plan's side, with sources. */
export function PlanEvidence({ plan, report }: { plan: TradePlan; report: IntelligenceReport | null }) {
  if (!report) return null;
  const buy = plan.direction === "BUY";
  const forSide = buy ? report.bullishEvidence : report.bearishEvidence;
  const against = buy ? report.bearishEvidence : report.bullishEvidence;
  if (!forSide.length && !against.length) return null;
  return (
    <details className={styles.evidence}>
      <summary>
        <span>Evidence</span>
        <span className={styles.count}>{forSide.length} for · {against.length} against</span>
      </summary>
      {forSide.length ? <><h5 className={styles.evHead}>For the {plan.direction}</h5><Points items={forSide.slice(0, 4)} /></> : null}
      {against.length ? <><h5 className={styles.evHead}>Against it</h5><Points items={against.slice(0, 3)} /></> : null}
    </details>
  );
}
