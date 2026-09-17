import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";
import { calculateAtrValues } from "@/lib/strategy/indicators";
import {
  computeSupportResistanceLevels,
  type SupportResistanceLevels,
} from "@/lib/strategy/support-resistance";

/**
 * Stage 2 S/R structure + migration engine.
 *
 * candles → existing S/R levels → snapshot/history → migration → range width →
 * internal-swing distances. Everything here is deterministic and UI-free so it
 * can be reused later for realtime alerts while a trade is active. No AI.
 *
 * It does NOT redesign the S/R algorithm — it tracks and interprets the levels
 * `computeSupportResistanceLevels` already produces:
 *   supportRange     = the outer range low  (rangeLow)
 *   resistanceRange  = the outer range high (rangeHigh)
 *   supportSwing     = nearest confirmed swing low below price (swingLow)
 *   resistanceSwing  = nearest confirmed swing high above price (swingHigh)
 */

export type MigrationDirection = "UP" | "DOWN" | "FLAT";
export type OverallMigration = "MIGRATING_UP" | "MIGRATING_DOWN" | "MIXED" | "STABLE";
export type RangeWidthClass = "TOO_TIGHT" | "TIGHT" | "NORMAL" | "WIDE" | "EXTREME";
export type SrLevelName = "supportRange" | "resistanceRange" | "supportSwing" | "resistanceSwing";

/** ---- Tunable thresholds (documented so a read can be checked). ---- */
export const SR_STRUCTURE_THRESHOLDS = {
  /**
   * A level must move at least this fraction of ATR14 to count as migrated.
   * Below it the change is an insignificant recalculation and reads as FLAT.
   * ATR-normalized so it is volatility-aware across pairs and regimes.
   */
  migrationFlatAtr: 0.25,
  /**
   * Outer range width in ATR14 units, classified by ascending boundaries:
   *   < tooTightAtr → TOO_TIGHT (barely wider than a candle; usually noise)
   *   < tightAtr    → TIGHT     (usable only if reward clears the spread)
   *   < wideAtr     → NORMAL    (opposite boundary is a realistic target)
   *   < extremeAtr  → WIDE
   *   ≥ extremeAtr  → EXTREME
   * Initial estimates — easy to tune here, and the live rangeWidthAtr is
   * exposed in debug so real values can guide tuning.
   */
  tooTightAtr: 1.5,
  tightAtr: 3,
  wideAtr: 6,
  extremeAtr: 10,
  /** How many completed candles back the derived "previous" snapshot looks. */
  migrationStepBars: 4,
} as const;

export type SrStructureThresholds = { -readonly [K in keyof typeof SR_STRUCTURE_THRESHOLDS]: number };

export interface SrSnapshot {
  timestamp: string;
  timeframe: string;
  /** Price the levels were measured against (last completed close). */
  current: number;
  supportRange: number;
  resistanceRange: number;
  supportSwing: number | null;
  resistanceSwing: number | null;
  /** ATR14 in price at this snapshot, for volatility-aware comparisons. */
  atr: number;
}

export interface LevelMigration {
  level: SrLevelName;
  current: number | null;
  previous: number | null;
  changePips: number | null;
  changeAtr: number | null;
  direction: MigrationDirection;
}

export interface LevelDistance {
  level: SrLevelName;
  price: number | null;
  distancePips: number | null;
  distanceAtr: number | null;
}

export interface SrStructureDebug {
  pair: string;
  timeframe: string;
  currentSupportRange: number;
  previousSupportRange: number | null;
  supportRangeMigration: MigrationDirection;
  currentResistanceRange: number;
  previousResistanceRange: number | null;
  resistanceRangeMigration: MigrationDirection;
  currentSupportSwing: number | null;
  currentResistanceSwing: number | null;
  supportSwingMigration: MigrationDirection;
  resistanceSwingMigration: MigrationDirection;
  overallMigration: OverallMigration;
  rangeWidthPips: number;
  rangeWidthAtr: number;
  rangeWidthClass: RangeWidthClass;
  current: number;
  distanceToSupportRangePips: number | null;
  distanceToResistanceRangePips: number | null;
  distanceToSupportSwingPips: number | null;
  distanceToResistanceSwingPips: number | null;
  atrPips: number;
}

