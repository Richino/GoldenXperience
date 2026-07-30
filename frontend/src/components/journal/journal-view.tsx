"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus, Save } from "lucide-react";
import { SectionLabel } from "@/components/ui/section-label";
import {
  PAPER_JOURNAL_STORAGE_KEY,
  PAPER_JOURNAL_UPDATED_EVENT,
  parseStoredJournal,
} from "@/lib/journal/storage";
import { calculateTradeResultR } from "@/lib/risk/engine";
import type { JournalTrade } from "@/types/forex";
import { apiUrl } from "@/lib/api/url";

const filters = ["All", "EUR/USD", "GBP/USD", "USD/JPY"] as const;

function decimalsForPair(pair: string) {
  return pair === "USD/JPY" ? 3 : 5;
}

function formatPrice(value: number | null, pair: string) {
  return value === null ? "—" : value.toFixed(decimalsForPair(pair));
}


function formatShortDate(value: string | null) {
  if (!value) return "Open";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function JournalTradeRow({ trade }: { trade: JournalTrade }) {
  const positive = (trade.resultR ?? 0) >= 0;
  const resultLabel =
    trade.resultR === null
      ? "Open"
      : `${positive ? "+" : ""}${trade.resultR.toFixed(2)}`;

  return (
    <article className="journal-entry">
      <div className="journal-entry-grid">
        <div
          className={`journal-entry-r metric-number ${
            trade.resultR === null
              ? "is-open"
              : positive
                ? "is-win"
                : "is-loss"
          }`}
        >
          {resultLabel}
          {trade.resultR !== null ? (
            <span className="journal-entry-r-unit">R</span>
          ) : null}
        </div>

        <div className="journal-entry-body min-w-0">
          <div className="journal-entry-top">
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
              <span className="journal-entry-reason">{trade.reason}</span>
            </p>
            <time className="journal-entry-date">
              {formatShortDate(trade.closedAt)}
            </time>
          </div>

          <p className="journal-entry-prices metric-number">
            <span>{formatPrice(trade.entry, trade.pair)}</span>
            <span className="journal-entry-arrow">→</span>
            <span>{formatPrice(trade.exit, trade.pair)}</span>
            <span className="journal-entry-levels">
              {formatPrice(trade.stop, trade.pair)}
              <span className="journal-entry-levels-sep">/</span>
              {formatPrice(trade.target, trade.pair)}
            </span>
          </p>
        </div>
      </div>

      {trade.notes ? (
        <details className="journal-entry-note">
          <summary>Note</summary>
          <p>{trade.notes}</p>
        </details>
      ) : null}
    </article>
  );
}

function PaperTradeForm({
  onSave,
}: {
  onSave: (trade: JournalTrade) => void;
}) {
  const [pair, setPair] = useState("EUR/USD");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [exit, setExit] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entryNumber = Number(entry);
    const stopNumber = Number(stop);
    const targetNumber = Number(target);
    const exitNumber = exit ? Number(exit) : null;

    if (
      !Number.isFinite(entryNumber) ||
      !Number.isFinite(stopNumber) ||
      !Number.isFinite(targetNumber) ||
      entryNumber <= 0 ||
      stopNumber <= 0 ||
      targetNumber <= 0 ||
      entryNumber === stopNumber
    ) {
      setError("Enter a valid entry, stop, and target.");
      return;
    }

    if (exitNumber !== null && (!Number.isFinite(exitNumber) || exitNumber <= 0)) {
      setError("Exit must be a positive price.");
      return;
    }

    if (!reason.trim()) {
      setError("Add the setup or entry reason.");
      return;
    }

    const resultR =
      exitNumber === null
        ? null
        : calculateTradeResultR({
            direction,
            entry: entryNumber,
            stop: stopNumber,
            exit: exitNumber,
          });
    const now = new Date().toISOString();
    const result =
      resultR === null
        ? "open"
        : Math.abs(resultR) < 0.01
          ? "breakeven"
          : resultR > 0
            ? "win"
            : "loss";

    onSave({
      id: crypto.randomUUID(),
      origin: "manual",
      pair,
      direction,
      status: exitNumber === null ? "open" : "closed",
      result,
      openedAt: now,
      closedAt: exitNumber === null ? null : now,
      entry: entryNumber,
      stop: stopNumber,
      target: targetNumber,
      exit: exitNumber,
      resultR,
      reason: reason.trim(),
      notes: notes.trim(),
    });

    setEntry("");
    setStop("");
    setTarget("");
    setExit("");
    setReason("");
    setNotes("");
    setError(null);
  }

  return (
    <details className="app-card group overflow-hidden">
      <summary className="pressable flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-[color:var(--minimal-hover)] md:px-6 [&::-webkit-details-marker]:hidden">
        <div>
          <SectionLabel title="Log a paper trade" variant="minimal" />
          <p className="mt-1 text-xs text-[color:var(--muted)]">
            Saved locally in this browser
          </p>
        </div>
        <span className="form-toggle grid size-8 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--foreground)_5%,var(--surface))] text-[color:var(--muted)]">
          <Plus className="size-3.5 transition-transform group-open:rotate-45" />
        </span>
      </summary>

      <form
        onSubmit={submit}
        className="grid gap-4 border-t border-[color:var(--border)] p-5 md:grid-cols-2 md:p-6"
      >
        <label>
          <span className="minimal-field-label">Pair</span>
          <select
            value={pair}
            onChange={(event) => setPair(event.target.value)}
            className="minimal-field"
          >
            <option>EUR/USD</option>
            <option>GBP/USD</option>
            <option>USD/JPY</option>
          </select>
        </label>
        <label>
          <span className="minimal-field-label">Direction</span>
          <select
            value={direction}
            onChange={(event) =>
              setDirection(event.target.value as "long" | "short")
            }
            className="minimal-field capitalize"
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        {[
          ["Entry", entry, setEntry],
          ["Stop", stop, setStop],
          ["Target", target, setTarget],
          ["Exit (blank while open)", exit, setExit],
        ].map(([label, value, setter]) => (
          <label key={label as string}>
            <span className="minimal-field-label">{label as string}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={value as string}
              onChange={(event) =>
                (setter as (next: string) => void)(event.target.value)
              }
              className="minimal-field minimal-field-mono"
            />
          </label>
        ))}
        <label className="md:col-span-2">
          <span className="minimal-field-label">Setup / reason</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="EMA pullback with structure confirmation"
            className="minimal-field"
          />
        </label>
        <label className="md:col-span-2">
          <span className="minimal-field-label">Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Execution quality, spread, news, or what you would repeat"
            className="minimal-field"
          />
        </label>
        {error ? (
          <p className="text-xs text-[color:var(--danger)] md:col-span-2">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="minimal-submit pressable md:col-span-2 md:justify-self-end"
        >
          <Save className="size-3.5" />
          Save trade
        </button>
      </form>
    </details>
  );
}

export function JournalView({ trades }: { trades: JournalTrade[] }) {
  const [activeFilter, setActiveFilter] =
    useState<(typeof filters)[number]>("All");
  const [records, setRecords] = useState(trades);
  const [storageReady, setStorageReady] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const stored = parseStoredJournal(
          window.localStorage.getItem(PAPER_JOURNAL_STORAGE_KEY),
        );
        if (stored?.length) await fetch(apiUrl("/api/journal/import"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trades: stored }) });
        const response = await fetch(apiUrl("/api/journal/trades"), { credentials: "include", cache: "no-store" });
        const payload = await response.json() as { trades?: JournalTrade[] };
        if (!cancelled && response.ok) setRecords(payload.trades ?? []);
      } catch {
        // The existing seed remains visible when the private API is temporarily unavailable.
      } finally {
        if (!cancelled) setStorageReady(true);
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

  const filtered = useMemo(
    () =>
      activeFilter === "All"
        ? records
        : records.filter((trade) => trade.pair === activeFilter),
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
    <div className="journal-view space-y-6">
      <header>
        <h1 className="text-display tracking-[-0.05em]">Journal</h1>
        <p className="mt-1.5 max-w-xl text-sm text-[color:var(--muted)]">
          Track paper trades in R. Records are private and synced to your research database.
        </p>
      </header>

      <section className="app-card p-5 md:p-6">
        <div className="grid grid-cols-3 divide-x divide-[color:var(--border)]">
          {[
            ["Trades", records.length.toString(), `${closedTrades.length} closed`],
            ["Win rate", `${winRate.toFixed(0)}%`, `${wins.length} winners`],
            [
              "Avg R",
              `${averageR >= 0 ? "+" : ""}${averageR.toFixed(2)}R`,
              closedTrades.length ? "Closed trades" : "No closed trades",
            ],
          ].map(([label, value, detail], index) => (
            <div
              key={label}
              className={`dashboard-stat min-w-0 px-3 ${index === 0 ? "pl-0" : ""} ${index === 2 ? "pr-0" : ""}`}
            >
              <div className="dashboard-stat-label">{label}</div>
              <div
                className={`metric-number text-lg font-semibold tracking-[-0.04em] sm:text-xl ${
                  index > 0 && closedTrades.length
                    ? index === 2
                      ? averageR >= 0
                        ? "text-[color:var(--success)]"
                        : "text-[color:var(--danger)]"
                      : ""
                    : ""
                }`}
              >
                {value}
              </div>
              <div className="truncate text-[0.6875rem] text-[color:var(--muted)] sm:text-xs">
                {detail}
              </div>
            </div>
          ))}
        </div>
      </section>

      <PaperTradeForm onSave={(trade) => { void fetch(apiUrl("/api/journal/trades"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trade) }).then(async (response) => { if (!response.ok) return; const created = await response.json() as { id: string }; setRecords((current) => [{ ...trade, id: created.id }, ...current]); }); }} />

      <section className="app-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5 md:px-6">
          <SectionLabel title="Trade log" variant="minimal" />
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
          {filtered.length ? (
            filtered.map((trade) => (
              <motion.div
                layout
                key={trade.id}
                className="journal-entry-wrap"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <JournalTradeRow trade={trade} />
              </motion.div>
            ))
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="border-t border-[color:var(--border)] px-5 py-12 text-center md:px-6"
            >
              <p className="empty-state justify-center">
                <span className="empty-state-dot" />
                No trades in this view.
              </p>
              <p className="mt-2 text-xs text-[color:var(--muted)]">
                Change the filter or log a paper trade.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}
