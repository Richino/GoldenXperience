// 5-year backtest of TrendPullbackV1 swing mode, 14 majors.
//
// Every 4 hours, when a pair has no open position or working order, the rule is
// run exactly as Analyze runs it (H1 x500 base, H4 x250 and D x250 for the
// higher-timeframe check), using only candles closed by then. Its plan is
// traded on OANDA M5 bid/ask: market fill when the entry is available now,
// else a limit that expires after 48h or cancels when price reaches the target
// first. Stop and 2R/1R target as planned; stop wins a bar that touches both.
// Not modelled: the news hold, swap/financing.
//
// Mirror: at each fill, the opposite direction at market with the same stop and
// target distances — if the rule's direction carries information, the mirror
// should lose about what the rule gains.
import fs from "node:fs";
import { analyzeTrendPullbackV1 } from "../src/lib/strategy/trend-pullback-v1";
import type { Candle, MajorInstrument } from "../src/types/forex";

const DIR = process.argv[2]!;
const START = Date.parse("2021-10-01T00:00:00Z");
const END = Date.parse("2026-10-01T00:00:00Z");
const PAIRS = process.env.PAIRS ? process.env.PAIRS.split(",") : ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "CAD_JPY", "NZD_JPY", "GBP_JPY", "AUD_JPY", "EUR_AUD"];
const GRAN_MS = { H1: 3_600_000, H4: 14_400_000, D: 86_400_000 } as const;
const STEP_MS = 4 * 3_600_000;
/** MODE=normal|swing; SL_MULT/TP_MULT reshape the plan's stop and target as multiples of its own stop distance. */
const MODE = (process.env.MODE ?? "swing") as "normal" | "swing";
const SL_MULT = Number(process.env.SL_MULT ?? 1);
const TP_MULT = process.env.TP_MULT ? Number(process.env.TP_MULT) : null;
const EXPIRY_MS = (MODE === "swing" ? 48 : 4) * 3_600_000;
const MAX_HOLD_MS = 30 * 86_400_000;

function loadMid(inst: string, gran: keyof typeof GRAN_MS) {
  const rows = JSON.parse(fs.readFileSync(`${DIR}/${inst}_${gran}.json`, "utf8")) as number[][];
  const candles: Candle[] = rows.map(([t, o, h, l, c]) => ({ time: new Date(t!).toISOString(), open: o!, high: h!, low: l!, close: c!, volume: 0, complete: true }));
  const ends = rows.map(([t]) => t! + GRAN_MS[gran]);
  return { candles, ends };
}

/** Number of items in sorted `arr` that are <= x. */
function countLE(arr: ArrayLike<number>, x: number, stride = 1) {
  let lo = 0, hi = arr.length / stride;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid * stride]! <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** First 4-hour step after `endedAt`, and always later than `current`. */
function nextDecision(current: number, endedAt: number) {
  return Math.max(current + STEP_MS, START + Math.ceil((endedAt - START) / STEP_MS) * STEP_MS);
}

type Trade = {
  pair: string; year: number; long: boolean; counter: boolean; market: boolean;
  r: number; rMid: number; mirrorR: number; out: string; holdH: number;
};

for (const inst of PAIRS) {
  if (!fs.existsSync(`${DIR}/${inst}_M5BA.bin`)) { console.error(`missing ${inst}`); continue; }
}

const trades: Trade[] = [];
const stats = { decisions: 0, noFill: 0, cancelledAtTarget: 0 };

