import type { ChartBox } from "@/components/charts/chart-box-primitive";
import { localMinutes, LONDON_TIME_ZONE, NEW_YORK_TIME_ZONE } from "@/lib/strategy/session";
import type { Candle } from "@/types/forex";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const M15_MS = 15 * 60_000;

// These session boundaries are in the daytime, after either zone's DST change.
// The offset at UTC noon therefore also applies at the local 08:00/12:00 boundary.
function sessionHour(dayMs: number, hour: number, timeZone: string) {
  const offsetMinutes = localMinutes(new Date(dayMs + 12 * HOUR_MS), timeZone) - 12 * 60;
  return dayMs + (hour * 60 - offsetMinutes) * 60_000;
}

/**
 * Scheduled AMD shading, independent of sweeps, reclaims or trade outcomes:
 * A: 00:00 UTC to London 08:00; M: London 08:00 to New York 08:00;
 * D: New York 08:00 to 12:00. London and New York follow their own DST clocks.
 * Each box contains that window's completed M15 candle highs/lows. During a
 * session it grows only through the latest closed candle, including in replay.
 * The labels name session windows, not confirmed price patterns or signals.
 */
export function computeAmdSessionBoxes(candles: Candle[]): ChartBox[] {
  const days = new Map<number, Array<{ candle: Candle; ms: number }>>();
  for (const candle of candles) {
    const ms = Date.parse(candle.time);
    if (!Number.isFinite(ms) || candle.complete === false) continue;
    const dayMs = ms - (ms % DAY_MS);
    const bars = days.get(dayMs) ?? [];
    bars.push({ candle, ms });
    days.set(dayMs, bars);
  }

  const boxes: ChartBox[] = [];
  for (const [dayMs, bars] of [...days].sort(([a], [b]) => a - b)) {
    const london = sessionHour(dayMs, 8, LONDON_TIME_ZONE);
    const newYork = sessionHour(dayMs, 8, NEW_YORK_TIME_ZONE);
    const noon = sessionHour(dayMs, 12, NEW_YORK_TIME_ZONE);
    const windows = [
      { phase: "A", label: "A · Asia", start: dayMs, end: london, color: "#ff8a5b" },
      { phase: "M", label: "M · London", start: london, end: newYork, color: "#ffc14d" },
      { phase: "D", label: "D · NY", start: newYork, end: noon, color: "#c8f560" },
    ];
    for (const window of windows) {
      const session = bars.filter(({ ms }) => ms >= window.start && ms < window.end);
      if (!session.length) continue;
      const end = Math.min(window.end, Math.max(...session.map(({ ms }) => ms + M15_MS)));
      boxes.push({
        key: `amd-session-${new Date(dayMs).toISOString().slice(0, 10)}-${window.phase}`,
        startTime: new Date(window.start).toISOString(),
        endTime: new Date(end).toISOString(),
        top: Math.max(...session.map(({ candle }) => candle.high)),
        bottom: Math.min(...session.map(({ candle }) => candle.low)),
        color: window.color,
        label: window.label,
        faded: end < window.end,
      });
    }
  }
  return boxes;
}
