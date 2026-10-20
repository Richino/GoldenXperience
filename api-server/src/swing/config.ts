import { createHash } from "node:crypto";
import { isKnownInstrument } from "../../../frontend/src/lib/instruments/catalog.js";
import { ANALYZE_V2 } from "../../../frontend/src/lib/strategy/analyze-v2/config.js";
import type { SwingStyle } from "../../../frontend/src/lib/swing-intelligence.js";

/** Every threshold is provisional, not fitted or a probability of success. */
export function swingSettings(env: NodeJS.ProcessEnv = process.env) {
  const n = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[`SWING_${name}`], value = Number(raw);
    if (!raw?.trim()) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`SWING_${name} must be between ${min} and ${max}.`);
    return value;
  };
  const integers = (name: string, fallback: number, min: number, max: number) => Math.floor(n(name, fallback, min, max));
  const instruments = [...new Set((env.SWING_INSTRUMENTS || "EUR_USD").split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!instruments.length || instruments.some(i => !isKnownInstrument(i))) throw new Error("SWING_INSTRUMENTS must contain supported OANDA pairs.");
  const style = env.SWING_ENTRY_STYLE || "BALANCED";
  if (!["AGGRESSIVE", "BALANCED", "CONSERVATIVE"].includes(style)) throw new Error("Invalid SWING_ENTRY_STYLE.");
  const windows = [...new Set((env.SWING_MOVEMENT_WINDOWS || "15,60,300,900").split(",").map(Number))].sort((a, b) => a - b);
  if (!windows.length || windows.length > 8 || windows.some(v => !Number.isInteger(v) || v < 5 || v > 3600)) throw new Error("SWING_MOVEMENT_WINDOWS requires 5–3600 second windows (maximum eight).");
  const minZone = n("ZONE_MIN_WIDTH_ATR", 0.15, 0.01, 3), maxZone = n("ZONE_MAX_WIDTH_ATR", 0.8, 0.01, 5);
  const minStop = n("MIN_STOP_ATR", 0.8, 0.1, 5), maxStop = n("MAX_STOP_ATR", 4, 0.5, 20);
  if (minZone > maxZone || minStop > maxStop) throw new Error("Swing minimum zone/stop distances cannot exceed their maximums.");
  return {
    enabled: env.SWING_INTELLIGENCE_ENABLED === "true", instruments, style: style as SwingStyle,
    quoteMaxAgeMs: n("QUOTE_MAX_AGE_MS", 5000, 500, 60000), gapMs: n("QUOTE_GAP_MS", 5000, 1000, 60000),
    maxSamples: integers("MAX_QUOTE_SAMPLES", 12000, 100, 100000), windows,
    minSamples: integers("MIN_MOVEMENT_SAMPLES", 12, 3, 10000), coverage: n("MIN_WINDOW_COVERAGE", 0.8, 0.5, 1),
    pressureEfficiency: n("CONTROL_EFFICIENCY", 0.35, 0.05, 1), pressureProgressAtr: n("CONTROL_PROGRESS_ATR", 0.01, 0, 2),
    pressurePersistence: n("CONTROL_PERSISTENCE", 0.2, 0, 1),
    controlWeights: { daily: n("CONTROL_D1_WEIGHT", 3, 0, 10), h4: n("CONTROL_H4_WEIGHT", 2, 0, 10),
      pressure: n("CONTROL_PRESSURE_WEIGHT", 1, 0, 10), interpretation: n("CONTROL_AI_WEIGHT", 1, 0, 10), threshold: n("CONTROL_LEAN_THRESHOLD", 2, 0.1, 20) },
    zoneTtlTradingHours: n("ZONE_TTL_TRADING_HOURS", 120, 1, 480), zoneInvalidationAtr: n("ZONE_INVALIDATION_ATR", 2, 0.2, 10),
    breakoutAtr: n("BREAKOUT_ACCEPTANCE_ATR", 0.08, 0.01, 2), acceptanceSeconds: n("ACCEPTANCE_SECONDS", 45, 5, 3600),
    initialObservationSeconds: n("INITIAL_OBSERVATION_SECONDS", 60, 5, 3600), reactionAtr: n("REACTION_ATR", 0.05, 0.005, 2),
    minStopAtr: minStop, maxStopAtr: maxStop,
    stopBufferAtr: n("STOP_BUFFER_ATR", 0.2, 0.01, 2), minRewardRisk: n("MIN_REWARD_RISK", 1.5, 0.1, 10),
    maxSpreadStopShare: n("MAX_SPREAD_STOP_SHARE", 0.15, 0.01, 0.8), riskPercent: n("MAX_RISK_PERCENT", 1, 0.01, 5),
    maxAggregateRisk: n("MAX_AGGREGATE_RISK_PERCENT", 3, 0.01, 20), blackoutMinutes: n("NEWS_BLACKOUT_MINUTES", 30, 0, 240),
    horizonDays: integers("HOLDING_DAYS", 5, 2, 5), maxTargetD1Atr: n("MAX_TARGET_D1_ATR", 3, 0.5, 10),
    deterministicRefreshMs: n("STRUCTURE_REFRESH_MS", 60000, 30000, 900000), accountRefreshMs: n("ACCOUNT_REFRESH_MS", 30000, 10000, 300000),
    researchTtlMs: n("RESEARCH_CACHE_HOURS", 24, 1, 72) * 3600000, dailyHourUtc: integers("DAILY_RESEARCH_HOUR_UTC", 6, 0, 23),
    hourlyChecks: env.SWING_HOURLY_NEWS_CHECKS !== "false", searchWithoutProvider: env.SWING_HOURLY_SEARCH_ENABLED !== "false",
    materialImpact: n("NEWS_MATERIALITY_IMPACT", 3, 2, 3), materialDisplacementAtr: n("MATERIAL_STRUCTURE_CHANGE_ATR", 1, 0.1, 5),
    dailyResearchLimit: integers("DAILY_RESEARCH_LIMIT", 6, 1, 100), maxSearches: integers("MAX_SEARCHES", 3, 1, 12),
    maxDailyUsd: env.SWING_MAX_AI_SPEND_USD?.trim() ? n("MAX_AI_SPEND_USD", 0, 0, 10000) : null,
    requestReserveUsd: n("AI_REQUEST_RESERVE_USD", 1, 0.01, 100), retryMs: n("RETRY_BACKOFF_MS", 60000, 10000, 3600000),
    researchTimeoutMs: n("RESEARCH_TIMEOUT_MS", 300000, 10000, 600000),
    model: env.SWING_OPENAI_MODEL || env.OPENAI_RESEARCH_MODEL || env.OPENAI_ANALYSIS_MODEL || "gpt-5-mini",
    effort: env.SWING_REASONING_EFFORT || "low", aggregateSeconds: n("AGGREGATE_SECONDS", 60, 10, 300),
    retentionDays: integers("AGGREGATE_RETENTION_DAYS", 30, 1, 365),
    structure: { ...ANALYZE_V2.SWING,
      regime: { ...ANALYZE_V2.SWING.regime, pivotReach: integers("PIVOT_REACH", 3, 1, 12), minLegAtr: n("STRUCTURE_MIN_LEG_ATR", 1, 0.1, 5) },
      zones: { ...ANALYZE_V2.SWING.zones, minWidthAtr: minZone, maxWidthAtr: maxZone, maxDistanceAtr: n("ZONE_MAX_DISTANCE_ATR", 6, 1, 20) } },
  };
}
export type SwingSettings = ReturnType<typeof swingSettings>;
export const swingAccountKey = () => createHash("sha256").update(`swing:${process.env.OANDA_ENVIRONMENT || "practice"}:${process.env.OANDA_ACCOUNT_ID || "unconfigured"}`).digest("hex");
export function safeSwingError(value: unknown) {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\/accounts\/[^/\s?]+/g, "/accounts/[redacted]").slice(0, 600);
}
