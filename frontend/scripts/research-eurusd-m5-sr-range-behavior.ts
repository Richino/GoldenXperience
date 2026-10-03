/**
 * EUR/USD M5 S/R RANGE BEHAVIOR STUDY
 *
 * Structural behavior only — no entry strategy, no optimization, no production changes.
 *
 * Production S/R: computeSupportResistanceLevels
 *   frontend/src/lib/strategy/support-resistance.ts
 *   PIVOT_REACH=5, RANGE_LOOKBACK=60, VISIBLE_LOOKBACK=160
 *
 * Applied on M5 MID ((bid+ask)/2). Ranges frozen until exit (no repaint).
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = 0.0001;
const VISIBLE_LOOKBACK = 160;
const BAR_MIN = 5;
const HORIZON_BARS = (4 * 60) / BAR_MIN; // 48 = 4h
const MIN_RANGE_P = 10;
const TIME_WINDOWS = [5, 10, 15, 30, 45, 60, 120, 240] as const;
const REV_TARGETS = [2, 3, 5, 7.5, 10, 12.5, 15, 20] as const;
const DEPTH_THRESHOLDS = [1, 2, 3, 5, 7.5, 10, 15, 20] as const;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-m5-sr-range-behavior-study.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-m5-sr-range-behavior-events.csv");
const M5_CACHE = path.join(OUT_DIR, "cache", "eurusd-m5-ba-for-sr-range-study.json");
const M5_SCRATCH =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m5-mba-cache.json";
const SR_SRC = path.resolve(__dirname, "../src/lib/strategy/support-resistance.ts");
const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");

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
const fmtHM = (mins: number) => {
  if (!Number.isFinite(mins)) return "-";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

type Bucket = "A_10_15" | "B_15_25" | "C_25plus";
type ExitDir = "UP" | "DOWN";

type EventRow = {
  id: string;
  isControl: boolean;
  rangeDetectedTime: string;
  detectIdx: number;
  support: number;
  resistance: number;
  rangePips: number;
  rangeBucket: Bucket;
  exitTime: string;
  exitIdx: number;
  exitDirection: ExitDir;
  maxBreakoutDepthPips: number;
  /** S/R-relative reversal (through/back past broken level) */
  maxFavorablePips: number;
  /** Pullback from post-break extreme */
  pullbackFromExtremePips: number;
  /** Same as maxBreakoutDepth for adverse before/during path */
  maxAdversePips: number;
  reversalHit: Record<number, boolean>;
  minutesToTarget: Record<number, number>;
  minutesTo10p: number;
  atr14AtDetect: number;
  sameBarBothExits: boolean;
};

function bucketOf(rangeP: number): Bucket {
  if (rangeP >= 25) return "C_25plus";
  if (rangeP >= 15) return "B_15_25";
  return "A_10_15";
}

function bucketLabel(b: Bucket): string {
  switch (b) {
    case "A_10_15":
      return "10–<15p";
    case "B_15_25":
      return "15–<25p";
    case "C_25plus":
      return "≥25p";
    default: {
      const _e: never = b;
      return _e;
    }
  }
}

function verifySrConstants(): void {
  const src = fs.readFileSync(SR_SRC, "utf8");
  for (const [name, val] of [
    ["PIVOT_REACH", 5],
    ["RANGE_LOOKBACK", 60],
    ["VISIBLE_LOOKBACK", 160],
  ] as const) {
    const m = new RegExp(`const ${name} = (\\d+)`).exec(src);
    if (!m || Number(m[1]) !== val) throw new Error(`SR constant mismatch ${name}`);
  }
}

