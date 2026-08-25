/**
 * Eight-family movement/delayed-direction walk-forward replay.
 *
 * RESEARCH ONLY: reads historical OANDA candles/quotes and writes local report
 * artifacts. It never writes the database and never imports the paper cycle.
 * The existing sealed interval begins at 2025-08-01 and is excluded in SQL.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(serviceRoot, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.NODE_ENV = "production";

const { query } = await import("../src/database.js");
const { dayTradingSession } = await import("../../frontend/src/lib/strategy/strategy-engine.js");
const { pipSizeFor } = await import("../../frontend/src/lib/instruments/catalog.js");
const {
  EIGHT_DIRECTIONAL_FAMILIES,
  STRICT_DIRECTIONAL_CONFIDENCE_CONFIG,
  confirmDirectionAfterSetup,
  createDirectionalEvidenceStore,
  decideDirectionalAction,
  detectEightFamilySetups,
  estimateMovementOpportunity,
  oppositeDirection,
  recordDirectionalEvidence,
  simulateResearchTrade,
} = await import("../src/directional-research.js");
import type { Candle } from "../../frontend/src/types/forex.js";
import type {
  DirectionConfirmation,
  DirectionalFamily,
  MovementEstimate,
  ResearchQuote,
  ResearchSetupCandidate,
  SimulatedTrade,
  TradeDirection,
} from "../src/directional-research.js";

const PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"] as const;
const WARMUP_START = "2021-01-01T00:00:00.000Z";
const REPLAY_START = Date.parse("2022-08-01T00:00:00.000Z");
const DEVELOPMENT_START = "2024-08-01T00:00:00.000Z";
const SEALED_START = "2025-08-01T00:00:00.000Z";
const SEALED_START_MS = Date.parse(SEALED_START);
const WINDOW = 260;
const CONFIDENCE_MODE = process.argv.includes("--confidence-v2");
const EXPERIMENT_NAME = CONFIDENCE_MODE ? "eight-family-direction-confidence-v2" : "eight-family-directional-v1";
const OUTPUT_DIR = path.join(serviceRoot, "research-v2", EXPERIMENT_NAME);

type Pair = (typeof PAIRS)[number];
type Control = SimulatedTrade["control"];
type Series = { candles: Candle[]; quotes: ResearchQuote[]; h1: Candle[]; h4: Candle[] };
type Event = {
  family: DirectionalFamily;
  pair: Pair;
  index: number;
  session: string;
  candidate: ResearchSetupCandidate;
  movement: MovementEstimate;
  confirmation: DirectionConfirmation;
};
type PendingEvidence = {
  resolvedAtMs: number;
  context: { family: string; instrument: string; session: string; regime: string; confirmationType: string; direction: string };
  followR: number;
  reverseR: number;
};
type DecisionLog = {
  ordinal: number;
  time: string;
  family: string;
  action: string;
  preferredAction: "follow" | "reverse" | null;
  evidence: number;
  traded: boolean;
  followExpectancy: number | null;
  reverseExpectancy: number | null;
  confidenceScore: number;
  directionAccuracy: number | null;
  directionAccuracyLower: number | null;
  evidenceQuality: string;
  preferredCorrect: boolean | null;
  preferredResultR: number | null;
};

function asCandle(row: Record<string, unknown>): Candle {
  return { time: new Date(row.close_time as string).toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume ?? 0), complete: true };
}

async function loadSeries(pair: Pair): Promise<Series> {
  const [m15, h1, h4] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT c.close_time, c.open::float, c.high::float, c.low::float, c.close::float, c.volume,
              q.bid_open::float, q.bid_high::float, q.bid_low::float, q.bid_close::float,
              q.ask_open::float, q.ask_high::float, q.ask_low::float, q.ask_close::float
         FROM market_candles c
         JOIN market_candle_quotes q USING (instrument, timeframe, close_time, source)
        WHERE c.instrument=$1 AND c.timeframe='M15' AND c.source='oanda'
          AND c.close_time >= $2 AND c.close_time < $3
        ORDER BY c.close_time`, [pair, WARMUP_START, SEALED_START]),
    query<Record<string, unknown>>(
      `SELECT close_time, open::float, high::float, low::float, close::float, volume
         FROM market_candles WHERE instrument=$1 AND timeframe='H1' AND source='oanda'
          AND close_time >= $2 AND close_time < $3 ORDER BY close_time`, [pair, WARMUP_START, SEALED_START]),
    query<Record<string, unknown>>(
      `SELECT close_time, open::float, high::float, low::float, close::float, volume
         FROM market_candles WHERE instrument=$1 AND timeframe='H4' AND source='oanda'
          AND close_time >= $2 AND close_time < $3 ORDER BY close_time`, [pair, WARMUP_START, SEALED_START]),
  ]);
  return {
    candles: m15.rows.map(asCandle),
    quotes: m15.rows.map((row) => ({
      closeTime: new Date(row.close_time as string).toISOString(),
      bidOpen: Number(row.bid_open), bidHigh: Number(row.bid_high), bidLow: Number(row.bid_low), bidClose: Number(row.bid_close),
      askOpen: Number(row.ask_open), askHigh: Number(row.ask_high), askLow: Number(row.ask_low), askClose: Number(row.ask_close),
    })),
    h1: h1.rows.map(asCandle),
    h4: h4.rows.map(asCandle),
  };
}

function lastClosedIndex(candles: Candle[], timeMs: number, from: number): number {
  let index = Math.max(0, from);
  while (index + 1 < candles.length && Date.parse(candles[index + 1]!.time) <= timeMs) index += 1;
  return index;
}

function validContinuity(candles: Candle[], index: number): boolean {
  for (let i = index - 49; i <= index; i += 1) {
    const gap = Date.parse(candles[i]!.time) - Date.parse(candles[i - 1]!.time);
    if (gap > 15.5 * 60_000) return false;
  }
  return true;
}

function deterministicDirection(key: string): TradeDirection {
  let hash = 2166136261;
  for (const char of `20260824|${key}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % 2 === 0 ? "long" : "short";
}

function planAtSetup(candidate: ResearchSetupCandidate, quote: ResearchQuote, direction: TradeDirection) {
  const entry = direction === "long" ? quote.askClose : quote.bidClose;
  const risk = candidate.originalPlan ? Math.abs(candidate.originalPlan.entry - candidate.originalPlan.stop) : candidate.atr;
  const targetR = candidate.originalPlan ? Math.abs(candidate.originalPlan.target - candidate.originalPlan.entry) / risk : 1.5;
  return { entry, stop: direction === "long" ? entry - risk : entry + risk, target: direction === "long" ? entry + risk * targetR : entry - risk * targetR };
}

function delayedTrade(event: Event, series: Series, control: Control, direction: TradeDirection, extras: Partial<Parameters<typeof simulateResearchTrade>[0]> = {}) {
  if (event.confirmation.entryIndex == null) return null;
  return simulateResearchTrade({ family: event.family, control, candidate: event.candidate, quotes: series.quotes, direction, entryIndex: event.confirmation.entryIndex, targetR: 1.5, maxBars: 24, confirmation: event.confirmation, movementQualified: event.movement.qualified, session: event.session, ...extras });
}

console.log(`Loading pre-holdout data (< ${SEALED_START})...`);
const seriesByPair = {} as Record<Pair, Series>;
for (const pair of PAIRS) {
  seriesByPair[pair] = await loadSeries(pair);
  console.log(`${pair}: ${seriesByPair[pair].candles.length.toLocaleString()} aligned M15 bars`);
}

const events: Event[] = [];
const evaluationCounts = Object.fromEntries(EIGHT_DIRECTIONAL_FAMILIES.map((family) => [family, 0])) as Record<DirectionalFamily, number>;
const setupCounts = Object.fromEntries(EIGHT_DIRECTIONAL_FAMILIES.map((family) => [family, 0])) as Record<DirectionalFamily, number>;

for (const pair of PAIRS) {
  const series = seriesByPair[pair];
  const pip = pipSizeFor(pair);
  let h1Index = 0;
  let h4Index = 0;
  for (let index = WINDOW; index < series.candles.length - 30; index += 1) {
    const timeMs = Date.parse(series.candles[index]!.time);
    if (timeMs < REPLAY_START || timeMs >= SEALED_START_MS || !validContinuity(series.candles, index)) continue;
    const session = dayTradingSession(new Date(timeMs));
    if (!session.open) continue;
    h1Index = lastClosedIndex(series.h1, timeMs, h1Index);
    h4Index = lastClosedIndex(series.h4, timeMs, h4Index);
    if (h1Index < 60 || h4Index < 60) continue;
    const quote = series.quotes[index]!;
    const spreadPips = (quote.askClose - quote.bidClose) / pip;
    if (!(spreadPips > 0)) continue;
    const windowStart = index - WINDOW + 1;
    const decisionWindow = series.candles.slice(windowStart, index + 1);
    const detected = detectEightFamilySetups({
      instrument: pair, accountBalance: 100_000, accountCurrency: "USD", dataSource: "oanda",
      candles15m: decisionWindow,
      candles1h: series.h1.slice(Math.max(0, h1Index - WINDOW + 1), h1Index + 1),
      candles4h: series.h4.slice(Math.max(0, h4Index - WINDOW + 1), h4Index + 1),
      bid: quote.bidClose, ask: quote.askClose, spreadPips, marketOpen: true, calendarConnected: false,
      highImpactNewsWithinMinutes: null, evaluatedAt: series.candles[index]!.time, newsRequired: false, evaluationMode: "historical_replay",
    }, index);
    for (const candidate of detected.candidates) {
      evaluationCounts[candidate.family] += 1;
      if (!candidate.setupQualified || !candidate.originalDirection || !candidate.originalPlan) continue;
      setupCounts[candidate.family] += 1;
      const localSetupIndex = decisionWindow.length - 1;
      const movement = estimateMovementOpportunity(decisionWindow, localSetupIndex, candidate.atr, spreadPips, pip);
      const localConfirmation = confirmDirectionAfterSetup(series.candles.slice(windowStart, index + 31), localSetupIndex, candidate.atr);
      const confirmation: DirectionConfirmation = {
        ...localConfirmation,
        knownAtIndex: localConfirmation.knownAtIndex == null ? null : localConfirmation.knownAtIndex + windowStart,
        entryIndex: localConfirmation.entryIndex == null ? null : localConfirmation.entryIndex + windowStart,
      };
      events.push({ family: candidate.family, pair, index, session: session.label, candidate, movement, confirmation });
    }
  }
}

events.sort((a, b) => {
  const ai = a.confirmation.knownAtIndex ?? a.index;
  const bi = b.confirmation.knownAtIndex ?? b.index;
  return Date.parse(seriesByPair[a.pair].candles[ai]!.time) - Date.parse(seriesByPair[b.pair].candles[bi]!.time);
});
console.log(`Built ${events.length.toLocaleString()} setup events; replaying controls...`);

const trades: SimulatedTrade[] = [];
const decisions: DecisionLog[] = [];
const adaptiveByOrdinal: Array<{ ordinal: number; trade: SimulatedTrade }> = [];
const evidence = createDirectionalEvidenceStore();
let pending: PendingEvidence[] = [];
let ordinal = 0;

for (const event of events) {
  const series = seriesByPair[event.pair];
  const quote = series.quotes[event.index]!;
  const original = event.candidate.originalDirection!;
  const originalPlan = planAtSetup(event.candidate, quote, original);
  const invertedDirection = oppositeDirection(original);
  const invertedPlan = planAtSetup(event.candidate, quote, invertedDirection);
  const spreadPrice = quote.askClose - quote.bidClose;
  const originalTrade = simulateResearchTrade({ family: event.family, control: "original", candidate: event.candidate, quotes: series.quotes, direction: original, entryIndex: event.index + 1, ...originalPlan, spreadPrice, entryTime: event.candidate.setupTime, movementQualified: event.movement.qualified, session: event.session });
  const invertedTrade = simulateResearchTrade({ family: event.family, control: "inverted", candidate: event.candidate, quotes: series.quotes, direction: invertedDirection, entryIndex: event.index + 1, ...invertedPlan, spreadPrice, entryTime: event.candidate.setupTime, movementQualified: event.movement.qualified, session: event.session });
  if (originalTrade) trades.push(originalTrade);
  if (invertedTrade) trades.push(invertedTrade);

  const confirmedDirection = event.confirmation.direction;
  if (confirmedDirection === "uncertain" || event.confirmation.knownAtIndex == null || event.confirmation.entryIndex == null) continue;
  const noMovement = delayedTrade(event, series, "confirmed_without_movement", confirmedDirection);
  if (noMovement) trades.push(noMovement);
  if (!event.movement.qualified) continue;

  const follow = delayedTrade(event, series, "confirmed", confirmedDirection);
  const reverse = delayedTrade(event, series, "confirmed", oppositeDirection(confirmedDirection));
  const random = delayedTrade(event, series, "random", deterministicDirection(`${event.family}|${event.pair}|${event.candidate.setupTime}`));
  if (follow) trades.push(follow);
  if (random) trades.push(random);
  if (!follow || !reverse) continue;

  const decisionTime = Date.parse(series.candles[event.confirmation.knownAtIndex]!.time);
  for (const item of pending.filter((candidate) => candidate.resolvedAtMs < decisionTime)) {
    recordDirectionalEvidence(evidence, item.context, item.followR, item.reverseR);
  }
  pending = pending.filter((candidate) => candidate.resolvedAtMs >= decisionTime);
  const context = { family: event.family, instrument: event.pair, session: event.session, regime: event.candidate.regime.regime, confirmationType: event.confirmation.confirmationType, direction: confirmedDirection };
  const decision = decideDirectionalAction(evidence, context, CONFIDENCE_MODE ? STRICT_DIRECTIONAL_CONFIDENCE_CONFIG : undefined);
  ordinal += 1;
  let adaptiveTrade: SimulatedTrade | null = null;
  if (decision.action === "follow") adaptiveTrade = delayedTrade(event, series, "adaptive", confirmedDirection, { adaptiveAction: "follow", adaptiveEvidence: decision.evidence });
  if (decision.action === "reverse") adaptiveTrade = delayedTrade(event, series, "adaptive", oppositeDirection(confirmedDirection), { adaptiveAction: "reverse", adaptiveEvidence: decision.evidence });
  if (adaptiveTrade) { trades.push(adaptiveTrade); adaptiveByOrdinal.push({ ordinal, trade: adaptiveTrade }); }
  const bestResolvedArm = follow.resultR === reverse.resultR ? null : follow.resultR > reverse.resultR ? "follow" : "reverse";
  const preferredResultR = decision.preferredAction === "follow" ? follow.resultR : decision.preferredAction === "reverse" ? reverse.resultR : null;
  decisions.push({
    ordinal,
    time: series.candles[event.confirmation.knownAtIndex]!.time,
    family: event.family,
    action: decision.action,
    preferredAction: decision.preferredAction,
    evidence: decision.evidence,
    traded: Boolean(adaptiveTrade),
    followExpectancy: decision.followExpectancy,
    reverseExpectancy: decision.reverseExpectancy,
    confidenceScore: decision.confidenceScore,
    directionAccuracy: decision.directionAccuracy,
    directionAccuracyLower: decision.directionAccuracyLower,
    evidenceQuality: decision.evidenceQuality,
    preferredCorrect: decision.preferredAction === null || bestResolvedArm === null ? null : decision.preferredAction === bestResolvedArm,
    preferredResultR,
  });
  pending.push({ resolvedAtMs: Math.max(Date.parse(follow.resolvedAt), Date.parse(reverse.resolvedAt)), context, followR: follow.resultR, reverseR: reverse.resultR });
}

type Metric = { trades: number; wins: number; losses: number; winRate: number | null; averageWinR: number | null; averageLossR: number | null; grossExpectancyR: number | null; netExpectancyR: number | null; totalR: number; maxDrawdownR: number; profitFactor: number | null; averageSpreadCostR: number | null; averageConfirmationDelayBars: number | null };
function metric(rows: SimulatedTrade[]): Metric {
  const wins = rows.filter((row) => row.resultR > 0);
  const losses = rows.filter((row) => row.resultR < 0);
  let equity = 0; let peak = 0; let maxDrawdownR = 0;
  for (const row of [...rows].sort((a, b) => Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt))) { equity += row.resultR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  const grossProfit = wins.reduce((sum, row) => sum + row.resultR, 0);
  const grossLoss = -losses.reduce((sum, row) => sum + row.resultR, 0);
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return { trades: rows.length, wins: wins.length, losses: losses.length, winRate: rows.length ? wins.length / rows.length : null, averageWinR: avg(wins.map((row) => row.resultR)), averageLossR: avg(losses.map((row) => row.resultR)), grossExpectancyR: avg(rows.map((row) => row.grossR)), netExpectancyR: avg(rows.map((row) => row.resultR)), totalR: rows.reduce((sum, row) => sum + row.resultR, 0), maxDrawdownR, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, averageSpreadCostR: avg(rows.map((row) => row.spreadCostR)), averageConfirmationDelayBars: avg(rows.map((row) => row.confirmationDelayBars)) };
}

function grouped(keys: Array<{ name: string; value: (row: SimulatedTrade) => string }>) {
  const buckets = new Map<string, SimulatedTrade[]>();
  for (const row of trades) { const key = keys.map((part) => `${part.name}=${part.value(row)}`).join("|"); const bucket = buckets.get(key) ?? []; bucket.push(row); buckets.set(key, bucket); }
  return Object.fromEntries([...buckets].map(([key, rows]) => [key, metric(rows)]));
}

const familyControl = grouped([{ name: "family", value: (r) => r.family }, { name: "control", value: (r) => r.control }]);
const opportunityFunnel = Object.fromEntries(EIGHT_DIRECTIONAL_FAMILIES.map((family) => {
  const familyEvents = events.filter((event) => event.family === family);
  const familyDecisions = decisions.filter((decision) => decision.family === family);
  return [family, {
    evaluated: evaluationCounts[family], setups: setupCounts[family],
    movementQualified: familyEvents.filter((event) => event.movement.qualified).length,
    directionConfirmed: familyEvents.filter((event) => event.confirmation.direction !== "uncertain").length,
    movementAndDirectionConfirmed: familyEvents.filter((event) => event.movement.qualified && event.confirmation.direction !== "uncertain").length,
    adaptiveAccepted: familyDecisions.filter((decision) => decision.traded).length,
    adaptiveSkipped: familyDecisions.filter((decision) => decision.action === "skip").length,
  }];
}));
const adaptiveBuckets = [0, 500, 1000, 2500, 5000, 10000, Number.POSITIVE_INFINITY].slice(0, -1).map((start, index) => {
  const end = [0, 500, 1000, 2500, 5000, 10000, Number.POSITIVE_INFINITY][index + 1]!;
  const ds = decisions.filter((decision) => decision.ordinal > start && decision.ordinal <= end);
  const ts = adaptiveByOrdinal.filter((item) => item.ordinal > start && item.ordinal <= end).map((item) => item.trade);
  const avgEvidence = ds.length ? ds.reduce((sum, decision) => sum + decision.evidence, 0) / ds.length : null;
  const scored = ds.filter((decision) => decision.preferredCorrect !== null);
  return { range: `${start + 1}-${Number.isFinite(end) ? end : "plus"}`, decisions: ds.length, follow: ds.filter((d) => d.action === "follow").length, reverse: ds.filter((d) => d.action === "reverse").length, skipped: ds.filter((d) => d.action === "skip").length, skippedPct: ds.length ? ds.filter((d) => d.action === "skip").length / ds.length : null, averageEvidence: avgEvidence, averageConfidence: ds.length ? ds.reduce((sum, decision) => sum + decision.confidenceScore, 0) / ds.length : null, preferredDirectionAccuracy: scored.length ? scored.filter((decision) => decision.preferredCorrect).length / scored.length : null, performance: metric(ts) };
});

const confidenceEdges = [0, 50, 60, 70, 80, 90, 101];
const confidenceCalibration = confidenceEdges.slice(0, -1).map((low, index) => {
  const high = confidenceEdges[index + 1]!;
  const rows = decisions.filter((decision) => decision.preferredAction !== null && decision.confidenceScore >= low && decision.confidenceScore < high);
  const correctness = rows.filter((decision) => decision.preferredCorrect !== null);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    confidenceRange: `${low}-${high === 101 ? 100 : high}`,
    decisions: rows.length,
    executed: rows.filter((decision) => decision.traded).length,
    skipped: rows.filter((decision) => !decision.traded).length,
    averageConfidenceScore: average(rows.map((decision) => decision.confidenceScore)),
    realizedPairedDirectionAccuracy: correctness.length ? correctness.filter((decision) => decision.preferredCorrect).length / correctness.length : null,
    averagePreferredNetR: average(rows.map((decision) => decision.preferredResultR).filter((value): value is number => value !== null)),
    supported: rows.filter((decision) => decision.evidenceQuality === "supported").length,
  };
});
const calibratedDecisions = decisions.filter((decision) => decision.preferredCorrect !== null && decision.directionAccuracy !== null);
const brierScore = calibratedDecisions.length ? calibratedDecisions.reduce((sum, decision) => sum + ((decision.directionAccuracy ?? 0) - (decision.preferredCorrect ? 1 : 0)) ** 2, 0) / calibratedDecisions.length : null;

const confirmed = metric(trades.filter((trade) => trade.control === "confirmed"));
const adaptive = metric(trades.filter((trade) => trade.control === "adaptive"));
const original = metric(trades.filter((trade) => trade.control === "original"));
let verdict = "NO_DIRECTIONAL_EDGE_FOUND";
if ((adaptive.netExpectancyR ?? -Infinity) > 0 && adaptive.trades >= 100) verdict = "ADAPTIVE_DIRECTIONAL_EDGE_FOUND";
else if ((confirmed.netExpectancyR ?? -Infinity) > 0 && confirmed.trades >= 100) verdict = "DELAYED_CONFIRMATION_ADDS_VALUE";
else if ((adaptive.netExpectancyR ?? -Infinity) <= (confirmed.netExpectancyR ?? -Infinity)) verdict = "ADAPTIVE_ADDS_NO_VALUE";
else if ((confirmed.winRate ?? 0) > (original.winRate ?? 0) && (confirmed.netExpectancyR ?? -1) <= 0) verdict = "DIRECTION_IMPROVED_BUT_NOT_PROFITABLE";

const results = {
  experiment: EXPERIMENT_NAME, mode: CONFIDENCE_MODE ? "strict_confidence_gate" : "directional_v1", generatedAt: new Date().toISOString(), verdict,
  safety: { researchOnly: true, databaseWrites: 0, liveAllowlistChanged: false, paperCycleChanged: false, sealedStart: SEALED_START, sealedTouched: false, maxQueriedTimeExclusive: SEALED_START },
  data: { pairs: PAIRS, warmupStart: WARMUP_START, replayStart: new Date(REPLAY_START).toISOString(), developmentStart: DEVELOPMENT_START, preHoldoutEndExclusive: SEALED_START, storedTimeframes: ["M15", "H1", "H4"], scalpingConstraint: "M1/M5 are not stored; Scalping Continuation is an explicitly labeled M15 proxy." },
  definitions: { setup: "Family detector qualifies using completed candles through setup time.", movement: "Past-only deterministic movement-heuristic-v1 qualifies expected movement net of spread.", confirmation: "Post-setup close outside the frozen local range plus one completed hold bar; entry is the following bar open.", adaptive: CONFIDENCE_MODE ? "Strict past-only gate: WAIT during cold start; FOLLOW/REVERSE requires positive 90% lower-bound net expectancy and paired directional-accuracy lower bound above 50%. Confidence is the evidence-adjusted paired-arm accuracy estimate on a 0-100 scale." : "Past-only hierarchical context evidence; FOLLOW during cold start, REVERSE only after >=100 observations and a positive 90% lower-bound net expectancy; otherwise WAIT." },
  evaluationCounts, setupCounts, opportunityFunnel, totalSetupEvents: events.length,
  controlDefinitions: { original: "Existing detector direction at setup close.", inverted: "Genuine opposite-side replay at setup close; not sign-flipped P&L.", confirmed_without_movement: "Delayed confirmation without movement filtering.", confirmed: "Movement-qualified delayed confirmation.", adaptive: "Movement-qualified delayed confirmation with past-only FOLLOW/REVERSE/WAIT.", random: "Seeded random direction on the same movement-qualified confirmed opportunities." },
  overallByControl: Object.fromEntries(["original", "inverted", "confirmed_without_movement", "confirmed", "adaptive", "random"].map((control) => [control, metric(trades.filter((trade) => trade.control === control))])),
  familyControl,
  byPair: grouped([{ name: "pair", value: (r) => r.instrument }, { name: "control", value: (r) => r.control }]),
  bySession: grouped([{ name: "session", value: (r) => r.session }, { name: "control", value: (r) => r.control }]),
  byMonth: grouped([{ name: "month", value: (r) => r.entryTime.slice(0, 7) }, { name: "control", value: (r) => r.control }]),
  byYear: grouped([{ name: "year", value: (r) => r.entryTime.slice(0, 4) }, { name: "control", value: (r) => r.control }]),
  byDataSplit: grouped([{ name: "split", value: (r) => Date.parse(r.entryTime) < Date.parse(DEVELOPMENT_START) ? "development" : "pre_holdout_validation" }, { name: "control", value: (r) => r.control }]),
  byVolatility: grouped([{ name: "volatility", value: (r) => r.volatility }, { name: "control", value: (r) => r.control }]),
  byConfirmationType: grouped([{ name: "confirmation", value: (r) => r.confirmationType }, { name: "control", value: (r) => r.control }]),
  directionDistribution: Object.fromEntries(["original", "inverted", "confirmed_without_movement", "confirmed", "adaptive", "random"].map((control) => [control, { long: trades.filter((trade) => trade.control === control && trade.direction === "long").length, short: trades.filter((trade) => trade.control === control && trade.direction === "short").length }])),
  adaptiveLearningCurve: adaptiveBuckets,
  confidenceCalibration,
  confidenceBrierScore: brierScore,
  adaptiveDecisionCounts: { total: decisions.length, follow: decisions.filter((d) => d.action === "follow").length, reverse: decisions.filter((d) => d.action === "reverse").length, skip: decisions.filter((d) => d.action === "skip").length },
  costLimitations: { spread: "Exact bid/ask OHLC replay; resultR is net of spread and grossR adds spreadCostR back.", commission: "Not available in stored candle data; excluded.", slippage: "Not available in stored candle data; excluded. Results are optimistic to that extent.", ambiguousBars: "Trades whose stop and target are both touched in one M15 candle are excluded rather than assigned an arbitrary favorable order." },
};

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, "RESULTS.json"), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(OUTPUT_DIR, "CONFIG_SNAPSHOT.json"), JSON.stringify({ pairs: PAIRS, warmupStart: WARMUP_START, replayStart: new Date(REPLAY_START).toISOString(), developmentStart: DEVELOPMENT_START, sealedStart: SEALED_START, movementVersion: "movement-heuristic-v1", confirmationVersion: "range-close-hold-v1", randomSeed: 20260824, targetR: 1.5, maxBars: 24, adaptive: CONFIDENCE_MODE ? STRICT_DIRECTIONAL_CONFIDENCE_CONFIG : { minLearningSample: 50, minReverseSample: 100, confidenceZ: 1.64, positiveLowerBoundRequired: true } }, null, 2));
const pct = (value: number | null) => value == null ? "n/a" : `${(value * 100).toFixed(2)}%`;
const num = (value: number | null) => value == null ? "n/a" : value.toFixed(4);
const lines = [
  CONFIDENCE_MODE ? "EIGHT-FAMILY STRICT DIRECTION-CONFIDENCE TEST" : "EIGHT-FAMILY MOVEMENT + DELAYED-DIRECTION RESEARCH", "", `VERDICT: ${verdict}`, "",
  `Range: ${new Date(REPLAY_START).toISOString()} through ${SEALED_START} (exclusive)`,
  `Sealed interval touched: NO`, `Database writes: 0`, `Setup events: ${events.length.toLocaleString()}`, "",
  "CONTROL RESULTS (net of exact historical spread)",
  ...Object.entries(results.overallByControl).map(([control, m]) => `${control.padEnd(28)} n=${String(m.trades).padStart(6)} WR=${pct(m.winRate).padStart(8)} netE=${num(m.netExpectancyR).padStart(8)} grossE=${num(m.grossExpectancyR).padStart(8)} totalR=${m.totalR.toFixed(2).padStart(9)} maxDD=${m.maxDrawdownR.toFixed(2).padStart(9)} PF=${num(m.profitFactor).padStart(8)} spreadR=${num(m.averageSpreadCostR).padStart(8)} delay=${num(m.averageConfirmationDelayBars).padStart(7)}`),
  "", "BY FAMILY AND CONTROL",
  ...Object.entries(familyControl).sort().map(([key, m]) => `${key.padEnd(58)} n=${String(m.trades).padStart(5)} WR=${pct(m.winRate).padStart(8)} netE=${num(m.netExpectancyR).padStart(8)} totalR=${m.totalR.toFixed(2).padStart(9)} DD=${m.maxDrawdownR.toFixed(2).padStart(9)} PF=${num(m.profitFactor).padStart(8)}`),
  "", "OPPORTUNITY FUNNEL", ...Object.entries(opportunityFunnel).map(([family, funnel]) => `${family.padEnd(30)} evaluated=${String(funnel.evaluated).padStart(6)} setup=${String(funnel.setups).padStart(6)} movement=${String(funnel.movementQualified).padStart(6)} confirmed=${String(funnel.directionConfirmed).padStart(6)} both=${String(funnel.movementAndDirectionConfirmed).padStart(6)} adaptive=${String(funnel.adaptiveAccepted).padStart(5)} skipped=${String(funnel.adaptiveSkipped).padStart(5)}`),
  "", "ADAPTIVE DECISIONS", JSON.stringify(results.adaptiveDecisionCounts), "", "ADAPTIVE LEARNING CURVE",
  ...adaptiveBuckets.map((bucket) => `${bucket.range.padEnd(12)} decisions=${String(bucket.decisions).padStart(5)} follow=${String(bucket.follow).padStart(5)} reverse=${String(bucket.reverse).padStart(5)} skip=${String(bucket.skipped).padStart(5)} skipPct=${pct(bucket.skippedPct).padStart(8)} avgEvidence=${num(bucket.averageEvidence).padStart(8)} avgConfidence=${num(bucket.averageConfidence).padStart(8)} preferredAccuracy=${pct(bucket.preferredDirectionAccuracy).padStart(8)} trades=${String(bucket.performance.trades).padStart(5)} netE=${num(bucket.performance.netExpectancyR).padStart(8)} totalR=${bucket.performance.totalR.toFixed(2).padStart(9)}`),
  "", "CONFIDENCE CALIBRATION", `Brier score: ${num(brierScore)}`,
  ...confidenceCalibration.map((bucket) => `${bucket.confidenceRange.padEnd(9)} decisions=${String(bucket.decisions).padStart(5)} executed=${String(bucket.executed).padStart(5)} skipped=${String(bucket.skipped).padStart(5)} avgScore=${num(bucket.averageConfidenceScore).padStart(8)} realizedAccuracy=${pct(bucket.realizedPairedDirectionAccuracy).padStart(8)} preferredNetE=${num(bucket.averagePreferredNetR).padStart(8)} supported=${String(bucket.supported).padStart(5)}`),
  "", "CAVEATS", "- Stored data has M15/H1/H4 but no M1/M5; scalping_continuation is an M15 proxy, not a real scalping validation.", "- Commission and slippage are unavailable and excluded; spread is exact bid/ask and included.", "- This is development/pre-holdout evidence. No sealed result is claimed.", "- Full pair/session/month/volatility/confirmation tables are in RESULTS.json.", "",
];
fs.writeFileSync(path.join(OUTPUT_DIR, "FINAL_REPORT.txt"), lines.join("\n"));
console.log(lines.slice(0, 20).join("\n"));
console.log(`\nWrote ${OUTPUT_DIR}`);
