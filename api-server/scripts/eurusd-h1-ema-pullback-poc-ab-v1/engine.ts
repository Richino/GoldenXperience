/**
 * Frozen EURUSD H1 EMA pullback A/B engine.
 * Research only. POC filter is the only strategic difference between A and B.
 */
import {
  previousUtcDayKey,
  utcDayKey,
  yesterdayPocForSignalDay,
  type VolumeBar,
} from "./poc.js";

export const PIP = 0.0001;
export const STOP_OFFSET = 0.0002;
export const RISK_FRACTION = 0.005;
export const STARTING_BALANCE = 100;
export const REWARD_R = 2;
export const MAX_HOLD_MS = 48 * 60 * 60_000;
export const SPREAD_FRACTION_LIMIT = 0.10;
export const WEEKEND_GAP_MS = 12 * 60 * 60_000;
export const H1_MS = 60 * 60_000;
export const M5_MS = 5 * 60_000;
export const M1_MS = 60_000;
export const DEV_OPPORTUNITY_COUNT = 200;
export const DEV_CHECKPOINT_COUNT = 100;

export type Direction = "long" | "short";
export type ExitReason = "STOP" | "TARGET" | "TIME_EXIT_48H" | "WEEKEND_EXIT" | "END_OF_DATA";
export type RejectReason =
  | "POSITION_ALREADY_OPEN"
  | "SPREAD_TOO_WIDE"
  | "INVALID_STOP_GEOMETRY"
  | "BLOCKED_BY_POC"
  | "POC_UNAVAILABLE"
  | "UNITS_TOO_SMALL"
  | "INSUFFICIENT_MARGIN"
  | "NO_EXECUTABLE_ENTRY";

export type Side = { open: number; high: number; low: number; close: number };

export type MbaBar = {
  time: string;
  openMs: number;
  closeMs: number;
  volume: number;
  mid: Side;
  bid: Side;
  ask: Side;
};

export type PathBar = {
  openMs: number;
  closeMs: number;
  time: string;
  bid: Side;
  ask: Side;
};

export function calculateEmaValues(closes: readonly number[], period: number): Array<number | null> {
  const values: Array<number | null> = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;
  for (let index = 0; index < closes.length; index += 1) {
    if (index < period - 1) {
      values.push(null);
      continue;
    }
    if (previous === null) {
      previous = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    } else {
      previous = closes[index]! * multiplier + previous * (1 - multiplier);
    }
    values.push(previous);
  }
  return values;
}

export function lastIndexAtOrBefore(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function firstIndexAtOrAfter(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = times.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! >= time) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found;
}

export function isWeekendCloseBar(bars: readonly { openMs: number; closeMs: number }[], index: number): boolean {
  const next = bars[index + 1];
  if (!next) return false;
  return next.openMs - bars[index]!.closeMs >= WEEKEND_GAP_MS;
}

export type RawOpportunity = {
  opportunityId: string;
  h1Index: number;
  direction: Direction;
  signalTime: string;
  signalOpenMs: number;
  signalCloseMs: number;
  signalClose: number;
  ema20: number;
  ema50: number;
  ema50FiveAgo: number;
  previousHigh: number;
  previousLow: number;
  threeBarLow: number;
  threeBarHigh: number;
  stop: number;
  yesterdayPoc: number | null;
  pocDayKey: string;
  pocRelationship: "above" | "below" | "equal" | "unavailable";
  entryBarTime: string | null;
  entryMs: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  spreadPips: number | null;
  stopDistance: number | null;
  stopDistancePips: number | null;
  spreadFraction: number | null;
  executableEntry: number | null;
  target: number | null;
  aReject: RejectReason | null;
  bReject: RejectReason | null;
};

export type ResolvedPath = {
  exitTime: string;
  exitMs: number;
  exitPrice: number;
  exitReason: ExitReason;
  resultR: number;
  holdMs: number;
  ambiguousIntrabar: boolean;
  resolutionMethod: "m1_path" | "m5_path" | "stop_first_fallback";
  gappedStop: boolean;
  gappedTarget: boolean;
};

