"use client";

import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { CrosshairMode, type IChartApi, type MouseEventParams, type Time } from "lightweight-charts";
import { formatChartHoverTime } from "@/lib/format/datetime";

function timeToMs(time: Time) {
  if (typeof time === "number") return time * 1_000;
  if (typeof time === "string") return new Date(time).getTime();
  return Date.UTC(time.year, time.month - 1, time.day);
}

/** Rounded badges using public chart APIs; the library owns the crosshair lines. */
export function ChartCrosshairLabels({
  chartRef, epoch, enabled, background, color,
}: {
  chartRef: RefObject<IChartApi | null>;
  epoch: number;
  enabled: boolean;
  background: string;
  color: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const chart = chartRef.current;
    const host = hostRef.current;
    const priceLabel = priceRef.current;
    const timeLabel = timeRef.current;
    if (!enabled || !chart || !host || !priceLabel || !timeLabel) return;

    const hide = () => { host.hidden = true; };
    const paint = (event: MouseEventParams<Time>) => {
      const pane = chart.panes()[event.paneIndex ?? 0];
      const series = pane?.getSeries()[0];
      const paneElement = pane?.getHTMLElement();
      if (!event.point || !pane || !series || !paneElement ||
        chart.options().crosshair.mode === CrosshairMode.Hidden) {
        hide();
        return;
      }

      const { x, y } = event.point;
      if (x < 0 || x > chart.timeScale().width() || y < 0 || y > pane.getHeight()) {
        hide();
        return;
      }
      const price = series.coordinateToPrice(y);
      if (price === null || !Number.isFinite(price)) {
        hide();
        return;
      }

      host.hidden = false;
      priceLabel.textContent = series.priceFormatter().format(price);
      const paneTop = paneElement.getBoundingClientRect().top - host.getBoundingClientRect().top;
      const halfHeight = priceLabel.offsetHeight / 2;
      const priceY = paneTop + Math.max(halfHeight, Math.min(y, pane.getHeight() - halfHeight));
      priceLabel.style.top = `${priceY}px`;

      timeLabel.hidden = event.time === undefined;
      if (event.time !== undefined) {
        timeLabel.textContent = formatChartHoverTime(timeToMs(event.time));
        const halfWidth = timeLabel.offsetWidth / 2;
        const crosshairX = chart.timeScale().timeToCoordinate(event.time) ?? x;
        const timeX = Math.max(halfWidth + 2, Math.min(crosshairX, chart.timeScale().width() - halfWidth - 2));
        timeLabel.style.left = `${timeX}px`;
      }
    };

    chart.subscribeCrosshairMove(paint);
    // Also clear when the pointer leaves for a toolbar overlay or chart control.
    const container = host.parentElement;
    container?.addEventListener("pointerleave", hide);
    return () => {
      chart.unsubscribeCrosshairMove(paint);
      container?.removeEventListener("pointerleave", hide);
      hide();
    };
  }, [chartRef, enabled, epoch]);

  if (!enabled) return null;

  return (
    <div ref={hostRef} className="setup-chart-crosshair-labels" hidden aria-hidden="true"
      style={{ "--crosshair-background": background, "--crosshair-color": color } as CSSProperties}>
      <span ref={priceRef} className="setup-chart-crosshair-label is-price" />
      <span ref={timeRef} className="setup-chart-crosshair-label is-time" />
    </div>
  );
}
