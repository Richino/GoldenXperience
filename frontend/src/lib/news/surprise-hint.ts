import { eventCurrencyPolarity } from "@/lib/news/event-polarity";

export type CalendarValueFields = {
  title: string;
  currency: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
};

export type TrendDirection = "up" | "down";

export type NewsSurpriseHint =
  | { kind: "unknown" }
  | {
      kind: "before";
      currency: string;
      beatDirection: TrendDirection;
      missDirection: TrendDirection;
    }
  | {
      kind: "after";
      currency: string;
      outcome: "beat" | "miss" | "inline";
      direction: TrendDirection | "flat";
    };

/** Parse ForexFactory-style values (220K, 0.3%, -1.2M). */
export function parseCalendarValue(raw: string | null): number | null {
  if (!raw?.trim()) return null;
  let s = raw.trim().replace(/,/g, "").replace(/\s+/g, "");
  if (!s || s === "—" || s === "-") return null;

  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1);
  }

  const suffix = s.slice(-1).toUpperCase();
  let multiplier = 1;
  if (suffix === "K") {
    multiplier = 1_000;
    s = s.slice(0, -1);
  } else if (suffix === "M") {
    multiplier = 1_000_000;
    s = s.slice(0, -1);
  } else if (suffix === "B") {
    multiplier = 1_000_000_000;
    s = s.slice(0, -1);
  } else if (suffix === "T") {
    multiplier = 1_000_000_000_000;
    s = s.slice(0, -1);
  }

  const value = Number(s);
  if (!Number.isFinite(value)) return null;
  return value * multiplier * (percent ? 0.01 : 1);
}

/**
 * Home calendar hint: before release we show beat/miss lenses, not a prediction.
 * After actual is known we compare to forecast when both parse as numbers.
 */
export function newsSurpriseHint(event: CalendarValueFields): NewsSurpriseHint {
  const polarity = eventCurrencyPolarity(event.title);
  if (polarity === null) return { kind: "unknown" };

  const forecast = parseCalendarValue(event.forecast);
  const actual = parseCalendarValue(event.actual);

  if (actual !== null && forecast !== null) {
    const delta = actual - forecast;
    const epsilon = Math.max(Math.abs(forecast) * 0.001, 1e-9);
    const outcome =
      delta > epsilon ? "beat" : delta < -epsilon ? "miss" : "inline";
    if (outcome === "inline") {
      return {
        kind: "after",
        currency: event.currency,
        outcome,
        direction: "flat",
      };
    }
    const surpriseSign = outcome === "beat" ? 1 : -1;
    const direction = polarity * surpriseSign > 0 ? "up" : "down";
    return {
      kind: "after",
      currency: event.currency,
      outcome,
      direction,
    };
  }

  const beatDirection: TrendDirection = polarity > 0 ? "up" : "down";
  const missDirection: TrendDirection = polarity > 0 ? "down" : "up";
  return {
    kind: "before",
    currency: event.currency,
    beatDirection,
    missDirection,
  };
}

/**
 * A first-pass call on whether a release will beat or miss, from the only data
 * the calendar carries: previous vs forecast. Consensus forecasts tend to lag,
 * so the print is assumed to land nearer the previous reading — a previous above
 * forecast leans "beat", below leans "miss". Equal values give no call.
 * Deliberately simple; expect it to be wrong often.
 */
export function predictSurprise(event: CalendarValueFields): "beat" | "miss" | null {
  const forecast = parseCalendarValue(event.forecast);
  const previous = parseCalendarValue(event.previous);
  if (forecast === null || previous === null) return null;
  const epsilon = Math.max(Math.abs(forecast) * 0.001, 1e-9);
  const delta = previous - forecast;
  if (Math.abs(delta) <= epsilon) return null;
  return delta > 0 ? "beat" : "miss";
}

/** Screen-reader / tooltip text when the visual uses trend lines. */
export function describeNewsSurpriseHint(hint: NewsSurpriseHint): string | null {
  switch (hint.kind) {
    case "unknown":
      return null;
    case "before":
      return `${hint.beatDirection === "up" ? "Up" : "Down"} if beat · ${hint.missDirection === "up" ? "Up" : "Down"} if miss`;
    case "after":
      if (hint.outcome === "inline") return "On forecast";
      return `${hint.outcome === "beat" ? "Beat" : "Miss"} · ${hint.direction === "up" ? "Up" : "Down"}`;
    default: {
      hint satisfies never;
      return null;
    }
  }
}
