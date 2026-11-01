import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { PendingManualEntry } from "@/types/pending-entry";
import { entryOrderHref, entryOrderStatus } from "@/lib/journal/active-orders";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime, formatShortDay } from "@/lib/format/datetime";

/** Pending entry cards, two across on desktop (canvas "Trades", Orders tab). */
export function PendingOrders({ entries, asOf, status }: { entries: PendingManualEntry[]; asOf: string | null; status?: ReactNode }) {
  if (!entries.length) return null;
  const now = asOf ? Date.parse(asOf) : 0;
  return <section className="nl-tx-panel" aria-labelledby="nl-tx-pending-title">
    <div className="nl-tx-ph">
      <div className="nl-tx-ph-title"><h2 id="nl-tx-pending-title">Pending entries</h2><span className="nl-tx-cnt">{entries.length}</span></div>
      {status}
    </div>
    <div className="nl-tx-pending-grid">
      {entries.map(entry => {
        const price = (value: number | null) => value === null ? "None" : formatChartPrice(value, entry.instrument);
        const state = entryOrderStatus(entry, now);
        const when = state === "Scheduled" ? entry.activateAt! : entry.createdAt;
        const linked = entry.metadata.linkedOco === true || typeof entry.metadata.straddleId === "string";
        return <Link key={entry.id} href={entryOrderHref(entry)} prefetch={false} className="nl-tx-pending" aria-label={`View ${entry.instrument.replace("_", "/")} ${entry.direction} order, ${state}`}>
          <span className="nl-tx-pending-top">
            <span className="nl-tx-pair"><b>{entry.instrument.replace("_", "/")}</b><span className={`nl-tx-side ${entry.direction === "long" ? "is-up" : "is-down"}`}>{entry.direction === "long" ? "Long" : "Short"}</span></span>
            <span className={`nl-tx-tag${state === "Pending" ? " is-pend" : ""}`}>{state === "Pending" ? "Waiting" : state}</span>
          </span>
          <dl className="nl-tx-levels">
            <div><dt>Entry · {entry.entryOrderType.endsWith("stop") ? "Stop" : "Limit"}</dt><dd>{price(entry.entryPrice)}</dd></div>
            <div className="is-down"><dt>Stop loss</dt><dd>{price(entry.stopPrice)}</dd></div>
            <div className="is-up"><dt>Take profit</dt><dd>{price(entry.targetPrice)}</dd></div>
          </dl>
          <span className="nl-tx-pending-meta"><span className="metric-number">{linked ? "Linked OCO · " : ""}{formatShortDay(when)} · {formatClockTime(when)}</span><span>View order <ArrowUpRight aria-hidden="true" /></span></span>
        </Link>;
      })}
    </div>
  </section>;
}

/** Orders tab summary: three tiles. */
export function OrdersOverview({ entries, openCount, openPnl }: { entries: PendingManualEntry[]; openCount: number; openPnl: number | null }) {
  const pendingCount = entries.filter(e => e.status !== "TRIGGERED").length;
  const syncing = entries.length - pendingCount;
  const money = openCount === 0 ? 0 : openPnl;
  return <section className="nl-tx-panel nl-tx-overview" aria-label="Active orders summary">
    <div className="nl-tx-tile"><span className="nl-tx-lbl"><span className="nl-tx-wide">Pending entries</span><span className="nl-tx-narrow">Pending</span></span><b className="metric-number">{pendingCount}{syncing ? <small> + {syncing} syncing</small> : null}</b></div>
    <div className="nl-tx-tile"><span className="nl-tx-lbl"><span className="nl-tx-wide">Open trades</span><span className="nl-tx-narrow">Open</span></span><b className="metric-number">{openCount}</b></div>
    <div className="nl-tx-tile"><span className="nl-tx-lbl">Open P/L</span><b className={`metric-number ${money === null || money === 0 ? "" : money > 0 ? "is-up" : "is-down"}`}>{money === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero" }).format(money)}</b></div>
  </section>;
}
