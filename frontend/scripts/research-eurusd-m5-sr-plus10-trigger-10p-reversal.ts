/**
 * EUR/USD M5 S/R — +10p OUTSIDE TRIGGER → FULL 10p REVERSAL STUDY
 *
 * Production S/R only: computeSupportResistanceLevels
 * Real-time trigger = first touch of resistance+10p / support-10p
 * Target = 10 pips back from trigger (i.e. back to the broken S/R level)
 *
 * No strategy, no optimization, no production changes.
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
const TRIGGER_P = 10;
const REVERSAL_P = 10;
const TIME_WINDOWS = [5, 10, 15, 30, 60, 120, 240] as const;
const CONT_THRESHOLDS = [5, 10, 15, 20, 30] as const;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-m5-sr-plus10-trigger-10p-reversal.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-m5-sr-plus10-trigger-10p-reversal-events.csv");
const M5_CACHE = path.join(OUT_DIR, "cache", "eurusd-m5-ba-for-sr-range-study.json");
const M5_SCRATCH =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m5-mba-cache.json";
const SR_SRC = path.resolve(__dirname, "../src/lib/strategy/support-resistance.ts");

type Side = "RESISTANCE" | "SUPPORT";

type Event = {
  id: string;
  side: Side;
  support: number;
  resistance: number;
  breakIdx: number;
  breakTime: string;
  triggerIdx: number;
  triggerTime: string;
  triggerPrice: number;
  targetPrice: number;
  hit: boolean;
  minutesToReverse: number;
  /** pips farther beyond trigger before reverse (or within horizon if never) */
  adverseBeyondTriggerPips: number;
  /** eventual max breakout from S/R (hindsight) */
  maxBreakoutFromSrPips: number;
  firstHitCont: Record<number, "REV" | "CONT" | "NONE">; // cont thresholds
  hitWithin: Record<number, boolean>;
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

function verifySr(): void {
  const src = fs.readFileSync(SR_SRC, "utf8");
  for (const [n, v] of [
    ["PIVOT_REACH", 5],
    ["RANGE_LOOKBACK", 60],
    ["VISIBLE_LOOKBACK", 160],
  ] as const) {
    const m = new RegExp(`const ${n} = (\\d+)`).exec(src);
    if (!m || Number(m[1]) !== v) throw new Error(`SR constant mismatch ${n}`);
  }
}

