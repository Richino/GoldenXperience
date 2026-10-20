import { createHash } from "node:crypto";
import { ANALYZE_V2, TIMEFRAME_MS } from "../../../frontend/src/lib/strategy/analyze-v2/config.js";
import { checkTimeframe } from "../../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { readMarketFoundation, type MarketFoundation } from "../../../frontend/src/lib/strategy/analyze-v2/foundation.js";
import { readTrend, type TrendRead } from "../../../frontend/src/lib/strategy/analyze-v2/structure.js";
import { getForexSessionStatus } from "../../../frontend/src/lib/strategy/session.js";
import type { Candle } from "../../../frontend/src/types/forex.js";
import { OBSERVED_LABEL, FORWARD_LABEL, type Catalyst, type ForwardLean, type MarketOpportunity, type MarketStateCondition, type MarketStateSnapshot } from "../../../frontend/src/lib/trade-plans/market-state.js";
import type { GeneratorInput } from "../trade-plan-generator.js";
import type { TradePlanInput } from "../trade-plans.js";
import type { CalendarSnapshot } from "./calendar-snapshot.js";
import { evidenceBalance, impactOnPair, isSupportedSchema, type Factor, type MarketIntelligence } from "./research-contract.js";

export const MARKET_STATE_VERSION = "market-state-v1.0.0";
const HOUR = 3_600_000;
const round = (n: number) => Number(n.toFixed(4));
type Market = Pick<GeneratorInput, "instrument" | "candles" | "quote" | "now">;
export type MarketTechnicals = {
  foundation: MarketFoundation; h1: TrendRead | null; candles: Record<"H1" | "H4" | "D1", Candle[]>;
  issues: string[]; stale: boolean;
};

/** Shared authoritative structure engine. No plan proposal, web request, or model call. */
export function readMarketTechnicals(market: Market): MarketTechnicals {
  const issues: string[] = [];
  const candles = {} as MarketTechnicals["candles"];
  let stale = false;
  for (const tf of ["H1", "H4", "D1"] as const) {
    const supplied = market.candles[tf] ?? [];
    // Completed means its END is known at this clock, including in replays.
    const usable = supplied.filter(c => c.complete === true && Number.isFinite(Date.parse(c.time)) && Date.parse(c.time) + TIMEFRAME_MS[tf] <= market.now);
    const checked = checkTimeframe(tf, usable, tf, market.now, ANALYZE_V2.SWING, true);
    candles[tf] = checked.normalized.closed;
    for (const check of checked.checks) if (check.status === "FAIL" || check.status === "UNKNOWN") {
      issues.push(`${tf}: ${check.reason}`);
      if (/freshness/.test(check.id)) stale = true;
    }
    if (usable.some(c => ![c.open, c.high, c.low, c.close].every(n => Number.isFinite(n) && n > 0) || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close) || c.low > c.high)) issues.push(`${tf}: malformed OHLC prices.`);
    const last = candles[tf].at(-1);
    // Weekend acceptance never makes a previous week's feed current.
    if (last && market.now - Date.parse(last.time) - TIMEFRAME_MS[tf] > 96 * HOUR) { stale = true; issues.push(`${tf}: last completed candle is over four days old.`); }
  }
  const foundation = readMarketFoundation({ instrument: market.instrument, mode: "SWING", candles, quote: market.quote, now: market.now });
  const h1 = candles.H1.length >= 60 ? readTrend(market.instrument, "H1", candles.H1, ANALYZE_V2.NORMAL.regime) : null;
  if (!foundation.primary?.sufficient || !foundation.higher?.sufficient || !h1?.sufficient) issues.push("Insufficient confirmed D1/H4/H1 structure.");
  if (getForexSessionStatus(new Date(market.now)).marketOpen && !foundation.data.quote.executable) issues.push("Current OANDA quote is unavailable or stale while the market is open.");
  return { foundation, h1, candles, issues: [...new Set(issues)], stale };
}

