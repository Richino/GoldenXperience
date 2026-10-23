"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { PairAvatar } from "@/components/ui/pair-avatar";
import { apiUrl } from "@/lib/api/url";
import { createPairTrendsCache, PAIR_TRENDS_TTL_MS } from "@/lib/home/pair-trends-cache";
import { displayNameFor } from "@/lib/instruments/catalog";
import { getForexSessionStatus } from "@/lib/strategy/session";
import { rankWeeklyTrends, weeklyTiming, type PairTrendsSnapshot } from "@/lib/home/weekly-trends";
import styles from "./good-trends.module.css";

const REFRESH_MS = PAIR_TRENDS_TTL_MS;
// Load only after mount, as with the shared news calendar cache.
const trendsCache = createPairTrendsCache(async () => {
  const response = await fetch(apiUrl("/api/pair-trends"), {
    credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Trend data unavailable");
  return response.json() as Promise<PairTrendsSnapshot>;
}, { storage: () => window.sessionStorage });
const SHOWN = 5;
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
    let warmRetry: ReturnType<typeof setTimeout> | null = null;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const next = await trendsCache.load();
        if (next.scanStatus === "warming") {
          if (!controller.signal.aborted) {
            if (warmRetry !== null) clearTimeout(warmRetry);
            warmRetry = setTimeout(() => { void read(); }, 3_000);
          }
          return;
        }
        if (!controller.signal.aborted) { setSnapshot(next); setError(false); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        reading = false;
        if (!controller.signal.aborted) setNow(Date.now());
      }
    }
    void read();
    // Check expiration locally; fresh snapshots never start another request.
    const refreshVisible = () => { if (document.visibilityState === "visible") void read(); };
    const refresh = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      controller.abort(); window.clearInterval(refresh); window.clearInterval(clockTimer);
      if (warmRetry !== null) clearTimeout(warmRetry);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);

  const aligned = rankWeeklyTrends(snapshot?.pairs ?? []);
  const closed = now !== null && !getForexSessionStatus(new Date(now)).marketOpen;
  const stale = snapshot && now !== null && now - Date.parse(snapshot.checkedAt) > REFRESH_MS * 2;
  const row = (pair: PairTrendsSnapshot["pairs"][number]) => <Link key={pair.instrument}
    href={`/chart?instrument=${encodeURIComponent(pair.instrument)}`} className={styles.row}
    aria-label={`View ${displayNameFor(pair.instrument)} chart, Weekly and Daily ${pair.w1 === "UPTREND" ? "up" : "down"}, ${weeklyTiming(pair).label}`}>
    <PairAvatar instrument={pair.instrument} size={30} />
    <strong>{displayNameFor(pair.instrument)}</strong>
    <span className={styles.structure}>
      <span className={styles.direction} data-direction={pair.w1}>{pair.w1 === "UPTREND" ? "↑ Weekly up" : "↓ Weekly down"}</span>
      <small>{weeklyTiming(pair).label}</small>
    </span>
    <ArrowUpRight size={16} aria-hidden="true" />
  </Link>;

  return <section className={styles.card} aria-labelledby="home-good-trends-title" aria-busy={!snapshot && !error}>
    <header className={styles.header}><h2 id="home-good-trends-title">Weekly trends</h2>
      {snapshot?.pairs.length ? <span>{aligned.length} {aligned.length === 1 ? "pair" : "pairs"}</span> : null}
    </header>
    <p className={styles.description}>Weekly and Daily aligned · 4H confirmation first.</p>
    <div className={`${styles.list}${snapshot ? ` ${styles.resolved}` : ""}`}>
      <div className={styles.rows}>
        {!snapshot && !error ? <div aria-hidden="true">
          {Array.from({ length: SHOWN }, (_, index) => <div key={index} className={styles.skeletonRow}>
            <span className={styles.skeletonAvatar} />
            <span className={styles.skeletonPair} />
            <span className={styles.skeletonStructure}><span /><span /></span>
          </div>)}
        </div> : aligned.length ? aligned.slice(0, SHOWN).map(row)
          : <p className={styles.note}>{error || !snapshot?.pairs.length ? "Trend data is unavailable right now." : "No pairs have aligned Weekly and Daily trends right now."}</p>}
      </div>
      <div className={styles.more}>
        {aligned.length > SHOWN ? <details><summary>{aligned.length - SHOWN} more trends</summary>{aligned.slice(SHOWN).map(row)}</details> : null}
      </div>
    </div>
    <div className={styles.footer}>
      <p className={styles.checked}>{snapshot ? `Checked ${clock(snapshot.checkedAt)} ET` : error ? "Check unavailable" : <span className={styles.skeletonChecked} aria-hidden="true" />}</p>
      <p className={`${styles.status}${error || stale ? ` ${styles.warning}` : ""}`} role="status">
        {!snapshot && !error ? "Checking weekly trends…" : error || stale ? "Couldn’t refresh · retrying automatically." : closed ? "Market closed · latest available trends." : "\u00a0"}
      </p>
    </div>
  </section>;
}
