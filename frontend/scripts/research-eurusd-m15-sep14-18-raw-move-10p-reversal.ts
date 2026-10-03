/**
 * EUR/USD M15 RAW MOVE → 10p REVERSAL (NO S/R)
 * Sep 14–18 2026 only. Real-time anchors. Separate threshold experiments.
 * No pivots, no future confirmation, no production changes.
 */
import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../src/types/forex";

const PIP = 0.0001;
const BAR_MIN = 15;
const HORIZON_BARS = (4 * 60) / BAR_MIN; // 16
const REVERSAL_P = 10;
const INITIAL_MOVES = [10, 15, 20, 25, 30] as const;
const TIME_WINDOWS = [15, 30, 60, 120, 240] as const;
const CONT_THRESHOLDS = [5, 10, 15, 20, 30] as const;
const EVAL_START = "2026-09-14T00:00:00.000000000Z";
const EVAL_END_EXCL = "2026-09-19T00:00:00.000000000Z";

const OUT_DIR = path.resolve(__dirname, "../research-output");
const OUT_REPORT = path.join(OUT_DIR, "eurusd-m15-sep14-18-raw-move-10p-reversal.txt");
const OUT_CSV = path.join(OUT_DIR, "eurusd-m15-sep14-18-raw-move-10p-reversal-events.csv");
const M15_FULL = path.join(OUT_DIR, "cache", "eurusd-m15-mid-for-outer-10pip.json");
const M15_WINDOW =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m15-sep10-19-window.json";

type Dir = "UP" | "DOWN";
type HitMark = "REV" | "CONT" | "NONE" | "AMBIG";

type Event = {
  initialMovePips: number;
  anchorTime: string;
  anchorPrice: number;
  anchorIdx: number;
  triggerTime: string;
  triggerPrice: number;
  triggerIdx: number;
  direction: Dir;
  reversalTarget: number;
  ambiguous: boolean;
  reversalHitConfirmed: boolean;
  minutesTo10pReversal: number; // confirmed; 0 if ambiguous only
  maxAdverseContinuationPips: number;
  maxFavorablePips: number;
  firstHitCont: Record<number, HitMark>;
  hitWithin: Record<number, boolean>;
  hitWithinInclusive: Record<number, boolean>;
  timedOut: boolean;
};

