import type { PoolClient } from "pg";
import { db } from "../database.js";
import type { MarketStreamConfig } from "../market-stream-config.js";
import type { MarketPriceTick } from "../market-stream-types.js";
import { NEWS_TERMINAL, type NewsRun } from "../../../frontend/src/lib/news/news-straddle-v3.js";
import { accountKey, type BrokerTransaction } from "./broker.js";
import { NewsStraddleEngine } from "./engine.js";
import { liveEngineDeps } from "./service.js";
import { newsRuntimeStatus, PgNewsRepository } from "./store.js";
import { PREPARE_LEAD_MS, type NewsQuote } from "./policy.js";

/** A single account leader; per-run locks and durable submission markers remain the final authority. */
export function startNewsStraddleRuntime(config: MarketStreamConfig, tickFor: (instrument: string) => MarketPriceTick | null) {
  const key = accountKey(), deps = liveEngineDeps(), engine = new NewsStraddleEngine(deps);
  let stopped = false, leader: PoolClient | null = null, cached: NewsRun[] = [], cursor: string | null = null;
  let connected = false, lastStreamAt = 0, lastSync = 0, loading = false, syncing = false, acquiring = false;
  let calendarBusy = false, lastCalendar = 0;
  let streamController: AbortController | null = null;
  const configuredEntries = deps.entriesEnabled;
  deps.entriesEnabled = () => !stopped && !!leader && configuredEntries?.() !== false;
  const knownRuns = new Set<string>(), busy = new Set<string>();
  const status = () => ({ enabled: !stopped && config.environment === "practice" && process.env.NEWS_STRADDLE_V3_ENABLED !== "false", leader: !!leader, transactionStreamConnected: connected, ready: !!leader && connected && Date.now() - lastStreamAt < 10_000 && Date.now() - lastSync < 3000, lastReconciliationAt: lastSync ? new Date(lastSync).toISOString() : null });
  const quote = (instrument: string): NewsQuote | null => { const t = tickFor(instrument); return t?.source === "oanda" ? { bid: t.bid, ask: t.ask, time: t.time, tradeable: t.status.toLowerCase() === "tradeable" } : null; };
  const loseLeadership = () => { connected = false; lastSync = 0; streamController?.abort(); streamController = null; leader?.release(true); leader = null; cached = []; };
  const apply = async (tx: BrokerTransaction) => {
    // Matching occurs against the locked, latest run, so a fill arriving before
    // its HTTP acknowledgment is still matched to the preceding STOP transaction.
    for (const r of cached) await engine.observeTransaction(r.id, tx);
  };
  async function acquire() {
    if (acquiring || stopped || leader || config.environment !== "practice") return;
    acquiring = true;
    let c: PoolClient | null = null;
    try {
      c = await db().connect();
      if (!(await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok", [`news-v3-runtime:${key}`])).rows[0]!.ok) { c.release(); return; }
      if (!(await c.query<{ ready: boolean }>("SELECT to_regclass('news_straddle_runs') IS NOT NULL AS ready")).rows[0]!.ready) { await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`news-v3-runtime:${key}`]); c.release(); return; }
      leader = c; c.on("error", loseLeadership); cursor = (await newsRuntimeStatus(key)).transaction_cursor;
      knownRuns.clear(); await hydrate();
    } catch (e) { if (c && c !== leader) c.release(true); deps.log(e); }
    finally { acquiring = false; }
  }
  async function hydrate() {
    if (!leader || loading || stopped) return;
    loading = true;
    try {
      await leader.query("SELECT 1");
      cached = await new PgNewsRepository(key).active();
      for (const r of cached) if (!knownRuns.has(r.id)) {
        if (!/^\d+$/.test(r.transactionSeed)) { await engine.fail(r.id, "Broker transaction seed is invalid."); continue; }
        if (!cursor || BigInt(r.transactionSeed) < BigInt(cursor)) cursor = r.transactionSeed;
        knownRuns.add(r.id);
      }
      if (cached.length && !streamController) { streamController = new AbortController(); void transactionStream(streamController.signal).catch(deps.log); }
      if (!cached.length && streamController) { streamController.abort(); streamController = null; connected = false; }
    } catch (e) { deps.log(e); loseLeadership(); }
    finally { loading = false; }
  }
  async function synchronize() {
    if (!leader || syncing || stopped || !cached.length || !cursor) return;
    syncing = true;
    try {
      const r = await deps.broker.transactions(cursor);
      if (!/^\d+$/.test(r.lastTransactionID)) throw new Error("Broker returned an invalid transaction cursor.");
      for (const tx of r.transactions) await apply(tx);
      // Do not advance on failed processing or use stream heartbeat IDs: a
      // reconnect must replay every missed transaction before entries are allowed.
      await leader.query("INSERT INTO news_straddle_runtime(account_key,transaction_cursor) VALUES($1,$2) ON CONFLICT(account_key) DO UPDATE SET transaction_cursor=$2,updated_at=now()", [key, r.lastTransactionID]);
      cursor = r.lastTransactionID; lastSync = Date.now();
    } catch (e) { lastSync = 0; deps.log(e); }
    finally { syncing = false; }
  }
  async function verifyCalendar() {
    if (!leader || stopped || calendarBusy || !cached.length || Date.now() - lastCalendar < 5000) return;
    // Avoid adding calendar I/O or locks during the critical submission window.
    if (cached.some(r => Math.abs(Date.parse(r.targetSubmitAt) - Date.now()) < 1500)) return;
    calendarBusy = true; lastCalendar = Date.now();
    try { const calendar = await deps.calendar(); for (const r of cached) await engine.verifyCalendar(r.id, calendar); }
    catch (e) { deps.log(e); /* expiry is checked again before dispatch; never invent release data */ }
    finally { calendarBusy = false; }
  }
  async function transactionStream(signal: AbortSignal) {
    let retry = 250;
    while (!signal.aborted && leader && !stopped) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        if (!config.accountId || !config.apiKey || config.environment !== "practice") throw new Error("A practice transaction stream is required.");
        const r = await fetch(`https://stream-fxpractice.oanda.com/v3/accounts/${encodeURIComponent(config.accountId)}/transactions/stream`, { headers: { Authorization: `Bearer ${config.apiKey}`, "Accept-Datetime-Format": "RFC3339" }, signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) });
        if (!r.ok || !r.body) throw new Error(`Practice transaction stream returned ${r.status}.`);
        connected = true; lastStreamAt = Date.now(); lastSync = 0; await synchronize();
        reader = r.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; retry = 250;
        while (!signal.aborted) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Transaction heartbeat timed out.")), 12_000); })]).finally(() => { if (timer) clearTimeout(timer); });
          if (chunk.done) throw new Error("Transaction stream ended.");
          buffer += decoder.decode(chunk.value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); if (!line) continue;
            const tx = JSON.parse(line) as BrokerTransaction; lastStreamAt = Date.now();
            if (tx.type !== "HEARTBEAT") await apply(tx);
          }
        }
      } catch (e) { connected = false; lastSync = 0; if (!signal.aborted) deps.log(e); }
      finally { connected = false; await reader?.cancel().catch(() => undefined); }
      if (!signal.aborted) await new Promise<void>(resolve => { const t = setTimeout(resolve, retry); signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
      retry = Math.min(10_000, retry * 2);
    }
  }
  const dispatch = (r: NewsRun) => {
    if (busy.has(r.id) || !leader || stopped) return;
    busy.add(r.id);
    void engine.tick(r.id, quote(r.instrument), status().ready).catch(deps.log).finally(() => busy.delete(r.id));
  };
  const fast = setInterval(() => {
    const now = Date.now();
    for (const r of cached) {
      const target = Date.parse(r.targetSubmitAt);
      if (r.state === "SCHEDULED" && now >= Date.parse(r.release.time) - PREPARE_LEAD_MS || r.state === "PREPARING" && now >= target || r.state === "READY" && now >= target || r.state === "SUBMITTING" && now >= Date.parse(r.release.time)) dispatch(r);
    }
  }, 50);
  const slow = setInterval(() => {
    void acquire(); void hydrate(); void synchronize(); void verifyCalendar();
    for (const r of cached) { if (!NEWS_TERMINAL.includes(r.state)) { dispatch(r); void engine.reconcile(r.id).catch(deps.log); } }
  }, 1000);
  fast.unref(); slow.unref(); void acquire();
  return {
    status,
    onPrice(t: MarketPriceTick) {
      for (const r of cached) if (r.instrument === t.instrument && r.firstFillSide && ["OPEN", "OCO_CANCELLING", "TRAILING"].includes(r.state)) {
        const l = r.legs[r.firstFillSide];
        if (l.fillPrice !== null && !l.trailingRequestedAt) dispatch(r);
      }
    },
    async stop() { stopped = true; clearInterval(fast); clearInterval(slow); streamController?.abort(); const previousLeader = leader; leader = null; if (previousLeader) { await previousLeader.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`news-v3-runtime:${key}`]).catch(() => undefined); previousLeader.release(); } },
  };
}
