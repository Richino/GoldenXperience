/**
 * EUR/USD M1 TREND-DETECTION RESEARCH
 * Window: Mon 2026-09-14 → Fri 2026-09-18 (inclusive trading hours)
 *
 * Behavioral only — no entries, no production changes, no spread.
 * All classifications use candles[0..i] only (no lookahead).
 */
import fs from "node:fs";
import path from "node:path";

const PIP = 0.0001;
const START = "2026-09-14T00:00:00.000000000Z";
const END_EXCL = "2026-09-19T00:00:00.000000000Z";
const PIVOT_REACH = 3; // M1 structure: 3 bars each side to confirm
const HORIZON_MIN = 60;
const EVAL_WINDOWS = [5, 10, 15, 30, 60] as const;
const FAV_TARGETS = [3, 5, 7.5, 10, 15] as const;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-m1-trend-detection-sep14-18.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-m1-trend-detection-sep14-18-episodes.csv");
const M1_WINDOW =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-sep10-19-window.json";
const M1_FULL =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const M1_CACHE = path.join(OUT_DIR, "cache", "eurusd-m1-mid-sep14-18.json");

type Dir = "UP" | "DOWN" | "NO_TREND";
type Side = "UP" | "DOWN";

type Bar = { time: string; open: number; high: number; low: number; close: number; ms: number };

type ClassSeries = Dir[];

type Episode = {
  method: string;
  direction: Side;
  signalIdx: number;
  signalTime: string;
  signalPrice: number;
  endIdx: number;
  episodeEnd: string;
  episodeMinutes: number;
  atr: number;
  emaSeparation: number;
  emaSlope: number;
  recentMomentum: number;
  candleDirRatio: number;
  recentRange: number;
  structureStrength: number;
  maxFav: Record<number, number>;
  maxAdv: Record<number, number>;
  hit10Within: Record<number, boolean>;
  hit10BeforeMinus10: boolean;
  hit10BeforeAdv: Record<number, boolean>; // adv thresholds 3,5,7.5,10,15
  firstHit: Record<string, "FAV" | "ADV" | "NONE">; // "5","7.5","10"
  minutesTo10p: number;
  episodePips: number; // net close move during episode
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f5 = (x: number) => (Number.isFinite(x) ? x.toFixed(5) : "-");
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : NaN);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const quantile = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  return s[lo]! * (hi - idx) + s[hi]! * (idx - lo);
};
const median = (a: number[]) => quantile(a, 0.5);
const dayKey = (t: string) => t.slice(0, 10);
const toMs = (t: string) => Date.parse(t.slice(0, 19) + "Z");

function loadBars(): Bar[] {
  const tryPaths = [M1_CACHE, M1_WINDOW, M1_FULL].filter((p) => fs.existsSync(p));
  if (!tryPaths.length) throw new Error("No M1 cache found");
  const p = tryPaths[0]!;
  process.stderr.write(`Loading M1 from ${p}...\n`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown[];
  const out: Bar[] = [];
  for (const row of raw) {
    let time: string;
    let high: number;
    let low: number;
    let close: number;
    let open: number;
    if (Array.isArray(row)) {
      const [t, bh, bl, ah, al, bc, ac] = row as [string, number, number, number, number, number, number];
      time = t;
      high = (bh + ah) / 2;
      low = (bl + al) / 2;
      close = (bc + ac) / 2;
      open = close;
    } else {
      const c = row as {
        time: string;
        complete?: boolean;
        mid?: { open: number; high: number; low: number; close: number };
        bid?: { high: number; low: number; close: number; open?: number };
        ask?: { high: number; low: number; close: number; open?: number };
      };
      if (c.complete === false) continue;
      time = c.time;
      if (c.mid) {
        open = c.mid.open;
        high = c.mid.high;
        low = c.mid.low;
        close = c.mid.close;
      } else if (c.bid && c.ask) {
        high = (c.bid.high + c.ask.high) / 2;
        low = (c.bid.low + c.ask.low) / 2;
        close = (c.bid.close + c.ask.close) / 2;
        open = c.bid.open != null && c.ask.open != null ? (c.bid.open + c.ask.open) / 2 : close;
      } else continue;
    }
    if (time < START || time >= END_EXCL) continue;
    out.push({ time, open, high, low, close, ms: toMs(time) });
  }
  out.sort((a, b) => a.ms - b.ms);
  // fix open from prior close when missing
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.open === out[i]!.close && Math.abs(out[i]!.open - out[i - 1]!.close) > 1e-9) {
      // keep as-is for BA mid; optional: out[i].open = out[i-1].close
    }
  }
  if (p !== M1_CACHE) {
    fs.mkdirSync(path.dirname(M1_CACHE), { recursive: true });
    // don't rewrite huge — skip
  }
  return out;
}

