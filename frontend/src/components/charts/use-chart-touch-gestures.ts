"use client";

import { useEffect, type RefObject } from "react";
import type {
  IChartApi,
  ISeriesApi,
  Logical,
  SeriesType,
} from "lightweight-charts";

/**
 * A self-contained touch/gesture layer for the mobile (`embedded`) chart. It
 * owns finger input and drives Lightweight Charts through its native APIs only
 * — `timeScale().setVisibleLogicalRange`, `priceScale().setVisibleRange` and
 * the coordinate converters — never DOM-pixel manipulation. Desktop mouse,
 * wheel, axis drag and crosshair are left to the library untouched.
 *
 * Gestures:
 *   1 finger  → free 2D pan (time on X, price on Y), with restrained release
 *               inertia.
 *   2 fingers → intent is detected past a dead zone and then locked for the
 *               rest of the gesture: mostly-horizontal stretches candle
 *               spacing, mostly-vertical stretches the price scale, and a
 *               balanced pinch scales both around the midpoint between the
 *               fingers.
 *
 * All per-frame state lives in closure variables (no React state), and visual
 * updates are coalesced into a single `requestAnimationFrame`.
 */

type GestureMode =
  | "none"
  | "pan"
  | "pinch"
  | "horizontal-scale"
  | "vertical-scale";

interface Point {
  x: number;
  y: number;
}

