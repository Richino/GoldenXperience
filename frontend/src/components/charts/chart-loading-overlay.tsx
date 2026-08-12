"use client";

import { useEffect, useState } from "react";

const EXIT_MS = 360;

function useAnimatedVisibility(visible: boolean, exitMs = EXIT_MS) {
  const [mounted, setMounted] = useState(visible);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (visible) {
      const frame = window.requestAnimationFrame(() => {
        setMounted(true);
        window.requestAnimationFrame(() => setActive(true));
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const frame = window.requestAnimationFrame(() => setActive(false));
    const timeout = window.setTimeout(() => setMounted(false), exitMs);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [exitMs, visible]);

  return { mounted, active };
}

export function ChartLoadingOverlay({ visible }: { visible: boolean }) {
  const { mounted, active } = useAnimatedVisibility(visible);

  if (!mounted) return null;

  return (
    <div
      aria-busy={active}
      aria-live="polite"
      className={`chart-loading-overlay${active ? " chart-loading-overlay-visible" : ""}`}
    >
      <div className="chart-loading-overlay-content">
        <span aria-hidden className="chart-loading-overlay-spinner" />
        <span>Refreshing chart</span>
      </div>
    </div>
  );
}

export function ChartHistoryLoader({ visible }: { visible: boolean }) {
  const { mounted, active } = useAnimatedVisibility(visible);

  if (!mounted) return null;

  return (
    <div
      aria-busy={active}
      aria-live="polite"
      className={`chart-history-loader${active ? " chart-history-loader-visible" : ""}`}
    >
      <span aria-hidden className="chart-history-loader-track" />
      <span className="chart-history-loader-label">Loading history…</span>
    </div>
  );
}

export async function settleChartLoad(
  startedAt: number,
  minimumMs = 480,
): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });

  const elapsed = Date.now() - startedAt;
  if (elapsed < minimumMs) {
    await new Promise((resolve) => window.setTimeout(resolve, minimumMs - elapsed));
  }
}
