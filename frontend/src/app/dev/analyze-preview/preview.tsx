"use client";

import { useMemo } from "react";
import { AnalyzeCard } from "@/components/analysis/analyze-card";
import { toMarketAnalysis } from "@/lib/strategy/analyze-v2/adapter";
import { primeExplanation } from "@/lib/strategy/analyze-v2/explain-client";
import { previewResults } from "./fixtures";

const noop = () => {};

/** Every Analyze V2 state side by side, from synthetic candles. Explanations are canned; no AI call is made. */
export function AnalyzePreview() {
  const cases = useMemo(() => {
    const results = previewResults();
    primeExplanation(results.long, {
      status: "ready",
      explanation: {
        decision: "LONG",
        summary: "The M15 uptrend pulled back into 1.10610–1.10620 and a closed candle confirmed the turn, with H1 also trending up.",
        direction: "Both M15 swing highs and lows are rising, and H1 agrees.",
        location: "Price reacted inside the old high, which now acts as support.",
        support: "Both timeframes trend the same way and no check blocks the entry.",
        risks: "A bid at 1.10492 ends the trade; the spread is 7% of the risk.",
        levels: "The stop sits below the higher low; the target is the 1.5R minimum.",
      },
    });
    primeExplanation(results.short, { status: "loading" });
    primeExplanation(results.watching, { status: "unavailable", reason: "preview" });
    primeExplanation(results.conflict, { status: "unavailable", reason: "preview" });
    primeExplanation(results.noNews, { status: "unavailable", reason: "preview" });
    return [
      ["LONG", results.long],
      ["SHORT (explanation loading)", results.short],
      ["NO TRADE · waiting for confirmation", results.watching],
      ["NO TRADE · higher TF conflict + news", results.conflict],
      ["NO TRADE · calendar unknown", results.noNews],
    ] as const;
  }, []);
  return (
    <main style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: 24, alignItems: "flex-start" }}>
      {cases.map(([label, result]) => (
        <div key={label} style={{ width: 340, display: "flex", flexDirection: "column", gap: 8 }} data-preview={label}>
          <span className="nl-v2-label">{label}</span>
          <AnalyzeCard
            normal={toMarketAnalysis(result)}
            swing={null}
            instrument="EUR_USD"
            analyzing={false}
            onClose={noop}
            onCancel={noop}
            onReview={noop}
            onAnalyze={noop}
            onNewEntry={noop}
          />
        </div>
      ))}
    </main>
  );
}
