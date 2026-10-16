import { currenciesOf, pipSizeFor, precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import { calculatePositionSize } from "../../frontend/src/lib/risk/engine.js";
import type { NewsItem } from "../../frontend/src/lib/strategy/analyze-v2/risk.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * The mandatory safety checks before GX places an Auto trade order. Pure:
 * every input is read by the caller just before submitting, so the same
 * inputs always give the same verdict. Any failed check means no order, and
 * each check carries its own plain reason. Only when all pass does it return
 * the order to send (size, executable entry, fixed stop and target, slippage
 * bound) — the stop is never widened and the size never averaged up.
 */

export type ExecutionCheck = { key: string; ok: boolean; detail: string };

export type ExecutionInput = {
  plan: {
    instrument: MajorInstrument;
    direction: "BUY" | "SELL";
    stopLoss: number;
    takeProfit: number;
    expiresAt: string;
    maxRiskPercent: number;
    minRewardRisk: number;
    /** Entry the confirmation proposed (live price at confirmation); slippage is measured from it. */
    proposalEntry: number | null;
  };
  now: number;
  settings: {
    autoApproved: boolean;
    killSwitch: boolean;
    suspended: boolean;
    maxRiskPercent: number;
    maxAggregateRiskPercent: number;
    maxOpenPositions: number;
    dailyLossLimitPercent: number;
    maxSpreadStopFraction: number;
    maxSlippageStopFraction: number;
    maxDataAgeSeconds: number;
    newsBlackoutBeforeMinutes: number;
    newsBlackoutAfterMinutes: number;
  };
  brokerEnvironment: "practice" | "live" | null;
  marketOpen: boolean;
  quote: { bid: number; ask: number; time: string } | null;
  /** null when the calendar could not be read. */
  news: NewsItem[] | null;
  /** null when the account could not be read. */
  account: { nav: number; marginAvailable: number } | null;
  /** USD per unit of the quote currency (1 for USD-quoted pairs); undefined when unknown. */
  quoteToUsdRate: number | undefined;
  /** Instruments with an open broker trade; null when they could not be read. */
  openInstruments: string[] | null;
  /** GX Auto trades currently open or being placed. */
  openAutoTrades: { count: number; riskPercent: number };
  /** Realised P/L of Auto trades closed today (account currency; negative is a loss). */
  realizedTodayPL: number;
  /** When fresh market research is required for Auto trade (RESEARCH_REQUIRED_FOR_AUTO). */
  research?: { required: boolean; fresh: boolean; reason: string | null };
};

export type ExecutionOrder = {
  units: number;
  entry: number;
  stop: number;
  target: number;
  priceBound: number;
  riskPercent: number;
  riskAmount: number;
  rewardRisk: number;
};

/** Conservative margin estimate (20:1). The broker's own check is still final. */
const MARGIN_SHARE = 0.05;

export function executionChecks(input: ExecutionInput): { ok: boolean; checks: ExecutionCheck[]; order: ExecutionOrder | null } {
  const { plan, settings, quote } = input;
  const checks: ExecutionCheck[] = [];
  const check = (key: string, ok: boolean, detail: string) => { checks.push({ key, ok, detail }); return ok; };
  const digits = precisionFor(plan.instrument);
  const fmt = (value: number) => value.toFixed(digits);
  const buy = plan.direction === "BUY";

  check("auto_trade", settings.autoApproved, settings.autoApproved ? "Auto trade is on with approved limits." : "Auto trade is off in Settings.");
  check("kill_switch", !settings.killSwitch, settings.killSwitch ? "The execution kill switch is on." : "Kill switch off.");
  check("suspended", !settings.suspended, settings.suspended ? "Auto trade is paused after broker errors." : "Not paused.");
  check("practice_account", input.brokerEnvironment === "practice",
    input.brokerEnvironment === "practice" ? "OANDA practice account." : input.brokerEnvironment === "live" ? "The server is on a live account; Auto trade is practice-only." : "No OANDA account is connected.");
  check("plan_valid", input.now < Date.parse(plan.expiresAt), input.now < Date.parse(plan.expiresAt) ? "Plan has not expired." : "The plan has expired.");
  check("market_open", input.marketOpen, input.marketOpen ? "Market open." : "The market is closed.");

  const quoteAge = quote ? (input.now - Date.parse(quote.time)) / 1000 : Infinity;
  const fresh = check("fresh_quote", quote !== null && quoteAge <= settings.maxDataAgeSeconds,
    !quote ? "No live quote." : quoteAge <= settings.maxDataAgeSeconds ? `Quote ${Math.max(0, Math.round(quoteAge))}s old.` : `The quote is ${Math.round(quoteAge)}s old (limit ${settings.maxDataAgeSeconds}s).`);

  // News blackout around high-impact releases for either currency.
  if (input.news === null) check("news", false, "The economic calendar could not be read.");
  else {
    const { base, quote: quoteCurrency } = currenciesOf(plan.instrument);
    const near = input.news.find((event) => {
      if (event.impact < 3 || (event.currency !== base && event.currency !== quoteCurrency)) return false;
      const minutes = (Date.parse(event.timestamp) - input.now) / 60_000;
      return minutes <= settings.newsBlackoutBeforeMinutes && minutes >= -settings.newsBlackoutAfterMinutes;
    });
    check("news", !near, near ? `News blackout: high-impact ${near.currency} ${near.title}.` : "No high-impact release in the blackout window.");
  }

  // Same pair already open at the broker: on a netting account a new order would close or flip it.
  if (input.openInstruments === null) check("no_open_position", false, "Open positions could not be read from OANDA.");
  else {
    const open = input.openInstruments.includes(plan.instrument);
    check("no_open_position", !open, open ? `A trade is already open on ${plan.instrument.replace("_", "/")}; Auto trade will not net against it.` : "No open trade on this pair.");
  }

  if (input.research?.required) {
    check("research", input.research.fresh, input.research.fresh ? "Market research is fresh." : `Fresh market research is required and unavailable: ${input.research.reason ?? "stale"}.`);
  }
  check("open_positions", input.openAutoTrades.count < settings.maxOpenPositions,
    `${input.openAutoTrades.count} of ${settings.maxOpenPositions} Auto trades open.`);

  if (!fresh || !quote) {
    return { ok: false, checks, order: null };
  }

  const entry = buy ? quote.ask : quote.bid;
  const spread = quote.ask - quote.bid;
  const risk = buy ? entry - plan.stopLoss : plan.stopLoss - entry;
  const reward = buy ? plan.takeProfit - entry : entry - plan.takeProfit;
  const stopOk = check("stop_side", risk > 0 && reward > 0,
    risk > 0 && reward > 0 ? `Entry ${fmt(entry)} sits between stop ${fmt(plan.stopLoss)} and target ${fmt(plan.takeProfit)}.` : `Price ${fmt(entry)} is already past the ${risk <= 0 ? "stop" : "target"}.`);
  if (!stopOk) return { ok: false, checks, order: null };

  check("stop_distance", risk >= 2 * spread, risk >= 2 * spread
    ? `Stop ${Math.round(risk / pipSizeFor(plan.instrument))} pips away.`
    : "The stop is closer than twice the spread.");
  check("spread", spread <= settings.maxSpreadStopFraction * risk,
    `Spread is ${Math.round((spread / risk) * 100)}% of the stop distance (limit ${Math.round(settings.maxSpreadStopFraction * 100)}%).`);
  const rewardRisk = (reward - spread) / risk;
  check("reward_risk", rewardRisk >= plan.minRewardRisk, `Reward/risk ${rewardRisk.toFixed(2)} from ${fmt(entry)} (needs ${plan.minRewardRisk}).`);

  const slipAllowance = settings.maxSlippageStopFraction * risk;
  if (plan.proposalEntry !== null) {
    const moved = buy ? entry - plan.proposalEntry : plan.proposalEntry - entry;
    check("slippage", moved <= slipAllowance,
      moved <= slipAllowance ? "Price is where the confirmation saw it." : `Price moved ${fmt(Math.abs(moved))} against the entry since confirmation, over the ${Math.round(settings.maxSlippageStopFraction * 100)}% allowance.`);
  }

  if (!input.account || !(input.account.nav > 0)) {
    check("account", false, "Account equity could not be read.");
    return { ok: false, checks, order: null };
  }
  check("account", true, `Equity ${input.account.nav.toFixed(2)}.`);

  const dailyLimit = (settings.dailyLossLimitPercent / 100) * input.account.nav;
  check("daily_loss", input.realizedTodayPL > -dailyLimit,
    input.realizedTodayPL > -dailyLimit ? `Today's Auto trade result ${input.realizedTodayPL.toFixed(2)} (limit −${dailyLimit.toFixed(2)}).` : `Today's Auto trade losses ${input.realizedTodayPL.toFixed(2)} reached the ${settings.dailyLossLimitPercent}% daily limit.`);

  const riskPercent = Math.min(plan.maxRiskPercent, settings.maxRiskPercent);
  check("aggregate_risk", input.openAutoTrades.riskPercent + riskPercent <= settings.maxAggregateRiskPercent + 1e-9,
    `Open Auto trade risk would be ${(input.openAutoTrades.riskPercent + riskPercent).toFixed(2)}% (limit ${settings.maxAggregateRiskPercent}%).`);

  const sized = calculatePositionSize({
    instrument: plan.instrument,
    accountBalance: input.account.nav,
    riskPercent,
    entry,
    stop: plan.stopLoss,
    quoteToUsdRate: input.quoteToUsdRate,
    applyPaperCap: false,
  });
  const units = sized ? Math.floor(sized.units) : 0;
  const sizeOk = check("position_size", units >= 1, units >= 1 ? `${units.toLocaleString("en-US")} units risk ${riskPercent}% of equity.` : "Risk-based size came out under one unit.");

  if (sizeOk) {
    const notionalUsd = units * entry * (input.quoteToUsdRate ?? 1);
    const marginNeeded = notionalUsd * MARGIN_SHARE;
    check("margin", input.account.marginAvailable >= marginNeeded,
      input.account.marginAvailable >= marginNeeded ? "Margin available." : `About ${marginNeeded.toFixed(0)} margin needed, ${input.account.marginAvailable.toFixed(0)} available.`);
  }

  const ok = checks.every((item) => item.ok);
  return {
    ok,
    checks,
    order: ok
      ? {
          units,
          entry,
          stop: plan.stopLoss,
          target: plan.takeProfit,
          priceBound: Number((buy ? entry + slipAllowance : entry - slipAllowance).toFixed(digits)),
          riskPercent,
          riskAmount: sized!.estimatedRisk,
          rewardRisk: Number(rewardRisk.toFixed(2)),
        }
      : null,
  };
}

/**
 * After a submit throws: only a 4xx is a definite refusal (nothing opened).
 * A timeout, an unreachable broker or a 5xx leaves the order's fate unknown —
 * it must be looked up, never resent.
 */
export function submitFailureKind(status: number | undefined): "rejected" | "unknown" {
  return status !== undefined && status >= 400 && status < 500 ? "rejected" : "unknown";
}

export type ReconcileDecision = "wait" | "filled" | "rejected" | "lost";

/**
 * What to do with an order whose response was lost, given what the broker
 * says now when asked by client id. Never "resend".
 */
export function reconcileDecision(input: {
  /** ms since the attempt last changed. */
  sinceUpdateMs: number;
  /** ms since the attempt was created. */
  ageMs: number;
  order: { state: string; tradeId: string | null } | null;
  reconcileAfterMs: number;
  giveUpAfterMs: number;
}): ReconcileDecision {
  if (input.sinceUpdateMs < input.reconcileAfterMs) return "wait";
  if (input.order?.state === "FILLED" && input.order.tradeId) return "filled";
  if (input.order?.state === "CANCELLED") return "rejected";
  if (!input.order && input.ageMs >= input.giveUpAfterMs) return "lost";
  return "wait";
}
