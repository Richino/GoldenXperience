import type { Candle } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { firstFvg, type FvgZone } from "@/lib/strategy/fvg";

/**
 * Asia-range AMD (accumulation → manipulation → distribution) as an explicit,
 * causal state machine over closed M15 candles. Visual and analytics only —
 * nothing here feeds an evaluator or places an order.
 *
 *   A  The Asian session (00:00–07:00 UTC) is the accumulation range. Its
 *      high, low and midpoint freeze when the session ends and never move.
 *   M? London (07:00–13:00 UTC) trades through one side: a sweep candidate.
 *      Crossing the level is not manipulation by itself.
 *   M  A closed candle back inside the range (never a wick) confirms the
 *      manipulation. A low swept and reclaimed points long, a high short —
 *      the direction comes from the side that was swept, never from the
 *      break itself.
 *   D  In CLOSE_PLUS_DISPLACEMENT mode (the default) a candle with a body of
 *      at least `displacementBodyMult` x the recent average body, closing on
 *      in the expected direction, completes the sequence. In CLOSE mode the
 *      reclaim alone does.
 *
 * A break that holds outside — `outsideClosesRequired` closes in a row, one
 * close `acceptanceDistanceAtr` ATR beyond the level, or no reclaim within
 * `reclaimTimeoutBars` — is BREAKOUT_ACCEPTED: continuation, not manipulation.
 *
 * Every candle is processed once, in order, and only ever looks back: at
 * candle N the machine knows candles 0..N and nothing else, so a replay cut at
 * N shows exactly what was known live. Frozen fields are never rewritten.
 */

export type AmdState =
  | "ASIA_BUILDING"
  | "ASIA_LOCKED"
  | "WAITING_FOR_SWEEP"
  | "SWEEP_CANDIDATE"
  | "RECLAIM_CONFIRMED"
  | "WAITING_FOR_DISPLACEMENT"
  | "DISTRIBUTION_CONFIRMED"
  | "BREAKOUT_ACCEPTED"
  | "NO_SWEEP"
  | "EXPIRED"
  | "INVALID";

export type AmdSide = "high" | "low";
export type AmdDirection = "long" | "short";
export type AmdReclaimMode = "CLOSE" | "CLOSE_PLUS_DISPLACEMENT";

export interface AmdConfig {
  /** UTC hours. Asia is [asiaStartHour, asiaEndHour); sweeps may start until londonEndHour. */
  asiaStartHour: number;
  asiaEndHour: number;
  londonEndHour: number;
  /** Nothing is resolved or measured after this UTC hour. */
  dayEndHour: number;
  barMinutes: number;
  /** Fewer Asian candles than this (holiday, data gap) makes the day INVALID. */
  minAsiaBars: number;
  /** How far past the level price must trade to be a sweep candidate. 0 = any trade through. */
  minSweepPips: number;
  reclaimMode: AmdReclaimMode;
  outsideClosesRequired: number;
  /** Candles after the sweep candle allowed for a reclaim. */
  reclaimTimeoutBars: number;
  /** A single close this many M15 ATR beyond the level is acceptance. */
  acceptanceDistanceAtr: number;
  /** Displacement body vs the average body of the previous `bodyLookback` candles. */
  displacementBodyMult: number;
  bodyLookback: number;
  /** Candles after the reclaim candle allowed for displacement. */
  displacementTimeoutBars: number;
  atrPeriod: number;
  /** A candle range above this many ATR is flagged as abnormal volatility. */
  abnormalRangeAtr: number;
  newsWindowMinutes: number;
  /** Daily ATR length used to size the Asian range. */
  dailyAtrDays: number;
  outcomePips: number[];
}

export const AMD_DEFAULTS: AmdConfig = {
  asiaStartHour: 0,
  asiaEndHour: 7,
  londonEndHour: 13,
  dayEndHour: 21,
  barMinutes: 15,
  minAsiaBars: 20,
  minSweepPips: 0,
  reclaimMode: "CLOSE_PLUS_DISPLACEMENT",
  outsideClosesRequired: 2,
  reclaimTimeoutBars: 4,
  acceptanceDistanceAtr: 2,
  displacementBodyMult: 1,
  bodyLookback: 20,
  displacementTimeoutBars: 4,
  atrPeriod: 14,
  abnormalRangeAtr: 3,
  newsWindowMinutes: 30,
  dailyAtrDays: 14,
  outcomePips: [5, 10, 15, 20],
};

