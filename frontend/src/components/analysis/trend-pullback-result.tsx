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
  const validPlan = result.status !== "NO_VALID_ENTRY";
  const directionTone = result.action === "LONG" ? "text-emerald-600" : "text-rose-600";
  const status = result.status === "ENTRY_AVAILABLE_NOW" ? "Entry available now" : result.currentMove === "NONE" ? "Next pullback level" : "Planned pullback entry";
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" data-pull-to-refresh-ignore="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100" role="dialog" aria-modal="true" aria-labelledby="trend-pullback-title">
        <header className="flex items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">TrendPullbackV1 · M15</p><h2 id="trend-pullback-title" className="mt-1 text-xl font-semibold">{validPlan ? status : "No trade plan"}</h2></div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-xl" aria-label="Close analysis">×</button>
        </header>
        {validPlan ? <>
          <div className="mt-5 rounded-2xl bg-zinc-100 p-4 dark:bg-zinc-900"><div className="flex items-baseline justify-between gap-3"><span className={`text-2xl font-bold ${directionTone}`}>{result.action}</span><span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{result.priceBasis === "LAST_M15_CLOSE" ? "Reference only" : result.orderType ?? "Market entry"}</span></div><p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Entry</p><p className="mt-1 font-mono text-3xl font-bold tracking-tight">{format(result.entry)}</p><p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">Zone {format(result.entryZoneLow)} – {format(result.entryZoneHigh)} · {result.distanceToEntryPips?.toFixed(1) ?? "—"} pips away</p></div>
          <dl className="mt-3 grid grid-cols-2 gap-2"><div className="rounded-xl border border-rose-200 p-3 dark:border-rose-950"><dt className="text-[11px] font-semibold uppercase tracking-wide text-rose-600">Stop loss</dt><dd className="mt-1 font-mono text-base font-semibold">{format(result.stopLoss)}</dd><dd className="mt-1 text-xs text-zinc-500">{result.stopDistancePips?.toFixed(1) ?? "—"} pips risk</dd></div><div className="rounded-xl border border-sky-200 p-3 dark:border-sky-950"><dt className="text-[11px] font-semibold uppercase tracking-wide text-sky-600">Take profit</dt><dd className="mt-1 font-mono text-base font-semibold">{format(result.takeProfit)}</dd><dd className="mt-1 text-xs text-zinc-500">{result.targetDistancePips?.toFixed(1) ?? "—"} pips reward</dd></div></dl>
          <div className="mt-3 flex items-center justify-between rounded-xl px-3 py-2 text-sm"><span className="text-zinc-500">Risk / reward</span><strong className="font-mono text-base">{result.riskReward?.toFixed(2) ?? "—"}:1</strong></div>
          {result.currentMove === "NONE" ? <p className="mt-2 text-xs text-zinc-500">Pullback not active yet. This is a planned level.</p> : null}
          {result.priceBasis === "LAST_M15_CLOSE" ? <p className="mt-2 text-xs text-amber-600">Using the last completed M15 close. Refresh prices before trading.</p> : null}
        </> : <div className="mt-5 rounded-2xl bg-zinc-100 p-4 text-sm leading-6 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">{result.entry !== null ? <p className="mb-2 font-mono text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{format(result.entry)}</p> : null}{result.reasons[0] ?? "TrendPullbackV1 could not form a valid setup."}</div>}
        {process.env.NODE_ENV === "development" ? <details className="mt-4 text-xs"><summary className="cursor-pointer font-semibold">Debug values</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">{JSON.stringify(result.debug, null, 2)}</pre></details> : null}
        <footer className="mt-5 flex gap-2"><button type="button" onClick={onClose} className="min-h-11 flex-1 rounded-xl border border-zinc-300 px-4 dark:border-zinc-700">Close</button>{validPlan && result.priceBasis === "LIVE_QUOTE" && <button type="button" onClick={onReview} className="min-h-11 flex-1 rounded-xl bg-emerald-600 px-4 font-semibold text-white">Review trade</button>}</footer>
      </section>
    </div>, document.body,
  );
}
