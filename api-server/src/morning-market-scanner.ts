import { randomUUID, timingSafeEqual } from "node:crypto";
import { db, query } from "./database.js";
import { discoverSelectionInstruments, evaluateSelection } from "./market-selection-service.js";
import { MARKET_SELECTION_VERSION, rankQualifiedMarkets } from "../../frontend/src/lib/strategy/ny-tradability.js";
import { morningDateKey, morningScanSlot, morningPicksState, type MorningScanRun, type MorningPicksSnapshot } from "../../frontend/src/lib/strategy/morning-scan.js";

const LOCK = 7190630;
export class MorningRefreshLimited extends Error {}
export function morningClosedDates() {
  return (process.env.MORNING_SCAN_CLOSED_DATES ?? "").split(",").map(s => s.trim()).filter(Boolean);
}
export function scheduledScanAuthorized(header: string | undefined) {
  const token = process.env.MORNING_SCAN_JOB_TOKEN;
  if (!token || !header) return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function morningPicksSnapshot(now = new Date()): Promise<MorningPicksSnapshot> {
  const [current, latest] = await Promise.all([
    query<{ snapshot: MorningScanRun }>("SELECT s.snapshot FROM morning_market_scan_current c JOIN morning_market_scans s ON s.id=c.scan_id WHERE c.singleton=true"),
    query<{ status: string; started_at: Date; error: string | null }>("SELECT status,started_at,error FROM morning_market_scans ORDER BY started_at DESC LIMIT 1"),
  ]);
  const run = current.rows[0]?.snapshot ?? null;
  const last = latest.rows[0];
  const abandoned = last?.status === "RUNNING" && now.getTime() - last.started_at.getTime() > 4 * 60_000;
  return { state: morningPicksState(run, last?.status === "FAILED" || Boolean(abandoned), now, morningClosedDates()), current: run,
    lastAttempt: last ? { status: abandoned ? "FAILED" : last.status, startedAt: last.started_at.toISOString(), error: abandoned ? "Scan interrupted before completion." : last.error } : null,
    refreshing: last?.status === "RUNNING" && !abandoned, checkedAt: now.toISOString() };
}

/** Session advisory lock spans the job: safe across replicas/restarts, released
 * by PostgreSQL if the process dies. One immutable run per version / 5m slot. */
export async function runMorningScan(source: "scheduled" | "manual", now = new Date(), dependencies = {
  discover: discoverSelectionInstruments, evaluate: (names: string[], signal?: AbortSignal) => evaluateSelection(names, signal, true), timeoutMs: 180_000,
}) {
  const slot = morningScanSlot(now, morningClosedDates());
  if (!slot) return morningPicksSnapshot(now);
  const client = await db().connect();
  let locked = false;
  let id: string | null = null;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Morning scan exceeded its deadline.")), dependencies.timeoutMs);
  try {
    await client.query("SET statement_timeout='15s'");
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [LOCK]);
    locked = Boolean(lock.rows[0]?.acquired);
    if (!locked) return morningPicksSnapshot(now);
    if (source === "manual") {
      const allowed = await client.query("UPDATE morning_market_scan_current SET manual_requested_at=now() WHERE singleton=true AND (manual_requested_at IS NULL OR manual_requested_at < now()-interval '60 seconds') RETURNING singleton");
      if (!allowed.rowCount) throw new MorningRefreshLimited("Refresh is limited to once per minute. The shared scan runs every five minutes.");
    }
    // Recover only abandoned attempts while owning the global job lock.
    await client.query("UPDATE morning_market_scans SET status='FAILED',completed_at=now(),error='Scan interrupted before completion.' WHERE status='RUNNING'");
    id = randomUUID();
    const inserted = await client.query("INSERT INTO morning_market_scans(id,job_key,date_et,version,source,started_at,status) VALUES($1,$2,$3,$4,$5,$6,'RUNNING') ON CONFLICT(job_key) DO NOTHING RETURNING id",
      [id, `${MARKET_SELECTION_VERSION}:${slot}`, morningDateKey(now), MARKET_SELECTION_VERSION, source, new Date(started)]);
    if (!inserted.rowCount) { id = null; return morningPicksSnapshot(); }
    console.log("[morning-scan] started", { id, slot, source });
    const instruments = await dependencies.discover(controller.signal);
    controller.signal.throwIfAborted();
    const result = await dependencies.evaluate(instruments, controller.signal);
    const shortlist = rankQualifiedMarkets(result.pairs).map(p => p.instrument);
    const failures = result.pairs.filter(p => p.selection?.dataFailure).map(p => `${p.instrument}: ${p.selection!.reasons.join(" ")}`);
    const closed = result.pairs.length > 0 && result.pairs.every(p => p.summary.includes("not tradeable"));
    const status = closed ? "CLOSED" : failures.length === instruments.length ? "FAILED" : failures.length ? "PARTIAL" : "SUCCESS";
    const counts = new Map<string, number>();
    for (const instrument of shortlist) for (const currency of instrument.split("_")) counts.set(currency, (counts.get(currency) ?? 0) + 1);
    const run: MorningScanRun = { id, dateEt: morningDateKey(now), version: MARKET_SELECTION_VERSION, mode: "Normal", startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(), durationMs: Date.now() - started, ...result, status, shortlist,
      sharedCurrencies: [...counts].filter(([, count]) => count > 1).map(([currency]) => currency).sort(), failures,
      error: status === "FAILED" ? "Required market or news data could not be verified for any instrument." : null };
    controller.signal.throwIfAborted();
    await client.query("BEGIN");
    await client.query("UPDATE morning_market_scans SET status=$2,completed_at=$3,snapshot=$4,error=$5 WHERE id=$1 AND status='RUNNING'", [id, status, run.completedAt, JSON.stringify(run), run.error]);
    if (status !== "FAILED") await client.query("UPDATE morning_market_scan_current SET scan_id=$1 WHERE singleton=true", [id]);
    await client.query("COMMIT");
    console.log("[morning-scan] completed", { id, status, durationMs: run.durationMs, instruments: instruments.length, qualified: shortlist.length, providerFailures: failures.length });
    return morningPicksSnapshot();
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof MorningRefreshLimited) throw error;
    const message = error instanceof Error ? error.message : "Morning scan failed.";
    if (id) await client.query("UPDATE morning_market_scans SET status='FAILED',completed_at=now(),error=$2 WHERE id=$1 AND status='RUNNING'", [id, message]);
    console.error("[morning-scan] failed", { id, durationMs: Date.now() - started, message });
    return morningPicksSnapshot();
  } finally {
    clearTimeout(timeout);
    let discard = false;
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      await client.query("RESET statement_timeout");
    } catch (error) { discard = true; throw error; }
    finally { client.release(discard); }
  }
}

export function startMorningScanner() {
  console.log("[morning-scan] scheduler enabled", { version: MARKET_SELECTION_VERSION, timeZone: "America/New_York", start: "06:30", end: "11:00", cadenceMinutes: 5 });
  const tick = () => {
    if (morningScanSlot(new Date(), morningClosedDates())) void runMorningScan("scheduled").catch(error => console.error("[morning-scan] scheduler failed", error));
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return timer;
}
