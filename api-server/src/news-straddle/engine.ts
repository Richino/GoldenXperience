import { NEWS_TERMINAL, type NewsRun, type NewsSide, type NewsLeg } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import { pipSizeFor } from "../../../frontend/src/lib/instruments/catalog.js";
import { newsReleaseStillMatches } from "../../../frontend/src/lib/news/news-release-groups.js";
import type { NewsRepository, NewsSession, Audit } from "./store.js";
import type { NewsBroker, BrokerContext, BrokerTransaction, OrderObservation, TradeObservation } from "./broker.js";
import { calculateNewsRisk, entryPrices, executablePips, MAX_SUBMIT_LATENESS_MS, PREPARE_LEAD_MS, preSubmitIssue, priceDistance, quoteIssue, roundPrice, trailingDecision, type NewsQuote } from "./policy.js";

export type EngineDeps = { repo: NewsRepository; broker: NewsBroker; now(): number;
  entriesEnabled?(): boolean;
  policy(userId: string): Promise<{ killSwitch: boolean; riskLimit: number }>;
  halted(): Promise<boolean>; calendar(): Promise<{ events: Array<{ id: string; title: string; currency: string; timestamp: string; impact: number; timingVerified?: boolean }>; fetchedAt: string }>;
  notify(run: NewsRun, event: string, text: string): Promise<void>; log(error: unknown): void;
};
type Action = { key: string; run: () => Promise<void> };
const SIDES: NewsSide[] = ["long", "short"];
const other = (s: NewsSide) => s === "long" ? "short" : "long";
const iso = (n: number) => new Date(n).toISOString();
const resolved = (l: NewsLeg) => ["CANCELLED", "REJECTED"].includes(l.state) || l.state === "UNSENT" || l.state === "FILLED";
const cancelling = (r: NewsRun) => r.state === "CANCELLING" || r.state === "EXCEPTION";

