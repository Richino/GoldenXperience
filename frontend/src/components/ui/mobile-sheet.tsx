"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  DISMISS_DISTANCE,
  DISMISS_VELOCITY,
  animateSheetBack,
  animateSheetIn,
  animateSheetOut,
  createDragFollower,
  createVelocityTracker,
} from "@/lib/sheet-motion";

/**
 * A bottom sheet for the mobile layouts.
 *
 * Dismissal dragging is deliberately limited to the visible grip/header. This
 * keeps option lists purely scrollable and prevents a selection swipe from
 * pulling the whole sheet down.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  eyebrow,
  headerAction,
  lockPageScroll = true,
  resetPageScrollOnOpen = false,
  resetPageScrollOnInputFocus = false,
  keyboardAvoiding = false,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Small uppercase context label above the title ("Chart", "Inbox"). */
  eyebrow?: string;
  /** Optional control shown in the head, to the left of the close button. */
  headerAction?: React.ReactNode;
  /** The chart already fills a non-scrolling PWA viewport, so it can opt out
   * of iOS's fragile fixed-body scroll lock. */
  lockPageScroll?: boolean;
  /** Start the fixed-body lock from the top, ignoring an iOS focus-scroll. */
  resetPageScrollOnOpen?: boolean;
  /** Reassert the top position after an input receives focus on iOS. */
  resetPageScrollOnInputFocus?: boolean;
  /** Keep an input-focused drawer above the software keyboard. */
  keyboardAvoiding?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  // `present` outlives `open` by the exit animation, so closing (X, backdrop,
  // a pick, or a drag) slides the sheet away instead of cutting it.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  // Parents often clear the selected item on close. Keep the last open
  // content through the exit, so the drawer does not collapse mid-animation.
  const [lastContent, setLastContent] = useState({ title, eyebrow, headerAction, children });
  if (open && (lastContent.title !== title || lastContent.eyebrow !== eyebrow
    || lastContent.headerAction !== headerAction || lastContent.children !== children)) {
    setLastContent({ title, eyebrow, headerAction, children });
  }
  const content = open ? { title, eyebrow, headerAction, children } : lastContent;
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; time: number; inBody: boolean } | null>(null);
  const active = useRef(false);
  const follower = useRef<ReturnType<typeof createDragFollower> | null>(null);
  const velocity = useRef<ReturnType<typeof createVelocityTracker> | null>(null);
  /** Where a dismissing drag let go, so the exit continues from there. */
  const releaseY = useRef(0);
  const shown = useRef(false);
  const exiting = useRef(false);

  // onClose is recreated by the parent on every render (e.g. live price ticks),
  // so keep it in a ref. Depending on it here re-ran this effect constantly,
  // and the sheetRef.focus() below then stole focus from the search input on
  // every tick — the keyboard opened and immediately closed.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const resetDocumentScroll = useCallback(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
  }, []);

  useEffect(() => {
    if (!open) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }

    document.addEventListener("keydown", handleEscape);
    sheetRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  /*
   * iOS ignores `overflow: hidden` on the body for touch scrolling, so the page
   * behind kept moving under the sheet. Pinning the body and restoring the
   * offset after the exit animation is what actually holds it still. Releasing
   * this lock as soon as `open` flips false reflows the fixed chart behind a
   * still-visible drawer, producing a flash on every close button tap.
   */
  useLayoutEffect(() => {
    if (!present || !lockPageScroll) return;

    const { body } = document;
    const root = document.documentElement;
    const scrollY = resetPageScrollOnOpen ? 0 : window.scrollY;
    if (resetPageScrollOnOpen && window.scrollY !== 0) {
      resetDocumentScroll();
    }
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
    root.classList.add("mobile-sheet-open");

    return () => {
      Object.assign(body.style, previous);
      root.classList.remove("mobile-sheet-open");
      window.scrollTo(0, scrollY);
    };
  }, [lockPageScroll, present, resetDocumentScroll, resetPageScrollOnOpen]);

  /* iOS PWAs keep the layout viewport at its pre-keyboard height. Fixed
   * drawers therefore remain beneath the keyboard unless we explicitly move
   * their bottom edge to visualViewport's visible bottom. This is scoped to
   * sheets that opt in. CSS also requires a measured keyboard, because iOS can
   * leave focus on an input after the keyboard has already been dismissed. */
  useEffect(() => {
    if (!open || !keyboardAvoiding) return;

    const sheet = sheetRef.current;
    const viewport = window.visualViewport;
    if (!sheet || !viewport) return;

    const sync = () => {
      const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
      const keyboardOffset = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
      const keyboardOpen = viewport.height < layoutHeight - 120;
      sheet.style.setProperty("--mobile-sheet-keyboard-offset", `${Math.round(keyboardOffset)}px`);
      sheet.style.setProperty("--mobile-sheet-visible-height", `${Math.round(viewport.height)}px`);
      sheet.dataset.keyboardOpen = keyboardOpen ? "true" : "false";
    };

    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      sheet.style.removeProperty("--mobile-sheet-keyboard-offset");
      sheet.style.removeProperty("--mobile-sheet-visible-height");
      delete sheet.dataset.keyboardOpen;
    };
  }, [keyboardAvoiding, open]);

  /* Open: slide in on mount. Close: slide out from wherever the sheet is, then
   * unmount. Layout effect so the first painted frame is already off-screen. */
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (open && present && sheet && !shown.current) {
      shown.current = true;
      void animateSheetIn(sheet, backdropRef.current);
      return;
    }
    if (!open && present && !exiting.current) {
      exiting.current = true;
      const from = releaseY.current;
      releaseY.current = 0;
      const done = () => {
        shown.current = false;
        exiting.current = false;
        setPresent(false);
      };
      if (sheet) void animateSheetOut(sheet, backdropRef.current, from).then(done);
      else done();
    }
  }, [open, present]);

  const beginDrag = useCallback((y: number, time: number) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    active.current = true;
    follower.current = createDragFollower(sheet, backdropRef.current);
    velocity.current = createVelocityTracker();
    velocity.current.add(y, time);
  }, []);

  const moveDrag = useCallback((y: number, time: number) => {
    if (!start.current) return;
    velocity.current?.add(y, time);
    follower.current?.move(y - start.current.y);
  }, []);

  const finish = useCallback(
    (endY: number, endTime: number) => {
      if (!active.current || !start.current) return;
      velocity.current?.add(endY, endTime);
      const distance = Math.max(0, endY - start.current.y);
      const speed = velocity.current?.velocity() ?? 0;
      const at = follower.current?.stop() ?? distance;

      active.current = false;
      start.current = null;
      follower.current = null;
      velocity.current = null;

      if (distance > DISMISS_DISTANCE || speed > DISMISS_VELOCITY) {
        releaseY.current = at;
        onCloseRef.current();
        return;
      }
      const sheet = sheetRef.current;
      if (sheet) void animateSheetBack(sheet, backdropRef.current, at);
    },
    [],
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
      const grip = sheetRef.current?.querySelector(".mobile-sheet-grip");
      if (!touch || !(event.target instanceof Node) || !grip?.contains(event.target)) return;
      const body = bodyRef.current;
      start.current = {
        y: touch.clientY,
        time: event.timeStamp,
        inBody: Boolean(body && event.target instanceof Node && body.contains(event.target)),
      };
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
        if (delta <= 0 || (from.inBody && !atTop)) return;
        beginDrag(touch.clientY, event.timeStamp);
      }

      if (event.cancelable) event.preventDefault();
      moveDrag(touch.clientY, event.timeStamp);
    }

    function onTouchEnd(event: TouchEvent) {
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (!active.current) {
        start.current = null;
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
  }, [beginDrag, finish, moveDrag, open]);

  if (!present) return null;

  // Mouse dragging stays on the grip: a pointer has no momentum to hand back to
  // a scroll container, and click-dragging a list would be surprising.
  function onGripMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (!open) return;
    start.current = { y: event.clientY, time: event.timeStamp, inBody: false };
    beginDrag(event.clientY, event.timeStamp);

    function move(moveEvent: MouseEvent) {
      moveDrag(moveEvent.clientY, moveEvent.timeStamp);
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
      <div
        ref={backdropRef}
        className="mobile-sheet-backdrop"
        onClick={open ? onClose : undefined}
        data-pull-to-refresh-ignore="true"
        aria-hidden
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={content.title}
        tabIndex={-1}
        data-pull-to-refresh-ignore="true"
        className={`mobile-sheet${className ? ` ${className}` : ""}`}
        onFocusCapture={resetPageScrollOnInputFocus ? () => {
          // iOS performs its input-reveal scroll after focus dispatches; run
          // again on the next frame to keep the fixed chart origin stable.
          resetDocumentScroll();
          window.requestAnimationFrame(resetDocumentScroll);
        } : undefined}
      >
        <div className="mobile-sheet-grip" onMouseDown={onGripMouseDown}>
          <div className="mobile-sheet-handle" aria-hidden />
          <div className="mobile-sheet-head">
            <div className="mobile-sheet-heading">
              {content.eyebrow ? <p className="mobile-sheet-eyebrow">{content.eyebrow}</p> : null}
              <p className="mobile-sheet-title">{content.title}</p>
            </div>
            <div className="mobile-sheet-actions">
              {content.headerAction}
              <button
                type="button"
                onClick={onClose}
                aria-label={`Close ${content.title.toLowerCase()}`}
                className="mobile-sheet-close pressable"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </div>
          </div>
        </div>

        <div ref={bodyRef} className="mobile-sheet-body">
          {content.children}
        </div>
      </div>
    </>,
    document.body,
  );
}
