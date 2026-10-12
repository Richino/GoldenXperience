"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type MouseEvent, type KeyboardEvent, type DragEvent } from "react";
import { observerBubbleCloudLines, observerBubbleCloudRoom, observerBubblePanel, observerBubblePosition, type ObserverBubblePosition } from "./observer-bubble-position";

type Drag = { id: number; startX: number; startY: number; origin: ObserverBubblePosition; current: ObserverBubblePosition; moved: boolean };
const viewport = () => ({ left: window.visualViewport?.offsetLeft ?? 0, top: window.visualViewport?.offsetTop ?? 0,
  width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight });
function rowStyle(position: ObserverBubblePosition): CSSProperties {
  return { position: "fixed", left: position.side === "left" ? position.x : position.x + position.iconSize,
    top: position.y + position.iconSize, transform: position.side === "left" ? "translateY(-100%)" : "translate(-100%, -100%)",
    "--scout-cloud-room": `${observerBubbleCloudRoom(position)}px`, "--scout-cloud-lines": observerBubbleCloudLines(position) } as CSSProperties;
}

export function useObserverBubbleDrag(enabled: boolean) {
  const rowRef = useRef<HTMLDivElement>(null);
  const setRow = useCallback((element: HTMLDivElement | null) => { rowRef.current = element; }, []);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const suppressClickUntil = useRef(0);
  const saved = useRef<ObserverBubblePosition | null>(null);
  const [position, setPosition] = useState<ObserverBubblePosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const measure = useCallback(() => {
    const row = rowRef.current;
    const icon = row?.querySelector<HTMLElement>("[data-observer-drag-icon]");
    if (!row || !icon || !row.getBoundingClientRect().height) return null;
    const box = icon.getBoundingClientRect();
    return observerBubblePosition(box.left, box.top, box.width, row.getBoundingClientRect().height, viewport(), saved.current?.side ?? "right");
  }, []);
  const commit = useCallback((next: ObserverBubblePosition) => {
    saved.current = next;
    // React commits only at release/resize, not on every pointer movement.
    setPosition(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const paint = useCallback((next: ObserverBubblePosition, settled: boolean) => {
    const row = rowRef.current;
    if (!row) return;
    const style = rowStyle(next);
    row.style.position = "fixed";
    row.style.left = `${style.left}px`;
    row.style.top = `${style.top}px`;
    row.style.transform = String(style.transform);
    // Keep the message width stable during dragging; fit it inward after release.
    if (settled) {
      row.style.setProperty("--scout-cloud-room", `${observerBubbleCloudRoom(next)}px`);
      row.style.setProperty("--scout-cloud-lines", String(observerBubbleCloudLines(next)));
    }
  }, []);
  const finish = useCallback((event: { pointerId: number }) => {
    const active = drag.current;
    if (!active || event.pointerId !== active.id) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (active.moved) {
      const next = observerBubblePosition(active.current.x, active.current.y, active.current.iconSize, active.current.rowHeight, viewport());
      paint(next, true);
      commit(next);
      suppressClickUntil.current = performance.now() + 400;
    }
    setDragging(false);
    const row = rowRef.current;
    if (row?.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
  }, [commit, paint]);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || !event.isPrimary || event.button !== 0 || drag.current || (event.target as Element).closest("[data-no-observer-drag]")) return;
    const origin = measure();
    if (!origin) return;
    suppressClickUntil.current = 0;
    drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin, current: origin, moved: false };
  };
  const onPointerMove = useCallback((event: { pointerId: number; clientX: number; clientY: number; preventDefault: () => void }) => {
    const active = drag.current;
    if (!active || event.pointerId !== active.id) return;
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY;
    if (!active.moved && Math.hypot(dx, dy) < 6) return;
    if (!active.moved) {
      active.moved = true;
      rowRef.current?.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    active.current = observerBubblePosition(active.origin.x + dx, active.origin.y + dy, active.origin.iconSize, active.origin.rowHeight, viewport(), active.origin.side);
    event.preventDefault();
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current) paint(drag.current.current, false);
    });
  }, [paint]);
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (performance.now() < suppressClickUntil.current) {
      event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = 0;
    }
  };
  const onLostPointerCapture = (event: PointerEvent<HTMLDivElement>) => {
    // Touch initially captures on the child button. Transferring capture to the
    // row fires a bubbling loss from that button; the row still owns the drag.
    if (event.target === event.currentTarget) finish(event);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target as Element).closest("[data-observer-drag-icon]")) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    const origin = measure();
    if (!origin) return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 20;
    const next = observerBubblePosition(origin.x + direction[0] * step, origin.y + direction[1] * step, origin.iconSize, origin.rowHeight, viewport());
    paint(next, true); commit(next);
  };
  useEffect(() => {
    if (!enabled) return;
    const row = rowRef.current;
    const adjust = () => {
      if (drag.current || !saved.current) return;
      const dimensions = measure();
      if (!dimensions) return;
      const next = observerBubblePosition(saved.current.x, saved.current.y, dimensions.iconSize, dimensions.rowHeight, viewport());
      paint(next, true); commit(next);
    };
    const observer = new ResizeObserver(adjust);
    if (row) observer.observe(row);
    // Keep following and finish reliably even when the pointer leaves the bubble.
    const cancel = () => { if (drag.current) finish({ pointerId: drag.current.id }); };
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", adjust);
    window.visualViewport?.addEventListener("resize", adjust);
    window.visualViewport?.addEventListener("scroll", adjust);
    return () => {
      observer.disconnect(); window.removeEventListener("resize", adjust);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", cancel);
      window.visualViewport?.removeEventListener("resize", adjust);
      window.visualViewport?.removeEventListener("scroll", adjust);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null; drag.current = null; setDragging(false);
    };
  }, [enabled, commit, measure, paint, finish, onPointerMove]);
  const panel = position ? observerBubblePanel(position) : null;
  const panelStyle = panel ? { "--scout-panel-left": `${panel.left}px`, "--scout-panel-top": panel.above ? "auto" : `${panel.edge}px`,
    "--scout-panel-bottom": panel.above ? `${window.innerHeight - panel.edge}px` : "auto", "--scout-panel-height": `${panel.height}px` } as CSSProperties : undefined;
  return { setRow, rowStyle: position ? rowStyle(position) : undefined, panelStyle, side: position?.side ?? "right", positioned: !!position, dragging,
    handlers: { onPointerDown, onLostPointerCapture, onClickCapture, onKeyDown,
      onDragStart: (event: DragEvent<HTMLDivElement>) => event.preventDefault() } };
}
