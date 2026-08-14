"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  PAPER_JOURNAL_STORAGE_KEY,
  PAPER_JOURNAL_UPDATED_EVENT,
} from "@/lib/journal/storage";
import type { JournalTrade } from "@/types/forex";
import { apiUrl } from "@/lib/api/url";
import { formatShortDay } from "@/lib/format/datetime";
import { openTradeProgress } from "@/lib/open-trade-progress";
import { useLiveQuotes } from "@/lib/market-stream/use-live-quotes";
import { useOpenPositionFills } from "@/lib/market-stream/use-open-positions";
import { JournalEntriesSkeleton } from "@/components/ui/page-skeletons";
import Link from "next/link";

const BASE_FILTERS = ["All", "Wins", "Losses", "EUR/USD", "GBP/USD", "USD/JPY"];

function decimalsForPair(pair: string) {
  return pair.endsWith("/JPY") ? 3 : 5;
}

function outcomeLabel(outcome: string | null | undefined) {
  if (!outcome || outcome === "open") return null;
  return outcome.replace(/_/g, " ");
}

function formatPrice(value: number | null, pair: string) {
  return value === null ? "—" : value.toFixed(decimalsForPair(pair));
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatShortDate(value: string | null) {
  if (!value) return "Open";
  return formatShortDay(value);
}

function JournalTradeRow({
  trade,
  quote,
  fill,
}: {
  trade: JournalTrade;
  quote?: { bid: number | null; ask: number | null };
  fill?: { price: number; units: number };
}) {
  // An unresolved trade reports what it is worth right now and how far it has
  // come towards its target, rather than only that it is open. Without a live
  // quote — a manual trade, or the snapshot not loaded — it falls back to
  // "Open" rather than inventing a value.
  const live =
    trade.resultR === null
      ? openTradeProgress({
          direction: trade.direction,
          entry: trade.entry,
          stop: trade.stop,
          target: trade.target,
          bid: quote?.bid,
          ask: quote?.ask,
          riskAmount: trade.nominalRiskAmount,
          fill,
        })
      : null;

  const positive = (trade.resultR ?? live?.unrealizedR ?? 0) >= 0;
  const resultTone =
    trade.resultR === null && !live
      ? "is-open"
      : positive
        ? "is-win"
        : "is-loss";
  const resultLabel =
    trade.resultR !== null
      ? `${positive ? "+" : ""}${trade.resultR.toFixed(2)}`
      : live
        ? `${Math.round(live.percent)}% ${live.towards === "stop" ? "to SL" : "to TP"}`
        : "Open";
  const moneyValue = trade.paperPl ?? live?.money ?? null;
  const money = formatMoney(moneyValue);
  const moneyTone =
    moneyValue == null ? null : moneyValue >= 0 ? "is-win" : "is-loss";
  const outcome = outcomeLabel(trade.outcome);

  // Strategy trades open on the chart they were taken from. A manually entered
  // trade has no instrument code to route with, so it stays unlinked rather
  // than pointing at a pair the chart cannot resolve.
  const href = trade.instrument
    ? `/signals?instrument=${trade.instrument}&trade=${trade.id}`
    : null;

  const body = (
    <>
      <header className="journal-entry-top">
        <p className="journal-entry-title">
          <span className="journal-entry-pair">{trade.pair}</span>
          <span
            className={
              trade.direction === "long"
                ? "journal-entry-dir is-long"
                : "journal-entry-dir is-short"
            }
          >
            {trade.direction}
          </span>
          {trade.origin === "strategy" ? (
            <span className="journal-entry-auto">
              Auto{trade.sequence ? ` #${trade.sequence}` : ""}
            </span>
          ) : null}
        </p>
        <time className="journal-entry-date">
          {formatShortDate(trade.closedAt)}
        </time>
      </header>

      <div className="journal-entry-result">
        <span className={`journal-entry-r metric-number ${resultTone}`}>
          {resultLabel}
          {trade.resultR !== null ? (
            <span className="journal-entry-r-unit">R</span>
          ) : null}
        </span>
        {money && moneyTone ? (
          <span className={`journal-entry-money metric-number ${moneyTone}`}>
            {money}
          </span>
        ) : null}
        {outcome ? (
          <span className="journal-entry-outcome">{outcome}</span>
        ) : null}
      </div>

      <dl className="journal-entry-levels">
        <div className="journal-entry-level">
          <dt>Entry</dt>
          <dd className="metric-number">
            {formatPrice(trade.entry, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Exit</dt>
          <dd className="metric-number">
            {formatPrice(trade.exit, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Stop</dt>
          <dd className="metric-number">
            {formatPrice(trade.stop, trade.pair)}
          </dd>
        </div>
        <div className="journal-entry-level">
          <dt>Target</dt>
          <dd className="metric-number">
            {formatPrice(trade.target, trade.pair)}
          </dd>
        </div>
      </dl>
    </>
  );

  return (
    <article className="journal-entry">
      {/* The note stays outside the link: it is a `details` toggle, and a tap
          on it has to open the note rather than navigate away. */}
      {href ? (
        <Link href={href} className="journal-entry-open pressable">
          {body}
        </Link>
      ) : (
        body
      )}

      {trade.notes ? (
        <details className="journal-entry-note">
          <summary>Note</summary>
          <p>{trade.notes}</p>
        </details>
      ) : null}
    </article>
  );
}

export function JournalView({ embedded = false }: { embedded?: boolean } = {}) {
  const [activeFilter, setActiveFilter] = useState("All");
  const [records, setRecords] = useState<JournalTrade[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  // Live bid/ask per pair, so an unresolved row is marked to market on every
  // tick. A dropped socket leaves the last known figure rather than a wrong
  // one, and rows without a quote fall back to "Open".
  const quotes = useLiveQuotes();
  // Real fills, so an open row reports the same money as the account hero.
  const fills = useOpenPositionFills();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(apiUrl("/api/journal/trades"), { credentials: "include", cache: "no-store" });
        const payload = await response.json() as { trades?: JournalTrade[] };
        if (!response.ok) throw new Error("Journal records are unavailable.");
        if (!cancelled) {
          setRecords(payload.trades ?? []);
          setLoadError(null);
        }
      } catch {
        if (!cancelled) setLoadError("Could not load your journal records.");
      } finally {
        if (!cancelled) {
          setLoadingRecords(false);
          setStorageReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem(
      PAPER_JOURNAL_STORAGE_KEY,
      JSON.stringify(records),
    );
    window.dispatchEvent(new Event(PAPER_JOURNAL_UPDATED_EVENT));
  }, [records, storageReady]);

  const filters = useMemo(
    () => [
      ...BASE_FILTERS,
      ...[...new Set(records.map((trade) => trade.pair))]
        .filter((pair) => !BASE_FILTERS.includes(pair))
        .sort(),
    ],
    [records],
  );
  const filtered = useMemo(
    () => {
      if (activeFilter === "All") return records;
      if (activeFilter === "Wins") return records.filter((trade) => (trade.resultR ?? 0) > 0);
      if (activeFilter === "Losses") return records.filter((trade) => (trade.resultR ?? 0) < 0);
      return records.filter((trade) => trade.pair === activeFilter);
    },
    [activeFilter, records],
  );
  const closedTrades = records.filter(
    (trade): trade is JournalTrade & { resultR: number } =>
      trade.status === "closed" && trade.resultR !== null,
  );
  const wins = closedTrades.filter((trade) => trade.resultR > 0);
  const winRate = closedTrades.length
    ? (wins.length / closedTrades.length) * 100
    : 0;
  const averageR = closedTrades.length
    ? closedTrades.reduce((sum, trade) => sum + trade.resultR, 0) /
      closedTrades.length
    : 0;

  return (
    <div className="journal-view journal-minimal space-y-8 lg:space-y-10">
      {embedded ? (
        loadError ? <p className="text-xs text-[color:var(--danger)]">{loadError}</p> : null
      ) : (
        <header>
          <h1 className="text-display">Journal</h1>
          <p className="mt-1 text-sm text-[color:var(--muted)]">Paper trades in R</p>
          {loadError ? <p className="mt-2 text-xs text-[color:var(--danger)]">{loadError}</p> : null}
        </header>
      )}

      <section
        className="journal-stats-card grid grid-cols-3"
        aria-label="Journal summary"
      >
        {(
          [
            ["Trades", records.length.toString()],
            ["Win rate", `${winRate.toFixed(0)}%`],
            [
              "Avg R",
              `${averageR >= 0 ? "+" : ""}${averageR.toFixed(2)}R`,
            ],
          ] as const
        ).map(([label, value], index) => (
          <div key={label} className="journal-stat min-w-0">
            <p className="text-xs text-[color:var(--muted)]">{label}</p>
            <p
              className={`metric-number mt-1 text-xl font-semibold tracking-[-0.03em] ${
                index === 2 && closedTrades.length
                  ? averageR >= 0
                    ? "text-[color:var(--success)]"
                    : "text-[color:var(--danger)]"
                  : ""
              }`}
            >
              {value}
            </p>
          </div>
        ))}
      </section>

      <section className="dashboard-minimal-section" aria-label="Trade log">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Trade log</h2>
          <div className="flex flex-wrap gap-1.5">
            {filters.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={`check-chip pressable ${
                  activeFilter === filter ? "check-chip-active" : ""
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <AnimatePresence mode="popLayout" initial={false}>
          {loadingRecords ? (
            <JournalEntriesSkeleton />
          ) : filtered.length ? (
            <div className="journal-entry-list mt-3">
              {filtered.map((trade) => (
                <motion.div
                  layout
                  key={trade.id}
                  className="journal-entry-wrap"
                  initial={reducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                >
                  <JournalTradeRow
                    trade={trade}
                    quote={trade.instrument ? quotes[trade.instrument] : undefined}
                    fill={trade.instrument ? fills[trade.instrument] : undefined}
                  />
                </motion.div>
              ))}
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-6"
            >
              <p className="text-sm text-[color:var(--muted)]">No trades in this view.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
