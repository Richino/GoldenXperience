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

function expirationFieldValues(value: string | null) {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60_000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour24 = date.getHours();
  const hour = hour24 % 12 || 12;
  return {
    date: `${month}/${day}/${date.getFullYear()}`,
    time: `${String(hour).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} ${hour24 >= 12 ? "PM" : "AM"}`,
  };
}

function parseExpirationFields(dateText: string, timeText: string) {
  const date = dateText.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const time = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!date || !time) return null;
  const month = Number(date[1]), day = Number(date[2]), year = Number(date[3]);
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 1 || hour > 12 || minute > 59) return null;
  if (time[3]!.toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (time[3]!.toUpperCase() === "AM" && hour === 12) hour = 0;
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed.toISOString();
}

export function PendingEntryDialog({
  open,
  instrument,
  bid,
  ask,
  selectedEntry,
  initialProposal = null,
  onClose,
  onChanged,
}: {
  open: boolean;
  instrument: string;
  bid: number | null;
  ask: number | null;
  selectedEntry: PendingManualEntry | null;
  initialProposal?: { direction: "long" | "short"; entry: number; stop: number; target: number; confidence: number | null; rationale: string; preferredEntryTime: string } | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [direction, setDirection] = useState<"long" | "short">(selectedEntry?.direction ?? initialProposal?.direction ?? "long");
  const [orderReferencePrice, setOrderReferencePrice] = useState<number | null>(() => {
    const initialDirection = selectedEntry?.direction ?? "long";
    return initialDirection === "long" ? ask : bid;
  });
  const [entryPrice, setEntryPrice] = useState(selectedEntry ? String(selectedEntry.entryPrice) : initialProposal ? String(initialProposal.entry) : "");
  const [stopPrice, setStopPrice] = useState(selectedEntry?.stopPrice == null ? (initialProposal ? String(initialProposal.stop) : "") : String(selectedEntry.stopPrice));
  const [targetPrice, setTargetPrice] = useState(selectedEntry?.targetPrice == null ? (initialProposal ? String(initialProposal.target) : "") : String(selectedEntry.targetPrice));
  const [invalidationPrice, setInvalidationPrice] = useState(selectedEntry?.invalidationPrice == null ? "" : String(selectedEntry.invalidationPrice));
  const [expiration, setExpiration] = useState<ExpirationPreset>(selectedEntry?.expiresAt ? "custom" : "none");
  const [customExpiration, setCustomExpiration] = useState(localDateTimeValue(selectedEntry?.expiresAt ?? null));
  const [customExpirationPickerOpen, setCustomExpirationPickerOpen] = useState(false);
  const initialExpirationFields = expirationFieldValues(selectedEntry?.expiresAt ?? null);
  const [customDate, setCustomDate] = useState(initialExpirationFields.date);
  const [customTime, setCustomTime] = useState(initialExpirationFields.time);
  const [customExpirationError, setCustomExpirationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const scrollY = window.scrollY;
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
  }, [onClose, open]);

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

  function openCustomExpirationPicker() {
    const fields = expirationFieldValues(customExpiration || null);
    setCustomDate(fields.date);
    setCustomTime(fields.time);
    setCustomExpirationError(null);
    setExpiration("custom");
    setCustomExpirationPickerOpen(true);
  }

  function applyCustomExpiration() {
    const parsed = parseExpirationFields(customDate, customTime);
    if (!parsed || Date.parse(parsed) <= Date.now()) {
      setCustomExpirationError("Choose a future date and time, for example 09/15/2026 and 09:30 AM.");
      return;
    }
    setCustomExpiration(localDateTimeValue(parsed));
    setCustomExpirationPickerOpen(false);
  }

  if (!open) return null;

  async function save() {
    setError(null);
    if (current === null) return setError("Wait for a fresh executable market quote.");
    if (!Number.isFinite(parsedEntry) || parsedEntry <= 0) return setError("Enter a valid entry price.");
    if (stopPrice && (!Number.isFinite(parsedStop) || (parsedStop ?? 0) <= 0)) return setError("Enter a valid stop price.");
    if (targetPrice && (!Number.isFinite(parsedTarget) || (parsedTarget ?? 0) <= 0)) return setError("Enter a valid target price.");
    if (invalidationPrice && (!Number.isFinite(parsedInvalidation) || (parsedInvalidation ?? 0) <= 0)) return setError("Enter a valid cancellation price.");
    if (expiration === "custom" && (!expiresAt || Date.parse(expiresAt) <= Date.now())) return setError("Choose a custom expiration in the future.");
    setSaving(true);
    try {
      const response = await fetch(apiUrl(selectedEntry ? `/api/pending-entries/${selectedEntry.id}` : "/api/pending-entries"), {
        method: selectedEntry ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, direction, entryPrice: parsedEntry, stopPrice: parsedStop, targetPrice: parsedTarget, expiresAt, invalidationPrice: parsedInvalidation, orderReferencePrice }),
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

  return (
    <>
      {createPortal((
    <div className="pending-entry-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`pending-entry-dialog${initialProposal ? " is-proposal" : ""}`} role="dialog" aria-modal="true" aria-labelledby="pending-entry-title">
        <header>
          <div>
            <span>{isDetail ? selectedEntry?.status : selectedEntry ? "Edit pending entry" : "Pending manual entry"}</span>
            <h2 id="pending-entry-title">{displayNameFor(instrument)}</h2>
          </div>
          <button type="button" className="mobile-sheet-close pressable" onClick={onClose} aria-label="Close pending entry">
            <X className="size-4" />
          </button>
        </header>

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
            ) : null}
          </>
        ) : (
          <>
            <div className="pending-entry-form">
            <div className="pending-entry-direction" role="group" aria-label="Direction">
              {(["long", "short"] as const).map((option) => (
                <button key={option} type="button" className={direction === option ? "is-active" : ""} onClick={() => {
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
              <span>Expires: {expiration === "none" ? "No expiration" : expiration === "custom" ? customExpiration || "Choose time" : expiration}</span>
              <span>Invalidation: {parsedInvalidation && Number.isFinite(parsedInvalidation) ? parsedInvalidation.toFixed(precision) : "None"}</span>
              <span className={`pending-entry-summary-spread${spreadIsWide ? " is-wide" : ""}`}>
                Spread: {spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips`}
                {spreadIsWide ? " · Wide — may be expensive" : " · Normal"}
              </span>
            </div>
            {error ? <p className="pending-entry-error">{error}</p> : null}
            </div>
            <footer className="pending-entry-actions">
              <button type="button" className="pending-entry-secondary pressable" onClick={selectedEntry ? () => setEditing(false) : onClose}>Cancel</button>
              <button
                type="button"
                className="pending-entry-primary pressable"
                disabled={saving || !Number.isFinite(parsedEntry) || parsedEntry <= 0}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : selectedEntry ? "Save Changes" : "Create Entry"}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
      ), document.body)}
      {customExpirationPickerOpen ? createPortal(
        <div className="custom-expiration-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && setCustomExpirationPickerOpen(false)}>
          <section className="custom-expiration-dialog" role="dialog" aria-modal="true" aria-labelledby="custom-expiration-title">
            <header><div><span>Pending entry</span><h3 id="custom-expiration-title">Custom expiration</h3></div></header>
            <p>Choose when this pending entry should expire.</p>
            <div className="custom-expiration-fields">
              <label><span>Date</span><input value={customDate} onChange={(event) => setCustomDate(event.target.value)} placeholder="MM/DD/YYYY" inputMode="numeric" /></label>
              <label><span>Time</span><input value={customTime} onChange={(event) => setCustomTime(event.target.value)} placeholder="HH:MM AM" /></label>
            </div>
            {customExpirationError ? <p className="custom-expiration-error">{customExpirationError}</p> : null}
            <footer><button type="button" onClick={() => setCustomExpirationPickerOpen(false)}>Cancel</button><button type="button" onClick={applyCustomExpiration}>Apply time</button></footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