for (const inst of PAIRS) {
  if (!fs.existsSync(`${DIR}/${inst}_M5BA.bin`)) continue;
  const h1 = loadMid(inst, "H1"), h4 = loadMid(inst, "H4"), d1 = loadMid(inst, "D");
  const buf = fs.readFileSync(`${DIR}/${inst}_M5BA.bin`);
  const m5 = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const n5 = m5.length / 9;
  const at = (i: number, col: number) => m5[i * 9 + col]!;
  // cols: 0 t, 1 bo, 2 bh, 3 bl, 4 bc, 5 ao, 6 ah, 7 al, 8 ac
  const firstBarAtOrAfter = (t: number) => countLE(m5, t - 1, 9);
  // Normal mode reads M15 mid candles, built from the M5 bid/ask bars.
  const m15: Candle[] = [];
  const m15Ends: number[] = [];
  if (MODE === "normal") {
    for (let k = 0; k < n5; k += 1) {
      const start = Math.floor(at(k, 0) / 900_000) * 900_000;
      const o = (at(k, 1) + at(k, 5)) / 2, h = (at(k, 2) + at(k, 6)) / 2, l = (at(k, 3) + at(k, 7)) / 2, c = (at(k, 4) + at(k, 8)) / 2;
      const last = m15.at(-1);
      if (last && m15Ends.at(-1)! - 900_000 === start) {
        last.high = Math.max(last.high, h); last.low = Math.min(last.low, l); last.close = c;
      } else {
        m15.push({ time: new Date(start).toISOString(), open: o, high: h, low: l, close: c, volume: 0, complete: true });
        m15Ends.push(start + 900_000);
      }
    }
  }

  /**
   * Walk M5 bars from `i` with a filled position; returns exit R vs `riskDist`
   * on executable prices (or on mid when `useMid`).
   */
  function runPosition(i: number, long: boolean, fill: number, stop: number, target: number, riskDist: number, useMid: boolean, sameBarFilled: boolean) {
    const t0 = at(i, 0);
    for (let k = i; k < n5; k += 1) {
      const t = at(k, 0);
      // Exit side: a long closes on the bid, a short on the ask.
      const o = useMid ? (at(k, 1) + at(k, 5)) / 2 : long ? at(k, 1) : at(k, 5);
      const h = useMid ? (at(k, 2) + at(k, 6)) / 2 : long ? at(k, 2) : at(k, 6);
      const l = useMid ? (at(k, 3) + at(k, 7)) / 2 : long ? at(k, 3) : at(k, 7);
      const c = useMid ? (at(k, 4) + at(k, 8)) / 2 : long ? at(k, 4) : at(k, 8);
      const gapOpen = k === i && sameBarFilled ? fill : o;
      const hitStop = long ? l <= stop : h >= stop;
      const hitTarget = long ? h >= target : l <= target;
      if (hitStop) {
        const px = long ? Math.min(gapOpen, stop) : Math.max(gapOpen, stop);
        return { r: (long ? px - fill : fill - px) / riskDist, out: "SL", end: t };
      }
      if (hitTarget) {
        const px = long ? Math.max(gapOpen, target) : Math.min(gapOpen, target);
        return { r: (long ? px - fill : fill - px) / riskDist, out: "TP", end: t };
      }
      if (t - t0 >= MAX_HOLD_MS || t >= END) return { r: (long ? c - fill : fill - c) / riskDist, out: "time", end: t };
    }
    return { r: 0, out: "end", end: END };
  }

  let t = START;
  while (t < END) {
    const nH1 = countLE(h1.ends, t), nH4 = countLE(h4.ends, t), nD = countLE(d1.ends, t);
    const nM15 = MODE === "normal" ? countLE(m15Ends, t) : 0;
    const candles = MODE === "normal" ? m15.slice(Math.max(0, nM15 - 500), nM15) : h1.candles.slice(Math.max(0, nH1 - 500), nH1);
    // Skip the weekend: no fresh hourly candle in the last 2 hours.
    if (!candles.length || !nH1 || t - h1.ends[nH1 - 1]! > 2 * 3_600_000) { t += STEP_MS; continue; }
    stats.decisions += 1;
    const currentPrice = candles.at(-1)!.close;
    const plan = analyzeTrendPullbackV1({
      instrument: inst as MajorInstrument, candles, currentPrice,
      h1Candles: MODE === "normal" ? h1.candles.slice(Math.max(0, nH1 - 250), nH1) : h4.candles.slice(Math.max(0, nH4 - 250), nH4),
      h4Candles: MODE === "normal" ? h4.candles.slice(Math.max(0, nH4 - 250), nH4) : d1.candles.slice(Math.max(0, nD - 250), nD),
      mode: MODE, now: t,
    });
    if (!plan.action || plan.entry === null || plan.stopLoss === null || plan.takeProfit === null) { t += STEP_MS; continue; }
    const long = plan.action === "LONG";
    // Normal mode trades its recommended (structure) stop when it has one.
    const structure = MODE === "normal" && plan.structureStop?.available ? plan.structureStop : null;
    const planStop = structure ? structure.stop : plan.stopLoss;
    const planDist = Math.abs(plan.entry - planStop);
    const sign = long ? 1 : -1;
    const stop = plan.entry - sign * SL_MULT * planDist;
    const target = plan.entry + sign * (TP_MULT ?? plan.riskReward!) * planDist;
    // 1R = the distance actually risked, so every variant is at the same $ risk.
    const riskDist = SL_MULT * planDist;
    const market = plan.status === "ENTRY_AVAILABLE_NOW";

    // Find the fill.
    let i = firstBarAtOrAfter(t);
    let fill: number | null = null, fillMid: number | null = null, fillBar = -1, sameBar = false;
    for (; i < n5; i += 1) {
      const bt = at(i, 0);
      if (market) {
        fill = long ? at(i, 5) : at(i, 1);
        fillMid = (at(i, 1) + at(i, 5)) / 2;
        fillBar = i; sameBar = false; break;
      }
      if (bt - t > EXPIRY_MS) break;
      // Price reaching the target before the entry cancels the order.
      if (long ? at(i, 2) >= target : at(i, 7) <= target) { stats.cancelledAtTarget += 1; break; }
      const reached = long ? at(i, 7) <= plan.entry : at(i, 2) >= plan.entry;
      if (reached) {
        const open = long ? at(i, 5) : at(i, 1);
        // A bar that opens through the limit fills at its open (better price).
        fill = long ? Math.min(open, plan.entry) : Math.max(open, plan.entry);
        fillMid = fill + (long ? -1 : 1) * (at(i, 5) - at(i, 1)) / 2;
        fillBar = i; sameBar = true; break;
      }
    }
    if (fill === null || fillMid === null) {
      stats.noFill += 1;
      t = nextDecision(t, Math.min(at(Math.min(i, n5 - 1), 0), t + EXPIRY_MS));
      continue;
    }
    const exec = runPosition(fillBar, long, fill, stop, target, riskDist, false, sameBar);
    const mid = runPosition(fillBar, long, fillMid, stop, target, riskDist, true, sameBar);
    // Mirror at market from the bar after the fill, same distances.
    const mi = Math.min(fillBar + 1, n5 - 1);
    const mFill = long ? at(mi, 1) : at(mi, 5);
    const targetDist = Math.abs(target - plan.entry);
    const mStop = long ? mFill + riskDist : mFill - riskDist;
    const mTarget = long ? mFill - targetDist : mFill + targetDist;
    const mirror = runPosition(mi, !long, mFill, mStop, mTarget, riskDist, false, false);
    trades.push({
      pair: inst, year: new Date(at(fillBar, 0)).getUTCFullYear(), long, counter: plan.counterTrend, market,
      r: exec.r, rMid: mid.r, mirrorR: mirror.r, out: exec.out, holdH: (exec.end - at(fillBar, 0)) / 3_600_000,
    });
    // Next decision after the position closes.
    t = nextDecision(t, exec.end);
  }
  const mine = trades.filter((x) => x.pair === inst);
  console.error(`${inst}: ${mine.length} trades, avg ${(mine.reduce((s, x) => s + x.r, 0) / mine.length).toFixed(3)}R`);
}

