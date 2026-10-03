/**
 * EUR/USD H1 TREND DIRECTION RESEARCH
 * Evaluation window: Mon 2026-09-14 → Fri 2026-09-18
 *
 * Behavioral / directional only — no M1 entries, no pullbacks, no production changes.
 * Classifications at H1 close using only completed bars ≤ i.
 */
import fs from "node:fs";
import path from "node:path";

const PIP = 0.0001;
const EVAL_START = "2026-09-14T00:00:00.000000000Z";
const EVAL_END_EXCL = "2026-09-19T00:00:00.000000000Z";
const PIVOT_REACH = 2; // H1: 2 bars each side to confirm pivot
const HORIZON_H = 12;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-h1-trend-direction-sep14-18.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-h1-trend-direction-sep14-18-episodes.csv");
const M1_WINDOW =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-sep10-19-window.json";
const M15_CACHE = path.join(OUT_DIR, "cache", "eurusd-m15-mid-for-outer-10pip.json");

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
  episodeHours: number;
  emaFast: number;
  emaSlow: number;
  emaSeparation: number;
  emaSlope: number;
  momentum3H: number;
  momentum6H: number;
  momentum12H: number;
  momentum24H: number;
  directionCorrect: Record<number, boolean>;
  maxFav: Record<number, number>;
  maxAdv: Record<number, number>;
  hit10Within: Record<number, boolean>;
  hitTargetWithin: Record<string, boolean>; // `${pips}@${hours}`
  hit10BeforeMinus10: boolean;
  firstHit: Record<string, "FAV" | "ADV" | "NONE">;
  maxPullbackBefore10: number;
  maxPullbackBefore15: number;
  pullbackThen: Record<string, boolean>; // `pb${pb}_then_${fav}`
  minutesTo10: number;
  episodeNetPips: number;
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

function loadM1Rows(pathTry: string): Array<{ time: string; o: number; h: number; l: number; c: number }> {
  const raw = JSON.parse(fs.readFileSync(pathTry, "utf8")) as unknown[];
  const out: Array<{ time: string; o: number; h: number; l: number; c: number }> = [];
  for (const row of raw) {
    if (Array.isArray(row)) {
      const [t, bh, bl, ah, al, bc, ac] = row as [string, number, number, number, number, number, number];
      const h = (bh + ah) / 2;
      const l = (bl + al) / 2;
      const c = (bc + ac) / 2;
      out.push({ time: t, o: c, h, l, c });
    } else {
      const c = row as {
        time: string;
        complete?: boolean;
        mid?: { open: number; high: number; low: number; close: number };
        bid?: { high: number; low: number; close: number };
        ask?: { high: number; low: number; close: number };
      };
      if (c.complete === false) continue;
      if (c.mid) out.push({ time: c.time, o: c.mid.open, h: c.mid.high, l: c.mid.low, c: c.mid.close });
      else if (c.bid && c.ask) {
        out.push({
          time: c.time,
          o: (c.bid.close + c.ask.close) / 2,
          h: (c.bid.high + c.ask.high) / 2,
          l: (c.bid.low + c.ask.low) / 2,
          c: (c.bid.close + c.ask.close) / 2,
        });
      }
    }
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : 1));
}

function aggregateH1(m1: Array<{ time: string; o: number; h: number; l: number; c: number }>): Bar[] {
  const map = new Map<string, Bar>();
  for (const r of m1) {
    const ms = toMs(r.time);
    const hourMs = Math.floor(ms / 3_600_000) * 3_600_000;
    const key = new Date(hourMs).toISOString().replace(/\.\d{3}Z$/, ".000000000Z");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { time: key, open: r.o, high: r.h, low: r.l, close: r.c, ms: hourMs });
    } else {
      existing.high = Math.max(existing.high, r.h);
      existing.low = Math.min(existing.low, r.l);
      existing.close = r.c;
    }
  }
  return [...map.values()].sort((a, b) => a.ms - b.ms);
}

