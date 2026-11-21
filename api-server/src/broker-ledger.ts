import { requestPracticeAccount } from "../../frontend/src/lib/oanda/client.js";

/**
 * OANDA's own result for every closed practice trade. The journal's money
 * figures must come from here for broker-backed trades: strategy rows store a
 * simulated paper P/L that, for most fills, is not what the broker booked.
 */
export type BrokerClosedTrade = {
  realizedPL: number;
  financing: number;
  /** Half-spread paid on the opening and closing fills, in account currency. Already inside realizedPL; null if unreadable. */
  spreadCost: number | null;
};
export type BrokerLedger = { trades: Map<string, BrokerClosedTrade>; realizedPL: number; financing: number; spreadCost: number | null };

type OandaTrade = { id?: string; realizedPL?: string; financing?: string };
type FillLeg = { tradeID?: string; units?: string };
type OandaFill = { halfSpreadCost?: string; tradeOpened?: FillLeg; tradeReduced?: FillLeg; tradesClosed?: FillLeg[] };

/**
 * Spread paid per trade, from every ORDER_FILL. A fill that closes several
 * trades splits its spread between them by units.
 */
// Fills never change once booked, so the per-trade spread is kept for the life
// of the process and each refresh reads only transactions after the last one seen.
const spreadState = { lastId: 0, byTrade: new Map<string, number>() };

async function readSpreadByTrade(): Promise<Map<string, number>> {
  const summary: { account?: { lastTransactionID?: string } } = await requestPracticeAccount("/summary");
  const last = Number(summary.account?.lastTransactionID);
  if (!Number.isFinite(last) || last <= spreadState.lastId) return spreadState.byTrade;
  // Build on a copy so a failed page never leaves a half-read state behind.
  const spread = new Map(spreadState.byTrade);
  const add = (tradeId: string | undefined, amount: number) => {
    if (tradeId) spread.set(tradeId, (spread.get(tradeId) ?? 0) + amount);
  };
  // OANDA caps an id range at 1000 transactions.
  for (let from = spreadState.lastId + 1; from <= last; from += 1000) {
    const page: { transactions?: OandaFill[] } = await requestPracticeAccount(
      `/transactions/idrange?from=${from}&to=${Math.min(last, from + 999)}&type=ORDER_FILL`,
    );
    for (const fill of page.transactions ?? []) {
      const cost = Number(fill.halfSpreadCost);
      if (!Number.isFinite(cost) || !cost) continue;
      const legs = [fill.tradeOpened, fill.tradeReduced, ...(fill.tradesClosed ?? [])].filter((leg): leg is FillLeg => Boolean(leg?.tradeID));
      const units = legs.map((leg) => Math.abs(Number(leg.units)) || 0);
      const totalUnits = units.reduce((sum, value) => sum + value, 0);
      legs.forEach((leg, index) => add(leg.tradeID, totalUnits ? cost * units[index]! / totalUnits : cost / legs.length));
    }
  }
  spreadState.lastId = last;
  spreadState.byTrade = spread;
  return spread;
}

const LEDGER_TTL_MS = 60_000;
const PAGE = 500;
let cache: { until: number; value: Promise<BrokerLedger | null> } | null = null;

async function readLedger(): Promise<BrokerLedger> {
  // Spread is a breakdown only: if it cannot be read, P/L still is.
  const spreadByTrade = readSpreadByTrade().catch((error) => {
    console.warn("[broker-ledger] spread read failed", error instanceof Error ? error.message : error);
    return null;
  });
  const trades = new Map<string, BrokerClosedTrade>();
  let beforeId: string | null = null;
  for (;;) {
    const response: { trades?: OandaTrade[] } = await requestPracticeAccount(
      `/trades?state=CLOSED&count=${PAGE}${beforeId ? `&beforeID=${encodeURIComponent(beforeId)}` : ""}`,
    );
    const page = response.trades ?? [];
    const sizeBefore = trades.size;
    for (const trade of page) {
      const realizedPL = Number(trade.realizedPL), financing = Number(trade.financing ?? 0);
      if (!trade.id || !Number.isFinite(realizedPL) || !Number.isFinite(financing)) continue;
      trades.set(trade.id, { realizedPL, financing, spreadCost: null });
    }
    // Newest first; page backwards until a short page or no new trades.
    if (page.length < PAGE || trades.size === sizeBefore) break;
    const oldest = page.at(-1)?.id;
    if (!oldest || !/^\d+$/.test(oldest) || oldest === "1") break;
    beforeId = String(Number(oldest) - 1);
  }
  const spread = await spreadByTrade;
  let realizedPL = 0, financing = 0, spreadCost = 0;
  for (const [id, trade] of trades) {
    trade.spreadCost = spread?.get(id) ?? null;
    realizedPL += trade.realizedPL; financing += trade.financing; spreadCost += trade.spreadCost ?? 0;
  }
  return { trades, realizedPL, financing, spreadCost: spread ? spreadCost : null };
}

/** Cached for a minute; a failed read is not cached, so the next request retries. */
export function brokerClosedLedger(): Promise<BrokerLedger | null> {
  if (cache && cache.until > Date.now()) return cache.value;
  const value = readLedger().catch((error) => {
    console.warn("[broker-ledger] closed-trade read failed", error instanceof Error ? error.message : error);
    return null;
  });
  const entry = { until: Date.now() + LEDGER_TTL_MS, value };
  cache = entry;
  void value.then((ledger) => { if (!ledger && cache === entry) cache = null; });
  return value;
}