function emaSeries(closes: Float64Array, period: number): Float64Array {
  const out = new Float64Array(closes.length);
  out.fill(NaN);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += closes[i]!;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) {
    e = closes[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function atr14Pips(bars: Bar[], i: number): number {
  const start = Math.max(1, i - 40);
  const trs: number[] = [];
  for (let j = start; j <= i; j++) {
    const c = bars[j]!;
    const p = bars[j - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < 14) return (mean(trs) || 5 * PIP) / PIP;
  return mean(trs.slice(-14))! / PIP;
}

/** Confirmed pivots only: pivot at j known at j+REACH */
function buildStructureClass(bars: Bar[]): ClassSeries {
  const n = bars.length;
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  const swingHighs: Array<{ idx: number; price: number }> = [];
  const swingLows: Array<{ idx: number; price: number }> = [];

  for (let i = 0; i < n; i++) {
    // newly confirmable pivot center = i - REACH
    const center = i - PIVOT_REACH;
    if (center >= PIVOT_REACH) {
      const c = bars[center]!;
      let isH = true;
      let isL = true;
      for (let k = center - PIVOT_REACH; k <= center + PIVOT_REACH; k++) {
        if (k === center) continue;
        if (bars[k]!.high > c.high) isH = false;
        if (bars[k]!.low < c.low) isL = false;
      }
      if (isH) swingHighs.push({ idx: center, price: c.high });
      if (isL) swingLows.push({ idx: center, price: c.low });
    }

    // use last 3 confirmed highs/lows available at i
    const hs = swingHighs.slice(-3);
    const ls = swingLows.slice(-3);
    if (hs.length >= 2 && ls.length >= 2) {
      const hh = hs[hs.length - 1]!.price > hs[hs.length - 2]!.price;
      const hl = ls[ls.length - 1]!.price > ls[ls.length - 2]!.price;
      const lh = hs[hs.length - 1]!.price < hs[hs.length - 2]!.price;
      const ll = ls[ls.length - 1]!.price < ls[ls.length - 2]!.price;
      if (hh && hl) cls[i] = "UP";
      else if (lh && ll) cls[i] = "DOWN";
      else cls[i] = "NO_TREND";
    }
  }
  return cls;
}

function buildEmaClass(
  closes: Float64Array,
  fast: number,
  slow: number,
  requireSlope: boolean,
  slopeBars = 5,
  slopeMinPips = 0.5,
): ClassSeries {
  const n = closes.length;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ef[i]) || !Number.isFinite(es[i])) continue;
    const sep = ef[i]! - es[i]!;
    let slopeOkUp = true;
    let slopeOkDn = true;
    if (requireSlope && i >= slopeBars && Number.isFinite(ef[i - slopeBars])) {
      const slope = (ef[i]! - ef[i - slopeBars]!) / PIP;
      slopeOkUp = slope >= slopeMinPips;
      slopeOkDn = slope <= -slopeMinPips;
    }
    if (sep > 0 && slopeOkUp) cls[i] = "UP";
    else if (sep < 0 && slopeOkDn) cls[i] = "DOWN";
    else cls[i] = "NO_TREND";
  }
  return cls;
}

function buildMomentumClass(closes: Float64Array, window: number, threshPips: number): ClassSeries {
  const n = closes.length;
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  const thr = threshPips * PIP;
  for (let i = window; i < n; i++) {
    const d = closes[i]! - closes[i - window]!;
    if (d >= thr) cls[i] = "UP";
    else if (d <= -thr) cls[i] = "DOWN";
    else cls[i] = "NO_TREND";
  }
  return cls;
}

function combineAnd(a: ClassSeries, b: ClassSeries): ClassSeries {
  return a.map((x, i) => {
    const y = b[i]!;
    if (x === "UP" && y === "UP") return "UP";
    if (x === "DOWN" && y === "DOWN") return "DOWN";
    return "NO_TREND";
  });
}

function combine3(a: ClassSeries, b: ClassSeries, c: ClassSeries): ClassSeries {
  return combineAnd(combineAnd(a, b), c);
}

function extractEpisodes(method: string, cls: ClassSeries, bars: Bar[], closes: Float64Array): Episode[] {
  const n = bars.length;
  const episodes: Episode[] = [];
  let i = 0;
  // warm-up: skip until we have enough history for indicators (~60)
  const warm = 60;
  while (i < n) {
    if (i < warm || cls[i] === "NO_TREND") {
      i++;
      continue;
    }
    const dir = cls[i] as Side;
    const start = i;
    i++;
    while (i < n && cls[i] === dir) i++;
    const end = i - 1; // last bar of episode
    const ep = evaluateEpisode(method, dir, start, end, bars, closes, cls);
    episodes.push(ep);
  }
  return episodes;
}

