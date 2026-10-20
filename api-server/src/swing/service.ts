import type { PoolClient } from "pg";
import { db, databaseConfigured } from "../database.js";
import { getForexSessionStatus } from "../../../frontend/src/lib/strategy/session.js";
import type { OandaStreamPrice } from "../market-stream-normalize.js";
import type { SwingAssessment, SwingMarket, SwingStyle, SwingView, SwingZone } from "../../../frontend/src/lib/swing-intelligence.js";
import { safeSwingError, swingAccountKey, swingSettings, type SwingSettings } from "./config.js";
import { loadSwingMarket, type SwingData } from "./market.js";
import { SwingMovementEngine } from "./movement.js";
import { digest, evaluateSwingScenario, generateSwingZones, loadSwingRisk, pressureControl, swingAssessmentFresh, swingPreference, type SwingRiskContext } from "./decision.js";
import { checkSwingNews, researchSwing } from "./research.js";
import { SwingRepository, type SwingMonitor, type SwingScope } from "./store.js";

type LiveState = { monitor: SwingMonitor; zones: SwingZone[]; assessment: SwingAssessment | null; signature: string;
  zoneSignature: string; risk: SwingRiskContext | null; lastRiskAt: number; touches: Map<string, { at: string; quote: NonNullable<SwingMarket["quote"]>;
    market: SwingMarket | null; assessment: SwingAssessment | null; movement: ReturnType<SwingMovementEngine["snapshot"]> }>;
  lastMid: number | null; lastContinuity: number; invalidations: Map<string, string>; evaluations: Map<string, string>; lastAggregate: number };
type Publish = (scope: SwingScope, message: { type: "swing-intelligence"; instrument: string; event: string; at: string; zoneId?: string }) => void;

