"use client";

import { createPortal } from "react-dom";
import { useCenterModalDialog } from "@/lib/use-center-modal-dialog";
import { displayNameFor } from "@/lib/instruments/catalog";

export type CloseAllTarget = { id: string; instrument: string; direction: "long" | "short"; money: number | null };

/** Confirms closing every open manual trade at market, listing each one first. */
export function CloseAllConfirmation({
  trades,
  open,
  confirming,
  error,
  currency,
  onDismiss,
  onConfirm,
}: {
  trades: CloseAllTarget[];
  open: boolean;
  confirming: boolean;
  error: string | null;
  currency: string;
  onDismiss: () => void;
  onConfirm: (tradeIds: string[]) => Promise<boolean>;
}) {
  const { present, backdropRef, panelRef, dismissAnimated } = useCenterModalDialog({
    open,
    onDismiss,
    lockWhile: confirming,
    openKey: open ? "close-all" : undefined,
  });

  if (!present) return null;
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 });
  const total = trades.reduce((sum, trade) => sum + (trade.money ?? 0), 0);
  const priced = trades.every((trade) => trade.money !== null);
  const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${money.format(Math.abs(value))}`;
  const tone = (value: number) => (value > 0 ? "is-up" : value < 0 ? "is-down" : "");

  return createPortal(
    <div
      ref={backdropRef}
      className="manual-proposal-backdrop pending-cancel-backdrop"
      role="presentation"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !confirming) void dismissAnimated();
      }}
    >
      <section
        ref={panelRef}
        className="manual-proposal pending-cancel-confirmation close-all-confirmation"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-all-title"
      >
        <header>
          <div>
            <span>Open positions</span>
            <h2 id="close-all-title">Close {trades.length === 1 ? "this trade" : `all ${trades.length} trades`}?</h2>
          </div>
        </header>
        <p>{trades.length === 1 ? "It is" : "Each trade is"} closed at the current market price on OANDA. This cannot be undone.</p>
        <ul className="close-all-list">
          {trades.map((trade) => (
            <li key={trade.id}>
              <span>
                <b>{displayNameFor(trade.instrument)}</b>
                <span className={trade.direction === "long" ? "is-up" : "is-down"}>{trade.direction === "long" ? "Long" : "Short"}</span>
              </span>
              <span className={`metric-number ${trade.money === null ? "" : tone(trade.money)}`}>
                {trade.money === null ? "—" : signed(trade.money)}
              </span>
            </li>
          ))}
        </ul>
        {priced && trades.length > 1 ? (
          <p className="close-all-total">
            <span>Now, before costs</span>
            <span className={`metric-number ${tone(total)}`}>{signed(total)}</span>
          </p>
        ) : null}
        {error ? <p className="close-all-error" role="alert">{error}</p> : null}
        <footer>
          <button
            type="button"
            className="manual-proposal-dismiss pressable"
            disabled={confirming}
            onClick={() => void dismissAnimated()}
          >
            {trades.length === 1 ? "Keep it open" : "Keep them open"}
          </button>
          <button
            type="button"
            className="pending-cancel-confirm pressable"
            disabled={confirming || trades.length === 0}
            onClick={() => {
              void (async () => {
                const ok = await onConfirm(trades.map((trade) => trade.id));
                if (ok) await dismissAnimated();
              })();
            }}
          >
            {confirming ? "Closing…" : trades.length === 1 ? "Yes, close trade" : "Yes, close all"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
