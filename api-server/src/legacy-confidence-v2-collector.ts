/**
 * Legacy-confidence-v2 collector.
 *
 * The runtime entry point for the live daemon — one cycle = one fetch/detect/decide
 * pass across all pairs. Called from server.ts on a 15-minute interval and
 * from scripts/run-legacy-confidence-v2-daemon.ts for manual invocations.
 *
 * When LEGACY_CONFIDENCE_V2_DRY_RUN is true (default), decisions are logged
 * to stdout only. Set the env var to "false" to actually open paper trades
 * via legacy-confidence-v2-executor.
 */
import type { LegacyCandle } from "./legacy-setup-detector.js";
import { evaluateLegacySetup, atr, rsi, ema, pipSize } from "./legacy-setup-detector.js";
import { decideDirection, loadLegacyConfidenceArtifact, artifactAgeDays, type LegacyConfidenceFeatures } from "./legacy-confidence-v2.js";
import { openLegacyConfidenceV2Trade } from "./legacy-confidence-v2-executor.js";
import { query } from "./database.js";

const env = (k: string) => process.env[k]?.trim().replace(/^["']|["']$/g, "") ?? "";

const ALL_PAIRS = ["USD_JPY", "AUD_USD", "EUR_USD", "GBP_USD", "USD_CAD", "USD_CHF", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_GBP", "NZD_USD", "XAU_USD"];
const GRAN_MIN: Record<string, number> = { M15: 15, H1: 60, H4: 240 };

async function fetchCandles(inst: string, gran: string, count: number, token: string, host: string): Promise<LegacyCandle[]> {
  const url = `${host}/v3/instruments/${inst}/candles?price=BA&granularity=${gran}&count=${count}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const j = await r.json() as { candles?: Array<Record<string, never>> };
  const step = GRAN_MIN[gran]! * 60_000;
  return (j.candles ?? []).filter((c) => (c as never as { complete: boolean }).complete).map((c) => {
    const x = c as never as { time: string; bid: Record<string, string>; ask: Record<string, string> };
    const mid = (b: number, a: number) => (b + a) / 2;
    return {
      closeTime: new Date(Date.parse(x.time) + step).toISOString(),
      open: mid(+x.bid.o, +x.ask.o), high: mid(+x.bid.h, +x.ask.h), low: mid(+x.bid.l, +x.ask.l), close: mid(+x.bid.c, +x.ask.c),
      bidOpen: +x.bid.o, bidHigh: +x.bid.h, bidLow: +x.bid.l, bidClose: +x.bid.c,
      askOpen: +x.ask.o, askHigh: +x.ask.h, askLow: +x.ask.l, askClose: +x.ask.c,
    };
  });
}

function etHourOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}
function etDayOf(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[wd] ?? 0;
}
function computeFeatures(m15: LegacyCandle[]): LegacyConfidenceFeatures | null {
  const i = m15.length - 1;
  if (i < 500) return null;
  const closes = m15.map((b) => b.close);
  const a14 = atr(m15, 14);
  const a50 = atr(m15, 50);
  const r14 = rsi(closes, 14);
  const atr14V = a14[i]!; const atr50V = a50[i]!; const closeV = closes[i]!;
  const rsiV = r14[i]!; const rsiPrev = r14[i - 3]; const closePrev3 = closes[i - 3];
  if (![atr14V, atr50V, closeV, rsiV, rsiPrev, closePrev3].every((x) => Number.isFinite(x as number))) return null;
  const atrHist = a14.slice(Math.max(0, i - 500), i).filter((v) => Number.isFinite(v));
  if (atrHist.length < 100) return null;
  let count = 0;
  for (const v of atrHist) if (v <= atr14V) count++;
  const atrPct = count / atrHist.length;
  const atrRatio = atr14V / atr50V;
  const rangeWin = m15.slice(Math.max(0, i - 20), i);
  const rangeHi = Math.max(...rangeWin.map((b) => b.high));
  const rangeLo = Math.min(...rangeWin.map((b) => b.low));
  const rangePos = rangeHi > rangeLo ? (closeV - rangeLo) / (rangeHi - rangeLo) : 0.5;
  const rsiVelocity = (rsiV - (rsiPrev as number)) / 3;
  const mom3 = (closeV - (closePrev3 as number)) / closeV;
  const iso = m15[i]!.closeTime;
  return { atrPct, atrRatio, hourEt: etHourOf(iso), dayOfWeek: etDayOf(iso), rsiVelocity, rangePos, mom3 };
}

export type LegacyConfidenceV2CollectResult = {
  ran: boolean;
  reason?: string;
  pairsChecked: number;
  setupsFired: number;
  tradesOpened: number;
  skipped: number;
  errors: number;
};

type IndicatorSnapshot = {
  m15BarTime: string | null;
  m15Ema21: number | null; m15Ema50: number | null; m15Ema200: number | null;
  h1Ema21: number | null; h1Ema50: number | null;
  h4Ema21: number | null; h4Ema50: number | null;
  atr14: number | null; atrPips: number | null; rsi14: number | null; spreadPips: number | null;
};

function snapshotIndicators(pair: string, m15: LegacyCandle[], h1: LegacyCandle[], h4: LegacyCandle[]): IndicatorSnapshot {
  const empty: IndicatorSnapshot = {
    m15BarTime: null,
    m15Ema21: null, m15Ema50: null, m15Ema200: null,
    h1Ema21: null, h1Ema50: null, h4Ema21: null, h4Ema50: null,
    atr14: null, atrPips: null, rsi14: null, spreadPips: null,
  };
  if (m15.length === 0) return empty;
  const last = m15[m15.length - 1]!;
  const closes15 = m15.map((b) => b.close);
  const e21 = m15.length >= 21 ? ema(closes15, 21).at(-1)! : null;
  const e50 = m15.length >= 50 ? ema(closes15, 50).at(-1)! : null;
  const e200 = m15.length >= 200 ? ema(closes15, 200).at(-1)! : null;
  const a14series = m15.length >= 14 ? atr(m15, 14) : null;
  const atr14V = a14series ? (a14series.at(-1) ?? null) : null;
  const rsiSeries = m15.length > 14 ? rsi(closes15, 14) : null;
  const rsi14V = rsiSeries ? (rsiSeries.at(-1) ?? null) : null;
  const pip = pipSize(pair);
  const spreadPips = Number.isFinite(last.askClose - last.bidClose) ? (last.askClose - last.bidClose) / pip : null;
  const h1e21 = h1.length >= 21 ? ema(h1.map((b) => b.close), 21).at(-1)! : null;
  const h1e50 = h1.length >= 50 ? ema(h1.map((b) => b.close), 50).at(-1)! : null;
  const h4e21 = h4.length >= 21 ? ema(h4.map((b) => b.close), 21).at(-1)! : null;
  const h4e50 = h4.length >= 50 ? ema(h4.map((b) => b.close), 50).at(-1)! : null;
  return {
    m15BarTime: last.closeTime,
    m15Ema21: e21, m15Ema50: e50, m15Ema200: e200,
    h1Ema21: h1e21, h1Ema50: h1e50,
    h4Ema21: h4e21, h4Ema50: h4e50,
    atr14: Number.isFinite(atr14V as number) ? (atr14V as number) : null,
    atrPips: Number.isFinite(atr14V as number) ? (atr14V as number) / pip : null,
    rsi14: Number.isFinite(rsi14V as number) ? (rsi14V as number) : null,
    spreadPips,
  };
}

type AuditRecord = {
  cycleId: string;
  instrument: string;
  dryRun: boolean;
  snapshot: IndicatorSnapshot;
  setupPassed: boolean;
  rejectReason: string | null;
  direction: "long" | "short" | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskPips: number | null;
  targetPips: number | null;
  pLong: number | null;
  features: LegacyConfidenceFeatures | null;
  artifactVersion: string | null;
  artifactTrainedAt: string | null;
  decisionAction: string | null;
  decisionReason: string | null;
  executedDirection: "long" | "short" | null;
  inverted: boolean | null;
  tradeId: string | null;
  errorMessage: string | null;
};

async function recordEvaluation(rec: AuditRecord): Promise<void> {
  try {
    await query(
      `INSERT INTO legacy_confidence_v2_evaluations (
         cycle_id, m15_bar_time, instrument, dry_run,
         setup_passed, reject_reason, direction,
         entry, stop, target, risk_pips, target_pips,
         m15_ema21, m15_ema50, m15_ema200, h1_ema21, h1_ema50, h4_ema21, h4_ema50,
         atr14, atr_pips, rsi14, spread_pips,
         p_long, features, artifact_version, artifact_trained_at,
         decision_action, decision_reason, executed_direction, inverted,
         trade_id, error_message
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19,
         $20, $21, $22, $23,
         $24, $25::jsonb, $26, $27,
         $28, $29, $30, $31,
         $32, $33
       )`,
      [
        rec.cycleId, rec.snapshot.m15BarTime, rec.instrument, rec.dryRun,
        rec.setupPassed, rec.rejectReason, rec.direction,
        rec.entry, rec.stop, rec.target, rec.riskPips, rec.targetPips,
        rec.snapshot.m15Ema21, rec.snapshot.m15Ema50, rec.snapshot.m15Ema200,
        rec.snapshot.h1Ema21, rec.snapshot.h1Ema50, rec.snapshot.h4Ema21, rec.snapshot.h4Ema50,
        rec.snapshot.atr14, rec.snapshot.atrPips, rec.snapshot.rsi14, rec.snapshot.spreadPips,
        rec.pLong, rec.features === null ? null : JSON.stringify(rec.features), rec.artifactVersion, rec.artifactTrainedAt,
        rec.decisionAction, rec.decisionReason, rec.executedDirection, rec.inverted,
        rec.tradeId, rec.errorMessage,
      ],
    );
  } catch (err) {
    // Never let audit-trail failures kill the trading cycle.
    console.error(`[legacy-confidence-v2] audit insert failed for ${rec.instrument}:`, (err as Error).message);
  }
}

/**
 * Run one collection cycle. Safe to call on a timer. Returns a summary; never
 * throws — errors are counted and logged.
 *
 * Environment:
 *   LEGACY_CONFIDENCE_V2_ENABLED  = "true" | "false" (default false — must opt in)
 *   LEGACY_CONFIDENCE_V2_DRY_RUN  = "true" | "false" (default true — safe by default)
 *   LEGACY_V2_ACCOUNT_BALANCE     = number (default 10000)
 *   LEGACY_V2_RISK_PERCENT        = number (default 1)
 *   LEGACY_V2_PAIRS               = comma list (default all 12)
 *   OANDA_API_KEY / OANDA_API_TOKEN, OANDA_ENVIRONMENT
 */
export async function collectLegacyConfidenceV2Cycle(): Promise<LegacyConfidenceV2CollectResult> {
  const enabled = (process.env.LEGACY_CONFIDENCE_V2_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled) return { ran: false, reason: "LEGACY_CONFIDENCE_V2_ENABLED is not true", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };

  const dryRun = (process.env.LEGACY_CONFIDENCE_V2_DRY_RUN ?? "true").toLowerCase() !== "false";
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) return { ran: false, reason: "no OANDA credentials", pairsChecked: 0, setupsFired: 0, tradesOpened: 0, skipped: 0, errors: 0 };
  const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  const pairs = process.env.LEGACY_V2_PAIRS ? process.env.LEGACY_V2_PAIRS.split(",").map((s) => s.trim()).filter(Boolean) : ALL_PAIRS;
  const accountBalance = Number(process.env.LEGACY_V2_ACCOUNT_BALANCE ?? "10000");
  const riskPercent = Number(process.env.LEGACY_V2_RISK_PERCENT ?? "1");

  const artifact = loadLegacyConfidenceArtifact();
  if (artifactAgeDays(artifact) > 14) {
    console.warn(`[legacy-confidence-v2] artifact stale (${artifactAgeDays(artifact).toFixed(1)}d) — all decisions will skip`);
  }

  let setupsFired = 0, tradesOpened = 0, skipped = 0, errors = 0;
  const cycleId = new Date().toISOString();

  for (const pair of pairs) {
    const audit: AuditRecord = {
      cycleId, instrument: pair, dryRun,
      snapshot: { m15BarTime: null, m15Ema21: null, m15Ema50: null, m15Ema200: null,
        h1Ema21: null, h1Ema50: null, h4Ema21: null, h4Ema50: null,
        atr14: null, atrPips: null, rsi14: null, spreadPips: null },
      setupPassed: false, rejectReason: null, direction: null,
      entry: null, stop: null, target: null, riskPips: null, targetPips: null,
      pLong: null, features: null, artifactVersion: null, artifactTrainedAt: null,
      decisionAction: null, decisionReason: null, executedDirection: null, inverted: null,
      tradeId: null, errorMessage: null,
    };
    try {
      const [m15, h1, h4] = await Promise.all([
        fetchCandles(pair, "M15", 500, token, host),
        fetchCandles(pair, "H1", 300, token, host),
        fetchCandles(pair, "H4", 200, token, host),
      ]);
      audit.snapshot = snapshotIndicators(pair, m15, h1, h4);
      if (m15.length < 210 || h1.length < 60 || h4.length < 60) {
        audit.rejectReason = `insufficient candles (M15=${m15.length}, H1=${h1.length}, H4=${h4.length})`;
        continue;
      }
      const setup = evaluateLegacySetup(pair, m15, h1, h4);
      if (!setup.passed) {
        audit.rejectReason = setup.reason;
        continue;
      }
      setupsFired++;
      audit.setupPassed = true;
      audit.direction = setup.direction;
      audit.entry = setup.entry; audit.stop = setup.stop; audit.target = setup.target;
      audit.riskPips = setup.riskPips; audit.targetPips = setup.targetPips;

      const feats = computeFeatures(m15);
      if (!feats) {
        errors++;
        audit.errorMessage = "computeFeatures returned null";
        continue;
      }
      audit.features = feats;
      const { decision, pLong, artifactVersion, trainedAt } = decideDirection({
        pair, legacyDirection: setup.direction, features: feats,
      });
      audit.pLong = pLong;
      audit.artifactVersion = artifactVersion;
      audit.artifactTrainedAt = trainedAt;
      audit.decisionAction = decision.action;
      audit.decisionReason = "reason" in decision && typeof decision.reason === "string" ? decision.reason : null;

      if (decision.action === "skip") {
        skipped++;
        continue;
      }

      const executedDirection = decision.action === "take_model_pick" ? decision.direction : setup.direction;
      const originalDirection = decision.action === "take_model_pick" ? decision.originalDirection : null;
      const inverted = decision.action === "take_model_pick";
      audit.executedDirection = executedDirection;
      audit.inverted = inverted;

      let entry = setup.entry, stop = setup.stop, target = setup.target;
      if (inverted) {
        const bar = m15[m15.length - 1]!;
        const stopDist = Math.abs(setup.entry - setup.stop);
        const targetDist = Math.abs(setup.target - setup.entry);
        entry = executedDirection === "long" ? bar.askClose : bar.bidClose;
        stop = executedDirection === "long" ? entry - stopDist : entry + stopDist;
        target = executedDirection === "long" ? entry + targetDist : entry - targetDist;
        audit.entry = entry; audit.stop = stop; audit.target = target;
      }

      if (dryRun) {
        console.log(`[legacy-confidence-v2 DRY_RUN] ${pair} ${executedDirection} @ ${entry.toFixed(5)} (pLong=${pLong.toFixed(3)}, inverted=${inverted})`);
      } else {
        const res = await openLegacyConfidenceV2Trade({
          instrument: pair,
          decisionTime: setup.decisionTime,
          direction: executedDirection,
          entry, stop, target,
          spreadPips: setup.spreadPips,
          atrPips: setup.atrPips,
          originalDirection, inverted,
          features: { ...feats, pLong, artifactVersion, trainedAt, decision },
          conditions: setup.gatesPassed.map((name) => ({ name, passed: true })),
          accountBalance,
          riskPercent,
        });
        if (res.ok) {
          tradesOpened++;
          audit.tradeId = res.tradeId;
          console.log(`[legacy-confidence-v2] opened trade #${res.tradeSequence} ${pair} ${executedDirection} in batch ${res.batchNumber}`);
        } else {
          audit.errorMessage = `trade not opened: ${res.reason}`;
          console.log(`[legacy-confidence-v2] ${pair} not opened: ${res.reason}`);
        }
      }
    } catch (err) {
      errors++;
      audit.errorMessage = (err as Error).message;
      console.error(`[legacy-confidence-v2] ${pair} cycle error`, err);
    } finally {
      await recordEvaluation(audit);
    }
  }

  return { ran: true, pairsChecked: pairs.length, setupsFired, tradesOpened, skipped, errors };
}
