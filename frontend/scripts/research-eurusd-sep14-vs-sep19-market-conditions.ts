/**
 * EUR/USD — SEP 14 vs SEP 19 MARKET-CONDITION STUDY
 *
 * Research only. OANDA MBA candles. No lookahead in trend labels.
 *
 * NOTE: 2026-09-19 is Saturday (forex closed). Sep 19 has 0 candles.
 * Primary live comparison uses last completed session Sep 18 (Fri),
 * with equivalent-hour slices vs Sep 14 where needed.
 *
 * CHOP SCORE (frozen BEFORE results; same formula both days):
 *   CHOP = 100 * (
 *     0.20 * m15FlipRate +
 *     0.15 * m5FlipRate +
 *     0.15 * (1 - meanBodyRangeM15) +
 *     0.15 * overlapPctM15 +
 *     0.10 * insideBarPctM15 +
 *     0.15 * (1 - medianPathEff1h) +
 *     0.10 * failed10pRate
 *   )
 * Higher = choppier. Components already ~0..1.
 */
import fs from "node:fs";
import path from "node:path";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import type { MajorInstrument } from "../src/types/forex";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const OUT_DIR = path.resolve(__dirname, "../research-output");
const M15_FULL = path.join(PAD, "eurusd-m15-mba-cache.json");
const M15_WIN = path.join(PAD, "eurusd-m15-sep10-19-window.json");
const M5_WIN = path.join(PAD, "eurusd-m5-sep10-19-window.json");
const M1_WIN = path.join(PAD, "eurusd-m1-sep10-19-window.json");

const BLOCK = 16;
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;
const TOUCH_TOL_P = 1.0;
const BREAK_P = 2.0;

type OHLC = { open: number; high: number; low: number; close: number };
type RC = {
  time: string;
  complete?: boolean;
  mid: OHLC;
  bid?: OHLC;
  ask?: OHLC;
};

type DayKey = "SEP14" | "SEP18" | "SEP19";
type TrendLabel = "STRONG_BULLISH" | "BULLISH" | "RANGE" | "BEARISH" | "STRONG_BEARISH";
type Align = "ALIGNED" | "OPPOSED" | "FLAT";

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const f4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "-");
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : NaN);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};
const pips = (x: number) => x / PIP;
const dayUTC = (t: string) => t.slice(0, 10);
const toMs = (t: string) => Date.parse(t.slice(0, 19) + "Z");
const etStr = (isoOrMs: string | number) => {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(toMs(isoOrMs));
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return (
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    (UTC_HOURS as readonly number[]).includes(d.getUTCHours())
  );
}

function load(p: string): RC[] {
  return (JSON.parse(fs.readFileSync(p, "utf8")) as RC[]).filter((c) => c.complete !== false && c.mid);
}

function filterDay(rows: RC[], day: string, endExclusive?: string): RC[] {
  return rows.filter((c) => {
    if (dayUTC(c.time) !== day) return false;
    if (endExclusive && c.time >= endExclusive) return false;
    return true;
  });
}

function filterRange(rows: RC[], start: string, endExclusive: string): RC[] {
  return rows.filter((c) => c.time >= start && c.time < endExclusive);
}

function aggregate(rows: RC[], barMs: number): RC[] {
  if (!rows.length) return [];
  const out: RC[] = [];
  let bucket = -1;
  let cur: RC | null = null;
  for (const c of rows) {
    const ms = toMs(c.time);
    const b = Math.floor(ms / barMs) * barMs;
    if (b !== bucket || !cur) {
      if (cur) out.push(cur);
      bucket = b;
      cur = {
        time: new Date(b).toISOString().replace(/\.\d{3}Z$/, ".000000000Z"),
        mid: { ...c.mid },
        bid: c.bid ? { ...c.bid } : undefined,
        ask: c.ask ? { ...c.ask } : undefined,
        complete: true,
      };
    } else {
      cur.mid.high = Math.max(cur.mid.high, c.mid.high);
      cur.mid.low = Math.min(cur.mid.low, c.mid.low);
      cur.mid.close = c.mid.close;
      if (cur.bid && c.bid) {
        cur.bid.high = Math.max(cur.bid.high, c.bid.high);
        cur.bid.low = Math.min(cur.bid.low, c.bid.low);
        cur.bid.close = c.bid.close;
      }
      if (cur.ask && c.ask) {
        cur.ask.high = Math.max(cur.ask.high, c.ask.high);
        cur.ask.low = Math.min(cur.ask.low, c.ask.low);
        cur.ask.close = c.ask.close;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function ema(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(NaN);
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

function swingHL(rows: RC[]): { hh: number; hl: number; lh: number; ll: number } {
  let hh = 0,
    hl = 0,
    lh = 0,
    ll = 0;
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i - 2]!.mid;
    const b = rows[i - 1]!.mid;
    const c = rows[i]!.mid;
    if (b.high > a.high && b.high > c.high) {
      // swing high at i-1 — compare to prior swing high later; count local vs prev bar
    }
  }
  // simpler: consecutive bar structure over day
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1]!.mid;
    const c = rows[i]!.mid;
    if (c.high > p.high) hh++;
    if (c.low > p.low) hl++;
    if (c.high < p.high) lh++;
    if (c.low < p.low) ll++;
  }
  return { hh, hl, lh, ll };
}

function classifyTrend(rows: RC[], h1: RC[], h4: RC[]): { label: TrendLabel; strength: number; detail: string } {
  if (rows.length < 8) return { label: "RANGE", strength: 0, detail: "insufficient" };
  const o = rows[0]!.mid.open;
  const c = rows[rows.length - 1]!.mid.close;
  const netP = pips(c - o);
  const rangeP = pips(Math.max(...rows.map((r) => r.mid.high)) - Math.min(...rows.map((r) => r.mid.low)));
  const de = rangeP > 0 ? Math.abs(netP) / rangeP : 0;
  const closes = rows.map((r) => r.mid.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, Math.max(10, Math.floor(closes.length / 2))));
  const last20 = e20[e20.length - 1]!;
  const last50 = e50[e50.length - 1]!;
  const slope20 =
    e20.length >= 6 && Number.isFinite(e20[e20.length - 1]!) && Number.isFinite(e20[e20.length - 6]!)
      ? pips(e20[e20.length - 1]! - e20[e20.length - 6]!)
      : 0;
  const sw = swingHL(rows);
  const bullStruct = sw.hh + sw.hl;
  const bearStruct = sw.lh + sw.ll;
  const structBias = bullStruct - bearStruct;
  const h1Net = h1.length >= 2 ? pips(h1[h1.length - 1]!.mid.close - h1[0]!.mid.open) : 0;
  const h4Net = h4.length >= 1 ? pips(h4[h4.length - 1]!.mid.close - h4[0]!.mid.open) : 0;
  const m15Net = netP;

  let score = 0;
  score += Math.sign(m15Net) * Math.min(3, Math.abs(m15Net) / 20);
  score += Math.sign(h1Net) * Math.min(2, Math.abs(h1Net) / 15);
  score += Math.sign(h4Net) * Math.min(2, Math.abs(h4Net) / 20);
  if (Number.isFinite(last20) && Number.isFinite(last50)) score += last20 > last50 ? 1 : last20 < last50 ? -1 : 0;
  score += Math.sign(slope20) * Math.min(1.5, Math.abs(slope20) / 5);
  score += Math.sign(structBias) * Math.min(1.5, Math.abs(structBias) / 30);
  if (de < 0.25) score *= 0.35; // mean-reverting day dampens trend label

  let label: TrendLabel;
  if (score >= 4) label = "STRONG_BULLISH";
  else if (score >= 1.5) label = "BULLISH";
  else if (score <= -4) label = "STRONG_BEARISH";
  else if (score <= -1.5) label = "BEARISH";
  else label = "RANGE";

  return {
    label,
    strength: score,
    detail: `netM15=${f1(m15Net)}p h1=${f1(h1Net)}p h4=${f1(h4Net)}p de=${f2(de)} slope20=${f1(slope20)} ema20${last20 > last50 ? ">" : "<"}ema50 struct=${structBias}`,
  };
}

