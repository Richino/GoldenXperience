"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import { formatChartPrice } from "@/lib/chart-utils";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";

export type ManualProposal = {
  instrument: string;
  direction: "long" | "short";
  confidence: number;
  entry: number;
  stop: number;
  target: number;
  riskReward: number;
  preferredEntryTime: string;
  rationale: string;
  newsSummary: string;
  analyzedAt: string;
  testOnly: true;
};

const CHART_OPEN_DELAY_MS = 180;

/**
 * The test-only "AI analysis" flow shared by the watchlist and the chart page:
 * request a proposal for an instrument, lock the page behind the modal, and
 * hand acceptance off to the chart's pending-entry draft. Accepting never
 * places an order — it opens a reviewable draft.
 */
export function useManualProposal() {
  const router = useRouter();
  const [proposal, setProposal] = useState<ManualProposal | null>(null);
  const [analyzingInstrument, setAnalyzingInstrument] = useState<string | null>(
    null,
  );
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    if (!proposal) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousHtmlHeight = document.documentElement.style.height;
    const previousBodyMinHeight = document.body.style.minHeight;
    const scrollY = window.scrollY;
    let touchStartY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      if (touchStartY === null || currentY === undefined) return;
      const modal = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".manual-proposal")
        : null;
      if (!modal) {
        event.preventDefault();
        return;
      }
      const delta = currentY - touchStartY;
      const atTop = modal.scrollTop <= 0;
      const atBottom = modal.scrollTop + modal.clientHeight >= modal.scrollHeight - 1;
      if ((atTop && delta > 0) || (atBottom && delta < 0)) event.preventDefault();
    };
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
    // On iOS a position:fixed body with no explicit height leaves fixed
    // descendants (the portaled modal) short of the physical screen, so the
    // centered dialog rides up and the bare page shows below. Pinning html/body
    // to the dynamic viewport height gives the modal the full screen to center in.
    document.documentElement.style.height = "100dvh";
    document.body.style.minHeight = "100dvh";
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
      document.documentElement.style.height = previousHtmlHeight;
      document.body.style.minHeight = previousBodyMinHeight;
      document.removeEventListener("touchstart", onTouchStart, true);
      document.removeEventListener("touchmove", onTouchMove, true);
      window.scrollTo(0, scrollY);
    };
  }, [proposal]);

  const analyze = useCallback(async (instrument: string) => {
    setAnalysisError(null);
    setAnalyzingInstrument(instrument);
    try {
      const response = await fetch(apiUrl("/api/manual-analysis"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument }),
      });
      const payload = await response.json() as { proposal?: ManualProposal; error?: string };
      if (!response.ok || !payload.proposal) throw new Error(payload.error ?? "Analysis could not produce a proposal.");
      setProposal(payload.proposal);
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : "Analysis could not run.");
    } finally {
      setAnalyzingInstrument(null);
    }
  }, []);

  const acceptProposal = useCallback(() => {
    if (!proposal) return;
    const parameters = new URLSearchParams({
      instrument: proposal.instrument,
      entry: String(proposal.entry),
      stop: String(proposal.stop),
      target: String(proposal.target),
      direction: proposal.direction,
      confidence: String(proposal.confidence),
      preferredEntryTime: proposal.preferredEntryTime,
      rationale: proposal.rationale,
      proposal: "manual-analysis",
    });
    // Give the modal one frame of visible feedback before navigation. During
    // this small handoff window the returned cancellation function makes an
    // outside tap or Cancel a real cancellation rather than a cosmetic one.
    const timeout = window.setTimeout(() => {
      router.push(`/chart?${parameters.toString()}`);
    }, CHART_OPEN_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [proposal, router]);

  return {
    proposal,
    setProposal,
    analyze,
    analyzingInstrument,
    analysisError,
    acceptProposal,
  };
}

/** The reviewable AI-proposal modal. Portals to <body>, above the page. */
export function ManualProposalModal({
  proposal,
  currentPrice = null,
  onDismiss,
  onAccept,
}: {
  proposal: ManualProposal | null;
  /** The live executable side: Ask for a long, Bid for a short. */
  currentPrice?: number | null;
  onDismiss: () => void;
  /** Starts navigation and may return a cancellation function for the handoff. */
  onAccept: () => void | (() => void);
}) {
  const [opening, setOpening] = useState(false);
  const cancelOpenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (proposal) return;
    cancelOpenRef.current?.();
    cancelOpenRef.current = null;
    setOpening(false);
  }, [proposal]);

  useEffect(
    () => () => {
      cancelOpenRef.current?.();
    },
    [],
  );

  if (!proposal) return null;

  const executableSide = proposal.direction === "long" ? "Ask" : "Bid";
  const currentPriceIsValid = currentPrice !== null && Number.isFinite(currentPrice);
  const entryDistancePips = currentPriceIsValid
    ? (currentPrice - proposal.entry) / pipSizeFor(proposal.instrument)
    : null;
  const entryDistanceLabel = entryDistancePips === null
    ? "Waiting for a live quote"
    : Math.abs(entryDistancePips) < 0.05
      ? "At entry"
      : `${Math.abs(entryDistancePips).toFixed(1)} pips ${entryDistancePips > 0 ? "above" : "below"} entry`;

  function dismiss() {
    cancelOpenRef.current?.();
    cancelOpenRef.current = null;
    setOpening(false);
    onDismiss();
  }

  function accept() {
    if (opening) return;
    cancelOpenRef.current = onAccept() ?? null;
    setOpening(true);
  }

  return createPortal(
    (
      <div
        className="manual-proposal-backdrop"
        role="presentation"
        data-pull-to-refresh-ignore="true"
        onMouseDown={(event) => event.target === event.currentTarget && dismiss()}
      >
        <section className="manual-proposal" role="dialog" aria-modal="true" aria-labelledby="manual-proposal-title">
          <header>
            <div>
              <h2 id="manual-proposal-title">{displayNameFor(proposal.instrument)} · {proposal.direction.toUpperCase()}</h2>
            </div>
            <strong>{proposal.confidence}% <small>confidence</small></strong>
          </header>
          <div className="manual-proposal-quote" aria-label={`Live ${executableSide} price`}>
            <span>Live {executableSide}</span>
            <strong>{currentPriceIsValid ? formatChartPrice(currentPrice, proposal.instrument) : "—"}</strong>
            <small>{entryDistanceLabel}</small>
          </div>
          <dl>
            <div><dt>Entry</dt><dd>{formatChartPrice(proposal.entry, proposal.instrument)}</dd></div>
            <div><dt>Stop</dt><dd>{formatChartPrice(proposal.stop, proposal.instrument)}</dd></div>
            <div><dt>Target</dt><dd>{formatChartPrice(proposal.target, proposal.instrument)} · {proposal.riskReward}:1</dd></div>
          </dl>
          <p className="manual-proposal-entry-time"><b>Preferred entry:</b> {proposal.preferredEntryTime}</p>
          <p><b>Why:</b> {proposal.rationale}</p>
          <p><b>News:</b> {proposal.newsSummary}</p>
          <footer>
            <button type="button" className="manual-proposal-dismiss pressable" onClick={dismiss}>
              {opening ? "Cancel" : "Dismiss"}
            </button>
            <button
              type="button"
              className="manual-proposal-accept pressable"
              onClick={accept}
              disabled={opening}
              aria-live="polite"
            >
              {opening ? <><LoaderCircle className="size-3.5 animate-spin" /> Opening chart…</> : "Accept & open chart"}
            </button>
          </footer>
        </section>
      </div>
    ),
    document.body,
  );
}
