"use client";

import { createPortal } from "react-dom";
import { formatChartPrice } from "@/lib/chart-utils";
import type { TrendPullbackV1Result } from "@/lib/strategy/trend-pullback-v1";
import type { MajorInstrument } from "@/types/forex";

export function TrendPullbackResultDialog({ result, instrument, analyzing = false, onClose, onCancel, onReview }: {
  result: TrendPullbackV1Result | null;
  instrument: MajorInstrument;
  analyzing?: boolean;
  onClose: () => void;
  onCancel: () => void;
  onReview: () => void;
}) {
  if (!result && !analyzing) return null;
  if (analyzing) return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" data-pull-to-refresh-ignore="true">
      <section className="w-full max-w-sm rounded-2xl bg-white p-6 text-center text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="trend-pullback-title">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">TrendPullbackV1</p>
        <h2 id="trend-pullback-title" className="mt-2 text-xl font-semibold">Analyzing chart</h2>
        <div className="mx-auto mt-5 size-8 animate-spin rounded-full border-4 border-zinc-200 border-t-emerald-600 dark:border-zinc-800" aria-label="Analyzing" />
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-300">Loading fresh M15 candles and the current OANDA price.</p>
        <button type="button" onClick={onCancel} className="mt-6 min-h-11 w-full rounded-xl border border-zinc-300 px-4 font-medium dark:border-zinc-700">Cancel</button>
      </section>
    </div>, document.body,
  );
  if (!result) return null;
  const format = (price: number | null) => price === null ? "—" : formatChartPrice(price, instrument);
  const fields = [
    ["Trend", result.trend], ["MAJOR", result.majorTrend], ["CURRENT", result.currentTrend],
    ["Pullback", result.currentMove === "NONE" ? "NONE" : result.currentMove.replace("_PULLBACK", " / PULLBACK")],
    ["Trade", result.action ?? "—"], ["Order", result.orderType ?? (result.status === "ENTRY_AVAILABLE_NOW" ? "ENTRY AVAILABLE NOW" : "—")],
    ["Current price", format(result.currentPrice)], ["Entry", format(result.entry)],
    ["Entry zone", result.entryZoneLow === null ? "—" : `${format(result.entryZoneLow)} – ${format(result.entryZoneHigh)}`],
    ["Distance to entry", result.distanceToEntryPips === null ? "—" : `${result.distanceToEntryPips.toFixed(1)} pips`],
    ["SL", format(result.stopLoss)], ["Risk", result.stopDistancePips === null ? "—" : `${result.stopDistancePips.toFixed(1)} pips`],
    ["TP", format(result.takeProfit)], ["Reward", result.targetDistancePips === null ? "—" : `${result.targetDistancePips.toFixed(1)} pips`],
    ["Risk / reward", result.riskReward === null ? "—" : `${result.riskReward.toFixed(2)}:1`],
  ];
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="trend-pullback-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">TrendPullbackV1</p><h2 id="trend-pullback-title" className="text-xl font-semibold">{result.status === "NO_VALID_ENTRY" ? "No valid pullback entry" : result.status === "ENTRY_AVAILABLE_NOW" ? "Entry available now" : "Planned pullback trade"}</h2></div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xl" aria-label="Close analysis">×</button>
        </header>
        <dl className="grid grid-cols-2 gap-2">{fields.map(([label, value]) => <div key={label} className="rounded-xl bg-zinc-100 p-3 dark:bg-zinc-900"><dt className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</dt><dd className="mt-1 font-mono text-sm font-semibold">{value}</dd></div>)}</dl>
        <div className="mt-4"><h3 className="text-sm font-semibold">Why this entry</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">{result.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
        {process.env.NODE_ENV === "development" ? <details className="mt-4 text-xs"><summary className="cursor-pointer font-semibold">Debug values</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">{JSON.stringify(result.debug, null, 2)}</pre></details> : null}
        <footer className="mt-5 flex gap-2"><button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-zinc-300 px-4 dark:border-zinc-700">Close</button>{result.entry !== null && <button type="button" onClick={onReview} className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 font-semibold text-white">Review trade draft</button>}</footer>
      </section>
    </div>, document.body,
  );
}
