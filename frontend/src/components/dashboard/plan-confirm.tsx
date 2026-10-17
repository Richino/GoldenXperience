"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";

/**
 * Confirm a Plans action before it happens. Drawn with the Analyze sheet
 * parts: a bottom sheet you can drag down on phones, a centred card on
 * desktop (the nl-mp pattern).
 */

export type PlanConfirmRequest = {
  eyebrow: string;
  title: string;
  body: string;
  keepLabel: string;
  confirmLabel: string;
  busyLabel: string;
  run: () => Promise<unknown>;
};

export function PlanConfirm({ request, onDone }: { request: PlanConfirmRequest | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setError(null); onDone(); };
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({ open: request !== null, onDismiss: close, handleSelector: ".nl-an-grip, .nl-an-top" });
  if (!request) return null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await request.run();
      setBusy(false);
      requestClose();
    } catch {
      setBusy(false);
      setError("That did not work. Try again.");
    }
  };

  return createPortal(
    <div
      ref={setBackdrop}
      className="nl-an-backdrop nl-mp-backdrop"
      role="presentation"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) requestClose(); }}
    >
      <section ref={setSheet} className="nl-an-sheet nl-mp nl-plan-confirm" role="alertdialog" aria-modal="true" aria-labelledby="plan-confirm-title" aria-describedby="plan-confirm-body" {...handlers}>
        <div className="nl-an-grip" aria-hidden="true" />
        <div className="nl-an-body">
          <div className="nl-an-top">
            <span className="nl-an-eyebrow">{request.eyebrow}</span>
            <button type="button" className="nl-an-close" onClick={() => requestClose()} disabled={busy} aria-label="Close">
              <X aria-hidden="true" />
            </button>
          </div>
          <h2 id="plan-confirm-title" className="nl-plan-confirm-title">{request.title}</h2>
          <p id="plan-confirm-body" className="nl-plan-confirm-body">{request.body}</p>
          {error ? <p className="nl-plan-confirm-error" role="alert">{error}</p> : null}
          <div className="nl-an-actions nl-plan-confirm-actions">
            <button type="button" className="nl-an-secondary pressable" onClick={() => requestClose()} disabled={busy}>
              {request.keepLabel}
            </button>
            <button type="button" className="nl-an-primary nl-plan-confirm-danger pressable" onClick={() => void confirm()} disabled={busy}>
              {busy ? request.busyLabel : request.confirmLabel}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
