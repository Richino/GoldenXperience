import { displayNameFor, pipSizeFor } from "@/lib/instruments/catalog";
import { calculatePositionSize, DEFAULT_RISK_POLICY, spreadWithinLimit } from "@/lib/risk/engine";
import { dayTradingSession } from "@/lib/strategy/strategy-engine";
import type { StrategyCandidate } from "@/lib/strategy/strategy";
import type {
  Candle, MajorInstrument,
} from "@/types/forex";
import type {
  MarketRegime, SetupStatus, StrategyCondition, StrategyDirection, StrategyEvaluationInput,
  StrategyFamily, StrategyPositionSize, StrategyResearchFeatures,
} from "@/lib/strategy/types";

/**
 * Shared, strategy-agnostic building blocks for the four Phase 2 strategies.
 *
 * The hard safety gates (data, session, spread, news) are identical across
 * strategies — they are infrastructure requirements, not strategy identity — so
 * they live here once. Each strategy adds its own setup gates on top. This is
 * the same fail-closed news behaviour the retired liquidity strategy used.
 */

/** Minimum completed M15 candles before any strategy is allowed a decision. */
export const MINIMUM_CANDLES = 210;

/** Per-pair spread ceilings, in pips. Mirrors the retired strategy's limits. */
export const MAX_SPREAD_PIPS: Record<string, number> = {
  EUR_USD: 1.5, GBP_USD: 2, USD_JPY: 1.5, AUD_USD: 2, NZD_USD: 2,
  USD_CAD: 2, USD_CHF: 2, EUR_GBP: 2, EUR_JPY: 2, GBP_JPY: 2.5,
  AUD_JPY: 2.5, EUR_AUD: 2.5,
};

export function condition(name: string, passed: boolean, reason: string, currentValue: string, required = false): StrategyCondition {
  return { name, passed, required, reason, currentValue };
}

export function completedCandles(candles: Candle[]): Candle[] {
  return candles.filter((candle) => candle.complete);
}

/** ATR-bucketed volatility, using the same thresholds as the batch breakdown. */
export function volatilityBucketFor(atrPips: number | null) {
  if (atrPips === null || !Number.isFinite(atrPips)) return "normal" as const;
  return atrPips < 5 ? "low" as const : atrPips < 10 ? "normal" as const : "high" as const;
}

/**
 * The decision-time news verdict, as a structured value rather than a sentence.
 *
 * The gate always ran; only its verdict was being lost. It survived inside the
 * `conditions` array as a display string while the `news_status` column on every
 * multi-strategy trade read 'not_evaluated', so the database contradicted the
 * evidence sitting beside it. This type is what makes the column truthful, and
 * it uses exactly the values `paper_strategy_trades.news_status` already allows.
 */
export type NewsGateStatus = "clear" | "high_impact" | "calendar_unavailable" | "not_evaluated";

export interface HardGateResult {
  conditions: StrategyCondition[];
  passed: boolean;
  session: string;
  spreadPips: number | null;
  /** The structured verdict behind the "News" condition. */
  newsStatus: NewsGateStatus;
}

/**
 * The four hard gates every strategy must clear. Any failure means no trade,
 * regardless of setup quality. News fails closed exactly as the live liquidity
 * strategy did: an unusable calendar pauses entries rather than clearing them.
 */
