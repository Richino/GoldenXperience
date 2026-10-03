/**
 * EUR/USD M15 — TREND PULLBACK + WIDE STOP (2:1 risk/reward) RESEARCH v1
 *
 * Hypothesis: when trend direction is correctly identified, normal/deep pullbacks
 * often tag a conventional stop before price continues; wider SL + smaller TP may
 * change expectancy vs tight stops.
 *
 * RESEARCH ONLY — no production changes. Fixed rules; no parameter optimization.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../src/types/forex";
import { findSwingPoints } from "../src/lib/strategy/market-structure";
import { atr14Of } from "../src/lib/strategy/sr-structure";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT = "EUR_USD" as const;
const PIP = pipSizeFor(INSTRUMENT);
const OUT_DIR = path.resolve(__dirname, "../research-output");
const REPORT = path.join(OUT_DIR, "eurusd-m15-trend-pullback-wide-stop-v1-report.txt");
const CSV = path.join(OUT_DIR, "eurusd-m15-trend-pullback-wide-stop-v1-trades.csv");

const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };

type TrendDir = "bullish" | "bearish" | "unclear";
type TradeDir = "long" | "short";

/** Confirmed swing visibility: pivot at index j needs j + radius completed bars. */
const SWING_RADIUS = 2;
const WARMUP = 120;
const PULLBACK_LOOKBACK = 64;
const PULLBACK_START_PIPS = 3;
const MIN_PULLBACK_PIPS = 5;
const MIN_PULLBACK_ATR = 0.25;
const SETUP_MAX_BARS = 96;
const COOLDOWN_BARS = 16;
const TRADE_MAX_BARS = 480; // ~5 trading days on M15
const TRENDLINE_BUFFER_PIPS = 3;

const RECOVERY_WINDOWS: Array<{ label: string; bars: number }> = [
  { label: "1h", bars: 4 },
  { label: "4h", bars: 16 },
  { label: "12h", bars: 48 },
  { label: "24h", bars: 96 },
  { label: "3d", bars: 288 },
  { label: "5td", bars: 480 },
];

type RrFamily = "2to1" | "1to1" | "1to2" | "atr";

type Config = {
  id: string;
  family: RrFamily;
  slPips: number;
  tpPips: number;
  label: string;
};

const FIXED_MATRIX: Array<{ sl: number; tp: number }> = [
  { sl: 10, tp: 5 },
  { sl: 15, tp: 7.5 },
  { sl: 20, tp: 10 },
  { sl: 25, tp: 12.5 },
  { sl: 30, tp: 15 },
  { sl: 40, tp: 20 },
];

function buildConfigs(): Config[] {
  const out: Config[] = [];
  for (const { sl, tp } of FIXED_MATRIX) {
    out.push({
      id: `2R1_${sl}sl_${tp}tp`,
      family: "2to1",
      slPips: sl,
      tpPips: tp,
      label: `${sl}p SL / ${tp}p TP (2:1)`,
    });
    out.push({
      id: `1R1_${sl}sl`,
      family: "1to1",
      slPips: sl,
      tpPips: sl,
      label: `${sl}p SL / ${sl}p TP (1:1)`,
    });
    out.push({
      id: `1R2_${sl}sl_${sl * 2}tp`,
      family: "1to2",
      slPips: sl,
      tpPips: sl * 2,
      label: `${sl}p SL / ${sl * 2}p TP (1:2)`,
    });
  }
  for (const mult of [0.75, 1, 1.25, 1.5]) {
    out.push({
      id: `ATR_${mult}sl_${mult * 0.5}tp`,
      family: "atr",
      slPips: mult,
      tpPips: mult * 0.5,
      label: `ATR ${mult} SL / ${mult * 0.5} TP (2:1)`,
    });
  }
  return out;
}

const CONFIGS = buildConfigs();

type EntryEvent = {
  entryBar: number;
  entryTime: string;
  direction: TradeDir;
  frozenTrend: "bullish" | "bearish";
  entryAsk: number;
  entryBid: number;
  spreadPips: number;
  atr14: number;
  trendExtreme: number;
  pullbackTrough: number;
  pullbackPips: number;
  pullbackAtr: number;
  distFromExtremePips: number;
  trendlineAtEntry: number | null;
  trendlineCrossBeforeEntry: boolean;
  swingBrokenBeforeEntry: boolean;
  slPipsUsedForMeta: number;
};

