"use client";

/**
 * Several trades at once on the Chart page (canvas "Chart — Multiple open &
 * pending trades"). One book lists every live manual trade across pairs plus
 * this pair's open strategy trades, numbered oldest first so a trade keeps its
 * number in the list and on the chart. One trade is selected at a time: it
 * owns the chart's stop / entry / target and the trade actions; the others on
 * this pair draw only their entry.
 *
 * Desktop shows the book in the side column; the phone steps through this
 * pair's trades in its position strip and opens the whole book in a sheet.
 */

import { useEffect, useState } from "react";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { formatChartPrice } from "@/lib/chart-utils";
import type { MajorInstrument, PaperChartTrade } from "@/types/forex";
import type { PendingManualEntry } from "@/types/pending-entry";

export type BookItem = {
  /** The pending entry's id, or the strategy paper trade's id. */
  id: string;
  number: number;
  instrument: string;
  kind: "open" | "pending";
  /** Manual entries can be selected, cancelled or closed here; strategy trades are shown only. */
  source: "manual" | "strategy";
  direction: "long" | "short";
  /** "Buy limit", "Sell stop" … for a pending order. */
  orderLabel: string | null;
  entry: number;
  stop: number | null;
  target: number | null;
  /** Fill time for an open trade, creation time for an order. */
  since: string;
  expiresAt: string | null;
  news: boolean;
};

const ORDER_LABEL: Record<PendingManualEntry["entryOrderType"], string> = {
  buy_limit: "Buy limit",
  buy_stop: "Buy stop",
  sell_limit: "Sell limit",
  sell_stop: "Sell stop",
};

/** Same membership as the chart's pairTrades, across every pair. */
export function isLiveEntry(entry: PendingManualEntry) {
  const live = entry.status === "PENDING" || entry.status === "TRIGGERING" ||
    (entry.status === "TRIGGERED" && entry.paperTradeStatus === "open");
  // A News setup is two linked rows; while both wait, list it once (its BUY row).
  const newsLowerTwin = entry.metadata?.mode === "news" && entry.status === "PENDING" && entry.metadata?.line === "lower";
  return live && !newsLowerTwin;
}

export function buildTradeBook(entries: PendingManualEntry[], openStrategyTrades: PaperChartTrade[]): BookItem[] {
  const manualPaperIds = new Set(entries.map((entry) => entry.paperTradeId).filter(Boolean));
  const items: Omit<BookItem, "number">[] = [
    ...entries.filter(isLiveEntry).map((entry) => ({
      id: entry.id,
      instrument: entry.instrument,
      kind: entry.status === "TRIGGERED" ? "open" as const : "pending" as const,
      source: "manual" as const,
      direction: entry.direction,
      orderLabel: entry.status === "TRIGGERED" ? null : ORDER_LABEL[entry.entryOrderType],
      entry: entry.entryPrice,
      stop: entry.stopPrice,
      target: entry.targetPrice,
      since: entry.triggeredAt ?? entry.createdAt,
      expiresAt: entry.expiresAt,
      news: entry.metadata?.mode === "news",
    })),
    ...openStrategyTrades
      .filter((trade) => trade.status === "open" && trade.closedAt === null && !manualPaperIds.has(trade.id))
      .map((trade) => ({
        id: trade.id,
        instrument: trade.instrument,
        kind: "open" as const,
        source: "strategy" as const,
        direction: trade.direction,
        orderLabel: null,
        entry: trade.entry,
        stop: trade.stop,
        target: trade.target,
        since: trade.openedAt,
        expiresAt: null,
        news: false,
      })),
  ];
  return items
    .sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id))
    .map((item, index) => ({ ...item, number: index + 1 }));
}

const pairLabel = (instrument: string) => displayNameFor(instrument as MajorInstrument);
const price = (value: number | null, instrument: string) =>
  value === null ? "—" : formatChartPrice(value, instrument as MajorInstrument);