type ControlProbe = {
  originTime: string;
  originIdx: number;
  originPrice: number;
  /** 10p UP from origin within window (confirmed subsequent-bar) */
  upWithin: Record<number, boolean>;
  downWithin: Record<number, boolean>;
  upInclusive: Record<number, boolean>;
  downInclusive: Record<number, boolean>;
  upAmbig: boolean;
  downAmbig: boolean;
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

function loadM15(): { candles: Candle[]; evalStartIdx: number; source: string } {
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
  const warmFrom = "2026-08-01T00:00:00.000000000Z";
  const candles = all.filter((c) => c.time >= warmFrom);
  const evalStartIdx = candles.findIndex((c) => c.time >= EVAL_START);
  if (evalStartIdx < 1) throw new Error("Need at least one pre-eval candle for anchor");
  return {
    candles,
    evalStartIdx,
    source: "OANDA M15 MID (full cache + sep10-19 window merge)",
  };
}

function adverseBucket(p: number): string {
  if (p < 2) return "0–2";
  if (p < 5) return "2–5";
  if (p < 7.5) return "5–7.5";
  if (p < 10) return "7.5–10";
  if (p < 15) return "10–15";
  if (p < 20) return "15–20";
  if (p < 30) return "20–30";
  return "30+";
}

function measureAfterTrigger(
  candles: Candle[],
  triggerIdx: number,
  direction: Dir,
  triggerPrice: number,
): Pick<
  Event,
  | "ambiguous"
  | "reversalHitConfirmed"
  | "minutesTo10pReversal"
  | "maxAdverseContinuationPips"
  | "maxFavorablePips"
  | "firstHitCont"
  | "hitWithin"
  | "hitWithinInclusive"
  | "timedOut"
> {
  const end = Math.min(candles.length - 1, triggerIdx + HORIZON_BARS);
  const trig = candles[triggerIdx]!;
  const revTarget =
    direction === "UP" ? triggerPrice - REVERSAL_P * PIP : triggerPrice + REVERSAL_P * PIP;

  const ambiguous =
    direction === "UP"
      ? trig.high >= triggerPrice && trig.low <= revTarget
      : trig.low <= triggerPrice && trig.high >= revTarget;

  let adv = 0;
  let fav = 0;
  for (let j = triggerIdx; j <= end; j++) {
    const bar = candles[j]!;
    if (direction === "UP") {
      adv = Math.max(adv, (bar.high - triggerPrice) / PIP);
      fav = Math.max(fav, (triggerPrice - bar.low) / PIP);
    } else {
      adv = Math.max(adv, (triggerPrice - bar.low) / PIP);
      fav = Math.max(fav, (bar.high - triggerPrice) / PIP);
    }
  }

  let hitConfirmed = false;
  let minutesConfirmed = NaN;
  for (let j = triggerIdx + 1; j <= end; j++) {
    const bar = candles[j]!;
    const ok =
      direction === "UP" ? bar.low <= revTarget : bar.high >= revTarget;
    if (ok) {
      hitConfirmed = true;
      minutesConfirmed = (j - triggerIdx) * BAR_MIN;
      break;
    }
  }

  const firstHitCont: Record<number, HitMark> = {};
  for (const t of CONT_THRESHOLDS) firstHitCont[t] = ambiguous ? "AMBIG" : "NONE";

  if (!ambiguous) {
    let runAdv = 0;
    for (let j = triggerIdx; j <= end; j++) {
      const bar = candles[j]!;
      const contExt =
        direction === "UP" ? (bar.high - triggerPrice) / PIP : (triggerPrice - bar.low) / PIP;
      runAdv = Math.max(runAdv, contExt);
      for (const t of CONT_THRESHOLDS) {
        if (firstHitCont[t] !== "NONE") continue;
        if (runAdv >= t) firstHitCont[t] = "CONT";
      }
      if (j === triggerIdx) continue;
      const revOk = direction === "UP" ? bar.low <= revTarget : bar.high >= revTarget;
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
    hitWithinInclusive[w] = hitWithin[w]! || ambiguous;
  }

  const timedOut = !hitConfirmed && !ambiguous && end - triggerIdx >= HORIZON_BARS;

  return {
    ambiguous,
    reversalHitConfirmed: hitConfirmed,
    minutesTo10pReversal: hitConfirmed ? minutesConfirmed : ambiguous ? 0 : NaN,
    maxAdverseContinuationPips: adv,
    maxFavorablePips: fav,
    firstHitCont,
    hitWithin,
    hitWithinInclusive,
    timedOut,
  };
}

/**
 * Resolve when reverse is confirmed on a subsequent bar, or after HORIZON_BARS,
 * or immediately if same-bar ambiguous (event ends; we still flag AMBIG).
 * Returns the bar index that is "most recently completed" for the new anchor
 * (= resolve bar).
 */
function resolveEndIdx(
  candles: Candle[],
  triggerIdx: number,
  direction: Dir,
  triggerPrice: number,
  ambiguous: boolean,
  hitConfirmed: boolean,
  minutesTo10pReversal: number,
): number {
  const hardEnd = Math.min(candles.length - 1, triggerIdx + HORIZON_BARS);
  if (ambiguous) return triggerIdx;
  if (hitConfirmed && Number.isFinite(minutesTo10pReversal)) {
    return Math.min(hardEnd, triggerIdx + Math.round(minutesTo10pReversal / BAR_MIN));
  }
  return hardEnd;
}

function runThreshold(
  candles: Candle[],
  evalStartIdx: number,
  initialMovePips: number,
): { events: Event[]; anchors: number; lookaheadViolations: number; duplicates: number } {
  const events: Event[] = [];
  let anchors = 0;
  let lookaheadViolations = 0;
  let duplicates = 0;
  const seenTrig = new Set<string>();

  // Phase: waiting for ±initialMove from frozen anchor, or resolving after trigger.
  type Phase =
    | { kind: "watch"; anchorIdx: number; anchorPrice: number; anchorTime: string }
    | {
        kind: "resolve";
        event: Event;
        endIdx: number;
      };

  // First anchor = close of candle just before first eval bar
  let phase: Phase = {
    kind: "watch",
    anchorIdx: evalStartIdx - 1,
    anchorPrice: candles[evalStartIdx - 1]!.close,
    anchorTime: candles[evalStartIdx - 1]!.time,
  };
  anchors++;

  for (let i = evalStartIdx; i < candles.length; i++) {
    const bar = candles[i]!;
    if (bar.time >= EVAL_END_EXCL) break;

    if (phase.kind === "resolve") {
      if (i < phase.endIdx) continue;
      // Reset: most recently completed close = bar at endIdx
      const aIdx = phase.endIdx;
      phase = {
        kind: "watch",
        anchorIdx: aIdx,
        anchorPrice: candles[aIdx]!.close,
        anchorTime: candles[aIdx]!.time,
      };
      anchors++;
      // Fall through to watch on this same bar i if i > aIdx; if i == aIdx we're on the
      // resolve bar itself — monitoring starts on the NEXT bar after anchor.
      if (i <= aIdx) continue;
    }

    if (phase.kind !== "watch") continue;

    const { anchorPrice, anchorTime, anchorIdx } = phase;
    // Integrity: anchor must be a prior completed close (no lookahead)
    if (anchorIdx >= i) lookaheadViolations++;

    const upLvl = anchorPrice + initialMovePips * PIP;
    const dnLvl = anchorPrice - initialMovePips * PIP;
    const hitUp = bar.high >= upLvl;
    const hitDn = bar.low <= dnLvl;

    if (!hitUp && !hitDn) continue;

    let direction: Dir;
    let triggerPrice: number;
    if (hitUp && hitDn) {
      // Same bar both sides: ambiguous direction — pick farther extreme (real-time max excursion)
      const upExt = bar.high - anchorPrice;
      const dnExt = anchorPrice - bar.low;
      if (upExt >= dnExt) {
        direction = "UP";
        triggerPrice = upLvl;
      } else {
        direction = "DOWN";
        triggerPrice = dnLvl;
      }
    } else if (hitUp) {
      direction = "UP";
      triggerPrice = upLvl;
    } else {
      direction = "DOWN";
      triggerPrice = dnLvl;
    }

    const m = measureAfterTrigger(candles, i, direction, triggerPrice);
    const reversalTarget =
      direction === "UP" ? triggerPrice - REVERSAL_P * PIP : triggerPrice + REVERSAL_P * PIP;

    const ev: Event = {
      initialMovePips,
      anchorTime,
      anchorPrice,
      anchorIdx,
      triggerTime: bar.time,
      triggerPrice,
      triggerIdx: i,
      direction,
      reversalTarget,
      ...m,
    };

    const key = `${initialMovePips}|${i}|${direction}`;
    if (seenTrig.has(key)) duplicates++;
    seenTrig.add(key);
    events.push(ev);

    const endIdx = resolveEndIdx(
      candles,
      i,
      direction,
      triggerPrice,
      m.ambiguous,
      m.reversalHitConfirmed,
      m.minutesTo10pReversal,
    );
    phase = { kind: "resolve", event: ev, endIdx };
  }

  return { events, anchors, lookaheadViolations, duplicates };
}

/**
 * CONTROL — unconditional 10p move from completed closes.
 *
 * Construction (does NOT mechanically favor control):
 * - Every completed M15 candle in the evaluation window is an origin.
 * - originPrice = that candle's close (known at close; measurement starts next bar).
 * - Measure whether price subsequently reaches origin+10p (UP) and origin-10p (DOWN)
 *   within the same windows / ambiguity rules as treatment reversals.
 * - NO preceding 10/15/20/25/30p directional filter.
 * - Same-bar: origin bar itself is NOT used for the move (measurement from next bar),
 *   matching treatment's "confirmed = subsequent bar" spirit for the primary rates.
 *   We also report inclusive rates if the bar AFTER origin is ambiguous.
 *
 * This answers: baseline P(10p move in a direction within T) without requiring
 * a prior impulse — so we can see whether post-impulse 10p reverses differ.
 */
function runControl(candles: Candle[], evalStartIdx: number): ControlProbe[] {
  const probes: ControlProbe[] = [];
  for (let i = evalStartIdx; i < candles.length - 1; i++) {
    const origin = candles[i]!;
    if (origin.time < EVAL_START || origin.time >= EVAL_END_EXCL) continue;
    // First measurement bar = i+1
    const start = i + 1;
    if (start >= candles.length) break;
    if (candles[start]!.time >= EVAL_END_EXCL) break;

    const price = origin.close;
    const upT = price + REVERSAL_P * PIP;
    const dnT = price - REVERSAL_P * PIP;
    const end = Math.min(candles.length - 1, start + HORIZON_BARS - 1);

    const first = candles[start]!;
    const upAmbig = first.high >= upT && first.low <= price; // not used for reverse; keep false typically
    const downAmbig = first.low <= dnT && first.high >= price;
    // For control "10p move", same-bar on first measure bar: if first bar alone reaches ±10,
    // minutes=0 is unambiguous for a one-sided move (only one threshold). Mark ambig only if
    // both +10 and -10 on same first bar.
    const bothOnFirst = first.high >= upT && first.low <= dnT;

    let upMin = NaN;
    let dnMin = NaN;
    for (let j = start; j <= end; j++) {
      const bar = candles[j]!;
      const mins = (j - start) * BAR_MIN;
      if (!Number.isFinite(upMin) && bar.high >= upT) upMin = mins;
      if (!Number.isFinite(dnMin) && bar.low <= dnT) dnMin = mins;
      if (Number.isFinite(upMin) && Number.isFinite(dnMin)) break;
    }

    const upWithin: Record<number, boolean> = {};
    const downWithin: Record<number, boolean> = {};
    const upInclusive: Record<number, boolean> = {};
    const downInclusive: Record<number, boolean> = {};
    for (const w of TIME_WINDOWS) {
      // Strict: if both sides on first bar, exclude from strict directional claim for that side
      // when both hit on same bar (ordering unknown) — treat as inclusive-only.
      const upStrict = Number.isFinite(upMin) && upMin <= w && !(bothOnFirst && upMin === 0);
      const dnStrict = Number.isFinite(dnMin) && dnMin <= w && !(bothOnFirst && dnMin === 0);
      upWithin[w] = upStrict;
      downWithin[w] = dnStrict;
      upInclusive[w] = Number.isFinite(upMin) && upMin <= w;
      downInclusive[w] = Number.isFinite(dnMin) && dnMin <= w;
    }

    probes.push({
      originTime: origin.time,
      originIdx: i,
      originPrice: price,
      upWithin,
      downWithin,
      upInclusive,
      downInclusive,
      upAmbig: bothOnFirst,
      downAmbig: bothOnFirst,
    });
    void upAmbig;
    void downAmbig;
  }
  return probes;
}

function rate(ev: Event[], pred: (e: Event) => boolean): number {
  return pct(ev.filter(pred).length, ev.length);
}

function main(): void {
  const { candles, evalStartIdx, source } = loadM15();
  const evalCandles = candles.filter((c) => c.time >= EVAL_START && c.time < EVAL_END_EXCL);
  const allEvents: Event[] = [];
  const byMove = new Map<number, Event[]>();
  const meta = new Map<
    number,
    { anchors: number; lookahead: number; duplicates: number; timeouts: number }
  >();

  process.stderr.write(`M15 n=${candles.length} evalStartIdx=${evalStartIdx}...\n`);

  for (const move of INITIAL_MOVES) {
    const { events, anchors, lookaheadViolations, duplicates } = runThreshold(
      candles,
      evalStartIdx,
      move,
    );
    byMove.set(move, events);
    allEvents.push(...events);
    meta.set(move, {
      anchors,
      lookahead: lookaheadViolations,
      duplicates,
      timeouts: events.filter((e) => e.timedOut).length,
    });
  }

  const control = runControl(candles, evalStartIdx);
  const totalLookahead = [...meta.values()].reduce((s, m) => s + m.lookahead, 0);

  log("=".repeat(78));
  log("EUR/USD M15 RAW MOVE → 10p REVERSAL (NO S/R) — Sep 14–18 2026");
  log("=".repeat(78));
  log(`Generated: ${new Date().toISOString()}`);
  log("SMALL SAMPLE — five trading days. Do not generalize.");
  log("No S/R. No pivots. Real-time anchors only.");
  log("");
  log("INTEGRITY");
  log("-".repeat(78));
  log(`  Source: ${source}`);
  log(`  First eval candle: ${evalCandles[0]?.time}`);
  log(`  Last eval candle:  ${evalCandles[evalCandles.length - 1]?.time}`);
  log(`  Evaluation candles: ${evalCandles.length}`);
  log(`  Warmup before eval: ${evalStartIdx}`);
  log(`  Lookahead violations (all thresholds): ${totalLookahead}`);
  log("");

  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    const m = meta.get(move)!;
    const up = ev.filter((e) => e.direction === "UP");
    const dn = ev.filter((e) => e.direction === "DOWN");
    log(`  [${move}p experiment]`);
    log(`    anchors=${m.anchors} triggers=${ev.length} UP=${up.length} DOWN=${dn.length}`);
    log(
      `    confirmed 10p rev=${ev.filter((e) => e.reversalHitConfirmed).length} ambiguous=${ev.filter((e) => e.ambiguous).length} timeouts=${m.timeouts} duplicates=${m.duplicates} lookahead=${m.lookahead}`,
    );
  }
  log("");

  const printMain = (label: string, filter?: (e: Event) => boolean) => {
    log(label);
    log("-".repeat(78));
    log("INITIAL MOVE | N   | 15m  | 30m  | 1H   | 2H   | 4H");
    for (const move of INITIAL_MOVES) {
      let ev = byMove.get(move)!;
      if (filter) ev = ev.filter(filter);
      log(
        [
          `${move}p`.padEnd(12),
          String(ev.length).padStart(3),
          `${f1(rate(ev, (e) => e.hitWithin[15]!))}%`,
          `${f1(rate(ev, (e) => e.hitWithin[30]!))}%`,
          `${f1(rate(ev, (e) => e.hitWithin[60]!))}%`,
          `${f1(rate(ev, (e) => e.hitWithin[120]!))}%`,
          `${f1(rate(ev, (e) => e.hitWithin[240]!))}%`,
        ].join(" | "),
      );
    }
    log("");
  };

  printMain("MAIN TABLE — CONFIRMED 10p REVERSAL FROM TRIGGER (COMBINED)");
  printMain("MAIN TABLE — UP move → DOWN 10p reversal (confirmed)", (e) => e.direction === "UP");
  printMain("MAIN TABLE — DOWN move → UP 10p reversal (confirmed)", (e) => e.direction === "DOWN");

  log("INCLUSIVE (same-bar ambiguous counted as success at 0m) — COMBINED");
  log("-".repeat(78));
  log("INITIAL MOVE | N   | 15m  | 30m  | 1H   | 2H   | 4H");
  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    log(
      [
        `${move}p`.padEnd(12),
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

  log("FIRST-HIT — 10p REV before continuation (AMBIG excluded from %)");
  log("-".repeat(78));
  for (const [dirLabel, filter] of [
    ["UP", (e: Event) => e.direction === "UP"],
    ["DOWN", (e: Event) => e.direction === "DOWN"],
    ["COMBINED", (_e: Event) => true],
  ] as const) {
    log(`  ${dirLabel}`);
    log("  INITIAL | N | ambig | rev before +5c | +10c | +15c | +20c | +30c");
    for (const move of INITIAL_MOVES) {
      const ev = byMove.get(move)!.filter(filter);
      const clear = ev.filter((e) => !e.ambiguous);
      const ambigN = ev.filter((e) => e.ambiguous).length;
      log(
        [
          `  ${move}p`.padEnd(10),
          String(ev.length),
          String(ambigN),
          ...CONT_THRESHOLDS.map((t) =>
            clear.length ? f1(rate(clear, (e) => e.firstHitCont[t] === "REV")) : "-",
          ),
        ].join(" | "),
      );
    }
  }
  log("");

  log("ADVERSE CONTINUATION BEYOND TRIGGER (before / without confirmed 10p rev)");
  log("-".repeat(78));
  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    const a = ev.map((e) => e.maxAdverseContinuationPips);
    log(
      `  ${move}p: med=${f1(median(a))} P25=${f1(quantile(a, 0.25))} P75=${f1(quantile(a, 0.75))} P90=${f1(quantile(a, 0.9))} P95=${f1(quantile(a, 0.95))} max=${f1(a.length ? Math.max(...a) : NaN)} (N=${ev.length})`,
    );
  }
  log("  Buckets by initial move (confirmed ≤windows %):");
  for (const move of INITIAL_MOVES) {
    log(`  -- ${move}p --`);
    log("  FARTHER | N | ≤30m | ≤1H | ≤2H | ≤4H");
    for (const b of ["0–2", "2–5", "5–7.5", "7.5–10", "10–15", "15–20", "20–30", "30+"]) {
      const sub = byMove.get(move)!.filter((e) => adverseBucket(e.maxAdverseContinuationPips) === b);
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
  }
  log("");

  log("CONTROL — unconditional 10p move from every eval M15 close");
  log("-".repeat(78));
  log("  Method: each completed eval M15 close = origin. From NEXT bar, measure");
  log("  whether origin±10p is reached within windows. No prior impulse required.");
  log("  Strict rates exclude first-measure-bar both-sides ambiguity.");
  log(`  Control origins N=${control.length}`);
  log("  DIR | ≤15m | ≤30m | ≤1H | ≤2H | ≤4H");
  for (const [lab, key] of [
    ["UP +10p", "upWithin"],
    ["DOWN -10p", "downWithin"],
  ] as const) {
    log(
      [
        lab.padEnd(10),
        ...TIME_WINDOWS.map((w) =>
          f1(pct(control.filter((c) => c[key][w]).length, control.length)),
        ),
      ].join(" | "),
    );
  }
  log("  (inclusive, both-sides-on-first-bar counted):");
  for (const [lab, key] of [
    ["UP +10p", "upInclusive"],
    ["DOWN -10p", "downInclusive"],
  ] as const) {
    log(
      [
        lab.padEnd(10),
        ...TIME_WINDOWS.map((w) =>
          f1(pct(control.filter((c) => c[key][w]).length, control.length)),
        ),
      ].join(" | "),
    );
  }
  log("");

  // Compare treatment 4H reverse vs control opposite-direction 4H
  log("TREATMENT vs CONTROL (4H confirmed)");
  log("-".repeat(78));
  const ctrlUp4 = pct(control.filter((c) => c.upWithin[240]).length, control.length);
  const ctrlDn4 = pct(control.filter((c) => c.downWithin[240]).length, control.length);
  log(`  Control UP +10p ≤4H: ${f1(ctrlUp4)}% (N=${control.length})`);
  log(`  Control DOWN -10p ≤4H: ${f1(ctrlDn4)}% (N=${control.length})`);
  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    const up = ev.filter((e) => e.direction === "UP");
    const dn = ev.filter((e) => e.direction === "DOWN");
    log(
      `  After ${move}p UP→rev10: ${f1(rate(up, (e) => e.hitWithin[240]!))}% (N=${up.length}) vs control DOWN ${f1(ctrlDn4)}%`,
    );
    log(
      `  After ${move}p DOWN→rev10: ${f1(rate(dn, (e) => e.hitWithin[240]!))}% (N=${dn.length}) vs control UP ${f1(ctrlUp4)}%`,
    );
  }
  log("");

  // Final answers prep
  let bestMove = INITIAL_MOVES[0];
  let bestRate = -1;
  let bestN = 0;
  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    const r = rate(ev, (e) => e.hitWithin[240]!);
    if (r > bestRate || (r === bestRate && ev.length > bestN)) {
      bestRate = r;
      bestMove = move;
      bestN = ev.length;
    }
  }

  const ambigTotal = allEvents.filter((e) => e.ambiguous).length;

  log("FINAL ANSWERS");
  log("-".repeat(78));
  for (const move of INITIAL_MOVES) {
    const ev = byMove.get(move)!;
    const q = move === 10 ? "1" : "2";
    log(
      `${q}. After ${move}p move, confirmed 10p rev ≤15m/30m/1H/2H/4H: ${f1(rate(ev, (e) => e.hitWithin[15]!))}% / ${f1(rate(ev, (e) => e.hitWithin[30]!))}% / ${f1(rate(ev, (e) => e.hitWithin[60]!))}% / ${f1(rate(ev, (e) => e.hitWithin[120]!))}% / ${f1(rate(ev, (e) => e.hitWithin[240]!))}% (N=${ev.length})`,
    );
  }
  log(`3. Highest observed 4H confirmed 10p-rev rate: ${bestMove}p = ${f1(bestRate)}% (N=${bestN})`);
  log("4. Rev before another +10c continuation (clear only):");
  for (const move of INITIAL_MOVES) {
    const clear = byMove.get(move)!.filter((e) => !e.ambiguous);
    log(
      `   ${move}p: ${f1(rate(clear, (e) => e.firstHitCont[10] === "REV"))}% (Nclear=${clear.length})`,
    );
  }
  log("5. Median adverse continuation:");
  for (const move of INITIAL_MOVES) {
    const a = byMove.get(move)!.map((e) => e.maxAdverseContinuationPips);
    log(`   ${move}p: ${f1(median(a))}p (N=${a.length})`);
  }
  {
    const ups = allEvents.filter((e) => e.direction === "UP");
    const dns = allEvents.filter((e) => e.direction === "DOWN");
    log(
      `6. UP→DOWN vs DOWN→UP (all thresholds pooled, 4H conf): ${f1(rate(ups, (e) => e.hitWithin[240]!))}% (N=${ups.length}) vs ${f1(rate(dns, (e) => e.hitWithin[240]!))}% (N=${dns.length}) — week sample only.`,
    );
  }
  log(`7. Same-M15-bar ambiguous cases (all thresholds pooled): ${ambigTotal}`);
  {
    const r10 = rate(byMove.get(10)!, (e) => e.hitWithin[240]!);
    const r30 = rate(byMove.get(30)!, (e) => e.hitWithin[240]!);
    log(
      `8. Larger initial move change 4H rev? 10p→${f1(r10)}% (N=${byMove.get(10)!.length}) vs 30p→${f1(r30)}% (N=${byMove.get(30)!.length}). Descriptive only.`,
    );
  }
  log(
    `9. Control 4H unconditional ±10p: UP ${f1(ctrlUp4)}% / DOWN ${f1(ctrlDn4)}% (N=${control.length}). Treatment post-impulse 4H rev rates are listed above — compare side-by-side; do not over-claim with N this small.`,
  );
  log(
    `10. At the real-time moment a 10–30p directional move completes: see tables. This week, confirmed full 10p reverses within 4H were uncommon on strict subsequent-bar rules; same-bar AMBIG and inclusive rates are higher. Adverse continuation medians and first-hit CONT vs REV show whether price more often extended first. N is very small — observation of last week only, not a strategy.`,
  );
  log("=".repeat(78));

  const headers = [
    "initialMovePips",
    "anchorTime",
    "anchorPrice",
    "triggerTime",
    "triggerPrice",
    "direction",
    "reversalTarget",
    "ambiguous",
    "reversalHit",
    "minutesTo10pReversal",
    "maxAdverseContinuationPips",
    "maxFavorablePips",
    "revBefore5Continuation",
    "revBefore10Continuation",
    "revBefore15Continuation",
    "revBefore20Continuation",
    "revBefore30Continuation",
  ];
  const lines = [headers.join(",")];
  const sorted = [...allEvents].sort((a, b) =>
    a.initialMovePips !== b.initialMovePips
      ? a.initialMovePips - b.initialMovePips
      : a.triggerTime < b.triggerTime
        ? -1
        : 1,
  );
  for (const e of sorted) {
    lines.push(
      [
        e.initialMovePips,
        e.anchorTime,
        f5(e.anchorPrice),
        e.triggerTime,
        f5(e.triggerPrice),
        e.direction,
        f5(e.reversalTarget),
        e.ambiguous ? 1 : 0,
        e.reversalHitConfirmed ? 1 : 0,
        Number.isFinite(e.minutesTo10pReversal) ? f1(e.minutesTo10pReversal) : "",
        f2(e.maxAdverseContinuationPips),
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