type SimRow = {
  configId: string;
  family: RrFamily;
  slPips: number;
  tpPips: number;
  entryBar: number;
  entryTime: string;
  direction: TradeDir;
  outcome: "win" | "loss" | "timeout";
  exitBar: number;
  exitTime: string;
  holdBars: number;
  spreadPips: number;
  entryPx: number;
  exitPx: number;
  netPips: number;
  netR: number;
  maePips: number;
  mfePips: number;
  crossedTrendline: boolean;
  brokeLatestSwing: boolean;
  recoveredOriginalTrend: boolean;
  timeToTpBars: number | null;
  timeToSlBars: number | null;
  stoppedThenHitTp: boolean;
  maxBeyondSlPips: number | null;
  recoveryWindows: Record<string, boolean>;
  pullbackPips: number;
  pullbackAtr: number;
  trendlineCrossBeforeEntry: boolean;
  swingBrokenBeforeEntry: boolean;
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "-");
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0);

function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  const w = idx - lo;
  return s[lo]! * (1 - w) + s[hi]! * w;
}

function trendAt(mids: Candle[], i: number): TrendDir {
  const slice = mids.slice(0, i + 1);
  const { highs, lows } = findSwingPoints(slice, SWING_RADIUS);
  if (highs.length < 2 || lows.length < 2) return "unclear";
  const h0 = highs[highs.length - 2]!;
  const h1 = highs[highs.length - 1]!;
  const l0 = lows[lows.length - 2]!;
  const l1 = lows[lows.length - 1]!;
  if (h1.price > h0.price && l1.price > l0.price) return "bullish";
  if (h1.price < h0.price && l1.price < l0.price) return "bearish";
  return "unclear";
}

function latestSwings(mids: Candle[], i: number) {
  const slice = mids.slice(0, i + 1);
  const { highs, lows } = findSwingPoints(slice, SWING_RADIUS);
  return {
    lastHigh: highs.length ? highs[highs.length - 1]! : null,
    lastLow: lows.length ? lows[lows.length - 1]! : null,
    prevLow: lows.length >= 2 ? lows[lows.length - 2]! : null,
    prevHigh: highs.length >= 2 ? highs[highs.length - 2]! : null,
  };
}

function trendlineSupport(mids: Candle[], i: number): number | null {
  const { prevLow, lastLow } = latestSwings(mids, i);
  if (!prevLow || !lastLow || lastLow.index === prevLow.index) return null;
  const slope = (lastLow.price - prevLow.price) / (lastLow.index - prevLow.index);
  return lastLow.price + slope * (i - lastLow.index);
}

function trendlineResistance(mids: Candle[], i: number): number | null {
  const { prevHigh, lastHigh } = latestSwings(mids, i);
  if (!prevHigh || !lastHigh || lastHigh.index === prevHigh.index) return null;
  const slope = (lastHigh.price - prevHigh.price) / (lastHigh.index - prevHigh.index);
  return lastHigh.price + slope * (i - lastHigh.index);
}

function crossedTrendline(
  mids: Candle[],
  from: number,
  to: number,
  direction: TradeDir,
): boolean {
  for (let j = from; j <= to; j++) {
    const line = direction === "long" ? trendlineSupport(mids, j) : trendlineResistance(mids, j);
    if (line === null) continue;
    const close = mids[j]!.close;
    const buf = TRENDLINE_BUFFER_PIPS * PIP;
    if (direction === "long" && close < line - buf) return true;
    if (direction === "short" && close > line + buf) return true;
  }
  return false;
}

function brokeLatestSwing(mids: Candle[], from: number, to: number, direction: TradeDir): boolean {
  for (let j = from; j <= to; j++) {
    const { lastLow, lastHigh } = latestSwings(mids, j);
    const c = mids[j]!.close;
    if (direction === "long" && lastLow && c < lastLow.price) return true;
    if (direction === "short" && lastHigh && c > lastHigh.price) return true;
  }
  return false;
}

