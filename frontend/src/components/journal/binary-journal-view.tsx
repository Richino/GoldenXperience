"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime, formatShortDay } from "@/lib/format/datetime";
import { predictionResultTone, predictionStatusLabel } from "@/lib/binary-format";
import { useInfiniteScroll } from "@/lib/use-infinite-scroll";
import type { BinaryPerformance, BinaryPrediction, BinaryPredictionDetail } from "@/types/binary";

const FILTERS = ["All", "Won", "Lost", "Tie", "Active"] as const;
type Filter = (typeof FILTERS)[number];

const PAGE_SIZE = 20;

function filterParamFor(filter: Filter): "all" | "won" | "lost" | "tie" | "active" {
  return filter === "Won"
    ? "won"
    : filter === "Lost"
      ? "lost"
      : filter === "Tie"
        ? "tie"
        : filter === "Active"
          ? "active"
          : "all";
}

function dedupeById(items: BinaryPrediction[]): BinaryPrediction[] {
  const seen = new Set<string>();
  return items.filter((item) =>
    seen.has(item.id) ? false : (seen.add(item.id), true),
  );
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const requestSeqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const filterParam = filterParamFor(filter);

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch(apiUrl("/api/binary/stats"), { credentials: "include", cache: "no-store" });
      if (response.ok) setStats((await response.json()) as BinaryPerformance);
    } catch {
      // Stats are supplementary; the list stays usable without them.
    }
  }, []);

  // Loads one page. `reset` restarts at the first page for a filter change;
  // otherwise it appends the next page. A per-call sequence drops a slower
  // earlier request that resolves after a newer one.
  const loadPage = useCallback(
    async (reset: boolean) => {
      const seq = ++requestSeqRef.current;
      const offset = reset ? 0 : offsetRef.current;
      if (!reset) setLoadingMore(true);
      try {
        const response = await fetch(
          apiUrl(`/api/binary/journal?limit=${PAGE_SIZE}&offset=${offset}&filter=${filterParam}`),
          { credentials: "include", cache: "no-store" },
        );
        const payload = (await response.json()) as { predictions?: BinaryPrediction[]; hasMore?: boolean; error?: string };
        if (!response.ok || !payload.predictions) throw new Error(payload.error ?? "Prediction history is unavailable.");
        if (seq !== requestSeqRef.current) return;
        const batch = payload.predictions;
        offsetRef.current = offset + batch.length;
        setPredictions((prev) => (reset ? batch : dedupeById([...prev, ...batch])));
        setHasMore(Boolean(payload.hasMore));
        setError(null);
      } catch (reason) {
        if (seq === requestSeqRef.current) {
          setError(reason instanceof Error ? reason.message : "Prediction history is unavailable.");
        }
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filterParam],
  );

  // Refresh page one of the current filter and merge by id, so active
  // predictions flip to resolved (and brand-new ones appear at the top) without
  // resetting the loaded list or the user's scroll position.
  const refreshActive = useCallback(async () => {
    try {
      const response = await fetch(
        apiUrl(`/api/binary/journal?limit=${PAGE_SIZE}&offset=0&filter=${filterParam}`),
        { credentials: "include", cache: "no-store" },
      );
      const payload = (await response.json()) as { predictions?: BinaryPrediction[] };
      if (response.ok && payload.predictions) {
        const page = payload.predictions;
        setPredictions((prev) => {
          const known = new Set(prev.map((prediction) => prediction.id));
          const fresh = page.filter((prediction) => !known.has(prediction.id));
          const updated = prev.map((prediction) => page.find((next) => next.id === prediction.id) ?? prediction);
          return [...fresh, ...updated];
        });
      }
    } catch {
      // Left as-is until the next tick.
    }
    void loadStats();
  }, [filterParam, loadStats]);

  // One-time deep link: open a specific prediction if it is in the loaded set.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusId(new URLSearchParams(window.location.search).get("prediction"));
  }, []);

  // Filter change (and first mount) resets to page one and reloads stats.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void loadPage(true);
    void loadStats();
  }, [loadPage, loadStats]);

  // Periodic refresh keeps active predictions current without a full reload.
  useEffect(() => {
    const timer = window.setInterval(() => void refreshActive(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshActive]);

  const loadMore = useCallback(() => {
    void loadPage(false);
  }, [loadPage]);
  useInfiniteScroll({ sentinelRef, hasMore, loading: loading || loadingMore, onLoadMore: loadMore });

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

      {stats && stats.horizons.some((horizon) => horizon.resolved > 0) ? (
        <section className="dashboard-minimal-section" aria-label="Horizon comparison">
          <h2 className="text-sm font-semibold tracking-[-0.01em]">Horizon comparison</h2>
          <div className="binary-horizon-grid mt-3">
            {stats.horizons.map((horizon) => (
              <div key={horizon.horizonSeconds} className="binary-horizon-cell">
                <p className="binary-horizon-label">{horizon.label}</p>
                <p className="metric-number binary-horizon-rate">
                  {horizon.winRate === null ? "—" : `${(horizon.winRate * 100).toFixed(0)}%`}
                </p>
                <dl className="binary-horizon-split">
                  <div>
                    <dt className="is-win">W</dt>
                    <dd className="metric-number">{horizon.won}</dd>
                  </div>
                  <div>
                    <dt className="is-loss">L</dt>
                    <dd className="metric-number">{horizon.lost}</dd>
                  </div>
                  <div>
                    <dt>T</dt>
                    <dd className="metric-number">{horizon.tie}</dd>
                  </div>
                </dl>
                <p className="binary-horizon-sample">
                  {horizon.resolved} resolved{horizon.missing ? ` · ${horizon.missing} no data` : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
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
        ) : predictions.length ? (
          <>
            <div className="journal-entry-list mt-3">
              {predictions.map((prediction) => (
                <PredictionRow key={prediction.id} prediction={prediction} initiallyOpen={prediction.id === focusId} />
              ))}
            </div>
            <div ref={sentinelRef} aria-hidden className="h-px" />
            {loadingMore ? (
              <p className="mt-4 text-center text-sm text-[color:var(--muted)]">Loading more…</p>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-sm text-[color:var(--muted)]">No predictions in this view.</p>
        )}
      </section>
    </div>
  );
}
