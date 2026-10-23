import type { TrendDirection } from "@/lib/strategy/analyze-v2/structure";

type SwingTrendStatus = { label: string; tone: "up" | "down" | "mixed" | "neutral"; detail: string };

/** Multi-day context, not an entry setup or a prediction of the next move. */
export function swingTrendStatus(daily: TrendDirection | null, h4: TrendDirection | null): SwingTrendStatus {
  if (!daily || !h4) return {
    label: !daily && !h4 ? "Swing unavailable" : !daily ? "Daily unavailable" : "4H unavailable",
    tone: "neutral",
    detail: "Both Daily and 4-hour data are needed for the multi-day swing view.",
  };
  if (daily === "TRANSITION") return { label: "Daily structure changing", tone: "mixed", detail: "Daily structure has broken. A new multi-day direction is not confirmed." };
  if (daily === "UNCLEAR") return { label: "Swing direction unclear", tone: "neutral", detail: "Daily swings do not establish a clear multi-day direction." };
  if (daily === "RANGE") return { label: "Daily range", tone: "neutral", detail: "Daily price is ranging. A 4-hour move inside that range does not establish a multi-day trend." };
  const up = daily === "UPTREND";
  const bias = up ? "Up" : "Down";
  if (h4 === daily) return { label: `Swing ${up ? "up" : "down"} · Aligned`, tone: up ? "up" : "down", detail: "Daily and 4-hour structure agree. Alignment alone is not an entry setup." };
  if (h4 === "UPTREND" || h4 === "DOWNTREND") return {
    label: `${bias} bias · 4H ${up ? "pullback" : "rebound"}`,
    tone: "mixed",
    detail: "The 4-hour move opposes the Daily trend. It could be a pullback or an emerging reversal; neither outcome is confirmed.",
  };
  if (h4 === "RANGE") return { label: `${bias} bias · Consolidating`, tone: "mixed", detail: "The Daily trend holds while 4-hour price ranges. Wait for clearer swing structure." };
  if (h4 === "TRANSITION") return { label: `${bias} bias · 4H changing`, tone: "mixed", detail: "4-hour structure has broken, while the Daily trend still holds. A new 4-hour direction is not confirmed." };
  return { label: `${bias} bias · 4H unclear`, tone: "mixed", detail: "The Daily trend holds, but 4-hour swings do not establish a clear direction." };
}

/** Ordinal structure buckets, not profitability scores or entry recommendations. */
export function weeklySwingStatus(weekly: TrendDirection | null, daily: TrendDirection | null) {
  const status = swingTrendStatus(weekly, daily);
  const label = status.label.replace(/Daily/g, "Weekly").replace(/4H/g, "Daily").replace(/Swing/g, "Weekly");
  const detail = status.detail.replace(/Daily/g, "Weekly").replace(/4-hour/g, "Daily").replace(/multi-day/g, "weekly");
  const trending = (value: TrendDirection | null) => value === "UPTREND" || value === "DOWNTREND";
  let rank: number;
  let group: string;
  if (!weekly || !daily) { rank = 7; group = "Data unavailable"; }
  else if (trending(weekly) && weekly === daily) { rank = 0; group = "Aligned Weekly + Daily"; }
  else if (trending(weekly) && trending(daily)) { rank = 1; group = "Daily pullbacks / opposing moves"; }
  else if (trending(weekly) && daily === "RANGE") { rank = 2; group = "Consolidating in a Weekly trend"; }
  else if (trending(weekly)) { rank = 3; group = "Daily structure needs confirmation"; }
  else if (weekly === "TRANSITION") { rank = 4; group = "Weekly structure changing"; }
  else if (weekly === "RANGE") { rank = 5; group = "Weekly ranges"; }
  else { rank = 6; group = "Weekly direction unclear"; }
  return { ...status, label, detail, rank, group };
}
