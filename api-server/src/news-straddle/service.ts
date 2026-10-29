import { getCandles } from "../../../frontend/src/lib/oanda/client.js";
import { readSwingTrend } from "../../../frontend/src/lib/swing-trend-read.js";
import { precisionFor } from "../../../frontend/src/lib/instruments/catalog.js";
import type { MajorInstrument } from "../../../frontend/src/types/forex.js";
import { manualOcoRun } from "./manual-oco.js";
import { randomUUID } from "node:crypto";
import { getMarketSelectionCalendar } from "../../../frontend/src/lib/calendar/forex-factory.js";
import { NEWS_V3, type NewsLeg, type NewsRun, type NewsV3Preview } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import { calculateNewsRisk, entryPrices, eventKey, parseV3Settings, priceDistance, schedulingQuoteIssue, SUBMIT_LEAD_MS, verifyRelease } from "./policy.js";
import { accountKey, liveNewsBroker } from "./broker.js";
import { createNewsRun, newsRiskPolicy, newsRuntimeStatus, newsRows, PgNewsRepository, readUserNewsRun } from "./store.js";
import { NewsStraddleEngine, type EngineDeps } from "./engine.js";
import { queueNotification } from "../notifications.js";
import { query } from "../database.js";

export const liveEngineDeps = (): EngineDeps => ({
  repo: new PgNewsRepository(accountKey()), broker: liveNewsBroker, now: Date.now,
  entriesEnabled: () => process.env.NEWS_STRADDLE_V3_ENABLED !== "false",
  policy: newsRiskPolicy, halted: async () => (await newsRuntimeStatus(accountKey())).halted,
  calendar: getMarketSelectionCalendar,
  notify: async (run, event, text) => { await queueNotification({ userId: run.userId, kind: event === "exception" ? "system_issue" : "trade_update", title: `${run.instrument.replace("_", "/")} ${run.mode === "oco" ? "Linked OCO" : "News Straddle"}`, message: text, instrument: run.instrument, paperTradeId: null, dedupeKey: `news-v3:${run.id}:${event}` }); },
  log: error => console.error("[news-v3]", error instanceof Error ? error.message : error),
});

export async function previewNewsV3(userId: string, raw: Record<string, unknown>) {
  if (process.env.NEWS_STRADDLE_V3_ENABLED === "false") throw new Error("The news scheduler is disabled.");
  if (raw.version !== NEWS_V3) throw new Error("News Straddle has been updated. Reload the ticket before arming.");
  if (liveNewsBroker.environment() !== "practice") throw new Error("News Straddle is practice-only.");
  const instrument = String(raw.instrument ?? "");
  const settings = parseV3Settings(raw.settings && typeof raw.settings === "object" ? raw.settings as Record<string, unknown> : {});
  const [calendar, initialContext, policy, runtime] = await Promise.all([getMarketSelectionCalendar(), liveNewsBroker.context(instrument), newsRiskPolicy(userId), newsRuntimeStatus(accountKey())]);
  let context = initialContext;
  // A calendar lookup or a transient candle response can outlive the first quote.
  // Retry observations only; the final freshness and volatility rules stay intact.
  for (let attempt = 0; attempt < 2 && (schedulingQuoteIssue(context.quote, Date.now()) || settings.stopMode === "ATR" && !(context.atrPips! > 0)); attempt++) {
    context = await liveNewsBroker.context(instrument);
  }
  const now = Date.now();
  if (policy.killSwitch || runtime.halted) throw new Error(runtime.halt_reason ?? "Execution kill switch is on.");
  const issue = schedulingQuoteIssue(context.quote, now); if (issue) throw new Error(issue);
  if (context.openInstruments.includes(instrument) || context.pendingInstruments.includes(instrument)) throw new Error("This pair already has a broker position or pending order.");
  const release = verifyRelease(instrument, raw.release && typeof raw.release === "object" ? raw.release as Record<string, unknown> : {}, calendar, now);
  const sized = calculateNewsRisk({ instrument, settings, ...context, ...context.constraints, riskLimit: policy.riskLimit, eventRiskLimit: policy.eventRiskLimit });
  const entries = entryPrices(instrument, context.quote, settings.distancePips, settings.maxSlippagePips);
  const preview: NewsV3Preview = { settings, release, quote: context.quote, buyEntry: entries.buy, sellEntry: entries.sell, risk: sized.risk, units: sized.units, checkedAt: new Date(now).toISOString(), targetSubmitAt: new Date(Date.parse(release.time) - SUBMIT_LEAD_MS).toISOString() };
  return { preview, context, calendar };
}
export async function armNewsV3(userId: string, raw: Record<string, unknown>) {
  const { preview: p, context, calendar } = await previewNewsV3(userId, raw);
  const id = randomUUID();
  const entries = entryPrices(String(raw.instrument), context.quote, p.settings.distancePips, p.settings.maxSlippagePips);
  const leg = (side: "long" | "short"): NewsLeg => ({ side, entryId: randomUUID(), clientId: `gx-news-${id}-${side}`, tradeClientId: `gx-news-trade-${id}-${side}`,
    state: "UNSENT", entry: side === "long" ? entries.buy : entries.sell, bound: side === "long" ? entries.buyBound : entries.sellBound, stopDistance: priceDistance(String(raw.instrument), p.risk.stopPips), units: p.units,
    orderId: null, tradeId: null, paperTradeId: null, submittedAt: null, acknowledgedAt: null, brokerTime: null, cancellationRequestedAt: null, cancellationConfirmedAt: null,
    fillTime: null, fillPrice: null, slippagePips: null, fillSpreadPips: null, initialStop: null, activeStop: null, trailingOrderId: null, trailingRequestedAt: null, trailingActivatedAt: null,
    unrealizedPips: null, maximumFavorablePips: 0, protectedPips: null, realizedPL: null, realizedR: null, exitPrice: null, closedAt: null, lastProtectionAt: null });
  const run: NewsRun = { id, userId, accountKey: accountKey(), instrument: String(raw.instrument), eventKey: eventKey(p.release), version: 3, revision: 0,
    state: "SCHEDULED", release: p.release, settings: p.settings, createdAt: p.checkedAt, targetSubmitAt: p.targetSubmitAt, preparedAt: null,
    calendarCheckedAt: p.checkedAt, calendarFetchedAt: calendar.fetchedAt, transactionSeed: context.lastTransactionId, lastReconciledAt: null,
    preparedQuote: context.quote, risk: p.risk, constraints: context.constraints, clock: context.clock, levelsFrozenAt: null,
    legs: { long: leg("long"), short: leg("short") }, firstFillSide: null, exception: null, reason: null, endedAt: null,
    timeline: [{ at: p.checkedAt, event: "scheduled", detail: "Approved practice STOP/OCO settings; no orders sent yet." }] };
  const stored = await createNewsRun(run);
  await queueNotification({ userId, kind: "trade_update", title: `${run.instrument.replace("_", "/")} news setup scheduled`, message: `Two protected STOP orders target 10 seconds before release, with ${stored.risk?.perLegPercent ?? stored.settings.riskPerTradePercent}% planned risk per trade. A verified fill cancels the opposite order; no fixed target.`, instrument: run.instrument, paperTradeId: null, dedupeKey: `news-v3:${stored.id}:scheduled` });
  return { run: stored, entries: await newsRows(stored.id, userId) };
}
export async function cancelNewsV3(userId: string, id: string) {
  if (!await readUserNewsRun(id, userId)) throw new Error("News setup not found.");
  const engine = new NewsStraddleEngine(liveEngineDeps());
  await engine.cancel(id, userId);
  return newsRows(id, userId);
}
export async function resetNewsHalt(userId: string) {
  const active = await new PgNewsRepository(accountKey()).active();
  if (active.length) throw new Error("Reconcile every unresolved news setup before resetting the pause.");
  if ((await newsRiskPolicy(userId)).killSwitch) throw new Error("The account execution kill switch is still on.");
  // No orders are submitted by a reset. A new release still needs explicit arming.
  await query("UPDATE news_straddle_runtime SET halted=false,halt_reason=NULL,updated_at=now() WHERE account_key=$1", [accountKey()]);
  return { reset: true };
}

