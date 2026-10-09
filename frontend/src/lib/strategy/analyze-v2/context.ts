import type { AnalysisResult } from "@/lib/strategy/analyze-v2/decide";

/** Setup tags for orders placed from a V2 plan; the server sets their lifetime from these. */
export const ANALYZE_V2_SETUP: Record<"NORMAL" | "SWING", string> = {
  NORMAL: "analyze-v2-normal",
  SWING: "analyze-v2-swing",
};

/**
 * The frozen record saved with an order from a V2 plan, so forward tests can
 * be scored by setup. The envelope stays version 1 (the server keeps only
 * that, up to 8,000 characters); `frozen.engine` marks it as V2.
 */
export function analyzeV2Context(result: AnalysisResult) {
  return {
    version: 1,
    direction: result.decision === "SHORT" ? "short" : "long",
    setup: ANALYZE_V2_SETUP[result.mode],
    frozen: {
      engine: "analyze-v2",
      strategy: result.strategy,
      mode: result.mode,
      decision: result.decision,
      headline: result.headline,
      analyzedAt: result.analyzedAt,
      marketDataTimestamp: result.marketDataTimestamp,
      quoteTimestamp: result.quoteTimestamp,
      marketStructure: result.marketStructure,
      setup: result.setup,
      execution: result.execution,
      checks: result.checks.map(({ id, status, reason }) => ({ id, status, reason })),
      news: { state: result.news.state, reason: result.news.reason },
      volatility: { status: result.volatility.status, rangeAtr: result.volatility.rangeAtr },
      liquidity: {
        risk: result.liquidity.assessment.risk,
        stopExposed: result.liquidity.assessment.stopExposed,
        confirmed: result.liquidity.assessment.confirmation !== null,
      },
      invalidation: result.invalidation,
      warnings: result.warnings,
    },
  };
}
