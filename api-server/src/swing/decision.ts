import { createHash, randomUUID } from "node:crypto";
import { requestPracticeAccount, oandaEnvironment } from "../../../frontend/src/lib/oanda/client.js";
import { currenciesOf } from "../../../frontend/src/lib/instruments/catalog.js";
import { addTradingHours } from "../trade-plan-generator.js";
import { query } from "../database.js";
import type { SwingAssessment, SwingControl, SwingExpectancy, SwingLean, SwingMarket, SwingMovement, SwingScenario, SwingSide, SwingStyle, SwingZone, SwingBehavior } from "../../../frontend/src/lib/swing-intelligence.js";
import type { SwingSettings } from "./config.js";

export const SWING_STRATEGY_VERSION = "swing-intelligence-v1-provisional";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const stableId = (value: unknown) => { const h = digest(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
export function swingAssessmentFresh(assessment: SwingAssessment | null, market: SwingMarket | null, now = Date.now()) {
  if (!assessment || !market || ![Date.parse(assessment.expiresAt), Date.parse(assessment.createdAt)].every(Number.isFinite) || Date.parse(assessment.expiresAt) <= now || Date.parse(assessment.createdAt) > now) return false;
  return !market.calendar.events.some(e => e.impact >= 3 && e.timingVerified && e.actual !== null && Date.parse(e.timestamp) <= now &&
    assessment.calendar.find(old => old.id === e.id)?.actual !== e.actual);
}
const up = (control: SwingControl) => control === "BUYERS_DOMINANT" ? 1 : control === "SELLERS_DOMINANT" ? -1 : 0;
export function pressureControl(movement: SwingMovement | null, market: SwingMarket, settings: SwingSettings): SwingControl {
  const w = movement?.windows.find(w => w.seconds >= 60 && w.ready);
  if (movement?.state !== "READY" || !w) return "INSUFFICIENT_DATA";
  const progress = Math.abs(w.netPips) * market.pipSize;
  const count = w.upCount + w.downCount, persistence = count ? (w.upCount - w.downCount) / count : 0;
  if (w.efficiency < settings.pressureEfficiency || progress < market.frames.H4.atr * settings.pressureProgressAtr || Math.sign(persistence) !== Math.sign(w.netPips) || Math.abs(persistence) < settings.pressurePersistence) return "CONTESTED";
  return w.netPips > 0 ? "BUYERS_DOMINANT" : "SELLERS_DOMINANT";
}
export function swingPreference(market: SwingMarket, assessment: SwingAssessment | null, pressure: SwingControl, settings: SwingSettings): SwingLean {
  if (!(["D1", "H4", "H1"] as const).every(tf => market.frames[tf].sufficient)) return "INSUFFICIENT_DATA";
  const ai = assessment?.interpretation.combinedLean;
  const w = settings.controlWeights;
  const balance = up(market.frames.D1.control) * w.daily + up(market.frames.H4.control) * w.h4 + up(pressure) * w.pressure + (ai === "BUY_FAVORED" ? 1 : ai === "SELL_FAVORED" ? -1 : 0) * w.interpretation;
  return balance >= w.threshold ? "BUY_FAVORED" : balance <= -w.threshold ? "SELL_FAVORED" : "NO_DIRECTIONAL_EDGE";
}

export function generateSwingZones(market: SwingMarket, assessment: SwingAssessment | null, settings: SwingSettings, existing: SwingZone[] = [], campaign = "") {
  const result: SwingZone[] = [], unavailable: string[] = [], atr = market.frames.H4.atr;
  if (!market.structureZones.length || !(atr > 0)) return { zones: [], unavailable: ["Completed D1/H4 structure does not establish defensible zones."] };
  const preference = swingPreference(market, assessment, "INSUFFICIENT_DATA", settings), selling = preference === "SELL_FAVORED";
  const mid = market.quote ? (market.quote.bid + market.quote.ask) / 2 : null;
  const sorted = [...market.structureZones].sort((a, b) => Math.abs((a.lower + a.upper) / 2 - (mid ?? market.frames.H4.highs.at(-1)?.price ?? 0)) - Math.abs((b.lower + b.upper) / 2 - (mid ?? market.frames.H4.highs.at(-1)?.price ?? 0)));
  for (const classification of ["PULLBACK_REVERSAL", "BREAKOUT_CONTINUATION"] as const) {
    const desired = classification === "PULLBACK_REVERSAL" ? selling ? "RESISTANCE" : "SUPPORT" : selling ? "SUPPORT" : "RESISTANCE";
    const generationOf = (z: SwingMarket["structureZones"][number]) => digest([campaign, market.instrument, classification, Number(z.lower.toFixed(market.precision)), Number(z.upper.toFixed(market.precision)), z.swingReferences, preference]);
    const retained = sorted.find(z => existing.some(old => old.classification === classification && old.generation === generationOf(z)));
    const z = retained ?? sorted.find(z => z.type === desired && !result.some(prior => prior.lower === Number(z.lower.toFixed(market.precision)) && prior.upper === Number(z.upper.toFixed(market.precision))));
    if (!z || !z.swingReferences.length) { unavailable.push(`${classification}: no distinct ${desired.toLowerCase()} zone is supported by confirmed swings.`); continue; }
    const lower = Number(z.lower.toFixed(market.precision)), upper = Number(z.upper.toFixed(market.precision));
    const generation = generationOf(z);
    const previous = existing.find(old => old.generation === generation);
    const createdAt = market.capturedAt;
    result.push({ id: randomUUID(), instrument: market.instrument, assessmentId: assessment?.id ?? null, timeframe: "H4", lower, upper, classification,
      structuralType: previous?.structuralType ?? z.type, status: "WATCHING", createdAt, validatedAt: createdAt,
      expiresAt: new Date(addTradingHours(Date.parse(createdAt), settings.zoneTtlTradingHours)).toISOString(), revision: 0, touchedAt: null,
      evidence: z.evidence, fundamentalContext: assessment ? [assessment.fundamentalSummary, ...assessment.interpretation.contradictions] : ["Fundamental assessment unavailable; eligibility remains blocked."],
      swingReferences: z.swingReferences, buyScenario: "Assess support defense or accepted upside breakout independently of the original lean.",
      sellScenario: "Assess resistance rejection or accepted downside breakout independently of the original lean.",
      invalidation: { lower: lower - atr * settings.zoneInvalidationAtr, upper: upper + atr * settings.zoneInvalidationAtr,
        rules: ["Expire when the supporting confirmed structure changes or the thesis is materially invalidated.", "Expire outside the structural invalidation envelope or at the trading-hour TTL.", "Pause entry eligibility when executable quotes or source evidence become unreliable."] },
      behavior: "INSUFFICIENT_DATA", behaviorSide: null, reason: "Watching a structure-derived region; no order is authorized.", generation });
  }
  return { zones: result, unavailable };
}

export function zoneReaction(zone: SwingZone, market: SwingMarket, movement: SwingMovement, settings: SwingSettings): { behavior: SwingBehavior; side: SwingSide | null; reason: string } {
  const q = market.quote, atr = market.frames.H4.atr, w = movement.windows.find(w => w.seconds >= settings.initialObservationSeconds && w.ready);
  if (!q || !w || !zone.touchedAt || movement.state !== "READY") return { behavior: "INSUFFICIENT_DATA", side: null, reason: "Reliable post-touch observation coverage is still warming." };
  const mid = (q.bid + q.ask) / 2, beyond = atr * settings.breakoutAtr;
  if (mid > zone.upper + beyond && w.aboveZoneSeconds >= settings.acceptanceSeconds && w.netPips > 0) return { behavior: ["BREAKOUT", "CONTINUATION"].includes(zone.behavior) && zone.behaviorSide === "BUY" ? "CONTINUATION" : "BREAKOUT", side: "BUY", reason: "Observed upside acceptance beyond the structural boundary." };
  if (mid < zone.lower - beyond && w.belowZoneSeconds >= settings.acceptanceSeconds && w.netPips < 0) return { behavior: ["BREAKOUT", "CONTINUATION"].includes(zone.behavior) && zone.behaviorSide === "SELL" ? "CONTINUATION" : "BREAKOUT", side: "SELL", reason: "Observed downside acceptance beyond the structural boundary." };
  if (w.high !== null && w.high > zone.upper + beyond && mid < zone.upper && w.netPips < 0) return { behavior: "FAILED_BREAKOUT", side: "SELL", reason: "Observed upside extension returned through the zone." };
  if (w.low !== null && w.low < zone.lower - beyond && mid > zone.lower && w.netPips > 0) return { behavior: "FAILED_BREAKOUT", side: "BUY", reason: "Observed downside extension returned through the zone." };
  if (mid < zone.lower && w.pullbackPips * market.pipSize >= atr * settings.reactionAtr) return { behavior: "REJECTION", side: "SELL", reason: "Observed retreat from the zone's upper excursion." };
  if (mid > zone.upper && w.recoveryPips * market.pipSize >= atr * settings.reactionAtr) return { behavior: "REJECTION", side: "BUY", reason: "Observed recovery from the zone's lower excursion." };
  return { behavior: "CONSOLIDATION", side: null, reason: "Neither hypothesis has established sustained directional acceptance." };
}

export type SwingRiskContext = { asOf: string; equity: number | null; currency: string | null; conversion: number | null;
  minimumUnits: number | null; maximumUnits: number | null; unitsPrecision: number | null; instrumentPrecision: number | null; pipSize: number | null;
  openRiskPercent: number | null; sameInstrumentExposure: boolean; killSwitch: boolean; riskLimit: number; aggregateLimit: number; issues: string[] };
export async function loadSwingRisk(userId: string, instrument: string, settings: SwingSettings): Promise<SwingRiskContext> {
  const context: SwingRiskContext = { asOf: new Date().toISOString(), equity: null, currency: null, conversion: null,
    minimumUnits: null, maximumUnits: null, unitsPrecision: null, instrumentPrecision: null, pipSize: null,
    openRiskPercent: null, sameInstrumentExposure: false, killSwitch: true, riskLimit: settings.riskPercent, aggregateLimit: settings.maxAggregateRisk, issues: [] };
  try {
    const row = (await query<{ kill_switch: boolean; max_risk_percent: string; max_aggregate_risk_percent: string }>("SELECT kill_switch,max_risk_percent::text,max_aggregate_risk_percent::text FROM trade_plan_risk_settings WHERE user_id=$1", [userId])).rows[0];
    context.killSwitch = row?.kill_switch === true;
    const riskLimit = Math.min(settings.riskPercent, Number(row?.max_risk_percent ?? settings.riskPercent));
    const aggregateLimit = Math.min(settings.maxAggregateRisk, Number(row?.max_aggregate_risk_percent ?? settings.maxAggregateRisk));
    if (![riskLimit, aggregateLimit].every(v => Number.isFinite(v) && v > 0)) throw new Error("Account risk limits are invalid.");
    context.riskLimit = riskLimit; context.aggregateLimit = aggregateLimit;
    if (oandaEnvironment() !== "practice") throw new Error("Account sizing requires the configured OANDA practice account; live execution is unavailable.");
    const read = <T>(path: string) => requestPracticeAccount<T>(path, { signal: AbortSignal.timeout(15000) });
    type Trade = { instrument: string; currentUnits: string; price: string; stopLossOrder?: { price: string; state: string } };
    type Order = { instrument?: string; units?: string; price?: string; type: string; stopLossOnFill?: { distance?: string; price?: string } };
    const [account, specs, trades, orders] = await Promise.all([
      read<{ account: { NAV: string; currency: string } }>("/summary"),
      read<{ instruments: Array<{ name: string; pipLocation: number; displayPrecision: number; minimumTradeSize: string; maximumOrderUnits: string; tradeUnitsPrecision: number }> }>(`/instruments?instruments=${encodeURIComponent(instrument)}`),
      read<{ trades: Trade[] }>("/openTrades"), read<{ orders: Order[] }>("/pendingOrders"),
    ]);
    const instruments = [...new Set([instrument, ...trades.trades.map(t => t.instrument), ...orders.orders.filter(o => o.instrument).map(o => o.instrument!)])];
    const pricing = await read<{ homeConversions?: Array<{ currency: string; accountLoss: string; accountGain: string }> }>(`/pricing?instruments=${instruments.map(encodeURIComponent).join(",")}&includeHomeConversions=true`);
    const equity = Number(account.account.NAV), currency = account.account.currency;
    const conversionFor = (pair: string) => {
      const counter = currenciesOf(pair).quote;
      if (counter === currency) return 1;
      const c = pricing.homeConversions?.find(c => c.currency === counter);
      return c ? Math.max(Number(c.accountLoss), Number(c.accountGain)) : NaN;
    };
    const spec = specs.instruments.find(s => s.name === instrument);
    if (!spec || ![equity, Number(spec.minimumTradeSize), Number(spec.maximumOrderUnits)].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(spec.tradeUnitsPrecision)) throw new Error("Broker equity or instrument specification is unavailable.");
    context.equity = equity; context.currency = currency; context.conversion = conversionFor(instrument);
    context.minimumUnits = Number(spec.minimumTradeSize); context.maximumUnits = Number(spec.maximumOrderUnits);
    context.unitsPrecision = spec.tradeUnitsPrecision; context.instrumentPrecision = spec.displayPrecision; context.pipSize = 10 ** spec.pipLocation;
    const entries = orders.orders.filter(o => o.instrument && ["LIMIT", "STOP", "MARKET_IF_TOUCHED"].includes(o.type));
    context.sameInstrumentExposure = trades.trades.some(t => t.instrument === instrument) || entries.some(o => o.instrument === instrument);
    let riskCash = 0, unknown = false;
    for (const t of trades.trades) {
      const conversion = conversionFor(t.instrument), units = Number(t.currentUnits), entry = Number(t.price), stop = Number(t.stopLossOrder?.price);
      if (!Number.isFinite(conversion) || !(conversion > 0) || t.stopLossOrder?.state !== "PENDING" || ![units, entry, stop].every(Number.isFinite)) { unknown = true; continue; }
      riskCash += Math.max(0, units > 0 ? entry - stop : stop - entry) * Math.abs(units) * conversion;
    }
    for (const o of entries) {
      const conversion = conversionFor(o.instrument!), units = Number(o.units), entry = Number(o.price), stop = Number(o.stopLossOnFill?.price);
      const distance = o.stopLossOnFill?.distance ? Number(o.stopLossOnFill.distance) : Number.isFinite(stop) ? Math.max(0, units > 0 ? entry - stop : stop - entry) : NaN;
      if (![conversion, units, entry, distance].every(Number.isFinite) || !(conversion > 0) || !(distance > 0)) { unknown = true; continue; }
      riskCash += Math.abs(units) * distance * conversion;
    }
    context.openRiskPercent = unknown ? null : riskCash / equity * 100;
    if (unknown) context.issues.push("Existing open/pending exposure lacks a verified protective stop or home-currency conversion.");
    if (!(context.conversion! > 0) || !Number.isFinite(context.conversion)) context.issues.push("Home-currency loss conversion is unavailable.");
    context.asOf = new Date().toISOString();
  } catch (error) { context.issues.push(error instanceof Error ? error.message : "Broker account data is unavailable."); }
  return context;
}

export function evaluateSwingScenario(input: { market: SwingMarket; zone: SwingZone; assessment: SwingAssessment | null; movement: SwingMovement;
  risk: SwingRiskContext; side: SwingSide; style: SwingStyle; preference: SwingLean; expectancy?: SwingExpectancy; settings: SwingSettings; now?: number }): SwingScenario {
  const { market: m, zone: z, risk, side, style, settings: s } = input, now = input.now ?? Date.now(), buy = side === "BUY", sign = buy ? 1 : -1;
  const blockers: string[] = [], support: string[] = [], contradictions: string[] = [];
  const q = m.quote, atr = m.frames.H4.atr, pressure = pressureControl(input.movement, m, s);
  const entry = q ? buy ? q.ask : q.bid : null, round = (v: number) => Number(v.toFixed(m.precision));
  const anchor = buy ? m.frames.H4.lows.filter(l => l.price <= z.lower).at(-1)?.price : m.frames.H4.highs.filter(l => l.price >= z.upper).at(-1)?.price;
  const stop = atr > 0 ? round(buy ? Math.min(z.lower, anchor ?? z.lower) - s.stopBufferAtr * atr : Math.max(z.upper, anchor ?? z.upper) + s.stopBufferAtr * atr) : null;
  const targets = m.structureZones.filter(t => buy ? t.lower > z.upper && entry !== null && t.lower > entry : t.upper < z.lower && entry !== null && t.upper < entry)
    .map(t => round(buy ? t.lower - s.structure.plan.obstacleBufferAtr * atr : t.upper + s.structure.plan.obstacleBufferAtr * atr))
    .filter(t => entry !== null && sign * (t - entry) > 0 && sign * (t - entry) <= m.frames.D1.atr * s.maxTargetD1Atr)
    .sort((a, b) => buy ? a - b : b - a);
  const firstTarget = targets[0] ?? null, secondTarget = targets.find(t => firstTarget !== null && sign * (t - firstTarget) > atr * s.structure.zones.minWidthAtr) ?? null;
  const distance = entry !== null && stop !== null ? sign * (entry - stop) : null;
  const reward = entry !== null && firstTarget !== null ? sign * (firstTarget - entry) : null;
  const rr = distance !== null && distance > 0 && reward !== null ? reward / distance : null;
  const spread = q ? q.ask - q.bid : null;
  if (!q || !q.tradeable || now - Date.parse(q.time) > s.quoteMaxAgeMs || Date.parse(q.time) > now + 1000) blockers.push("Fresh executable OANDA pricing is required.");
  if (["STALE", "DISCONNECTED"].includes(input.movement.state)) blockers.push("Observed quote continuity is unavailable; a fresh REST price alone does not establish live zone pressure.");
  if (now - Date.parse(input.movement.asOf) > s.quoteMaxAgeMs) blockers.push("The movement observation became stale while account/decision context was being read.");
  if (m.state !== "CURRENT") blockers.push(`Market data condition: ${m.state}.`);
  if (now - Date.parse(m.capturedAt) > s.deterministicRefreshMs * 3) blockers.push("Technical context is stale.");
  if (z.status === "EXPIRED") blockers.push("The zone has been structurally invalidated or expired.");
  if (!swingAssessmentFresh(input.assessment, m, now)) blockers.push("A current fully validated AI/fundamental assessment is required; a new release may have invalidated it.");
  if (!m.calendar.available || !m.calendar.coverageUntil || Date.parse(m.calendar.coverageUntil) < now + s.blackoutMinutes * 60000) blockers.push("Verified news coverage is unavailable or ends before the entry buffer.");
  for (const e of m.calendar.events.filter(e => e.impact >= 3 && Math.abs(Date.parse(e.timestamp) - now) <= s.blackoutMinutes * 60000)) blockers.push(`High-impact event buffer: ${e.currency} ${e.title}.`);
  if (!(atr > 0) || distance === null || distance <= 0 || distance < atr * s.minStopAtr || distance > atr * s.maxStopAtr) blockers.push("A stop outside structural noise and within the approved ATR limits is required.");
  if (firstTarget === null || reward === null || reward <= 0 || reward > m.frames.D1.atr * s.maxTargetD1Atr || rr === null || rr < s.minRewardRisk) blockers.push("Available structural reward does not meet the provisional swing reward/risk floor.");
  if (spread === null || distance === null || spread / distance > s.maxSpreadStopShare) blockers.push("Spread consumes too much of the proposed structural risk.");
  if (risk.killSwitch) blockers.push("The existing account execution kill switch is on.");
  if (now - Date.parse(risk.asOf) > s.accountRefreshMs * 2) blockers.push("Account exposure data is stale.");
  blockers.push(...risk.issues);
  if (risk.sameInstrumentExposure) blockers.push("This instrument already has broker exposure or a pending entry; correlated proposals are alternatives only.");
  if (risk.openRiskPercent === null || risk.openRiskPercent + risk.riskLimit > risk.aggregateLimit) blockers.push("Verified aggregate account risk capacity is insufficient or unknown.");
  if (risk.pipSize !== m.pipSize || risk.instrumentPrecision !== m.precision) blockers.push("OANDA pip/precision metadata does not match the instrument catalog.");
  const validSizing = risk.equity !== null && risk.equity > 0 && risk.conversion !== null && risk.conversion > 0 && Number.isFinite(risk.conversion) &&
    distance !== null && distance > 0 && risk.unitsPrecision !== null && Number.isInteger(risk.unitsPrecision) && risk.minimumUnits !== null && risk.maximumUnits !== null;
  const riskCash = validSizing ? risk.equity! * risk.riskLimit / 100 : null;
  const factor = 10 ** (risk.unitsPrecision ?? 0), units = riskCash !== null && distance !== null ? Math.floor(riskCash / (distance * risk.conversion!) * factor) / factor : null;
  if (units === null || !Number.isFinite(units) || units < risk.minimumUnits! || units > risk.maximumUnits!) blockers.push("Risk-based size cannot be verified against broker minimum/maximum units.");
  const ownControl = buy ? "BUYERS_DOMINANT" : "SELLERS_DOMINANT", opposite = buy ? "SELLERS_DOMINANT" : "BUYERS_DOMINANT";
  for (const tf of ["D1", "H4"] as const) { if (m.frames[tf].control === ownControl) support.push(`${tf} confirmed structure supports ${side}.`); if (m.frames[tf].control === opposite) contradictions.push(`${tf} confirmed structure opposes ${side}.`); }
  if (pressure === ownControl) support.push("Covered observed quote pressure supports this hypothesis.");
  if (pressure === opposite) contradictions.push("Recent observed quote pressure opposes this hypothesis.");
  support.push(...(buy ? input.assessment?.interpretation.buyEvidence ?? [] : input.assessment?.interpretation.sellEvidence ?? []));
  contradictions.push(...(input.assessment?.interpretation.contradictions ?? []));
  const directional = m.frames.H4.control === ownControl || pressure === ownControl;
  const reaction = z.behaviorSide === side && ["REJECTION", "BREAKOUT", "CONTINUATION", "FAILED_BREAKOUT"].includes(z.behavior);
  const h1Confirmed = z.touchedAt !== null && m.frames.H1.lastClosedOpenTime !== null && Date.parse(m.frames.H1.lastClosedOpenTime) >= Date.parse(z.touchedAt) && m.frames.H1.control === ownControl;
  const qualified = z.touchedAt !== null && directional && (style === "AGGRESSIVE" ? (buy ? z.structuralType === "SUPPORT" : z.structuralType === "RESISTANCE") || reaction
    : style === "BALANCED" ? reaction : reaction && h1Confirmed);
  const eligibility = z.status === "EXPIRED" ? "INVALIDATED" : blockers.length ? "BLOCKED" : qualified ? "ELIGIBLE" : "WATCHING";
  if (!qualified) support.push(style === "CONSERVATIVE" ? "Waiting for post-touch completed H1 structural confirmation." : style === "BALANCED" ? "Waiting for a covered, directional zone reaction." : "Waiting for a qualified structural touch.");
  return { id: stableId([z.id, side]), zoneId: z.id, instrument: m.instrument, side, style, asOf: new Date(now).toISOString(), preference: input.preference,
    eligibility, provisional: true, entry, stop, firstTarget, secondTarget, stopPips: distance !== null ? distance / m.pipSize : null,
    rewardPips: reward !== null ? reward / m.pipSize : null, rewardRisk: rr, spreadImpactR: spread !== null && distance !== null && distance > 0 ? spread / distance : null,
    financingImpact: null, riskPercent: risk.riskLimit, riskAmount: units !== null && distance !== null && risk.conversion !== null ? Math.abs(units * distance * risk.conversion) : null,
    units, accountCurrency: risk.currency, support, contradictions, blockers: [...new Set(blockers)],
    expectancy: input.expectancy ?? { status: "UNAVAILABLE", strategyVersion: SWING_STRATEGY_VERSION, sampleSize: null, expectancyR: null, winRate: null, validatedAt: null, source: null } };
}
