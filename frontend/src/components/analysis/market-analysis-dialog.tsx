"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { formatChartPrice } from "@/lib/chart-utils";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { NO_NEWS, type AnalysisMode, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import type { MajorInstrument } from "@/types/forex";

const REGIME_LABEL = { UPTREND: "Uptrend", DOWNTREND: "Downtrend", RANGE: "Range", TRANSITION: "Transition" } as const;
const DECISION_LABEL = { LONG: "Long setup", SHORT: "Short setup", "NO TRADE": "No trade" } as const;

/** Risk first, reward as 2, the way the plan is set: reward/risk 0.5 reads "4:2". */
function riskToReward(rewardRisk: number) {
  const risk = Number((2 / rewardRisk).toFixed(1));
  return `${risk}:2`;
}

/**
 * Analyze result, kept to the trade itself: regime, entry, stop, target and a
 * caution when high-impact news is due. Normal (H1 regime) and Swing (H4
 * regime) are two reads of the same structure; the toggle switches between
 * them and Accept places the one shown.
 */
export function MarketAnalysisDialog({ normal, swing, instrument, analyzing = false, onClose, onCancel, onReview }: {
  normal: MarketAnalysis | null;
  swing: MarketAnalysis | null;
  instrument: MajorInstrument;
  analyzing?: boolean;
  onClose: () => void;
  onCancel: () => void;
  onReview: (mode: AnalysisMode) => void;
}) {
  // Tied to the analysis it was picked on, so a new analysis starts on Normal.
  const [picked, setPicked] = useState<{ analysis: MarketAnalysis | null; mode: AnalysisMode }>({ analysis: null, mode: "NORMAL" });
  const mode: AnalysisMode = picked.analysis === normal && picked.mode === "SWING" && swing ? "SWING" : "NORMAL";
  const { setSheet, setBackdrop, handlers: dragHandlers, requestClose } = useDragToDismiss({
    open: analyzing || normal !== null,
    onDismiss: analyzing ? onCancel : onClose,
    handleSelector: ".tp-grip, .tp-head",
  });
  if (!normal && !analyzing) return null;

  if (analyzing || !normal) return createPortal(
    <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true">
      <section className="tp-sheet is-loading max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-busy="true" aria-label="Analyzing chart" ref={setSheet} {...dragHandlers}>
        <div className="tp-grip" aria-hidden="true" />
        <header className="tp-head flex items-start justify-between gap-4">
          <div><p className="tp-eyebrow text-xs font-semibold uppercase tracking-wide text-emerald-600">Market structure</p><span className="tp-skel tp-skel-title mt-2 block h-6 w-52 rounded-md" /></div>
          <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Cancel analysis">×</button>
        </header>
        <span className="tp-skel tp-skel-button mt-4 block h-10 w-full rounded-xl" />
        <div className="tp-entry mt-3 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900">
          <span className="tp-skel tp-skel-direction block h-7 w-28 rounded-md" />
          <span className="tp-skel tp-skel-line mt-3 block h-3.5 w-48 rounded" />
        </div>
        <div className="tp-levels mt-3 grid grid-cols-2 gap-2">
          {[0, 1].map((index) => (
            <div key={index} className="tp-level rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <span className="tp-skel tp-skel-label block h-3 w-16 rounded" />
              <span className="tp-skel tp-skel-level mt-2 block h-4 w-20 rounded" />
            </div>
          ))}
        </div>
        <footer className="tp-actions mt-5 flex gap-2">
          <span className="tp-skel tp-skel-button block min-h-11 flex-1 rounded-xl" />
          <span className="tp-skel tp-skel-button block min-h-11 flex-1 rounded-xl" />
        </footer>
      </section>
    </div>, document.body,
  );

  const analysis = mode === "SWING" && swing ? swing : normal;
  const format = (price: number | null | undefined) => price === null || price === undefined ? "—" : formatChartPrice(price, instrument);
  const trade = analysis.trade;
  const tone = analysis.decision === "LONG" ? "text-emerald-600" : analysis.decision === "SHORT" ? "text-rose-600" : "text-zinc-500";
  const news = analysis.risk.news !== NO_NEWS ? analysis.risk.news : null;

  return createPortal(
    <div ref={setBackdrop} className="tp-backdrop fixed inset-0 z-[10000] flex items-center justify-center p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <section className="tp-sheet max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="market-analysis-title" ref={setSheet} {...dragHandlers}>
        <div className="tp-grip" aria-hidden="true" />
        <header className="tp-head flex items-start justify-between gap-4">
          <div>
            <p className="tp-eyebrow text-xs font-semibold uppercase tracking-wide text-emerald-600">Market structure · {analysis.mode === "SWING" ? "Swing" : "Normal"} · {analysis.primaryTimeframe}</p>
            <h2 id="market-analysis-title" className={`tp-title mt-1 text-xl font-semibold ${tone}${analysis.decision === "LONG" ? " is-long" : analysis.decision === "SHORT" ? " is-short" : ""}`}>{analysis.weakSetup ? <>{analysis.decision === "LONG" ? "Long" : "Short"}<span className="tp-title-note"> · weak setup</span></> : DECISION_LABEL[analysis.decision]}</h2>
          </div>
          <button type="button" onClick={requestClose} className="tp-close rounded-lg px-2 py-1 text-xl" aria-label="Close analysis">×</button>
        </header>

        <div className="tp-stop-choice mt-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 text-sm dark:bg-zinc-900" role="radiogroup" aria-label="Trade mode">
            {(["NORMAL", "SWING"] as const).map((option) => {
              const read = option === "SWING" ? swing : normal;
              return (
                <button key={option} type="button" role="radio" aria-checked={mode === option} disabled={!read} onClick={() => setPicked({ analysis: normal, mode: option })}
                  className={`min-h-9 rounded-lg px-2 font-semibold disabled:opacity-40 ${mode === option ? "bg-white shadow-sm dark:bg-zinc-800" : "text-zinc-500"}`}>
                  {option === "NORMAL" ? "Normal" : "Swing"}{read ? ` · ${read.decision === "NO TRADE" ? "No trade" : read.decision === "LONG" ? "Long" : "Short"}` : ""}
                </button>
              );
            })}
          </div>
        </div>

        <div className="tp-entry mt-3 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-lg font-bold">{REGIME_LABEL[analysis.regime]}</span>
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{analysis.regimeConfidence.toLowerCase()} confidence</span>
          </div>
          {trade ? <>
            <p className="tp-label mt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Entry · {trade.orderType === "MARKET" ? "available now" : trade.orderType === "BUY_LIMIT" ? "buy limit" : "sell limit"}</p>
            <p className="tp-entry-price mt-1 font-mono text-3xl font-bold tracking-tight">{format(trade.entry)}</p>
            <p className="tp-distance mt-1 text-sm text-zinc-600 dark:text-zinc-300">Current {format(analysis.currentPrice)}{trade.orderType === "MARKET" ? "" : ` · ~${trade.fillChancePct}% chance to fill`} · {trade.holding}</p>
          </> : <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300">{analysis.reason}</p>}
        </div>

        {news ? (
          <div className="tp-news-caution mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
            <p className="text-[11px] font-bold uppercase tracking-wide">⚠ Caution · news</p>
            <p className="mt-1 text-xs leading-5">{news}</p>
          </div>
        ) : null}

        {trade ? <>
          <dl className="tp-levels mt-3 grid grid-cols-2 gap-2">
            <div className="tp-level is-stop rounded-xl border border-rose-200 p-3 dark:border-rose-950"><dt className="tp-level-label text-[11px] font-semibold uppercase tracking-wide text-rose-600">Stop loss</dt><dd className="tp-level-price mt-1 font-mono text-base font-semibold">{format(trade.stopLoss)}</dd><dd className="tp-level-copy mt-1 text-xs text-zinc-500">{trade.stopPips} pips risk</dd></div>
            <div className="tp-level is-target rounded-xl border border-sky-200 p-3 dark:border-sky-950"><dt className="tp-level-label text-[11px] font-semibold uppercase tracking-wide text-sky-600">Take profit</dt><dd className="tp-level-price mt-1 font-mono text-base font-semibold">{format(trade.takeProfit)}</dd><dd className="tp-level-copy mt-1 text-xs text-zinc-500">{trade.targetPips} pips reward</dd></div>
          </dl>
          <div className="tp-rr mt-3 flex items-center justify-between rounded-xl px-3 py-2 text-sm"><span className="text-zinc-500">Risk : reward</span><strong className="font-mono text-base">{riskToReward(trade.riskReward)}</strong></div>
        </> : null}

        <footer className="tp-actions mt-5 flex gap-2">
          <button type="button" onClick={requestClose} className="tp-reject min-h-11 flex-1 rounded-xl border border-rose-200 px-4 font-medium text-rose-700 dark:border-rose-900 dark:text-rose-300">{trade ? "Reject" : "Close"}</button>
          {trade ? <button type="button" onClick={() => onReview(analysis.mode)} className="tp-accept min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 font-semibold text-white">Accept</button> : null}
        </footer>
      </section>
    </div>, document.body,
  );
}