export type ClosedTrade = {
  opportunityId: string;
  version: "A" | "B";
  direction: Direction;
  signalTime: string;
  entryTime: string;
  entryMs: number;
  exitTime: string;
  exitMs: number;
  exitReason: ExitReason;
  signalClose: number;
  entry: number;
  stop: number;
  target: number;
  stopDistance: number;
  stopDistancePips: number;
  spread: number;
  spreadPips: number;
  spreadFraction: number;
  yesterdayPoc: number | null;
  balanceBefore: number;
  riskDollars: number;
  units: number;
  pipValue: number;
  actualModeledRisk: number;
  pnlUsd: number;
  resultR: number;
  holdMs: number;
  ambiguousIntrabar: boolean;
  resolutionMethod: ResolvedPath["resolutionMethod"];
  gappedStop: boolean;
  gappedTarget: boolean;
  extraSlippagePips: number;
  year: number;
};

function finite(value: number): boolean {
  return Number.isFinite(value);
}

export function validSide(side: Side): boolean {
  return finite(side.open) && finite(side.high) && finite(side.low) && finite(side.close)
    && side.high >= Math.max(side.open, side.close)
    && side.low <= Math.min(side.open, side.close)
    && side.high >= side.low;
}

export function toMbaBar(raw: {
  time: string;
  volume: number;
  complete: boolean;
  mid: Side;
  bid: Side;
  ask: Side;
}, periodMs: number): MbaBar | null {
  if (!raw.complete || !validSide(raw.mid) || !validSide(raw.bid) || !validSide(raw.ask)) return null;
  if (raw.ask.close < raw.bid.close) return null;
  const openMs = Date.parse(raw.time);
  if (!Number.isFinite(openMs)) return null;
  return {
    time: raw.time,
    openMs,
    closeMs: openMs + periodMs,
    volume: Number.isFinite(raw.volume) ? raw.volume : 0,
    mid: raw.mid,
    bid: raw.bid,
    ask: raw.ask,
  };
}

export function normalizeMba(
  candles: readonly {
    time: string;
    volume: number;
    complete: boolean;
    mid: Side;
    bid: Side;
    ask: Side;
  }[],
  periodMs: number,
): { bars: MbaBar[]; duplicates: number; malformed: number; conflicting: number } {
  let malformed = 0;
  const byTime = new Map<number, MbaBar>();
  let duplicates = 0;
  let conflicting = 0;
  for (const candle of candles) {
    const bar = toMbaBar(candle, periodMs);
    if (!bar) {
      malformed += 1;
      continue;
    }
    const existing = byTime.get(bar.openMs);
    if (!existing) {
      byTime.set(bar.openMs, bar);
      continue;
    }
    duplicates += 1;
    if (existing.mid.close !== bar.mid.close || existing.bid.close !== bar.bid.close || existing.ask.close !== bar.ask.close) {
      conflicting += 1;
    }
  }
  return {
    bars: [...byTime.values()].sort((left, right) => left.openMs - right.openMs),
    duplicates,
    malformed,
    conflicting,
  };
}