export interface SrStructureAssessment {
  instrument: MajorInstrument;
  timeframe: string;
  /** Structure at the moment of analysis. Callers must never mutate this. */
  frozen: SrSnapshot;
  /** Latest recalculated structure. Equal to `frozen` at analysis time; a live
   *  monitor updates this as candles arrive while `frozen` stays fixed. */
  live: SrSnapshot;
  /** The comparison snapshot migration was measured against (derived or fed). */
  previous: SrSnapshot | null;
  migrations: Record<SrLevelName, LevelMigration>;
  overallMigration: OverallMigration;
  rangeWidthPips: number;
  rangeWidthAtr: number;
  rangeWidthClass: RangeWidthClass;
  distances: Record<SrLevelName, LevelDistance>;
  debug: SrStructureDebug;
}

const round = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** ATR14 of the completed series, in price. Falls back to a mean range. */
export function atr14Of(completed: Candle[]): number {
  const values = calculateAtrValues(completed, 14);
  const last = [...values].reverse().find((value): value is number => value !== null);
  if (last && last > 0) return last;
  // Too few candles for a 14-period ATR: mean candle range is a safe stand-in.
  if (!completed.length) return 0;
  return completed.reduce((sum, candle) => sum + (candle.high - candle.low), 0) / completed.length;
}

/** Build a normalized snapshot from raw S/R levels. */
export function snapshotFromLevels(
  levels: SupportResistanceLevels,
  meta: { timestamp: string; timeframe: string; atr: number },
): SrSnapshot {
  return {
    timestamp: meta.timestamp,
    timeframe: meta.timeframe,
    current: levels.current,
    supportRange: levels.rangeLow,
    resistanceRange: levels.rangeHigh,
    supportSwing: levels.swingLow,
    resistanceSwing: levels.swingHigh,
    atr: meta.atr,
  };
}

/** Classify one level's movement, ATR-normalized so tiny recalcs read FLAT. */
export function classifyLevelMigration(
  level: SrLevelName,
  current: number | null,
  previous: number | null,
  atr: number,
  pip: number,
  migrationFlatAtr: number = SR_STRUCTURE_THRESHOLDS.migrationFlatAtr,
): LevelMigration {
  if (current === null || previous === null || atr <= 0) {
    return { level, current, previous, changePips: null, changeAtr: null, direction: "FLAT" };
  }
  const change = current - previous;
  const changeAtr = change / atr;
  const direction: MigrationDirection =
    Math.abs(changeAtr) < migrationFlatAtr
      ? "FLAT"
      : changeAtr > 0
        ? "UP"
        : "DOWN";
  return {
    level,
    current,
    previous,
    changePips: round(change / pip, 1),
    changeAtr: round(changeAtr, 3),
    direction,
  };
}

/** Combine the per-level directions into one structure verdict. */
export function classifyOverallMigration(migrations: LevelMigration[]): OverallMigration {
  const measured = migrations.filter((migration) => migration.direction !== "FLAT" || migration.changeAtr !== null);
  const up = measured.filter((migration) => migration.direction === "UP").length;
  const down = measured.filter((migration) => migration.direction === "DOWN").length;
  if (up > 0 && down === 0) return "MIGRATING_UP";
  if (down > 0 && up === 0) return "MIGRATING_DOWN";
  if (up > 0 && down > 0) return "MIXED";
  return "STABLE";
}

