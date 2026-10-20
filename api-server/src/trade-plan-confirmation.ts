import { checkQuote } from "../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { precisionFor } from "../../frontend/src/lib/instruments/catalog.js";
import type { NewsItem } from "../../frontend/src/lib/strategy/analyze-v2/risk.js";
import type { Candle } from "../../frontend/src/types/forex.js";
import type { TradePlanDirection, TradePlanSetupType } from "./trade-plans.js";

/**
 * Confirmation engine: judges one approved plan against the completed
 * candles formed since it was created.
 *
 * Stateless by design. Each evaluation replays every closed candle (of the
 * timeframes the plan names: H4/H1 for swing plans, H1/M15 for older ones)
 * from the plan's creation to now, so a restarted worker reaches exactly the
 * same answer without stored progress, and repeating an evaluation is
 * harmless. Only candles that are complete AND whose close time has passed
 * are read, so an in-progress candle can never confirm anything.
 *
 * SELL plans are judged by negating every price and running the BUY rules:
 * the two directions are mirror images by construction.
 *
 * Outcomes:
 *   WAITING      not confirmed yet (each condition says why, and how much of its window is left)
 *   CONFIRMED    every technical condition passed — final: a confirmed plan never
 *                goes back to waiting. Whether an order is safe right now is
 *                reported separately in `safety` and never adds a condition.
 *   INVALIDATED  the market broke the plan's invalidation rules, or every approved attempt failed
 *   MISSED       the entry passed: price ran away without the approved entry, or the
 *                approved entry window closed while blocked. GX never chases.
 *   EXPIRED      the plan's time ran out first
 *
 * Finite by construction: plans carry a retest window, a continuation window
 * and a maximum number of attempts (frozen when approved), so every plan
 * either confirms within its rules or ends with a reason.
 */

export type ConditionStatus = "PENDING" | "PASSED" | "FAILED" | "BLOCKED";
export type ConfirmationOutcome = "WAITING" | "CONFIRMED" | "INVALIDATED" | "EXPIRED" | "MISSED";

export type ConditionResult = {
  key: string;
  status: ConditionStatus;
  detail: string;
  /** Candle open time (ISO) the condition was decided on, if any. */
  at: string | null;
  evidence?: Record<string, unknown>;
};

export type ConfirmationEventType =
  | "BREAKOUT_DETECTED" | "RETEST_DETECTED" | "SWEEP_DETECTED" | "REJECTION_DETECTED"
  | "STRUCTURE_BREAK" | "CONDITIONS_MET" | "SETUP_CONFIRMED" | "SAFETY_BLOCKED" | "INVALIDATED" | "ATTEMPT_FAILED" | "MISSED";

export type ConfirmationEvent = { type: ConfirmationEventType; at: string; detail: string };

export type PlanForConfirmation = {
  instrument: string;
  direction: TradePlanDirection;
  setupType: TradePlanSetupType;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: string;
  expiresAt: string;
  plan: Record<string, unknown>;
};

export type SafetyLimits = {
  maxSpreadStopFraction: number;
  maxDataAgeSeconds: number;
  newsBlackoutBeforeMinutes: number;
  newsBlackoutAfterMinutes: number;
};

export type ConfirmationInput = {
  plan: PlanForConfirmation;
  /** Candles by timeframe; the plan's rules say which ones it is judged on. */
  candles: Partial<Record<Tf, Candle[]>>;
  quote: { bid: number; ask: number; time: string } | null;
  /** null when the calendar could not be read. */
  news: NewsItem[] | null;
  now: number;
  limits: SafetyLimits;
};

export type Confirmation = {
  outcome: ConfirmationOutcome;
  /** Where the plan is in its sequence, e.g. WAITING_FOR_RETEST. */
  stage: string;
  conditions: ConditionResult[];
  /** One sentence: why the plan has not triggered (null once confirmed). */
  notTriggeredReason: string | null;
  events: ConfirmationEvent[];
  /** The proposed trade at confirmation time; filled once the technical sequence completes. */
  proposal: {
    confirmedAt: string;
    side: "BUY" | "SELL";
    entry: number;
    stopLoss: number;
    takeProfit: number;
    rewardRisk: number;
    spread: number | null;
    quoteTime: string | null;
  } | null;
  /** Latest closed candle the evaluation read (ISO open time). */
  evaluatedThrough: Partial<Record<Tf, string | null>>;
  /** Execution safety now (spread, quote age, market open, news blackout, live reward/risk). Separate from confirmation. */
  safety: { ok: boolean; blocks: string[] } | null;
  /** Attempts used of those approved, and the open window (in closed candles), when the plan has them. */
  progress: { attempt: number; maxAttempts: number | null; window: { window: string; used: number; limit: number } | null };
};