/** Also pull earlier warmup from M15 if available */
function loadH1WithWarmup(): { all: Bar[]; evalStartIdx: number; source: string } {
  const m1Path = fs.existsSync(M1_WINDOW) ? M1_WINDOW : null;
  if (!m1Path) throw new Error("Missing M1 window cache for H1 aggregation");
  process.stderr.write(`Aggregating H1 from M1: ${m1Path}\n`);
  let h1 = aggregateH1(loadM1Rows(m1Path));

  // Extend warmup from M15 if present (before Sep 10)
  if (fs.existsSync(M15_CACHE)) {
    const raw = JSON.parse(fs.readFileSync(M15_CACHE, "utf8")) as Array<{
      time: string;
      mid: { open: number; high: number; low: number; close: number };
      complete?: boolean;
    }>;
    const m15 = raw
      .filter((c) => c.complete !== false && c.mid && c.time < "2026-09-10T00:00:00Z" && c.time >= "2026-08-01T00:00:00Z")
      .map((c) => ({ time: c.time, o: c.mid.open, h: c.mid.high, l: c.mid.low, c: c.mid.close }));
    if (m15.length) {
      const early = aggregateH1(m15);
      const by = new Map(h1.map((b) => [b.time, b]));
      for (const b of early) if (!by.has(b.time)) by.set(b.time, b);
      h1 = [...by.values()].sort((a, b) => a.ms - b.ms);
    }
  }

  const evalStartIdx = h1.findIndex((b) => b.time >= EVAL_START);
  if (evalStartIdx < 0) throw new Error("No H1 bars in evaluation window");
  // trim end to eval window for results, but keep all for indicator warmup
  return {
    all: h1.filter((b) => b.time < EVAL_END_EXCL),
    evalStartIdx,
    source: `OANDA M1→H1 MID aggregate (+ optional M15 warmup)`,
  };
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

function buildEmaClass(
  closes: Float64Array,
  fast: number,
  slow: number,
  requireSlope: boolean,
  slopeBars = 3,
  slopeMinPips = 1,
): { cls: ClassSeries; ef: Float64Array; es: Float64Array } {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const n = closes.length;
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ef[i]) || !Number.isFinite(es[i])) continue;
    const sep = ef[i]! - es[i]!;
    let upOk = sep > 0;
    let dnOk = sep < 0;
    if (requireSlope && i >= slopeBars && Number.isFinite(ef[i - slopeBars])) {
      const slope = (ef[i]! - ef[i - slopeBars]!) / PIP;
      upOk = upOk && slope >= slopeMinPips;
      dnOk = dnOk && slope <= -slopeMinPips;
    }
    if (upOk) cls[i] = "UP";
    else if (dnOk) cls[i] = "DOWN";
  }
  return { cls, ef, es };
}

function buildMomClass(closes: Float64Array, hours: number, minPips: number): ClassSeries {
  const n = closes.length;
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  const thr = minPips * PIP;
  for (let i = hours; i < n; i++) {
    const d = closes[i]! - closes[i - hours]!;
    if (d >= thr) cls[i] = "UP";
    else if (d <= -thr) cls[i] = "DOWN";
  }
  return cls;
}

function buildStructureClass(bars: Bar[]): ClassSeries {
  const n = bars.length;
  const cls: ClassSeries = Array(n).fill("NO_TREND");
  const highs: Array<{ idx: number; price: number }> = [];
  const lows: Array<{ idx: number; price: number }> = [];
  for (let i = 0; i < n; i++) {
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
      if (isH) highs.push({ idx: center, price: c.high });
      if (isL) lows.push({ idx: center, price: c.low });
    }
    const hs = highs.slice(-3);
    const ls = lows.slice(-3);
    if (hs.length >= 2 && ls.length >= 2) {
      const hh = hs[hs.length - 1]!.price > hs[hs.length - 2]!.price;
      const hl = ls[ls.length - 1]!.price > ls[ls.length - 2]!.price;
      const lh = hs[hs.length - 1]!.price < hs[hs.length - 2]!.price;
      const ll = ls[ls.length - 1]!.price < ls[ls.length - 2]!.price;
      if (hh && hl) cls[i] = "UP";
      else if (lh && ll) cls[i] = "DOWN";
    }
  }
  return cls;
}

function and2(a: ClassSeries, b: ClassSeries): ClassSeries {
  return a.map((x, i) => {
    const y = b[i]!;
    if (x === "UP" && y === "UP") return "UP";
    if (x === "DOWN" && y === "DOWN") return "DOWN";
    return "NO_TREND";
  });
}
function and3(a: ClassSeries, b: ClassSeries, c: ClassSeries): ClassSeries {
  return and2(and2(a, b), c);
}

