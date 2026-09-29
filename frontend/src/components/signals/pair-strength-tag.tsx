"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import type { CurrencyStrength, PairStrength, PairStrengthSnapshot } from "@/lib/strategy/pair-strength";

const GRADE_LABEL = { strong: "Strong", pullback: "Pullback", turning: "Turning", weak: "Weak", range: "Range" } as const;

const GRADE_TITLE = {
  strong: "Trending on the 1H chart and moving with it now",
  pullback: "Trending on the 1H chart, dipping or pausing now",
  turning: "A sharp move over the last 4 hours against the trend, or where there was none",
  weak: "Moving, but not in a clean trend",
  range: "Going sideways",
} as const;

/**
 * Trend quality and currency strength for every featured pair, read whenever
 * `enabled` turns on and then every `refreshMs` while it stays on (the API
 * shares one snapshot for a minute). The last read stays in place if a
 * refresh fails; nothing that shows it depends on it.
 */
export function usePairStrength(enabled: boolean, refreshMs?: number) {
  const [byInstrument, setByInstrument] = useState<ReadonlyMap<string, PairStrength>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      void fetch(apiUrl("/api/pair-strength"), { credentials: "include", signal: controller.signal })
        .then((response) => (response.ok ? (response.json() as Promise<PairStrengthSnapshot>) : null))
        .then((snapshot) => {
          if (snapshot) setByInstrument(new Map(snapshot.pairs.map((pair) => [pair.instrument, pair])));
        })
        .catch(() => {
          // Keep the last read.
        });
    };
    load();
    const timer = refreshMs ? window.setInterval(load, refreshMs) : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, refreshMs]);

  return byInstrument;
}

/**
 * The line under a pair's name: one pill combining the 1H trend with what the
 * last 4 hours are doing inside it, then whichever of its two currencies
 * stands out as strong or weak across the other pairs. Neutral currencies are
 * omitted.
 */
export function PairStrengthTag({
  strength,
  pillOnly = false,
}: {
  strength: PairStrength;
  /** Just the trend pill, for tight spots like the chart header. */
  pillOnly?: boolean;
}) {
  const { grade, direction } = strength.trend;
  const tone = (grade === "strong" || grade === "pullback") && direction ? `${grade}-${direction}` : grade;
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  const standouts = [strength.base, strength.quote].filter(
    (currency): currency is CurrencyStrength => currency !== null && currency.tier !== "neutral",
  );

  return (
    <span className={`pair-strength${pillOnly ? " pair-strength--pill" : ""}`} title={GRADE_TITLE[grade]}>
      <span className="pair-strength-chip" data-tone={tone}>
        {Arrow ? <Arrow className="size-3" strokeWidth={2.4} aria-hidden /> : <span className="pair-strength-dot" aria-hidden />}
        <span className="pair-strength-label">{GRADE_LABEL[grade]}</span>
        {direction ? <span className="sr-only"> {direction}</span> : null}
      </span>
      {pillOnly ? null : standouts.map((currency) => (
        <span key={currency.currency} className="pair-strength-currency">
          {currency.currency} <span data-tier={currency.tier}>{currency.tier}</span>
        </span>
      ))}
    </span>
  );
}
