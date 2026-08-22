import { query } from "./database.js";
import { labelOutcome, type NormalizedQuote } from "./research.js";
import { resolveShadowOutcome } from "./shadow-outcomes.js";
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";
import type { StrategyCandidate } from "../../frontend/src/lib/strategy/strategy.js";
import type { MajorInstrument } from "../../frontend/src/types/forex.js";

/**
 * Momentum SHORT inversion — forward shadow A/B experiment. RESEARCH ONLY.
 *
 * THE HYPOTHESIS, FROZEN: when the current Momentum engine says SHORT, does the
 * exact opposite LONG produce positive net expectancy after costs?
 *
 * WHY IT IS ONLY A HYPOTHESIS. A 23-trade momentum sample over three days
 * (2026-08-19 → 08-21) inverted from -7.19R to +7.13R, and across the engine the
 * original SHORT signals ran -5.43R against +8.71R inverted. That sample
 * GENERATED this hypothesis and is therefore disqualified from confirming it —
 * it is never inserted here, and the forward statistics start empty. An
 * 11,977-signal historical replay put inverted momentum at -0.0600 against the
 * original -0.0595, i.e. no inversion effect at all, so the two bodies of
 * evidence currently disagree and only new data can settle it.
 *
 * SAFETY. Both arms are shadow. Nothing here places an order, opens a paper
 * position, or touches risk, exposure or the account. Critically, the adaptive
 * engine builds its evidence from `paper_strategy_trades` and
 * `shadow_candidate_outcomes` — this table is deliberately neither, so
 * collecting cannot alter live selection while the hypothesis is frozen.
 *
 * SCOPE. Momentum SHORT only. Momentum LONG, EMA, Breakout and MeanRev are
 * untouched and continue to be recorded by the normal pipeline.
 */

/** Bump this if the Momentum configuration changes; never pool across cohorts. */
export const MOMENTUM_SHORT_INVERSION_COHORT = "momentum-short-inversion-forward-v1";
const HORIZONS = [1, 3, 6, 12, 24];

export interface RecordInput {
  candidate: StrategyCandidate;
  quote: { bid: number; ask: number } | undefined;
  spreadPips: number | null;
  session: string;
}

/**
 * Capture one forward Momentum SHORT opportunity as a paired A/B row.
 *
 * Every qualifying signal is taken — no filtering on how the setup looks, which
 * pair it is, or how wide the spread is. A signal that cannot be recorded is
 * stored with `status='excluded'` and a reason rather than dropped, so the
 * denominator stays honest.
 */
export async function recordMomentumShortPair(input: RecordInput): Promise<"recorded" | "excluded" | "skipped"> {
  const c = input.candidate;
  if (c.family !== "momentum" || c.direction !== "short" || c.status !== "valid") return "skipped";

  const exclude = async (reason: string) => {
    await query(
      `INSERT INTO momentum_short_inversion_pairs
         (cohort, strategy_version, config_version, instrument, decision_time, session,
          stop_distance, target_distance, orig_direction, orig_entry, orig_stop, orig_target,
          inv_direction, inv_entry, inv_stop, inv_target, status, excluded_reason)
       VALUES ($1,$2,$3,$4,$5,$6, 0,0, 'short',0,0,0, 'long',0,0,0, 'excluded',$7)
       ON CONFLICT (cohort, instrument, decision_time) DO NOTHING`,
      [MOMENTUM_SHORT_INVERSION_COHORT, c.version, c.configVersion, c.instrument, c.evaluatedAt, input.session, reason]);
    return "excluded" as const;
  };

  // Fail closed on anything that would make the counterfactual unreliable.
  if (!input.quote) return exclude("no live quote at signal time");
  if (c.entry === null || c.stop === null || c.target === null) return exclude("incomplete trade plan");
  if (!(input.spreadPips !== null && input.spreadPips > 0 && Number.isFinite(input.spreadPips))) return exclude("invalid spread");
  const atr = c.regime.atr;
  if (!(atr && atr > 0)) return exclude("ATR unavailable");

  const stopDistance = Math.abs(c.entry - c.stop);
  const targetDistance = Math.abs(c.target - c.entry);
  if (!(stopDistance > 0) || !(targetDistance > 0)) return exclude("degenerate stop/target geometry");

  // Arm A is exactly what the engine produced: a SHORT filled at the bid.
  // Arm B fills the OTHER side of the book at the SAME bar and mirrors the same
  // distances. Both arms therefore pay their own spread; neither is a negation
  // of the other, which would hand the inverted arm a free round trip.
  const origEntry = c.entry;
  const invEntry = input.quote.ask;
  const invStop = invEntry - stopDistance;
  const invTarget = invEntry + targetDistance;

  await query(
    `INSERT INTO momentum_short_inversion_pairs
       (cohort, strategy_version, config_version, instrument, decision_time, session, regime,
        atr, atr_pips, spread_pips, stop_distance, target_distance,
        orig_direction, orig_entry, orig_stop, orig_target,
        inv_direction, inv_entry, inv_stop, inv_target, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             'short',$13,$14,$15, 'long',$16,$17,$18, 'pending')
     ON CONFLICT (cohort, instrument, decision_time) DO NOTHING`,
    [MOMENTUM_SHORT_INVERSION_COHORT, c.version, c.configVersion, c.instrument, c.evaluatedAt,
     input.session, c.regime.regime, atr, c.regime.atrPips, input.spreadPips,
     stopDistance, targetDistance, origEntry, c.stop, c.target, invEntry, invStop, invTarget]);
  return "recorded";
}

