"use client";

import { useSyncExternalStore } from "react";
import { PlanAnalyzeCard, PlanAnalyzeSheet, type PlanAnalyzeState } from "@/components/trade-plans/plan-analyze";
import { PlanMascot } from "@/components/trade-plans/plan-mascot";
import { fixturePlan, watchingPair } from "@/lib/trade-plans/fixtures";

const noop = () => undefined;
const base: PlanAnalyzeState = {
  phase: { kind: "idle" }, active: [], open: false, setOpen: noop, busy: false, actionError: null,
  run: async () => undefined, accept: noop, dismiss: noop, stopWatching: noop, cancel: noop, analyzing: false,
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

/** ?sheet=1 opens the phone sheet with the offered plans. */
const wantsSheet = () => new URLSearchParams(window.location.search).has("sheet");

export function PlanAnalyzePreview() {
  const sheet = useSyncExternalStore(() => () => undefined, wantsSheet, () => false);
  if (sheet) return <PlanAnalyzeSheet state={{ ...offered, open: true }} instrument="EUR_USD" price={1.12292} />;
  return (
    <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh", display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 360px))", alignItems: "start" }}>
      {[base, offered, none, watching].map((state, index) => (
        <div key={index} data-preview={["idle", "offered", "none", "watching"][index]}>
          <PlanAnalyzeCard state={state} instrument="EUR_USD" price={1.12292} onNewEntry={noop} />
        </div>
      ))}
      <PlanMascot chartInstrument="EUR_USD" hidden={false} fixture={watchingPair()} />
    </main>
  );
}