function detectEntries(raw: RC[], mids: Candle[]): EntryEvent[] {
  const n = raw.length;
  const entries: EntryEvent[] = [];
  let cooldownUntil = WARMUP;
  let setupStart = -1;
  let frozenTrend: TrendDir = "unclear";
  let frozenExtreme = 0;
  let frozenTrough = 0;
  for (let i = WARMUP; i < n - 2; i++) {
    if (i < cooldownUntil) continue;

    const trend = trendAt(mids, i);
    const atr = atr14Of(mids.slice(Math.max(0, i - 14), i + 1));
    if (!(atr > 0)) continue;

    const win0 = Math.max(WARMUP, i - PULLBACK_LOOKBACK);
    let peakIdx = win0;
    let peak = mids[win0]!.high;
    for (let j = win0 + 1; j < i; j++) {
      if (mids[j]!.high >= peak) {
        peak = mids[j]!.high;
        peakIdx = j;
      }
    }
    let trough = mids[peakIdx]!.low;
    for (let j = peakIdx; j <= i; j++) trough = Math.min(trough, mids[j]!.low);

    let peakIdxS = win0;
    let peakS = mids[win0]!.low;
    for (let j = win0 + 1; j < i; j++) {
      if (mids[j]!.low <= peakS) {
        peakS = mids[j]!.low;
        peakIdxS = j;
      }
    }
    let troughS = mids[peakIdxS]!.high;
    for (let j = peakIdxS; j <= i; j++) troughS = Math.max(troughS, mids[j]!.high);

    const bullPullbackPips = (peak - trough) / PIP;
    const bearPullbackPips = (troughS - peakS) / PIP;
    const minPb = Math.max(MIN_PULLBACK_PIPS, MIN_PULLBACK_ATR * (atr / PIP));

    if (setupStart >= 0 && i - setupStart > SETUP_MAX_BARS) {
      setupStart = -1;
      frozenTrend = "unclear";
    }

    if (setupStart < 0) {
      if (trend === "bullish" && bullPullbackPips >= PULLBACK_START_PIPS) {
        setupStart = i;
        frozenTrend = "bullish";
        frozenExtreme = peak;
        frozenTrough = trough;
      } else if (trend === "bearish" && bearPullbackPips >= PULLBACK_START_PIPS) {
        setupStart = i;
        frozenTrend = "bearish";
        frozenExtreme = peakS;
        frozenTrough = troughS;
      }
      continue;
    }

    const dir: TradeDir | null = frozenTrend === "bullish" ? "long" : frozenTrend === "bearish" ? "short" : null;
    if (!dir) {
      setupStart = -1;
      continue;
    }

    const pbPips = dir === "long" ? (frozenExtreme - frozenTrough) / PIP : (frozenTrough - frozenExtreme) / PIP;
    if (pbPips < minPb) continue;

    const prev = mids[i - 1]!;
    const cur = mids[i]!;
    const resume =
      dir === "long"
        ? cur.close > prev.close && cur.close >= cur.open
        : cur.close < prev.close && cur.close <= cur.open;
    if (!resume) continue;

    const fillBar = i + 1;
    const fill = raw[fillBar]!;
    const entryAsk = fill.ask.open;
    const entryBid = fill.bid.open;
    const spreadPips = (entryAsk - entryBid) / PIP;

    const tl = dir === "long" ? trendlineSupport(mids, i) : trendlineResistance(mids, i);
    entries.push({
      entryBar: fillBar,
      entryTime: fill.time,
      direction: dir,
      frozenTrend: frozenTrend as "bullish" | "bearish",
      entryAsk,
      entryBid,
      spreadPips,
      atr14: atr,
      trendExtreme: frozenExtreme,
      pullbackTrough: frozenTrough,
      pullbackPips: pbPips,
      pullbackAtr: pbPips / (atr / PIP),
      distFromExtremePips: Math.abs(frozenExtreme - frozenTrough) / PIP,
      trendlineAtEntry: tl,
      trendlineCrossBeforeEntry: crossedTrendline(mids, setupStart, i, dir),
      swingBrokenBeforeEntry: brokeLatestSwing(mids, setupStart, i, dir),
      slPipsUsedForMeta: 20,
    });

    setupStart = -1;
    frozenTrend = "unclear";
    cooldownUntil = fillBar + COOLDOWN_BARS;
  }
  return entries;
}