const direction = (trend: TrendRead | null) => trend?.direction === "UPTREND" ? 1 : trend?.direction === "DOWNTREND" ? -1 : 0;
const topicOf = (factor: Factor) => {
  const text = `${factor.factor} ${factor.description}`.toLowerCase();
  if (/energy|oil|gas supply/.test(text)) return "energy";
  if (/fiscal|sovereign|budget|debt/.test(text)) return "fiscal";
  if (/positioning|cftc|speculative|short.cover/.test(text)) return "positioning";
  if (/fed|ecb|central.bank|interest.rate|treasury|yield|tightening|easing|policy/.test(text)) return "policy-and-rates";
  if (/employment|payroll|unemployment/.test(text)) return "employment";
  if (/inflation|cpi|pce/.test(text)) return "inflation";
  if (/growth|gdp|retail|consumption/.test(text)) return "growth";
  if (/risk.aversion|risk.appetite|equities|ai.related/.test(text)) return "risk-sentiment";
  return `source:${[...factor.sourceIds].sort()[0] ?? factor.id}`;
};

/** Conservative catalyst grouping: one maximum per direction, currency and topic, never a sum of duplicate stories. */
export function groupMarketCatalysts(intel: MarketIntelligence, now: number): Catalyst[] {
  const registry = new Set(intel.sources.filter(s => s.verification === "returned_by_search").map(s => s.id));
  const groups = new Map<string, { catalyst: Catalyst; nearBull: number; nearBear: number; swingBull: number; swingBear: number }>();
  for (const f of intel.factors) {
    if (![intel.base, intel.quote].includes(f.currency) || !f.sourceIds.some(id => registry.has(id))) continue;
    const impact = impactOnPair(intel.pair, f.currency, f.effectOnCurrency);
    const at = f.observedAt ? Date.parse(f.observedAt) : NaN;
    if (Number.isFinite(at) && at > now) continue;
    const hours = Number.isFinite(at) ? (now - at) / HOUR : Infinity;
    const recency = hours <= 24 ? 1 : hours <= 72 ? 0.8 : hours <= 168 ? 0.5 : Number.isFinite(hours) ? 0.25 : 0.2;
    const weight = ({ high: 3, medium: 2, low: 1 }[f.importance] ?? 1) * (f.evidenceType === "hypothesis" ? 0.5 : 1) * recency;
    const topic = topicOf(f);
    const id = `${f.currency}:${topic}`;
    const g = groups.get(id) ?? { catalyst: { id, topic, currency: f.currency, factorIds: [], sourceIds: [], bullish: 0, bearish: 0, shortTermNet: 0, swingNet: 0, latestObservedAt: null, persistence: "NOT_ESTABLISHED" }, nearBull: 0, nearBear: 0, swingBull: 0, swingBear: 0 };
    g.catalyst.factorIds.push(f.id);
    g.catalyst.sourceIds = [...new Set([...g.catalyst.sourceIds, ...f.sourceIds.filter(s => registry.has(s))])];
    if (Number.isFinite(at) && (!g.catalyst.latestObservedAt || at > Date.parse(g.catalyst.latestObservedAt))) g.catalyst.latestObservedAt = new Date(at).toISOString();
    if (impact === "bullish" || impact === "bearish") {
      g.catalyst[impact] = Math.max(g.catalyst[impact], weight);
      const near = weight * (hours <= 72 ? 1 : 0.25);
      const swing = weight * (hours <= 168 ? 1 : 0.5);
      if (impact === "bullish") { g.nearBull = Math.max(g.nearBull, near); g.swingBull = Math.max(g.swingBull, swing); }
      else { g.nearBear = Math.max(g.nearBear, near); g.swingBear = Math.max(g.swingBear, swing); }
    }
    groups.set(id, g);
  }
  return [...groups.values()].map(g => ({ ...g.catalyst, bullish: round(g.catalyst.bullish), bearish: round(g.catalyst.bearish), shortTermNet: round(g.nearBull - g.nearBear), swingNet: round(g.swingBull - g.swingBear) })).sort((a, b) => a.id.localeCompare(b.id));
}

function opportunity(intel: MarketIntelligence, side: "BUY" | "SELL", plans: TradePlanInput[]): MarketOpportunity {
  const plan = plans.find(p => p.direction === side);
  const thesis = side === "BUY" ? intel.bullishThesis : intel.bearishThesis;
  return {
    direction: side, status: plan ? "CONDITIONAL_PLAN" : "RESEARCH_CASE_ONLY", thesis: thesis.hypothesis,
    setupType: plan?.setupType ?? null, trigger: typeof plan?.plan.entryTrigger === "string" ? plan.plan.entryTrigger : null,
    entryZone: plan ? { low: plan.entryZoneLow, high: plan.entryZoneHigh } : null, stop: plan?.stopLoss ?? null, target: plan?.takeProfit ?? null,
    confirmation: plan?.conditions?.map(c => c.label) ?? thesis.strengthensIf,
    invalidation: plan ? ((plan.plan.invalidation as { rules?: string[] } | undefined)?.rules ?? []) : thesis.weakensIf,
    expiresAt: plan?.expiresAt ?? null,
    readiness: !plan ? "NO_NEW_PLAN" : (plan.plan.entryReadiness as { status?: string } | undefined)?.status === "WAITING_FOR_RISK_REWARD" ? "WAITING_FOR_RISK_REWARD" : "WAITING_FOR_CONFIRMATION",
  };
}

