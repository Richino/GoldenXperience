"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";
import type { NewsDraft } from "@/lib/news/news-zone-overlay";
import type { PendingManualEntry } from "@/types/pending-entry";

/**
 * News mode of the trade ticket, in two phases:
 *  1. Is there a release for this pair in the next 5 hours? If not, nothing to set up.
 *  2. The anchor is always the live price — taken one minute before the
 *     release (or now, when it is under a minute away). A buy zone sits
 *     `distance` pips above it and a sell zone the same below, each `depth`
 *     pips deep. Price entering a zone sends one market order that way (the
 *     server watches every tick) and drops the other side; the order fills
 *     only inside the zone, never further.
 */

const LOOKAHEAD_MS = 5 * 60 * 60_000;
const ANCHOR_LEAD_MS = 60_000;
const WATCH_CHOICES = [5, 15, 30, 60] as const;
const CLOSE_CHOICES = [0, 5, 15, 30] as const;

function minutesLabel(minutes: number) {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

function until(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function NewsStraddleTicket({
  header,
  instrument,
  bid,
  ask,
  creationBlocked,
  onCancel,
  onArmed,
  onDraft,
}: {
  /** The ticket's Normal / News switch, shown first in the scrolling body. */
  header: ReactNode;
  instrument: string;
  bid: number | null;
  ask: number | null;
  creationBlocked: boolean;
  onCancel: () => void;
  onArmed: (message: string) => void;
  /** The unsaved zone settings, for the chart's DRAFT preview (null when the ticket closes). */
  onDraft?: (draft: NewsDraft | null) => void;
}) {
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const { base, quote } = currenciesOf(instrument);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const spreadPips = bid !== null && ask !== null ? Math.max(0, (ask - bid) / pip) : null;

  const [distance, setDistance] = useState("10");
  const [depth, setDepth] = useState("3");
  const [spreadCap, setSpreadCap] = useState("8");
  const [stopPips, setStopPips] = useState("");
  const [targetPips, setTargetPips] = useState("");
  const [watchMinutes, setWatchMinutes] = useState<number>(15);
  const [closeAfter, setCloseAfter] = useState<number>(15);
  const [pickedRelease, setPickedRelease] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Phase 1: this pair's releases in the next 5 hours.
  const { snapshot: calendar, loading: calendarLoading } = useEconomicCalendar();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock only exists in the browser
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const releases = useMemo(() => {
    // Offline, the hook serves placeholder events; never offer those as releases.
    if (now === null || !calendar.connected) return [];
    return calendar.events
      .filter((event) => event.currency === base || event.currency === quote)
      .filter((event) => {
        const time = Date.parse(event.timestamp);
        return time > now && time <= now + LOOKAHEAD_MS;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }, [base, calendar.connected, calendar.events, now, quote]);
  // The soonest release unless another was picked.
  const release = releases.find((event) => event.id === pickedRelease) ?? releases[0] ?? null;
  const releaseAt = release ? Date.parse(release.timestamp) : null;
  const anchorAt = releaseAt !== null && now !== null && releaseAt - ANCHOR_LEAD_MS > now ? releaseAt - ANCHOR_LEAD_MS : null;
  const watchUntil = releaseAt !== null && now !== null ? Math.max(releaseAt, now) + watchMinutes * 60_000 : null;

  // Zones around the live price (the server takes the anchor itself).
  const distanceNumber = Number(distance), depthNumber = Number(depth), capNumber = Number(spreadCap);
  const stopNumber = Number(stopPips), targetNumber = Number(targetPips);
  const zonesValid = mid !== null && distanceNumber > 0 && depthNumber > 0;
  const upper = zonesValid ? mid! + distanceNumber * pip : null;
  const lower = zonesValid ? mid! - distanceNumber * pip : null;
  const ratio = stopNumber > 0 && targetNumber > 0 ? targetNumber / stopNumber : null;
  const spreadOverCap = spreadPips !== null && capNumber > 0 && spreadPips > capNumber;
  const spreadOverDepth = spreadPips !== null && depthNumber > 0 && spreadPips > depthNumber;

  // What each side would be sized to (same stop distance, so one size),
  // keyed on a coarse entry so the live price does not refetch every tick.
  const sizeEntry = upper === null ? null : Number(upper.toFixed(Math.max(0, precision - 2)));
  const sizeKey = sizeEntry !== null && stopNumber > 0 ? `${instrument}|${sizeEntry}|${(sizeEntry - stopNumber * pip).toFixed(precision)}` : null;
  const [size, setSize] = useState<{ key: string; lots: number; riskAmount: number; riskPercent: number } | null>(null);
  useEffect(() => {
    if (!sizeKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const [, entry, stop] = sizeKey.split("|");
      fetch(apiUrl(`/api/pending-entries/size?instrument=${instrument}&entry=${entry}&stop=${stop}`), { credentials: "include", cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { lots?: number; riskAmount?: number; riskPercent?: number } | null) => {
          if (cancelled || !payload || typeof payload.lots !== "number") return;
          setSize({ key: sizeKey, lots: payload.lots, riskAmount: payload.riskAmount ?? 0, riskPercent: payload.riskPercent ?? 0 });
        })
        .catch(() => undefined);
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [instrument, sizeKey]);
  const currentSize = size && size.key === sizeKey ? size : null;

  // Show the unsaved zones on the chart while the ticket is open.
  useEffect(() => {
    if (!onDraft) return;
    onDraft(distanceNumber > 0 && depthNumber > 0 ? { distancePips: distanceNumber, depthPips: depthNumber } : null);
  }, [depthNumber, distanceNumber, onDraft]);
  useEffect(() => () => onDraft?.(null), [onDraft]);

  async function arm() {
    setError(null);
    if (creationBlocked) return setError("This pair already has an active position. Close it before arming a news setup.");
    if (!release) return setError(`No ${base} or ${quote} news in the next 5 hours.`);
    if (!zonesValid) return setError("Enter a zone distance and depth, and wait for a live price.");
    if (!(stopNumber > 0) || !(targetNumber > 0)) return setError("Enter a stop and a target in pips.");
    setSaving(true);
    try {
      const response = await fetch(apiUrl("/api/pending-entries/news"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          distancePips: distanceNumber,
          slippagePips: depthNumber,
          spreadCapPips: capNumber,
          stopPips: stopNumber,
          targetPips: targetNumber,
          armedMinutes: watchMinutes,
          closeAfterMinutes: closeAfter,
          release: { id: release.id, title: release.title, currency: release.currency, time: release.timestamp },
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not arm the news setup.");
      onArmed(anchorAt ? `News setup armed · zones set at ${timeOf(anchorAt)}` : "News setup armed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not arm the news setup.");
    } finally {
      setSaving(false);
    }
  }

  const fmt = (value: number | null) => (value === null || !Number.isFinite(value) ? "—" : value.toFixed(precision));
  const phaseOneMessage = calendarLoading && !calendar.connected
    ? `Checking the calendar for ${base} and ${quote} news…`
    : !calendar.connected
      ? "The economic calendar can't be read right now, so there's no release to set up for. Try again shortly."
      : !releases.length
        ? `No ${base} or ${quote} news in the next 5 hours. News mode sets up only ahead of a release.`
        : null;

  return (
    <>
      <div className="nl-pe-plan nl-pe-ticket">
        {header}
        {phaseOneMessage ? (
          <p className="nl-pe-news-empty" role="status">{phaseOneMessage}</p>
        ) : (
          <>
            <div className="nl-pe-submit">
              <span>Release</span>
              <select
                className="nl-pe-release"
                value={release?.id ?? ""}
                onChange={(event) => setPickedRelease(event.target.value)}
                aria-label="Release this setup is for"
              >
                {releases.map((event) => (
                  <option key={event.id} value={event.id}>
                    {timeOf(Date.parse(event.timestamp))} · {event.currency} {event.title}{event.impact >= 3 ? " (high)" : event.impact <= 1 ? " (low)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <dl className="nl-an-rows">
              {releaseAt !== null && now !== null ? (
                <div>
                  <dt>Release</dt>
                  <dd>{new Date(releaseAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })} · in {until(releaseAt - now)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Anchor</dt>
                <dd>{anchorAt ? `live price at ${timeOf(anchorAt)} (in ${until(anchorAt - (now ?? 0))})` : "live price now"}</dd>
              </div>
              <div>
                <dt>Buy zone</dt>
                <dd className="metric-number is-up">{upper === null ? "—" : `${fmt(upper)} – ${fmt(upper + depthNumber * pip)}`}</dd>
              </div>
              <div>
                <dt>Sell zone</dt>
                <dd className="metric-number is-down">{lower === null ? "—" : `${fmt(lower)} – ${fmt(lower - depthNumber * pip)}`}</dd>
              </div>
            </dl>
            {anchorAt ? <p className="nl-pe-news-note">Zones shown around the price now; they move with it until {timeOf(anchorAt)}, then stay put.</p> : null}

            <div className="nl-pe-levels">
              <label>
                <span>Distance · pips</span>
                <input className="metric-number" inputMode="decimal" value={distance} onChange={(event) => setDistance(event.target.value)} placeholder="10" aria-label="Zone distance in pips from the anchor" />
                <small className="nl-pe-hint">from the anchor</small>
              </label>
              <label>
                <span>Zone depth · pips</span>
                <input className="metric-number" inputMode="decimal" value={depth} onChange={(event) => setDepth(event.target.value)} placeholder="3" aria-label="Zone depth in pips" />
                <small className="nl-pe-hint">fills only inside</small>
              </label>
              <label>
                <span>Spread cap · pips</span>
                <input className="metric-number" inputMode="decimal" value={spreadCap} onChange={(event) => setSpreadCap(event.target.value)} placeholder="8" aria-label="Spread cap in pips" />
                <small className="nl-pe-hint">waits while wider</small>
              </label>
            </div>

            <div className="nl-pe-levels is-two">
              <label>
                <span>Stop · pips</span>
                <input className="metric-number is-down" inputMode="decimal" value={stopPips} onChange={(event) => setStopPips(event.target.value)} placeholder="e.g. 15" aria-label="Stop loss in pips from the fill" />
                <small className="nl-pe-hint">from the fill</small>
              </label>
              <label>
                <span>Target · pips</span>
                <input className="metric-number is-up" inputMode="decimal" value={targetPips} onChange={(event) => setTargetPips(event.target.value)} placeholder="e.g. 30" aria-label="Take profit in pips from the fill" />
                <small className="nl-pe-hint">{ratio === null ? "from the fill" : `from the fill · 1:${Number(ratio.toFixed(1))}`}</small>
              </label>
            </div>

            <div className="nl-pe-submit">
              <span>Watch after release</span>
              <div className="nl-an-modes" role="radiogroup" aria-label="How long it watches after the release">
                {WATCH_CHOICES.map((minutes) => (
                  <button key={minutes} type="button" role="radio" aria-checked={watchMinutes === minutes} className={watchMinutes === minutes ? "is-active" : ""} onClick={() => setWatchMinutes(minutes)}>
                    {minutesLabel(minutes)}
                  </button>
                ))}
              </div>
            </div>

            <div className="nl-pe-submit">
              <span>Close after</span>
              <div className="nl-an-modes" role="radiogroup" aria-label="Close the trade at market after">
                {CLOSE_CHOICES.map((minutes) => (
                  <button key={minutes} type="button" role="radio" aria-checked={closeAfter === minutes} className={closeAfter === minutes ? "is-active" : ""} onClick={() => setCloseAfter(minutes)}>
                    {minutes === 0 ? "Off" : minutesLabel(minutes)}
                  </button>
                ))}
              </div>
            </div>

            <dl className="nl-an-rows">
              <div>
                <dt>Spread now</dt>
                <dd className={`metric-number${spreadOverCap || spreadOverDepth ? " is-caution" : ""}`}>
                  {spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips${spreadOverCap ? " · over your cap" : spreadOverDepth ? " · wider than the zone" : ""}`}
                </dd>
              </div>
              <div>
                <dt>Size (either side)</dt>
                <dd className="metric-number">
                  {!sizeKey ? "—" : currentSize ? `${currentSize.lots.toFixed(2)} lots · risks $${currentSize.riskAmount.toFixed(0)} (${currentSize.riskPercent}%)` : "Sizing…"}
                </dd>
              </div>
              <div><dt>Watches until</dt><dd>{watchUntil === null ? "—" : timeOf(watchUntil)}</dd></div>
              <div><dt>Account</dt><dd>OANDA practice</dd></div>
            </dl>

            <p className="nl-pe-news-note">
              The server watches every price tick. The moment price enters a zone, GX sends one market order that way and drops the other zone. It fills only inside the zone; if price has already jumped past it, nothing opens and you are told. Spreads often widen several-fold in the seconds after a release; the spread and slippage you got are in the fill notification.
            </p>
          </>
        )}

        {error ? <p className="nl-pe-error" role="alert">{error}</p> : null}
      </div>
      <footer className="nl-an-actions is-card nl-pe-actions">
        <button type="button" className="nl-an-secondary pressable" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="nl-an-primary pressable"
          disabled={saving || creationBlocked || !release || !zonesValid || !(stopNumber > 0) || !(targetNumber > 0)}
          onClick={() => void arm()}
        >
          {saving ? "Arming…" : "Arm news setup"}
        </button>
      </footer>
    </>
  );
}


/** Plain words for each server state of a News setup. */
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
export function NewsSetupStatus({ entry, bid, ask }: { entry: PendingManualEntry; bid: number | null; ask: number | null }) {
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