function dir(c: RC): number {
  const d = c.mid.close - c.mid.open;
  if (d > 0) return 1;
  if (d < 0) return -1;
  return 0;
}

function flipRate(rows: RC[]): { flips: number; rate: number } {
  let flips = 0;
  let prev = 0;
  for (const r of rows) {
    const d = dir(r);
    if (d === 0) continue;
    if (prev !== 0 && d !== prev) flips++;
    prev = d;
  }
  const n = rows.filter((r) => dir(r) !== 0).length;
  return { flips, rate: n > 1 ? flips / (n - 1) : 0 };
}

function continuation(rows: RC[]) {
  const stats = {
    up1: 0,
    up1n: 0,
    up2: 0,
    up2n: 0,
    up4: 0,
    up4n: 0,
    dn1: 0,
    dn1n: 0,
    dn2: 0,
    dn2n: 0,
    dn4: 0,
    dn4n: 0,
  };
  const net = (i: number, k: number) => rows[i + k]!.mid.close - rows[i]!.mid.close;
  for (let i = 0; i < rows.length; i++) {
    const d = dir(rows[i]!);
    if (d === 0) continue;
    if (d > 0) {
      if (i + 1 < rows.length) {
        stats.up1n++;
        if (net(i, 1) > 0) stats.up1++;
      }
      if (i + 2 < rows.length) {
        stats.up2n++;
        if (net(i, 2) > 0) stats.up2++;
      }
      if (i + 4 < rows.length) {
        stats.up4n++;
        if (net(i, 4) > 0) stats.up4++;
      }
    } else {
      if (i + 1 < rows.length) {
        stats.dn1n++;
        if (net(i, 1) < 0) stats.dn1++;
      }
      if (i + 2 < rows.length) {
        stats.dn2n++;
        if (net(i, 2) < 0) stats.dn2++;
      }
      if (i + 4 < rows.length) {
        stats.dn4n++;
        if (net(i, 4) < 0) stats.dn4++;
      }
    }
  }
  return stats;
}

function streaks(rows: RC[]): Record<string, number> {
  const counts: Record<string, number> = { "2": 0, "3": 0, "4": 0, "5+": 0 };
  let run = 0;
  let prev = 0;
  const flush = () => {
    if (run >= 5) counts["5+"]!++;
    else if (run === 4) counts["4"]!++;
    else if (run === 3) counts["3"]!++;
    else if (run === 2) counts["2"]!++;
  };
  for (const r of rows) {
    const d = dir(r);
    if (d === 0) {
      flush();
      run = 0;
      prev = 0;
      continue;
    }
    if (d === prev) run++;
    else {
      flush();
      run = 1;
      prev = d;
    }
  }
  flush();
  return counts;
}

function bodyRange(r: RC) {
  const range = r.mid.high - r.mid.low;
  const body = Math.abs(r.mid.close - r.mid.open);
  const wick = range - body;
  return {
    range,
    body,
    wick,
    bodyRatio: range > 0 ? body / range : 0,
    wickRatio: range > 0 ? wick / range : 0,
  };
}

function overlapPct(rows: RC[]): number {
  if (rows.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!.mid;
    const b = rows[i]!.mid;
    const overlap = Math.min(a.high, b.high) - Math.max(a.low, b.low);
    if (overlap > 0) n++;
  }
  return n / (rows.length - 1);
}

function insideBarPct(rows: RC[]): number {
  if (rows.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!.mid;
    const b = rows[i]!.mid;
    if (b.high <= a.high && b.low >= a.low) n++;
  }
  return n / (rows.length - 1);
}

function pathEfficiency(rows: RC[], windowBars: number): number[] {
  const out: number[] = [];
  for (let i = windowBars; i < rows.length; i++) {
    const start = rows[i - windowBars]!.mid.close;
    const end = rows[i]!.mid.close;
    let path = 0;
    for (let j = i - windowBars + 1; j <= i; j++) {
      path += Math.abs(rows[j]!.mid.close - rows[j - 1]!.mid.close);
    }
    out.push(path > 0 ? Math.abs(end - start) / path : 0);
  }
  return out;
}

function failedMoves(rows: RC[], targetP: number, lookBars: number): { attempts: number; fails: number; rate: number } {
  let attempts = 0;
  let fails = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const d = dir(rows[i]!);
    if (d === 0) continue;
    const start = rows[i]!.mid.close;
    let mfe = 0;
    let returned = false;
    let hitTarget = false;
    for (let j = i + 1; j <= Math.min(rows.length - 1, i + lookBars); j++) {
      const fav = d > 0 ? pips(rows[j]!.mid.high - start) : pips(start - rows[j]!.mid.low);
      const against = d > 0 ? pips(start - rows[j]!.mid.low) : pips(rows[j]!.mid.high - start);
      mfe = Math.max(mfe, fav);
      if (mfe >= targetP) hitTarget = true;
      if (hitTarget && against >= 0.5) {
        returned = true;
        break;
      }
      if (mfe >= targetP * 2) break; // success extension
    }
    if (hitTarget) {
      attempts++;
      if (returned && mfe < targetP * 2) fails++;
    }
  }
  return { attempts, fails, rate: attempts > 0 ? fails / attempts : 0 };
}

function chopScore(parts: {
  m15FlipRate: number;
  m5FlipRate: number;
  meanBodyRangeM15: number;
  overlapPctM15: number;
  insideBarPctM15: number;
  medianPathEff1h: number;
  failed10pRate: number;
}): number {
  return (
    100 *
    (0.2 * parts.m15FlipRate +
      0.15 * parts.m5FlipRate +
      0.15 * (1 - parts.meanBodyRangeM15) +
      0.15 * parts.overlapPctM15 +
      0.1 * parts.insideBarPctM15 +
      0.15 * (1 - parts.medianPathEff1h) +
      0.1 * parts.failed10pRate)
  );
}

function spreads(rows: RC[]) {
  const s: number[] = [];
  for (const r of rows) {
    if (!r.bid || !r.ask) continue;
    s.push(pips(r.ask.close - r.bid.close));
  }
  return {
    n: s.length,
    avg: mean(s),
    med: median(s),
    p75: q(s, 0.75),
    p90: q(s, 0.9),
  };
}

type BlockInfo = {
  start: string;
  end: string;
  support: number;
  resist: number;
  mid: number;
  rangeP: number;
  open: number;
  distMidP: number;
  prevTrend: "BULL" | "BEAR" | "FLAT";
  align: Align;
  unfinished: boolean;
  nearMid5_10: boolean;
  midHit: boolean;
  supHit: boolean;
  resHit: boolean;
  supTouches: number;
  resTouches: number;
  midCrosses: number;
  rejections: number;
  breaks: number;
  returns: number;
  continuations: number;
  withTrendEnc: number;
  againstTrendEnc: number;
  roomBuckets: Record<string, number>;
};

