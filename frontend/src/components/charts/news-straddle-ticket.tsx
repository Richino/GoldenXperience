"use client";

import { useEffect, useState } from "react";
import { pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";
import { BrokerNewsStraddleTicket, BrokerNewsSetupStatus, type BrokerNewsTicketProps } from "./news-straddle-v3-ticket";

export function NewsStraddleTicket(props: BrokerNewsTicketProps) {
  return <BrokerNewsStraddleTicket {...props} />;
}

export function NewsSetupStatus(props: { entry: PendingManualEntry; bid: number | null; ask: number | null }) {
  return props.entry.metadata.configVersion === 3 ? <BrokerNewsSetupStatus {...props} /> : <LegacyNewsSetupStatus {...props} />;
}

const STATE_WORDS: Record<string, string> = {
  ARMED: "Armed · zones follow the price until the lock",
  LOCKING: "Locking · waiting for a valid OANDA price",
  ZONES_LOCKED: "Zones locked · entries open at the release",
  WATCHING: "Live · watching both zones",
  TRIGGER_RESERVED: "Zone touched · order pending",
  ORDER_SUBMITTING: "Order pending at OANDA",
  ORDER_UNKNOWN: "Order unconfirmed · checking with OANDA by its id",
  ORDER_REJECTED: "Not filled",
  FILLED: "Filled · trade open",
  CLOSING: "Closing at market (time exit)",
  CLOSED: "Closed",
  EXPIRED: "Expired · no zone touched",
  SKIPPED: "Skipped",
  CANCELLED: "Cancelled",
  ERROR: "Needs attention",
};

type SetupMeta = {
  newsState?: string;
  release?: { title?: string; currency?: string | null; time?: string } | null;
  lockAt?: string;
  zones?: { buy: { lower: number; upper: number }; sell: { lower: number; upper: number } } | null;
  anchor?: number | null;
  distancePips?: number;
  slippagePips?: number;
  spreadCapPips?: number;
  stopPips?: number;
  targetPips?: number;
  closeAfterMinutes?: number;
  reservation?: { side?: "long" | "short"; priceBound?: number } | null;
  fillPrice?: number;
  slippageVsQuotePips?: number;
  spreadAtFillPips?: number | null;
  timeExitAt?: string | null;
  stopConfirmed?: number | null;
  targetConfirmed?: number | null;
  exitReason?: string;
  exitPrice?: number | null;
  realizedPL?: number | null;
  resultR?: number | null;
  timeline?: Array<{ at: string; to?: string; note?: string; reason?: string }>;
};

/**
 * A News setup's live status, read from the server's state (never assumed
 * locally): release with time zone, time to lock and release, the zones,
 * the order or trade, and the timeline of state changes.
 */
function LegacyNewsSetupStatus({ entry, bid, ask }: { entry: PendingManualEntry; bid: number | null; ask: number | null }) {
  const meta = (entry.metadata ?? {}) as SetupMeta;
  const precision = precisionFor(entry.instrument);
  const pip = pipSizeFor(entry.instrument);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock only exists in the browser
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const state = meta.newsState ?? "ARMED";
  const fmt = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(precision));
  const releaseAt = meta.release?.time ? Date.parse(meta.release.time) : null;
  const lockAt = meta.lockAt ? Date.parse(meta.lockAt) : null;
  const zone = (side: "buy" | "sell") => {
    if (meta.zones) return `${fmt(meta.zones[side].lower)} – ${fmt(meta.zones[side].upper)}`;
    return `${meta.distancePips}–${(meta.distancePips ?? 0) + (meta.slippagePips ?? 0)} pips ${side === "buy" ? "above" : "below"} the price at the lock`;
  };
  const spreadPips = bid !== null && ask !== null ? (ask - bid) / pip : null;
  const live = ["ARMED", "LOCKING", "ZONES_LOCKED", "WATCHING"].includes(state);
  const side = meta.reservation?.side ?? (entry.status === "TRIGGERING" || entry.status === "TRIGGERED" ? entry.direction : null);
  const headline = state === "ORDER_REJECTED" || state === "SKIPPED" || state === "ERROR"
    ? `${STATE_WORDS[state]}${entry.failureReason ? ` · ${entry.failureReason.replace(/^(Skipped|Not filled): /, "")}` : ""}`
    : state === "CLOSED"
      ? `Closed · ${meta.exitReason ?? "closed"}${typeof meta.resultR === "number" ? ` · ${meta.resultR >= 0 ? "+" : ""}${meta.resultR.toFixed(2)}R` : ""}`
      : STATE_WORDS[state] ?? state;
  return (
    <div className="nl-pe-news-status">
      <p className={`pending-entry-status is-news-${state.toLowerCase()}`}>{headline}</p>
      <dl>
        {meta.release?.time ? (
          <div><dt>Release</dt><dd>{meta.release.currency} {meta.release.title} · {new Date(meta.release.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}</dd></div>
        ) : null}
        {now !== null && lockAt !== null && (state === "ARMED" || state === "LOCKING") ? <div><dt>Zones lock in</dt><dd className="metric-number">{countdownText(lockAt - now)}</dd></div> : null}
        {now !== null && releaseAt !== null && live && releaseAt > now ? <div><dt>Release in</dt><dd className="metric-number">{countdownText(releaseAt - now)}</dd></div> : null}
        {now !== null && state === "WATCHING" && entry.expiresAt ? <div><dt>Watching for</dt><dd className="metric-number">{countdownText(Date.parse(entry.expiresAt) - now)}</dd></div> : null}
        {live ? <div><dt>BUY zone (ask)</dt><dd className="metric-number is-up">{zone("buy")}</dd></div> : null}
        {live ? <div><dt>SELL zone (bid)</dt><dd className="metric-number is-down">{zone("sell")}</dd></div> : null}
        {meta.anchor != null && meta.zones ? <div><dt>Anchor</dt><dd className="metric-number">{fmt(meta.anchor)} (mid at the lock)</dd></div> : null}
        {live ? <div><dt>Spread now</dt><dd className={`metric-number${spreadPips !== null && meta.spreadCapPips !== undefined && spreadPips > meta.spreadCapPips ? " is-caution" : ""}`}>{spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips (cap ${meta.spreadCapPips})`}</dd></div> : null}
        {side ? <div><dt>Side</dt><dd>{side === "long" ? "BUY" : "SELL"}{meta.reservation?.priceBound !== undefined ? ` · fills no worse than ${fmt(meta.reservation.priceBound)}` : ""}</dd></div> : null}
        {meta.fillPrice !== undefined ? <div><dt>Fill</dt><dd className="metric-number">{fmt(meta.fillPrice)} · {typeof meta.slippageVsQuotePips === "number" ? `${meta.slippageVsQuotePips >= 0 ? "+" : ""}${meta.slippageVsQuotePips}p slip` : ""}{typeof meta.spreadAtFillPips === "number" ? ` · spread ${meta.spreadAtFillPips}p` : ""}</dd></div> : null}
        {meta.fillPrice !== undefined ? <div><dt>Stop · target</dt><dd className="metric-number">{fmt(meta.stopConfirmed ?? entry.stopPrice)} · {meta.targetConfirmed != null ? fmt(meta.targetConfirmed) : "target not confirmed"}</dd></div> : null}
        {now !== null && state === "FILLED" && meta.timeExitAt ? <div><dt>Time exit in</dt><dd className="metric-number">{countdownText(Date.parse(meta.timeExitAt) - now)}</dd></div> : null}
        {state === "CLOSED" && meta.exitPrice != null ? <div><dt>Exit</dt><dd className="metric-number">{fmt(meta.exitPrice)}{typeof meta.realizedPL === "number" ? ` · P/L ${meta.realizedPL >= 0 ? "+" : ""}${meta.realizedPL.toFixed(2)}` : ""}</dd></div> : null}
        {!meta.fillPrice ? <div><dt>From the fill</dt><dd>stop {meta.stopPips}p · target {meta.targetPips}p{meta.closeAfterMinutes ? ` · closes after ${meta.closeAfterMinutes}m` : ""}</dd></div> : null}
      </dl>
      {live ? <p className="nl-pe-news-note">These settings are fixed while armed. To change them, cancel and arm a new setup. Cancelling cancels both zones.</p> : null}
      {meta.timeline?.length ? (
        <ol className="nl-pe-news-timeline" aria-label="Setup history">
          {meta.timeline.slice(-6).map((step, index) => (
            <li key={`${step.at}-${index}`}>
              <time>{new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              {" "}{step.to ? STATE_WORDS[step.to]?.split(" · ")[0] ?? step.to : step.note ?? "note"}{step.reason ? ` · ${step.reason}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function countdownText(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