/** TOO_TIGHT / TIGHT / NORMAL / WIDE / EXTREME from the outer range width in ATR14 units. */
export function classifyRangeWidth(
  rangeWidthAtr: number,
  thresholds: SrStructureThresholds = SR_STRUCTURE_THRESHOLDS,
): RangeWidthClass {
  const t = thresholds;
  if (rangeWidthAtr >= t.extremeAtr) return "EXTREME";
  if (rangeWidthAtr >= t.wideAtr) return "WIDE";
  if (rangeWidthAtr >= t.tightAtr) return "NORMAL";
  if (rangeWidthAtr >= t.tooTightAtr) return "TIGHT";
  return "TOO_TIGHT";
}

function distanceFor(
  level: SrLevelName,
  price: number | null,
  current: number,
  atr: number,
  pip: number,
): LevelDistance {
  if (price === null) {
    return { level, price: null, distancePips: null, distanceAtr: null };
  }
  const distance = Math.abs(price - current);
  return {
    level,
    price,
    distancePips: round(distance / pip, 1),
    distanceAtr: atr > 0 ? round(distance / atr, 2) : null,
  };
}

/**
 * A small, reusable ring buffer of recent snapshots keyed by
 * `${instrument}:${timeframe}`. Built for the later realtime stage: a monitor
 * pushes each recalculated snapshot and can read the most recent comparable one.
 * The Analyze-on-click path does not depend on it (it derives `previous` from
 * the same candle fetch), but the store is available so history is reusable.
 */
export class SrHistory {
  private readonly byKey = new Map<string, SrSnapshot[]>();
  constructor(private readonly limit = 64) {}

  private keyOf(instrument: MajorInstrument, timeframe: string) {
    return `${instrument}:${timeframe}`;
  }

  push(instrument: MajorInstrument, snapshot: SrSnapshot): void {
    const key = this.keyOf(instrument, snapshot.timeframe);
    const list = this.byKey.get(key) ?? [];
    list.push(snapshot);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.byKey.set(key, list);
    void instrument;
  }

  recent(instrument: MajorInstrument, timeframe: string): SrSnapshot[] {
    return this.byKey.get(this.keyOf(instrument, timeframe)) ?? [];
  }

  /** The most recent snapshot at least `minGapMs` older than `beforeIso`. */
  previousComparable(
    instrument: MajorInstrument,
    timeframe: string,
    beforeIso: string,
    minGapMs = 0,
  ): SrSnapshot | null {
    const before = Date.parse(beforeIso);
    const list = this.recent(instrument, timeframe);
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index]!;
      if (before - Date.parse(candidate.timestamp) >= minGapMs) return candidate;
    }
    return null;
  }
}

/**
 * The one entry point. Feed it a completed-or-forming M15 series and it returns
 * the full S/R structure read: current (frozen) levels, migration vs a previous
 * snapshot, outer-range width classification, and internal-swing distances.
 *
 * `previousSnapshot` lets a realtime monitor supply the last real snapshot;
 * when omitted, `previous` is derived deterministically from the same candles
 * (the S/R as it stood `migrationStepBars` completed candles ago).
 */