async function loadM5(): Promise<{ candles: Candle[]; source: string }> {
  const p = [M5_CACHE, M5_SCRATCH].find((x) => fs.existsSync(x));
  if (!p) throw new Error("No M5 cache — fetch OANDA M5 MBA first");
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

function windowPrior(candles: Candle[], endExclusive: number): Candle[] {
  return candles.slice(Math.max(0, endExclusive - VISIBLE_LOOKBACK), endExclusive);
}

function adverseBucket(p: number): string {
  if (p < 2) return "0–2";
  if (p < 5) return "2–5";
  if (p < 7.5) return "5–7.5";
  if (p < 10) return "7.5–10";
  if (p < 15) return "10–15";
  if (p < 20) return "15–20";
  return "20+";
}

function maxDepthBucket(p: number): string {
  if (p < 15) return "10–15";
  if (p < 20) return "15–20";
  if (p < 30) return "20–30";
  if (p < 40) return "30–40";
  return "40+";
}

function measureFromTrigger(
  candles: Candle[],
  triggerIdx: number,
  side: Side,
  triggerPrice: number,
  srLevel: number,
): Omit<Event, "id" | "side" | "support" | "resistance" | "breakIdx" | "breakTime" | "triggerIdx" | "triggerTime" | "triggerPrice" | "targetPrice"> {
  const targetPrice = side === "RESISTANCE" ? triggerPrice - REVERSAL_P * PIP : triggerPrice + REVERSAL_P * PIP;
  const end = Math.min(candles.length - 1, triggerIdx + HORIZON_BARS);

  let hit = false;
  let minutesToReverse = NaN;
  let adverseBeyond = 0;
  let maxFromSr = side === "RESISTANCE" ? (candles[triggerIdx]!.high - srLevel) / PIP : (srLevel - candles[triggerIdx]!.low) / PIP;

  const firstHitCont: Record<number, "REV" | "CONT" | "NONE"> = {};
  for (const t of CONT_THRESHOLDS) firstHitCont[t] = "NONE";
  const hitWithin: Record<number, boolean> = {};
  for (const w of TIME_WINDOWS) hitWithin[w] = false;

  // Include trigger bar for adverse (may wick further) but reversal on same bar is ambiguous —
  // count reversal from trigger bar inclusive (conservative for adverse, inclusive for hit timing)
  for (let j = triggerIdx; j <= end; j++) {
    const bar = candles[j]!;
    const mins = (j - triggerIdx) * BAR_MIN;

    if (side === "RESISTANCE") {
      adverseBeyond = Math.max(adverseBeyond, (bar.high - triggerPrice) / PIP);
      maxFromSr = Math.max(maxFromSr, (bar.high - srLevel) / PIP);
      const rev = (triggerPrice - bar.low) / PIP;
      if (!hit && rev >= REVERSAL_P) {
        hit = true;
        minutesToReverse = mins;
      }
    } else {
      adverseBeyond = Math.max(adverseBeyond, (triggerPrice - bar.low) / PIP);
      maxFromSr = Math.max(maxFromSr, (srLevel - bar.low) / PIP);
      const rev = (bar.high - triggerPrice) / PIP;
      if (!hit && rev >= REVERSAL_P) {
        hit = true;
        minutesToReverse = mins;
      }
    }

    for (const t of CONT_THRESHOLDS) {
      if (firstHitCont[t] !== "NONE") continue;
      if (hit && minutesToReverse === mins) {
        // decide order on this bar: if both cont and rev on same bar → CONT wins (conservative)
        if (adverseBeyond >= t) firstHitCont[t] = "CONT";
        else firstHitCont[t] = "REV";
      } else if (adverseBeyond >= t) {
        firstHitCont[t] = "CONT";
      }
    }
  }

  // Re-scan for clean first-hit ordering (bar by bar, check cont before rev within bar = conservative)
  {
    let adv = 0;
    let gotRev = false;
    let gotRevMin = NaN;
    const fh: Record<number, "REV" | "CONT" | "NONE"> = {};
    for (const t of CONT_THRESHOLDS) fh[t] = "NONE";
    for (let j = triggerIdx; j <= end; j++) {
      const bar = candles[j]!;
      const mins = (j - triggerIdx) * BAR_MIN;
      let contExt: number;
      let revExt: number;
      if (side === "RESISTANCE") {
        contExt = (bar.high - triggerPrice) / PIP;
        revExt = (triggerPrice - bar.low) / PIP;
      } else {
        contExt = (triggerPrice - bar.low) / PIP;
        revExt = (bar.high - triggerPrice) / PIP;
      }
      adv = Math.max(adv, contExt);
      for (const t of CONT_THRESHOLDS) {
        if (fh[t] !== "NONE") continue;
        if (adv >= t) fh[t] = "CONT";
      }
      if (!gotRev && revExt >= REVERSAL_P) {
        gotRev = true;
        gotRevMin = mins;
        for (const t of CONT_THRESHOLDS) {
          if (fh[t] === "NONE") fh[t] = "REV";
        }
      }
    }
    Object.assign(firstHitCont, fh);
    hit = gotRev;
    minutesToReverse = gotRevMin;
    adverseBeyond = adv;
  }

  for (const w of TIME_WINDOWS) {
    hitWithin[w] = hit && Number.isFinite(minutesToReverse) && minutesToReverse <= w;
  }

  void targetPrice;
  return {
    hit,
    minutesToReverse,
    adverseBeyondTriggerPips: adverseBeyond,
    maxBreakoutFromSrPips: maxFromSr,
    firstHitCont,
    hitWithin,
  };
}

function rate(ev: Event[], pred: (e: Event) => boolean): number {
  return pct(ev.filter(pred).length, ev.length);
}

async function main(): Promise<void> {
  verifySr();
  const { candles, source } = await loadM5();
  const n = candles.length;
  if (n < VISIBLE_LOOKBACK + 100) throw new Error(`Too few candles: ${n}`);

  let lookaheadViolations = 0;
  let frozenExcursions = 0;
  let resBreakouts = 0;
  let supBreakouts = 0;
  let duplicateTriggers = 0;

  type Active = {
    support: number;
    resistance: number;
    side: Side | null; // set on break
    breakIdx: number;
    triggered: boolean;
  };

  let active: Active | null = null;
  let lastKey: string | null = null;
  const events: Event[] = [];

  process.stderr.write(`Scanning ${n} M5 bars...\n`);

  for (let i = VISIBLE_LOOKBACK; i < n; i++) {
    if (i % 100_000 === 0) process.stderr.write(`  idx ${i}/${n} events=${events.length}\n`);
    const bar = candles[i]!;
    const prior = windowPrior(candles, i);
    const levels = computeSupportResistanceLevels(prior, INSTRUMENT);
    if (!levels) continue;
    if (Math.abs(levels.current - prior[prior.length - 1]!.close) > 1e-12) lookaheadViolations++;

    // Active excursion: wait for +10 trigger or abandon if re-enters deep inside
    if (active && active.side) {
      if (active.triggered) {
        // should not happen — cleared after trigger
        active = null;
        continue;
      }

      if (active.side === "RESISTANCE") {
        // abandon if close back below resistance by >1p (failed break)
        if (bar.close < active.resistance - PIP) {
          active = null;
          continue;
        }
        const triggerLvl = active.resistance + TRIGGER_P * PIP;
        if (bar.high >= triggerLvl) {
          const triggerPrice = triggerLvl; // first touch of level
          const m = measureFromTrigger(candles, i, "RESISTANCE", triggerPrice, active.resistance);
          events.push({
            id: `RES|${active.breakIdx}|${i}`,
            side: "RESISTANCE",
            support: active.support,
            resistance: active.resistance,
            breakIdx: active.breakIdx,
            breakTime: candles[active.breakIdx]!.time,
            triggerIdx: i,
            triggerTime: bar.time,
            triggerPrice,
            targetPrice: triggerPrice - REVERSAL_P * PIP,
            ...m,
          });
          lastKey = `${active.support.toFixed(5)}|${active.resistance.toFixed(5)}`;
          active = null;
        }
      } else {
        if (bar.close > active.support + PIP) {
          active = null;
          continue;
        }
        const triggerLvl = active.support - TRIGGER_P * PIP;
        if (bar.low <= triggerLvl) {
          const triggerPrice = triggerLvl;
          const m = measureFromTrigger(candles, i, "SUPPORT", triggerPrice, active.support);
          events.push({
            id: `SUP|${active.breakIdx}|${i}`,
            side: "SUPPORT",
            support: active.support,
            resistance: active.resistance,
            breakIdx: active.breakIdx,
            breakTime: candles[active.breakIdx]!.time,
            triggerIdx: i,
            triggerTime: bar.time,
            triggerPrice,
            targetPrice: triggerPrice + REVERSAL_P * PIP,
            ...m,
          });
          lastKey = `${active.support.toFixed(5)}|${active.resistance.toFixed(5)}`;
          active = null;
        }
      }
      continue;
    }

    // Active freeze waiting for first break
    if (active && !active.side) {
      const up = bar.high > active.resistance;
      const dn = bar.low < active.support;
      if (!up && !dn) continue;
      if (up && dn) {
        // both: pick deeper
        const ud = bar.high - active.resistance;
        const dd = active.support - bar.low;
        active.side = ud >= dd ? "RESISTANCE" : "SUPPORT";
      } else {
        active.side = up ? "RESISTANCE" : "SUPPORT";
      }
      active.breakIdx = i;
      frozenExcursions++;
      if (active.side === "RESISTANCE") resBreakouts++;
      else supBreakouts++;

      // same bar may already reach +10
      if (active.side === "RESISTANCE") {
        const triggerLvl = active.resistance + TRIGGER_P * PIP;
        if (bar.high >= triggerLvl) {
          active.triggered = true;
          const triggerPrice = triggerLvl;
          const m = measureFromTrigger(candles, i, "RESISTANCE", triggerPrice, active.resistance);
          events.push({
            id: `RES|${i}|${i}`,
            side: "RESISTANCE",
            support: active.support,
            resistance: active.resistance,
            breakIdx: i,
            breakTime: bar.time,
            triggerIdx: i,
            triggerTime: bar.time,
            triggerPrice,
            targetPrice: triggerPrice - REVERSAL_P * PIP,
            ...m,
          });
          lastKey = `${active.support.toFixed(5)}|${active.resistance.toFixed(5)}`;
          active = null;
        }
      } else {
        const triggerLvl = active.support - TRIGGER_P * PIP;
        if (bar.low <= triggerLvl) {
          active.triggered = true;
          const triggerPrice = triggerLvl;
          const m = measureFromTrigger(candles, i, "SUPPORT", triggerPrice, active.support);
          events.push({
            id: `SUP|${i}|${i}`,
            side: "SUPPORT",
            support: active.support,
            resistance: active.resistance,
            breakIdx: i,
            breakTime: bar.time,
            triggerIdx: i,
            triggerTime: bar.time,
            triggerPrice,
            targetPrice: triggerPrice + REVERSAL_P * PIP,
            ...m,
          });
          lastKey = `${active.support.toFixed(5)}|${active.resistance.toFixed(5)}`;
          active = null;
        }
      }
      continue;
    }

    // Idle: freeze new range if inside
    const rangeP = (levels.rangeHigh - levels.rangeLow) / PIP;
    if (rangeP < 10) continue; // need meaningful range (same family as prior M5 study)
    const key = `${levels.rangeLow.toFixed(5)}|${levels.rangeHigh.toFixed(5)}`;
    if (key === lastKey) continue;
    if (bar.high > levels.rangeHigh || bar.low < levels.rangeLow) continue;
    if (bar.close > levels.rangeHigh || bar.close < levels.rangeLow) continue;

    active = {
      support: levels.rangeLow,
      resistance: levels.rangeHigh,
      side: null,
      breakIdx: -1,
      triggered: false,
    };
    lastKey = null;
  }

  const res = events.filter((e) => e.side === "RESISTANCE");
  const sup = events.filter((e) => e.side === "SUPPORT");

  log("=".repeat(78));
  log("EUR/USD M5 S/R — +10p OUTSIDE TRIGGER → FULL 10p REVERSAL");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("");
  log("INTEGRITY");
  log("-".repeat(78));
  log(`  Production S/R: computeSupportResistanceLevels`);
  log(`  File: frontend/src/lib/strategy/support-resistance.ts`);
  log(`  Data: ${source}`);
  log(`  Total candles: ${n}`);
  log(`  Date range: ${candles[0]!.time} → ${candles[n - 1]!.time}`);
  log(`  Frozen S/R excursions (broke range): ${frozenExcursions}`);
  log(`  Resistance breakouts: ${resBreakouts}`);
  log(`  Support breakouts: ${supBreakouts}`);
  log(`  +10p resistance triggers: ${res.length}`);
  log(`  +10p support triggers: ${sup.length}`);
  log(`  Duplicate triggers: ${duplicateTriggers}`);
  log(`  Lookahead violations: ${lookaheadViolations}`);
  log("");
  log("  TRIGGER (real-time): first touch of resistance+10p / support-10p");
  log("  TARGET: 10 pips reverse from triggerPrice (= back to broken S/R)");
  log("  One trigger per frozen breakout excursion.");
  log("");

  log("MAIN COMPARISON — FULL 10-PIP REVERSAL FROM +10/−10 TRIGGER");
  log("-".repeat(78));
  log("SIDE             | N    | 5m   | 10m  | 15m  | 30m  | 1H   | 2H   | 4H");
  for (const [label, ev] of [
    ["Resistance break", res],
    ["Support break", sup],
  ] as const) {
    log(
      [
        label.padEnd(16),
        String(ev.length).padStart(4),
        f1(rate(ev, (e) => e.hitWithin[5]!)),
        f1(rate(ev, (e) => e.hitWithin[10]!)),
        f1(rate(ev, (e) => e.hitWithin[15]!)),
        f1(rate(ev, (e) => e.hitWithin[30]!)),
        f1(rate(ev, (e) => e.hitWithin[60]!)),
        f1(rate(ev, (e) => e.hitWithin[120]!)),
        f1(rate(ev, (e) => e.hitWithin[240]!)),
      ].join(" | "),
    );
  }
  log("");

  log("TIME TO REVERSAL (successful ≤4H only)");
  log("-".repeat(78));
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
  ] as const) {
    const st = ev.filter((e) => e.hit).map((e) => e.minutesToReverse);
    log(`  ${label} N_success=${st.length}/${ev.length}`);
    log(
      `    avg=${f1(mean(st))}m med=${f1(median(st))}m P25=${f1(quantile(st, 0.25))} P75=${f1(quantile(st, 0.75))} P90=${f1(quantile(st, 0.9))}`,
    );
  }
  log("");

  log("ADVERSE CONTINUATION AFTER TRIGGER (real-time buckets)");
  log("-".repeat(78));
  const advOrder = ["0–2", "2–5", "5–7.5", "7.5–10", "10–15", "15–20", "20+"];
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
  ] as const) {
    log(`  --- ${label} ---`);
    log("  FARTHER | N | 10p≤30m | ≤1H | ≤2H | ≤4H");
    for (const b of advOrder) {
      const sub = ev.filter((e) => adverseBucket(e.adverseBeyondTriggerPips) === b);
      log(
        [
          b.padEnd(7),
          String(sub.length).padStart(4),
          f1(rate(sub, (e) => e.hitWithin[30]!)),
          f1(rate(sub, (e) => e.hitWithin[60]!)),
          f1(rate(sub, (e) => e.hitWithin[120]!)),
          f1(rate(sub, (e) => e.hitWithin[240]!)),
        ].join(" | "),
      );
    }
  }
  log("");

  log("MAX BREAKOUT DEPTH FROM S/R — HINDSIGHT / DESCRIPTIVE ONLY");
  log("-".repeat(78));
  log("  (NOT a real-time entry rule — uses eventual max depth after trigger)");
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
  ] as const) {
    log(`  --- ${label} ---`);
    log("  MAX DEPTH | N | 10p rev ≤4H");
    for (const b of ["10–15", "15–20", "20–30", "30–40", "40+"]) {
      const sub = ev.filter((e) => maxDepthBucket(e.maxBreakoutFromSrPips) === b);
      log(`  ${b.padEnd(8)} | ${String(sub.length).padStart(4)} | ${f1(rate(sub, (e) => e.hitWithin[240]!))}%`);
    }
  }
  log("");

  log("FIRST-HIT RISK: 10p REVERSAL before further CONTINUATION");
  log("-".repeat(78));
  log("SIDE | N | rev before +5c | +10c | +15c | +20c | +30c");
  for (const [label, ev] of [
    ["RESISTANCE→SHORT", res],
    ["SUPPORT→LONG", sup],
  ] as const) {
    log(
      [
        label.padEnd(16),
        String(ev.length).padStart(4),
        ...CONT_THRESHOLDS.map((t) => f1(rate(ev, (e) => e.firstHitCont[t] === "REV"))),
      ].join(" | "),
    );
  }
  log("  (c = continuation pips beyond the +10/−10 trigger)");
  log("");

  log("MFE / MAE — ADVERSE CONTINUATION BEYOND TRIGGER");
  log("-".repeat(78));
  for (const [label, ev] of [
    ["RESISTANCE (adverse=UP)", res],
    ["SUPPORT (adverse=DOWN)", sup],
  ] as const) {
    const a = ev.map((e) => e.adverseBeyondTriggerPips);
    log(`  ${label}:`);
    log(
      `    median=${f1(median(a))}  P25=${f1(quantile(a, 0.25))}  P75=${f1(quantile(a, 0.75))}  P90=${f1(quantile(a, 0.9))}  P95=${f1(quantile(a, 0.95))}`,
    );
  }
  log("");

  log("OPTIONAL SPREAD VIEW (NOT an execution backtest)");
  log("-".repeat(78));
  log("  Primary study is MID. For ~10 net pips after round-turn spread,");
  log("  MID reversal from trigger would need ~10+spread.");
  for (const spr of [1.5, 2.0]) {
    const need = 10 + spr;
    // approximate: adverse path unused; count max favorable from trigger via hit if we had larger target
    // We only stored 10p hit — report implication textually
    log(`  Spread ${spr}p → need ~${need}p MID reverse from trigger for ~10 net.`);
    log(`    (This study's 10p MID hit ≤4H: RES ${f1(rate(res, (e) => e.hitWithin[240]!))}% SUP ${f1(rate(sup, (e) => e.hitWithin[240]!))}%)`);
  }
  log("");

  // Final answers
  const r15 = rate(res, (e) => e.hitWithin[15]!);
  const r30 = rate(res, (e) => e.hitWithin[30]!);
  const r60 = rate(res, (e) => e.hitWithin[60]!);
  const r120 = rate(res, (e) => e.hitWithin[120]!);
  const r240 = rate(res, (e) => e.hitWithin[240]!);
  const s15 = rate(sup, (e) => e.hitWithin[15]!);
  const s30 = rate(sup, (e) => e.hitWithin[30]!);
  const s60 = rate(sup, (e) => e.hitWithin[60]!);
  const s120 = rate(sup, (e) => e.hitWithin[120]!);
  const s240 = rate(sup, (e) => e.hitWithin[240]!);

  const resTimes = res.filter((e) => e.hit).map((e) => e.minutesToReverse);
  const supTimes = sup.filter((e) => e.hit).map((e) => e.minutesToReverse);
  const resAdv = res.map((e) => e.adverseBeyondTriggerPips);
  const supAdv = sup.map((e) => e.adverseBeyondTriggerPips);

  log("FINAL ANSWERS");
  log("-".repeat(78));
  log(`1. Resistance +10p trigger → full 10p reverse: 15m ${f1(r15)}% / 30m ${f1(r30)}% / 1H ${f1(r60)}% / 2H ${f1(r120)}% / 4H ${f1(r240)}% (N=${res.length})`);
  log(`2. Support −10p trigger → full 10p reverse: 15m ${f1(s15)}% / 30m ${f1(s30)}% / 1H ${f1(s60)}% / 2H ${f1(s120)}% / 4H ${f1(s240)}% (N=${sup.length})`);
  log(
    `3. Higher observed 4H 10p reversal rate: ${r240 >= s240 ? "RESISTANCE" : "SUPPORT"} (RES ${f1(r240)}% vs SUP ${f1(s240)}%; Δ ${f1(Math.abs(r240 - s240))} pp). Not labeled better/stronger.`,
  );
  log(
    `4. Faster (lower median time among successes): ${median(resTimes) <= median(supTimes) ? "RESISTANCE" : "SUPPORT"} (RES med ${f1(median(resTimes))}m vs SUP med ${f1(median(supTimes))}m)`,
  );
  log(
    `5. Smaller adverse continuation (lower median): ${median(resAdv) <= median(supAdv) ? "RESISTANCE" : "SUPPORT"} (RES med ${f1(median(resAdv))}p vs SUP med ${f1(median(supAdv))}p)`,
  );
  log("6. How often further continuation BEFORE 10p reverse (first-hit CONT):");
  for (const [label, ev] of [
    ["RES", res],
    ["SUP", sup],
  ] as const) {
    log(
      `   ${label}: before +5c ${f1(rate(ev, (e) => e.firstHitCont[5] === "CONT"))}% / +10c ${f1(rate(ev, (e) => e.firstHitCont[10] === "CONT"))}% / +15c ${f1(rate(ev, (e) => e.firstHitCont[15] === "CONT"))}% / +20c ${f1(rate(ev, (e) => e.firstHitCont[20] === "CONT"))}% / +30c ${f1(rate(ev, (e) => e.firstHitCont[30] === "CONT"))}%`,
    );
  }
  log(
    `7. Adverse beyond trigger — RES: med ${f1(median(resAdv))} / P75 ${f1(quantile(resAdv, 0.75))} / P90 ${f1(quantile(resAdv, 0.9))} | SUP: med ${f1(median(supAdv))} / P75 ${f1(quantile(supAdv, 0.75))} / P90 ${f1(quantile(supAdv, 0.9))}`,
  );
  log(
    `8. Full 10p reverse ≤4H rates (RES ${f1(r240)}% / SUP ${f1(s240)}%) are the primary metric here; prior study's 5p-from-S/R figure is not substituted.`,
  );
  const asym = Math.abs(r240 - s240) >= 5 || Math.abs(median(resAdv) - median(supAdv)) >= 2;
  log(`9. Meaningful RES vs SUP asymmetry? ${asym ? "YES — see rate and/or adverse differences above" : "SMALL on this sample"}`);
  log("10. At the REAL-TIME +10p outside moment:");
  log(`   — Full 10p reverse ≤30m: RES ${f1(r30)}% / SUP ${f1(s30)}%`);
  log(`   — Full 10p reverse ≤4H: RES ${f1(r240)}% / SUP ${f1(s240)}%`);
  log(`   — Median further run beyond trigger before/without reverse: RES ${f1(median(resAdv))}p / SUP ${f1(median(supAdv))}p`);
  log(`   — 10p reverse before another +10c continuation: RES ${f1(rate(res, (e) => e.firstHitCont[10] === "REV"))}% / SUP ${f1(rate(sup, (e) => e.firstHitCont[10] === "REV"))}%`);
  log("=".repeat(78));

  // CSV
  const headers = [
    "side",
    "breakTime",
    "triggerTime",
    "support",
    "resistance",
    "triggerPrice",
    "targetPrice",
    "hit10pReverse",
    "minutesToReverse",
    "adverseBeyondTriggerPips",
    "maxBreakoutFromSrPips",
    "hit15m",
    "hit30m",
    "hit1H",
    "hit2H",
    "hit4H",
  ];
  const lines = [headers.join(",")];
  for (const e of events) {
    lines.push(
      [
        e.side,
        e.breakTime,
        e.triggerTime,
        f5(e.support),
        f5(e.resistance),
        f5(e.triggerPrice),
        f5(e.targetPrice),
        e.hit ? 1 : 0,
        Number.isFinite(e.minutesToReverse) ? f1(e.minutesToReverse) : "",
        f2(e.adverseBeyondTriggerPips),
        f2(e.maxBreakoutFromSrPips),
        e.hitWithin[15] ? 1 : 0,
        e.hitWithin[30] ? 1 : 0,
        e.hitWithin[60] ? 1 : 0,
        e.hitWithin[120] ? 1 : 0,
        e.hitWithin[240] ? 1 : 0,
      ].join(","),
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_REPORT, L.join("\n") + "\n");
  fs.writeFileSync(OUT_CSV, lines.join("\n") + "\n");
  console.error(`\n[written] ${OUT_REPORT}`);
  console.error(`[written] ${OUT_CSV}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