function sinceLabel(item: BookItem, now: number | null) {
  if (now === null) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(item.since)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The number column: an open trade's move and R, a pending order's distance
 * to its entry. Only the charted pair has a live price here; other pairs show
 * their entry until they are opened.
 */
export function bookReadout(item: BookItem, mark: number | null) {
  if (mark === null) return { main: price(item.entry, item.instrument), sub: item.kind === "open" ? "entry" : "entry", tone: "" };
  const pip = pipSizeFor(item.instrument);
  if (item.kind === "pending") {
    return { main: price(item.entry, item.instrument), sub: `${(Math.abs(mark - item.entry) / pip).toFixed(1)} p away`, tone: "" };
  }
  const sign = item.direction === "long" ? 1 : -1;
  const pips = ((mark - item.entry) * sign) / pip;
  const risk = item.stop === null ? null : Math.abs(item.entry - item.stop) / pip;
  const signed = (value: number, digits: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;
  return {
    main: `${signed(pips, 1)} p`,
    sub: risk ? `${signed(pips / risk, 2)}R` : "no stop",
    tone: Math.abs(pips) < 0.05 ? "" : pips > 0 ? "is-up" : "is-down",
  };
}

/** Line under the label: what the line on the chart means for this item. */
export function bookLineLabel(item: BookItem, mark: number | null) {
  const pip = pipSizeFor(item.instrument);
  if (item.kind === "pending") {
    const away = mark === null ? "" : ` · ${(Math.abs(mark - item.entry) / pip).toFixed(1)} p away`;
    return `#${item.number} ${(item.orderLabel ?? "Order").toUpperCase()} · ${price(item.entry, item.instrument)}${away}`;
  }
  return `#${item.number} ${item.direction === "long" ? "LONG" : "SHORT"} · Entry ${price(item.entry, item.instrument)}`;
}

type RowProps = {
  item: BookItem;
  selected: boolean;
  mark: number | null;
  now: number | null;
  onSelect?: (item: BookItem) => void;
};

function BookRow({ item, selected, mark, now, onSelect }: RowProps) {
  const readout = bookReadout(item, mark);
  const side = item.kind === "pending" ? item.orderLabel ?? "Order" : item.direction === "long" ? "Long" : "Short";
  const sideTone = item.kind === "pending" ? "is-pend" : item.direction === "long" ? "is-up" : "is-down";
  // The entry shows here only when the readout on the right is not already it.
  const meta = [
    item.kind === "pending"
      ? [item.stop !== null ? `SL ${price(item.stop, item.instrument)}` : null, item.target !== null ? `TP ${price(item.target, item.instrument)}` : null].filter(Boolean).join("  ")
      : mark !== null ? `Entry ${price(item.entry, item.instrument)}` : null,
    item.kind === "open" ? sinceLabel(item, now) : null,
    item.source === "strategy" ? "Strategy" : item.news ? "News OCO" : null,
  ].filter(Boolean).join(" · ");
  const body = (
    <>
      <span className="nl-book-id">
        <span className="nl-book-line">
          <span className="nl-book-num metric-number">#{item.number}</span>
          <b>{pairLabel(item.instrument)}</b>
          <span className={`nl-book-side ${sideTone}`}>{side}</span>
        </span>
        <span className="nl-book-meta metric-number">{meta}</span>
      </span>
      <span className="nl-book-read">
        <span className={`nl-book-main metric-number ${readout.tone}`}>{readout.main}</span>
        <span className={`nl-book-sub metric-number ${readout.tone}`}>{readout.sub}</span>
      </span>
    </>
  );
  return onSelect ? (
    <button type="button" className={`nl-book-row${selected ? " is-selected" : ""}`} onClick={() => onSelect(item)} aria-pressed={selected}>
      {body}
    </button>
  ) : (
    <div className={`nl-book-row is-static${selected ? " is-selected" : ""}`}>{body}</div>
  );
}

/** Desktop side column: counts, then Open and Pending lists, filterable to this pair. */
export function ChartTradeBook({
  items,
  instrument,
  selectedId,
  mark,
  onSelect,
}: {
  items: BookItem[];
  instrument: string;
  selectedId: string | null;
  mark: number | null;
  onSelect: (item: BookItem) => void;
}) {
  const now = useNow(30_000);
  const [thisPairOnly, setThisPairOnly] = useState(false);
  const shown = thisPairOnly ? items.filter((item) => item.instrument === instrument) : items;
  const open = shown.filter((item) => item.kind === "open");
  const pending = shown.filter((item) => item.kind === "pending");
  const onPair = items.filter((item) => item.instrument === instrument).length;
  const pairs = new Set(items.map((item) => item.instrument)).size;
  // A fixed order, oldest first as the chart numbers them, so clicking a row
  // (and the chart switching pairs) never reshuffles the list.
  const order = (list: BookItem[]) => [...list].sort((a, b) => a.number - b.number);
  const row = (item: BookItem) => (
    <BookRow
      key={item.id}
      item={item}
      selected={item.id === selectedId}
      mark={item.instrument === instrument ? mark : null}
      now={now}
      onSelect={onSelect}
    />
  );

  return (
    <section className="nl-cside-card nl-book" aria-labelledby="nl-book-title">
      {items.length ? (
        <dl className="nl-book-counts">
          <div><dt>Open</dt><dd className="metric-number">{items.filter((item) => item.kind === "open").length}</dd></div>
          <div><dt>Pending</dt><dd className="metric-number">{items.filter((item) => item.kind === "pending").length}</dd></div>
          <div><dt>Pairs</dt><dd className="metric-number">{pairs}</dd></div>
        </dl>
      ) : null}
      <div className="nl-cside-head">
        <h2 id="nl-book-title">Trades</h2>
        {items.length ? <span className="nl-book-head-end">
          <span className="nl-book-filter" role="group" aria-label="Trades shown">
            <button type="button" aria-pressed={!thisPairOnly} className={!thisPairOnly ? "is-on" : undefined} onClick={() => setThisPairOnly(false)}>
              All <span className="metric-number">{items.length}</span>
            </button>
            <button type="button" aria-pressed={thisPairOnly} className={thisPairOnly ? "is-on" : undefined} onClick={() => setThisPairOnly(true)}>
              {pairLabel(instrument)} <span className="metric-number">{onPair}</span>
            </button>
          </span>
        </span> : null}
      </div>
      {open.length ? <p className="nl-book-group">Open · {open.length}</p> : null}
      {order(open).map(row)}
      {pending.length ? <p className="nl-book-group">Pending · {pending.length}</p> : null}
      {order(pending).map(row)}
      {!items.length ? (
        <div className="nl-book-empty">
          <b>No open trades or orders</b>
          <span>Positions and pending entries on any pair show up here.</span>
        </div>
      ) : !shown.length ? (
        <div className="nl-book-empty">
          <b>Nothing on {pairLabel(instrument)}</b>
          <button type="button" onClick={() => setThisPairOnly(false)}>
            Show {items.length} on other {pairs === 1 ? "pair" : "pairs"} →
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Phone position strip header: step through this pair's trades, open the book. */
export function ChartMobileTradePager({
  pairItems,
  selectedId,
  total,
  onStep,
  onOpenAll,
}: {
  pairItems: BookItem[];
  selectedId: string | null;
  total: number;
  onStep: (item: BookItem) => void;
  onOpenAll: () => void;
}) {
  if (!total) return null;
  // A lone trade on this pair is already the strip below; the header only earns
  // its place when there is another trade to step to or one elsewhere to find.
  if (total === 1 && pairItems.length === 1) return null;
  const index = Math.max(0, pairItems.findIndex((item) => item.id === selectedId));
  const many = pairItems.length > 1;
  const step = (delta: number) => {
    const next = pairItems[(index + delta + pairItems.length) % pairItems.length];
    if (next) onStep(next);
  };
  return (
    <div className="nl-mpager">
      {many ? (
        <span className="nl-mpager-step">
          <button type="button" className="nl-mpager-btn pressable" onClick={() => step(-1)} aria-label="Previous trade on this pair">‹</button>
          <span className="metric-number">{index + 1} of {pairItems.length}</span>
          <button type="button" className="nl-mpager-btn pressable" onClick={() => step(1)} aria-label="Next trade on this pair">›</button>
        </span>
      ) : (
        <span className="nl-mpager-note">
          <b>Trades</b>
          <span>
            {pairItems.length ? "1 on this pair" : `None on this pair · ${total} elsewhere`}
          </span>
        </span>
      )}
      {many ? (
        <span className="nl-mpager-dots" aria-hidden="true">
          {pairItems.map((item, dot) => (
            <i key={item.id} className={`${item.kind === "pending" ? "is-pend" : ""}${dot === index ? " is-on" : ""}`} />
          ))}
        </span>
      ) : null}
      {total ? (
        <button type="button" className="nl-mpager-all pressable" onClick={onOpenAll}>
          All <span className="metric-number">{total}</span>
          <span aria-hidden="true" className="nl-mpager-chev">›</span>
        </button>
      ) : null}
    </div>
  );
}

/** Phone sheet with the whole book; rows select, the trailing button acts. */
export function ChartTradesSheet({
  open,
  onClose,
  items,
  instrument,
  selectedId,
  mark,
  onSelect,
  onAct,
}: {
  open: boolean;
  onClose: () => void;
  items: BookItem[];
  instrument: string;
  selectedId: string | null;
  mark: number | null;
  onSelect: (item: BookItem) => void;
  /** Close (open trade) or Cancel (order) on this pair; another pair opens it. */
  onAct: (item: BookItem) => void;
}) {
  const now = useNow(30_000);
  const [thisPairOnly, setThisPairOnly] = useState(false);
  const shown = thisPairOnly ? items.filter((item) => item.instrument === instrument) : items;
  const groups = [
    { title: "Open", list: shown.filter((item) => item.kind === "open") },
    { title: "Pending", list: shown.filter((item) => item.kind === "pending") },
  ];
  return (
    <MobileSheet open={open} onClose={onClose} eyebrow="Chart" title="All trades" lockPageScroll={false} className="nl-trades-sheet">
      <div className="nl-book nl-book-sheet">
        <dl className="nl-book-counts">
          <div><dt>Open</dt><dd className="metric-number">{groups[0]!.list.length}</dd></div>
          <div><dt>Pending</dt><dd className="metric-number">{groups[1]!.list.length}</dd></div>
          <div><dt>Pairs</dt><dd className="metric-number">{new Set(shown.map((item) => item.instrument)).size}</dd></div>
        </dl>
        <div className="nl-book-filter is-wide" role="group" aria-label="Trades shown">
          <button type="button" aria-pressed={!thisPairOnly} className={!thisPairOnly ? "is-on" : undefined} onClick={() => setThisPairOnly(false)}>
            All <span className="metric-number">{items.length}</span>
          </button>
          <button type="button" aria-pressed={thisPairOnly} className={thisPairOnly ? "is-on" : undefined} onClick={() => setThisPairOnly(true)}>
            {pairLabel(instrument)} <span className="metric-number">{items.filter((item) => item.instrument === instrument).length}</span>
          </button>
        </div>
        {groups.map((group) => group.list.length ? (
          <div key={group.title}>
            <p className="nl-book-group">{group.title} · {group.list.length}</p>
            {group.list.map((item) => {
              const here = item.instrument === instrument;
              const actionable = item.source === "manual";
              return (
                <div key={item.id} className="nl-book-sheet-row">
                  <BookRow item={item} selected={item.id === selectedId} mark={here ? mark : null} now={now}
                    onSelect={(picked) => { onSelect(picked); onClose(); }} />
                  {actionable ? (
                    <button type="button" className={`nl-book-act pressable${here ? " is-danger" : ""}`} onClick={() => onAct(item)}>
                      {here ? item.kind === "open" ? "Close" : "Cancel" : "Open"}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null)}
        {!shown.length ? <p className="nl-cside-empty">No open trades or orders.</p> : null}
      </div>
    </MobileSheet>
  );
}
