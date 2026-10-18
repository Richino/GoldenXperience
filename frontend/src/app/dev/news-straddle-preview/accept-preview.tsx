"use client";

import { useState } from "react";
import { NewsAcceptCard, NewsV3StatusView } from "@/components/charts/news-straddle-v3-ticket";
import type { PublicNewsRun } from "@/lib/news/news-straddle-v3";

/** Local UI demo: Accept only changes component state. No API or broker calls. */
export function NewsAcceptPreview({ run }: { run: PublicNewsRun }) {
  const [accepted, setAccepted] = useState(false);
  const now = Date.parse(run.release.time) - 180_000;
  const events = [
    { id: "fixture-cpi", title: "CPI m/m", currency: "USD" },
    { id: "fixture-core-cpi", title: "Core CPI m/m", currency: "USD" },
    { id: "fixture-claims", title: "Unemployment Claims", currency: "USD" },
  ];
  return <section className="pending-entry-dialog is-plan" style={{ position: "relative", width: "100%", maxHeight: "none", marginTop: 20 }}>
    {accepted ? <div style={{ padding: 20 }}><NewsV3StatusView run={{ ...run, state: "SCHEDULED", firstFillSide: null, reason: null, release: { ...run.release, events } }} now={now} /></div>
      : <NewsAcceptCard instrument={run.instrument} release={{ title: "CPI m/m", currency: "USD", timestamp: run.release.time, events }} now={now}
          unavailableReason={null} busy={false} error={null} onAccept={() => setAccepted(true)} onCancel={() => undefined} />}
  </section>;
}