function slTpForConfig(cfg: Config, ev: EntryEvent): { slPips: number; tpPips: number } {
  if (cfg.family !== "atr") return { slPips: cfg.slPips, tpPips: cfg.tpPips };
  const atrPips = ev.atr14 / PIP;
  return { slPips: cfg.slPips * atrPips, tpPips: cfg.tpPips * atrPips };
}

function simulate(
  raw: RC[],
  mids: Candle[],
  ev: EntryEvent,
  cfg: Config,
): SimRow {
  const { slPips, tpPips } = slTpForConfig(cfg, ev);
  const isLong = ev.direction === "long";
  const entryPx = isLong ? ev.entryAsk : ev.entryBid;
  const sl = isLong ? entryPx - slPips * PIP : entryPx + slPips * PIP;
  const tp = isLong ? entryPx + tpPips * PIP : entryPx - tpPips * PIP;
  const n = raw.length;
  const start = ev.entryBar;

  let mae = 0;
  let mfe = 0;
  let outcome: SimRow["outcome"] = "timeout";
  let exitBar = Math.min(n - 1, start + TRADE_MAX_BARS);
  let exitPx = isLong ? raw[exitBar]!.bid.close : raw[exitBar]!.ask.close;
  let timeToTp: number | null = null;
  let timeToSl: number | null = null;
  const swingsAtEntry = latestSwings(mids, start);
  const swingLevel = isLong ? swingsAtEntry.lastLow?.price ?? null : swingsAtEntry.lastHigh?.price ?? null;
  const { prevLow, lastLow, prevHigh, lastHigh } = swingsAtEntry;
  const trendFrozen =
    isLong && prevLow && lastLow
      ? {
          base: lastLow.price,
          slope: (lastLow.price - prevLow.price) / (lastLow.index - prevLow.index),
          anchor: lastLow.index,
        }
      : !isLong && prevHigh && lastHigh
        ? {
            base: lastHigh.price,
            slope: (lastHigh.price - prevHigh.price) / (lastHigh.index - prevHigh.index),
            anchor: lastHigh.index,
          }
        : null;
  let crossedTl = false;
  let brokeSwing = false;

  for (let j = start; j <= Math.min(n - 1, start + TRADE_MAX_BARS); j++) {
    const b = raw[j]!.bid;
    const a = raw[j]!.ask;
    if (isLong) {
      mae = Math.max(mae, (entryPx - b.low) / PIP);
      mfe = Math.max(mfe, (b.high - entryPx) / PIP);
    } else {
      mae = Math.max(mae, (a.high - entryPx) / PIP);
      mfe = Math.max(mfe, (entryPx - b.low) / PIP);
    }
    if (!crossedTl && trendFrozen) {
      const line = trendFrozen.base + trendFrozen.slope * (j - trendFrozen.anchor);
      const buf = TRENDLINE_BUFFER_PIPS * PIP;
      const close = mids[j]!.close;
      if (isLong && close < line - buf) crossedTl = true;
      if (!isLong && close > line + buf) crossedTl = true;
    }
    if (!brokeSwing && swingLevel !== null) {
      if (isLong && b.low < swingLevel) brokeSwing = true;
      if (!isLong && a.high > swingLevel) brokeSwing = true;
    }

    const hitSl = isLong ? b.low <= sl : a.high >= sl;
    const hitTp = isLong ? b.high >= tp : b.low <= tp;
    if (hitSl && hitTp) {
      outcome = "loss";
      exitBar = j;
      timeToSl = j - start;
      exitPx = isLong ? sl : sl;
      break;
    }
    if (hitSl) {
      outcome = "loss";
      exitBar = j;
      timeToSl = j - start;
      exitPx = sl;
      break;
    }
    if (hitTp) {
      outcome = "win";
      exitBar = j;
      timeToTp = j - start;
      exitPx = tp;
      break;
    }
  }

  const netPips = isLong ? (exitPx - entryPx) / PIP : (entryPx - exitPx) / PIP;
  const netR = netPips / slPips;

  let stoppedThenHitTp = false;
  let maxBeyondSl: number | null = null;
  const recoveryWindows: Record<string, boolean> = {};
  if (outcome === "loss") {
    for (const w of RECOVERY_WINDOWS) {
      let hit = false;
      let beyond = 0;
      const end = Math.min(n - 1, exitBar + w.bars);
      for (let j = exitBar + 1; j <= end; j++) {
        const b = raw[j]!.bid;
        const a = raw[j]!.ask;
        if (isLong) {
          beyond = Math.max(beyond, (sl - b.low) / PIP);
          if (b.high >= tp) hit = true;
        } else {
          beyond = Math.max(beyond, (a.high - sl) / PIP);
          if (b.low <= tp) hit = true;
        }
      }
      recoveryWindows[w.label] = hit;
      if (w.label === "5td") {
        stoppedThenHitTp = hit;
        maxBeyondSl = beyond;
      }
    }
  }

  const endCheck = Math.min(n - 1, exitBar + TRADE_MAX_BARS);
  let recovered = false;
  if (outcome === "loss") {
    const targetMove = isLong ? tp - entryPx : entryPx - tp;
    for (let j = exitBar + 1; j <= endCheck; j++) {
      const b = raw[j]!.bid;
      const a = raw[j]!.ask;
      const fav = isLong ? b.high - entryPx : entryPx - a.low;
      if (fav >= targetMove) {
        recovered = true;
        break;
      }
    }
  }

  return {
    configId: cfg.id,
    family: cfg.family,
    slPips,
    tpPips,
    entryBar: ev.entryBar,
    entryTime: ev.entryTime,
    direction: ev.direction,
    outcome,
    exitBar,
    exitTime: raw[exitBar]!.time,
    holdBars: exitBar - start,
    spreadPips: ev.spreadPips,
    entryPx,
    exitPx,
    netPips,
    netR,
    maePips: mae,
    mfePips: mfe,
    crossedTrendline: crossedTl,
    brokeLatestSwing: brokeSwing,
    recoveredOriginalTrend: outcome === "win" || recovered,
    timeToTpBars: timeToTp,
    timeToSlBars: timeToSl,
    stoppedThenHitTp,
    maxBeyondSlPips: maxBeyondSl,
    recoveryWindows,
    pullbackPips: ev.pullbackPips,
    pullbackAtr: ev.pullbackAtr,
    trendlineCrossBeforeEntry: ev.trendlineCrossBeforeEntry,
    swingBrokenBeforeEntry: ev.swingBrokenBeforeEntry,
  };
}

