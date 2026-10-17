"use client";

import { useState } from "react";
import { NewsAcceptCard, NewsV3StatusView } from "@/components/charts/news-straddle-v3-ticket";
import type { PublicNewsRun } from "@/lib/news/news-straddle-v3";

/** Local UI demo: Accept only changes component state. No API or broker calls. */
export function NewsAcceptPreview({ run }: { run: PublicNewsRun }) {
  const [accepted, setAccepted] = useState(false);
  const now = Date.parse(run.release.time) - 180_000;
  return <section className="pending-entry-dialog is-plan" style={{ position: "relative", width: "100%", maxHeight: "none", marginTop: 20 }}>
    {accepted ? <div style={{ padding: 20 }}><NewsV3StatusView run={{ ...run, state: "SCHEDULED", firstFillSide: null, reason: null }} now={now} /></div>
      : <NewsAcceptCard instrument={run.instrument} release={{ title: "CPI m/m", currency: "USD", timestamp: run.release.time }} now={now}
          unavailableReason={null} busy={false} error={null} onAccept={() => setAccepted(true)} onCancel={() => undefined} />}
  </section>;
}
