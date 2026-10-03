"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import type { CurrencyStrength, PairStrength, PairStrengthSnapshot } from "@/lib/strategy/pair-strength";

/** Short labels for tight spots (the chart header). */
const GRADE_LABEL = { strong: "Trending", pullback: "Pullback", turning: "Turning", weak: "Choppy", range: "Sideways" } as const;

/** Plain-English trend, with its direction, for the pair list. */
function trendLabel(grade: keyof typeof GRADE_LABEL, direction: "up" | "down" | null) {
  if (grade === "strong") return direction === "down" ? "Trending down" : "Trending up";
  if (grade === "pullback") return direction === "down" ? "Downtrend, bouncing" : "Uptrend, dipping";
  if (grade === "turning") return direction === "down" ? "Turning down" : direction === "up" ? "Turning up" : "Turning";
  return GRADE_LABEL[grade];
}

/**
 * How far apart the two currencies' strength scores must be (in ATRs of
 * average move) before one counts as stronger, and as much stronger. Two
 * strong (or two weak) currencies sit inside the first band: they cancel out.
 * Today decides the call; the 3-day window can only veto it, when it clears
 * the same band the other way. A flat 3 days neither confirms nor blocks.
 */
const LEAN_EVEN_BELOW = 1.5;
const LEAN_MUCH_FROM = 4;

const GRADE_TITLE = {
  strong: "Trending on the 1H chart and moving with it now",
  pullback: "Trending on the 1H chart, dipping or pausing now",
  turning: "A sharp move over the last 4 hours against the trend, or where there was none",
  weak: "Moving, but not in a clean trend",
  range: "Going sideways",
} as const;

/**
 * Which currency in the pair has been stronger across the market lately, as
 * one verdict. The pair tends to rise when its first (base) currency is the
 * stronger one and fall when the second is. Null when either is unscored.
 */
function currencyLean(base: CurrencyStrength | null, quote: CurrencyStrength | null) {
  if (!base || !quote) return null;
  const gap = base.score - quote.score;
  const stronger = gap >= 0 ? base : quote;
  const weaker = gap >= 0 ? quote : base;
  const size = Math.abs(gap);
  // "Up against 6 of 7": how broad each currency's move is today.
  const breadth = (currency: CurrencyStrength) => `${currency.currency} is up against ${currency.upCount} of ${currency.pairCount} currencies today`;
  const counts = `${breadth(stronger)}; ${breadth(weaker)}.`;
  if (size < LEAN_EVEN_BELOW) {
    return {
      lean: "even" as const,
      text: "Evenly matched",
      title: `${base.currency} and ${quote.currency} have moved about the same today, so neither is pushing this pair. ${counts}`,
    };
  }
  const pairUp = gap > 0;
  // The last 3 days pointing clearly the other way means today's lead may be
  // just a bounce. Flat (or unknown) 3 days leaves today's read standing.
  const longGap = base.longScore !== null && quote.longScore !== null ? base.longScore - quote.longScore : null;
  const longOpposes = longGap !== null && Math.abs(longGap) >= LEAN_EVEN_BELOW && longGap > 0 !== pairUp;
  if (longOpposes) {
    return {
      lean: "unclear" as const,
      text: "Unclear",
      title: `${stronger.currency} has been stronger than ${weaker.currency} today, but not over the last 3 days, so the lead may not hold. ${counts}`,
    };
  }
  // "Much" needs a big lead today that the last 3 days back the same way.
  const longBacks = longGap !== null && Math.abs(longGap) >= LEAN_EVEN_BELOW;
  const much = size >= LEAN_MUCH_FROM && longGap !== null && Math.abs(longGap) >= LEAN_MUCH_FROM;
  return {
    lean: pairUp ? ("up" as const) : ("down" as const),
    text: `${stronger.currency} ${much ? "much" : "a bit"} stronger`,
    title: `${stronger.currency} has been stronger than ${weaker.currency} ${longBacks ? "today and over the last 3 days" : "today (the last 3 days were about even)"}, which tends to push ${base.currency}/${quote.currency} ${pairUp ? "up" : "down"}. ${counts}`,
  };
}

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
 * The line under a pair's name, in plain words: the trend ("Trending up",
 * "Sideways") from the 1H trend and the last 4 hours inside it, then which of
 * the pair's two currencies is stronger across the market ("AUD much
 * stronger ↑", or "Evenly matched" when they cancel out).
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
  const lean = pillOnly ? null : currencyLean(strength.base, strength.quote);
  const LeanArrow = lean?.lean === "up" ? ArrowUpRight : lean?.lean === "down" ? ArrowDownRight : null;

  return (
    <span className={`pair-strength${pillOnly ? " pair-strength--pill" : ""}`} title={GRADE_TITLE[grade]}>
      <span className="pair-strength-chip" data-tone={tone}>
        {Arrow ? <Arrow className="size-3" strokeWidth={2.4} aria-hidden /> : <span className="pair-strength-dot" aria-hidden />}
        <span className="pair-strength-label">{pillOnly ? GRADE_LABEL[grade] : trendLabel(grade, direction)}</span>
        {pillOnly && direction ? <span className="sr-only"> {direction}</span> : null}
      </span>
      {lean ? (
        <span className="pair-strength-lean" data-lean={lean.lean} title={lean.title}>
          {lean.text}
          {LeanArrow ? <LeanArrow className="size-3" strokeWidth={2.4} aria-hidden /> : null}
        </span>
      ) : null}
    </span>
  );
}
