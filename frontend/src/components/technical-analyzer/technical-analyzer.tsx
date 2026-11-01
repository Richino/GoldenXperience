"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { INSTRUMENT_CATALOG } from "@/lib/instruments/catalog";
import { apiUrl } from "@/lib/api/url";
import { conciseMarketReport, copyReport, marketReport } from "@/lib/technical-analyzer/report";
import { recordedReadings, technicalSummary } from "@/lib/technical-analyzer/ratings";
import { levelRiskLabel, zoneGrade } from "@/lib/technical-analyzer/levels";
import { continuationRiskLabel, outlookDirection, outlookEvidence } from "@/lib/technical-analyzer/outlook";
import type { Forecast, Frame, History, Horizon, Snapshot, Zone } from "@/lib/technical-analyzer/types";
import { TechnicalGauge } from "./technical-gauge";
import styles from "./technical-analyzer.module.css";

const FRAMES: Array<{ key: Frame; label: string }> = [{ key: "H1", label: "1H" }, { key: "H4", label: "4H" }, { key: "D", label: "1D" }, { key: "W", label: "1W" }];
const HORIZONS: Horizon[] = [1,2,3,4,5];
const time = (s: string) => new Date(s).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const percent = (n: number | null) => n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const biasStyle = (bias: string) => bias === "BEARISH" ? styles.sell : bias === "BULLISH" ? styles.buy : styles.neutral;

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(`/api/technical-analyzer/${path}`), { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(60000), ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Technical analysis unavailable.");
  return data as T;
}

function interpretation(f: Forecast): string {
  if (f.lean) return f.lean.rationale;
  if (f.bias === "UNAVAILABLE") return "Required completed-candle data is unavailable. Refresh the data before drawing a technical conclusion.";
  const bearish = f.groups.trend < 0, bullish = f.groups.trend > 0;
  if (f.bias === "NO EDGE" && f.levelRisk) return `${f.reasons[2]} ${f.levelRisk.zone ? `Nearby ${f.levelRisk.zone.role} adds continuation risk; it is not the reason for NO EDGE.` : ""}`;
  if (f.levelRisk?.zone) return `${f.bias === "BULLISH" ? "Bullish bias" : f.bias === "BEARISH" ? "Bearish bias" : "Directional evidence remains mixed"}, with ${f.levelRisk.severity === "HIGH" ? "major" : "nearby"} ${f.levelRisk.zone.frame} ${f.levelRisk.zone.role} creating continuation risk. A confirmed break and retest would reduce that risk; a rejection could favor reversal.`;
  if (f.groups.location === "opposing major zone") return `${bearish ? "Bearish trend approaching major support" : bullish ? "Bullish trend approaching major resistance" : "Mixed structure at a major level"}. Continuation needs a confirmed break; a rejection could favor reversal.`;
  if (f.bias === "BEARISH") return "Bearish continuation conditions are aligned. This is directional evidence, not an instruction to enter a trade.";
  if (f.bias === "BULLISH") return "Bullish continuation conditions are aligned. Monitor whether support holds and momentum persists.";
  if (bearish && f.groups.momentum > 0) return "Bullish reversal potential within a bearish trend. Recovering momentum alone does not confirm a structural recovery.";
  if (bullish && f.groups.momentum < 0) return "Bearish pullback momentum within a bullish structure. A recovery needs momentum to realign and support to hold.";
  return "No clear directional advantage under the configured rules. Trend, momentum, strength or exhaustion gates remain unresolved.";
}

