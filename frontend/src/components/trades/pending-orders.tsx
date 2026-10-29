import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { PendingManualEntry } from "@/types/pending-entry";
import { entryOrderHref, entryOrderStatus } from "@/lib/journal/active-orders";
import { formatChartPrice } from "@/lib/chart-utils";
import { formatClockTime, formatShortDay } from "@/lib/format/datetime";
import styles from "./pending-orders.module.css";

export function PendingOrders({ entries, asOf }: { entries: PendingManualEntry[]; asOf: string | null }) {
  if (!entries.length) return null;
  const now = asOf ? Date.parse(asOf) : 0;
  return <section className={styles.list} aria-label="Pending and synchronizing entries">
    <h2 className={styles.heading}>Pending entries <span>{entries.length}</span></h2>
    {entries.map(entry => {
      const price = (value: number | null) => value === null ? "None" : formatChartPrice(value, entry.instrument);
      const status = entryOrderStatus(entry, now);
      const when = status === "Scheduled" ? entry.activateAt! : entry.createdAt;
      const linked = entry.metadata.linkedOco === true || typeof entry.metadata.straddleId === "string";
      return <Link key={entry.id} href={entryOrderHref(entry)} prefetch={false} className={styles.card} aria-label={`View ${entry.instrument.replace("_", "/")} ${entry.direction} order, ${status}`}>
        <div className={styles.top}><div className="nl-tr-pair"><b>{entry.instrument.replace("_", "/")}</b><span className={`nl-tr-side ${entry.direction === "long" ? "is-up" : "is-down"}`}>{entry.direction === "long" ? "Long" : "Short"}</span></div><span className={styles.status}>{status}</span></div>
        <dl className={styles.levels}><div><dt>Entry · {entry.entryOrderType.endsWith("stop") ? "Stop" : "Limit"}</dt><dd>{price(entry.entryPrice)}</dd></div><div><dt>Stop loss</dt><dd>{price(entry.stopPrice)}</dd></div><div><dt>Take profit</dt><dd>{price(entry.targetPrice)}</dd></div></dl>
        <div className={styles.meta}><span>{linked ? "Linked OCO · " : ""}{formatShortDay(when)} · {formatClockTime(when)}</span><span>View order <ArrowUpRight size={14} aria-hidden="true" /></span></div>
      </Link>;
    })}
  </section>;
}

export function OrdersOverview({ entries, openCount, openPnl }: { entries: PendingManualEntry[]; openCount: number; openPnl: number | null }) {
  const pendingCount = entries.filter(e => e.status !== "TRIGGERED").length;
  const syncing = entries.length - pendingCount;
  const money = openCount === 0 ? 0 : openPnl;
  return <section className={styles.overview} aria-label="Active orders summary">
    <div><span>Pending entries</span><b>{pendingCount}{syncing ? <small> + {syncing} syncing</small> : null}</b></div>
    <div><span>Open trades</span><b>{openCount}</b></div>
    <div><span>Open P/L</span><b className={money === null || money === 0 ? "" : money > 0 ? "is-up" : "is-down"}>{money === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", signDisplay: "exceptZero" }).format(money)}</b></div>
  </section>;
}