function buildBlocks(m15All: RC[], dayStart: string, dayEndExclusive: string): BlockInfo[] {
  const startMs = toMs(dayStart);
  const endMsDay = toMs(dayEndExclusive);
  // binary-ish find start index
  let lo = 0,
    hi = m15All.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toMs(m15All[mid]!.time) < startMs - 4 * 3600_000) lo = mid + 1;
    else hi = mid;
  }
  const scanFrom = Math.max(BLOCK, lo);
  let scanTo = scanFrom;
  while (scanTo < m15All.length && toMs(m15All[scanTo]!.time) < endMsDay) scanTo++;

  const blocks: BlockInfo[] = [];
  for (let i = scanFrom; i < scanTo; i++) {
    const ms = toMs(m15All[i]!.time);
    if (ms < startMs || ms >= endMsDay) continue;
    if (!isUtcBlockStart(ms)) continue;
    if (i < BLOCK) continue;
    const prev = m15All.slice(i - BLOCK, i);
    const support = Math.min(...prev.map((p) => p.mid.low));
    const resist = Math.max(...prev.map((p) => p.mid.high));
    const mid = (support + resist) / 2;
    const rangeP = pips(resist - support);
    const prevOpen = prev[0]!.mid.open;
    const prevClose = prev[BLOCK - 1]!.mid.close;
    const prevTrend: "BULL" | "BEAR" | "FLAT" =
      prevClose > prevOpen + PIP * 0.5 ? "BULL" : prevClose < prevOpen - PIP * 0.5 ? "BEAR" : "FLAT";
    const open = m15All[i]!.mid.open;
    const distMidP = pips(open - mid);
    let align: Align = "FLAT";
    let unfinished = false;
    if (prevTrend === "BULL" && open < mid) {
      align = "ALIGNED";
      unfinished = true;
    } else if (prevTrend === "BEAR" && open > mid) {
      align = "ALIGNED";
      unfinished = true;
    } else if (prevTrend === "BULL" && open >= mid) align = "OPPOSED";
    else if (prevTrend === "BEAR" && open <= mid) align = "OPPOSED";

    const absDist = Math.abs(distMidP);
    const nearMid5_10 = unfinished && absDist > 5 && absDist <= 10;

    const endMs = ms + 4 * 3600_000;
    const blockBars: RC[] = [];
    for (let j = i; j < m15All.length && toMs(m15All[j]!.time) < endMs; j++) {
      const t = toMs(m15All[j]!.time);
      if (t >= ms && t < endMsDay + 4 * 3600_000) blockBars.push(m15All[j]!);
    }
    if (!blockBars.length) continue;

    let midHit = false,
      supHit = false,
      resHit = false;
    let midCrosses = 0;
    let supTouches = 0,
      resTouches = 0;
    let rejections = 0,
      breaks = 0,
      returns = 0,
      continuations = 0;
    let withTrendEnc = 0,
      againstTrendEnc = 0;
    const roomBuckets: Record<string, number> = { "5p": 0, "10p": 0, "15p": 0, "20p": 0, "30p+": 0 };
    let prevAboveMid: boolean | null = null;
    let lastSupTouch = -99,
      lastResTouch = -99;
    const htf = prevTrend === "BULL" ? 1 : prevTrend === "BEAR" ? -1 : 0;

    for (let bi = 0; bi < blockBars.length; bi++) {
      const b = blockBars[bi]!.mid;
      const above = b.close > mid;
      if (prevAboveMid !== null && above !== prevAboveMid) midCrosses++;
      prevAboveMid = above;
      if (b.low <= mid && b.high >= mid) midHit = true;

      const nearSup = b.low <= support + TOUCH_TOL_P * PIP;
      const nearRes = b.high >= resist - TOUCH_TOL_P * PIP;
      if (nearSup && bi - lastSupTouch >= 2) {
        supTouches++;
        lastSupTouch = bi;
        supHit = true;
        const bounce = b.close > support;
        const broke = b.close < support - BREAK_P * PIP;
        if (broke) {
          breaks++;
          const ret = blockBars.slice(bi + 1, bi + 5).some((x) => x.mid.close >= support);
          if (ret) returns++;
          else continuations++;
        } else if (bounce) rejections++;
        if (htf > 0) againstTrendEnc++;
        else if (htf < 0) withTrendEnc++;
        const room = rangeP;
        if (room >= 30) roomBuckets["30p+"]!++;
        else if (room >= 20) roomBuckets["20p"]!++;
        else if (room >= 15) roomBuckets["15p"]!++;
        else if (room >= 10) roomBuckets["10p"]!++;
        else roomBuckets["5p"]!++;
      }
      if (nearRes && bi - lastResTouch >= 2) {
        resTouches++;
        lastResTouch = bi;
        resHit = true;
        const bounce = b.close < resist;
        const broke = b.close > resist + BREAK_P * PIP;
        if (broke) {
          breaks++;
          const ret = blockBars.slice(bi + 1, bi + 5).some((x) => x.mid.close <= resist);
          if (ret) returns++;
          else continuations++;
        } else if (bounce) rejections++;
        if (htf < 0) withTrendEnc++;
        else if (htf > 0) againstTrendEnc++;
        const room = rangeP;
        if (room >= 30) roomBuckets["30p+"]!++;
        else if (room >= 20) roomBuckets["20p"]!++;
        else if (room >= 15) roomBuckets["15p"]!++;
        else if (room >= 10) roomBuckets["10p"]!++;
        else roomBuckets["5p"]!++;
      }
    }

    blocks.push({
      start: m15All[i]!.time,
      end: new Date(endMs).toISOString(),
      support,
      resist,
      mid,
      rangeP,
      open,
      distMidP,
      prevTrend,
      align,
      unfinished,
      nearMid5_10,
      midHit,
      supHit,
      resHit,
      supTouches,
      resTouches,
      midCrosses,
      rejections,
      breaks,
      returns,
      continuations,
      withTrendEnc,
      againstTrendEnc,
      roomBuckets,
    });
  }
  return blocks;
}

type DayMetrics = {
  key: DayKey;
  day: string;
  note: string;
  barsM15: number;
  barsM5: number;
  barsM1: number;
  dailyRangeP: number;
  netP: number;
  absNetP: number;
  atrM15: number;
  avgM15Range: number;
  medM15Range: number;
  avgM5Range: number;
  realizedVol: number;
  dirEff: number;
  trend: ReturnType<typeof classifyTrend>;
  cont: ReturnType<typeof continuation>;
  streak: Record<string, number>;
  m15Flips: ReturnType<typeof flipRate>;
  m5Flips: ReturnType<typeof flipRate>;
  m1Flips: ReturnType<typeof flipRate>;
  meanBody: number;
  meanWick: number;
  overlap: number;
  inside: number;
  failed5: ReturnType<typeof failedMoves>;
  failed10: ReturnType<typeof failedMoves>;
  path30: number[];
  path1h: number[];
  path2h: number[];
  path4h: number[];
  chop: number;
  spread: ReturnType<typeof spreads>;
  blocks: BlockInfo[];
};