/** Broker I/O runs outside the short DB lock, so a slow POST cannot block OCO fill processing. */
export class NewsStraddleEngine {
  private inFlight = new Map<string, Promise<void>>();
  private lastAction = new Map<string, number>();
  constructor(readonly deps: EngineDeps) {}
  private launch(a: Action) {
    if (this.inFlight.has(a.key) || this.deps.now() - (this.lastAction.get(a.key) ?? -Infinity) < 250) return;
    this.lastAction.set(a.key, this.deps.now());
    const task = a.run().catch(e => this.deps.log(e)).finally(() => { this.inFlight.delete(a.key); });
    this.inFlight.set(a.key, task);
  }
  async drain() { for (let i = 0; this.inFlight.size && i < 100; i++) await Promise.allSettled([...this.inFlight.values()]); }
  private async save(s: NewsSession, run: NewsRun, event: string, detail: Record<string, unknown> = {}, transactionId?: string) {
    run.timeline = [...run.timeline, { at: iso(this.deps.now()), event, detail: typeof detail.reason === "string" ? detail.reason : event.replaceAll("_", " ") }].slice(-30);
    await s.save(run, { event, detail: { ...detail, state: run.state, at: iso(this.deps.now()) }, transactionId });
  }
  private async exception(s: NewsSession, r: NewsRun, reason: string) {
    r.state = "EXCEPTION"; r.exception ??= reason; r.reason = reason;
    await s.halt(reason);
    await this.save(s, r, "emergency_risk_reduction", { reason });
    this.launch({ key: `notify:${r.id}:exception`, run: () => this.deps.notify(r, "exception", reason) });
  }
  private async cancelRun(s: NewsSession, r: NewsRun, reason: string) {
    r.state = "CANCELLING"; r.reason = reason;
    await this.save(s, r, "fail_safe_requested", { reason });
  }
  private async advance(s: NewsSession, r: NewsRun) {
    if (NEWS_TERMINAL.includes(r.state)) return;
    const previousState = r.state;
    if (!r.exception && SIDES.every(side => r.legs[side].state === "FILLED")) await this.exception(s, r, "Both opposing STOP orders filled before OCO cancellation completed.");
    const fill = r.firstFillSide ? r.legs[r.firstFillSide] : null;
    const opposite = r.firstFillSide ? r.legs[other(r.firstFillSide)] : null;
    if (!cancelling(r) && fill && opposite?.state === "CANCELLED" && fill.lastProtectionAt && !fill.closedAt) r.state = fill.trailingActivatedAt ? "TRAILING" : "OPEN";
    if (!fill && SIDES.every(side => r.legs[side].state === "PENDING") && !cancelling(r)) r.state = "PENDING_ORDERS";
    const flat = r.exposureCheckedAt && this.deps.now() - Date.parse(r.exposureCheckedAt) < 3000 && !r.ownedOpenTradeIds?.length;
    const tradesClosed = SIDES.every(side => !r.legs[side].tradeId || !!r.legs[side].closedAt);
    if (flat && tradesClosed && SIDES.every(side => resolved(r.legs[side]))) {
      if (r.exception) r.state = "HALTED";
      else if (fill) r.state = "CLOSED";
      else if (cancelling(r)) r.state = r.reason === "Cancelled by user." ? "CANCELLED" : this.deps.now() >= Date.parse(r.release.time) + r.settings.windowSeconds * 1000 ? "EXPIRED" : "SKIPPED";
      else return;
      r.endedAt = iso(this.deps.now());
      await this.save(s, r, "setup_ended", { reason: r.reason ?? "Broker confirms no remaining orders or exposure." });
      this.launch({ key: `notify:${r.id}:end`, run: () => this.deps.notify(r, "ended", r.state) });
    }
    else if (r.state !== previousState) await this.save(s, r, "lifecycle_reconciled");
  }
  private async protectObservation(s: NewsSession, r: NewsRun, side: NewsSide, t: TradeObservation) {
    const l = r.legs[side];
    if (t.instrument !== r.instrument || t.id !== l.tradeId) { await this.exception(s, r, "Broker trade identity does not match the setup."); return; }
    if (t.state === "CLOSED") {
      if (!t.closedAt || t.exit === null || !Number.isFinite(t.realizedPL)) return;
      l.closedAt = t.closedAt; l.exitPrice = t.exit; l.realizedPL = t.realizedPL;
      l.realizedPips = l.fillPrice === null ? null : (side === "long" ? t.exit - l.fillPrice : l.fillPrice - t.exit) / pipSizeFor(r.instrument);
      l.realizedR = r.risk?.perLegCash ? t.realizedPL / r.risk.perLegCash : null; l.unrealizedPips = null;
      await this.save(s, r, "broker_trade_closed", { side, tradeId: t.id, closeTime: t.closedAt, exitPrice: t.exit, realizedPL: t.realizedPL, realizedR: l.realizedR, realizedPips: l.realizedPips });
      if (!cancelling(r)) r.state = "OCO_CANCELLING";
      return;
    }
    if (t.state !== "OPEN" || Math.sign(t.units) !== (side === "long" ? 1 : -1) || Math.abs(t.units) !== l.units) { await this.exception(s, r, "Broker exposure differs from the approved size or direction."); return; }
    if (t.stop === null && t.trailValue === null) { await this.exception(s, r, "Broker did not confirm stop protection on the open trade."); return; }
    if (t.target !== null) { await this.exception(s, r, "An unexpected fixed take-profit is attached to this news trade."); return; }
    const initial = roundPrice(r.instrument, l.fillPrice! + (side === "long" ? -1 : 1) * l.stopDistance!);
    const candidates = [t.stop, t.trailValue].filter((n): n is number => n !== null);
    const active = side === "long" ? Math.max(...candidates) : Math.min(...candidates);
    const tick = 10 ** -(r.constraints?.precision ?? 5);
    if ((side === "long" ? active < initial - tick : active > initial + tick) || (l.activeStop !== null && (side === "long" ? active < l.activeStop - tick : active > l.activeStop + tick))) {
      await this.exception(s, r, "The confirmed broker stop lost protection; no stop was widened by GX."); return;
    }
    if (l.trailingActivatedAt && !t.trailId) { await this.exception(s, r, "Previously verified broker trailing protection disappeared."); return; }
    l.initialStop ??= initial; l.activeStop = active; l.lastProtectionAt = iso(this.deps.now());
    l.protectedPips = (side === "long" ? active - l.fillPrice! : l.fillPrice! - active) / pipSizeFor(r.instrument);
    if (t.trailId && t.trailValue !== null) {
      const expected = priceDistance(r.instrument, r.settings.trailingDistancePips);
      if (t.trailDistance === null || Math.abs(t.trailDistance - expected) > tick / 2) { await this.exception(s, r, "Broker trailing distance differs from the approved setting."); return; }
      l.trailingOrderId = t.trailId; l.trailingActivatedAt ??= iso(this.deps.now());
      l.maximumFavorablePips = Math.max(l.maximumFavorablePips, l.protectedPips + r.settings.trailingDistancePips);
    }
    await this.save(s, r, "broker_protection_verified", { side, initialStop: l.initialStop, activeStop: active, trailingOrderId: t.trailId });
  }
  private async applyFill(s: NewsSession, r: NewsRun, side: NewsSide, tx: BrokerTransaction) {
    const l = r.legs[side];
    if (l.state === "FILLED") return;
    const fill = Number(tx.price);
    if (!Number.isFinite(fill) || fill <= 0 || !Number.isFinite(Date.parse(tx.time))) { await this.exception(s, r, "Broker fill has invalid price/time; exposure requires reconciliation."); return; }
    l.state = "FILLED"; l.fillTime = tx.time; l.fillPrice = fill; l.tradeId = tx.tradeOpened?.tradeID ?? null;
    l.brokerTime = tx.time; l.orderId ??= tx.orderID ?? null;
    l.slippagePips = (side === "long" ? fill - l.entry! : l.entry! - fill) / pipSizeFor(r.instrument);
    const bid = Number(tx.fullPrice?.bids?.[0]?.price), ask = Number(tx.fullPrice?.asks?.[0]?.price);
    l.fillSpreadPips = bid > 0 && ask >= bid ? (ask - bid) / pipSizeFor(r.instrument) : null;
    r.firstFillSide ??= side;
    await this.save(s, r, "broker_fill", { side, transactionId: tx.id, brokerFillTime: tx.time, receivedAt: iso(this.deps.now()), fill, slippagePips: l.slippagePips, spreadPips: l.fillSpreadPips });
    if (r.legs[other(side)].state === "FILLED") { await this.exception(s, r, "Both opposing STOP orders filled before OCO cancellation completed."); return; }
    if (!l.tradeId || (tx.tradeReduced || tx.tradesClosed?.length) || !Number.isFinite(Number(tx.tradeOpened?.units)) || Math.abs(Number(tx.tradeOpened?.units)) !== l.units) {
      await this.exception(s, r, "Unexpected netting or partial fill; reconcile and flatten only this setup's exposure."); return;
    }
    if (cancelling(r)) { await this.exception(s, r, "A broker fill arrived while cancellation was in progress."); return; }
    r.state = "OCO_CANCELLING";
    await this.save(s, r, "oco_cancellation_required", { side: other(side), fillTime: tx.time });
    this.launch({ key: `notify:${r.id}:fill`, run: () => this.deps.notify(r, "fill", `${side.toUpperCase()} fill verified; opposite cancellation requested.`) });
  }
  async observeTransaction(id: string, tx: BrokerTransaction) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || await s.seen(tx.id)) return;
      const side = SIDES.find(side => r.legs[side].orderId !== null && r.legs[side].orderId === tx.orderID || r.legs[side].clientId === tx.clientOrderID || r.legs[side].clientId === tx.clientExtensions?.id);
      if (side) {
        if (tx.type === "STOP_ORDER") { const l = r.legs[side]; l.orderId = tx.id; l.brokerTime = tx.time; l.acknowledgedAt ??= iso(this.deps.now()); if (["SUBMITTING", "UNKNOWN"].includes(l.state)) l.state = "PENDING"; }
        else if (tx.type === "ORDER_FILL") await this.applyFill(s, r, side, tx);
        else if (tx.type === "ORDER_CANCEL") { const l = r.legs[side]; if (l.state !== "FILLED") { l.state = "CANCELLED"; l.cancellationConfirmedAt = tx.time; } }
      }
      await this.advance(s, r);
      await this.save(s, r, "broker_transaction", { transaction: tx }, tx.id);
    });
    await this.drive(id);
  }
  async observeOrder(id: string, side: NewsSide, observation: OrderObservation | null, ack = false) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state)) return;
      const l = r.legs[side];
      if (observation) {
        r.lastReconciledAt = iso(this.deps.now());
        l.orderId = observation.id; l.brokerTime ??= observation.time ?? null;
        if (ack) l.acknowledgedAt = iso(this.deps.now());
        if (observation.state === "FILLED" && observation.fill) await this.applyFill(s, r, side, observation.fill);
        else if (l.state !== "FILLED") {
          l.state = observation.state;
          if (observation.state === "CANCELLED") l.cancellationConfirmedAt ??= iso(this.deps.now());
        }
        await this.save(s, r, ack ? "broker_acknowledged" : "broker_order_reconciled", { side, observation });
      }
      await this.advance(s, r);
    });
    await this.drive(id);
  }
  async observeTrade(id: string, side: NewsSide, trade: TradeObservation | null) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state)) return;
      if (trade) { r.lastReconciledAt = iso(this.deps.now()); await this.protectObservation(s, r, side, trade); }
      else if (r.legs[side].tradeId) await this.exception(s, r, "The filled trade cannot be verified at OANDA.");
      await this.advance(s, r);
    });
    await this.drive(id);
  }
  async observeExposure(id: string, trades: TradeObservation[]) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state)) return;
      r.exposureCheckedAt = iso(this.deps.now()); r.ownedOpenTradeIds = trades.map(t => t.id);
      r.lastReconciledAt = r.exposureCheckedAt;
      for (const t of trades) {
        const side = SIDES.find(side => r.legs[side].tradeClientId === t.clientId || r.legs[side].tradeId === t.id);
        if (side && !r.legs[side].tradeId) { r.legs[side].tradeId = t.id; r.legs[side].fillPrice = t.entry; r.legs[side].fillTime = t.openedAt; r.legs[side].state = "FILLED"; await this.exception(s, r, "Recovered an open trade before its order fill was reconciled."); }
      }
      await this.save(s, r, "broker_exposure_reconciled", { tradeIds: r.ownedOpenTradeIds });
      await this.advance(s, r);
    });
    await this.drive(id);
  }
  async cancel(id: string, userId: string) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || r.userId !== userId) throw new Error("News setup not found.");
      if (!NEWS_TERMINAL.includes(r.state)) await this.cancelRun(s, r, "Cancelled by user.");
    }); await this.drive(id);
  }
  async verifyCalendar(id: string, calendar: Awaited<ReturnType<EngineDeps["calendar"]>>) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state) || cancelling(r) || r.firstFillSide) return;
      const valid = newsReleaseStillMatches(r.instrument, r.release, calendar.events);
      if (!valid || this.deps.now() - Date.parse(calendar.fetchedAt) > 15 * 60_000) await this.cancelRun(s, r, "Release was cancelled, rescheduled or its calendar verification expired.");
      else { r.calendarCheckedAt = iso(this.deps.now()); r.calendarFetchedAt = calendar.fetchedAt; await this.save(s, r, "calendar_reverified"); }
    });
    await this.drive(id);
  }
  private async prepared(id: string, context: BrokerContext, calendar: Awaited<ReturnType<EngineDeps["calendar"]>>) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || r.state !== "PREPARING") return;
      try {
        if (!newsReleaseStillMatches(r.instrument, r.release, calendar.events)) throw new Error("A release was cancelled, rescheduled or no longer reliably classified.");
        if (this.deps.now() - Date.parse(calendar.fetchedAt) > 15 * 60_000) throw new Error("Calendar verification is stale.");
        const policy = await this.deps.policy(r.userId);
        if (policy.killSwitch || await this.deps.halted()) throw new Error("News execution is paused.");
        if (context.openInstruments.includes(r.instrument) || context.pendingInstruments.includes(r.instrument)) throw new Error("Broker already has exposure or a pending order on this pair.");
        const issue = quoteIssue(context.quote, this.deps.now()); if (issue) throw new Error(issue);
        const sized = calculateNewsRisk({ instrument: r.instrument, settings: r.settings, ...context, equity: Math.min(context.equity, r.risk?.equity ?? context.equity), ...context.constraints, riskLimit: policy.riskLimit });
        r.risk = sized.risk; r.constraints = context.constraints; r.clock = context.clock; r.preparedAt = iso(this.deps.now());
        r.preparedQuote = context.quote; r.calendarCheckedAt = iso(this.deps.now()); r.calendarFetchedAt = calendar.fetchedAt;
        for (const l of Object.values(r.legs)) { l.units = sized.units; l.stopDistance = priceDistance(r.instrument, sized.risk.stopPips); }
        r.state = "READY"; await this.save(s, r, "preflight_ready", { risk: r.risk, constraints: r.constraints, clock: r.clock });
      } catch (error) { await this.cancelRun(s, r, error instanceof Error ? error.message : "Preflight failed."); }
    });
    await this.drive(id);
  }
  async tick(id: string, quote: NewsQuote | null, monitorReady: boolean) {
    const actions: Action[] = [];
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state)) return;
      const now = this.deps.now(), releaseAt = Date.parse(r.release.time), target = Date.parse(r.targetSubmitAt);
      if (this.deps.broker.environment() !== "practice") { await this.cancelRun(s, r, "Practice execution is unavailable."); return; }
      if (!r.firstFillSide && !cancelling(r) && this.deps.entriesEnabled?.() === false) { await this.cancelRun(s, r, "New News Straddle entries are disabled."); return; }
      if (!cancelling(r) && (await this.deps.policy(r.userId)).killSwitch) { await this.cancelRun(s, r, "Execution kill switch is on; cancel orders and close this setup's exposure."); return; }
      if (r.state === "SCHEDULED" && now >= releaseAt - PREPARE_LEAD_MS) {
        r.state = "PREPARING"; await this.save(s, r, "preflight_started");
        actions.push({ key: `prepare:${id}`, run: async () => {
          try { const [context, calendar] = await Promise.all([this.deps.broker.context(r.instrument), this.deps.calendar()]); await this.prepared(id, context, calendar); }
          catch (error) { await this.fail(id, error instanceof Error ? error.message : "Broker/calendar preflight failed."); }
        } }); return;
      }
      if (r.state === "PREPARING" && now >= target) { await this.cancelRun(s, r, "Preflight did not finish before the submission target."); return; }
      if (r.state === "READY" && !r.levelsFrozenAt && now >= target - 1000 && now < target) {
        const issue = quoteIssue(quote, now); if (issue) { await this.cancelRun(s, r, issue); return; }
        const p = entryPrices(r.instrument, quote!, r.settings.distancePips, r.settings.maxSlippagePips);
        Object.assign(r.legs.long, { entry: p.buy, bound: p.buyBound }); Object.assign(r.legs.short, { entry: p.sell, bound: p.sellBound });
        r.preparedQuote = quote!; r.levelsFrozenAt = iso(now); await this.save(s, r, "stop_entries_frozen", { quote, entries: p });
      }
      if (r.state === "READY" && now >= target) {
        const policy = await this.deps.policy(r.userId);
        const issue = !r.levelsFrozenAt ? "STOP entries were not frozen before the target." : policy.killSwitch || await this.deps.halted() ? "News execution is paused." : !Number.isFinite(policy.riskLimit) || r.settings.maxEventRiskPercent > policy.riskLimit || r.settings.riskPerTradePercent > policy.riskLimit ? "Approved news risk exceeds the current account limit." : preSubmitIssue(r, quote, now, monitorReady);
        if (issue) { await this.cancelRun(s, r, issue); return; }
        r.state = "SUBMITTING";
        for (const side of SIDES) { r.legs[side].state = "SUBMITTING"; r.legs[side].submittedAt = iso(now); }
        await this.save(s, r, "submission_reserved", { targetSubmitAt: r.targetSubmitAt, reservedAt: iso(now), quote });
        for (const side of SIDES) actions.push({ key: `submit:${id}:${side}`, run: async () => {
          if (this.deps.entriesEnabled?.() === false) { await this.failSubmission(id, side, "News entry ownership or permission ended before HTTP dispatch.", true); return; }
          if (this.deps.now() - target > MAX_SUBMIT_LATENESS_MS) { await this.failSubmission(id, side, "Submission target missed before HTTP dispatch.", true); return; }
          try {
            const dispatchedAt = iso(this.deps.now());
            // The async broker method starts fetch before its first await.
            // Persist the actual dispatch separately from the durable reservation.
            const submitted = this.deps.broker.submit(r, r.legs[side]).then(value => ({ value, error: null }), error => ({ value: null, error }));
            await this.deps.repo.locked(id, async session => { const current = await session.read(); if (current) { current.legs[side].httpDispatchedAt = dispatchedAt; await this.save(session, current, "http_order_dispatched", { side, actualSubmissionTime: dispatchedAt, intendedSubmissionTime: current.targetSubmitAt }); } });
            const outcome = await submitted; if (outcome.error) throw outcome.error;
            const response = outcome.value!;
            await this.observeOrder(id, side, response.order, true);
            for (const tx of response.transactions) await this.observeTransaction(id, tx);
            if (!response.order) await this.failSubmission(id, side, "No broker order acknowledgment.", response.transactions.some(t => t.type.endsWith("_REJECT")));
          } catch (error) { const code = (error as { status?: number })?.status; await this.failSubmission(id, side, String(error), code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429); }
        } }); return;
      }
      if (!cancelling(r) && now >= releaseAt && !r.firstFillSide && !SIDES.every(side => r.legs[side].state === "PENDING")) await this.cancelRun(s, r, "Both opposing orders were not confirmed before the release.");
      if (!cancelling(r) && !r.firstFillSide && ["SUBMITTING", "PENDING_ORDERS"].includes(r.state) && !monitorReady) await this.cancelRun(s, r, "Broker transaction monitoring lost synchronization while orders were pending.");
      if (!cancelling(r) && !r.firstFillSide && now >= releaseAt + r.settings.windowSeconds * 1000) await this.cancelRun(s, r, "The news entry window ended.");
      if (!cancelling(r) && !r.firstFillSide && SIDES.some(side => ["CANCELLED", "REJECTED"].includes(r.legs[side].state))) await this.cancelRun(s, r, "One opposing order was rejected or cancelled; single-sided entry is disabled.");
      if (!cancelling(r) && !r.firstFillSide && ["SUBMITTING", "PENDING_ORDERS"].includes(r.state) && !quoteIssue(quote, now) && (quote!.ask - quote!.bid) / pipSizeFor(r.instrument) > r.settings.maxSpreadPips + 1e-8) await this.cancelRun(s, r, "Spread expanded beyond the approved cap while orders were pending.");
      if (r.firstFillSide && !cancelling(r)) {
        const l = r.legs[r.firstFillSide], opposite = r.legs[other(r.firstFillSide)];
        if (opposite.state !== "CANCELLED" && now - Date.parse(l.fillTime!) > 2000) await this.exception(s, r, "Opposite cancellation was not confirmed promptly after the fill.");
        if (l.fillPrice !== null && !l.closedAt) {
          const issue = quoteIssue(quote, now);
          l.unrealizedPips = issue ? null : executablePips(l.side, l.fillPrice, quote!, r.instrument);
          if (l.unrealizedPips !== null) l.maximumFavorablePips = Math.max(l.maximumFavorablePips, l.unrealizedPips);
          const lastProtected = Date.parse(l.lastProtectionAt ?? l.fillTime!);
          if (now - lastProtected > r.settings.disconnectExitSeconds * 1000) await this.exception(s, r, "Broker protection could not be re-verified within the approved disconnect grace.");
          if (!issue && l.unrealizedPips! <= -r.risk!.stopPips * r.settings.emergencyLossR) await this.exception(s, r, "Emergency adverse-price threshold reached.");
          if (!issue && r.settings.emergencySpreadPips > 0 && (quote!.ask - quote!.bid) / pipSizeFor(r.instrument) > r.settings.emergencySpreadPips) await this.exception(s, r, "Configured emergency spread threshold reached.");
          if (r.settings.maxHoldMinutes > 0 && now - Date.parse(l.fillTime!) > r.settings.maxHoldMinutes * 60_000) await this.cancelRun(s, r, "Configured maximum holding time reached.");
          if (!cancelling(r) && !issue && l.activeStop !== null && !l.trailingRequestedAt && trailingDecision({ instrument: r.instrument, side: l.side, entry: l.fillPrice, quote: quote!, activeStop: l.activeStop, activationPips: r.settings.trailingActivationPips, distancePips: r.settings.trailingDistancePips, brokerTrailing: !!l.trailingOrderId }).activate) {
            l.trailingRequestedAt = iso(now); await this.save(s, r, "trailing_activation_requested", { side: l.side, executablePips: l.unrealizedPips, originalStopRetained: true });
            actions.push({ key: `trail:${id}:${l.side}`, run: async () => {
              try { await this.deps.broker.addTrailing(l.tradeId!, priceDistance(r.instrument, r.settings.trailingDistancePips), r.instrument); await this.observeTrade(id, l.side, await this.deps.broker.trade(l.tradeId!)); }
              catch (error) { this.deps.log(error); /* uncertain response is reconciled, never blindly replaced */ }
            } });
          }
          if (l.trailingRequestedAt && !l.trailingActivatedAt && now - Date.parse(l.trailingRequestedAt) > 5000) await this.exception(s, r, "Trailing activation was not confirmed; the original stop was retained.");
          await this.save(s, r, "observed_trade_metrics", { side: l.side, unrealizedPips: l.unrealizedPips, maximumFavorablePips: l.maximumFavorablePips, protectedPips: l.protectedPips });
        }
      }
      await this.advance(s, r);
    });
    for (const a of actions) this.launch(a);
    await this.drive(id);
  }
  private async failSubmission(id: string, side: NewsSide, reason: string, notSent: boolean) {
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r) return;
      if (["FILLED", "CANCELLED", "PENDING"].includes(r.legs[side].state)) return;
      r.legs[side].state = notSent ? "REJECTED" : "UNKNOWN";
      await this.save(s, r, "submission_uncertain", { side, reason, notSent });
      await this.cancelRun(s, r, reason);
    }); await this.drive(id);
  }
  async fail(id: string, reason: string) { await this.deps.repo.locked(id, async s => { const r = await s.read(); if (r && !NEWS_TERMINAL.includes(r.state)) await this.cancelRun(s, r, reason); }); await this.drive(id); }
  /** Reconciliation/cancellation actions are idempotent; entry POSTs are never scheduled here. */
  async drive(id: string) {
    const actions: Action[] = [];
    await this.deps.repo.locked(id, async s => {
      const r = await s.read(); if (!r || NEWS_TERMINAL.includes(r.state)) return;
      for (const side of SIDES) {
        const l = r.legs[side];
        const mustCancel = cancelling(r) || (r.firstFillSide !== null && r.firstFillSide !== side);
        if (mustCancel && ["SUBMITTING", "UNKNOWN", "PENDING"].includes(l.state)) {
          if (!l.cancellationRequestedAt) { l.cancellationRequestedAt = iso(this.deps.now()); await this.save(s, r, "opposite_cancel_requested", { side, clientId: l.clientId }); }
          actions.push({ key: `cancel:${id}:${side}`, run: async () => {
            try { await this.deps.broker.cancel(l.clientId); } catch (e) { this.deps.log(e); }
            await this.observeOrder(id, side, await this.deps.broker.order(l.clientId));
          } });
        }
        if (cancelling(r) && l.tradeId && !l.closedAt) actions.push({ key: `close:${id}:${l.tradeId}`, run: async () => {
          const t = await this.deps.broker.trade(l.tradeId!);
          if (t?.state === "OPEN") await this.deps.broker.close(l.tradeId!);
          await this.observeTrade(id, side, await this.deps.broker.trade(l.tradeId!));
        } });
      }
    });
    for (const a of actions) this.launch(a);
  }
  async reconcile(id: string) {
    const r = await this.deps.repo.locked(id, s => s.read()); if (!r || NEWS_TERMINAL.includes(r.state)) return;
    for (const side of SIDES) {
      const l = r.legs[side];
      if (!["UNSENT", "REJECTED"].includes(l.state)) this.launch({ key: `poll-order:${id}:${side}`, run: async () => this.observeOrder(id, side, await this.deps.broker.order(l.clientId)) });
      if (l.tradeId && !l.closedAt) this.launch({ key: `poll-trade:${id}:${side}`, run: async () => this.observeTrade(id, side, await this.deps.broker.trade(l.tradeId!)) });
    }
    this.launch({ key: `poll-exposure:${id}`, run: async () => this.observeExposure(id, await this.deps.broker.ownedTrades(r)) });
  }
}
