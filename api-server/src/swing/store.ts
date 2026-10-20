import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../database.js";
import type { SwingAssessment, SwingEvent, SwingExpectancy, SwingJob, SwingMarket, SwingMovement, SwingScenario, SwingStyle, SwingZone } from "../../../frontend/src/lib/swing-intelligence.js";
import type { MarketIntelligence } from "../intelligence/research-contract.js";
import { safeSwingError, type SwingSettings } from "./config.js";
import type { SwingResearchUsage } from "./research.js";
import { digest, SWING_STRATEGY_VERSION } from "./decision.js";

export type SwingScope = { userId: string; accountKey: string; instrument: string };
export type SwingMonitor = SwingScope & { active: boolean; style: SwingStyle; market: SwingMarket | null; assessmentId: string | null;
  unavailableZones: string[]; scheduleState: Record<string, unknown> };
export type SwingJobRow = { id: string; user_id: string; account_key: string; instrument: string; kind: SwingJob["kind"]; status: string;
  dedupe_key: string; lease_token: string | null; attempts: number; created_at: Date; completed_at: Date | null; error: string | null };
const args = (s: SwingScope) => [s.userId, s.accountKey, s.instrument];
const UTC_DAY_SQL = "(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";
const monitorRow = (r: { user_id: string; account_key: string; instrument: string; active: boolean; style: SwingStyle; market: SwingMarket | null;
  assessment_id: string | null; unavailable_zones: string[]; schedule_state: Record<string, unknown> }): SwingMonitor => ({ userId: r.user_id, accountKey: r.account_key,
  instrument: r.instrument, active: r.active, style: r.style, market: r.market, assessmentId: r.assessment_id, unavailableZones: r.unavailable_zones, scheduleState: r.schedule_state });

