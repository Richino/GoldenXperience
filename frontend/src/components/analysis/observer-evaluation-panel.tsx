"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import type { ObserverEvaluation } from "@/lib/market-observer-types";
import styles from "./market-observer-bubble.module.css";

const number = (value: number | null, suffix = "") => value === null ? "—" : `${value.toFixed(2)}${suffix}`;
const percentage = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

/** Owner-scoped journal evidence is loaded on demand, independently of live polling. */
export function ObserverEvaluationPanel({ instrument }: { instrument: string }) {
  const [value, setValue] = useState<{ instrument: string; report: ObserverEvaluation } | null>(null);
  const [error, setError] = useState<{ instrument: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [instrument]);
  const report = value?.instrument === instrument ? value.report : null;
  const load = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const response = await fetch(apiUrl(`/api/market-observer/evaluation?instrument=${encodeURIComponent(instrument)}`), { credentials: "include", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Signal results could not be loaded.");
      const next = await response.json() as ObserverEvaluation;
      if (next.version !== "observer-evaluation@1" || next.instrument !== instrument || !next.counts || !Array.isArray(next.recent)) throw new Error("Signal evaluation is unavailable.");
      if (!controller.signal.aborted) setValue({ instrument, report: next });
    } catch (e) { if (!controller.signal.aborted) setError({ instrument, text: e instanceof Error ? e.message : "Results unavailable." }); }
    finally { if (request.current === controller) setBusy(false); }
  };
  return <section aria-label="Signal evaluation">
    <div className={styles.actions}><button disabled={busy} onClick={() => void load()}>{busy ? "Loading results…" : report ? "Refresh signal results" : "View signal results"}</button></div>
    {error?.instrument === instrument && <p className={styles.notice} role="status">{error.text}</p>}
    {report && <>
      <h4>Signal results · {instrument.replace("_", "/")}</h4>
      <p className={styles.caption}>As of {new Date(report.asOf).toLocaleString()} · {report.counts.plans} saved versions{report.truncated ? " · limited to latest 1,000" : ""}{report.from ? ` · since ${new Date(report.from).toLocaleDateString()}` : ""}.</p>
      <div className={styles.resultCounts}>
        <div><strong>{report.counts.signals}</strong><span>Signals observed</span></div>
        <div><strong>{report.counts.target}</strong><span>Targets observed</span></div>
        <div><strong>{report.counts.stop}</strong><span>Stops observed</span></div>
        <div><strong>{report.counts.unknown}</strong><span>Unknown / stopped</span></div>
        <div><strong>{report.counts.tracking}</strong><span>Still tracking</span></div>
        <div><strong>{report.counts.noSignal}</strong><span>Without a signal</span></div>
      </div>
      {report.counts.measured === 0 ? <p>No measured signals yet. Saved watch conditions do not establish performance.</p> : <>
        <p>{report.metrics.resolved} resolved observations · mean {number(report.metrics.meanObservedR, "R")} · {number(report.metrics.meanNetPips, "p")}.</p>
        <p>Target rate among resolved signals: {percentage(report.metrics.targetRateResolved)}.</p>
        {report.metrics.targetRateBounds && <p>Including unknown and unfinished signals: {percentage(report.metrics.targetRateBounds.low)}–{percentage(report.metrics.targetRateBounds.high)} possible target rate.</p>}
        <p>Mean entry spread {number(report.metrics.meanSpreadPips, "p")} · no-trade baseline 0R · resolved mean difference {number(report.baseline.differenceR, "R")}.</p>
      </>}
      {(report.counts.legacy > 0 || report.counts.invalid > 0) && <p className={styles.caption}>{report.counts.legacy} older signals without measurements · {report.counts.invalid} inconsistent records. Excluded from performance metrics.</p>}
      {report.cohorts.length > 0 && <details className={styles.savedVersion}><summary>Results by context</summary><ul>{report.cohorts.map(c => <li key={`${c.group}:${c.label}`}><strong>{c.group} · {c.label.replaceAll("_", " ")}</strong><br />{c.signals} signals · {c.resolved} resolved · mean {number(c.meanObservedR, "R")}</li>)}</ul><p className={styles.caption}>Pattern groups overlap. These describe observations, not pattern success probabilities.</p></details>}
      {report.recent.length > 0 && <details className={styles.savedVersion}><summary>Recent signal evidence</summary><ul>{report.recent.slice(0, 12).map(row => <li key={row.id}><strong>Version {row.version} · {row.mode} · {row.result}</strong><br />{new Date(row.triggeredAt).toLocaleString()} · {row.direction}<br />Result {number(row.observedR, "R")} · spread {number(row.spreadPips, "p")}<br />Favorable {number(row.favorablePips, "p")} · adverse {number(row.adversePips, "p")}</li>)}</ul></details>}
      <details className={styles.savedVersion}><summary>How these results are measured</summary><ul>{report.limitations.map(text => <li key={text}>{text}</li>)}</ul></details>
      <p className={styles.caption}>Hypothetical quote observations, not account profit. Live usefulness and a trading edge remain unproven.</p>
    </>}
  </section>;
}
