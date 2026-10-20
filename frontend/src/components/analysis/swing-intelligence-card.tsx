"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import type { SwingMovement, SwingStyle, SwingView, SwingZone } from "@/lib/swing-intelligence";
import styles from "./swing-intelligence.module.css";

const words = (value: string) => value.replaceAll("_", " ").toLowerCase();
const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "Unavailable";
async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20000), ...init });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Swing analysis could not be loaded.");
  return data;
}

export function SwingIntelligenceCard({ instrument, onZones, open, onClose, startRequest = 0, onReviewPlans }: {
  instrument: string; onZones?(zones: SwingZone[]): void; open?: boolean; onClose?(): void;
  startRequest?: number; onReviewPlans?(): void;
}) {
  const [view, setView] = useState<SwingView | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [style, setStyle] = useState<SwingStyle>("BALANCED");
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [zoneMovement, setZoneMovement] = useState<SwingMovement | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const inAction = useRef(false);
  const handledStart = useRef(0);
  const digits = precisionFor(instrument), price = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
  useEffect(() => {
    let active = true, pending = false, lastRefresh = 0, firstRead = true;
    const refresh = async () => {
      if (pending) return;
      pending = true; lastRefresh = Date.now();
      try {
        const next = await read<SwingView>(`/api/swing-intelligence?instrument=${encodeURIComponent(instrument)}`);
        if (active) { setView(next); setError(null); if (next.monitor && (firstRead || next.monitor.active)) setStyle(next.monitor.style); firstRead = false; }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Swing analysis is unavailable."); }
      finally { pending = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10000);
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ instrument?: string }>).detail;
      if (detail?.instrument === instrument && Date.now() - lastRefresh > 1000) void refresh();
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("gx:swing-intelligence", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("gx:swing-intelligence", onUpdate); document.removeEventListener("visibilitychange", onVisible); };
  }, [instrument]);
  useEffect(() => { onZones?.(!error && view?.monitor?.active ? view.zones : []); }, [error, onZones, view]);
  useEffect(() => () => onZones?.([]), [onZones]);
  const focusId = selectedZone ?? view?.zones.find(z => z.touchedAt)?.id ?? null;
  useEffect(() => {
    let active = true;
    if (!focusId || !view?.monitor?.active) return;
    void read<{ movement: SwingMovement }>(`/api/swing-intelligence/zones/${focusId}?instrument=${encodeURIComponent(instrument)}`)
      .then(next => { if (active) setZoneMovement(next.movement); }).catch(() => { if (active) setZoneMovement(null); });
    return () => { active = false; };
  }, [focusId, instrument, view]);
  const action = useCallback(async (operation: "start" | "stop" | "research") => {
    if (inAction.current) return;
    inAction.current = true; setBusy(true); setError(null);
    try {
      const path = operation === "research" ? "/api/swing-intelligence/research" : "/api/swing-intelligence/monitor";
      await read(`${path}?instrument=${encodeURIComponent(instrument)}`, operation === "stop" ? { method: "DELETE" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument, style, ...(operation === "research" ? { force: true } : {}) }) });
      await refreshRef.current();
    } catch (e) { setError(e instanceof Error ? e.message : "The analysis request failed."); }
    finally { inAction.current = false; setBusy(false); }
  }, [instrument, style]);
  // A chart Analyze click starts or rejoins this pair. Consume unavailable
  // requests too: enabling a server later must not silently start monitoring.
  useEffect(() => {
    if (!startRequest || handledStart.current === startRequest || (!view && !error)) return;
    handledStart.current = startRequest;
    if (!error && view?.enabled && view.runtime.available && !view.monitor?.active) void action("start");
  }, [action, error, startRequest, view]);
  const assessment = view?.assessment, market = view?.market;
  const focus = view?.zones.find(z => z.id === focusId);
  const movement = focus ? zoneMovement : view?.movement;
  const observation = movement?.windows.find(w => w.seconds === 60) ?? movement?.windows[0];
  const unavailable = error ? "Reconnect to the analysis server and retry." : !view ? "Connecting to the analysis server…"
    : !view.enabled ? view.runtime.reason ?? `Swing intelligence is not enabled for ${displayNameFor(instrument)} on this server.`
    : !view.runtime.available ? view.runtime.reason ?? "The analysis worker is unavailable." : null;
  const content = <section className={styles.card} aria-label={`${displayNameFor(instrument)} swing intelligence`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>2–5 trading days · analysis only</p><h2>Swing intelligence <span>{displayNameFor(instrument)}</span></h2></div>
      <span className={styles.badge}>{view?.monitor?.active ? "Monitoring" : "Not monitoring"}</span></header>
    {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <label>Entry style<select aria-label="Swing entry style" value={style} disabled={busy || view?.monitor?.active} onChange={e => setStyle(e.target.value as SwingStyle)}>
          <option value="AGGRESSIVE">Aggressive · qualified touch</option><option value="BALANCED">Balanced · initial reaction</option><option value="CONSERVATIVE">Conservative · closed H1 confirmation</option>
        </select></label>
        {view?.monitor?.active ? <><button type="button" disabled={busy || Boolean(unavailable)} onClick={() => void action("research")}>Refresh AI research</button><button type="button" disabled={busy} onClick={() => void action("stop")}>Stop analysis</button></>
          : <button type="button" disabled={busy || Boolean(unavailable)} aria-describedby={unavailable ? `swing-unavailable-${instrument}` : undefined} onClick={() => void action("start")}>{busy ? "Starting…" : "Start swing analysis"}</button>}
        <button type="button" disabled={busy} onClick={() => void refreshRef.current()}>Reconnect / refresh</button>
        {onReviewPlans ? <button type="button" onClick={onReviewPlans}>View existing trade plans</button> : null}
      </div>
      {unavailable ? <p id={`swing-unavailable-${instrument}`} className={styles.warning} role="status">{unavailable}</p> : null}
    {!view ? <p className={styles.note}>{error ? "No swing analysis snapshot is available." : "Loading swing analysis…"}</p> : !view.enabled ? null : <>
      <p className={styles.note}>Research uses the configured AI budget. Scenarios are alternatives for manual review; this engine never places or changes trades. All eligibility rules are provisional.</p>
      {view.job ? <p className={styles.note}>Research: {words(view.job.status)} · {words(view.job.kind)}{view.job.error ? ` · ${view.job.error}` : ""}</p> : null}
      {market ? <>
        <div className={styles.grid}>
          <div><span>OANDA bid / ask</span><strong>{price(market.quote?.bid)} / {price(market.quote?.ask)}</strong><small>{when(market.quote?.time)} · {words(market.state)}</small></div>
          <div><span>Directional assessment</span><strong>{words(view.preference)}</strong><small>Assessment, not entry permission</small></div>
          <div><span>Fundamental assessment</span><strong>{words(assessment?.fundamentalBias ?? "unavailable")}</strong><small>Retrieved evidence and attributed interpretations</small></div>
          {(["D1", "H4", "H1"] as const).map(tf => <div key={tf}><span>{tf} completed structure</span><strong>{words(market.frames[tf].condition)}</strong><small>{words(market.frames[tf].control)} · broker candle opened {when(market.frames[tf].lastClosedOpenTime)}</small></div>)}
          <div><span>Recent quote pressure</span><strong>{words(view.control.pressure)}</strong><small>Observed quote behavior, not traded volume</small></div>
        </div>
        {market.issues.length ? <details><summary>Data limitations ({market.issues.length})</summary><ul>{market.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></details> : null}
      </> : <p className={styles.note}>Start monitoring to retrieve actual OANDA D1, H4 and H1 context.</p>}
      {assessment ? <details open><summary>AI interpretation · {view.assessmentFresh ? "current" : "stale / invalidated"}</summary>
        <p className={styles.note}>Generated {when(assessment.createdAt)} · {assessment.horizon}</p><p>{assessment.interpretation.explanation}</p>
        <p><b>Independent AI candle interpretation:</b> D1 {assessment.interpretation.d1Condition} · H4 {assessment.interpretation.h4Condition} · H1 {assessment.interpretation.h1Condition}.</p>
        <p><b>Swing outlook:</b> {assessment.interpretation.swingOutlook}</p><p><b>Fundamental evidence:</b> {assessment.fundamentalSummary}</p>
        <div className={styles.columns}><div><h3>Supports BUY</h3><ul>{assessment.interpretation.buyEvidence.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          <div><h3>Supports SELL</h3><ul>{assessment.interpretation.sellEvidence.map((s, i) => <li key={i}>{s}</li>)}</ul></div></div>
        <h3>Contradictions and invalidation</h3><ul>{[...assessment.interpretation.contradictions, ...assessment.interpretation.invalidation].map((s, i) => <li key={i}>{s}</li>)}</ul>
        <h3>What changed</h3><ul>{assessment.interpretation.changes.map((s, i) => <li key={i}>{s}</li>)}</ul>
        <h3>Retrieved sources</h3><ul>{assessment.sources.map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.publisher} · {s.title ?? s.url}</a><small> Retrieved {when(s.retrievedAt)}</small></li>)}</ul>
        <details><summary>Evidence, release figures and limitations</summary>
          {assessment.fundamentalEvidence.map(e => <p key={e.id}><b>{words(e.evidenceType)}:</b> {e.description}</p>)}
          {assessment.calendar.filter(e => e.impact >= 3).slice(-12).map(e => <p key={e.id}>{e.currency} {e.title} · {when(e.timestamp)}<br />Actual {e.actual ?? "unavailable"} · forecast {e.forecast ?? "unavailable"} · previous {e.previous ?? "unavailable"} · revised unavailable<br />
            {e.surprise ? `Actual versus forecast: ${words(e.surprise.side)}${e.surprise.difference !== null ? ` (${e.surprise.difference} ${e.surprise.unit ?? ""})` : ""}. ` : ""}
            {e.reaction ? `${e.reaction.status === "OBSERVED" ? `Observed H1 price change ${e.reaction.changePercent}%: ` : ""}${e.reaction.explanation}` : "No completed-candle reaction is available yet."}</p>)}
          <ul>{assessment.limitations.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </details>
      </details> : <p className={styles.note}>No fully validated swing assessment is available yet. BUY/SELL eligibility remains blocked until research completes.</p>}
      <div className={styles.zones}>{view.zones.map(z => {
        const mid = market?.quote ? (market.quote.bid + market.quote.ask) / 2 : null;
        const distance = mid !== null && market ? (mid > z.upper ? mid - z.upper : mid < z.lower ? z.lower - mid : 0) / market.pipSize : null;
        return <article className={styles.zone} key={z.id}><button type="button" aria-pressed={focusId === z.id} onClick={() => setSelectedZone(z.id)}>
          <span>{words(z.classification)}</span><strong>{price(z.lower)} – {price(z.upper)}</strong><small>{words(z.status)} · {words(z.behavior)}{distance !== null ? ` · ${distance.toFixed(1)}p away` : ""}</small></button>
          <p>{z.reason}</p><p className={styles.note}>{z.evidence.join(" ")}</p><p className={styles.note}>Invalidation envelope {price(z.invalidation.lower)} – {price(z.invalidation.upper)} · expires {when(z.expiresAt)}</p>
        </article>;
      })}</div>
      {view.unavailableZones.map(reason => <p key={reason} className={styles.note}>{reason}</p>)}
      {movement ? <details open={Boolean(focus?.touchedAt)}><summary>{focus ? "Live zone evaluation" : "Observed quote movement"} · {words(movement.state)}</summary>
        {focus ? <p>{words(focus.behavior)} · {focus.reason}</p> : null}
        {observation ? <div className={styles.grid}>
          <div><span>Observed rises / falls</span><strong>{observation.upCount} / {observation.downCount}</strong><small>{observation.unchangedCount} unchanged</small></div>
          <div><span>Up / down distance</span><strong>{observation.upPips.toFixed(2)} / {observation.downPips.toFixed(2)} pips</strong></div>
          <div><span>Net / efficiency</span><strong>{observation.netPips.toFixed(2)}p / {(observation.efficiency * 100).toFixed(0)}%</strong><small>Path efficiency, not a win probability</small></div>
          <div><span>Velocity / acceleration</span><strong>{observation.velocity?.toFixed(3) ?? "—"} p/s</strong><small>{observation.acceleration?.toFixed(4) ?? "Unavailable"} p/s²</small></div>
          <div><span>Above / inside / below zone</span><strong>{observation.aboveZoneSeconds.toFixed(0)} / {observation.insideZoneSeconds.toFixed(0)} / {observation.belowZoneSeconds.toFixed(0)} sec</strong></div>
          <div><span>Observation coverage</span><strong>{observation.coveredSeconds.toFixed(0)} / {observation.seconds} sec</strong><small>{observation.samples} quotes · {movement.gaps} gaps · {observation.ready ? "covered" : "warming"}</small></div>
        </div> : null}<p className={styles.note}>{movement.reason ?? movement.limitation}</p>
      </details> : null}
      {view.scenarios.length ? <details open><summary>Conditional BUY / SELL scenarios</summary><div className={styles.columns}>
        {view.scenarios.map(s => <article className={styles.scenario} key={s.id}><h3>{s.side} · {words(error ? "BLOCKED" : s.eligibility)}</h3><p className={styles.note}>{words(s.style)} · provisional · {when(s.asOf)}</p>
          <dl><div><dt>Entry / stop</dt><dd>{price(s.entry)} / {price(s.stop)}</dd></div><div><dt>Targets</dt><dd>{price(s.firstTarget)} / {price(s.secondTarget)}</dd></div>
            <div><dt>Stop distance / reward</dt><dd>{s.stopPips?.toFixed(1) ?? "—"}p / {s.rewardPips?.toFixed(1) ?? "—"}p</dd></div><div><dt>Reward / risk</dt><dd>{s.rewardRisk?.toFixed(2) ?? "—"}</dd></div>
            <div><dt>Intended risk / units</dt><dd>{s.riskPercent}% · {s.riskAmount?.toFixed(2) ?? "—"} {s.accountCurrency} / {s.units ?? "—"}</dd></div>
            <div><dt>Spread impact</dt><dd>{s.spreadImpactR?.toFixed(3) ?? "—"}R</dd></div><div><dt>Financing estimate</dt><dd>Unavailable</dd></div>
            <div><dt>Historical expectancy</dt><dd>{s.expectancy.status === "VALIDATED" ? `${s.expectancy.expectancyR?.toFixed(2)}R · n=${s.expectancy.sampleSize}` : "Unavailable"}</dd></div></dl>
          <h4>Supporting evidence</h4><ul>{s.support.map((text, i) => <li key={i}>{text}</li>)}</ul><h4>Could fail / blocked by</h4><ul>{[...s.contradictions, ...s.blockers].map((text, i) => <li key={i}>{text}</li>)}</ul>
        </article>)}</div><p className={styles.note}>Stops do not guarantee the intended maximum loss during gaps or slippage. These are proposed alternatives, not execution instructions.</p></details> : null}
      <details><summary>Changes and research usage</summary><ol>{view.events.slice(0, 20).map(e => <li key={e.id}><time>{when(e.at)}</time> · {e.detail}</li>)}</ol>
        <p className={styles.note}>Today: {view.usage.requests} AI requests · {view.usage.searches} searches · {view.usage.inputTokens.toLocaleString()} input / {view.usage.outputTokens.toLocaleString()} output tokens · {(view.usage.latencyMs / 1000).toFixed(1)}s total latency.</p>
        <p className={styles.note}>Known estimated cost ${view.usage.knownCostUsd.toFixed(4)} · {view.usage.unknownCostRequests} requests with unavailable cost.</p>
      </details>
    </>}
  </section>;
  // Keep the data subscription mounted while the sheet is closed so chart
  // zones continue to update. Only the presentation lives in the portal.
  return onClose ? <MobileSheet open={Boolean(open)} onClose={onClose} title={`Swing analysis · ${displayNameFor(instrument)}`}
    eyebrow="Market intelligence" lockPageScroll={false} className={styles.sheet}>{content}</MobileSheet> : content;
}
