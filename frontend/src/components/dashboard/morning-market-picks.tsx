"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import { homeCalendarImpactTier } from "@/lib/news/home-calendar";
import { morningChartHref, MORNING_SCAN_STALE_MS, type MorningPicksSnapshot } from "@/lib/strategy/morning-scan";
import type { PairTradability } from "@/lib/strategy/ny-tradability";
import { MAJOR_INSTRUMENTS } from "@/types/forex";
import styles from "./morning-market-picks.module.css";

function clock(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
type TrendDirection = "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION" | "UNCLEAR";
/** 4H and daily structure per pair, from /api/pair-trends (the chart’s trend label). */
export type PairTrendsSnapshot = { checkedAt: string; pairs: { instrument: string; h4: TrendDirection; d1: TrendDirection }[] };

const TRENDS_SHOWN = 5;
const NEWS_LOOKAHEAD_MS = 24 * 60 * 60_000;

/** The news journal’s frozen pre-release calls (/api/news/predictions). */
type SignalRecord = { n: number; hits: number; scope: "series" | "overall" };
type JournalCall = {
  title: string; currency: string; impact: number | string; event_time: string;
  currency_call: "up" | "down" | null; signal_record?: SignalRecord | null;
};
export type NewsJournal = { predictions: JournalCall[] };

/** Smoothed hit rate, so a 1/1 record does not outrank 8/10 (as on the news sheet). */
const recordScore = (record: SignalRecord | null | undefined) => (record ? (record.hits + 1) / (record.n + 2) : 0);

type NewsLean = { pairMove: "up" | "down" | "mixed"; detail: string };

/**
 * What the next 24h of high-impact calls say about the pair. A call for the
 * base currency moves the pair the same way; for the quote currency, the
 * opposite way. Simultaneous releases that disagree lean with the clearly
 * better record, the same rule the news sheet uses; otherwise they are mixed.
 */
function newsLeanFor(instrument: string, journal: NewsJournal | null, now: number): NewsLean | null {
  if (!journal) return null;
  const { base, quote } = currenciesOf(instrument);
  const upcoming = journal.predictions.filter((row) => {
    const at = Date.parse(row.event_time);
    return (row.currency === base || row.currency === quote) && row.currency_call && at > now && at - now <= NEWS_LOOKAHEAD_MS
      && homeCalendarImpactTier(Number(row.impact)) === "high";
  });
  if (!upcoming.length) return null;
  const votes = upcoming.map((row) => ({ row, move: (row.currency === base) === (row.currency_call === "up") ? "up" as const : "down" as const }));
  const moves = new Set(votes.map((vote) => vote.move));
  let pairMove: NewsLean["pairMove"] = moves.size === 1 ? votes[0]!.move : "mixed";
  if (pairMove === "mixed") {
    const ranked = [...votes].sort((a, b) => recordScore(b.row.signal_record) - recordScore(a.row.signal_record));
    const leader = ranked[0]!;
    const runnerUp = ranked.find((vote) => vote.move !== leader.move);
    if (leader.row.signal_record && leader.row.signal_record.n >= 8 && runnerUp
      && recordScore(leader.row.signal_record) - recordScore(runnerUp.row.signal_record) >= 0.05) pairMove = leader.move;
  }
  const detail = votes.map(({ row }) => {
    const record = row.signal_record && row.signal_record.n > 0 ? ` (right ${row.signal_record.hits}/${row.signal_record.n})` : "";
    return `${row.currency} ${row.title} ${clock(row.event_time)} ET: ${row.currency} ${row.currency_call}${record}`;
  }).join("\n");
  return { pairMove, detail };
}
const MAJORS = new Set<string>(MAJOR_INSTRUMENTS);

/** The morning scan’s main caution, in two words. */
function cautionLabel(cautions: string[]) {
  if (cautions.some((c) => /news/i.test(c))) return "News soon";
  if (cautions.some((c) => /spread/i.test(c))) return "Wide spread";
  if (cautions.some((c) => /room/i.test(c))) return "Little room";
  if (cautions.some((c) => /opposes/i.test(c))) return "1H disagrees";
  return "Caution";
}

function TrendRow({ instrument, direction, caution, news }: { instrument: string; direction: "UPTREND" | "DOWNTREND"; caution?: string; news: NewsLean | null }) {
  const up = direction === "UPTREND";
  const trendMove = up ? "up" : "down";
  const note = !news ? `favour ${up ? "buys" : "sells"}`
    : news.pairMove === "mixed" ? "news mixed"
      : news.pairMove === trendMove ? "news agrees" : null;
  return <div className={styles.trendRow} title={news ? `News in the next 24h:\n${news.detail}` : undefined}>
    <PairAvatar instrument={instrument} size={30} />
    <div className={styles.identity}>
      <strong>{displayNameFor(instrument)}</strong>
      <span className={styles.trend}><span data-direction={direction}>{up ? "▲ Up" : "▼ Down"}</span> · {note ?? <>news says <span data-direction={news!.pairMove === "up" ? "UPTREND" : "DOWNTREND"}>{news!.pairMove === "up" ? "▲ up" : "▼ down"}</span></>}</span>
    </div>
    {caution ? <span className={styles.status} data-status="CAUTION" title="Flagged by this morning’s scan">{caution}</span> : null}
    <Link className={styles.chart} href={morningChartHref(instrument)} aria-label={`View ${displayNameFor(instrument)} chart`}><span>Chart</span> <ArrowUpRight size={14} aria-hidden="true" /></Link>
  </div>;
}

/**
 * Pairs whose 4H and daily structure agree. It describes the trend so far, not
 * a forecast. Pairs the morning scan rejected (spread too wide, news coverage
 * missing) are left out: a trend you cannot trade cheaply is not a good one.
 */
function GoodTrends({ trends, run, journal, now }: { trends: PairTrendsSnapshot; run: MorningPicksSnapshot["current"] | null | undefined; journal: NewsJournal | null; now: number }) {
  const selection = (instrument: string) => run?.pairs.find((pair) => pair.instrument === instrument)?.selection;
  const aligned = trends.pairs
    .filter((pair) => (pair.h4 === "UPTREND" || pair.h4 === "DOWNTREND") && pair.h4 === pair.d1)
    .filter((pair) => selection(pair.instrument)?.status !== "REJECTED")
    .sort((a, b) => Number(MAJORS.has(b.instrument)) - Number(MAJORS.has(a.instrument)) || a.instrument.localeCompare(b.instrument));
  const row = (pair: (typeof aligned)[number]) => {
    const read = selection(pair.instrument);
    return <TrendRow key={pair.instrument} instrument={pair.instrument} direction={pair.h4 as "UPTREND" | "DOWNTREND"} caution={read?.status === "CAUTION" ? cautionLabel(read.cautions) : undefined} news={newsLeanFor(pair.instrument, journal, now)} />;
  };
  return <div className={styles.trends}>
    <h3>Good trends <span>{aligned.length} pair{aligned.length === 1 ? "" : "s"} · 4H &amp; daily agree</span></h3>
    {aligned.length ? aligned.slice(0, TRENDS_SHOWN).map(row) : <p className={styles.metrics}>No tradable pair has the 4H and daily trending the same way right now.</p>}
    {aligned.length > TRENDS_SHOWN ? <details><summary>{aligned.length - TRENDS_SHOWN} more</summary>{aligned.slice(TRENDS_SHOWN).map(row)}</details> : null}
  </div>;
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
  const [trends, setTrends] = useState<PairTrendsSnapshot | null>(null);
  const [journal, setJournal] = useState<NewsJournal | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const [trendResponse, journalResponse] = await Promise.all([
          fetch(apiUrl("/api/pair-trends"), { credentials: "include", cache: "no-store", signal: controller.signal }),
          fetch(apiUrl("/api/news/predictions"), { credentials: "include", cache: "no-store", signal: controller.signal }).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        if (trendResponse.ok) setTrends(await trendResponse.json() as PairTrendsSnapshot);
        if (journalResponse?.ok) setJournal(await journalResponse.json() as NewsJournal);
      } catch { /* the section stays hidden until a read succeeds */ }
    };
    void read();
    const timer = window.setInterval(read, 15 * 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);
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
  return <MorningPicksDisplay snapshot={snapshot} error={error} now={now} trends={trends} journal={journal} />;
}

/** Pure view allows realistic fixture rendering without starting a scan or
 * persisting synthetic recommendations in the live application. */
export function MorningPicksDisplay({ snapshot, error = null, now, trends = null, journal = null }: {
  snapshot: MorningPicksSnapshot | null; error?: string | null; now: number; trends?: PairTrendsSnapshot | null; journal?: NewsJournal | null;
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
      {trends ? <GoodTrends trends={trends} run={run} journal={journal} now={now} /> : null}
      {run.sharedCurrencies.length ? <p className={styles.warning}>Shared currency exposure: {run.sharedCurrencies.join(", ")}. These charts are not independent opportunities.</p> : null}
      {caution.length ? <details><summary>{caution.length} caution candidates</summary>{caution.map(p => <PairRow key={p.instrument} pair={p} />)}</details> : null}
      {rejected.length ? <details><summary>{rejected.length} rejected or unavailable markets</summary>{rejected.map(p => <div className={styles.rejected} key={p.instrument}><strong>{displayNameFor(p.instrument)}</strong> · {p.selection!.dataFailure ? "Data unavailable" : "Rejected"}<p>{p.selection!.reasons.join(" ")}</p></div>)}</details> : null}
    </> : trends ? <GoodTrends trends={trends} run={run} journal={journal} now={now} /> : null}
  </section>;
}