export function analyzeSrStructure(input: {
  candles: Candle[];
  instrument: MajorInstrument;
  timeframe?: string;
  atr14?: number;
  previousSnapshot?: SrSnapshot | null;
  migrationStepBars?: number;
  /** Timeframe-profile overrides (range-width boundaries, migration floor). */
  thresholds?: Partial<SrStructureThresholds>;
}): SrStructureAssessment | null {
  const { instrument } = input;
  const t: SrStructureThresholds = { ...SR_STRUCTURE_THRESHOLDS, ...input.thresholds };
  const timeframe = input.timeframe ?? "M15";
  const stepBars = input.migrationStepBars ?? t.migrationStepBars;
  const pip = pipSizeFor(instrument);

  const completed = input.candles.filter((candle) => candle.complete !== false);
  const currentLevels = computeSupportResistanceLevels(completed, instrument);
  if (!currentLevels) return null;

  const atr = input.atr14 !== undefined ? input.atr14 : atr14Of(completed);
  const timestamp = completed.at(-1)?.time ?? new Date().toISOString();
  const frozen = snapshotFromLevels(currentLevels, { timestamp, timeframe, atr });
  // Frozen and live are the same object-shape at analysis time but distinct
  // values, so a later monitor can advance `live` while `frozen` stays put.
  const live: SrSnapshot = { ...frozen };

  // Previous: an explicit realtime snapshot, else derived from the same fetch.
  let previous: SrSnapshot | null = input.previousSnapshot ?? null;
  if (!previous && completed.length > stepBars) {
    const priorLevels = computeSupportResistanceLevels(completed.slice(0, -stepBars), instrument);
    if (priorLevels) {
      previous = snapshotFromLevels(priorLevels, {
        timestamp: completed.at(-1 - stepBars)?.time ?? timestamp,
        timeframe,
        atr: atr14Of(completed.slice(0, -stepBars)),
      });
    }
  }

  const migrationFor = (level: SrLevelName, current: number | null, prior: number | null) =>
    classifyLevelMigration(level, current, prior, atr, pip, t.migrationFlatAtr);
  const migrations: Record<SrLevelName, LevelMigration> = {
    supportRange: migrationFor("supportRange", frozen.supportRange, previous?.supportRange ?? null),
    resistanceRange: migrationFor("resistanceRange", frozen.resistanceRange, previous?.resistanceRange ?? null),
    supportSwing: migrationFor("supportSwing", frozen.supportSwing, previous?.supportSwing ?? null),
    resistanceSwing: migrationFor("resistanceSwing", frozen.resistanceSwing, previous?.resistanceSwing ?? null),
  };
  const overallMigration = classifyOverallMigration(Object.values(migrations));

  const rangeWidth = frozen.resistanceRange - frozen.supportRange;
  const rangeWidthPips = round(rangeWidth / pip, 1);
  const rangeWidthAtr = atr > 0 ? round(rangeWidth / atr, 2) : 0;
  const rangeWidthClass = classifyRangeWidth(rangeWidthAtr, t);

  const distances: Record<SrLevelName, LevelDistance> = {
    supportRange: distanceFor("supportRange", frozen.supportRange, frozen.current, atr, pip),
    resistanceRange: distanceFor("resistanceRange", frozen.resistanceRange, frozen.current, atr, pip),
    supportSwing: distanceFor("supportSwing", frozen.supportSwing, frozen.current, atr, pip),
    resistanceSwing: distanceFor("resistanceSwing", frozen.resistanceSwing, frozen.current, atr, pip),
  };

  const debug: SrStructureDebug = {
    pair: instrument,
    timeframe,
    currentSupportRange: frozen.supportRange,
    previousSupportRange: previous?.supportRange ?? null,
    supportRangeMigration: migrations.supportRange.direction,
    currentResistanceRange: frozen.resistanceRange,
    previousResistanceRange: previous?.resistanceRange ?? null,
    resistanceRangeMigration: migrations.resistanceRange.direction,
    currentSupportSwing: frozen.supportSwing,
    currentResistanceSwing: frozen.resistanceSwing,
    supportSwingMigration: migrations.supportSwing.direction,
    resistanceSwingMigration: migrations.resistanceSwing.direction,
    overallMigration,
    rangeWidthPips,
    rangeWidthAtr,
    rangeWidthClass,
    current: frozen.current,
    distanceToSupportRangePips: distances.supportRange.distancePips,
    distanceToResistanceRangePips: distances.resistanceRange.distancePips,
    distanceToSupportSwingPips: distances.supportSwing.distancePips,
    distanceToResistanceSwingPips: distances.resistanceSwing.distancePips,
    atrPips: atr > 0 ? round(atr / pip, 1) : 0,
  };

  return {
    instrument,
    timeframe,
    frozen,
    live,
    previous,
    migrations,
    overallMigration,
    rangeWidthPips,
    rangeWidthAtr,
    rangeWidthClass,
    distances,
    debug,
  };
}