function reactionsFor(calendar: CalendarSnapshot, candles: Candle[], now: number): MarketStateSnapshot["reactions"] {
  const released = calendar.released.filter(e => calendar.currencies.includes(e.currency) && e.impact >= 2 && Date.parse(e.at) <= now && now - Date.parse(e.at) <= 72 * HOUR);
  return released.slice(-12).map(event => {
    const at = Date.parse(event.at);
    const before = candles.filter(c => Date.parse(c.time) + HOUR <= at).at(-1);
    const after = candles.find(c => Date.parse(c.time) + HOUR >= at + HOUR && Date.parse(c.time) + HOUR <= at + 2 * HOUR);
    const aligned = before && after && at - Date.parse(before.time) - HOUR <= HOUR;
    const overlaps = released.some(e => e !== event && Math.abs(Date.parse(e.at) - at) < HOUR);
    return {
      eventId: `${event.currency}|${event.title}|${event.at}`, title: event.title, at: event.at,
      status: aligned ? "OBSERVED" as const : "UNVERIFIED" as const,
      from: aligned ? before.close : null, to: aligned ? after.close : null,
      startAt: aligned ? new Date(Date.parse(before.time) + HOUR).toISOString() : null,
      endAt: aligned ? new Date(Date.parse(after.time) + HOUR).toISOString() : null,
      changePercent: aligned ? round((after.close / before.close - 1) * 100) : null,
      overlappingReleases: overlaps,
      explanation: aligned ? `Completed OANDA H1 closes around the release show price movement, not causation.${overlaps ? " Other releases overlap this window." : ""}` : "No time-aligned completed OANDA candles establish a reaction window.",
    };
  });
}

/** Shared completed-candle reaction observations; no new interpretation or execution behavior. */
export { reactionsFor as observedReleaseReactions };

export type InterpretMarketInput = {
  intelligence: MarketIntelligence; researchFresh: boolean; researchStaleReason?: string | null;
  market: Market; technical: MarketTechnicals; calendar: CalendarSnapshot | null;
  plans?: TradePlanInput[]; previous?: MarketStateSnapshot | null;
};

