"use client";

import { createPortal } from "react-dom";
import { useCenterModalDialog } from "@/lib/use-center-modal-dialog";

export function TradeConfirmDialog({
  mode,
  pairLabel,
  onDismiss,
  onConfirm,
}: {
  mode: "cancel" | "close" | null;
  pairLabel: string;
  onDismiss: () => void;
  onConfirm: (mode: "cancel" | "close") => void;
}) {
  const { present, backdropRef, panelRef, dismissAnimated } = useCenterModalDialog({
    open: mode !== null,
    onDismiss,
    openKey: mode ?? undefined,
  });

  const activeMode = mode;
  if (!present || !activeMode) return null;

  return createPortal(
    <div
      ref={backdropRef}
      className="custom-expiration-backdrop trade-confirm-backdrop"
      role="presentation"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void dismissAnimated();
      }}
    >
      <section
        ref={panelRef}
        className="custom-expiration-dialog trade-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trade-confirm-title"
      >
        <header>
          <div>
            <span>{pairLabel}</span>
            <h3 id="trade-confirm-title">
              {activeMode === "cancel" ? "Cancel pending trade?" : "Close active trade?"}
            </h3>
          </div>
        </header>
        <p>
          {activeMode === "cancel"
            ? "This removes the resting order from OANDA so it will not fill. You can create a new one afterward."
            : "This closes the position on OANDA at the current market price and books the result. This cannot be undone."}
        </p>
        <footer>
          <button type="button" onClick={() => void dismissAnimated()}>
            Keep it
          </button>
          <button
            type="button"
            className={activeMode === "close" ? "is-danger" : "is-warning"}
            onClick={() => {
              void (async () => {
                const action = activeMode;
                await dismissAnimated();
                onConfirm(action);
              })();
            }}
          >
            {activeMode === "cancel" ? "Cancel Trade" : "Close Trade"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
