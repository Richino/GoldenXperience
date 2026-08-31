/**
 * Forward-only shadow collection for EUR/USD move-gate-v1. It records MOVE and
 * WAIT decisions before their outcome can be known and never creates a trade.
 */
import { query } from "./database.js";
import { evaluateEurUsdMoveGateV1 } from "./eur-usd-move-gate-v1.js";
import type { ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const HORIZON_BARS = 16;
const BAR_MS = 15 * 60_000;
const STOP_ATR = 0.75;
const TARGET_ATR = 1.5;
type Direction = "long" | "short";
type QuoteBar = { closeTime: string; bidClose: number; bidHigh: number; bidLow: number; askClose: number; askHigh: number; askLow: number };

function closeTime(time: string) { return new Date(Date.parse(time) + BAR_MS).toISOString(); }
function targetFirst(direction: Direction, entry: number, atr: number, future: QuoteBar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) {
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return false; // candle order is unknowable: fail closed
    if (targetHit) return true;
    if (stopHit) return false;
  }
  return false;
}
function normalized(candles: ResearchCandle[]) {
  return candles.filter((candle) => candle.complete).map((candle) => ({
    closeTime: closeTime(candle.time),
    candle: { time: closeTime(candle.time), open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true } satisfies Candle,
    bidClose: candle.bid.close, bidHigh: candle.bid.high, bidLow: candle.bid.low,
    askClose: candle.ask.close, askHigh: candle.ask.high, askLow: candle.ask.low,
  })).sort((left, right) => Date.parse(left.closeTime) - Date.parse(right.closeTime));
}

export async function runEurUsdMoveGateV1Shadow(candles: ResearchCandle[], now = new Date()) {
  const bars = normalized(candles);
  const latest = bars.at(-1);
  let recorded = 0;
  if (latest) {
    const decision = evaluateEurUsdMoveGateV1({ instrument: "EUR_USD", candles: bars.map((bar) => bar.candle), bid: latest.bidClose, ask: latest.askClose });
    // Invalid inputs are operational faults, not a market WAIT observation.
    if (decision.atr !== null) {
      const inserted = await query(
        `INSERT INTO eur_usd_move_gate_v1_shadow_observations
           (decision_time,instrument,action,reason,atr,bid_close,ask_close,expected_move_atr,cost_atr,movement_strength,volatility_expansion,compression_release,velocity_atr,horizon_ends_at)
         VALUES($1,'EUR_USD',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT(decision_time) DO NOTHING`,
        [decision.observedAt, decision.action, decision.reason, decision.atr, latest.bidClose, latest.askClose,
         decision.expectedMoveAtr, decision.costAtr, decision.movementStrength, decision.volatilityExpansion,
         decision.compressionRelease, decision.velocityAtr, new Date(Date.parse(decision.observedAt!) + HORIZON_BARS * BAR_MS).toISOString()],
      );
      recorded = inserted.rowCount ?? 0;
    }
  }

  const pending = await query<{ decision_time: string | Date; atr: string; bid_close: string; ask_close: string }>(
    `SELECT decision_time,atr,bid_close,ask_close FROM eur_usd_move_gate_v1_shadow_observations
      WHERE status='pending' AND horizon_ends_at <= $1::timestamptz
      ORDER BY decision_time ASC LIMIT 300`, [now.toISOString()],
  );
  let resolved = 0;
  for (const row of pending.rows) {
    const decisionTime = new Date(row.decision_time).toISOString();
    const future = bars.filter((bar) => bar.closeTime > decisionTime && bar.closeTime <= new Date(Date.parse(decisionTime) + HORIZON_BARS * BAR_MS).toISOString());
    if (future.length !== HORIZON_BARS || Date.parse(future.at(-1)!.closeTime) - Date.parse(decisionTime) !== HORIZON_BARS * BAR_MS) continue;
    const atr = Number(row.atr);
    const moved = targetFirst("long", Number(row.ask_close), atr, future) || targetFirst("short", Number(row.bid_close), atr, future);
    const updated = await query(
      `UPDATE eur_usd_move_gate_v1_shadow_observations
          SET status='resolved', outcome=$2, resolved_at=$3
        WHERE decision_time=$1 AND status='pending'`,
      [decisionTime, moved ? "move_target_first" : "no_move_target_first", now.toISOString()],
    );
    resolved += updated.rowCount ?? 0;
  }
  return { recorded, resolved, latestDecision: latest ? latest.closeTime : null };
}

export const eurUsdMoveGateV1ShadowInternals = { BAR_MS, HORIZON_BARS, targetFirst, normalized };
