import type { CheckStatus } from "@/lib/strategy/analyze-v2/data-quality";
import type { AnalyzeMode } from "@/lib/strategy/analyze-v2/config";
import type { Candle } from "@/types/forex";

/**
 * Event and volatility risk for a new entry.
 *
 * News: events for either currency of the pair. A calendar that could not be
 * read is NEWS_UNKNOWN (status UNKNOWN), never "no news". Initial buffers,
 * which are operating safeguards, not measured optimal windows:
 *
 *   high impact   block from `blockBeforeMin` before to `blockAfterMin` after
 *   medium impact caution inside the same window
 *
 * Swing trades are held across ordinary releases, so for SWING only a
 * high-impact release inside the block window blocks; later releases in the
 * holding period are listed as exposure, not blocked.
 *
 * Volatility: the last closed candle's true range against ATR, and the gap
 * between its open and the previous close. ATR measures movement, not
 * direction.
 */

export interface NewsItem {
  title: string;
  currency: string;
  /** 3 high, 2 medium, 1 low (calendar.ts scale). */
  impact: number;
  timestamp: string;
}

export const RISK_POLICY = {
  news: {
    /**
     * When the calendar cannot be read: true keeps it UNKNOWN, which blocks
     * new entries (the spec's preferred policy); false downgrades it to a
     * caution so a plan can still be offered with the gap stated.
     */
    blockWhenUnknown: true,
    blockBeforeMin: 30,
    blockAfterMin: 15,
    highImpact: 3,
    mediumImpact: 2,
    /** Window listed as exposure (not blocking), by mode. */
    exposureHours: { NORMAL: 6, SWING: 72 } as Record<AnalyzeMode, number>,
  },
  volatility: {
    /** Last candle's range above this many ATRs is a caution... */
    cautionRangeAtr: 2.5,
    /** ...and above this, new entries are blocked. */
    blockRangeAtr: 4,
    /** An open this many ATRs from the previous close is a gap. */
    gapAtr: 1,
  },
} as const;

export interface NewsEventRisk {
  title: string;
  currency: string;
  impact: number;
  at: string;
  /** Negative = minutes since release. */
  minutesUntil: number;
  /** Inside the block window around the release. */
  blocking: boolean;
}

export interface NewsRisk {
  status: CheckStatus;
  /** NEWS_UNKNOWN when the calendar could not be read. */
  state: "CLEAR" | "CAUTION" | "BLOCKED" | "NEWS_UNKNOWN";
  reason: string;
  events: NewsEventRisk[];
}

/** `events` null means the calendar was unavailable. */
export function assessNews(instrument: string, events: NewsItem[] | null, now: number, mode: AnalyzeMode): NewsRisk {
  if (events === null) {
    return {
      status: RISK_POLICY.news.blockWhenUnknown ? "UNKNOWN" : "CAUTION",
      state: "NEWS_UNKNOWN",
      reason: "The economic calendar could not be read; upcoming news is unknown. Check it yourself before trading.",
      events: [],
    };
  }
  const policy = RISK_POLICY.news;
  const [base, quote] = instrument.split("_");
  const relevant = events
    .filter((event) => (event.currency === base || event.currency === quote) && event.impact >= policy.mediumImpact)
    .map((event) => {
      const at = Date.parse(event.timestamp);
      const minutesUntil = Math.round((at - now) / 60_000);
      return {
        title: event.title,
        currency: event.currency,
        impact: event.impact,
        at: Number.isFinite(at) ? new Date(at).toISOString() : event.timestamp,
        minutesUntil,
        blocking: Number.isFinite(at) && minutesUntil <= policy.blockBeforeMin && minutesUntil >= -policy.blockAfterMin,
      };
    })
    .filter((event) => Number.isFinite(Date.parse(event.at))
      && event.minutesUntil >= -policy.blockAfterMin
      && event.minutesUntil <= policy.exposureHours[mode] * 60)
    .sort((a, b) => a.minutesUntil - b.minutesUntil);
  const when = (event: NewsEventRisk) => event.minutesUntil >= 0 ? `in ${event.minutesUntil} min` : `${-event.minutesUntil} min ago`;
  const highBlock = relevant.find((event) => event.blocking && event.impact >= policy.highImpact);
  if (highBlock) {
    return {
      status: "FAIL",
      state: "BLOCKED",
      reason: `High-impact ${highBlock.currency} ${highBlock.title} ${when(highBlock)}: no new entries from ${policy.blockBeforeMin} min before to ${policy.blockAfterMin} min after.`,
      events: relevant,
    };
  }
  const mediumNear = relevant.find((event) => event.blocking);
  if (mediumNear) {
    return { status: "CAUTION", state: "CAUTION", reason: `Medium-impact ${mediumNear.currency} ${mediumNear.title} ${when(mediumNear)}.`, events: relevant };
  }
  const nextHigh = relevant.find((event) => event.impact >= policy.highImpact && event.minutesUntil > 0);
  if (nextHigh) {
    return {
      status: "CAUTION",
      state: "CAUTION",
      reason: `High-impact ${nextHigh.currency} ${nextHigh.title} ${when(nextHigh)}, inside the ${mode === "SWING" ? "swing" : "day-trade"} holding window. A release does not tell you its direction.`,
      events: relevant,
    };
  }
  return { status: "PASS", state: "CLEAR", reason: `No medium- or high-impact ${base}/${quote} news in the next ${policy.exposureHours[mode]}h.`, events: relevant };
}

export interface VolatilityRisk {
  status: CheckStatus;
  reason: string;
  /** Last closed candle's true range in ATRs. */
  rangeAtr: number | null;
  gapAtr: number | null;
}

export function assessVolatility(closed: Candle[], atr: number): VolatilityRisk {
  const last = closed.at(-1);
  const previous = closed.at(-2);
  if (!last || !previous || !(atr > 0)) return { status: "UNKNOWN", reason: "Not enough candles to judge volatility.", rangeAtr: null, gapAtr: null };
  const policy = RISK_POLICY.volatility;
  const trueRange = Math.max(last.high, previous.close) - Math.min(last.low, previous.close);
  const rangeAtr = trueRange / atr;
  const gapAtr = Math.abs(last.open - previous.close) / atr;
  if (rangeAtr > policy.blockRangeAtr) {
    return { status: "FAIL", reason: `The last candle ranged ${rangeAtr.toFixed(1)} ATR: abnormal volatility.`, rangeAtr, gapAtr };
  }
  const notes: string[] = [];
  if (rangeAtr > policy.cautionRangeAtr) notes.push(`last candle ranged ${rangeAtr.toFixed(1)} ATR`);
  if (gapAtr > policy.gapAtr) notes.push(`opened ${gapAtr.toFixed(1)} ATR from the previous close (gap)`);
  if (notes.length) return { status: "CAUTION", reason: `Elevated volatility: ${notes.join("; ")}.`, rangeAtr, gapAtr };
  return { status: "PASS", reason: `Normal volatility (last candle ${rangeAtr.toFixed(1)} ATR).`, rangeAtr, gapAtr };
}
