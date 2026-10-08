"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, ArrowUpRight } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { morningChartHref, MORNING_SCAN_STALE_MS, type MorningPicksSnapshot } from "@/lib/strategy/morning-scan";
import type { PairTradability } from "@/lib/strategy/ny-tradability";
import styles from "./morning-market-picks.module.css";

function clock(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function PairRow({ pair, rank }: { pair: PairTradability; rank?: number }) {
  const read = pair.selection!;
  const near = [...new Map(read.levels.map(l => [l.price.toFixed(precisionFor(pair.instrument)), l])).values()].sort((a, b) => {
    const mark = read.referencePrice ?? 0;
    return Math.abs(a.price - mark) - Math.abs(b.price - mark);
  }).slice(0, 2);
  return <article className={styles.pair}>
    <div className={styles.row}>
      <strong>{rank ? <span className={styles.rank}>#{rank} </span> : null}{displayNameFor(pair.instrument)}</strong>
      <span className={styles.status} data-status={read.status}>{read.status}</span>
      <Link className={styles.chart} href={morningChartHref(pair.instrument)} aria-label={`View ${displayNameFor(pair.instrument)} chart`}>View Chart <ArrowUpRight size={14} aria-hidden="true" /></Link>
    </div>
    <div className={styles.metrics}>{read.direction.toLowerCase()} · M15 primary · H1 {read.h1Direction.toLowerCase()}</div>
    <p>{read.explanation}</p>
    <div className={styles.metrics}>
      Spread {pair.spreadPips?.toFixed(1) ?? "unknown"}p · ATR(14) {read.atrPips?.toFixed(1) ?? "unknown"}p · Last 2h range {read.recentRangePips?.toFixed(1) ?? "unknown"}p
    </div>
    <div className={styles.metrics}>News: {read.news.state === "UNKNOWN" ? "UNKNOWN — calendar not verified" : read.news.events.length ? `${read.news.events[0]!.currency} high impact, ${clock(read.news.events[0]!.at)} ET` : "No blocking event in verified coverage."}</div>
    <details className={styles.context}><summary>Levels &amp; news details</summary>
      {near.length ? <div className={styles.metrics}>{near.map(l => `${l.name}: ${l.price.toFixed(precisionFor(pair.instrument))} (${l.context})`).join(" · ")}</div> : <p>No nearby mapped levels.</p>}
      <div className={styles.metrics}>Room before opposing structure: {read.opposingRoomPips?.toFixed(1) ?? "unverified"}p · Realized 2h movement: {read.realizedVolatilityPips?.toFixed(1) ?? "unknown"}p · London so far: {read.sessionRangePips?.toFixed(1) ?? "unknown"}p</div>
      {read.news.events.map(e => <p key={`${e.currency}-${e.at}-${e.title}`}>{e.currency} · {e.title} · High impact · {clock(e.at)} ET · {Math.round(e.minutesAway)}m from scan{e.overlapsWindow ? " · Morning window" : ""}</p>)}
      <div className={styles.metrics}>Relative suitability: {read.rankScore}/100 points · M15 through {pair.candlesAsOf ? clock(pair.candlesAsOf) : "unknown"} ET · Quote {pair.quoteAsOf ? clock(pair.quoteAsOf) : "unknown"} ET</div>
    </details>
    {!rank ? <ul>{[...read.reasons, ...read.cautions].map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
  </article>;
}

export function MorningMarketPicks({ initial }: { initial: MorningPicksSnapshot | null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => initial ? Date.parse(initial.checkedAt) : 0);
  const controller = useRef<AbortController | null>(null);
  const refreshing = useRef(false);
  useEffect(() => {
    const readController = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(apiUrl("/api/morning-picks"), { credentials: "include", cache: "no-store", signal: readController.signal });
        if (!response.ok) throw new Error("Morning scan unavailable.");
        const next = await response.json() as MorningPicksSnapshot;
        if (!readController.signal.aborted) { setSnapshot(next); setNow(Date.now()); setError(null); }
      } catch { if (!readController.signal.aborted) { setError("Morning scan unavailable."); setNow(Date.now()); } }
    };
    void read();
    // Reads persisted results only. The API server owns all scanning.
    const timer = window.setInterval(() => { setNow(Date.now()); void read(); }, 30_000);
    return () => { readController.abort(); controller.current?.abort(); window.clearInterval(timer); };
  }, []);
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setBusy(true); setError(null);
    controller.current = new AbortController();
    try {
      const response = await fetch(apiUrl("/api/morning-picks/refresh"), { method: "POST", credentials: "include", cache: "no-store", signal: controller.current.signal });
      const next = await response.json() as MorningPicksSnapshot & { error?: string };
      if (!response.ok) throw new Error(next.error ?? "Morning scan unavailable.");
      setSnapshot(next); setNow(Date.now());
    } catch (cause) { if (!controller.current.signal.aborted) setError(cause instanceof Error ? cause.message : "Morning scan unavailable."); }
    finally { refreshing.current = false; setBusy(false); }
  }
  return <MorningPicksDisplay snapshot={snapshot} busy={busy} error={error} now={now} onRefresh={refresh} />;
}

/** Pure view allows realistic fixture rendering without starting a scan or
 * persisting synthetic recommendations in the live application. */
export function MorningPicksDisplay({ snapshot, busy = false, error = null, now, onRefresh }: {
  snapshot: MorningPicksSnapshot | null; busy?: boolean; error?: string | null; now: number; onRefresh: () => void;
}) {
  const run = snapshot?.current;
  const stale = Boolean(run && (snapshot?.state === "STALE" || now - Date.parse(run.evaluatedAt) > MORNING_SCAN_STALE_MS || error));
  const closed = snapshot?.state === "CLOSED";
  const outside = snapshot?.state === "OUTSIDE_WINDOW";
  const picks = run?.shortlist.map(i => run.pairs.find(p => p.instrument === i)).filter((p): p is PairTradability => Boolean(p?.selection)) ?? [];
  const caution = run?.pairs.filter(p => p.selection?.status === "CAUTION") ?? [];
  const rejected = run?.pairs.filter(p => p.selection?.status === "REJECTED") ?? [];
  return <section className={styles.card} aria-labelledby="morning-picks-title" aria-busy={busy || snapshot?.refreshing}>
    <header className={styles.header}><div><h2 id="morning-picks-title">Morning Market Picks</h2><p>Best markets to watch for the New York morning session.</p></div>
      <button className={styles.refresh} onClick={onRefresh} disabled={busy || snapshot?.refreshing || closed || outside} aria-label="Refresh morning market picks"><RefreshCw size={16} aria-hidden="true" className={busy ? styles.spin : undefined} />{busy || snapshot?.refreshing ? "Scanning…" : "Refresh"}</button>
    </header>
    <div className={styles.meta}>Normal · M15 / H1 · {run ? `Scanned ${clock(run.evaluatedAt)} ET` : "Weekdays from 6:30 AM ET, rechecked every 5 minutes until 11 AM."}</div>
    <div role="status">
      {error || snapshot?.lastAttempt?.status === "FAILED" ? <p className={styles.warning}>Morning scan unavailable. {error && error !== "Morning scan unavailable." ? error : snapshot?.lastAttempt?.error}</p> : null}
      {closed ? <p className={styles.warning}>Forex market closed. Saved picks are not currently tradable.</p> : outside ? <p>The morning scan window runs weekdays, 6:30–11 AM ET.</p> : null}
      {stale && !closed ? <p className={styles.warning}>Outdated saved results — current conditions have not been verified.</p> : null}
      {!snapshot && !error ? <p>Morning scan unavailable.</p> : !run && !closed && !outside && snapshot ? <p>{snapshot.refreshing ? "The server is preparing the morning shortlist…" : "Morning scan unavailable. No completed scan is available yet."}</p> : null}
    </div>
    {!closed && !outside && run ? <>
      {!picks.length ? <p>{run.status === "FAILED" ? "Morning scan unavailable." : "No markets currently meet your trading criteria."}</p> : picks.map((pair, index) => <PairRow key={pair.instrument} pair={pair} rank={index + 1} />)}
      {run.sharedCurrencies.length ? <p className={styles.warning}>Shared currency exposure: {run.sharedCurrencies.join(", ")}. These charts are not independent opportunities.</p> : null}
      {caution.length ? <details><summary>{caution.length} caution candidates</summary>{caution.map(p => <PairRow key={p.instrument} pair={p} />)}</details> : null}
      {rejected.length ? <details><summary>{rejected.length} rejected or unavailable markets</summary>{rejected.map(p => <div className={styles.rejected} key={p.instrument}><strong>{displayNameFor(p.instrument)}</strong> · {p.selection!.dataFailure ? "Data unavailable" : "Rejected"}<p>{p.selection!.reasons.join(" ")}</p></div>)}</details> : null}
    </> : null}
    <footer className={styles.meta}>Watchlist candidates for further review. Open a chart to inspect it and run Analyze.</footer>
  </section>;
}