export function evaluateHardGates(
  input: StrategyEvaluationInput,
  evaluatedAt: string,
  candles15m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
): HardGateResult {
  const conditions: StrategyCondition[] = [];

  const hasData = input.dataSource === "oanda"
    && candles15m.length >= MINIMUM_CANDLES && candles1h.length >= MINIMUM_CANDLES && candles4h.length >= MINIMUM_CANDLES;
  conditions.push(condition("Market data", hasData,
    hasData ? "Completed OANDA candles are available on all timeframes." : "Live OANDA candle history is unavailable or incomplete.",
    `${candles15m.length}/${candles1h.length}/${candles4h.length} candles`, true));

  const session = dayTradingSession(new Date(evaluatedAt));
  const sessionOpen = session.open && input.marketOpen;
  conditions.push(condition("Session", sessionOpen,
    sessionOpen ? `${session.label} is trading.` : "Entries are limited to the London and New York sessions and close at 16:45 ET.",
    session.label, true));

  const maxSpread = MAX_SPREAD_PIPS[input.instrument] ?? 1.5;
  const spreadOk = spreadWithinLimit(input.spreadPips, maxSpread);
  conditions.push(condition("Spread", spreadOk,
    spreadOk ? "Spread is inside the pair limit." : input.spreadPips === null ? "No live spread available." : "Spread too wide.",
    input.spreadPips === null ? "unavailable" : `${input.spreadPips.toFixed(1)} / ${maxSpread.toFixed(1)} pips`, true));

  const evaluationMode = input.evaluationMode ?? "live";
  const newsRequired = evaluationMode !== "historical_replay";
  const newsClear = !newsRequired || (input.calendarConnected
    && (input.highImpactNewsWithinMinutes === null || input.highImpactNewsWithinMinutes > 30));
  // Four distinct states, not three. An unusable calendar used to be recorded as
  // "high impact" because `newsClear` collapses to false either way — so a trade
  // paused for a MISSING calendar was indistinguishable from one paused for an
  // actual release. The gate's PASS/FAIL is deliberately unchanged (it still
  // fails closed on an unusable calendar); only what gets written down improves.
  const newsStatus: NewsGateStatus = !newsRequired ? "not_evaluated"
    : !input.calendarConnected ? "calendar_unavailable"
      : newsClear ? "clear" : "high_impact";
  conditions.push(condition("News", newsRequired ? newsClear : false,
    evaluationMode === "historical_replay" ? "Historical news was not retained; this is a price-only technical evaluation."
      : !input.calendarConnected ? "Economic calendar is unavailable or stale; entries pause until the 30-minute news buffer can be verified."
        : newsClear ? "No high-impact release inside the 30-minute buffer." : "High-impact release inside the buffer.",
    newsStatus, newsRequired));

  return {
    conditions,
    passed: conditions.every((item) => !item.required || item.passed),
    session: session.label,
    spreadPips: input.spreadPips,
    newsStatus,
  };
}

/**
 * Recover the structured news verdict from a condition list.
 *
 * The condition array is the single source of truth for what the gate decided,
 * so deriving the persisted column FROM it makes the two incapable of
 * disagreeing — which is precisely the defect being repaired. Kept tolerant of
 * the older display spellings ("high impact", "not evaluated") so historical
 * rows can be re-read by the repair command without a translation table.
 */
export function newsStatusFromConditions(conditions: readonly StrategyCondition[]): NewsGateStatus | null {
  const news = conditions.find((item) => item.name === "News");
  if (!news) return null;
  const value = String(news.currentValue ?? "").trim().toLowerCase();
  if (value === "clear") return "clear";
  if (value === "calendar_unavailable") return "calendar_unavailable";
  if (value === "not_evaluated" || value === "not evaluated") return "not_evaluated";
  if (value === "high_impact" || value === "high impact") {
    // Pre-repair rows spelled BOTH "calendar unusable" and "release inside the
    // buffer" as "high impact". The reason text is the only thing that still
    // separates them, so it decides rather than a guess.
    return /calendar is unavailable|calendar is stale/i.test(news.reason ?? "") ? "calendar_unavailable" : "high_impact";
  }
  return null;
}

export interface TradePlan {
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  position: StrategyPositionSize | null;
}

/**
 * Turn a direction + a raw structural stop into an executable plan.
 *
 * The stop is floored at `minStopAtr` so it never sits inside the market's own
 * noise, and the target is a fixed R multiple — the same shape the risk engine
 * and resolvers already expect. `targetPrice`, when given, overrides the R
 * target (mean-reversion targets a value area rather than a fixed multiple).
 */
export function buildTradePlan(
  input: StrategyEvaluationInput,
  direction: Exclude<StrategyDirection, null>,
  rawStop: number,
  atr: number,
  options: { targetR: number; minStopAtr: number; targetPrice?: number | null },
): TradePlan {
  const entry = direction === "long" ? input.ask : input.bid;
  if (entry === null) return { entry: null, stop: null, target: null, riskReward: null, position: null };

  const flooredStop = direction === "long"
    ? Math.min(rawStop, entry - atr * options.minStopAtr)
    : Math.max(rawStop, entry + atr * options.minStopAtr);
  const risk = Math.abs(entry - flooredStop);
  if (!(risk > 0)) return { entry, stop: null, target: null, riskReward: null, position: null };

  const target = options.targetPrice != null
    ? options.targetPrice
    : direction === "long" ? entry + risk * options.targetR : entry - risk * options.targetR;
  const reward = direction === "long" ? target - entry : entry - target;
  const riskReward = reward / risk;
  const position = calculatePositionSize({
    instrument: input.instrument, accountBalance: input.accountBalance,
    riskPercent: DEFAULT_RISK_POLICY.riskPercent, entry, stop: flooredStop, applyPaperCap: false,
  });
  return { entry, stop: flooredStop, target, riskReward, position };
}

