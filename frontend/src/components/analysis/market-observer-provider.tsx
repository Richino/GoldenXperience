"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { MarketObserverBubble, type MarketObserverControl, type MarketObserverMonitoring } from "./market-observer-bubble";

type ChartContext = { instrument: string; replayActive: boolean } | null;
interface ObserverWorkspace extends MarketObserverMonitoring, MarketObserverControl {
  setChartContext: (chart: ChartContext) => void;
}
const ObserverContext = createContext<ObserverWorkspace | null>(null);

/** The workspace layout survives navigation, so active chats and dragging do too. */
export function MarketObserverProvider({ children }: { children: ReactNode }) {
  const controls = useRef<MarketObserverControl | null>(null);
  const [monitoring, setMonitoring] = useState<MarketObserverMonitoring>({ tracked: [], busyPairs: {} });
  const [chart, setChartContext] = useState<ChartContext>(null);
  const analyze = useCallback(async (instrument: string) => { await controls.current?.analyze(instrument); }, []);
  const stop = useCallback(async (instrument: string) => { await controls.current?.stop(instrument); }, []);
  const value = useMemo(() => ({ ...monitoring, analyze, stop, setChartContext }), [monitoring, analyze, stop]);
  return <ObserverContext.Provider value={value}>
    {children}
    <MarketObserverBubble instrument={chart?.instrument ?? "EUR_USD"} replayActive={chart?.replayActive ?? false} controlRef={controls} onMonitoringChange={setMonitoring} />
  </ObserverContext.Provider>;
}

/** Embedded native chart surfaces do not mount the workspace observer. */
export function useMarketObserver() { return useContext(ObserverContext); }
