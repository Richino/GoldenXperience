"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { ANALYZE_V2 } from "@/lib/strategy/analyze-v2/config";
import { readTrend, type TrendDirection, type TrendRead } from "@/lib/strategy/analyze-v2/structure";
import type { CandleSeries } from "@/types/forex";

/**
 * The pair's trend on the 4-hour and daily charts, from the same swing-structure
 * read Analyze's swing mode uses (higher highs + higher lows = up, lower highs +
 * lower lows = down, a box = range). It describes the structure so far; it is a
 * guide to which side to favour, not a forecast.
 */

const REFRESH_MS = 15 * 60_000;
const SETTINGS = ANALYZE_V2.SWING.regime;

type PairTrend = { h4: TrendRead | null; d1: TrendRead | null };

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

async function loadRead(instrument: string, granularity: "H4" | "D", label: string): Promise<TrendRead | null> {
  const response = await fetch(apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=${granularity}&count=250`), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return null;
  const series = ((await response.json()) as { data?: CandleSeries }).data;
  if (!series || series.instrument !== instrument || series.source !== "oanda") return null;
  return readTrend(instrument, label, series.candles, SETTINGS);
}

// Shared across every label on the page, so a pair on the chart, in search and
// in the watchlist is read once per refresh window rather than once per label.
const cache = new Map<string, { at: number; promise: Promise<PairTrend> }>();

function readPair(instrument: string): Promise<PairTrend> {
  const hit = cache.get(instrument);
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.promise;
  const promise = Promise.all([loadRead(instrument, "H4", "4H"), loadRead(instrument, "D", "Daily")])
    .then(([h4, d1]) => ({ h4, d1 }))
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

export function TrendLabel({ instrument, className = "", showNote = false }: { instrument: string; className?: string; showNote?: boolean }) {
  const trend = usePairTrend(instrument);
  if (!trend) return <span className={`nl-trend is-loading ${className}`} aria-label="Reading trend">Trend…</span>;
  const { h4, d1 } = trend;
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
      {showNote && line ? <span className="nl-trend-note">{line}</span> : null}
    </span>
  );
}
