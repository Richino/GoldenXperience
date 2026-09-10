"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import type { MajorInstrument, PriceQuote } from "@/types/forex";

export type ChartOverlayPreferences = {
  levels: boolean;
  signalMarkers: boolean;
  positionMarkers: boolean;
};

function displayPair(instrument: string) {
  return instrument.replace("_", "/");
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="gx-context-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="gx-context-toggle-track" aria-hidden="true" />
    </label>
  );
}

export function ChartContextPanel({
  activeInstrument,
  quotes,
  overlayPreferences,
  onOverlayChange,
  onSelectInstrument,
  spreadPips,
  dayHigh,
  dayLow,
  sessionLabel,
}: {
  activeInstrument: MajorInstrument;
  quotes: PriceQuote[];
  overlayPreferences: ChartOverlayPreferences;
  onOverlayChange: (preferences: ChartOverlayPreferences) => void;
  onSelectInstrument: (instrument: MajorInstrument) => void;
  spreadPips: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  sessionLabel: string | null;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, "");

  const visibleQuotes = useMemo(() => {
    const filtered = quotes.filter((quote) => {
      if (!normalizedQuery) return true;
      return displayPair(quote.instrument).toLowerCase().replace("/", "").includes(normalizedQuery)
        || quote.instrument.toLowerCase().includes(normalizedQuery);
    });

    return [...filtered]
      .sort((left, right) => Number(right.instrument === activeInstrument) - Number(left.instrument === activeInstrument))
      .slice(0, 8);
  }, [activeInstrument, normalizedQuery, quotes]);

  return (
    <aside className="gx-chart-context" aria-label="Chart context">
      <section className="gx-context-section">
        <div className="gx-context-heading">
          <span>Watchlist</span>
          <button
            type="button"
            className={`gx-watchlist-search-btn${searchOpen ? " is-open" : ""}`}
            aria-expanded={searchOpen}
            aria-label={searchOpen ? "Close watchlist search" : "Filter watchlist"}
            onClick={() => {
              setSearchOpen((open) => {
                if (open) setQuery("");
                return !open;
              });
            }}
          >
            <Search className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        {searchOpen ? (
          <label className="gx-watchlist-search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pairs"
              aria-label="Filter watchlist"
              autoFocus
            />
          </label>
        ) : null}
        {visibleQuotes.length ? (
          <div className="gx-watchlist">
            {visibleQuotes.map((quote) => {
              const selected = quote.instrument === activeInstrument;
              const positive = quote.changePercent >= 0;
              const flat = Math.abs(quote.changePercent) < 0.005;
              return (
                <button
                  key={quote.instrument}
                  type="button"
                  className={`gx-watchlist-row${selected ? " is-active" : ""}`}
                  onClick={() => onSelectInstrument(quote.instrument)}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="gx-watchlist-pair">{displayPair(quote.instrument)}</span>
                  <span className="gx-watchlist-price metric-number">{formatChartPrice(quote.mid, quote.instrument)}</span>
                  <span className={`gx-watchlist-change ${flat ? "is-neutral" : positive ? "is-positive" : "is-negative"}`}>
                    {positive ? "+" : ""}{quote.changePercent.toFixed(2)}%
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="gx-context-empty">
            {normalizedQuery ? "No pairs match that search." : "Live watchlist quotes are unavailable."}
          </p>
        )}
      </section>

      <section className="gx-context-section">
        <div className="gx-context-heading"><span>GX overlays</span></div>
        <div className="gx-context-toggles">
          <Toggle
            label="Signal markers"
            checked={overlayPreferences.signalMarkers}
            onChange={(signalMarkers) => onOverlayChange({ ...overlayPreferences, signalMarkers })}
          />
          <Toggle
            label="Entry / SL / TP"
            checked={overlayPreferences.levels}
            onChange={(levels) => onOverlayChange({ ...overlayPreferences, levels })}
          />
          <Toggle
            label="Position markers"
            checked={overlayPreferences.positionMarkers}
            onChange={(positionMarkers) => onOverlayChange({ ...overlayPreferences, positionMarkers })}
          />
          <Toggle
            label="Strategy levels"
            checked={false}
            onChange={() => undefined}
            disabled
          />
        </div>
      </section>

      <section className="gx-context-section gx-market-detail">
        <div className="gx-context-heading"><span>Market detail</span></div>
        <dl>
          <div><dt>Spread</dt><dd>{spreadPips === null ? "—" : spreadPips.toFixed(1)}</dd></div>
          <div><dt>Session</dt><dd className="gx-market-session">{sessionLabel ?? "—"}</dd></div>
          <div><dt>Day high</dt><dd className="metric-number">{dayHigh === null ? "—" : formatChartPrice(dayHigh, activeInstrument)}</dd></div>
          <div><dt>Day low</dt><dd className="metric-number">{dayLow === null ? "—" : formatChartPrice(dayLow, activeInstrument)}</dd></div>
        </dl>
      </section>
    </aside>
  );
}
