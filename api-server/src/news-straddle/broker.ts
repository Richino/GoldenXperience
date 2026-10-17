import { createHash } from "node:crypto";
import { OandaRequestError, requestPracticeAccount, closePracticeTrade, getCandles, oandaEnvironment } from "../../../frontend/src/lib/oanda/client.js";
import { currenciesOf, pipSizeFor, precisionFor } from "../../../frontend/src/lib/instruments/catalog.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import type { NewsLeg, NewsRun } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import type { NewsQuote } from "./policy.js";

export type BrokerTransaction = { id: string; type: string; time: string; instrument?: string; orderID?: string; clientOrderID?: string; clientExtensions?: { id?: string }; price?: string; units?: string; reason?: string; pl?: string;
  tradeOpened?: { tradeID: string; units?: string; price?: string }; tradeReduced?: { tradeID: string; units?: string; realizedPL?: string }; tradesClosed?: Array<{ tradeID: string; realizedPL?: string }>; fullPrice?: { bids?: Array<{ price: string }>; asks?: Array<{ price: string }> } };
export type OrderObservation = { id: string; state: "PENDING" | "FILLED" | "CANCELLED"; time?: string; reason?: string; fill?: BrokerTransaction };
export type TradeObservation = { id: string; state: string; instrument: string; units: number; entry: number; openedAt: string; stop: number | null; trailId: string | null; trailValue: number | null; trailDistance: number | null; target: number | null; realizedPL: number; closedAt: string | null; exit: number | null; clientId: string | null };
export type BrokerContext = { quote: NewsQuote; equity: number; currency: string; conversion: number; atrPips: number | null; lastTransactionId: string;
  constraints: NonNullable<NewsRun["constraints"]>; clock: NonNullable<NewsRun["clock"]>; openInstruments: string[]; pendingInstruments: string[] };
