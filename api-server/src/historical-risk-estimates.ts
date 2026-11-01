import { monetaryRatio, type HistoricalRiskEstimate } from "../../frontend/src/lib/risk-metrics.js";

type HistoricalEntry = { id: string; paper_trade_id: string; instrument: string; direction: string; created_at: string | Date; metadata: Record<string, unknown> };
type BrokerTransaction = { id?: string; accountID?: string; type?: string; time?: string; instrument?: string; units?: string; price?: string;
  orderID?: string; clientExtensions?: { id?: string }; stopLossOnFill?: { price?: string };
  tradeOpened?: { tradeID?: string; units?: string }; lossQuoteHomeConversionFactor?: string };
const amount = (v: unknown) => (typeof v === "string" && v.trim() !== "" || typeof v === "number") && Number.isFinite(Number(v)) ? Number(v) : null;

/** Requires the original app-owned order and its exact opening fill. Never
 * reads a current stop, current FX quote, current balance or current policy. */
export function reconstructManualRiskEstimate(entry: HistoricalEntry, order: BrokerTransaction, fill: BrokerTransaction, accountId: string): HistoricalRiskEstimate | null {
  const meta = entry.metadata;
  const orderAt = Date.parse(order.time ?? ""), fillAt = Date.parse(fill.time ?? "");
  const createdAt = new Date(entry.created_at).getTime();
  const client = order.clientExtensions?.id ?? "", expected = `gx-${entry.id}`;
  if (!accountId || order.accountID !== accountId || fill.accountID !== accountId ||
    !/^(STOP|LIMIT|MARKET_IF_TOUCHED)_ORDER$/.test(order.type ?? "") || fill.type !== "ORDER_FILL" ||
    order.id !== meta.brokerOrderId || fill.id !== meta.brokerTradeId || fill.orderID !== order.id || fill.tradeOpened?.tradeID !== fill.id ||
    order.instrument !== entry.instrument || fill.instrument !== entry.instrument ||
    !(client === expected || client.startsWith(`${expected}-r`)) || !Number.isFinite(orderAt) || !Number.isFinite(fillAt) || orderAt > fillAt ||
    !Number.isFinite(createdAt) || createdAt > orderAt + 1000) return null;
  const units = amount(fill.tradeOpened?.units), requested = amount(order.units), savedUnits = amount(meta.units), price = amount(order.price);
  const stop = amount(meta.sizingStop) ?? amount(order.stopLossOnFill?.price);
  const rate = entry.instrument.endsWith("_USD") ? 1 : amount(fill.lossQuoteHomeConversionFactor);
  const sign = entry.direction === "long" ? 1 : entry.direction === "short" ? -1 : 0;
  if (!units || !requested || !savedUnits || !sign || Math.sign(units) !== sign || Math.sign(requested) !== sign ||
    Math.abs(units) > Math.abs(requested) || Math.abs(savedUnits) !== Math.abs(requested) ||
    !(price && price > 0) || !(stop && stop > 0) || price === stop || !(rate && rate > 0)) return null;
  const risk = Math.abs(units) * Math.abs(price - stop) * rate;
  if (!(risk > 0) || !Number.isFinite(risk)) return null;
  return { version: 1, currency: "USD", positionKey: entry.paper_trade_id, riskUsd: risk, evidenceAt: order.time!,
    basis: `Original order ${order.id} sizing distance × opened units × opening-fill USD loss conversion. Sizing benchmark; no original monetary budget was recorded.` };
}

export function strategyRiskEstimate(id: string, riskUsd: number | null, decisionAt: string | Date): HistoricalRiskEstimate | null {
  if (monetaryRatio(1, riskUsd) === null || !Number.isFinite(new Date(decisionAt).getTime())) return null;
  return { version: 1, currency: "USD", positionKey: id, riskUsd: riskUsd!, evidenceAt: new Date(decisionAt).toISOString(),
    basis: "Original stored strategy nominal risk amount. Sizing benchmark; original risk provenance and P/L cost completeness are not verified." };
}