function supportingEvidence(f: Forecast, snapshot: Snapshot): string {
  if (!f.lean) return `${f.structure}. ${f.trendStrength}; ${f.momentum}.`;
  const direction=f.lean.direction === "BULLISH" ? 1 : f.lean.direction === "BEARISH" ? -1 : 0;
  if (!direction) return f.lean.direction === "UNAVAILABLE" ? "Required candle evidence is unavailable." : "Trend and structure do not establish a dominant direction.";
  return f.frames.flatMap(key=>{
    const frame=snapshot.frames[key], facts:string[]=[];
    if (frame.trend===direction) facts.push(`${direction>0 ? "bullish" : "bearish"} EMA alignment`);
    if (frame.structure === (direction>0 ? "higher highs / higher lows" : "lower highs / lower lows")) facts.push(frame.structure);
    return facts.length ? [`${key}: ${facts.join("; ")}`] : [];
  }).join(". ") || "Directional trend/structure evidence is weak.";
}

function ZoneTable({ zones, precision }: { zones: Zone[]; precision: number }) {
  return <div className={styles.tableScroll}><table><thead><tr><th>Zone / price range</th><th>Strength / reactions</th><th>Distance</th><th>Frame</th><th>Condition</th></tr></thead><tbody>{zones.map((z,i) => <tr key={`${z.frame}-${z.low}-${i}`}><td><span className={z.role === "support" ? styles.buy : styles.sell}>{z.role}</span><strong>{z.low.toFixed(precision)}–{z.high.toFixed(precision)}</strong></td><td>{zoneGrade(z).toLowerCase()} · {z.reactions}<small>Rejection {z.quality.toFixed(2)} ATR</small></td><td>{z.distancePips.toFixed(1)} pips<small>{z.distanceAtr.toFixed(2)} {z.frame} ATR</small></td><td>{z.frame}</td><td>{z.retestedAt ? "Retested" : z.brokenAt ? "Broken" : "Holding*"}</td></tr>)}</tbody></table>{!zones.length && <p className={styles.muted}>No relevant reaction zones detected.</p>}</div>;
}

