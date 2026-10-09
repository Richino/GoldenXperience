import { precisionFor } from "@/lib/instruments/catalog";
import { NO_NEWS, type Alignment as LegacyAlignment, type MarketAnalysis } from "@/lib/strategy/market-analysis";
import type { Regime } from "@/lib/strategy/market-regime";
import type { RoleTimeframe } from "@/lib/strategy/timeframe-roles";
import type { AnalysisResult } from "@/lib/strategy/analyze-v2/decide";
import type { MajorInstrument } from "@/types/forex";

/**
 * Presents an Analyze V2 result in the MarketAnalysis shape the Analyze card,
 * sheet and entry form already read, with the full V2 result attached as
 * `v2`. The numbers are V2's; nothing here computes a level.
 */

const HOLDING = { NORMAL: "Day trade: inside the session", SWING: "Swing: several days" } as const;

function legacyAlignment(alignment: AnalysisResult["marketStructure"]["alignment"]): LegacyAlignment {
  return alignment === "ALIGNED" ? "ALIGNED" : alignment === "OPPOSED" ? "CONFLICTING" : alignment === "UNKNOWN" ? "UNKNOWN" : "MIXED";
}

const regimeOf = (trend: string | null): Regime =>
  trend === "UPTREND" || trend === "DOWNTREND" || trend === "RANGE" ? trend : "TRANSITION";

export function toMarketAnalysis(result: AnalysisResult): MarketAnalysis {
  const digits = precisionFor(result.pair);
  const structure = result.marketStructure;
  const plan = result.execution;
  const impulse = result.foundation.primary?.impulse ?? null;
  const zone = result.setup.zoneLow !== null && result.setup.zoneHigh !== null ? { low: result.setup.zoneLow, high: result.setup.zoneHigh } : null;
  const spread = result.foundation.data.quote.executable?.spreadPips ?? null;
  const roles = {
    context: structure.higherTimeframe as RoleTimeframe,
    primary: structure.primaryTimeframe as RoleTimeframe,
    setup: null,
    execution: result.foundation.timeframes.execution as RoleTimeframe | null,
    holding: HOLDING[result.mode],
  };
  return {
    mode: result.mode,
    pair: result.pair as MajorInstrument,
    primaryTimeframe: structure.primaryTimeframe,
    regime: regimeOf(structure.primaryTrend),
    // Not a probability; the V2 checklist replaces it. Kept for the legacy shape.
    regimeConfidence: "MEDIUM",
    context: {
      timeframe: structure.higherTimeframe,
      regime: regimeOf(structure.higherTimeframeTrend),
      agrees: structure.alignment === "ALIGNED" ? true : structure.alignment === "OPPOSED" ? false : null,
      alignment: legacyAlignment(structure.alignment),
    },
    hierarchy: {
      version: "ROLES",
      roles,
      setup: null,
      execution: null,
      interpretation: structure.alignmentText,
      strategy: result.headline,
    },
    decision: result.decision === "NO_TRADE" ? "NO TRADE" : result.decision,
    setupType: result.setup.type === "TREND_PULLBACK" && plan ? "TREND_PULLBACK" : "NONE",
    currentPrice: result.foundation.referencePrice ?? 0,
    structure: {
      latestSwingHigh: structure.lastSwingHigh,
      latestSwingLow: structure.lastSwingLow,
      interpretation: structure.evidence.join(". "),
    },
    trend: impulse
      ? {
          impulse: `${impulse.from.price.toFixed(digits)} → ${impulse.to.price.toFixed(digits)} (${impulse.sizeAtr.toFixed(1)} ATR)`,
          pullbackZone: zone,
          entry: plan?.entry ?? null,
          chaseRisk: result.setup.status === "EXPIRED" || result.setup.status === "NO_PULLBACK" ? "HIGH" : "LOW",
          distanceToPullbackPips: null,
        }
      : null,
    range: null,
    transition: null,
    trade: plan
      ? {
          entry: plan.entry,
          stopLoss: plan.stop,
          takeProfit: plan.target,
          riskReward: Number(plan.rewardRisk.toFixed(2)),
          stopPips: Number(plan.stopPips.toFixed(1)),
          targetPips: Number(plan.targetPips.toFixed(1)),
          orderType: "MARKET",
          holding: HOLDING[result.mode],
          fillChancePct: 100,
          stopBasis: plan.stopBasis,
        }
      : null,
    risk: {
      spread: spread === null ? "Unknown (no live quote)" : `${spread.toFixed(1)} pips`,
      news: result.news.state === "CLEAR" ? NO_NEWS : result.news.reason,
      invalidation: result.invalidation,
      main: result.checks.find((check) => check.status === "FAIL" || check.status === "UNKNOWN")?.reason ?? "Structure failure through the invalidation level.",
    },
    warnings: result.warnings,
    // V2 blocks entries around news instead of delaying the order.
    activateAfter: null,
    reason: plan ? `${result.headline} ${plan.targetBasis}.` : [result.headline, result.watch?.condition].filter(Boolean).join(" "),
    v2: result,
  };
}