function summary(label: string, list: Trade[]) {
  const n = list.length;
  if (!n) return { label, n: 0 };
  const mean = (f: (x: Trade) => number) => list.reduce((s, x) => s + f(x), 0) / n;
  const avg = mean((x) => x.r);
  const sd = Math.sqrt(list.reduce((s, x) => s + (x.r - avg) ** 2, 0) / Math.max(1, n - 1));
  const wins = list.filter((x) => x.r > 0);
  const grossWin = wins.reduce((s, x) => s + x.r, 0);
  const grossLoss = -list.filter((x) => x.r <= 0).reduce((s, x) => s + x.r, 0);
  return {
    label, n,
    winPct: Math.round((100 * wins.length) / n),
    avgR: +avg.toFixed(3),
    ci95: `${(avg - 1.96 * sd / Math.sqrt(n)).toFixed(3)}..${(avg + 1.96 * sd / Math.sqrt(n)).toFixed(3)}`,
    totalR: +(avg * n).toFixed(1),
    PF: +(grossWin / Math.max(grossLoss, 1e-9)).toFixed(2),
    midAvgR: +mean((x) => x.rMid).toFixed(3),
    mirrorAvgR: +mean((x) => x.mirrorR).toFixed(3),
    medHoldH: [...list].sort((a, b) => a.holdH - b.holdH)[Math.floor(n / 2)]!.holdH.toFixed(0),
  };
}

console.log(JSON.stringify({ MODE, SL_MULT, TP_MULT, ...stats }));
console.table([summary("ALL", trades)]);
console.table([...new Set(trades.map((x) => x.year))].sort().map((y) => summary(String(y), trades.filter((x) => x.year === y))));
console.table(PAIRS.map((p) => summary(p, trades.filter((x) => x.pair === p))));
console.table([
  summary("with trend", trades.filter((x) => !x.counter)),
  summary("counter-trend (1R)", trades.filter((x) => x.counter)),
  summary("market fill", trades.filter((x) => x.market)),
  summary("limit fill", trades.filter((x) => !x.market)),
  summary("long", trades.filter((x) => x.long)),
  summary("short", trades.filter((x) => !x.long)),
]);
const outs: Record<string, number> = {};
for (const x of trades) outs[x.out] = (outs[x.out] ?? 0) + 1;
console.log("exits", outs);
fs.writeFileSync(`${DIR}/trades.json`, JSON.stringify(trades));
