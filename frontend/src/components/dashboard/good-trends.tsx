"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { getForexSessionStatus } from "@/lib/strategy/session";
import { MAJOR_INSTRUMENTS } from "@/types/forex";
import type { PairTrendsSnapshot } from "./morning-market-picks";
import styles from "./good-trends.module.css";

const REFRESH_MS = 15 * 60_000;
const SHOWN = 5;
const MAJORS = new Set<string>(MAJOR_INSTRUMENTS);
const clock = (iso: string) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}).format(new Date(iso));

/** Trend discovery only: no morning shortlist, news predictions or trade filters. */
export function GoodTrends() {
  const [snapshot, setSnapshot] = useState<PairTrendsSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const response = await fetch(apiUrl("/api/pair-trends"), { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Trend data unavailable");
        const next = await response.json() as PairTrendsSnapshot;
        if (!Array.isArray(next.pairs) || !Number.isFinite(Date.parse(next.checkedAt))) throw new Error("Invalid trend snapshot");
        if (!controller.signal.aborted) { setSnapshot(next); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        reading = false;
        if (!controller.signal.aborted) setNow(Date.now());
      }
    }
    void read();
    const refresh = window.setInterval(read, REFRESH_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { controller.abort(); window.clearInterval(refresh); window.clearInterval(clockTimer); };
  }, []);

  const aligned = (snapshot?.pairs ?? [])
    .filter(pair => (pair.h4 === "UPTREND" || pair.h4 === "DOWNTREND") && pair.h4 === pair.d1)
    .sort((a, b) => Number(MAJORS.has(b.instrument)) - Number(MAJORS.has(a.instrument)) || a.instrument.localeCompare(b.instrument));
  const closed = now !== null && !getForexSessionStatus(new Date(now)).marketOpen;
  const stale = snapshot && now !== null && now - Date.parse(snapshot.checkedAt) > REFRESH_MS * 2;
  const row = (pair: PairTrendsSnapshot["pairs"][number]) => <Link key={pair.instrument}
    href={`/chart?instrument=${encodeURIComponent(pair.instrument)}`} className={styles.row}
    aria-label={`View ${displayNameFor(pair.instrument)} chart, trending ${pair.h4 === "UPTREND" ? "up" : "down"}`}>
    <PairAvatar instrument={pair.instrument} size={30} />
    <strong>{displayNameFor(pair.instrument)}</strong>
    <span className={styles.direction} data-direction={pair.h4}>{pair.h4 === "UPTREND" ? "↑ Trending up" : "↓ Trending down"}</span>
    <ArrowUpRight size={16} aria-hidden="true" />
  </Link>;

  return <section className={styles.card} aria-labelledby="home-good-trends-title" aria-busy={!snapshot && !error}>
    <header className={styles.header}><h2 id="home-good-trends-title">Good trends</h2>
      {snapshot?.pairs.length ? <span>{aligned.length} {aligned.length === 1 ? "pair" : "pairs"}</span> : null}
    </header>
    <p className={styles.description}>Daily and 4-hour charts moving the same way.</p>
    {closed ? <p className={styles.note}>Market closed · showing the latest available trends.</p> : null}
    <div role="status">
      {!snapshot ? <p className={styles.note}>{error ? "Trend data is unavailable right now." : "Checking trends…"}</p>
        : error || stale ? <p className={styles.warning}>Couldn’t refresh · showing the last trend check.</p> : null}
      {snapshot && !snapshot.pairs.length ? <p className={styles.note}>Trend data is unavailable right now.</p>
        : snapshot && !aligned.length ? <p className={styles.note}>No pairs have a clear trend on both charts right now.</p> : null}
    </div>
    {aligned.length ? <div className={styles.list}>{aligned.slice(0, SHOWN).map(row)}
      {aligned.length > SHOWN ? <details><summary>{aligned.length - SHOWN} more trends</summary>{aligned.slice(SHOWN).map(row)}</details> : null}
    </div> : null}
    {snapshot ? <p className={styles.checked}>Checked {clock(snapshot.checkedAt)} ET</p> : null}
  </section>;
}
