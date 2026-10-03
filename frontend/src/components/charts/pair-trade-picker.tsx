"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import type { PendingManualEntry } from "@/types/pending-entry";
import type { MajorInstrument } from "@/types/forex";

/** Picker value for "set up another trade on this pair". */
export const NEW_PAIR_TRADE = "__new__";

function tradeTitle(entry: PendingManualEntry, index: number) {
  return `Trade ${index + 1} · ${entry.direction === "long" ? "Long" : "Short"}`;
}

/**
 * Which of the pair's live trades the chart is showing. Only rendered while
 * the pair has an open or pending trade; the button opens a bottom drawer
 * (the Analyze drawer's sheet) listing them, plus "New trade", which clears
 * the chart so another can be placed.
 */
export function PairTradePicker({ trades, selectedId, instrument, onSelect }: {
  trades: PendingManualEntry[];
  selectedId: string | null;
  instrument: MajorInstrument;
  onSelect: (id: string) => void;
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
              <b className={selected.direction === "long" ? "is-long" : "is-short"}>{tradeTitle(selected, selectedIndex)}</b>
              <span>{selected.status === "TRIGGERED" ? "Open" : "Pending"} · {price(selected.status === "TRIGGERED" ? selected.triggerPrice : selected.entryPrice)}</span>
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
          <section ref={setSheet} {...handlers} className="tp-sheet gx-pair-trade-sheet max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="pair-trade-title">
            <div className="tp-grip" aria-hidden="true" />
            <header className="tp-head flex items-start justify-between gap-4">
              <h2 id="pair-trade-title" className="tp-title text-xl font-semibold">Trades on {instrument.replace("_", "/")}</h2>
              <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Close trade list">×</button>
            </header>
            <ul className="gx-pair-trade-list">
              {trades.map((entry, index) => {
                const filled = entry.status === "TRIGGERED";
                const isSelected = entry.id === selectedId;
                return (
                  <li key={entry.id}>
                    <button type="button" className={`gx-pair-trade-row pressable${isSelected ? " is-selected" : ""}`} onClick={() => pick(entry.id)} aria-pressed={isSelected}>
                      <span className={`gx-pair-trade-side ${entry.direction === "long" ? "is-long" : "is-short"}`} aria-hidden="true" />
                      <span className="gx-pair-trade-main">
                        <span className="gx-pair-trade-name">
                          {tradeTitle(entry, index)}
                          <span className={`gx-pair-trade-status ${filled ? "is-open" : "is-pending"}`}>{filled ? "Open" : "Pending"}</span>
                        </span>
                        <span className="gx-pair-trade-levels metric-number">
                          Entry {price(filled ? entry.triggerPrice : entry.entryPrice)} · SL {price(entry.stopPrice)} · TP {price(entry.targetPrice)}
                        </span>
                      </span>
                      {isSelected ? <Check className="gx-pair-trade-check size-5" aria-label="Shown on the chart" /> : null}
                    </button>
                  </li>
                );
              })}
              <li>
                <button type="button" className={`gx-pair-trade-row is-new pressable${selectedId === NEW_PAIR_TRADE ? " is-selected" : ""}`} onClick={() => pick(NEW_PAIR_TRADE)}>
                  <Plus className="size-5" aria-hidden="true" />
                  <span className="gx-pair-trade-main">
                    <span className="gx-pair-trade-name">New trade</span>
                    <span className="gx-pair-trade-levels">Clear the chart to place another trade</span>
                  </span>
                  {selectedId === NEW_PAIR_TRADE ? <Check className="gx-pair-trade-check size-5" aria-label="Selected" /> : null}
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