async function loadM15(): Promise<RC[]> {
  const candidates = [
    process.env.EURUSD_M15_MBA_CACHE,
    path.join(OUT_DIR, "cache", "eurusd-m15-mba.json"),
    path.resolve(
      "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-mba-cache.json",
    ),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.error(`[data] ${p}`);
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as RC[];
      return raw.filter((c) => c.bid && c.ask && c.mid).sort((a, b) => (a.time < b.time ? -1 : 1));
    }
  }

  console.error("[data] cache miss — fetching OANDA MBA M15 (paginated)…");
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const byTime = new Map<string, RC>();
  const START = process.env.SR_START ?? "2013-01-01T00:00:00Z";
  let cursor: string | undefined;
  for (let round = 0; round < 120; round++) {
    const batch = await getResearchCandles(INSTRUMENT, "M15", 5000, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) {
      if (!c.mid || !c.bid || !c.ask) continue;
      byTime.set(c.time, {
        time: c.time,
        mid: c.mid,
        bid: c.bid,
        ask: c.ask,
      });
    }
    const earliest = batch[0]!.time;
    console.error(`  round ${round + 1}: total ${byTime.size} oldest=${earliest}`);
    if (earliest <= START) break;
    if (cursor === earliest) break;
    cursor = earliest;
  }
  const rows = [...byTime.values()]
    .filter((c) => c.time >= START)
    .sort((a, b) => (a.time < b.time ? -1 : 1));
  const cacheOut = path.join(OUT_DIR, "cache", "eurusd-m15-mba.json");
  fs.mkdirSync(path.dirname(cacheOut), { recursive: true });
  fs.writeFileSync(cacheOut, JSON.stringify(rows));
  console.error(`[data] cached ${rows.length} → ${cacheOut}`);
  return rows;
}

