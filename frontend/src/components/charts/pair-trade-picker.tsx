"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import type { PendingManualEntry } from "@/types/pending-entry";
import type { MajorInstrument } from "@/types/forex";
import { newsStateOf } from "@/lib/news/news-zone-overlay";

/** Picker value for "set up another trade on this pair". */
export const NEW_PAIR_TRADE = "__new__";

const isNews = (entry: PendingManualEntry) => entry.metadata?.mode === "news";

function tradeTitle(entry: PendingManualEntry, index: number) {
  // A News setup has no side until a zone is touched.
  if (isNews(entry)) return entry.status === "PENDING" ? "News" : `News · ${entry.direction === "long" ? "Long" : "Short"}`;
  return `Trade ${index + 1} · ${entry.direction === "long" ? "Long" : "Short"}`;
}

function shortCountdown(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A News setup's stage in a few words, from the server's state. Null for anything else. */
function newsStage(entry: PendingManualEntry, now: number) {
  if (!isNews(entry) || entry.status === "TRIGGERED") return null;
  if (entry.metadata.configVersion === 3) {
    const state = String(entry.metadata.newsState ?? "SCHEDULED");
    const words: Record<string, string> = { SCHEDULED: "scheduled · T−2s", PREPARING: "checking broker", READY: "ready · T−2s", SUBMITTING: "sending both stops", PENDING_ORDERS: "both stops confirmed", OCO_CANCELLING: "cancelling opposite", CANCELLING: "cancelling & reconciling", EXCEPTION: "emergency reduction", HALTED: "entries paused", CANCELLED: "cancelled", SKIPPED: "skipped", EXPIRED: "window ended", CLOSED: "closed", OPEN: "initial stop protected", TRAILING: "broker trailing active" };
    return words[state] ?? "checking broker";
  }
  const meta = entry.metadata as { lockAt?: string; release?: { time?: string } | null };
  const state = newsStateOf(entry);
  if (state === "ARMED") return meta.lockAt ? `locks in ${shortCountdown(Date.parse(meta.lockAt) - now)}` : "armed";
  if (state === "LOCKING") return "locking";
  if (state === "ZONES_LOCKED") return meta.release?.time ? `news in ${shortCountdown(Date.parse(meta.release.time) - now)}` : "locked";
  if (state === "WATCHING") return "live";
  if (state === "ORDER_UNKNOWN") return "checking with OANDA";
  return "sending";
}

/**
 * Which of the pair's live trades the chart is showing. Only rendered while
 * the pair has an open or pending trade; the button opens a bottom drawer
 * (the Analyze drawer's sheet) listing them, plus "New trade", which clears
 * the chart so another can be placed.
 */
export function PairTradePicker({ trades, selectedId, instrument, onSelect, now }: {
  trades: PendingManualEntry[];
  selectedId: string | null;
  instrument: MajorInstrument;
  onSelect: (id: string) => void;
  /** Clock for News countdowns, ticked by the chart. */
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({
    open,
    onDismiss: () => setOpen(false),
    handleSelector: ".tp-grip, .tp-head",
  });
  if (!trades.length) return null;

  const price = (value: number | null) => value === null ? "—" : formatChartPrice(value, instrument);
  const selectedIndex = trades.findIndex((entry) => entry.id === selectedId);
  const selected = selectedIndex >= 0 ? trades[selectedIndex]! : null;
  const pick = (id: string) => {
    onSelect(id);
    requestClose();
  };

  return (
    <>
      <button
        type="button"
        className="gx-pair-trade-trigger pressable"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Choose the trade shown on the chart"
      >
        <span className="gx-pair-trade-trigger-text">
          {selected ? (
            <>
              <b className={isNews(selected) && selected.status === "PENDING" ? undefined : selected.direction === "long" ? "is-long" : "is-short"}>{tradeTitle(selected, selectedIndex)}</b>
              <span>{newsStage(selected, now) ?? `${selected.status === "TRIGGERED" ? "Open" : "Pending"} · ${price(selected.status === "TRIGGERED" ? selected.triggerPrice : selected.entryPrice)}`}</span>
            </>
          ) : (
            <b>New trade</b>
          )}
        </span>
        <span className="gx-pair-trade-count">{trades.length} {trades.length === 1 ? "trade" : "trades"}</span>
        <ChevronDown className="size-4" aria-hidden="true" />
      </button>

      {open ? createPortal(
        <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
          <section ref={setSheet} {...handlers} className="tp-sheet nl-pt-sheet" role="dialog" aria-modal="true" aria-labelledby="pair-trade-title">
            <div className="tp-grip" aria-hidden="true" />
            <header className="tp-head nl-an-top">
              <span className="nl-an-eyebrow">Chart · {instrument.replace("_", "/")}</span>
              <button type="button" onClick={requestClose} className="nl-an-close" aria-label="Close trade list">
                <X aria-hidden="true" />
              </button>
            </header>
            <h2 id="pair-trade-title" className="nl-pt-title">Trades on this pair</h2>
            <ul className="nl-pt-list">
              {trades.map((entry, index) => {
                const filled = entry.status === "TRIGGERED";
                const isSelected = entry.id === selectedId;
                const stage = newsStage(entry, now);
                const zones = (entry.metadata as { upperLine?: number; lowerLine?: number }) ?? {};
                return (
                  <li key={entry.id}>
                    <button type="button" className={`nl-pt-row pressable${isSelected ? " is-selected" : ""}`} onClick={() => pick(entry.id)} aria-pressed={isSelected}>
                      <span className={`nl-pt-side${stage && entry.status === "PENDING" ? "" : entry.direction === "long" ? " is-long" : " is-short"}`} aria-hidden="true" />
                      <span className="nl-pt-main">
                        <span className="nl-pt-name">
                          {tradeTitle(entry, index)}
                          <span className={`nl-pt-status ${filled ? "is-open" : "is-pending"}`}>{stage ?? (filled ? "Open" : "Pending")}</span>
                        </span>
                        {stage && entry.status === "PENDING" ? (
                          <span className="nl-pt-levels metric-number">
                            <span className="is-up">BUY {price(zones.upperLine ?? null)}</span>
                            <span className="is-down">SELL {price(zones.lowerLine ?? null)}</span>
                          </span>
                        ) : (
                          <span className="nl-pt-levels metric-number">
                            <span>Entry {price(filled ? entry.triggerPrice : entry.entryPrice)}</span>
                            <span className="is-down">SL {price(entry.stopPrice)}</span>
                            <span className="is-up">TP {price(entry.targetPrice)}</span>
                          </span>
                        )}
                      </span>
                      {isSelected ? <Check className="nl-pt-check" aria-label="Shown on the chart" /> : null}
                    </button>
                  </li>
                );
              })}
              <li>
                <button type="button" className={`nl-pt-row is-new pressable${selectedId === NEW_PAIR_TRADE ? " is-selected" : ""}`} onClick={() => pick(NEW_PAIR_TRADE)}>
                  <span className="nl-pt-plus" aria-hidden="true"><Plus /></span>
                  <span className="nl-pt-main">
                    <span className="nl-pt-name">New trade</span>
                    <span className="nl-pt-levels">Clear the chart to place another trade</span>
                  </span>
                  {selectedId === NEW_PAIR_TRADE ? <Check className="nl-pt-check" aria-label="Selected" /> : null}
                </button>
              </li>
            </ul>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