function evaluateEpisode(
  method: string,
  dir: Side,
  start: number,
  end: number,
  bars: Bar[],
  closes: Float64Array,
  ef: Float64Array | null,
  es: Float64Array | null,
): Episode {
  const sig = bars[start]!;
  const price = sig.close;
  const horizonEnd = Math.min(bars.length - 1, start + HORIZON_H);

  const maxFav: Record<number, number> = {};
  const maxAdv: Record<number, number> = {};
  const directionCorrect: Record<number, boolean> = {};
  const hit10Within: Record<number, boolean> = {};
  const hitTargetWithin: Record<string, boolean> = {};
  for (const h of [1, 2, 3, 4, 6, 12]) {
    maxFav[h] = 0;
    maxAdv[h] = 0;
    directionCorrect[h] = false;
    hit10Within[h] = false;
  }
  for (const p of [5, 10, 15, 20, 30]) {
    for (const h of [1, 2, 4, 6, 12]) hitTargetWithin[`${p}@${h}`] = false;
  }

  let runFav = 0;
  let runAdv = 0;
  let minutesTo10 = NaN;
  let maxPullbackBefore10 = NaN;
  let maxPullbackBefore15 = NaN;
  let got10 = false;
  let got15 = false;
  let pullbackRun = 0;
  const firstHit: Record<string, "FAV" | "ADV" | "NONE"> = {
    "5": "NONE",
    "10": "NONE",
    "15": "NONE",
    "20": "NONE",
  };
  let hit10BeforeMinus10 = false;
  const pbTargets = [2, 3, 5, 7.5, 10];
  const afterFav = [5, 10, 15];
  const sawPullback: Record<number, boolean> = {};
  for (const p of pbTargets) sawPullback[p] = false;
  const pullbackThen: Record<string, boolean> = {};

  for (let j = start + 1; j <= horizonEnd; j++) {
    const hours = j - start;
    const bar = bars[j]!;
    const favExt = dir === "UP" ? (bar.high - price) / PIP : (price - bar.low) / PIP;
    const advExt = dir === "UP" ? (price - bar.low) / PIP : (bar.high - price) / PIP;
    runFav = Math.max(runFav, favExt);
    runAdv = Math.max(runAdv, advExt);
    pullbackRun = Math.max(pullbackRun, advExt);

    for (const h of [1, 2, 3, 4, 6, 12]) {
      if (hours <= h) {
        maxFav[h] = Math.max(maxFav[h]!, favExt);
        maxAdv[h] = Math.max(maxAdv[h]!, advExt);
      }
    }

    for (const p of pbTargets) if (pullbackRun >= p) sawPullback[p] = true;
    for (const p of pbTargets) {
      for (const f of afterFav) {
        const key = `pb${p}_then_${f}`;
        if (sawPullback[p] && runFav >= f) pullbackThen[key] = true;
      }
    }

    for (const pair of ["5", "10", "15", "20"] as const) {
      const t = Number(pair);
      if (firstHit[pair] === "NONE") {
        if (runFav >= t) firstHit[pair] = "FAV";
        else if (runAdv >= t) firstHit[pair] = "ADV";
      }
    }

    if (!got10 && runFav >= 10) {
      got10 = true;
      minutesTo10 = hours * 60;
      maxPullbackBefore10 = pullbackRun;
      hit10BeforeMinus10 = runAdv < 10;
    }
    if (!got15 && runFav >= 15) {
      got15 = true;
      maxPullbackBefore15 = pullbackRun;
    }

    for (const p of [5, 10, 15, 20, 30]) {
      for (const h of [1, 2, 4, 6, 12]) {
        if (hours <= h && runFav >= p) hitTargetWithin[`${p}@${h}`] = true;
      }
    }
    for (const h of [1, 2, 3, 4, 6, 12]) {
      if (hours <= h && runFav >= 10) hit10Within[h] = true;
    }
  }

  // end-of-horizon direction accuracy (close vs signal)
  for (const h of [1, 2, 3, 4, 6, 12]) {
    const j = Math.min(bars.length - 1, start + h);
    if (j <= start) {
      directionCorrect[h] = false;
      continue;
    }
    const dClose = bars[j]!.close - price;
    directionCorrect[h] = dir === "UP" ? dClose > 0 : dClose < 0;
  }

  const mom = (h: number) => (start >= h ? (closes[start]! - closes[start - h]!) / PIP : NaN);
  const emaF = ef && Number.isFinite(ef[start]) ? ef[start]! : NaN;
  const emaS = es && Number.isFinite(es[start]) ? es[start]! : NaN;
  const emaSep = Number.isFinite(emaF) && Number.isFinite(emaS) ? (emaF - emaS) / PIP : NaN;
  let emaSlope = NaN;
  if (ef && start >= 3 && Number.isFinite(ef[start]) && Number.isFinite(ef[start - 3])) {
    emaSlope = (ef[start]! - ef[start - 3]!) / PIP;
  }

  return {
    method,
    direction: dir,
    signalIdx: start,
    signalTime: sig.time,
    signalPrice: price,
    endIdx: end,
    episodeEnd: bars[end]!.time,
    episodeHours: end - start + 1,
    emaFast: emaF,
    emaSlow: emaS,
    emaSeparation: emaSep,
    emaSlope,
    momentum3H: mom(3),
    momentum6H: mom(6),
    momentum12H: mom(12),
    momentum24H: mom(24),
    directionCorrect,
    maxFav,
    maxAdv,
    hit10Within,
    hitTargetWithin,
    hit10BeforeMinus10,
    firstHit,
    maxPullbackBefore10,
    maxPullbackBefore15,
    pullbackThen,
    minutesTo10,
    episodeNetPips:
      dir === "UP"
        ? (bars[end]!.close - bars[start]!.close) / PIP
        : (bars[start]!.close - bars[end]!.close) / PIP,
  };
}

