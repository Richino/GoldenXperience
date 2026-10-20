"use client";

import { useState } from "react";
import { NewsAcceptCard, NewsV3StatusView } from "@/components/charts/news-straddle-v3-ticket";
import type { NewsLeg, PublicNewsRun } from "@/lib/news/news-straddle-v3";

/** Local UI demo: Accept only changes component state. No API or broker calls. */
export function NewsAcceptPreview({ run }: { run: PublicNewsRun }) {
  const [accepted, setAccepted] = useState(false);
  const now = Date.parse(run.release.time) - 180_000;
  const events = [
    { id: "fixture-cpi", title: "CPI m/m", currency: "USD" },
    { id: "fixture-core-cpi", title: "Core CPI m/m", currency: "USD" },
    { id: "fixture-claims", title: "Unemployment Claims", currency: "USD" },
  ];
  const unsent = (leg: NewsLeg): NewsLeg => ({ ...leg, state: "UNSENT", orderId: null, tradeId: null, submittedAt: null,
    httpDispatchedAt: null, acknowledgedAt: null, brokerTime: null, cancellationRequestedAt: null, cancellationConfirmedAt: null,
    fillTime: null, fillPrice: null, fillSpreadPips: null, slippagePips: null, initialStop: null, activeStop: null,
    trailingOrderId: null, trailingRequestedAt: null, trailingActivatedAt: null, lastProtectionAt: null });
  const scheduled: PublicNewsRun = { ...run, state: "SCHEDULED", firstFillSide: null, reason: null,
    targetSubmitAt: new Date(Date.parse(run.release.time) - 10000).toISOString(), preparedAt: null, levelsFrozenAt: null,
    legs: { long: unsent(run.legs.long), short: unsent(run.legs.short) }, timeline: [], release: { ...run.release, events } };
  return <section className="pending-entry-dialog is-plan" style={{ position: "relative", width: "100%", maxHeight: "none", marginTop: 20 }}>
    {accepted ? <div style={{ padding: 20 }}><NewsV3StatusView run={scheduled} now={now} /></div>
      : <NewsAcceptCard instrument={run.instrument} release={{ title: "CPI m/m", currency: "USD", timestamp: run.release.time, events }} now={now}
          unavailableReason={null} busy={false} error={null} onAccept={() => setAccepted(true)} onCancel={() => undefined} />}
  </section>;
}
