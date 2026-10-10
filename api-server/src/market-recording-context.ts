import { getCandles } from "../../frontend/src/lib/oanda/client.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import type { MarketRecorder, MarketRecord } from "./market-recording.js";

export function startRecordingContext(recorder: MarketRecorder | null, instruments: string[], providers = { getCandles, getEconomicCalendar }, observer?: (kind: MarketRecord["kind"], data: Record<string, unknown>, receivedAt: string) => void, recordInstruments: readonly string[] = instruments) {
  let busy = false;
  let stopped = false;
  let cycle = 0;
  const controller = new AbortController();
  const emit = (kind: MarketRecord["kind"], data: Record<string, unknown>) => {
    const receivedAt = new Date().toISOString();
    if (!data.instrument || recordInstruments.includes(String(data.instrument))) recorder?.record(kind, data, receivedAt);
    observer?.(kind, data, receivedAt);
  };
  const capture = async () => {
    if (busy || stopped || recorder && recorder.status().state !== "recording" && !observer) return;
    busy = true;
    try {
      // Serial requests avoid a startup burst. Initial history establishes context;
      // subsequent snapshots retain both complete and forming candles.
      for (const instrument of instruments) {
        for (const granularity of ["M1", "M5", "M15", "H1", "H4"]) {
          if (stopped) return;
          if (cycle > 0 && !["M1", "M5", "M15"].includes(granularity) && cycle % 5 !== 0) continue;
          const result = await providers.getCandles(instrument, granularity, cycle === 0 ? 256 : 4, { signal: controller.signal });
          if (stopped) return;
          if (result.data.source === "oanda" && result.status.state === "connected") {
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
