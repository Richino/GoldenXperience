/**
 * Overall trend + mini trend flip (user's rule, 2026-10-06), causal replay.
 *
 *   H4 regime is DOWNTREND, M15 regime is UPTREND (a pullback against it),
 *   and an M15 candle closes below the M15 trend's last higher low: SHORT at
 *   the next M15 open. Stop above the M15 trend's high plus the spread and
 *   0.1 M15 ATR; target 2x the stop. Mirror for longs. Both regimes come from
 *   the app's own structure read (market-regime.ts) on candles closed by then.
 *   One position per pair; 5-day time stop at market. Exits on bid/ask,
 *   stop first when one bar touches both.
 *
 *   --mid     fills and exits at mid (no spread)
 *   --mirror  take each signal the opposite way, same distances (with --mid)
 *
 *   npx tsx scripts/trend-flip-h4-m15.ts --days=1095
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";
import { classifyMarketRegime, DEFAULT_REGIME_SETTINGS, type RegimeRead } from "../../frontend/src/lib/strategy/market-regime.js";
import type { Candle } from "../../frontend/src/types/forex.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
const DAYS = Number(arg("days") ?? 1095);
const PAIRS = (arg("pairs") ?? "EUR_USD,GBP_USD,USD_JPY,USD_CHF,AUD_USD,USD_CAD,NZD_USD,EUR_JPY,EUR_GBP").split(",");
const MID = process.argv.includes("--mid");
const MIRROR = process.argv.includes("--mirror");
/** --maxSpread=1.5: skip a signal whose spread at the signal close is wider than this many pips. */
const MAX_SPREAD = Number(arg("maxSpread") ?? Infinity);
const SLICE = 260;
const MINUTE = 60_000;
const DURATION: Record<string, number> = { M15: 15 * MINUTE, H4: 240 * MINUTE };
const TIME_STOP_MS = 5 * 86_400_000;

type Bar = { open: number; close: number; mid: Candle; bid: ResearchCandle["bid"]; ask: ResearchCandle["ask"] };

async function fetchSeries(instrument: string, granularity: string, sinceMs: number): Promise<Bar[]> {
  const out: ResearchCandle[] = [];
  let to = Date.now() - 5 * MINUTE;
  for (;;) {
    let batch: ResearchCandle[] = [];
    for (let attempt = 1; ; attempt += 1) {
      try { batch = await getResearchCandles(instrument, granularity, 5000, { to: new Date(to).toISOString() }); break; }
      catch (error) { if (attempt >= 4) throw error; await new Promise((resolve) => setTimeout(resolve, 3000 * attempt)); }
    }
    if (!batch.length) break;
    out.push(...batch);
    const earliest = Math.min(...batch.map((candle) => Date.parse(candle.time)));
    if (earliest <= sinceMs || batch.length < 5000) break;
    to = earliest - 1;
  }
  const unique = new Map(out.filter((candle) => candle.complete).map((candle) => [Date.parse(candle.time), candle]));
  const midSide = (candle: ResearchCandle) => ({ open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close }) as ResearchCandle["bid"];
  return [...unique.entries()].sort((a, b) => a[0] - b[0]).map(([open, candle]) => ({
    open,
    close: open + DURATION[granularity]!,
    mid: { time: candle.time, open: candle.mid.open, high: candle.mid.high, low: candle.mid.low, close: candle.mid.close, volume: candle.volume, complete: true },
    bid: MID ? midSide(candle) : candle.bid,
    ask: MID ? midSide(candle) : candle.ask,
  }));
}

function closedBy(bars: Bar[], t: number): Candle[] {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.close <= t) lo = mid + 1; else hi = mid; }
  return bars.slice(Math.max(0, lo - SLICE), lo).map((bar) => bar.mid);
}

type Trade = { pair: string; year: number; long: boolean; r: number; stopPips: number; spreadPips: number; exit: "stop" | "target" | "time" | "open" };