export function detectSignals(
  h1: readonly MbaBar[],
  pocByDay: Map<string, number | null>,
): RawOpportunity[] {
  const closes = h1.map((bar) => bar.mid.close);
  const ema20 = calculateEmaValues(closes, 20);
  const ema50 = calculateEmaValues(closes, 50);
  const opportunities: RawOpportunity[] = [];
  let serial = 0;
  for (let t = 0; t < h1.length; t += 1) {
    const e20 = ema20[t];
    const e50 = ema50[t];
    const e50Prev = t >= 5 ? ema50[t - 5] : null;
    if (e20 == null || e50 == null || e50Prev == null || t < 2) continue;
    const bar = h1[t]!;
    const prev = h1[t - 1]!;
    const older = h1[t - 2]!;
    const trendLong = e20 > e50 && e50 > e50Prev;
    const trendShort = e20 < e50 && e50 < e50Prev;
    const longSignal = trendLong && bar.mid.low <= e20 && bar.mid.close > e20 && bar.mid.close > prev.mid.high;
    const shortSignal = trendShort && bar.mid.high >= e20 && bar.mid.close < e20 && bar.mid.close < prev.mid.low;
    if (!longSignal && !shortSignal) continue;
    if (longSignal && shortSignal) continue;
    const direction: Direction = longSignal ? "long" : "short";
    const threeBarLow = Math.min(bar.mid.low, prev.mid.low, older.mid.low);
    const threeBarHigh = Math.max(bar.mid.high, prev.mid.high, older.mid.high);
    const stop = direction === "long" ? threeBarLow - STOP_OFFSET : threeBarHigh + STOP_OFFSET;
    const signalDay = utcDayKey(bar.openMs);
    const yesterdayPoc = yesterdayPocForSignalDay(pocByDay, signalDay);
    const pocRelationship: RawOpportunity["pocRelationship"] = yesterdayPoc == null
      ? "unavailable"
      : bar.mid.close > yesterdayPoc ? "above" : bar.mid.close < yesterdayPoc ? "below" : "equal";
    const next = h1[t + 1] ?? null;
    const entryBid = next?.bid.open ?? null;
    const entryAsk = next?.ask.open ?? null;
    const spread = entryBid != null && entryAsk != null ? entryAsk - entryBid : null;
    const rawEntry = next == null ? null : direction === "long" ? entryAsk : entryBid;
    const stopDistance = rawEntry != null ? Math.abs(rawEntry - stop) : null;
    const validGeometry = rawEntry != null && (
      direction === "long" ? rawEntry > stop : rawEntry < stop
    );
    const spreadFraction = spread != null && stopDistance != null && stopDistance > 0 ? spread / stopDistance : null;
    const target = rawEntry != null && stopDistance != null
      ? (direction === "long" ? rawEntry + REWARD_R * stopDistance : rawEntry - REWARD_R * stopDistance)
      : null;
    serial += 1;
    opportunities.push({
      opportunityId: `OPP-${String(serial).padStart(5, "0")}`,
      h1Index: t,
      direction,
      signalTime: bar.time,
      signalOpenMs: bar.openMs,
      signalCloseMs: bar.closeMs,
      signalClose: bar.mid.close,
      ema20: e20,
      ema50: e50,
      ema50FiveAgo: e50Prev,
      previousHigh: prev.mid.high,
      previousLow: prev.mid.low,
      threeBarLow,
      threeBarHigh,
      stop,
      yesterdayPoc,
      pocDayKey: previousUtcDayKey(signalDay),
      pocRelationship,
      entryBarTime: next?.time ?? null,
      entryMs: next?.openMs ?? null,
      bid: entryBid,
      ask: entryAsk,
      spread,
      spreadPips: spread != null ? spread / PIP : null,
      stopDistance,
      stopDistancePips: stopDistance != null ? stopDistance / PIP : null,
      spreadFraction,
      executableEntry: rawEntry,
      target,
      aReject: next == null ? "NO_EXECUTABLE_ENTRY"
        : !validGeometry ? "INVALID_STOP_GEOMETRY"
        : spreadFraction != null && spreadFraction > SPREAD_FRACTION_LIMIT ? "SPREAD_TOO_WIDE"
        : null,
      bReject: next == null ? "NO_EXECUTABLE_ENTRY"
        : !validGeometry ? "INVALID_STOP_GEOMETRY"
        : spreadFraction != null && spreadFraction > SPREAD_FRACTION_LIMIT ? "SPREAD_TOO_WIDE"
        : yesterdayPoc == null ? "POC_UNAVAILABLE"
        : direction === "long" && bar.mid.close <= yesterdayPoc ? "BLOCKED_BY_POC"
        : direction === "short" && bar.mid.close >= yesterdayPoc ? "BLOCKED_BY_POC"
        : null,
    });
  }
  return opportunities;
}

function applyEntrySlippage(direction: Direction, rawEntry: number, slip: number): number {
  return direction === "long" ? rawEntry + slip : rawEntry - slip;
}

function exitSide(bar: PathBar, direction: Direction): Side {
  return direction === "long" ? bar.bid : bar.ask;
}

function applyExitSlippage(direction: Direction, rawExit: number, slip: number): number {
  return direction === "long" ? rawExit - slip : rawExit + slip;
}

type Hit = {
  kind: "STOP" | "TARGET";
  fill: number;
  gap: boolean;
};

