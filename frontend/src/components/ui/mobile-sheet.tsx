"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Drag distance past which releasing dismisses the sheet. */
const DISMISS_DISTANCE = 90;
/** A flick this fast dismisses regardless of distance, in px per ms. */
const DISMISS_VELOCITY = 0.5;

/**
 * A bottom sheet for the mobile layouts.
 *
 * Dragging works from anywhere on the sheet, the way a native sheet does: a
 * drag that starts in the option list only moves the sheet when the list is
 * already scrolled to the top, so scrolling a long list still works and the
 * gesture hands off to the sheet once there is nothing left to scroll.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  headerAction,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional control shown in the head, to the left of the close button. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; time: number; inBody: boolean } | null>(null);
  const latest = useRef<{ y: number; time: number } | null>(null);
  const active = useRef(false);

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleEscape);
    sheetRef.current?.focus();
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose, open]);

  /*
   * iOS ignores `overflow: hidden` on the body for touch scrolling, so the page
   * behind kept moving under the sheet. Pinning the body and restoring the
   * offset on close is what actually holds it still.
   */
  useEffect(() => {
    if (!open) return;

    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overflow = "hidden";

    return () => {
      Object.assign(body.style, previous);
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  const finish = useCallback(
    (endY: number, endTime: number) => {
      if (!active.current || !start.current) return;

      const distance = Math.max(0, endY - start.current.y);
      const previous = latest.current;
      const velocity =
        previous && endTime > previous.time
          ? (endY - previous.y) / (endTime - previous.time)
          : 0;

      active.current = false;
      start.current = null;
      latest.current = null;
      setDragging(false);
      setDragY(0);

      if (distance > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY) onClose();
    },
    [onClose],
  );

  /*
   * Bound natively rather than through React so the listener can be
   * non-passive: cancelling the browser's own scroll is the only way the sheet
   * can follow the finger instead of the page moving underneath it.
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!open || !sheet) return;

    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch) return;
      const body = bodyRef.current;
      start.current = {
        y: touch.clientY,
        time: event.timeStamp,
        inBody: Boolean(body && event.target instanceof Node && body.contains(event.target)),
      };
      latest.current = { y: touch.clientY, time: event.timeStamp };
      active.current = false;
    }

    function onTouchMove(event: TouchEvent) {
      const touch = event.touches[0];
      const from = start.current;
      if (!touch || !from) return;

      const delta = touch.clientY - from.y;

      if (!active.current) {
        // A list that can still scroll up keeps the gesture.
        const atTop = (bodyRef.current?.scrollTop ?? 0) <= 0;
        if (delta <= 0 || (from.inBody && !atTop)) {
          latest.current = { y: touch.clientY, time: event.timeStamp };
          return;
        }
        active.current = true;
        setDragging(true);
      }

      if (event.cancelable) event.preventDefault();
      latest.current = { y: touch.clientY, time: event.timeStamp };
      setDragY(Math.max(0, delta));
    }

    function onTouchEnd(event: TouchEvent) {
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (!active.current) {
        start.current = null;
        latest.current = null;
        return;
      }
      finish(touch.clientY, event.timeStamp);
    }

    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    sheet.addEventListener("touchend", onTouchEnd);
    sheet.addEventListener("touchcancel", onTouchEnd);

    return () => {
      sheet.removeEventListener("touchstart", onTouchStart);
      sheet.removeEventListener("touchmove", onTouchMove);
      sheet.removeEventListener("touchend", onTouchEnd);
      sheet.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [finish, open]);

  if (!open) return null;

  // Mouse dragging stays on the grip: a pointer has no momentum to hand back to
  // a scroll container, and click-dragging a list would be surprising.
  function onGripMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    start.current = { y: event.clientY, time: event.timeStamp, inBody: false };
    latest.current = { y: event.clientY, time: event.timeStamp };
    active.current = true;
    setDragging(true);

    function move(moveEvent: MouseEvent) {
      if (!start.current) return;
      latest.current = { y: moveEvent.clientY, time: moveEvent.timeStamp };
      setDragY(Math.max(0, moveEvent.clientY - start.current.y));
    }

    function up(upEvent: MouseEvent) {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      finish(upEvent.clientY, upEvent.timeStamp);
    }

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

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
        <div className="mobile-sheet-grip" onMouseDown={onGripMouseDown}>
          <div className="mobile-sheet-handle" aria-hidden />
          <div className="mobile-sheet-head">
            <p className="mobile-sheet-title">{title}</p>
            <div className="mobile-sheet-actions">
              {headerAction}
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
        </div>

        <div ref={bodyRef} className="mobile-sheet-body">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
