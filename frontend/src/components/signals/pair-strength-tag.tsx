"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { apiUrl } from "@/lib/api/url";
import type { CurrencyStrength, PairStrength, PairStrengthSnapshot } from "@/lib/strategy/pair-strength";

/** Short labels for tight spots (the chart header), in the pair list's plain words. */
const GRADE_LABEL = { strong: "Trending", pullback: "Pausing", turning: "Fast move", weak: "No trend", range: "Flat" } as const;

function pillLabel(grade: keyof typeof GRADE_LABEL, direction: "up" | "down" | null) {
  if (grade === "strong" && direction) return direction === "down" ? "Going down" : "Going up";
  return GRADE_LABEL[grade];
}

/**
 * The pair list's one-line read, in words for someone new to trading. It merges
 * the 1H trend with which of the two currencies is stronger: a clean trend
 * reads plainly ("Price going up") only when the stronger currency pushes the
 * same way; otherwise it adds "but weakly". Chop and sideways say outright there
 * is no clear direction. It describes the recent move; it is not a forecast.
 */
function verdict(
  grade: keyof typeof GRADE_LABEL,
  direction: "up" | "down" | null,
  lean: ReturnType<typeof currencyLean>,
): { text: string; tone: string } {
  const going = direction === "down" ? "Price going down" : "Price going up";
  if (grade === "strong" && direction) {
    return lean?.lean === direction
      ? { text: going, tone: `strong-${direction}` }
      : { text: `${going}, but weakly`, tone: `pullback-${direction}` };
  }
  if (grade === "pullback" && direction) {
    return { text: direction === "down" ? "Price going down, small rise now" : "Price going up, small drop now", tone: `pullback-${direction}` };
  }
  if (grade === "turning") {
    return { text: direction === "down" ? "Price just dropped fast" : direction === "up" ? "Price just jumped fast" : "Price just moved fast", tone: "turning" };
  }
  if (grade === "range") return { text: "Price barely moving", tone: "range" };
  return { text: "Price jumping around, no trend", tone: "weak" };
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
  strong: "The price has been moving one way on the hourly chart and is still moving that way",
  pullback: "The price has been moving one way on the hourly chart, but for the last few hours it has moved back a little the other way",
  turning: "A sudden move in the last 4 hours, against the earlier direction or out of a flat market",
  weak: "The price keeps going up and down without settling on a direction",
  range: "The price has stayed between the same high and low",
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
 * The line under a pair's name: one plain-words read about the price
 * ("Price going up", "Price jumping around, no trend") from the 1H trend, the last 4 hours inside it,
 * and which of the pair's two currencies is stronger across the market. The
 * tooltip keeps both underlying reads.
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
  const lean = currencyLean(strength.base, strength.quote);
  const read = verdict(grade, direction, lean);
  // The chart header keeps its short pill; the colours follow the full read.
  const tone = pillOnly
    ? (grade === "strong" || grade === "pullback") && direction ? `${grade}-${direction}` : grade
    : read.tone;
  const Arrow = (grade === "range" || grade === "weak") ? null
    : direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : null;
  const title = pillOnly || !lean ? GRADE_TITLE[grade] : `${GRADE_TITLE[grade]}. ${lean.text}: ${lean.title}`;

  return (
    <span className={`pair-strength${pillOnly ? " pair-strength--pill" : ""}`} title={title}>
      <span className="pair-strength-chip" data-tone={tone}>
        {Arrow ? <Arrow className="size-3" strokeWidth={2.4} aria-hidden /> : <span className="pair-strength-dot" aria-hidden />}
        <span className="pair-strength-label">{pillOnly ? pillLabel(grade, direction) : read.text}</span>
        {pillOnly && direction ? <span className="sr-only"> {direction}</span> : null}
      </span>
    </span>
  );
}