const closeTime = (t: string) => new Date(new Date(t).getTime() + 15 * 60_000).toISOString();
function toQuote(candle: Awaited<ReturnType<typeof getResearchCandles>>[number]): NormalizedQuote {
  return {
    closeTime: closeTime(candle.time),
    bidOpen: candle.bid.open, bidHigh: candle.bid.high, bidLow: candle.bid.low, bidClose: candle.bid.close,
    askOpen: candle.ask.open, askHigh: candle.ask.high, askLow: candle.ask.low, askClose: candle.ask.close,
  };
}

/**
 * Resolve both arms of any pending pair whose outcome is genuinely known.
 *
 * Each arm is replayed INDEPENDENTLY through the production resolver against
 * real subsequent bid/ask. A SHORT loss is never assumed to be a LONG win — the
 * mirrored LONG can and does lose too. Same-bar stop/target ambiguity inherits
 * production's conservative handling. A pair is written only when BOTH arms have
 * resolved, so the paired comparison is never half-formed.
 */
export async function resolveMomentumShortInversion(now: Date = new Date()): Promise<number> {
  const pending = await query<{
    forward_pair_id: string; instrument: MajorInstrument; decision_time: string | Date;
    orig_entry: string; orig_stop: string; orig_target: string;
    inv_entry: string; inv_stop: string; inv_target: string; atr: string;
  }>(
    `SELECT forward_pair_id, instrument, decision_time,
            orig_entry::text, orig_stop::text, orig_target::text,
            inv_entry::text, inv_stop::text, inv_target::text, atr::text
       FROM momentum_short_inversion_pairs
      WHERE status='pending' ORDER BY decision_time LIMIT 200`);
  if (!pending.rows.length) return 0;

  const byInstrument = new Map<string, NormalizedQuote[]>();
  let resolved = 0;
  for (const row of pending.rows) {
    let quotes = byInstrument.get(row.instrument);
    if (!quotes) {
      try {
        const candles = (await getResearchCandles(row.instrument, "M15", 500)).filter((x) => x.complete);
        quotes = candles.map(toQuote);
        byInstrument.set(row.instrument, quotes);
      } catch { continue; }               // unreachable data: leave pending, never guess
    }
    const decisionTime = new Date(row.decision_time).toISOString();
    const forward = quotes.filter((q) => new Date(q.closeTime) > new Date(decisionTime));
    if (forward.length < 2) continue;

    const orig = resolveShadowOutcome("short", Number(row.orig_entry), Number(row.orig_stop), Number(row.orig_target), decisionTime, forward, now);
    const inv = resolveShadowOutcome("long", Number(row.inv_entry), Number(row.inv_stop), Number(row.inv_target), decisionTime, forward, now);
    if (!orig || !inv) continue;          // either arm still open: wait for both

    // Fixed-horizon forward moves for BOTH directions, executable, so the
    // directional question can be separated from the TP/SL geometry.
    const atr = Number(row.atr);
    const hz: Record<string, number> = {};
    if (atr > 0) {
      for (const h of HORIZONS) {
        const q = forward[h - 1];
        if (!q) continue;
        hz[`short${h}`] = (Number(row.orig_entry) - q.askClose) / atr;
        hz[`long${h}`] = (q.bidClose - Number(row.inv_entry)) / atr;
      }
    }

    await query(
      `UPDATE momentum_short_inversion_pairs SET
         status='resolved', resolved_at=now(),
         orig_outcome=$2, orig_result_r=$3, orig_mfe_r=$4, orig_mae_r=$5, orig_exit=$6,
         orig_resolved_at=$7, orig_exit_reason=$8,
         inv_outcome=$9, inv_result_r=$10, inv_mfe_r=$11, inv_mae_r=$12, inv_exit=$13,
         inv_resolved_at=$14, inv_exit_reason=$15, horizon_returns=$16::jsonb
       WHERE forward_pair_id=$1 AND status='pending'`,
      [row.forward_pair_id,
       orig.outcome, orig.resultR, orig.maxFavorableR, orig.maxAdverseR, orig.exit, orig.resolvedAt, orig.exitReason,
       inv.outcome, inv.resultR, inv.maxFavorableR, inv.maxAdverseR, inv.exit, inv.resolvedAt, inv.exitReason,
       JSON.stringify(hz)]);
    resolved += 1;
  }
  return resolved;
}

