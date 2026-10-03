/**
 * EUR/USD M15 S/R — Sep 14–18 2026 — +10p OUTSIDE TRIGGER → FULL 10p REVERSAL
 *
 * Production S/R only. One week focused sample. No strategy / optimization.
 * Same-M15-bar trigger+target ambiguity reported separately (not assumed ordered).
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle, MajorInstrument } from "../src/types/forex";
import { computeSupportResistanceLevels } from "../src/lib/strategy/support-resistance";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = 0.0001;
const VISIBLE_LOOKBACK = 160;
const BAR_MIN = 15;
const HORIZON_BARS = (4 * 60) / BAR_MIN; // 16
const TRIGGER_P = 10;
const REVERSAL_P = 10;
const TIME_WINDOWS = [15, 30, 60, 120, 240] as const;
const CONT_THRESHOLDS = [5, 10, 15, 20, 30] as const;
const EVAL_START = "2026-09-14T00:00:00.000000000Z";
const EVAL_END_EXCL = "2026-09-19T00:00:00.000000000Z";
const MIN_RANGE_P = 10;

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-m15-sep14-18-plus10-10p-reversal.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-m15-sep14-18-plus10-10p-reversal-events.csv");
const M15_FULL = path.join(OUT_DIR, "cache", "eurusd-m15-mid-for-outer-10pip.json");
const M15_WINDOW =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-sep10-19-window.json";
const SR_SRC = path.resolve(__dirname, "../src/lib/strategy/support-resistance.ts");

// Prior full-history M5 study (descriptive compare only)
const M5_HIST = {
  res4h: 75.7,
  sup4h: 75.8,
  resBefore10c: 56.1,
  supBefore10c: 59.6,
};

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
  sameBarAmbiguous: boolean;
  hitConfirmed: boolean; // strict: subsequent bar (or unambiguous)
  hitInclusiveAmbiguous: boolean; // includes same-bar as possible hit
  minutesToReverse: number; // NaN if no confirmed; 0 if same-bar counted inclusive only
  adverseBeyondTriggerPips: number;
  maxFavorablePips: number;
  maxBreakoutFromSrPips: number;
  firstHitCont: Record<number, "REV" | "CONT" | "NONE" | "AMBIG">;
  hitWithin: Record<number, boolean>; // confirmed only
  hitWithinInclusive: Record<number, boolean>;
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

function verifySr(): void {
  const src = fs.readFileSync(SR_SRC, "utf8");
  for (const [n, v] of [
    ["PIVOT_REACH", 5],
    ["RANGE_LOOKBACK", 60],
    ["VISIBLE_LOOKBACK", 160],
  ] as const) {
    const m = new RegExp(`const ${n} = (\\d+)`).exec(src);
    if (!m || Number(m[1]) !== v) throw new Error(`SR mismatch ${n}`);
  }
}

function toCandle(row: unknown): Candle | null {
  if (Array.isArray(row)) return null;
  const c = row as {
    time: string;
    complete?: boolean;
    mid?: { open: number; high: number; low: number; close: number };
  };
  if (c.complete === false || !c.mid) return null;
  return {
    time: c.time,
    open: c.mid.open,
    high: c.mid.high,
    low: c.mid.low,
    close: c.mid.close,
    volume: 0,
    complete: true,
  };
}

function loadM15(): { all: Candle[]; evalStartIdx: number; source: string } {
  if (!fs.existsSync(M15_FULL)) throw new Error(`Missing ${M15_FULL}`);
  const by = new Map<string, Candle>();
  for (const row of JSON.parse(fs.readFileSync(M15_FULL, "utf8")) as unknown[]) {
    const c = toCandle(row);
    if (c && c.time < EVAL_END_EXCL) by.set(c.time, c);
  }
  if (fs.existsSync(M15_WINDOW)) {
    for (const row of JSON.parse(fs.readFileSync(M15_WINDOW, "utf8")) as unknown[]) {
      const c = toCandle(row);
      if (c && c.time < EVAL_END_EXCL) by.set(c.time, c);
    }
  }
  const all = [...by.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
  // Keep warmup from ~Aug 2026 onward for speed, but enough for VISIBLE_LOOKBACK
  const warmFrom = "2026-08-01T00:00:00.000000000Z";
  const trimmed = all.filter((c) => c.time >= warmFrom);
  const evalStartIdx = trimmed.findIndex((c) => c.time >= EVAL_START);
  if (evalStartIdx < 0) throw new Error("No eval candles");
  // Need VISIBLE_LOOKBACK before eval — if short, use more from full
  if (evalStartIdx < VISIBLE_LOOKBACK) {
    const need = VISIBLE_LOOKBACK - evalStartIdx;
    const extra = all.filter((c) => c.time < warmFrom).slice(-need);
    const merged = [...extra, ...trimmed];
    const esi = merged.findIndex((c) => c.time >= EVAL_START);
    return { all: merged, evalStartIdx: esi, source: `OANDA M15 MID (full cache + sep window merge)` };
  }
  return { all: trimmed, evalStartIdx, source: `OANDA M15 MID (full cache + sep window merge)` };
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

function measureFromTrigger(
  candles: Candle[],
  triggerIdx: number,
  side: Side,
  triggerPrice: number,
  srLevel: number,
): Pick<
  Event,
  | "sameBarAmbiguous"
  | "hitConfirmed"
  | "hitInclusiveAmbiguous"
  | "minutesToReverse"
  | "adverseBeyondTriggerPips"
  | "maxFavorablePips"
  | "maxBreakoutFromSrPips"
  | "firstHitCont"
  | "hitWithin"
  | "hitWithinInclusive"
> {
  const end = Math.min(candles.length - 1, triggerIdx + HORIZON_BARS);
  const trig = candles[triggerIdx]!;

  // Same-bar ambiguity: trigger bar also reaches reverse target
  let sameBarAmbiguous = false;
  if (side === "RESISTANCE") {
    sameBarAmbiguous = trig.high >= triggerPrice && trig.low <= triggerPrice - REVERSAL_P * PIP;
  } else {
    sameBarAmbiguous = trig.low <= triggerPrice && trig.high >= triggerPrice + REVERSAL_P * PIP;
  }

  let adv = 0;
  let fav = 0;
  let maxFromSr =
    side === "RESISTANCE" ? (trig.high - srLevel) / PIP : (srLevel - trig.low) / PIP;

  // Inclusive path (includes trigger bar) for adverse/favorable extremes
  for (let j = triggerIdx; j <= end; j++) {
    const bar = candles[j]!;
    if (side === "RESISTANCE") {
      adv = Math.max(adv, (bar.high - triggerPrice) / PIP);
      fav = Math.max(fav, (triggerPrice - bar.low) / PIP);
      maxFromSr = Math.max(maxFromSr, (bar.high - srLevel) / PIP);
    } else {
      adv = Math.max(adv, (triggerPrice - bar.low) / PIP);
      fav = Math.max(fav, (bar.high - triggerPrice) / PIP);
      maxFromSr = Math.max(maxFromSr, (srLevel - bar.low) / PIP);
    }
  }

  // STRICT confirmed reversal: first SUBSEQUENT bar that hits target
  let hitConfirmed = false;
  let minutesConfirmed = NaN;
  for (let j = triggerIdx + 1; j <= end; j++) {
    const bar = candles[j]!;
    const mins = (j - triggerIdx) * BAR_MIN;
    const ok =
      side === "RESISTANCE"
        ? bar.low <= triggerPrice - REVERSAL_P * PIP
        : bar.high >= triggerPrice + REVERSAL_P * PIP;
    if (ok) {
      hitConfirmed = true;
      minutesConfirmed = mins;
      break;
    }
  }

  const hitInclusiveAmbiguous = hitConfirmed || sameBarAmbiguous;
  const minutesToReverse = hitConfirmed ? minutesConfirmed : sameBarAmbiguous ? 0 : NaN;

  // First-hit CONT vs REV — subsequent bars only for confirmed; same-bar = AMBIG for all thresholds if ambiguous
  const firstHitCont: Record<number, "REV" | "CONT" | "NONE" | "AMBIG"> = {};
  for (const t of CONT_THRESHOLDS) firstHitCont[t] = sameBarAmbiguous ? "AMBIG" : "NONE";

  // Non-ambiguous: trigger bar can only add adverse (further continuation).
  // Reversal confirmation uses subsequent bars only (same-bar target = AMBIG above).
  if (!sameBarAmbiguous) {
    let runAdv = 0;
    for (let j = triggerIdx; j <= end; j++) {
      const bar = candles[j]!;
      const contExt =
        side === "RESISTANCE" ? (bar.high - triggerPrice) / PIP : (triggerPrice - bar.low) / PIP;
      runAdv = Math.max(runAdv, contExt);
      for (const t of CONT_THRESHOLDS) {
        if (firstHitCont[t] !== "NONE") continue;
        if (runAdv >= t) firstHitCont[t] = "CONT";
      }
      if (j === triggerIdx) continue;
      const revOk =
        side === "RESISTANCE"
          ? bar.low <= triggerPrice - REVERSAL_P * PIP
          : bar.high >= triggerPrice + REVERSAL_P * PIP;
      if (revOk) {
        for (const t of CONT_THRESHOLDS) {
          if (firstHitCont[t] === "NONE") firstHitCont[t] = "REV";
        }
        break;
      }
    }
  }

  const hitWithin: Record<number, boolean> = {};
  const hitWithinInclusive: Record<number, boolean> = {};
  for (const w of TIME_WINDOWS) {
    hitWithin[w] = hitConfirmed && minutesConfirmed <= w;
    hitWithinInclusive[w] =
      (hitConfirmed && minutesConfirmed <= w) || (sameBarAmbiguous && w >= 0);
  }

  return {
    sameBarAmbiguous,
    hitConfirmed,
    hitInclusiveAmbiguous,
    minutesToReverse,
    adverseBeyondTriggerPips: adv,
    maxFavorablePips: fav,
    maxBreakoutFromSrPips: maxFromSr,
    firstHitCont,
    hitWithin,
    hitWithinInclusive,
  };
}

function rate(ev: Event[], pred: (e: Event) => boolean): number {
  return pct(ev.filter(pred).length, ev.length);
}

function main(): void {
  verifySr();
  const { all: candles, evalStartIdx, source } = loadM15();
  const n = candles.length;
  const evalCount = candles.filter((c) => c.time >= EVAL_START && c.time < EVAL_END_EXCL).length;

  let lookaheadViolations = 0;
  let frozenExcursions = 0;
  let resBreakouts = 0;
  let supBreakouts = 0;
  let duplicateTriggers = 0;

  type Active = {
    support: number;
    resistance: number;
    side: Side | null;
    breakIdx: number;
    counted: boolean;
  };
  let active: Active | null = null;
  let lastKey: string | null = null;
  const events: Event[] = [];

  const countExcursion = (side: Side, breakTime: string) => {
    if (breakTime >= EVAL_START && breakTime < EVAL_END_EXCL) {
      frozenExcursions++;
      if (side === "RESISTANCE") resBreakouts++;
      else supBreakouts++;
      return true;
    }
    return false;
  };

  const countExcursionForEvalTrigger = (side: Side, alreadyCounted: boolean) => {
    if (alreadyCounted) return;
    // Warmup break that produced an in-eval +10p trigger still counts as an excursion.
    frozenExcursions++;
    if (side === "RESISTANCE") resBreakouts++;
    else supBreakouts++;
  };

  process.stderr.write(`Scanning M15 n=${n} evalStartIdx=${evalStartIdx}...\n`);

  for (let i = VISIBLE_LOOKBACK; i < n; i++) {
    const bar = candles[i]!;
    const inEval = bar.time >= EVAL_START && bar.time < EVAL_END_EXCL;
    const prior = windowPrior(candles, i);
    const levels = computeSupportResistanceLevels(prior, INSTRUMENT);
    if (!levels) continue;
    if (Math.abs(levels.current - prior[prior.length - 1]!.close) > 1e-12) lookaheadViolations++;

    const recordTrigger = (side: Side, breakIdx: number, triggerIdx: number) => {
      if (candles[triggerIdx]!.time < EVAL_START || candles[triggerIdx]!.time >= EVAL_END_EXCL) return;
      countExcursionForEvalTrigger(side, active!.counted);
      const sr = side === "RESISTANCE" ? active!.resistance : active!.support;
      const triggerPrice =
        side === "RESISTANCE" ? active!.resistance + TRIGGER_P * PIP : active!.support - TRIGGER_P * PIP;
      const m = measureFromTrigger(candles, triggerIdx, side, triggerPrice, sr);
      events.push({
        id: `${side === "RESISTANCE" ? "RES" : "SUP"}|${breakIdx}|${triggerIdx}`,
        side,
        support: active!.support,
        resistance: active!.resistance,
        breakIdx,
        breakTime: candles[breakIdx]!.time,
        triggerIdx,
        triggerTime: candles[triggerIdx]!.time,
        triggerPrice,
        targetPrice:
          side === "RESISTANCE" ? triggerPrice - REVERSAL_P * PIP : triggerPrice + REVERSAL_P * PIP,
        ...m,
      });
      lastKey = `${active!.support.toFixed(5)}|${active!.resistance.toFixed(5)}`;
      active = null;
    };

    if (active && active.side) {
      if (active.side === "RESISTANCE") {
        if (bar.close < active.resistance - PIP) {
          active = null;
          continue;
        }
        const lvl = active.resistance + TRIGGER_P * PIP;
        if (bar.high >= lvl) {
          recordTrigger("RESISTANCE", active.breakIdx, i);
        }
      } else {
        if (bar.close > active.support + PIP) {
          active = null;
          continue;
        }
        const lvl = active.support - TRIGGER_P * PIP;
        if (bar.low <= lvl) {
          recordTrigger("SUPPORT", active.breakIdx, i);
        }
      }
      continue;
    }

    if (active && !active.side) {
      const up = bar.high > active.resistance;
      const dn = bar.low < active.support;
      if (!up && !dn) continue;
      if (up && dn) {
        active.side =
          bar.high - active.resistance >= active.support - bar.low ? "RESISTANCE" : "SUPPORT";
      } else {
        active.side = up ? "RESISTANCE" : "SUPPORT";
      }
      active.breakIdx = i;
      active.counted = countExcursion(active.side, bar.time);
      if (active.side === "RESISTANCE" && bar.high >= active.resistance + TRIGGER_P * PIP) {
        recordTrigger("RESISTANCE", i, i);
      } else if (active.side === "SUPPORT" && bar.low <= active.support - TRIGGER_P * PIP) {
        recordTrigger("SUPPORT", i, i);
      }
      continue;
    }

    // Idle freeze — allow freeze during warmup so state carries into eval
    const rangeP = (levels.rangeHigh - levels.rangeLow) / PIP;
    if (rangeP < MIN_RANGE_P) continue;
    const key = `${levels.rangeLow.toFixed(5)}|${levels.rangeHigh.toFixed(5)}`;
    if (key === lastKey) continue;
    if (bar.high > levels.rangeHigh || bar.low < levels.rangeLow) continue;
    if (bar.close > levels.rangeHigh || bar.close < levels.rangeLow) continue;

    active = {
      support: levels.rangeLow,
      resistance: levels.rangeHigh,
      side: null,
      breakIdx: -1,
      counted: false,
    };
    lastKey = null;
  }

  {
    const seen = new Set<string>();
    for (const e of events) {
      if (seen.has(e.id)) duplicateTriggers++;
      seen.add(e.id);
    }
  }
  const res = events.filter((e) => e.side === "RESISTANCE");
  const sup = events.filter((e) => e.side === "SUPPORT");
  const all = events;
  const ambig = all.filter((e) => e.sameBarAmbiguous);

  log("=".repeat(78));
  log("EUR/USD M15 S/R — Sep 14–18 2026 — +10p TRIGGER → FULL 10p REVERSAL");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("SMALL SAMPLE — five trading days only. Do not generalize to full history.");
  log("");
  log("INTEGRITY");
  log("-".repeat(78));
  log(`  Production S/R: computeSupportResistanceLevels`);
  log(`  File: frontend/src/lib/strategy/support-resistance.ts`);
  log(`  Source: ${source}`);
  log(`  Warmup candles (before eval start): ${evalStartIdx}`);
  log(`  First evaluation candle: ${candles[evalStartIdx]!.time}`);
  log(`  Last evaluation candle:  ${candles[n - 1]!.time}`);
  log(`  Evaluation candle count: ${evalCount}`);
  log(`  Total loaded (warmup+eval): ${n}`);
  log(`  Frozen S/R excursions (eval breaks): ${frozenExcursions}`);
  log(`  Resistance breakouts: ${resBreakouts}`);
  log(`  Support breakouts: ${supBreakouts}`);
  log(`  Resistance +10p triggers: ${res.length}`);
  log(`  Support +10p triggers: ${sup.length}`);
  log(`  Duplicate triggers: ${duplicateTriggers}`);
  log(`  Lookahead violations: ${lookaheadViolations}`);
  log(`  Same-M15-bar ambiguous (trigger+target same candle): ${ambig.length}`);
  log("");
  log("  MAIN rates below use CONFIRMED reversals (subsequent M15 bar),");
  log("  unless noted as INCLUSIVE (counts same-bar ambiguous as hit at 0m).");
  log("");

  const row = (label: string, ev: Event[]) => {
    const n0 = ev.length;
    if (!n0) {
      log(`${label.padEnd(16)} | ${String(0).padStart(3)} |  -  |  -  |  -  |  -  |  -`);
      return;
    }
    log(
      [
        label.padEnd(16),
        String(n0).padStart(3),
        `${f1(rate(ev, (e) => e.hitWithin[15]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithin[30]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithin[60]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithin[120]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithin[240]!))}%`,
      ].join(" | "),
    );
  };

  log("MAIN TABLE — CONFIRMED 10p REVERSAL (subsequent bar)");
  log("-".repeat(78));
  log("SIDE             | N   | 15m  | 30m  | 1H   | 2H   | 4H");
  row("Resistance", res);
  row("Support", sup);
  row("Combined", all);
  log("");
  log("INCLUSIVE (same-bar ambiguous counted as success at 0m)");
  log("-".repeat(78));
  log("SIDE             | N   | 15m  | 30m  | 1H   | 2H   | 4H");
  for (const [label, ev] of [
    ["Resistance", res],
    ["Support", sup],
    ["Combined", all],
  ] as const) {
    log(
      [
        label.padEnd(16),
        String(ev.length).padStart(3),
        `${f1(rate(ev, (e) => e.hitWithinInclusive[15]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithinInclusive[30]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithinInclusive[60]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithinInclusive[120]!))}%`,
        `${f1(rate(ev, (e) => e.hitWithinInclusive[240]!))}%`,
      ].join(" | "),
    );
  }
  log("");

  log("FIRST-HIT (confirmed path; AMBIG excluded from REV/CONT %)");
  log("-".repeat(78));
  log("SIDE | N | ambig | rev before +5c | +10c | +15c | +20c | +30c");
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
    ["COMBINED", all],
  ] as const) {
    const clear = ev.filter((e) => !e.sameBarAmbiguous);
    log(
      [
        label.padEnd(11),
        String(ev.length),
        String(ev.filter((e) => e.sameBarAmbiguous).length),
        ...CONT_THRESHOLDS.map((t) =>
          clear.length ? f1(rate(clear, (e) => e.firstHitCont[t] === "REV")) : "-",
        ),
      ].join(" | "),
    );
  }
  log("");

  log("ADVERSE CONTINUATION BEYOND TRIGGER");
  log("-".repeat(78));
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
    ["COMBINED", all],
  ] as const) {
    const a = ev.map((e) => e.adverseBeyondTriggerPips);
    log(
      `  ${label}: med=${f1(median(a))} P25=${f1(quantile(a, 0.25))} P75=${f1(quantile(a, 0.75))} P90=${f1(quantile(a, 0.9))} P95=${f1(quantile(a, 0.95))} max=${f1(Math.max(...a, 0))} (N=${ev.length})`,
    );
  }
  log("  Buckets (COMBINED, confirmed ≤windows):");
  log("  FARTHER | N | ≤30m | ≤1H | ≤2H | ≤4H");
  for (const b of ["0–2", "2–5", "5–7.5", "7.5–10", "10–15", "15–20", "20+"]) {
    const sub = all.filter((e) => adverseBucket(e.adverseBeyondTriggerPips) === b);
    log(
      [
        b.padEnd(7),
        String(sub.length).padStart(3),
        f1(rate(sub, (e) => e.hitWithin[30]!)),
        f1(rate(sub, (e) => e.hitWithin[60]!)),
        f1(rate(sub, (e) => e.hitWithin[120]!)),
        f1(rate(sub, (e) => e.hitWithin[240]!)),
      ].join(" | "),
    );
  }
  log("");

  log("TIME TO SUCCESS (confirmed only)");
  log("-".repeat(78));
  for (const [label, ev] of [
    ["RESISTANCE", res],
    ["SUPPORT", sup],
    ["COMBINED", all],
  ] as const) {
    const st = ev.filter((e) => e.hitConfirmed).map((e) => e.minutesToReverse);
    log(
      `  ${label}: N_success=${st.length}/${ev.length} avg=${f1(mean(st))} med=${f1(median(st))} P25=${f1(quantile(st, 0.25))} P75=${f1(quantile(st, 0.75))} P90=${f1(quantile(st, 0.9))}`,
    );
  }
  log("");

  log("RESULTS BY DAY (confirmed)");
  log("-".repeat(78));
  log("DAY | Nres | Nsup | N | ≤30m | ≤1H | ≤2H | ≤4H | rev before +10c");
  const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
  let mostTriggersDay = days[0]!;
  let mostTriggersN = -1;
  let bestRateDay = days[0]!;
  let bestRate = -1;
  let bestRateN = 0;
  for (const d of days) {
    const ev = all.filter((e) => dayKey(e.triggerTime) === d);
    const clear = ev.filter((e) => !e.sameBarAmbiguous);
    const r4 = rate(ev, (e) => e.hitWithin[240]!);
    if (ev.length > mostTriggersN) {
      mostTriggersN = ev.length;
      mostTriggersDay = d;
    }
    if (ev.length >= 1 && (r4 > bestRate || (r4 === bestRate && ev.length > bestRateN))) {
      bestRate = r4;
      bestRateDay = d;
      bestRateN = ev.length;
    }
    log(
      [
        d.slice(5),
        ev.filter((e) => e.side === "RESISTANCE").length,
        ev.filter((e) => e.side === "SUPPORT").length,
        ev.length,
        f1(rate(ev, (e) => e.hitWithin[30]!)),
        f1(rate(ev, (e) => e.hitWithin[60]!)),
        f1(rate(ev, (e) => e.hitWithin[120]!)),
        f1(rate(ev, (e) => e.hitWithin[240]!)),
        clear.length ? f1(rate(clear, (e) => e.firstHitCont[10] === "REV")) : "-",
      ].join(" | "),
    );
  }
  log("");

  log("EVERY +10p TRIGGER EVENT");
  log("-".repeat(78));
  if (!all.length) {
    log("  (none)");
  } else {
    for (const e of all) {
      log(
        `  ${e.triggerTime} ${e.side} S=${f5(e.support)} R=${f5(e.resistance)} trig=${f5(e.triggerPrice)} tgt=${f5(e.targetPrice)} ambig=${e.sameBarAmbiguous ? "Y" : "N"} hitConf=${e.hitConfirmed ? "Y" : "N"} min=${f1(e.minutesToReverse)} adv=${f1(e.adverseBeyondTriggerPips)} fav=${f1(e.maxFavorablePips)} rev<+5c=${e.firstHitCont[5]} <+10c=${e.firstHitCont[10]} <+15c=${e.firstHitCont[15]} <+20c=${e.firstHitCont[20]} <+30c=${e.firstHitCont[30]}`,
      );
    }
  }
  log("");

  log("DESCRIPTIVE COMPARE vs FULL-HISTORY M5 (NOT a superiority claim)");
  log("-".repeat(78));
  log(`  M5 full-history RES/SUP 4H: ${M5_HIST.res4h}% / ${M5_HIST.sup4h}%`);
  log(
    `  M15 Sep14–18 RES/SUP 4H confirmed: ${f1(rate(res, (e) => e.hitWithin[240]!))}% (N=${res.length}) / ${f1(rate(sup, (e) => e.hitWithin[240]!))}% (N=${sup.length})`,
  );
  log(`  M5 full-history rev-before-+10c: RES ${M5_HIST.resBefore10c}% / SUP ${M5_HIST.supBefore10c}%`);
  {
    const rc = res.filter((e) => !e.sameBarAmbiguous);
    const sc = sup.filter((e) => !e.sameBarAmbiguous);
    log(
      `  M15 Sep14–18 rev-before-+10c: RES ${f1(rate(rc, (e) => e.firstHitCont[10] === "REV"))}% (Nclear=${rc.length}) / SUP ${f1(rate(sc, (e) => e.firstHitCont[10] === "REV"))}% (Nclear=${sc.length})`,
    );
  }
  log("  Five-day M15 sample is too small to conclude M15 is better or worse than M5.");
  log("");

  const c30 = rate(all, (e) => e.hitWithin[30]!);
  const c60 = rate(all, (e) => e.hitWithin[60]!);
  const c120 = rate(all, (e) => e.hitWithin[120]!);
  const c240 = rate(all, (e) => e.hitWithin[240]!);
  const clearAll = all.filter((e) => !e.sameBarAmbiguous);
  const before10 = rate(clearAll, (e) => e.firstHitCont[10] === "REV");
  const advMed = median(all.map((e) => e.adverseBeyondTriggerPips));

  log("FINAL ANSWERS");
  log("-".repeat(78));
  log(`1. M15 +10p triggers last week: ${all.length}${all.length < 20 ? " (VERY SMALL N)" : ""}`);
  log(`2. Resistance ${res.length} / Support ${sup.length}`);
  log(`3. Confirmed 10p reverse ≤30m/1H/2H/4H: ${f1(c30)}% / ${f1(c60)}% / ${f1(c120)}% / ${f1(c240)}% (N=${all.length})`);
  log(`4. Reverse 10p before another +10c (clear events): ${f1(before10)}% (Nclear=${clearAll.length}; ambig=${ambig.length})`);
  log(`5. Median adverse continuation after trigger: ${f1(advMed)}p`);
  log(
    `6. RES vs SUP different? 4H conf ${f1(rate(res, (e) => e.hitWithin[240]!))}% (N=${res.length}) vs ${f1(rate(sup, (e) => e.hitWithin[240]!))}% (N=${sup.length}) — N too small to claim a structural difference.`,
  );
  log(`7. Most triggers: ${mostTriggersDay.slice(5)} (N=${mostTriggersN})`);
  log(`8. Highest observed 4H confirmed rate: ${bestRateDay.slice(5)} = ${f1(bestRate)}% (N=${bestRateN})`);
  log(`9. All events listed above and in CSV.`);
  log(`10. vs M5 full-history: M15 week 4H combined ${f1(c240)}% (N=${all.length}) vs M5 ~75.7–75.8%; week rev-before-10c ${f1(before10)}% vs M5 ~56–60%. Descriptive only — not a ranking.`);
  log("=".repeat(78));

  const headers = [
    "timestamp",
    "side",
    "support",
    "resistance",
    "triggerPrice",
    "targetPrice",
    "sameBarAmbiguous",
    "hitConfirmed",
    "minutesToReverse",
    "maxAdverseContinuation",
    "maxFavorableMovement",
    "revBefore5c",
    "revBefore10c",
    "revBefore15c",
    "revBefore20c",
    "revBefore30c",
  ];
  const lines = [headers.join(",")];
  for (const e of all) {
    lines.push(
      [
        e.triggerTime,
        e.side,
        f5(e.support),
        f5(e.resistance),
        f5(e.triggerPrice),
        f5(e.targetPrice),
        e.sameBarAmbiguous ? 1 : 0,
        e.hitConfirmed ? 1 : 0,
        Number.isFinite(e.minutesToReverse) ? f1(e.minutesToReverse) : "",
        f2(e.adverseBeyondTriggerPips),
        f2(e.maxFavorablePips),
        e.firstHitCont[5],
        e.firstHitCont[10],
        e.firstHitCont[15],
        e.firstHitCont[20],
        e.firstHitCont[30],
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