export async function armManualOco(userId: string, raw: Record<string, unknown>) {
  if (liveNewsBroker.environment() !== "practice" || process.env.NEWS_STRADDLE_V3_ENABLED === "false") throw new Error("Practice OCO execution is unavailable.");
  const existing = typeof raw.requestId === "string" && /^[0-9a-f-]{36}$/i.test(raw.requestId) ? await readUserNewsRun(raw.requestId, userId) : null;
  if (existing) {
    if (existing.mode !== "oco" || existing.instrument !== raw.instrument || existing.legs.long.entry !== raw.buyEntry || existing.legs.short.entry !== raw.sellEntry || existing.requestedRiskAmount !== raw.riskAmount) throw new Error("Request ID belongs to a different setup.");
    return { run: existing, entries: await newsRows(existing.id, userId) };
  }
  const run = await previewManualOco(userId, raw);
  const stored = await createNewsRun(run);
  return { run: stored, entries: await newsRows(stored.id, userId) };
}

export async function previewManualOco(userId: string, raw: Record<string, unknown>) {
  if (liveNewsBroker.environment() !== "practice" || process.env.NEWS_STRADDLE_V3_ENABLED === "false") throw new Error("Practice OCO execution is unavailable.");
  const instrument = String(raw.instrument);
  const [context, policy, runtime, candles] = await Promise.all([liveNewsBroker.context(instrument), newsRiskPolicy(userId), newsRuntimeStatus(accountKey()), getCandles(instrument as MajorInstrument, "H4", 250)]);
  if (runtime.halted) throw new Error(runtime.halt_reason ?? "OCO execution is paused after an exception.");
  if (candles.status.state !== "connected" || !readSwingTrend(instrument, "H4", candles.data)) throw new Error("Current completed OANDA 4H candles are unavailable for stop placement.");
  const closed = candles.data.candles.filter(c => c.complete === true).slice(-15);
  const atr = closed.slice(1).reduce((sum, c, i) => sum + Math.max(c.high - c.low, Math.abs(c.high - closed[i].close), Math.abs(c.low - closed[i].close)), 0) / 14;
  const scale = 10 ** precisionFor(instrument);
  const ocoStopDistance = Math.ceil(2 * atr * scale) / scale;
  return manualOcoRun(userId, accountKey(), raw, { ...context, ocoStopDistance }, policy, Date.now());
}
