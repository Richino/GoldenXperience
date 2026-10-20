"use client";

import partialSnapshot from "@/lib/trade-plans/fixtures/partial-market-state.json";
import completedSnapshot from "@/lib/trade-plans/fixtures/completed-market-state.json";
import type { MarketStateSnapshot } from "@/lib/trade-plans/market-state";
import { useSyncExternalStore } from "react";
import { PlanAnalyzeCard, PlanAnalyzeSheet, type PlanAnalyzeState } from "@/components/trade-plans/plan-analyze";
import { PlanMascot } from "@/components/trade-plans/plan-mascot";
import { fixturePlan, fixtureResearch, watchingPair } from "@/lib/trade-plans/fixtures";

const noop = () => undefined;
const base: PlanAnalyzeState = {
  phase: { kind: "idle" }, active: [], status: "new", open: false, setOpen: noop, busy: false, actionError: null,
  run: async () => undefined, retryTechnical: async () => undefined, accept: noop, dismiss: noop, stopWatching: noop, cancel: noop, analyzing: false,
  research: { loading: false, result: fixtureResearch(), error: null }, refreshResearch: noop, cancelResearch: noop, review: noop,
};
const offered: PlanAnalyzeState = {
  ...base,
  phase: { kind: "results", result: { analysisId: "a", result: "PLANS", reason: null, planIds: [], rejected: [], plans: [fixturePlan("BUY"), fixturePlan("SELL")] } },
};
const none: PlanAnalyzeState = {
  ...base,
  phase: { kind: "results", result: { analysisId: "b", result: "NO_VALID_SETUP", reason: "x", planIds: [], plans: [], rejected: [
    { direction: "BUY", setupType: "SR_REVERSAL", reason: "Estimated reward/risk 1.14 is under 1.5: the resistance at 1.33026 is too close." },
    { direction: "SELL", setupType: "BREAKOUT_RETEST", reason: "The spread is 19% of the stop distance, over the 15% limit." },
  ] } },
};
const watching: PlanAnalyzeState = { ...base, active: watchingPair() };
const researching: PlanAnalyzeState = {
  ...none,
  research: { loading: false, error: null, result: { research: null, state: "started", job: {
    id: "00000000-0000-4000-8000-0000000000dd", instrument: "EUR_USD", status: "RESEARCHING", trigger: "MANUAL", horizon: "2-5 trading days", model: "gpt-6.1-sol", effort: "high",
    researchId: null, error: null, createdAt: new Date(Date.now() - 95_000).toISOString(), startedAt: new Date(Date.now() - 90_000).toISOString(), completedAt: null,
    usage: { inputTokens: null, outputTokens: null, reasoningTokens: null, webSearchCalls: null, sources: null, costUsd: null, validationDrops: null },
  } } },
};

/** ?sheet=1 opens the phone sheet with the offered plans. */
const wantsSheet = () => new URLSearchParams(window.location.search).has("sheet");
const wantsPartial = () => new URLSearchParams(window.location.search).has("partial");
const wantsComplete = () => new URLSearchParams(window.location.search).has("complete");
const wantsNoSetup = () => new URLSearchParams(window.location.search).has("no-setup");
const wantsTechnicalFailure = () => new URLSearchParams(window.location.search).has("technical-failure");
const wantsCalendarWait = () => new URLSearchParams(window.location.search).has("calendar-wait");

export function PlanAnalyzePreview() {
  const sheet = useSyncExternalStore(() => () => undefined, wantsSheet, () => false);
  const partial = useSyncExternalStore(() => () => undefined, wantsPartial, () => false);
  const complete = useSyncExternalStore(() => () => undefined, wantsComplete, () => false);
  const noSetup = useSyncExternalStore(() => () => undefined, wantsNoSetup, () => false);
  const technicalFailure = useSyncExternalStore(() => () => undefined, wantsTechnicalFailure, () => false);
  const calendarWait = useSyncExternalStore(() => () => undefined, wantsCalendarWait, () => false);
  if (sheet && noSetup) return <PlanAnalyzeSheet state={{...none,open:true,research:{...base.research,result:{...fixtureResearch(),marketState:{snapshot:completedSnapshot as MarketStateSnapshot,usable:true,reasons:[]}}}}} instrument="EUR_USD" price={1.12297} />;
  if (sheet && complete) return <PlanAnalyzeSheet state={{...offered,open:true,research:{...base.research,result:{...fixtureResearch(),marketState:{snapshot:completedSnapshot as MarketStateSnapshot,usable:true,reasons:[]}}}}} instrument="EUR_USD" price={1.12297} />;
  if (sheet && partial) return <PlanAnalyzeSheet state={{ ...base, open: true, research: { ...base.research, result: { ...fixtureResearch(), marketState: { snapshot: partialSnapshot as MarketStateSnapshot, usable: true, reasons: [] } } }, phase: { kind: "results", result: { analysisId: "fixture-partial", result: "TECHNICAL_DATA_UNAVAILABLE", reason: "Higher-timeframe H4 input is unavailable. H1 observations remain validated.", plans: [], planIds: [], rejected: [] } } }} instrument="EUR_USD" price={1.12297} />;
  if (sheet && technicalFailure) return <PlanAnalyzeSheet state={{ ...base, open: true, phase: { kind: "results", result: { analysisId: "fixture-failure", result: "TECHNICAL_DATA_UNAVAILABLE", reason: "OANDA H4 candle request failed. Validated research is retained; trade plans require verified H4 data.", plans: [], planIds: [], rejected: [] } } }} instrument="EUR_USD" price={1.12297} />;
  if (sheet && calendarWait) return <PlanAnalyzeSheet state={{ ...researching, phase: { kind: "researching" }, open: true, research: {
    ...researching.research, result: { ...researching.research.result!, job: {
      ...researching.research.result!.job!, status: "QUEUED", startedAt: null,
      error: "Verified economic calendar unavailable. Research will retry before starting; no report has been generated.",
    } },
  } }} instrument="EUR_USD" price={1.12292} />;
  if (sheet) return <PlanAnalyzeSheet state={{ ...offered, open: true }} instrument="EUR_USD" price={1.12292} />;
  return (
    <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh", display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 360px))", alignItems: "start" }}>
      {[base, offered, none, watching, researching].map((state, index) => (
        <div key={index} data-preview={["idle", "offered", "none", "watching", "researching"][index]}>
          <PlanAnalyzeCard state={state} instrument="EUR_USD" price={1.12292} onNewEntry={noop} />
        </div>
      ))}
      <PlanMascot chartInstrument="EUR_USD" hidden={false} fixture={watchingPair()} />
    </main>
  );
}
