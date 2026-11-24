"use client";

import type { ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
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
 * target, each with what it books. Tapping the stop or target rung places
 * that line on the chart to drag (a missing one is added first), so the
 * sheet is the only place that asks "add or move?".
 */
export function TradeSheetSummary({
  entry,
  bid,
  ask,
  now,
  exitMoney,
  livePL,
  livePLColor,
  onEditLevel,
  onMoreOptions,
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
  /** Opens the chart level editor on this level, adding it first when unset. Null: levels can't be edited here. */
  onEditLevel: ((key: "stop" | "target") => void) | null;
  /** A waiting order: open the full form for its entry, size or expiry. */
  onMoreOptions: (() => void) | null;
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
  // Stop / target rungs: an Add pill when unset, otherwise what it books and a
  // chevron saying the row opens. The whole row is the tap target.
  const levelRight = (value: number | null) => {
    if (!onEditLevel) return value === null ? null : money(value);
    if (value === null) return <span className="nl-ts-add" aria-hidden="true"><Plus />Add</span>;
    return <span className="nl-ts-go">{money(value)}<ChevronRight aria-hidden="true" /></span>;
  };

  // Unset levels sit on their natural side of entry: a long's stop below it.
  const offset = 1;
  const rungs: Rung[] = [
    {
      key: "stop",
      label: "Stop loss",
      price: entry.stopPrice,
      sortPrice: entry.stopPrice ?? entryPrice + (long ? -offset : offset),
      right: levelRight(entry.stopPrice),
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
      right: levelRight(entry.targetPrice),
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
        {rungs.map((rung) => {
          const level = rung.key === "entry" ? null : rung.key;
          const tappable = level !== null && onEditLevel !== null;
          return (
          <li key={rung.key} className={`is-${rung.key}${rung.price === null ? " is-unset" : ""}${tappable ? " is-tappable" : ""}`}>
            {tappable ? (
              <button
                type="button"
                className="nl-ts-hit pressable"
                onClick={() => onEditLevel(level)}
                aria-label={`${rung.price === null ? "Add" : "Move"} ${rung.label.toLowerCase()}`}
              />
            ) : null}
            <i aria-hidden="true" />
            <div className="nl-ts-rung">
              <span>{rung.label}</span>
              <b className="metric-number">{rung.price === null ? "None" : price(rung.price)}</b>
              {rung.note ? <small>{rung.note}</small> : null}
            </div>
            {rung.right}
          </li>
          );
        })}
      </ol>
      <p className="nl-ts-foot metric-number">
        {open ? null : <span>{orderType.charAt(0).toUpperCase()}{orderType.slice(1)}</span>}
        {spread === null ? null : <span>Spread {spread.toFixed(1)}</span>}
        {open || !entry.expiresAt ? null : <span>{expiryLabel(entry.expiresAt, now)}</span>}
        {onMoreOptions ? (
          <button type="button" className="nl-ts-more pressable" onClick={onMoreOptions}>
            Change entry, size or expiry
            <ChevronRight aria-hidden="true" />
          </button>
        ) : null}
      </p>
    </div>
  );
}
