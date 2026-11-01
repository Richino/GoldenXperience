import { createHash, randomUUID } from "node:crypto";
import { query, transaction } from "./database.js";
import { getCandles, getPricing } from "../../frontend/src/lib/oanda/client.js";
import { INSTRUMENT_CATALOG } from "../../frontend/src/lib/instruments/catalog.js";
import { marketQuality } from "../../frontend/src/lib/technical-analyzer/quality.js";
import { analyzeFrame, buildForecast, dataWarnings, FRAMES, metrics, MODEL_VERSION, score } from "../../frontend/src/lib/technical-analyzer/engine.js";
import type { Frame, History, HistoryRow, MetricObservation, Snapshot } from "../../frontend/src/lib/technical-analyzer/types.js";
import { expiryCandle } from "../../frontend/src/lib/technical-analyzer/validation.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

const historyCache = new Map<string, { expires: number; data: ReturnType<typeof getCandles> }>();
const flights = new Map<string, Promise<Snapshot>>();
function accountKey() {
  if (process.env.OANDA_ENVIRONMENT === "live") throw new Error("GX Technical Analyzer requires the OANDA Practice connection.");
  if (!process.env.OANDA_ACCOUNT_ID) throw new Error("OANDA Practice account is not configured.");
  return createHash("sha256").update(process.env.OANDA_ACCOUNT_ID).digest("hex").slice(0, 24);
}
function candles(instrument: string, frame: Frame, to?: string) {
  const key = `${accountKey()}:${instrument}:${frame}:${to ?? "latest"}`;
  const old = historyCache.get(key);
  if (old && old.expires > Date.now()) return old.data;
  const data = getCandles(instrument as MajorInstrument, frame, to ? 5 : 420, { to });
  historyCache.set(key, { expires: Date.now() + (to ? 3600000 : 60000), data });
  void data.then(r => { if (r.status.state !== "connected") historyCache.delete(key); }, () => historyCache.delete(key));
  if (historyCache.size > 600) historyCache.delete(historyCache.keys().next().value!);
  return data;
}

export function runTechnicalAnalysis(userId: string, instrument: string) {
  const key = `${userId}:${accountKey()}:${instrument}`;
  const existing = flights.get(key);
  if (existing) return existing;
  const request = analyze(userId, instrument);
  flights.set(key, request);
  void request.finally(() => flights.delete(key)).catch(() => {});
  return request;
}

async function analyze(userId: string, instrument: string): Promise<Snapshot> {
  const info = INSTRUMENT_CATALOG.find(i => i.name === instrument);
  if (!info) throw new Error("Choose a supported forex pair.");
  const account = accountKey();
  const [quoteResult, ...series] = await Promise.all([getPricing([instrument as MajorInstrument]), ...FRAMES.map(f => candles(instrument, f))]);
  const quote = quoteResult.data.find(q => q.instrument === instrument);
  if (quoteResult.status.state !== "connected" || !quote || quote.source !== "oanda" || ![quote.bid, quote.ask, quote.mid].every(v => Number.isFinite(v) && v > 0)
    || quote.ask < quote.bid || !Number.isFinite(Date.parse(quote.time))) throw new Error("Verified OANDA quote unavailable; no forecast was issued.");
  const now = Date.now(), pip = 10 ** info.pipLocation;
  if (Date.parse(quote.time) > now + 10000) throw new Error("OANDA quote timestamp is in the future.");
  const warnings: string[] = [];
  const frames = {} as Snapshot["frames"];
  for (let i = 0; i < FRAMES.length; i++) {
    const result = series[i], frame = FRAMES[i];
    if (result.status.state !== "connected" || result.data.source !== "oanda") throw new Error(`${frame}: verified OANDA history unavailable.`);
    const confirmed = result.data.candles.filter(c => c.complete);
    warnings.push(...dataWarnings(confirmed, frame, now));
    frames[frame] = analyzeFrame(confirmed, frame, quote.mid, pip);
  }
  const quality = marketQuality(now, quote.time, quote.status === "tradeable", warnings);
  warnings.push(...quality.scoringReasons);
  const { eligible } = quality;
  const snapshot: Snapshot = { id: randomUUID(), modelVersion: MODEL_VERSION, instrument, createdAt: new Date(now).toISOString(), marketAt: quote.time,
    source: "OANDA Practice", referencePrice: quote.mid, spreadPips: (quote.ask - quote.bid) / pip, pip, precision: info.displayPrecision,
    freshness: !quality.marketOpen ? "MARKET CLOSED" : quality.quoteFresh ? "FRESH" : "STALE", warnings, ...quality, frames, forecasts: [],
    baseline: frames.D.close >= frames.D.ema20 ? "BULLISH" : "BEARISH" };
  snapshot.forecasts = ([1, 2, 3, 4, 5] as const).map(h => buildForecast(snapshot, h));
  // One observation per hour/pair/model and completed-candle set. Repeated clicks
  // return the original stored report, including its original reference quote.
  const fingerprint = createHash("sha256").update(JSON.stringify({ instrument, model: MODEL_VERSION, hour: Math.floor(now / 3600000),
    candles: FRAMES.map(f => frames[f].lastOpen), eligible })).digest("hex");
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gx-technical:${userId}:${account}:${fingerprint}`]);
    const prior = await client.query<{ snapshot: Snapshot }>("SELECT snapshot FROM gx_technical_forecasts WHERE user_id=$1 AND account_key=$2 AND fingerprint=$3 LIMIT 1", [userId, account, fingerprint]);
    if (prior.rows[0]) return prior.rows[0].snapshot;
    for (const f of snapshot.forecasts) await client.query(`INSERT INTO gx_technical_forecasts
      (id,user_id,account_key,instrument,model_version,created_at,expires_at,horizon,eligible,fingerprint,snapshot,forecast)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
    [`${snapshot.id}:${f.horizon}`, userId, account, instrument, MODEL_VERSION, snapshot.createdAt, f.expiresAt, f.horizon, eligible, fingerprint, JSON.stringify(snapshot), JSON.stringify(f)]);
    return snapshot;
  });
}