export type Tf = "H4" | "H1" | "M15";
const STEP: Record<Tf, number> = { H4: 4 * 3_600_000, H1: 3_600_000, M15: 900_000 };
const tfOf = (value: unknown, fallback: Tf): Tf => (value === "H4" || value === "H1" || value === "M15" ? value : fallback);

/** A closed candle in BUY-normalised prices (SELL plans negate). */
type Bar = { index: number; open: number; close: number; o: number; h: number; l: number; c: number; time: string };

function bars(candles: Candle[], step: number, now: number, sign: 1 | -1): Bar[] {
  return candles
    .filter((candle) => candle.complete === true && Date.parse(candle.time) + step <= now)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((candle, index) => {
      const open = Date.parse(candle.time);
      return sign === 1
        ? { index, open, close: open + step, o: candle.open, h: candle.high, l: candle.low, c: candle.close, time: candle.time }
        : { index, open, close: open + step, o: -candle.open, h: -candle.low, l: -candle.high, c: -candle.close, time: candle.time };
    });
}

/** The candle timeframes a plan is judged on (from its frozen rules). */
export function planTimeframes(plan: Pick<PlanForConfirmation, "setupType" | "plan">): Tf[] {
  const rules = (plan.plan.rules ?? {}) as Record<string, unknown>;
  return plan.setupType === "BREAKOUT_RETEST"
    ? [...new Set([tfOf(rules.breakoutTimeframe, "H1"), tfOf(rules.retestTimeframe, "M15")])]
    : [tfOf(rules.confirmTimeframe, "M15")];
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function evaluateConfirmation(input: ConfirmationInput): Confirmation {
  const { plan, now } = input;
  const sign: 1 | -1 = plan.direction === "BUY" ? 1 : -1;
  const digits = precisionFor(plan.instrument);
  /** Normalised price back to a real one, formatted. */
  const fmt = (value: number) => (sign * value).toFixed(digits);
  /** A normalised zone as real prices, low first. */
  const span = (a: number, b: number) => [sign * a, sign * b].sort((x, y) => x - y).map((value) => value.toFixed(digits)).join("–");
  const under = sign === 1 ? "below" : "above";
  const over = sign === 1 ? "above" : "below";
  const createdAt = Date.parse(plan.createdAt);
  const rules = (plan.plan.rules ?? {}) as Record<string, unknown>;
  // Swing plans freeze an H4 ATR as `atr`; plans made before swing mode froze `atrH1`.
  const atr = num(rules.atr ?? rules.atrH1, NaN);
  const atrTf = typeof rules.atrTimeframe === "string" ? rules.atrTimeframe : "H1";
  // Breakout: the breakout candle's timeframe, then the retest timeframe. Reversal: one confirmation timeframe.
  const entryTf = plan.setupType === "BREAKOUT_RETEST" ? tfOf(rules.retestTimeframe, "M15") : tfOf(rules.confirmTimeframe, "M15");
  const signalTf = plan.setupType === "BREAKOUT_RETEST" ? tfOf(rules.breakoutTimeframe, "H1") : entryTf;
  const minRewardRisk = num(rules.minRewardRisk, 1.5);
  const validMs = num(rules.confirmationValidMinutes, 60) * 60_000;

  const signalAll = bars(input.candles[signalTf] ?? [], STEP[signalTf], now, sign);
  const entryAll = bars(input.candles[entryTf] ?? [], STEP[entryTf], now, sign);
  const signalBars = signalAll.filter((bar) => bar.open >= createdAt);
  const entryBars = entryAll.filter((bar) => bar.open >= createdAt);
  const evaluatedThrough = { [signalTf]: signalAll.at(-1)?.time ?? null, [entryTf]: entryAll.at(-1)?.time ?? null };

  const conditions = new Map<string, ConditionResult>();
  const set = (key: string, status: ConditionStatus, detail: string, at: string | null = null, evidence?: Record<string, unknown>) =>
    conditions.set(key, { key, status, detail, at, evidence });
  const events: ConfirmationEvent[] = [];
  const stop = sign * plan.stopLoss;
  const target = sign * plan.takeProfit;

  const keys = plan.setupType === "BREAKOUT_RETEST"
    ? ["breakout_close", "breakout_size", "retest", "retest_holds", "continuation", "reward_risk", "execution_safety"]
    : ["approach", "rejection_or_sweep", "reclaim", "local_structure", "stop_placement", "reward_risk", "execution_safety"];
  for (const key of keys) set(key, "PENDING", "Waiting for the earlier conditions.");

  let attemptsUsed = 1;
  let maxAttemptsUsed: number | null = null;
  let windowNote: { window: string; used: number; limit: number } | null = null;
  let safety: Confirmation["safety"] = null;
  const finish = (outcome: ConfirmationOutcome, stage: string, reason: string | null, proposal: Confirmation["proposal"] = null): Confirmation => ({
    outcome,
    stage,
    conditions: keys.map((key) => conditions.get(key)!),
    notTriggeredReason: outcome === "CONFIRMED" ? reason : reason,
    events,
    proposal,
    evaluatedThrough,
    safety,
    progress: { attempt: attemptsUsed, maxAttempts: maxAttemptsUsed, window: outcome === "WAITING" ? windowNote : null },
  });
  const invalidate = (bar: Bar | null, key: string, reason: string) => {
    set(key, "FAILED", reason, bar?.time ?? null);
    events.push({ type: "INVALIDATED", at: bar ? new Date(bar.close).toISOString() : new Date(now).toISOString(), detail: reason });
    return finish("INVALIDATED", "INVALIDATED", reason);
  };
  const missed = (bar: Bar | null, key: string, reason: string) => {
    set(key, "FAILED", reason, bar?.time ?? null);
    events.push({ type: "MISSED", at: bar ? new Date(bar.close).toISOString() : new Date(now).toISOString(), detail: reason });
    return finish("MISSED", "MISSED", reason);
  };
  // Approved entry zone in BUY-normalised prices, and how far past it an entry may be (plans with the rule only).
  const zoneTop = Math.max(sign * plan.entryZoneLow, sign * plan.entryZoneHigh);
  const deviation = num(rules.maxEntryDeviationAtr, NaN) * atr;
  /** Price has left the approved entry behind: past the zone with too little reward left. */
  const ranAway = (bar: Bar) => Number.isFinite(deviation) && bar.c > zoneTop && (bar.c >= target || (target - bar.c) / (bar.c - stop) < minRewardRisk);

  if (!(atr > 0)) return invalidate(null, keys[0]!, "The plan has no frozen ATR; it cannot be judged.");

  // ── Technical sequence. Returns the bar that completed it, or a terminal result.
  let completed: Bar | null = null;
  let waiting: { stage: string; reason: string } | null = null;

  if (plan.setupType === "BREAKOUT_RETEST") {
    const level = sign * num(plan.plan.breakoutLevel, NaN);
    const invalidation = (plan.plan.invalidation ?? {}) as Record<string, unknown>;
    const failLevel = sign * num(invalidation.failLevel, NaN);
    const farEdge = sign * num(invalidation.zoneFarEdge, NaN);
    const threshold = num(rules.breakoutCloseAtr ?? rules.breakoutCloseH1Atr, 0.25) * atr;
    const tolerance = num(rules.retestToleranceAtr ?? rules.retestToleranceH1Atr, 0.3) * atr;
    if (![level, failLevel, farEdge].every(Number.isFinite)) return invalidate(null, "breakout_close", "The plan is missing its breakout levels.");

    // Finite by construction: each attempt has a retest window and a continuation
    // window (in closed entry candles), and the plan allows a fixed number of
    // attempts. Plans approved before these rules existed have none of them and
    // keep the rules they were approved with (expiry still ends them).
    const retestWindow = num(rules.retestWindowBars, Infinity);
    const continuationWindow = num(rules.continuationWindowBars, Infinity);
    const maxAttempts = Math.max(1, Math.floor(num(rules.maxBreakoutAttempts, 1)));
    maxAttemptsUsed = Number.isFinite(retestWindow) || Number.isFinite(continuationWindow) ? maxAttempts : null;

    let from = createdAt;
    let approached = rules.waitForApproach !== true || plan.plan.breakoutAlreadyClosed === true;
    for (let attempt = 1; ; attempt += 1) {
      attemptsUsed = attempt;
      const label = maxAttemptsUsed && maxAttemptsUsed > 1 ? ` (attempt ${attempt} of ${maxAttemptsUsed})` : "";
      // 1–2. Breakout: a completed close (signal timeframe) beyond the level by the noise threshold.
      let breakoutAt: number | null = attempt === 1 && plan.plan.breakoutAlreadyClosed === true ? createdAt : null;
      let firstClose: Bar | null = null;
      if (breakoutAt !== null) {
        set("breakout_close", "PASSED", `Price had already closed through ${fmt(level)} when the plan was made.`, plan.createdAt);
        set("breakout_size", "PASSED", "The breakout was already established at generation.", plan.createdAt);
      } else {
        for (const bar of signalBars.filter((item) => item.open >= from)) {
          if (bar.h >= farEdge) approached = true;
          if (approached && bar.c < farEdge) return invalidate(bar, "breakout_close", `An ${signalTf} close at ${fmt(bar.c)} went through the far side of the zone (${fmt(farEdge)}) before any breakout.`);
          if (bar.c > level && !firstClose) firstClose = bar;
          if (bar.c > level + threshold) {
            breakoutAt = bar.close;
            set("breakout_close", "PASSED", `${signalTf} closed at ${fmt(bar.c)}, beyond ${fmt(level)}${label}.`, bar.time, { close: sign * bar.c });
            set("breakout_size", "PASSED", `The close cleared the level by ${((bar.c - level) / atr).toFixed(2)} ${atrTf} ATR (needs ${(threshold / atr).toFixed(2)}).`, bar.time);
            events.push({ type: "BREAKOUT_DETECTED", at: new Date(bar.close).toISOString(), detail: `${signalTf} closed at ${fmt(bar.c)} through ${fmt(level)}${label}.` });
            break;
          }
        }
      }
      if (breakoutAt === null) {
        if (firstClose) {
          set("breakout_close", "PASSED", `${signalTf} closed at ${fmt(firstClose.c)} beyond ${fmt(level)}, but not by enough.`, firstClose.time);
          set("breakout_size", "PENDING", `No ${signalTf} close beyond ${fmt(level + threshold)} yet (${(threshold / atr).toFixed(2)} ${atrTf} ATR past the level).`);
        } else {
          set("breakout_close", "PENDING", `No completed ${signalTf} close beyond ${fmt(level)} yet${label}.`);
        }
        waiting = { stage: "WAITING_FOR_BREAKOUT", reason: `Waiting for a ${signalTf} close beyond ${fmt(level + threshold)}${label}.` };
        break;
      }

      // 3–5. Retest within tolerance and window, hold above the fail level, then a continuation close within its window.
      let retest: Bar | null = null;
      let deepest: Bar | null = null;
      let used = 0;
      let retestAt = 0;
      let failed: { bar: Bar; reason: string } | null = null;
      for (const bar of entryBars.filter((item) => item.open >= breakoutAt!)) {
        used += 1;
        if (bar.c < failLevel) {
          return invalidate(bar, retest ? "retest_holds" : "retest", `${entryTf} closed at ${fmt(bar.c)}, back through ${fmt(failLevel)}: the breakout failed.`);
        }
        if (bar.l <= stop) return invalidate(bar, "retest_holds", `Price traded to ${fmt(bar.l)}, through the approved stop ${fmt(stop)}.`);
        if (!retest) {
          if (bar.l <= level + tolerance) {
            retest = bar;
            deepest = bar;
            retestAt = used;
            set("retest", "PASSED", `Price came back to ${fmt(bar.l)}, within ${(tolerance / atr).toFixed(2)} ${atrTf} ATR of ${fmt(level)}.`, bar.time);
            events.push({ type: "RETEST_DETECTED", at: new Date(bar.close).toISOString(), detail: `Retest of ${fmt(level)} reached ${fmt(bar.l)}.` });
            continue;
          }
          if (ranAway(bar)) return missed(bar, "retest", `Price ran to ${fmt(bar.c)} without retesting ${fmt(level)}; from there reward/risk is under ${minRewardRisk}. GX does not chase.`);
          if (used >= retestWindow) return missed(bar, "retest", `No retest of ${fmt(level)} within ${retestWindow} ${entryTf} candles of the breakout. GX does not chase.`);
          continue;
        }
        if (bar.l < deepest!.l) deepest = bar;
        if (bar.c > deepest!.h && bar.c > level) {
          completed = bar;
          set("retest_holds", "PASSED", `No ${entryTf} close back through ${fmt(failLevel)}; the retest's extreme was ${fmt(deepest!.l)}.`, deepest!.time);
          set("continuation", "PASSED", `${entryTf} closed at ${fmt(bar.c)}, beyond the retest candle's ${sign === 1 ? "high" : "low"} ${fmt(deepest!.h)}.`, bar.time);
          break;
        }
        if (used - retestAt >= continuationWindow) {
          failed = { bar, reason: `no ${entryTf} continuation within ${continuationWindow} candles of the retest` };
          break;
        }
      }
      if (completed) break;
      if (failed) {
        events.push({ type: "ATTEMPT_FAILED", at: new Date(failed.bar.close).toISOString(), detail: `Breakout attempt ${attempt} failed: ${failed.reason}.` });
        if (attempt >= maxAttempts) {
          return invalidate(failed.bar, "continuation", maxAttempts > 1
            ? `All ${maxAttempts} approved breakout attempts failed; the last had ${failed.reason}.`
            : `The breakout failed: ${failed.reason}.`);
        }
        // The plan allows another attempt: a fresh breakout close after this failure, judged by the same rules.
        from = failed.bar.close;
        for (const key of ["breakout_close", "breakout_size", "retest", "retest_holds", "continuation"]) set(key, "PENDING", "Waiting for a new breakout attempt.");
        continue;
      }
      if (!retest) {
        windowNote = Number.isFinite(retestWindow) ? { window: "retest", used, limit: retestWindow } : null;
        set("retest", "PENDING", `Waiting for price to come back within ${(tolerance / atr).toFixed(2)} ${atrTf} ATR of ${fmt(level)}${windowNote ? ` (${retestWindow - used} of ${retestWindow} ${entryTf} candles left)` : ""}.`);
        waiting = { stage: "WAITING_FOR_RETEST", reason: `Breakout confirmed; waiting for a retest of ${fmt(level)}${windowNote ? ` within ${retestWindow - used} more ${entryTf} candles` : ""}.` };
      } else {
        windowNote = Number.isFinite(continuationWindow) ? { window: "continuation", used: used - retestAt, limit: continuationWindow } : null;
        set("retest_holds", "PENDING", `Holding so far: no ${entryTf} close through ${fmt(failLevel)}.`);
        set("continuation", "PENDING", `Waiting for an ${entryTf} close beyond ${fmt(deepest!.h)}${windowNote ? ` (${continuationWindow - (used - retestAt)} of ${continuationWindow} candles left)` : ""}.`);
        waiting = { stage: "WAITING_FOR_CONTINUATION", reason: `Retest holding; waiting for an ${entryTf} close beyond ${fmt(deepest!.h)}.` };
      }
      break;
    }
  } else {
    const zone = (plan.plan.zone ?? {}) as Record<string, unknown>;
    const invalidation = (plan.plan.invalidation ?? {}) as Record<string, unknown>;
    // In BUY-normalised prices the support zone is [zl, zh]; a SELL's resistance negates into the same shape.
    const edges = [sign * num(zone.low, NaN), sign * num(zone.high, NaN)];
    const zl = Math.min(...edges);
    const zh = Math.max(...edges);
    const failLevel = sign * num(invalidation.failLevel, NaN);
    const sweepLimit = sign * num(invalidation.sweepLimit, NaN);
    if (![zl, zh, failLevel, sweepLimit].every(Number.isFinite)) return invalidate(null, "approach", "The plan is missing its zone levels.");
    const reclaimBars = num(rules.reclaimBars, 3);
    const wickShare = num(rules.rejectionWickShare, 0.5);
    const lookback = num(rules.structureLookbackBars, 8);
    const breakBars = num(rules.structureBreakBars, 16);
    // Each rejection or sweep that does not break structure in time is a failed attempt (plans with the rule only).
    const maxTurns = num(rules.maxAttempts, Infinity);
    maxAttemptsUsed = Number.isFinite(maxTurns) ? maxTurns : null;
    let failedTurns = 0;
    const turnFailed = (bar: Bar, why: string) => {
      failedTurns += 1;
      events.push({ type: "ATTEMPT_FAILED", at: new Date(bar.close).toISOString(), detail: `Attempt ${failedTurns} failed: ${why}.` });
      attemptsUsed = failedTurns + 1;
      return failedTurns >= maxTurns;
    };

    let approach: Bar | null = null;
    let pendingSweep: { bar: Bar; low: number } | null = null;
    let turn: { kind: "SWEEP" | "REJECTION"; bar: Bar; low: number; pivot: number } | null = null;
    const pivotBefore = (bar: Bar) => {
      const before = entryAll.slice(Math.max(0, bar.index - lookback), bar.index);
      return before.length ? Math.max(...before.map((item) => item.h)) : bar.h;
    };
    for (const bar of entryBars) {
      if (!approach) {
        if (bar.l > zh) continue;
        approach = bar;
        set("approach", "PASSED", `Price reached the zone at ${fmt(bar.l)}.`, bar.time);
      }
      if (bar.c < failLevel) return invalidate(bar, "rejection_or_sweep", `${entryTf} closed at ${fmt(bar.c)}, through ${fmt(failLevel)}: the zone gave way.`);
      if (bar.l < sweepLimit) return invalidate(bar, "rejection_or_sweep", `Price ran to ${fmt(bar.l)}, past the deepest allowed sweep ${fmt(sweepLimit)}.`);
      if (bar.l <= stop) return invalidate(bar, "stop_placement", `Price traded to ${fmt(bar.l)}, through the approved stop ${fmt(stop)}.`);

      if (turn) {
        if (bar.index - turn.bar.index > breakBars) {
          // The turn never broke structure: a failed attempt. Look for another only if the plan allows one.
          if (turnFailed(bar, `no break of ${fmt(turn.pivot)} within ${breakBars} candles`)) {
            attemptsUsed = failedTurns;
            return invalidate(bar, "local_structure", `All ${maxTurns} approved attempts failed: the last turn did not break ${fmt(turn.pivot)} within ${breakBars} ${entryTf} candles.`);
          }
          turn = null;
        } else if (bar.c > turn.pivot) {
          completed = bar;
          set("local_structure", "PASSED", `${entryTf} closed at ${fmt(bar.c)}, beyond the local ${sign === 1 ? "high" : "low"} ${fmt(turn.pivot)}.`, bar.time);
          set("stop_placement", "PASSED", `The approved stop ${fmt(stop)} is beyond the ${turn.kind === "SWEEP" ? "sweep" : "rejection"} extreme ${fmt(turn.low)}.`, turn.bar.time);
          events.push({ type: "STRUCTURE_BREAK", at: new Date(bar.close).toISOString(), detail: `${entryTf} broke ${fmt(turn.pivot)}.` });
          break;
        } else {
          continue;
        }
      }
      if (pendingSweep) {
        pendingSweep.low = Math.min(pendingSweep.low, bar.l);
        if (bar.c >= zl) {
          turn = { kind: "SWEEP", bar, low: pendingSweep.low, pivot: pivotBefore(pendingSweep.bar) };
          set("rejection_or_sweep", "PASSED", `Liquidity sweep to ${fmt(pendingSweep.low)}, past ${fmt(zl)}.`, pendingSweep.bar.time);
          set("reclaim", "PASSED", `An ${entryTf} close at ${fmt(bar.c)} reclaimed the zone.`, bar.time);
          events.push({ type: "SWEEP_DETECTED", at: new Date(bar.close).toISOString(), detail: `Swept to ${fmt(pendingSweep.low)} and reclaimed ${fmt(zl)}.` });
          pendingSweep = null;
        } else if (bar.index - pendingSweep.bar.index >= reclaimBars) {
          if (turnFailed(bar, `the sweep was not reclaimed within ${reclaimBars} candles`)) {
            attemptsUsed = failedTurns;
            return invalidate(bar, "reclaim", `All ${maxTurns} approved attempts failed: the last sweep was not reclaimed within ${reclaimBars} ${entryTf} candles.`);
          }
          pendingSweep = null;
        }
        continue;
      }
      if (!turn && ranAway(bar)) return missed(bar, "rejection_or_sweep", `Price left the zone to ${fmt(bar.c)} without a confirmed turn; from there reward/risk is under ${minRewardRisk}. GX does not chase.`);
      if (bar.l < zl) {
        if (bar.c >= zl) {
          turn = { kind: "SWEEP", bar, low: bar.l, pivot: pivotBefore(bar) };
          set("rejection_or_sweep", "PASSED", `Liquidity sweep to ${fmt(bar.l)}, past ${fmt(zl)}, closing back inside.`, bar.time);
          set("reclaim", "PASSED", `The sweep candle closed back at ${fmt(bar.c)}.`, bar.time);
          events.push({ type: "SWEEP_DETECTED", at: new Date(bar.close).toISOString(), detail: `Swept to ${fmt(bar.l)} and closed back inside.` });
        } else {
          pendingSweep = { bar, low: bar.l };
        }
        continue;
      }
      const range = bar.h - bar.l;
      const wick = Math.min(bar.o, bar.c) - bar.l;
      if (bar.l <= zh && range > 0 && wick / range >= wickShare && bar.c >= (zl + zh) / 2) {
        turn = { kind: "REJECTION", bar, low: bar.l, pivot: pivotBefore(bar) };
        set("rejection_or_sweep", "PASSED", `${entryTf} rejected the zone: ${Math.round((wick / range) * 100)}% wick, close ${fmt(bar.c)}.`, bar.time);
        set("reclaim", "PASSED", "No sweep: the zone held on a rejection.", bar.time);
        events.push({ type: "REJECTION_DETECTED", at: new Date(bar.close).toISOString(), detail: `Rejection at ${fmt(bar.l)}.` });
      }
    }
    if (!completed) {
      if (!approach) {
        set("approach", "PENDING", `Waiting for price to reach ${span(zl, zh)}.`);
        waiting = { stage: "WAITING_FOR_ZONE", reason: `Waiting for price to reach the zone ${span(zl, zh)}.` };
      } else if (pendingSweep) {
        set("rejection_or_sweep", "PASSED", `Price swept to ${fmt(pendingSweep.low)}, past ${fmt(zl)}.`, pendingSweep.bar.time);
        set("reclaim", "PENDING", `A sweep alone is not a trigger: waiting for an ${entryTf} close back ${over} ${fmt(zl)}.`);
        waiting = { stage: "WAITING_FOR_RECLAIM", reason: `Swept ${under} ${fmt(zl)}; waiting for a close back inside the zone.` };
      } else if (turn) {
        set("local_structure", "PENDING", `Waiting for an ${entryTf} close beyond ${fmt(turn.pivot)}.`);
        waiting = { stage: "WAITING_FOR_STRUCTURE", reason: `${turn.kind === "SWEEP" ? "Sweep reclaimed" : "Rejection seen"}; waiting for ${entryTf} to break ${fmt(turn.pivot)}.` };
      } else {
        set("rejection_or_sweep", "PENDING", "In the zone; no rejection or sweep yet.");
        waiting = { stage: "WAITING_FOR_REJECTION", reason: "Price is at the zone; waiting for a rejection or a sweep and reclaim." };
      }
    }
  }

  const expired = now >= Date.parse(plan.expiresAt);
  if (!completed) {
    if (expired) return finish("EXPIRED", "EXPIRED", "The plan expired before it confirmed.");
    return finish("WAITING", waiting!.stage, waiting!.reason);
  }

  // A sequence that completed after expiry does not count.
  if (completed.close > Date.parse(plan.expiresAt)) return finish("EXPIRED", "EXPIRED", "The plan expired before it confirmed.");

  // ── Reward/risk at the confirming close (deterministic from candles).
  // Mid prices only: this verdict is permanent, so it must not depend on the
  // spread at evaluation time. The live spread is judged in the safety checks.
  const checkedQuote = checkQuote(plan.instrument, input.quote, now, input.limits.maxDataAgeSeconds * 1000);
  const quote = checkedQuote.executable;
  const spread = quote ? quote.ask - quote.bid : null;
  const cost = spread ?? 0;
  const atClose = (target - completed.c) / (completed.c - stop);
  if (!(completed.c > stop) || atClose < minRewardRisk) {
    return missed(completed, "reward_risk", `At the confirming close ${fmt(completed.c)} reward/risk was ${atClose.toFixed(2)}, under ${minRewardRisk}: price ran too far first. GX does not chase.`);
  }
  if (Number.isFinite(deviation) && completed.c > zoneTop + deviation) {
    return missed(completed, "reward_risk", `The setup completed at ${fmt(completed.c)}, more than ${(deviation / atr).toFixed(2)} ${atrTf} ATR past the approved entry zone. GX does not chase.`);
  }
  set("reward_risk", "PASSED", `Reward/risk ${atClose.toFixed(2)} at the confirming close ${fmt(completed.c)}.`, completed.time);
  const confirmedAt = new Date(completed.close).toISOString();
  events.push({ type: "CONDITIONS_MET", at: confirmedAt, detail: `Technical conditions complete at ${fmt(completed.c)}.` });

  // ── Execution safety, judged now. It never adds a confirmation condition: it
  // only says whether an order may go in at this moment.
  const blocks: string[] = [];
  if (!quote) blocks.push(checkedQuote.reason);
  if (!getForexSessionStatus(new Date(now)).marketOpen) blocks.push("The market is closed.");
  // Executable entry: BUY at the ask, SELL at the bid (normalised: -bid).
  const entry = quote ? (sign === 1 ? quote.ask : -quote.bid) : completed.c;
  const risk = entry - stop;
  const liveRewardRisk = risk > 0 ? (target - entry - cost) / risk : -1;
  if (quote) {
    if (!(risk > 0)) blocks.push(`Price ${fmt(entry)} is already past the stop.`);
    else {
      if (cost > input.limits.maxSpreadStopFraction * risk) {
        blocks.push(`Spread is ${Math.round((cost / risk) * 100)}% of the stop distance (limit ${Math.round(input.limits.maxSpreadStopFraction * 100)}%).`);
      }
      if (liveRewardRisk < minRewardRisk) blocks.push(`From ${fmt(entry)} reward/risk is ${liveRewardRisk.toFixed(2)}, under ${minRewardRisk}.`);
    }
  }
  if (input.news === null) blocks.push("The economic calendar could not be read.");
  else {
    const [base, quoteCurrency] = plan.instrument.split("_");
    const near = input.news.find((event) => {
      if (event.impact < 3 || (event.currency !== base && event.currency !== quoteCurrency)) return false;
      const minutes = (Date.parse(event.timestamp) - now) / 60_000;
      return minutes <= input.limits.newsBlackoutBeforeMinutes && minutes >= -input.limits.newsBlackoutAfterMinutes;
    });
    if (near) blocks.push(`News blackout: high-impact ${near.currency} ${near.title} at ${new Date(Date.parse(near.timestamp)).toISOString().slice(11, 16)} UTC.`);
  }
  safety = { ok: blocks.length === 0, blocks };

  const proposal = {
    confirmedAt,
    side: plan.direction,
    entry: Number((sign * entry).toFixed(digits)),
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    rewardRisk: Number((quote ? liveRewardRisk : atClose).toFixed(2)),
    spread,
    quoteTime: quote?.time ?? null,
  };
  // Price has moved beyond the approved entry: the opportunity is gone, not re-armed.
  if (quote && Number.isFinite(deviation) && entry > zoneTop + deviation) {
    return missed(completed, "execution_safety", `Confirmed, but price is now ${fmt(entry)}, more than ${(deviation / atr).toFixed(2)} ${atrTf} ATR past the approved entry zone. GX does not chase.`);
  }
  if (expired) return finish("EXPIRED", "EXPIRED", "The plan expired before it could be acted on.");
  if (blocks.length) {
    // The approved entry window: a confirmation that cannot be acted on within it is missed, not re-confirmed later.
    if (now - completed.close > validMs) {
      return missed(completed, "execution_safety", `Confirmed at ${confirmedAt.slice(11, 16)} UTC, but no safe entry within the approved ${Math.round(validMs / 60_000)} min window: ${blocks.join(" ")}`);
    }
    set("execution_safety", "BLOCKED", blocks.join(" "));
    events.push({ type: "SAFETY_BLOCKED", at: new Date(now).toISOString(), detail: blocks.join(" ") });
    events.push({ type: "SETUP_CONFIRMED", at: confirmedAt, detail: `Confirmed: ${plan.direction} near ${proposal.entry}, stop ${plan.stopLoss}, target ${plan.takeProfit}.` });
    return finish("CONFIRMED", "CONFIRMED_BLOCKED", `Confirmed; an order cannot go in yet: ${blocks.join(" ")}`, proposal);
  }
  set("execution_safety", "PASSED", "Fresh quote, market open, spread and reward/risk within limits, no news blackout. Account risk is checked again at execution.");
  events.push({ type: "SETUP_CONFIRMED", at: confirmedAt, detail: `Confirmed: ${plan.direction} from ${proposal.entry}, stop ${plan.stopLoss}, target ${plan.takeProfit}.` });
  return finish("CONFIRMED", "CONFIRMED", null, proposal);
}
