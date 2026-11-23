"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { formatChartPrice } from "@/lib/chart-utils";
import { pipSizeFor } from "@/lib/instruments/catalog";
import type { PendingManualEntry } from "@/types/pending-entry";
import type { MajorInstrument } from "@/types/forex";

function expiryLabel(expiresAt: string | null, now: number) {
  if (!expiresAt) return "No expiry";
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  if (minutes >= 24 * 60) return `Expires in ${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
  if (minutes >= 60) return `Expires in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Expires in ${minutes}m`;
}

type Rung = {
  key: "stop" | "entry" | "target";
  label: string;
  price: number | null;
  /** Where an unset level would sit, so the ladder keeps the chart's order. */
  sortPrice: number;
  right: ReactNode;
  note?: string;
};

/**
 * The selected trade at the top of the phone trade sheet, drawn as a price
 * ladder in the chart's own order (highest price on top): stop, entry and
 * target, each with what it books. A missing stop is its own rung with an
 * Add button rather than a separate warning.
 */
export function TradeSheetSummary({
  entry,
  bid,
  ask,
  now,
  exitMoney,
  livePL,
  livePLColor,
  onAddStop,
}: {
  entry: PendingManualEntry;
  bid: number | null;
  ask: number | null;
  now: number;
  /** Account-currency result if the trade exits at this price, or null when unknown. */
  exitMoney: (price: number | null) => string | null;
  /** Open trades: the broker's current unrealized P/L label. */
  livePL: string | null;
  livePLColor: string | null;
  /** Shown when the trade has no stop; starts the level editor with one added. */
  onAddStop: (() => void) | null;
}) {
  const instrument = entry.instrument as MajorInstrument;
  const pip = pipSizeFor(instrument);
  const price = (value: number) => formatChartPrice(value, instrument);
  const open = entry.status === "TRIGGERED";
  const long = entry.direction === "long";
  const entryPrice = open ? entry.triggerPrice ?? entry.entryPrice : entry.entryPrice;
  // A short fills on the bid, a long on the ask.
  const current = long ? ask : bid;
  const distance = !open && current !== null ? (entryPrice - current) / pip : null;
  const units = typeof entry.metadata.units === "number" && entry.metadata.units > 0 ? entry.metadata.units : null;
  const spread = bid !== null && ask !== null ? (ask - bid) / pip : null;
  const orderType = entry.entryOrderType.replace("_", " ");
  const live = livePL?.replace(/^P\/L /, "") ?? null;
  const money = (value: number | null) => {
    const label = exitMoney(value);
    return label ? <span className="nl-ts-money metric-number">{label}</span> : null;
  };

  // Unset levels sit on their natural side of entry: a long's stop below it.
  const offset = 1;
  const rungs: Rung[] = [
    {
      key: "stop",
      label: "Stop loss",
      price: entry.stopPrice,
      sortPrice: entry.stopPrice ?? entryPrice + (long ? -offset : offset),
      right: entry.stopPrice === null
        ? (onAddStop ? <button type="button" className="nl-ts-add pressable" onClick={onAddStop}><Plus aria-hidden="true" />Add</button> : null)
        : money(entry.stopPrice),
      note: entry.stopPrice === null ? "Loss isn't capped" : undefined,
    },
    {
      key: "entry",
      label: open ? "Filled" : "Entry",
      price: entryPrice,
      sortPrice: entryPrice,
      right: open
        ? (live ? <span className="nl-ts-money metric-number" style={livePLColor ? { color: livePLColor } : undefined}>{live}</span> : null)
        : distance !== null
          ? <span className="nl-ts-away metric-number">{Math.abs(distance).toFixed(1)} p {distance > 0 ? "above" : "below"}</span>
          : null,
    },
    {
      key: "target",
      label: "Take profit",
      price: entry.targetPrice,
      sortPrice: entry.targetPrice ?? entryPrice + (long ? offset : -offset),
      right: entry.targetPrice === null ? null : money(entry.targetPrice),
    },
  ];
  rungs.sort((a, b) => b.sortPrice - a.sortPrice);

  return (
    <div className="nl-ts">
      <div className="nl-ts-head">
        <span className={`nl-ts-badge ${open ? "is-open" : "is-pending"}`}>
          <i aria-hidden="true" />
          {open ? "Open" : "Waiting to fill"}
        </span>
        <span className="nl-ts-meta metric-number">
          <b className={long ? "is-long" : "is-short"}>{long ? "Long" : "Short"}</b>
          {units === null ? null : ` · ${(units / 100_000).toFixed(2)} lots`}
        </span>
      </div>
      <ol className="nl-ts-ladder">
        {rungs.map((rung) => (
          <li key={rung.key} className={`is-${rung.key}${rung.price === null ? " is-unset" : ""}`}>
            <i aria-hidden="true" />
            <div className="nl-ts-rung">
              <span>{rung.label}</span>
              <b className="metric-number">{rung.price === null ? "None" : price(rung.price)}</b>
              {rung.note ? <small>{rung.note}</small> : null}
            </div>
            {rung.right}
          </li>
        ))}
      </ol>
      <p className="nl-ts-foot metric-number">
        {open ? null : <span>{orderType.charAt(0).toUpperCase()}{orderType.slice(1)}</span>}
        {spread === null ? null : <span>Spread {spread.toFixed(1)} p</span>}
        {open ? null : <span>{expiryLabel(entry.expiresAt, now)}</span>}
      </p>
    </div>
  );
}
