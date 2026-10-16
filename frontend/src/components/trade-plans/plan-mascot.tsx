"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ObserverMascot } from "@/components/analysis/observer-mascot";
import styles from "@/components/analysis/market-observer-bubble.module.css";
import { displayNameFor } from "@/lib/instruments/catalog";
import { tradePlansApi, type TradePlan } from "@/lib/trade-plans/api";
import { mascotLine, mascotPair } from "@/lib/trade-plans/mascot";
import { useDragToDismiss } from "@/lib/use-drag-to-dismiss";
import { useObserverBubbleDrag } from "@/lib/use-observer-bubble-drag";
import { PlanBlock, TRADE_PLANS_CHANGED } from "./plan-analyze";

/**
 * The mascot for accepted trade plans. It appears once a plan is accepted
 * and says what is happening at the zones: how far price is from each,
 * which step a plan has reached, and when one confirms. It reads the
 * server's monitor (which runs with the app closed); it never decides
 * anything itself.
 */
export function PlanMascot({ chartInstrument, hidden, fixture }: {
  chartInstrument: string | null;
  hidden: boolean;
  /** Dev preview only: show these plans instead of polling the server. */
  fixture?: TradePlan[];
}) {
  const [polled, setPlans] = useState<TradePlan[]>([]);
  const plans = fixture ?? polled;
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setPlans(await tradePlansApi.list("active")); } catch { /* next poll retries */ }
  }, []);
  useEffect(() => {
    if (fixture) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    const changed = () => { setMinimized(false); void refresh(); };
    window.addEventListener(TRADE_PLANS_CHANGED, changed);
    return () => { window.clearInterval(timer); window.removeEventListener(TRADE_PLANS_CHANGED, changed); };
  }, [fixture, refresh]);

  const visible = !hidden && plans.length > 0;
  const { setRow, rowStyle, panelStyle, side, positioned, dragging, handlers } = useObserverBubbleDrag(visible);
  const { setSheet, setBackdrop, handlers: sheetHandlers, requestClose } = useDragToDismiss({ open, onDismiss: () => setOpen(false), handleSelector: `.${styles.grip}, .${styles.panelHead}` });

  const pair = mascotPair(plans, chartInstrument);
  if (!visible || !pair) return null;
  const pairPlans = plans.filter((plan) => plan.instrument === pair);
  const line = mascotLine(pairPlans)!;
  const otherPairs = [...new Set(plans.map((plan) => plan.instrument))].filter((item) => item !== pair);
  const stop = async () => {
    setBusy(true);
    try {
      await Promise.all(pairPlans.filter((plan) => ["APPROVED", "MONITORING", "CONFIRMED", "NOTIFIED"].includes(plan.status)).map((plan) => tradePlansApi.cancel(plan.id, "Stopped watching from the mascot")));
      window.dispatchEvent(new Event(TRADE_PLANS_CHANGED));
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <aside className={`${styles.scout} ${minimized ? styles.minimized : ""}`} style={panelStyle} data-market-observer data-state="live" data-expression={line.expression} data-side={side} data-positioned={positioned} data-dragging={dragging}>
      {open && <div ref={setBackdrop} className={styles.backdrop} aria-hidden="true" onClick={requestClose} />}
      {open && (
        <section ref={setSheet} {...sheetHandlers} className={styles.panel} aria-label={`${displayNameFor(pair)} plans`}>
          <div className={styles.grip} aria-hidden="true" />
          <header className={styles.panelHead}>
            <span className={styles.headIcon} aria-hidden="true"><ObserverMascot expression={line.expression} /></span>
            <div><h3>{displayNameFor(pair)} plans</h3><small><i className={styles.dot} data-tone={line.tone} />{line.text}</small></div>
            <button aria-label="Close" onClick={requestClose}><X size={18} /></button>
          </header>
          <div className={styles.panelBody}>
            {pairPlans.map((plan) => <PlanBlock key={plan.id} plan={plan} watching />)}
            {otherPairs.length ? <p className={styles.caption}>Also watching: {otherPairs.map((item) => displayNameFor(item)).join(", ")}.</p> : null}
          </div>
          <div className={`${styles.actions} ${styles.panelFooter}`}>
            <button type="button" disabled={busy} onClick={() => void stop()}>{busy ? "Stopping…" : `Stop watching ${displayNameFor(pair)}`}</button>
            <Link href={`/chart?instrument=${pair}`} onClick={() => setOpen(false)} className={styles.resultsLauncher}>Open chart</Link>
          </div>
        </section>
      )}
      <div ref={setRow} style={rowStyle} {...handlers} className={styles.bubbleRow}>
        {!open && !minimized && (
          <div className={styles.cloudWrap}>
            <button className={styles.cloud} aria-label={`${line.status}. ${line.text}. Open the plans`} onClick={() => setOpen(true)}>
              <span className={styles.cloudTag}><i className={styles.dot} data-tone={line.tone} />{line.status}</span>
              <span key={line.text} className={`${styles.cloudText} ${styles.cloudTextEnter}`}>{line.text}</span>
            </button>
            <button data-no-observer-drag className={styles.minimize} aria-label="Hide the message, keep the icon" onClick={() => setMinimized(true)}><X size={12} /></button>
          </div>
        )}
        <button data-observer-drag-icon className={styles.icon} title="Drag to move." aria-expanded={open} aria-label={open ? "Close the plans" : `${line.status}. Open the plans`} onClick={() => { if (open) requestClose(); else { setMinimized(false); setOpen(true); } }}>
          <ObserverMascot expression={line.expression} reactionKey={line.expression === "confirmed" ? line.text : undefined} />
          <i className={styles.badge} data-tone={line.tone} role="img" aria-label={`Plan status: ${line.status}`} />
        </button>
      </div>
    </aside>,
    document.body,
  );
}
