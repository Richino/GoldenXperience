import { randomUUID } from "node:crypto";
import { pipSizeFor, precisionFor } from "../../../frontend/src/lib/instruments/catalog.js";
import { NEWS_V3_DEFAULTS, type NewsLeg, type NewsRun } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import type { BrokerContext } from "./broker.js";
import { calculateNewsRisk, schedulingQuoteIssue } from "./policy.js";

/** Manual prices share the durable broker OCO engine, without a calendar or trailing strategy. */
export function manualOcoRun(userId: string, accountKey: string, raw: Record<string, unknown>, context: BrokerContext & { ocoStopDistance: number },
  policy: { killSwitch: boolean; riskLimit: number; eventRiskLimit?: number }, now: number): NewsRun {
  const id = String(raw.requestId ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("A unique OCO request ID is required.");
  const instrument = String(raw.instrument);
  const price = (key: string) => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || Math.abs(value - Number(value.toFixed(precisionFor(instrument)))) > 1e-10) throw new Error(`Enter a valid ${key} price.`);
    return value;
  };
  const buy = price("buyEntry"), sell = price("sellEntry"), distance = context.ocoStopDistance;
  const cash = raw.riskAmount;
  if (typeof cash !== "number" || !Number.isFinite(cash) || cash <= 0 || Math.abs(cash - Number(cash.toFixed(2))) > 1e-8) throw new Error("Enter a cash risk amount with at most two decimal places.");
  if (!Number.isFinite(distance) || distance <= 0) throw new Error("A verified 4H stop distance is required.");
  const issue = schedulingQuoteIssue(context.quote, now);
  if (issue) throw new Error(issue);
  if (policy.killSwitch) throw new Error("The account execution kill switch is on.");
  if (context.openInstruments.includes(instrument) || context.pendingInstruments.includes(instrument)) throw new Error("This pair already has an open trade or pending order.");
  if (buy <= context.quote.ask || sell >= context.quote.bid || buy <= sell) throw new Error("Buy entry must be above the ask and sell entry below the bid.");
  if (buy - distance <= 0) throw new Error("Stop distance places the long stop below zero.");
  const perLeg = cash / context.equity * 100;
  if (!Number.isFinite(perLeg) || perLeg > policy.riskLimit + 1e-9 || perLeg * 2 > (policy.eventRiskLimit ?? policy.riskLimit * 2) + 1e-9) throw new Error("Cash risk exceeds the account per-order or combined risk limit.");
  const settings = { ...NEWS_V3_DEFAULTS, stopMode: "FIXED" as const, stopPips: distance / pipSizeFor(instrument),
    riskPerTradePercent: perLeg, maxEventRiskPercent: perLeg * 2, minimumStopPips: 0.1, maximumStopPips: 500, maxHoldMinutes: 0 };
  if ((context.quote.ask - context.quote.bid) / pipSizeFor(instrument) > settings.maxSpreadPips + 1e-8) throw new Error("Spread exceeds the OCO entry cap.");
  const sized = calculateNewsRisk({ trailingEnabled: false, instrument, settings, ...context, ...context.constraints, riskLimit: policy.riskLimit, eventRiskLimit: policy.eventRiskLimit });
  const slip = settings.maxSlippagePips * pipSizeFor(instrument);
  if (sell - slip <= 0) throw new Error("Sell entry is too low for a valid price bound.");
  const leg = (side: "long" | "short"): NewsLeg => ({ side, entryId: randomUUID(), clientId: `gx-oco-${id}-${side}`, tradeClientId: `gx-oco-trade-${id}-${side}`,
    state: "UNSENT", entry: side === "long" ? buy : sell, bound: Number((side === "long" ? buy + slip : sell - slip).toFixed(precisionFor(instrument))), stopDistance: distance, units: sized.units,
    orderId: null, tradeId: null, paperTradeId: null, submittedAt: null, acknowledgedAt: null, brokerTime: null, cancellationRequestedAt: null, cancellationConfirmedAt: null,
    fillTime: null, fillPrice: null, slippagePips: null, fillSpreadPips: null, initialStop: null, activeStop: null, trailingOrderId: null, trailingRequestedAt: null, trailingActivatedAt: null,
    unrealizedPips: null, maximumFavorablePips: 0, protectedPips: null, realizedPL: null, realizedR: null, exitPrice: null, closedAt: null, lastProtectionAt: null });
  const at = new Date(now).toISOString();
  return { id, userId, accountKey, instrument, eventKey: `oco:${id}`, version: 3, revision: 0, mode: "oco", requestedRiskAmount: cash, expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    state: "READY", release: { id, title: "Linked pending orders", currency: instrument.slice(0, 3), time: new Date(now + 60_000).toISOString(), impact: 0, provider: "manual" },
    settings, createdAt: at, targetSubmitAt: at, preparedAt: at, calendarCheckedAt: at, calendarFetchedAt: at, transactionSeed: context.lastTransactionId,
    lastReconciledAt: null, preparedQuote: context.quote, risk: sized.risk, constraints: context.constraints, clock: context.clock, levelsFrozenAt: at,
    legs: { long: leg("long"), short: leg("short") }, firstFillSide: null, exception: null, reason: null, endedAt: null,
    timeline: [{ at, event: "oco_created", detail: "Manual STOP prices approved. A verified fill cancels the opposite pending order." }] };
}
