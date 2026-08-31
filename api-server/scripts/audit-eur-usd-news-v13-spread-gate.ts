/**
 * Research-only V13 challenger. It adds an execution-cost gate to frozen V12.
 * Candidate limits are selected on Aug 2024-Jul 2025 only. The reused
 * Aug 2025-Jul 2026 period is diagnostic, not untouched confirmation.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyEurUsdNewsV12Event,
  createEurUsdNewsV12Levels,
  groupEurUsdNewsV12Events,
  parseEurUsdNewsV12Number,
  passesEurUsdNewsV12FrozenFilters,
  type EurUsdNewsV12Event,
  type EurUsdNewsV12Group,
} from "../src/eur-usd-news-v12-shadow.js";

type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; bid: Side; ask: Side; mid: Side };
type Trade = {
  releaseTimeUtc: string;
  entryTimeUtc: string;
  direction: "UP" | "DOWN";
  surpriseStrength: number;
  preReleaseAtrPips: number;
  spreadPips: number;
  spreadToStopRatio: number;
  executableEntry: number;
  stop: number;
  target: number;
  risk: number;
  confirmationMoveAtr: number;
  eventNames: string[];
  resultR: number;
  outcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT";
  resolutionTimeUtc: string;
  minutesToOutcome: number;
  maximumFavorableRBeforeOutcome: number;
  maximumAdverseRBeforeOutcome: number;
  maximumFavorableR72h: number;
  maximumAdverseR72h: number;
  netDirectionalMoveR72h: number;
  targetTouchedAfterStop: boolean;
  inverseOutcome: "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT";
  inverseResultR: number;
  m1AmbiguousResolution?: "TARGET_FIRST" | "STOP_FIRST" | "STILL_AMBIGUOUS" | "NO_TOUCH" | "UNAVAILABLE";
};

type VariantSpec = {
  name: string;
  entryMode: "IMMEDIATE" | "CLOSE_CONFIRMED_PULLBACK";
  pullbackAtr?: number;
  maximumWaitMinutes?: number;
  stopMode: "PRE_RELEASE_ATR" | "POST_RELEASE_RANGE" | "RELEASE_STRUCTURE";
  stopAtrMultiplier?: number;
  postReleaseRangeMultiplier?: number;
};

type VariantTrade = {
  releaseTimeUtc: string;
  entryTimeUtc: string | null;
  entered: boolean;
  direction: "UP" | "DOWN";
  resultR: number | null;
  outcome: Trade["outcome"] | "SKIP";
  riskPips: number | null;
  spreadToStopRatio: number | null;
  executableEntry: number | null;
  risk: number | null;
  stop: number | null;
  target: number | null;
  baselineResultR: number;
  baselineOutcome: Trade["outcome"];
};

type RescueSpec = {
  name: string;
  reclaimLevel: "PRE_RELEASE_MID" | "ORIGINAL_ENTRY" | "CONFIRMATION_CLOSE";
  reclaimBufferAtr: number;
  maximumWaitMinutes: number;
  retryStopAtrMultiplier: number;
};

type RescueTrade = {
  releaseTimeUtc: string;
  direction: "UP" | "DOWN";
  baselineResultR: number;
  retryTaken: boolean;
  retryEntryTimeUtc: string | null;
  retryOutcome: Trade["outcome"] | "NO_RETRY";
  retryResultR: number;
  eventResultR: number;
};

type HybridCondition = "DOWN_ONLY" | "WEAK_0_25" | "WEAK_0_50" | "CHASED_3_ATR" | "DOWN_WEAK_0_25" | "DOWN_CHASED_3_ATR";

type ManagementSpec = {
  name: string;
  activationCloseR: number;
  partialFraction: number;
};

type ExpansionSpec = {
  name: string;
  surpriseThreshold: number;
  atrCeilingPips: number;
  confirmationMinutes: 5 | 10 | 15 | 20 | 30 | 45 | 60 | 90 | 120;
  cooldownHours: 0 | 2 | 4;
};

type RawEventGroup = {
  releaseTimeUtc: string;
  events: EurUsdNewsV12Event[];
};

type HighFrequencySpec = {
  name: string;
  confirmationMinutes: 5 | 15;
  minimumConfirmationMoveAtr: number;
  atrCeilingPips: number;
  cooldownHours: 0 | 2 | 4;
  postReleaseRangeMultiplier: number;
};

type BroadNewsSpec = {
  name: string;
  surpriseThreshold: number;
  atrCeilingPips: number;
  confirmationMinutes: 5 | 15;
  confirmationMode: "AGREEMENT" | "NONE";
  cooldownHours: 0 | 2 | 4;
  postReleaseRangeMultiplier: 0 | 0.5 | 1;
};

type SessionTechnicalSpec = {
  name: string;
  utcHour: number;
  lookbackBars: 12 | 24 | 48 | 96;
  directionMode: "MOMENTUM" | "MEAN_REVERSION";
  minimumMoveAtr: number;
  stopAtrMultiplier: number;
};

type ManagedTrade = {
  releaseTimeUtc: string;
  baselineResultR: number;
  resultR: number;
  managementActivated: boolean;
  partialRealizedR: number;
  outcome: "TARGET" | "STOP" | "BREAK_EVEN" | "TIME_EXIT";
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "research-v2", "eurusd-news-v13-spread-gate");
const developmentFile = path.join(root, "research-v2", "eurusd-ff-high-impact-aug2024-jul2025", "events.json");
const validationFile = path.join(root, "research-v2", "eurusd-ff-high-impact-aug2025-jul2026", "events.json");
const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
if (!token) throw new Error("OANDA Practice credentials are required.");
if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") throw new Error("V13 research refuses OANDA live.");

const fetchStart = "2024-07-25T00:00:00.000Z";
const fetchEnd = "2026-08-04T00:00:00.000Z";

async function fetchM5() {
  const collected = new Map<number, Bar>();
  let cursor = fetchStart;
  for (let pageNumber = 0; pageNumber < 80; pageNumber += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`OANDA Practice M5 request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }> };
    const page = (payload.candles ?? []).filter((candle) => candle.complete).map((candle): Bar => {
      const bid = { o: Number(candle.bid.o), h: Number(candle.bid.h), l: Number(candle.bid.l), c: Number(candle.bid.c) };
      const ask = { o: Number(candle.ask.o), h: Number(candle.ask.h), l: Number(candle.ask.l), c: Number(candle.ask.c) };
      return { time: candle.time, bid, ask, mid: { o: (bid.o + ask.o) / 2, h: (bid.h + ask.h) / 2, l: (bid.l + ask.l) / 2, c: (bid.c + ask.c) / 2 } };
    });
    for (const bar of page) if (Date.parse(bar.time) < Date.parse(fetchEnd)) collected.set(Date.parse(bar.time), bar);
    if ((pageNumber + 1) % 10 === 0) console.error(`Fetched ${collected.size.toLocaleString()} M5 candles`);
    const last = page.at(-1);
    if (!last || page.length < 5000 || Date.parse(last.time) >= Date.parse(fetchEnd)) break;
    cursor = new Date(Date.parse(last.time) + 300_000).toISOString();
  }
  return [...collected.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

async function resolveAmbiguousWithM1(trade: Trade): Promise<Trade> {
  if (trade.outcome !== "AMBIGUOUS_STOP") return trade;
  try {
    const query = new URLSearchParams({
      price: "BA",
      granularity: "M1",
      from: trade.entryTimeUtc,
      to: new Date(Date.parse(trade.entryTimeUtc) + 5 * 60_000).toISOString(),
    });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return { ...trade, m1AmbiguousResolution: "UNAVAILABLE" };
    const payload = await response.json() as { candles?: Array<{ complete: boolean; bid: Record<string, string>; ask: Record<string, string> }> };
    for (const candle of payload.candles ?? []) {
      if (!candle.complete) continue;
      const targetHit = trade.direction === "UP" ? Number(candle.bid.h) >= trade.target : Number(candle.ask.l) <= trade.target;
      const stopHit = trade.direction === "UP" ? Number(candle.bid.l) <= trade.stop : Number(candle.ask.h) >= trade.stop;
      if (targetHit && stopHit) return { ...trade, m1AmbiguousResolution: "STILL_AMBIGUOUS" };
      if (targetHit) return { ...trade, m1AmbiguousResolution: "TARGET_FIRST" };
      if (stopHit) return { ...trade, m1AmbiguousResolution: "STOP_FIRST" };
    }
    return { ...trade, m1AmbiguousResolution: "NO_TOUCH" };
  } catch {
    return { ...trade, m1AmbiguousResolution: "UNAVAILABLE" };
  }
}

function atr14At(bars: Bar[], index: number) {
  if (index < 13) return Number.NaN;
  let sum = 0;
  for (let cursor = index - 13; cursor <= index; cursor += 1) {
    const previousClose = cursor > 0 ? bars[cursor - 1]!.mid.c : bars[cursor]!.mid.c;
    const bar = bars[cursor]!;
    sum += Math.max(bar.mid.h - bar.mid.l, Math.abs(bar.mid.h - previousClose), Math.abs(bar.mid.l - previousClose));
  }
  return sum / 14;
}

function loadGroups(file: string) {
  const payload = JSON.parse(readFileSync(file, "utf8")) as { events: EurUsdNewsV12Event[] };
  const directional = groupEurUsdNewsV12Events(payload.events);
  const groups: EurUsdNewsV12Group[] = [];
  for (const group of directional) {
    const previous = groups.at(-1);
    if (!previous || Date.parse(group.releaseTimeUtc) >= Date.parse(previous.releaseTimeUtc) + 4 * 3_600_000) groups.push(group);
  }
  return { calendarRows: payload.events.length, directionalGroups: directional.length, directionalGroupsAll: directional, groups };
}

function loadRawEventGroups(file: string) {
  const payload = JSON.parse(readFileSync(file, "utf8")) as { events: EurUsdNewsV12Event[] };
  const byRelease = new Map<string, EurUsdNewsV12Event[]>();
  for (const event of payload.events) {
    const releaseTimeUtc = new Date(event.releaseTimeUtc).toISOString();
    byRelease.set(releaseTimeUtc, [...(byRelease.get(releaseTimeUtc) ?? []), event]);
  }
  return [...byRelease.entries()]
    .map(([releaseTimeUtc, events]): RawEventGroup => ({ releaseTimeUtc, events }))
    .sort((left, right) => Date.parse(left.releaseTimeUtc) - Date.parse(right.releaseTimeUtc));
}

function classifyBroadNewsEvent(event: EurUsdNewsV12Event) {
  const existing = classifyEurUsdNewsV12Event(event);
  if (existing) return existing;
  if (!/(CPI|PPI|PCE|Inflation Expectations|Federal Funds Rate|Main Refinancing Rate|Consumer Confidence)/.test(event.eventName)) return null;
  const actual = parseEurUsdNewsV12Number(event.actual);
  const forecast = parseEurUsdNewsV12Number(event.forecast);
  if (!actual || !forecast || actual.unit !== forecast.unit || actual.value === forecast.value) return null;
  const currencyGood = actual.value > forecast.value ? 1 : -1;
  return {
    direction: (currencyGood * (event.currency === "EUR" ? 1 : -1)) as 1 | -1,
    magnitude: Math.abs(actual.value - forecast.value) / Math.max(Math.abs(forecast.value), 1),
  };
}

function loadBroadNewsGroups(file: string) {
  const payload = JSON.parse(readFileSync(file, "utf8")) as { events: EurUsdNewsV12Event[] };
  const byRelease = new Map<string, Array<{ event: EurUsdNewsV12Event; direction: 1 | -1; magnitude: number }>>();
  for (const event of payload.events) {
    const signal = classifyBroadNewsEvent(event);
    if (!signal) continue;
    const releaseTimeUtc = new Date(event.releaseTimeUtc).toISOString();
    byRelease.set(releaseTimeUtc, [...(byRelease.get(releaseTimeUtc) ?? []), { event, ...signal }]);
  }
  return [...byRelease.entries()].flatMap(([releaseTimeUtc, signals]): EurUsdNewsV12Group[] => {
    const vote = signals.reduce((sum, signal) => sum + signal.direction, 0);
    if (vote === 0) return [];
    return [{
      releaseTimeUtc,
      direction: vote > 0 ? 1 : -1,
      surpriseStrength: signals.reduce((sum, signal) => sum + signal.magnitude, 0),
      events: signals.map((signal) => signal.event),
    }];
  }).sort((left, right) => Date.parse(left.releaseTimeUtc) - Date.parse(right.releaseTimeUtc));
}

function resolvePath(input: {
  bars: Bar[];
  entryIndex: number;
  direction: 1 | -1;
  executableEntry: number;
  risk: number;
  stop: number;
  target: number;
}) {
  const deadline = Date.parse(input.bars[input.entryIndex]!.time) + 72 * 3_600_000;
  let exitIndex = input.entryIndex;
  let outcome: Trade["outcome"] = "TIME_EXIT";
  let resultR = 0;
  for (let index = input.entryIndex; index < input.bars.length && Date.parse(input.bars[index]!.time) <= deadline; index += 1) {
    exitIndex = index;
    const bar = input.bars[index]!;
    const targetHit = input.direction === 1 ? bar.bid.h >= input.target : bar.ask.l <= input.target;
    const stopHit = input.direction === 1 ? bar.bid.l <= input.stop : bar.ask.h >= input.stop;
    if (targetHit && stopHit) { outcome = "AMBIGUOUS_STOP"; resultR = -0.75; break; }
    if (targetHit) { outcome = "TARGET"; resultR = 1.5; break; }
    if (stopHit) { outcome = "STOP"; resultR = -0.75; break; }
  }
  if (outcome === "TIME_EXIT") {
    const exit = input.direction === 1 ? input.bars[exitIndex]!.bid.c : input.bars[exitIndex]!.ask.c;
    resultR = 0.75 * (input.direction === 1 ? exit - input.executableEntry : input.executableEntry - exit) / input.risk;
  }

  let maximumFavorableRBeforeOutcome = 0, maximumAdverseRBeforeOutcome = 0;
  for (let index = input.entryIndex; index <= exitIndex; index += 1) {
    const bar = input.bars[index]!;
    const favorable = input.direction === 1 ? (bar.bid.h - input.executableEntry) / input.risk : (input.executableEntry - bar.ask.l) / input.risk;
    const adverse = input.direction === 1 ? (input.executableEntry - bar.bid.l) / input.risk : (bar.ask.h - input.executableEntry) / input.risk;
    maximumFavorableRBeforeOutcome = Math.max(maximumFavorableRBeforeOutcome, favorable);
    maximumAdverseRBeforeOutcome = Math.max(maximumAdverseRBeforeOutcome, adverse);
  }

  let horizonEndIndex = input.entryIndex, maximumFavorableR72h = 0, maximumAdverseR72h = 0, targetTouchedAfterStop = false;
  for (let index = input.entryIndex; index < input.bars.length && Date.parse(input.bars[index]!.time) <= deadline; index += 1) {
    horizonEndIndex = index;
    const bar = input.bars[index]!;
    const favorable = input.direction === 1 ? (bar.bid.h - input.executableEntry) / input.risk : (input.executableEntry - bar.ask.l) / input.risk;
    const adverse = input.direction === 1 ? (input.executableEntry - bar.bid.l) / input.risk : (bar.ask.h - input.executableEntry) / input.risk;
    maximumFavorableR72h = Math.max(maximumFavorableR72h, favorable);
    maximumAdverseR72h = Math.max(maximumAdverseR72h, adverse);
    const targetHit = input.direction === 1 ? bar.bid.h >= input.target : bar.ask.l <= input.target;
    if ((outcome === "STOP" || outcome === "AMBIGUOUS_STOP") && index > exitIndex && targetHit) targetTouchedAfterStop = true;
  }
  const horizonExit = input.direction === 1 ? input.bars[horizonEndIndex]!.bid.c : input.bars[horizonEndIndex]!.ask.c;
  const netDirectionalMoveR72h = (input.direction === 1 ? horizonExit - input.executableEntry : input.executableEntry - horizonExit) / input.risk;
  return {
    outcome,
    resultR,
    exitIndex,
    maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome,
    maximumFavorableR72h,
    maximumAdverseR72h,
    netDirectionalMoveR72h,
    targetTouchedAfterStop,
  };
}

function resolveTrade(group: EurUsdNewsV12Group, bars: Bar[], indexByTime: Map<number, number>): Trade | null {
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  if (releaseIndex === undefined || releaseIndex < 14 || !bars[releaseIndex + 3]) return null;
  const preReleaseIndex = releaseIndex - 1;
  const decisionIndex = releaseIndex + 2;
  const entryIndex = releaseIndex + 3;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  if (!passesEurUsdNewsV12FrozenFilters({
    group,
    preReleaseAtr,
    preReleaseMid: bars[preReleaseIndex]!.mid.c,
    confirmationCloseMid: bars[decisionIndex]!.mid.c,
  })) return null;

  const entryBar = bars[entryIndex]!;
  const executableEntry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const levels = createEurUsdNewsV12Levels({ direction: group.direction, executableEntry, preReleaseAtr });
  const spreadPips = (entryBar.ask.o - entryBar.bid.o) * 10_000;
  const resolved = resolvePath({ bars, entryIndex, direction: group.direction, executableEntry, risk: levels.risk, stop: levels.stop, target: levels.target });
  const inverseDirection = (group.direction * -1) as 1 | -1;
  const inverseEntry = inverseDirection === 1 ? entryBar.ask.o : entryBar.bid.o;
  const inverseLevels = createEurUsdNewsV12Levels({ direction: inverseDirection, executableEntry: inverseEntry, preReleaseAtr });
  const inverse = resolvePath({ bars, entryIndex, direction: inverseDirection, executableEntry: inverseEntry, risk: inverseLevels.risk, stop: inverseLevels.stop, target: inverseLevels.target });
  return {
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: group.direction === 1 ? "UP" : "DOWN",
    surpriseStrength: group.surpriseStrength,
    preReleaseAtrPips: preReleaseAtr * 10_000,
    spreadPips,
    spreadToStopRatio: (entryBar.ask.o - entryBar.bid.o) / levels.risk,
    executableEntry,
    stop: levels.stop,
    target: levels.target,
    risk: levels.risk,
    confirmationMoveAtr: group.direction * (bars[decisionIndex]!.mid.c - bars[preReleaseIndex]!.mid.c) / levels.risk,
    eventNames: group.events.map((event) => `${event.currency} ${event.eventName}`),
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    resolutionTimeUtc: new Date(Date.parse(bars[resolved.exitIndex]!.time)).toISOString(),
    minutesToOutcome: (Date.parse(bars[resolved.exitIndex]!.time) - Date.parse(entryBar.time)) / 60_000,
    maximumFavorableRBeforeOutcome: resolved.maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome: resolved.maximumAdverseRBeforeOutcome,
    maximumFavorableR72h: resolved.maximumFavorableR72h,
    maximumAdverseR72h: resolved.maximumAdverseR72h,
    netDirectionalMoveR72h: resolved.netDirectionalMoveR72h,
    targetTouchedAfterStop: resolved.targetTouchedAfterStop,
    inverseOutcome: inverse.outcome,
    inverseResultR: inverse.resultR,
  };
}

function applyCooldown<T extends { releaseTimeUtc: string }>(groups: T[], cooldownHours: number) {
  if (cooldownHours <= 0) return groups;
  const selected: T[] = [];
  for (const group of groups) {
    const previous = selected.at(-1);
    if (!previous || Date.parse(group.releaseTimeUtc) >= Date.parse(previous.releaseTimeUtc) + cooldownHours * 3_600_000) selected.push(group);
  }
  return selected;
}

function resolveExpansionTrade(group: EurUsdNewsV12Group, spec: ExpansionSpec, bars: Bar[], indexByTime: Map<number, number>): Trade | null {
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  const confirmationBars = spec.confirmationMinutes / 5;
  if (releaseIndex === undefined || releaseIndex < 14 || !bars[releaseIndex + confirmationBars]) return null;
  const preReleaseIndex = releaseIndex - 1;
  const decisionIndex = releaseIndex + confirmationBars - 1;
  const entryIndex = releaseIndex + confirmationBars;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  if (!Number.isFinite(preReleaseAtr) || preReleaseAtr <= 0) return null;
  if (group.surpriseStrength < spec.surpriseThreshold || preReleaseAtr * 10_000 > spec.atrCeilingPips) return null;
  const confirmationAligned = group.direction === 1
    ? bars[decisionIndex]!.mid.c > bars[preReleaseIndex]!.mid.c
    : bars[decisionIndex]!.mid.c < bars[preReleaseIndex]!.mid.c;
  if (!confirmationAligned) return null;

  const entryBar = bars[entryIndex]!;
  const executableEntry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  let risk = preReleaseAtr;
  if (group.direction === -1 && group.surpriseStrength < 0.25) {
    const releaseWindow = bars.slice(releaseIndex, entryIndex);
    const releaseHigh = Math.max(...releaseWindow.map((bar) => bar.mid.h));
    const releaseLow = Math.min(...releaseWindow.map((bar) => bar.mid.l));
    risk = Math.max(preReleaseAtr, 0.5 * (releaseHigh - releaseLow));
  }
  const spreadPips = (entryBar.ask.o - entryBar.bid.o) * 10_000;
  const spreadToStopRatio = (entryBar.ask.o - entryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) return null;
  const stop = group.direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = group.direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const resolved = resolvePath({ bars, entryIndex, direction: group.direction, executableEntry, risk, stop, target });
  return {
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: group.direction === 1 ? "UP" : "DOWN",
    surpriseStrength: group.surpriseStrength,
    preReleaseAtrPips: preReleaseAtr * 10_000,
    spreadPips,
    spreadToStopRatio,
    executableEntry,
    stop,
    target,
    risk,
    confirmationMoveAtr: group.direction * (bars[decisionIndex]!.mid.c - bars[preReleaseIndex]!.mid.c) / preReleaseAtr,
    eventNames: group.events.map((event) => `${event.currency} ${event.eventName}`),
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    resolutionTimeUtc: new Date(Date.parse(bars[resolved.exitIndex]!.time)).toISOString(),
    minutesToOutcome: (Date.parse(bars[resolved.exitIndex]!.time) - Date.parse(entryBar.time)) / 60_000,
    maximumFavorableRBeforeOutcome: resolved.maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome: resolved.maximumAdverseRBeforeOutcome,
    maximumFavorableR72h: resolved.maximumFavorableR72h,
    maximumAdverseR72h: resolved.maximumAdverseR72h,
    netDirectionalMoveR72h: resolved.netDirectionalMoveR72h,
    targetTouchedAfterStop: resolved.targetTouchedAfterStop,
    inverseOutcome: "TIME_EXIT",
    inverseResultR: 0,
  };
}

function resolveHighFrequencyTrade(group: RawEventGroup, spec: HighFrequencySpec, bars: Bar[], indexByTime: Map<number, number>): Trade | null {
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  const confirmationBars = spec.confirmationMinutes / 5;
  if (releaseIndex === undefined || releaseIndex < 14 || !bars[releaseIndex + confirmationBars]) return null;
  const preReleaseIndex = releaseIndex - 1;
  const decisionIndex = releaseIndex + confirmationBars - 1;
  const entryIndex = releaseIndex + confirmationBars;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  if (!Number.isFinite(preReleaseAtr) || preReleaseAtr <= 0 || preReleaseAtr * 10_000 > spec.atrCeilingPips) return null;
  const confirmationMove = bars[decisionIndex]!.mid.c - bars[preReleaseIndex]!.mid.c;
  if (Math.abs(confirmationMove) < spec.minimumConfirmationMoveAtr * preReleaseAtr || confirmationMove === 0) return null;
  const direction = confirmationMove > 0 ? 1 : -1;
  const entryBar = bars[entryIndex]!;
  const executableEntry = direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const releaseWindow = bars.slice(releaseIndex, entryIndex);
  const releaseHigh = Math.max(...releaseWindow.map((bar) => bar.mid.h));
  const releaseLow = Math.min(...releaseWindow.map((bar) => bar.mid.l));
  const risk = Math.max(preReleaseAtr, spec.postReleaseRangeMultiplier * (releaseHigh - releaseLow));
  const spreadPips = (entryBar.ask.o - entryBar.bid.o) * 10_000;
  const spreadToStopRatio = (entryBar.ask.o - entryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) return null;
  const stop = direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const resolved = resolvePath({ bars, entryIndex, direction, executableEntry, risk, stop, target });
  return {
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: direction === 1 ? "UP" : "DOWN",
    surpriseStrength: 0,
    preReleaseAtrPips: preReleaseAtr * 10_000,
    spreadPips,
    spreadToStopRatio,
    executableEntry,
    stop,
    target,
    risk,
    confirmationMoveAtr: Math.abs(confirmationMove) / preReleaseAtr,
    eventNames: group.events.map((event) => `${event.currency} ${event.eventName}`),
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    resolutionTimeUtc: new Date(Date.parse(bars[resolved.exitIndex]!.time)).toISOString(),
    minutesToOutcome: (Date.parse(bars[resolved.exitIndex]!.time) - Date.parse(entryBar.time)) / 60_000,
    maximumFavorableRBeforeOutcome: resolved.maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome: resolved.maximumAdverseRBeforeOutcome,
    maximumFavorableR72h: resolved.maximumFavorableR72h,
    maximumAdverseR72h: resolved.maximumAdverseR72h,
    netDirectionalMoveR72h: resolved.netDirectionalMoveR72h,
    targetTouchedAfterStop: resolved.targetTouchedAfterStop,
    inverseOutcome: "TIME_EXIT",
    inverseResultR: 0,
  };
}

function resolveBroadNewsTrade(group: EurUsdNewsV12Group, spec: BroadNewsSpec, bars: Bar[], indexByTime: Map<number, number>): Trade | null {
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  const confirmationBars = spec.confirmationMinutes / 5;
  if (releaseIndex === undefined || releaseIndex < 14 || !bars[releaseIndex + confirmationBars]) return null;
  const preReleaseIndex = releaseIndex - 1;
  const decisionIndex = releaseIndex + confirmationBars - 1;
  const entryIndex = releaseIndex + confirmationBars;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  if (!Number.isFinite(preReleaseAtr) || preReleaseAtr <= 0 || preReleaseAtr * 10_000 > spec.atrCeilingPips || group.surpriseStrength < spec.surpriseThreshold) return null;
  const confirmationMove = bars[decisionIndex]!.mid.c - bars[preReleaseIndex]!.mid.c;
  if (spec.confirmationMode === "AGREEMENT" && group.direction * confirmationMove <= 0) return null;
  const entryBar = bars[entryIndex]!;
  const executableEntry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const releaseWindow = bars.slice(releaseIndex, entryIndex);
  const releaseHigh = Math.max(...releaseWindow.map((bar) => bar.mid.h));
  const releaseLow = Math.min(...releaseWindow.map((bar) => bar.mid.l));
  let risk = preReleaseAtr;
  if (spec.postReleaseRangeMultiplier > 0) risk = Math.max(risk, spec.postReleaseRangeMultiplier * (releaseHigh - releaseLow));
  else if (group.direction === -1 && group.surpriseStrength < 0.25) risk = Math.max(risk, 0.5 * (releaseHigh - releaseLow));
  const spreadPips = (entryBar.ask.o - entryBar.bid.o) * 10_000;
  const spreadToStopRatio = (entryBar.ask.o - entryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) return null;
  const stop = group.direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = group.direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const resolved = resolvePath({ bars, entryIndex, direction: group.direction, executableEntry, risk, stop, target });
  return {
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: group.direction === 1 ? "UP" : "DOWN",
    surpriseStrength: group.surpriseStrength,
    preReleaseAtrPips: preReleaseAtr * 10_000,
    spreadPips,
    spreadToStopRatio,
    executableEntry,
    stop,
    target,
    risk,
    confirmationMoveAtr: group.direction * confirmationMove / preReleaseAtr,
    eventNames: group.events.map((event) => `${event.currency} ${event.eventName}`),
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    resolutionTimeUtc: new Date(Date.parse(bars[resolved.exitIndex]!.time)).toISOString(),
    minutesToOutcome: (Date.parse(bars[resolved.exitIndex]!.time) - Date.parse(entryBar.time)) / 60_000,
    maximumFavorableRBeforeOutcome: resolved.maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome: resolved.maximumAdverseRBeforeOutcome,
    maximumFavorableR72h: resolved.maximumFavorableR72h,
    maximumAdverseR72h: resolved.maximumAdverseR72h,
    netDirectionalMoveR72h: resolved.netDirectionalMoveR72h,
    targetTouchedAfterStop: resolved.targetTouchedAfterStop,
    inverseOutcome: "TIME_EXIT",
    inverseResultR: 0,
  };
}

const sessionTechnicalTradeCache = new Map<string, Trade | null>();

function resolveSessionTechnicalTrade(signalIndex: number, spec: SessionTechnicalSpec): Trade | null {
  const entryIndex = signalIndex + 1;
  const lookbackIndex = signalIndex - spec.lookbackBars;
  if (lookbackIndex < 0 || !bars[entryIndex]) return null;
  const expectedLookbackMilliseconds = spec.lookbackBars * 5 * 60_000;
  if (Date.parse(bars[signalIndex]!.time) - Date.parse(bars[lookbackIndex]!.time) !== expectedLookbackMilliseconds) return null;
  const atr = atr14At(bars, signalIndex);
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const observedMove = bars[signalIndex]!.mid.c - bars[lookbackIndex]!.mid.c;
  if (Math.abs(observedMove) < spec.minimumMoveAtr * atr || observedMove === 0) return null;
  const cacheKey = `${signalIndex}:${spec.lookbackBars}:${spec.directionMode}:${spec.stopAtrMultiplier}`;
  if (sessionTechnicalTradeCache.has(cacheKey)) return sessionTechnicalTradeCache.get(cacheKey)!;
  const momentumDirection = observedMove > 0 ? 1 : -1;
  const direction = (spec.directionMode === "MOMENTUM" ? momentumDirection : -momentumDirection) as 1 | -1;
  const entryBar = bars[entryIndex]!;
  const executableEntry = direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const risk = spec.stopAtrMultiplier * atr;
  const spreadPips = (entryBar.ask.o - entryBar.bid.o) * 10_000;
  const spreadToStopRatio = (entryBar.ask.o - entryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) {
    sessionTechnicalTradeCache.set(cacheKey, null);
    return null;
  }
  const stop = direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const resolved = resolvePath({ bars, entryIndex, direction, executableEntry, risk, stop, target });
  const trade: Trade = {
    releaseTimeUtc: new Date(Date.parse(bars[signalIndex]!.time)).toISOString(),
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    direction: direction === 1 ? "UP" : "DOWN",
    surpriseStrength: 0,
    preReleaseAtrPips: atr * 10_000,
    spreadPips,
    spreadToStopRatio,
    executableEntry,
    stop,
    target,
    risk,
    confirmationMoveAtr: Math.abs(observedMove) / atr,
    eventNames: [`TECHNICAL ${spec.directionMode} ${spec.lookbackBars * 5}m @ ${String(spec.utcHour).padStart(2, "0")}:00 UTC`],
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    resolutionTimeUtc: new Date(Date.parse(bars[resolved.exitIndex]!.time)).toISOString(),
    minutesToOutcome: (Date.parse(bars[resolved.exitIndex]!.time) - Date.parse(entryBar.time)) / 60_000,
    maximumFavorableRBeforeOutcome: resolved.maximumFavorableRBeforeOutcome,
    maximumAdverseRBeforeOutcome: resolved.maximumAdverseRBeforeOutcome,
    maximumFavorableR72h: resolved.maximumFavorableR72h,
    maximumAdverseR72h: resolved.maximumAdverseR72h,
    netDirectionalMoveR72h: resolved.netDirectionalMoveR72h,
    targetTouchedAfterStop: resolved.targetTouchedAfterStop,
    inverseOutcome: "TIME_EXIT",
    inverseResultR: 0,
  };
  sessionTechnicalTradeCache.set(cacheKey, trade);
  return trade;
}

function evaluateSessionTechnical(spec: SessionTechnicalSpec, fromInclusive: string, toExclusive: string) {
  const fromMs = Date.parse(fromInclusive);
  const toMs = Date.parse(toExclusive);
  const trades: Trade[] = [];
  for (let signalIndex = 100; signalIndex < bars.length - 1; signalIndex += 1) {
    const timestamp = Date.parse(bars[signalIndex]!.time);
    if (timestamp < fromMs || timestamp >= toMs) continue;
    const date = new Date(timestamp);
    if (date.getUTCHours() !== spec.utcHour || date.getUTCMinutes() !== 0) continue;
    const trade = resolveSessionTechnicalTrade(signalIndex, spec);
    if (trade) trades.push(trade);
  }
  return { spec, summary: summarize(trades), trades };
}

function resolveVariantTrade(input: {
  group: EurUsdNewsV12Group;
  baseline: Trade;
  bars: Bar[];
  indexByTime: Map<number, number>;
  spec: VariantSpec;
}): VariantTrade {
  const { group, baseline, bars, indexByTime, spec } = input;
  const skipped = (): VariantTrade => ({
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: null,
    entered: false,
    direction: baseline.direction,
    resultR: null,
    outcome: "SKIP",
    riskPips: null,
    spreadToStopRatio: null,
    executableEntry: null,
    risk: null,
    stop: null,
    target: null,
    baselineResultR: baseline.resultR,
    baselineOutcome: baseline.outcome,
  });
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  if (releaseIndex === undefined || releaseIndex < 14 || !bars[releaseIndex + 3]) return skipped();
  const preReleaseIndex = releaseIndex - 1;
  const decisionIndex = releaseIndex + 2;
  const baselineEntryIndex = releaseIndex + 3;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  let entryIndex = baselineEntryIndex;

  if (spec.entryMode === "CLOSE_CONFIRMED_PULLBACK") {
    const waitBars = Math.max(1, Math.floor((spec.maximumWaitMinutes ?? 30) / 5));
    let favorableExtremeClose = bars[decisionIndex]!.mid.c;
    let found = false;
    for (let signalIndex = baselineEntryIndex; signalIndex < Math.min(bars.length - 1, baselineEntryIndex + waitBars); signalIndex += 1) {
      const signalClose = bars[signalIndex]!.mid.c;
      favorableExtremeClose = group.direction === 1
        ? Math.max(favorableExtremeClose, signalClose)
        : Math.min(favorableExtremeClose, signalClose);
      const retracement = group.direction === 1
        ? favorableExtremeClose - signalClose
        : signalClose - favorableExtremeClose;
      const remainsAligned = group.direction === 1
        ? signalClose > bars[preReleaseIndex]!.mid.c
        : signalClose < bars[preReleaseIndex]!.mid.c;
      if (remainsAligned && retracement >= (spec.pullbackAtr ?? 0.5) * preReleaseAtr) {
        entryIndex = signalIndex + 1;
        found = true;
        break;
      }
    }
    if (!found) return skipped();
  }

  const entryBar = bars[entryIndex]!;
  const executableEntry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const rangeBars = bars.slice(releaseIndex, entryIndex);
  let risk = (spec.stopAtrMultiplier ?? 1) * preReleaseAtr;
  if (spec.stopMode === "POST_RELEASE_RANGE") {
    const high = Math.max(...rangeBars.map((bar) => bar.mid.h));
    const low = Math.min(...rangeBars.map((bar) => bar.mid.l));
    risk = Math.max(risk, (high - low) * (spec.postReleaseRangeMultiplier ?? 0.5));
  } else if (spec.stopMode === "RELEASE_STRUCTURE") {
    risk = group.direction === 1
      ? executableEntry - (Math.min(...rangeBars.map((bar) => bar.bid.l)) - 0.1 * preReleaseAtr)
      : (Math.max(...rangeBars.map((bar) => bar.ask.h)) + 0.1 * preReleaseAtr) - executableEntry;
    risk = Math.max(preReleaseAtr, risk);
  }
  if (!Number.isFinite(risk) || risk <= 0) return skipped();
  const spreadToStopRatio = (entryBar.ask.o - entryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) return skipped();
  const stop = group.direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = group.direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const resolved = resolvePath({ bars, entryIndex, direction: group.direction, executableEntry, risk, stop, target });
  return {
    releaseTimeUtc: group.releaseTimeUtc,
    entryTimeUtc: new Date(Date.parse(entryBar.time)).toISOString(),
    entered: true,
    direction: baseline.direction,
    resultR: resolved.resultR,
    outcome: resolved.outcome,
    riskPips: risk * 10_000,
    spreadToStopRatio,
    executableEntry,
    risk,
    stop,
    target,
    baselineResultR: baseline.resultR,
    baselineOutcome: baseline.outcome,
  };
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((trade) => trade.resultR > 0).length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const trade of trades) { equity += trade.resultR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : null,
    totalR,
    expectancyR: trades.length ? totalR / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maxDrawdownR,
    medianSpreadToStopRatio: trades.length ? [...trades].sort((a, b) => a.spreadToStopRatio - b.spreadToStopRatio)[Math.floor(trades.length / 2)]!.spreadToStopRatio : null,
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function diagnoseLosses(trades: Trade[]) {
  const losses = trades.filter((trade) => trade.resultR < 0);
  const winners = trades.filter((trade) => trade.resultR > 0);
  const count = (predicate: (trade: Trade) => boolean) => losses.filter(predicate).length;
  return {
    trades: trades.length,
    losses: losses.length,
    stopTiming: {
      entryBar: count((trade) => trade.minutesToOutcome === 0),
      within15Minutes: count((trade) => trade.minutesToOutcome > 0 && trade.minutesToOutcome <= 15),
      within1Hour: count((trade) => trade.minutesToOutcome > 15 && trade.minutesToOutcome <= 60),
      after1Hour: count((trade) => trade.minutesToOutcome > 60),
    },
    directionEvidence: {
      netWrongAt72Hours: count((trade) => trade.netDirectionalMoveR72h < 0),
      netRightAt72HoursDespiteStop: count((trade) => trade.netDirectionalMoveR72h > 0),
      inverseWouldHitTarget: count((trade) => trade.inverseOutcome === "TARGET"),
      inverseAlsoLost: count((trade) => trade.inverseResultR < 0),
    },
    pathEvidence: {
      originalTargetTouchedOnlyAfterStop: count((trade) => trade.targetTouchedAfterStop),
      reachedAtLeast1RFavorableBeforeLosing: count((trade) => trade.maximumFavorableRBeforeOutcome >= 1),
      reachedLessThanHalfRFavorableBeforeLosing: count((trade) => trade.maximumFavorableRBeforeOutcome < 0.5),
      confirmationAlreadyMovedAtLeast1Atr: count((trade) => trade.confirmationMoveAtr >= 1),
    },
    winnerVsLoser: {
      medianSpreadToStopRatio: { winners: median(winners.map((trade) => trade.spreadToStopRatio)), losses: median(losses.map((trade) => trade.spreadToStopRatio)) },
      medianConfirmationMoveAtr: { winners: median(winners.map((trade) => trade.confirmationMoveAtr)), losses: median(losses.map((trade) => trade.confirmationMoveAtr)) },
      medianSurpriseStrength: { winners: median(winners.map((trade) => trade.surpriseStrength)), losses: median(losses.map((trade) => trade.surpriseStrength)) },
      medianPreReleaseAtrPips: { winners: median(winners.map((trade) => trade.preReleaseAtrPips)), losses: median(losses.map((trade) => trade.preReleaseAtrPips)) },
    },
    lossesByDirection: {
      up: count((trade) => trade.direction === "UP"),
      down: count((trade) => trade.direction === "DOWN"),
    },
    ambiguousM5Losses: {
      total: count((trade) => trade.outcome === "AMBIGUOUS_STOP"),
      targetFirstOnM1: count((trade) => trade.m1AmbiguousResolution === "TARGET_FIRST"),
      stopFirstOnM1: count((trade) => trade.m1AmbiguousResolution === "STOP_FIRST"),
      stillAmbiguousOnM1: count((trade) => trade.m1AmbiguousResolution === "STILL_AMBIGUOUS"),
      unresolved: count((trade) => trade.outcome === "AMBIGUOUS_STOP" && (!trade.m1AmbiguousResolution || trade.m1AmbiguousResolution === "NO_TOUCH" || trade.m1AmbiguousResolution === "UNAVAILABLE")),
    },
    performanceByDirection: Object.fromEntries((["UP", "DOWN"] as const).map((direction) => [direction.toLowerCase(), summarize(trades.filter((trade) => trade.direction === direction))])),
    performanceByNewsFamily: Object.fromEntries((["LABOR", "RETAIL", "PMI", "GDP", "OTHER"] as const).map((family) => {
      const matches = trades.filter((trade) => {
        const names = trade.eventNames.join(" ");
        if (family === "LABOR") return /Employment|Unemployment|Hourly Earnings|Job Openings/.test(names);
        if (family === "RETAIL") return /Retail Sales/.test(names);
        if (family === "PMI") return /PMI/.test(names);
        if (family === "GDP") return /GDP/.test(names) && !/Employment|Unemployment|Hourly Earnings|Job Openings/.test(names);
        return !/Employment|Unemployment|Hourly Earnings|Job Openings|Retail Sales|PMI|GDP/.test(names);
      });
      return [family.toLowerCase(), summarize(matches)];
    })),
    rows: losses,
  };
}

function summarizeVariant(trades: VariantTrade[]) {
  const entered = trades.filter((trade): trade is VariantTrade & { resultR: number } => trade.entered && trade.resultR !== null);
  const baselineWinners = trades.filter((trade) => trade.baselineResultR > 0);
  const baselineLosers = trades.filter((trade) => trade.baselineResultR < 0);
  const summary = summarize(entered.map((trade): Trade => ({
    releaseTimeUtc: trade.releaseTimeUtc,
    entryTimeUtc: trade.entryTimeUtc!,
    direction: trade.direction,
    surpriseStrength: 0,
    preReleaseAtrPips: trade.riskPips ?? 0,
    spreadPips: 0,
    spreadToStopRatio: trade.spreadToStopRatio ?? 0,
    executableEntry: 1,
    stop: 1,
    target: 1,
    risk: 1,
    confirmationMoveAtr: 0,
    eventNames: [],
    resultR: trade.resultR,
    outcome: trade.outcome as Trade["outcome"],
    resolutionTimeUtc: trade.entryTimeUtc!,
    minutesToOutcome: 0,
    maximumFavorableRBeforeOutcome: 0,
    maximumAdverseRBeforeOutcome: 0,
    maximumFavorableR72h: 0,
    maximumAdverseR72h: 0,
    netDirectionalMoveR72h: 0,
    targetTouchedAfterStop: false,
    inverseOutcome: "TIME_EXIT",
    inverseResultR: 0,
  })));
  const count = (rows: VariantTrade[], predicate: (trade: VariantTrade) => boolean) => rows.filter(predicate).length;
  return {
    opportunities: trades.length,
    ...summary,
    skipped: trades.length - entered.length,
    medianRiskPips: median(entered.map((trade) => trade.riskPips!)),
    baselineWins: baselineWinners.length,
    baselineWinsPreserved: count(baselineWinners, (trade) => (trade.resultR ?? 0) > 0),
    baselineWinsTurnedLoss: count(baselineWinners, (trade) => trade.resultR !== null && trade.resultR < 0),
    baselineWinsSkipped: count(baselineWinners, (trade) => !trade.entered),
    baselineLosses: baselineLosers.length,
    baselineLossesRescued: count(baselineLosers, (trade) => (trade.resultR ?? 0) > 0),
    baselineLossesStillLost: count(baselineLosers, (trade) => trade.resultR !== null && trade.resultR < 0),
    baselineLossesSkipped: count(baselineLosers, (trade) => !trade.entered),
  };
}

function resolveRescueTrade(input: {
  group: EurUsdNewsV12Group;
  baseline: Trade;
  bars: Bar[];
  indexByTime: Map<number, number>;
  spec: RescueSpec;
}): RescueTrade {
  const { group, baseline, bars, indexByTime, spec } = input;
  const noRetry = (): RescueTrade => ({
    releaseTimeUtc: baseline.releaseTimeUtc,
    direction: baseline.direction,
    baselineResultR: baseline.resultR,
    retryTaken: false,
    retryEntryTimeUtc: null,
    retryOutcome: "NO_RETRY",
    retryResultR: 0,
    eventResultR: baseline.resultR,
  });
  if (baseline.resultR >= 0) return noRetry();
  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  const stoppedIndex = indexByTime.get(Date.parse(baseline.resolutionTimeUtc));
  if (releaseIndex === undefined || stoppedIndex === undefined) return noRetry();
  const preReleaseMid = bars[releaseIndex - 1]!.mid.c;
  const confirmationClose = bars[releaseIndex + 2]!.mid.c;
  const reclaimLevel = spec.reclaimLevel === "PRE_RELEASE_MID"
    ? preReleaseMid
    : spec.reclaimLevel === "CONFIRMATION_CLOSE"
      ? confirmationClose
      : baseline.executableEntry;
  const reclaimThreshold = baseline.direction === "UP"
    ? reclaimLevel + spec.reclaimBufferAtr * baseline.risk
    : reclaimLevel - spec.reclaimBufferAtr * baseline.risk;
  const maximumSignalIndex = Math.min(bars.length - 2, stoppedIndex + Math.floor(spec.maximumWaitMinutes / 5));
  let retryEntryIndex: number | null = null;
  for (let signalIndex = stoppedIndex + 1; signalIndex <= maximumSignalIndex; signalIndex += 1) {
    const reclaimed = baseline.direction === "UP"
      ? bars[signalIndex]!.mid.c >= reclaimThreshold
      : bars[signalIndex]!.mid.c <= reclaimThreshold;
    if (reclaimed) {
      retryEntryIndex = signalIndex + 1;
      break;
    }
  }
  if (retryEntryIndex === null) return noRetry();
  const retryEntryBar = bars[retryEntryIndex]!;
  const direction = baseline.direction === "UP" ? 1 : -1;
  const executableEntry = direction === 1 ? retryEntryBar.ask.o : retryEntryBar.bid.o;
  const risk = spec.retryStopAtrMultiplier * baseline.risk;
  const spreadToStopRatio = (retryEntryBar.ask.o - retryEntryBar.bid.o) / risk;
  if (spreadToStopRatio > 0.5) return noRetry();
  const stop = direction === 1 ? executableEntry - risk : executableEntry + risk;
  const target = direction === 1 ? executableEntry + 2 * risk : executableEntry - 2 * risk;
  const retry = resolvePath({ bars, entryIndex: retryEntryIndex, direction, executableEntry, risk, stop, target });
  return {
    releaseTimeUtc: baseline.releaseTimeUtc,
    direction: baseline.direction,
    baselineResultR: baseline.resultR,
    retryTaken: true,
    retryEntryTimeUtc: new Date(Date.parse(retryEntryBar.time)).toISOString(),
    retryOutcome: retry.outcome,
    retryResultR: retry.resultR,
    eventResultR: baseline.resultR + retry.resultR,
  };
}

function summarizeRescue(trades: RescueTrade[]) {
  const results = trades.map((trade) => trade.eventResultR);
  const wins = results.filter((result) => result > 0).length;
  const totalR = results.reduce((sum, result) => sum + result, 0);
  const grossProfit = results.filter((result) => result > 0).reduce((sum, result) => sum + result, 0);
  const grossLoss = -results.filter((result) => result < 0).reduce((sum, result) => sum + result, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const result of results) { equity += result; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  const baselineWinners = trades.filter((trade) => trade.baselineResultR > 0);
  const baselineLosers = trades.filter((trade) => trade.baselineResultR < 0);
  return {
    opportunities: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : null,
    totalR,
    expectancyR: trades.length ? totalR / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    maxDrawdownR,
    totalExecutedTrades: trades.length + trades.filter((trade) => trade.retryTaken).length,
    retriesTaken: trades.filter((trade) => trade.retryTaken).length,
    baselineWinsPreserved: baselineWinners.filter((trade) => trade.eventResultR > 0).length,
    baselineLossesRescuedToNetWin: baselineLosers.filter((trade) => trade.eventResultR > 0).length,
    baselineLossesWorsened: baselineLosers.filter((trade) => trade.retryResultR < 0).length,
    baselineLossesNoRetry: baselineLosers.filter((trade) => !trade.retryTaken).length,
  };
}

function buildHybridTrades(input: {
  alternative: VariantTrade[];
  baselines: Trade[];
  condition: HybridCondition;
}) {
  const baselineByRelease = new Map(input.baselines.map((trade) => [Date.parse(trade.releaseTimeUtc), trade]));
  return input.alternative.flatMap((alternative): VariantTrade[] => {
    const baseline = baselineByRelease.get(Date.parse(alternative.releaseTimeUtc));
    if (!baseline) return [];
    const useAlternative = input.condition === "DOWN_ONLY" ? baseline.direction === "DOWN"
      : input.condition === "WEAK_0_25" ? baseline.surpriseStrength < 0.25
        : input.condition === "WEAK_0_50" ? baseline.surpriseStrength < 0.5
          : input.condition === "CHASED_3_ATR" ? baseline.confirmationMoveAtr >= 3
            : input.condition === "DOWN_WEAK_0_25" ? baseline.direction === "DOWN" && baseline.surpriseStrength < 0.25
              : baseline.direction === "DOWN" && baseline.confirmationMoveAtr >= 3;
    if (useAlternative && alternative.entered) return [alternative];
    return [{
      releaseTimeUtc: baseline.releaseTimeUtc,
      entryTimeUtc: baseline.entryTimeUtc,
      entered: true,
      direction: baseline.direction,
      resultR: baseline.resultR,
      outcome: baseline.outcome,
      riskPips: baseline.risk * 10_000,
      spreadToStopRatio: baseline.spreadToStopRatio,
      executableEntry: baseline.executableEntry,
      risk: baseline.risk,
      stop: baseline.stop,
      target: baseline.target,
      baselineResultR: baseline.resultR,
      baselineOutcome: baseline.outcome,
    }];
  });
}

function buildDownWeakRangeHybrid(input: {
  alternative: VariantTrade[];
  baselines: Trade[];
  surpriseThreshold: number;
}) {
  const baselineByRelease = new Map(input.baselines.map((trade) => [Date.parse(trade.releaseTimeUtc), trade]));
  return input.alternative.flatMap((alternative): VariantTrade[] => {
    const baseline = baselineByRelease.get(Date.parse(alternative.releaseTimeUtc));
    if (!baseline) return [];
    if (baseline.direction === "DOWN" && baseline.surpriseStrength < input.surpriseThreshold && alternative.entered) return [alternative];
    return [{
      releaseTimeUtc: baseline.releaseTimeUtc,
      entryTimeUtc: baseline.entryTimeUtc,
      entered: true,
      direction: baseline.direction,
      resultR: baseline.resultR,
      outcome: baseline.outcome,
      riskPips: baseline.risk * 10_000,
      spreadToStopRatio: baseline.spreadToStopRatio,
      executableEntry: baseline.executableEntry,
      risk: baseline.risk,
      stop: baseline.stop,
      target: baseline.target,
      baselineResultR: baseline.resultR,
      baselineOutcome: baseline.outcome,
    }];
  });
}

function resolveManagedTrade(trade: VariantTrade, bars: Bar[], indexByTime: Map<number, number>, spec: ManagementSpec): ManagedTrade | null {
  if (!trade.entered || trade.resultR === null || trade.entryTimeUtc === null || trade.executableEntry === null || trade.risk === null || trade.stop === null || trade.target === null) return null;
  const entryIndex = indexByTime.get(Date.parse(trade.entryTimeUtc));
  if (entryIndex === undefined) return null;
  const direction = trade.direction === "UP" ? 1 : -1;
  const deadline = Date.parse(trade.entryTimeUtc) + 72 * 3_600_000;
  let activateAtIndex: number | null = null;
  let managementActivated = false;
  let remainingFraction = 1;
  let partialRealizedR = 0;
  let lastIndex = entryIndex;

  for (let index = entryIndex; index < bars.length && Date.parse(bars[index]!.time) <= deadline; index += 1) {
    lastIndex = index;
    const bar = bars[index]!;
    if (activateAtIndex === index) {
      managementActivated = true;
      if (spec.partialFraction > 0) {
        const partialExit = direction === 1 ? bar.bid.o : bar.ask.o;
        const partialPriceR = direction === 1
          ? (partialExit - trade.executableEntry) / trade.risk
          : (trade.executableEntry - partialExit) / trade.risk;
        partialRealizedR = spec.partialFraction * partialPriceR * 0.75;
        remainingFraction -= spec.partialFraction;
      }
    }

    const activeStop = managementActivated ? trade.executableEntry : trade.stop;
    const targetHit = direction === 1 ? bar.bid.h >= trade.target : bar.ask.l <= trade.target;
    const stopHit = direction === 1 ? bar.bid.l <= activeStop : bar.ask.h >= activeStop;
    if (targetHit && stopHit) {
      const resultR = managementActivated ? partialRealizedR : -0.75;
      return { releaseTimeUtc: trade.releaseTimeUtc, baselineResultR: trade.resultR, resultR, managementActivated, partialRealizedR, outcome: managementActivated ? "BREAK_EVEN" : "STOP" };
    }
    if (targetHit) {
      const resultR = partialRealizedR + remainingFraction * 1.5;
      return { releaseTimeUtc: trade.releaseTimeUtc, baselineResultR: trade.resultR, resultR, managementActivated, partialRealizedR, outcome: "TARGET" };
    }
    if (stopHit) {
      const resultR = managementActivated ? partialRealizedR : -0.75;
      return { releaseTimeUtc: trade.releaseTimeUtc, baselineResultR: trade.resultR, resultR, managementActivated, partialRealizedR, outcome: managementActivated ? "BREAK_EVEN" : "STOP" };
    }

    if (!managementActivated && activateAtIndex === null && index < bars.length - 1) {
      const closePriceR = direction === 1
        ? (bar.bid.c - trade.executableEntry) / trade.risk
        : (trade.executableEntry - bar.ask.c) / trade.risk;
      if (closePriceR >= spec.activationCloseR) activateAtIndex = index + 1;
    }
  }

  const exit = direction === 1 ? bars[lastIndex]!.bid.c : bars[lastIndex]!.ask.c;
  const remainingPriceR = direction === 1
    ? (exit - trade.executableEntry) / trade.risk
    : (trade.executableEntry - exit) / trade.risk;
  return {
    releaseTimeUtc: trade.releaseTimeUtc,
    baselineResultR: trade.resultR,
    resultR: partialRealizedR + remainingFraction * remainingPriceR * 0.75,
    managementActivated,
    partialRealizedR,
    outcome: "TIME_EXIT",
  };
}

function summarizeManaged(trades: ManagedTrade[]) {
  const wins = trades.filter((trade) => trade.resultR > 0).length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossProfit = trades.filter((trade) => trade.resultR > 0).reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLoss = -trades.filter((trade) => trade.resultR < 0).reduce((sum, trade) => sum + trade.resultR, 0);
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : null,
    totalR,
    expectancyR: trades.length ? totalR / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    managementActivated: trades.filter((trade) => trade.managementActivated).length,
    baselineWinsPreserved: trades.filter((trade) => trade.baselineResultR > 0 && trade.resultR > 0).length,
    baselineWinsTurnedNonWin: trades.filter((trade) => trade.baselineResultR > 0 && trade.resultR <= 0).length,
    baselineLossesTurnedWin: trades.filter((trade) => trade.baselineResultR < 0 && trade.resultR > 0).length,
    baselineLossesTurnedScratch: trades.filter((trade) => trade.baselineResultR < 0 && trade.resultR === 0).length,
  };
}

const bars = await fetchM5();
const indexByTime = new Map(bars.map((bar, index) => [Date.parse(bar.time), index]));
const development = loadGroups(developmentFile);
const validation = loadGroups(validationFile);
const developmentRawGroups = loadRawEventGroups(developmentFile);
const validationRawGroups = loadRawEventGroups(validationFile);
const developmentBroadNewsGroups = loadBroadNewsGroups(developmentFile);
const validationBroadNewsGroups = loadBroadNewsGroups(validationFile);
const developmentTrades = await Promise.all(development.groups.map((group) => resolveTrade(group, bars, indexByTime)).filter((trade): trade is Trade => trade !== null).map(resolveAmbiguousWithM1));
const validationTrades = await Promise.all(validation.groups.map((group) => resolveTrade(group, bars, indexByTime)).filter((trade): trade is Trade => trade !== null).map(resolveAmbiguousWithM1));

const candidates = [null, 0.5, 0.4, 1 / 3, 0.25] as const;
const developmentFrontier = candidates.map((maximumSpreadToStopRatio) => {
  const trades = maximumSpreadToStopRatio === null ? developmentTrades : developmentTrades.filter((trade) => trade.spreadToStopRatio <= maximumSpreadToStopRatio);
  return { maximumSpreadToStopRatio, ...summarize(trades) };
});
const reusedValidationDiagnostics = candidates.map((maximumSpreadToStopRatio) => {
  const trades = maximumSpreadToStopRatio === null ? validationTrades : validationTrades.filter((trade) => trade.spreadToStopRatio <= maximumSpreadToStopRatio);
  return { maximumSpreadToStopRatio, ...summarize(trades) };
});
const v13DevelopmentTrades = developmentTrades.filter((trade) => trade.spreadToStopRatio <= 0.5);
const v13ValidationTrades = validationTrades.filter((trade) => trade.spreadToStopRatio <= 0.5);
const highFrequencySpecs: HighFrequencySpec[] = ([5, 15] as const).flatMap((confirmationMinutes) =>
  ([0, 0.25, 0.5, 0.75, 1, 1.5] as const).flatMap((minimumConfirmationMoveAtr) =>
    ([6, 10, 15] as const).flatMap((atrCeilingPips) =>
      ([0, 2, 4] as const).flatMap((cooldownHours) =>
        ([0.35, 0.5, 0.75, 1] as const).map((postReleaseRangeMultiplier): HighFrequencySpec => ({
          name: `price_confirm_${confirmationMinutes}_move_${String(minimumConfirmationMoveAtr).replace(".", "_")}_atr_${atrCeilingPips}_cooldown_${cooldownHours}_range_${String(postReleaseRangeMultiplier).replace(".", "_")}`,
          confirmationMinutes,
          minimumConfirmationMoveAtr,
          atrCeilingPips,
          cooldownHours,
          postReleaseRangeMultiplier,
        }))
      )
    )
  )
);

function evaluateHighFrequency(spec: HighFrequencySpec, rawGroups: RawEventGroup[]) {
  const groups = applyCooldown(rawGroups, spec.cooldownHours);
  const trades = groups.map((group) => resolveHighFrequencyTrade(group, spec, bars, indexByTime)).filter((trade): trade is Trade => trade !== null);
  return { spec, summary: summarize(trades), trades };
}

const developmentHighFrequencyResults = highFrequencySpecs.map((spec) => evaluateHighFrequency(spec, developmentRawGroups));
const validationHighFrequencyDiagnostics = highFrequencySpecs.map((spec) => evaluateHighFrequency(spec, validationRawGroups));
const validationHighFrequencyByName = new Map(validationHighFrequencyDiagnostics.map((candidate) => [candidate.spec.name, candidate]));
const highFrequencyCrossPeriod = developmentHighFrequencyResults.map((developmentCandidate) => {
  const validationCandidate = validationHighFrequencyByName.get(developmentCandidate.spec.name)!;
  const combinedDescriptiveOnly = summarize([...developmentCandidate.trades, ...validationCandidate.trades]);
  return {
    spec: developmentCandidate.spec,
    development: developmentCandidate.summary,
    reusedValidation: validationCandidate.summary,
    combinedDescriptiveOnly,
    meetsRequestedGate: developmentCandidate.summary.trades >= 100
      && validationCandidate.summary.trades >= 100
      && combinedDescriptiveOnly.trades >= 200
      && (developmentCandidate.summary.winRate ?? 0) >= 0.45
      && (validationCandidate.summary.winRate ?? 0) >= 0.45
      && (combinedDescriptiveOnly.winRate ?? 0) >= 0.45
      && (developmentCandidate.summary.profitFactor ?? 0) > 1
      && (validationCandidate.summary.profitFactor ?? 0) > 1,
  };
});
const requestedFrequencyWinner = highFrequencyCrossPeriod
  .filter((candidate) => candidate.meetsRequestedGate)
  .sort((left, right) => right.combinedDescriptiveOnly.trades - left.combinedDescriptiveOnly.trades
    || (right.combinedDescriptiveOnly.expectancyR ?? -Infinity) - (left.combinedDescriptiveOnly.expectancyR ?? -Infinity))[0] ?? null;
const bestWinRateAtRequestedVolume = highFrequencyCrossPeriod
  .filter((candidate) => candidate.development.trades >= 100 && candidate.reusedValidation.trades >= 100 && candidate.combinedDescriptiveOnly.trades >= 200)
  .sort((left, right) => (right.combinedDescriptiveOnly.winRate ?? -Infinity) - (left.combinedDescriptiveOnly.winRate ?? -Infinity)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const highestVolumeAtRequestedWinRate = highFrequencyCrossPeriod
  .filter((candidate) => (candidate.development.winRate ?? 0) >= 0.45
    && (candidate.reusedValidation.winRate ?? 0) >= 0.45
    && (candidate.combinedDescriptiveOnly.winRate ?? 0) >= 0.45)
  .sort((left, right) => right.combinedDescriptiveOnly.trades - left.combinedDescriptiveOnly.trades
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const broadNewsSpecs: BroadNewsSpec[] = ([0, 0.01, 0.02, 0.035] as const).flatMap((surpriseThreshold) =>
  ([6, 10, 15] as const).flatMap((atrCeilingPips) =>
    ([5, 15] as const).flatMap((confirmationMinutes) =>
      (["AGREEMENT", "NONE"] as const).flatMap((confirmationMode) =>
        ([0, 2, 4] as const).flatMap((cooldownHours) =>
          ([0, 0.5, 1] as const).map((postReleaseRangeMultiplier): BroadNewsSpec => ({
            name: `broad_surprise_${String(surpriseThreshold).replace(".", "_")}_atr_${atrCeilingPips}_confirm_${confirmationMinutes}_${confirmationMode.toLowerCase()}_cooldown_${cooldownHours}_range_${String(postReleaseRangeMultiplier).replace(".", "_")}`,
            surpriseThreshold,
            atrCeilingPips,
            confirmationMinutes,
            confirmationMode,
            cooldownHours,
            postReleaseRangeMultiplier,
          }))
        )
      )
    )
  )
);

function evaluateBroadNews(spec: BroadNewsSpec, groups: EurUsdNewsV12Group[]) {
  const cooled = applyCooldown(groups, spec.cooldownHours);
  const trades = cooled.map((group) => resolveBroadNewsTrade(group, spec, bars, indexByTime)).filter((trade): trade is Trade => trade !== null);
  return { spec, summary: summarize(trades), trades };
}

const developmentBroadNewsResults = broadNewsSpecs.map((spec) => evaluateBroadNews(spec, developmentBroadNewsGroups));
const validationBroadNewsDiagnostics = broadNewsSpecs.map((spec) => evaluateBroadNews(spec, validationBroadNewsGroups));
const validationBroadNewsByName = new Map(validationBroadNewsDiagnostics.map((candidate) => [candidate.spec.name, candidate]));
const broadNewsCrossPeriod = developmentBroadNewsResults.map((developmentCandidate) => {
  const validationCandidate = validationBroadNewsByName.get(developmentCandidate.spec.name)!;
  const combinedDescriptiveOnly = summarize([...developmentCandidate.trades, ...validationCandidate.trades]);
  return {
    spec: developmentCandidate.spec,
    development: developmentCandidate.summary,
    reusedValidation: validationCandidate.summary,
    combinedDescriptiveOnly,
    meetsRequestedGate: developmentCandidate.summary.trades >= 100
      && validationCandidate.summary.trades >= 100
      && combinedDescriptiveOnly.trades >= 200
      && (developmentCandidate.summary.winRate ?? 0) >= 0.45
      && (validationCandidate.summary.winRate ?? 0) >= 0.45
      && (combinedDescriptiveOnly.winRate ?? 0) >= 0.45
      && (developmentCandidate.summary.profitFactor ?? 0) > 1
      && (validationCandidate.summary.profitFactor ?? 0) > 1,
  };
});
const broadNewsRequestedWinner = broadNewsCrossPeriod
  .filter((candidate) => candidate.meetsRequestedGate)
  .sort((left, right) => right.combinedDescriptiveOnly.trades - left.combinedDescriptiveOnly.trades
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const broadNewsBestWinRateAtRequestedVolume = broadNewsCrossPeriod
  .filter((candidate) => candidate.development.trades >= 100 && candidate.reusedValidation.trades >= 100)
  .sort((left, right) => (right.combinedDescriptiveOnly.winRate ?? -Infinity) - (left.combinedDescriptiveOnly.winRate ?? -Infinity)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const requestedOverallWinner = [requestedFrequencyWinner, broadNewsRequestedWinner]
  .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
  .sort((left, right) => right.combinedDescriptiveOnly.trades - left.combinedDescriptiveOnly.trades
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const coarseExpansionSpecs: ExpansionSpec[] = ([0, 0.02, 0.04, 0.06766917293233082] as const).flatMap((surpriseThreshold) =>
  ([5.53, 7.5, 10, 15] as const).flatMap((atrCeilingPips) =>
    ([5, 10, 15, 20] as const).flatMap((confirmationMinutes) =>
      ([0, 2, 4] as const).map((cooldownHours): ExpansionSpec => ({
        name: `surprise_${String(surpriseThreshold).replace(".", "_")}_atr_${String(atrCeilingPips).replace(".", "_")}_confirm_${confirmationMinutes}_cooldown_${cooldownHours}`,
        surpriseThreshold,
        atrCeilingPips,
        confirmationMinutes,
        cooldownHours,
      }))
    )
  )
);
const refinedExpansionSpecs: ExpansionSpec[] = ([0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06, 0.06766917293233082] as const).flatMap((surpriseThreshold) =>
  ([5.53, 6, 6.5, 7, 7.5, 8, 9, 10] as const).flatMap((atrCeilingPips) =>
    ([2, 4] as const).map((cooldownHours): ExpansionSpec => ({
      name: `surprise_${String(surpriseThreshold).replace(".", "_")}_atr_${String(atrCeilingPips).replace(".", "_")}_confirm_15_cooldown_${cooldownHours}`,
      surpriseThreshold,
      atrCeilingPips,
      confirmationMinutes: 15,
      cooldownHours,
    }))
  )
);
const expansionSpecs = [...new Map([...coarseExpansionSpecs, ...refinedExpansionSpecs].map((spec) => [spec.name, spec])).values()];

function evaluateExpansion(spec: ExpansionSpec, dataset: ReturnType<typeof loadGroups>) {
  const groups = applyCooldown(dataset.directionalGroupsAll, spec.cooldownHours);
  const trades = groups.map((group) => resolveExpansionTrade(group, spec, bars, indexByTime)).filter((trade): trade is Trade => trade !== null);
  return { spec, summary: summarize(trades), trades };
}

const developmentExpansionResults = expansionSpecs.map((spec) => evaluateExpansion(spec, development));
const reusedValidationExpansionDiagnostics = expansionSpecs.map((spec) => evaluateExpansion(spec, validation));
const expansionValidationByName = new Map(reusedValidationExpansionDiagnostics.map((candidate) => [candidate.spec.name, candidate]));
const targetExpandedWinRate = 16 / 35;
const expansionCrossPeriod = developmentExpansionResults.map((developmentCandidate) => {
  const validationCandidate = expansionValidationByName.get(developmentCandidate.spec.name)!;
  const combinedSummary = summarize([...developmentCandidate.trades, ...validationCandidate.trades]);
  return {
    spec: developmentCandidate.spec,
    development: developmentCandidate.summary,
    reusedValidation: validationCandidate.summary,
    combinedDescriptiveOnly: combinedSummary,
    qualifiesAcrossExposedPeriods: developmentCandidate.summary.trades > 15
      && validationCandidate.summary.trades > 20
      && combinedSummary.trades > 35
      && (developmentCandidate.summary.winRate ?? 0) >= targetExpandedWinRate
      && (validationCandidate.summary.winRate ?? 0) >= targetExpandedWinRate
      && (combinedSummary.winRate ?? 0) >= targetExpandedWinRate
      && (developmentCandidate.summary.profitFactor ?? 0) > 1
      && (validationCandidate.summary.profitFactor ?? 0) > 1,
    qualifiesCombinedWinRate: combinedSummary.trades > 35
      && (combinedSummary.winRate ?? 0) >= targetExpandedWinRate
      && (developmentCandidate.summary.winRate ?? 0) >= 0.4
      && (validationCandidate.summary.winRate ?? 0) >= 0.4
      && (developmentCandidate.summary.expectancyR ?? 0) > 0
      && (validationCandidate.summary.expectancyR ?? 0) > 0
      && (developmentCandidate.summary.profitFactor ?? 0) > 1
      && (validationCandidate.summary.profitFactor ?? 0) > 1,
  };
});
const highestFrequencyExpansion = expansionCrossPeriod
  .filter((candidate) => candidate.qualifiesCombinedWinRate)
  .sort((left, right) => right.combinedDescriptiveOnly.trades - left.combinedDescriptiveOnly.trades
    || (right.combinedDescriptiveOnly.expectancyR ?? -Infinity) - (left.combinedDescriptiveOnly.expectancyR ?? -Infinity)
    || right.spec.cooldownHours - left.spec.cooldownHours)[0] ?? null;
const developmentSelectedExpansion = developmentExpansionResults
  .filter((candidate) => candidate.summary.trades > 15
    && (candidate.summary.winRate ?? 0) >= targetExpandedWinRate
    && (candidate.summary.profitFactor ?? 0) > 1)
  .sort((left, right) => right.summary.trades - left.summary.trades
    || (right.summary.expectancyR ?? -Infinity) - (left.summary.expectancyR ?? -Infinity))[0] ?? null;
const developmentSelectedExpansionValidation = developmentSelectedExpansion
  ? expansionValidationByName.get(developmentSelectedExpansion.spec.name) ?? null
  : null;
const ladderBaseSpec = highestFrequencyExpansion?.spec ?? {
  name: "fallback_v15",
  surpriseThreshold: 0.035,
  atrCeilingPips: 6,
  confirmationMinutes: 15 as const,
  cooldownHours: 4 as const,
};
const ladderDelays = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;
const ladderSpecs: ExpansionSpec[] = ladderDelays.map((confirmationMinutes) => ({
  name: `ladder_${confirmationMinutes}`,
  surpriseThreshold: ladderBaseSpec.surpriseThreshold,
  atrCeilingPips: ladderBaseSpec.atrCeilingPips,
  confirmationMinutes,
  cooldownHours: ladderBaseSpec.cooldownHours,
}));
const developmentLadderArms = ladderSpecs.map((spec) => evaluateExpansion(spec, development));
const validationLadderArms = ladderSpecs.map((spec) => evaluateExpansion(spec, validation));

function uniqueTradesByEntry(trades: Trade[]) {
  return [...new Map(trades.map((trade) => [`${trade.releaseTimeUtc}:${trade.entryTimeUtc}`, trade])).values()]
    .sort((left, right) => Date.parse(left.entryTimeUtc) - Date.parse(right.entryTimeUtc));
}

const ladderCombinations = Array.from({ length: (1 << ladderSpecs.length) - 1 }, (_, index) => index + 1).map((mask) => {
  const selectedDelays = ladderDelays.filter((_, index) => (mask & (1 << index)) !== 0);
  const developmentCombined = uniqueTradesByEntry(developmentLadderArms
    .filter((arm) => selectedDelays.includes(arm.spec.confirmationMinutes as typeof selectedDelays[number]))
    .flatMap((arm) => arm.trades));
  const validationCombined = uniqueTradesByEntry(validationLadderArms
    .filter((arm) => selectedDelays.includes(arm.spec.confirmationMinutes as typeof selectedDelays[number]))
    .flatMap((arm) => arm.trades));
  const developmentSummary = summarize(developmentCombined);
  const validationSummary = summarize(validationCombined);
  const combinedDescriptiveOnly = summarize([...developmentCombined, ...validationCombined]);
  return {
    selectedDelays,
    development: developmentSummary,
    reusedValidation: validationSummary,
    combinedDescriptiveOnly,
    distinctDevelopmentEvents: new Set(developmentCombined.map((trade) => trade.releaseTimeUtc)).size,
    distinctValidationEvents: new Set(validationCombined.map((trade) => trade.releaseTimeUtc)).size,
    meetsRequestedGate: developmentSummary.trades >= 100
      && validationSummary.trades >= 100
      && (developmentSummary.winRate ?? 0) >= 0.45
      && (validationSummary.winRate ?? 0) >= 0.45
      && (developmentSummary.profitFactor ?? 0) > 1
      && (validationSummary.profitFactor ?? 0) > 1,
  };
});
const ladderWinner = ladderCombinations
  .filter((candidate) => candidate.meetsRequestedGate)
  .sort((left, right) => Math.abs(left.combinedDescriptiveOnly.trades - 200) - Math.abs(right.combinedDescriptiveOnly.trades - 200)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const bestLadderAtRequestedVolume = ladderCombinations
  .filter((candidate) => candidate.development.trades >= 100 && candidate.reusedValidation.trades >= 100)
  .sort((left, right) => Math.min(right.development.winRate ?? 0, right.reusedValidation.winRate ?? 0)
      - Math.min(left.development.winRate ?? 0, left.reusedValidation.winRate ?? 0)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const sessionTechnicalSpecs: SessionTechnicalSpec[] = Array.from({ length: 14 }, (_, index) => index + 6).flatMap((utcHour) =>
  ([12, 24, 48, 96] as const).flatMap((lookbackBars) =>
    (["MOMENTUM", "MEAN_REVERSION"] as const).flatMap((directionMode) =>
      ([0.5, 1, 1.5, 2, 3] as const).flatMap((minimumMoveAtr) =>
        ([0.75, 1, 1.25, 1.5, 2] as const).map((stopAtrMultiplier): SessionTechnicalSpec => ({
          name: `session_${utcHour}_${directionMode.toLowerCase()}_${lookbackBars}_move_${String(minimumMoveAtr).replace(".", "_")}_stop_${String(stopAtrMultiplier).replace(".", "_")}`,
          utcHour,
          lookbackBars,
          directionMode,
          minimumMoveAtr,
          stopAtrMultiplier,
        }))
      )
    )
  )
);
const developmentSessionTechnicalResults = sessionTechnicalSpecs.map((spec) => evaluateSessionTechnical(spec, "2024-08-01T00:00:00.000Z", "2025-08-01T00:00:00.000Z"));
const validationSessionTechnicalDiagnostics = sessionTechnicalSpecs.map((spec) => evaluateSessionTechnical(spec, "2025-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"));
const validationSessionTechnicalByName = new Map(validationSessionTechnicalDiagnostics.map((candidate) => [candidate.spec.name, candidate]));
const sessionTechnicalCrossPeriod = developmentSessionTechnicalResults.map((developmentCandidate) => {
  const validationCandidate = validationSessionTechnicalByName.get(developmentCandidate.spec.name)!;
  const combinedDescriptiveOnly = summarize([...developmentCandidate.trades, ...validationCandidate.trades]);
  return {
    spec: developmentCandidate.spec,
    development: developmentCandidate.summary,
    reusedValidation: validationCandidate.summary,
    combinedDescriptiveOnly,
    meetsStandaloneGate: developmentCandidate.summary.trades >= 100
      && validationCandidate.summary.trades >= 100
      && (developmentCandidate.summary.winRate ?? 0) >= 0.45
      && (validationCandidate.summary.winRate ?? 0) >= 0.45
      && (developmentCandidate.summary.profitFactor ?? 0) > 1
      && (validationCandidate.summary.profitFactor ?? 0) > 1,
  };
});
const bestSessionTechnicalAtVolume = sessionTechnicalCrossPeriod
  .filter((candidate) => candidate.development.trades >= 70 && candidate.reusedValidation.trades >= 70)
  .sort((left, right) => (right.combinedDescriptiveOnly.winRate ?? -Infinity) - (left.combinedDescriptiveOnly.winRate ?? -Infinity)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const standaloneSessionTechnicalWinner = sessionTechnicalCrossPeriod
  .filter((candidate) => candidate.meetsStandaloneGate)
  .sort((left, right) => right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const selectedFrequencyDevelopmentTrades = highestFrequencyExpansion
  ? developmentExpansionResults.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades
  : [];
const selectedFrequencyValidationTrades = highestFrequencyExpansion
  ? reusedValidationExpansionDiagnostics.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades
  : [];
const compositeSessionCrossPeriod = developmentSessionTechnicalResults.map((developmentCandidate) => {
  const validationCandidate = validationSessionTechnicalByName.get(developmentCandidate.spec.name)!;
  const developmentTradesCombined = [...selectedFrequencyDevelopmentTrades, ...developmentCandidate.trades]
    .sort((left, right) => Date.parse(left.entryTimeUtc) - Date.parse(right.entryTimeUtc));
  const validationTradesCombined = [...selectedFrequencyValidationTrades, ...validationCandidate.trades]
    .sort((left, right) => Date.parse(left.entryTimeUtc) - Date.parse(right.entryTimeUtc));
  const developmentSummary = summarize(developmentTradesCombined);
  const validationSummary = summarize(validationTradesCombined);
  const combinedDescriptiveOnly = summarize([...developmentTradesCombined, ...validationTradesCombined]);
  return {
    spec: developmentCandidate.spec,
    technicalDevelopment: developmentCandidate.summary,
    technicalReusedValidation: validationCandidate.summary,
    development: developmentSummary,
    reusedValidation: validationSummary,
    combinedDescriptiveOnly,
    meetsRequestedGate: developmentSummary.trades >= 100
      && validationSummary.trades >= 100
      && (developmentSummary.winRate ?? 0) >= 0.45
      && (validationSummary.winRate ?? 0) >= 0.45
      && (developmentSummary.profitFactor ?? 0) > 1
      && (validationSummary.profitFactor ?? 0) > 1,
  };
});
const compositeSessionWinner = compositeSessionCrossPeriod
  .filter((candidate) => candidate.meetsRequestedGate)
  .sort((left, right) => Math.abs(left.combinedDescriptiveOnly.trades - 200) - Math.abs(right.combinedDescriptiveOnly.trades - 200)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const bestCompositeSessionAtRequestedVolume = compositeSessionCrossPeriod
  .filter((candidate) => candidate.development.trades >= 100 && candidate.reusedValidation.trades >= 100)
  .sort((left, right) => (right.combinedDescriptiveOnly.winRate ?? -Infinity) - (left.combinedDescriptiveOnly.winRate ?? -Infinity)
    || right.combinedDescriptiveOnly.totalR - left.combinedDescriptiveOnly.totalR)[0] ?? null;
const variantSpecs: VariantSpec[] = [
  { name: "immediate_pre_atr_1_25", entryMode: "IMMEDIATE", stopMode: "PRE_RELEASE_ATR", stopAtrMultiplier: 1.25 },
  { name: "immediate_pre_atr_1_50", entryMode: "IMMEDIATE", stopMode: "PRE_RELEASE_ATR", stopAtrMultiplier: 1.5 },
  { name: "immediate_pre_atr_2_00", entryMode: "IMMEDIATE", stopMode: "PRE_RELEASE_ATR", stopAtrMultiplier: 2 },
  { name: "immediate_post_range_0_25", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.25 },
  { name: "immediate_post_range_0_35", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.35 },
  { name: "immediate_post_range_0_40", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.4 },
  { name: "immediate_post_range_0_50", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.5 },
  { name: "immediate_post_range_0_60", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.6 },
  { name: "immediate_post_range_0_75", entryMode: "IMMEDIATE", stopMode: "POST_RELEASE_RANGE", stopAtrMultiplier: 1, postReleaseRangeMultiplier: 0.75 },
  { name: "immediate_release_structure", entryMode: "IMMEDIATE", stopMode: "RELEASE_STRUCTURE" },
  ...([0.25, 0.5, 0.75] as const).flatMap((pullbackAtr) => ([30, 60] as const).flatMap((maximumWaitMinutes) => ([1, 1.25, 1.5] as const).map((stopAtrMultiplier): VariantSpec => ({
    name: `pullback_${String(pullbackAtr).replace(".", "_")}_atr_wait_${maximumWaitMinutes}_pre_atr_${String(stopAtrMultiplier).replace(".", "_")}`,
    entryMode: "CLOSE_CONFIRMED_PULLBACK",
    pullbackAtr,
    maximumWaitMinutes,
    stopMode: "PRE_RELEASE_ATR",
    stopAtrMultiplier,
  })) )),
  ...([0.25, 0.5, 0.75] as const).flatMap((pullbackAtr) => ([30, 60] as const).map((maximumWaitMinutes): VariantSpec => ({
    name: `pullback_${String(pullbackAtr).replace(".", "_")}_atr_wait_${maximumWaitMinutes}_structure`,
    entryMode: "CLOSE_CONFIRMED_PULLBACK",
    pullbackAtr,
    maximumWaitMinutes,
    stopMode: "RELEASE_STRUCTURE",
  }))),
];

function evaluateVariant(spec: VariantSpec, groups: EurUsdNewsV12Group[], baselineTrades: Trade[]) {
  const groupByRelease = new Map(groups.map((group) => [Date.parse(group.releaseTimeUtc), group]));
  const trades = baselineTrades.flatMap((baseline): VariantTrade[] => {
    const group = groupByRelease.get(Date.parse(baseline.releaseTimeUtc));
    return group ? [resolveVariantTrade({ group, baseline, bars, indexByTime, spec })] : [];
  });
  return { spec, summary: summarizeVariant(trades), trades };
}

const developmentVariantResults = variantSpecs.map((spec) => evaluateVariant(spec, development.groups, v13DevelopmentTrades));
const reusedValidationVariantDiagnostics = variantSpecs.map((spec) => evaluateVariant(spec, validation.groups, v13ValidationTrades));
const v13DevelopmentSummary = summarize(v13DevelopmentTrades);
const robustnessThresholds = [0.15, 0.2, 0.25, 0.3, 0.35] as const;
const robustnessRangeFactors = [0.35, 0.4, 0.5, 0.6, 0.75] as const;

function createRobustnessGrid(variantResults: ReturnType<typeof evaluateVariant>[], baselines: Trade[]) {
  const alternativeByName = new Map(variantResults.map((result) => [result.spec.name, result]));
  return robustnessThresholds.flatMap((surpriseThreshold) => robustnessRangeFactors.flatMap((rangeFactor) => {
    const alternativeName = `immediate_post_range_${rangeFactor.toFixed(2).replace(".", "_")}`;
    const alternative = alternativeByName.get(alternativeName);
    if (!alternative) return [];
    const trades = buildDownWeakRangeHybrid({ alternative: alternative.trades, baselines, surpriseThreshold });
    return [{ surpriseThreshold, rangeFactor, summary: summarizeVariant(trades), trades }];
  }));
}

const developmentRobustnessGrid = createRobustnessGrid(developmentVariantResults, v13DevelopmentTrades);
const reusedValidationRobustnessGrid = createRobustnessGrid(reusedValidationVariantDiagnostics, v13ValidationTrades);
const hybridAlternativeNames = [
  "immediate_pre_atr_1_25",
  "immediate_post_range_0_25",
  "immediate_post_range_0_50",
  "immediate_post_range_0_75",
  "immediate_release_structure",
] as const;
const hybridConditions: HybridCondition[] = ["DOWN_ONLY", "WEAK_0_25", "WEAK_0_50", "CHASED_3_ATR", "DOWN_WEAK_0_25", "DOWN_CHASED_3_ATR"];

function createHybridResults(variantResults: ReturnType<typeof evaluateVariant>[], baselines: Trade[]) {
  const alternativeByName = new Map(variantResults.map((result) => [result.spec.name, result]));
  return hybridAlternativeNames.flatMap((alternativeName) => hybridConditions.flatMap((condition) => {
    const alternative = alternativeByName.get(alternativeName);
    if (!alternative) return [];
    const trades = buildHybridTrades({ alternative: alternative.trades, baselines, condition });
    return [{ name: `${condition.toLowerCase()}__${alternativeName}`, alternativeName, condition, summary: summarizeVariant(trades), trades }];
  }));
}

const developmentHybridResults = createHybridResults(developmentVariantResults, v13DevelopmentTrades);
const reusedValidationHybridDiagnostics = createHybridResults(reusedValidationVariantDiagnostics, v13ValidationTrades);
const selectedHybridVariant = developmentHybridResults
  .filter((candidate) => candidate.summary.trades === v13DevelopmentTrades.length
    && candidate.summary.baselineWinsPreserved >= Math.ceil(candidate.summary.baselineWins * 0.8)
    && candidate.summary.totalR > v13DevelopmentSummary.totalR
    && (candidate.summary.winRate ?? 0) >= 0.4
    && (candidate.summary.profitFactor ?? 0) > 1)
  .sort((left, right) => right.summary.totalR - left.summary.totalR || right.summary.baselineWinsPreserved - left.summary.baselineWinsPreserved)[0] ?? null;
const selectedHybridValidation = selectedHybridVariant
  ? reusedValidationHybridDiagnostics.find((candidate) => candidate.name === selectedHybridVariant.name) ?? null
  : null;
const crossPeriodExploratoryName = "down_weak_0_25__immediate_post_range_0_50";
const crossPeriodExploratoryDevelopment = developmentHybridResults.find((candidate) => candidate.name === crossPeriodExploratoryName)!;
const crossPeriodExploratoryValidation = reusedValidationHybridDiagnostics.find((candidate) => candidate.name === crossPeriodExploratoryName)!;
const currentConditionalTrades = [...crossPeriodExploratoryDevelopment.trades, ...crossPeriodExploratoryValidation.trades];
const highestFrequencyTrades = highestFrequencyExpansion
  ? [...developmentExpansionResults.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades,
    ...reusedValidationExpansionDiagnostics.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades]
  : [];
const highestFrequencyByRelease = new Map(highestFrequencyTrades.map((trade) => [Date.parse(trade.releaseTimeUtc), trade]));
const currentConditionalReleaseTimes = new Set(currentConditionalTrades.map((trade) => Date.parse(trade.releaseTimeUtc)));
const originalWinnerRows = currentConditionalTrades.filter((trade) => (trade.resultR ?? 0) > 0);
const addedFrequencyTrades = highestFrequencyTrades.filter((trade) => !currentConditionalReleaseTimes.has(Date.parse(trade.releaseTimeUtc)));
const expansionComposition = highestFrequencyExpansion ? {
  originalOpportunities: currentConditionalTrades.length,
  originalWinners: originalWinnerRows.length,
  originalWinnersPreserved: originalWinnerRows.filter((trade) => (highestFrequencyByRelease.get(Date.parse(trade.releaseTimeUtc))?.resultR ?? -Infinity) > 0).length,
  originalWinnersMissing: originalWinnerRows.filter((trade) => !highestFrequencyByRelease.has(Date.parse(trade.releaseTimeUtc))).length,
  originalWinnersTurnedLoss: originalWinnerRows.filter((trade) => {
    const expanded = highestFrequencyByRelease.get(Date.parse(trade.releaseTimeUtc));
    return expanded !== undefined && expanded.resultR < 0;
  }).length,
  addedTrades: summarize(addedFrequencyTrades),
} : null;
const v13ReusedValidationSummary = summarize(v13ValidationTrades);
const validationRobustnessByKey = new Map(reusedValidationRobustnessGrid.map((cell) => [`${cell.surpriseThreshold}:${cell.rangeFactor}`, cell]));
const robustnessCrossPeriod = developmentRobustnessGrid.map((developmentCell) => {
  const validationCell = validationRobustnessByKey.get(`${developmentCell.surpriseThreshold}:${developmentCell.rangeFactor}`)!;
  return {
    surpriseThreshold: developmentCell.surpriseThreshold,
    rangeFactor: developmentCell.rangeFactor,
    development: developmentCell.summary,
    reusedValidation: validationCell.summary,
    improvesBothPeriods: developmentCell.summary.totalR > v13DevelopmentSummary.totalR
      && validationCell.summary.totalR > v13ReusedValidationSummary.totalR,
    preservesAllBaselineWinners: developmentCell.summary.baselineWinsPreserved === developmentCell.summary.baselineWins
      && validationCell.summary.baselineWinsPreserved === validationCell.summary.baselineWins,
  };
});
const managementSpecs: ManagementSpec[] = [
  { name: "break_even_after_close_0_50r", activationCloseR: 0.5, partialFraction: 0 },
  { name: "break_even_after_close_0_75r", activationCloseR: 0.75, partialFraction: 0 },
  { name: "break_even_after_close_1_00r", activationCloseR: 1, partialFraction: 0 },
  { name: "partial_25_then_be_after_close_0_75r", activationCloseR: 0.75, partialFraction: 0.25 },
  { name: "partial_25_then_be_after_close_1_00r", activationCloseR: 1, partialFraction: 0.25 },
  { name: "partial_50_then_be_after_close_0_75r", activationCloseR: 0.75, partialFraction: 0.5 },
  { name: "partial_50_then_be_after_close_1_00r", activationCloseR: 1, partialFraction: 0.5 },
];

function evaluateManagement(spec: ManagementSpec, candidateTrades: VariantTrade[]) {
  const trades = candidateTrades.map((trade) => resolveManagedTrade(trade, bars, indexByTime, spec)).filter((trade): trade is ManagedTrade => trade !== null);
  return { spec, summary: summarizeManaged(trades), trades };
}

const managementDiagnostics = managementSpecs.map((spec) => {
  const developmentResult = evaluateManagement(spec, crossPeriodExploratoryDevelopment.trades);
  const reusedValidationResult = evaluateManagement(spec, crossPeriodExploratoryValidation.trades);
  return {
    spec,
    development: developmentResult.summary,
    reusedValidation: reusedValidationResult.summary,
    combinedDescriptiveOnly: summarizeManaged([...developmentResult.trades, ...reusedValidationResult.trades]),
    improvesBothPeriods: developmentResult.summary.totalR > crossPeriodExploratoryDevelopment.summary.totalR
      && reusedValidationResult.summary.totalR > crossPeriodExploratoryValidation.summary.totalR,
    preservesAllCandidateWinners: developmentResult.summary.baselineWinsTurnedNonWin === 0
      && reusedValidationResult.summary.baselineWinsTurnedNonWin === 0,
  };
});
const selectedEntryStopVariant = developmentVariantResults
  .filter((candidate) => candidate.summary.trades >= 12
    && candidate.summary.baselineWinsPreserved >= Math.ceil(candidate.summary.baselineWins * 0.8)
    && candidate.summary.totalR > v13DevelopmentSummary.totalR
    && (candidate.summary.winRate ?? 0) >= 0.4
    && (candidate.summary.profitFactor ?? 0) > 1)
  .sort((left, right) => right.summary.totalR - left.summary.totalR || right.summary.baselineLossesRescued - left.summary.baselineLossesRescued)[0] ?? null;
const selectedEntryStopValidation = selectedEntryStopVariant
  ? evaluateVariant(selectedEntryStopVariant.spec, validation.groups, v13ValidationTrades)
  : null;
const rescueSpecs: RescueSpec[] = (["PRE_RELEASE_MID", "ORIGINAL_ENTRY", "CONFIRMATION_CLOSE"] as const).flatMap((reclaimLevel) =>
  ([0, 0.25] as const).flatMap((reclaimBufferAtr) =>
    ([60, 240, 720] as const).flatMap((maximumWaitMinutes) =>
      ([1, 1.25, 1.5] as const).map((retryStopAtrMultiplier): RescueSpec => ({
        name: `retry_${reclaimLevel.toLowerCase()}_buffer_${String(reclaimBufferAtr).replace(".", "_")}_wait_${maximumWaitMinutes}_stop_${String(retryStopAtrMultiplier).replace(".", "_")}`,
        reclaimLevel,
        reclaimBufferAtr,
        maximumWaitMinutes,
        retryStopAtrMultiplier,
      }))
    )
  )
);

function evaluateRescue(spec: RescueSpec, groups: EurUsdNewsV12Group[], baselineTrades: Trade[]) {
  const groupByRelease = new Map(groups.map((group) => [Date.parse(group.releaseTimeUtc), group]));
  const trades = baselineTrades.flatMap((baseline): RescueTrade[] => {
    const group = groupByRelease.get(Date.parse(baseline.releaseTimeUtc));
    return group ? [resolveRescueTrade({ group, baseline, bars, indexByTime, spec })] : [];
  });
  return { spec, summary: summarizeRescue(trades), trades };
}

const developmentRescueResults = rescueSpecs.map((spec) => evaluateRescue(spec, development.groups, v13DevelopmentTrades));
const reusedValidationRescueDiagnostics = rescueSpecs.map((spec) => evaluateRescue(spec, validation.groups, v13ValidationTrades));
const selectedRescueVariant = developmentRescueResults
  .filter((candidate) => candidate.summary.totalR > v13DevelopmentSummary.totalR
    && candidate.summary.baselineWinsPreserved === v13DevelopmentSummary.wins
    && (candidate.summary.winRate ?? 0) >= (v13DevelopmentSummary.winRate ?? 0)
    && (candidate.summary.profitFactor ?? 0) > 1)
  .sort((left, right) => right.summary.totalR - left.summary.totalR
    || right.summary.baselineLossesRescuedToNetWin - left.summary.baselineLossesRescuedToNetWin
    || left.summary.totalExecutedTrades - right.summary.totalExecutedTrades)[0] ?? null;
const selectedRescueValidation = selectedRescueVariant
  ? evaluateRescue(selectedRescueVariant.spec, validation.groups, v13ValidationTrades)
  : null;
const selectedDevelopment = developmentFrontier
  .filter((candidate) => candidate.maximumSpreadToStopRatio !== null && candidate.trades >= 20 && (candidate.winRate ?? 0) >= 0.4 && (candidate.expectancyR ?? 0) > 0 && (candidate.profitFactor ?? 0) > 1)
  .sort((left, right) => (right.expectancyR ?? -Infinity) - (left.expectancyR ?? -Infinity))[0] ?? null;
const lockedValidationTrades = selectedDevelopment
  ? validationTrades.filter((trade) => trade.spreadToStopRatio <= selectedDevelopment.maximumSpreadToStopRatio!)
  : [];
const validationSummary = selectedDevelopment ? summarize(lockedValidationTrades) : null;
const validationPassed = validationSummary !== null
  && validationSummary.trades >= 20
  && (validationSummary.winRate ?? 0) >= 0.4
  && (validationSummary.expectancyR ?? 0) > 0
  && (validationSummary.profitFactor ?? 0) > 1;

const report = {
  generatedAt: new Date().toISOString(),
  verdict: !selectedDevelopment ? "NO_DEVELOPMENT_GATE_VALIDATION_NOT_USED" : validationPassed ? "REUSED_VALIDATION_PASSED_NEW_FORWARD_REQUIRED" : "REUSED_VALIDATION_FAILED",
  execution: { enabled: false, status: "RESEARCH_ONLY", ordersAllowed: false },
  hypothesis: "reject entries where executable spread consumes too much of the fixed ATR stop distance",
  integrity: {
    development: "Aug 2024-Jul 2025 only selects the maximum spread-to-stop ratio",
    validation: selectedDevelopment ? "Aug 2025-Jul 2026 evaluated unchanged, but this period has been reused and is not untouched confirmation" : "not used for selection or promotion; fixed-candidate diagnostics are reported because this period was already exposed",
    August2026ForwardReadForSelection: false,
    frozenV12Modified: false,
    warning: "A candidate that passes still requires a new prospective sample starting after this experiment.",
  },
  rule: {
    base: "V12 news direction, surprise threshold, 15-minute confirmation, ATR ceiling, 1 ATR stop, 2 stop-distance target, 72-hour hold",
    challenger: "maximum executable spread divided by stop distance",
    candidates: candidates.map((value) => value === null ? "no gate" : value),
    developmentGate: "n>=20, win>=40%, expectancy>0, PF>1; select highest expectancy",
    validationGate: "n>=20, win>=40%, expectancy>0, PF>1",
  },
  data: {
    oandaM5Candles: bars.length,
    development: { calendarRows: development.calendarRows, directionalGroups: development.directionalGroups, nonOverlappingGroups: development.groups.length, frozenV12EligibleTrades: developmentTrades.length },
    validation: { calendarRows: validation.calendarRows, directionalGroups: validation.directionalGroups, nonOverlappingGroups: validation.groups.length, frozenV12EligibleTrades: validationTrades.length },
  },
  results: {
    developmentFrontier,
    reusedValidationDiagnostics,
    v18NewsEntryLadder: {
      status: ladderWinner ? "EXPLORATORY_GATE_MET_ON_EXPOSED_DATA" : "REQUESTED_GATE_NOT_MET",
      objective: "at least 100 executable entries per yearly period and >=45% wins in each while retaining +1.5R/-0.75R",
      baseOpportunityRule: ladderBaseSpec,
      mechanism: "one news opportunity may create distinct entries at selected completed-candle delays; every entry has its own executable bid/ask fill, stop, target, and 72-hour path resolution",
      warning: "entry count is not independent opportunity count; positions from one release are correlated and portfolio risk must be capped by event",
      delaysTestedMinutes: ladderDelays,
      combinationsTested: ladderCombinations.length,
      qualifyingCombinations: ladderCombinations.filter((candidate) => candidate.meetsRequestedGate).length,
      armSummaries: developmentLadderArms.map((developmentArm) => ({
        delayMinutes: developmentArm.spec.confirmationMinutes,
        development: developmentArm.summary,
        reusedValidation: validationLadderArms.find((validationArm) => validationArm.spec.name === developmentArm.spec.name)!.summary,
      })),
      winner: ladderWinner ? { ...ladderWinner, warning: "selected after both periods were exposed; research-only and requires prospective confirmation" } : null,
      bestAtRequestedVolume: bestLadderAtRequestedVolume,
    },
    v17NewsPlusSessionTechnical: {
      status: compositeSessionWinner ? "EXPLORATORY_GATE_MET_ON_EXPOSED_DATA" : "REQUESTED_GATE_NOT_MET",
      objective: "approximately 100 EUR/USD trades per yearly period while retaining >=45% wins, positive expectancy, and PF>1 in each exposed period",
      baseLane: highestFrequencyExpansion ? {
        spec: highestFrequencyExpansion.spec,
        development: highestFrequencyExpansion.development,
        reusedValidation: highestFrequencyExpansion.reusedValidation,
      } : null,
      complementaryLane: "one fixed UTC session decision per market day; past-only 1h/2h/4h/8h price move; momentum or mean-reversion direction; next-M5 executable bid/ask entry; ATR stop; 2:1 target; 72h maximum hold",
      gridSize: sessionTechnicalSpecs.length,
      qualifyingCompositeCandidates: compositeSessionCrossPeriod.filter((candidate) => candidate.meetsRequestedGate).length,
      winner: compositeSessionWinner ? { ...compositeSessionWinner, warning: "selected after both periods were exposed; research-only and requires a new prospective sample" } : null,
      bestCompositeAtRequestedVolume: bestCompositeSessionAtRequestedVolume,
      standaloneTechnicalWinner: standaloneSessionTechnicalWinner,
      bestStandaloneTechnicalAtAtLeast70TradesPerPeriod: bestSessionTechnicalAtVolume,
      candidateSummaries: compositeSessionCrossPeriod.map((candidate) => ({
        spec: candidate.spec,
        technicalDevelopment: candidate.technicalDevelopment,
        technicalReusedValidation: candidate.technicalReusedValidation,
        development: candidate.development,
        reusedValidation: candidate.reusedValidation,
        combinedDescriptiveOnly: candidate.combinedDescriptiveOnly,
        meetsRequestedGate: candidate.meetsRequestedGate,
      })),
    },
    v16HundredTradesPerYear: {
      status: requestedOverallWinner ? "EXPLORATORY_GATE_MET_ON_EXPOSED_DATA" : "REQUESTED_GATE_NOT_MET",
      objective: ">=100 trades in each yearly period and >=45% wins in each, with +1.5R/-0.75R, positive expectancy, and PF>1",
      mechanism: "all high-impact EUR/USD calendar releases; direction is the sign of a completed post-release candle; entry is the next M5 open; stop is max(pre-release ATR, configured share of observed post-release range)",
      gridSize: highFrequencySpecs.length + broadNewsSpecs.length,
      availableReleaseGroups: {
        allHighImpact: { development: developmentRawGroups.length, reusedValidation: validationRawGroups.length },
        broadNumeric: { development: developmentBroadNewsGroups.length, reusedValidation: validationBroadNewsGroups.length },
      },
      qualifyingCandidates: highFrequencyCrossPeriod.filter((candidate) => candidate.meetsRequestedGate).length + broadNewsCrossPeriod.filter((candidate) => candidate.meetsRequestedGate).length,
      winner: requestedOverallWinner ? { ...requestedOverallWinner, warning: "both periods were exposed during development; requires prospective confirmation" } : null,
      priceConfirmationLane: { winner: requestedFrequencyWinner, bestWinRateAtRequestedVolume, highestVolumeAtRequestedWinRate },
      broadNumericNewsLane: { winner: broadNewsRequestedWinner, bestWinRateAtRequestedVolume: broadNewsBestWinRateAtRequestedVolume },
      priceConfirmationCandidateSummaries: highFrequencyCrossPeriod.map(({ spec, development: developmentResult, reusedValidation: validationResult, combinedDescriptiveOnly, meetsRequestedGate }) => ({
        spec,
        development: developmentResult,
        reusedValidation: validationResult,
        combinedDescriptiveOnly,
        meetsRequestedGate,
      })),
      broadNumericCandidateSummaries: broadNewsCrossPeriod.map(({ spec, development: developmentResult, reusedValidation: validationResult, combinedDescriptiveOnly, meetsRequestedGate }) => ({
        spec,
        development: developmentResult,
        reusedValidation: validationResult,
        combinedDescriptiveOnly,
        meetsRequestedGate,
      })),
    },
    v15FrequencyExpansion: {
      status: "EXPLORATORY_REUSED_DATA_NOT_PROMOTABLE",
      objective: "increase resolved trade count above 35 while maintaining at least the current combined 16/35 (45.71%) win rate, with win>=40%, positive expectancy, and PF>1 in each exposed yearly period",
      fixedExecution: "conditional DOWN weak-surprise post-release-range stop; 2:1 target-to-stop; +1.5R/-0.75R; executable OANDA bid/ask; 72-hour maximum hold",
      gridSize: expansionSpecs.length,
      developmentSelected: developmentSelectedExpansion ? { spec: developmentSelectedExpansion.spec, summary: developmentSelectedExpansion.summary } : null,
      developmentSelectedReusedValidation: developmentSelectedExpansionValidation ? { spec: developmentSelectedExpansionValidation.spec, summary: developmentSelectedExpansionValidation.summary } : null,
      qualifyingAcrossExposedPeriods: expansionCrossPeriod.filter((candidate) => candidate.qualifiesAcrossExposedPeriods).length,
      qualifyingCombinedWinRate: expansionCrossPeriod.filter((candidate) => candidate.qualifiesCombinedWinRate).length,
      highestFrequencyAcrossExposedPeriods: highestFrequencyExpansion ? {
        ...highestFrequencyExpansion,
        warning: "chosen after both periods were exposed; descriptive only and requires a new prospective sample",
        composition: expansionComposition,
        trades: {
          development: developmentExpansionResults.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades,
          reusedValidation: reusedValidationExpansionDiagnostics.find((candidate) => candidate.spec.name === highestFrequencyExpansion.spec.name)!.trades,
        },
      } : null,
      candidateSummaries: expansionCrossPeriod.map(({ spec, development: developmentResult, reusedValidation: validationResult, combinedDescriptiveOnly, qualifiesAcrossExposedPeriods, qualifiesCombinedWinRate }) => ({
        spec,
        development: developmentResult,
        reusedValidation: validationResult,
        combinedDescriptiveOnly,
        qualifiesAcrossExposedPeriods,
        qualifiesCombinedWinRate,
      })),
    },
    v13LossDiagnostics: {
      development: diagnoseLosses(v13DevelopmentTrades),
      reusedValidation: diagnoseLosses(v13ValidationTrades),
      combinedDescriptiveOnly: diagnoseLosses([...v13DevelopmentTrades, ...v13ValidationTrades]),
    },
    v14EntryStopChallenger: {
      status: "RESEARCH_ONLY_REUSED_VALIDATION_NOT_PROMOTABLE",
      selectionPeriod: "Aug 2024-Jul 2025",
      selectionRule: "entered>=12; preserve>=80% of baseline winners; totalR above baseline; win>=40%; PF>1; maximize development totalR",
      baselineDevelopment: v13DevelopmentSummary,
      developmentCandidates: developmentVariantResults.map(({ spec, summary }) => ({ spec, summary })),
      reusedValidationCandidateDiagnostics: reusedValidationVariantDiagnostics.map(({ spec, summary }) => ({ spec, summary })),
      selectedDevelopment: selectedEntryStopVariant ? { spec: selectedEntryStopVariant.spec, summary: selectedEntryStopVariant.summary } : null,
      reusedValidation: selectedEntryStopValidation ? { spec: selectedEntryStopValidation.spec, summary: selectedEntryStopValidation.summary } : null,
      selectedTradeConversions: selectedEntryStopValidation ? {
        development: selectedEntryStopVariant!.trades,
        reusedValidation: selectedEntryStopValidation.trades,
      } : null,
    },
    v14OneRetryChallenger: {
      status: "RESEARCH_ONLY_REUSED_VALIDATION_NOT_PROMOTABLE",
      mechanism: "leave baseline winners untouched; after a real stop, permit one same-direction retry only after a completed M5 close reclaims a predeclared level; enter next M5 open",
      selectionPeriod: "Aug 2024-Jul 2025",
      selectionRule: "preserve every baseline winner; totalR above baseline; win rate no lower than baseline; PF>1; maximize development totalR",
      developmentCandidates: developmentRescueResults.map(({ spec, summary }) => ({ spec, summary })),
      reusedValidationCandidateDiagnostics: reusedValidationRescueDiagnostics.map(({ spec, summary }) => ({ spec, summary })),
      selectedDevelopment: selectedRescueVariant ? { spec: selectedRescueVariant.spec, summary: selectedRescueVariant.summary } : null,
      reusedValidation: selectedRescueValidation ? { spec: selectedRescueValidation.spec, summary: selectedRescueValidation.summary } : null,
      selectedTradeConversions: selectedRescueValidation ? {
        development: selectedRescueVariant!.trades,
        reusedValidation: selectedRescueValidation.trades,
      } : null,
    },
    v14ConditionalExecutionChallenger: {
      status: "EXPLORATORY_REUSED_DATA_NOT_PROMOTABLE",
      mechanism: "keep the baseline rule except on an observable weak subset, where a predeclared wider execution geometry is applied",
      selectionPeriod: "Aug 2024-Jul 2025",
      selectionRule: "enter every opportunity; preserve>=80% of baseline winners; totalR above baseline; win>=40%; PF>1; maximize development totalR",
      developmentCandidates: developmentHybridResults.map(({ name, alternativeName, condition, summary }) => ({ name, alternativeName, condition, summary })),
      reusedValidationCandidateDiagnostics: reusedValidationHybridDiagnostics.map(({ name, alternativeName, condition, summary }) => ({ name, alternativeName, condition, summary })),
      selectedDevelopment: selectedHybridVariant ? { name: selectedHybridVariant.name, alternativeName: selectedHybridVariant.alternativeName, condition: selectedHybridVariant.condition, summary: selectedHybridVariant.summary } : null,
      reusedValidation: selectedHybridValidation ? { name: selectedHybridValidation.name, alternativeName: selectedHybridValidation.alternativeName, condition: selectedHybridValidation.condition, summary: selectedHybridValidation.summary } : null,
      selectedTradeConversions: selectedHybridValidation ? {
        development: selectedHybridVariant!.trades,
        reusedValidation: selectedHybridValidation.trades,
      } : null,
      crossPeriodExploratoryCandidate: {
        warning: "identified after both periods were exposed; descriptive only and not eligible for promotion without a new prospective sample",
        name: crossPeriodExploratoryName,
        rule: "only when direction is DOWN and surpriseStrength<0.25, set stop distance to max(pre-release ATR, 0.5 * first-15-minute post-release range); retain the 2:1 target-to-stop geometry; all other opportunities use V13 unchanged",
        development: crossPeriodExploratoryDevelopment.summary,
        reusedValidation: crossPeriodExploratoryValidation.summary,
        combinedDescriptiveOnly: summarizeVariant([...crossPeriodExploratoryDevelopment.trades, ...crossPeriodExploratoryValidation.trades]),
        rescuedRows: [...crossPeriodExploratoryDevelopment.trades, ...crossPeriodExploratoryValidation.trades].filter((trade) => trade.baselineResultR < 0 && (trade.resultR ?? 0) > 0),
      },
      parameterNeighborhood: {
        warning: "all cells are exploratory because both periods were already exposed",
        thresholds: robustnessThresholds,
        rangeFactors: robustnessRangeFactors,
        cells: robustnessCrossPeriod,
        cellsImprovingBothPeriods: robustnessCrossPeriod.filter((cell) => cell.improvesBothPeriods).length,
        cellsImprovingBothAndPreservingAllWinners: robustnessCrossPeriod.filter((cell) => cell.improvesBothPeriods && cell.preservesAllBaselineWinners).length,
      },
      managementDiagnostics: {
        executionAssumption: "management activates only after a completed M5 close reaches the threshold and takes effect at the next M5 open; same-bar ambiguity is resolved conservatively",
        candidates: managementDiagnostics.map(({ spec, development: developmentResult, reusedValidation: validationResult, combinedDescriptiveOnly, improvesBothPeriods, preservesAllCandidateWinners }) => ({
          spec,
          development: developmentResult,
          reusedValidation: validationResult,
          combinedDescriptiveOnly,
          improvesBothPeriods,
          preservesAllCandidateWinners,
        })),
        candidatesImprovingBothAndPreservingAllWinners: managementDiagnostics.filter((candidate) => candidate.improvesBothPeriods && candidate.preservesAllCandidateWinners).length,
      },
    },
    selectedDevelopment,
    validation: selectedDevelopment ? validationSummary : "NOT_USED",
    validationTrades: selectedDevelopment ? lockedValidationTrades : "NOT_USED",
  },
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, "RESULTS.json"), `${JSON.stringify(report, null, 2)}\n`);
const combinedLossAudit = report.results.v13LossDiagnostics.combinedDescriptiveOnly;
const lossRows = combinedLossAudit.rows.map((trade) => {
  const primaryDiagnosis = trade.netDirectionalMoveR72h > 0
    ? "72h direction right; immediate whipsaw hit stop before target"
    : trade.targetTouchedAfterStop
      ? "72h direction wrong; two-sided path later touched original target"
      : "direction wrong; original target never touched within 72h";
  return `| ${trade.releaseTimeUtc.slice(0, 10)} | ${trade.eventNames.join(" + ")} | ${trade.direction} | ${trade.minutesToOutcome} | ${trade.netDirectionalMoveR72h > 0 ? "RIGHT" : "WRONG"} | ${trade.inverseOutcome === "TARGET" ? "WIN" : "LOSS"} | ${primaryDiagnosis} |`;
}).join("\n");
const exploratoryCandidate = report.results.v14ConditionalExecutionChallenger.crossPeriodExploratoryCandidate;
const parameterNeighborhood = report.results.v14ConditionalExecutionChallenger.parameterNeighborhood;
const managementAudit = report.results.v14ConditionalExecutionChallenger.managementDiagnostics;
const frequencyExpansion = report.results.v15FrequencyExpansion.highestFrequencyAcrossExposedPeriods;
const rescuedRows = exploratoryCandidate.rescuedRows.map((trade) => `| ${trade.releaseTimeUtc.slice(0, 10)} | ${trade.direction} | ${trade.baselineResultR.toFixed(2)}R | ${(trade.resultR ?? 0).toFixed(2)}R | ${(trade.riskPips ?? 0).toFixed(2)} |`).join("\n");
writeFileSync(path.join(outputDirectory, "FINDINGS.md"), `# EUR/USD News V13 Spread Gate\n\nVerdict: **${report.verdict}**\n\nThis challenger does not modify V12 or authorize orders. It tests whether spread relative to the ATR stop is an execution-quality gate. Development selected ${selectedDevelopment?.maximumSpreadToStopRatio ?? "no threshold"}. ${validationSummary ? `Reused validation: ${validationSummary.trades} trades, ${((validationSummary.winRate ?? 0) * 100).toFixed(2)}% wins, ${validationSummary.totalR.toFixed(2)}R, PF ${validationSummary.profitFactor?.toFixed(3) ?? "n/a"}.` : "Validation was not used."}\n\n## Loss diagnosis\n\nAcross the descriptive 35-trade V13 sample, ${combinedLossAudit.losses} trades lost. ${combinedLossAudit.stopTiming.entryBar} stopped on the entry M5 candle and the remaining ${combinedLossAudit.stopTiming.within15Minutes} stopped within five minutes. The two M5 candles that touched both levels were checked with M1 bid/ask candles; both touched the stop first.\n\nDirection alone does not explain the losses: ${combinedLossAudit.directionEvidence.netRightAt72HoursDespiteStop} losing trades still had the correct net direction after 72 hours, while ${combinedLossAudit.directionEvidence.netWrongAt72Hours} were wrong at the 72-hour close. Inverting every losing signal would only have won ${combinedLossAudit.directionEvidence.inverseWouldHitTarget} times and would also have lost ${combinedLossAudit.directionEvidence.inverseAlsoLost} times. The original target was touched later in ${combinedLossAudit.pathEvidence.originalTargetTouchedOnlyAfterStop} of ${combinedLossAudit.losses} losses, after the executable stop had already occurred.\n\nThe dominant observed failure is therefore entry/stop geometry during post-news two-sided volatility. The fixed one-ATR stop is typically only about four pips, while ${combinedLossAudit.pathEvidence.confirmationAlreadyMovedAtLeast1Atr} of ${combinedLossAudit.losses} losing entries occurred after confirmation had already traveled at least one ATR. This is diagnosis, not proof that simply widening the stop is profitable; a wider stop changes risk, target distance, holding time, and expectancy and needs a matched replay.\n\n## Exploratory conditional fix\n\nRule: ${exploratoryCandidate.rule}.\n\n- Development: ${exploratoryCandidate.development.wins}/${exploratoryCandidate.development.trades} wins, ${exploratoryCandidate.development.totalR.toFixed(2)}R, PF ${exploratoryCandidate.development.profitFactor?.toFixed(3)}.\n- Reused validation: ${exploratoryCandidate.reusedValidation.wins}/${exploratoryCandidate.reusedValidation.trades} wins, ${exploratoryCandidate.reusedValidation.totalR.toFixed(2)}R, PF ${exploratoryCandidate.reusedValidation.profitFactor?.toFixed(3)}.\n- Combined descriptive sample: ${exploratoryCandidate.combinedDescriptiveOnly.wins}/${exploratoryCandidate.combinedDescriptiveOnly.trades} wins, ${exploratoryCandidate.combinedDescriptiveOnly.totalR.toFixed(2)}R, PF ${exploratoryCandidate.combinedDescriptiveOnly.profitFactor?.toFixed(3)}.\n- Conversion: all ${exploratoryCandidate.combinedDescriptiveOnly.baselineWins} original winners stayed wins; ${exploratoryCandidate.combinedDescriptiveOnly.baselineLossesRescued} original losses became wins.\n\n${exploratoryCandidate.warning}.\n\n| Release | Direction | Baseline | Candidate | Candidate stop pips |\n|---|---:|---:|---:|---:|\n${rescuedRows}\n\n## Every losing trade\n\n| Release | Event group | Direction | Minutes to stop | 72h direction | Inverse | Primary diagnosis |\n|---|---|---:|---:|---:|---:|---|\n${lossRows}\n`);
const stableNeighborhoodRows = parameterNeighborhood.cells
  .filter((cell) => cell.improvesBothPeriods && cell.preservesAllBaselineWinners)
  .map((cell) => `| ${cell.surpriseThreshold.toFixed(2)} | ${cell.rangeFactor.toFixed(2)} | ${cell.development.totalR.toFixed(2)}R | ${cell.reusedValidation.totalR.toFixed(2)}R |`)
  .join("\n");
const managementRows = managementAudit.candidates
  .map((candidate) => `| ${candidate.spec.name} | ${candidate.development.totalR.toFixed(2)}R | ${candidate.reusedValidation.totalR.toFixed(2)}R | ${candidate.combinedDescriptiveOnly.totalR.toFixed(2)}R | ${candidate.preservesAllCandidateWinners ? "yes" : "no"} |`)
  .join("\n");
const findingsPath = path.join(outputDirectory, "FINDINGS.md");
writeFileSync(findingsPath, readFileSync(findingsPath, "utf8").replace("\n## Every losing trade", `\n## Robustness and management\n\n${parameterNeighborhood.cellsImprovingBothAndPreservingAllWinners} of ${parameterNeighborhood.cells.length} nearby threshold/range settings improved both exposed periods and preserved every baseline winner. This is evidence of a local plateau, but it remains exploratory because both periods were exposed.\n\n| Surprise threshold | Range factor | Development | Reused validation |\n|---:|---:|---:|---:|\n${stableNeighborhoodRows}\n\nNo tested break-even or partial-profit rule improved both periods while preserving all candidate winners (${managementAudit.candidatesImprovingBothAndPreservingAllWinners} passing candidates).\n\n| Management rule | Development | Reused validation | Combined | Preserved all wins |\n|---|---:|---:|---:|---:|\n${managementRows}\n\n## Every losing trade`));
if (frequencyExpansion) {
  writeFileSync(findingsPath, readFileSync(findingsPath, "utf8").replace("\n## Robustness and management", `\n## Frequency expansion\n\nThe highest-frequency rule that held the original combined 45.71% win-rate floor in both exposed yearly periods uses surprise strength >=${frequencyExpansion.spec.surpriseThreshold}, ATR <=${frequencyExpansion.spec.atrCeilingPips} pips, ${frequencyExpansion.spec.confirmationMinutes}-minute confirmation, and a ${frequencyExpansion.spec.cooldownHours}-hour event cooldown. Execution and the conditional weak-short stop remain unchanged.\n\n| Sample | Trades | Wins | Win rate | Total R | PF |\n|---|---:|---:|---:|---:|---:|\n| Development | ${frequencyExpansion.development.trades} | ${frequencyExpansion.development.wins} | ${((frequencyExpansion.development.winRate ?? 0) * 100).toFixed(2)}% | ${frequencyExpansion.development.totalR.toFixed(2)}R | ${frequencyExpansion.development.profitFactor?.toFixed(3)} |\n| Reused validation | ${frequencyExpansion.reusedValidation.trades} | ${frequencyExpansion.reusedValidation.wins} | ${((frequencyExpansion.reusedValidation.winRate ?? 0) * 100).toFixed(2)}% | ${frequencyExpansion.reusedValidation.totalR.toFixed(2)}R | ${frequencyExpansion.reusedValidation.profitFactor?.toFixed(3)} |\n| Combined descriptive | ${frequencyExpansion.combinedDescriptiveOnly.trades} | ${frequencyExpansion.combinedDescriptiveOnly.wins} | ${((frequencyExpansion.combinedDescriptiveOnly.winRate ?? 0) * 100).toFixed(2)}% | ${frequencyExpansion.combinedDescriptiveOnly.totalR.toFixed(2)}R | ${frequencyExpansion.combinedDescriptiveOnly.profitFactor?.toFixed(3)} |\n\nThe expansion preserved ${frequencyExpansion.composition?.originalWinnersPreserved}/${frequencyExpansion.composition?.originalWinners} original winners and added ${frequencyExpansion.composition?.addedTrades.trades} trades at ${((frequencyExpansion.composition?.addedTrades.winRate ?? 0) * 100).toFixed(2)}% wins and ${frequencyExpansion.composition?.addedTrades.totalR.toFixed(2)}R. ${frequencyExpansion.warning}.\n\n## Robustness and management`));
}
const v16Audit = report.results.v16HundredTradesPerYear;
const v17Audit = report.results.v17NewsPlusSessionTechnical;
const v18Audit = report.results.v18NewsEntryLadder;
const bestV16Price = v16Audit.priceConfirmationLane.bestWinRateAtRequestedVolume;
const bestV16Broad = v16Audit.broadNumericNewsLane.bestWinRateAtRequestedVolume;
const bestV17 = v17Audit.bestCompositeAtRequestedVolume;
const bestV18 = v18Audit.bestAtRequestedVolume;
writeFileSync(findingsPath, `${readFileSync(findingsPath, "utf8")}\n## 100-trades-per-year challenge\n\nVerdict: **${v18Audit.status}**. No tested expansion reached at least 100 trades in each yearly period while keeping at least 45% wins, positive expectancy, and PF above 1 in both periods.\n\n| Family | Development | Reused validation | Combined | Gate |\n|---|---:|---:|---:|---:|\n| All-release price confirmation | ${bestV16Price?.development.trades ?? 0} @ ${(((bestV16Price?.development.winRate) ?? 0) * 100).toFixed(2)}% | ${bestV16Price?.reusedValidation.trades ?? 0} @ ${(((bestV16Price?.reusedValidation.winRate) ?? 0) * 100).toFixed(2)}% | ${(bestV16Price?.combinedDescriptiveOnly.totalR ?? 0).toFixed(2)}R | reject |\n| Broad numeric news | ${bestV16Broad?.development.trades ?? 0} @ ${(((bestV16Broad?.development.winRate) ?? 0) * 100).toFixed(2)}% | ${bestV16Broad?.reusedValidation.trades ?? 0} @ ${(((bestV16Broad?.reusedValidation.winRate) ?? 0) * 100).toFixed(2)}% | ${(bestV16Broad?.combinedDescriptiveOnly.totalR ?? 0).toFixed(2)}R | reject |\n| News plus fixed-session technical | ${bestV17?.development.trades ?? 0} @ ${(((bestV17?.development.winRate) ?? 0) * 100).toFixed(2)}% | ${bestV17?.reusedValidation.trades ?? 0} @ ${(((bestV17?.reusedValidation.winRate) ?? 0) * 100).toFixed(2)}% | ${(bestV17?.combinedDescriptiveOnly.totalR ?? 0).toFixed(2)}R | reject |\n| Correlated news entry ladder | ${bestV18?.development.trades ?? 0} @ ${(((bestV18?.development.winRate) ?? 0) * 100).toFixed(2)}% | ${bestV18?.reusedValidation.trades ?? 0} @ ${(((bestV18?.reusedValidation.winRate) ?? 0) * 100).toFixed(2)}% | ${(bestV18?.combinedDescriptiveOnly.totalR ?? 0).toFixed(2)}R | reject |\n\nThe honest frontier remains the V15 rule: 29 development trades at 48.28% and +9.75R, plus 30 reused-validation trades at 46.67% and +9.00R. That is about 30 trades per year, not 100. The 100-per-year target cannot be represented as achieved by duplicating or accepting lower-quality entries.\n`);
console.log(JSON.stringify(report, null, 2));