function extractEpisodes(
  method: string,
  cls: ClassSeries,
  bars: Bar[],
  closes: Float64Array,
  evalStartIdx: number,
  ef: Float64Array | null,
  es: Float64Array | null,
): Episode[] {
  const n = bars.length;
  const eps: Episode[] = [];
  let i = evalStartIdx;
  while (i < n) {
    const cur = cls[i]!;
    const prev = i > 0 ? cls[i - 1]! : "NO_TREND";
    if ((cur === "UP" || cur === "DOWN") && prev !== cur) {
      const dir = cur;
      const start = i;
      i++;
      while (i < n && cls[i] === dir) i++;
      const end = i - 1;
      eps.push(evaluateEpisode(method, dir, start, end, bars, closes, ef, es));
      continue;
    }
    i++;
  }
  return eps;
}

function rate(eps: Episode[], pred: (e: Episode) => boolean): number {
  return pct(eps.filter(pred).length, eps.length);
}

function main(): void {
  const { all: bars, evalStartIdx, source } = loadH1WithWarmup();
  const closes = new Float64Array(bars.map((b) => b.close));
  const evalBars = bars.slice(evalStartIdx);
  const warmupCount = evalStartIdx;

  log("=".repeat(78));
  log("EUR/USD H1 TREND DIRECTION RESEARCH — Sep 14–18 2026");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("A. DATASET / INTEGRITY");
  log("-".repeat(78));
  log(`  Instrument: EUR_USD`);
  log(`  Primary: H1 MID (aggregated from OANDA M1 BA→MID)`);
  log(`  Source: ${source}`);
  log(`  Warmup candle count: ${warmupCount}`);
  log(`  First warmup candle: ${bars[0]?.time ?? "-"}`);
  log(`  First evaluation candle: ${bars[evalStartIdx]!.time}`);
  log(`  Last evaluation candle:  ${bars[bars.length - 1]!.time}`);
  log(`  Total H1 candles (warmup+eval): ${bars.length}`);
  log(`  Evaluation H1 candles: ${evalBars.length}`);
  log(`  Lookahead: none — classify at H1 close using bars ≤ i only`);
  log(`  Pivot confirm reach: ${PIVOT_REACH}`);
  log("");

  // Count NO_TREND hours etc. needs per-method

  process.stderr.write("Building detectors...\n");
  const ema510 = buildEmaClass(closes, 5, 10, false);
  const ema510s = buildEmaClass(closes, 5, 10, true);
  const ema920 = buildEmaClass(closes, 9, 20, false);
  const ema920s = buildEmaClass(closes, 9, 20, true);
  const ema1020 = buildEmaClass(closes, 10, 20, false);
  const ema1020s = buildEmaClass(closes, 10, 20, true);
  const ema2050 = buildEmaClass(closes, 20, 50, false);
  const ema2050s = buildEmaClass(closes, 20, 50, true);

  const mom3_5 = buildMomClass(closes, 3, 5);
  const mom6_5 = buildMomClass(closes, 6, 5);
  const mom6_10 = buildMomClass(closes, 6, 10);
  const mom12_10 = buildMomClass(closes, 12, 10);
  const mom12_15 = buildMomClass(closes, 12, 15);
  const mom24_15 = buildMomClass(closes, 24, 15);

  const struct = buildStructureClass(bars);

  type Meth = { name: string; cls: ClassSeries; ef: Float64Array | null; es: Float64Array | null };
  const methods: Meth[] = [
    { name: "A_EMA_5_10", cls: ema510.cls, ef: ema510.ef, es: ema510.es },
    { name: "A_EMA_5_10_SLOPE", cls: ema510s.cls, ef: ema510s.ef, es: ema510s.es },
    { name: "A_EMA_9_20", cls: ema920.cls, ef: ema920.ef, es: ema920.es },
    { name: "A_EMA_9_20_SLOPE", cls: ema920s.cls, ef: ema920s.ef, es: ema920s.es },
    { name: "A_EMA_10_20", cls: ema1020.cls, ef: ema1020.ef, es: ema1020.es },
    { name: "A_EMA_10_20_SLOPE", cls: ema1020s.cls, ef: ema1020s.ef, es: ema1020s.es },
    { name: "A_EMA_20_50", cls: ema2050.cls, ef: ema2050.ef, es: ema2050.es },
    { name: "A_EMA_20_50_SLOPE", cls: ema2050s.cls, ef: ema2050s.ef, es: ema2050s.es },
    { name: "B_MOM_3H_5p", cls: mom3_5, ef: null, es: null },
    { name: "B_MOM_6H_5p", cls: mom6_5, ef: null, es: null },
    { name: "B_MOM_6H_10p", cls: mom6_10, ef: null, es: null },
    { name: "B_MOM_12H_10p", cls: mom12_10, ef: null, es: null },
    { name: "B_MOM_12H_15p", cls: mom12_15, ef: null, es: null },
    { name: "B_MOM_24H_15p", cls: mom24_15, ef: null, es: null },
    { name: "C_STRUCTURE", cls: struct, ef: null, es: null },
    { name: "D_EMA9_20S+MOM6_10", cls: and2(ema920s.cls, mom6_10), ef: ema920s.ef, es: ema920s.es },
    { name: "E_STRUCT+MOM6_10", cls: and2(struct, mom6_10), ef: null, es: null },
    { name: "F_ALL_THREE", cls: and3(ema920s.cls, mom6_10, struct), ef: ema920s.ef, es: ema920s.es },
  ];

  const byMethod = new Map<string, Episode[]>();
  const allEpisodes: Episode[] = [];
  for (const m of methods) {
    const eps = extractEpisodes(m.name, m.cls, bars, closes, evalStartIdx, m.ef, m.es);
    byMethod.set(m.name, eps);
    allEpisodes.push(...eps);
  }

  // Pick best: require N>=10; prioritize +10 before -10, then 4H accuracy
  let bestName = methods[0]!.name;
  let bestScore = -1;
  for (const m of methods) {
    const eps = byMethod.get(m.name)!;
    if (eps.length < 10) continue;
    const score =
      rate(eps, (e) => e.hit10BeforeMinus10) +
      0.4 * rate(eps, (e) => e.directionCorrect[4]!) +
      0.2 * rate(eps, (e) => e.hit10Within[4]!);
    if (score > bestScore) {
      bestScore = score;
      bestName = m.name;
    }
  }
  // Fallback if nothing has N>=10
  if (bestScore < 0) {
    for (const m of methods) {
      const eps = byMethod.get(m.name)!;
      if (eps.length < 5) continue;
      const score = rate(eps, (e) => e.hit10BeforeMinus10);
      if (score > bestScore) {
        bestScore = score;
        bestName = m.name;
      }
    }
  }
  const best = byMethod.get(bestName)!;
  const bestCls = methods.find((m) => m.name === bestName)!.cls;

  log("B. H1 TREND METHODS");
  log("-".repeat(78));
  log("METHOD | N | 1Hacc | 4Hacc | +10<-10 | +10≤4H | medDur(H)");
  for (const m of methods) {
    const eps = byMethod.get(m.name)!;
    log(
      [
        m.name.padEnd(22),
        String(eps.length).padStart(3),
        f1(rate(eps, (e) => e.directionCorrect[1]!)),
        f1(rate(eps, (e) => e.directionCorrect[4]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
        f1(rate(eps, (e) => e.hit10Within[4]!)),
        f1(median(eps.map((e) => e.episodeHours))),
      ].join(" | "),
    );
  }
  log(`  BEST (by score): ${bestName} N=${best.length}`);
  log("");

  log("C. DIRECTION ACCURACY");
  log("-".repeat(78));
  log("METHOD | N | 1H | 2H | 3H | 4H | 6H | 12H");
  for (const m of methods) {
    const eps = byMethod.get(m.name)!;
    log(
      [
        m.name.padEnd(22),
        String(eps.length).padStart(3),
        ...([1, 2, 3, 4, 6, 12] as const).map((h) => f1(rate(eps, (e) => e.directionCorrect[h]!))),
      ].join(" | "),
    );
  }
  log("");

  log("D. FIRST-HIT RESULTS");
  log("-".repeat(78));
  log("METHOD | N | +5<-5 | +10<-10 | +15<-15 | +20<-20");
  for (const m of methods) {
    const eps = byMethod.get(m.name)!;
    log(
      [
        m.name.padEnd(22),
        String(eps.length).padStart(3),
        f1(rate(eps, (e) => e.firstHit["5"] === "FAV")),
        f1(rate(eps, (e) => e.firstHit["10"] === "FAV")),
        f1(rate(eps, (e) => e.firstHit["15"] === "FAV")),
        f1(rate(eps, (e) => e.firstHit["20"] === "FAV")),
      ].join(" | "),
    );
  }
  log("");

  log("E. PIP CONTINUATION (+10 hit by horizon)");
  log("-".repeat(78));
  log("METHOD | N | ≤1H | ≤2H | ≤4H | ≤6H | ≤12H");
  for (const m of methods) {
    const eps = byMethod.get(m.name)!;
    log(
      [
        m.name.padEnd(22),
        String(eps.length).padStart(3),
        ...([1, 2, 4, 6, 12] as const).map((h) => f1(rate(eps, (e) => e.hit10Within[h]!))),
      ].join(" | "),
    );
  }
  log("  Target curve @4H (best method):");
  for (const p of [5, 10, 15, 20, 30]) {
    log(`    +${p}p ≤4H: ${f1(rate(best, (e) => e.hitTargetWithin[`${p}@4`]!))}%`);
  }
  log("");

  log("F. UP VS DOWN (best: " + bestName + ")");
  log("-".repeat(78));
  log("DIR | N | 1Hacc | 4Hacc | +10<-10 | +10≤2H | ≤4H | ≤6H");
  for (const d of ["UP", "DOWN"] as const) {
    const eps = best.filter((e) => e.direction === d);
    log(
      [
        d,
        eps.length,
        f1(rate(eps, (e) => e.directionCorrect[1]!)),
        f1(rate(eps, (e) => e.directionCorrect[4]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
        f1(rate(eps, (e) => e.hit10Within[2]!)),
        f1(rate(eps, (e) => e.hit10Within[4]!)),
        f1(rate(eps, (e) => e.hit10Within[6]!)),
      ].join(" | "),
    );
  }
  log("");

  log("G. RESULTS BY DAY (best: " + bestName + ")");
  log("-".repeat(78));
  // NO_TREND time share on eval bars
  const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  log("DAY | UP eps | DN eps | NO_TREND% | 4Hacc | +10<-10 | +10≤4H | +10≤6H");
  for (const d of days) {
    const eps = best.filter((e) => dayKey(e.signalTime) === d);
    const dayIdxs = [];
    for (let i = evalStartIdx; i < bars.length; i++) if (dayKey(bars[i]!.time) === d) dayIdxs.push(i);
    const noTrend = dayIdxs.filter((i) => bestCls[i] === "NO_TREND").length;
    log(
      [
        d.slice(5),
        eps.filter((e) => e.direction === "UP").length,
        eps.filter((e) => e.direction === "DOWN").length,
        f1(pct(noTrend, dayIdxs.length)),
        f1(rate(eps, (e) => e.directionCorrect[4]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
        f1(rate(eps, (e) => e.hit10Within[4]!)),
        f1(rate(eps, (e) => e.hit10Within[6]!)),
      ].join(" | "),
    );
  }
  log("");

  log("H. TREND EPISODE DURATION (best)");
  log("-".repeat(78));
  {
    const durs = best.map((e) => e.episodeHours);
    const nets = best.map((e) => e.episodeNetPips);
    log(`  N=${best.length}`);
    log(`  Duration (H): avg=${f1(mean(durs))} med=${f1(median(durs))} P25=${f1(quantile(durs, 0.25))} P75=${f1(quantile(durs, 0.75))} max=${f1(Math.max(...durs, 0))}`);
    log(`  Episode net pips: med=${f1(median(nets))} avg=${f1(mean(nets))}`);
  }
  log("");

  log("I. PULLBACK BEHAVIOR (best method, after detection)");
  log("-".repeat(78));
  log("  Did price pull back X then reach +Y above/below signal?");
  for (const pb of [2, 3, 5, 7.5, 10]) {
    for (const fav of [5, 10, 15]) {
      const key = `pb${pb}_then_${fav}`;
      const r = rate(best, (e) => !!e.pullbackThen[key]);
      log(`  pullback≥${pb}p then +${fav}p: ${f1(r)}% (N=${best.length})`);
    }
  }
  {
    const pb10 = best.filter((e) => e.hit10Within[12]).map((e) => e.maxPullbackBefore10).filter(Number.isFinite);
    const pb15 = best.filter((e) => (e.maxFav[12] ?? 0) >= 15).map((e) => e.maxPullbackBefore15).filter(Number.isFinite);
    log(`  Max pullback before +10 (among +10 hitters): med=${f1(median(pb10))} P75=${f1(quantile(pb10, 0.75))} P90=${f1(quantile(pb10, 0.9))} N=${pb10.length}`);
    log(`  Max pullback before +15: med=${f1(median(pb15))} P75=${f1(quantile(pb15, 0.75))} N=${pb15.length}`);
  }
  log("");

  log("J. CONTROL COMPARISON (same episode start times as best)");
  log("-".repeat(78));

  function controlEps(name: string, pick: (start: number) => Side): Episode[] {
    return best.map((e) => evaluateEpisode(`CTL_${name}`, pick(e.signalIdx), e.signalIdx, e.signalIdx, bars, closes, null, null));
  }

  const controls: Array<[string, Episode[]]> = [
    ["BEST_" + bestName, best],
    [
      "PREV_H1_DIR",
      controlEps("PREV_H1", (i) => {
        if (i < 1) return "UP";
        return closes[i]! >= closes[i - 1]! ? "UP" : "DOWN";
      }),
    ],
    [
      "PREV_3H_DIR",
      controlEps("PREV_3H", (i) => {
        if (i < 3) return "UP";
        return closes[i]! >= closes[i - 3]! ? "UP" : "DOWN";
      }),
    ],
    [
      "PREV_6H_DIR",
      controlEps("PREV_6H", (i) => {
        if (i < 6) return "UP";
        return closes[i]! >= closes[i - 6]! ? "UP" : "DOWN";
      }),
    ],
    ["ALWAYS_LONG", controlEps("LONG", () => "UP")],
    ["ALWAYS_SHORT", controlEps("SHORT", () => "DOWN")],
    [
      "RANDOM",
      controlEps("RAND", (i) => ((Math.imul(i + 91, 1103515245) >>> 0) & 1 ? "UP" : "DOWN")),
    ],
  ];

  log("NAME | N | 1Hacc | 4Hacc | +10<-10 | +10≤4H");
  for (const [name, eps] of controls) {
    log(
      [
        name.padEnd(28),
        String(eps.length).padStart(3),
        f1(rate(eps, (e) => e.directionCorrect[1]!)),
        f1(rate(eps, (e) => e.directionCorrect[4]!)),
        f1(rate(eps, (e) => e.hit10BeforeMinus10)),
        f1(rate(eps, (e) => e.hit10Within[4]!)),
      ].join(" | "),
    );
  }
  const best1010 = rate(best, (e) => e.hit10BeforeMinus10);
  const prev6 = controls.find((c) => c[0] === "PREV_6H_DIR")![1];
  const rand = controls.find((c) => c[0] === "RANDOM")![1];
  const alwaysShort = controls.find((c) => c[0] === "ALWAYS_SHORT")![1];
  const dPrev6 = best1010 - rate(prev6, (e) => e.hit10BeforeMinus10);
  const dRand = best1010 - rate(rand, (e) => e.hit10BeforeMinus10);
  const dShort = best1010 - rate(alwaysShort, (e) => e.hit10BeforeMinus10);
  log(`  Best vs PREV_6H Δ(+10<-10)=${f1(dPrev6)} pp`);
  log(`  Best vs RANDOM Δ(+10<-10)=${f1(dRand)} pp`);
  log(`  Best vs ALWAYS_SHORT Δ(+10<-10)=${f1(dShort)} pp`);
  log("");

  // Compare to M1 study published numbers
  const M1_BEST_1010 = 26.2;
  const M1_BEST_30M = 16.4;
  const M1_BEST_60M = 26.2;

  const h1_1h = rate(best, (e) => e.directionCorrect[1]!);
  const h1_4h = rate(best, (e) => e.directionCorrect[4]!);
  const h1_6h = rate(best, (e) => e.directionCorrect[6]!);
  const h1_10_1 = rate(best, (e) => e.hit10Within[1]!);
  const h1_10_2 = rate(best, (e) => e.hit10Within[2]!);
  const h1_10_4 = rate(best, (e) => e.hit10Within[4]!);
  const h1_10_6 = rate(best, (e) => e.hit10Within[6]!);

  const up = best.filter((e) => e.direction === "UP");
  const dn = best.filter((e) => e.direction === "DOWN");
  const outperformsControls = dPrev6 >= 5 && dRand >= 5 && best1010 >= 45;
  const betterThanM1 = best1010 >= M1_BEST_1010 + 5 || h1_4h >= 55;

  const step2 =
    outperformsControls && best.length >= 8
      ? "YES — enough to justify NEXT research experiment: H1 TREND → M1 PULLBACK → turn confirm → 10p target (still research-only)."
      : betterThanM1 && dRand >= 3 && best.length >= 8
        ? "MARGINAL — H1 looks more usable than M1 this week, but control edge is limited; next step only as a scoped probe."
        : "NO — H1 direction filter not yet strong enough vs simple controls to justify the M1 pullback entry experiment.";

  log("FINAL QUESTIONS");
  log("-".repeat(78));
  log(
    `1. Better than M1 trend test this week? ${betterThanM1 ? "YES / LIKELY" : "NO / NOT CLEAR"} (H1 +10<-10=${f1(best1010)}% vs M1 best ${M1_BEST_1010}%; M1 +10≤30m/60m were ${M1_BEST_30M}%/${M1_BEST_60M}%)`,
  );
  log(`2. Best H1 method: ${bestName}`);
  log(`3. Independent episodes: ${best.length}`);
  log(`4. Direction accuracy 1H / 4H / 6H: ${f1(h1_1h)}% / ${f1(h1_4h)}% / ${f1(h1_6h)}%`);
  log(`5. +10 before -10: ${f1(best1010)}%`);
  log(`6. +10 within 1H / 2H / 4H / 6H: ${f1(h1_10_1)}% / ${f1(h1_10_2)}% / ${f1(h1_10_4)}% / ${f1(h1_10_6)}%`);
  log(
    `7. UP vs DOWN: UP N=${up.length} +10<-10 ${f1(rate(up, (e) => e.hit10BeforeMinus10))}% ; DOWN N=${dn.length} +10<-10 ${f1(rate(dn, (e) => e.hit10BeforeMinus10))}% → ${rate(dn, (e) => e.hit10BeforeMinus10) >= rate(up, (e) => e.hit10BeforeMinus10) ? "DOWN stronger or equal" : "UP stronger"}`,
  );
  log(`8. H1 trend duration: med ${f1(median(best.map((e) => e.episodeHours)))}H, avg ${f1(mean(best.map((e) => e.episodeHours)))}H`);
  {
    const pb10 = best.filter((e) => e.hit10Within[12]).map((e) => e.maxPullbackBefore10).filter(Number.isFinite);
    log(`9. Pullbacks before successful +10: med ${f1(median(pb10))}p, P75 ${f1(quantile(pb10, 0.75))}p (N=${pb10.length})`);
  }
  log(`10. Outperform simple controls? vs PREV_6H ${f1(dPrev6)} pp, vs RANDOM ${f1(dRand)} pp, vs ALWAYS_SHORT ${f1(dShort)} pp → ${outperformsControls ? "YES" : "NO / weak"}`);
  log(`11. Justify next experiment (H1→M1 pullback)? ${step2}`);
  log("=".repeat(78));

  const headers = [
    "method",
    "direction",
    "signalTime",
    "signalPrice",
    "episodeEnd",
    "episodeHours",
    "emaFast",
    "emaSlow",
    "emaSeparation",
    "emaSlope",
    "momentum3H",
    "momentum6H",
    "momentum12H",
    "momentum24H",
    "directionCorrect1H",
    "directionCorrect2H",
    "directionCorrect4H",
    "directionCorrect6H",
    "directionCorrect12H",
    "maxFavorable1H",
    "maxAdverse1H",
    "maxFavorable2H",
    "maxAdverse2H",
    "maxFavorable4H",
    "maxAdverse4H",
    "maxFavorable6H",
    "maxAdverse6H",
    "maxFavorable12H",
    "maxAdverse12H",
    "hit10Within1H",
    "hit10Within2H",
    "hit10Within4H",
    "hit10Within6H",
    "hit10Within12H",
    "hit10BeforeMinus10",
    "maxPullbackBefore10",
    "minutesTo10",
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
        e.episodeHours,
        f5(e.emaFast),
        f5(e.emaSlow),
        f2(e.emaSeparation),
        f2(e.emaSlope),
        f2(e.momentum3H),
        f2(e.momentum6H),
        f2(e.momentum12H),
        f2(e.momentum24H),
        e.directionCorrect[1] ? 1 : 0,
        e.directionCorrect[2] ? 1 : 0,
        e.directionCorrect[4] ? 1 : 0,
        e.directionCorrect[6] ? 1 : 0,
        e.directionCorrect[12] ? 1 : 0,
        f2(e.maxFav[1] ?? 0),
        f2(e.maxAdv[1] ?? 0),
        f2(e.maxFav[2] ?? 0),
        f2(e.maxAdv[2] ?? 0),
        f2(e.maxFav[4] ?? 0),
        f2(e.maxAdv[4] ?? 0),
        f2(e.maxFav[6] ?? 0),
        f2(e.maxAdv[6] ?? 0),
        f2(e.maxFav[12] ?? 0),
        f2(e.maxAdv[12] ?? 0),
        e.hit10Within[1] ? 1 : 0,
        e.hit10Within[2] ? 1 : 0,
        e.hit10Within[4] ? 1 : 0,
        e.hit10Within[6] ? 1 : 0,
        e.hit10Within[12] ? 1 : 0,
        e.hit10BeforeMinus10 ? 1 : 0,
        Number.isFinite(e.maxPullbackBefore10) ? f2(e.maxPullbackBefore10) : "",
        Number.isFinite(e.minutesTo10) ? f1(e.minutesTo10) : "",
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