export class SwingRepository {
  async monitor(scope: SwingScope) {
    const r = (await query<Parameters<typeof monitorRow>[0]>("SELECT * FROM swing_monitors WHERE user_id=$1 AND account_key=$2 AND instrument=$3", args(scope))).rows[0];
    return r ? monitorRow(r) : null;
  }
  async active(account: string) {
    return (await query<Parameters<typeof monitorRow>[0]>("SELECT * FROM swing_monitors WHERE account_key=$1 AND active ORDER BY user_id,instrument", [account])).rows.map(monitorRow);
  }
  async setMonitor(scope: SwingScope, active: boolean, style: SwingStyle) {
    await query(`INSERT INTO swing_monitors(user_id,account_key,instrument,active,style,schedule_state) VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(user_id,account_key,instrument) DO UPDATE SET active=$4,style=$5,
      schedule_state=CASE WHEN $4 AND NOT swing_monitors.active THEN swing_monitors.schedule_state||$6::jsonb ELSE swing_monitors.schedule_state END,updated_at=now()`,
      [...args(scope), active, style, JSON.stringify({ campaign: randomUUID() })]);
  }
  async assessment(scope: SwingScope): Promise<SwingAssessment | null> {
    return (await query<{ snapshot: SwingAssessment }>(`SELECT a.snapshot FROM swing_monitors m JOIN swing_assessments a ON a.id=m.assessment_id
      AND a.user_id=m.user_id AND a.account_key=m.account_key AND a.instrument=m.instrument
      WHERE m.user_id=$1 AND m.account_key=$2 AND m.instrument=$3`, args(scope))).rows[0]?.snapshot ?? null;
  }
  async saveMarket(scope: SwingScope, market: SwingMarket) {
    const fingerprint = digest({ frames: market.frames, zones: market.structureZones, issues: market.issues, state: market.state });
    await transaction(async c => {
      await c.query("UPDATE swing_monitors SET market=$4::jsonb,market_updated_at=now(),updated_at=now() WHERE user_id=$1 AND account_key=$2 AND instrument=$3", [...args(scope), JSON.stringify(market)]);
      await c.query(`INSERT INTO swing_technical_snapshots(id,user_id,account_key,instrument,fingerprint,snapshot)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(user_id,account_key,instrument,fingerprint) DO NOTHING`, [randomUUID(), ...args(scope), fingerprint, JSON.stringify(market)]);
    });
  }
  async saveAssessment(scope: SwingScope, assessment: SwingAssessment, report: MarketIntelligence, job: SwingJobRow) {
    await transaction(async c => {
      const ownership = await c.query(`SELECT id FROM swing_research_jobs WHERE id=$1 AND lease_token=$2 AND status='RUNNING' AND lease_until>now()
        AND user_id=$3 AND account_key=$4 AND instrument=$5 FOR UPDATE`, [job.id, job.lease_token, ...args(scope)]);
      if (!ownership.rowCount) throw new Error("Research job ownership expired; assessment was not activated.");
      const monitor = (await c.query<{ active: boolean }>("SELECT active FROM swing_monitors WHERE user_id=$1 AND account_key=$2 AND instrument=$3 FOR UPDATE", args(scope))).rows[0];
      if (!monitor?.active) throw new Error("Analysis monitoring stopped; assessment was not activated.");
      await c.query("INSERT INTO swing_assessments(id,user_id,account_key,instrument,snapshot,fundamental_report,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)",
        [assessment.id, ...args(scope), JSON.stringify(assessment), JSON.stringify(report), assessment.createdAt, assessment.expiresAt]);
      for (const factor of report.factors) await c.query(`INSERT INTO swing_fundamental_evidence(assessment_id,factor_id,user_id,account_key,instrument,evidence,sources,observed_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [assessment.id, factor.id, ...args(scope), JSON.stringify(factor), JSON.stringify(report.sources.filter(s => factor.sourceIds.includes(s.id))), factor.observedAt]);
      await c.query("UPDATE swing_monitors SET assessment_id=$4,updated_at=now() WHERE user_id=$1 AND account_key=$2 AND instrument=$3", [...args(scope), assessment.id]);
    });
  }
  async zones(scope: SwingScope, includeExpired = false) {
    return (await query<{ snapshot: SwingZone }>(`SELECT snapshot FROM swing_zones WHERE user_id=$1 AND account_key=$2 AND instrument=$3
      ${includeExpired ? "" : "AND status<>'EXPIRED'"} ORDER BY created_at DESC LIMIT 40`, args(scope))).rows.map(r => r.snapshot);
  }
  async zone(scope: SwingScope, id: string) {
    return (await query<{ snapshot: SwingZone }>("SELECT snapshot FROM swing_zones WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND id=$4", [...args(scope), id])).rows[0]?.snapshot ?? null;
  }
  async syncZones(scope: SwingScope, next: SwingZone[], unavailable: string[]) {
    await transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`swing-zones:${args(scope).join(":")}`]);
      const monitor = (await c.query<{ active: boolean }>("SELECT active FROM swing_monitors WHERE user_id=$1 AND account_key=$2 AND instrument=$3 FOR UPDATE", args(scope))).rows[0];
      if (!monitor?.active) return;
      const old = (await c.query<{ snapshot: SwingZone }>("SELECT snapshot FROM swing_zones WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND status<>'EXPIRED' FOR UPDATE", args(scope))).rows.map(r => r.snapshot);
      for (const zone of old) {
        const replacement = next.find(n => n.generation === zone.generation);
        if (!replacement) {
          await this.writeZone(c, scope, { ...zone, revision: zone.revision + 1, status: "EXPIRED", validatedAt: new Date().toISOString(), reason: "Supporting structure or directional thesis changed; previous analysis is invalidated." });
          await this.insertEvent(c, scope, { kind: "SCENARIO_INVALIDATED", zoneId: zone.id, detail: "Supporting structure/thesis changed; the old zone is expired.", data: { previous: zone }, dedupe: `zone-expired:${zone.id}` });
          await c.query(`UPDATE swing_scenarios SET snapshot=jsonb_set(jsonb_set(snapshot,'{eligibility}','"INVALIDATED"'),'{blockers}','["Supporting zone expired."]'),updated_at=now()
            WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND zone_id=$4`, [...args(scope), zone.id]);
        } else await this.writeZone(c, scope, { ...zone, assessmentId: replacement.assessmentId, validatedAt: replacement.validatedAt,
          fundamentalContext: replacement.fundamentalContext, revision: zone.revision + 1 });
      }
      for (const zone of next.filter(n => !old.some(z => z.generation === n.generation))) {
        const inserted = await c.query(`INSERT INTO swing_zones(id,user_id,account_key,instrument,generation,classification,status,revision,snapshot,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10) ON CONFLICT(user_id,account_key,instrument,generation,classification) DO NOTHING RETURNING id`,
          [zone.id, ...args(scope), zone.generation, zone.classification, zone.status, zone.revision, JSON.stringify(zone), zone.createdAt]);
        if (inserted.rowCount) await this.insertEvent(c, scope, { kind: "ZONE_CREATED", zoneId: zone.id, detail: zone.reason, data: { zone }, dedupe: `zone-created:${zone.id}` });
        else unavailable.push(`${zone.classification}: this exact structural scenario was previously expired; awaiting genuinely new structure.`);
      }
      await c.query("UPDATE swing_monitors SET unavailable_zones=$4::jsonb,updated_at=now() WHERE user_id=$1 AND account_key=$2 AND instrument=$3", [...args(scope), JSON.stringify(unavailable)]);
    });
  }
  private async writeZone(c: PoolClient, scope: SwingScope, zone: SwingZone) {
    await c.query("UPDATE swing_zones SET status=$5,revision=$6,snapshot=$7::jsonb,updated_at=$8 WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND id=$4",
      [...args(scope), zone.id, zone.status, zone.revision, JSON.stringify(zone), zone.validatedAt]);
  }
  async transition(scope: SwingScope, previous: SwingZone, changes: Partial<SwingZone>, detail: string, data: Record<string, unknown> = {}) {
    return transaction(async c => {
      const current = (await c.query<{ snapshot: SwingZone }>("SELECT snapshot FROM swing_zones WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND id=$4 FOR UPDATE", [...args(scope), previous.id])).rows[0]?.snapshot;
      if (!current || current.revision !== previous.revision || current.status === "EXPIRED") return null;
      const active = (await c.query<{ active: boolean }>("SELECT active FROM swing_monitors WHERE user_id=$1 AND account_key=$2 AND instrument=$3", args(scope))).rows[0]?.active;
      if (!active && changes.status !== "EXPIRED") return null;
      const next = { ...current, ...changes, id: current.id, lower: current.lower, upper: current.upper, revision: current.revision + 1, validatedAt: new Date().toISOString() };
      await this.writeZone(c, scope, next);
      await this.insertEvent(c, scope, { kind: next.status === "TOUCHED" ? "ZONE_TOUCHED" : next.status === "EXPIRED" ? "SCENARIO_INVALIDATED" : "ZONE_EVALUATION_CHANGED", zoneId: next.id,
        detail, data: { ...data, from: current.status, to: next.status, behavior: next.behavior }, dedupe: `zone-revision:${next.id}:${next.revision}` });
      return next;
    });
  }
  async expireAll(scope: SwingScope, reason: string) {
    await transaction(async c => {
      const zones = (await c.query<{ snapshot: SwingZone }>("SELECT snapshot FROM swing_zones WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND status<>'EXPIRED' FOR UPDATE", args(scope))).rows;
      for (const row of zones) {
        const zone = { ...row.snapshot, status: "EXPIRED" as const, reason, validatedAt: new Date().toISOString(), revision: row.snapshot.revision + 1 };
        await this.writeZone(c, scope, zone);
        await this.insertEvent(c, scope, { kind: "SCENARIO_INVALIDATED", zoneId: zone.id, detail: reason, data: { zoneId: zone.id }, dedupe: `zone-expired:${zone.id}` });
      }
      await c.query(`UPDATE swing_scenarios SET snapshot=jsonb_set(jsonb_set(snapshot,'{eligibility}','"INVALIDATED"'),'{blockers}',$4::jsonb),updated_at=now()
        WHERE user_id=$1 AND account_key=$2 AND instrument=$3`, [...args(scope), JSON.stringify([reason])]);
    });
  }
  private async insertEvent(c: Pick<PoolClient, "query">, scope: SwingScope, event: { kind: string; zoneId?: string | null; detail: string; data: Record<string, unknown>; dedupe: string }) {
    const at = new Date().toISOString(), id = randomUUID();
    await c.query(`INSERT INTO swing_zone_events(id,user_id,account_key,instrument,zone_id,dedupe_key,kind,detail,data,at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT(user_id,account_key,instrument,dedupe_key) DO NOTHING`,
      [id, ...args(scope), event.zoneId ?? null, event.dedupe, event.kind, event.detail, JSON.stringify(event.data), at]);
  }
  async event(scope: SwingScope, kind: string, detail: string, dedupe: string, data: Record<string, unknown> = {}) { await transaction(c => this.insertEvent(c, scope, { kind, detail, dedupe, data })); }
  async events(scope: SwingScope, zoneId?: string) {
    return (await query<{ id: string; at: Date; kind: string; zone_id: string | null; detail: string; data: Record<string, unknown> }>(`SELECT id,at,kind,zone_id,detail,data FROM swing_zone_events
      WHERE user_id=$1 AND account_key=$2 AND instrument=$3 ${zoneId ? "AND zone_id=$4" : ""} ORDER BY at DESC LIMIT 60`, [...args(scope), ...(zoneId ? [zoneId] : [])])).rows.map(r => ({ id: r.id, at: r.at.toISOString(), kind: r.kind, zoneId: r.zone_id, detail: r.detail, data: r.data } satisfies SwingEvent));
  }
  async saveScenario(scope: SwingScope, scenario: SwingScenario) {
    return transaction(async c => {
      const ownership = (await c.query<{ active: boolean; status: string }>(`SELECT m.active,z.status FROM swing_zones z JOIN swing_monitors m
        ON m.user_id=z.user_id AND m.account_key=z.account_key AND m.instrument=z.instrument
        WHERE z.user_id=$1 AND z.account_key=$2 AND z.instrument=$3 AND z.id=$4 FOR UPDATE OF z`, [...args(scope), scenario.zoneId])).rows[0];
      if (!ownership) return false;
      if (!ownership.active || ownership.status === "EXPIRED") scenario = { ...scenario, eligibility: "INVALIDATED", blockers: [...scenario.blockers, "Monitoring stopped or the supporting zone expired."] };
      const signature = digest([scenario.eligibility, scenario.preference, scenario.style, scenario.blockers, scenario.support, scenario.contradictions]);
      const previous = (await c.query<{ signature: string }>("SELECT signature FROM swing_scenarios WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND id=$4 FOR UPDATE", [...args(scope), scenario.id])).rows[0];
      await c.query(`INSERT INTO swing_scenarios(id,user_id,account_key,instrument,zone_id,side,signature,snapshot,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        ON CONFLICT(id) DO UPDATE SET signature=$7,snapshot=$8::jsonb,updated_at=$9 WHERE swing_scenarios.user_id=$2 AND swing_scenarios.account_key=$3 AND swing_scenarios.instrument=$4`,
        [scenario.id, ...args(scope), scenario.zoneId, scenario.side, signature, JSON.stringify(scenario), scenario.asOf]);
      if (previous?.signature !== signature) await this.insertEvent(c, scope, { kind: scenario.eligibility === "ELIGIBLE" ? "SCENARIO_ELIGIBLE" : scenario.eligibility === "INVALIDATED" ? "SCENARIO_INVALIDATED" : "DECISION_CHANGED",
        zoneId: scenario.zoneId, detail: `${scenario.side}: ${scenario.eligibility}. ${scenario.blockers[0] ?? scenario.support.at(-1) ?? "Conditional analysis only."}`, data: { scenario }, dedupe: `decision:${scenario.id}:${signature}:${previous?.signature ?? "initial"}` });
      return previous?.signature !== signature;
    });
  }
  async scenarios(scope: SwingScope) {
    return (await query<{ snapshot: SwingScenario }>(`SELECT s.snapshot FROM swing_scenarios s JOIN swing_zones z ON z.id=s.zone_id
      WHERE s.user_id=$1 AND s.account_key=$2 AND s.instrument=$3 AND z.status<>'EXPIRED' ORDER BY s.updated_at DESC LIMIT 4`, args(scope))).rows.map(r => r.snapshot);
  }
  async aggregate(scope: SwingScope, movement: SwingMovement, settings: SwingSettings) {
    const bucket = new Date(Math.floor(Date.parse(movement.asOf) / (settings.aggregateSeconds * 1000)) * settings.aggregateSeconds * 1000).toISOString();
    await query(`INSERT INTO swing_movement_aggregates(user_id,account_key,instrument,bucket,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(user_id,account_key,instrument,bucket) DO NOTHING`, [...args(scope), bucket, JSON.stringify({ ...movement,
        summaries: movement.summaries.filter(summary => !movement.summaries.some(other => other.timeframe === summary.timeframe && other.bucket > summary.bucket)) })]);
  }
  async expectancy(scope: SwingScope, style: SwingStyle, side: "BUY" | "SELL"): Promise<SwingExpectancy | undefined> {
    const row = (await query<{ sample_size: number; expectancy_r: string; win_rate: string | null; source: string; validated_at: Date }>(`SELECT sample_size,expectancy_r::text,win_rate::text,source,validated_at FROM swing_expectancy
      WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND strategy_version=$4 AND style=$5 AND side=$6`, [...args(scope), SWING_STRATEGY_VERSION, style, side])).rows[0];
    return row ? { status: "VALIDATED", strategyVersion: SWING_STRATEGY_VERSION, sampleSize: row.sample_size, expectancyR: Number(row.expectancy_r), winRate: row.win_rate === null ? null : Number(row.win_rate), validatedAt: row.validated_at.toISOString(), source: row.source } : undefined;
  }
  async queue(scope: SwingScope, kind: SwingJob["kind"], key: string, settings: SwingSettings) {
    return transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`swing-budget:${scope.accountKey}`]);
      const existing = (await c.query<SwingJobRow>(`SELECT * FROM swing_research_jobs WHERE user_id=$1 AND account_key=$2 AND instrument=$3
        AND (status IN ('QUEUED','RUNNING') OR dedupe_key=$4) ORDER BY created_at DESC LIMIT 1`, [...args(scope), key])).rows[0];
      if (existing) return this.jobView(existing);
      const usage = (await c.query<{ jobs: string; cost: string; reserved: string; unknown: string }>(`SELECT
        (SELECT count(*) FROM swing_research_jobs WHERE account_key=$1 AND created_at>=${UTC_DAY_SQL} AND status<>'BUDGET_BLOCKED')::text jobs,
        (SELECT COALESCE(sum(cost_usd),0) FROM swing_ai_usage WHERE account_key=$1 AND created_at>=${UTC_DAY_SQL})::text cost,
        (SELECT COALESCE(sum(reserved_usd),0) FROM swing_research_jobs j WHERE account_key=$1 AND created_at>=${UTC_DAY_SQL} AND status IN ('QUEUED','RUNNING'))::text reserved,
        (SELECT count(*) FROM swing_research_jobs j WHERE account_key=$1 AND created_at>=${UTC_DAY_SQL}
          AND (status='FAILED' OR EXISTS(SELECT 1 FROM swing_ai_usage u WHERE u.job_id=j.id AND u.cost_usd IS NULL)))::text unknown`, [scope.accountKey])).rows[0];
      const costsKnown = [process.env.OPENAI_PRICE_INPUT_PER_MTOK, process.env.OPENAI_PRICE_OUTPUT_PER_MTOK, process.env.OPENAI_PRICE_WEB_SEARCH_CALL].every(v => v?.trim() && Number.isFinite(Number(v)) && Number(v) >= 0);
      const blocked = Number(usage.jobs) >= settings.dailyResearchLimit || settings.maxDailyUsd !== null && (!costsKnown || Number(usage.cost) + Number(usage.reserved) + Number(usage.unknown) * settings.requestReserveUsd + settings.requestReserveUsd > settings.maxDailyUsd);
      const error = blocked ? "Research budget/count limit reached, or model/search prices required by the USD budget are unavailable." : null;
      const row = (await c.query<SwingJobRow>(`INSERT INTO swing_research_jobs(id,user_id,account_key,instrument,kind,status,dedupe_key,reserved_usd,error)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), ...args(scope), kind, blocked ? "BUDGET_BLOCKED" : "QUEUED", key, settings.requestReserveUsd, error])).rows[0];
      return this.jobView(row);
    });
  }
  async claim(account: string, settings: SwingSettings) {
    // A crash/timeout has uncertain provider billing. Never blindly replay it.
    await query(`UPDATE swing_research_jobs SET status='FAILED',error='Previous worker ended with an uncertain provider outcome; request a new assessment explicitly.',completed_at=now()
      WHERE account_key=$1 AND status='RUNNING' AND lease_until<now()`, [account]);
    return transaction(async c => {
      const row = (await c.query<SwingJobRow>("SELECT * FROM swing_research_jobs WHERE account_key=$1 AND status='QUEUED' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED", [account])).rows[0];
      if (!row) return null;
      const token = randomUUID();
      return (await c.query<SwingJobRow>("UPDATE swing_research_jobs SET status='RUNNING',lease_token=$2,lease_until=now()+$3::double precision*interval '1 millisecond',started_at=COALESCE(started_at,now()),attempts=attempts+1 WHERE id=$1 RETURNING *", [row.id, token, settings.researchTimeoutMs * 3 + 60000])).rows[0];
    });
  }
  async finishJob(job: SwingJobRow, error: string | null, retry: boolean, settings: SwingSettings) {
    await query(`UPDATE swing_research_jobs SET status=$3,error=$4,completed_at=CASE WHEN $3='QUEUED' THEN NULL ELSE now() END,
      next_attempt_at=now()+$5::double precision*interval '1 millisecond',lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND lease_token=$2 AND user_id=$6 AND account_key=$7`, [job.id, job.lease_token, retry ? "QUEUED" : error ? "FAILED" : "COMPLETED", error, settings.retryMs * 2 ** Math.min(job.attempts - 1, 4), job.user_id, job.account_key]);
  }
  async recordUsage(job: SwingJobRow, usage: SwingResearchUsage) {
    await query(`INSERT INTO swing_ai_usage(job_id,user_id,account_key,instrument,stage,model,input_tokens,output_tokens,searches,latency_ms,cost_usd,success,error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [job.id, job.user_id, job.account_key, job.instrument, usage.stage, usage.model,
      usage.inputTokens, usage.outputTokens, usage.webSearchCalls, usage.latencyMs, usage.costUsd, usage.success, usage.error ? safeSwingError(usage.error) : null]);
  }
  jobView(row: SwingJobRow): SwingJob { return { id: row.id, kind: row.kind, status: row.status, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null, error: row.error }; }
  async latestJob(scope: SwingScope) {
    const row = (await query<SwingJobRow>("SELECT * FROM swing_research_jobs WHERE user_id=$1 AND account_key=$2 AND instrument=$3 ORDER BY created_at DESC LIMIT 1", args(scope))).rows[0];
    return row ? this.jobView(row) : null;
  }
  async usage(scope: SwingScope) {
    const r = (await query<{ requests: string; input: string; output: string; searches: string; cost: string; unknown: string; latency: string }>(`SELECT count(*)::text requests,
      COALESCE(sum(input_tokens),0)::text input,COALESCE(sum(output_tokens),0)::text output,COALESCE(sum(searches),0)::text searches,
      COALESCE(sum(cost_usd),0)::text cost,count(*) FILTER(WHERE cost_usd IS NULL)::text unknown,COALESCE(sum(latency_ms),0)::text latency
      FROM swing_ai_usage WHERE user_id=$1 AND account_key=$2 AND instrument=$3 AND created_at>=${UTC_DAY_SQL}`, args(scope))).rows[0];
    return { requests: Number(r.requests), inputTokens: Number(r.input), outputTokens: Number(r.output), searches: Number(r.searches), knownCostUsd: Number(r.cost), unknownCostRequests: Number(r.unknown), latencyMs: Number(r.latency) };
  }
  async scheduleState(scope: SwingScope, state: Record<string, unknown>) { await query("UPDATE swing_monitors SET schedule_state=schedule_state||$4::jsonb WHERE user_id=$1 AND account_key=$2 AND instrument=$3", [...args(scope), JSON.stringify(state)]); }
  async prune(account: string, settings: SwingSettings) {
    await query("DELETE FROM swing_movement_aggregates WHERE account_key=$1 AND bucket<now()-$2::int*interval '1 day'", [account, settings.retentionDays]);
  }
}
