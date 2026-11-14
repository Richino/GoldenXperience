import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import type { MarketRecorder, MarketRecord } from "./market-recording.js";

const GRANULARITIES = ["M1", "M5", "M15", "H1", "H4"] as const;
type ContextGranularity = typeof GRANULARITIES[number];
const BAR_MS: Record<ContextGranularity, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000 };
/**
 * Longest a timeframe goes without a broker snapshot. The pattern engine builds
 * the forming bar from live ticks and calls M5+ context stale after 10 minutes,
 * so 5 minutes keeps a margin. Each timeframe is also fetched on the first
 * cycle after one of its bars closes, which is when the engine needs the
 * broker's completed bar. The old loop fetched M1, M5 and M15 every minute for
 * every pair (~69k OANDA requests a day, weekends included), which was most of
 * the API's outbound egress.
 */
const MAX_CONTEXT_AGE_MS: Record<ContextGranularity, number> = { M1: 60_000, M5: 300_000, M15: 300_000, H1: 300_000, H4: 300_000 };
/** The 60 s timer drifts a little; never skip a fetch over a few seconds. */
const TIMER_SLACK_MS = 5_000;

type ContextProviders = {
  getCandles: typeof getCandles;
  getEconomicCalendar: typeof getEconomicCalendar;
  /** Omitted (tests, the recording script) means always open. */
  marketOpen?: (now: Date) => boolean;
};

export function startRecordingContext(recorder: MarketRecorder | null, instruments: string[], providers: ContextProviders = { getCandles, getEconomicCalendar, marketOpen: now => getForexSessionStatus(now).marketOpen }, observer?: (kind: MarketRecord["kind"], data: Record<string, unknown>, receivedAt: string) => void, recordInstruments: readonly string[] = instruments) {
  let busy = false;
  let stopped = false;
  let cycle = 0;
  const lastFetched = new Map<string, number>();
  const due = (instrument: string, granularity: ContextGranularity, now: number) => {
    const last = lastFetched.get(`${instrument}:${granularity}`);
    if (cycle === 0 || last === undefined) return true;
    if (now - last >= MAX_CONTEXT_AGE_MS[granularity] - TIMER_SLACK_MS) return true;
    return Math.floor(now / BAR_MS[granularity]) > Math.floor(last / BAR_MS[granularity]);
  };
  const controller = new AbortController();
  const emit = (kind: MarketRecord["kind"], data: Record<string, unknown>) => {
    const receivedAt = new Date().toISOString();
    if (!data.instrument || recordInstruments.includes(String(data.instrument))) recorder?.record(kind, data, receivedAt);
    observer?.(kind, data, receivedAt);
  };
  const capture = async () => {
    if (busy || stopped || recorder && recorder.status().state !== "recording" && !observer) return;
    // Nothing moves while forex is shut (Fri 17:00 – Sun 17:00 NY). The first
    // cycle after the reopen starts over with full history (cycle 0), since a
    // 4-bar snapshot cannot bridge the weekend gap.
    if (providers.marketOpen && !providers.marketOpen(new Date())) {
      cycle = 0;
      lastFetched.clear();
      return;
    }
    busy = true;
    try {
      // Serial requests avoid a startup burst. Initial history establishes context;
      // subsequent snapshots retain both complete and forming candles.
      for (const instrument of instruments) {
        for (const granularity of GRANULARITIES) {
          if (stopped) return;
          const startedAt = Date.now();
          if (!due(instrument, granularity, startedAt)) continue;
          const result = await providers.getCandles(instrument, granularity, cycle === 0 ? 256 : 4, { signal: controller.signal });
          if (stopped) return;
          if (result.data.source === "oanda" && result.status.state === "connected") {
            // Only a real snapshot counts; a failed fetch retries next minute.
            lastFetched.set(`${instrument}:${granularity}`, startedAt);
            emit("candles", { instrument, granularity, source: "oanda", priceComponent: "mid", snapshot: result.data });
          } else emit("context-error", { instrument, granularity, context: "candles", state: result.status.state });
        }
      }
      if (cycle % 5 === 0 && !stopped) {
        const result = await providers.getEconomicCalendar();
        if (stopped) return;
        if (result.data.source !== "mock" && result.data.connected && result.status.state === "connected") {
          emit("calendar", { source: result.data.source, checkedAt: result.status.checkedAt, snapshot: result.data });
        } else emit("context-error", { context: "calendar", state: result.status.state });
      }
      cycle++;
    } catch {
      if (!stopped) emit("context-error", { context: "snapshot", state: "error" });
    } finally { busy = false; }
  };
  void capture();
  const timer = setInterval(() => void capture(), 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); controller.abort(); };
}
