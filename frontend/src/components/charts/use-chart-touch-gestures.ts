"use client";

import { useEffect, useRef, type RefObject } from "react";
import type {
  IChartApi,
  Logical,
} from "lightweight-charts";

/**
 * A self-contained touch/gesture layer for the mobile (`embedded`) chart. It
 * owns finger input and drives Lightweight Charts through its native APIs only
 * — `timeScale().setVisibleLogicalRange` — never DOM-pixel manipulation. Desktop mouse,
 * wheel, axis drag and crosshair are left to the library untouched.
 *
 * Gestures:
 *   1 finger  → free pan through both history and price, with restrained
 *               release inertia.
 *   2 fingers → pinch to zoom both visible ranges around the pinch midpoint.
 *
 * All per-frame state lives in closure variables (no React state), and visual
 * updates are coalesced into a single `requestAnimationFrame`.
 */

type GestureMode = "none" | "pan" | "pinch";

interface Point {
  x: number;
  y: number;
}

// Keeps a near-overlapping starting pair from producing a huge scale factor.
// It is a stability floor, not a gesture gate: a pinch can still begin anywhere
// on the chart and in any orientation.
const MIN_FINGER_SEPARATION = 24;
// Candle width limits so the chart can never become unreadable.
const MIN_BAR_SPACING = 2;
const MAX_BAR_SPACING = 60;
// A single pinch cannot make a 4× change in either direction. Repeat the
// gesture to go further; this avoids an accidental two-finger jump leaving
// the chart at an unusable scale.
const MIN_PINCH_SCALE = 0.25;
const MAX_PINCH_SCALE = 4;
// Restrained inertia: per-frame velocity decay, the speed it stops at, and a
// cap so a hard flick can't launch the view across the whole history. Tuned
// gentle — a short, slow glide that settles quickly rather than a long fling.
const INERTIA_DECAY = 0.86;
const INERTIA_STOP = 0.04; // px/ms
const MAX_VELOCITY = 1.8; // px/ms
const FRAME_MS = 16;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function useChartTouchGestures({
  containerRef,
  chartRef,
  enabled,
  epoch,
  onViewChange,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  chartRef: RefObject<IChartApi | null>;
  enabled: boolean;
  epoch: number;
  /** Fires after each applied pan/pinch/inertia frame so overlays can glue on. */
  onViewChange?: () => void;
}) {
  const onViewChangeRef = useRef(onViewChange);

  useEffect(() => {
    onViewChangeRef.current = onViewChange;
  }, [onViewChange]);

  useEffect(() => {
    if (!enabled) return;
    const containerEl = containerRef.current;
    const chartApi = chartRef.current;
    if (!containerEl || !chartApi) return;
    // Re-bound as non-null consts so the flow narrowing survives inside the
    // nested handler closures below.
    const container = containerEl;
    const chart = chartApi;

    const pointers = new Map<number, Point>();
    let mode: GestureMode = "none";
    let frame = 0;
    let inertiaFrame = 0;
    // The container's viewport origin, cached once per gesture so pointermove
    // never forces a layout read. `touch-action: none` keeps the page from
    // scrolling mid-gesture, so it stays valid until the fingers lift.
    let originX = 0;
    let originY = 0;

    // --- pan state ---
    let panLastPoint: Point = { x: 0, y: 0 };
    // Instantaneous pan velocity, for release inertia.
    let velocityX = 0;
    let velocityY = 0;
    let lastMoveX = 0;
    let lastMoveY = 0;
    let lastMoveT = 0;

    // --- two-finger baseline, captured when the second finger lands ---
    let baseDistance = 0;
    let baseMidLogical = 0;
    let baseLogicalFrom = 0;
    let baseLogicalTo = 0;
    let baseWidth = 0;
    let baseHeight = 0;
    let basePriceFrom = 0;
    let basePriceTo = 0;
    let baseMidPrice = 0;

    const relativePoint = (event: PointerEvent): Point => ({
      x: event.clientX - originX,
      y: event.clientY - originY,
    });

    const width = () => container.clientWidth || 1;
    const height = () => container.clientHeight || 1;

    // --- native-API primitives ---
    function shiftTimeByPixels(dxPx: number) {
      const timeScale = chart.timeScale();
      const range = timeScale.getVisibleLogicalRange();
      if (!range) return;
      const bars = range.to - range.from;
      if (bars <= 0) return;
      const barSpacing = width() / bars;
      const deltaBars = dxPx / barSpacing;
      timeScale.setVisibleLogicalRange({
        from: (range.from - deltaBars) as Logical,
        to: (range.to - deltaBars) as Logical,
      });
    }

    function shiftPriceByPixels(dyPx: number) {
      const priceScale = chart.priceScale("right");
      const range = priceScale.getVisibleRange();
      if (!range) return;
      const span = range.to - range.from;
      if (span <= 0) return;
      const delta = (dyPx / height()) * span;
      priceScale.setAutoScale(false);
      priceScale.setVisibleRange({
        from: range.from + delta,
        to: range.to + delta,
      });
    }

    // --- gesture starts ---
    function startPan(point: Point) {
      mode = "pan";
      panLastPoint = point;
      velocityX = 0;
      velocityY = 0;
      lastMoveX = point.x;
      lastMoveY = point.y;
      lastMoveT = performance.now();
    }

    function startTwoFinger() {
      mode = "none";
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      baseDistance = Math.max(
        Math.hypot(b.x - a.x, b.y - a.y),
        MIN_FINGER_SEPARATION,
      );
      const midX = (a.x + b.x) / 2;

      const timeScale = chart.timeScale();
      const logical = timeScale.getVisibleLogicalRange();
      baseLogicalFrom = logical?.from ?? 0;
      baseLogicalTo = logical?.to ?? 0;
      baseMidLogical = timeScale.coordinateToLogical(midX) ?? baseLogicalTo;

      baseWidth = width();
      baseHeight = height();
      const priceRange = chart.priceScale("right").getVisibleRange();
      basePriceFrom = priceRange?.from ?? 0;
      basePriceTo = priceRange?.to ?? 0;
      const midY = (a.y + b.y) / 2;
      const priceFraction = clamp(midY / baseHeight, 0, 1);
      baseMidPrice = basePriceTo - priceFraction * (basePriceTo - basePriceFrom);
    }

    // --- per-frame application ---
    function applyPinch(curDistance: number, midX: number, midY: number) {
      const baseBars = baseLogicalTo - baseLogicalFrom;
      if (baseBars <= 0) return;
      const baseBarSpacing = baseWidth / baseBars;
      const scale = clamp(
        Math.max(curDistance, MIN_FINGER_SEPARATION) / baseDistance,
        MIN_PINCH_SCALE,
        MAX_PINCH_SCALE,
      );
      const newBarSpacing = clamp(
        baseBarSpacing * scale,
        MIN_BAR_SPACING,
        MAX_BAR_SPACING,
      );
      const barsVisible = baseWidth / newBarSpacing;
      const fraction = midX / baseWidth;
      const from = baseMidLogical - fraction * barsVisible;
      const to = from + barsVisible;
      chart.timeScale().setVisibleLogicalRange({
        from: from as Logical,
        to: to as Logical,
      });

      const basePriceSpan = basePriceTo - basePriceFrom;
      if (basePriceSpan <= 0) return;
      const priceSpan = basePriceSpan / scale;
      const priceFraction = clamp(midY / baseHeight, 0, 1);
      const priceTo = baseMidPrice + priceFraction * priceSpan;
      const priceScale = chart.priceScale("right");
      priceScale.setAutoScale(false);
      priceScale.setVisibleRange({
        from: priceTo - priceSpan,
        to: priceTo,
      });
    }

    function applyTwoFinger() {
      const values = [...pointers.values()];
      const a = values[0];
      const b = values[1];
      if (!a || !b) return;
      const curDistance = Math.hypot(b.x - a.x, b.y - a.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      mode = "pinch";
      applyPinch(curDistance, midX, midY);
    }

    function applyFrame() {
      frame = 0;
      if (pointers.size >= 2) {
        applyTwoFinger();
        onViewChangeRef.current?.();
        return;
      }
      if (mode === "pan" && pointers.size === 1) {
        const point = [...pointers.values()][0];
        if (!point) return;
        const dx = point.x - panLastPoint.x;
        const dy = point.y - panLastPoint.y;
        panLastPoint = point;
        if (dx) shiftTimeByPixels(dx);
        if (dy) shiftPriceByPixels(dy);
      }
      onViewChangeRef.current?.();
    }

    function scheduleFrame() {
      if (!frame) frame = requestAnimationFrame(applyFrame);
    }

    // --- inertia ---
    function stopInertia() {
      if (inertiaFrame) {
        cancelAnimationFrame(inertiaFrame);
        inertiaFrame = 0;
      }
    }

    function startInertia() {
      let vx = clamp(velocityX, -MAX_VELOCITY, MAX_VELOCITY);
      let vy = clamp(velocityY, -MAX_VELOCITY, MAX_VELOCITY);
      if (Math.max(Math.abs(vx), Math.abs(vy)) < INERTIA_STOP) return;
      const step = () => {
        shiftTimeByPixels(vx * FRAME_MS);
        shiftPriceByPixels(vy * FRAME_MS);
        onViewChangeRef.current?.();
        vx *= INERTIA_DECAY;
        vy *= INERTIA_DECAY;
        if (Math.max(Math.abs(vx), Math.abs(vy)) < INERTIA_STOP) {
          inertiaFrame = 0;
          return;
        }
        inertiaFrame = requestAnimationFrame(step);
      };
      inertiaFrame = requestAnimationFrame(step);
    }

    // --- pointer handlers ---
    function onPointerDown(event: PointerEvent) {
      if (event.pointerType === "mouse") return;
      stopInertia();
      if (pointers.size === 0) {
        const rect = container.getBoundingClientRect();
        originX = rect.left;
        originY = rect.top;
      }
      pointers.set(event.pointerId, relativePoint(event));
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; gestures still work without it.
      }
      if (pointers.size === 1) {
        startPan([...pointers.values()][0]!);
      } else if (pointers.size === 2) {
        startTwoFinger();
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (event.pointerType === "mouse") return;
      if (!pointers.has(event.pointerId)) return;
      const point = relativePoint(event);
      pointers.set(event.pointerId, point);

      if (mode === "pan" && pointers.size === 1) {
        const now = performance.now();
        const dt = now - lastMoveT;
        if (dt > 0) {
          velocityX = (point.x - lastMoveX) / dt;
          velocityY = (point.y - lastMoveY) / dt;
          lastMoveX = point.x;
          lastMoveY = point.y;
          lastMoveT = now;
        }
      }

      scheduleFrame();
    }

    function endPointer(event: PointerEvent) {
      if (event.pointerType === "mouse") return;
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      try {
        container.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore — the pointer may already be released.
      }

      if (pointers.size === 1) {
        // Two → one finger: the remaining finger becomes a fresh pan baseline
        // so the chart doesn't jump. No fling carries over from scaling.
        startPan([...pointers.values()][0]!);
      } else if (pointers.size === 0) {
        if (mode === "pan") startInertia();
        mode = "none";
      }
    }

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endPointer);
    container.addEventListener("pointercancel", endPointer);

    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", endPointer);
      container.removeEventListener("pointercancel", endPointer);
      if (frame) cancelAnimationFrame(frame);
      stopInertia();
      pointers.clear();
    };
    // Reattaches to the freshly created chart whenever it is rebuilt (`epoch`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, epoch]);
}
