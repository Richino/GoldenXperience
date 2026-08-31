/**
 * For each recent EUR/USD trade, compare the trade's direction against the
 * ACTUAL price movement over multiple forward horizons (4h, 24h, 72h) starting
 * from the trade's entry time. Answers: did the trade have the trend right on
 * a longer horizon than the strategy was measuring on?
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles } from "../../frontend/src/lib/oanda/client.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const trades = await pool.query<{
    opened_at: Date; closed_at: Date; direction: string; result_r: string;
    max_favorable_r: string | null; max_adverse_r: string | null; instrument: string;
    strategy_family: string | null; exit_reason: string | null;
  }>(`
    SELECT opened_at, closed_at, direction, result_r, max_favorable_r, max_adverse_r,
           instrument, strategy_family, exit_reason
    FROM paper_strategy_trades
    WHERE status='closed' AND result_r IS NOT NULL AND closed_at IS NOT NULL
    ORDER BY opened_at DESC
  `);
  console.log(`analyzing ${trades.rows.length} closed trades`);

  // Group by instrument so we fetch H1 candles once per instrument
  const byInstrument = new Map<string, typeof trades.rows>();
  for (const t of trades.rows) {
    const arr = byInstrument.get(t.instrument) ?? [];
    arr.push(t);
    byInstrument.set(t.instrument, arr);
  }

  // Fetch H1 candles once per instrument, spanning min(opened_at)-1d to max(opened_at)+4d
  const priceIndex = new Map<string, { time: number; mid: number }[]>();
  for (const [instr, list] of byInstrument.entries()) {
    const earliest = Math.min(...list.map((t) => Date.parse(t.opened_at.toISOString())));
    const latest = Math.max(...list.map((t) => Date.parse(t.opened_at.toISOString())));
    const spanHours = Math.ceil((latest - earliest) / 3_600_000) + 96 + 24; // pad both sides
    const toMs = Math.min(Date.now() - 60_000, latest + 96 * 3_600_000);
    const to = new Date(toMs).toISOString();
    try {
      const candles = await getResearchCandles(instr as any, "H1", Math.min(5000, spanHours), { to });
      const arr = candles.filter((c) => c.complete).map((c) => ({ time: Date.parse(c.time), mid: c.mid.close }));
      priceIndex.set(instr, arr.sort((a, b) => a.time - b.time));
      console.log(`${instr}: fetched ${arr.length} H1 candles`);
    } catch (e: any) {
      console.log(`${instr}: fetch failed — ${e.message}`);
    }
  }

  function priceAt(instr: string, atMs: number): number | null {
    const arr = priceIndex.get(instr);
    if (!arr || arr.length === 0) return null;
    // find closest candle at or after atMs
    let candidate: { time: number; mid: number } | null = null;
    for (const bar of arr) {
      if (bar.time >= atMs) { candidate = bar; break; }
    }
    return candidate ? candidate.mid : null;
  }

  const rows: any[] = [];
  const HORIZONS = [4, 24, 72]; // hours
  for (const t of trades.rows) {
    const openedMs = Date.parse(t.opened_at.toISOString());
    const entryPx = priceAt(t.instrument, openedMs);
    if (entryPx == null) continue;
    const forwardMoves: Record<string, number | null> = {};
    for (const h of HORIZONS) {
      const px = priceAt(t.instrument, openedMs + h * 3_600_000);
      forwardMoves[`h${h}`] = px == null ? null : px - entryPx;
    }
    rows.push({
      opened_at: t.opened_at.toISOString(),
      instr: t.instrument,
      dir: t.direction,
      strategy: t.strategy_family,
      result_r: Number(t.result_r).toFixed(2),
      hold_min: Math.round((Date.parse(t.closed_at.toISOString()) - openedMs) / 60_000),
      exit: t.exit_reason,
      ...forwardMoves,
    });
  }

  // Direction-correctness by horizon
  const correctness: any[] = [];
  for (const h of HORIZONS) {
    const key = `h${h}` as const;
    const usable = rows.filter((r) => r[key] != null);
    const dirCorrect = usable.filter((r) => (r.dir === "long" && r[key] > 0) || (r.dir === "short" && r[key] < 0)).length;
    const dirWrong = usable.length - dirCorrect;
    correctness.push({
      horizon_h: h,
      n: usable.length,
      dir_correct: dirCorrect,
      dir_wrong: dirWrong,
      dir_correct_pct: usable.length ? ((dirCorrect / usable.length) * 100).toFixed(1) : "n/a",
    });
  }
  console.log("\n=== TRADE DIRECTION vs ACTUAL PRICE DRIFT (long-horizon truth) ===");
  console.table(correctness);

  // Split by trade outcome — did LOSERS still have the direction right on a longer horizon?
  const byOutcome = ["target", "stop", "other"];
  for (const h of HORIZONS) {
    const key = `h${h}` as const;
    const table: any[] = [];
    for (const outcome of byOutcome) {
      const subset = rows.filter((r) => {
        if (r[key] == null) return false;
        if (outcome === "target") return r.exit === "target_first";
        if (outcome === "stop") return r.exit === "stop_first";
        return r.exit !== "target_first" && r.exit !== "stop_first";
      });
      if (subset.length === 0) continue;
      const correct = subset.filter((r) => (r.dir === "long" && r[key] > 0) || (r.dir === "short" && r[key] < 0)).length;
      table.push({
        outcome,
        n: subset.length,
        dir_correct: correct,
        dir_correct_pct: ((correct / subset.length) * 100).toFixed(1),
      });
    }
    console.log(`\n=== ${h}h horizon — direction correctness by trade outcome ===`);
    console.table(table);
  }

  // Top 5 losers with the biggest "should have been right" — direction correct on 72h
  const biggestMisses = rows
    .filter((r) => r.exit === "stop_first" && r.h72 != null &&
      ((r.dir === "long" && r.h72 > 0) || (r.dir === "short" && r.h72 < 0)))
    .sort((a, b) => Math.abs(b.h72) - Math.abs(a.h72))
    .slice(0, 10);
  console.log("\n=== TOP 10 STOP-OUT LOSERS THAT WERE DIRECTIONALLY RIGHT AT 72h ===");
  console.table(biggestMisses.map((r) => ({
    opened: r.opened_at, instr: r.instr, dir: r.dir, strat: r.strategy,
    hold_min: r.hold_min, r: r.result_r,
    h4_pips: r.h4 == null ? null : (r.h4 * 10000).toFixed(1),
    h24_pips: r.h24 == null ? null : (r.h24 * 10000).toFixed(1),
    h72_pips: r.h72 == null ? null : (r.h72 * 10000).toFixed(1),
  })));

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
