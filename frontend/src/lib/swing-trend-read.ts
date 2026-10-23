import { ANALYZE_V2 } from "@/lib/strategy/analyze-v2/config";
import { checkTimeframe } from "@/lib/strategy/analyze-v2/data-quality";
import { readTrend } from "@/lib/strategy/analyze-v2/structure";
import type { CandleSeries } from "@/types/forex";

/** Shared by the chart labels, picker and Home scan: genuine, completed, current structure. */
export function readSwingTrend(instrument: string, granularity: "W" | "D" | "H4", series: CandleSeries | undefined, now = Date.now()) {
  if (!series || series.instrument !== instrument || series.granularity !== granularity || series.source !== "oanda") return null;
  const timeframe = granularity === "D" ? "D1" : granularity;
  const closed = series.candles.filter(c => c.complete === true);
  const checked = checkTimeframe(timeframe, closed, timeframe, now, ANALYZE_V2.SWING, true, { instrument });
  if (checked.checks.some(c => c.status === "FAIL" || c.status === "UNKNOWN")) return null;
  const label = granularity === "W" ? "Weekly" : granularity === "D" ? "Daily" : "4H";
  const read = readTrend(instrument, label, checked.normalized.closed, ANALYZE_V2.SWING.regime);
  return read.sufficient ? read : null;
}
