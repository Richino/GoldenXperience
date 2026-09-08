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

function compactPair(instrument: string) {
  return displayNameFor(instrument).replace("/", "");
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
  featuredInstrument,
  currency,
  allTimePL,
  openCount,
  assigned,
  batchSize,
  winRate,
  netR,
  todayTrades,
  todayNetR,
}: {
  quotes: Record<string, { bid: number; ask: number }>;
  featuredInstrument: MajorInstrument;
  currency: string;
  allTimePL: number;
  openCount: number;
  assigned: number;
  batchSize: number;
  winRate: number | null;
  netR: number;
  todayTrades: number;
  todayNetR: number | null;
}) {
  const [dayChange, setDayChange] = useState<Record<string, number>>({});
  const [lastClose, setLastClose] = useState<Record<string, number>>({});
  const featuredMid = quotes[featuredInstrument]
    ? (quotes[featuredInstrument].bid + quotes[featuredInstrument].ask) / 2
    : null;
  const winPercent = winRate === null ? null : Math.round(winRate * 100);
  const allTimePositive = allTimePL >= 0;
  const netRPositive = netR >= 0;

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
    <aside className="home-rail" aria-label="Markets">
      <HomeMiniChart instrument={featuredInstrument} liveMid={featuredMid} />

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

      {todayTrades > 0 || todayNetR !== null ? (
      <section className="home-rail-section" aria-label="Today">
        <div className="home-rail-heading">
          <span>Today</span>
        </div>
        <dl className="home-rail-today">
          <div>
            <dt>Trades</dt>
            <dd className="metric-number">{todayTrades}</dd>
          </div>
          <div>
            <dt>Net R</dt>
            <dd className={`metric-number ${todayNetR === null || Math.abs(todayNetR) < 0.05 ? "" : todayNetR > 0 ? "is-positive" : "is-negative"}`}>
              {todayNetR === null
                ? "—"
                : `${todayNetR > 0 ? "+" : ""}${todayNetR.toFixed(1)}R`}
            </dd>
          </div>
        </dl>
      </section>
      ) : null}

      <section className="home-rail-section home-rail-total">
        <div className="home-rail-heading">
          <span>Total</span>
        </div>
        <div className="home-rail-total-row">
          <p className={`home-rail-total-lead ${allTimePositive ? "is-positive" : "is-negative"}`}>
            {allTimePositive ? "+" : "−"}
            {money(Math.abs(allTimePL), currency)}
          </p>
          <p className={`home-rail-total-r ${netRPositive ? "is-positive" : "is-negative"}`}>
            {netR > 0 ? "+" : ""}
            {netR.toFixed(1)}R
          </p>
        </div>
        <dl className="home-rail-total-meta">
          <div>
            <dt>Trades</dt>
            <dd>{openCount}</dd>
          </div>
          <div>
            <dt>w/r</dt>
            <dd>
              {assigned}/{batchSize}
            </dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{winPercent === null ? "—" : `${winPercent}%`}</dd>
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