/** One trade through one side of the Asian range, and what became of it. */
export interface AmdSweep {
  side: AmdSide;
  /** The direction a reclaim of this side points: low → long, high → short. */
  direction: AmdDirection;
  /** Open time of the candle that first traded through the level. */
  startTime: string;
  extreme: number;
  extremeTime: string;
  depthPips: number;
  /** Closes outside the range in a row while a candidate. */
  outsideCloses: number;
  status:
    | "candidate"
    | "reclaimed"
    | "distribution"
    | "accepted"
    | "no-displacement"
    | "re-broken"
    /** Dropped because the other side was swept (or both went in one candle). */
    | "superseded"
    | "expired";
  acceptedReason: "closes" | "distance" | "timeout" | null;
  /** Close time of the reclaim candle. */
  reclaimTime: string | null;
  reclaimClose: number | null;
  /** Candles after the sweep candle until the reclaim closed (0 = same candle). */
  barsToReclaim: number | null;
  /** Close time of the last candle this sweep covered; grows while it is live. */
  endTime: string;
  high: number;
  low: number;
}

export interface AmdOutcome {
  direction: AmdDirection;
  /** Close time of the candle the measurement starts after. */
  startTime: string;
  entry: number;
  mfePips: number;
  maePips: number;
  /** Per threshold: which came first, +X or −X pips. "both" = same candle. */
  race: Record<number, "win" | "loss" | "both" | "open">;
  bars: number;
}

export interface AmdDistribution {
  direction: AmdDirection;
  sweepSide: AmdSide;
  /** Open time of the confirming candle. */
  barTime: string;
  /** Close time of the confirming candle: the first moment the setup existed. */
  time: string;
  entry: number;
  /** Body of the confirming candle vs the recent average body (CLOSE mode: the reclaim candle). */
  bodyRatio: number;
  stop: number;
  target: number;
  midpoint: number;
  riskPips: number;
  rewardPips: number;
  /** Reward to the opposite Asian boundary over risk to the sweep extreme; null if not positive. */
  rr: number | null;
  /** The confirming candle's range. */
  high: number;
  low: number;
  /** Furthest price reached in the direction so far, and the close time of the last candle followed. */
  best: number;
  endTime: string;
  midpointReached: "already" | "reached" | "no";
  oppositeReached: "already" | "reached" | "no";
  minutesToOpposite: number | null;
  /** Stop at the sweep extreme, target at the far side of the range, closed at day end. */
  structural: { result: "win" | "loss" | "open" | "n/a"; r: number | null };
}

export interface AmdTransition {
  /** Open time of the candle that decided it; null when the clock did (Asia close, London close, day end). */
  barTime: string | null;
  /** When it became known: that candle's close, or the clock time. */
  time: string;
  from: AmdState;
  to: AmdState;
  note: string;
}

export interface AsiaQuality {
  /** |net move| / path length of closes: 0 = churn, 1 = straight line. */
  efficiency: number;
  /** |close − open| of the session over its range. */
  netMoveRatio: number;
  /** Separate visits to the top or bottom tenth of the range. */
  boundaryTouches: number;
  /** 0–1, higher = more range-like. Recorded, never used to filter. */
  score: number;
}

export interface AmdDay {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  instrument: string;
  state: AmdState;
  asiaStart: string;
  asiaEnd: string;
  londonEnd: string;
  dayEnd: string;
  asiaBars: number;
  asiaHigh: number;
  asiaLow: number;
  asiaMidpoint: number;
  asiaRangePips: number;
  /** Asian range over the daily ATR before the day; null without enough history. */
  asiaRangeAtr: number | null;
  quality: AsiaQuality | null;
  locked: boolean;
  /** Close time of the last candle seen for this day. */
  lastTime: string;
  sweeps: AmdSweep[];
  doubleSweep: boolean;
  distribution: AmdDistribution | null;
  accepted: { side: AmdSide; direction: AmdDirection; time: string; close: number; reason: "closes" | "distance" | "timeout" } | null;
  /** Measured from the first reclaim close, in its direction — with or without displacement. */
  reclaimOutcome: AmdOutcome | null;
  /** Measured from the distribution entry. */
  outcome: AmdOutcome | null;
  /** Measured from the acceptance close, in the breakout's direction. */
  continuationOutcome: AmdOutcome | null;
  /** High-impact news for either currency near the London action; null when no calendar was given. */
  newsNearby: boolean | null;
  abnormalVolatility: boolean;
  /** Largest London candle range over ATR, from the first sweep on. */
  maxRangeAtr: number;
  fvg: FvgZone | null;
  transitions: AmdTransition[];
}

export interface AmdNewsEvent { time: number; currency: string }