function scanBarHits(
  direction: Direction,
  stop: number,
  target: number,
  side: Side,
  slip: number,
  isEntryBar: boolean,
): { hits: Hit[]; ambiguous: boolean } {
  const openFill = applyExitSlippage(direction, side.open, slip);
  const highFill = applyExitSlippage(direction, side.high, slip);
  const lowFill = applyExitSlippage(direction, side.low, slip);
  const hits: Hit[] = [];
  if (!isEntryBar) {
    if (direction === "long") {
      if (openFill <= stop) hits.push({ kind: "STOP", fill: openFill, gap: true });
      else if (openFill >= target) hits.push({ kind: "TARGET", fill: target, gap: true });
    } else if (openFill >= stop) hits.push({ kind: "STOP", fill: openFill, gap: true });
    else if (openFill <= target) hits.push({ kind: "TARGET", fill: target, gap: true });
    if (hits.length) return { hits, ambiguous: false };
  }
  const stopHit = direction === "long" ? lowFill <= stop : highFill >= stop;
  const targetHit = direction === "long" ? highFill >= target : lowFill <= target;
  if (stopHit) {
    const fill = direction === "long"
      ? Math.min(stop, applyExitSlippage(direction, Math.min(side.open, side.low), slip))
      : Math.max(stop, applyExitSlippage(direction, Math.max(side.open, side.high), slip));
    hits.push({ kind: "STOP", fill: direction === "long" ? Math.min(fill, stop) : Math.max(fill, stop), gap: false });
  }
  if (targetHit) hits.push({ kind: "TARGET", fill: target, gap: false });
  return { hits, ambiguous: stopHit && targetHit };
}

function stopFill(direction: Direction, stop: number, side: Side, slip: number, gapped: boolean): number {
  if (!gapped) return applyExitSlippage(direction, stop, slip);
  const openFill = applyExitSlippage(direction, side.open, slip);
  return direction === "long" ? Math.min(openFill, stop) : Math.max(openFill, stop);
}

export type M1Provider = (fromMs: number, toMs: number) => PathBar[] | Promise<PathBar[]>;

function pathResult(
  bar: PathBar,
  entryMs: number,
  reason: ExitReason,
  fill: number,
  ambiguousIntrabar: boolean,
  resolutionMethod: ResolvedPath["resolutionMethod"],
  gappedStop: boolean,
  gappedTarget: boolean,
): ResolvedPath {
  const exitMs = reason === "WEEKEND_EXIT" || reason === "END_OF_DATA" ? bar.closeMs : bar.openMs;
  return {
    exitTime: new Date(exitMs).toISOString(),
    exitMs,
    exitPrice: fill,
    exitReason: reason,
    resultR: 0,
    holdMs: exitMs - entryMs,
    ambiguousIntrabar,
    resolutionMethod,
    gappedStop,
    gappedTarget,
  };
}

async function resolveHitsOnBar(
  direction: Direction,
  entryMs: number,
  stop: number,
  target: number,
  slip: number,
  bar: PathBar,
  isEntryBar: boolean,
  m1Provider: M1Provider | null,
  state: { ambiguousIntrabar: boolean; resolutionMethod: ResolvedPath["resolutionMethod"] },
): Promise<ResolvedPath | null> {
  const side = exitSide(bar, direction);
  const hits = scanBarHits(direction, stop, target, side, slip, isEntryBar);
  if (!hits.hits.length) return null;
  if (!hits.ambiguous) {
    const first = hits.hits[0]!;
    const fill = first.kind === "STOP" ? stopFill(direction, stop, side, slip, first.gap) : target;
    return pathResult(bar, entryMs, first.kind, fill, state.ambiguousIntrabar, state.resolutionMethod, first.kind === "STOP" && first.gap, first.kind === "TARGET" && first.gap);
  }
  state.ambiguousIntrabar = true;
  const m1Bars = m1Provider ? await m1Provider(bar.openMs, bar.closeMs) : [];
  if (m1Bars.length) {
    state.resolutionMethod = "m1_path";
    for (const m1 of m1Bars) {
      if (m1.openMs < entryMs) continue;
      const m1Hits = scanBarHits(direction, stop, target, exitSide(m1, direction), slip, m1.openMs === entryMs);
      if (m1Hits.ambiguous) {
        state.resolutionMethod = "stop_first_fallback";
        const gapped = m1Hits.hits.some((hit) => hit.kind === "STOP" && hit.gap);
        return pathResult(m1, entryMs, "STOP", stopFill(direction, stop, exitSide(m1, direction), slip, gapped), true, "stop_first_fallback", gapped, false);
      }
      const first = m1Hits.hits[0];
      if (first) {
        const fill = first.kind === "STOP" ? stopFill(direction, stop, exitSide(m1, direction), slip, first.gap) : target;
        return pathResult(m1, entryMs, first.kind, fill, true, "m1_path", first.kind === "STOP" && first.gap, first.kind === "TARGET" && first.gap);
      }
    }
  }
  state.resolutionMethod = "stop_first_fallback";
  return pathResult(bar, entryMs, "STOP", stopFill(direction, stop, side, slip, false), true, "stop_first_fallback", false, false);
}

