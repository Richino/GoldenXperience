"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { candleEnd } from "@/lib/strategy/candle-clock";
import type { TrendDirection } from "@/lib/strategy/analyze-v2/structure";
import { createPairTrendReadCache, type PairTrend, type TrendLabelRead } from "@/lib/pair-trend-read-cache";
import { readSwingTrend } from "@/lib/swing-trend-read";
import type { CandleSeries } from "@/types/forex";
import { weeklySwingStatus } from "@/lib/swing-trend-status";
import styles from "./trend-label.module.css";

/**
 * Weekly context, Daily structure and 4-hour timing, from the same swing-structure
 * read Analyze's swing mode uses (higher highs + higher lows = up, lower highs +
 * lower lows = down, a box = range). It describes the structure so far; it is a
 * guide to which side to favour, not a forecast.
 */

const REFRESH_MS = 60_000;

export type { PairTrend } from "@/lib/pair-trend-read-cache";

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

async function loadRead(instrument: string, granularity: "H4" | "D" | "W"): Promise<TrendLabelRead | null> {
  const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=250`), {
    credentials: "include",
    cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const series = ((await response.json()) as { data?: CandleSeries }).data;
  const read = readSwingTrend(instrument, granularity, series);
  return read ? { timeframe: read.timeframe, direction: read.direction, closeTime: read.closeTime, evidence: read.evidence } : null;
}

// Shared across every label on the page, so a pair on the chart, in search and
// in the watchlist is read once per refresh window rather than once per label.
const cache = createPairTrendReadCache(async instrument => {
  const [h4, d1, w1] = await Promise.all([loadRead(instrument, "H4").catch(() => null), loadRead(instrument, "D").catch(() => null), loadRead(instrument, "W").catch(() => null)]);
  return { h4, d1, w1, asOf: new Date().toISOString() };
}, { storage: () => window.sessionStorage });
const readPair = cache.load;

export function usePairTrend(instrument: string, enabled = true) {
  const [state, setState] = useState<{ instrument: string; trend: PairTrend } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const trend = await readPair(instrument);
      if (!cancelled) setState({ instrument, trend });
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [instrument, enabled]);
  return state?.instrument === instrument ? state.trend : null;
}

/** Preload before opening; restore cached rows immediately and publish fresh batches together. */
export function usePairTrendList(instruments: readonly string[], enabled: boolean) {
  const key = instruments.join(",");
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, PairTrend>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const instruments = key.split(",").filter(Boolean);
    const cached = new Map<string, PairTrend>();
    for (const instrument of instruments) {
      const trend = cache.peek(instrument);
      if (trend) cached.set(instrument, trend);
    }
    void Promise.resolve().then(() => {
      if (!cancelled && cached.size) setSnapshot(current => new Map([...current, ...cached]));
    });
    const load = async () => {
      const queue = key.split(",").filter(Boolean);
      const rows = new Map<string, PairTrend>();
      const worker = async () => {
        for (let instrument = queue.shift(); instrument && !cancelled; instrument = queue.shift()) {
          rows.set(instrument, await readPair(instrument));
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (!cancelled) setSnapshot(current => new Map([...current, ...rows]));
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [key, enabled]);
  return snapshot;
}

/** One line on what the two timeframes say together. */
function summary(h4: TrendLabelRead | null, d1: TrendLabelRead | null) {
  if (!h4 || !d1) return null;
  const trending = (read: TrendLabelRead) => read.direction === "UPTREND" || read.direction === "DOWNTREND";
  if (trending(h4) && h4.direction === d1.direction) return h4.direction === "UPTREND" ? "Aligned · favour buys" : "Aligned · favour sells";
  if (trending(h4) && trending(d1)) return "Mixed · wait";
  if (!trending(h4) && !trending(d1)) return "No trend · wait";
  return trending(d1) ? "Wait for 4H" : "Daily unclear · wait";
}

/** Describe the observed charts without turning the trend into an entry signal. */
function plainSummary(h4: TrendLabelRead | null, d1: TrendLabelRead | null) {
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

export function TrendLabel({ instrument, className = "", plainLanguage = false, snapshot }: { instrument: string; className?: string; plainLanguage?: boolean; snapshot?: PairTrend | null }) {
  const localTrend = usePairTrend(instrument, snapshot === undefined);
  const trend = snapshot === undefined ? localTrend : snapshot;
  if (!trend) return <span className={`nl-trend is-loading ${className}`} aria-label="Reading trend">{plainLanguage ? <span className={styles.pill} data-tone="neutral">Checking trend…</span> : "Trend…"}</span>;
  const { h4, d1, w1 } = trend;
  if (plainLanguage) {
    const pill = weeklySwingStatus(w1?.direction ?? null, d1?.direction ?? null);
    const daily = d1 ? LABEL[d1.direction] : "data unavailable";
    const short = h4 ? LABEL[h4.direction] : "data unavailable";
    const title = `${pill.detail} Weekly: ${w1 ? LABEL[w1.direction] : "data unavailable"}; Daily: ${daily}; 4H timing: ${short}. ${plainSummary(h4, d1)} Completed candles only; checked every minute. Weekly candle${w1?.closeTime ? ` ended ${new Date(candleEnd(Date.parse(w1.closeTime), "W")).toLocaleString()}` : " unavailable"}; Daily candle${d1?.closeTime ? ` ended ${new Date(candleEnd(Date.parse(d1.closeTime), "D1")).toLocaleString()}` : " unavailable"}; 4H candle${h4?.closeTime ? ` ended ${new Date(candleEnd(Date.parse(h4.closeTime), "H4")).toLocaleString()}` : " unavailable"}. Checked at ${trend.asOf ? new Date(trend.asOf).toLocaleString() : "unknown"}.`;
    // The qualifier after " · " is its own span so tight layouts can drop it
    // and keep the direction; the title and label always carry the full text.
    const [lead, ...qualifier] = pill.label.split(" · ");
    return <span className={`nl-trend ${className}`}><span className={styles.pill} data-tone={pill.tone} title={title} aria-label={`${pill.label}. ${title}`}><span>{lead}{qualifier.length ? <span className="nl-trend-qualifier"> · {qualifier.join(" · ")}</span> : null}</span></span></span>;
  }
  if (!h4 && !d1) return null;
  const line = summary(h4, d1);
  const details = [h4, d1]
    .filter((read): read is TrendLabelRead => read !== null)
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