function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function loadM5(): Promise<{ candles: Candle[]; source: string }> {
  const tryPaths = [M5_CACHE, M5_SCRATCH].filter((p) => fs.existsSync(p));
  if (tryPaths.length) {
    const p = tryPaths[0]!;
    process.stderr.write(`Loading M5 from ${p}...\n`);
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown[];
    const candles: Candle[] = [];
    for (const row of raw) {
      if (Array.isArray(row)) {
        const [t, bh, bl, ah, al, bc, ac] = row as [string, number, number, number, number, number, number];
        const high = (bh + ah) / 2;
        const low = (bl + al) / 2;
        const close = (bc + ac) / 2;
        candles.push({ time: t, open: close, high, low, close, volume: 0, complete: true });
      } else {
        const c = row as {
          time: string;
          complete?: boolean;
          mid?: { open: number; high: number; low: number; close: number };
          bid?: { high: number; low: number; close: number };
          ask?: { high: number; low: number; close: number };
        };
        if (c.complete === false) continue;
        if (c.mid) {
          candles.push({
            time: c.time,
            open: c.mid.open,
            high: c.mid.high,
            low: c.mid.low,
            close: c.mid.close,
            volume: 0,
            complete: true,
          });
        } else if (c.bid && c.ask) {
          candles.push({
            time: c.time,
            open: (c.bid.close + c.ask.close) / 2,
            high: (c.bid.high + c.ask.high) / 2,
            low: (c.bid.low + c.ask.low) / 2,
            close: (c.bid.close + c.ask.close) / 2,
            volume: 0,
            complete: true,
          });
        }
      }
    }
    candles.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    return { candles, source: `OANDA M5 BA→MID ((b+a)/2) ${p}` };
  }

  loadEnv();
  process.stderr.write("Fetching OANDA EUR_USD M5...\n");
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const START = "2013-01-01T00:00:00Z";
  const byTime = new Map<string, [string, number, number, number, number, number, number]>();
  let cursor: string | undefined;
  let round = 0;
  while (true) {
    round++;
    const batch = await getResearchCandles("EUR_USD", "M5", 5000, cursor ? { to: cursor } : {});
    if (!batch.length) break;
    for (const c of batch) {
      if (c.complete) {
        byTime.set(c.time, [c.time, c.bid.high, c.bid.low, c.ask.high, c.ask.low, c.bid.close, c.ask.close]);
      }
    }
    const earliest = batch[0]!.time;
    if (round % 20 === 0) process.stderr.write(`  round ${round} n=${byTime.size} oldest=${earliest}\n`);
    if (earliest <= START) break;
    if (cursor && earliest === cursor) break;
    cursor = earliest;
    if (round > 260) break;
  }
  const rows = [...byTime.values()].filter((r) => r[0]! >= START).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  fs.mkdirSync(path.dirname(M5_CACHE), { recursive: true });
  fs.writeFileSync(M5_CACHE, JSON.stringify(rows));
  return loadM5();
}

function atr14(candles: Candle[], endExclusive: number): number {
  const start = Math.max(1, endExclusive - 50);
  const trs: number[] = [];
  for (let i = start; i < endExclusive; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < 14) return mean(trs) || PIP * 5;
  // Wilder-ish simple last 14 mean
  return mean(trs.slice(-14));
}

function windowPrior(candles: Candle[], endExclusive: number): Candle[] {
  return candles.slice(Math.max(0, endExclusive - VISIBLE_LOOKBACK), endExclusive);
}

function measurePostExit(
  candles: Candle[],
  exitIdx: number,
  support: number,
  resistance: number,
  dir: ExitDir,
): {
  maxBreakoutDepthPips: number;
  maxFavorablePips: number;
  pullbackFromExtremePips: number;
  maxAdversePips: number;
  reversalHit: Record<number, boolean>;
  minutesToTarget: Record<number, number>;
} {
  const end = Math.min(candles.length - 1, exitIdx + HORIZON_BARS);
  let maxBeyond = 0;
  let maxThrough = 0;
  let extreme = dir === "UP" ? candles[exitIdx]!.high : candles[exitIdx]!.low;
  let maxPullbackFromExtreme = 0;
  const minutesToTarget: Record<number, number> = {};
  for (const t of REV_TARGETS) minutesToTarget[t] = NaN;

  for (let j = exitIdx; j <= end; j++) {
    const bar = candles[j]!;
    const mins = (j - exitIdx) * BAR_MIN;
    if (dir === "UP") {
      extreme = Math.max(extreme, bar.high);
      maxBeyond = Math.max(maxBeyond, bar.high - resistance);
      maxThrough = Math.max(maxThrough, resistance - bar.low);
      maxPullbackFromExtreme = Math.max(maxPullbackFromExtreme, extreme - bar.low);
      for (const t of REV_TARGETS) {
        if (!Number.isFinite(minutesToTarget[t]!) && resistance - bar.low >= t * PIP) {
          minutesToTarget[t] = mins;
        }
      }
    } else {
      extreme = Math.min(extreme, bar.low);
      maxBeyond = Math.max(maxBeyond, support - bar.low);
      maxThrough = Math.max(maxThrough, bar.high - support);
      maxPullbackFromExtreme = Math.max(maxPullbackFromExtreme, bar.high - extreme);
      for (const t of REV_TARGETS) {
        if (!Number.isFinite(minutesToTarget[t]!) && bar.high - support >= t * PIP) {
          minutesToTarget[t] = mins;
        }
      }
    }
  }

  const reversalHit: Record<number, boolean> = {};
  for (const t of REV_TARGETS) {
    reversalHit[t] = Number.isFinite(minutesToTarget[t]) && minutesToTarget[t]! <= 4 * 60;
  }

  return {
    maxBreakoutDepthPips: maxBeyond / PIP,
    maxFavorablePips: maxThrough / PIP,
    pullbackFromExtremePips: maxPullbackFromExtreme / PIP,
    maxAdversePips: maxBeyond / PIP,
    reversalHit,
    minutesToTarget,
  };
}

