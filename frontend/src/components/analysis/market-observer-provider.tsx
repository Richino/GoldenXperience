"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { MarketObserverBubble, type MarketObserverControl, type MarketObserverMonitoring } from "./market-observer-bubble";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { observerPairLabel } from "@/lib/observer-conversation";
import { PlanMascot } from "@/components/trade-plans/plan-mascot";

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
  const [choiceInstrument, setChoiceInstrument] = useState<string | null>(null);
  const analyze = useCallback(async (instrument: string, mode?: "NORMAL" | "SWING") => {
    if (mode) await controls.current?.analyze(instrument, mode);
    else setChoiceInstrument(instrument);
  }, []);
  const chooseMode = async (mode: "NORMAL" | "SWING") => {
    if (!choiceInstrument || monitoring.busyPairs[choiceInstrument] || chart?.replayActive) return;
    const instrument = choiceInstrument;
    setChoiceInstrument(null);
    await controls.current?.analyze(instrument, mode);
  };
  const stopChoice = async () => {
    if (!choiceInstrument || monitoring.busyPairs[choiceInstrument]) return;
    const instrument = choiceInstrument;
    setChoiceInstrument(null);
    await controls.current?.stop(instrument);
  };
  const managing = Boolean(choiceInstrument && monitoring.tracked.includes(choiceInstrument));
  const stop = useCallback(async (instrument: string) => { await controls.current?.stop(instrument); }, []);
  const value = useMemo(() => ({ ...monitoring, analyze, stop, setChartContext }), [monitoring, analyze, stop]);
  return <ObserverContext.Provider value={value}>
    {children}
    <MarketObserverBubble instrument={chart?.instrument ?? "EUR_USD"} replayActive={chart?.replayActive ?? false} controlRef={controls} onMonitoringChange={setMonitoring} />
    {/* Accepted trade plans get the mascot; it stays out of the way while the older observer chat is active. */}
    <PlanMascot chartInstrument={chart?.instrument ?? null} hidden={Boolean(chart?.replayActive) || monitoring.tracked.length > 0 || Object.values(monitoring.busyPairs).some(Boolean)} />
    <MobileSheet open={choiceInstrument !== null} onClose={() => setChoiceInstrument(null)} title={`${managing ? "Manage" : "Analyze"} ${choiceInstrument ? observerPairLabel(choiceInstrument) : "pair"}`} eyebrow={managing ? "Analysis controls" : "Choose analysis mode"} className="analysis-mode-sheet">
      <div className="analysis-mode-choices">
        <button type="button" onClick={() => void chooseMode("NORMAL")} disabled={Boolean(choiceInstrument && monitoring.busyPairs[choiceInstrument]) || chart?.replayActive}><strong>Intraday</strong><span>5-minute candle confirmation</span></button>
        <button type="button" onClick={() => void chooseMode("SWING")} disabled={Boolean(choiceInstrument && monitoring.busyPairs[choiceInstrument]) || chart?.replayActive}><strong>Swing</strong><span>1-hour candle confirmation</span></button>
        {managing && <button type="button" className="analysis-mode-stop" onClick={() => void stopChoice()} disabled={Boolean(choiceInstrument && monitoring.busyPairs[choiceInstrument])}><strong>Stop monitoring</strong><span>End analysis updates for this pair</span></button>}
      </div>
    </MobileSheet>
  </ObserverContext.Provider>;
}

/** Embedded native chart surfaces do not mount the workspace observer. */
export function useMarketObserver() { return useContext(ObserverContext); }