export function TechnicalAnalyzer() {
  const [pair, setPair] = useState("EUR_USD");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [frame, setFrame] = useState<Frame>("D");
  const [horizon, setHorizon] = useState<Horizon>(1);
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(true);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [notice, setNotice] = useState("");
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [clock, setClock] = useState(0);

  async function refreshHistory() {
    setHistoryBusy(true); setHistoryError("");
    try { setHistory(await read<History>("history")); }
    catch (e) { setHistoryError(e instanceof Error ? e.message : "History unavailable."); }
    finally { setHistoryBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void read<History>("history", { signal: controller.signal }).then(h => {
      if (!controller.signal.aborted) {
        setHistory(h); setClock(Date.now());
      }
    }).catch(e => { if (!controller.signal.aborted) setHistoryError(e instanceof Error ? e.message : "History unavailable."); })
      .finally(() => { if (!controller.signal.aborted) setHistoryBusy(false); });
    const timer = window.setInterval(() => setClock(Date.now()), 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);

  async function analyze() {
    setBusy(true); setError(""); setNotice(""); setManualCopy(null);
    try {
      const s = await read<Snapshot>("analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instrument: pair }) });
      setSnapshot(s); setClock(Date.now()); void refreshHistory();
    } catch (e) { setError(e instanceof Error ? e.message : "Analysis unavailable."); setSnapshot(null); }
    finally { setBusy(false); }
  }

  const current = snapshot?.frames[frame];
  const selected = snapshot?.forecasts.find(f => f.horizon === horizon);
  const readings = useMemo(() => current ? recordedReadings(current) : null, [current]);
  const ratings = useMemo(() => readings ? technicalSummary(readings) : null, [readings]);
  const exportedAt = snapshot ? new Date(clock || Date.parse(snapshot.createdAt)).toISOString() : "";
  const report = useMemo(() => snapshot ? conciseMarketReport(snapshot, frame, exportedAt) : "", [snapshot, frame, exportedAt]);
  const price = (n: number) => n.toFixed(snapshot?.precision ?? 5);
  const zones = useMemo(() => snapshot ? Object.values(snapshot.frames).filter(f => f.frame !== "H1").flatMap(f => f.zones).sort((a,b) => a.distancePips - b.distancePips) : [], [snapshot]);
  const aged = snapshot && snapshot.freshness !== "MARKET CLOSED" && clock - Date.parse(snapshot.marketAt) > 120000;
  const qualityLabel = !snapshot ? "Awaiting analysis" : snapshot.technicalAvailable === false ? "Data needs attention" : "Completed candles verified";
  async function copy(full = false) {
    if (!snapshot) return;
    const text = full ? `${marketReport(snapshot, exportedAt)}\n\nFULL FROZEN SNAPSHOT\n${JSON.stringify(snapshot,null,2)}` : report;
    const ok = await copyReport(text);
    setNotice(ok ? `${full ? "Full technical export" : "Research report"} copied.` : "Clipboard blocked. Select and copy the report below.");
    setManualCopy(ok ? null : text);
  }

  return <div className={styles.page}>
    <header className={styles.header}><div><Link href="/watchlist" className={styles.back}>Markets / Technicals</Link><h1>GX Technical Analyzer</h1></div><span className={styles.model}>Not yet validated <span>· {snapshot?.modelVersion.replace("gx-technical-", "v") ?? "v1.4"}</span></span></header>
    <section className={styles.marketBar} aria-label="Market data">
      <div className={styles.pairBlock}><label htmlFor="technical-pair">Currency pair</label><select id="technical-pair" value={pair} disabled={busy} onChange={e => { setPair(e.target.value); setSnapshot(null); setError(""); setNotice(""); setManualCopy(null); }}>{INSTRUMENT_CATALOG.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>)}</select></div>
      <div className={styles.priceBlock}><strong>{snapshot ? price(snapshot.referencePrice) : "—"}</strong><span><i className={snapshot?.freshness === "MARKET CLOSED" ? styles.closedDot : styles.openDot} />{snapshot ? snapshot.freshness === "MARKET CLOSED" ? "Market closed · last price" : aged ? "Quote stale" : "Market open" : "OANDA Practice"}</span></div>
      <div className={styles.timestamp}>{current ? <><span>{FRAMES.find(f => f.key === frame)?.label} candle completed</span><strong>{time(current.lastCloseAt)}</strong></> : <span>Completed-candle technical analysis</span>}</div>
      <div className={styles.actions}><button className={styles.primary} disabled={busy} onClick={() => void analyze()}>{busy ? "Analyzing…" : snapshot ? "Refresh analysis" : "Analyze"}</button><button disabled={!snapshot || busy} onClick={() => void copy()}>Copy for ChatGPT</button></div>
    </section>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {error && <p role="alert" className={styles.error}>UNAVAILABLE · {error}</p>}

    <section aria-label="Technical indicator summary" className={styles.technicalSection}>
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>CURRENT TECHNICALS</p><h2>Indicator overview</h2></div><div className={styles.selectorBlock}><span>Indicator timeframe</span><div className={styles.segments} role="group" aria-label="Indicator timeframe">{FRAMES.map(f => <button key={f.key} aria-pressed={frame === f.key} onClick={() => setFrame(f.key)}>{f.label}</button>)}</div></div></div>
      {ratings && readings && snapshot && snapshot.technicalAvailable !== false ? <div className={styles.gauges}>
        <TechnicalGauge title="Oscillators" rating={ratings.oscillators} rows={readings.oscillators} precision={snapshot.precision} />
        <TechnicalGauge title="Overall Summary" rating={ratings.overall} rows={[...readings.oscillators,...readings.averages]} precision={snapshot.precision} prominent />
        <TechnicalGauge title="Moving Averages" rating={ratings.averages} rows={readings.averages} precision={snapshot.precision} />
      </div> : <div className={styles.emptyGauges}>{["Oscillators","Overall Summary","Moving Averages"].map(title => <div key={title}><h3>{title}</h3><div className={styles.emptyArc} /><strong>{busy ? "Calculating…" : error || snapshot?.technicalAvailable === false ? "UNAVAILABLE" : "Awaiting analysis"}</strong></div>)}</div>}
      <p className={styles.summaryNote}>Indicator votes describe the selected timeframe. They are separate from the forecasts below and are not a confidence score.</p>
      {current && !current.readings && <p className={styles.summaryNote}>Original legacy report: only recorded, supportable readings are rated. Refresh analysis for the expanded indicator set and current forecast rules.</p>}
      {current && snapshot?.technicalAvailable !== false && <div className={styles.trendStrip}><span>Trend <strong>{current.adx >= 25 ? "Strong" : current.adx >= 18 ? "Developing" : "Weak"} {current.structure === "lower highs / lower lows" ? "bearish" : current.structure === "higher highs / higher lows" ? "bullish" : "mixed"} · ADX {current.adx.toFixed(2)}</strong></span><span>Structure <strong>{current.structure}</strong></span><span>Oscillators <strong className={ratings ? biasStyle(ratings.oscillators.score > .1 ? "BULLISH" : ratings.oscillators.score < -.1 ? "BEARISH" : "NO EDGE") : ""}>{ratings?.oscillators.label}</strong></span></div>}
    </section>

    <section className={styles.outlookSection} aria-label="Five-day directional outlook">
      <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>DIRECTIONAL LEAN · EVIDENCE · CONTINUATION RISK</p><h2>1–5 day outlook</h2></div><span className={styles.explainer}>Forecast horizon · trading days</span></div>
      <div className={styles.forecastCards} role="group" aria-label="Forecast horizon">{HORIZONS.map(h => {
        const f = snapshot?.forecasts.find(f => f.horizon === h);
        return <button key={h} aria-label={`${h} trading day${h > 1 ? "s" : ""}`} aria-pressed={horizon === h} onClick={() => setHorizon(h)}><span className={styles.cardTop}><b>{h}D</b><small className={f?.lean?.evidence === "STRONG" ? styles.evidenceStrong : undefined}>{f ? `${outlookEvidence(f)} evidence` : "—"}</small></span><strong className={`${styles.cardBias} ${biasStyle(f ? outlookDirection(f) : "UNAVAILABLE")}`}>{f ? outlookDirection(f) : "UNAVAILABLE"}</strong><span>{f?.trendStrength ?? "Run analysis"}</span><span>{f?.momentum ?? "Completed candles required"}</span><small className={f?.continuationRisk && f.continuationRisk.severity !== "LOW" ? styles.conflict : styles.muted}>{f ? continuationRiskLabel(f) : "—"}</small><small className={f?.levelRisk?.zone || f?.groups.location === "opposing major zone" ? styles.conflict : styles.muted}>{f ? levelRiskLabel(f) : "—"}</small></button>;
      })}</div>
      <p className={styles.summaryNote}>Lean describes direction, evidence describes agreement, and continuation risk describes obstacles. Stricter assessments remain in details and history.</p>
      {selected && snapshot && <div className={styles.forecastDetail} aria-label="Selected forecast">
        <div className={styles.detailHeading}><div><h3>{horizon}-day interpretation</h3><p>{interpretation(selected)}</p></div><span className={styles.expiry}>Expires<strong>{time(selected.expiresAt)}</strong></span></div>
        <div className={styles.evidenceColumns}><div><span className={styles.eyebrow}>SUPPORTING EVIDENCE</span><p>{supportingEvidence(selected,snapshot)}</p></div><div><span className={styles.eyebrow}>STRONGEST CONTRADICTION</span><p>{selected.contradictions.find(c => c.includes("obstructs") || c.includes("may obstruct")) ?? selected.contradictions[0] ?? "No contradiction detected by these rules. Predictive skill is unproven."}</p></div></div>
        <p className={styles.invalidation}><strong>Invalidation</strong>{selected.bias === "UNAVAILABLE" ? "Restore valid completed-candle data before relying on price scenarios." : selected.lean?.direction === "UNCLEAR" ? "No directional thesis is established. Support and resistance breaks define the alternative scenarios below." : selected.invalidation}</p>
        {selected.levelRisk?.zone && !selected.continuationRisk && <p className={styles.footnote}>Continuation risk: {selected.levelRisk.explanation} {selected.levelRisk.distanceAtr?.toFixed(2)} primary-frame ATR from the zone.</p>}
        {selected.continuationRisk && <div className={styles.continuation}><strong>{continuationRiskLabel(selected)}</strong>{selected.continuationRisk.factors.map(factor=><p key={factor}>{factor}</p>)}</div>}
        <details><summary>Scenarios & strict assessment</summary><p><strong>Strict assessment: {selected.bias}</strong> · {selected.evidence} strict evidence. Its trend, momentum, strength and exhaustion thresholds are unchanged.</p><div className={styles.scenarios}><div><h4>Continuation</h4><p>{selected.continuation}</p></div><div><h4>Reversal</h4><p>{selected.reversal}</p></div></div><p>Volatility envelope {price(selected.movement.low)}–{price(selected.movement.high)} · ±{selected.movement.pips.toFixed(1)} pips. Heuristic, not a calibrated range.</p><h4>Directional evidence grading</h4>{selected.lean?.evidenceReasons?.map(reason=><p key={reason}>{reason}</p>)}<h4>Strict assessment rationale</h4>{selected.reasons.map(r => <p key={r}>{r}</p>)}<h4>Other contradictions</h4>{selected.contradictions.map(r => <p key={r}>{r}</p>)}<p>Reference {price(snapshot.referencePrice)} · {selected.frames.join(" / ")} emphasis. Scoring {snapshot.eligible ? "eligible" : "excluded for issue-time market/data conditions"}.</p></details>
      </div>}
    </section>

    <section className={styles.levelsSection} aria-label="Support and resistance"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>LOCATION MATTERS</p><h2>Nearby support & resistance</h2></div><span className={styles.explainer}>H4 · Daily · Weekly</span></div><ZoneTable zones={zones.slice(0,5)} precision={snapshot?.precision ?? 5} /><p className={styles.footnote}>Major requires H4/D1/W1, at least 3 reactions and mean rejection ≥0.25 ATR. *Holding means no confirmed break detected. These initial classifications do not predict whether a level will hold.</p>{zones.length > 5 && <details><summary>More levels & intraday zones</summary><ZoneTable zones={[...zones.slice(5),...(snapshot?.frames.H1.zones ?? [])]} precision={snapshot?.precision ?? 5} /></details>}</section>

    <details className={styles.utilitySection}><summary><span>Data Quality</span><small>{qualityLabel}{snapshot?.warnings.length ? ` · ${snapshot.warnings.length} notes` : ""}</small></summary><div className={styles.utilityBody}>{snapshot ? <><p>Quote {time(snapshot.marketAt)} · issued {time(snapshot.createdAt)} · spread {snapshot.spreadPips.toFixed(1)} pips · {snapshot.source}.</p><p>Technical snapshot {snapshot.technicalAvailable === false ? "unavailable" : "available"}. Forward scoring {snapshot.eligible ? "eligible" : "excluded"}. Live execution is not part of this analyzer.</p>{snapshot.warnings.map(w => <p key={w}>{w}</p>)}<p>Closed-market quotes are expected to age. During market hours, an unexpectedly stale quote affects price freshness and scoring, independently of completed-candle technical evidence.</p></> : <p>{error || "Run analysis to inspect verified OANDA data."}</p>}</div></details>
    {snapshot && <details className={styles.utilitySection}><summary><span>Technical details & exports</span><small>Indicators, structure and full diagnostics</small></summary><div className={styles.utilityBody}>{Object.values(snapshot.frames).map(f => <details key={f.frame}><summary>{f.frame} · {f.count} completed candles · {f.structure}</summary><p>Close {price(f.close)} · RSI {f.rsi.toFixed(2)} · ADX {f.adx.toFixed(2)} · ATR {price(f.atr)} · divergence {f.divergence ?? "none confirmed"}</p><p>EMA20 {price(f.ema20)} · EMA50 {price(f.ema50)} · EMA200 {price(f.ema200)}</p>{f.events.map((e,i) => <p key={i}>{e.kind} {e.direction} {price(e.level)} · {time(e.at)}</p>)}</details>)}<div className={styles.exportActions}><button onClick={() => void copy(true)}>Copy Full Technical Export</button><button onClick={() => setManualCopy(report)}>Show concise research report</button></div><p className={styles.muted}>Full export includes the original indicator snapshot, confirmation events, zones and diagnostics. Historical reports retain their original model and forecasts.</p></div></details>}
    {manualCopy !== null && <section className={styles.utilitySection}><div className={styles.utilityBody}><label htmlFor="technical-report">Research report · select to copy manually</label><textarea id="technical-report" readOnly value={manualCopy} onFocus={e => { e.currentTarget.select(); e.currentTarget.setSelectionRange(0,e.currentTarget.value.length); }} rows={12} /><button onClick={() => setManualCopy(null)}>Close report</button></div></section>}

    <details className={styles.utilitySection}><summary><span>Forecast history & validation</span><small>{history?.total ?? 0} horizon forecasts · no proven predictive accuracy</small></summary><div className={styles.utilityBody}><div className={styles.sectionHeading}><p>Completed, eligible forecasts only. Lean and strict assessment accuracy use separate samples. Accuracy is not profitability.</p><button disabled={historyBusy} onClick={() => void refreshHistory()}>{historyBusy ? "Evaluating…" : "Refresh outcomes"}</button></div>{historyError && <p role="alert" className={styles.error}>{historyError}</p>}{history?.scoringWarnings.map(w => <p key={w}>{w}</p>)}<div className={styles.tableScroll}><table><thead><tr><th>Group</th><th>Completed / strict calls</th><th>Strict accuracy</th><th>Lean calls / accuracy</th><th>Strict bull / bear</th><th>Strict baseline</th><th>Non-overlap n / accuracy</th></tr></thead><tbody>{history?.metrics.map(m => <tr key={m.label}><th>{m.label}</th><td>{m.completed} / {m.directional}</td><td>{percent(m.accuracy)}</td><td>{m.leanCalls ?? 0} / {percent(m.leanAccuracy ?? null)}</td><td>{percent(m.bullishAccuracy)} / {percent(m.bearishAccuracy)}</td><td>{percent(m.baselineAccuracy)}</td><td>{m.independent} / {percent(m.independentAccuracy)}</td></tr>)}</tbody></table></div><p className={styles.muted}>Baseline follows the issue-time Daily close versus EMA20 on the same directional sample. Overlapping forecasts are correlated; non-overlap is selected chronologically per pair and horizon. History refresh evaluates up to 50 due forecasts.</p><details><summary>Review original reports</summary>{history?.rows.map(r => <article className={styles.historyRow} key={r.id}><div><strong>{r.snapshot.instrument.replace("_","/")} · {r.forecast.horizon}D · {outlookDirection(r.forecast)}{r.forecast.lean ? " lean" : ""}</strong><p>Strict assessment: {r.forecast.bias} · {time(r.snapshot.createdAt)} → {r.outcome ? `${r.outcome.direction} · ${r.outcome.correct === null ? "abstained / unavailable" : r.outcome.correct ? "correct" : "miss"}` : "pending"}{!r.snapshot.eligible ? " · scoring excluded" : ""}</p></div><button disabled={busy} onClick={() => { setPair(r.snapshot.instrument); setSnapshot(r.snapshot); setHorizon(r.forecast.horizon); setClock(Date.now()); }}>Review</button></article>)}</details></div></details>
    <footer className={styles.footer}>Completed-candle evidence · No AI predictions or trade execution · Forecast rules have not demonstrated historical predictive skill.</footer>
  </div>;
}



