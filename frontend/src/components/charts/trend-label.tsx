"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { candleEnd } from "@/lib/strategy/candle-clock";
import { checkTimeframe } from "@/lib/strategy/analyze-v2/data-quality";
import { ANALYZE_V2 } from "@/lib/strategy/analyze-v2/config";
import { readTrend, type TrendDirection, type TrendRead } from "@/lib/strategy/analyze-v2/structure";
import type { CandleSeries } from "@/types/forex";
import styles from "./trend-label.module.css";

/**
 * The pair's trend on the 4-hour and daily charts, from the same swing-structure
 * read Analyze's swing mode uses (higher highs + higher lows = up, lower highs +
 * lower lows = down, a box = range). It describes the structure so far; it is a
 * guide to which side to favour, not a forecast.
 */

const REFRESH_MS = 60_000;
const SETTINGS = ANALYZE_V2.SWING.regime;

type PairTrend = { h4: TrendRead | null; d1: TrendRead | null; m15?: TrendRead | null; asOf?: string };

const LABEL: Record<TrendDirection, string> = {
  UPTREND: "Up",
  DOWNTREND: "Down",
  RANGE: "Range",
  TRANSITION: "Turning",
  UNCLEAR: "Unclear",
};

const TONE: Record<TrendDirection, string> = {
  UPTREND: "is-up",
  DOWNTREND: "is-down",
  RANGE: "is-flat",
  TRANSITION: "is-flat",
  UNCLEAR: "is-flat",
};