type Bar = { ms: number; open: number; high: number; low: number; close: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const TERMINAL: AmdState[] = ["DISTRIBUTION_CONFIRMED", "BREAKOUT_ACCEPTED", "NO_SWEEP", "EXPIRED", "INVALID"];

interface DayWork {
  day: AmdDay;
  dayMs: number;
  asia: Bar[];
  /** Candles from the Asian close on, for the FVG read. */
  after: Bar[];
  /** Index into `after` where the distribution's sweep began. */
  fvgFrom: number;
  active: AmdSweep | null;
  /** Candles processed since the active sweep's first candle / since its reclaim. */
  barsSinceSweep: number;
  barsSinceReclaim: number;
  trackers: Array<"reclaimOutcome" | "outcome" | "continuationOutcome">;
  actionMs: number[];
}

export class AsiaAmdMachine {
  readonly config: AmdConfig;
  private readonly pip: number;
  private readonly currencies: string[];
  private readonly news: number[] | null;
  private readonly barMs: number;
  private readonly days: DayWork[] = [];
  private current: DayWork | null = null;
  private lastMs = -Infinity;
  // Rolling statistics, always from candles before the one being judged.
  private atr: number | null = null;
  private prevClose: number | null = null;
  private bodies: number[] = [];
  private dailyTr: number[] = [];
  private dayAgg: { dayMs: number; high: number; low: number; close: number; bars: number } | null = null;
  private prevDayClose: number | null = null;

  constructor(readonly instrument: string, config: Partial<AmdConfig> = {}, news: AmdNewsEvent[] | null = null) {
    this.config = { ...AMD_DEFAULTS, ...config };
    this.pip = pipSizeFor(instrument);
    this.currencies = instrument.split("_");
    this.news = news
      ? news.filter((event) => this.currencies.includes(event.currency)).map((event) => event.time).sort((a, b) => a - b)
      : null;
    this.barMs = this.config.barMinutes * 60_000;
  }

  /** Feed one closed candle. Out-of-order or duplicate candles are ignored. */
  push(candle: Candle) {
    const ms = Date.parse(candle.time);
    if (!Number.isFinite(ms) || ms <= this.lastMs || candle.complete === false) return;
    this.lastMs = ms;
    const bar: Bar = { ms, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
    this.clock(ms);
    this.process(bar);
    this.clock(ms + this.barMs);
    this.updateStats(bar);
  }

  /** What is known now, as plain data (a deep copy). */
  snapshot(): AmdDay[] {
    return this.days.map((work) => structuredClone(work.day));
  }

  // ---- time-driven transitions -------------------------------------------

  private clock(t: number) {
    const work = this.current;
    if (!work) return;
    const { day } = work;
    const asiaEnd = work.dayMs + this.config.asiaEndHour * HOUR_MS;
    if (day.state === "ASIA_BUILDING" && t >= asiaEnd) this.lockAsia(work, t);
    if (day.state === "WAITING_FOR_SWEEP" && t >= work.dayMs + this.config.londonEndHour * HOUR_MS) {
      if (day.sweeps.length) this.transition(work, "EXPIRED", null, t, "London closed with no valid sequence");
      else this.transition(work, "NO_SWEEP", null, t, "London closed without a sweep");
    }
    if (!TERMINAL.includes(day.state) && t >= work.dayMs + this.config.dayEndHour * HOUR_MS) {
      if (work.active) work.active.status = work.active.status === "candidate" ? "expired" : "no-displacement";
      work.active = null;
      this.transition(work, "EXPIRED", null, t, "day ended unresolved");
    }
  }

  private lockAsia(work: DayWork, t: number) {
    const { day, asia } = work;
    day.locked = true;
    if (asia.length < this.config.minAsiaBars) {
      this.transition(work, "INVALID", null, t, `only ${asia.length} Asian candles`);
      return;
    }
    const range = day.asiaHigh - day.asiaLow;
    day.asiaMidpoint = (day.asiaHigh + day.asiaLow) / 2;
    const recent = this.dailyTr.slice(-this.config.dailyAtrDays);
    day.asiaRangeAtr = recent.length >= 5 ? range / (recent.reduce((sum, tr) => sum + tr, 0) / recent.length) : null;
    day.quality = asiaQuality(asia, day.asiaHigh, day.asiaLow, day.asiaRangeAtr);
    this.transition(work, "ASIA_LOCKED", null, t, `A frozen ${day.asiaLow}–${day.asiaHigh}`);
    this.transition(work, "WAITING_FOR_SWEEP", null, t, "watching London");
  }

  // ---- candle-driven transitions ------------------------------------------

  private process(bar: Bar) {
    const cfg = this.config;
    const dayMs = bar.ms - (bar.ms % DAY_MS);
    const offset = bar.ms - dayMs;
    if (offset >= cfg.asiaStartHour * HOUR_MS && offset < cfg.asiaEndHour * HOUR_MS) {
      if (!this.current || this.current.dayMs !== dayMs) this.openDay(dayMs, bar);
      const work = this.current!;
      work.asia.push(bar);
      work.day.asiaBars = work.asia.length;
      work.day.asiaHigh = Math.max(work.day.asiaHigh, bar.high);
      work.day.asiaLow = Math.min(work.day.asiaLow, bar.low);
      work.day.asiaMidpoint = (work.day.asiaHigh + work.day.asiaLow) / 2;
      work.day.asiaRangePips = (work.day.asiaHigh - work.day.asiaLow) / this.pip;
      work.day.lastTime = iso(bar.ms + this.barMs);
      return;
    }
    const work = this.current;
    if (!work || work.dayMs !== dayMs || offset >= cfg.dayEndHour * HOUR_MS) return;
    const { day } = work;
    if (day.state === "INVALID") return;
    day.lastTime = iso(bar.ms + this.barMs);
    work.after.push(bar);
    this.trackOutcomes(work, bar);
    if (TERMINAL.includes(day.state)) {
      if (day.state === "DISTRIBUTION_CONFIRMED") this.followDistribution(work, bar);
      return;
    }
    this.step(work, bar);
    // From the first sweep candle to the resolving one: how violent was it?
    if (day.sweeps.length && this.atr) {
      const range = bar.high - bar.low;
      day.maxRangeAtr = Math.max(day.maxRangeAtr, range / this.atr);
      if (range > cfg.abnormalRangeAtr * this.atr) day.abnormalVolatility = true;
    }
  }

  private step(work: DayWork, bar: Bar) {
    const { day } = work;
    if (day.state === "WAITING_FOR_SWEEP") {
      if (bar.ms >= work.dayMs + this.config.londonEndHour * HOUR_MS) return;
      const side = this.breachSide(day, bar);
      if (!side) return;
      this.startSweep(work, bar, side);
      this.judgeCandidate(work, bar);
      return;
    }
    if (day.state === "SWEEP_CANDIDATE") {
      work.barsSinceSweep += 1;
      this.extendSweep(work, bar);
      this.judgeCandidate(work, bar);
      return;
    }
    if (day.state === "WAITING_FOR_DISPLACEMENT") this.judgeDisplacement(work, bar);
  }

  private openDay(dayMs: number, bar: Bar) {
    const cfg = this.config;
    const day: AmdDay = {
      day: iso(dayMs).slice(0, 10),
      instrument: this.instrument,
      state: "ASIA_BUILDING",
      asiaStart: iso(bar.ms),
      asiaEnd: iso(dayMs + cfg.asiaEndHour * HOUR_MS),
      londonEnd: iso(dayMs + cfg.londonEndHour * HOUR_MS),
      dayEnd: iso(dayMs + cfg.dayEndHour * HOUR_MS),
      asiaBars: 0,
      asiaHigh: -Infinity,
      asiaLow: Infinity,
      asiaMidpoint: 0,
      asiaRangePips: 0,
      asiaRangeAtr: null,
      quality: null,
      locked: false,
      lastTime: iso(bar.ms + this.barMs),
      sweeps: [],
      doubleSweep: false,
      distribution: null,
      accepted: null,
      reclaimOutcome: null,
      outcome: null,
      continuationOutcome: null,
      newsNearby: this.news ? false : null,
      abnormalVolatility: false,
      maxRangeAtr: 0,
      fvg: null,
      transitions: [],
    };
    const work: DayWork = {
      day, dayMs, asia: [], after: [], fvgFrom: 0, active: null,
      barsSinceSweep: 0, barsSinceReclaim: 0, trackers: [], actionMs: [],
    };
    // A day that never got its Asian close (data ends) stays as it was.
    this.days.push(work);
    this.current = work;
    day.transitions.push({ barTime: iso(bar.ms), time: iso(bar.ms + this.barMs), from: "ASIA_BUILDING", to: "ASIA_BUILDING", note: "Asia opened" });
  }

  private breachSide(day: AmdDay, bar: Bar): AmdSide | "both" | null {
    const poke = this.config.minSweepPips * this.pip;
    const above = bar.high > day.asiaHigh + poke;
    const below = bar.low < day.asiaLow - poke;
    if (above && below) return "both";
    return above ? "high" : below ? "low" : null;
  }

  private startSweep(work: DayWork, bar: Bar, breach: AmdSide | "both") {
    const { day } = work;
    // One candle through both sides: record both, and judge the side it
    // closed nearer (a close inside reclaims both — the nearer side is the
    // one that close rejected hardest). Direction still waits for a reclaim
    // and, by default, displacement.
    if (breach === "both") {
      const nearLow = Math.abs(bar.close - day.asiaLow) <= Math.abs(bar.close - day.asiaHigh);
      const other: AmdSide = nearLow ? "high" : "low";
      const skipped = this.newSweep(work, bar, other);
      skipped.status = "superseded";
      day.sweeps.push(skipped);
      breach = nearLow ? "low" : "high";
    }
    const sweep = this.newSweep(work, bar, breach);
    day.sweeps.push(sweep);
    work.active = sweep;
    work.barsSinceSweep = 0;
    work.actionMs.push(bar.ms);
    if (!day.doubleSweep && new Set(day.sweeps.map((s) => s.side)).size === 2) {
      day.doubleSweep = true;
      day.transitions.push({ barTime: iso(bar.ms), time: iso(bar.ms + this.barMs), from: day.state, to: day.state, note: "DOUBLE_SWEEP: both sides of Asia taken" });
    }
    const level = breach === "low" ? day.asiaLow : day.asiaHigh;
    this.transition(work, "SWEEP_CANDIDATE", bar.ms, bar.ms + this.barMs, `M? ${breach === "low" ? "below Asia low" : "above Asia high"} ${level}, ${sweep.depthPips.toFixed(1)}p deep`);
  }

  private newSweep(work: DayWork, bar: Bar, side: AmdSide): AmdSweep {
    const { day } = work;
    const extreme = side === "low" ? bar.low : bar.high;
    return {
      side,
      direction: side === "low" ? "long" : "short",
      startTime: iso(bar.ms),
      extreme,
      extremeTime: iso(bar.ms),
      depthPips: (side === "low" ? day.asiaLow - extreme : extreme - day.asiaHigh) / this.pip,
      outsideCloses: 0,
      status: "candidate",
      acceptedReason: null,
      reclaimTime: null,
      reclaimClose: null,
      barsToReclaim: null,
      endTime: iso(bar.ms + this.barMs),
      high: bar.high,
      low: bar.low,
    };
  }

  private extendSweep(work: DayWork, bar: Bar) {
    const sweep = work.active!;
    const { day } = work;
    sweep.endTime = iso(bar.ms + this.barMs);
    sweep.high = Math.max(sweep.high, bar.high);
    sweep.low = Math.min(sweep.low, bar.low);
    if (sweep.side === "low" ? bar.low < sweep.extreme : bar.high > sweep.extreme) {
      sweep.extreme = sweep.side === "low" ? bar.low : bar.high;
      sweep.extremeTime = iso(bar.ms);
      sweep.depthPips = (sweep.side === "low" ? day.asiaLow - sweep.extreme : sweep.extreme - day.asiaHigh) / this.pip;
    }
  }

  /** A sweep candidate's candle has closed: reclaimed, accepted, or still open. */
  private judgeCandidate(work: DayWork, bar: Bar) {
    const cfg = this.config;
    const { day } = work;
    const sweep = work.active!;
    const level = sweep.side === "low" ? day.asiaLow : day.asiaHigh;
    const inside = sweep.side === "low" ? bar.close > level : bar.close < level;
    if (inside) {
      sweep.status = "reclaimed";
      sweep.reclaimTime = iso(bar.ms + this.barMs);
      sweep.reclaimClose = bar.close;
      sweep.barsToReclaim = work.barsSinceSweep;
      work.barsSinceReclaim = 0;
      work.actionMs.push(bar.ms);
      this.transition(work, "RECLAIM_CONFIRMED", bar.ms, bar.ms + this.barMs, `M closed back ${sweep.side === "low" ? "above" : "below"} ${level} → ${sweep.direction}`);
      if (!day.reclaimOutcome) this.startTracker(work, "reclaimOutcome", sweep.direction, bar);
      const ratio = this.bodyRatio(bar);
      if (cfg.reclaimMode === "CLOSE") {
        this.confirm(work, bar, ratio ?? 0, "reclaim close");
      } else if (this.isDisplacement(bar, sweep.direction, ratio)) {
        this.confirm(work, bar, ratio!, "reclaim candle is the displacement");
      } else {
        this.transition(work, "WAITING_FOR_DISPLACEMENT", bar.ms, bar.ms + this.barMs, "waiting for displacement");
      }
      return;
    }
    const outside = sweep.side === "low" ? bar.close < level : bar.close > level;
    sweep.outsideCloses = outside ? sweep.outsideCloses + 1 : 0;
    const distance = sweep.side === "low" ? level - bar.close : bar.close - level;
    let reason: "closes" | "distance" | "timeout" | null = null;
    if (sweep.outsideCloses >= cfg.outsideClosesRequired) reason = "closes";
    else if (this.atr && distance >= cfg.acceptanceDistanceAtr * this.atr) reason = "distance";
    else if (work.barsSinceSweep >= cfg.reclaimTimeoutBars) reason = "timeout";
    if (!reason) return;
    sweep.status = "accepted";
    sweep.acceptedReason = reason;
    work.active = null;
    const direction: AmdDirection = sweep.side === "low" ? "short" : "long";
    day.accepted = { side: sweep.side, direction, time: iso(bar.ms + this.barMs), close: bar.close, reason };
    work.actionMs.push(bar.ms);
    this.startTracker(work, "continuationOutcome", direction, bar);
    this.transition(work, "BREAKOUT_ACCEPTED", bar.ms, bar.ms + this.barMs, `held outside (${reason}) → continuation ${direction}`);
  }

  /** After a reclaim: displacement, a failed reclaim, the other side, or a timeout. */
  private judgeDisplacement(work: DayWork, bar: Bar) {
    const cfg = this.config;
    const { day } = work;
    const sweep = work.active!;
    work.barsSinceReclaim += 1;
    // A deeper wick that closes back inside moves the extreme (the stop), not the state.
    this.extendSweep(work, bar);
    const ratio = this.bodyRatio(bar);
    const level = sweep.side === "low" ? day.asiaLow : day.asiaHigh;
    if (this.isDisplacement(bar, sweep.direction, ratio)) {
      this.confirm(work, bar, ratio!, "displacement");
      return;
    }
    const londonOpen = bar.ms < work.dayMs + cfg.londonEndHour * HOUR_MS;
    // Closed back outside the swept side: the reclaim failed; a new sweep of
    // the same side starts here.
    const reBroken = sweep.side === "low" ? bar.close < level : bar.close > level;
    // Traded through the other side without displacing: that side is swept now.
    const breach = this.breachSide(day, bar);
    const opposite = breach === "both" || (breach !== null && breach !== sweep.side);
    if (reBroken || opposite) {
      sweep.status = reBroken ? "re-broken" : "superseded";
      work.active = null;
      this.transition(work, "WAITING_FOR_SWEEP", bar.ms, bar.ms + this.barMs, reBroken ? "reclaim failed: closed back outside" : "other side swept before displacement");
      if (!londonOpen) {
        this.transition(work, "EXPIRED", bar.ms, bar.ms + this.barMs, "reclaim failed after London");
        return;
      }
      this.startSweep(work, bar, reBroken ? sweep.side : (sweep.side === "low" ? "high" : "low"));
      this.judgeCandidate(work, bar);
      return;
    }
    if (work.barsSinceReclaim >= cfg.displacementTimeoutBars) {
      sweep.status = "no-displacement";
      work.active = null;
      if (londonOpen) this.transition(work, "WAITING_FOR_SWEEP", bar.ms, bar.ms + this.barMs, "no displacement in time; re-armed");
      else this.transition(work, "EXPIRED", bar.ms, bar.ms + this.barMs, "no displacement in time");
    }
  }

  private confirm(work: DayWork, bar: Bar, bodyRatio: number, note: string) {
    const { day } = work;
    const sweep = work.active!;
    sweep.status = "distribution";
    const long = sweep.direction === "long";
    const target = long ? day.asiaHigh : day.asiaLow;
    const entry = bar.close;
    const risk = long ? entry - sweep.extreme : sweep.extreme - entry;
    const reward = long ? target - entry : entry - target;
    const beyondMid = long ? entry >= day.asiaMidpoint : entry <= day.asiaMidpoint;
    const beyondTarget = long ? entry >= target : entry <= target;
    day.distribution = {
      direction: sweep.direction,
      sweepSide: sweep.side,
      barTime: iso(bar.ms),
      time: iso(bar.ms + this.barMs),
      entry,
      bodyRatio,
      stop: sweep.extreme,
      target,
      midpoint: day.asiaMidpoint,
      riskPips: risk / this.pip,
      rewardPips: reward / this.pip,
      rr: risk > 0 && reward > 0 ? reward / risk : null,
      high: bar.high,
      low: bar.low,
      best: long ? bar.high : bar.low,
      endTime: iso(bar.ms + this.barMs),
      midpointReached: beyondMid ? "already" : "no",
      oppositeReached: beyondTarget ? "already" : "no",
      minutesToOpposite: beyondTarget ? 0 : null,
      structural: risk > 0 && reward > 0 ? { result: "open", r: 0 } : { result: "n/a", r: null },
    };
    work.active = null;
    work.actionMs.push(bar.ms);
    work.fvgFrom = Math.max(0, work.after.findIndex((b) => b.ms >= Date.parse(sweep.startTime)));
    this.startTracker(work, "outcome", sweep.direction, bar);
    this.transition(work, "DISTRIBUTION_CONFIRMED", bar.ms, bar.ms + this.barMs, `D ${sweep.direction} (${note}), entry ${entry}`);
    this.refreshFvg(work);
  }

  /** After the signal: how far the move has gone, and what it reached. Analytics only. */
  private followDistribution(work: DayWork, bar: Bar) {
    const d = work.day.distribution!;
    const long = d.direction === "long";
    if (d.midpointReached === "no" && (long ? bar.high >= d.midpoint : bar.low <= d.midpoint)) d.midpointReached = "reached";
    if (d.oppositeReached === "no" && (long ? bar.high >= d.target : bar.low <= d.target)) {
      d.oppositeReached = "reached";
      d.minutesToOpposite = (bar.ms + this.barMs - Date.parse(d.time)) / 60_000;
    }
    // The move is followed candle by candle until the target or the stop is
    // hit (or the day ends): it grows, it is never drawn ahead of time.
    if (d.structural.result === "open" || d.structural.result === "n/a") {
      d.endTime = iso(bar.ms + this.barMs);
      d.best = long ? Math.max(d.best, bar.high) : Math.min(d.best, bar.low);
    }
    if (d.structural.result === "open") {
      const risk = Math.abs(d.entry - d.stop);
      const stopped = long ? bar.low <= d.stop : bar.high >= d.stop;
      const hit = long ? bar.high >= d.target : bar.low <= d.target;
      if (stopped) d.structural = { result: "loss", r: -1 };
      else if (hit) d.structural = { result: "win", r: Math.abs(d.target - d.entry) / risk };
      else d.structural = { result: "open", r: (long ? bar.close - d.entry : d.entry - bar.close) / risk };
    }
    this.refreshFvg(work);
  }

  private refreshFvg(work: DayWork) {
    const { day } = work;
    if (!day.distribution) return;
    const minGap = Math.max(this.pip, 0.05 * (day.asiaHigh - day.asiaLow));
    day.fvg = firstFvg(work.after, work.fvgFrom, work.after.length, day.distribution.direction, minGap, this.barMs);
  }

  private startTracker(work: DayWork, key: "reclaimOutcome" | "outcome" | "continuationOutcome", direction: AmdDirection, bar: Bar) {
    work.day[key] = {
      direction,
      startTime: iso(bar.ms + this.barMs),
      entry: bar.close,
      mfePips: 0,
      maePips: 0,
      race: Object.fromEntries(this.config.outcomePips.map((x) => [x, "open"])) as AmdOutcome["race"],
      bars: 0,
    };
    // The candle that started it is not part of what came after it.
    work.trackers.push(key);
  }

  private trackOutcomes(work: DayWork, bar: Bar) {
    for (const key of work.trackers) {
      const outcome = work.day[key];
      if (!outcome || Date.parse(outcome.startTime) > bar.ms) continue;
      const long = outcome.direction === "long";
      const fav = (long ? bar.high - outcome.entry : outcome.entry - bar.low) / this.pip;
      const adv = (long ? outcome.entry - bar.low : bar.high - outcome.entry) / this.pip;
      outcome.mfePips = Math.max(outcome.mfePips, fav);
      outcome.maePips = Math.max(outcome.maePips, adv);
      outcome.bars += 1;
      for (const x of this.config.outcomePips) {
        if (outcome.race[x] !== "open") continue;
        const win = fav >= x;
        const loss = adv >= x;
        if (win || loss) outcome.race[x] = win && loss ? "both" : win ? "win" : "loss";
      }
    }
  }

  private transition(work: DayWork, to: AmdState, barMs: number | null, knownMs: number, note: string) {
    const { day } = work;
    day.transitions.push({ barTime: barMs === null ? null : iso(barMs), time: iso(knownMs), from: day.state, to, note });
    day.state = to;
    if (this.news && day.locked) {
      // Around the London action (first sweep to the latest decision), or the
      // whole London window on a day without one. Scheduled events are known
      // in advance, so this is not lookahead.
      const window = this.config.newsWindowMinutes * 60_000;
      const from = (work.actionMs[0] ?? work.dayMs + this.config.asiaEndHour * HOUR_MS) - window;
      const until = (work.actionMs.length ? work.actionMs.at(-1)! + this.barMs : work.dayMs + this.config.londonEndHour * HOUR_MS) + window;
      day.newsNearby = this.news.some((t) => t >= from && t <= until);
    }
  }

  // ---- displacement and rolling statistics --------------------------------

  /** Body over the average body of the previous candles (null while warming up). */
  private bodyRatio(bar: Bar): number | null {
    if (this.bodies.length < Math.min(5, this.config.bodyLookback)) return null;
    const average = this.bodies.reduce((sum, body) => sum + body, 0) / this.bodies.length;
    return average > 0 ? Math.abs(bar.close - bar.open) / average : null;
  }

  private isDisplacement(bar: Bar, direction: AmdDirection, ratio: number | null) {
    if (ratio === null || ratio < this.config.displacementBodyMult) return false;
    const prev = this.prevClose ?? bar.open;
    return direction === "long"
      ? bar.close > bar.open && bar.close > prev
      : bar.close < bar.open && bar.close < prev;
  }

  private updateStats(bar: Bar) {
    const tr = this.prevClose === null
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - this.prevClose), Math.abs(bar.low - this.prevClose));
    this.atr = this.atr === null ? tr : (this.atr * (this.config.atrPeriod - 1) + tr) / this.config.atrPeriod;
    this.prevClose = bar.close;
    this.bodies.push(Math.abs(bar.close - bar.open));
    if (this.bodies.length > this.config.bodyLookback) this.bodies.shift();

    const dayMs = bar.ms - (bar.ms % DAY_MS);
    if (this.dayAgg && this.dayAgg.dayMs !== dayMs) {
      // Weekend stubs (a few Sunday-evening candles) are not a day.
      if (this.dayAgg.bars >= 40) {
        const { high, low } = this.dayAgg;
        const prev = this.prevDayClose;
        this.dailyTr.push(prev === null ? high - low : Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
        if (this.dailyTr.length > 60) this.dailyTr.shift();
      }
      this.prevDayClose = this.dayAgg.close;
      this.dayAgg = null;
    }
    if (!this.dayAgg) this.dayAgg = { dayMs, high: bar.high, low: bar.low, close: bar.close, bars: 0 };
    this.dayAgg.high = Math.max(this.dayAgg.high, bar.high);
    this.dayAgg.low = Math.min(this.dayAgg.low, bar.low);
    this.dayAgg.close = bar.close;
    this.dayAgg.bars += 1;
  }
}

function asiaQuality(asia: Bar[], high: number, low: number, rangeAtr: number | null): AsiaQuality {
  const range = high - low;
  let path = Math.abs(asia[0]!.close - asia[0]!.open);
  for (let i = 1; i < asia.length; i += 1) path += Math.abs(asia[i]!.close - asia[i - 1]!.close);
  const net = Math.abs(asia.at(-1)!.close - asia[0]!.open);
  const efficiency = path > 0 ? net / path : 0;
  const netMoveRatio = range > 0 ? net / range : 0;
  const band = 0.1 * range;
  let touches = 0;
  let inTop = false;
  let inBottom = false;
  for (const bar of asia) {
    const top = bar.high >= high - band;
    const bottom = bar.low <= low + band;
    if (top && !inTop) touches += 1;
    if (bottom && !inBottom) touches += 1;
    inTop = top;
    inBottom = bottom;
  }
  const parts = [1 - efficiency, 1 - netMoveRatio, Math.min(1, touches / 6)];
  if (rangeAtr !== null) parts.push(Math.max(0, Math.min(1, 1 - rangeAtr)));
  return { efficiency, netMoveRatio, boundaryTouches: touches, score: parts.reduce((sum, p) => sum + p, 0) / parts.length };
}

export interface AmdOptions {
  config?: Partial<AmdConfig>;
  news?: AmdNewsEvent[] | null;
}

/**
 * Run the machine over candles in time order and return what it knows after
 * the last closed one. Incomplete (still-forming) candles are skipped.
 */
export function computeAmdDays(candles: Candle[], instrument: string, options: AmdOptions = {}): AmdDay[] {
  const machine = new AsiaAmdMachine(instrument, options.config, options.news ?? null);
  const ordered = [...candles].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  for (const candle of ordered) machine.push(candle);
  return machine.snapshot();
}