function summarizeConfig(rows: SimRow[]) {
  const wins = rows.filter((r) => r.outcome === "win");
  const losses = rows.filter((r) => r.outcome === "loss");
  const rs = rows.map((r) => r.netR);
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const r of rs) {
    eq += r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  const grossWin = wins.reduce((s, r) => s + Math.max(0, r.netPips), 0);
  const grossLoss = losses.reduce((s, r) => s + Math.abs(Math.min(0, r.netPips)), 0);
  const stopped = losses.filter((r) => r.stoppedThenHitTp);
  const winMae = wins.map((r) => -r.maePips);
  const rr = rows[0]?.family === "2to1" ? 2 : rows[0]?.family === "1to2" ? 0.5 : 1;
  const breakEvenWr = rows[0]?.family === "2to1" ? 66.67 : rows[0]?.family === "1to2" ? 33.33 : 50;

  return {
    n: rows.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: rows.filter((r) => r.outcome === "timeout").length,
    wr: pct(wins.length, rows.length),
    avgSpread: rows.reduce((s, r) => s + r.spreadPips, 0) / Math.max(1, rows.length),
    expR: rs.reduce((s, x) => s + x, 0) / Math.max(1, rs.length),
    netPips: rows.reduce((s, r) => s + r.netPips, 0),
    pf: grossLoss > 0 ? grossWin / grossLoss : NaN,
    maxDdR: maxDd,
    avgHold: rows.reduce((s, r) => s + r.holdBars, 0) / Math.max(1, rows.length),
    medHold: percentile(
      rows.map((r) => r.holdBars),
      0.5,
    ),
    maeMed: percentile(
      rows.map((r) => r.maePips),
      0.5,
    ),
    mfeMed: percentile(
      rows.map((r) => r.mfePips),
      0.5,
    ),
    stoppedRecover: stopped.length,
    stoppedRecoverPct: pct(stopped.length, losses.length),
    medBeyondSl: percentile(
      stopped.map((r) => r.maxBeyondSlPips ?? 0).filter((x) => Number.isFinite(x)),
      0.5,
    ),
    winMaePct: {
      p25: percentile(winMae, 0.25),
      p50: percentile(winMae, 0.5),
      p75: percentile(winMae, 0.75),
      p80: percentile(winMae, 0.8),
      p90: percentile(winMae, 0.9),
      p95: percentile(winMae, 0.95),
    },
    breakEvenWr,
    rr,
  };
}

