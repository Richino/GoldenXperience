"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  animateSheetBack,
  animateSheetIn,
  animateSheetOut,
  createDragFollower,
  createVelocityTracker,
  isPhoneLayout,
} from "@/lib/sheet-motion";

/**
 * Bottom-drawer motion for drawers that are not built on MobileSheet (the
 * Analyze result and the Trade form): slide in when `open` turns on, follow a
 * finger that drags the grip/header, and slide out on `requestClose`. Only in
 * the phone layout — on desktop these are centred dialogs or side panels, so
 * `requestClose` closes immediately and nothing moves.
 *
 * Positions are written straight to the element (see lib/sheet-motion), so a
 * drag never re-renders React and runs at the display's frame rate.
 */
export function useDragToDismiss({
  open,
  onDismiss,
  handleSelector,
  enabled = true,
}: {
  open: boolean;
  onDismiss: () => void;
  handleSelector: string;
  enabled?: boolean;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const shown = useRef(false);
  const closing = useRef(false);
  const start = useRef<number | null>(null);
  const follower = useRef<ReturnType<typeof createDragFollower> | null>(null);
  const velocity = useRef<ReturnType<typeof createVelocityTracker> | null>(null);
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Callback refs, so callers never read a ref object during render.
  const setSheet = useCallback((element: HTMLElement | null) => {
    sheetRef.current = element;
  }, []);
  const setBackdrop = useCallback((element: HTMLDivElement | null) => {
    backdropRef.current = element;
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      shown.current = false;
      closing.current = false;
      return;
    }
    const sheet = sheetRef.current;
    if (!enabled || shown.current || !sheet || !isPhoneLayout()) return;
    shown.current = true;
    void animateSheetIn(sheet, backdropRef.current);
  }, [enabled, open]);

  /** Slide the drawer off-screen from wherever it is, then let the owner unmount it. */
  const closeFrom = useCallback((fromY: number) => {
    if (closing.current) return;
    const sheet = sheetRef.current;
    if (!enabled || !sheet || !isPhoneLayout()) {
      onDismissRef.current();
      return;
    }
    closing.current = true;
    void animateSheetOut(sheet, backdropRef.current, fromY).then(() => onDismissRef.current());
  }, [enabled]);

  const requestClose = useCallback(() => closeFrom(0), [closeFrom]);

  const isHandle = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(handleSelector)) && !target.closest("button, input, a");
  }, [handleSelector]);

  const beginDrag = useCallback((y: number, time: number) => {
    if (!sheetRef.current) return;
    start.current = y;
    follower.current = createDragFollower(sheetRef.current, backdropRef.current);
    velocity.current = createVelocityTracker();
    velocity.current.add(y, time);
  }, []);

  const moveDrag = useCallback((y: number, time: number) => {
    if (start.current === null) return;
    velocity.current?.add(y, time);
    follower.current?.move(y - start.current);
  }, []);

  const finishDrag = useCallback((y: number, time: number) => {
    if (start.current === null) return;
    velocity.current?.add(y, time);
    const distance = Math.max(0, y - start.current);
    const speed = velocity.current?.velocity() ?? 0;
    const at = follower.current?.stop() ?? distance;
    start.current = null;
    follower.current = null;
    velocity.current = null;
    if (distance > DISMISS_DISTANCE || speed > DISMISS_VELOCITY) {
      // Continue from where the finger let go instead of snapping back first.
      closeFrom(at);
      return;
    }
    if (sheetRef.current) void animateSheetBack(sheetRef.current, backdropRef.current, at);
  }, [closeFrom]);

  /*
   * Touch is bound natively, as in MobileSheet: the listener must be
   * non-passive so cancelling iOS's own scroll lets the sheet follow the
   * finger instead of the page or the gesture being stolen mid-drag.
   */
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!open || !enabled || !sheet) return;
    let touchStartY: number | null = null;

    function onTouchStart(event: TouchEvent) {
      const touch = event.touches[0];
      touchStartY = null;
      if (!touch || closing.current || !isPhoneLayout() || !isHandle(event.target)) return;
      touchStartY = touch.clientY;
    }

    function onTouchMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (!touch || touchStartY === null) return;
      if (start.current === null) {
        if (touch.clientY - touchStartY <= 0) return;
        beginDrag(touchStartY, event.timeStamp);
      }
      if (event.cancelable) event.preventDefault();
      moveDrag(touch.clientY, event.timeStamp);
    }

    function onTouchEnd(event: TouchEvent) {
      const touch = event.changedTouches[0];
      touchStartY = null;
      if (touch) finishDrag(touch.clientY, event.timeStamp);
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
  }, [beginDrag, enabled, finishDrag, isHandle, moveDrag, open]);

  // Mouse and pen only; touch goes through the native listeners above.
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    if (!enabled || closing.current || !isPhoneLayout() || !isHandle(event.target)) return;
    beginDrag(event.clientY, event.timeStamp);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; moves still arrive while the pointer stays on the drawer.
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    moveDrag(event.clientY, event.timeStamp);
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    finishDrag(event.clientY, event.timeStamp);
  };

  return {
    setSheet,
    setBackdrop,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
    requestClose,
  };
}
