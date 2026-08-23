export const STRATEGY_FAMILY_LABEL: Record<string, string> = {
  ema: "EMA",
  breakout: "Breakout",
  momentum: "Momentum",
  meanrev: "Mean rev",
};

/**
 * Display label for a strategy trade's family. Known families map to short
 * badges; missing or unrecognized families read as Other.
 */
export function strategyTypeLabel(input: {
  strategyFamily?: string | null;
  batchNumber?: number | null;
}): string {
  if (!input.strategyFamily) return "Other";
  return STRATEGY_FAMILY_LABEL[input.strategyFamily] ?? "Other";
}