export interface NewsBroker {
  environment(): string | null; context(instrument: string): Promise<BrokerContext>;
  submit(run: NewsRun, leg: NewsLeg): Promise<{ order: OrderObservation | null; transactions: BrokerTransaction[] }>;
  order(clientId: string): Promise<OrderObservation | null>; cancel(clientId: string): Promise<string | null>;
  trade(id: string): Promise<TradeObservation | null>; ownedTrades(run: NewsRun): Promise<TradeObservation[]>;
  addTrailing(id: string, distance: number, instrument: string): Promise<string>;
  close(id: string): Promise<unknown>; transactions(since: string): Promise<{ transactions: BrokerTransaction[]; lastTransactionID: string }>;
}
export const accountKey = () => createHash("sha256").update(`practice:${process.env.OANDA_ACCOUNT_ID ?? "unconfigured"}`).digest("hex");
const number = (n: unknown) => n === undefined || n === null || n === "" || !Number.isFinite(Number(n)) ? null : Number(n);
const enc = (id: string) => encodeURIComponent(id).replace(/^%40/, "@");
type RawOrder = { id: string; state: OrderObservation["state"]; createTime?: string; cancellingTransactionID?: string; fillingTransactionID?: string; price?: string; distance?: string; trailingStopValue?: string };
type RawTrade = { id: string; state: string; instrument: string; currentUnits: string; price: string; openTime: string; stopLossOrder?: RawOrder; trailingStopLossOrder?: RawOrder; takeProfitOrder?: RawOrder; realizedPL?: string; financing?: string; commission?: string; guaranteedExecutionFees?: string; closeTime?: string; averageClosePrice?: string; clientExtensions?: { id?: string } };
function tradeOf(t: RawTrade): TradeObservation {
  const pending = (o?: RawOrder) => o?.state === "PENDING";
  return { id: t.id, state: t.state, instrument: t.instrument, units: Number(t.currentUnits), entry: Number(t.price), openedAt: t.openTime,
    stop: pending(t.stopLossOrder) ? number(t.stopLossOrder?.price) : null,
    trailId: pending(t.trailingStopLossOrder) ? t.trailingStopLossOrder!.id : null,
    trailValue: pending(t.trailingStopLossOrder) ? number(t.trailingStopLossOrder?.trailingStopValue) : null,
    trailDistance: pending(t.trailingStopLossOrder) ? number(t.trailingStopLossOrder?.distance) : null,
    target: pending(t.takeProfitOrder) ? number(t.takeProfitOrder?.price) : null,
    realizedPL: Number(t.realizedPL ?? 0) + Number(t.financing ?? 0) - Number(t.commission ?? 0) - Number(t.guaranteedExecutionFees ?? 0),
    closedAt: t.closeTime ?? null, exit: number(t.averageClosePrice), clientId: t.clientExtensions?.id ?? null };
}
export function stopOrderBody(run: NewsRun, leg: NewsLeg) {
  if (!(leg.units >= 1) || !leg.entry || !leg.bound || !leg.stopDistance) throw new Error("A STOP entry needs valid units, price bound and mandatory initial stop.");
  const digits = precisionFor(run.instrument);
  return { order: { type: "STOP", instrument: run.instrument, units: String(leg.side === "long" ? leg.units : -leg.units),
    price: leg.entry.toFixed(digits), priceBound: leg.bound.toFixed(digits), triggerCondition: "DEFAULT", positionFill: "REDUCE_FIRST",
    timeInForce: "GTD", gtdTime: new Date(Date.parse(run.release.time) + run.settings.windowSeconds * 1000).toISOString(),
    stopLossOnFill: { distance: leg.stopDistance.toFixed(digits), timeInForce: "GTC" },
    clientExtensions: { id: leg.clientId, tag: "gx-news-v3" }, tradeClientExtensions: { id: leg.tradeClientId, tag: "gx-news-v3" } } };
}
export const liveNewsBroker: NewsBroker = {
  environment: oandaEnvironment,
  async context(instrument) {
    const [summary, instruments, open, pending, candles] = await Promise.all([
      requestPracticeAccount<{ account: { NAV: string; currency: string; lastTransactionID: string; mt4AccountID?: number } }>("/summary"),
      requestPracticeAccount<{ instruments: Array<{ name: string; displayPrecision: number; minimumTrailingStopDistance: string; maximumTrailingStopDistance: string; minimumTradeSize: string; maximumOrderUnits: string; tradeUnitsPrecision: number }> }>(`/instruments?instruments=${enc(instrument)}`),
      requestPracticeAccount<{ trades: RawTrade[] }>("/openTrades"), requestPracticeAccount<{ orders: Array<{ instrument: string }> }>("/pendingOrders"),
      getCandles(instrument as MajorInstrument, "M1", 30),
    ]);
    // Read executable pricing last; slower history/account requests must not age it.
    const started = Date.now();
    const pricing = await requestPracticeAccount<{ time: string; prices: Array<{ instrument: string; time: string; status: string; bids: Array<{ price: string }>; asks: Array<{ price: string }> }>; homeConversions: Array<{ currency: string; accountLoss: string; accountGain: string }> }>(`/pricing?instruments=${enc(instrument)}&includeHomeConversions=true`);
    const received = Date.now(), serverAt = Date.parse(pricing.time);
    const q = pricing.prices.find(p => p.instrument === instrument);
    if (!q) throw new Error("OANDA returned no price for the selected instrument.");
    if (summary.account.mt4AccountID) throw new Error("This strategy requires an unlinked v20 practice account with client order identifiers.");
    const spec = instruments.instruments.find(i => i.name === instrument);
    if (!spec || spec.displayPrecision !== precisionFor(instrument) || spec.tradeUnitsPrecision !== 0) throw new Error("Broker precision does not match the supported instrument configuration.");
    const { quote } = currenciesOf(instrument);
    const conversion = quote === summary.account.currency ? 1 : Math.max(...(pricing.homeConversions ?? []).filter(c => c.currency === quote).map(c => Math.max(Number(c.accountLoss), Number(c.accountGain))));
    const closed = candles.status.state === "connected" && candles.data.source === "oanda" ? candles.data.candles.filter(c => c.complete === true && Date.parse(c.time) + 60_000 <= received) : [];
    let atrPips: number | null = null;
    if (closed.length >= 15 && received - Date.parse(closed.at(-1)!.time) <= 120_000 && closed.slice(-15).every((c, i, a) => !i || Date.parse(c.time) - Date.parse(a[i - 1]!.time) === 60_000)) {
      const last = closed.slice(-15);
      atrPips = last.slice(1).reduce((sum, c, i) => sum + Math.max(c.high - c.low, Math.abs(c.high - last[i]!.close), Math.abs(c.low - last[i]!.close)), 0) / 14 / pipSizeFor(instrument);
    }
    return { quote: { bid: Number(q.bids[0]?.price), ask: Number(q.asks[0]?.price), time: q.time, tradeable: q.status === "tradeable" }, equity: Number(summary.account.NAV), currency: summary.account.currency,
      conversion, atrPips, lastTransactionId: summary.account.lastTransactionID,
      constraints: { minimumTrail: Number(spec.minimumTrailingStopDistance), maximumTrail: Number(spec.maximumTrailingStopDistance), minimumUnits: Number(spec.minimumTradeSize), maximumUnits: Number(spec.maximumOrderUnits), precision: spec.displayPrecision },
      clock: { sampledAt: new Date(received).toISOString(), offsetMs: serverAt - (started + received) / 2, uncertaintyMs: (received - started) / 2 },
      openInstruments: [...new Set(open.trades.map(t => t.instrument))], pendingInstruments: [...new Set(pending.orders.map(o => o.instrument))] };
  },
  async submit(run, leg) {
    const remaining = Date.parse(run.release.time) - Date.now();
    if (remaining <= 0) throw new Error("The release already started; the STOP order was not submitted.");
    const r = await requestPracticeAccount<{ orderCreateTransaction?: BrokerTransaction; orderFillTransaction?: BrokerTransaction; orderCancelTransaction?: BrokerTransaction; orderRejectTransaction?: BrokerTransaction }>("/orders", { method: "POST", body: stopOrderBody(run, leg), signal: AbortSignal.timeout(Math.max(1, Math.min(1500, remaining))) });
    const transactions = [r.orderCreateTransaction, r.orderFillTransaction, r.orderCancelTransaction, r.orderRejectTransaction].filter((t): t is BrokerTransaction => !!t);
    const t = r.orderCreateTransaction;
    return { order: t ? { id: t.id, state: r.orderFillTransaction ? "FILLED" : r.orderCancelTransaction ? "CANCELLED" : "PENDING", time: t.time, fill: r.orderFillTransaction } : null, transactions };
  },
  async order(clientId) {
    try {
      const { order } = await requestPracticeAccount<{ order: RawOrder }>(`/orders/${enc(`@${clientId}`)}`);
      const fill = order.fillingTransactionID ? (await requestPracticeAccount<{ transaction: BrokerTransaction }>(`/transactions/${enc(order.fillingTransactionID)}`)).transaction : undefined;
      return { id: order.id, state: order.state, time: order.createTime, fill };
    } catch (error) { if (error instanceof OandaRequestError && error.status === 404) return null; throw error; }
  },
  async cancel(clientId) {
    const r = await requestPracticeAccount<{ orderCancelTransaction?: BrokerTransaction }>(`/orders/${enc(`@${clientId}`)}/cancel`, { method: "PUT" });
    return r.orderCancelTransaction?.id ?? null;
  },
  async trade(id) {
    try {
      const { trade } = await requestPracticeAccount<{ trade: RawTrade }>(`/trades/${enc(id)}`);
      const t = tradeOf(trade);
      if (t.trailId && t.trailValue === null) {
        const { order } = await requestPracticeAccount<{ order: RawOrder }>(`/orders/${enc(t.trailId)}`);
        t.trailValue = number(order.trailingStopValue);
      }
      return t;
    } catch (error) { if (error instanceof OandaRequestError && error.status === 404) return null; throw error; }
  },
  async ownedTrades(run) { const { trades } = await requestPracticeAccount<{ trades: RawTrade[] }>("/openTrades"); return trades.filter(t => Object.values(run.legs).some(l => l.tradeClientId === t.clientExtensions?.id || l.tradeId === t.id)).map(tradeOf); },
  async addTrailing(id, distance, instrument) {
    // Deliberately omit stopLoss: OANDA keeps the original stop in place.
    const r = await requestPracticeAccount<{ trailingStopLossOrderTransaction?: BrokerTransaction; trailingStopLossOrderRejectTransaction?: BrokerTransaction }>(`/trades/${enc(id)}/orders`, { method: "PUT", body: { trailingStopLoss: { distance: distance.toFixed(precisionFor(instrument)), timeInForce: "GTC" } } });
    if (!r.trailingStopLossOrderTransaction || r.trailingStopLossOrderRejectTransaction) throw new Error("Broker did not confirm a trailing stop; original stop retained.");
    return r.trailingStopLossOrderTransaction.id;
  },
  close: closePracticeTrade,
  transactions: (since) => requestPracticeAccount(`/transactions/sinceid?id=${enc(since)}`),
};