function simulate(pair: string, m15: Bar[], h4: Bar[], start: number, trades: Trade[]) {
  const pip = pipSizeFor(pair);
  let pending: { long: boolean; stop: number; signalSpread: number } | null = null;
  let position: { long: boolean; fill: number; stop: number; target: number; risk: number; filledAt: number; spreadPips: number } | null = null;
  let previous: RegimeRead | null = null;
  const close = (bar: Bar, price: number, exit: Trade["exit"]) => {
    const p = position!;
    trades.push({ pair, year: new Date(p.filledAt).getUTCFullYear(), long: p.long, r: (p.long ? price - p.fill : p.fill - price) / p.risk, stopPips: p.risk / pip, spreadPips: p.spreadPips, exit });
    position = null;
  };
  for (const bar of m15) {
    if (pending) {
      const signal = pending;
      pending = null;
      const long = MIRROR ? !signal.long : signal.long;
      const fill = long ? bar.ask.open : bar.bid.open;
      const signalRisk = signal.long ? (bar.mid.open - signal.stop) : (signal.stop - bar.mid.open);
      if (signalRisk > 0) {
        const risk = signal.long ? fill - signal.stop : signal.stop - fill;
        const distance = MIRROR ? signalRisk : risk;
        if (distance > 0) {
          const stop = long ? fill - distance : fill + distance;
          position = { long, fill, stop, target: long ? fill + 2 * distance : fill - 2 * distance, risk: distance, filledAt: bar.open, spreadPips: signal.signalSpread };
        }
      }
    }
    if (position) {
      const p = position;
      if (p.long ? bar.bid.low <= p.stop : bar.ask.high >= p.stop) close(bar, p.stop, "stop");
      else if (p.long ? bar.bid.high >= p.target : bar.ask.low <= p.target) close(bar, p.target, "target");
      else if (bar.close - p.filledAt >= TIME_STOP_MS) close(bar, p.long ? bar.bid.close : bar.ask.close, "time");
    }
    const t = bar.close;
    if (t < start - 2 * DURATION.M15!) continue;
    const m15Candles = closedBy(m15, t);
    const read = classifyMarketRegime(m15Candles, DEFAULT_REGIME_SETTINGS);
    const before = previous;
    previous = read;
    if (t < start || position || pending || !before) continue;
    if ((bar.ask.close - bar.bid.close) / pip > MAX_SPREAD) continue;
    const overall = classifyMarketRegime(closedBy(h4, t), DEFAULT_REGIME_SETTINGS).regime;
    const closePrice = bar.mid.close;
    const buffer = (bar.ask.close - bar.bid.close) + 0.1 * read.atr;
    // Short: H4 down, M15 was trending up, and this close broke its last higher low.
    if (overall === "DOWNTREND" && before.regime === "UPTREND" && before.latestSwingLow && before.latestSwingHigh && closePrice < before.latestSwingLow.price) {
      pending = { long: false, stop: before.latestSwingHigh.price + buffer, signalSpread: (bar.ask.close - bar.bid.close) / pip };
    } else if (overall === "UPTREND" && before.regime === "DOWNTREND" && before.latestSwingLow && before.latestSwingHigh && closePrice > before.latestSwingHigh.price) {
      pending = { long: true, stop: before.latestSwingLow.price - buffer, signalSpread: (bar.ask.close - bar.bid.close) / pip };
    }
  }
  if (position) {
    const last = m15.at(-1)!;
    close(last, (position as { long: boolean }).long ? last.bid.close : last.ask.close, "open");
  }
}

function line(label: string, trades: Trade[]) {
  const n = trades.length;
  const total = trades.reduce((sum, trade) => sum + trade.r, 0);
  const mean = n ? total / n : 0;
  const se = n > 1 ? Math.sqrt(trades.reduce((sum, trade) => sum + (trade.r - mean) ** 2, 0) / (n - 1) / n) : 0;
  const grossWin = trades.filter((trade) => trade.r > 0).reduce((sum, trade) => sum + trade.r, 0);
  const grossLoss = -trades.filter((trade) => trade.r <= 0).reduce((sum, trade) => sum + trade.r, 0);
  const avg = (pick: (trade: Trade) => number) => (n ? trades.reduce((sum, trade) => sum + pick(trade), 0) / n : 0);
  console.log(`${label.padEnd(22)} trades ${String(n).padStart(5)}  win ${(n ? (100 * trades.filter((trade) => trade.r > 0).length) / n : 0).toFixed(1).padStart(5)}%  expR ${mean.toFixed(3).padStart(7)} ±${se.toFixed(3)}  totalR ${total.toFixed(1).padStart(7)}  PF ${(grossLoss > 0 ? grossWin / grossLoss : 0).toFixed(2)}  stop ${avg((trade) => trade.stopPips).toFixed(1)}p  spread ${avg((trade) => trade.spreadPips).toFixed(2)}p`);
}

async function main() {
  const start = Date.now() - DAYS * 86_400_000;
  const trades: Trade[] = [];
  for (const pair of PAIRS) {
    const m15 = await fetchSeries(pair, "M15", start - SLICE * DURATION.M15! * 1.6);
    const h4 = await fetchSeries(pair, "H4", start - SLICE * DURATION.H4! * 1.6);
    simulate(pair, m15, h4, start, trades);
    console.error(`${pair} done`);
  }
  console.log(`\n=== H4 trend + M15 flip, last ${DAYS} days, ${PAIRS.length} pairs${Number.isFinite(MAX_SPREAD) ? `, spread <= ${MAX_SPREAD}p` : ""}${MID ? ", mid prices" : ""}${MIRROR ? ", MIRRORED" : ""} ===`);
  line("ALL", trades);
  line("  shorts", trades.filter((trade) => !trade.long));
  line("  longs", trades.filter((trade) => trade.long));
  for (const pair of PAIRS) line(`  ${pair}`, trades.filter((trade) => trade.pair === pair));
  for (const year of [...new Set(trades.map((trade) => trade.year))].sort()) line(`  ${year}`, trades.filter((trade) => trade.year === year));
  for (const [lo, hi] of [[0, 10], [10, 20], [20, 40], [40, 1e9]] as const) line(`  stop ${lo}-${hi === 1e9 ? "+" : hi}p`, trades.filter((trade) => trade.stopPips >= lo && trade.stopPips < hi));
  const exits = ["stop", "target", "time", "open"].map((exit) => `${exit} ${trades.filter((trade) => trade.exit === exit).length}`).join("  ");
  console.log(`  exits: ${exits}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
