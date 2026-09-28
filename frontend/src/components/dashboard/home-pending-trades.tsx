"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { displayNameFor } from "@/lib/instruments/catalog";
import {
  pendingLevelPrice,
  pendingStatusLabel,
  pendingTimingNote,
  pendingTriggerSummary,
} from "@/lib/pending-entry/plain-language";
import type { PendingManualEntry } from "@/types/pending-entry";

export function HomePendingTrades({
  entries,
  cancellingId,
  error,
  onCancel,
}: {
  entries: PendingManualEntry[];
  cancellingId: string | null;
  error: string | null;
  onCancel: (entry: PendingManualEntry) => void;
}) {
  if (!entries.length) {
    return (
      <section className="home-section home-pending-trades" aria-label="Pending trades">
        <div className="home-section-head">
          <h2>Pending trades</h2>
        </div>
        <p className="home-pending-empty">Nothing waiting yet — orders you set on the chart will show up here.</p>
        {error ? <p className="home-pending-error" role="status">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="home-section home-pending-trades" aria-label="Pending trades">
      <div className="home-section-head">
        <h2>Pending trades</h2>
        <span className="home-pending-count">{entries.length} {entries.length === 1 ? "trade" : "trades"}</span>
      </div>
      <div className="home-pending-list">
        {entries.map((entry) => {
          const canCancel = entry.status === "PENDING";
          const cancelling = cancellingId === entry.id;
          const timingNote = pendingTimingNote(entry);
          const entryLevel = pendingLevelPrice(entry.entryPrice, entry.instrument);
          const stopLoss = pendingLevelPrice(entry.stopPrice, entry.instrument);
          const takeProfit = pendingLevelPrice(entry.targetPrice, entry.instrument);
          return (
            <div key={entry.id} className={`home-pending-row is-${entry.direction}`}>
              <Link
                href={`/chart?instrument=${entry.instrument}`}
                className="home-pending-link"
                aria-label={pendingTriggerSummary(entry)}
              >
                <div className="home-pending-header">
                  <span className="home-pending-ident">
                    <strong>{displayNameFor(entry.instrument)}</strong>
                    <span className={`home-side is-${entry.direction}`}>
                      {entry.direction === "long" ? "LONG" : "SHORT"}
                    </span>
                  </span>
                  <span className="home-pending-status">{pendingStatusLabel(entry.status)}</span>
                </div>
                <dl className="home-pending-levels">
                  <div>
                    <dt>Entry</dt>
                    <dd className="metric-number">{entryLevel.text}</dd>
                  </div>
                  <div>
                    <dt>
                      <span className="home-pending-dt-wide">Stop loss</span>
                      <span className="home-pending-dt-narrow">SL</span>
                    </dt>
                    <dd className={`metric-number${stopLoss.unset ? " is-unset" : ""}`}>{stopLoss.text}</dd>
                  </div>
                  <div>
                    <dt>
                      <span className="home-pending-dt-wide">Take profit</span>
                      <span className="home-pending-dt-narrow">TP</span>
                    </dt>
                    <dd className={`metric-number${takeProfit.unset ? " is-unset" : ""}`}>{takeProfit.text}</dd>
                  </div>
                </dl>
                {timingNote ? <p className="home-pending-note is-muted">{timingNote}</p> : null}
              </Link>
              <button
                type="button"
                className="home-pending-cancel pressable"
                disabled={!canCancel || cancelling}
                onClick={() => onCancel(entry)}
                aria-label={`Remove waiting order for ${displayNameFor(entry.instrument)}`}
              >
                <X className="size-3.5" aria-hidden="true" />
                {cancelling ? "Removing…" : canCancel ? "Remove order" : "Processing"}
              </button>
            </div>
          );
        })}
      </div>
      {error ? <p className="home-pending-error" role="status">{error}</p> : null}
    </section>
  );
}
