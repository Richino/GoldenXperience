"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HomeMiniChart } from "@/components/dashboard/home-mini-chart";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { CandleSeries, MajorInstrument } from "@/types/forex";

const MARKET_PAIRS: MajorInstrument[] = [
  "EUR_USD",
  "GBP_USD",
  "USD_JPY",
  "AUD_USD",
  "USD_CAD",
];

export type HomeAvailableSignal = {
  kind: "setup";
  id: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  evaluatedAt: string | null;
};

export type HomeCurrentPosition = {
  kind: "position";
  id: string;
  instrument: MajorInstrument;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  openedAt: string;
};

function compactPair(instrument: string) {
  return displayNameFor(instrument);
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

export function HomeRail({
  quotes,
  availableSignals,
  currentPositions,
  currency,
  todayNet,
  todayR,
  todayTrades,
  todayWins,
  todayLosses,
}: {
  quotes: Record<string, { bid: number; ask: number }>;
  /** Saved, immutable plans. These are never synthesized from a live quote. */
  availableSignals: HomeAvailableSignal[];
  /** Open paper trades take priority over prospective setups in this rail. */
  currentPositions: HomeCurrentPosition[];
  currency: string;
  /** Realized money booked today; null when nothing has closed. */
  todayNet: number | null;
  todayR: number | null;
  todayTrades: number;
  todayWins: number;
  todayLosses: number;
}) {
  const [dayChange, setDayChange] = useState<Record<string, number>>({});
  const [lastClose, setLastClose] = useState<Record<string, number>>({});
  const resolvedToday = todayWins + todayLosses;
  const winPercent = resolvedToday > 0 ? Math.round((todayWins / resolvedToday) * 100) : null;
  const hasTodayTrades = todayTrades > 0;
  const netPositive = (todayNet ?? 0) >= 0;
  const rPositive = (todayR ?? 0) >= 0;
  const previewItems = currentPositions.length ? currentPositions : availableSignals;
  const showingPositions = currentPositions.length > 0;

  useEffect(() => {
    let cancelled = false;

    async function loadChanges() {
      const entries = await Promise.all(
        MARKET_PAIRS.map(async (instrument) => {
          try {
            const response = await fetch(
              apiUrl(`/api/oanda/candles?instrument=${instrument}&granularity=D&count=3`),
              { credentials: "include", cache: "no-store" },
            );
            if (!response.ok) return { instrument, change: null, close: null };
            const payload = (await response.json()) as { data?: CandleSeries };
            const candles = payload.data?.candles ?? [];
            const previous = candles.at(-2)?.close;
            const latest = candles.at(-1)?.close;
            if (!previous || !latest) return { instrument, change: null, close: latest ?? null };
            return {
              instrument,
              change: ((latest - previous) / previous) * 100,
              close: latest,
            };
          } catch {
            return { instrument, change: null, close: null };
          }
        }),
      );

      if (cancelled) return;
      const nextChange: Record<string, number> = {};
      const nextClose: Record<string, number> = {};
      for (const entry of entries) {
        if (entry.change !== null) nextChange[entry.instrument] = entry.change;
        if (entry.close !== null) nextClose[entry.instrument] = entry.close;
      }
      setDayChange(nextChange);
      setLastClose(nextClose);
    }

    void loadChanges();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="home-rail" aria-label="Current positions, available signals, and markets">
      <section className="home-available-signals" aria-label={showingPositions ? "Current positions" : "Saved setups"}>
        <div className="home-rail-heading">
          <span>{showingPositions ? "Current positions" : "Saved setups"}</span>
          {previewItems.length > 1 ? <span className="home-signal-swipe-hint">Swipe</span> : null}
        </div>
        {previewItems.length ? (
          <div className="home-signal-carousel">
            {previewItems.map((signal) => {
              const quote = quotes[signal.instrument];
              const liveMid = quote ? (quote.bid + quote.ask) / 2 : null;
              const position = signal.kind === "position";
              return (
                <Link
                  key={position ? signal.id : `${signal.instrument}-${signal.direction}-${signal.entry}`}
                  href={position
                    ? `/chart?instrument=${signal.instrument}&trade=${signal.id}`
                    : `/chart?instrument=${signal.instrument}&setup=${signal.id}&entry=${signal.entry}&stop=${signal.stop}&target=${signal.target}`}
                  className="home-signal-preview"
                  aria-label={`Open ${compactPair(signal.instrument)} ${signal.direction} ${position ? "position" : "signal"} chart with entry, stop loss, and target`}
                >
                  <HomeMiniChart
                    instrument={signal.instrument}
                    liveMid={liveMid}
                    evaluatedAt={position ? signal.openedAt : signal.evaluatedAt}
                    entry={signal.entry}
                    stop={signal.stop}
                    target={signal.target}
                  />
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="home-available-signals-empty">No saved setups right now.</p>
        )}
      </section>

      <section className="home-rail-section">
        <div className="home-rail-heading">
          <span>Markets</span>
          <Link href="/watchlist" className="home-rail-link">
            See all
          </Link>
        </div>
        <div className="home-rail-markets">
          {MARKET_PAIRS.map((instrument) => {
            const quote = quotes[instrument];
            const mid = quote
              ? (quote.bid + quote.ask) / 2
              : lastClose[instrument] ?? null;
            const change = dayChange[instrument];
            const flat = change !== undefined && Math.abs(change) < 0.005;
            const positive = (change ?? 0) >= 0;
            return (
              <Link
                key={instrument}
                href={`/chart?instrument=${instrument}`}
                className="home-rail-market"
              >
                <span>{compactPair(instrument)}</span>
                <span className="metric-number">
                  {mid === null ? "—" : formatChartPrice(mid, instrument)}
                </span>
                <span
                  className={
                    change === undefined || flat
                      ? "is-neutral"
                      : positive
                        ? "is-positive"
                        : "is-negative"
                  }
                >
                  {change === undefined
                    ? "—"
                    : `${positive ? "+" : ""}${change.toFixed(2)}%`}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="home-rail-section home-rail-total" aria-label="Today">
        <div className="home-rail-heading">
          <span>Today</span>
        </div>
        <div className="home-rail-total-row">
          <p className={`home-rail-total-lead ${netPositive ? "is-positive" : "is-negative"}`}>
            {todayNet === null
              ? money(0, currency)
              : `${netPositive ? "+" : "−"}${money(Math.abs(todayNet), currency)}`}
          </p>
          <p className={`home-rail-total-r ${rPositive ? "is-positive" : "is-negative"}`}>
            {todayR === null ? "0.0R" : `${todayR > 0 ? "+" : ""}${todayR.toFixed(1)}R`}
          </p>
        </div>
        {!hasTodayTrades ? <p className="home-rail-total-empty">No closed trades today</p> : null}
        <dl className="home-rail-total-meta">
          <div>
            <dt>Trades</dt>
            <dd>{todayTrades}</dd>
          </div>
          <div>
            <dt>W/L</dt>
            <dd>
              {todayWins}/{todayLosses}
            </dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{winPercent === null ? "0%" : `${winPercent}%`}</dd>
          </div>
        </dl>
        <div className="home-rail-bar" aria-hidden="true">
          {winPercent === null ? null : (
            <>
              <span className="is-win" style={{ width: `${Math.min(100, winPercent)}%` }} />
              <span className="is-loss" style={{ width: `${Math.max(0, 100 - winPercent)}%` }} />
            </>
          )}
        </div>
      </section>
    </aside>
  );
}
