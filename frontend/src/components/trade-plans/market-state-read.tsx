"use client";

import { precisionFor } from "@/lib/instruments/catalog";
import type { MarketIntelligence } from "@/lib/trade-plans/api";
import { FUNDAMENTAL_LABEL, FORWARD_LABEL, toneOf, type MarketStateView } from "@/lib/trade-plans/market-state";
import styles from "./market-read.module.css";

const at = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

/** One interpretation, with distinct observation, economic environment and forward preference. */
export function MarketStateRead({ view, intel, historical = false }: { view: MarketStateView; intel: MarketIntelligence; historical?: boolean }) {
  const s = view.snapshot;
  const digits = precisionFor(s.instrument);
  if (!view.usable) return <div role="status">
    <p className={styles.summary}><strong>Market interpretation unavailable</strong></p>
    <ul className={styles.points}>{view.reasons.slice(0, 4).map(reason => <li key={reason}>{reason}</li>)}</ul>
    <p className={styles.meta}>The saved research remains available below. A current directional interpretation needs usable research, calendar and OANDA data.</p>
    {["VALID", "PARTIAL"].includes(s.quality.status) ? <details className={styles.more}>
      <summary>Last verified interpretation · {at(s.generatedAt)}</summary>
      <MarketStateRead view={{ ...view, usable: true }} intel={intel} historical />
    </details> : null}
  </div>;
  return <>
    {historical ? <p className={styles.fresh} data-stale>Previously saved snapshot. Current data checks do not pass; the views below describe that earlier observation.</p> : null}
    {/* At a glance: the read (its label is the chip above), three leans, one status line. Everything else is in the details. */}
    <p className={styles.summary}>{s.observed.explanation}</p>
    <dl className={styles.outlook} data-count="3">
      {([
        ["Fundamentals", s.fundamental.classification, FUNDAMENTAL_LABEL[s.fundamental.classification]],
        [historical ? "Then · near term" : "Near term", s.forward.shortTerm.classification, FORWARD_LABEL[s.forward.shortTerm.classification]],
        [historical ? "Then · swing" : "Swing 2–5 days", s.forward.swing.classification, FORWARD_LABEL[s.forward.swing.classification]],
      ] as const).map(([label, value, text]) => {
        const { tone, soft } = toneOf(value);
        return <div key={label} className={styles.tile} data-tone={tone} data-soft={soft || undefined}><dt>{label}</dt><dd>{text}</dd></div>;
      })}
    </dl>
    <p className={styles.status}>
      {s.observed.timeframe} · last candle {s.observed.asOf ? at(s.observed.asOf) : "unavailable"}
      {s.source.marketOpen ? "" : " · market closed"}
      {s.quality.status === "PARTIAL" ? " · partial evidence" : ""}
    </p>
    <details className={styles.more}>
      <summary>Why GX reads it this way</summary>
      <h4 className={styles.sub}>The leans</h4>
      <p className={styles.text}><strong>Near term:</strong> {s.forward.shortTerm.explanation}</p>
      <p className={styles.text}><strong>Swing:</strong> {s.forward.swing.explanation}</p>
      <p className={styles.fine}>Both BUY and SELL plans keep their own triggers; the first valid confirmation decides. This read never places a trade.</p>
      <h4 className={styles.sub}>Observed price evidence</h4>
      <ul className={styles.points}>{s.observed.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
      <h4 className={styles.sub}>Economic catalysts</h4>
      <p className={styles.text}>{s.fundamental.explanation}</p>
      <p className={styles.meta}>Original evidence points: {s.fundamental.rawScores.bullish} bullish / {s.fundamental.rawScores.bearish} bearish. After recency and overlap checks: {s.fundamental.adjusted.bullish} / {s.fundamental.adjusted.bearish}. These are evidence weights, not win probabilities.</p>
      <ul className={styles.points}>{s.fundamental.catalysts.map(c => <li key={c.id}>
        <strong>{c.currency} · {c.topic.replaceAll("-", " ")}</strong>
        <span className={styles.newsText}> {c.factorIds.map(id => intel.factors.find(f => f.id === id)?.factor).filter(Boolean).join("; ")}</span>
        <span className={styles.meta}> Related stories count once per direction. Observed {c.latestObservedAt ? at(c.latestObservedAt) : "at an unknown time"}; persistence not established.</span>
        <span className={styles.sources}>{c.sourceIds.slice(0, 3).map(id => { const source = intel.sources.find(s => s.id === id); return source ? <a key={id} href={source.url} target="_blank" rel="noopener noreferrer">{source.publisher}</a> : null; })}</span>
      </li>)}</ul>
      <h4 className={styles.sub}>What strengthens continuation</h4>
      {s.observed.continuation.length ? <ul className={styles.points}>{s.observed.continuation.map((c, i) => <li key={i}><strong>{c.timeframe} close {c.relation === "CLOSE_ABOVE" ? "above" : "below"} {c.level.toFixed(digits)}.</strong> {c.explanation}</li>)}</ul> : <p className={styles.text}>No directional continuation level is established by the current structure.</p>}
      <h4 className={styles.sub}>What weakens the interpretation</h4>
      {s.observed.invalidation.length ? <ul className={styles.points}>{s.observed.invalidation.map((c, i) => <li key={i}><strong>{c.timeframe} close {c.relation === "CLOSE_ABOVE" ? "above" : "below"} {c.level.toFixed(digits)}.</strong> {c.explanation}</li>)}</ul> : <p className={styles.text}>Reassess when completed candles establish a directional structure.</p>}
      {s.reactions.length ? <><h4 className={styles.sub}>Verified event windows</h4><ul className={styles.points}>{s.reactions.map(r => <li key={r.eventId}><strong>{r.title} · {at(r.at)}</strong> {r.status === "OBSERVED" ? `${r.from!.toFixed(digits)} → ${r.to!.toFixed(digits)} (${r.changePercent! >= 0 ? "+" : ""}${r.changePercent}%).` : "Reaction not verified."} {r.explanation}</li>)}</ul></> : null}
      {s.previous ? <p className={styles.meta}>Compared with the previous snapshot: observed state {s.previous.observedStateChanged ? "changed" : "unchanged"}; near-term lean {s.previous.shortTermChanged ? "changed" : "unchanged"}; swing lean {s.previous.swingChanged ? "changed" : "unchanged"}.</p> : null}
      {intel.research.missingData.length ? <><h4 className={styles.sub}>Limits of the evidence</h4><ul className={styles.points}>{intel.research.missingData.map((gap, i) => <li key={i}>{gap}</li>)}</ul></> : null}
      <p className={styles.fine}>Deterministic interpretation · {s.engineVersion} · no additional model or web-search calls. Generated {at(s.generatedAt)}. Approved plan levels and conditions remain unchanged.</p>
    </details>
  </>;
}
