"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import { NEWS_TERMINAL, NEWS_V3_DEFAULTS, NEWS_V3_LABEL, type NewsV3Preview, type NewsV3Settings, type PublicNewsRun } from "@/lib/news/news-straddle-v3";
import type { NewsDraft } from "@/lib/news/news-zone-overlay";
import type { PendingManualEntry } from "@/types/pending-entry";
import styles from "./news-straddle-v3.module.css";

export type BrokerNewsTicketProps = { header: ReactNode; instrument: string; bid: number | null; ask: number | null; creationBlocked: boolean; onCancel(): void; onArmed(message: string): void; onDraft?(draft: NewsDraft | null): void };
const clock = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const countdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const money = (n: number, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiUrl(path), { credentials: "include", cache: "no-store", ...init });
  const value = await r.json() as T & { error?: string };
  if (!r.ok) throw new Error(value.error ?? "News setup request failed.");
  return value;
}
function useDisplayClock() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const update = () => setNow(Date.now()); update(); const timer = window.setInterval(update, 1000); return () => clearInterval(timer); }, []);
  return now;
}
export function BrokerNewsStraddleTicket({ header, instrument, bid, ask, creationBlocked, onCancel, onArmed, onDraft }: BrokerNewsTicketProps) {
  const { snapshot: calendar, loading } = useEconomicCalendar(), now = useDisplayClock();
  const { base, quote } = currenciesOf(instrument), precision = precisionFor(instrument), pip = pipSizeFor(instrument);
  const [settings, setSettings] = useState<NewsV3Settings>({ ...NEWS_V3_DEFAULTS });
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<{ key: string; value: NewsV3Preview } | null>(null);
  const [runtime, setRuntime] = useState<{ halted: boolean; halt_reason?: string | null; enabled?: boolean } | null>(null);
  useEffect(() => { let active = true; request<typeof runtime>("/api/news-straddles/runtime").then(r => { if (active) setRuntime(r); }).catch(() => { if (active) setRuntime({ halted: false, enabled: false }); }); return () => { active = false; }; }, []);
  const releases = useMemo(() => calendar.connected && calendar.source === "forex_factory" && now !== null ? calendar.events.filter(e => [base, quote].includes(e.currency) && e.impact >= 3 && e.timingVerified === true && !/tentative|all.day|summit|speaks|speech|meeting day/i.test(e.title) && Date.parse(e.timestamp) > now + 15_000 && Date.parse(e.timestamp) <= now + 5 * 3_600_000).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) : [], [base, quote, calendar, now]);
  const release = releases.find(e => e.id === selected) ?? releases[0] ?? null;
  const key = JSON.stringify({ instrument, settings, releaseId: release?.id });
  const checked = preview?.key === key && now !== null && now - Date.parse(preview.value.checkedAt) <= 30_000 ? preview.value : null;
  const buy = ask !== null ? Number((ask + settings.distancePips * pip).toFixed(precision)) : null;
  const sell = bid !== null ? Number((bid - settings.distancePips * pip).toFixed(precision)) : null;
  useEffect(() => { onDraft?.(release && buy !== null && sell !== null && settings.distancePips > 0 ? { distancePips: settings.distancePips, depthPips: settings.maxSlippagePips, buyEntry: buy, sellEntry: sell } : null); }, [buy, sell, release?.id, settings.distancePips, settings.maxSlippagePips, onDraft]); // eslint-disable-line react-hooks/exhaustive-deps -- only the stable release identity controls a chart draft
  useEffect(() => () => onDraft?.(null), [onDraft]);
  const update = (name: keyof NewsV3Settings, value: number | string) => { setSettings(s => ({ ...s, [name]: value })); setError(null); };
  const field = (label: string, name: keyof NewsV3Settings, unit: string, min = 0.1, max = 500, step = 0.1) => <label key={name}><span>{label}<small>{unit}</small></span><input aria-label={label} type="number" inputMode="decimal" min={min} max={max} step={step} value={String(settings[name])} onChange={e => update(name, e.target.value === "" ? "" : Number(e.target.value))} disabled={busy} /></label>;
  const payload = () => ({ version: 3, instrument, settings, release: release ? { id: release.id, title: release.title, currency: release.currency, time: release.timestamp } : null });
  async function check() {
    if (!release) return; setBusy(true); setError(null);
    try { const value = await request<NewsV3Preview>("/api/pending-entries/news/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) }); setPreview({ key, value }); }
    catch (e) { setError(e instanceof Error ? e.message : "Order checks failed."); } finally { setBusy(false); }
  }
  async function arm() {
    if (!checked || !release) return; setBusy(true); setError(null);
    try { await request("/api/pending-entries/news", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) }); onArmed("Practice news setup scheduled · backend targets T−2s"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not schedule the setup."); } finally { setBusy(false); }
  }
  const unavailable = !release || creationBlocked || runtime?.enabled === false || runtime?.halted;
  return <>
    <div className={`nl-pe-plan ${styles.ticket}`}>
      {header}
      <div className={styles.intro}><h3>News Straddle</h3><span className={styles.badge}>Practice only</span></div>
      <p className={styles.note}>Two protected STOP orders target 2 seconds before a high-impact release. First fill requests cancellation of the opposite order.</p>
      {runtime?.halted ? <div className={styles.warning} role="status">News entries are paused: {runtime.halt_reason}<button type="button" onClick={async () => { try { await request("/api/news-straddles/reset-pause", { method: "POST" }); setRuntime(r => r ? { ...r, halted: false } : null); } catch (e) { setError(String(e)); } }}>Reset safety pause</button></div> : null}
      <section className={styles.card} aria-label="Economic release">
        <div className={styles.cardTitle}><strong>{displayNameFor(instrument)}</strong><span className={styles.impact}>High impact</span></div>
        {release ? <>
          <label className={styles.release}><span>Economic release</span><select value={release.id} onChange={e => { setSelected(e.target.value); setError(null); }} disabled={busy}>{releases.map(e => <option key={e.id} value={e.id}>{e.currency} · {e.title} · {clock(e.timestamp)}</option>)}</select></label>
          <dl className={styles.metrics}><div><dt>Release in</dt><dd>{now === null ? "—" : countdown(Date.parse(release.timestamp) - now)}</dd></div><div><dt>Submission target</dt><dd>{clock(new Date(Date.parse(release.timestamp) - 2000).toISOString())}</dd></div></dl>
        </> : <p className={styles.note}>{loading ? "Checking the economic calendar…" : calendar.connected ? `No verified, precisely timed high-impact ${base}/${quote} release in the next 5 hours.` : "The verified economic calendar is unavailable. No setup can be armed."}</p>}
      </section>
      <section className={styles.card} aria-label="News strategy settings">
        <div className={styles.cardTitle}><strong>Entry & protection</strong><span className={styles.subtle}>No fixed target</span></div>
        <div className={styles.fields}>
          {field("Entry offset", "distancePips", "pips from ask / bid", 0.1, 200)}
          <label><span>Initial stop<small>−1R reference</small></span><select aria-label="Initial stop mode" value={settings.stopMode} onChange={e => update("stopMode", e.target.value)} disabled={busy}><option value="ATR">ATR · M1</option><option value="FIXED">Fixed pips</option></select></label>
          {settings.stopMode === "FIXED" ? field("Stop distance", "stopPips", "pips") : field("ATR multiplier", "atrMultiplier", "14 completed M1 ranges", 0.25, 10, 0.25)}
          {field("Trailing activation", "trailingActivationPips", "favorable executable pips")}
          {field("Trailing distance", "trailingDistancePips", "broker managed · pips")}
        </div>
        <p className={styles.note}>At +{settings.trailingActivationPips} pips, the {settings.trailingDistancePips}-pip trail aims to protect about +{Math.max(0, Number(settings.trailingActivationPips) - Number(settings.trailingDistancePips)).toFixed(1)} pips. The original broker stop stays in place. These are experimental settings.</p>
      </section>
      <section className={styles.card} aria-label="Event risk budget">
        <div className={styles.cardTitle}><strong>Risk budget</strong><span className={styles.subtle}>No doubled risk</span></div>
        <div className={styles.fields}>{field("Maximum event risk", "maxEventRiskPercent", "% equity · both orders", 0.01, 5, 0.01)}{field("Per-trade risk cap", "riskPerTradePercent", "% equity", 0.01, 5, 0.01)}</div>
        <p className={styles.note}>Each order gets at most {Math.min(Number(settings.riskPerTradePercent), Number(settings.maxEventRiskPercent) / 2).toFixed(2)}% equity. The event cap also covers other pairs armed for the same release.</p>
      </section>
      <details className={styles.more}><summary>Spread, slippage & emergency limits</summary><div className={styles.fields}>
        {field("Maximum spread", "maxSpreadPips", "pips", 0.1, 50)}{field("Maximum entry slippage", "maxSlippagePips", "price bound · pips", 0.1, 50)}
        {field("Unfilled order window", "windowSeconds", "seconds after release", 5, 900, 1)}
        {field("Minimum ATR stop", "minimumStopPips", "pips", 0.1, 100)}{field("Maximum approved stop", "maximumStopPips", "pips", 1, 500)}
        {field("Emergency loss threshold", "emergencyLossR", "R · attempts exit", 1, 5)}{field("Emergency spread exit", "emergencySpreadPips", "pips · 0 disables", 0, 100)}
        {field("Broker disconnect grace", "disconnectExitSeconds", "seconds before emergency exit", 5, 300, 1)}{field("Maximum holding time", "maxHoldMinutes", "minutes · 0 disables", 0, 240, 1)}
      </div><p className={styles.note}>If both orders cannot be confirmed in time: cancel and reconcile both, then close this setup’s exposure. Double fills pause further news entries and trigger the same emergency policy.</p></details>
      <section className={styles.card} aria-label="Order preview">
        <div className={styles.cardTitle}><strong>STOP entries</strong><span className={styles.subtle}>{checked ? "Broker checked" : "Indicative until checked"}</span></div>
        <dl className={styles.metrics}><div><dt>BUY STOP · ask + offset</dt><dd className={styles.buy}>{(checked?.buyEntry ?? buy)?.toFixed(precision) ?? "—"}</dd></div><div><dt>SELL STOP · bid − offset</dt><dd className={styles.sell}>{(checked?.sellEntry ?? sell)?.toFixed(precision) ?? "—"}</dd></div>
          {checked ? <><div><dt>Initial stop</dt><dd>{checked.risk.stopPips.toFixed(1)} pips · −1R</dd></div><div><dt>Each order</dt><dd>{(checked.units / 100000).toFixed(2)} lots · {money(checked.risk.perLegCash, checked.risk.currency)}</dd></div><div><dt>Combined planned risk</dt><dd>{money(checked.risk.perLegCash * 2, checked.risk.currency)} / {money(checked.risk.eventCash, checked.risk.currency)} cap</dd></div></> : null}
        </dl>
        <button type="button" className={styles.check} disabled={busy || !!unavailable} onClick={() => void check()}>{busy ? "Checking…" : checked ? "Recheck order & risk" : "Check order & risk"}</button>
      </section>
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      {creationBlocked ? <p className={styles.warning}>This pair already has exposure. No new setup can be armed.</p> : null}
      {runtime?.enabled === false ? <p className={styles.warning}>The practice news scheduler is unavailable on this API instance.</p> : null}
      <p className={styles.note}>The browser countdown is display only. The backend rechecks the release, bid/ask, spread, clock and risk. Timing, OCO cancellation and stop execution prices cannot be guaranteed.</p>
    </div>
    <footer className="nl-an-actions is-card nl-pe-actions"><button type="button" className="nl-an-secondary pressable" onClick={onCancel}>Cancel</button><button type="button" className="nl-an-primary pressable" disabled={busy || !checked || !!unavailable} onClick={() => void arm()}>{busy ? "Working…" : "Arm practice setup"}</button></footer>
  </>;
}

export function NewsV3StatusView({ run, now }: { run: PublicNewsRun; now: number | null }) {
  const digits = precisionFor(run.instrument), fmt = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toFixed(digits);
  const active = run.firstFillSide ? run.legs[run.firstFillSide] : null;
  const opposite = run.firstFillSide ? run.legs[run.firstFillSide === "long" ? "short" : "long"] : null;
  const current = now !== null && active?.lastProtectionAt && now - Date.parse(active.lastProtectionAt) < 5000;
  const pips = (n: number | null | undefined) => n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} pips`;
  return <div className={styles.status}>
    <div className={styles.intro}><h3>{NEWS_V3_LABEL[run.state]}</h3><span className={styles.badge}>Practice</span></div>
    {run.reason ? <p className={styles.warning}>{run.reason}</p> : null}
    <p className={styles.note}>{displayNameFor(run.instrument)} · {run.release.currency} {run.release.title} · High impact<br />{clock(run.release.time)}</p>
    {!run.levelsFrozenAt && ["SCHEDULED", "PREPARING", "READY"].includes(run.state) ? <p className={styles.note}>Entry prices are indicative. The backend freezes fresh bid/ask-based levels before submission.</p> : null}
    {now !== null && Date.parse(run.release.time) > now ? <p className={styles.countdown}>Release in {countdown(Date.parse(run.release.time) - now)}</p> : null}
    <section className={styles.card} aria-label="Broker order status"><dl className={styles.metrics}>
      {(["long", "short"] as const).map(side => { const l = run.legs[side]; return <div key={side}><dt>{side === "long" ? "BUY STOP" : "SELL STOP"}</dt><dd>{fmt(l.entry)}<small>{l.state.replaceAll("_", " ")}</small></dd></div>; })}
      <div><dt>Opposite order cancellation</dt><dd>{opposite?.state === "CANCELLED" && opposite.cancellationConfirmedAt ? "Confirmed by broker" : opposite?.cancellationRequestedAt ? "Requested · awaiting confirmation" : run.exception ? "Exception · reconciling" : "After first verified fill"}</dd></div>
      <div><dt>Initial stop</dt><dd>{active ? fmt(active.initialStop) : `${run.risk?.stopPips.toFixed(1) ?? "—"} pips`} · −1R</dd></div>
      <div><dt>Trailing settings</dt><dd>+{run.settings.trailingActivationPips}p activation / {run.settings.trailingDistancePips}p distance</dd></div>
      <div><dt>Fixed take-profit</dt><dd>Disabled</dd></div>
      <div><dt>Planned risk / order</dt><dd>{run.risk ? `${money(run.risk.perLegCash, run.risk.currency)} (${run.risk.perLegPercent.toFixed(2)}%)` : "Rechecking"}</dd></div>
    </dl></section>
    {active ? <section className={styles.card} aria-label="Trade performance"><dl className={styles.metrics}>
      <div><dt>Unrealized · executable price</dt><dd>{current ? pips(active.unrealizedPips) : active.closedAt ? "Closed" : "Waiting for fresh verification"}</dd></div>
      <div><dt>Maximum favorable · observed</dt><dd>{pips(active.maximumFavorablePips)}</dd></div>
      <div><dt>Currently protected</dt><dd>{current ? pips(active.protectedPips) : active.closedAt ? "Closed" : "Last known: " + pips(active.protectedPips)}</dd></div>
      <div><dt>Confirmed broker stop</dt><dd>{fmt(active.activeStop)}</dd></div>
      <div><dt>Trailing order</dt><dd>{active.trailingActivatedAt ? "Broker active" : active.trailingRequestedAt ? "Awaiting broker confirmation" : "Not activated"}</dd></div>
      <div><dt>Realized profit / loss</dt><dd>{active.realizedPL === null ? "Not closed" : money(active.realizedPL, run.risk?.currency)}</dd></div>
      <div><dt>Realized R</dt><dd>{active.realizedR === null ? "—" : `${active.realizedR.toFixed(2)}R`}</dd></div>
      <div><dt>Realized price movement</dt><dd>{pips(active.realizedPips)}</dd></div>
    </dl></section> : null}
    {Object.values(run.legs).every(l => l.state === "FILLED") ? <section className={styles.card} aria-label="Exception exposure and results"><dl className={styles.metrics}>
      <div><dt>Last verified open trades</dt><dd>{run.ownedOpenTradeIds?.length ?? "Awaiting reconciliation"}</dd></div>
      <div><dt>Other fill realized P/L</dt><dd>{opposite?.realizedPL === null || opposite?.realizedPL === undefined ? "Awaiting verified closure" : money(opposite.realizedPL, run.risk?.currency)}</dd></div>
      <div><dt>Combined realized P/L</dt><dd>{Object.values(run.legs).every(l => l.realizedPL !== null) ? money(Object.values(run.legs).reduce((sum, l) => sum + l.realizedPL!, 0), run.risk?.currency) : "Awaiting both broker closures"}</dd></div>
    </dl></section> : null}
    <details className={styles.more}><summary>Submission, fills & execution audit</summary><dl className={styles.metrics}>
      <div><dt>Intended submission</dt><dd>{clock(run.targetSubmitAt)}</dd></div>
      {Object.values(run.legs).map(l => <div key={l.side}><dt>{l.side === "long" ? "BUY" : "SELL"} submission / acknowledgment</dt><dd>{l.httpDispatchedAt ? clock(l.httpDispatchedAt) : "Not dispatched"}<small>{l.acknowledgedAt ? `Ack ${clock(l.acknowledgedAt)}` : "No acknowledgment"}</small>{l.fillTime ? <small>Fill {clock(l.fillTime)} · {fmt(l.fillPrice)} · {pips(l.slippagePips)} slippage</small> : null}{l.fillSpreadPips !== null ? <small>Fill spread {l.fillSpreadPips.toFixed(1)}p</small> : null}</dd></div>)}
    </dl></details>
    <ol className={styles.timeline} aria-label="News setup history">{run.timeline.slice(-6).map((item, i) => <li key={`${item.at}-${i}`}><time>{new Date(item.at).toLocaleTimeString()}</time> {item.detail}</li>)}</ol>
  </div>;
}

export function BrokerNewsSetupStatus({ entry }: { entry: PendingManualEntry; bid: number | null; ask: number | null }) {
  const id = String(entry.metadata.straddleId ?? ""), now = useDisplayClock();
  const [run, setRun] = useState<PublicNewsRun | null>(() => entry.metadata.newsRun as PublicNewsRun | undefined ?? null);
  const [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true, pending = false; const refresh = async () => { if (pending) return; pending = true; try { const next = await request<PublicNewsRun>(`/api/news-straddles/${id}`); if (active) { setRun(next); setError(null); } } catch { if (active) setError("Status refresh is unavailable. Displaying the last saved broker observations."); } finally { pending = false; } }; void refresh(); const t = window.setInterval(() => void refresh(), 1000); return () => { active = false; clearInterval(t); }; }, [id]);
  async function stop() { setBusy(true); try { await request(`/api/news-straddles/${id}`, { method: "DELETE" }); setConfirm(false); } catch (e) { setError(e instanceof Error ? e.message : "Cancellation could not be requested."); } finally { setBusy(false); } }
  if (!run) return <p className={styles.note}>{error ?? "Loading broker setup status…"}</p>;
  return <><NewsV3StatusView run={run} now={now} />{error ? <p className={styles.warning} role="status">{error}</p> : null}{!NEWS_TERMINAL.includes(run.state) ? <div className={styles.stop}>
    {confirm ? <><p>This requests cancellation of both orders and closes only trades opened by this setup. Broker confirmation may take time.</p><button type="button" disabled={busy} onClick={() => void stop()}>Confirm stop & close</button><button type="button" onClick={() => setConfirm(false)}>Keep running</button></> : <button type="button" onClick={() => setConfirm(true)}>Stop setup & close its trades</button>}
  </div> : null}</>;
}
