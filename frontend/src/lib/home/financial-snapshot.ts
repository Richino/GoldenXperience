import type { AccountBalanceHistoryPoint, AccountSummary, OpenPosition } from "@/types/forex";
import type { OpenPositionFill } from "@/lib/market-stream/use-open-positions";

export type HomeFinancialSnapshot = {
  data: AccountSummary;
  positions: OpenPosition[];
  history: AccountBalanceHistoryPoint[];
  checkedAt: string;
  lastTransactionID: string;
};

/** A transaction occurring during the history fetch belongs to the next frame. */
export function historyAtSnapshot(history: AccountBalanceHistoryPoint[], transactionId: string, balance: number) {
  if (!/^\d+$/.test(transactionId)) throw new Error("Missing broker transaction boundary.");
  const boundary = BigInt(transactionId);
  const result = history.filter(point => /^\d+$/.test(point.id) && BigInt(point.id) <= boundary);
  const last = result.at(-1);
  if (last && Math.abs(last.balance - balance) > 0.005) throw new Error("Account history has not caught up with the broker snapshot.");
  return result;
}

export function snapshotFills(snapshot: HomeFinancialSnapshot) {
  const { data: account, positions } = snapshot;
  if (!Array.isArray(snapshot.history) || snapshot.history.some(point => ![point.balance, point.change].every(Number.isFinite) || !Number.isFinite(Date.parse(point.time)))) throw new Error("Invalid history snapshot.");
  historyAtSnapshot(snapshot.history, snapshot.lastTransactionID, account.balance);
  if (account.source !== "oanda" || ![account.balance, account.nav, account.unrealizedPL].every(Number.isFinite) ||
      !Number.isFinite(Date.parse(snapshot.checkedAt)) || positions.length !== account.openTradeCount ||
      Math.abs(account.nav - account.balance - account.unrealizedPL) > 0.02) throw new Error("Invalid account snapshot.");
  const fills: Record<string, OpenPositionFill> = {};
  let total = 0;
  for (const position of positions) {
    if (position.source !== "oanda" || ![position.entryPrice, position.units, position.unrealizedPL, position.currentPrice].every(Number.isFinite) || fills[`broker:${position.id}`]) throw new Error("Invalid position snapshot.");
    const fill: OpenPositionFill = {
      brokerTradeId: position.id, price: position.entryPrice, units: Math.abs(position.units),
      stopPrice: position.stopPrice ?? null, currentPrice: position.currentPrice,
      currentBid: position.currentBid ?? null, currentAsk: position.currentAsk ?? null,
      unrealizedPL: position.unrealizedPL,
    };
    fills[`broker:${position.id}`] = fill;
    fills[position.instrument] ??= fill;
    total += position.unrealizedPL;
  }
  if (Math.abs(total - account.unrealizedPL) > 0.01 * (positions.length + 1)) throw new Error("Account and position P/L disagree.");
  return fills;
}
