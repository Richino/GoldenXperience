"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
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

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!enabled || closing.current || !isPhoneLayout() || !sheetRef.current) return;
    const target = event.target as HTMLElement;
    if (!target.closest(handleSelector) || target.closest("button, input, a")) return;
    start.current = event.clientY;
    follower.current = createDragFollower(sheetRef.current, backdropRef.current);
    velocity.current = createVelocityTracker();
    velocity.current.add(event.clientY, event.timeStamp);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; moves still arrive while the finger stays on the drawer.
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (start.current === null) return;
    velocity.current?.add(event.clientY, event.timeStamp);
    follower.current?.move(event.clientY - start.current);
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    if (start.current === null) return;
    velocity.current?.add(event.clientY, event.timeStamp);
    const distance = Math.max(0, event.clientY - start.current);
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
  };

  return {
    setSheet,
    setBackdrop,
    handlers: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd },
    requestClose,
  };
}
