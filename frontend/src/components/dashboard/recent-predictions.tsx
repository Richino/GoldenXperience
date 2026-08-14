"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime } from "@/lib/format/datetime";
import { useForegroundRefresh } from "@/lib/use-foreground-refresh";
import { predictionResultTone, predictionStatusLabel } from "@/lib/binary-format";
import type { BinaryPrediction } from "@/types/binary";

function clock(value: string | null) {
  return value ? formatClockTime(value) : "—";
}

/**
 * The dashboard's "Recent Predictions" — the Binary Prediction counterpart to
 * Recent Trades, shown directly beneath it and kept entirely separate. These are
 * directional 10-minute predictions, never trades: no money, no R, no position.
 */
export function RecentPredictions() {
  const [predictions, setPredictions] = useState<BinaryPrediction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/binary/predictions?limit=6"), { credentials: "include", cache: "no-store" });
      const payload = (await response.json()) as { predictions?: BinaryPrediction[]; error?: string };
      if (!response.ok || !payload.predictions) throw new Error(payload.error ?? "Predictions are unavailable.");
      setPredictions(payload.predictions);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Predictions are unavailable.");
    }
  }, []);

  useEffect(() => {
    // load resolves its fetch before setting state, so the update lands in a
    // promise continuation rather than synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useForegroundRefresh(load);

  return (
    <section className="dashboard-minimal-section" aria-label="Recent predictions">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Recent predictions</h2>
        <Link href="/journal?tab=binary" className="link-quiet pressable text-xs">
          View all
        </Link>
      </div>
      {error ? <p className="mt-3 text-xs text-[color:var(--danger)]">{error}</p> : null}
      {predictions.length ? (
        <div className="dash-trade-list mt-3">
          {predictions.map((prediction) => {
            const tone = predictionResultTone(prediction.status, prediction.result);
            return (
              <Link
                key={prediction.id}
                href={`/signals?instrument=${encodeURIComponent(prediction.instrument)}&prediction=${prediction.id}`}
                className="dash-trade-card pressable"
              >
                <div className="dash-trade-main min-w-0">
                  <p className="dash-trade-title">
                    <span className="dash-trade-pair">{displayNameFor(prediction.instrument)}</span>
                    <span className={prediction.direction === "up" ? "binary-dir is-up" : "binary-dir is-down"}>
                      {prediction.direction === "up" ? "UP" : "DOWN"}
                    </span>
                  </p>
                  <p className="dash-trade-time">
                    {formatChartPrice(prediction.entryPrice, prediction.instrument)} · {clock(prediction.startAt)} → {clock(prediction.intendedExpiration)}
                  </p>
                </div>
                <div className="dash-trade-aside">
                  <p className={`dash-trade-pl metric-number ${tone}`}>{predictionStatusLabel(prediction)}</p>
                  <p className="dash-trade-r metric-number">{prediction.confidence.toFixed(2)}</p>
                </div>
              </Link>
            );
          })}
        </div>
      ) : !error ? (
        <p className="mt-4 text-sm text-[color:var(--muted)]">No predictions yet.</p>
      ) : null}
    </section>
  );
}