export async function resolvePath(
  direction: Direction,
  entryMs: number,
  stop: number,
  target: number,
  extraSlippagePips: number,
  m5: readonly MbaBar[],
  h1Times: readonly number[],
  m1Provider: M1Provider | null,
): Promise<ResolvedPath | null> {
  const slip = extraSlippagePips * PIP;
  const m5Times = m5.map((bar) => bar.openMs);
  const begin = firstIndexAtOrAfter(m5Times, entryMs);
  if (begin >= m5.length) return null;
  const timeExitH1 = firstIndexAtOrAfter(h1Times, entryMs + MAX_HOLD_MS);
  const timeExitMs = timeExitH1 < h1Times.length ? h1Times[timeExitH1]! : Number.POSITIVE_INFINITY;
  const state = { ambiguousIntrabar: false, resolutionMethod: "m5_path" as ResolvedPath["resolutionMethod"] };

  for (let index = begin; index < m5.length; index += 1) {
    const bar = m5[index]!;
    const isEntryBar = bar.openMs === entryMs;
    const side = exitSide(bar, direction);

    if (!isEntryBar && bar.openMs >= timeExitMs) {
      const openHit = scanBarHits(direction, stop, target, side, slip, false);
      if (openHit.hits[0]?.kind === "STOP" && openHit.hits[0].gap) {
        return pathResult(bar, entryMs, "STOP", stopFill(direction, stop, side, slip, true), state.ambiguousIntrabar, state.resolutionMethod, true, false);
      }
      return pathResult(bar, entryMs, "TIME_EXIT_48H", applyExitSlippage(direction, side.open, slip), state.ambiguousIntrabar, state.resolutionMethod, false, false);
    }

    const hit = await resolveHitsOnBar(direction, entryMs, stop, target, slip, bar, isEntryBar, m1Provider, state);
    if (hit) return hit;

    if (isWeekendCloseBar(m5, index)) {
      return pathResult(bar, entryMs, "WEEKEND_EXIT", applyExitSlippage(direction, side.close, slip), state.ambiguousIntrabar, state.resolutionMethod, false, false);
    }
  }

  const last = m5[m5.length - 1];
  if (!last) return null;
  return pathResult(last, entryMs, "END_OF_DATA", applyExitSlippage(direction, exitSide(last, direction).close, slip), state.ambiguousIntrabar, state.resolutionMethod, false, false);
}

export function resultR(direction: Direction, entry: number, stop: number, exit: number): number {
  const distance = Math.abs(entry - stop);
  if (!(distance > 0)) return 0;
  const pnl = direction === "long" ? exit - entry : entry - exit;
  return pnl / distance;
}

export function sizePosition(
  balance: number,
  entry: number,
  stop: number,
  marginRate: number | null,
): {
  reject: Extract<RejectReason, "UNITS_TOO_SMALL" | "INSUFFICIENT_MARGIN"> | null;
  units: number;
  riskDollars: number;
  actualModeledRisk: number;
  pipValue: number;
} {
  const riskDollars = balance * RISK_FRACTION;
  const stopDistance = Math.abs(entry - stop);
  const units = stopDistance > 0 ? Math.floor(riskDollars / stopDistance) : 0;
  const actualModeledRisk = units * stopDistance;
  const pipValue = units * PIP;
  if (units < 1) {
    return { reject: "UNITS_TOO_SMALL", units: 0, riskDollars, actualModeledRisk: 0, pipValue: 0 };
  }
  if (marginRate != null && units * entry * marginRate > balance + 1e-12) {
    return { reject: "INSUFFICIENT_MARGIN", units: 0, riskDollars, actualModeledRisk: 0, pipValue: 0 };
  }
  return { reject: null, units, riskDollars, actualModeledRisk, pipValue };
}

export function pnlUsd(direction: Direction, units: number, entry: number, exit: number): number {
  return units * (direction === "long" ? exit - entry : entry - exit);
}

export type VersionId = "A" | "B";