export type InversionStatus = "COLLECTING" | "PROMISING" | "FAILED" | "CONFIRMED";

/**
 * Status summary. Deliberately conservative: PROMISING is not a claim, and
 * CONFIRMED requires the full pre-registered promotion gate, not just a positive
 * point estimate.
 */
export async function momentumShortInversionStatus(cohort = MOMENTUM_SHORT_INVERSION_COHORT) {
  const rows = await query<{ orig_result_r: string; inv_result_r: string; instrument: string; decision_time: string | Date }>(
    `SELECT orig_result_r::text, inv_result_r::text, instrument, decision_time
       FROM momentum_short_inversion_pairs
      WHERE cohort=$1 AND status='resolved' AND orig_result_r IS NOT NULL AND inv_result_r IS NOT NULL
      ORDER BY decision_time`, [cohort]);
  const counts = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM momentum_short_inversion_pairs WHERE cohort=$1 GROUP BY status`, [cohort]);

  const o = rows.rows.map((r) => Number(r.orig_result_r));
  const i = rows.rows.map((r) => Number(r.inv_result_r));
  const n = o.length;
  const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const ci = (a: number[]) => {
    if (a.length < 2) return [null, null] as [number | null, number | null];
    const m = mean(a);
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
    const se = sd / Math.sqrt(a.length);
    return [m - 1.96 * se, m + 1.96 * se] as [number, number];
  };
  const paired = i.map((v, k) => v - o[k]!);
  const [invLo, invHi] = ci(i);
  const [pLo, pHi] = ci(paired);
  const pairsSeen = new Set(rows.rows.map((r) => r.instrument)).size;

  // Promotion gate, pre-registered. All of it, or it is not CONFIRMED.
  const gate = n >= 100 && mean(i) > 0 && (invLo ?? -1) > 0 && mean(paired) > 0 && (pLo ?? -1) > 0 && pairsSeen >= 3;
  const status: InversionStatus =
    gate ? "CONFIRMED"
      : n < 50 ? "COLLECTING"
        : mean(i) > 0 ? "PROMISING"
          : (invHi !== null && invHi < 0) ? "FAILED" : "COLLECTING";

  const next = n < 25 ? 25 : n < 50 ? 50 : n < 100 ? 100 : n < 200 ? 200 : null;
  return {
    cohort, pairsResolved: n, nextCheckpoint: next,
    byStatus: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)])),
    original: { wins: o.filter((x) => x > 0).length, losses: o.filter((x) => x <= 0).length,
                totalR: o.reduce((a, b) => a + b, 0), expectancy: mean(o) },
    inverted: { wins: i.filter((x) => x > 0).length, losses: i.filter((x) => x <= 0).length,
                totalR: i.reduce((a, b) => a + b, 0), expectancy: mean(i),
                ci95: [invLo, invHi] },
    pairedImprovement: { mean: mean(paired), ci95: [pLo, pHi] },
    instrumentsSeen: pairsSeen,
    status,
    note: "Forward evidence only. The 2026-08-19..08-21 discovery sample is excluded by construction. "
        + "PROMISING is not proof; CONFIRMED requires n>=100, inverted expectancy and paired improvement "
        + "both positive with 95% CI above zero, across at least 3 instruments.",
  };
}
