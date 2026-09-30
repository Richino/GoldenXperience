"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { formatChartPrice } from "@/lib/chart-utils";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import type { TrendPullbackV1Result } from "@/lib/strategy/trend-pullback-v1";
import type { MajorInstrument } from "@/types/forex";

export function TrendPullbackResultDialog({ result, instrument, analyzing = false, onClose, onCancel, onReview }: {
  result: TrendPullbackV1Result | null;
  instrument: MajorInstrument;
  analyzing?: boolean;
  onClose: () => void;
  onCancel: () => void;
  onReview: (stopChoice: "normal" | "structure") => void;
}) {
  // Tied to the plan it was picked on, so a new analysis starts on the stop it recommends.
  const [picked, setPicked] = useState<{ plan: TrendPullbackV1Result | null; choice: "normal" | "structure" }>({ plan: null, choice: "normal" });
  const stopChoice = picked.plan === result ? picked.choice : result?.recommendedStop ?? "normal";
  const setStopChoice = (choice: "normal" | "structure") => setPicked({ plan: result, choice });
  const { setSheet, setBackdrop, handlers: dragHandlers, requestClose } = useDragToDismiss({
    open: analyzing || result !== null,
    onDismiss: analyzing ? onCancel : onClose,
    handleSelector: ".tp-grip, .tp-head",
  });
  if (!result && !analyzing) return null;
  // While the plan is computed, show the plan's own layout as a skeleton so the
  // drawer does not jump from a spinner card to a different-shaped result.
  if (analyzing) return createPortal(
    <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true">
      <section className="tp-sheet is-loading max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-busy="true" aria-label="Analyzing chart" ref={setSheet} {...dragHandlers}>
        <div className="tp-grip" aria-hidden="true" />
        <header className="tp-head flex items-start justify-between gap-4">
          <div><p className="tp-eyebrow text-xs font-semibold uppercase tracking-wide text-emerald-600">TrendPullbackV1 · loose · M15</p><span className="tp-skel tp-skel-title mt-2 block h-6 w-52 rounded-md" /></div>
          <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Cancel analysis">×</button>
        </header>
        <div className="tp-entry mt-5 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900">
          <div className="tp-entry-top"><span className="tp-skel tp-skel-direction block h-7 w-20 rounded-md" /></div>
          <span className="tp-skel tp-skel-label mt-3 block h-3 w-12 rounded" />
          <span className="tp-skel tp-skel-price mt-2 block h-8 w-40 rounded-md" />
          <span className="tp-skel tp-skel-line mt-2 block h-3.5 w-24 rounded" />
        </div>
        <div className="tp-levels mt-3 grid grid-cols-2 gap-2">
          {[0, 1].map((index) => (
            <div key={index} className="tp-level rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <span className="tp-skel tp-skel-label block h-3 w-16 rounded" />
              <span className="tp-skel tp-skel-level mt-2 block h-4 w-20 rounded" />
              <span className="tp-skel tp-skel-line mt-2 block h-3 w-24 rounded" />
            </div>
          ))}
        </div>
        <div className="tp-rr mt-3 flex items-center justify-between px-3 py-2"><span className="tp-skel tp-skel-line block h-3.5 w-24 rounded" /><span className="tp-skel tp-skel-level block h-4 w-14 rounded" /></div>
        <footer className="tp-actions mt-5 flex gap-2">
          <span className="tp-skel tp-skel-button block min-h-11 flex-1 rounded-xl" />
          <span className="tp-skel tp-skel-button block min-h-11 flex-1 rounded-xl" />
        </footer>
      </section>
    </div>, document.body,
  );
  if (!result) return null;
  const format = (price: number | null) => price === null ? "—" : formatChartPrice(price, instrument);
  const validPlan = result.status !== "NO_VALID_ENTRY";
  const directionTone = result.action === "LONG" ? "text-emerald-600" : "text-rose-600";
  const structure = result.structureStop?.available ? result.structureStop : null;
  const useStructure = stopChoice === "structure" && structure !== null;
  const shown = useStructure
    ? { stop: structure.stop, stopPips: structure.stopDistancePips, target: structure.takeProfit, targetPips: structure.targetDistancePips }
    : { stop: result.stopLoss, stopPips: result.stopDistancePips, target: result.takeProfit, targetPips: result.targetDistancePips };
  const status = result.status === "ENTRY_AVAILABLE_NOW" ? "Entry available now" : result.currentMove === "NONE" ? "Next pullback level" : "Planned pullback entry";
  return createPortal(
    <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="tp-sheet max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="trend-pullback-title" ref={setSheet} {...dragHandlers}>
        <div className="tp-grip" aria-hidden="true" />
        <header className="tp-head flex items-start justify-between gap-4">
          <div><p className="tp-eyebrow text-xs font-semibold uppercase tracking-wide text-emerald-600">TrendPullbackV1 · loose · M15</p><h2 id="trend-pullback-title" className="tp-title mt-1 text-xl font-semibold">{validPlan ? status : "No trade plan"}</h2></div>
          <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Close analysis">×</button>
        </header>
        {validPlan ? <>
          <div className="tp-entry mt-5 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900"><div className="tp-entry-top flex items-baseline justify-between gap-3"><span className={`tp-direction is-${result.action === "LONG" ? "long" : "short"} text-2xl font-bold ${directionTone}`}>{result.action}</span><span className="tp-basis text-xs font-semibold uppercase tracking-wide text-zinc-500">{result.priceBasis === "LAST_M15_CLOSE" ? "Reference only" : result.orderType ?? "Market entry"}</span></div>{result.counterTrend ? <p className="tp-counter mt-2 text-xs font-semibold text-amber-600 dark:text-amber-400">Against the 1H/4H trend · tested level · 1:1 target</p> : null}<p className="tp-label mt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Entry</p><p className="tp-entry-price mt-1 font-mono text-3xl font-bold tracking-tight">{format(result.entry)}</p><p className="tp-distance mt-1 text-sm text-zinc-600 dark:text-zinc-300">{result.distanceToEntryPips?.toFixed(1) ?? "—"} pips away</p></div>
          <dl className="tp-levels mt-3 grid grid-cols-2 gap-2"><div className="tp-level is-stop rounded-xl border border-rose-200 p-3 dark:border-rose-950"><dt className="tp-level-label text-[11px] font-semibold uppercase tracking-wide text-rose-600">Stop loss</dt><dd className="tp-level-price mt-1 font-mono text-base font-semibold">{format(shown.stop)}</dd><dd className="tp-level-copy mt-1 text-xs text-zinc-500">{shown.stopPips?.toFixed(1) ?? "—"} pips risk</dd></div><div className="tp-level is-target rounded-xl border border-sky-200 p-3 dark:border-sky-950"><dt className="tp-level-label text-[11px] font-semibold uppercase tracking-wide text-sky-600">Take profit</dt><dd className="tp-level-price mt-1 font-mono text-base font-semibold">{format(shown.target)}</dd><dd className="tp-level-copy mt-1 text-xs text-zinc-500">{shown.targetPips?.toFixed(1) ?? "—"} pips reward</dd></div></dl>
          {result.structureStop ? <div className="tp-stop-choice mt-3">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 text-sm dark:bg-zinc-900" role="radiogroup" aria-label="Stop placement">
              {(["normal", "structure"] as const).map((choice) => (
                <button key={choice} type="button" role="radio" aria-checked={stopChoice === choice} disabled={choice === "structure" && !structure} title={choice === "structure" && result.structureStop && !result.structureStop.available ? result.structureStop.note : undefined} onClick={() => setStopChoice(choice)}
                  className={`min-h-9 rounded-lg px-2 font-semibold disabled:opacity-40 ${stopChoice === choice ? "bg-white shadow-sm dark:bg-zinc-800" : "text-zinc-500"}`}>
                  {choice === "normal" ? `Normal · ${result.stopDistancePips?.toFixed(1) ?? "—"}p` : `Structure${structure ? ` · ${structure.stopDistancePips.toFixed(1)}p` : ""}`}
                </button>
              ))}
            </div>
          </div> : null}
          <div className="tp-rr mt-3 flex items-center justify-between rounded-xl px-3 py-2 text-sm"><span className="text-zinc-500">Risk / reward</span><strong className="font-mono text-base">{result.riskReward?.toFixed(2) ?? "—"}:1</strong></div>
        </> : <div className="tp-empty mt-5 rounded-2xl bg-zinc-100 p-4 text-sm leading-6 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">{result.entry !== null ? <p className="mb-2 font-mono text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{format(result.entry)}</p> : null}{result.reasons[0] ?? "TrendPullbackV1 could not form a valid setup."}</div>}
        <footer className="tp-actions mt-5 flex gap-2">
          <button type="button" onClick={requestClose} className="tp-reject min-h-11 flex-1 rounded-xl border border-rose-200 px-4 font-medium text-rose-700 dark:border-rose-900 dark:text-rose-300">Reject</button>
          {validPlan ? <button type="button" onClick={() => onReview(useStructure ? "structure" : "normal")} className="tp-accept min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 font-semibold text-white">Accept</button> : null}
        </footer>
      </section>
    </div>, document.body,
  );
}