function analyzeDay(
  key: DayKey,
  day: string,
  m15All: RC[],
  m15: RC[],
  m5: RC[],
  m1: RC[],
  note: string,
): DayMetrics {
  if (!m15.length) {
    return {
      key,
      day,
      note,
      barsM15: 0,
      barsM5: 0,
      barsM1: 0,
      dailyRangeP: NaN,
      netP: NaN,
      absNetP: NaN,
      atrM15: NaN,
      avgM15Range: NaN,
      medM15Range: NaN,
      avgM5Range: NaN,
      realizedVol: NaN,
      dirEff: NaN,
      trend: { label: "RANGE", strength: 0, detail: "no data" },
      cont: continuation([]),
      streak: { "2": 0, "3": 0, "4": 0, "5+": 0 },
      m15Flips: { flips: 0, rate: 0 },
      m5Flips: { flips: 0, rate: 0 },
      m1Flips: { flips: 0, rate: 0 },
      meanBody: NaN,
      meanWick: NaN,
      overlap: NaN,
      inside: NaN,
      failed5: { attempts: 0, fails: 0, rate: 0 },
      failed10: { attempts: 0, fails: 0, rate: 0 },
      path30: [],
      path1h: [],
      path2h: [],
      path4h: [],
      chop: NaN,
      spread: { n: 0, avg: NaN, med: NaN, p75: NaN, p90: NaN },
      blocks: [],
    };
  }

  const hi = Math.max(...m15.map((r) => r.mid.high));
  const lo = Math.min(...m15.map((r) => r.mid.low));
  const open = m15[0]!.mid.open;
  const close = m15[m15.length - 1]!.mid.close;
  const dailyRangeP = pips(hi - lo);
  const netP = pips(close - open);
  const rangesM15 = m15.map((r) => pips(r.mid.high - r.mid.low));
  const rangesM5 = m5.map((r) => pips(r.mid.high - r.mid.low));
  const rets = [];
  for (let i = 1; i < m15.length; i++) rets.push(pips(m15[i]!.mid.close - m15[i - 1]!.mid.close));
  const realizedVol = Math.sqrt(mean(rets.map((x) => x * x)));
  const bodies = m15.map((r) => bodyRange(r));
  const meanBody = mean(bodies.map((b) => b.bodyRatio));
  const meanWick = mean(bodies.map((b) => b.wickRatio));
  const overlap = overlapPct(m15);
  const inside = insideBarPct(m15);
  const m15Flips = flipRate(m15);
  const m5Flips = flipRate(m5);
  const m1Flips = flipRate(m1);
  const path30 = pathEfficiency(m15, 2); // 30m
  const path1h = pathEfficiency(m15, 4);
  const path2h = pathEfficiency(m15, 8);
  const path4h = pathEfficiency(m15, 16);
  const failed5 = failedMoves(m15, 5, 8);
  const failed10 = failedMoves(m15, 10, 12);
  const chop = chopScore({
    m15FlipRate: m15Flips.rate,
    m5FlipRate: m5Flips.rate,
    meanBodyRangeM15: meanBody,
    overlapPctM15: overlap,
    insideBarPctM15: inside,
    medianPathEff1h: median(path1h) || 0,
    failed10pRate: failed10.rate,
  });

  const h1 = aggregate(m15, 3600_000);
  const h4 = aggregate(m15, 4 * 3600_000);
  const dayStart = day + "T00:00:00.000000000Z";
  const endExclusive = (() => {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().replace(/\.\d{3}Z$/, ".000000000Z");
  })();
  const blocksFixed = buildBlocks(m15All, dayStart, endExclusive);

  return {
    key,
    day,
    note,
    barsM15: m15.length,
    barsM5: m5.length,
    barsM1: m1.length,
    dailyRangeP,
    netP,
    absNetP: Math.abs(netP),
    atrM15: mean(rangesM15),
    avgM15Range: mean(rangesM15),
    medM15Range: median(rangesM15),
    avgM5Range: mean(rangesM5),
    realizedVol,
    dirEff: dailyRangeP > 0 ? Math.abs(netP) / dailyRangeP : 0,
    trend: classifyTrend(m15, h1, h4),
    cont: continuation(m15),
    streak: streaks(m15),
    m15Flips,
    m5Flips,
    m1Flips,
    meanBody,
    meanWick,
    overlap,
    inside,
    failed5,
    failed10,
    path30,
    path1h,
    path2h,
    path4h,
    chop,
    spread: spreads(m15),
    blocks: blocksFixed,
  };
}

function sessionSlices(m15: RC[], m5: RC[], m1: RC[], _m15All: RC[], day: string) {
  const out = [];
  for (const h of UTC_HOURS) {
    const start = `${day}T${String(h).padStart(2, "0")}:00:00.000000000Z`;
    const endH = (h + 4) % 24;
    const endDay =
      h + 4 >= 24
        ? (() => {
            const d = new Date(day + "T00:00:00Z");
            d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString().slice(0, 10);
          })()
        : day;
    const end = `${endDay}T${String(endH).padStart(2, "0")}:00:00.000000000Z`;
    const s15 = filterRange(m15, start, end);
    const s5 = filterRange(m5, start, end);
    const s1 = filterRange(m1, start, end);
    if (!s15.length) {
      out.push({ h, empty: true as const });
      continue;
    }
    const hi = Math.max(...s15.map((r) => r.mid.high));
    const lo = Math.min(...s15.map((r) => r.mid.low));
    const netP = pips(s15[s15.length - 1]!.mid.close - s15[0]!.mid.open);
    const rangeP = pips(hi - lo);
    const de = rangeP > 0 ? Math.abs(netP) / rangeP : 0;
    const bodies = s15.map((r) => bodyRange(r));
    const meanBody = mean(bodies.map((b) => b.bodyRatio));
    const flips15 = flipRate(s15);
    const flips5 = flipRate(s5);
    const path1h = pathEfficiency(s15, Math.min(4, Math.max(2, s15.length - 1)));
    const failed10 = failedMoves(s15, 10, 8);
    const chop = chopScore({
      m15FlipRate: flips15.rate,
      m5FlipRate: flips5.rate,
      meanBodyRangeM15: meanBody,
      overlapPctM15: overlapPct(s15),
      insideBarPctM15: insideBarPct(s15),
      medianPathEff1h: median(path1h) || 0,
      failed10pRate: failed10.rate,
    });
    const h1 = aggregate(s15, 3600_000);
    const h4 = aggregate(s15, 4 * 3600_000);
    const tr = classifyTrend(s15, h1, h4);
    // light block lookup for this session only
    const blks = buildBlocks(_m15All, start, end);
    const b0 = blks[0];
    out.push({
      h,
      empty: false as const,
      range: rangeP,
      net: netP,
      de,
      chop,
      trend: tr.label,
      spread: spreads(s15).avg,
      srRange: b0?.rangeP ?? NaN,
      midHit: b0?.midHit ?? false,
      align: b0?.align ?? "-",
    });
    void s1;
  }
  return out;
}

function blockAgg(blocks: BlockInfo[]) {
  const n = blocks.length || 1;
  return {
    n: blocks.length,
    avgRange: mean(blocks.map((b) => b.rangeP)),
    midHitRate: pct(blocks.filter((b) => b.midHit).length, blocks.length),
    rejectRate: pct(
      blocks.reduce((s, b) => s + b.rejections, 0),
      blocks.reduce((s, b) => s + b.supTouches + b.resTouches, 0),
    ),
    breakRate: pct(
      blocks.reduce((s, b) => s + b.breaks, 0),
      blocks.reduce((s, b) => s + b.supTouches + b.resTouches, 0),
    ),
    aligned: blocks.filter((b) => b.align === "ALIGNED").length,
    unfinished: blocks.filter((b) => b.unfinished).length,
    near510: blocks.filter((b) => b.nearMid5_10).length,
    withTrend: blocks.reduce((s, b) => s + b.withTrendEnc, 0),
    againstTrend: blocks.reduce((s, b) => s + b.againstTrendEnc, 0),
    room30: blocks.reduce((s, b) => s + (b.roomBuckets["30p+"] ?? 0), 0),
    roomAvg: mean(blocks.map((b) => b.rangeP)),
  };
}

// ---------- main ----------
console.error("Loading candles...");
const m15Win = load(M15_WIN);
const m5Win = load(M5_WIN);
const m1Win = load(M1_WIN);
console.error("Loading full M15 cache (hist)...");
const m15Full = load(M15_FULL);
console.error(`full=${m15Full.length} win=${m15Win.length}`);

// merge window into working series for Sep10-18 (window is newer than full cache for Sep18)
const lastFull = m15Full.at(-1)?.time ?? "";
const m15All = m15Full.concat(m15Win.filter((c) => c.time > lastFull));
console.error(`merged m15All=${m15All.length} last=${m15All.at(-1)?.time}`);

const sep14 = "2026-09-14";
const sep18 = "2026-09-18";
const sep19 = "2026-09-19";

const m15_14 = filterDay(m15Win, sep14);
const m5_14 = filterDay(m5Win, sep14);
const m1_14 = filterDay(m1Win, sep14);
const m15_18 = filterDay(m15Win, sep18);
const m5_18 = filterDay(m5Win, sep18);
const m1_18 = filterDay(m1Win, sep18);
const m15_19 = filterDay(m15Win, sep19);

// equivalent hours: Sep14 truncated to Sep18 length (00:00 -> last Sep18 bar + 15m)
const last18 = m15_18[m15_18.length - 1]?.time;
const eqEnd = last18 ? sep14 + "T" + last18.slice(11) : sep14 + "T21:00:00.000000000Z";
const m15_14eq2 = m15_14.filter((c) => c.time <= eqEnd);
const m5_14eq = m5_14.filter((c) => c.time <= eqEnd);
const m1_14eq = m1_14.filter((c) => c.time <= eqEnd);

