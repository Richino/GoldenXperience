"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { X } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";
import { NewsWarning } from "@/components/charts/news-warning";
import { usePairTrend } from "@/components/charts/trend-label";
import { NewsStraddleTicket } from "@/components/charts/news-straddle-ticket";

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
    handleSelector: ".pending-entry-grip, .pending-entry-dialog > header, .nl-pe-stickyhead",
    enabled: !isPanel,
  });
  // iOS keeps the layout viewport at full height when the keyboard opens, so
  // this bottom-anchored drawer stayed under the keyboard while typing a price.
  // Lift it to the visible bottom and keep the focused field in view.
  useEffect(() => {
    if (!open || isPanel) return;
    const viewport = window.visualViewport;
    const backdrop = document.querySelector<HTMLElement>(".pending-entry-backdrop");
    if (!viewport || !backdrop) return;
    const sync = () => {
      const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
      const offset = Math.max(0, layoutHeight - viewport.height - viewport.offsetTop);
      const keyboardOpen = viewport.height < layoutHeight - 120;
      backdrop.style.setProperty("--pe-keyboard-offset", `${Math.round(offset)}px`);
      backdrop.style.setProperty("--pe-visible-height", `${Math.round(viewport.height)}px`);
      backdrop.dataset.keyboardOpen = keyboardOpen ? "true" : "false";
      // The sheet extends behind the keyboard (like pair search), so "visible"
      // means above the keyboard: scroll the sheet until the field clears it.
      const field = document.activeElement;
      const sheet = backdrop.querySelector<HTMLElement>(".pending-entry-dialog");
      if (keyboardOpen && sheet && field instanceof HTMLInputElement && sheet.contains(field)) {
        const box = field.getBoundingClientRect();
        const visibleBottom = viewport.offsetTop + viewport.height - 16;
        const visibleTop = sheet.getBoundingClientRect().top + 16;
        if (box.bottom > visibleBottom) sheet.scrollTop += box.bottom - visibleBottom;
        else if (box.top < visibleTop) sheet.scrollTop -= visibleTop - box.top;
      }
    };
    const onFocus = (event: FocusEvent) => {
      // The keyboard animates in after focus; re-check once it has settled.
      if (event.target instanceof HTMLInputElement) window.setTimeout(sync, 350);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    backdrop.addEventListener("focusin", onFocus);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      backdrop.removeEventListener("focusin", onFocus);
    };
  }, [isPanel, open]);
  const [editing, setEditing] = useState(false);
  // Normal is the usual ticket; News arms a two-line breakout for a release.
  const [ticketMode, setTicketMode] = useState<"normal" | "news">("normal");
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
  // The manual ticket can take the stop and target as pips from entry (easier
  // to reason about than raw prices). The prices stay the source of truth for
  // saving; in pips mode they are recalculated from entry and side.
  const [levelUnit, setLevelUnit] = useState<"pips" | "price">("pips");
  const pipDistanceText = (price: string, entry: string) => {
    const p = Number(price), e = Number(entry);
    if (!price.trim() || !entry.trim() || !Number.isFinite(p) || !Number.isFinite(e)) return "";
    return String(Number((Math.abs(p - e) / pipSizeFor(instrument)).toFixed(1)));
  };
  const [stopPips, setStopPips] = useState(() => pipDistanceText(stopPrice, entryPrice));
  const [targetPips, setTargetPips] = useState(() => pipDistanceText(targetPrice, entryPrice));
  /** The price a pip distance lands on: below entry for a long's stop, above for its target. */
  const priceFromPips = (pips: string, kind: "stop" | "target", entry: string, side: "long" | "short" | null) => {
    const distance = Number(pips), e = Number(entry);
    if (!pips.trim() || side === null || !entry.trim() || !Number.isFinite(distance) || distance <= 0 || !Number.isFinite(e)) return "";
    const away = (kind === "target" ? 1 : -1) * (side === "long" ? 1 : -1) * distance * pipSizeFor(instrument);
    return (e + away).toFixed(precisionFor(instrument));
  };
  // Entry in pips is a distance from the live price (ask for a long, bid for a
  // short), below or above it. A sign is avoided on purpose: the iPhone decimal
  // keypad has no minus key. Blank means at the current price.
  const [entryPips, setEntryPips] = useState("");
  const [entrySide, setEntrySide] = useState<"below" | "above" | null>(null);
  const defaultEntrySide = (side: "long" | "short" | null) => (side === "short" ? "above" : "below");
  const entryReference = (side: "long" | "short" | null) => (side === "long" ? ask : side === "short" ? bid : null);
  const entryFromPips = (pips: string, where: "below" | "above", side: "long" | "short" | null) => {
    const reference = entryReference(side);
    if (reference === null) return "";
    const distance = pips.trim() === "" ? 0 : Number(pips);
    if (!Number.isFinite(distance) || distance < 0) return "";
    return (reference + (where === "above" ? 1 : -1) * distance * pipSizeFor(instrument)).toFixed(precisionFor(instrument));
  };
  /** Pips mode: set entry from its distance, then let stop and target follow it. */
  const applyEntryPips = (pips: string, where: "below" | "above", side: "long" | "short" | null) => {
    const nextEntry = entryFromPips(pips, where, side);
    setEntryPrice(nextEntry);
    setOrderReferencePrice(entryReference(side));
    if (levelUnit === "pips") {
      setStopPrice(priceFromPips(stopPips, "stop", nextEntry, side));
      setTargetPrice(priceFromPips(targetPips, "target", nextEntry, side));
    }
    return nextEntry;
  };
  // Every new trade is a swing trade (held for days): the stop goes beyond
  // 4-hour structure, the target defaults to 2R, and the size comes from that
  // stop. An existing day entry being edited keeps its saved style.
  const tradeStyle: "day" | "swing" =
    selectedEntry && (selectedEntry.metadata as { tradeStyle?: string } | undefined)?.tradeStyle !== "swing" ? "day" : "swing";
  // What this order would be sized to, from the server's own sizing (your
  // Settings risk %, live conversion rate, no lot cap), so the preview and the
  // OANDA order always match. Asked after typing settles.
  const [positionSize, setPositionSize] = useState<{ key: string; lots: number; riskAmount: number; riskPercent: number; balance: number } | null>(null);
  const sizeEntry = Number(entryPrice), sizeStop = stopPrice.trim() ? Number(stopPrice) : NaN;
  const sizeKey = Number.isFinite(sizeEntry) && sizeEntry > 0 && Number.isFinite(sizeStop) && sizeStop > 0 && sizeEntry !== sizeStop
    ? `${instrument}|${sizeEntry}|${sizeStop}` : null;
  useEffect(() => {
    if (!open || !sizeKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const [, entry, stop] = sizeKey.split("|");
      fetch(apiUrl(`/api/pending-entries/size?instrument=${instrument}&entry=${entry}&stop=${stop}`), { credentials: "include", cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: { lots?: number; riskAmount?: number; riskPercent?: number; balance?: number } | null) => {
          if (cancelled || !payload || typeof payload.lots !== "number") return;
          setPositionSize({ key: sizeKey, lots: payload.lots, riskAmount: payload.riskAmount ?? 0, riskPercent: payload.riskPercent ?? 0, balance: payload.balance ?? 0 });
        })
        .catch(() => undefined);
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [instrument, open, sizeKey]);
  const currentSize = positionSize && positionSize.key === sizeKey ? positionSize : null;
  // Plan check (journal tags): trend / news view / entry level. Trend is
  // pre-filled from the 4H + daily read against the chosen side until changed.
  const pairTrend = usePairTrend(instrument);
  const [planNews, setPlanNews] = useState<"supports" | "against" | "none" | null>(null);
  const [planLevel, setPlanLevel] = useState<"at" | "none" | null>(null);
  const [planTrendChoice, setPlanTrendChoice] = useState<"with" | "against" | "none" | null>(null);
  const suggestedTrend = (() => {
    const h4 = pairTrend?.h4?.direction, d1 = pairTrend?.d1?.direction;
    if (!direction || !h4 || !d1) return null;
    const trending = (value: string) => value === "UPTREND" || value === "DOWNTREND";
    if (!trending(h4) || h4 !== d1) return "none" as const;
    return (h4 === "UPTREND") === (direction === "long") ? "with" as const : "against" as const;
  })();
  const planTrend = planTrendChoice ?? suggestedTrend;
  /** In pips mode, keep the stop and target prices following entry and side. */
  const syncPipLevels = (entry: string, side: "long" | "short" | null) => {
    if (levelUnit !== "pips") return;
    setStopPrice(priceFromPips(stopPips, "stop", entry, side));
    setTargetPrice(priceFromPips(targetPips, "target", entry, side));
  };
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
          tradeStyle,
          planTags: !selectedEntry ? { trend: planTrend, news: planNews, level: planLevel } : undefined,
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

  const newsSetup = selectedEntry?.metadata?.mode === "news" ? selectedEntry.metadata as { execution?: string; upperLine?: number; lowerLine?: number; upperFar?: number; lowerFar?: number; release?: { title?: string; currency?: string | null; time?: string } | null; stopPips?: number; targetPips?: number; slippagePips?: number; spreadCapPips?: number; closeAfterMinutes?: number } : null;
  const modeSwitch = !selectedEntry ? (
    <div className="nl-pe-submit">
      <span>Mode</span>
      <div className="nl-an-modes" role="radiogroup" aria-label="Ticket mode">
        {(["normal", "news"] as const).map((mode) => (
          <button key={mode} type="button" role="radio" aria-checked={ticketMode === mode} className={ticketMode === mode ? "is-active" : ""} onClick={() => { setTicketMode(mode); setError(null); }}>
            {mode === "normal" ? "Normal" : "News"}
          </button>
        ))}
      </div>
    </div>
  ) : null;

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
      {isPlan || (isTicket && !isPanel) ? (
        // Grip + header pinned as one bar while the form scrolls underneath.
        <div className="nl-pe-stickyhead">
        <div className="pending-entry-grip" aria-hidden="true" />
        <header className="nl-an-top">
          <span className="nl-an-eyebrow">
            {isPlan ? <AnalyzeIcon className="size-3.5" /> : null}
            {isPlan ? "Review entry" : selectedEntry ? "Edit entry" : "New trade"} · {displayNameFor(instrument)}
          </span>
          <button type="button" className="nl-an-close" onClick={requestDrawerClose} aria-label="Close pending entry">
            <X aria-hidden="true" />
          </button>
        </header>
        </div>
      ) : isPanel && !selectedEntry ? null : (
        <>
        {isPanel ? null : <div className="pending-entry-grip" aria-hidden="true" />}
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
        </>
      )}

      {isDetail && selectedEntry ? (
        <>
          <div className="pending-entry-detail">
            <p className={`pending-entry-status is-${selectedEntry.status.toLowerCase()}`}>
              {selectedEntry.status === "PENDING" ? (newsSetup ? (newsSetup.execution === "news_waiting" ? "News setup · waiting for the release" : "News setup · watching both zones") : `Waiting for ${selectedEntry.entryPrice.toFixed(precision)}`)
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
              {newsSetup?.release?.time ? <div><dt>Release</dt><dd>{new Date(newsSetup.release.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {newsSetup.release.currency} {newsSetup.release.title}</dd></div> : null}
              {newsSetup && newsSetup.execution === "news_waiting" && selectedEntry.activateAt
                ? <div><dt>Zones</dt><dd>set from the live price at {new Date(selectedEntry.activateAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd></div>
                : newsSetup ? <div><dt>Zones</dt><dd>buy {newsSetup.upperLine?.toFixed(precision) ?? "—"}–{newsSetup.upperFar?.toFixed(precision) ?? "—"} · sell {newsSetup.lowerLine?.toFixed(precision) ?? "—"}–{newsSetup.lowerFar?.toFixed(precision) ?? "—"}</dd></div> : null}
              {newsSetup ? <div><dt>From the fill</dt><dd>stop {newsSetup.stopPips}p · target {newsSetup.targetPips}p · fills only inside the zone{newsSetup.closeAfterMinutes ? ` · closes after ${newsSetup.closeAfterMinutes}m` : ""}</dd></div> : null}
            </dl>
            {newsSetup && selectedEntry.status === "PENDING" ? <p className="nl-pe-news-note">Price entering a zone sends one order and drops the other zone. Cancelling cancels both.</p> : null}
            {error ? <p className="pending-entry-error">{error}</p> : null}
          </div>
          {selectedEntry.status === "PENDING" ? (
            <footer className="pending-entry-actions">
              <button type="button" className="pending-entry-danger pressable" disabled={saving} onClick={() => void cancelEntry()}>{newsSetup ? "Cancel news setup" : "Cancel Entry"}</button>
              {newsSetup ? null : <button type="button" className="pending-entry-primary pressable" onClick={() => {
                setOrderReferencePrice(current);
                setEditing(true);
              }}>Edit Entry</button>}
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
            <NewsWarning instrument={instrument} />

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
      ) : ticketMode === "news" && !selectedEntry ? (
        <NewsStraddleTicket
          header={modeSwitch}
          instrument={instrument}
          bid={bid}
          ask={ask}
          creationBlocked={creationBlocked}
          onCancel={dismissCreateOrClose}
          onArmed={(message) => {
            onChanged(message);
            onClose();
          }}
        />
      ) : (
        <>
          {/* The manual ticket in the plan's layout: side, the three levels in
              one box, then the order read. Expiry, delayed submit and a
              cancel level are not offered (none / now / none); an entry being
              edited keeps whatever it already had. */}
          <div className="nl-pe-plan nl-pe-ticket">
            {modeSwitch}
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
                    if (levelUnit === "pips") {
                      // Entry re-measured from this side's live price; stop and
                      // target flip to the other side of it with the direction.
                      const where = entrySide ?? defaultEntrySide(option);
                      setEntrySide(where);
                      applyEntryPips(entryPips, where, option);
                      return;
                    }
                    setOrderReferencePrice(reference);
                    // Start from the live price so the order read fills in at once.
                    if (entryPrice.trim() === "" && reference !== null) setEntryPrice(reference.toFixed(precision));
                  }}
                >
                  {option === "long" ? "Long" : "Short"}
                </button>
              ))}
            </div>
            {direction === null ? null : (
              <p className="nl-an-regime">
                {`${planOrder ?? "Order"} · ${current === null ? "waiting for quote" : `now ${current.toFixed(precision)}${distancePips === null ? "" : `, ${distancePips.toFixed(1)} pips away`}`}`}
              </p>
            )}
            <NewsWarning instrument={instrument} tradeStyle={tradeStyle} />

            <div className="nl-pe-submit">
              <span>Enter levels in</span>
              <div className="nl-an-modes" role="radiogroup" aria-label="Entry, stop and target units">
                {(["pips", "price"] as const).map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    role="radio"
                    aria-checked={levelUnit === unit}
                    className={levelUnit === unit ? "is-active" : ""}
                    onClick={() => {
                      if (unit === "pips") {
                        // Carry the current prices over as distances: entry from
                        // the live price, stop and target from entry.
                        setStopPips(pipDistanceText(stopPrice, entryPrice));
                        setTargetPips(pipDistanceText(targetPrice, entryPrice));
                        const reference = entryReference(direction);
                        const entry = Number(entryPrice);
                        if (reference !== null && entryPrice.trim() && Number.isFinite(entry)) {
                          setEntryPips(String(Number((Math.abs(entry - reference) / pipSizeFor(instrument)).toFixed(1))));
                          setEntrySide(entry < reference ? "below" : "above");
                        }
                      }
                      setLevelUnit(unit);
                    }}
                  >
                    {unit === "pips" ? "Pips" : "Price"}
                  </button>
                ))}
              </div>
            </div>

            <div className="nl-pe-levels">
              <label>
                <span>Entry{levelUnit === "pips" ? " · pips" : ""}</span>
                {levelUnit === "pips" ? (
                  <input className="metric-number" inputMode="decimal" value={entryPips} disabled={direction === null} onChange={(event) => {
                    const where = entrySide ?? defaultEntrySide(direction);
                    setEntrySide(where);
                    setEntryPips(event.target.value);
                    applyEntryPips(event.target.value, where, direction);
                  }} placeholder="0" aria-label="Entry in pips from the current price" />
                ) : (
                  <input className="metric-number" inputMode="decimal" value={entryPrice} onChange={(event) => {
                    if (entryPrice.trim() === "") setOrderReferencePrice(current);
                    setEntryPrice(event.target.value);
                    syncPipLevels(event.target.value, direction);
                  }} placeholder={current?.toFixed(precision) ?? "0.00000"} aria-label="Entry price" />
                )}
                {levelUnit === "pips" && direction !== null ? (
                  <span className="nl-pe-where" role="radiogroup" aria-label="Entry below or above the current price">
                    {(["below", "above"] as const).map((where) => (
                      <button
                        key={where}
                        type="button"
                        role="radio"
                        aria-checked={(entrySide ?? defaultEntrySide(direction)) === where}
                        className={(entrySide ?? defaultEntrySide(direction)) === where ? "is-active" : ""}
                        onClick={(event) => {
                          event.preventDefault();
                          setEntrySide(where);
                          applyEntryPips(entryPips, where, direction);
                        }}
                      >
                        {where === "below" ? "Below" : "Above"}
                      </button>
                    ))}
                  </span>
                ) : null}
                <small className="nl-pe-hint">
                  {direction === null
                    ? "Pick a side"
                    : levelUnit === "pips"
                      ? Number.isFinite(parsedEntry) && entryPrice.trim() ? `at ${parsedEntry.toFixed(precision)}` : "waiting for price"
                      : direction === "long" ? "Buy here" : "Sell here"}
                </small>
              </label>
              <label>
                <span>Stop{levelUnit === "pips" ? " · pips" : ""}</span>
                {levelUnit === "pips" ? (
                  <input className="metric-number is-down" inputMode="decimal" value={stopPips} onChange={(event) => {
                    setStopPips(event.target.value);
                    setStopPrice(priceFromPips(event.target.value, "stop", entryPrice, direction));
                  }} placeholder="e.g. 15" aria-label="Stop loss in pips" />
                ) : (
                  <input className="metric-number is-down" inputMode="decimal" value={stopPrice} onChange={(event) => setStopPrice(event.target.value)} placeholder="None" aria-label="Stop loss" />
                )}
                <small className="nl-pe-hint">
                  {parsedStop === null || !Number.isFinite(parsedStop)
                    ? direction === "short" ? "Above entry" : direction === "long" ? "Below entry" : " "
                    : levelUnit === "pips" ? `at ${parsedStop.toFixed(precision)}` : pipsBetween(parsedEntry, parsedStop)}
                </small>
              </label>
              <label>
                <span>Target{levelUnit === "pips" ? " · pips" : ""}</span>
                {levelUnit === "pips" ? (
                  <input className="metric-number is-up" inputMode="decimal" value={targetPips} onChange={(event) => {
                    setTargetPips(event.target.value);
                    setTargetPrice(priceFromPips(event.target.value, "target", entryPrice, direction));
                  }} placeholder="e.g. 30" aria-label="Take profit in pips" />
                ) : (
                  <input className="metric-number is-up" inputMode="decimal" value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} placeholder="None" aria-label="Take profit" />
                )}
                <small className="nl-pe-hint">
                  {parsedTarget === null || !Number.isFinite(parsedTarget)
                    ? direction === "short" ? "Below entry" : direction === "long" ? "Above entry" : " "
                    : `${levelUnit === "pips" ? `at ${parsedTarget.toFixed(precision)}` : pipsBetween(parsedEntry, parsedTarget)}${planRatio === null ? "" : ` · 1:${Number(planRatio.toFixed(1))}`}`}
                </small>
              </label>
            </div>

            <div className="nl-pe-plancheck" aria-label="Plan check">
              <span className="nl-pe-plancheck-title">Plan check <small>for your journal</small></span>
              {([
                ["Trend", planTrend, (value: string) => setPlanTrendChoice(value as "with" | "against" | "none"), [["with", "With"], ["against", "Against"], ["none", "No trend"]]],
                ["News view", planNews, (value: string) => setPlanNews(value as "supports" | "against" | "none"), [["supports", "Supports"], ["against", "Against"], ["none", "None"]]],
                ["Entry", planLevel, (value: string) => setPlanLevel(value as "at" | "none"), [["at", "At a level"], ["none", "No level"]]],
              ] as const).map(([name, current, choose, options]) => (
                <div key={name} className="nl-pe-plancheck-row">
                  <span>{name}{name === "Trend" && planTrendChoice === null && suggestedTrend ? <em> · from 4H + D</em> : null}</span>
                  <div className="nl-an-modes" role="radiogroup" aria-label={name}>
                    {options.map(([value, label]) => (
                      <button key={value} type="button" role="radio" aria-checked={current === value} className={current === value ? "is-active" : ""} onClick={() => choose(value)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <dl className="nl-an-rows">
              <div><dt>Stop distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedStop)}</dd></div>
              <div><dt>Target distance</dt><dd className="metric-number">{pipsBetween(parsedEntry, parsedTarget)}</dd></div>
              <div>
                <dt>Size</dt>
                <dd className="metric-number">
                  {parsedStop === null
                    ? "No stop: sized from the hourly range"
                    : currentSize
                      ? `${currentSize.lots.toFixed(2)} lots · risks $${currentSize.riskAmount.toFixed(0)} (${currentSize.riskPercent}%)`
                      : sizeKey ? "Sizing…" : "—"}
                </dd>
              </div>
              <div><dt>Risk : reward</dt><dd className={`metric-number${planRatio !== null ? " is-up" : ""}`}>{planRatio === null ? "—" : `1 : ${Number(planRatio.toFixed(1))}`}</dd></div>
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
