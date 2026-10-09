import { precisionFor } from "@/lib/instruments/catalog";
import { ANALYZE_V2, type AnalyzeMode } from "@/lib/strategy/analyze-v2/config";
import type { CheckStatus, DataCheck } from "@/lib/strategy/analyze-v2/data-quality";
import { readMarketFoundation, type FoundationInput, type MarketFoundation } from "@/lib/strategy/analyze-v2/foundation";
import { buildTradePlan, type PlanOutcome, type TradePlan } from "@/lib/strategy/analyze-v2/plan";
import type { PullbackState } from "@/lib/strategy/analyze-v2/pullback";
import { assessNews, assessVolatility, type NewsItem, type NewsRisk, type VolatilityRisk } from "@/lib/strategy/analyze-v2/risk";
import { assessLiquidity, buildLiquidityLevels, type LiquidityAssessment, type LiquidityLevel } from "@/lib/strategy/analyze-v2/liquidity";
import type { Alignment, TrendDirection } from "@/lib/strategy/analyze-v2/structure";

/**
 * Analyze V2 decision: thirteen checks (the spec's twelve plus liquidity), each PASS / CAUTION / FAIL / UNKNOWN.
 * LONG or SHORT only when every check is PASS or CAUTION; any FAIL or
 * UNKNOWN is NO_TRADE with execution null. There is no score and no
 * probability: the result is the checklist and the reasons.
 *
 * Checks later in the chain that cannot be judged because an earlier one
 * failed are marked UNKNOWN with `evaluated: false`.
 */

/** v2.1 (2026-10-09): stop behind the trend's structure level instead of the pullback extreme. */
export const ANALYZE_V2_STRATEGY = "analyze-v2.1";
export type AnalyzeDecision = "LONG" | "SHORT" | "NO_TRADE";

export type CheckId =
  | "data" | "timeframe" | "structure" | "higher" | "pullback" | "trigger"
  | "stop" | "target" | "reward-risk" | "spread" | "news-volatility" | "liquidity" | "price-rules";

export interface DecisionCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  reason: string;
  /** False when an earlier failure made this check impossible to judge. */
  evaluated: boolean;
}

export interface AnalysisResult {
  strategy: string;
  pair: string;
  mode: AnalyzeMode;
  decision: AnalyzeDecision;
  /** One-line primary explanation. */
  headline: string;
  analyzedAt: string;
  marketDataTimestamp: string | null;
  quoteTimestamp: string | null;
  marketStructure: {
    primaryTimeframe: string;
    higherTimeframe: string;
    primaryTrend: TrendDirection;
    higherTimeframeTrend: TrendDirection | null;
    alignment: Alignment;
    aligned: boolean;
    alignmentText: string;
    lastSwingHigh: number | null;
    lastSwingLow: number | null;
    structureLevel: number | null;
    evidence: string[];
  };
  setup: {
    type: "TREND_PULLBACK" | "NONE";
    status: PullbackState;
    zoneLow: number | null;
    zoneHigh: number | null;
    triggerConfirmed: boolean;
    /** Share of the impulse retraced (context only). */
    depth: number | null;
  };
  /** Present only for LONG / SHORT. */
  execution: (TradePlan & { orderLifetimeHours: number }) | null;
  checks: DecisionCheck[];
  news: NewsRisk;
  volatility: VolatilityRisk;
  /** Reference levels and their sweep/breakout status, with the entry-risk read. */
  liquidity: { levels: LiquidityLevel[]; assessment: LiquidityAssessment };
  invalidation: string;
  reasoning: string[];
  warnings: string[];
  /** Non-actionable: where and what to wait for. Never an entry signal. */
  watch: { zoneLow: number; zoneHigh: number; condition: string } | null;
  /** The full deterministic read, for display and diagnostics. */
  foundation: MarketFoundation;
}

export interface DecisionInput extends FoundationInput {
  /** Economic calendar events; null when the calendar could not be read. */
  news: NewsItem[] | null;
  /** Open trades and resting orders, for the same-currency warning. */
  exposure?: Array<{ instrument: string; direction: "long" | "short" }>;
}