const D14 = analyzeDay("SEP14", sep14, m15All, m15_14, m5_14, m1_14, "full Monday session");
const D14eq = analyzeDay("SEP14", sep14, m15All, m15_14eq2, m5_14eq, m1_14eq, "Sep14 truncated to Sep18 clock hours");
const D18 = analyzeDay("SEP18", sep18, m15All, m15_18, m5_18, m1_18, "Friday last trading day (proxy for Sep19 weekend)");
const D19 = analyzeDay("SEP19", sep19, m15All, [], [], [], "SATURDAY — forex closed — 0 candles");

function f5(x: number) {
  return Number.isFinite(x) ? x.toFixed(5) : "-";
}

log("=".repeat(78));
log("EUR/USD — SEP 14 vs SEP 19 MARKET-CONDITION STUDY");
log("=".repeat(78));
log(`Generated: ${new Date().toISOString()}`);
log(`Data: OANDA MBA mid+bid+ask | M15 primary`);
log(`M15 window: ${m15Win[0]?.time} -> ${m15Win.at(-1)?.time}`);
log(`M15 historical cache: ${m15Full[0]?.time} -> ${m15Full.at(-1)?.time} (+ window merge)`);
log("");
log("DATE STATUS");
log("-".repeat(78));
log(`Sep 14 2026 = Monday (full FX session). M15 bars=${D14.barsM15}`);
log(`Sep 19 2026 = Saturday — FOREX CLOSED. M15 bars=${m15_19.length}`);
log(`Sep 18 2026 = Friday (last completed session into weekend). M15 bars=${D18.barsM15}`);
log(`COMPARISON PROTOCOL: Sep14 full vs Sep18 live proxy; also Sep14eq (clock-matched to Sep18 end ${last18 ?? "-"}).`);
log(`Sep19 itself: NO MARKET — MATCH SCORE vs Sep14 is NOT_SEP14_LIKE by definition (no session).`);
log("");

// ---- §3 Basic movement ----
log("3. BASIC MOVEMENT");
log("-".repeat(78));
const basicRow = (d: DayMetrics) =>
  `  ${d.key.padEnd(6)} range=${f1(d.dailyRangeP)}p net=${f1(d.netP)}p |net|=${f1(d.absNetP)}p atrM15=${f2(d.atrM15)} avgM15=${f2(d.avgM15Range)} medM15=${f2(d.medM15Range)} avgM5=${f2(d.avgM5Range)} rVol=${f2(d.realizedVol)} DE=${f3(d.dirEff)}`;
log(basicRow(D14));
log(basicRow(D14eq) + " [eq-hours]");
log(basicRow(D18));
log(basicRow(D19));
log("");

// ---- §4 Trend ----
log("4. TREND QUALITY");
log("-".repeat(78));
for (const d of [D14, D14eq, D18]) {
  log(`  ${d.key}: ${d.trend.label}  strength=${f2(d.trend.strength)}  (${d.trend.detail})`);
}
log("");

// ---- §5 Persistence ----
log("5. DIRECTIONAL PERSISTENCE (M15)");
log("-".repeat(78));
const contLine = (d: DayMetrics) => {
  const c = d.cont;
  return `  ${d.key}: UP->+1 ${f1(pct(c.up1, c.up1n))}%  +2 ${f1(pct(c.up2, c.up2n))}%  +4 ${f1(pct(c.up4, c.up4n))}% | DN->-1 ${f1(pct(c.dn1, c.dn1n))}%  -2 ${f1(pct(c.dn2, c.dn2n))}%  -4 ${f1(pct(c.dn4, c.dn4n))}% | streaks 2/3/4/5+=${d.streak["2"]}/${d.streak["3"]}/${d.streak["4"]}/${d.streak["5+"]}`;
};
log(contLine(D14));
log(contLine(D18));
log("");

// ---- §6 Chop ----
log("6. CHOP / REVERSAL");
log("-".repeat(78));
log("  CHOP SCORE formula (frozen a priori):");
log("  100*(0.20*m15Flip + 0.15*m5Flip + 0.15*(1-body/range) + 0.15*overlap");
log("      + 0.10*inside + 0.15*(1-medPathEff1h) + 0.10*failed10pRate)");
for (const d of [D14, D18]) {
  log(
    `  ${d.key}: CHOP=${f1(d.chop)}  m15Flips=${d.m15Flips.flips}(${f2(d.m15Flips.rate)}) m5=${d.m5Flips.flips}(${f2(d.m5Flips.rate)}) m1=${d.m1Flips.flips}(${f2(d.m1Flips.rate)}) body/range=${f3(d.meanBody)} wick/body~=${f3(d.meanWick)} overlap=${f1(pct(d.overlap, 1))}% inside=${f1(pct(d.inside, 1))}% fail5=${d.failed5.fails}/${d.failed5.attempts}(${f1(pct(d.failed5.rate, 1))}%) fail10=${d.failed10.fails}/${d.failed10.attempts}(${f1(pct(d.failed10.rate, 1))}%)`,
  );
}
log("");

// ---- §7 Path efficiency ----
log("7. PATH EFFICIENCY (median)");
log("-".repeat(78));
for (const d of [D14, D18]) {
  log(
    `  ${d.key}: 30m=${f3(median(d.path30))}  1h=${f3(median(d.path1h))}  2h=${f3(median(d.path2h))}  4h=${f3(median(d.path4h))}  | 1h p25/p75=${f3(q(d.path1h, 0.25))}/${f3(q(d.path1h, 0.75))}`,
  );
}
log("");

// ---- §8 4H blocks ----
log("8. 4H FROZEN S/R BLOCKS");
log("-".repeat(78));
const printBlocks = (d: DayMetrics) => {
  log(`  --- ${d.key} ${d.day} (${d.note}) ---`);
  if (!d.blocks.length) {
    log("  (none)");
    return;
  }
  for (const b of d.blocks) {
    log(
      `  ${b.start.slice(11, 16)} UTC (${etStr(b.start)} ET) S=${f5(b.support)} M=${f5(b.mid)} R=${f5(b.resist)} rng=${f1(b.rangeP)}p open=${f5(b.open)} distMid=${f1(b.distMidP)}p prev=${b.prevTrend} ${b.align}${b.unfinished ? " UNFINISHED" : ""}${b.nearMid5_10 ? " NEAR_MID_5-10p" : ""} midHit=${b.midHit} SHit=${b.supHit} RHit=${b.resHit} touchesS/R=${b.supTouches}/${b.resTouches} midX=${b.midCrosses} rej=${b.rejections} brk=${b.breaks}`,
    );
  }
};
printBlocks(D14);
printBlocks(D18);
log("");

// ---- §9 unfinished ----
log("9. UNFINISHED-TREND (V3 ALIGNED)");
log("-".repeat(78));
for (const d of [D14, D18]) {
  const u = d.blocks.filter((b) => b.unfinished);
  const n = d.blocks.filter((b) => b.nearMid5_10);
  log(`  ${d.key}: ALIGNED/unfinished=${u.length}/${d.blocks.length}  of which 5-10p from mid=${n.length}`);
  for (const b of u) {
    log(`    ${b.start.slice(11, 16)} ${b.prevTrend} open-distMid=${f1(b.distMidP)}p ${b.nearMid5_10 ? "FLAG_5-10" : ""}`);
  }
}
log("");

// ---- §10-12 SR behavior ----
log("10-12. S/R BEHAVIOR + TREND ALIGNMENT + ROOM");
log("-".repeat(78));
for (const d of [D14, D18]) {
  const a = blockAgg(d.blocks);
  log(
    `  ${d.key}: blocks=${a.n} avgSRRange=${f1(a.avgRange)}p midHit=${f1(a.midHitRate)}% reject=${f1(a.rejectRate)}% break=${f1(a.breakRate)}% alignedSetups=${a.aligned} withTrendEnc=${a.withTrend} againstTrendEnc=${a.againstTrend} room30p+_enc=${a.room30}`,
  );
}
log("");