/**
 * A completed confirmation candle in the trade's direction: an engulf, a
 * decisive continuation body, or a rejection wick. Shared by EMA and momentum.
 */
export function confirmationCandle(candles: Candle[], direction: "long" | "short", atr: number): boolean {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current || !previous || atr <= 0) return false;
  const body = Math.abs(current.close - current.open);
  const range = current.high - current.low;
  if (direction === "long") {
    const engulfing = previous.close < previous.open && current.close > current.open && current.close >= previous.open && current.open <= previous.close;
    const continuation = current.close > previous.high && body >= atr * 0.45;
    const rejection = range > 0 && current.close > current.open && current.close >= current.high - range * 0.35;
    return engulfing || continuation || rejection;
  }
  const engulfing = previous.close > previous.open && current.close < current.open && current.close <= previous.open && current.open >= previous.close;
  const continuation = current.close < previous.low && body >= atr * 0.45;
  const rejection = range > 0 && current.close < current.open && current.close <= current.low + range * 0.35;
  return engulfing || continuation || rejection;
}

const EMPTY_FEATURES: StrategyResearchFeatures = {
  trend15m: "mixed", trend1h: null, trend4h: null, ema21: null, ema50: null, ema200: null,
  rsi14: null, atr14: null, atrPips: null, structureHighs: 0, structureLows: 0, liquidity: null,
};

export interface FinalizeInput {
  family: StrategyFamily;
  version: string;
  configVersion: string;
  input: StrategyEvaluationInput;
  evaluatedAt: string;
  regime: MarketRegime;
  direction: StrategyDirection;
  plan: TradePlan | null;
  conditions: StrategyCondition[];
  status: SetupStatus;
  summary: string;
  qualifyReason: string;
  features?: StrategyResearchFeatures;
  /** Overrides the verdict derived from `conditions`. Rarely needed. */
  newsStatus?: NewsGateStatus;
}

/**
 * Assemble the common {@link StrategyCandidate} shape for a family evaluator.
 *
 * `newsStatus` and `evaluationMode` are stamped onto the features here rather
 * than in each strategy. Every one of the four families builds its features
 * literal inline and none of them set these two, so `openPaperTrade` — which
 * reads `setup.features.newsStatus` — wrote 'not_evaluated' onto all 55
 * multi-strategy trades even though the news gate had run and passed on all 55.
 * Deriving it from the condition list at this single point means the column and
 * the conditions array come from the same fact and cannot drift apart, and no
 * strategy has to remember to do it.
 */
export function finalizeCandidate(args: FinalizeInput): StrategyCandidate {
  const { plan } = args;
  const features = args.features ?? EMPTY_FEATURES;
  const newsStatus = args.newsStatus ?? newsStatusFromConditions(args.conditions) ?? undefined;
  return {
    family: args.family,
    version: args.version,
    configVersion: args.configVersion,
    regime: args.regime,
    qualifyReason: args.qualifyReason,
    status: args.status,
    instrument: args.input.instrument,
    pair: displayNameFor(args.input.instrument),
    direction: args.direction,
    timeframe: "15m",
    entry: plan?.entry ?? null,
    stop: plan?.stop ?? null,
    target: plan?.target ?? null,
    riskReward: plan?.riskReward ?? null,
    positionSize: plan?.position ?? null,
    features: { ...features, newsStatus, evaluationMode: args.input.evaluationMode ?? "live" },
    summary: args.summary,
    conditions: args.conditions,
    passedConditions: args.conditions.filter((item) => item.passed),
    failedConditions: args.conditions.filter((item) => !item.passed),
    evaluatedAt: args.evaluatedAt,
    dataSource: args.input.dataSource,
  };
}

export function pipOf(instrument: MajorInstrument) {
  return pipSizeFor(instrument);
}
