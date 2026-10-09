"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
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
  initialProposal?: { direction: "long" | "short"; entry: number; stop: number; target: number; confidence: number | null; rationale: string; preferredEntryTime: string; activateAt?: string | null; analysisContext?: Record<string, unknown> } | null;
  creationBlocked?: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const isPanel = layout === "panel";
  const { setSheet, setBackdrop, handlers: dragHandlers, requestClose: requestDrawerClose } = useDragToDismiss({
    open,
    onDismiss: onClose,
    handleSelector: ".pending-entry-grip, .pending-entry-dialog > header",
    enabled: !isPanel,
  });
  const [editing, setEditing] = useState(false);
  // A blank entry has no direction until the user picks one, so a form that
  // lost its Analyze plan (e.g. a reload) can never submit a default LONG.
  const [direction, setDirection] = useState<"long" | "short" | null>(selectedEntry?.direction ?? initialProposal?.direction ?? null);
  const [orderReferencePrice, setOrderReferencePrice] = useState<number | null>(() => {
    const initialDirection = selectedEntry?.direction ?? initialProposal?.direction ?? null;
    return initialDirection === null ? null : initialDirection === "long" ? ask : bid;
  });
  const [entryPrice, setEntryPrice] = useState(() => {
    if (selectedEntry) return String(selectedEntry.entryPrice);
    if (initialProposal) return initialProposal.entry.toFixed(precisionFor(instrument));
    // Blank until a direction is picked; the phone drawer then fills in that side's price.
    return "";
  });
  const [stopPrice, setStopPrice] = useState(selectedEntry?.stopPrice == null ? (initialProposal ? initialProposal.stop.toFixed(precisionFor(instrument)) : "") : String(selectedEntry.stopPrice));
  const [targetPrice, setTargetPrice] = useState(selectedEntry?.targetPrice == null ? (initialProposal ? initialProposal.target.toFixed(precisionFor(instrument)) : "") : String(selectedEntry.targetPrice));
  const [invalidationPrice, setInvalidationPrice] = useState(selectedEntry?.invalidationPrice == null ? "" : String(selectedEntry.invalidationPrice));
  // A plan held back for news arrives with its start time already set.
  const [activateAt, setActivateAt] = useState(localDateTimeValue(selectedEntry?.activateAt ?? initialProposal?.activateAt ?? null));
  const [activatePickerOpen, setActivatePickerOpen] = useState(false);
  const initialActivateFields = splitLocal(selectedEntry?.activateAt ?? initialProposal?.activateAt ?? null);
  const [activateDate, setActivateDate] = useState(initialActivateFields.date);
  const [activateTime, setActivateTime] = useState(initialActivateFields.time);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [expiration, setExpiration] = useState<ExpirationPreset>(selectedEntry?.expiresAt ? "custom" : "none");
  const [customExpiration, setCustomExpiration] = useState(localDateTimeValue(selectedEntry?.expiresAt ?? null));
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
        ? event.target.closest<HTMLElement>(".pending-entry-form, .pending-entry-detail, .pending-entry-dialog.is-plan")
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

  const current = direction === null ? null : direction === "long" ? ask : bid;
  const parsedEntry = entryPrice.trim() === "" ? Number.NaN : Number(entryPrice);
  const parsedInvalidation = invalidationPrice ? Number(invalidationPrice) : null;
  // Orders from an Analyze plan get their expiry and cancel level from the
  // server (4 hours after they start watching, 24 for a swing plan; cancelled
  // at the target), so those two are shown as facts rather than choices.
  const analyzeContext = selectedEntry
    ? (selectedEntry.metadata?.frozenContext as { setup?: unknown } | undefined)
    : (initialProposal?.analysisContext as { setup?: unknown } | undefined);
  const AUTOMATIC_LIFETIME_HOURS: Record<string, number> = {
    "trend-pullback-loose-v1": 4, "trend-pullback-swing-v1": 24,
    "market-regime-normal-v1": 4, "market-regime-swing-v1": 48,
    "analyze-v2-normal": 2, "analyze-v2-swing": 16,
  };
  const automaticLifetimeHours = typeof analyzeContext?.setup === "string" ? AUTOMATIC_LIFETIME_HOURS[analyzeContext.setup] ?? null : null;
  const automaticLifetime = automaticLifetimeHours !== null;
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
  const inferredOrder = direction !== null && orderReferencePrice !== null && Number.isFinite(parsedEntry)
    ? direction === "long"
      ? parsedEntry >= orderReferencePrice ? "Buy stop" : "Buy limit"
      : parsedEntry <= orderReferencePrice ? "Sell stop" : "Sell limit"
    : null;
  const expiresAt = useMemo(
    () => expirationFromPreset(expiration, customExpiration),
    [customExpiration, expiration],
  );
  const isDetail = Boolean(selectedEntry && !editing);
  // A new order from an Analyze plan is reviewed in the plan's own layout
  // (the Analyze card's head, levels and rows); everything else is the form.
  const isPlan = !selectedEntry && !isPanel && automaticLifetime && direction !== null;
  // Every other create / edit form is the manual ticket, in the same shell.
  const isTicket = !isPlan && !isDetail;
  const planRatio = Number.isFinite(parsedEntry) && parsedStop && parsedTarget && parsedEntry !== parsedStop
    ? Math.abs(parsedTarget - parsedEntry) / Math.abs(parsedEntry - parsedStop)
    : null;
  // Until the entry is edited there is no reference price, so read the order
  // type against the live quote.
  const planOrder = inferredOrder ?? (direction !== null && current !== null && Number.isFinite(parsedEntry)
    ? direction === "long"
      ? parsedEntry >= current ? "Buy stop" : "Buy limit"
      : parsedEntry <= current ? "Sell stop" : "Sell limit"
    : null);
  const pipsBetween = (from: number | null, to: number | null) =>
    from !== null && to !== null && Number.isFinite(from) && Number.isFinite(to)
      ? `${(Math.abs(to - from) / pipSizeFor(instrument)).toFixed(1)} pips`
      : "—";

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
    const nextDirection = initialProposal?.direction ?? null;
    setEditing(false);
    setDirection(nextDirection);
    setOrderReferencePrice(nextDirection === null ? null : nextDirection === "long" ? ask : bid);
    setEntryPrice(initialProposal ? initialProposal.entry.toFixed(precision) : "");
    setStopPrice(initialProposal ? initialProposal.stop.toFixed(precision) : "");
    setTargetPrice(initialProposal ? initialProposal.target.toFixed(precision) : "");
    setInvalidationPrice("");
    const proposalActivateAt = initialProposal?.activateAt ?? null;
    const proposalActivateFields = splitLocal(proposalActivateAt);
    setActivateAt(localDateTimeValue(proposalActivateAt));
    setActivatePickerOpen(false);
    setActivateDate(proposalActivateFields.date);
    setActivateTime(proposalActivateFields.time);
    setActivateError(null);
    setExpiration("none");
    setCustomExpiration("");
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
    if (direction === null) return setError("Choose LONG or SHORT.");
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
        body: JSON.stringify({
          instrument, direction, entryPrice: parsedEntry, stopPrice: parsedStop, targetPrice: parsedTarget, expiresAt, activateAt: activateAtIso, invalidationPrice: parsedInvalidation, orderReferencePrice,
          // Tags forward-test trades so they can be scored separately later.
          analysisContext: !selectedEntry && initialProposal?.analysisContext
              ? {
                ...initialProposal.analysisContext,
                direction,
                frozen: {
                  ...(initialProposal.analysisContext.frozen as Record<string, unknown> | undefined),
                  editedAfterFill: direction !== initialProposal.direction
                    || parsedEntry.toFixed(precision) !== initialProposal.entry.toFixed(precision)
                    || parsedStop?.toFixed(precision) !== initialProposal.stop.toFixed(precision)
                    || parsedTarget?.toFixed(precision) !== initialProposal.target.toFixed(precision),
                },
              }
              : undefined,
        }),
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
        : "Trade";

  const shell = (
    <section
      className={`pending-entry-dialog${isPanel ? " is-panel" : ""}${initialProposal ? " is-proposal" : ""}${isPlan || (isTicket && !isPanel) ? " is-plan" : ""}`}
      role={isPanel ? "region" : "dialog"}
      aria-modal={isPanel ? undefined : true}
      aria-labelledby={isPanel && !selectedEntry ? undefined : "pending-entry-title"}
      aria-label={isPanel && !selectedEntry ? "Add entry" : undefined}
      onFocusCapture={resetDialogDocumentScroll}
      ref={setSheet}
      {...dragHandlers}
    >
      {isPanel ? null : <div className="pending-entry-grip" aria-hidden="true" />}
      {isPlan || (isTicket && !isPanel) ? (
        <header className="nl-an-top">
          <span className="nl-an-eyebrow">
            {isPlan ? <AnalyzeIcon className="size-3.5" /> : null}
            {isPlan ? "Review entry" : selectedEntry ? "Edit entry" : "New trade"} · {displayNameFor(instrument)}
          </span>
          <button type="button" className="nl-an-close" onClick={requestDrawerClose} aria-label="Close pending entry">
            <X aria-hidden="true" />
          </button>
        </header>
      ) : isPanel && !selectedEntry ? null : (
        <header>
          <div>
            <span>{headerEyebrow}</span>
            <h2 id="pending-entry-title">{displayNameFor(instrument)}</h2>
          </div>
          <button
            type="button"
            className="mobile-sheet-close pressable"
            onClick={requestDrawerClose}
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
      ) : isPlan ? (
        <>
          <div className="nl-pe-plan">
            <div className="nl-an-head">
              <h2 id="pending-entry-title" className={`nl-an-decision ${direction === "long" ? "is-up" : "is-down"}`}>
                {direction === "long" ? "Long" : "Short"}
              </h2>
              {planRatio !== null ? (
                <span className="nl-an-ratio">1:{Number.isInteger(Number(planRatio.toFixed(1))) ? planRatio.toFixed(0) : planRatio.toFixed(1)}</span>
              ) : null}
            </div>
            <p className="nl-an-regime">
              {planOrder ?? "Order"} · {current === null ? "waiting for quote" : `now ${current.toFixed(precision)}, ${distancePips === null ? "—" : `${distancePips.toFixed(1)} pips away`}`}
            </p>

            <div className="nl-pe-levels">
              <label>
                <span>Entry</span>
                <input className="metric-number" inputMode="decimal" value={entryPrice} onChange={(event) => {
                  if (entryPrice.trim() === "") setOrderReferencePrice(current);
                  setEntryPrice(event.target.value);
                }} aria-label="Entry price" />
              </label>
              <label>
                <span>Stop</span>
                <input className="metric-number is-down" inputMode="decimal" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} aria-label="Stop loss" />
              </label>
              <label>
                <span>Target</span>
                <input className="metric-number is-up" inputMode="decimal" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} aria-label="Take profit" />
              </label>
            </div>

            <dl className="nl-an-rows">
              <div><dt>Stop distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedStop)}</dd></div>
              <div><dt>Target distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedTarget)}</dd></div>
              <div><dt>Spread</dt><dd className={`metric-number${spreadIsWide ? " is-caution" : ""}`}>{spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips${spreadIsWide ? " · wide" : ""}`}</dd></div>
              <div><dt>Expires</dt><dd>{automaticLifetimeHours}h after it starts watching</dd></div>
            </dl>

            <div className="nl-pe-submit">
              <span>Submit</span>
              <div className="nl-an-modes" role="radiogroup" aria-label="Submit after">
                <button type="button" role="radio" aria-checked={!activateAt} className={!activateAt ? "is-active" : ""} onClick={() => { setActivateAt(""); setActivateError(null); }}>Now</button>
                <button type="button" role="radio" aria-checked={Boolean(activateAt)} className={activateAt ? "is-active" : ""} onClick={openActivatePicker}>{activateAt ? new Date(activateAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "Later"}</button>
              </div>
            </div>

            {error ? <p className="nl-pe-error" role="alert">{error}</p> : null}
          </div>
          <footer className="nl-an-actions is-card nl-pe-actions">
            <button type="button" className="nl-an-secondary pressable" onClick={dismissCreateOrClose}>Cancel</button>
            <button
              type="button"
              className="nl-an-primary pressable"
              disabled={saving || creationBlocked || !Number.isFinite(parsedEntry) || parsedEntry <= 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Create entry"}
            </button>
          </footer>
        </>
      ) : (
        <>
          {/* The manual ticket in the plan's layout: side, the three levels in
              one box, then the order read. Expiry, delayed submit and a
              cancel level are not offered (none / now / none); an entry being
              edited keeps whatever it already had. */}
          <div className="nl-pe-plan nl-pe-ticket">
            <div className="nl-pe-dir" role="radiogroup" aria-label="Direction">
              {(["long", "short"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={direction === option}
                  className={`is-${option}${direction === option ? " is-active" : ""}`}
                  onClick={() => {
                    const reference = option === "long" ? ask : bid;
                    setDirection(option);
                    setOrderReferencePrice(reference);
                    // Start from the live price so the order read fills in at once.
                    if (entryPrice.trim() === "" && reference !== null) setEntryPrice(reference.toFixed(precision));
                  }}
                >
                  {option === "long" ? "Long" : "Short"}
                </button>
              ))}
            </div>
            <p className="nl-an-regime">
              {direction === null
                ? "Choose long or short to start."
                : `${planOrder ?? "Order"} · ${current === null ? "waiting for quote" : `now ${current.toFixed(precision)}${distancePips === null ? "" : `, ${distancePips.toFixed(1)} pips away`}`}`}
            </p>

            <div className="nl-pe-levels">
              <label>
                <span>Entry</span>
                <input className="metric-number" inputMode="decimal" value={entryPrice} onChange={(event) => {
                  if (entryPrice.trim() === "") setOrderReferencePrice(current);
                  setEntryPrice(event.target.value);
                }} placeholder={current?.toFixed(precision) ?? "0.00000"} aria-label="Entry price" />
              </label>
              <label>
                <span>Stop</span>
                <input className="metric-number is-down" inputMode="decimal" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} placeholder="None" aria-label="Stop loss" />
              </label>
              <label>
                <span>Target</span>
                <input className="metric-number is-up" inputMode="decimal" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="None" aria-label="Take profit" />
              </label>
            </div>

            <dl className="nl-an-rows">
              <div><dt>Stop distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedStop)}</dd></div>
              <div><dt>Target distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedTarget)}</dd></div>
              <div><dt>Reward : risk</dt><dd className="metric-number">{planRatio === null ? "—" : `${Number(planRatio.toFixed(1))} : 1`}</dd></div>
              <div><dt>Spread</dt><dd className={`metric-number${spreadIsWide ? " is-caution" : ""}`}>{spreadPips === null ? "—" : `${spreadPips.toFixed(1)} pips${spreadIsWide ? " · wide" : ""}`}</dd></div>
              {automaticLifetime ? <div><dt>Expires</dt><dd>{automaticLifetimeHours}h after it starts watching</dd></div> : null}
            </dl>

            {error ? <p className="nl-pe-error" role="alert">{error}</p> : null}
          </div>
          <footer className="nl-an-actions is-card nl-pe-actions">
            {(!isPanel || selectedEntry) ? (
              <button type="button" className="nl-an-secondary pressable" onClick={dismissCreateOrClose}>
                {selectedEntry ? "Back" : "Cancel"}
              </button>
            ) : null}
            <button
              type="button"
              className="nl-an-primary pressable"
              disabled={saving || creationBlocked || direction === null || !Number.isFinite(parsedEntry) || parsedEntry <= 0}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : selectedEntry ? "Save changes" : "Create entry"}
            </button>
          </footer>
        </>
      )}
    </section>
  );
  return (
    <>
      {isPanel ? shell : createPortal((
        <div ref={setBackdrop} className="pending-entry-backdrop" data-pull-to-refresh-ignore="true" onMouseDown={(event) => event.target === event.currentTarget && requestDrawerClose()}>
          {shell}
        </div>
      ), document.body)}
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