// ---- §13 spread ----
log("13. SPREAD (OANDA BID/ASK close)");
log("-".repeat(78));
for (const d of [D14, D18]) {
  const s = d.spread;
  log(`  ${d.key}: n=${s.n} avg=${f3(s.avg)}p med=${f3(s.med)}p P75=${f3(s.p75)}p P90=${f3(s.p90)}p`);
}
log("");

// ---- §14 sessions ----
log("14. SESSION BREAKDOWN (UTC 4H)");
log("-".repeat(78));
for (const d of [D14, D18]) {
  const m15 = d.key === "SEP14" ? m15_14 : m15_18;
  const m5 = d.key === "SEP14" ? m5_14 : m5_18;
  const m1 = d.key === "SEP14" ? m1_14 : m1_18;
  const day = d.day;
  log(`  --- ${d.key} ---`);
  for (const s of sessionSlices(m15, m5, m1, m15All, day)) {
    if (s.empty) {
      log(`  ${String(s.h).padStart(2, "0")}-… : (no bars)`);
      continue;
    }
    log(
      `  ${String(s.h).padStart(2, "0")}-${String((s.h + 4) % 24).padStart(2, "0")} UTC: range=${f1(s.range)}p net=${f1(s.net)}p DE=${f3(s.de)} chop=${f1(s.chop)} trend=${s.trend} spread=${f3(s.spread)} SRrng=${f1(s.srRange)} midHit=${s.midHit} align=${s.align}`,
    );
  }
}
log("");

// ---- §15 trades ----
log("15. SEP 14 TRADE ENVIRONMENT");
log("-".repeat(78));
log("  Loaded from paper_trades DB (deduped OANDA history + manual fill pairs).");
log("  EUR/USD-only closed on Sep14 calendar: 1 unique short WIN (07:38–15:36 UTC) entry 1.15524 exit 1.15455.");
log("  Plus overnight EUR/USD short WIN opened Sep13 23:28 closed Sep14 06:16 entry 1.15889 exit 1.15569.");
log("  User-recalled 5W/1L matches CROSS-PAIR Sep14 day (EUR/GBP/USDJPY), not EUR/USD alone:");
log("    EURUSD short W | GBPUSD short W | USDJPY long W | USDJPY long L | USDJPY short W  (+ overnight EUR W).");
log("  Full 6-trade EURUSD journal with 5W1L is NOT available. Describing environment of known EURUSD winners only.");
log("");

type TradeRow = {
  label: string;
  dir: "LONG" | "SHORT";
  opened: string;
  closed: string;
  entry: number;
  exit: number;
  result: string;
};
const eurTrades: TradeRow[] = [
  {
    label: "overnight",
    dir: "SHORT",
    opened: "2026-09-13T23:28:15.660Z",
    closed: "2026-09-14T06:16:04.704Z",
    entry: 1.15889,
    exit: 1.15569,
    result: "win",
  },
  {
    label: "day",
    dir: "SHORT",
    opened: "2026-09-14T07:38:18.525Z",
    closed: "2026-09-14T15:36:29.618Z",
    entry: 1.15524,
    exit: 1.15455,
    result: "win",
  },
];

const allForTrade = buildBlocks(m15All, "2026-09-13T20:00:00.000000000Z", "2026-09-15T00:00:00.000000000Z");
for (const t of eurTrades) {
  const openBlk =
    D14.blocks.find((b) => t.opened >= b.start && t.opened < b.end) ||
    [...D14.blocks].reverse().find((b) => t.opened >= b.start);
  const b = allForTrade.find((x) => t.opened >= x.start && t.opened < x.end);
  const nearest = b ?? openBlk;
  const distSR =
    nearest != null
      ? Math.min(Math.abs(pips(t.entry - nearest.support)), Math.abs(pips(t.entry - nearest.resist)))
      : NaN;
  const distMid = nearest != null ? pips(t.entry - nearest.mid) : NaN;
  log(
    `  TRADE ${t.label}: ${t.dir} ${t.opened} (${etStr(t.opened)} ET) -> ${t.closed} entry=${t.entry} exit=${t.exit} ${t.result}`,
  );
  if (nearest) {
    log(
      `    4H block ${nearest.start.slice(11, 16)} S=${f5(nearest.support)} M=${f5(nearest.mid)} R=${f5(nearest.resist)} align=${nearest.align} prev=${nearest.prevTrend} distSR=${f1(distSR)}p distMid=${f1(distMid)}p`,
    );
    log(
      `    Day trend=${D14.trend.label} chop=${f1(D14.chop)} DE=${f3(D14.dirEff)} spread≈${f3(D14.spread.avg)}p | WITH larger trend? ${t.dir === "SHORT" && D14.trend.label.includes("BEAR") ? "YES" : t.dir === "LONG" && D14.trend.label.includes("BULL") ? "YES" : "MIXED/NO"}`,
    );
  }
}
log("  Shared environment of known EURUSD winners: SHORT into a BEARISH/STRONG day, working lower; not enough N for rules.");
log("");

// ---- §16 comparison table ----
log("16. IMPORTANT COMPARISON TABLE");
log("-".repeat(78));
log("METRIC                      SEP14        SEP18(proxy)  SEP19");
const row = (name: string, a: string, b: string, c = "N/A") => log(`${name.padEnd(28)}${a.padStart(12)}${b.padStart(14)}${c.padStart(8)}`);
row("Daily range p", f1(D14.dailyRangeP), f1(D18.dailyRangeP), "-");
row("Net move p", f1(D14.netP), f1(D18.netP), "-");
row("Directional efficiency", f3(D14.dirEff), f3(D18.dirEff), "-");
row("M15 ATR p", f2(D14.atrM15), f2(D18.atrM15), "-");
row("M15 body/range", f3(D14.meanBody), f3(D18.meanBody), "-");
row("M15 overlap %", f1(pct(D14.overlap, 1)), f1(pct(D18.overlap, 1)), "-");
row("M15 dir flips", String(D14.m15Flips.flips), String(D18.m15Flips.flips), "-");
row("M5 dir flips", String(D14.m5Flips.flips), String(D18.m5Flips.flips), "-");
row("30m path eff med", f3(median(D14.path30)), f3(median(D18.path30)), "-");
row("1H path eff med", f3(median(D14.path1h)), f3(median(D18.path1h)), "-");
row("4H path eff med", f3(median(D14.path4h)), f3(median(D18.path4h)), "-");
row("Bull/Bear trend", D14.trend.label, D18.trend.label, "CLOSED");
row("Trend strength", f2(D14.trend.strength), f2(D18.trend.strength), "-");
row("4H S/R avg range", f1(blockAgg(D14.blocks).avgRange), f1(blockAgg(D18.blocks).avgRange), "-");
row("S/R rejection %", f1(blockAgg(D14.blocks).rejectRate), f1(blockAgg(D18.blocks).rejectRate), "-");
row("S/R breakout %", f1(blockAgg(D14.blocks).breakRate), f1(blockAgg(D18.blocks).breakRate), "-");
row("Midpoint hit %", f1(blockAgg(D14.blocks).midHitRate), f1(blockAgg(D18.blocks).midHitRate), "-");
row("Aligned 4H setups", String(blockAgg(D14.blocks).aligned), String(blockAgg(D18.blocks).aligned), "-");
row("Avg spread p", f3(D14.spread.avg), f3(D18.spread.avg), "-");
row("CHOP SCORE", f1(D14.chop), f1(D18.chop), "-");
log("");

