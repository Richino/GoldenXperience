"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** How far the sheet has to be dragged down before releasing dismisses it. */
const DISMISS_DISTANCE = 90;

/**
 * A bottom sheet for the mobile layouts.
 *
 * Dragging is bound to the header rather than the whole sheet so a long option
 * list still scrolls: a pointer that lands on the list belongs to the list.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleEscape);
    sheetRef.current?.focus();

    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, open]);

  if (!open) return null;

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    dragStartY.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartY.current === null) return;
    setDragY(Math.max(0, event.clientY - dragStartY.current));
  }

  function endDrag() {
    if (dragStartY.current === null) return;
    const dismissed = dragY > DISMISS_DISTANCE;
    dragStartY.current = null;
    setDragging(false);
    setDragY(0);
    if (dismissed) onClose();
  }

  // Portalled to the body because the triggers live inside cards that create
  // stacking contexts (backdrop-filter, transforms). Rendered in place, the
  // sheet would be trapped under those contexts — and under the mobile nav.
  return createPortal(
    <>
      <div className="mobile-sheet-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-pull-to-refresh-ignore="true"
        className="mobile-sheet"
        style={{
          transform: `translateY(${dragY}px)`,
          transition: dragging ? "none" : undefined,
        }}
      >
        <div
          className="mobile-sheet-grip"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="mobile-sheet-handle" aria-hidden />
          <div className="mobile-sheet-head">
            <p className="mobile-sheet-title">{title}</p>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title.toLowerCase()}`}
              className="mobile-sheet-close pressable"
            >
              <X className="size-4" strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="mobile-sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}