const LABELS: Record<CheckId, string> = {
  data: "Market data",
  timeframe: "Timeframes",
  structure: "Trend structure",
  higher: "Higher timeframe",
  pullback: "Pullback",
  trigger: "Entry trigger",
  stop: "Structural stop",
  target: "Realistic target",
  "reward-risk": "Reward/risk",
  spread: "Spread",
  "news-volatility": "News & volatility",
  liquidity: "Liquidity",
  "price-rules": "Price rules",
};

/** Worst status of a group: FAIL beats UNKNOWN beats CAUTION beats PASS. */
function worst(checks: DataCheck[]): DataCheck | null {
  const rank: Record<CheckStatus, number> = { FAIL: 3, UNKNOWN: 2, CAUTION: 1, PASS: 0 };
  return [...checks].sort((a, b) => rank[b.status] - rank[a.status])[0] ?? null;
}

/** Lower-case the first letter unless it starts a timeframe or pair (M15, EUR/USD). */
function lowerFirst(text: string) {
  return /^[A-Z][A-Z0-9]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

function currencyLegs(instrument: string, direction: "long" | "short") {
  const [base, quote] = instrument.split("_");
  const sign = direction === "long" ? 1 : -1;
  return base && quote ? [{ currency: base, sign }, { currency: quote, sign: -sign }] : [];
}

export function analyzeV2(input: DecisionInput): AnalysisResult {
  const config = input.config ?? ANALYZE_V2[input.mode];
  const digits = precisionFor(input.instrument);
  const fmt = (value: number) => value.toFixed(digits);
  const foundation = readMarketFoundation(input);
  const { primary, higher, pullback, zones } = foundation;
  const quote = foundation.data.quote.executable;
  const checks = new Map<CheckId, DecisionCheck>();
  const set = (id: CheckId, status: CheckStatus, reason: string, evaluated = true) =>
    checks.set(id, { id, label: LABELS[id], status, reason, evaluated });
  const skip = (id: CheckId, because: string) => set(id, "UNKNOWN", `Not evaluated: ${because}.`, false);

  // 1. Data: history, freshness, integrity and the live quote.
  const dataChecks = foundation.data.checks.filter((check) => !check.id.endsWith("-spacing"));
  const dataWorst = worst(dataChecks);
  set("data", dataWorst?.status ?? "UNKNOWN", dataWorst && dataWorst.status !== "PASS" ? dataWorst.reason : "Candles are current and the quote is live.");

  // 2. Timeframes really are what they claim.
  const spacing = worst(foundation.data.checks.filter((check) => check.id.endsWith("-spacing")));
  set("timeframe", spacing?.status ?? "UNKNOWN", spacing && spacing.status !== "PASS" ? spacing.reason : `${config.primary} structure, ${config.higher} context.`);

  // 3. Structure.
  const trending = primary?.direction === "UPTREND" || primary?.direction === "DOWNTREND";
  const side = primary?.direction === "UPTREND" ? "LONG" : primary?.direction === "DOWNTREND" ? "SHORT" : null;
  if (!primary) set("structure", "UNKNOWN", "No primary candles to read.");
  else if (trending) set("structure", "PASS", primary.evidence.slice(0, 2).join("; ") || `${primary.timeframe} ${primary.direction.toLowerCase()}.`);
  else set("structure", "FAIL", `${primary.timeframe} is ${primary.direction.toLowerCase()}${primary.direction === "RANGE" ? "; range reversals are not assumed to work" : ""}: no trend to join.`);

  // 4. Higher timeframe.
  if (!trending) skip("higher", "no primary trend");
  else if (foundation.alignment === "ALIGNED") set("higher", "PASS", foundation.alignmentText);
  else if (foundation.alignment === "HIGHER_NOT_TRENDING") set("higher", "CAUTION", foundation.alignmentText);
  else if (foundation.alignment === "OPPOSED") set("higher", "FAIL", foundation.alignmentText);
  else set("higher", "UNKNOWN", "No usable higher-timeframe read.");

  // 5–6. Pullback and trigger.
  const state = pullback?.state ?? "NOT_APPLICABLE";
  if (!trending) {
    skip("pullback", "no primary trend");
    skip("trigger", "no primary trend");
  } else {
    const note = pullback?.notes[0] ?? "";
    if (state === "AT_ZONE" || state === "TRIGGERED" || state === "EXPIRED") set("pullback", "PASS", `Pulled back into ${pullback!.zone ? `${fmt(pullback!.zone.low)}–${fmt(pullback!.zone.high)}` : "a zone"}.`);
    else if (state === "DEVELOPING") set("pullback", "FAIL", note);
    else if (state === "NO_PULLBACK") set("pullback", "FAIL", `${note} Not chasing the move.`);
    else set("pullback", "FAIL", note || "No qualifying pullback.");
    if (state === "TRIGGERED") set("trigger", "PASS", `A ${config.primary} candle closed ${side === "LONG" ? "above" : "below"} ${fmt(pullback!.triggerLevel!)}, the ${side === "LONG" ? "high" : "low"} of the pullback's ${side === "LONG" ? "lowest" : "highest"} candle.`);
    else if (state === "EXPIRED") set("trigger", "FAIL", `${note} The opportunity has passed.`);
    else if (state === "AT_ZONE") set("trigger", "FAIL", `No confirmation yet: wait for a close ${side === "LONG" ? "above" : "below"} ${fmt(pullback!.triggerLevel!)}.`);
    else skip("trigger", "no pullback at a zone");
  }

  // 7–10, 12. The plan (only for a confirmed trigger with a live quote).
  let outcome: PlanOutcome | null = null;
  if (state === "TRIGGERED" && side && primary && pullback && quote) {
    outcome = buildTradePlan({ instrument: input.instrument, side, quote, trend: primary, pullback, zones, config });
  }
  const plan = outcome?.plan ?? null;
  if (!outcome) {
    const because = state !== "TRIGGERED" ? "no confirmed entry" : "no executable quote";
    for (const id of ["stop", "target", "reward-risk", "spread", "price-rules"] as const) skip(id, because);
  } else {
    if (outcome.stopFailure) set("stop", "FAIL", outcome.stopFailure);
    else set("stop", "PASS", plan ? plan.stopBasis : `${outcome.stopPips?.toFixed(1)} pips behind the pullback extreme.`);
    if (outcome.stopFailure) skip("target", "no valid stop");
    else if (outcome.targetFailure) set("target", "FAIL", outcome.targetFailure);
    else if (plan && plan.minorObstacles.length) set("target", "CAUTION", `${plan.targetBasis}. In the way: ${plan.minorObstacles.map((item) => item.label).join(", ")}.`);
    else set("target", "PASS", plan?.targetBasis ?? "");
    if (plan) {
      set("reward-risk", plan.rewardRisk >= config.plan.minRewardRisk - 1e-9 ? "PASS" : "FAIL",
        `${plan.rewardRisk.toFixed(2)}R from executable prices (minimum ${config.plan.minRewardRisk}R; a preference, not a proven threshold).`);
      const share = plan.spreadShare;
      set("spread", share <= config.plan.spreadPassShare ? "PASS" : share <= config.plan.spreadFailShare ? "CAUTION" : "FAIL",
        `${plan.spreadPips.toFixed(1)} pips, ${Math.round(share * 100)}% of the ${plan.stopPips.toFixed(1)}-pip risk.`);
      set("price-rules", "PASS", `Entry ${fmt(plan.entry)}, stop ${fmt(plan.stop)}, target ${fmt(plan.target)}: ordered and at ${digits}-digit precision.`);
    } else {
      skip("reward-risk", "no valid plan");
      if (quote && outcome.stopPips) {
        const share = quote.spreadPips / outcome.stopPips;
        set("spread", share <= config.plan.spreadPassShare ? "PASS" : share <= config.plan.spreadFailShare ? "CAUTION" : "FAIL", `${quote.spreadPips.toFixed(1)} pips, ${Math.round(share * 100)}% of the risk.`);
      } else skip("spread", "no valid stop");
      if (outcome.rulesFailure) set("price-rules", "FAIL", outcome.rulesFailure);
      else skip("price-rules", "no valid plan");
    }
  }

  // 11. News and volatility (always evaluated).
  const news = assessNews(input.instrument, input.news, input.now, input.mode);
  const volatility = assessVolatility(foundation.primary ? (input.candles[config.primary] ?? []).filter((candle) => candle.complete !== false) : [], primary?.atr ?? 0);
  const riskWorst = worst([{ id: "news", status: news.status, reason: news.reason }, { id: "volatility", status: volatility.status, reason: volatility.reason }])!;
  set("news-volatility", riskWorst.status, riskWorst.status === "PASS" ? `${news.reason} ${volatility.reason}` : riskWorst.reason);

  // 12. Liquidity: entry-risk context. Missing levels are a caution, not a block;
  // a BLOCK names the rule it breaks (a conflicting accepted breakout).
  const closedPrimary = (input.candles[config.primary] ?? []).filter((candle) => candle.complete !== false);
  const liquidityLevels = primary ? buildLiquidityLevels({
    instrument: input.instrument,
    mode: input.mode,
    candles: closedPrimary.slice(-config.regime.lookback),
    timeframe: config.primary,
    daily: (input.candles.D1 ?? []).filter((candle) => candle.complete !== false),
    trend: primary,
    spread: quote ? quote.ask - quote.bid : null,
    reach: config.regime.pivotReach,
  }) : [];
  const liquidity = assessLiquidity({
    instrument: input.instrument,
    levels: liquidityLevels,
    atr: primary?.atr ?? 0,
    price: foundation.referencePrice ?? primary?.close ?? 0,
    side,
    plan: plan ? { entry: plan.entry, stop: plan.stop, target: plan.target } : null,
    pullbackStart: pullback?.start?.time ?? null,
  });
  if (!plan) skip("liquidity", state !== "TRIGGERED" ? "no confirmed entry" : "no valid plan");
  else {
    const status: CheckStatus = liquidity.risk === "BLOCK" ? "FAIL" : liquidity.risk === "CLEAR" ? "PASS" : "CAUTION";
    set("liquidity", status, [liquidity.findings[0], liquidity.confirmation].filter(Boolean).join(" "));
  }

  const ordered = (Object.keys(LABELS) as CheckId[]).map((id) => checks.get(id)!);
  const blocking = ordered.filter((check) => check.status === "FAIL" || check.status === "UNKNOWN");
  const actionable = blocking.length === 0 && plan !== null && side !== null;
  const decision: AnalyzeDecision = actionable ? side! : "NO_TRADE";

  // Same-currency exposure.
  const warnings: string[] = [];
  if (side) {
    for (const leg of currencyLegs(input.instrument, side === "LONG" ? "long" : "short")) {
      const same = (input.exposure ?? []).filter((open) => currencyLegs(open.instrument, open.direction).some((other) => other.currency === leg.currency && other.sign === leg.sign));
      if (same.length) warnings.push(`Already ${leg.sign > 0 ? "long" : "short"} ${leg.currency} in ${same.map((open) => `${open.direction} ${open.instrument.replace("_", "/")}`).join(", ")}; this adds to the same bet.`);
    }
  }
  for (const check of ordered) if (check.status === "CAUTION") warnings.push(`${check.label}: ${check.reason}`);

  // Watch zone: non-actionable guidance for a developing setup.
  let watch: AnalysisResult["watch"] = null;
  // Only when the pullback, its trigger or a news wait is all that is missing; otherwise
  // the "wait for" would point at a trade other checks already rule out.
  const onlyWaiting = blocking.every((check) => !check.evaluated || check.id === "pullback" || check.id === "trigger" || check.id === "news-volatility");
  if (trending && pullback && !actionable && onlyWaiting) {
    if (state === "DEVELOPING" && pullback.nextZone) {
      watch = { zoneLow: pullback.nextZone.low, zoneHigh: pullback.nextZone.high, condition: `Watch for price to reach ${fmt(pullback.nextZone.low)}–${fmt(pullback.nextZone.high)} and a closed ${config.primary} candle to confirm the turn.` };
    } else if (state === "AT_ZONE" && pullback.zone && pullback.triggerLevel !== null) {
      watch = { zoneLow: pullback.zone.low, zoneHigh: pullback.zone.high, condition: `Price is at ${fmt(pullback.zone.low)}–${fmt(pullback.zone.high)}; wait for a ${config.primary} close ${side === "LONG" ? "above" : "below"} ${fmt(pullback.triggerLevel)}.` };
    }
  }

  const structureLevel = primary?.structureLevel ?? null;
  const invalidation = plan
    ? structureLevel !== null && Math.abs(plan.invalidationLevel - structureLevel) < 1e-12
      ? `${side === "LONG" ? "A bid" : "An ask"} at ${fmt(plan.stop)} ends the trade; a close ${side === "LONG" ? "below" : "above"} ${fmt(structureLevel)} ends the ${primary!.timeframe} ${primary!.direction.toLowerCase()} the trade relies on.`
      : `${side === "LONG" ? "A bid" : "An ask"} at ${fmt(plan.stop)} ends the trade; a close ${side === "LONG" ? "below" : "above"} ${fmt(plan.invalidationLevel)} means the pullback did not hold${structureLevel !== null ? `, and through ${fmt(structureLevel)} the ${primary!.timeframe} trend itself` : ""}.`
    : structureLevel !== null ? `A close ${side === "LONG" ? "below" : "above"} ${fmt(structureLevel)} ends the ${primary!.timeframe} ${primary!.direction.toLowerCase()}.` : "No trend, so no invalidation level.";
  const firstBlock = blocking[0];
  const headline = actionable
    ? `${side === "LONG" ? "Bullish" : "Bearish"} pullback qualified: ${primary!.timeframe} ${primary!.direction.toLowerCase()}, confirmed turn at ${fmt(pullback!.zone!.low)}–${fmt(pullback!.zone!.high)}.`
    : firstBlock ? `No trade: ${lowerFirst(firstBlock.reason.replace(/^Not evaluated: /, ""))}` : "No trade.";
  const reasoning = [
    foundation.alignmentText,
    ...(primary?.evidence ?? []),
    ...(pullback?.notes ?? []),
    ...(plan ? [plan.stopBasis + ".", plan.targetBasis + "."] : []),
    ...(liquidity.confirmation ? [liquidity.confirmation] : []),
  ];

  return {
    strategy: ANALYZE_V2_STRATEGY,
    pair: input.instrument,
    mode: input.mode,
    decision,
    headline,
    analyzedAt: foundation.analyzedAt,
    marketDataTimestamp: foundation.data.lastPrimaryCandle,
    quoteTimestamp: input.quote?.time ?? null,
    marketStructure: {
      primaryTimeframe: config.primary,
      higherTimeframe: config.higher,
      primaryTrend: primary?.direction ?? "UNCLEAR",
      higherTimeframeTrend: higher?.direction ?? null,
      alignment: foundation.alignment,
      aligned: foundation.alignment === "ALIGNED",
      alignmentText: foundation.alignmentText,
      lastSwingHigh: primary?.lastSwingHigh?.price ?? null,
      lastSwingLow: primary?.lastSwingLow?.price ?? null,
      structureLevel,
      evidence: primary?.evidence ?? [],
    },
    setup: {
      type: trending ? "TREND_PULLBACK" : "NONE",
      status: state,
      zoneLow: pullback?.zone?.low ?? null,
      zoneHigh: pullback?.zone?.high ?? null,
      triggerConfirmed: state === "TRIGGERED",
      depth: pullback?.depth ?? null,
    },
    execution: actionable && plan ? { ...plan, orderLifetimeHours: config.plan.orderLifetimeHours } : null,
    checks: ordered,
    news,
    volatility,
    liquidity: { levels: liquidityLevels, assessment: liquidity },
    invalidation,
    reasoning,
    warnings,
    watch,
    foundation,
  };
}