// Movement (in CSS px) a two-finger gesture must exceed before its intent is
// locked — small enough to feel immediate, large enough to beat sensor jitter.
const DEAD_ZONE = 8;
// How much one axis must out-move the other to count as a directional stretch
// rather than a balanced pinch.
const DOMINANCE = 1.4;
// Guards against the huge scale factors you get when the two fingers start
// almost on top of each other.
const MIN_FINGER_SEPARATION = 24;
// Candle width limits so the chart can never become unreadable.
const MIN_BAR_SPACING = 2;
const MAX_BAR_SPACING = 60;
// Clamp a single vertical pinch so the price scale can't invert or explode.
const MIN_PRICE_SCALE = 0.2;
const MAX_PRICE_SCALE = 5;
// Vertical pan only takes over the price scale once the finger has clearly
// moved on Y, so a horizontal swipe doesn't quietly switch off auto-scaling.
const PRICE_ENGAGE = 4;
// +1 keeps the price under the finger as the finger drags (grab-and-move).
const PRICE_PAN_SIGN = 1;
// Restrained inertia: per-frame velocity decay, the speed it stops at, and a
// cap so a hard flick can't launch the view across the whole history.
const INERTIA_DECAY = 0.9;
const INERTIA_STOP = 0.02; // px/ms
const MAX_VELOCITY = 3; // px/ms
const FRAME_MS = 16;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function useChartTouchGestures({
  containerRef,
  chartRef,
  mainSeriesRef,
  enabled,
  epoch,
  onManualPrice,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  chartRef: RefObject<IChartApi | null>;
  mainSeriesRef: RefObject<ISeriesApi<SeriesType> | null>;
  enabled: boolean;
  epoch: number;
  onManualPrice: () => void;
}) {
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
    let panLastX = 0;
    let panLastY = 0;
    let panStartY = 0;
    let priceEngaged = false;
    let priceManual = false;
    let panePriceHeight = 0;
    // Instantaneous pan velocity, for release inertia.
    let velocityX = 0;
    let velocityY = 0;
    let lastMoveX = 0;
    let lastMoveY = 0;
    let lastMoveT = 0;

    // --- two-finger baseline, captured when the second finger lands ---
    let baseDx = 0;
    let baseDy = 0;
    let baseMidLogical = 0;
    let baseMidPrice = 0;
    let baseLogicalFrom = 0;
    let baseLogicalTo = 0;
    let basePriceFrom = 0;
    let basePriceTo = 0;
    let basePaneTopY = 0;
    let basePaneHeight = 0;
    let baseWidth = 0;

    const relativePoint = (event: PointerEvent): Point => ({
      x: event.clientX - originX,
      y: event.clientY - originY,
    });

    const width = () => container.clientWidth || 1;

    // The pixel height of the price pane, read back through the library's own
    // price↔coordinate mapping so it stays correct with oscillator panes.
    const priceScale = () => mainSeriesRef.current?.priceScale() ?? null;

    function measurePane(): { topY: number; height: number } {
      const series = mainSeriesRef.current;
      const scale = priceScale();
      const fallback = { topY: 0, height: container.clientHeight || 1 };
      if (!series || !scale) return fallback;
      const range = scale.getVisibleRange();
      if (!range) return fallback;
      const topY = series.priceToCoordinate(range.to);
      const bottomY = series.priceToCoordinate(range.from);
      if (topY === null || bottomY === null) return fallback;
      return { topY, height: Math.max(1, bottomY - topY) };
    }

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

    function enterManualPrice() {
      const scale = priceScale();
      if (!scale) return false;
      if (!priceManual) {
        scale.setAutoScale(false);
        priceManual = true;
        panePriceHeight = measurePane().height;
        onManualPrice();
      }
      return true;
    }

    function shiftPriceByPixels(dyPx: number, allowToggle: boolean) {
      const scale = priceScale();
      if (!scale) return;
      if (!priceManual) {
        if (!allowToggle) return;
        if (!enterManualPrice()) return;
      }
      const range = scale.getVisibleRange();
      if (!range) return;
      const span = range.to - range.from;
      const pricePerPx = span / (panePriceHeight || measurePane().height || 1);
      const shift = PRICE_PAN_SIGN * dyPx * pricePerPx;
      scale.setVisibleRange({ from: range.from + shift, to: range.to + shift });
    }

    // --- gesture starts ---
    function startPan(point: Point) {
      mode = "pan";
      panLastX = point.x;
      panLastY = point.y;
      panStartY = point.y;
      priceEngaged = false;
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
      baseDx = Math.abs(b.x - a.x);
      baseDy = Math.abs(b.y - a.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;

      const timeScale = chart.timeScale();
      const logical = timeScale.getVisibleLogicalRange();
      baseLogicalFrom = logical?.from ?? 0;
      baseLogicalTo = logical?.to ?? 0;
      baseMidLogical = timeScale.coordinateToLogical(midX) ?? baseLogicalTo;

      const scale = priceScale();
      const priceRange = scale?.getVisibleRange() ?? null;
      basePriceFrom = priceRange?.from ?? 0;
      basePriceTo = priceRange?.to ?? 0;
      baseMidPrice =
        mainSeriesRef.current?.coordinateToPrice(midY) ??
        (basePriceFrom + basePriceTo) / 2;

      const pane = measurePane();
      basePaneTopY = pane.topY;
      basePaneHeight = pane.height;
      baseWidth = width();
    }

    // --- per-frame application ---
    function applyHorizontal(curDx: number, midX: number) {
      if (baseDx < MIN_FINGER_SEPARATION) return;
      const baseBars = baseLogicalTo - baseLogicalFrom;
      if (baseBars <= 0) return;
      const baseBarSpacing = baseWidth / baseBars;
      const scaleX = curDx / baseDx;
      const newBarSpacing = clamp(
        baseBarSpacing * scaleX,
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
    }

    function applyVertical(curDy: number, midY: number) {
      if (baseDy < MIN_FINGER_SEPARATION) return;
      const scale = priceScale();
      if (!scale) return;
      if (!enterManualPrice()) return;
      const baseSpan = basePriceTo - basePriceFrom;
      if (baseSpan <= 0) return;
      const scaleY = clamp(curDy / baseDy, MIN_PRICE_SCALE, MAX_PRICE_SCALE);
      const newSpan = baseSpan / scaleY;
      const fractionTop = basePaneHeight
        ? (midY - basePaneTopY) / basePaneHeight
        : 0.5;
      const to = baseMidPrice + fractionTop * newSpan;
      const from = to - newSpan;
      if (from < to) scale.setVisibleRange({ from, to });
    }

    function applyTwoFinger() {
      const values = [...pointers.values()];
      const a = values[0];
      const b = values[1];
      if (!a || !b) return;
      const curDx = Math.abs(b.x - a.x);
      const curDy = Math.abs(b.y - a.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;

      if (mode === "none") {
        const changeX = Math.abs(curDx - baseDx);
        const changeY = Math.abs(curDy - baseDy);
        if (Math.max(changeX, changeY) < DEAD_ZONE) return;
        if (changeX > changeY * DOMINANCE) mode = "horizontal-scale";
        else if (changeY > changeX * DOMINANCE) mode = "vertical-scale";
        else mode = "pinch";
      }

      if (mode === "horizontal-scale" || mode === "pinch") {
        applyHorizontal(curDx, midX);
      }
      if (mode === "vertical-scale" || mode === "pinch") {
        applyVertical(curDy, midY);
      }
    }

    function applyFrame() {
      frame = 0;
      if (pointers.size >= 2) {
        applyTwoFinger();
        return;
      }
      if (mode === "pan" && pointers.size === 1) {
        const point = [...pointers.values()][0];
        if (!point) return;
        const dx = point.x - panLastX;
        const dy = point.y - panLastY;
        panLastX = point.x;
        panLastY = point.y;
        if (dx) shiftTimeByPixels(dx);
        if (!priceEngaged && Math.abs(point.y - panStartY) > PRICE_ENGAGE) {
          priceEngaged = true;
        }
        if (priceEngaged && dy) shiftPriceByPixels(dy, true);
      }
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
      if (Math.hypot(vx, vy) < INERTIA_STOP) return;
      const inertiaPriceEngaged = priceEngaged;
      const step = () => {
        shiftTimeByPixels(vx * FRAME_MS);
        if (inertiaPriceEngaged) shiftPriceByPixels(vy * FRAME_MS, false);
        vx *= INERTIA_DECAY;
        vy *= INERTIA_DECAY;
        if (Math.hypot(vx, vy) < INERTIA_STOP) {
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