/** Pure, versioned synthesis. It never calls GPT, changes a plan, or grants entry permission. */
export function interpretMarketState(input: InterpretMarketInput): MarketStateSnapshot {
  const { intelligence: intel, market, technical: t } = input;
  const now = market.now;
  const calendar = input.calendar;
  const issues = [...t.issues];
  if (!isSupportedSchema(intel.schemaVersion) || intel.pair !== market.instrument) issues.push("Validated research schema/pair is invalid.");
  if (!input.researchFresh) issues.push(input.researchStaleReason ?? "Research is stale.");
  if (!Number.isFinite(Date.parse(intel.research.createdAt)) || Date.parse(intel.research.createdAt) > now) issues.push("Research timestamp is invalid or in the future.");
  if (!Number.isFinite(Date.parse(intel.research.cutoffAt)) || Date.parse(intel.research.cutoffAt) > now) issues.push("Research cutoff is invalid or in the future.");
  if (!calendar?.available || ![intel.base, intel.quote].every(c => calendar.currencies.includes(c)) || !Number.isFinite(Date.parse(calendar.readAt)) || Date.parse(calendar.readAt) > now || now - Date.parse(calendar.readAt) > 6 * HOUR) issues.push("Verified current calendar input is unavailable or stale.");
  const closedAt = Object.fromEntries((["H1", "H4", "D1"] as const).map(tf => [tf, t.candles[tf].at(-1) ? new Date(Date.parse(t.candles[tf].at(-1)!.time) + TIMEFRAME_MS[tf]).toISOString() : null])) as MarketStateSnapshot["source"]["candleClosedAt"];
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: MARKET_STATE_VERSION, asOfHour: Math.floor(now / HOUR), research: intel, candles: t.candles,
    technical: [t.h1, t.foundation.primary, t.foundation.higher].map(r => r ? { direction: r.direction, atr: r.atr, swingHigh: r.lastSwingHigh, swingLow: r.lastSwingLow, protectedLevel: r.structureLevel } : null),
    calendar, plans: (input.plans ?? []).map(p => ({ side: p.direction, setup: p.setupType, entry: [p.entryZoneLow, p.entryZoneHigh], stop: p.stopLoss, target: p.takeProfit, conditions: p.conditions, invalidation: p.plan.invalidation })), qualityIssues: issues })).digest("hex");
  const id = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-8${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
  const raw = evidenceBalance(intel.factors);
  const snapshot: MarketStateSnapshot = {
    schemaVersion: "1.0", engineVersion: MARKET_STATE_VERSION, id, inputHash: fingerprint, instrument: market.instrument, researchId: intel.research.id, generatedAt: new Date(now).toISOString(),
    quality: { status: issues.length ? (!input.researchFresh || t.stale ? "STALE" : "UNAVAILABLE") : intel.research.missingData.length ? "PARTIAL" : "VALID", issues: [...new Set(issues)] },
    source: { market: "oanda", marketOpen: getForexSessionStatus(new Date(now)).marketOpen, researchCreatedAt: intel.research.createdAt, calendarReadAt: calendar?.readAt ?? null, candleClosedAt: closedAt },
    observed: { classification: "INSUFFICIENT_DATA", timeframe: "H1", asOf: closedAt.H1, explanation: "Mandatory inputs are not usable; no market interpretation is issued.", evidence: [], continuation: [], invalidation: [], recentMoveAtr: null, efficiency: null },
    fundamental: { classification: "INSUFFICIENT_EVIDENCE", explanation: "No interpretation while mandatory inputs are unavailable.", rawScores: { bullish: raw.bullish, bearish: raw.bearish }, adjusted: { bullish: 0, bearish: 0 }, catalysts: [] },
    forward: { shortTerm: { classification: "INDETERMINATE", horizon: "Next 24 trading hours", explanation: "Mandatory data checks must pass first.", supportingCatalystIds: [], opposingCatalystIds: [] }, swing: { classification: "INDETERMINATE", horizon: "Next 2–5 trading days", explanation: "Mandatory data checks must pass first.", supportingCatalystIds: [], opposingCatalystIds: [] } },
    opportunities: [], reactions: [], previous: null, summary: "Market interpretation unavailable: mandatory data checks did not pass.", costs: { modelCalls: 0, webSearchCalls: 0 },
  };
  if (issues.length) return snapshot;

  const h1 = t.h1!; const h4 = t.foundation.primary!; const d1 = t.foundation.higher!;
  const recent = t.candles.H1.slice(-13);
  const change = recent.at(-1)!.close - recent[0]!.close;
  const travel = recent.slice(1).reduce((sum, c, i) => sum + Math.abs(c.close - recent[i]!.close), 0);
  const efficiency = travel > 0 ? Math.abs(change) / travel : 0;
  const move = h1.atr > 0 ? change / h1.atr : 0;
  const momentum = Math.abs(move) >= 0.75 && efficiency >= 0.35 ? Math.sign(move) : 0;
  const short = momentum || direction(h1);
  const higher = direction(d1) || direction(h4);
  let observed: MarketStateSnapshot["observed"]["classification"];
  if (short && higher && short !== higher) observed = short > 0 ? "BULLISH_RECOVERY" : "BEARISH_RECOVERY";
  else if (direction(h4) && short && short === direction(h4)) {
    const strong = direction(d1) === short && direction(h1) === short && efficiency >= 0.65 && Math.abs(move) >= 2;
    observed = short > 0 ? strong ? "STRONG_BULLISH_TREND" : "BULLISH_TREND" : strong ? "STRONG_BEARISH_TREND" : "BEARISH_TREND";
  } else if (h4.direction === "RANGE" && !momentum) observed = "RANGE";
  else observed = "VOLATILE_UNSTRUCTURED";
  const recovery = observed.endsWith("RECOVERY");
  snapshot.observed = {
    ...snapshot.observed, classification: observed, recentMoveAtr: round(move), efficiency: round(efficiency),
    explanation: recovery ? `${direction(h1) === short ? "Confirmed H1 structure shows" : "Recent completed H1 price shows"} ${short > 0 ? "an upward recovery" : "a downward pullback"} against the ${direction(d1) ? "D1" : "H4"} trend.${move * short < 0 ? " The latest 12-hour net move has retraced within that structure." : ""} This is a countertrend recovery, not a confirmed higher-timeframe reversal.`
      : observed === "RANGE" ? "H4 structure is ranging and the recent H1 move does not establish directional continuation."
      : observed === "VOLATILE_UNSTRUCTURED" ? "Confirmed structure and recent price movement do not establish an organized trend."
      : `H1 movement and confirmed H4 structure point ${short > 0 ? "upward" : "downward"}.${observed.startsWith("STRONG") ? " D1 agrees and the recent move is directional relative to H1 volatility." : " A continuation remains conditional on later prices."}`,
    evidence: [`D1: ${d1.direction}; H4: ${h4.direction}; H1: ${h1.direction}.`, `Last 12 completed H1 intervals moved ${round(move)} H1 ATR; path efficiency ${Math.round(efficiency * 100)}%.`, ...h1.evidence, ...h4.evidence.slice(0, 2)],
  };
  const aheadZones = t.foundation.zones.filter(z => z.status === "ACTIVE" && (short > 0 ? z.type === "RESISTANCE" && z.high > h1.close : z.type === "SUPPORT" && z.low < h1.close))
    .sort((a, b) => short > 0 ? a.high - b.high : b.low - a.low);
  const swingAhead = short > 0 && h1.lastSwingHigh && h1.lastSwingHigh.price > h1.close ? h1.lastSwingHigh.price
    : short < 0 && h1.lastSwingLow && h1.lastSwingLow.price < h1.close ? h1.lastSwingLow.price : null;
  const continuationLevel = swingAhead ?? (short > 0 ? aheadZones[0]?.high ?? Math.max(...recent.map(c => c.high)) : short < 0 ? aheadZones[0]?.low ?? Math.min(...recent.map(c => c.low)) : null);
  const invalidationLevel = short > 0 ? h1.lastSwingLow && h1.lastSwingLow.price < h1.close ? h1.lastSwingLow.price : Math.min(...recent.map(c => c.low))
    : short < 0 ? h1.lastSwingHigh && h1.lastSwingHigh.price > h1.close ? h1.lastSwingHigh.price : Math.max(...recent.map(c => c.high)) : null;
  const condition = (level: number, up: boolean, explanation: string): MarketStateCondition => ({ timeframe: "H1", relation: up ? "CLOSE_ABOVE" : "CLOSE_BELOW", level, explanation });
  if (continuationLevel) snapshot.observed.continuation.push(condition(continuationLevel, short > 0, `A later completed H1 close through ${swingAhead ? "the last confirmed swing" : aheadZones.length ? "the next opposing zone" : "the recent completed price extreme"} strengthens continuation; plan-specific rules still apply.`));
  if (invalidationLevel) snapshot.observed.invalidation.push(condition(invalidationLevel, short < 0, "A later completed H1 close through the opposing swing weakens the current interpretation; it does not automatically trigger the other trade."));
  if (recovery && d1.structureLevel) snapshot.observed.continuation.push({ timeframe: "D1", relation: short > 0 ? "CLOSE_ABOVE" : "CLOSE_BELOW", level: d1.structureLevel, explanation: "The higher-timeframe trend has not reversed while its protected structure remains intact." });

  const catalysts = groupMarketCatalysts(intel, now);
  const bullish = catalysts.reduce((sum, c) => sum + c.bullish, 0);
  const bearish = catalysts.reduce((sum, c) => sum + c.bearish, 0);
  const total = bullish + bearish;
  const net = total ? (bullish - bearish) / total : 0;
  const directional = catalysts.filter(c => c.bullish !== c.bearish);
  const fundamental = !total ? "INSUFFICIENT_EVIDENCE" : Math.abs(net) < 0.15 ? "MIXED" : net > 0 ? (net >= 0.35 && directional.filter(c => c.bullish > c.bearish).length >= 2 ? "BULLISH" : "SLIGHTLY_BULLISH") : (net <= -0.35 && directional.filter(c => c.bearish > c.bullish).length >= 2 ? "BEARISH" : "SLIGHTLY_BEARISH");
  snapshot.fundamental = {
    classification: fundamental, rawScores: snapshot.fundamental.rawScores, adjusted: { bullish: round(bullish), bearish: round(bearish) }, catalysts,
    explanation: !total ? "No directly relevant, source-linked directional catalysts are available."
      : `${directional.length} directional catalyst groups remain after grouping related stories and discounting older or undated evidence. ${fundamental === "MIXED" ? "Support and opposition are close; fundamentals are mixed." : `${net > 0 ? "Bullish" : "Bearish"} support is stronger on this adjusted evidence read.`} Persistence is not established. These weights are not probabilities.`,
  };
  const leanFor = (horizon: "shortTerm" | "swing") => {
    const key = horizon === "shortTerm" ? "shortTermNet" : "swingNet";
    const strength = catalysts.reduce((sum, c) => sum + Math.abs(c[key]), 0);
    const score = strength ? catalysts.reduce((sum, c) => sum + c[key], 0) / strength : 0;
    const priced = horizon === "shortTerm" ? short : direction(h4) && direction(h4) === direction(d1) ? direction(h4) : 0;
    let classification: ForwardLean = "INDETERMINATE";
    let explanation = "Price structure and the independent catalysts do not establish a clear forward preference.";
    if (horizon === "swing" && recovery) explanation = "A countertrend recovery has occurred, but the higher-timeframe reversal is unconfirmed. The swing direction remains indeterminate.";
    else if (directional.length && priced && priced * score >= -0.2) {
      const supported = catalysts.filter(c => c[key] * priced > 0).length;
      const strong = observed.startsWith("STRONG") && supported >= 2 && priced * score >= 0.2;
      classification = priced > 0 ? strong ? "BULLISH" : "SLIGHTLY_BULLISH" : strong ? "BEARISH" : "SLIGHTLY_BEARISH";
      explanation = `Completed ${horizon === "shortTerm" ? "H1" : "H4/D1"} price behaviour supports a ${priced > 0 ? "bullish" : "bearish"} preference; ${supported} distinct catalyst group${supported === 1 ? "" : "s"} support it.${recovery ? " This is a recovery preference, not a confirmed trend reversal." : " Further price confirmation is still required."}`;
    } else if (observed === "RANGE" && directional.length >= 2 && Math.abs(score) < 0.15) { classification = "NEUTRAL"; explanation = "Observed price is ranging and the independent catalysts are balanced."; }
    else if (horizon === "shortTerm" && !priced && directional.length >= 2 && Math.abs(score) >= 0.35) {
      classification = score > 0 ? "SLIGHTLY_BULLISH" : "SLIGHTLY_BEARISH";
      explanation = "Recent independent catalysts support a tentative preference, but observed price has not confirmed continuation.";
    } else if (priced && priced * score < -0.2) explanation = "Observed price and the independent economic catalysts oppose each other. Neither is treated as a confirmed forecast.";
    const sign = classification.includes("BULLISH") ? 1 : classification.includes("BEARISH") ? -1 : 0;
    return { classification, horizon: snapshot.forward[horizon].horizon, explanation, supportingCatalystIds: sign ? catalysts.filter(c => c[key] * sign > 0).map(c => c.id) : [], opposingCatalystIds: sign ? catalysts.filter(c => c[key] * sign < 0).map(c => c.id) : [] };
  };
  snapshot.forward = { shortTerm: leanFor("shortTerm"), swing: leanFor("swing") };
  snapshot.opportunities = [opportunity(intel, "BUY", input.plans ?? []), opportunity(intel, "SELL", input.plans ?? [])];
  snapshot.reactions = reactionsFor(calendar!, t.candles.H1, now);
  if (input.previous && input.previous.instrument === market.instrument && Date.parse(input.previous.generatedAt) <= now) snapshot.previous = {
    id: input.previous.id, observedStateChanged: input.previous.observed.classification !== observed,
    shortTermChanged: input.previous.forward.shortTerm.classification !== snapshot.forward.shortTerm.classification,
    swingChanged: input.previous.forward.swing.classification !== snapshot.forward.swing.classification,
  };
  snapshot.summary = `${OBSERVED_LABEL[observed]}. Near-term preference: ${FORWARD_LABEL[snapshot.forward.shortTerm.classification].toLowerCase()}; swing: ${FORWARD_LABEL[snapshot.forward.swing.classification].toLowerCase()}.${recovery ? " The recovery is observed; continuation and a broader reversal are unconfirmed." : " A research preference does not confirm an entry."}`;
  return snapshot;
}
