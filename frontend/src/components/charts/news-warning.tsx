"use client";

import { useEffect, useState } from "react";
import { currenciesOf } from "@/lib/instruments/catalog";
import { groupedCalendarTitle, groupSimultaneousRows, homeCalendarImpactTier } from "@/lib/news/home-calendar";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";

/**
 * On the new-trade ticket: a heads-up when high-impact news for either of the
 * pair's currencies is about to land (or just landed). Spreads widen and price
 * can jump past a stop around these releases, so the plan is to wait until
 * after them. A swing trade also sees the next release it will likely hold
 * through.
 */

const MINUTE = 60_000;
const DANGER_BEFORE = 30 * MINUTE;
const CAUTION_BEFORE = 120 * MINUTE;
const AFTER_RELEASE = 15 * MINUTE;
const SWING_LOOKAHEAD = 5 * 24 * 60 * MINUTE;

function until(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function NewsWarning({ instrument, tradeStyle = "day" }: { instrument: string; tradeStyle?: "day" | "swing" }) {
  const { snapshot: calendar, loading } = useEconomicCalendar();
  // A ticking clock after mount, so the countdown stays current while the ticket is open.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock only exists in the browser
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading || now === null) return null;
  if (!calendar.connected) {
    return <p className="nl-news-warning is-caution" role="status">Calendar down · check the news yourself</p>;
  }

  const { base, quote } = currenciesOf(instrument);
  const relevant = [...(calendar.recentEvents ?? []), ...calendar.events].filter(
    (event) => (event.currency === base || event.currency === quote) && homeCalendarImpactTier(event.impact) === "high",
  );
  const seen = new Set<string>();
  const unique = relevant.filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)));
  const groups = groupSimultaneousRows(unique.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
  const label = (group: (typeof groups)[number]) => `${group.currency} ${groupedCalendarTitle(group.events)}`;

  const justReleased = groups.find((group) => {
    const time = Date.parse(group.timestamp);
    return time <= now && now - time <= AFTER_RELEASE;
  });
  const next = groups.find((group) => Date.parse(group.timestamp) > now);
  const nextIn = next ? Date.parse(next.timestamp) - now : null;

  if (next && nextIn !== null && nextIn <= DANGER_BEFORE) {
    return (
      <p className="nl-news-warning is-danger" role="alert">
        <b>{label(next)} in {until(nextIn)}</b> · wait until after it
      </p>
    );
  }
  if (justReleased) {
    return (
      <p className="nl-news-warning is-caution" role="status">
        <b>{label(justReleased)} out {until(now - Date.parse(justReleased.timestamp))} ago</b> · check the spread
      </p>
    );
  }
  if (next && nextIn !== null && nextIn <= CAUTION_BEFORE) {
    return (
      <p className="nl-news-warning is-caution" role="status">
        <b>{label(next)} in {until(nextIn)}</b> · hold through it or wait?
      </p>
    );
  }
  if (tradeStyle === "swing" && next && nextIn !== null && nextIn <= SWING_LOOKAHEAD) {
    return (
      <p className="nl-news-warning is-info" role="status">
        Next high-impact: <b>{label(next)}</b> in {until(nextIn)}
      </p>
    );
  }
  return null;
}
