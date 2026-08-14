"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime, formatShortDay } from "@/lib/format/datetime";
import { predictionResultTone, predictionStatusLabel } from "@/lib/binary-format";
import type { BinaryPerformance, BinaryPrediction, BinaryPredictionDetail } from "@/types/binary";

const FILTERS = ["All", "Won", "Lost", "Tie", "Active"] as const;
type Filter = (typeof FILTERS)[number];

function matchesFilter(prediction: BinaryPrediction, filter: Filter) {
  if (filter === "All") return true;
  if (filter === "Active") return prediction.status === "active";
  if (filter === "Won") return prediction.result === "won";
  if (filter === "Lost") return prediction.result === "lost";
  return prediction.result === "tie";
}

function price(value: number | null, prediction: BinaryPrediction) {
  return value === null ? "—" : formatChartPrice(value, prediction.instrument);
}

/** A compact, readable dump of a stored feature snapshot for audit. */
function FeatureSnapshot({ detail }: { detail: BinaryPredictionDetail }) {
  const secondary = Object.entries(detail.secondaryMarks ?? {});
  return (
    <div className="binary-detail">
      <dl className="binary-detail-grid">
        <div><dt>Model</dt><dd className="metric-number">{detail.modelName} · {detail.modelVersion}</dd></div>
        <div><dt>Score</dt><dd className="metric-number">{detail.confidence.toFixed(3)} <span className="text-[color:var(--muted)]">({detail.scoreKind})</span></dd></div>
        <div><dt>Entry</dt><dd className="metric-number">{price(detail.entryPrice, detail)}</dd></div>
        <div><dt>Expiration price</dt><dd className="metric-number">{price(detail.resolutionPrice, detail)}</dd></div>
        <div><dt>Intended expiry</dt><dd className="metric-number">{formatClockTime(detail.intendedExpiration)}</dd></div>
        <div><dt>Price time used</dt><dd className="metric-number">{detail.resolutionPriceTime ? formatClockTime(detail.resolutionPriceTime) : "—"}</dd></div>
      </dl>

      {secondary.length ? (
        <div className="binary-detail-block">
          <p className="binary-detail-label">Research horizons (do not affect the official result)</p>
          <dl className="binary-detail-grid">
            {secondary.map(([key, mark]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd className="metric-number">{formatChartPrice(mark.price, detail.instrument)} · {mark.result}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <details className="binary-detail-block">
        <summary className="binary-detail-label">Feature snapshot (as seen at prediction time)</summary>
        <pre className="binary-detail-json">{JSON.stringify(detail.features, null, 2)}</pre>
      </details>
      <details className="binary-detail-block">
        <summary className="binary-detail-label">Market context</summary>
        <pre className="binary-detail-json">{JSON.stringify(detail.marketContext, null, 2)}</pre>
      </details>
    </div>
  );
}

function PredictionRow({ prediction, initiallyOpen }: { prediction: BinaryPrediction; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [detail, setDetail] = useState<BinaryPredictionDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const tone = predictionResultTone(prediction.status, prediction.result);

  useEffect(() => {
    if (!open || detail || failed) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(apiUrl(`/api/binary/prediction?id=${prediction.id}`), { credentials: "include", cache: "no-store" });
        const payload = (await response.json()) as { prediction?: BinaryPredictionDetail };
        if (cancelled) return;
        if (response.ok && payload.prediction) setDetail(payload.prediction);
        else setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, detail, failed, prediction.id]);

  return (
    <article className="journal-entry" data-open={open || undefined}>
      <button type="button" className="binary-entry-head pressable" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <div className="binary-entry-main min-w-0">
          <p className="journal-entry-title">
            <span className="journal-entry-pair">{displayNameFor(prediction.instrument)}</span>
            <span className={prediction.direction === "up" ? "binary-dir is-up" : "binary-dir is-down"}>
              {prediction.direction === "up" ? "UP" : "DOWN"}
            </span>
            <span className="journal-entry-auto">#{prediction.sequence}</span>
          </p>
          <p className="binary-entry-sub metric-number">
            {price(prediction.entryPrice, prediction)} · {formatClockTime(prediction.startAt)} → {formatClockTime(prediction.intendedExpiration)} · {formatShortDay(prediction.createdAt)}
          </p>
        </div>
        <div className="binary-entry-aside">
          <span className={`journal-entry-r metric-number ${tone}`}>{predictionStatusLabel(prediction)}</span>
          <span className="binary-entry-score metric-number">{prediction.confidence.toFixed(2)}</span>
        </div>
      </button>
      {open ? (
        detail ? (
          <FeatureSnapshot detail={detail} />
        ) : failed ? (
          <p className="binary-detail-loading">Snapshot unavailable.</p>
        ) : (
          <p className="binary-detail-loading">Loading snapshot…</p>
        )
      ) : null}
    </article>
  );
}

/**
 * The Binary Predictions tab of the Journal: the complete, immutable prediction
 * history with each record's stored feature snapshot, kept separate from the
 * trade journal.
 */
export function BinaryJournalView() {
  const [predictions, setPredictions] = useState<BinaryPrediction[]>([]);
  const [stats, setStats] = useState<BinaryPerformance | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [journalResponse, statsResponse] = await Promise.all([
        fetch(apiUrl("/api/binary/journal"), { credentials: "include", cache: "no-store" }),
        fetch(apiUrl("/api/binary/stats"), { credentials: "include", cache: "no-store" }),
      ]);
      const journalPayload = (await journalResponse.json()) as { predictions?: BinaryPrediction[]; error?: string };
      if (!journalResponse.ok || !journalPayload.predictions) throw new Error(journalPayload.error ?? "Prediction history is unavailable.");
      setPredictions(journalPayload.predictions);
      if (statsResponse.ok) setStats((await statsResponse.json()) as BinaryPerformance);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Prediction history is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load resolves its fetch before setting state, so the update lands in a
    // promise continuation rather than synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    setFocusId(new URLSearchParams(window.location.search).get("prediction"));
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => predictions.filter((prediction) => matchesFilter(prediction, filter)), [predictions, filter]);
  const summary = stats?.summary;

  return (
    <div className="journal-view space-y-6">
      <section className="journal-stats-card grid grid-cols-4" aria-label="Prediction summary">
        {(
          [
            ["Predictions", summary ? String(summary.total) : "—"],
            ["Win rate", summary && summary.winRate !== null ? `${(summary.winRate * 100).toFixed(0)}%` : "—"],
            ["Resolved", summary ? `${summary.won}W · ${summary.lost}L` : "—"],
            ["Ties", summary ? String(summary.tie) : "—"],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="journal-stat min-w-0">
            <p className="text-xs text-[color:var(--muted)]">{label}</p>
            <p className="metric-number mt-1 text-xl font-semibold tracking-[-0.03em]">{value}</p>
          </div>
        ))}
      </section>

      {summary && summary.resolved > 0 && summary.resolved < 30 ? (
        <p className="text-xs text-[color:var(--muted)]">
          {summary.resolved} resolved so far — too few to claim an edge. This is forward-test collection.
        </p>
      ) : null}

      <section className="dashboard-minimal-section" aria-label="Prediction log">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Prediction log</h2>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`check-chip pressable ${filter === value ? "check-chip-active" : ""}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className="mt-3 text-xs text-[color:var(--danger)]">{error}</p> : null}

        {loading ? (
          <p className="mt-4 text-sm text-[color:var(--muted)]">Loading…</p>
        ) : filtered.length ? (
          <div className="journal-entry-list mt-3">
            {filtered.map((prediction) => (
              <PredictionRow key={prediction.id} prediction={prediction} initiallyOpen={prediction.id === focusId} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-[color:var(--muted)]">No predictions in this view.</p>
        )}
      </section>
    </div>
  );
}