async function loadRead(instrument: string, granularity: "H4" | "D" | "M15", label: string): Promise<TrendRead | null> {
  const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=250`), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const series = ((await response.json()) as { data?: CandleSeries }).data;
  if (!series || series.instrument !== instrument || series.source !== "oanda") return null;
  const tf = granularity === "D" ? "D1" : granularity;
  const now = Date.now();
  const checked = checkTimeframe(tf, series.candles.filter(c => c.complete === true && candleEnd(Date.parse(c.time),tf) <= now), tf, now, ANALYZE_V2.SWING, true);
  if (checked.checks.some(c => c.status === "FAIL" || c.status === "UNKNOWN")) return null;
  const read = readTrend(instrument, label, checked.normalized.closed, SETTINGS);
  return read.sufficient ? read : null;
}

// Shared across every label on the page, so a pair on the chart, in search and
// in the watchlist is read once per refresh window rather than once per label.
const cache = new Map<string, { at: number; promise: Promise<PairTrend> }>();

function readPair(instrument: string): Promise<PairTrend> {
  const hit = cache.get(instrument);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.promise;
  const promise = Promise.all([loadRead(instrument, "H4", "4H"), loadRead(instrument, "D", "Daily"), loadRead(instrument, "M15", "M15")])
    .then(([h4, d1, m15]) => { if (!h4 || !d1 || !m15) cache.delete(instrument); return { h4, d1, m15, asOf: new Date().toISOString() }; })
    .catch(() => {
      cache.delete(instrument);
      return { h4: null, d1: null };
    });
  cache.set(instrument, { at: Date.now(), promise });
  return promise;
}

export function usePairTrend(instrument: string) {
  const [state, setState] = useState<{ instrument: string; trend: PairTrend } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const trend = await readPair(instrument);
      if (!cancelled) setState({ instrument, trend });
    };
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [instrument]);
  return state?.instrument === instrument ? state.trend : null;
}

/** One line on what the two timeframes say together. */
function summary(h4: TrendRead | null, d1: TrendRead | null) {
  if (!h4 || !d1) return null;
  const trending = (read: TrendRead) => read.direction === "UPTREND" || read.direction === "DOWNTREND";
  if (trending(h4) && h4.direction === d1.direction) return h4.direction === "UPTREND" ? "Aligned · favour buys" : "Aligned · favour sells";
  if (trending(h4) && trending(d1)) return "Mixed · wait";
  if (!trending(h4) && !trending(d1)) return "No trend · wait";
  return trending(d1) ? "Wait for 4H" : "Daily unclear · wait";
}

/** Describe the observed charts without turning the trend into an entry signal. */
function plainSummary(h4: TrendRead | null, d1: TrendRead | null) {
  const overall: Record<TrendDirection, string> = {
    UPTREND: "Price is trending up overall",
    DOWNTREND: "Price is trending down overall",
    RANGE: "Price is moving sideways overall",
    TRANSITION: "The overall trend is changing",
    UNCLEAR: "The overall direction is unclear",
  };
  const shorter: Record<TrendDirection, string> = {
    UPTREND: "the 4-hour chart is trending up",
    DOWNTREND: "the 4-hour chart is trending down",
    RANGE: "the 4-hour chart is moving sideways",
    TRANSITION: "the 4-hour trend is changing",
    UNCLEAR: "the 4-hour chart has no clear direction",
  };
  if (!d1 && !h4) return "The trend is temporarily unavailable.";
  if (!d1) return `The daily trend is unavailable, but ${shorter[h4!.direction]}.`;
  if (!h4) return `${overall[d1.direction]}, but the 4-hour trend is unavailable.`;
  if (h4.direction === d1.direction) {
    if (d1.direction === "UPTREND") return "Price is trending up on both the daily and 4-hour charts.";
    if (d1.direction === "DOWNTREND") return "Price is trending down on both the daily and 4-hour charts.";
    if (d1.direction === "RANGE") return "Price is moving sideways on both the daily and 4-hour charts.";
    if (d1.direction === "UNCLEAR") return "Neither the daily nor the 4-hour chart has a clear direction.";
    return "The trend is changing on both the daily and 4-hour charts.";
  }
  return `${overall[d1.direction]}, but ${shorter[h4.direction]}.`;
}

function trendPill(h4: TrendRead | null, d1: TrendRead | null) {
  const overall: Record<TrendDirection, string> = {
    UPTREND: "Up overall", DOWNTREND: "Down overall", RANGE: "Sideways overall",
    TRANSITION: "Overall trend changing", UNCLEAR: "Overall unclear",
  };
  const shorter: Record<TrendDirection, string> = {
    UPTREND: "short-term up", DOWNTREND: "short-term down", RANGE: "short-term sideways",
    TRANSITION: "short-term changing", UNCLEAR: "short-term unclear",
  };
  if (!h4 && !d1) return { label: "Trend unavailable", tone: "neutral" };
  if (!d1) return { label: `Daily unavailable · ${shorter[h4!.direction]}`, tone: "neutral" };
  if (!h4) return { label: `${overall[d1.direction]} · 4H unavailable`, tone: "neutral" };
  if (h4.direction === d1.direction) {
    switch (d1.direction) {
      case "UPTREND": return { label: "Trending up", tone: "up" };
      case "DOWNTREND": return { label: "Trending down", tone: "down" };
      case "RANGE": return { label: "Moving sideways", tone: "neutral" };
      case "TRANSITION": return { label: "Trend changing", tone: "mixed" };
      case "UNCLEAR": return { label: "Direction unclear", tone: "neutral" };
    }
  }
  return { label: `${overall[d1.direction]} · ${shorter[h4.direction]}`, tone: "mixed" };
}

export function TrendLabel({ instrument, className = "", plainLanguage = false }: { instrument: string; className?: string; plainLanguage?: boolean }) {
  const trend = usePairTrend(instrument);
  if (!trend) return <span className={`nl-trend is-loading ${className}`} aria-label="Reading trend">{plainLanguage ? <span className={styles.pill} data-tone="neutral">Checking trend…</span> : "Trend…"}</span>;
  const { h4, d1 } = trend;
  if (plainLanguage) {
    const pill = trendPill(h4, d1);
    const daily = d1 ? LABEL[d1.direction] : "data unavailable";
    const short = trend.m15 ? LABEL[trend.m15.direction] : "data unavailable";
    pill.label = `Daily: ${daily} · M15: ${short}`;
    return <span className={`nl-trend ${className}`}><span className={styles.pill} data-tone={pill.tone} title={`${plainSummary(h4, d1)} Daily context uses the last completed D1 candle${d1?.closeTime ? ` ending ${new Date(candleEnd(Date.parse(d1.closeTime), "D1")).toLocaleString()}` : ""}; M15 uses completed candles${trend.m15?.closeTime ? ` ending ${new Date(candleEnd(Date.parse(trend.m15.closeTime), "M15")).toLocaleString()}` : ""}. Read at ${trend.asOf ?? "unknown"}.`} aria-label={pill.label}>{pill.label}</span></span>;
  }
  if (!h4 && !d1) return null;
  const line = summary(h4, d1);
  const details = [h4, d1]
    .filter((read): read is TrendRead => read !== null)
    .map((read) => `${read.timeframe}: ${LABEL[read.direction]}. ${read.evidence.join(". ")}.`)
    .join("\n");
  const title = `${line ? `${line}\n` : ""}${details}\nDescribes the structure so far; not a forecast.`;
  return (
    <span className={`nl-trend ${className}`} title={title} aria-label={title}>
      {[h4, d1].map((read, index) =>
        read ? (
          <span key={read.timeframe} className={`nl-trend-chip ${TONE[read.direction]}`}>
            <b>{index === 0 ? "4H" : "D"}</b>
            {read.direction === "UPTREND" ? "▲ " : read.direction === "DOWNTREND" ? "▼ " : ""}
            {LABEL[read.direction]}
          </span>
        ) : null,
      )}
    </span>
  );
}
