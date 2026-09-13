"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";

function expirationLabel(expiresAt: string | null) {
  if (!expiresAt) return "No expiration";
  const remaining = Date.parse(expiresAt) - Date.now();
  if (remaining <= 0) return "Expiring";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

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
  if (!entries.length) return null;

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
          return (
            <div key={entry.id} className={`home-pending-row is-${entry.direction}`}>
              <Link href={`/chart?instrument=${entry.instrument}`} className="home-pending-link">
                <span className="home-pending-ident">
                  <strong>{displayNameFor(entry.instrument)}</strong>
                  <span className={`home-side is-${entry.direction}`}>{entry.direction.toUpperCase()}</span>
                  <span className="home-pending-order">{entry.entryOrderType.replace("_", " ")}</span>
                </span>
                <dl>
                  <div>
                    <dt>Entry</dt>
                    <dd className="metric-number">{formatChartPrice(entry.entryPrice, entry.instrument)}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{expirationLabel(entry.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>Cancel at</dt>
                    <dd className="metric-number">{entry.invalidationPrice === null ? "None" : formatChartPrice(entry.invalidationPrice, entry.instrument)}</dd>
                  </div>
                </dl>
              </Link>
              <button
                type="button"
                className="home-pending-cancel pressable"
                disabled={!canCancel || cancelling}
                onClick={() => onCancel(entry)}
                aria-label={`Cancel ${displayNameFor(entry.instrument)} ${entry.direction} pending trade`}
              >
                <X className="size-3.5" aria-hidden="true" />
                {cancelling ? "Cancelling…" : canCancel ? "Cancel" : "Processing"}
              </button>
            </div>
          );
        })}
      </div>
      {error ? <p className="home-pending-error" role="status">{error}</p> : null}
    </section>
  );
}