function evaluateEpisode(
  method: string,
  dir: Side,
  start: number,
  end: number,
  bars: Bar[],
  closes: Float64Array,
  cls: ClassSeries,
): Episode {
  const sig = bars[start]!;
  const signalPrice = sig.close;
  const horizonEnd = Math.min(bars.length - 1, start + HORIZON_MIN);
  // also allow eval beyond episode end — forward from signal only
  const maxFav: Record<number, number> = {};
  const maxAdv: Record<number, number> = {};
  for (const w of EVAL_WINDOWS) {
    maxFav[w] = 0;
    maxAdv[w] = 0;
  }

  let hit10BeforeMinus10 = false;
  let hit10 = false;
  let hitMinus10 = false;
  const hit10BeforeAdv: Record<number, boolean> = { 3: false, 5: false, 7.5: false, 10: false, 15: false };
  const advHit: Record<number, boolean> = { 3: false, 5: false, 7.5: false, 10: false, 15: false };
  const favHit: Record<number, boolean> = {};
  for (const t of FAV_TARGETS) favHit[t] = false;
  const firstHit: Record<string, "FAV" | "ADV" | "NONE"> = { "5": "NONE", "7.5": "NONE", "10": "NONE" };
  let minutesTo10p = NaN;

  let runFav = 0;
  let runAdv = 0;

  for (let j = start + 1; j <= horizonEnd; j++) {
    const mins = j - start;
    const bar = bars[j]!;
    let favExt: number;
    let advExt: number;
    if (dir === "UP") {
      favExt = (bar.high - signalPrice) / PIP;
      advExt = (signalPrice - bar.low) / PIP;
    } else {
      favExt = (signalPrice - bar.low) / PIP;
      advExt = (bar.high - signalPrice) / PIP;
    }
    runFav = Math.max(runFav, favExt);
    runAdv = Math.max(runAdv, advExt);

    for (const w of EVAL_WINDOWS) {
      if (mins <= w) {
        maxFav[w] = Math.max(maxFav[w]!, favExt);
        maxAdv[w] = Math.max(maxAdv[w]!, advExt);
      }
    }

    for (const t of FAV_TARGETS) {
      if (!favHit[t]! && runFav >= t) favHit[t] = true;
    }
    for (const a of [3, 5, 7.5, 10, 15] as const) {
      if (!advHit[a]! && runAdv >= a) advHit[a] = true;
    }

    if (!hit10 && runFav >= 10) {
      hit10 = true;
      minutesTo10p = mins;
    }
    if (!hitMinus10 && runAdv >= 10) hitMinus10 = true;
    if (hit10 && !hitMinus10) hit10BeforeMinus10 = true;

    for (const a of [3, 5, 7.5, 10, 15] as const) {
      if (hit10 && !advHit[a]!) hit10BeforeAdv[a] = true;
      // once adv already hit before 10, stays false
      if (!hit10 && advHit[a]!) {
        // locked out for this threshold unless we already set true — keep false
      }
    }
    // Recompute lock: if adv hit before fav 10, cannot be true
    for (const a of [3, 5, 7.5, 10, 15] as const) {
      if (advHit[a]! && !hit10) hit10BeforeAdv[a] = false;
    }

    for (const pair of ["5", "7.5", "10"] as const) {
      const t = Number(pair);
      if (firstHit[pair] !== "NONE") continue;
      if (runFav >= t) firstHit[pair] = "FAV";
      else if (runAdv >= t) firstHit[pair] = "ADV";
    }
  }

  // finalize +10 before -X: true only if 10 hit and at the moment of 10-hit, adv was still < X
  // Re-scan for precise first-hit ordering
  {
    let f = 0;
    let a = 0;
    let got10 = false;
    const before: Record<number, boolean> = { 3: false, 5: false, 7.5: false, 10: false, 15: false };
    let before10 = false;
    const fh: Record<string, "FAV" | "ADV" | "NONE"> = { "5": "NONE", "7.5": "NONE", "10": "NONE" };
    minutesTo10p = NaN;
    for (let j = start + 1; j <= horizonEnd; j++) {
      const bar = bars[j]!;
      const mins = j - start;
      const favExt = dir === "UP" ? (bar.high - signalPrice) / PIP : (signalPrice - bar.low) / PIP;
      const advExt = dir === "UP" ? (signalPrice - bar.low) / PIP : (bar.high - signalPrice) / PIP;
      f = Math.max(f, favExt);
      a = Math.max(a, advExt);
      for (const pair of ["5", "7.5", "10"] as const) {
        const t = Number(pair);
        if (fh[pair] === "NONE") {
          if (f >= t) fh[pair] = "FAV";
          else if (a >= t) fh[pair] = "ADV";
        }
      }
      if (!got10 && f >= 10) {
        got10 = true;
        minutesTo10p = mins;
        before10 = a < 10;
        for (const thr of [3, 5, 7.5, 10, 15] as const) {
          before[thr] = a < thr;
        }
      }
    }
    hit10BeforeMinus10 = before10;
    Object.assign(hit10BeforeAdv, before);
    Object.assign(firstHit, fh);
  }

  const hit10Within: Record<number, boolean> = {};
  for (const w of EVAL_WINDOWS) {
    hit10Within[w] = Number.isFinite(minutesTo10p) && minutesTo10p <= w;
  }

  // features at detection (available at start)
  const atr = atr14Pips(bars, start);
  let emaSep = 0;
  let emaSlope = 0;
  {
    const ef = emaAt(closes, start, 9);
    const es = emaAt(closes, start, 20);
    if (Number.isFinite(ef) && Number.isFinite(es)) emaSep = (ef - es) / PIP;
    const ef5 = emaAt(closes, start, 9);
    const efPrev = emaAt(closes, Math.max(0, start - 5), 9);
    if (Number.isFinite(ef5) && Number.isFinite(efPrev)) emaSlope = (ef5 - efPrev) / PIP;
  }
  const momWin = 15;
  const recentMomentum =
    start >= momWin ? (closes[start]! - closes[start - momWin]!) / PIP : 0;
  let upCandles = 0;
  let nCandles = 0;
  for (let j = Math.max(0, start - 14); j <= start; j++) {
    nCandles++;
    if (bars[j]!.close > bars[j]!.open) upCandles++;
  }
  const candleDirRatio = dir === "UP" ? upCandles / nCandles : 1 - upCandles / nCandles;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = Math.max(0, start - 14); j <= start; j++) {
    hi = Math.max(hi, bars[j]!.high);
    lo = Math.min(lo, bars[j]!.low);
  }
  const recentRange = (hi - lo) / PIP;
  // structure strength: count of agreeing recent class bars
  let agree = 0;
  for (let j = Math.max(0, start - 9); j <= start; j++) if (cls[j] === dir) agree++;
  const structureStrength = agree;

  const episodePips =
    dir === "UP"
      ? (bars[end]!.close - bars[start]!.close) / PIP
      : (bars[start]!.close - bars[end]!.close) / PIP;

  return {
    method,
    direction: dir,
    signalIdx: start,
    signalTime: sig.time,
    signalPrice,
    endIdx: end,
    episodeEnd: bars[end]!.time,
    episodeMinutes: end - start + 1,
    atr,
    emaSeparation: emaSep,
    emaSlope,
    recentMomentum,
    candleDirRatio,
    recentRange,
    structureStrength,
    maxFav,
    maxAdv,
    hit10Within,
    hit10BeforeMinus10,
    hit10BeforeAdv,
    firstHit,
    minutesTo10p,
    episodePips,
  };
}

