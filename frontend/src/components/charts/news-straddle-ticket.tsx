"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/api/url";
import { currenciesOf, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import { useEconomicCalendar } from "@/lib/oanda/use-economic-calendar";

/**
 * News mode of the trade ticket: a two-line breakout for the first minutes
 * after a release. A buy line sits `distance` pips above the anchor and a
 * sell line the same below; the server watches live OANDA prices and the
 * first line crossed sends ONE market order that way and drops the other.
 * The order fills only within the max slippage past the line, and its stop
 * and target are measured from the actual fill.
 */

const ARMED_CHOICES = [5, 15, 30, 60] as const;
const CLOSE_CHOICES = [0, 5, 15, 30] as const;

function minutesLabel(minutes: number) {
  return minutes < 60 ? `${minutes}m` : `${minutes / 60}h`;
}

function until(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m`;
  return `${Math.floor(Math.abs(minutes) / 60)}h ${Math.abs(minutes) % 60}m`;
}

export function NewsStraddleTicket({
  header,
  instrument,
  bid,
  ask,
  creationBlocked,
  onCancel,
  onArmed,
}: {
  /** The ticket's Normal / News switch, shown first in the scrolling body. */
  header: ReactNode;
  instrument: string;
  bid: number | null;
  ask: number | null;
  creationBlocked: boolean;
  onCancel: () => void;
  onArmed: (message: string) => void;
}) {
  const pip = pipSizeFor(instrument);
  const precision = precisionFor(instrument);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const spreadPips = bid !== null && ask !== null ? Math.max(0, (ask - bid) / pip) : null;

  const [anchorText, setAnchorText] = useState("");
  const [distance, setDistance] = useState("10");
  const [stopPips, setStopPips] = useState("");
  const [targetPips, setTargetPips] = useState("");
  const [slippage, setSlippage] = useState("3");
  const [spreadCap, setSpreadCap] = useState("8");
  const [armedMinutes, setArmedMinutes] = useState<number>(15);
  const [closeAfter, setCloseAfter] = useState<number>(15);
  const [releaseId, setReleaseId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Blank anchor follows the live mid until armed; the server re-reads it then.
  const anchor = anchorText.trim() ? Number(anchorText) : mid;
  const distanceNumber = Number(distance);
  const linesValid = anchor !== null && Number.isFinite(anchor) && anchor > 0 && Number.isFinite(distanceNumber) && distanceNumber > 0;
  const upper = linesValid ? anchor! + distanceNumber * pip : null;
  const lower = linesValid ? anchor! - distanceNumber * pip : null;
  const stopNumber = Number(stopPips), targetNumber = Number(targetPips), slipNumber = Number(slippage), capNumber = Number(spreadCap);
  const ratio = stopNumber > 0 && targetNumber > 0 ? targetNumber / stopNumber : null;
  const spreadOverCap = spreadPips !== null && capNumber > 0 && spreadPips > capNumber;

  // Upcoming releases for either currency of the pair, next 24 hours.
  const { snapshot: calendar, loading: calendarLoading } = useEconomicCalendar();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock only exists in the browser
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const releases = useMemo(() => {
    // Offline, the hook serves placeholder events; never offer those as releases.
    if (now === null || !calendar.connected) return [];
    const { base, quote } = currenciesOf(instrument);
    return calendar.events
      .filter((event) => (event.currency === base || event.currency === quote) && event.impact >= 2)
      .filter((event) => {
        const time = Date.parse(event.timestamp);
        return time > now - 10 * 60_000 && time < now + 24 * 60 * 60_000;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(0, 12);
  }, [calendar.connected, calendar.events, instrument, now]);
  const release = releases.find((event) => event.id === releaseId) ?? null;
  const releaseIn = release && now !== null ? Date.parse(release.timestamp) - now : null;
  const windowMissesRelease = releaseIn !== null && releaseIn > armedMinutes * 60_000;

  // What each side would be sized to (same stop distance, so one size).
  // Keyed on a coarse entry so a live-following anchor does not refetch every tick.
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

  async function arm() {
    setError(null);
    if (creationBlocked) return setError("This pair already has an active position. Close it before arming a news setup.");
    if (!linesValid || upper === null || lower === null) return setError("Enter a distance and wait for a live price.");
    if (!(stopNumber > 0) || !(targetNumber > 0)) return setError("Enter a stop and a target in pips.");
    if (ask !== null && ask >= upper) return setError("Price is already at or above the buy line. Move the anchor or widen the distance.");
    if (bid !== null && bid <= lower) return setError("Price is already at or below the sell line. Move the anchor or widen the distance.");
    setSaving(true);
    try {
      const response = await fetch(apiUrl("/api/pending-entries/news"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument,
          anchor: anchorText.trim() ? Number(anchorText) : null,
          distancePips: distanceNumber,
          stopPips: stopNumber,
          targetPips: targetNumber,
          slippagePips: slipNumber,
          spreadCapPips: capNumber,
          armedMinutes,
          closeAfterMinutes: closeAfter,
          release: release ? { id: release.id, title: release.title, currency: release.currency, time: release.timestamp } : null,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not arm the news setup.");
      onArmed("News setup armed");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not arm the news setup.");
    } finally {
      setSaving(false);
    }
  }

  const fmt = (value: number | null) => (value === null || !Number.isFinite(value) ? "—" : value.toFixed(precision));

  return (
    <>
      <div className="nl-pe-plan nl-pe-ticket">
        {header}
        <p className="nl-an-regime">
          Buy above <b className="metric-number">{fmt(upper)}</b> · sell below <b className="metric-number">{fmt(lower)}</b>
          {mid === null ? " · waiting for quote" : ` · now ${mid.toFixed(precision)}`}
        </p>

        <div className="nl-pe-levels">
          <label>
            <span>Lines · pips</span>
            <input className="metric-number" inputMode="decimal" value={distance} onChange={(event) => setDistance(event.target.value)} placeholder="10" aria-label="Line distance in pips from the anchor" />
            <small className="nl-pe-hint">each side</small>
          </label>
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

        <div className="nl-pe-levels">
          <label>
            <span>Anchor</span>
            <input className="metric-number" inputMode="decimal" value={anchorText} onChange={(event) => setAnchorText(event.target.value)} placeholder={mid?.toFixed(precision) ?? "live mid"} aria-label="Anchor price (blank = live mid when armed)" />
            <small className="nl-pe-hint">{anchorText.trim() ? "your price" : "live mid"}</small>
          </label>
          <label>
            <span>Max slippage · pips</span>
            <input className="metric-number" inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value)} placeholder="3" aria-label="Max slippage in pips past the line" />
            <small className="nl-pe-hint">past the line</small>
          </label>
          <label>
            <span>Spread cap · pips</span>
            <input className="metric-number" inputMode="decimal" value={spreadCap} onChange={(event) => setSpreadCap(event.target.value)} placeholder="8" aria-label="Spread cap in pips" />
            <small className="nl-pe-hint">waits while wider</small>
          </label>
        </div>

        <div className="nl-pe-submit">
          <span>Release</span>
          <select
            className="nl-pe-release"
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            aria-label="Release this setup is for"
          >
            <option value="">{calendarLoading ? "Loading calendar…" : calendar.connected ? (releases.length ? "None picked" : "No releases in the next 24h") : "Calendar unavailable"}</option>
            {releases.map((event) => (
              <option key={event.id} value={event.id}>
                {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {event.currency} {event.title}{event.impact >= 3 ? " (high)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="nl-pe-submit">
          <span>Armed for</span>
          <div className="nl-an-modes" role="radiogroup" aria-label="How long the setup stays armed">
            {ARMED_CHOICES.map((minutes) => (
              <button key={minutes} type="button" role="radio" aria-checked={armedMinutes === minutes} className={armedMinutes === minutes ? "is-active" : ""} onClick={() => setArmedMinutes(minutes)}>
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
            <dd className={`metric-number${spreadOverCap ? " is-caution" : ""}`}>
              {spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips${spreadOverCap ? " · over your cap" : ""}`}
            </dd>
          </div>
          <div>
            <dt>Size (either side)</dt>
            <dd className="metric-number">
              {!sizeKey ? "—" : currentSize ? `${currentSize.lots.toFixed(2)} lots · risks $${currentSize.riskAmount.toFixed(0)} (${currentSize.riskPercent}%)` : "Sizing…"}
            </dd>
          </div>
          {release && releaseIn !== null ? (
            <div>
              <dt>Release</dt>
              <dd className={windowMissesRelease ? "is-caution" : undefined}>
                {releaseIn >= 0 ? `in ${until(releaseIn)}` : `${until(releaseIn)} ago`}
                {windowMissesRelease ? " · after the armed window ends" : ""}
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Fills only within</dt>
            <dd className="metric-number">{upper === null || lower === null || !(slipNumber >= 0) ? "—" : `buy ≤ ${fmt(upper + slipNumber * pip)} · sell ≥ ${fmt(lower - slipNumber * pip)}`}</dd>
          </div>
          <div><dt>Account</dt><dd>OANDA practice</dd></div>
        </dl>

        <p className="nl-pe-news-note">
          When price crosses a line, GX sends one market order that way and drops the other line. It fills only up to {slipNumber >= 0 ? slipNumber : "—"} pips past the line; if price has already run further, nothing opens and you are told. Spreads often widen several-fold in the seconds after a release; the spread and slippage you got are in the fill notification.
        </p>

        {error ? <p className="nl-pe-error" role="alert">{error}</p> : null}
      </div>
      <footer className="nl-an-actions is-card nl-pe-actions">
        <button type="button" className="nl-an-secondary pressable" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="nl-an-primary pressable"
          disabled={saving || creationBlocked || !linesValid || !(stopNumber > 0) || !(targetNumber > 0)}
          onClick={() => void arm()}
        >
          {saving ? "Arming…" : "Arm news setup"}
        </button>
      </footer>
    </>
  );
}