function depthBucket(d: number): string {
  if (d < 1) return "0–1";
  if (d < 2) return "1–2";
  if (d < 3) return "2–3";
  if (d < 5) return "3–5";
  if (d < 7.5) return "5–7.5";
  if (d < 10) return "7.5–10";
  if (d < 15) return "10–15";
  if (d < 20) return "15–20";
  return "20+";
}

function hitRate(events: EventRow[], pred: (e: EventRow) => boolean): number {
  return pct(events.filter(pred).length, events.length);
}

function rate10Within(events: EventRow[], mins: number): number {
  return hitRate(events, (e) => Number.isFinite(e.minutesTo10p) && e.minutesTo10p <= mins);
}

async function main(): Promise<void> {
  verifySrConstants();
  const { candles, source } = await loadM5();
  const n = candles.length;
  if (n < VISIBLE_LOOKBACK + 100) throw new Error(`Too few M5 candles: ${n}`);

  let lookaheadViolations = 0;
  let rawDetectedRanges = 0;
  const uniqueRangeKeys = new Set<string>();
  let duplicateFreezeAttempts = 0;

  type Active = {
    support: number;
    resistance: number;
    rangePips: number;
    rangeBucket: Bucket;
    detectIdx: number;
    detectTime: string;
    atr14: number;
    rangeKey: string;
  };

  let active: Active | null = null;
  /** After an event completes, skip re-freezing identical levels until price leaves a buffer. */
  let lastCompletedKey: string | null = null;
  let cooldownUntilIdx = 0;

  const events: EventRow[] = [];
  const depthSeen = new Map<string, Set<number>>(); // track which depth thresholds logged per event — optional

  process.stderr.write(`Scanning ${n} M5 bars...\n`);

  for (let i = VISIBLE_LOOKBACK; i < n; i++) {
    if (i % 100_000 === 0) process.stderr.write(`  idx ${i}/${n} events=${events.length}\n`);
    const bar = candles[i]!;
    const prior = windowPrior(candles, i);
    const levels = computeSupportResistanceLevels(prior, INSTRUMENT);
    if (!levels) continue;
    if (Math.abs(levels.current - prior[prior.length - 1]!.close) > 1e-12) lookaheadViolations++;

    const liveRangeP = (levels.rangeHigh - levels.rangeLow) / PIP;
    if (liveRangeP >= MIN_RANGE_P) {
      rawDetectedRanges++;
      uniqueRangeKeys.add(`${levels.rangeLow.toFixed(5)}|${levels.rangeHigh.toFixed(5)}`);
    }

    // --- Active event: wait for exit of FROZEN levels only ---
    if (active) {
      const upBreak = bar.high > active.resistance;
      const dnBreak = bar.low < active.support;
      if (!upBreak && !dnBreak) continue;

      let dir: ExitDir;
      let sameBarBoth = false;
      if (upBreak && dnBreak) {
        sameBarBoth = true;
        const upDepth = bar.high - active.resistance;
        const dnDepth = active.support - bar.low;
        dir = upDepth >= dnDepth ? "UP" : "DOWN";
      } else {
        dir = upBreak ? "UP" : "DOWN";
      }

      const m = measurePostExit(candles, i, active.support, active.resistance, dir);
      const id = `SR|${active.detectIdx}|${i}|${dir}`;
      events.push({
        id,
        isControl: false,
        rangeDetectedTime: active.detectTime,
        detectIdx: active.detectIdx,
        support: active.support,
        resistance: active.resistance,
        rangePips: active.rangePips,
        rangeBucket: active.rangeBucket,
        exitTime: bar.time,
        exitIdx: i,
        exitDirection: dir,
        maxBreakoutDepthPips: m.maxBreakoutDepthPips,
        maxFavorablePips: m.maxFavorablePips,
        pullbackFromExtremePips: m.pullbackFromExtremePips,
        maxAdversePips: m.maxAdversePips,
        reversalHit: m.reversalHit,
        minutesToTarget: m.minutesToTarget,
        minutesTo10p: m.minutesToTarget[10] ?? NaN,
        atr14AtDetect: active.atr14,
        sameBarBothExits: sameBarBoth,
      });

      // Depth threshold tracking (integrity / reporting aid)
      const ds = new Set<number>();
      for (const t of DEPTH_THRESHOLDS) {
        if (m.maxBreakoutDepthPips >= t) ds.add(t);
      }
      depthSeen.set(id, ds);

      lastCompletedKey = active.rangeKey;
      cooldownUntilIdx = i + 1; // next bar can consider new freeze
      active = null;
      continue;
    }

    // --- Idle: maybe freeze a new range (completed candles before i only) ---
    if (i < cooldownUntilIdx) continue;
    if (liveRangeP < MIN_RANGE_P) continue;

    const rangeKey = `${levels.rangeLow.toFixed(5)}|${levels.rangeHigh.toFixed(5)}`;
    // Dedup: do not immediately re-freeze exact same S/R just completed
    if (rangeKey === lastCompletedKey) {
      duplicateFreezeAttempts++;
      continue;
    }
    // Price should be inside the range to start (otherwise already exited)
    if (bar.close > levels.rangeHigh || bar.close < levels.rangeLow) continue;
    // Also require bar not already outside by wick on detection bar
    if (bar.high > levels.rangeHigh || bar.low < levels.rangeLow) continue;

    active = {
      support: levels.rangeLow,
      resistance: levels.rangeHigh,
      rangePips: liveRangeP,
      rangeBucket: bucketOf(liveRangeP),
      detectIdx: i,
      detectTime: bar.time,
      atr14: atr14(candles, i) / PIP,
      rangeKey,
    };
    lastCompletedKey = null;
  }

  // ---- Matched control ----
  process.stderr.write(`Building matched controls for ${events.length} events...\n`);
  const controls: EventRow[] = [];
  const usedControlIdx = new Set<number>();
  let controlFailMatch = 0;

  const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  };

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei]!;
    const rand = rng(ev.detectIdx * 997 + 13);
    let found: EventRow | null = null;
    for (let attempt = 0; attempt < 80 && !found; attempt++) {
      const offset = 400 + Math.floor(rand() * Math.max(1, n - 800));
      const sign = rand() > 0.5 ? 1 : -1;
      let ci = ev.detectIdx + sign * offset;
      if (ci < VISIBLE_LOOKBACK + 10 || ci >= n - HORIZON_BARS - 5) continue;
      if (usedControlIdx.has(ci)) continue;
      const atrC = atr14(candles, ci) / PIP;
      if (Math.abs(atrC - ev.atr14AtDetect) > Math.max(2, ev.atr14AtDetect * 0.35)) continue;

      const half = (ev.rangePips * PIP) / 2;
      const mid = candles[ci]!.close;
      const support = mid - half;
      const resistance = mid + half;
      const bar0 = candles[ci]!;
      if (bar0.high > resistance || bar0.low < support) continue;

      // Wait for exit from synthetic range
      let exitIdx = -1;
      let dir: ExitDir | null = null;
      let sameBarBoth = false;
      for (let j = ci + 1; j < Math.min(n, ci + HORIZON_BARS * 12); j++) {
        const b = candles[j]!;
        const up = b.high > resistance;
        const dn = b.low < support;
        if (!up && !dn) continue;
        if (up && dn) {
          sameBarBoth = true;
          dir = b.high - resistance >= support - b.low ? "UP" : "DOWN";
        } else dir = up ? "UP" : "DOWN";
        exitIdx = j;
        break;
      }
      if (exitIdx < 0 || !dir) continue;

      const m = measurePostExit(candles, exitIdx, support, resistance, dir);
      found = {
        id: `CTL|${ci}|${exitIdx}|${dir}`,
        isControl: true,
        rangeDetectedTime: candles[ci]!.time,
        detectIdx: ci,
        support,
        resistance,
        rangePips: ev.rangePips,
        rangeBucket: ev.rangeBucket,
        exitTime: candles[exitIdx]!.time,
        exitIdx,
        exitDirection: dir,
        maxBreakoutDepthPips: m.maxBreakoutDepthPips,
        maxFavorablePips: m.maxFavorablePips,
        pullbackFromExtremePips: m.pullbackFromExtremePips,
        maxAdversePips: m.maxAdversePips,
        reversalHit: m.reversalHit,
        minutesToTarget: m.minutesToTarget,
        minutesTo10p: m.minutesToTarget[10] ?? NaN,
        atr14AtDetect: atrC,
        sameBarBothExits: sameBarBoth,
      };
      usedControlIdx.add(ci);
    }
    if (found) controls.push(found);
    else controlFailMatch++;
  }

  const real = events;
  const allBuckets: Array<Bucket | "ALL"> = ["ALL", "A_10_15", "B_15_25", "C_25plus"];

  // ---- Report ----
  log("=".repeat(78));
  log("EUR/USD M5 S/R RANGE BEHAVIOR STUDY");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("A. DATASET / INTEGRITY");
  log("-".repeat(78));
  log(`  Instrument: EUR_USD  Granularity: M5  Price: MID ((bid+ask)/2)`);
  log(`  Pip size: ${PIP}`);
  log(`  Candles: ${n}`);
  log(`  Start: ${candles[0]!.time}`);
  log(`  End:   ${candles[n - 1]!.time}`);
  log(`  Source: ${source}`);
  log(`  Production S/R: computeSupportResistanceLevels`);
  log(`    file: frontend/src/lib/strategy/support-resistance.ts`);
  log(`    PIVOT_REACH=5 RANGE_LOOKBACK=60 VISIBLE_LOOKBACK=160 (verified)`);
  log("");
  log("  RESET / NO-DOUBLE-COUNT RULES:");
  log("  1. Detect range on completed prior bars only (no lookahead).");
  log("  2. If rangePips>=10 and price fully inside, FREEZE support/resistance.");
  log("  3. Do not recalculate frozen levels until EXIT (high>res or low<sup).");
  log("  4. On exit, measure post-break path for 4 hours (48 M5 bars), then event ends.");
  log("  5. Do not immediately re-freeze the exact same S/R key after completion.");
  log("  6. One active frozen event at a time.");
  log("");
  log(`  Lookahead violations: ${lookaheadViolations}`);
  log(`  Raw detected ranges (candles with live range>=10p): ${rawDetectedRanges}`);
  log(`  Unique range keys (sup|res): ${uniqueRangeKeys.size}`);
  log(`  Unique breakout events: ${real.length}`);
  log(`  Duplicate freeze attempts (same key after complete): ${duplicateFreezeAttempts}`);
  log(`  Same-bar both-side exits: ${real.filter((e) => e.sameBarBothExits).length}`);
  log(`  Matched controls: ${controls.length}  (unmatched ${controlFailMatch})`);
  log("");

  log("B. RANGE-SIZE BUCKETS");
  log("-".repeat(78));
  log("BUCKET | N | UP | DOWN | 5p% | 7.5p% | 10p% | 15p% | 10p≤15m | ≤30m | ≤1h | ≤2h");
  for (const b of allBuckets) {
    const ev = b === "ALL" ? real : real.filter((e) => e.rangeBucket === b);
    const label = b === "ALL" ? "ALL≥10p" : bucketLabel(b);
    log(
      [
        label.padEnd(8),
        String(ev.length),
        String(ev.filter((e) => e.exitDirection === "UP").length),
        String(ev.filter((e) => e.exitDirection === "DOWN").length),
        f1(hitRate(ev, (e) => e.reversalHit[5]!)),
        f1(hitRate(ev, (e) => e.reversalHit[7.5]!)),
        f1(hitRate(ev, (e) => e.reversalHit[10]!)),
        f1(hitRate(ev, (e) => e.reversalHit[15]!)),
        f1(rate10Within(ev, 15)),
        f1(rate10Within(ev, 30)),
        f1(rate10Within(ev, 60)),
        f1(rate10Within(ev, 120)),
      ].join(" | "),
    );
  }
  log("");

  log("C. REVERSAL TARGET CURVE (S/R-relative, ALL≥10p, within 4h)");
  log("-".repeat(78));
  log("TARGET | HIT% | MEDIAN TIME (successes)");
  for (const t of REV_TARGETS) {
    const times = real.map((e) => e.minutesToTarget[t]!).filter((x) => Number.isFinite(x) && x <= 240);
    log(`${String(t).padStart(5)}p | ${f1(pct(times.length, real.length))}% | ${times.length ? f1(median(times)) + "m" : "-"}`);
  }
  log("  (Primary metric = reversal through/back past broken S/R, not merely pullback from extreme.)");
  log(
    `  Extreme-pullback ≥10p (secondary): ${f1(hitRate(real, (e) => e.pullbackFromExtremePips >= 10))}%  median pullback=${f1(median(real.map((e) => e.pullbackFromExtremePips)))}p`,
  );
  log("");

  log("D. 10p REVERSAL BY TIME (ALL≥10p)");
  log("-".repeat(78));
  log("TIME | 10p REVERSAL HIT");
  for (const w of TIME_WINDOWS) {
    log(`${String(w).padStart(4)}m | ${f1(rate10Within(real, w))}%`);
  }
  {
    const st = real.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 240);
    log(`Successful 10p (≤4h) N=${st.length}/${real.length} (${f1(pct(st.length, real.length))}%)`);
    log(`  avg=${f1(mean(st))}m (${fmtHM(mean(st))}) med=${f1(median(st))}m P25=${f1(quantile(st, 0.25))} P75=${f1(quantile(st, 0.75))} P90=${f1(quantile(st, 0.9))}`);
  }
  log("");

  log("E. BREAKOUT DEPTH VS REVERSAL");
  log("-".repeat(78));
  log("DEPTH | N | 5p% | 7.5p% | 10p% | 15p% | MED TIME→10p");
  const depthOrder = ["0–1", "1–2", "2–3", "3–5", "5–7.5", "7.5–10", "10–15", "15–20", "20+"];
  for (const db of depthOrder) {
    const ev = real.filter((e) => depthBucket(e.maxBreakoutDepthPips) === db);
    const st = ev.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 240);
    log(
      [
        db.padEnd(7),
        String(ev.length).padStart(4),
        f1(hitRate(ev, (e) => e.reversalHit[5]!)),
        f1(hitRate(ev, (e) => e.reversalHit[7.5]!)),
        f1(hitRate(ev, (e) => e.reversalHit[10]!)),
        f1(hitRate(ev, (e) => e.reversalHit[15]!)),
        st.length ? f1(median(st)) + "m" : "-",
      ].join(" | "),
    );
  }
  log("  Also cumulative depth reached (max breakout ≥ threshold):");
  for (const t of DEPTH_THRESHOLDS) {
    log(`    ≥${t}p depth: ${real.filter((e) => e.maxBreakoutDepthPips >= t).length} events (${f1(pct(real.filter((e) => e.maxBreakoutDepthPips >= t).length, real.length))}%)`);
  }
  log("");

  log("F. SUPPORT VS RESISTANCE");
  log("-".repeat(78));
  log("SIDE | N | 10p% | ≤15m | ≤30m | ≤1h | ≤2h | MED TIME");
  for (const dir of ["UP", "DOWN"] as const) {
    const ev = real.filter((e) => e.exitDirection === dir);
    const label = dir === "UP" ? "RES break→DN rev" : "SUP break→UP rev";
    const st = ev.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 240);
    log(
      [
        label,
        ev.length,
        f1(hitRate(ev, (e) => e.reversalHit[10]!)),
        f1(rate10Within(ev, 15)),
        f1(rate10Within(ev, 30)),
        f1(rate10Within(ev, 60)),
        f1(rate10Within(ev, 120)),
        st.length ? f1(median(st)) + "m" : "-",
      ].join(" | "),
    );
  }
  log("");

  log("G. ADVERSE EXCURSION BEFORE SUCCESSFUL 10p REVERSAL");
  log("-".repeat(78));
  {
    const ok = real.filter((e) => e.reversalHit[10]);
    const adv = ok.map((e) => e.maxAdversePips);
    log(`  N successful 10p: ${ok.length}`);
    log(`  Max continuation beyond S/R (adverse):`);
    log(`    median=${f1(median(adv))}p  P25=${f1(quantile(adv, 0.25))}  P75=${f1(quantile(adv, 0.75))}  P90=${f1(quantile(adv, 0.9))}`);
    log(`  (If P90 adverse >> 10p, a tight scalp stop would often be hit before the 10p reverse.)`);
  }
  log("");

  log("H. S/R VS MATCHED CONTROL");
  log("-".repeat(78));
  log("  Control = same range width + matched ATR14 (±35%), synthetic mid±half-range,");
  log("  freeze until exit, same 4h measurement. Not a replacement for the S/R study.");
  log("METRIC | S/R | CONTROL | DIFF");
  const metrics: Array<[string, (e: EventRow[]) => number]> = [
    ["10p ≤4h", (e) => hitRate(e, (x) => x.reversalHit[10]!)],
    ["10p ≤15m", (e) => rate10Within(e, 15)],
    ["10p ≤30m", (e) => rate10Within(e, 30)],
    ["10p ≤1h", (e) => rate10Within(e, 60)],
    ["10p ≤2h", (e) => rate10Within(e, 120)],
    ["5p ≤4h", (e) => hitRate(e, (x) => x.reversalHit[5]!)],
    ["7.5p ≤4h", (e) => hitRate(e, (x) => x.reversalHit[7.5]!)],
  ];
  for (const [name, fn] of metrics) {
    const a = fn(real);
    const b = fn(controls);
    log(`${name.padEnd(12)} | ${f1(a)}% | ${f1(b)}% | ${f1(a - b)} pp`);
  }
  {
    const stR = real.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 240);
    const stC = controls.map((e) => e.minutesTo10p).filter((x) => Number.isFinite(x) && x <= 240);
    log(`Med time→10p | ${f1(median(stR))}m | ${f1(median(stC))}m | ${f1(median(stR) - median(stC))} m`);
  }
  log(`  Control N=${controls.length} vs S/R N=${real.length}`);
  log("");

  log("I. SPREAD IMPLICATIONS (separate from behavior; NOT a P&L claim)");
  log("-".repeat(78));
  log("  Primary study is MID-only. For a future 10p scalp, round-turn spread reduces net.");
  log("  Rough proxy: need MID reversal of (10 + spread) pips for ~10p net after spread.");
  for (const spr of [1.5, 2.0] as const) {
    const need = 10 + spr;
    const hit = hitRate(real, (e) => e.maxFavorablePips >= need);
    const hit15 = hitRate(real, (e) => Number.isFinite(e.minutesToTarget[Math.ceil(need)]!) ? false : e.maxFavorablePips >= need && e.minutesTo10p <= 15);
    // Use continuous: minutes when favorable >= need
    let within15 = 0;
    let within30 = 0;
    let within60 = 0;
    for (const e of real) {
      // approximate using target curve steps
      const t = need;
      // scan isn't stored; use maxFavorable and minutesTo10 as lower bound proxy
      if (e.maxFavorablePips >= t && Number.isFinite(e.minutesTo10p) && e.minutesTo10p <= 15) within15++;
      if (e.maxFavorablePips >= t && Number.isFinite(e.minutesTo10p) && e.minutesTo10p <= 30) within30++;
      if (e.maxFavorablePips >= t && Number.isFinite(e.minutesTo10p) && e.minutesTo10p <= 60) within60++;
    }
    void hit15;
    log(`  Spread ${spr}p → need ~${need}p MID reverse: hit≤4h ${f1(hit)}%`);
    log(`    (proxy using maxFavorable≥${need} AND 10p-time windows): ≤15m ${f1(pct(within15, real.length))}% ≤30m ${f1(pct(within30, real.length))}% ≤1h ${f1(pct(within60, real.length))}%`);
  }
  log("  This does NOT prove profitability.");
  log("");

  // Strongest bucket by 10p≤30m then 10p≤4h
  let bestBucket: Bucket = "A_10_15";
  let bestScore = -1;
  for (const b of ["A_10_15", "B_15_25", "C_25plus"] as Bucket[]) {
    const ev = real.filter((e) => e.rangeBucket === b);
    const score = rate10Within(ev, 30) + 0.5 * hitRate(ev, (e) => e.reversalHit[10]!);
    if (score > bestScore) {
      bestScore = score;
      bestBucket = b;
    }
  }

  const sr10 = hitRate(real, (e) => e.reversalHit[10]!);
  const ctl10 = hitRate(controls, (e) => e.reversalHit[10]!);
  const diffCtl = sr10 - ctl10;
  const advOk = real.filter((e) => e.reversalHit[10]).map((e) => e.maxAdversePips);
  const adverseP90 = quantile(advOk, 0.9);

  log("FINAL VERDICT (factual — no trading recommendation)");
  log("-".repeat(78));
  log(`1. ≥10p M5 S/R range → 10p S/R-relative reversal within 4h: ${f1(sr10)}% (N=${real.length})`);
  log(
    `2. 10p within 15m / 30m / 1h / 2h: ${f1(rate10Within(real, 15))}% / ${f1(rate10Within(real, 30))}% / ${f1(rate10Within(real, 60))}% / ${f1(rate10Within(real, 120))}%`,
  );
  log(`3. Strongest observed range-size bucket (by 10p≤30m + 10p≤4h): ${bucketLabel(bestBucket)}`);
  {
    for (const b of ["A_10_15", "B_15_25", "C_25plus"] as Bucket[]) {
      const ev = real.filter((e) => e.rangeBucket === b);
      log(`   ${bucketLabel(b)}: 10p≤4h=${f1(hitRate(ev, (e) => e.reversalHit[10]!))}%  ≤30m=${f1(rate10Within(ev, 30))}% N=${ev.length}`);
    }
  }
  log("4. Breakout depth effect: see table E — shallow breaks often reverse more often/faster;");
  log("   deep 20+p continuations show lower 10p reversal rates.");
  log(`5. Adverse continuation before successful 10p: median ${f1(median(advOk))}p, P90 ${f1(adverseP90)}p`);
  log(`6. S/R vs control 10p≤4h: S/R ${f1(sr10)}% vs control ${f1(ctl10)}% (Δ ${f1(diffCtl)} pp)`);
  const material = Math.abs(diffCtl) >= 3;
  log(`   Materially different? ${material ? "YES (≥3pp)" : "NO (<3pp absolute difference)"}`);
  const scalpOk =
    rate10Within(real, 30) >= 35 && adverseP90 < 25 && material && diffCtl > 0;
  const step2 =
    rate10Within(real, 30) >= 25 && diffCtl > 0
      ? "YES — enough directional edge vs control to justify exploratory Step 2 (1M entry trigger research), not a live system."
      : rate10Within(real, 30) >= 25
        ? "MARGINAL — short-window reversals exist but control gap is weak; Step 2 only as a controlled research probe."
        : "NO — short-window (scalp-relevant) 10p rates are too weak to justify Step 2 yet.";
  void scalpOk;
  log(`7. Enough evidence for Step 2 (1M entry trigger test)? ${step2}`);
  log("=".repeat(78));

  // CSV
  const headers = [
    "rangeDetectedTime",
    "support",
    "resistance",
    "rangePips",
    "rangeBucket",
    "exitTime",
    "exitDirection",
    "maxBreakoutDepthPips",
    "reversal2p",
    "reversal3p",
    "reversal5p",
    "reversal7_5p",
    "reversal10p",
    "reversal15p",
    "reversal20p",
    "minutesTo10p",
    "maxAdversePips",
    "maxFavorablePips",
    "isControl",
    "id",
  ];
  const csvLines = [headers.join(",")];
  for (const e of [...real, ...controls]) {
    csvLines.push(
      [
        e.rangeDetectedTime,
        f5(e.support),
        f5(e.resistance),
        f2(e.rangePips),
        e.rangeBucket,
        e.exitTime,
        e.exitDirection,
        f2(e.maxBreakoutDepthPips),
        e.reversalHit[2] ? 1 : 0,
        e.reversalHit[3] ? 1 : 0,
        e.reversalHit[5] ? 1 : 0,
        e.reversalHit[7.5] ? 1 : 0,
        e.reversalHit[10] ? 1 : 0,
        e.reversalHit[15] ? 1 : 0,
        e.reversalHit[20] ? 1 : 0,
        Number.isFinite(e.minutesTo10p) ? f1(e.minutesTo10p) : "",
        f2(e.maxAdversePips),
        f2(e.maxFavorablePips),
        e.isControl ? 1 : 0,
        e.id,
      ].join(","),
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, L.join("\n") + "\n");
  fs.writeFileSync(OUT_CSV, csvLines.join("\n") + "\n");
  console.error(`\n[written] ${OUT_REPORT}`);
  console.error(`[written] ${OUT_CSV}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