function csvEscape(v: string | number | boolean) {
  const s = String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const raw = await loadM15();
  const mids: Candle[] = raw.map((c) => ({
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: 0,
    complete: true,
  }));
  const n = raw.length;
  log("=".repeat(100));
  log("EUR/USD M15 — TREND PULLBACK + WIDE STOP (2:1) RESEARCH v1");
  log("=".repeat(100));
  log(`Generated: ${new Date().toISOString()}`);
  log(`Candles: ${n}  ${raw[0]?.time} → ${raw[n - 1]?.time}`);
  log(`Execution: BID/ASK on M15; long fills ASK / exits BID; short fills BID / exits ASK`);
  log(`Same-bar SL+TP: SL first (conservative)`);
  log("");
  log("RULES (fixed — not tuned)");
  log("-".repeat(100));
  log(`Trend: last two confirmed swing highs AND lows (radius=${SWING_RADIUS}, causal slice only).`);
  log("  Bullish = HH + HL; Bearish = LH + LL. No future bars.");
  log(`Pullback setup begins when retracement ≥ ${PULLBACK_START_PIPS}p from ${PULLBACK_LOOKBACK}-bar extreme while trend matches.`);
  log(`Trend direction FROZEN at setup start; entries do not flip on trendline/swing breaks.`);
  log(`Entry requires pullback ≥ max(${MIN_PULLBACK_PIPS}p, ${MIN_PULLBACK_ATR}×ATR14) + resume candle (close vs prior + body direction).`);
  log("Fill: next bar open (ask long / bid short). Cooldown 16 bars after entry.");
  log(`Trade horizon: ${TRADE_MAX_BARS} M15 bars (~5 trading days) or SL/TP.`);
  log("");

  const entries = detectEntries(raw, mids);
  log(`Entries detected: ${entries.length}`);
  if (entries.length < 50) log("WARNING: low sample — interpret cautiously.");

  const allSims: SimRow[] = [];
  console.error(`Simulating ${entries.length} entries × ${CONFIGS.length} configs…`);
  for (const cfg of CONFIGS) {
    for (const ev of entries) allSims.push(simulate(raw, mids, ev, cfg));
  }

  const header = [
    "configId",
    "family",
    "slPips",
    "tpPips",
    "entryTime",
    "direction",
    "outcome",
    "exitTime",
    "holdBars",
    "spreadPips",
    "entryPx",
    "exitPx",
    "netPips",
    "netR",
    "maePips",
    "mfePips",
    "crossedTrendline",
    "brokeLatestSwing",
    "recoveredOriginalTrend",
    "timeToTpBars",
    "timeToSlBars",
    "stoppedThenHitTp",
    "maxBeyondSlPips",
    "pullbackPips",
    "pullbackAtr",
    "trendlineCrossBeforeEntry",
    "swingBrokenBeforeEntry",
    ...RECOVERY_WINDOWS.map((w) => `recover_${w.label}`),
  ];
  const csvLines = [header.join(",")];
  for (const r of allSims) {
    csvLines.push(
      [
        r.configId,
        r.family,
        f2(r.slPips),
        f2(r.tpPips),
        r.entryTime,
        r.direction,
        r.outcome,
        r.exitTime,
        r.holdBars,
        f2(r.spreadPips),
        r.entryPx,
        r.exitPx,
        f2(r.netPips),
        f3(r.netR),
        f2(r.maePips),
        f2(r.mfePips),
        r.crossedTrendline,
        r.brokeLatestSwing,
        r.recoveredOriginalTrend,
        r.timeToTpBars ?? "",
        r.timeToSlBars ?? "",
        r.stoppedThenHitTp,
        r.maxBeyondSlPips ?? "",
        f2(r.pullbackPips),
        f2(r.pullbackAtr),
        r.trendlineCrossBeforeEntry,
        r.swingBrokenBeforeEntry,
        ...RECOVERY_WINDOWS.map((w) => r.recoveryWindows[w.label] ?? false),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(CSV, csvLines.join("\n"));
  log(`Trade CSV: ${CSV} (${allSims.length} rows)`);
  log("");

  log("PRIMARY 2:1 MATRIX (fixed pip SL / half TP)");
  log("-".repeat(100));
  log(
    [
      "Config",
      "N",
      "WR%",
      "BE%",
      "ExpR",
      "NetPips",
      "PF",
      "MaxDdR",
      "MedMAE",
      "Stop→TP%",
      "MedBeyondSL",
    ]
      .map((x) => x.padStart(10))
      .join(""),
  );
  const primaryIds = CONFIGS.filter((c) => c.family === "2to1").map((c) => c.id);
  const primarySummaries: Array<{ id: string; s: ReturnType<typeof summarizeConfig> }> = [];
  for (const id of primaryIds) {
    const rows = allSims.filter((r) => r.configId === id);
    const s = summarizeConfig(rows);
    primarySummaries.push({ id, s });
    log(
      [
        id.padStart(10),
        String(s.n).padStart(10),
        f1(s.wr).padStart(10),
        f1(s.breakEvenWr).padStart(10),
        f3(s.expR).padStart(10),
        f1(s.netPips).padStart(10),
        f2(s.pf).padStart(10),
        f2(s.maxDdR).padStart(10),
        f1(s.maeMed).padStart(10),
        f1(s.stoppedRecoverPct).padStart(10),
        f1(s.medBeyondSl).padStart(10),
      ].join(""),
    );
  }
  log("");

  const ref20 = allSims.filter((r) => r.configId === "2R1_20sl_10tp");
  const refS = summarizeConfig(ref20);
  log("WINNING TRADES MAE (20p SL / 10p TP config) — adverse pips before TP");
  log(
    `  P25=${f1(-refS.winMaePct.p25)}p  P50=${f1(-refS.winMaePct.p50)}p  P75=${f1(-refS.winMaePct.p75)}p  P80=${f1(-refS.winMaePct.p80)}p  P90=${f1(-refS.winMaePct.p90)}p  P95=${f1(-refS.winMaePct.p95)}p`,
  );
  log("");

  log("RECOVERY WINDOWS — % of STOPPED trades that later hit original TP (20p/10p)");
  const losses20 = ref20.filter((r) => r.outcome === "loss");
  for (const w of RECOVERY_WINDOWS) {
    const hit = losses20.filter((r) => r.recoveryWindows[w.label]).length;
    log(`  ${w.label.padEnd(4)}: ${f1(pct(hit, losses20.length))}% (${hit}/${losses20.length})`);
  }
  log("");

  log("CONTROLS — same entries, 20p SL baseline");
  for (const fam of ["1to1", "1to2", "2to1"] as const) {
    const id =
      fam === "2to1" ? "2R1_20sl_10tp" : fam === "1to1" ? "1R1_20sl" : "1R2_20sl_40tp";
    const s = summarizeConfig(allSims.filter((r) => r.configId === id));
    log(`  ${fam.padEnd(5)} ${id}: WR=${f1(s.wr)}% ExpR=${f3(s.expR)} NetPips=${f1(s.netPips)} PF=${f2(s.pf)}`);
  }
  log("");

  const tlBreak = ref20.filter((r) => r.crossedTrendline);
  const swBreak = ref20.filter((r) => r.brokeLatestSwing);
  log("STRUCTURE DURING TRADE (20p/10p)");
  log(`  Crossed trendline: ${tlBreak.length}/${ref20.length} → WR ${f1(pct(tlBreak.filter((x) => x.outcome === "win").length, tlBreak.length))}%`);
  log(`  Broke latest swing: ${swBreak.length}/${ref20.length} → WR ${f1(pct(swBreak.filter((x) => x.outcome === "win").length, swBreak.length))}%`);
  log("");

  log("FINAL QUESTIONS (data-only — no strategy recommendation)");
  log("-".repeat(100));
  log(
    `A. Winners deeply negative before TP? P50 MAE on wins = ${f1(-refS.winMaePct.p50)}p; P90 = ${f1(-refS.winMaePct.p90)}p.`,
  );
  log(
    `B. Tighter stops removing recoveries? ${f1(refS.stoppedRecoverPct)}% of stopped (5td window) later hit original TP on 20/10.`,
  );
  log(`C. Stopped-then-TP rate (5td): ${f1(refS.stoppedRecoverPct)}%.`);
  log(`D. MAE distribution of winners: see P25–P95 block above.`);
  const w10 = summarizeConfig(allSims.filter((r) => r.configId === "2R1_10sl_5tp"));
  const w40 = summarizeConfig(allSims.filter((r) => r.configId === "2R1_40sl_20tp"));
  log(`E. Widen stop vs WR: 10p SL WR=${f1(w10.wr)}% vs 40p SL WR=${f1(w40.wr)}%.`);
  log(`F. WR lift vs 2:1 breakeven (${f1(refS.breakEvenWr)}%): observed ${f1(refS.wr)}%, ExpR=${f3(refS.expR)}.`);
  log(`G. 2:1 after spread: ExpR=${f3(refS.expR)} (20/10); positive only if > 0).`);
  const c11 = summarizeConfig(allSims.filter((r) => r.configId === "1R1_20sl"));
  const c12 = summarizeConfig(allSims.filter((r) => r.configId === "1R2_20sl_40tp"));
  log(`H. vs controls @20p SL: 1:1 ExpR=${f3(c11.expR)} | 2:1 ExpR=${f3(refS.expR)} | 1:2 ExpR=${f3(c12.expR)}.`);
  log(
    `I. After trendline cross, original TP before wide stop: wins ${tlBreak.filter((x) => x.outcome === "win").length}/${tlBreak.length}.`,
  );
  log(
    `J. After swing break, recovery: wins ${swBreak.filter((x) => x.outcome === "win").length}/${swBreak.length}; stopped→TP ${f1(pct(swBreak.filter((x) => x.stoppedThenHitTp).length, swBreak.filter((x) => x.outcome === "loss").length))}% of losses with swing break.`,
  );
  log("");
  log("NO_LOOKAHEAD: swings/trend computed on causal slices; fills on next bar only.");

  fs.writeFileSync(REPORT, L.join("\n"));
  console.error(`\n[report] ${REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