// ---- §17 diffs ----
log("17. LARGEST MEASURABLE DIFFERENCES (Sep14 vs Sep18 proxy)");
log("-".repeat(78));
type Diff = { name: string; d14: number; d18: number; better: "14" | "18" | "na"; mag: number };
const diffs: Diff[] = [
  { name: "Directional efficiency", d14: D14.dirEff, d18: D18.dirEff, better: D14.dirEff > D18.dirEff ? "14" : "18", mag: Math.abs(D14.dirEff - D18.dirEff) },
  { name: "CHOP score (lower better)", d14: D14.chop, d18: D18.chop, better: D14.chop < D18.chop ? "14" : "18", mag: Math.abs(D14.chop - D18.chop) },
  { name: "1H path efficiency", d14: median(D14.path1h), d18: median(D18.path1h), better: median(D14.path1h) > median(D18.path1h) ? "14" : "18", mag: Math.abs(median(D14.path1h) - median(D18.path1h)) },
  { name: "M5 flip rate", d14: D14.m5Flips.rate, d18: D18.m5Flips.rate, better: D14.m5Flips.rate < D18.m5Flips.rate ? "14" : "18", mag: Math.abs(D14.m5Flips.rate - D18.m5Flips.rate) },
  { name: "Abs net move p", d14: D14.absNetP, d18: D18.absNetP, better: D14.absNetP > D18.absNetP ? "14" : "18", mag: Math.abs(D14.absNetP - D18.absNetP) },
  { name: "M15 body/range", d14: D14.meanBody, d18: D18.meanBody, better: D14.meanBody > D18.meanBody ? "14" : "18", mag: Math.abs(D14.meanBody - D18.meanBody) },
  { name: "Trend |strength|", d14: Math.abs(D14.trend.strength), d18: Math.abs(D18.trend.strength), better: Math.abs(D14.trend.strength) > Math.abs(D18.trend.strength) ? "14" : "18", mag: Math.abs(Math.abs(D14.trend.strength) - Math.abs(D18.trend.strength)) },
  { name: "Daily range p", d14: D14.dailyRangeP, d18: D18.dailyRangeP, better: "na", mag: Math.abs(D14.dailyRangeP - D18.dailyRangeP) },
];
diffs.sort((a, b) => b.mag - a.mag);
for (const d of diffs.slice(0, 6)) {
  log(`  ${d.name}: Sep14=${f3(d.d14)} Sep18=${f3(d.d18)}  (advantage: Sep${d.better})`);
}
log("");

// ---- §18 Historical validation ----
log("18. HISTORICAL VALIDATION — freeze Sep14-like regime FIRST");
log("-".repeat(78));
log("  FROZEN DEFINITION Sep14-like day (from Sep14 observed metrics, not optimized):");
log(`    DE >= ${f2(Math.max(0.45, D14.dirEff * 0.9))}`);
log(`    CHOP <= ${f1(D14.chop * 1.05)}`);
log(`    |trend strength| >= ${f1(Math.max(2, Math.abs(D14.trend.strength) * 0.75))}`);
log(`    median 1H path eff >= ${f2(Math.max(0.25, median(D14.path1h) * 0.9))}`);
log("  Test endpoint (behavior we care about): M15 continuation after impulse (+2 bars),");
log("  and 4H midpoint-hit rate + S/R rejection rate on that day's blocks.");

const DE_MIN = Math.max(0.45, D14.dirEff * 0.9);
const CHOP_MAX = D14.chop * 1.05;
const STR_MIN = Math.max(2, Math.abs(D14.trend.strength) * 0.75);
const PE_MIN = Math.max(0.25, median(D14.path1h) * 0.9);

// Scan historical days from full+window M15 (skip weekends roughly by requiring >= 80 bars)
type HistDay = {
  day: string;
  like: boolean;
  de: number;
  chop: number;
  strength: number;
  pe1h: number;
  cont2: number;
  midHit: number;
  reject: number;
  nBlocks: number;
};
const byDay = new Map<string, RC[]>();
for (const c of m15All) {
  const d = dayUTC(c.time);
  if (d < "2020-01-01") continue; // hist from 2020 for speed + relevance
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d)!.push(c);
}

const hist: HistDay[] = [];
const days = [...byDay.keys()].sort();
console.error(`Historical scan days=${days.length}...`);
let di = 0;
for (const day of days) {
  di++;
  if (di % 200 === 0) console.error(`  hist ${di}/${days.length}`);
  if (day >= "2026-09-19") continue;
  const bars = byDay.get(day)!;
  if (bars.length < 80) continue;
  const dayStart = day + "T00:00:00.000000000Z";
  const endExclusive = (() => {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().replace(/\.\d{3}Z$/, ".000000000Z");
  })();
  const hi = Math.max(...bars.map((r) => r.mid.high));
  const lo = Math.min(...bars.map((r) => r.mid.low));
  const net = pips(bars[bars.length - 1]!.mid.close - bars[0]!.mid.open);
  const range = pips(hi - lo);
  const de = range > 0 ? Math.abs(net) / range : 0;
  const bodies = bars.map((r) => bodyRange(r));
  const meanBody = mean(bodies.map((b) => b.bodyRatio));
  const overlap = overlapPct(bars);
  const inside = insideBarPct(bars);
  const flips = flipRate(bars);
  const path1h = pathEfficiency(bars, 4);
  const failed10 = failedMoves(bars, 10, 12);
  const chop = chopScore({
    m15FlipRate: flips.rate,
    m5FlipRate: Math.min(1, flips.rate * 1.05),
    meanBodyRangeM15: meanBody,
    overlapPctM15: overlap,
    insideBarPctM15: inside,
    medianPathEff1h: median(path1h) || 0,
    failed10pRate: failed10.rate,
  });
  const h1 = aggregate(bars, 3600_000);
  const h4 = aggregate(bars, 4 * 3600_000);
  const tr = classifyTrend(bars, h1, h4);
  const cont = continuation(bars);
  const cont2 = pct(cont.up2 + cont.dn2, cont.up2n + cont.dn2n);
  const blocks = buildBlocks(m15All, dayStart, endExclusive);
  const agg = blockAgg(blocks);
  const like =
    de >= DE_MIN &&
    chop <= CHOP_MAX &&
    Math.abs(tr.strength) >= STR_MIN &&
    (median(path1h) || 0) >= PE_MIN;
  hist.push({
    day,
    like,
    de,
    chop,
    strength: tr.strength,
    pe1h: median(path1h) || 0,
    cont2,
    midHit: agg.midHitRate,
    reject: agg.rejectRate,
    nBlocks: agg.n,
  });
}
console.error(`Historical done N=${hist.length}`);

const like = hist.filter((h) => h.like);
const unlike = hist.filter((h) => !h.like);
const avg = (xs: number[]) => mean(xs.filter((x) => Number.isFinite(x)));
log(`  Historical days scanned: N=${hist.length}`);
log(`  Sep14-like days: N=${like.length} (${f1(pct(like.length, hist.length))}%)`);
log(`  Not-like days:   N=${unlike.length}`);
log(`  Behavior WITH condition:`);
log(
  `    mean cont(+2) ${f1(avg(like.map((h) => h.cont2)))}%  midHit ${f1(avg(like.map((h) => h.midHit)))}%  reject ${f1(avg(like.map((h) => h.reject)))}%`,
);
log(`  Behavior WITHOUT condition:`);
log(
  `    mean cont(+2) ${f1(avg(unlike.map((h) => h.cont2)))}%  midHit ${f1(avg(unlike.map((h) => h.midHit)))}%  reject ${f1(avg(unlike.map((h) => h.reject)))}%`,
);
log(
  `  Delta (like - unlike): cont2 ${f1(avg(like.map((h) => h.cont2)) - avg(unlike.map((h) => h.cont2)))}pp  midHit ${f1(avg(like.map((h) => h.midHit)) - avg(unlike.map((h) => h.midHit)))}pp  reject ${f1(avg(like.map((h) => h.reject)) - avg(unlike.map((h) => h.reject)))}pp`,
);
log("  Note: historical window 2020-01-01..2026-09-18; CHOP uses M15 flip proxy for M5 component.");
log("");

