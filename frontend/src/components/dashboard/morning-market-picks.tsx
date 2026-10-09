"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PairAvatar } from "@/components/ui/pair-avatar";
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
  const news = read.news.state === "UNKNOWN"
    ? { tone: "unknown", text: "Calendar not verified" }
    : read.news.events.length
      ? { tone: "caution", text: `${read.news.events[0]!.currency} high impact · ${clock(read.news.events[0]!.at)} ET` }
      : { tone: "clear", text: "No blocking event in verified coverage" };
  const pips = (value: number | null | undefined) => (typeof value === "number" ? value.toFixed(1) : "—");
  return <article className={styles.pair}>
    <div className={styles.row}>
      {rank ? <span className={styles.rank} aria-label={`Rank ${rank}`}>{String(rank).padStart(2, "0")}</span> : null}
      <PairAvatar instrument={pair.instrument} size={34} />
      <div className={styles.identity}>
        <strong>{displayNameFor(pair.instrument)}</strong>
        <span className={styles.trend}>
          <span data-direction={read.direction}>{read.direction.toLowerCase()}</span> · M15 · H1 {read.h1Direction.toLowerCase()}
        </span>
      </div>
      <span className={styles.status} data-status={read.status}>{read.status.toLowerCase()}</span>
      <Link className={styles.chart} href={morningChartHref(pair.instrument)} aria-label={`View ${displayNameFor(pair.instrument)} chart`}>Chart <ArrowUpRight size={14} aria-hidden="true" /></Link>
    </div>
    <p className={styles.explanation}>{read.explanation}</p>
    <dl className={styles.tiles}>
      <div><dt>Spread</dt><dd>{pips(pair.spreadPips)}p</dd></div>
      <div><dt>ATR (14)</dt><dd>{pips(read.atrPips)}p</dd></div>
      <div><dt>Last 2h</dt><dd>{pips(read.recentRangePips)}p</dd></div>
    </dl>
    <p className={styles.news} data-tone={news.tone}><span aria-hidden="true" />News · {news.text}</p>
    <details className={styles.context}><summary>Levels &amp; news details</summary>
      <div className={styles.contextBody}>
        {near.length ? <div className={styles.metrics}>{near.map(l => `${l.name}: ${l.price.toFixed(precisionFor(pair.instrument))} (${l.context})`).join(" · ")}</div> : <p className={styles.metrics}>No nearby mapped levels.</p>}
        <div className={styles.metrics}>Room before opposing structure: {read.opposingRoomPips?.toFixed(1) ?? "unverified"}p · Realized 2h movement: {read.realizedVolatilityPips?.toFixed(1) ?? "unknown"}p · London so far: {read.sessionRangePips?.toFixed(1) ?? "unknown"}p</div>
        {read.news.events.map(e => <p className={styles.metrics} key={`${e.currency}-${e.at}-${e.title}`}>{e.currency} · {e.title} · High impact · {clock(e.at)} ET · {Math.round(e.minutesAway)}m from scan{e.overlapsWindow ? " · Morning window" : ""}</p>)}
        <div className={styles.metrics}>Relative suitability: {read.rankScore}/100 points · M15 through {pair.candlesAsOf ? clock(pair.candlesAsOf) : "unknown"} ET · Quote {pair.quoteAsOf ? clock(pair.quoteAsOf) : "unknown"} ET</div>
      </div>
    </details>
    {!rank ? <ul className={styles.reasons}>{[...read.reasons, ...read.cautions].map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
  </article>;
}

export function MorningMarketPicks({ initial }: { initial: MorningPicksSnapshot | null }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => initial ? Date.parse(initial.checkedAt) : 0);
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
    return () => { readController.abort(); window.clearInterval(timer); };
  }, []);
  return <MorningPicksDisplay snapshot={snapshot} error={error} now={now} />;
}

/** Pure view allows realistic fixture rendering without starting a scan or
 * persisting synthetic recommendations in the live application. */
export function MorningPicksDisplay({ snapshot, error = null, now }: {
  snapshot: MorningPicksSnapshot | null; error?: string | null; now: number;
}) {
  const run = snapshot?.current;
  const stale = Boolean(run && (snapshot?.state === "STALE" || now - Date.parse(run.evaluatedAt) > MORNING_SCAN_STALE_MS || error));
  const closed = snapshot?.state === "CLOSED";
  const outside = snapshot?.state === "OUTSIDE_WINDOW";
  const picks = run?.shortlist.map(i => run.pairs.find(p => p.instrument === i)).filter((p): p is PairTradability => Boolean(p?.selection)) ?? [];
  const caution = run?.pairs.filter(p => p.selection?.status === "CAUTION") ?? [];
  const rejected = run?.pairs.filter(p => p.selection?.status === "REJECTED") ?? [];
  return <section className={styles.card} aria-labelledby="morning-picks-title" aria-busy={snapshot?.refreshing}>
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>New York session</span>
        <h2 id="morning-picks-title">Morning Market Picks</h2>
      </div>
      {run ? <span className={styles.scanned}>{picks.length} pick{picks.length === 1 ? "" : "s"} · scanned {clock(run.evaluatedAt)} ET</span> : null}
    </header>
    <div role="status">
      {error || snapshot?.lastAttempt?.status === "FAILED" ? <p className={styles.warning}>Morning scan unavailable. {error && error !== "Morning scan unavailable." ? error : snapshot?.lastAttempt?.error}</p> : null}
      {closed ? <p className={styles.warning}>Forex market closed. Saved picks are not currently tradable.</p> : outside ? <p>Morning picks drop weekdays, 6:30–11 AM ET.</p> : null}
      {stale && !closed ? <p className={styles.warning}>Outdated saved results — current conditions have not been verified.</p> : null}
      {!snapshot && !error ? <p>Morning scan unavailable.</p> : !run && !closed && !outside && snapshot ? <p>{snapshot.refreshing ? "The server is preparing the morning shortlist…" : "Morning scan unavailable. No completed scan is available yet."}</p> : null}
    </div>
    {!closed && !outside && run ? <>
      {!picks.length ? <p>{run.status === "FAILED" ? "Morning scan unavailable." : "No markets currently meet your trading criteria."}</p> : picks.map((pair, index) => <PairRow key={pair.instrument} pair={pair} rank={index + 1} />)}
      {run.sharedCurrencies.length ? <p className={styles.warning}>Shared currency exposure: {run.sharedCurrencies.join(", ")}. These charts are not independent opportunities.</p> : null}
      {caution.length ? <details><summary>{caution.length} caution candidates</summary>{caution.map(p => <PairRow key={p.instrument} pair={p} />)}</details> : null}
      {rejected.length ? <details><summary>{rejected.length} rejected or unavailable markets</summary>{rejected.map(p => <div className={styles.rejected} key={p.instrument}><strong>{displayNameFor(p.instrument)}</strong> · {p.selection!.dataFailure ? "Data unavailable" : "Rejected"}<p>{p.selection!.reasons.join(" ")}</p></div>)}</details> : null}
    </> : null}
  </section>;
}