/** Analysis-only orchestrator. No dependencies on plan confirmation or order executors. */
export class SwingIntelligenceService {
  readonly settings: SwingSettings;
  readonly movement: SwingMovementEngine;
  readonly repo = new SwingRepository();
  private states = new Map<string, LiveState>();
  private data = new Map<string, { value: SwingData; at: number }>();
  private loadingData = new Map<string, Promise<SwingData>>();
  private leader: PoolClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private researchBusy = false;
  private stopped = false;
  private lastPrune = 0;
  private lastErrorLog = 0;
  private availableReason: string | null = null;
  private readonly startedAt = Date.now();
  constructor(private publish: Publish = () => {}, settings = swingSettings()) { this.settings = settings; this.movement = new SwingMovementEngine(settings); }
  private key(scope: SwingScope) { return `${scope.userId}:${scope.accountKey}:${scope.instrument}`; }
  scope(userId: string, instrument: string): SwingScope { return { userId, accountKey: swingAccountKey(), instrument }; }
  private notify(scope: SwingScope, event: string, zoneId?: string) { this.publish(scope, { type: "swing-intelligence", instrument: scope.instrument, event, at: new Date().toISOString(), ...(zoneId ? { zoneId } : {}) }); }
  status() { return { available: this.settings.enabled && this.timer !== null && !this.stopped && this.leader !== null,
    reason: !this.settings.enabled ? "Swing intelligence is disabled on this server." : !databaseConfigured() ? "The swing analysis database is not configured on this server."
      : process.env.SWING_ANALYSIS_WORKER_ENABLED !== "true" ? "The dedicated analysis worker is disabled on this API instance."
      : this.availableReason ?? (!this.leader ? "Waiting for the designated analysis worker and database migration." : null) }; }
  connection(state: string, source: string) { this.movement.setConnection(state, source); }
  issue(reason: string) { this.movement.breakContinuity(reason); }
  heartbeat() { this.movement.heartbeat(); }
  private wake() {
    if (this.wakeTimer || !this.timer || !this.leader || this.stopped) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; void this.pulse(); }, 0);
    this.wakeTimer.unref();
  }
  observe(raw: OandaStreamPrice, receivedAt: string) {
    if (!this.settings.enabled) return;
    this.movement.observe(raw, receivedAt);
    if (!raw.instrument) return;
    const quote = this.movement.currentQuote(raw.instrument);
    if (!quote || quote.time !== raw.time) return;
    const mid = (quote.bid + quote.ask) / 2;
    for (const state of this.states.values()) if (state.monitor.active && state.monitor.instrument === raw.instrument) {
      const continuity = this.movement.continuity(raw.instrument);
      if (state.lastContinuity !== continuity) { state.lastMid = null; state.lastContinuity = continuity; }
      for (const zone of state.zones) if (zone.status !== "EXPIRED" && (mid < zone.invalidation.lower || mid > zone.invalidation.upper) && !state.invalidations.has(zone.id)) { state.invalidations.set(zone.id, quote.time); this.wake(); }
      for (const zone of state.zones) if (zone.status === "WATCHING" && Date.parse(quote.time) >= Date.parse(zone.createdAt) &&
        (mid >= zone.lower && mid <= zone.upper || state.lastMid !== null && Math.min(mid, state.lastMid) <= zone.upper && Math.max(mid, state.lastMid) >= zone.lower)) {
        if (!state.touches.has(zone.id)) {
          const knownMarket = this.data.get(raw.instrument)?.value.market ?? state.monitor.market;
          state.touches.set(zone.id, { at: quote.time, quote, market: knownMarket, assessment: state.assessment,
            movement: this.movement.snapshot(raw.instrument, zone, knownMarket?.frames.H4.atr ?? 0) });
          this.wake();
        }
      }
      state.lastMid = mid;
    }
  }
  async monitor(userId: string, instrument: string, active: boolean, style: SwingStyle) {
    if (!this.settings.enabled || !this.settings.instruments.includes(instrument)) throw new Error("Swing analysis is not enabled for this instrument.");
    if (active && !this.status().available) throw new Error(this.status().reason ?? "The designated swing analysis worker is unavailable.");
    const scope = this.scope(userId, instrument);
    await this.repo.setMonitor(scope, active, style);
    if (!active) {
      await this.repo.expireAll(scope, "Analysis monitoring stopped by the user; no broker orders or positions were changed.");
      this.states.delete(this.key(scope));
    }
    this.notify(scope, active ? "MONITORING_STARTED" : "MONITORING_STOPPED");
    if (active) this.wake();
    return { active, style, analysisOnly: true };
  }
  async request(userId: string, instrument: string, force = false) {
    if (!this.status().available) throw new Error(this.status().reason ?? "Swing analysis worker unavailable.");
    const scope = this.scope(userId, instrument), monitor = await this.repo.monitor(scope);
    if (!monitor?.active) throw new Error("Start analysis monitoring before requesting research.");
    const assessment = await this.repo.assessment(scope);
    if (!force && swingAssessmentFresh(assessment, monitor.market)) return { cached: true, job: await this.repo.latestJob(scope) };
    return { cached: false, job: await this.repo.queue(scope, "MANUAL", `manual:${Math.floor(Date.now() / this.settings.retryMs)}`, this.settings) };
  }
  private async getData(instrument: string, force = false) {
    const cached = this.data.get(instrument);
    if (!force && cached && Date.now() - cached.at < this.settings.deterministicRefreshMs) return cached.value;
    const pending = this.loadingData.get(instrument); if (pending) return pending;
    const request = loadSwingMarket(instrument, this.settings).then(value => { this.data.set(instrument, { value, at: Date.now() }); return value; }).finally(() => this.loadingData.delete(instrument));
    this.loadingData.set(instrument, request); return request;
  }
  private currentMarket(market: SwingMarket): SwingMarket {
    const live = this.movement.currentQuote(market.instrument), quote = live ?? market.quote;
    const stale = !quote || Date.now() - Date.parse(quote.time) > this.settings.quoteMaxAgeMs || !quote.tradeable;
    return { ...market, quote, state: !getForexSessionStatus(new Date()).marketOpen ? "MARKET_CLOSED" : stale ? "STALE" : market.state,
      issues: stale ? [...new Set([...market.issues, "Current executable quote is stale or unavailable."])] : market.issues };
  }
  async view(userId: string, instrument: string): Promise<SwingView> {
    if (!this.settings.enabled || !this.settings.instruments.includes(instrument)) return {
      enabled: false, runtime: { available: false, reason: !this.settings.enabled ? this.status().reason
        : `Swing intelligence is not enabled for ${instrument.replace("_", "/")} on this server.` }, analysisOnly: true, instrument, monitor: null, market: null, assessment: null,
      assessmentFresh: false, zones: [], unavailableZones: [], movement: null,
      control: { d1: "INSUFFICIENT_DATA", h4: "INSUFFICIENT_DATA", pressure: "INSUFFICIENT_DATA" }, preference: "INSUFFICIENT_DATA", scenarios: [], events: [], job: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, searches: 0, knownCostUsd: 0, unknownCostRequests: 0, latencyMs: 0 },
    };
    const scope = this.scope(userId, instrument);
    const [monitor, assessment, zones, scenarios, events, job, usage] = await Promise.all([this.repo.monitor(scope), this.repo.assessment(scope), this.repo.zones(scope), this.repo.scenarios(scope), this.repo.events(scope), this.repo.latestJob(scope), this.repo.usage(scope)]);
    const market = monitor?.market ? this.currentMarket(this.data.get(instrument)?.value.market ?? monitor.market) : null;
    const movement = market && monitor?.active ? this.movement.snapshot(instrument, null, market.frames.H4.atr) : null;
    const pressure = market ? pressureControl(movement, market, this.settings) : "INSUFFICIENT_DATA";
    const fresh = swingAssessmentFresh(assessment, market);
    const currentScenarios = scenarios.map(s => !monitor?.active || !fresh || market?.state !== "CURRENT" || !movement || ["STALE", "DISCONNECTED"].includes(movement.state)
      || s.style !== "AGGRESSIVE" && movement.state !== "READY" || Date.parse(s.asOf) < this.startedAt || Date.now() - Date.parse(s.asOf) > 30000
      ? { ...s, eligibility: "BLOCKED" as const, blockers: [...new Set([...s.blockers, "A current monitored quote, assessment and decision snapshot is required."])] } : s);
    return { enabled: this.settings.enabled && this.settings.instruments.includes(instrument), runtime: this.status(), analysisOnly: true, instrument,
      monitor: monitor ? { active: monitor.active, style: monitor.style } : null, market, assessment, assessmentFresh: fresh, zones,
      unavailableZones: monitor?.unavailableZones ?? [], movement, control: { d1: market?.frames.D1.control ?? "INSUFFICIENT_DATA", h4: market?.frames.H4.control ?? "INSUFFICIENT_DATA", pressure },
      preference: market ? swingPreference(market, fresh ? assessment : null, pressure, this.settings) : "INSUFFICIENT_DATA", scenarios: currentScenarios, events, job, usage };
  }
  async zone(userId: string, instrument: string, id: string) {
    const scope = this.scope(userId, instrument), zone = await this.repo.zone(scope, id);
    if (!zone) return null;
    const monitor = await this.repo.monitor(scope);
    return { zone, events: await this.repo.events(scope, id), movement: this.movement.snapshot(instrument, zone, monitor?.market?.frames.H4.atr ?? 0, Date.now(), zone.touchedAt ? Date.parse(zone.touchedAt) : undefined) };
  }
  private async acquire() {
    if (this.leader || this.stopped) return;
    const c = await db().connect();
    try {
      const migrated = (await c.query<{ ok: boolean }>("SELECT to_regclass('swing_monitors') IS NOT NULL AS ok")).rows[0].ok;
      if (!migrated) { this.availableReason = "The swing intelligence database migration has not been applied."; c.release(); return; }
      const leader = (await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [`swing-runtime:${swingAccountKey()}`])).rows[0].ok;
      if (!leader) { this.availableReason = "Another API instance owns swing monitoring for this account."; c.release(); return; }
      this.leader = c; this.availableReason = null;
      console.info(`[swing] Analysis worker ready for ${this.settings.instruments.join(", ")}. Waiting for user-started analysis.`);
      c.on("error", () => { if (this.leader === c) { this.leader = null; c.release(true); } });
    } catch (error) { c.release(true); throw error; }
  }
  private async schedule(state: LiveState, market: SwingMarket) {
    const scope = state.monitor, now = Date.now(), s = this.settings, previous = state.monitor.scheduleState;
    const day = new Date(now - s.dailyHourUtc * 3600000).toISOString().slice(0, 10);
    if (!state.assessment || !swingAssessmentFresh(state.assessment, market) || previous.dailyDay !== day) await this.repo.queue(scope, "DAILY", `daily:${day}`, s);
    const releases = market.calendar.events.filter(e => e.impact >= s.materialImpact && e.timingVerified && e.actual !== null && Date.parse(e.timestamp) <= now && now - Date.parse(e.timestamp) < 72 * 3600000);
    const changedRelease = releases.some(e => state.assessment?.calendar.find(old => old.id === e.id)?.actual !== e.actual);
    if (changedRelease && state.assessment) await this.repo.queue(scope, "MATERIAL_NEWS", `release:${digest(releases.map(e => [e.id, e.actual, e.forecast, e.previous]))}`, s);
    const hour = Math.floor(now / 3600000);
    if (s.hourlyChecks && s.searchWithoutProvider && state.assessment && previous.hour !== hour) await this.repo.queue(scope, "HOURLY_CHECK", `hourly:${hour}`, s);
    const conditions = `${market.frames.D1.condition}:${market.frames.H4.condition}`;
    const materialStructure = previous.conditions && previous.conditions !== conditions || typeof previous.displacement === "number" && Math.abs(previous.displacement - market.frames.H4.momentum.displacementAtr) >= s.materialDisplacementAtr;
    if (materialStructure && previous.h4 !== market.frames.H4.lastClosedOpenTime && state.assessment) await this.repo.queue(scope, "MATERIAL_NEWS", `structure:${market.frames.H4.lastClosedOpenTime}:${conditions}`, s);
    const next = { ...previous, dailyDay: day, hour, conditions, displacement: market.frames.H4.momentum.displacementAtr, h4: market.frames.H4.lastClosedOpenTime };
    state.monitor.scheduleState = next; await this.repo.scheduleState(scope, next);
  }
  private async evaluate(state: LiveState, data: SwingData) {
    const scope = state.monitor, s = this.settings;
    let now = Date.now(), market = this.currentMarket(data.market);
    if (!this.leader || this.stopped || !(await this.repo.monitor(scope))?.active) return;
    const newAssessment = await this.repo.assessment(scope);
    state.assessment = newAssessment;
    state.zones = await this.repo.zones(scope);
    const activeIds = new Set(state.zones.map(z => z.id));
    for (const key of state.evaluations.keys()) if (!activeIds.has(key)) state.evaluations.delete(key);
    for (const key of state.touches.keys()) if (!activeIds.has(key)) state.touches.delete(key);
    for (const key of state.invalidations.keys()) if (!activeIds.has(key)) state.invalidations.delete(key);
    const zoneSignature = digest([market.frames.D1.condition, market.frames.H4.condition, market.structureZones, state.assessment?.id, scope.scheduleState.campaign]);
    if (state.zoneSignature !== zoneSignature && market.frames.H4.sufficient && market.frames.D1.sufficient && !market.issues.some(i => /D1:|H4:/.test(i))) {
      const generated = generateSwingZones(market, state.assessment, s, state.zones, String(scope.scheduleState.campaign ?? ""));
      await this.repo.syncZones(scope, generated.zones, generated.unavailable); state.zoneSignature = zoneSignature;
    }
    state.zones = await this.repo.zones(scope);
    if (!state.risk || now - state.lastRiskAt >= s.accountRefreshMs) { state.risk = await loadSwingRisk(scope.userId, scope.instrument, s); state.lastRiskAt = now; }
    if (!this.leader || this.stopped) return;
    now = Date.now(); market = this.currentMarket(data.market);
    const movement = this.movement.snapshot(scope.instrument, null, market.frames.H4.atr), pressure = pressureControl(movement, market, s);
    const preference = swingPreference(market, swingAssessmentFresh(state.assessment, market) ? state.assessment : null, pressure, s);
    const signature = digest([market.state, market.frames.D1.control, market.frames.H4.control, pressure, preference, swingAssessmentFresh(state.assessment, market)]);
    if (signature !== state.signature) {
      await this.repo.event(scope, market.state === "STALE" || market.state === "PROVIDER_ERROR" ? "MARKET_DATA_STALE" : "MARKET_CONTROL_CHANGED",
        `${market.state}; D1 ${market.frames.D1.control}; H4 ${market.frames.H4.control}; pressure ${pressure}; ${preference}.`, `control:${signature}:${state.signature || "initial"}`, { control: { d1: market.frames.D1.control, h4: market.frames.H4.control, pressure }, preference });
      state.signature = signature; this.notify(scope, "MARKET_CONTROL_CHANGED");
    }
    for (const original of state.zones) {
      if (!this.leader || this.stopped) return;
      let zone = original;
      const q = market.quote, mid = q ? (q.bid + q.ask) / 2 : null;
      if (state.invalidations.has(zone.id) || Date.parse(zone.expiresAt) <= now || market.state === "CURRENT" && mid !== null && (mid < zone.invalidation.lower || mid > zone.invalidation.upper)) {
        const changed = await this.repo.transition(scope, zone, { status: "EXPIRED", reason: "Structural invalidation envelope or swing trading-hour expiry reached." }, "The analysis scenario expired; no position or order was changed.");
        if (changed) { zone = changed; this.notify(scope, "SCENARIO_INVALIDATED", zone.id); }
        state.invalidations.delete(zone.id);
      }
      const touch = state.touches.get(zone.id);
      if (zone.status === "WATCHING" && touch) {
        const changed = await this.repo.transition(scope, zone, { status: "TOUCHED", touchedAt: touch.at, reason: "An actual OANDA quote reached/crossed the zone." }, "OANDA quote touched the structural zone.",
          { brokerTime: touch.at, quote: touch.quote, spreadPips: (touch.quote.ask - touch.quote.bid) / market.pipSize, zone: { lower: zone.lower, upper: zone.upper },
            D1: touch.market?.frames.D1 ?? null, H4: touch.market?.frames.H4 ?? null, movement: touch.movement,
            assessmentId: touch.assessment?.id ?? null, fundamentals: touch.assessment?.fundamentalSummary ?? null,
            calendar: touch.market?.calendar ?? null, contextCapturedAt: touch.market?.capturedAt ?? null, invalidation: zone.invalidation, issues: touch.market?.issues ?? ["No structural context was available at the observation."] });
        if (changed) { zone = changed; this.notify(scope, "ZONE_TOUCHED", zone.id); }
        state.touches.delete(zone.id);
      }
      if (zone.status === "TOUCHED") {
        const changed = await this.repo.transition(scope, zone, { status: "EVALUATING" }, "BUY and SELL hypotheses are being evaluated independently.");
        if (changed) zone = changed;
      }
      const reactionMovement = this.movement.snapshot(scope.instrument, zone, market.frames.H4.atr, now, zone.touchedAt ? Date.parse(zone.touchedAt) : undefined);
      const reaction = zoneReactionFor(zone, market, reactionMovement, s);
      const w = reactionMovement.windows.find(w => w.seconds >= 60) ?? reactionMovement.windows[0];
      const evaluationKey = digest([zone.status, zone.touchedAt, reaction, market.state, market.frames.H1.lastClosedOpenTime, market.frames.H4.lastClosedOpenTime,
        pressure, state.assessment?.id, state.lastRiskAt, Math.floor(now / 30000), w?.ready, Math.floor((w?.efficiency ?? 0) * 10)]);
      if (state.evaluations.get(zone.id) === evaluationKey) continue;
      state.evaluations.set(zone.id, evaluationKey);
      const evaluatedZone = { ...zone, behavior: reaction.behavior, behaviorSide: reaction.side, reason: reaction.reason };
      let eligible = false;
      for (const side of ["BUY", "SELL"] as const) {
        const expectancy = await this.repo.expectancy(scope, scope.style, side);
        const scenario = evaluateSwingScenario({ market: this.currentMarket(data.market), zone: evaluatedZone, assessment: state.assessment, movement: reactionMovement, risk: state.risk,
          side, style: scope.style, preference, settings: s, expectancy, now: Date.now() });
        eligible ||= scenario.eligibility === "ELIGIBLE";
        if (await this.repo.saveScenario(scope, scenario)) this.notify(scope, scenario.eligibility === "ELIGIBLE" ? "SCENARIO_ELIGIBLE" : "DECISION_CHANGED", zone.id);
      }
      if (zone.status !== "EXPIRED" && zone.touchedAt) {
        const status = eligible ? "ELIGIBLE" : reaction.behavior === "INSUFFICIENT_DATA" ? "EVALUATING" : "REJECTED";
        if (status !== zone.status || reaction.behavior !== zone.behavior || reaction.side !== zone.behaviorSide) {
          const changed = await this.repo.transition(scope, zone, { behavior: reaction.behavior, behaviorSide: reaction.side, status, reason: reaction.reason }, reaction.reason);
          if (changed) this.notify(scope, "ZONE_EVALUATION_CHANGED", zone.id);
        }
      }
    }
    if (now - state.lastAggregate >= s.aggregateSeconds * 1000) { await this.repo.aggregate(scope, movement, s); state.lastAggregate = now; }
    await this.schedule(state, market);
  }
  private async processJob() {
    if (this.researchBusy || !this.leader || this.stopped) return;
    this.researchBusy = true;
    try {
      const job = await this.repo.claim(swingAccountKey(), this.settings); if (!job) return;
      const scope = this.scope(job.user_id, job.instrument), monitor = await this.repo.monitor(scope);
      if (!monitor?.active) { await this.repo.finishJob(job, "Monitoring was stopped before research began.", false, this.settings); return; }
      let providerStarted = false;
      try {
        const previous = await this.repo.assessment(scope);
        let newsFingerprint: string | null = null;
        if (job.kind === "HOURLY_CHECK") {
          providerStarted = true;
          const news = await checkSwingNews(job.instrument, previous, this.settings, usage => this.repo.recordUsage(job, usage));
          const fingerprint = digest({ urls: news.sourceUrls.slice().sort(), facts: news.facts.map(f => f.toLowerCase().replace(/\s+/g, " ").trim()).sort() });
          await this.repo.event(scope, "NEWS_CHECKED", news.summary, `news-check:${job.id}`, { ...news, costedSearch: true });
          if (!news.material || fingerprint === monitor.scheduleState.newsFingerprint) { await this.repo.finishJob(job, null, false, this.settings); return; }
          newsFingerprint = fingerprint;
        }
        const data = await this.getData(job.instrument, true);
        const reliable = data.market.calendar.available && data.market.frames.D1.sufficient && data.market.frames.H4.sufficient && data.market.frames.H1.sufficient;
        if (!reliable) throw new Error("Reliable OANDA/cited calendar evidence is unavailable before research.");
        providerStarted = true;
        const result = await researchSwing(data, previous, this.settings, usage => this.repo.recordUsage(job, usage));
        const currentMonitor = await this.repo.monitor(scope);
        if (!currentMonitor?.active || !this.leader || this.stopped) throw new Error("Monitoring/worker ownership ended while research was running; result was not activated.");
        const latestMarket = currentMonitor.market ?? data.market;
        if (!swingAssessmentFresh(result.assessment, latestMarket) || latestMarket.frames.D1.condition !== data.market.frames.D1.condition || latestMarket.frames.H4.condition !== data.market.frames.H4.condition) throw new Error("Material release/structural evidence changed during research; the superseded assessment was not activated.");
        await this.repo.saveAssessment(scope, result.assessment, result.report, job);
        if (newsFingerprint) await this.repo.scheduleState(scope, { newsFingerprint });
        await this.repo.event(scope, "MARKET_BIAS_CHANGED", result.assessment.interpretation.explanation, `assessment:${result.assessment.id}`, {
          assessmentId: result.assessment.id, previousAssessmentId: previous?.id ?? null, previousLean: previous?.interpretation.combinedLean ?? null,
          lean: result.assessment.interpretation.combinedLean, changes: result.assessment.interpretation.changes });
        this.notify(scope, "MARKET_BIAS_CHANGED");
        await this.repo.finishJob(job, null, false, this.settings);
      } catch (error) {
        const message = safeSwingError(error);
        await this.repo.finishJob(job, message, !providerStarted && job.attempts < 3, this.settings);
        this.notify(scope, "RESEARCH_FAILED"); console.error("[swing] research failed", job.id, message);
      }
    } catch (error) { this.log(error); }
    finally { this.researchBusy = false; }
  }
  private log(error: unknown) { if (Date.now() - this.lastErrorLog > 30000) { this.lastErrorLog = Date.now(); console.error("[swing] analysis worker", safeSwingError(error)); } }
  private async pulse() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.acquire(); if (!this.leader) return;
      await this.leader.query("SELECT 1");
      const monitors = (await this.repo.active(swingAccountKey())).filter(m => this.settings.instruments.includes(m.instrument));
      const keys = new Set(monitors.map(m => this.key(m)));
      for (const key of this.states.keys()) if (!keys.has(key)) this.states.delete(key);
      for (const monitor of monitors) {
        const key = this.key(monitor);
        let state = this.states.get(key);
        if (!state) { state = { monitor, zones: [], assessment: null, signature: "", zoneSignature: "", risk: null, lastRiskAt: 0, touches: new Map(), lastMid: null, lastContinuity: this.movement.continuity(monitor.instrument), invalidations: new Map(), evaluations: new Map(), lastAggregate: 0 }; this.states.set(key, state); }
        state.monitor = monitor;
        const data = await this.getData(monitor.instrument);
        if (!this.leader || this.stopped) return;
        if (!monitor.market || monitor.market.capturedAt !== data.market.capturedAt) await this.repo.saveMarket(monitor, data.market);
        await this.evaluate(state, data);
      }
      if (Date.now() - this.lastPrune > 3600000) { await this.repo.prune(swingAccountKey(), this.settings); this.lastPrune = Date.now(); }
      void this.processJob();
    } catch (error) { this.log(error); if (this.leader) { this.leader.release(true); this.leader = null; } }
    finally { this.busy = false; }
  }
  start() {
    if (this.timer || !this.settings.enabled || process.env.SWING_ANALYSIS_WORKER_ENABLED !== "true" || !databaseConfigured()) return;
    this.stopped = false; this.timer = setInterval(() => void this.pulse(), 5000); this.timer.unref();
    void this.pulse();
  }
  async stop() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer); this.wakeTimer = null;
    const c = this.leader; this.leader = null;
    if (c) { await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`swing-runtime:${swingAccountKey()}`]).catch(() => undefined); c.release(); }
  }
}

// Kept outside the service class so reaction classification stays deterministic.
import { zoneReaction as zoneReactionFor } from "./decision.js";
