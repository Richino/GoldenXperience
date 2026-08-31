/**
 * 12-day backtest for eur-usd-engine (regime + HTF + structure).
 * Adds a cooldown: after a TRADE, block N bars so a single trending session
 * doesn't produce correlated fires.
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { runEurUsdEngine } from "../src/eur-usd-engine.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const BAR_MS = 15 * 60_000;
const HORIZON_BARS = 16;
const STOP_ATR = 0.75;
const TARGET_ATR = 1.5;
const DAYS = 12;
const WARMUP_BARS = 260; // gate needs 200; H1 needs 60*4=240
const COOLDOWN_BARS = 8; // 2h between trades

type Bar = {
  time: string;
  midCandle: Candle;
  bidClose: number;
  bidHigh: number;
  bidLow: number;
  askClose: number;
  askHigh: number;
  askLow: number;
};

function toBars(candles: ResearchCandle[]): Bar[] {
  return candles
    .filter((c) => c.complete)
    .map((c) => {
      const closeTime = new Date(Date.parse(c.time) + BAR_MS).toISOString();
      return {
        time: closeTime,
        midCandle: { time: closeTime, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: true },
        bidClose: c.bid.close, bidHigh: c.bid.high, bidLow: c.bid.low,
        askClose: c.ask.close, askHigh: c.ask.high, askLow: c.ask.low,
      };
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function resolveTrade(direction: "long" | "short", entry: number, atr: number, future: Bar[]) {
  const target = direction === "long" ? entry + TARGET_ATR * atr : entry - TARGET_ATR * atr;
  const stop = direction === "long" ? entry - STOP_ATR * atr : entry + STOP_ATR * atr;
  for (const bar of future) {
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return { hit: "stop" as const, r: -1 };
    if (targetHit) return { hit: "target" as const, r: TARGET_ATR / STOP_ATR };
    if (stopHit) return { hit: "stop" as const, r: -1 };
  }
  const last = future.at(-1)!;
  const finalPx = direction === "long" ? last.bidClose : last.askClose;
  const rawMove = direction === "long" ? finalPx - entry : entry - finalPx;
  return { hit: "timeout" as const, r: rawMove / (STOP_ATR * atr) };
}

async function main() {
  const needed = DAYS * 96 + WARMUP_BARS + HORIZON_BARS + 20;
  console.log(`fetching ${needed} EUR/USD M15 candles...`);
  const raw = await getResearchCandles("EUR_USD", "M15", needed);
  const bars = toBars(raw);
  console.log(`got ${bars.length} bars, ${bars.at(0)?.time} → ${bars.at(-1)?.time}`);

  const nowMs = Date.parse(bars.at(-1)!.time);
  const windowStartMs = nowMs - DAYS * 24 * 60 * 60_000;

  const counts = {
    bars_evaluated: 0,
    gate_move: 0,
    gate_wait: 0,
    regime_trending: 0,
    regime_ranging: 0,
    regime_chop: 0,
    engine_trade: 0,
    engine_move_no_direction: 0,
    trades_after_cooldown: 0,
    cooldown_skipped: 0,
  };
  const dnReason: Record<string, number> = {};
  const trades: Array<{
    time: string; direction: "long" | "short"; regime: string; conf: number;
    atr: number; entry: number; hit: string; r: number; reason: string;
  }> = [];

  let cooldownUntil = -1;

  for (let i = WARMUP_BARS; i < bars.length - HORIZON_BARS; i++) {
    const bar = bars[i]!;
    if (Date.parse(bar.time) < windowStartMs) continue;
    counts.bars_evaluated++;

    const history = bars.slice(0, i + 1).map((b) => b.midCandle);
    const decision = runEurUsdEngine({ instrument: "EUR_USD", candles: history, bid: bar.bidClose, ask: bar.askClose });

    if (decision.gate.action === "MOVE") counts.gate_move++; else counts.gate_wait++;
    if (decision.regime) {
      if (decision.regime.regime === "trending") counts.regime_trending++;
      else if (decision.regime.regime === "ranging") counts.regime_ranging++;
      else counts.regime_chop++;
    }

    if (decision.action === "MOVE_NO_DIRECTION") {
      counts.engine_move_no_direction++;
      dnReason[decision.reason] = (dnReason[decision.reason] ?? 0) + 1;
    }

    if (decision.action !== "TRADE") continue;
    counts.engine_trade++;
    if (i < cooldownUntil) { counts.cooldown_skipped++; continue; }
    counts.trades_after_cooldown++;
    cooldownUntil = i + COOLDOWN_BARS;

    const atr = decision.gate.atr!;
    const direction = decision.direction!;
    const entry = direction === "long" ? bar.askClose : bar.bidClose;
    const future = bars.slice(i + 1, i + 1 + HORIZON_BARS);
    const outcome = resolveTrade(direction, entry, atr, future);
    trades.push({
      time: bar.time, direction, regime: decision.regime?.regime ?? "?",
      conf: decision.combinedConfidence ?? 0, atr, entry,
      hit: outcome.hit, r: outcome.r, reason: decision.reason,
    });
  }

  console.log("\n=== BAR-LEVEL COUNTS (12d) ===");
  console.table(counts);
  console.log("\n=== MOVE_NO_DIRECTION reasons ===");
  console.table(dnReason);

  const wins = trades.filter((t) => t.hit === "target").length;
  const losses = trades.filter((t) => t.hit === "stop").length;
  const timeouts = trades.filter((t) => t.hit === "timeout").length;
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const avgR = trades.length ? sumR / trades.length : 0;
  const longs = trades.filter((t) => t.direction === "long");
  const shorts = trades.filter((t) => t.direction === "short");
  const trending = trades.filter((t) => t.regime === "trending");
  const ranging = trades.filter((t) => t.regime === "ranging");

  console.log("\n=== TRADES ===");
  console.table({
    total: trades.length,
    wins, losses, timeouts,
    win_pct_excl_timeouts: wins + losses ? ((wins / (wins + losses)) * 100).toFixed(1) : "n/a",
    sum_R: sumR.toFixed(2),
    avg_R: avgR.toFixed(3),
    longs: longs.length, shorts: shorts.length,
    long_avg_R: longs.length ? (longs.reduce((s, t) => s + t.r, 0) / longs.length).toFixed(3) : "n/a",
    short_avg_R: shorts.length ? (shorts.reduce((s, t) => s + t.r, 0) / shorts.length).toFixed(3) : "n/a",
    trending_n: trending.length,
    trending_avg_R: trending.length ? (trending.reduce((s, t) => s + t.r, 0) / trending.length).toFixed(3) : "n/a",
    ranging_n: ranging.length,
    ranging_avg_R: ranging.length ? (ranging.reduce((s, t) => s + t.r, 0) / ranging.length).toFixed(3) : "n/a",
  });

  if (trades.length) {
    console.log("\n=== ALL TRADES ===");
    console.table(trades.map((t) => ({
      time: t.time, dir: t.direction, regime: t.regime, conf: t.conf.toFixed(2),
      hit: t.hit, r: t.r.toFixed(2), reason: t.reason,
    })));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