/** EMA value at index i using only closes[0..i] */
function emaAt(closes: Float64Array, i: number, period: number): number {
  if (i < period - 1) return NaN;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let j = 0; j < period; j++) sum += closes[j]!;
  let e = sum / period;
  for (let j = period; j <= i; j++) e = closes[j]! * k + e * (1 - k);
  return e;
}

function rate(eps: Episode[], pred: (e: Episode) => boolean): number {
  return pct(eps.filter(pred).length, eps.length);
}

function summarizeMethod(name: string, eps: Episode[]): void {
  if (!eps.length) {
    log(`  ${name}: N=0`);
    return;
  }
  log(
    `  ${name.padEnd(28)} N=${String(eps.length).padStart(4)} | 10≤15m ${f1(rate(eps, (e) => e.hit10Within[15]!))}% | ≤30m ${f1(rate(eps, (e) => e.hit10Within[30]!))}% | ≤60m ${f1(rate(eps, (e) => e.hit10Within[60]!))}% | +10<-10 ${f1(rate(eps, (e) => e.hit10BeforeMinus10))}% | medDur ${f1(median(eps.map((e) => e.episodeMinutes)))}m`,
  );
}

function main(): void {
  const bars = loadBars();
  if (bars.length < 200) throw new Error(`Too few bars: ${bars.length}`);
  const closes = new Float64Array(bars.map((b) => b.close));

  log("=".repeat(78));
  log("EUR/USD M1 TREND-DETECTION RESEARCH — Sep 14–18 2026");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("A. DATASET / INTEGRITY");
  log("-".repeat(78));
  log(`  Instrument: EUR_USD`);
  log(`  Granularity: M1`);
  log(`  Price: MID ((bid+ask)/2 where BA cache)`);
  log(`  Candle count: ${bars.length}`);
  log(`  First candle: ${bars[0]!.time}`);
  log(`  Last candle:  ${bars[bars.length - 1]!.time}`);
  log(`  Range filter: ${START} ≤ t < ${END_EXCL}`);
  log(`  Lookahead: classifications use only bars ≤ i; pivots confirmed only after +${PIVOT_REACH} closed bars`);
  log(`  Evaluation: forward from episode start only; horizon ${HORIZON_MIN}m`);
  log("");

  // Build method series
  process.stderr.write("Building detectors...\n");
  const struct = buildStructureClass(bars);
  const ema5_10 = buildEmaClass(closes, 5, 10, false);
  const ema5_10s = buildEmaClass(closes, 5, 10, true);
  const ema9_20 = buildEmaClass(closes, 9, 20, false);
  const ema9_20s = buildEmaClass(closes, 9, 20, true);
  const ema10_20 = buildEmaClass(closes, 10, 20, false);
  const ema10_20s = buildEmaClass(closes, 10, 20, true);
  const ema20_50 = buildEmaClass(closes, 20, 50, false);
  const ema20_50s = buildEmaClass(closes, 20, 50, true);

  const mom5_3 = buildMomentumClass(closes, 5, 3);
  const mom10_5 = buildMomentumClass(closes, 10, 5);
  const mom15_5 = buildMomentumClass(closes, 15, 5);
  const mom20_7 = buildMomentumClass(closes, 20, 7.5);
  const mom30_10 = buildMomentumClass(closes, 30, 10);

  const methods: Array<[string, ClassSeries]> = [
    ["A_STRUCTURE", struct],
    ["B_EMA_5_10", ema5_10],
    ["B_EMA_5_10_SLOPE", ema5_10s],
    ["B_EMA_9_20", ema9_20],
    ["B_EMA_9_20_SLOPE", ema9_20s],
    ["B_EMA_10_20", ema10_20],
    ["B_EMA_10_20_SLOPE", ema10_20s],
    ["B_EMA_20_50", ema20_50],
    ["B_EMA_20_50_SLOPE", ema20_50s],
    ["C_MOM_5m_3p", mom5_3],
    ["C_MOM_10m_5p", mom10_5],
    ["C_MOM_15m_5p", mom15_5],
    ["C_MOM_20m_7.5p", mom20_7],
    ["C_MOM_30m_10p", mom30_10],
    ["D_STRUCT+EMA9_20S", combineAnd(struct, ema9_20s)],
    ["E_EMA9_20S+MOM15_5", combineAnd(ema9_20s, mom15_5)],
    ["F_STRUCT+EMA+MOM", combine3(struct, ema9_20s, mom15_5)],
  ];

  const allEpisodes: Episode[] = [];
  const byMethod = new Map<string, Episode[]>();

  for (const [name, series] of methods) {
    process.stderr.write(`  episodes: ${name}\n`);
    const eps = extractEpisodes(name, series, bars, closes);
    byMethod.set(name, eps);
    allEpisodes.push(...eps);
  }

  log("B. TREND METHODS COMPARED");
  log("-".repeat(78));
  log("  method | N | +10≤15m | ≤30m | ≤60m | +10 before -10 | med episode dur");
  for (const [name] of methods) summarizeMethod(name, byMethod.get(name)!);
  log("");

  // Pick best by +10 before -10 then ≤30m
  let bestName = methods[0]![0];
  let bestScore = -1;
  for (const [name] of methods) {
    const eps = byMethod.get(name)!;
    if (eps.length < 5) continue;
    const score = rate(eps, (e) => e.hit10BeforeMinus10) + 0.5 * rate(eps, (e) => e.hit10Within[30]!);
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  const best = byMethod.get(bestName)!;

  log("C. +10p CONTINUATION BY TIME (all methods)");
  log("-".repeat(78));
  log("METHOD | N | ≤5m | ≤10m | ≤15m | ≤30m | ≤60m | medT| avgT (successes≤60m)");
  for (const [name] of methods) {
    const eps = byMethod.get(name)!;
    const st = eps.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 60);
    log(
      [
        name.padEnd(22),
        String(eps.length).padStart(4),
        f1(rate(eps, (e) => e.hit10Within[5]!)),
        f1(rate(eps, (e) => e.hit10Within[10]!)),
        f1(rate(eps, (e) => e.hit10Within[15]!)),
        f1(rate(eps, (e) => e.hit10Within[30]!)),
        f1(rate(eps, (e) => e.hit10Within[60]!)),
        st.length ? f1(median(st)) : "-",
        st.length ? f1(mean(st)) : "-",
      ].join(" | "),
    );
  }
  log("");

  log("D. FIRST-HIT OUTCOMES");
  log("-".repeat(78));
  log("METHOD | N | +5<-5 | +7.5<-7.5 | +10<-10");
  for (const [name] of methods) {
    const eps = byMethod.get(name)!;
    log(
      [
        name.padEnd(22),
        String(eps.length).padStart(4),
        f1(rate(eps, (e) => e.firstHit["5"] === "FAV")),
        f1(rate(eps, (e) => e.firstHit["7.5"] === "FAV")),
        f1(rate(eps, (e) => e.firstHit["10"] === "FAV")),
      ].join(" | "),
    );
  }
  log("");

  log("E. +10 TARGET VS ADVERSE DISTANCES (best method: " + bestName + ")");
  log("-".repeat(78));
  log(`  N=${best.length}`);
  for (const a of [3, 5, 7.5, 10, 15] as const) {
    log(`  +10 before -${a}: ${f1(rate(best, (e) => e.hit10BeforeAdv[a]!))}%`);
  }
  {
    const st = best.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 60);
    log(`  Successful +10 ≤60m: N=${st.length} avg=${f1(mean(st))}m med=${f1(median(st))}m P25=${f1(quantile(st, 0.25))} P75=${f1(quantile(st, 0.75))} P90=${f1(quantile(st, 0.9))}`);
  }
  log("");

  log("F. UP VS DOWN (best method: " + bestName + ")");
  log("-".repeat(78));
  log("DIRECTION | N | +10≤15m | ≤30m | ≤60m | +10 before -10");
  for (const d of ["UP", "DOWN"] as const) {
    const eps = best.filter((e) => e.direction === d);
    log(
      [
        d,
        eps.length,
        f1(rate(eps, (e) => e.hit10Within[15]!)),
        f1(rate(eps, (e) => e.hit10Within[30]!)),
        f1(rate(eps, (e) => e.hit10Within[60]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
      ].join(" | "),
    );
  }
  log("");

  log("G. RESULTS BY DAY (best method: " + bestName + ")");
  log("-".repeat(78));
  log("DAY | N | +10≤15m | ≤30m | ≤60m | +10<-10 | medDur");
  const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  for (const d of ["ALL", ...days]) {
    const eps = d === "ALL" ? best : best.filter((e) => dayKey(e.signalTime) === d);
    const label = d === "ALL" ? "ALL DAYS" : d.slice(5);
    log(
      [
        label.padEnd(10),
        String(eps.length).padStart(3),
        f1(rate(eps, (e) => e.hit10Within[15]!)),
        f1(rate(eps, (e) => e.hit10Within[30]!)),
        f1(rate(eps, (e) => e.hit10Within[60]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
        f1(median(eps.map((e) => e.episodeMinutes))),
      ].join(" | "),
    );
  }
  log("");

  log("H. TREND EPISODE DURATION (best method)");
  log("-".repeat(78));
  {
    const durs = best.map((e) => e.episodeMinutes);
    const pips = best.map((e) => e.episodePips);
    log(`  N episodes=${best.length}`);
    log(`  Duration min: avg=${f1(mean(durs))} med=${f1(median(durs))} P25=${f1(quantile(durs, 0.25))} P75=${f1(quantile(durs, 0.75))}`);
    log(`  Episode net pips (dir): avg=${f1(mean(pips))} med=${f1(median(pips))}`);
  }
  log("");

  log("I. TREND STRENGTH BUCKETS (best method, at detection)");
  log("-".repeat(78));
  const bucketize = (vals: number[], edges: number[]) => {
    const labels: string[] = [];
    const groups: Episode[][] = [];
    for (let i = 0; i <= edges.length; i++) {
      labels.push(i === 0 ? `<${edges[0]}` : i === edges.length ? `≥${edges[edges.length - 1]}` : `${edges[i - 1]}–<${edges[i]}`);
      groups.push([]);
    }
    for (const e of best) {
      // caller assigns
      void e;
    }
    return { labels, groups };
  };
  void bucketize;

  const strengthFeatures: Array<[string, (e: Episode) => number, number[]]> = [
    ["|emaSeparation|", (e) => Math.abs(e.emaSeparation), [0.5, 1.5, 3]],
    ["|emaSlope|", (e) => Math.abs(e.emaSlope), [0.3, 1, 2]],
    ["|recentMomentum|", (e) => Math.abs(e.recentMomentum), [3, 7, 12]],
    ["ATR14", (e) => e.atr, [3, 5, 8]],
    ["candleDirRatio", (e) => e.candleDirRatio, [0.4, 0.55, 0.7]],
  ];
  for (const [fname, getter, edges] of strengthFeatures) {
    log(`  Feature: ${fname}`);
    const bins: Array<{ label: string; eps: Episode[] }> = [];
    for (let i = 0; i <= edges.length; i++) {
      const label =
        i === 0 ? `<${edges[0]}` : i === edges.length ? `≥${edges[edges.length - 1]}` : `${edges[i - 1]}–<${edges[i]}`;
      bins.push({ label, eps: [] });
    }
    for (const e of best) {
      const v = getter(e);
      let b = edges.length;
      for (let i = 0; i < edges.length; i++) {
        if (v < edges[i]!) {
          b = i;
          break;
        }
      }
      bins[b]!.eps.push(e);
    }
    for (const bin of bins) {
      if (!bin.eps.length) continue;
      log(
        `    ${bin.label.padEnd(12)} N=${String(bin.eps.length).padStart(3)} +10≤30m ${f1(rate(bin.eps, (e) => e.hit10Within[30]!))}% +10<-10 ${f1(rate(bin.eps, (e) => e.hit10BeforeMinus10))}%`,
      );
    }
  }
  log("");

  log("J. BASELINE / CONTROL COMPARISON");
  log("-".repeat(78));
  log("  Controls evaluated from the SAME episode start timestamps as best method.");
  log("  (1) random direction (2) always LONG (3) always SHORT (4) sign of prior 5m return");

  const controlDefs: Array<[string, (e: Episode, idx: number) => Side]> = [
    [
      "RANDOM",
      (e, idx) => {
        // deterministic pseudo-random from signalIdx
        const r = Math.imul(e.signalIdx + 17, 1103515245) >>> 0;
        return r & 1 ? "UP" : "DOWN";
      },
    ],
    ["ALWAYS_LONG", () => "UP"],
    ["ALWAYS_SHORT", () => "DOWN"],
    [
      "PREV_5M_SIGN",
      (e) => {
        const i = e.signalIdx;
        if (i < 5) return "UP";
        const d = closes[i]! - closes[i - 5]!;
        return d >= 0 ? "UP" : "DOWN";
      },
    ],
  ];

  function evalControl(name: string, pick: (e: Episode, idx: number) => Side): Episode[] {
    const out: Episode[] = [];
    const dummyCls: ClassSeries = Array(bars.length).fill("NO_TREND");
    best.forEach((e, idx) => {
      const dir = pick(e, idx);
      // one-bar "episode" evaluation from same start — use evaluate with end=start (duration 1) but forward path same
      dummyCls[e.signalIdx] = dir;
      const ep = evaluateEpisode(`CTL_${name}`, dir, e.signalIdx, e.signalIdx, bars, closes, dummyCls);
      out.push(ep);
    });
    return out;
  }

  log("NAME | N | +10≤30m | ≤60m | +10 before -10");
  const ctlResults: Array<[string, Episode[]]> = [["BEST_" + bestName, best]];
  for (const [name, pick] of controlDefs) {
    ctlResults.push([name, evalControl(name, pick)]);
  }
  for (const [name, eps] of ctlResults) {
    log(
      [
        name.padEnd(28),
        String(eps.length).padStart(4),
        f1(rate(eps, (e) => e.hit10Within[30]!)),
        f1(rate(eps, (e) => e.hit10Within[60]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
      ].join(" | "),
    );
  }
  const best1010 = rate(best, (e) => e.hit10BeforeMinus10);
  const rand1010 = rate(ctlResults.find((x) => x[0] === "RANDOM")![1], (e) => e.hit10BeforeMinus10);
  const prev1010 = rate(ctlResults.find((x) => x[0] === "PREV_5M_SIGN")![1], (e) => e.hit10BeforeMinus10);
  const materialVsRandom = best1010 - rand1010;
  const materialVsPrev = best1010 - prev1010;
  log(`  Best vs RANDOM Δ(+10<-10)=${f1(materialVsRandom)} pp`);
  log(`  Best vs PREV_5M_SIGN Δ(+10<-10)=${f1(materialVsPrev)} pp`);
  log("");

  // Favorable target curve for best
  log("FAVORABLE TARGET HITS ≤60m (best method)");
  log("-".repeat(78));
  for (const t of FAV_TARGETS) {
    const hit = rate(best, (e) => Number.isFinite(e.minutesTo10p) && e.maxFav[60]! >= t);
    // better: check maxFav[60]
    const hit2 = rate(best, (e) => (e.maxFav[60] ?? 0) >= t);
    log(`  +${t}p within 60m: ${f1(hit2)}%`);
    void hit;
  }
  log("");

  // Final questions
  const up = best.filter((e) => e.direction === "UP");
  const dn = best.filter((e) => e.direction === "DOWN");
  const dayRates = days.map((d) => ({
    d,
    r: rate(
      best.filter((e) => dayKey(e.signalTime) === d),
      (e) => e.hit10BeforeMinus10,
    ),
    n: best.filter((e) => dayKey(e.signalTime) === d).length,
  }));
  const daySpread = Math.max(...dayRates.map((x) => x.r)) - Math.min(...dayRates.map((x) => x.r));

  // strength improvement check: top vs bottom |mom| bucket
  const momSorted = [...best].sort((a, b) => Math.abs(b.recentMomentum) - Math.abs(a.recentMomentum));
  const topMom = momSorted.slice(0, Math.max(1, Math.floor(momSorted.length / 4)));
  const botMom = momSorted.slice(-Math.max(1, Math.floor(momSorted.length / 4)));
  const strengthHelps =
    rate(topMom, (e) => e.hit10BeforeMinus10) - rate(botMom, (e) => e.hit10BeforeMinus10) >= 5;

  const outperforms =
    materialVsRandom >= 5 && best1010 >= 55 && rate(best, (e) => e.hit10Within[30]!) >= 35;

  const step2 =
    outperforms && best.length >= 20
      ? "YES — enough evidence to run the next research experiment (M1 TREND → PULLBACK → BUY LOW / SELL HIGH), still research-only."
      : materialVsRandom >= 3 && best.length >= 15
        ? "MARGINAL — limited edge vs random; Step 2 only as a tightly scoped probe."
        : "NO — trend detector does not yet show clear material outperformance vs controls on this week.";

  log("FINAL SUMMARY");
  log("-".repeat(78));
  log(`1. Can M1 trend predict subsequent direction Sep14–18? ${best1010 >= 55 && materialVsRandom >= 3 ? "PARTIALLY YES on this week for best method" : "WEAK / UNCLEAR on this week"}`);
  log(`   Best +10 before -10 = ${f1(best1010)}% (N=${best.length}, method=${bestName}); vs random Δ=${f1(materialVsRandom)} pp`);
  log(`2. Strongest observed definition: ${bestName}`);
  log(`3. Independent episodes (best): ${best.length}`);
  log(`4. +10 before -10 (best): ${f1(best1010)}%`);
  log(
    `5. +10 within 15m / 30m / 60m: ${f1(rate(best, (e) => e.hit10Within[15]!))}% / ${f1(rate(best, (e) => e.hit10Within[30]!))}% / ${f1(rate(best, (e) => e.hit10Within[60]!))}%`,
  );
  log(
    `6. UP vs DOWN: UP N=${up.length} +10<-10 ${f1(rate(up, (e) => e.hit10BeforeMinus10))}% ; DOWN N=${dn.length} +10<-10 ${f1(rate(dn, (e) => e.hit10BeforeMinus10))}% → ${rate(up, (e) => e.hit10BeforeMinus10) >= rate(dn, (e) => e.hit10BeforeMinus10) ? "UP stronger or equal" : "DOWN stronger"}`,
  );
  log(`7. Day differences: max−min +10<-10 across days = ${f1(daySpread)} pp ${daySpread >= 15 ? "(SUBSTANTIAL)" : "(moderate/small)"}`);
  for (const x of dayRates) log(`   ${x.d.slice(5)}: N=${x.n} +10<-10 ${f1(x.r)}%`);
  log(`8. Stronger readings improve continuation? ${strengthHelps ? "YES (top vs bottom |momentum| quartile ≥5pp)" : "NOT CLEAR on this sample"}`);
  log(`9. Best vs controls material? vs RANDOM ${f1(materialVsRandom)} pp; vs PREV_5M ${f1(materialVsPrev)} pp → ${outperforms ? "YES" : "NO / weak"}`);
  log(`10. Enough for next experiment (trend→pullback entry)? ${step2}`);
  log("=".repeat(78));

  // CSV all episodes from all methods
  const headers = [
    "method",
    "direction",
    "signalTime",
    "signalPrice",
    "episodeEnd",
    "episodeMinutes",
    "ATR",
    "emaSeparation",
    "emaSlope",
    "recentMomentum",
    "maxFavorable5m",
    "maxAdverse5m",
    "maxFavorable15m",
    "maxAdverse15m",
    "maxFavorable30m",
    "maxAdverse30m",
    "maxFavorable60m",
    "maxAdverse60m",
    "hit10Within5m",
    "hit10Within15m",
    "hit10Within30m",
    "hit10Within60m",
    "hit10BeforeMinus10",
    "minutesTo10p",
  ];
  const lines = [headers.join(",")];
  for (const e of allEpisodes) {
    lines.push(
      [
        e.method,
        e.direction,
        e.signalTime,
        f5(e.signalPrice),
        e.episodeEnd,
        e.episodeMinutes,
        f2(e.atr),
        f2(e.emaSeparation),
        f2(e.emaSlope),
        f2(e.recentMomentum),
        f2(e.maxFav[5] ?? 0),
        f2(e.maxAdv[5] ?? 0),
        f2(e.maxFav[15] ?? 0),
        f2(e.maxAdv[15] ?? 0),
        f2(e.maxFav[30] ?? 0),
        f2(e.maxAdv[30] ?? 0),
        f2(e.maxFav[60] ?? 0),
        f2(e.maxAdv[60] ?? 0),
        e.hit10Within[5] ? 1 : 0,
        e.hit10Within[15] ? 1 : 0,
        e.hit10Within[30] ? 1 : 0,
        e.hit10Within[60] ? 1 : 0,
        e.hit10BeforeMinus10 ? 1 : 0,
        Number.isFinite(e.minutesTo10p) ? f1(e.minutesTo10p) : "",
      ].join(","),
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, L.join("\n") + "\n");
  fs.writeFileSync(OUT_CSV, lines.join("\n") + "\n");
  console.error(`\n[written] ${OUT_REPORT}`);
  console.error(`[written] ${OUT_CSV}`);
}

main();
