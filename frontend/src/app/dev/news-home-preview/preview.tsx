"use client";

import { useState } from "react";
import { LedgerPending, LedgerPositions, type LedgerPosition } from "@/components/dashboard/ledger-home";
import type { PendingManualEntry } from "@/types/pending-entry";
import styles from "./preview.module.css";

/** Synthetic snapshots rendered with the Home components. No execution requests. */
export function NewsHomePreview({ now }: { now: number }) {
  const [state, setState] = useState<"pending" | "active">("pending");
  const [note, setNote] = useState<string | null>(null);
  const release = new Date(now + 180_000).toISOString();
  const pending: PendingManualEntry[] = (["long", "short"] as const).map(direction => ({
    id: `preview-${direction}`, instrument: "EUR_USD", direction,
    entryPrice: direction === "long" ? 1.1211 : 1.119,
    entryOrderType: direction === "long" ? "buy_stop" : "sell_stop",
    currentPriceAtCreation: 1.12005, expirationType: "time", expiresAt: new Date(now + 240_000).toISOString(),
    activateAt: new Date(now + 178_000).toISOString(), invalidationPrice: null, status: "PENDING",
    triggerPrice: null, stopPrice: null, targetPrice: null,
    paperTradeId: null, paperTradeStatus: null, failureReason: null, triggeredAt: null, cancelledAt: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), metadata: {},
  }));
  const position: LedgerPosition = {
    id: "preview-filled-news", href: "/chart?instrument=EUR_USD", instrument: "EUR_USD", direction: "long",
    openedAt: new Date(now - 30_000).toISOString(), entry: 1.12115, mark: 1.12295,
    stop: 1.12245, target: null, entryAt: null, markAt: null, r: 1.2, money: 120,
    lots: 0.66666, progress: null, spreadCost: null, spreadR: null,
  };
  return <main className={`nl-home ${styles.page}`}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Home · Preview</span><h1>News trade</h1></div>
      <div className={styles.switch} aria-label="Preview state">
        <button type="button" aria-pressed={state === "pending"} onClick={() => { setState("pending"); setNote(null); }}>Pending</button>
        <button type="button" aria-pressed={state === "active"} onClick={() => { setState("active"); setNote(null); }}>Active</button>
      </div>
    </header>
    <p className={styles.explainer}>{state === "pending" ? "After Accept: both directions are waiting. GX submits the orders just before the release." : "After a BUY fills: the trade moves to Open positions. This example shows the SELL cancellation confirmed and trailing protection active."}</p>
    <div className={styles.columns}><div className={styles.main}>
      <LedgerPositions positions={state === "active" ? [position] : []} currency="USD" />
      <LedgerPending entries={state === "pending" ? pending : []} cancellingId={null} error={note}
        onCancel={() => setNote("Preview only — no orders were cancelled.")}
        onEdit={() => setNote("Preview only — no levels were changed.")} />
    </div><aside className={styles.context}>
      <span className={styles.eyebrow}>{state === "pending" ? "Monitoring" : "Trailing active"}</span>
      <h2>EUR/USD</h2><p>CPI m/m · Core CPI m/m<br />Unemployment Claims</p>
      <dl><div><dt>{state === "pending" ? "Release" : "Opposite SELL"}</dt><dd>{state === "pending" ? new Date(release).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) : "Cancelled"}</dd></div>
        <div><dt>Planned risk per trade</dt><dd>1% · $100</dd></div>
        <div><dt>{state === "pending" ? "Trailing" : "Stop protecting"}</dt><dd>{state === "pending" ? "+10 / 7 pips" : "+13 pips"}</dd></div>
        <div><dt>Fixed target</dt><dd>Disabled</dd></div></dl>
      <small>Illustrative $10,000 account. The cards on the left use the Home components; this explanation panel is preview-only. No orders are placed.</small>
    </aside></div>
  </main>;
}
