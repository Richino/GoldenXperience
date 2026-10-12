"use client";

import { useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useCenterModalDialog } from "@/lib/use-center-modal-dialog";
import { displayNameFor, precisionFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";

/**
 * Change the stop loss / take profit on a waiting order from Home. Entry,
 * order type and expiry stay as they are; the server replaces the resting
 * OANDA order so the broker holds the new levels.
 */
export function PendingLevelsDialog({
  entry,
  saving,
  onDismiss,
  onSave,
}: {
  entry: PendingManualEntry | null;
  saving: boolean;
  onDismiss: () => void;
  onSave: (entry: PendingManualEntry, levels: { stopPrice: number | null; targetPrice: number | null }) => Promise<string | null>;
}) {
  const { present, backdropRef, panelRef, dismissAnimated } = useCenterModalDialog({
    open: entry !== null,
    onDismiss,
    lockWhile: saving,
    openKey: entry?.id,
  });

  if (!present || !entry) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className="manual-proposal-backdrop pending-cancel-backdrop"
      role="presentation"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void dismissAnimated();
      }}
    >
      <PendingLevelsForm key={entry.id} entry={entry} saving={saving} panelRef={panelRef} onCancel={() => void dismissAnimated()} onSave={async (levels) => {
        const error = await onSave(entry, levels);
        if (!error) await dismissAnimated();
        return error;
      }} />
    </div>,
    document.body,
  );
}

function PendingLevelsForm({
  entry,
  saving,
  panelRef,
  onCancel,
  onSave,
}: {
  entry: PendingManualEntry;
  saving: boolean;
  panelRef: Ref<HTMLElement>;
  onCancel: () => void;
  onSave: (levels: { stopPrice: number | null; targetPrice: number | null }) => Promise<string | null>;
}) {
  const precision = precisionFor(entry.instrument);
  const [stop, setStop] = useState(entry.stopPrice === null ? "" : entry.stopPrice.toFixed(precision));
  const [target, setTarget] = useState(entry.targetPrice === null ? "" : entry.targetPrice.toFixed(precision));
  const [error, setError] = useState<string | null>(null);
  const long = entry.direction === "long";

  const submit = async () => {
    const stopText = stop.trim();
    const targetText = target.trim();
    if (Boolean(stopText) !== Boolean(targetText)) return setError("Enter both a stop loss and a take profit, or leave both blank.");
    const stopPrice = stopText ? Number(stopText) : null;
    const targetPrice = targetText ? Number(targetText) : null;
    if (stopPrice !== null && !(Number.isFinite(stopPrice) && stopPrice > 0)) return setError("Enter a valid stop loss price.");
    if (targetPrice !== null && !(Number.isFinite(targetPrice) && targetPrice > 0)) return setError("Enter a valid take profit price.");
    if (stopPrice !== null && (long ? stopPrice >= entry.entryPrice : stopPrice <= entry.entryPrice)) {
      return setError(`The stop loss must be ${long ? "below" : "above"} the entry.`);
    }
    if (targetPrice !== null && (long ? targetPrice <= entry.entryPrice : targetPrice >= entry.entryPrice)) {
      return setError(`The take profit must be ${long ? "above" : "below"} the entry.`);
    }
    setError(null);
    setError(await onSave({ stopPrice, targetPrice }));
  };

  const stopValue = Number(stop);
  const targetValue = Number(target);
  const reward = stop.trim() && target.trim() && Number.isFinite(stopValue) && Number.isFinite(targetValue)
    ? Math.abs(targetValue - entry.entryPrice) / Math.abs(entry.entryPrice - stopValue)
    : null;

  return (
    <section
      ref={panelRef}
      className="manual-proposal pending-cancel-confirmation pending-levels-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pending-levels-title"
    >
      <header>
        <div>
          <span>Pending trade</span>
          <h2 id="pending-levels-title">Edit {displayNameFor(entry.instrument)} {long ? "long" : "short"}</h2>
        </div>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="pending-levels-entry">
          Entry <b className="metric-number">{entry.entryPrice.toFixed(precision)}</b>
          {reward !== null && Number.isFinite(reward) && reward > 0 ? <> · <span className="metric-number">1:{reward.toFixed(2)}</span></> : null}
        </p>
        <div className="pending-levels-fields">
          <label>
            <span>Stop loss</span>
            <input className="metric-number is-down" inputMode="decimal" value={stop} placeholder="None" disabled={saving} onChange={(event) => setStop(event.target.value)} />
          </label>
          <label>
            <span>Take profit</span>
            <input className="metric-number is-up" inputMode="decimal" value={target} placeholder="None" disabled={saving} onChange={(event) => setTarget(event.target.value)} />
          </label>
        </div>
        <p className="pending-levels-hint">Leave both blank to run the trade with no stop or target. Size is re-set to your usual risk.</p>
        {error ? <p className="pending-levels-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" className="manual-proposal-dismiss pressable" disabled={saving} onClick={onCancel}>
            Back
          </button>
          <button type="submit" className="pending-levels-save pressable" disabled={saving}>
            {saving ? "Saving…" : "Save levels"}
          </button>
        </footer>
      </form>
    </section>
  );
}