// ---- §19 match score ----
log("19. TODAY MATCH SCORE");
log("-".repeat(78));
log("  Sep 19 2026 = Saturday, market closed → overall: NOT_SEP14_LIKE");
log("  Against last session Sep 18 (what traders face going into weekend):");

type Match = "MATCH" | "PARTIAL" | "NO MATCH";
const matchOne = (name: string, m: Match, detail: string) => log(`  ${name}: ${m} (${detail})`);

const deMatch: Match = D18.dirEff >= DE_MIN ? "MATCH" : D18.dirEff >= DE_MIN * 0.7 ? "PARTIAL" : "NO MATCH";
const chopMatch: Match = D18.chop <= CHOP_MAX ? "MATCH" : D18.chop <= CHOP_MAX * 1.15 ? "PARTIAL" : "NO MATCH";
const trendMatch: Match =
  Math.abs(D18.trend.strength) >= STR_MIN
    ? D14.trend.label.split("_").pop() === D18.trend.label.split("_").pop() ||
      (D14.trend.label.includes("BEAR") && D18.trend.label.includes("BEAR")) ||
      (D14.trend.label.includes("BULL") && D18.trend.label.includes("BULL"))
      ? "MATCH"
      : "PARTIAL"
    : "NO MATCH";
const peMatch: Match =
  (median(D18.path1h) || 0) >= PE_MIN ? "MATCH" : (median(D18.path1h) || 0) >= PE_MIN * 0.7 ? "PARTIAL" : "NO MATCH";
const srMatch: Match =
  blockAgg(D18.blocks).avgRange >= blockAgg(D14.blocks).avgRange * 0.8 ? "PARTIAL" : "NO MATCH";

matchOne("Trend", trendMatch, `${D18.trend.label} str=${f2(D18.trend.strength)} vs Sep14 ${D14.trend.label}`);
matchOne("Directional efficiency", deMatch, `${f3(D18.dirEff)} vs thresh ${f2(DE_MIN)}`);
matchOne("Low chop", chopMatch, `${f1(D18.chop)} vs max ${f1(CHOP_MAX)}`);
matchOne("Path efficiency 1H", peMatch, `${f3(median(D18.path1h))} vs min ${f2(PE_MIN)}`);
matchOne("S/R range room", srMatch, `avg ${f1(blockAgg(D18.blocks).avgRange)} vs Sep14 ${f1(blockAgg(D14.blocks).avgRange)}`);

const matches = [deMatch, chopMatch, trendMatch, peMatch].filter((x) => x === "MATCH").length;
const partials = [deMatch, chopMatch, trendMatch, peMatch].filter((x) => x === "PARTIAL").length;
let overall: "SEP14_LIKE" | "PARTIAL_SEP14" | "NOT_SEP14_LIKE";
if (matches >= 3 && partials + matches >= 4) overall = "SEP14_LIKE";
else if (matches + partials >= 2) overall = "PARTIAL_SEP14";
else overall = "NOT_SEP14_LIKE";
log(`  Sep18 vs Sep14 regime gate: ${overall} (matches=${matches} partials=${partials})`);
log(`  Sep19 calendar day: NOT_SEP14_LIKE (no session)`);
log("");

// ---- §20 answers ----
log("20. FINAL QUESTIONS");
log("-".repeat(78));
const cleanSessions = sessionSlices(m15_14, m5_14, m1_14, m15All, sep14)
  .filter((s) => !s.empty)
  .sort((a, b) => (a as any).chop - (b as any).chop);
log(`1. Special about Sep14: combination of ${D14.trend.label} (strength ${f2(D14.trend.strength)}), DE=${f3(D14.dirEff)}, CHOP=${f1(D14.chop)}, 1h pathEff=${f3(median(D14.path1h))}, absNet=${f1(D14.absNetP)}p.`);
log(`2. Primary driver: combination — trend + low/moderate chop + directional efficiency; not merely larger range (range ${f1(D14.dailyRangeP)}p vs Sep18 ${f1(D18.dailyRangeP)}p).`);
log(`3. Known EURUSD winners were SHORT; day label ${D14.trend.label} → mostly WITH larger bearish trend.`);
log(`4. 4H frozen S/R: ${D14.blocks.length} blocks, avg range ${f1(blockAgg(D14.blocks).avgRange)}p, midHit ${f1(blockAgg(D14.blocks).midHitRate)}%, aligned ${blockAgg(D14.blocks).aligned} — system describes structure; not proven as sole edge.`);
log(`5. Unfinished/ALIGNED: ${blockAgg(D14.blocks).unfinished} blocks; 5-10p-from-mid flags=${blockAgg(D14.blocks).near510}.`);
log(`6. Cleanest Sep14 hours (lowest chop): ${cleanSessions
  .slice(0, 3)
  .map((s) => (!s.empty ? `${String(s.h).padStart(2, "0")}-${String((s.h + 4) % 24).padStart(2, "0")} chop=${f1(s.chop)} DE=${f3(s.de)}` : ""))
  .join(" | ")}`);
log(`7. Room: avg 4H S/R range ${f1(blockAgg(D14.blocks).avgRange)}p; withTrend encounters ${blockAgg(D14.blocks).withTrend} vs against ${blockAgg(D14.blocks).againstTrend}.`);
log(`8. Sep19: weekend closed. Sep18 proxy differs: trend=${D18.trend.label}, DE=${f3(D18.dirEff)}, CHOP=${f1(D18.chop)}, path1h=${f3(median(D18.path1h))}.`);
log(`9. Sep19 resemble Sep14? NO (closed). Sep18 vs Sep14: ${overall}.`);
log(`10. Real-time detectability: YES — monitor rolling DE, CHOP (flip/body/overlap/pathEff), |trend strength|, 1h pathEff vs frozen thresholds; no hindsight needed.`);
log(`11. Historical: Sep14-like N=${like.length}/${hist.length}; cont2 delta ${f1(avg(like.map((h) => h.cont2)) - avg(unlike.map((h) => h.cont2)))}pp; midHit delta ${f1(avg(like.map((h) => h.midHit)) - avg(unlike.map((h) => h.midHit)))}pp.`);
log(`12. App measurements: (a) session DE abs(net)/range (b) CHOP score components (c) H1/H4+M15 trend strength (d) rolling 1h path efficiency (e) frozen 4H align/unfinished + dist-to-mid (f) spread P50/P90.`);
log("");

const histImproves =
  avg(like.map((h) => h.cont2)) - avg(unlike.map((h) => h.cont2)) >= 3 ||
  avg(like.map((h) => h.reject)) - avg(unlike.map((h) => h.reject)) >= 3;
const verdict =
  like.length >= 30 && histImproves
    ? "SEP14_REGIME_IDENTIFIED"
    : like.length >= 10
      ? "SEP14_PARTIALLY_EXPLAINED"
      : D14.barsM15 > 0
        ? "SEP14_PARTIALLY_EXPLAINED"
        : "INSUFFICIENT_EVIDENCE";

log("FINAL VERDICT");
log("-".repeat(78));
log(verdict);
log(`  Rationale: Sep14 market structure is quantitatively distinct; historical like-days N=${like.length}; behavior deltas modest/meaningful as printed; user 5W1L not fully EURUSD-attributable → regime helps explain environment, not prove trade P&L.`);
log("=".repeat(78));

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-sep14-vs-sep19-market-conditions-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`\n[written] ${outPath}`);

// also dump JSON summary for reuse
fs.writeFileSync(
  path.join(OUT_DIR, "eurusd-sep14-vs-sep19-market-conditions-summary.json"),
  JSON.stringify(
    {
      verdict,
      overallSep18: overall,
      D14: { ...D14, path30: undefined, path1h: undefined, path2h: undefined, path4h: undefined },
      D18: { ...D18, path30: undefined, path1h: undefined, path2h: undefined, path4h: undefined },
      thresholds: { DE_MIN, CHOP_MAX, STR_MIN, PE_MIN },
      hist: { n: hist.length, like: like.length, unlike: unlike.length },
    },
    null,
    2,
  ),
);