export async function replayVersion(
  version: VersionId,
  opportunities: readonly RawOpportunity[],
  extraSlippagePips: number,
  m5: readonly MbaBar[],
  h1: readonly MbaBar[],
  m1Provider: M1Provider | null,
  marginRate: number | null,
): Promise<{ trades: ClosedTrade[]; occupancyRejects: string[] }> {
  const h1Times = h1.map((bar) => bar.openMs);
  let balance = STARTING_BALANCE;
  let lockedUntil = -1;
  const trades: ClosedTrade[] = [];
  const occupancyRejects: string[] = [];
  const slip = extraSlippagePips * PIP;

  for (const opp of opportunities) {
    const strategicReject = version === "A" ? opp.aReject : opp.bReject;
    if (opp.entryMs != null && opp.entryMs < lockedUntil) {
      occupancyRejects.push(opp.opportunityId);
      continue;
    }
    if (strategicReject) continue;
    if (opp.entryMs == null || opp.executableEntry == null || opp.bid == null || opp.ask == null) continue;
    const rawEntry = applyEntrySlippage(opp.direction, opp.executableEntry, slip);
    const valid = opp.direction === "long" ? rawEntry > opp.stop : rawEntry < opp.stop;
    if (!valid) continue;
    const stopDistance = Math.abs(rawEntry - opp.stop);
    if (!(stopDistance > 0)) continue;
    const spread = opp.ask - opp.bid;
    if (spread / stopDistance > SPREAD_FRACTION_LIMIT) continue;
    const sized = sizePosition(balance, rawEntry, opp.stop, marginRate);
    if (sized.reject) continue;
    const target = opp.direction === "long" ? rawEntry + REWARD_R * stopDistance : rawEntry - REWARD_R * stopDistance;
    const path = await resolvePath(opp.direction, opp.entryMs, opp.stop, target, extraSlippagePips, m5, h1Times, m1Provider);
    if (!path) continue;
    path.resultR = resultR(opp.direction, rawEntry, opp.stop, path.exitPrice);
    path.holdMs = path.exitMs - opp.entryMs;
    const dollars = pnlUsd(opp.direction, sized.units, rawEntry, path.exitPrice);
    trades.push({
      opportunityId: opp.opportunityId,
      version,
      direction: opp.direction,
      signalTime: opp.signalTime,
      entryTime: new Date(opp.entryMs).toISOString(),
      entryMs: opp.entryMs,
      exitTime: path.exitTime,
      exitMs: path.exitMs,
      exitReason: path.exitReason,
      signalClose: opp.signalClose,
      entry: rawEntry,
      stop: opp.stop,
      target,
      stopDistance,
      stopDistancePips: stopDistance / PIP,
      spread,
      spreadPips: spread / PIP,
      spreadFraction: spread / stopDistance,
      yesterdayPoc: opp.yesterdayPoc,
      balanceBefore: balance,
      riskDollars: sized.riskDollars,
      units: sized.units,
      pipValue: sized.pipValue,
      actualModeledRisk: sized.actualModeledRisk,
      pnlUsd: dollars,
      resultR: path.resultR,
      holdMs: path.holdMs,
      ambiguousIntrabar: path.ambiguousIntrabar,
      resolutionMethod: path.resolutionMethod,
      gappedStop: path.gappedStop,
      gappedTarget: path.gappedTarget,
      extraSlippagePips,
      year: new Date(opp.signalTime).getUTCFullYear(),
    });
    balance += dollars;
    lockedUntil = path.exitMs;
  }
  return { trades, occupancyRejects };
}

export function m5VolumeBars(m5: readonly MbaBar[]): Array<VolumeBar & { openMs: number }> {
  return m5.map((bar) => ({
    openMs: bar.openMs,
    high: bar.mid.high,
    low: bar.mid.low,
    close: bar.mid.close,
    volume: bar.volume,
  }));
}

export function overnightFinancingDays(entryMs: number, exitMs: number): { rolls: number; daysCharged: number } {
  const nyClock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let rolls = 0;
  let daysCharged = 0;
  const hour = 60 * 60_000;
  const start = Math.ceil((entryMs + 1) / hour) * hour;
  for (let time = start; time <= exitMs; time += hour) {
    const parts = Object.fromEntries(
      nyClock.formatToParts(new Date(time)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    );
    if (parts.hour !== "17" || parts.minute !== "00") continue;
    rolls += 1;
    daysCharged += parts.weekday === "Wed" ? 3 : 1;
  }
  return { rolls, daysCharged };
}
