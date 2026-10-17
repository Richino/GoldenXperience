"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import { NEWS_TERMINAL, NEWS_V3_DEFAULTS, NEWS_V3_LABEL, type PublicNewsRun } from "@/lib/news/news-straddle-v3";
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
type SimpleRelease = { title: string; currency: string; timestamp: string };
export function NewsAcceptCard({ header, instrument, release, now, unavailableReason, busy, error, onAccept, onCancel }: {
  header?: ReactNode; instrument: string; release: SimpleRelease | null; now: number | null;
  unavailableReason: string | null; busy: boolean; error: string | null; onAccept(): void; onCancel(): void;
}) {
  return <>
    <div className={"nl-pe-plan " + styles.ticket}>
      {header}
      <div className={styles.intro}><h3>News trade</h3><span className={styles.badge}>Practice</span></div>
      <p className={styles.description}>GX watches {displayNameFor(instrument)} and handles the trade automatically.</p>
      <section className={styles.event} aria-label="Next news event">
        <span className={styles.eyebrow}>Next high-impact event</span>
        {release ? <>
          <h4>{release.title}</h4>
          <p>{release.currency} · {new Date(release.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</p>
          {now !== null ? <strong className={styles.countdown}>Starts in {countdown(Date.parse(release.timestamp) - now)}</strong> : null}
        </> : <p>{unavailableReason ?? "Checking upcoming news…"}</p>}
      </section>
      <p className={styles.description}>Both directions are covered. Entry, stop-loss and trailing protection are managed for you.</p>
      <div className={styles.risk}><span>Maximum planned risk</span><strong>1% of your account</strong></div>
      {release && unavailableReason ? <p className={styles.warning} role="status">{unavailableReason}</p> : null}
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      <p className={styles.note}>Accept starts monitoring and allows GX to place practice orders for this event.</p>
    </div>
    <footer className="nl-an-actions is-card nl-pe-actions">
      <button type="button" className="nl-an-secondary pressable" disabled={busy} onClick={onCancel}>Not now</button>
      <button type="button" className="nl-an-primary pressable" disabled={busy || !release || unavailableReason !== null} onClick={onAccept}>{busy ? "Starting…" : "Accept"}</button>
    </footer>
  </>;
}

export function BrokerNewsStraddleTicket({ header, instrument, bid, ask, creationBlocked, onCancel, onArmed, onDraft }: BrokerNewsTicketProps) {
  const { snapshot: calendar, loading } = useEconomicCalendar(), now = useDisplayClock();
  const { base, quote } = currenciesOf(instrument), pip = pipSizeFor(instrument), precision = precisionFor(instrument);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const accepting = useRef(false);
  const [runtime, setRuntime] = useState<{ halted: boolean; enabled?: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    request<NonNullable<typeof runtime>>("/api/news-straddles/runtime")
      .then(value => { if (active) setRuntime(value); })
      .catch(() => { if (active) setRuntime({ halted: false, enabled: false }); });
    return () => { active = false; };
  }, []);
  const release = useMemo(() => calendar.connected && calendar.source === "forex_factory" && now !== null
    ? calendar.events.filter(e => [base, quote].includes(e.currency) && e.impact >= 3 && e.timingVerified === true
      && !/tentative|all.day|summit|speaks|speech|meeting day/i.test(e.title)
      && Date.parse(e.timestamp) > now + 15_000 && Date.parse(e.timestamp) <= now + 5 * 3_600_000)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0] ?? null : null,
    [base, quote, calendar, now]);
  const buy = ask !== null ? Number((ask + NEWS_V3_DEFAULTS.distancePips * pip).toFixed(precision)) : null;
  const sell = bid !== null ? Number((bid - NEWS_V3_DEFAULTS.distancePips * pip).toFixed(precision)) : null;
  const releaseId = release?.id;
  useEffect(() => {
    onDraft?.(releaseId && buy !== null && sell !== null ? { distancePips: NEWS_V3_DEFAULTS.distancePips, depthPips: NEWS_V3_DEFAULTS.maxSlippagePips, buyEntry: buy, sellEntry: sell } : null);
  }, [releaseId, buy, sell, onDraft]);
  useEffect(() => () => onDraft?.(null), [onDraft]);
  const unavailableReason = creationBlocked ? "This pair already has an active trade or setup."
    : runtime?.halted ? "News monitoring is paused after an earlier issue."
    : runtime === null ? "Checking monitoring availability…"
    : runtime.enabled !== true ? "News monitoring is temporarily unavailable."
    : loading || now === null ? "Checking upcoming news…"
    : !calendar.connected ? "The news calendar is temporarily unavailable."
    : !release ? "No high-impact news for this pair in the next 5 hours." : null;

  async function accept() {
    if (!release || unavailableReason || accepting.current) return;
    accepting.current = true; setBusy(true); setError(null);
    try {
      // The existing arm endpoint checks calendar, broker and risk in this one request.
      await request("/api/pending-entries/news", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 3, instrument, settings: NEWS_V3_DEFAULTS,
          release: { id: release.id, title: release.title, currency: release.currency, time: release.timestamp } }) });
      onArmed("Monitoring started");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Monitoring could not start. Please try again.");
    } finally { accepting.current = false; setBusy(false); }
  }
  return <NewsAcceptCard header={header} instrument={instrument} release={release} now={now}
    unavailableReason={unavailableReason} busy={busy} error={error} onAccept={() => void accept()} onCancel={onCancel} />;
}
export function NewsV3StatusView({ run, now }: { run: PublicNewsRun; now: number | null }) {
  const digits = precisionFor(run.instrument), fmt = (n: number | null | undefined) => n === null || n === undefined ? "—" : n.toFixed(digits);
  const active = run.firstFillSide ? run.legs[run.firstFillSide] : null;
  const opposite = run.firstFillSide ? run.legs[run.firstFillSide === "long" ? "short" : "long"] : null;
  const current = now !== null && active?.lastProtectionAt && now - Date.parse(active.lastProtectionAt) < 5000;
  const pips = (n: number | null | undefined) => n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)} pips`;
  const simpleState: Record<PublicNewsRun["state"], string> = {
    SCHEDULED: "Monitoring", PREPARING: "Monitoring", READY: "Monitoring", SUBMITTING: "Preparing the trade",
    PENDING_ORDERS: "Watching for a move", OCO_CANCELLING: "Trade opened", OPEN: "Trade open", TRAILING: "Trade open",
    CANCELLING: "Stopping", EXCEPTION: "Stopping safely", CLOSED: "Trade finished", SKIPPED: "No trade taken",
    EXPIRED: "Monitoring finished", CANCELLED: "Monitoring stopped", HALTED: "Stopped · needs attention",
  };
  return <div className={styles.status}>
    <div className={styles.intro}><h3>{simpleState[run.state]}</h3><span className={styles.badge}>Practice</span></div>
    {run.reason ? <p className={styles.warning}>{run.reason}</p> : null}
    <p className={styles.note}>{displayNameFor(run.instrument)} · {run.release.currency} {run.release.title} · High impact<br />{clock(run.release.time)}</p>
    {now !== null && Date.parse(run.release.time) > now ? <p className={styles.countdown}>Release in {countdown(Date.parse(run.release.time) - now)}</p> : null}
    {active ? <section className={styles.card} aria-label="Trade summary"><dl className={styles.metrics}>
      <div><dt>{active.closedAt ? "Result" : "Current move"}</dt><dd>{active.closedAt && active.realizedPL !== null ? money(active.realizedPL, run.risk?.currency) : current ? pips(active.unrealizedPips) : "Waiting for an update"}</dd></div>
      {!active.closedAt ? <div><dt>Stop protection</dt><dd>{current ? pips(active.protectedPips) : "Checking with broker"}</dd></div> : null}
    </dl></section> : !NEWS_TERMINAL.includes(run.state) ? <p className={styles.description}>GX is watching this event. The entry, stop-loss and trailing protection are automatic.</p> : null}
    <details className={styles.more}><summary>Details</summary>
    <p className={styles.note}>{NEWS_V3_LABEL[run.state]}</p>
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
    </details>
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
    {confirm ? <><p>Close this practice trade and stop monitoring?</p><button type="button" disabled={busy} onClick={() => void stop()}>Stop trade</button><button type="button" onClick={() => setConfirm(false)}>Keep running</button></> : <button type="button" disabled={busy} onClick={() => run.firstFillSide ? setConfirm(true) : void stop()}>{busy ? "Stopping…" : run.firstFillSide ? "Stop trade" : "Stop monitoring"}</button>}
  </div> : null}</>;
}
