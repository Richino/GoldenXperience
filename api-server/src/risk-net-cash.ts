import { requestPracticeAccount } from "../../frontend/src/lib/oanda/client.js";

type Leg = { tradeID?: string; units?: string; realizedPL?: string; financing?: string; guaranteedExecutionFee?: string };
type Fill = { type?: string; units?: string; commission?: string; tradeOpened?: Leg; tradesClosed?: Leg[]; tradeReduced?: Leg };
type Trade = { id?: string; state?: string; initialUnits?: string; currentUnits?: string; realizedPL?: string; unrealizedPL?: string; financing?: string; closingTransactionIDs?: string[] };
type ReadBroker = (suffix: string) => Promise<unknown>;
const amount = (value: unknown) => typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

/** Read-only, account-currency ledger reconstruction. Missing costs are not
 * zero. Entry commission is allocated by units to the independently opened
 * trade; partial closures consume proportional entry costs once. Bid/ask
 * spread is already in broker P/L and is never subtracted a second time. */
export async function readRiskNetCash(tradeId: string, read: ReadBroker = suffix => requestPracticeAccount(suffix)) {
  if (!/^\d+$/.test(tradeId)) return null;
  const response = await read(`/trades/${tradeId}`) as { trade?: Trade };
  const t = response.trade;
  if (!t || t.id !== tradeId || !["OPEN", "CLOSED"].includes(t.state ?? "")) return null;
  const initial = amount(t.initialUnits), remaining = amount(t.currentUnits), realized = amount(t.realizedPL), floating = amount(t.unrealizedPL), financing = amount(t.financing);
  if (initial === null || remaining === null || realized === null || floating === null || financing === null || !Math.abs(initial) || Math.abs(remaining) > Math.abs(initial)) return null;
  const fullyClosed = t.state === "CLOSED";
  if (fullyClosed ? remaining !== 0 || floating !== 0 : remaining === 0 || Math.sign(remaining) !== Math.sign(initial)) return null;
  const closeIds = t.closingTransactionIDs ?? [];
  if (closeIds.length > 100 || new Set(closeIds).size !== closeIds.length || closeIds.some(id => !/^\d+$/.test(id))) return null;
  const opening = await read(`/transactions/${tradeId}`) as { transaction?: Fill };
  const open = opening.transaction;
  const openCommission = amount(open?.commission), orderUnits = amount(open?.units), openedUnits = amount(open?.tradeOpened?.units), openFee = amount(open?.tradeOpened?.guaranteedExecutionFee);
  if (open?.type !== "ORDER_FILL" || open.tradeOpened?.tradeID !== tradeId || openCommission === null || openCommission < 0 || orderUnits === null || openedUnits === null || openFee === null || openFee < 0 || !Math.abs(orderUnits) || Math.abs(openedUnits) !== Math.abs(initial) || Math.abs(openedUnits) > Math.abs(orderUnits)) return null;
  const entryCosts = openCommission * Math.abs(initial / orderUnits) + openFee;
  let closedUnits = 0, closeCosts = 0, closedFinancing = 0, closedPl = 0;
  for (const id of closeIds) {
    const result = await read(`/transactions/${id}`) as { transaction?: Fill };
    const tx = result.transaction;
    const legs = [...(tx?.tradesClosed ?? []), ...(tx?.tradeReduced ? [tx.tradeReduced] : [])].filter(leg => leg.tradeID === tradeId);
    const commission = amount(tx?.commission), units = amount(tx?.units);
    if (tx?.type !== "ORDER_FILL" || legs.length !== 1 || commission === null || commission < 0 || units === null || !Math.abs(units)) return null;
    const leg = legs[0], reduction = amount(leg.units), fee = amount(leg.guaranteedExecutionFee), finance = amount(leg.financing), pl = amount(leg.realizedPL);
    if (reduction === null || !Math.abs(reduction) || Math.abs(reduction) > Math.abs(units) || fee === null || fee < 0 || finance === null || pl === null) return null;
    closedUnits += Math.abs(reduction); closeCosts += commission * Math.abs(reduction / units) + fee; closedFinancing += finance; closedPl += pl;
  }
  if (Math.abs(closedUnits + Math.abs(remaining) - Math.abs(initial)) > 0.00001 || Math.abs(closedPl - realized) > 0.01) return null;
  const closedFraction = closedUnits / Math.abs(initial);
  return { state: t.state, remainingUnits: Math.abs(remaining), brokerUnrealizedPL: floating,
    // At full closure, all cumulative financing belongs to the realized
    // result, including charges booked before the closing fill.
    realizedNetPnlUsd: realized + (fullyClosed ? financing : closedFinancing) - closeCosts - entryCosts * closedFraction,
    unrealizedNetPnlUsd: fullyClosed ? 0 : floating + financing - closedFinancing - entryCosts * (1 - closedFraction),
    complete: true as const, costBasis: "OANDA trade and fill transactions; commission allocated by units; fees explicit" };
}
