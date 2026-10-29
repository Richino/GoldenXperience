import { currenciesOf, pipSizeFor, precisionFor } from "../../../frontend/src/lib/instruments/catalog.js";
import { NEWS_V3_DEFAULTS, type NewsRun, type NewsV3Settings, type NewsRelease, type NewsSide } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import { newsEventsAtTime, sameNewsMembers } from "../../../frontend/src/lib/news/news-release-groups.js";

export const SUBMIT_LEAD_MS = 10_000;
export const PREPARE_LEAD_MS = 30_000;
export const MAX_QUOTE_AGE_MS = 1_000;
export const MAX_CALENDAR_AGE_MS = 15 * 60_000;
export type NewsQuote = { bid: number; ask: number; time: string; tradeable: boolean };
export function parseV3Settings(raw: Record<string, unknown>): NewsV3Settings {
  const s = { ...NEWS_V3_DEFAULTS };
  const ranges: Record<string, [number, number]> = {
    distancePips: [0.1, 200], stopPips: [0.1, 500], atrMultiplier: [0.25, 10], minimumStopPips: [0.1, 100], maximumStopPips: [1, 500],
    riskPerTradePercent: [0.01, 5], maxEventRiskPercent: [0.01, 5], maxSpreadPips: [0.1, 50], maxSlippagePips: [0.1, 50],
    trailingActivationPips: [0.1, 500], trailingDistancePips: [0.1, 500], windowSeconds: [5, 900], maxHoldMinutes: [0, 240],
    emergencyLossR: [1, 5], emergencySpreadPips: [0, 100], disconnectExitSeconds: [5, 300],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (raw[key] === undefined) continue;
    const value = Number(raw[key]);
    if (raw[key] === "" || raw[key] === null || typeof raw[key] === "boolean" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}.`);
    (s as unknown as Record<string, unknown>)[key] = value;
  }
  if (raw.stopMode !== undefined && raw.stopMode !== "ATR" && raw.stopMode !== "FIXED") throw new Error("Choose ATR or FIXED stop mode.");
  s.stopMode = raw.stopMode === "FIXED" ? "FIXED" : "ATR";
  if (s.minimumStopPips > s.maximumStopPips) throw new Error("Minimum stop exceeds maximum stop.");
  if (s.trailingActivationPips <= s.trailingDistancePips) throw new Error("Trailing activation must exceed trailing distance to lock a profit.");
  if (raw.failSafe !== undefined && raw.failSafe !== s.failSafe) throw new Error("Only cancel-and-flatten fail-safe is supported.");
  if (raw.emergencyPolicy !== undefined && raw.emergencyPolicy !== s.emergencyPolicy) throw new Error("Only flatten-this-setup emergency policy is supported.");
  if (raw.targetPips !== undefined || raw.takeProfit !== undefined) throw new Error("Fixed take-profit is disabled for News Straddle v3.");
  return s;
}
export function eventKey(e: Pick<NewsRelease, "title" | "currency" | "time">) {
  // Provider IDs contain the timestamp; use currency/title/calendar date so a time change cannot buy another attempt.
  return `${e.currency}|${e.title.trim().toLowerCase().replace(/\s+/g, " ")}|${e.time.slice(0, 10)}`;
}
export function verifyRelease(instrument: string, requested: { id?: unknown; title?: unknown; currency?: unknown; time?: unknown; events?: unknown }, calendar: { events: Array<{ id: string; title: string; currency: string; timestamp: string; impact: number; timingVerified?: boolean }>; fetchedAt: string }, now: number): NewsRelease {
  if (!Number.isFinite(Date.parse(calendar.fetchedAt)) || now - Date.parse(calendar.fetchedAt) > MAX_CALENDAR_AGE_MS || Date.parse(calendar.fetchedAt) > now + 250) throw new Error("The verified calendar is stale.");
  const c = currenciesOf(instrument);
  const e = calendar.events.find(e => e.id === requested.id && e.title === requested.title && e.currency === requested.currency && e.timestamp === requested.time);
  if (!e || e.timingVerified !== true || ![c.base, c.quote].includes(e.currency) || e.impact < 3 || /tentative|all.day|summit|speaks|speech|meeting day/i.test(e.title)) throw new Error("Select a precisely timed high-impact economic release for this pair.");
  const at = Date.parse(e.timestamp);
  if (!Number.isFinite(at) || !/T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(e.timestamp) || at <= now + 15_000) throw new Error("The release must be more than 15 seconds ahead, with a verified UTC timestamp.");
  const events = newsEventsAtTime(instrument, calendar.events, e.timestamp);
  if (requested.events !== undefined && (!Array.isArray(requested.events) || requested.events.some(m => !m || typeof m.id !== "string" || typeof m.title !== "string" || typeof m.currency !== "string") || !sameNewsMembers(requested.events, events))) throw new Error("The news releases at this time changed. Refresh the setup before accepting.");
  return { ...events[0]!, time: new Date(at).toISOString(), impact: e.impact, provider: "forex_factory", events };
}
function quoteAgeIssue(q: NewsQuote | null, now: number, maximumAgeMs: number) {
  if (!q || ![q.bid, q.ask].every(n => Number.isFinite(n) && n > 0) || q.ask < q.bid || !q.tradeable) return "A valid executable OANDA bid/ask is required.";
  const age = now - Date.parse(q.time);
  return !Number.isFinite(age) || age < -250 || age > maximumAgeMs ? "The OANDA quote is stale or future-dated." : null;
}
export const quoteIssue = (q: NewsQuote | null, now: number) => quoteAgeIssue(q, now, MAX_QUOTE_AGE_MS);
// Scheduling sends no orders. Preparation refreshes this observation and dispatch
// still requires quoteIssue's strict one-second executable-price limit.
export const schedulingQuoteIssue = (q: NewsQuote | null, now: number) => quoteAgeIssue(q, now, 10_000);
export function roundPrice(instrument: string, n: number) { return Number(n.toFixed(precisionFor(instrument))); }
export function entryPrices(instrument: string, q: NewsQuote, distancePips: number, slippagePips: number) {
  const p = pipSizeFor(instrument), r = (n: number) => roundPrice(instrument, n);
  const buy = r(q.ask + distancePips * p), sell = r(q.bid - distancePips * p);
  return { buy, sell, buyBound: r(buy + slippagePips * p), sellBound: r(sell - slippagePips * p) };
}
export function priceDistance(instrument: string, pips: number) {
  const n = pips * pipSizeFor(instrument), r = roundPrice(instrument, n);
  if (!(r > 0) || Math.abs(r - n) > 1e-10) throw new Error("The pip distance exceeds the broker price precision.");
  return r;
}
export function calculateNewsRisk(input: {
  instrument: string; settings: NewsV3Settings; equity: number; currency: string; conversion: number; atrPips: number | null;
  minimumTrail: number; maximumTrail: number; minimumUnits: number; maximumUnits: number; riskLimit: number; eventRiskLimit?: number; trailingEnabled?: boolean;
}) {
  const { settings: s } = input;
  if (![input.equity, input.conversion, input.minimumUnits, input.maximumUnits].every(n => Number.isFinite(n) && n > 0)) throw new Error("Verified account equity, currency conversion and broker size constraints are required.");
  const eventRiskLimit = input.eventRiskLimit ?? input.riskLimit * 2;
  if (!Number.isFinite(input.riskLimit) || !Number.isFinite(eventRiskLimit) || s.maxEventRiskPercent > eventRiskLimit || s.riskPerTradePercent > input.riskLimit) throw new Error("News risk exceeds the account risk limit.");
  const trail = priceDistance(input.instrument, s.trailingDistancePips);
  priceDistance(input.instrument, s.trailingActivationPips); priceDistance(input.instrument, s.distancePips); priceDistance(input.instrument, s.maxSlippagePips);
  if (input.trailingEnabled !== false && (!Number.isFinite(input.minimumTrail) || !Number.isFinite(input.maximumTrail) || trail < input.minimumTrail || trail > input.maximumTrail)) throw new Error("Trailing distance is outside OANDA's permitted range; it was not changed automatically.");
  const unitPips = 10 ** -precisionFor(input.instrument) / pipSizeFor(input.instrument);
  if (s.stopMode === "ATR" && (!(input.atrPips! > 0) || !Number.isFinite(input.atrPips))) throw new Error("Fresh completed OANDA M1 volatility is unavailable.");
  const stopPips = s.stopMode === "ATR" ? Math.ceil(Math.max(s.minimumStopPips, input.atrPips! * s.atrMultiplier) / unitPips) * unitPips : s.stopPips;
  if (stopPips < s.minimumStopPips || stopPips > s.maximumStopPips) throw new Error("Calculated stop is outside the approved stop range.");
  const distance = priceDistance(input.instrument, stopPips);
  const perLegPercent = Math.min(s.riskPerTradePercent, s.maxEventRiskPercent / 2);
  const perLegCash = input.equity * perLegPercent / 100;
  const units = Math.floor(perLegCash / (distance * input.conversion));
  if (units < input.minimumUnits || units > input.maximumUnits) throw new Error("Risk-based units exceed broker limits; change the approved settings.");
  return { units, risk: { equity: input.equity, currency: input.currency, conversion: input.conversion, eventCash: input.equity * s.maxEventRiskPercent / 100, perLegCash: units * distance * input.conversion, perLegPercent, stopPips: Number(stopPips.toFixed(4)), atrPips: input.atrPips } };
}
export function preSubmitIssue(run: NewsRun, q: NewsQuote | null, now: number, monitorReady: boolean) {
  const issue = quoteIssue(q, now); if (issue) return issue;
  if (!monitorReady) return "Broker transaction monitoring is not synchronized.";
  // REST round-trip timing is diagnostic, not a reliable subsecond clock gate.
  // Fresh executable quotes and the release deadline still bound submission.
  if (run.mode !== "oco" && (now - Date.parse(run.calendarFetchedAt) > MAX_CALENDAR_AGE_MS || now - Date.parse(run.calendarCheckedAt) > 15_000)) return "The release was not recently verified.";
  if ((q!.ask - q!.bid) / pipSizeFor(run.instrument) > run.settings.maxSpreadPips + 1e-8) return "Spread exceeds the approved maximum.";
  if (!run.legs.long.entry || !run.legs.short.entry || q!.ask >= run.legs.long.entry || q!.bid <= run.legs.short.entry) return "Market already crossed a planned STOP entry.";
  if (now < Date.parse(run.targetSubmitAt)) return "Not due.";
  if (now >= Date.parse(run.release.time)) return "The release already started; no new orders were submitted.";
  return null;
}
export function executablePips(side: NewsSide, entry: number, q: NewsQuote, instrument: string) {
  return (side === "long" ? q.bid - entry : entry - q.ask) / pipSizeFor(instrument);
}
export function trailingDecision(input: { instrument: string; side: NewsSide; entry: number; quote: NewsQuote; activeStop: number; activationPips: number; distancePips: number; brokerTrailing: boolean }) {
  const pips = executablePips(input.side, input.entry, input.quote, input.instrument);
  const candidate = roundPrice(input.instrument, input.side === "long" ? input.quote.bid - input.distancePips * pipSizeFor(input.instrument) : input.quote.ask + input.distancePips * pipSizeFor(input.instrument));
  const improves = input.side === "long" ? candidate >= input.activeStop : candidate <= input.activeStop;
  return { pips, candidate, activate: !input.brokerTrailing && pips + 1e-8 >= input.activationPips && improves };
}
