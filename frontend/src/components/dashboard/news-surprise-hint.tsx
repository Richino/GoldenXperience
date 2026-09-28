"use client";

import type { NewsSurpriseHint, TrendDirection } from "@/lib/news/surprise-hint";
import { describeNewsSurpriseHint } from "@/lib/news/surprise-hint";

function MiniTrendLine({ direction }: { direction: TrendDirection }) {
  const rising = direction === "up";
  return (
    <svg className="home-rail-news-trend" viewBox="0 0 22 10" aria-hidden="true">
      <polyline
        points={rising ? "1,9 7,4 12,5 21,1" : "1,1 7,6 12,5 21,9"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HintLeg({
  direction,
  label,
}: {
  direction: TrendDirection;
  label: string;
}) {
  return (
    <span className={`home-rail-news-hint-leg is-${direction}`}>
      <MiniTrendLine direction={direction} />
      <span>{label}</span>
    </span>
  );
}

export function NewsSurpriseHintDisplay({ hint }: { hint: NewsSurpriseHint }) {
  const description = describeNewsSurpriseHint(hint);
  if (!description || hint.kind === "unknown") return null;

  const title =
    "Typical reaction if the print beats or misses forecast — not a prediction.";

  if (hint.kind === "after") {
    if (hint.outcome === "inline" || hint.direction === "flat") {
      return (
        <p className="home-rail-news-hint is-neutral" title={title}>
          On forecast
        </p>
      );
    }
    const direction = hint.direction;
    return (
      <p
        className={`home-rail-news-hint is-single is-${direction}`}
        title={title}
        aria-label={description}
      >
        <MiniTrendLine direction={direction} />
        <span>{hint.outcome === "beat" ? "Beat" : "Miss"}</span>
      </p>
    );
  }

  return (
    <p className="home-rail-news-hint" title={title} aria-label={description}>
      <HintLeg direction={hint.beatDirection} label="beat" />
      <span className="home-rail-news-hint-sep" aria-hidden="true">
        ·
      </span>
      <HintLeg direction={hint.missDirection} label="miss" />
    </p>
  );
}
