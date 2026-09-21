"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";

type ExpirationPreset = "none" | "30m" | "1h" | "4h" | "custom";

function localDateTimeValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function expirationFromPreset(preset: ExpirationPreset, custom: string) {
  if (preset === "none") return null;
  if (preset === "custom") return custom ? new Date(custom).toISOString() : null;
  const durations = { "30m": 30, "1h": 60, "4h": 240 } as const;
  return new Date(Date.now() + durations[preset] * 60_000).toISOString();
}

function remainingLabel(expiresAt: string | null) {
  if (!expiresAt) return "No expiration";
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return "Expired";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m remaining`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m remaining`;
}

/** Split an ISO/local value into native <input type="date"> and type="time" values. */
function splitLocal(value: string | null) {
  const local = localDateTimeValue(value); // "YYYY-MM-DDTHH:MM" or ""
  const [date = "", time = ""] = local.split("T");
  return { date, time };
}

/** Combine a native date (YYYY-MM-DD) and time (HH:MM) into an ISO string, or null. */
function combineLocalToIso(dateStr: string, timeStr: string) {
  if (!dateStr || !timeStr) return null;
  const parsed = new Date(`${dateStr}T${timeStr}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Today's local date as YYYY-MM-DD, for the date picker's `min`. */
function todayLocalDate() {
  return splitLocal(new Date().toISOString()).date;
}

export function PendingEntryDialog({
  open,
  layout = "dialog",
  instrument,
  bid,
  ask,
  selectedEntry,
  initialProposal = null,
  creationBlocked = false,
  onClose,
  onChanged,
}: {
  open: boolean;
  layout?: "dialog" | "panel";
  instrument: string;
  bid: number | null;
  ask: number | null;
  selectedEntry: PendingManualEntry | null;
  initialProposal?: { direction: "long" | "short"; entry: number; stop: number; target: number; confidence: number | null; rationale: string; preferredEntryTime: string } | null;
  creationBlocked?: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const isPanel = layout === "panel";
  const [editing, setEditing] = useState(false);
  const [direction, setDirection] = useState<"long" | "short">(selectedEntry?.direction ?? initialProposal?.direction ?? "long");
  const [orderReferencePrice, setOrderReferencePrice] = useState<number | null>(() => {
    const initialDirection = selectedEntry?.direction ?? initialProposal?.direction ?? "long";
    return initialDirection === "long" ? ask : bid;
  });
  const [entryPrice, setEntryPrice] = useState(selectedEntry ? String(selectedEntry.entryPrice) : initialProposal ? initialProposal.entry.toFixed(precisionFor(instrument)) : "");
  const [stopPrice, setStopPrice] = useState(selectedEntry?.stopPrice == null ? (initialProposal ? initialProposal.stop.toFixed(precisionFor(instrument)) : "") : String(selectedEntry.stopPrice));
  const [targetPrice, setTargetPrice] = useState(selectedEntry?.targetPrice == null ? (initialProposal ? initialProposal.target.toFixed(precisionFor(instrument)) : "") : String(selectedEntry.targetPrice));
  const [invalidationPrice, setInvalidationPrice] = useState(selectedEntry?.invalidationPrice == null ? "" : String(selectedEntry.invalidationPrice));
  const [activateAt, setActivateAt] = useState(localDateTimeValue(selectedEntry?.activateAt ?? null));
  const [activatePickerOpen, setActivatePickerOpen] = useState(false);
  const initialActivateFields = splitLocal(selectedEntry?.activateAt ?? null);
  const [activateDate, setActivateDate] = useState(initialActivateFields.date);
  const [activateTime, setActivateTime] = useState(initialActivateFields.time);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [expiration, setExpiration] = useState<ExpirationPreset>(selectedEntry?.expiresAt ? "custom" : "none");
  const [customExpiration, setCustomExpiration] = useState(localDateTimeValue(selectedEntry?.expiresAt ?? null));
  const [customExpirationPickerOpen, setCustomExpirationPickerOpen] = useState(false);
  const initialExpirationFields = splitLocal(selectedEntry?.expiresAt ?? null);
  const [customDate, setCustomDate] = useState(initialExpirationFields.date);
  const [customTime, setCustomTime] = useState(initialExpirationFields.time);
  const [customExpirationError, setCustomExpirationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || isPanel) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    // The chart is a fixed workspace. Do not let an iOS input-reveal scroll be
    // captured as a negative body offset when this dialog applies its lock.
    const scrollY = 0;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    let touchStartY: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      if (touchStartY === null || currentY === undefined) return;
      // The scroll container is the form/detail body, not the dialog shell
      // (the dialog is overflow:hidden). Reading the dialog's scrollTop — which
      // is always 0 — made the handler treat every swipe as an at-edge
      // overscroll and preventDefault it, blocking all touch scrolling.
      const scroller = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".pending-entry-form, .pending-entry-detail")
        : null;
      if (!scroller) {
        event.preventDefault();
        return;
      }
      const delta = currentY - touchStartY;
      const atTop = scroller.scrollTop <= 0;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if ((atTop && delta > 0) || (atBottom && delta < 0)) event.preventDefault();
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.width = previousBodyWidth;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      window.scrollTo(0, scrollY);
    };
  }, [isPanel, onClose, open]);

  const current = direction === "long" ? ask : bid;
  const parsedEntry = entryPrice.trim() === "" ? Number.NaN : Number(entryPrice);
  const parsedInvalidation = invalidationPrice ? Number(invalidationPrice) : null;
  const parsedStop = stopPrice ? Number(stopPrice) : null;
  const parsedTarget = targetPrice ? Number(targetPrice) : null;
  const precision = precisionFor(instrument);
  const spreadPips = bid !== null && ask !== null
    ? Math.max(0, (ask - bid) / pipSizeFor(instrument))
    : null;
  const spreadIsWide = spreadPips !== null && spreadPips > 2;
  const distancePips = current !== null && Number.isFinite(parsedEntry)
    ? Math.abs(parsedEntry - current) / pipSizeFor(instrument)
    : null;
  const relative = current !== null && Number.isFinite(parsedEntry)
    ? parsedEntry >= current ? "above" : "below"
    : null;
  const inferredOrder = orderReferencePrice !== null && Number.isFinite(parsedEntry)
    ? direction === "long"
      ? parsedEntry >= orderReferencePrice ? "Buy stop" : "Buy limit"
      : parsedEntry <= orderReferencePrice ? "Sell stop" : "Sell limit"
    : null;
  const expiresAt = useMemo(
    () => expirationFromPreset(expiration, customExpiration),
    [customExpiration, expiration],
  );
  const isDetail = Boolean(selectedEntry && !editing);

  function resetDialogDocumentScroll() {
    if (isPanel) return;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    // iOS performs its reveal scroll after focus dispatches.
    window.requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
    });
  }

  function resetCreateForm() {
    const nextDirection = initialProposal?.direction ?? "long";
    setEditing(false);
    setDirection(nextDirection);
    setOrderReferencePrice(nextDirection === "long" ? ask : bid);
    setEntryPrice(initialProposal ? initialProposal.entry.toFixed(precision) : "");
    setStopPrice(initialProposal ? initialProposal.stop.toFixed(precision) : "");
    setTargetPrice(initialProposal ? initialProposal.target.toFixed(precision) : "");
    setInvalidationPrice("");
    setActivateAt("");
    setActivatePickerOpen(false);
    setActivateDate("");
    setActivateTime("");
    setActivateError(null);
    setExpiration("none");
    setCustomExpiration("");
    setCustomExpirationPickerOpen(false);
    setCustomDate("");
    setCustomTime("");
    setCustomExpirationError(null);
    setError(null);
  }

  function dismissCreateOrClose() {
    if (selectedEntry) {
      setEditing(false);
      return;
    }
    if (isPanel) {
      resetCreateForm();
      return;
    }
    onClose();
  }

  function openCustomExpirationPicker() {
    const fields = splitLocal(customExpiration || new Date(Date.now() + 60 * 60_000).toISOString());
    setCustomDate(fields.date);
    setCustomTime(fields.time);
    setCustomExpirationError(null);
    setExpiration("custom");
    setCustomExpirationPickerOpen(true);
  }

  function applyCustomExpiration() {
    const iso = combineLocalToIso(customDate, customTime);
    if (!iso) { setCustomExpirationError("Pick both a date and a time."); return; }
    if (Date.parse(iso) <= Date.now()) { setCustomExpirationError("Choose a date and time in the future."); return; }
    setCustomExpiration(localDateTimeValue(iso));
    setCustomExpirationPickerOpen(false);
  }

  function openActivatePicker() {
    const fields = splitLocal(activateAt || new Date(Date.now() + 30 * 60_000).toISOString());
    setActivateDate(fields.date);
    setActivateTime(fields.time);
    setActivateError(null);
    setActivatePickerOpen(true);
  }

  function applyActivate() {
    const iso = combineLocalToIso(activateDate, activateTime);
    if (!iso) { setActivateError("Pick both a date and a time."); return; }
    if (Date.parse(iso) <= Date.now()) { setActivateError("Choose a date and time in the future."); return; }
    setActivateAt(localDateTimeValue(iso));
    setActivatePickerOpen(false);
  }

  if (!open) return null;

  async function save() {
    setError(null);
    if (!selectedEntry && creationBlocked) {
      setError("This pair already has an active position. Close it before creating another entry.");
      return;
    }
    if (current === null) return setError("Wait for a fresh executable market quote.");
    if (!Number.isFinite(parsedEntry) || parsedEntry <= 0) return setError("Enter a valid entry price.");
    if (stopPrice && (!Number.isFinite(parsedStop) || (parsedStop ?? 0) <= 0)) return setError("Enter a valid stop price.");
    if (targetPrice && (!Number.isFinite(parsedTarget) || (parsedTarget ?? 0) <= 0)) return setError("Enter a valid target price.");
    if (invalidationPrice && (!Number.isFinite(parsedInvalidation) || (parsedInvalidation ?? 0) <= 0)) return setError("Enter a valid cancellation price.");
    // Stop and target must be supplied together and sit on the correct side of entry.
    if (Boolean(stopPrice.trim()) !== Boolean(targetPrice.trim())) return setError("Enter both a stop and a target, or leave both blank.");
    if (parsedStop !== null && parsedTarget !== null && Number.isFinite(parsedStop) && Number.isFinite(parsedTarget)) {
      const okSide = direction === "long"
        ? parsedStop < parsedEntry && parsedTarget > parsedEntry
        : parsedStop > parsedEntry && parsedTarget < parsedEntry;
      if (!okSide) return setError(direction === "long"
        ? "For a long: stop must be below entry, target above it."
        : "For a short: stop must be above entry, target below it.");
    }
    // Cancellation price cannot equal the entry or the current price.
    if (parsedInvalidation !== null && Number.isFinite(parsedInvalidation)) {
      if (Math.abs(parsedInvalidation - parsedEntry) < Number.EPSILON) return setError("Cancellation price must differ from the entry price.");
      if (current !== null && Math.abs(parsedInvalidation - current) < Number.EPSILON) return setError("Cancellation price is already reached.");
    }
    if (expiration === "custom" && (!expiresAt || Date.parse(expiresAt) <= Date.now())) return setError("Choose a custom expiration in the future.");
    // Blank, or within the next minute, means submit now. Otherwise it must be before any expiration.
    const activateAtIso = activateAt && Date.parse(activateAt) > Date.now() + 60_000 ? new Date(activateAt).toISOString() : null;
    if (activateAtIso && expiresAt && Date.parse(activateAtIso) >= Date.parse(expiresAt)) return setError("The submit-after time must be before the expiration.");
    setSaving(true);
    try {
      const response = await fetch(apiUrl(selectedEntry ? `/api/pending-entries/${selectedEntry.id}` : "/api/pending-entries"), {
        method: selectedEntry ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, direction, entryPrice: parsedEntry, stopPrice: parsedStop, targetPrice: parsedTarget, expiresAt, activateAt: activateAtIso, invalidationPrice: parsedInvalidation, orderReferencePrice }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save the pending entry.");
      onChanged(selectedEntry ? "Pending entry updated" : "Pending entry created");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the pending entry.");
    } finally {
      setSaving(false);
    }
  }

  async function cancelEntry() {
    if (!selectedEntry) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(`/api/pending-entries/${selectedEntry.id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not cancel the entry.");
      onChanged("Pending entry cancelled");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not cancel the entry.");
    } finally {
      setSaving(false);
    }
  }

  const headerEyebrow = isDetail
    ? selectedEntry?.status
    : selectedEntry
      ? "Edit pending entry"
      : isPanel
        ? "Add entry"
        : "Pending manual entry";

  const shell = (
    <section
      className={`pending-entry-dialog${isPanel ? " is-panel" : ""}${initialProposal ? " is-proposal" : ""}`}
      role={isPanel ? "region" : "dialog"}
      aria-modal={isPanel ? undefined : true}
      aria-labelledby={isPanel && !selectedEntry ? undefined : "pending-entry-title"}
      aria-label={isPanel && !selectedEntry ? "Add entry" : undefined}
      onFocusCapture={resetDialogDocumentScroll}
    >
      {isPanel && !selectedEntry ? null : (
        <header>
          <div>
            <span>{headerEyebrow}</span>
            <h2 id="pending-entry-title">{displayNameFor(instrument)}</h2>
          </div>
          <button
            type="button"
            className="mobile-sheet-close pressable"
            onClick={onClose}
            aria-label={isPanel ? "Back to new entry" : "Close pending entry"}
          >
            <X className="size-4" />
          </button>
        </header>
      )}

      {isDetail && selectedEntry ? (
        <>
          <div className="pending-entry-detail">
            <p className={`pending-entry-status is-${selectedEntry.status.toLowerCase()}`}>
              {selectedEntry.status === "PENDING" ? `Waiting for ${selectedEntry.entryPrice.toFixed(precision)}`
                : selectedEntry.status === "TRIGGERED" ? `Entry triggered at ${selectedEntry.triggerPrice?.toFixed(precision) ?? "—"}`
                  : selectedEntry.status === "INVALIDATED" ? `Setup cancelled at ${selectedEntry.invalidationPrice?.toFixed(precision) ?? "—"}`
                    : selectedEntry.status === "EXPIRED" ? "Entry expired"
                      : selectedEntry.status === "CANCELLED" ? "Entry cancelled"
                        : selectedEntry.status === "FAILED" ? selectedEntry.failureReason ?? "Entry failed" : "Entry is processing"}
            </p>
            <dl>
              <div><dt>Direction</dt><dd>{selectedEntry.direction.toUpperCase()}</dd></div>
              <div><dt>Order</dt><dd>{selectedEntry.entryOrderType.replace("_", " ").toUpperCase()}</dd></div>
              <div><dt>Entry</dt><dd>{selectedEntry.entryPrice.toFixed(precision)}</dd></div>
              <div><dt>Distance</dt><dd>{distancePips === null ? "—" : `${distancePips.toFixed(1)} pips`}</dd></div>
              <div><dt>Spread</dt><dd className={spreadIsWide ? "is-wide" : undefined}>{spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips${spreadIsWide ? " · Wide" : ""}`}</dd></div>
              {selectedEntry.activateAt ? <div><dt>Submits at</dt><dd>{new Date(selectedEntry.activateAt).toLocaleString()}</dd></div> : null}
              <div><dt>Expiration</dt><dd>{remainingLabel(selectedEntry.expiresAt)}</dd></div>
              <div><dt>Invalidation</dt><dd>{selectedEntry.invalidationPrice?.toFixed(precision) ?? "None"}</dd></div>
              <div><dt>Created</dt><dd>{new Date(selectedEntry.createdAt).toLocaleString()}</dd></div>
              {selectedEntry.stopPrice !== null ? <div><dt>Stop</dt><dd>{selectedEntry.stopPrice.toFixed(precision)}</dd></div> : null}
              {selectedEntry.targetPrice !== null ? <div><dt>Target</dt><dd>{selectedEntry.targetPrice.toFixed(precision)}</dd></div> : null}
            </dl>
            {error ? <p className="pending-entry-error">{error}</p> : null}
          </div>
          {selectedEntry.status === "PENDING" ? (
            <footer className="pending-entry-actions">
              <button type="button" className="pending-entry-danger pressable" disabled={saving} onClick={() => void cancelEntry()}>Cancel Entry</button>
              <button type="button" className="pending-entry-primary pressable" onClick={() => {
                setOrderReferencePrice(current);
                setEditing(true);
              }}>Edit Entry</button>
            </footer>
          ) : isPanel ? (
            <footer className="pending-entry-actions">
              <button type="button" className="pending-entry-secondary pressable" onClick={onClose}>New Entry</button>
            </footer>
          ) : null}
        </>
      ) : (
        <>
          <div className="pending-entry-form">
            <div className="pending-entry-direction" role="group" aria-label="Direction">
              {(["long", "short"] as const).map((option) => (
                <button key={option} type="button" className={`is-${option}${direction === option ? " is-active" : ""}`} onClick={() => {
                  setDirection(option);
                  setOrderReferencePrice(option === "long" ? ask : bid);
                }}>{option.toUpperCase()}</button>
              ))}
            </div>
            <label>
              <span>Entry price</span>
              <input inputMode="decimal" value={entryPrice} onChange={(event) => {
                if (entryPrice.trim() === "") setOrderReferencePrice(current);
                setEntryPrice(event.target.value);
              }} placeholder={current?.toFixed(precision) ?? "0.00000"} />
              <small>Current: {current?.toFixed(precision) ?? "waiting…"}{distancePips !== null && relative ? ` · Entry ${distancePips.toFixed(1)} pips ${relative}` : ""}</small>
            </label>
            <div className="pending-entry-levels">
              <label>
                <span>Stop loss</span>
                <input inputMode="decimal" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} placeholder="Exact price" />
              </label>
              <label>
                <span>Take profit</span>
                <input inputMode="decimal" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="Exact price" />
              </label>
            </div>
            <fieldset>
              <legend>Expiration</legend>
              <div className="pending-entry-presets">
                {(["none", "30m", "1h", "4h", "custom"] as const).map((option) => (
                  <button key={option} type="button" className={expiration === option ? "is-active" : ""} onClick={() => option === "custom" ? openCustomExpirationPicker() : setExpiration(option)}>
                    {option === "none" ? "No expiration" : option === "custom" ? "Custom" : option}
                  </button>
                ))}
              </div>
              {expiration === "custom" ? <button type="button" className="pending-entry-custom-expiration" onClick={openCustomExpirationPicker}>{customExpiration ? new Date(customExpiration).toLocaleString() : "Choose date and time"}</button> : null}
            </fieldset>
            <fieldset>
              <legend>Submit after</legend>
              <div className="pending-entry-presets">
                <button type="button" className={!activateAt ? "is-active" : ""} onClick={() => { setActivateAt(""); setActivateError(null); }}>Submit now</button>
                <button type="button" className={activateAt ? "is-active" : ""} onClick={openActivatePicker}>Choose time</button>
              </div>
              {activateAt ? <button type="button" className="pending-entry-custom-expiration" onClick={openActivatePicker}>{new Date(activateAt).toLocaleString()}</button> : null}
            </fieldset>
            <label>
              <span>Cancel if price reaches <em>Optional</em></span>
              <input inputMode="decimal" value={invalidationPrice} onChange={(event) => setInvalidationPrice(event.target.value)} placeholder="Exact price" />
            </label>
            <div className="pending-entry-summary">
              <strong>{direction.toUpperCase()} {displayNameFor(instrument)}</strong>
              <span>Order: {inferredOrder ?? "—"}</span>
              <span>Entry: {Number.isFinite(parsedEntry) ? parsedEntry.toFixed(precision) : "—"}</span>
              <span>Stop: {parsedStop && Number.isFinite(parsedStop) ? parsedStop.toFixed(precision) : "—"}</span>
              <span>Target: {parsedTarget && Number.isFinite(parsedTarget) ? parsedTarget.toFixed(precision) : "—"}</span>
              <span>Current: {current?.toFixed(precision) ?? "—"}</span>
              <span>Distance: {distancePips === null ? "—" : `${distancePips.toFixed(1)} pips`}</span>
              <span>Submit: {activateAt ? new Date(activateAt).toLocaleString() : "Now"}</span>
              <span>Expires: {expiration === "none" ? "No expiration" : expiration === "custom" ? customExpiration || "Choose time" : expiration}</span>
              <span>Invalidation: {parsedInvalidation && Number.isFinite(parsedInvalidation) ? parsedInvalidation.toFixed(precision) : "None"}</span>
              <span className={`pending-entry-summary-spread${spreadIsWide ? " is-wide" : ""}`}>
                Spread: {spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips`}
                {spreadIsWide ? " · Wide — may be expensive" : " · Normal"}
              </span>
              {error ? <span className="pending-entry-summary-error" role="alert">{error}</span> : null}
            </div>
          </div>
          <footer className="pending-entry-actions">
            {(!isPanel || selectedEntry) ? (
              <button type="button" className="pending-entry-secondary pressable" onClick={dismissCreateOrClose}>
                {selectedEntry ? "Back" : "Cancel"}
              </button>
            ) : null}
            <button
              type="button"
              className="pending-entry-primary pressable"
              disabled={saving || creationBlocked || !Number.isFinite(parsedEntry) || parsedEntry <= 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : selectedEntry ? "Save Changes" : "Create Entry"}
            </button>
          </footer>
        </>
      )}
    </section>
  );

  return (
    <>
      {isPanel ? shell : createPortal((
        <div className="pending-entry-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
          {shell}
        </div>
      ), document.body)}
      {customExpirationPickerOpen ? createPortal(
        <div className="custom-expiration-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && setCustomExpirationPickerOpen(false)}>
          <section className="custom-expiration-dialog" role="dialog" aria-modal="true" aria-labelledby="custom-expiration-title">
            <header><div><span>Pending entry</span><h3 id="custom-expiration-title">Custom expiration</h3></div></header>
            <p>Choose when this pending entry should expire.</p>
            <div className="custom-expiration-fields">
              <label><span>Date</span><input type="date" value={customDate} min={todayLocalDate()} onChange={(event) => setCustomDate(event.target.value)} /></label>
              <label><span>Time</span><input type="time" value={customTime} onChange={(event) => setCustomTime(event.target.value)} /></label>
            </div>
            {customExpirationError ? <p className="custom-expiration-error">{customExpirationError}</p> : null}
            <footer><button type="button" onClick={() => setCustomExpirationPickerOpen(false)}>Cancel</button><button type="button" onClick={applyCustomExpiration}>Apply time</button></footer>
          </section>
        </div>,
        document.body,
      ) : null}
      {activatePickerOpen ? createPortal(
        <div className="custom-expiration-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && setActivatePickerOpen(false)}>
          <section className="custom-expiration-dialog" role="dialog" aria-modal="true" aria-labelledby="submit-after-title">
            <header><div><span>Pending entry</span><h3 id="submit-after-title">Submit after</h3></div></header>
            <p>Choose when this pending entry should be submitted. It stays dormant until then.</p>
            <div className="custom-expiration-fields">
              <label><span>Date</span><input type="date" value={activateDate} min={todayLocalDate()} onChange={(event) => setActivateDate(event.target.value)} /></label>
              <label><span>Time</span><input type="time" value={activateTime} onChange={(event) => setActivateTime(event.target.value)} /></label>
            </div>
            {activateError ? <p className="custom-expiration-error">{activateError}</p> : null}
            <footer><button type="button" onClick={() => setActivatePickerOpen(false)}>Cancel</button><button type="button" onClick={applyActivate}>Apply time</button></footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
