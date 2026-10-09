"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import {
  tradabilityPhase,
  type PairTradability,
  type TradabilitySnapshot,
} from "@/lib/strategy/ny-tradability";

/** One request per this many pairs; the API caps a batch at 40. */
const BATCH_SIZE = 40;
/** Re-read every minute: quotes move the spread check; candles only move each 15m. */
const REFRESH_MS = 60_000;
/** A read older than this is never shown as current. */
const STALE_AFTER_MS = 3 * 60_000;

/**
 * NY session tradability for the given pairs, from the shared
 * `/api/ny-tradability` detector. Only the Chart pair picker and the Markets
 * list use it. Pairs are requested in batches whenever the set changes and
 * then every minute while `enabled`. A read that has gone stale (failed
 * refreshes) or was scored before the window closed is reported as such,
 * never as a current score.
 */
export function useNyTradability(instruments: readonly string[], enabled: boolean) {
  const [byInstrument, setByInstrument] = useState<ReadonlyMap<string, PairTradability>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const key = useMemo(() => [...new Set(instruments)].sort().join(","), [instruments]);

  useEffect(() => {
    if (!enabled || !key) return;
    const list = key.split(",");
    const controller = new AbortController();
    const load = () => {
      for (let start = 0; start < list.length; start += BATCH_SIZE) {
        const batch = list.slice(start, start + BATCH_SIZE);
        void fetch(apiUrl(`/api/ny-tradability?instruments=${batch.join(",")}`), {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        })
          .then((response) => (response.ok ? (response.json() as Promise<TradabilitySnapshot>) : null))
          .then((snapshot) => {
            if (!snapshot) return;
            setByInstrument((previous) => {
              const next = new Map(previous);
              for (const pair of snapshot.pairs) next.set(pair.instrument, pair);
              return next;
            });
            setNow(Date.now());
          })
          .catch(() => {
            // The staleness check below takes over if refreshes keep failing.
          });
      }
    };
    load();
    const refresh = window.setInterval(load, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(refresh);
      window.clearInterval(tick);
    };
  }, [enabled, key]);

  return useMemo(() => {
    const phaseNow = tradabilityPhase(new Date(now));
    const current = new Map<string, PairTradability>();
    for (const [instrument, item] of byInstrument) {
      if (phaseNow === "outside" && item.phase !== "outside") {
        current.set(instrument, { ...item, status: "OUTSIDE_NY_WINDOW", phase: "outside", score: null, summary: "The New York window has closed." });
      } else if (now - Date.parse(item.evaluatedAt) > STALE_AFTER_MS) {
        current.set(instrument, { ...item, selection: undefined, status: "UNAVAILABLE", score: null, summary: "The last read is out of date; refreshing." });
      } else {
        current.set(instrument, item);
      }
    }
    return current;
  }, [byInstrument, now]);
}

function label(item: PairTradability) {
  if (item.phase !== "outside" && item.selection) return `${item.selection.status === "QUALIFIED" ? "Qualified" : item.selection.status === "CAUTION" ? "Caution" : "Rejected"} · ${item.selection.rankScore}/100 suitability`;
  switch (item.status) {
    case "HIGHLY_TRADABLE":
      return `Highly tradable · ${item.score}/100`;
    case "MODERATELY_TRADABLE":
      return `Moderately tradable · ${item.score}/100`;
    case "LOW_TRADABILITY":
      return `Low tradability · ${item.score}/100`;
    case "BLOCKED":
      return item.block === "spread" ? "Blocked: spread too wide" : "Blocked: high-impact news";
    case "OUTSIDE_NY_WINDOW":
      return "Outside NY window";
    default:
      return "Data unavailable";
  }
}

/** The same read in a few characters, for narrow rows (Markets on a phone). */
function shortLabel(item: PairTradability) {
  if (item.phase !== "outside" && item.selection) return `${item.selection.status === "QUALIFIED" ? "Qualified" : item.selection.status === "CAUTION" ? "Caution" : "Rejected"} · ${item.selection.rankScore}`;
  switch (item.status) {
    case "HIGHLY_TRADABLE":
      return `High · ${item.score}`;
    case "MODERATELY_TRADABLE":
      return `Moderate · ${item.score}`;
    case "LOW_TRADABILITY":
      return `Low · ${item.score}`;
    case "BLOCKED":
      return item.block === "spread" ? "Blocked · spread" : "Blocked · news";
    case "OUTSIDE_NY_WINDOW":
      return "Outside NY";
    default:
      return "No data";
  }
}

const TONE: Record<PairTradability["status"], string> = {
  HIGHLY_TRADABLE: "high",
  MODERATELY_TRADABLE: "moderate",
  LOW_TRADABILITY: "low",
  BLOCKED: "blocked",
  UNAVAILABLE: "unavailable",
  OUTSIDE_NY_WINDOW: "unavailable",
};

function clockEt(iso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/**
 * The pair's NY session tradability as one chip. The tooltip carries the
 * factor breakdown. It helps decide which pair to look at; it is not a
 * signal to trade.
 */
export function TradabilityTag({ item }: { item: PairTradability | undefined }) {
  if (!item) {
    return (
      <span className="pair-strength tradability">
        <span className="pair-strength-chip" data-tone="checking">Checking NY tradability…</span>
      </span>
    );
  }
  const scored = item.score !== null;
  const newsUnchecked = scored && item.news.state === "unavailable";
  const preSession = item.phase === "pre_session" && item.status !== "OUTSIDE_NY_WINDOW";
  const text = `${preSession ? "Pre-NY · " : ""}${label(item)}${newsUnchecked ? " · news unchecked" : ""}`;
  const short = `${preSession ? "Pre · " : ""}${shortLabel(item)}${newsUnchecked ? " · news?" : ""}`;
  const breakdown = item.factors.length
    ? item.factors.map((factor) => `${factor.label} ${factor.points}/${factor.max}${factor.verified ? "" : " (unverified)"}: ${factor.note}`).join("\n")
    : "";
  const title = [
    item.selection?.explanation,
    ...(item.selection?.reasons ?? []),
    ...(item.selection?.cautions ?? []),
    item.summary,
    breakdown,
    item.phase === "outside" ? null : `Evaluated ${clockEt(item.evaluatedAt)} ET.`,
    "For choosing which pair to look at, not a signal to trade.",
  ].filter(Boolean).join("\n");

  return (
    <span className="pair-strength tradability" title={title}>
      <span className="pair-strength-chip" data-tone={`tradability-${item.phase === "outside" ? "unavailable" : item.selection?.status === "REJECTED" ? "blocked" : item.selection?.status === "CAUTION" ? "moderate" : TONE[item.status]}`}>
        <span className="tradability-dot" aria-hidden="true" />
        <span className="pair-strength-label tradability-long">{text}</span>
        <span className="pair-strength-label tradability-short" aria-hidden="true">{short}</span>
      </span>
    </span>
  );
}
