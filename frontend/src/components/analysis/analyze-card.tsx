"use client";

/**
 * Analyze result in the Night Ledger layout: a card at the top of the chart's
 * side column on desktop, a bottom sheet on phones (the "Chart — Mobile,
 * Analyze sheet" artboard). Same data and actions as MarketAnalysisDialog:
 * Normal/Swing are two reads of one structure, and the primary action fills
 * the entry composer for review. It never places an order.
 */

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { AnalyzeIcon } from "@/components/icons/analyze-icon";
import { formatChartPrice } from "@/lib/chart-utils";
import { NO_NEWS, type AnalysisMode, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import type { AnalysisResult } from "@/lib/strategy/analyze-v2/decide";
import { useExplanation } from "@/lib/strategy/analyze-v2/explain-client";
import { AnalyzeV2Content } from "@/components/analysis/analyze-v2-panel";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import type { MajorInstrument } from "@/types/forex";

const REGIME_LABEL = { UPTREND: "Uptrend", DOWNTREND: "Downtrend", RANGE: "Range", TRANSITION: "Transition" } as const;
const ORDER_LABEL = { MARKET: "Market", BUY_LIMIT: "Buy limit", SELL_LIMIT: "Sell limit" } as const;

/** Reward/risk 2 reads "1:2", risk first, the way the plan is set. */
function ratio(rewardRisk: number) {
  const reward = Number(rewardRisk.toFixed(1));
  return `1:${Number.isInteger(reward) ? reward.toFixed(0) : reward}`;
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function subscribeMinute(onChange: () => void) {
  const timer = window.setInterval(onChange, 15_000);
  return () => window.clearInterval(timer);
}

/** New York wall-clock "10:28", refreshed every 15s; empty during SSR. */
function useEtClock() {
  return useSyncExternalStore(subscribeMinute, () => ET_TIME.format(new Date()), () => "");
}

type Props = {
  normal: MarketAnalysis | null;
  swing: MarketAnalysis | null;
  instrument: MajorInstrument;
  analyzing: boolean;
  onClose: () => void;
  onCancel: () => void;
  onReview: (mode: AnalysisMode) => void;
};

function AnalyzeBody({
  normal,
  swing,
  instrument,
  analyzing,
  onClose,
  onCancel,
  onReview,
  titleId,
  stamp = null,
}: Props & { titleId: string; /** Desktop card: the ET time the plan was read; the canvas eyebrow. */ stamp?: string | null }) {
  const card = stamp !== null;
  // Tied to the analysis it was picked on, so a new analysis starts on Normal.
  const [picked, setPicked] = useState<{ analysis: MarketAnalysis | null; mode: AnalysisMode }>({
    analysis: null,
    mode: "NORMAL",
  });

  if (analyzing || !normal) {
    return (
      <div className="nl-an-body" aria-busy="true">
        <div className="nl-an-top">
          <span className="nl-an-eyebrow">
            <AnalyzeIcon className="size-3.5" />
            Analyzing…
          </span>
          <button type="button" className="nl-an-close" onClick={onCancel} aria-label="Cancel analysis">
            <X aria-hidden="true" />
          </button>
        </div>
        <span className="nl-an-skel nl-an-skel-title" id={titleId} />
        <span className="nl-an-skel nl-an-skel-grid" />
        <span className="nl-an-skel nl-an-skel-line" />
        <span className="nl-an-skel nl-an-skel-line is-short" />
      </div>
    );
  }

  const mode: AnalysisMode = picked.analysis === normal && picked.mode === "SWING" && swing ? "SWING" : "NORMAL";
  const analysis = mode === "SWING" && swing ? swing : normal;
  const trade = analysis.trade;
  const price = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : formatChartPrice(value, instrument);
  const news = analysis.risk.news !== NO_NEWS ? analysis.risk.news : null;
  const tone = analysis.decision === "LONG" ? "is-up" : analysis.decision === "SHORT" ? "is-down" : "";
  // Legacy reads: the card explains itself; the sheet shows the plan alone.
  const showWhy = Boolean(analysis.reason) && card;
  const heading = analysis.decision === "LONG" ? "Long" : analysis.decision === "SHORT" ? "Short" : "No trade";

  const top = (
    <div className="nl-an-top">
      <span className="nl-an-eyebrow">
        <AnalyzeIcon className="size-3.5" />
        {card ? `Analyze${stamp ? ` · ${stamp} ET` : ""}` : "Trade plan"}
      </span>
      <div className="nl-an-top-end">
        <div className="nl-an-modes" role="radiogroup" aria-label="Stop mode">
          {(["NORMAL", "SWING"] as const).map((option) => {
            const read = option === "SWING" ? swing : normal;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                disabled={!read}
                className={mode === option ? "is-active" : ""}
                onClick={() => setPicked({ analysis: normal, mode: option })}
              >
                {option === "NORMAL" ? "Normal" : "Swing"}
              </button>
            );
          })}
        </div>
        {card ? null : (
          <button type="button" className="nl-an-close" onClick={onClose} aria-label="Close analysis">
            <X aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
  const actions = (
    <div className={`nl-an-actions${card ? " is-card" : ""}`}>
      <button type="button" className="nl-an-secondary pressable" onClick={onClose}>
        {trade ? "Dismiss" : "Close"}
      </button>
      {trade ? (
        <button type="button" className="nl-an-primary pressable" onClick={() => onReview(analysis.mode)}>
          Review entry
        </button>
      ) : null}
    </div>
  );

  if (analysis.v2) {
    return (
      <div className="nl-an-body">
        {top}
        {/* Only this part scrolls in the sheet; the top bar and buttons stay put. */}
        <div className="nl-an-scroll">
          <AnalyzeV2Content result={analysis.v2} titleId={titleId} />
          <AnalyzeExplanation result={analysis.v2} />
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className="nl-an-body">
      {top}

      <div className="nl-an-head">
        <h2 id={titleId} className={`nl-an-decision ${tone}`}>
          {heading}
        </h2>
        {trade ? <span className="nl-an-ratio">{ratio(trade.riskReward)}</span> : null}
      </div>

      {card ? null : (
        <p className="nl-an-regime">
          {REGIME_LABEL[analysis.regime]} · {analysis.regimeConfidence.toLowerCase()} confidence
        </p>
      )}

      {trade ? (
        <>
          <dl className="nl-an-levels">
            <div>
              <dt>{ORDER_LABEL[trade.orderType]}</dt>
              <dd className="metric-number">{price(trade.entry)}</dd>
            </div>
            <div>
              <dt>Stop</dt>
              <dd className="metric-number is-down">{price(trade.stopLoss)}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd className="metric-number is-up">{price(trade.takeProfit)}</dd>
            </div>
          </dl>

          <dl className="nl-an-rows">
            <div>
              <dt>Stop distance</dt>
              <dd className="metric-number">{trade.stopPips} pips</dd>
            </div>
            <div>
              <dt>Target distance</dt>
              <dd className="metric-number">{trade.targetPips} pips</dd>
            </div>
            <div>
              <dt>{trade.orderType === "MARKET" ? "Fills" : "Chance to fill"}</dt>
              <dd className="metric-number">{trade.orderType === "MARKET" ? "Now" : `~${trade.fillChancePct}%`}</dd>
            </div>
          </dl>
        </>
      ) : null}

      {showWhy || news || (trade && analysis.warnings.length > 0) ? (
        <div className="nl-an-notes">
          {showWhy ? (
            <p>
              <span>Why · </span>
              {analysis.reason}
            </p>
          ) : null}
          {news ? (
            <p className="is-caution" role="alert">
              <span>News · </span>
              {news}
            </p>
          ) : null}
          {trade && analysis.warnings.length ? (
            <ul className="is-caution" role="alert">
              {analysis.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {actions}
    </div>
  );
}

/**
 * The AI explanation of a V2 result. It loads after the analysis is already
 * on screen, and when it is unavailable or rejected the analysis stands alone.
 */
function AnalyzeExplanation({ result }: { result: AnalysisResult }) {
  const state = useExplanation(result);
  if (!state) return null;
  if (state.status === "loading") return <p className="nl-an-explain is-muted" aria-live="polite">Writing the explanation…</p>;
  if (state.status === "unavailable") return <p className="nl-an-explain is-muted">Explanation unavailable; the analysis above is complete.</p>;
  const { explanation } = state;
  const parts = [
    ["Direction", explanation.direction],
    ["Location", explanation.location],
    ["Support", explanation.support],
    ["Risks", explanation.risks],
    [result.decision === "NO_TRADE" ? "Watch" : "Stop and target", explanation.levels],
  ] as const;
  return (
    <div className="nl-an-explain" aria-live="polite">
      <span className="nl-an-explain-head">
        <Sparkles aria-hidden="true" />
        AI explanation
      </span>
      <p>{explanation.summary}</p>
      <details>
        <summary>More detail</summary>
        <dl>
          {parts.map(([label, text]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </details>
      <span className="nl-an-explain-note">Written by AI from the checks above; it cannot change them.</span>
    </div>
  );
}

/**
 * Desktop: always the first card in the chart's side column. Before a read it
 * offers Analyze and a blank entry; after one it shows the plan, stamped with
 * the New York time it was read.
 */
export function AnalyzeCard({
  onAnalyze,
  onNewEntry,
  analyzeDisabled = false,
  ...props
}: Props & { onAnalyze: () => void; onNewEntry: () => void; analyzeDisabled?: boolean }) {
  const clock = useEtClock();
  // Stamp each new result with the clock at the render it arrived on.
  const [stamped, setStamped] = useState<{ analysis: MarketAnalysis | null; at: string }>({ analysis: null, at: "" });
  if (props.normal && stamped.analysis !== props.normal) setStamped({ analysis: props.normal, at: clock });
  const stamp = props.normal && stamped.analysis === props.normal ? stamped.at : clock;

  if (!props.analyzing && !props.normal) {
    return (
      <section className="nl-an-card" aria-labelledby="nl-an-card-title">
        <div className="nl-an-body">
          <div className="nl-an-top">
            <span className="nl-an-eyebrow">
              <AnalyzeIcon className="size-3.5" />
              Analyze{clock ? ` · ${clock} ET` : ""}
            </span>
          </div>
          <h2 id="nl-an-card-title" className="nl-an-decision">
            No plan yet
          </h2>
          <div className="nl-an-actions is-card">
            <button type="button" className="nl-an-secondary pressable" onClick={onNewEntry} disabled={analyzeDisabled}>
              New entry
            </button>
            <button type="button" className="nl-an-primary pressable" onClick={onAnalyze} disabled={analyzeDisabled}>
              Analyze
            </button>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="nl-an-card" aria-labelledby="nl-an-card-title">
      <AnalyzeBody {...props} titleId="nl-an-card-title" stamp={stamp} />
    </section>
  );
}

/** Phone: a bottom sheet over the dimmed chart; drag the grip to dismiss. */
export function AnalyzeSheet(props: Props) {
  const open = props.analyzing || props.normal !== null;
  const { setSheet, setBackdrop, handlers, requestClose } = useDragToDismiss({
    open,
    onDismiss: props.analyzing ? props.onCancel : props.onClose,
    handleSelector: ".nl-an-grip, .nl-an-top",
  });
  if (!open) return null;
  return createPortal(
    <div
      ref={setBackdrop}
      className="nl-an-backdrop"
      data-pull-to-refresh-ignore="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={setSheet}
        className="nl-an-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nl-an-sheet-title"
        {...handlers}
      >
        <div className="nl-an-grip" aria-hidden="true" />
        <AnalyzeBody
          {...props}
          onClose={requestClose}
          onCancel={requestClose}
          titleId="nl-an-sheet-title"
        />
      </section>
    </div>,
    document.body,
  );
}
