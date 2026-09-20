import type { Candle, MajorInstrument } from "@/types/forex";
import { pipSizeFor } from "@/lib/instruments/catalog";

/**
 * 4H Frozen S/R — visual only.
 *
 * UTC blocks: 00–04, 04–08, 08–12, 12–16, 16–20, 20–00.
 *
 * At each block open T, Support / Resistance / Midpoint are the low / high /
 * midpoint of completed M15 candles whose open is in [T − 4h, T) — the prior
 * UTC window only. Current-block candles (open ≥ T) never enter the calc.
 * Those three prices are frozen for the whole [T, T + 4h) use window.
 */

const BLOCK_MS = 4 * 60 * 60 * 1000;

export type Frozen4hTrend = "bullish" | "bearish" | "flat";
export type Frozen4hAlign = "long" | "short" | "opposed";

export interface Frozen4hBlock {
  /** UTC ms at use-block open (inclusive). */
  blockStartMs: number;
  /** UTC ms at next block open (exclusive). */
  blockEndMs: number;
  /** First M15 open time in the use block (line start). */
  startTime: string;
  /** Last M15 open time currently in the use block (line end). */
  endTime: string;
  /** First / last M15 of the SOURCE window that defined R/S (for verify). */
  sourceStartTime: string;
  sourceEndTime: string;
  resistance: number;
  support: number;
  midpoint: number;
  rangePips: number;
  /** How many completed M15 bars formed the source window. */
  sourceBarCount: number;
  prevTrend: Frozen4hTrend;
  align: Frozen4hAlign;
  setup510: boolean;
  startDistPips: number;
  blockLabel: string;
}

function candleOpenMs(candle: Candle): number {
  return Date.parse(candle.time);
}

/** Floor a UTC instant to the 00/04/08/12/16/20 block open. */
export function utc4hFloor(ms: number): number {
  return Math.floor(ms / BLOCK_MS) * BLOCK_MS;
}

function completedM15(candles: Candle[]): Candle[] {
  return candles
    .filter((candle) => candle.complete !== false && Number.isFinite(candleOpenMs(candle)))
    .slice()
    .sort((left, right) => candleOpenMs(left) - candleOpenMs(right));
}

function blockLabelFromStartMs(startMs: number): string {
  const start = new Date(startMs);
  const end = new Date(startMs + BLOCK_MS);
  const hh = (d: Date) => String(d.getUTCHours()).padStart(2, "0");
  return `${hh(start)}:00–${hh(end)}:00 UTC`;
}

function candlesInWindow(
  completed: Candle[],
  startMs: number,
  endMs: number,
): Candle[] {
  return completed.filter((candle) => {
    const open = candleOpenMs(candle);
    return open >= startMs && open < endMs;
  });
}

function buildBlockAt(
  blockStartMs: number,
  completed: Candle[],
  instrument: MajorInstrument,
): Frozen4hBlock | null {
  const blockEndMs = blockStartMs + BLOCK_MS;
  const sourceStartMs = blockStartMs - BLOCK_MS;

  // STRICT: only the previous UTC 4H window. Never open >= blockStartMs.
  const source = candlesInWindow(completed, sourceStartMs, blockStartMs);
  if (source.length === 0) return null;

  const use = candlesInWindow(completed, blockStartMs, blockEndMs);
  // Block must have started printing before we draw / freeze it.
  if (use.length === 0) return null;

  const resistance = Math.max(...source.map((candle) => candle.high));
  const support = Math.min(...source.map((candle) => candle.low));
  if (!Number.isFinite(resistance) || !Number.isFinite(support) || resistance < support) {
    return null;
  }

  const midpoint = support + (resistance - support) * 0.5;
  const pip = pipSizeFor(instrument);
  const rangePips = pip > 0 ? (resistance - support) / pip : 0;

  const prevOpen = source[0]!.open;
  const prevClose = source[source.length - 1]!.close;
  const prevTrend: Frozen4hTrend =
    prevClose > prevOpen ? "bullish" : prevClose < prevOpen ? "bearish" : "flat";

  const newOpen = use[0]!.open;
  const startDistPips = pip > 0 ? Math.abs(newOpen - midpoint) / pip : 0;

  let align: Frozen4hAlign = "opposed";
  if (prevTrend === "bullish" && newOpen < midpoint) align = "long";
  else if (prevTrend === "bearish" && newOpen > midpoint) align = "short";

  const setup510 = align !== "opposed" && startDistPips >= 5 && startDistPips < 10;

  return {
    blockStartMs,
    blockEndMs,
    startTime: use[0]!.time,
    endTime: use[use.length - 1]!.time,
    sourceStartTime: source[0]!.time,
    sourceEndTime: source[source.length - 1]!.time,
    resistance,
    support,
    midpoint,
    rangePips,
    sourceBarCount: source.length,
    prevTrend,
    align,
    setup510,
    startDistPips,
    blockLabel: blockLabelFromStartMs(blockStartMs),
  };
}

/**
 * Every started UTC 4H use-block in the series (oldest → newest).
 * Levels always come from the prior UTC window only.
 */
export function computeFrozen4hBlocks(
  candles: Candle[],
  instrument: MajorInstrument,
): Frozen4hBlock[] {
  const completed = completedM15(candles);
  if (completed.length < 2) return [];

  const starts = new Set<number>();
  for (const candle of completed) {
    starts.add(utc4hFloor(candleOpenMs(candle)));
  }

  const blocks: Frozen4hBlock[] = [];
  for (const startMs of [...starts].sort((left, right) => left - right)) {
    const block = buildBlockAt(startMs, completed, instrument);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Active (latest started) frozen 4H block. Refresh-safe: same T → same source
 * window → identical R / MID / S.
 */
export function computeActiveFrozen4hSr(
  candles: Candle[],
  instrument: MajorInstrument,
): Frozen4hBlock | null {
  const blocks = computeFrozen4hBlocks(candles, instrument);
  return blocks.at(-1) ?? null;
}

/** Dev dump so a block's freeze can be verified in the console. */
export function logFrozen4hDebug(block: Frozen4hBlock): void {
  console.info("[frozen-4h-sr]", {
    "4H Block": block.blockLabel,
    "Source window": `${block.sourceStartTime} → ${block.sourceEndTime}`,
    "Source M15 count": block.sourceBarCount,
    "Use window": `${block.startTime} → ${block.endTime}`,
    Resistance: block.resistance,
    Midpoint: block.midpoint,
    Support: block.support,
    "Range (pips)": block.rangePips,
    "Previous 4H": block.prevTrend,
    Status: block.align,
    Setup: block.setup510 ? "5–10P SETUP" : "NO SETUP",
    Frozen: true,
  });
}
