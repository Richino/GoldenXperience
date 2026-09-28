"use client";

import { createPortal } from "react-dom";
import { useCenterModalDialog } from "@/lib/use-center-modal-dialog";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";

export function PendingCancelConfirmation({
  entry,
  confirming,
  onDismiss,
  onConfirm,
}: {
  entry: PendingManualEntry | null;
  confirming: boolean;
  onDismiss: () => void;
  onConfirm: (entry: PendingManualEntry) => Promise<boolean>;
}) {
  const { present, backdropRef, panelRef, dismissAnimated } = useCenterModalDialog({
    open: entry !== null,
    onDismiss,
    lockWhile: confirming,
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
      <section
        ref={panelRef}
        className="manual-proposal pending-cancel-confirmation"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-cancel-title"
      >
        <header>
          <div>
            <span>Pending trade</span>
            <h2 id="pending-cancel-title">Cancel {displayNameFor(entry.instrument)}?</h2>
          </div>
        </header>
        <p>
          This removes the {entry.direction} {entry.entryOrderType.replace("_", " ").toLowerCase()} entry. It
          cannot be restored.
        </p>
        <footer>
          <button
            type="button"
            className="manual-proposal-dismiss pressable"
            disabled={confirming}
            onClick={() => void dismissAnimated()}
          >
            No, keep it
          </button>
          <button
            type="button"
            className="pending-cancel-confirm pressable"
            disabled={confirming}
            onClick={() => {
              void (async () => {
                const ok = await onConfirm(entry);
                if (ok) await dismissAnimated();
              })();
            }}
          >
            {confirming ? "Cancelling…" : "Yes, cancel trade"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
