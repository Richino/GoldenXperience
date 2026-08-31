/**
 * Re-simulate the actual 167 paper trades as SWING trades: same entry time,
 * same direction, but replace the original tight M15-ATR stop with a wider
 * H4-ATR stop, a 4-ATR target, and a 72h time-stop.
 *
 * Grid: STOP_ATR = [1.5, 2.0, 2.5], TARGET_ATR = [3.0, 4.0], HORIZON = 72h.
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { calculateAtrValues } from "../../frontend/src/lib/strategy/indicators.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const HORIZON_HOURS = 72;

type Trade = {
  opened_at: Date; closed_at: Date; direction: "long" | "short"; result_r: string;
  instrument: string; strategy_family: string | null; exit_reason: string | null;
};

type H1Bar = { timeMs: number; midCandle: Candle; bidHigh: number; bidLow: number; bidClose: number; askHigh: number; askLow: number; askClose: number };

function toH1Bars(raw: ResearchCandle[]): H1Bar[] {
  return raw.filter((c) => c.complete).map((c) => ({
    timeMs: Date.parse(c.time),
    midCandle: { time: c.time, open: c.mid.open, high: c.mid.high, low: c.mid.low, close: c.mid.close, volume: c.volume, complete: true },
    bidHigh: c.bid.high, bidLow: c.bid.low, bidClose: c.bid.close,
    askHigh: c.ask.high, askLow: c.ask.low, askClose: c.ask.close,
  })).sort((a, b) => a.timeMs - b.timeMs);
}

function simulate(direction: "long" | "short", entry: number, atr: number, stopAtr: number, targetAtr: number, future: H1Bar[]) {
  const target = direction === "long" ? entry + targetAtr * atr : entry - targetAtr * atr;
  const stop = direction === "long" ? entry - stopAtr * atr : entry + stopAtr * atr;
  for (const bar of future) {
    const targetHit = direction === "long" ? bar.bidHigh >= target : bar.askLow <= target;
    const stopHit = direction === "long" ? bar.bidLow <= stop : bar.askHigh >= stop;
    if (targetHit && stopHit) return { hit: "stop" as const, r: -1 }; // fail-closed
    if (targetHit) return { hit: "target" as const, r: targetAtr / stopAtr };
    if (stopHit) return { hit: "stop" as const, r: -1 };
  }
  const last = future.at(-1);
  if (!last) return { hit: "no_data" as const, r: 0 };
  const finalPx = direction === "long" ? last.bidClose : last.askClose;
  const rawMove = direction === "long" ? finalPx - entry : entry - finalPx;
  return { hit: "timeout" as const, r: rawMove / (stopAtr * atr) };
}

async function main() {
  const trades = await pool.query<Trade>(`
    SELECT opened_at, closed_at, direction, result_r, instrument, strategy_family, exit_reason
    FROM paper_strategy_trades
    WHERE status='closed' AND result_r IS NOT NULL AND closed_at IS NOT NULL
    ORDER BY opened_at ASC
  `);
  console.log(`re-simulating ${trades.rows.length} trades as swing`);

  // Fetch H1 candles per instrument
  const byInstr = new Map<string, Trade[]>();
  for (const t of trades.rows) {
    const arr = byInstr.get(t.instrument) ?? [];
    arr.push(t);
    byInstr.set(t.instrument, arr);
  }
  const priceIndex = new Map<string, H1Bar[]>();
  for (const [instr, list] of byInstr.entries()) {
    const earliest = Math.min(...list.map((t) => Date.parse(t.opened_at.toISOString())));
    const latest = Math.max(...list.map((t) => Date.parse(t.opened_at.toISOString())));
    // need 500h of warmup (for H4 ATR baseline) + span + 72h forward
    const toMs = Math.min(Date.now() - 60_000, latest + (HORIZON_HOURS + 6) * 3_600_000);
    const spanHours = Math.ceil((toMs - earliest) / 3_600_000) + 500;
    const to = new Date(toMs).toISOString();
    try {
      const raw = await getResearchCandles(instr as any, "H1", Math.min(5000, spanHours), { to });
      priceIndex.set(instr, toH1Bars(raw));
      console.log(`${instr}: ${priceIndex.get(instr)!.length} H1 bars`);
    } catch (e: any) { console.log(`${instr}: fetch failed — ${e.message}`); }
  }

  function h4AtrAt(instr: string, atMs: number): { atr: number; entryPx: { bid: number; ask: number } } | null {
    const bars = priceIndex.get(instr);
    if (!bars) return null;
    // find last H1 bar before entry
    let idx = -1;
    for (let i = 0; i < bars.length; i++) { if (bars[i]!.timeMs >= atMs) { idx = i; break; } }
    if (idx < 200) return null;
    // Build H4 candles from last 4*80=320 H1 bars up to idx (exclusive)
    const window = bars.slice(Math.max(0, idx - 400), idx);
    const h4: Candle[] = [];
    for (let i = 0; i + 4 <= window.length; i += 4) {
      const group = window.slice(i, i + 4);
      h4.push({
        time: group[0]!.midCandle.time,
        open: group[0]!.midCandle.open,
        high: Math.max(...group.map((g) => g.midCandle.high)),
        low: Math.min(...group.map((g) => g.midCandle.low)),
        close: group[3]!.midCandle.close,
        volume: 0,
        complete: true,
      });
    }
    if (h4.length < 20) return null;
    const atr = calculateAtrValues(h4, 14).at(-1);
    if (!(atr && atr > 0)) return null;
    const entryBar = bars[idx]!;
    return { atr, entryPx: { bid: entryBar.bidClose, ask: entryBar.askClose } };
  }

  const grid = [
    { stop: 1.5, target: 3.0 },
    { stop: 2.0, target: 4.0 },
    { stop: 2.5, target: 5.0 },
    { stop: 2.0, target: 3.0 }, // 1.5:1 payoff sanity
  ];

  const originalWins = trades.rows.filter((t) => Number(t.result_r) > 0).length;
  const originalSumR = trades.rows.reduce((s, t) => s + Number(t.result_r), 0);
  console.log(`\nORIGINAL: ${trades.rows.length} trades, ${originalWins} wins (${((originalWins/trades.rows.length)*100).toFixed(1)}%), sumR ${originalSumR.toFixed(2)}, avg ${(originalSumR/trades.rows.length).toFixed(3)}`);

  for (const cfg of grid) {
    let wins = 0, losses = 0, timeouts = 0, noData = 0, sumR = 0;
    const flipped = { l2w: 0, w2l: 0 }; // original loser → swing winner, and reverse
    for (const t of trades.rows) {
      const openedMs = Date.parse(t.opened_at.toISOString());
      const ctx = h4AtrAt(t.instrument, openedMs);
      if (!ctx) { noData++; continue; }
      const bars = priceIndex.get(t.instrument)!;
      const startIdx = bars.findIndex((b) => b.timeMs >= openedMs);
      if (startIdx < 0) { noData++; continue; }
      const future = bars.slice(startIdx, startIdx + HORIZON_HOURS);
      const entry = t.direction === "long" ? ctx.entryPx.ask : ctx.entryPx.bid;
      const outcome = simulate(t.direction, entry, ctx.atr, cfg.stop, cfg.target, future);
      if (outcome.hit === "no_data") { noData++; continue; }
      sumR += outcome.r;
      if (outcome.hit === "target") wins++;
      else if (outcome.hit === "stop") losses++;
      else timeouts++;
      const origR = Number(t.result_r);
      if (origR < 0 && outcome.r > 0) flipped.l2w++;
      if (origR > 0 && outcome.r < 0) flipped.w2l++;
    }
    const usable = wins + losses + timeouts;
    console.log(`\n=== stop=${cfg.stop} ATR H4, target=${cfg.target} ATR, horizon=${HORIZON_HOURS}h ===`);
    console.table({
      trades_simulated: usable,
      no_data: noData,
      wins, losses, timeouts,
      win_pct_excl_timeouts: wins + losses ? ((wins / (wins + losses)) * 100).toFixed(1) : "n/a",
      sum_R: sumR.toFixed(2),
      avg_R: usable ? (sumR / usable).toFixed(3) : "n/a",
      orig_loser_to_swing_winner: flipped.l2w,
      orig_winner_to_swing_loser: flipped.w2l,
    });
  }

  // Also break down the best config by original outcome
  const best = grid.find((g) => g.stop === 2.0 && g.target === 4.0)!;
  const perOutcome: Record<string, { n: number; sumR: number; wins: number }> = {};
  for (const t of trades.rows) {
    const openedMs = Date.parse(t.opened_at.toISOString());
    const ctx = h4AtrAt(t.instrument, openedMs);
    if (!ctx) continue;
    const bars = priceIndex.get(t.instrument)!;
    const startIdx = bars.findIndex((b) => b.timeMs >= openedMs);
    if (startIdx < 0) continue;
    const future = bars.slice(startIdx, startIdx + HORIZON_HOURS);
    const entry = t.direction === "long" ? ctx.entryPx.ask : ctx.entryPx.bid;
    const outcome = simulate(t.direction, entry, ctx.atr, best.stop, best.target, future);
    if (outcome.hit === "no_data") continue;
    const bucket = t.exit_reason ?? "unknown";
    const b = perOutcome[bucket] ?? { n: 0, sumR: 0, wins: 0 };
    b.n++; b.sumR += outcome.r; if (outcome.r > 0) b.wins++;
    perOutcome[bucket] = b;
  }
  console.log(`\n=== Best-config outcome by ORIGINAL exit reason (stop=2, target=4) ===`);
  console.table(Object.entries(perOutcome).map(([k, v]) => ({
    original_exit: k, n: v.n, swing_wins: v.wins, swing_win_pct: ((v.wins/v.n)*100).toFixed(1), swing_sum_R: v.sumR.toFixed(2), swing_avg_R: (v.sumR/v.n).toFixed(3),
  })));

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