export async function technicalHistory(userId: string, instrument?: string): Promise<History> {
  const account = accountKey();
  const due = await query<HistoryRow>(`SELECT f.id,f.snapshot,f.forecast FROM gx_technical_forecasts f
    LEFT JOIN gx_technical_outcomes o ON o.forecast_id=f.id
    LEFT JOIN gx_technical_evaluation_attempts a ON a.forecast_id=f.id
    WHERE f.user_id=$1 AND f.account_key=$2 AND o.forecast_id IS NULL AND f.expires_at <= now()
    AND (a.retry_after IS NULL OR a.retry_after <= now())
    ORDER BY f.expires_at LIMIT 50`, [userId, account]);
  const scoringWarnings: string[] = [];
  async function retry(id: string, reason: string) {
    await query(`INSERT INTO gx_technical_evaluation_attempts(forecast_id,retry_after,last_reason) VALUES($1,now()+interval '6 hours',$2)
      ON CONFLICT(forecast_id) DO UPDATE SET attempts=gx_technical_evaluation_attempts.attempts+1,retry_after=EXCLUDED.retry_after,last_reason=EXCLUDED.last_reason`, [id, reason]);
  }
  // Bounded work per refresh. Missing holiday/session candles stay pending.
  for (const row of due.rows) {
    try {
      const result = await candles(row.snapshot.instrument, "D", new Date(Date.parse(row.forecast.expiresAt) + 1000).toISOString());
      if (result.status.state !== "connected" || result.data.source !== "oanda") throw new Error("OANDA scoring data unavailable.");
      const b = expiryCandle(result.data.candles, row.forecast.expiresAt, Date.now());
      if (!b) { scoringWarnings.push(`${row.snapshot.instrument}: exact expiry close unavailable; remains pending, retry in six hours.`); await retry(row.id, "Exact daily expiry candle unavailable."); continue; }
      dataWarnings([b], "D", Date.now());
      const outcome = score(row.snapshot.referencePrice, row.forecast, b.close, row.forecast.expiresAt);
      outcome.baselineCorrect = row.snapshot.baseline === "BULLISH" ? outcome.direction === "UP" : outcome.direction === "DOWN";
      await query("INSERT INTO gx_technical_outcomes(forecast_id,outcome) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING", [row.id, JSON.stringify(outcome)]);
    } catch { scoringWarnings.push(`${row.snapshot.instrument}: evaluation unavailable; original forecast retained and unscored.`); await retry(row.id, "OANDA evaluation unavailable."); }
  }
  const all = await query<HistoryRow & { total: string }>(`SELECT f.id,f.snapshot,f.forecast,o.outcome,count(*) OVER() AS total FROM gx_technical_forecasts f
    LEFT JOIN gx_technical_outcomes o ON o.forecast_id=f.id WHERE f.user_id=$1 AND f.account_key=$2
    ${instrument ? "AND f.instrument=$3" : ""} ORDER BY f.created_at DESC LIMIT 100`, [userId, account, ...(instrument ? [instrument] : [])]);
  const observations = await query<MetricObservation>(`SELECT jsonb_build_object('eligible',eligible,'instrument',instrument,'createdAt',created_at) AS snapshot,
    jsonb_build_object('bias',forecast->>'bias','horizon',horizon,'regime',forecast->>'regime','expiresAt',expires_at,'lean',forecast->'lean') AS forecast,o.outcome
    FROM gx_technical_forecasts f LEFT JOIN gx_technical_outcomes o ON o.forecast_id=f.id
    WHERE f.user_id=$1 AND f.account_key=$2 AND f.model_version=$3 ${instrument ? "AND f.instrument=$4" : ""}`, [userId, account, MODEL_VERSION, ...(instrument ? [instrument] : [])]);
  return { rows: all.rows.map(({ total: _total, ...r }) => r), total: Number(all.rows[0]?.total ?? 0), metrics: metrics(observations.rows), scoringWarnings: [...new Set(scoringWarnings)] };
}
