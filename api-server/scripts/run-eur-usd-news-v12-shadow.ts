/** Prospective EUR/USD news V12 observer. This script never creates orders. */
import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EUR_USD_NEWS_V12_SHADOW_POLICY,
  EUR_USD_NEWS_V13_CHALLENGER_POLICY,
  createEurUsdNewsV12Levels,
  groupEurUsdNewsV12Events,
  passesEurUsdNewsV12FrozenFilters,
  resolveEurUsdNewsV12FirstTouch,
  type EurUsdNewsV12Event,
  type EurUsdNewsV12Group,
} from "../src/eur-usd-news-v12-shadow.js";

type Side = { o: number; h: number; l: number; c: number };
type Bar = { time: string; bid: Side; ask: Side; mid: Side };
type LedgerState = "SKIPPED" | "WAIT" | "OPEN" | "RESOLVED";
type Outcome = "TARGET" | "STOP" | "AMBIGUOUS_STOP" | "TIME_EXIT";
type LedgerRow = {
  releaseTimeUtc: string;
  policyHash: string;
  state: LedgerState;
  reason?: string;
  direction: "UP" | "DOWN";
  surpriseStrength: number;
  eventNames: string[];
  preReleaseAtrPips?: number;
  confirmationCloseMid?: number;
  entryTimeUtc?: string;
  executableEntry?: number;
  spreadPips?: number;
  stop?: number;
  target?: number;
  outcome?: Outcome;
  exitTimeUtc?: string;
  resultR?: number;
  m1FirstTouch?: "STOP_FIRST" | "TARGET_FIRST" | "STILL_AMBIGUOUS" | "NO_TOUCH" | "UNAVAILABLE";
  m1FirstTouchTimeUtc?: string | null;
  spreadToStopRatio?: number;
  observedAt: string;
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(root, "research-v2", "eurusd-news-v12-forward-shadow");
const defaultEventFile = path.join(outputDirectory, "events.json");
const eventFile = path.resolve(process.env.EUR_USD_NEWS_V12_EVENTS_FILE?.trim() || defaultEventFile);
const ledgerFile = path.join(outputDirectory, "ledger.json");
const statusFile = path.join(outputDirectory, "STATUS.json");
const v13LedgerFile = path.join(outputDirectory, "v13-ledger.json");
const v13StatusFile = path.join(outputDirectory, "V13_STATUS.json");
const policyHash = createHash("sha256").update(JSON.stringify(EUR_USD_NEWS_V12_SHADOW_POLICY)).digest("hex");
const v13PolicyHash = createHash("sha256").update(JSON.stringify(EUR_USD_NEWS_V13_CHALLENGER_POLICY)).digest("hex");
const now = Date.now();

if ((process.env.OANDA_ENVIRONMENT ?? "practice").trim().toLowerCase() === "live") {
  throw new Error("EUR/USD news V12 shadow refuses the OANDA live environment.");
}
if (EUR_USD_NEWS_V12_SHADOW_POLICY.ordersAllowed !== false) throw new Error("Shadow policy order lock is invalid.");

function loadEvents() {
  const payload = JSON.parse(readFileSync(eventFile, "utf8")) as { events?: EurUsdNewsV12Event[] };
  if (!Array.isArray(payload.events)) throw new Error(`Expected an events array in ${eventFile}`);
  return payload.events;
}

function nonOverlappingGroups(groups: EurUsdNewsV12Group[]) {
  const selected: EurUsdNewsV12Group[] = [];
  for (const group of groups) {
    const prior = selected.at(-1);
    if (!prior || Date.parse(group.releaseTimeUtc) >= Date.parse(prior.releaseTimeUtc) + 4 * 3_600_000) selected.push(group);
  }
  return selected;
}

async function fetchM5(from: string, toExclusive: string) {
  const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
  if (!token) throw new Error("OANDA Practice credentials are required when forward event rows are present.");
  const collected = new Map<number, Bar>();
  let cursor = from;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ price: "BA", granularity: "M5", count: "5000", from: cursor });
    const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`OANDA Practice M5 request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as {
      candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }>;
    };
    const page = (payload.candles ?? []).filter((candle) => candle.complete).map((candle): Bar => {
      const bid = { o: Number(candle.bid.o), h: Number(candle.bid.h), l: Number(candle.bid.l), c: Number(candle.bid.c) };
      const ask = { o: Number(candle.ask.o), h: Number(candle.ask.h), l: Number(candle.ask.l), c: Number(candle.ask.c) };
      return {
        time: candle.time,
        bid,
        ask,
        mid: { o: (bid.o + ask.o) / 2, h: (bid.h + ask.h) / 2, l: (bid.l + ask.l) / 2, c: (bid.c + ask.c) / 2 },
      };
    });
    for (const bar of page) if (Date.parse(bar.time) < Date.parse(toExclusive)) collected.set(Date.parse(bar.time), bar);
    const last = page.at(-1);
    if (!last || page.length < 5000 || Date.parse(last.time) >= Date.parse(toExclusive)) break;
    cursor = new Date(Date.parse(last.time) + 300_000).toISOString();
  }
  return [...collected.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

async function resolveAmbiguousWithM1(row: LedgerRow): Promise<LedgerRow> {
  if (row.outcome !== "AMBIGUOUS_STOP" || !row.entryTimeUtc || row.stop === undefined || row.target === undefined) return row;
  const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
  if (!token) return { ...row, m1FirstTouch: "UNAVAILABLE" };
  const from = Date.parse(row.entryTimeUtc);
  const query = new URLSearchParams({
    price: "BA",
    granularity: "M1",
    from: new Date(from).toISOString(),
    to: new Date(from + 5 * 60_000).toISOString(),
  });
  const response = await fetch(`https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return { ...row, m1FirstTouch: "UNAVAILABLE" };
  const payload = await response.json() as {
    candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }>;
  };
  const bars = (payload.candles ?? []).filter((bar) => bar.complete).map((bar) => ({
    time: new Date(Date.parse(bar.time)).toISOString(),
    bid: { h: Number(bar.bid.h), l: Number(bar.bid.l) },
    ask: { h: Number(bar.ask.h), l: Number(bar.ask.l) },
  }));
  const firstTouch = resolveEurUsdNewsV12FirstTouch({ direction: row.direction === "UP" ? 1 : -1, stop: row.stop, target: row.target, bars });
  return { ...row, m1FirstTouch: firstTouch.result, m1FirstTouchTimeUtc: firstTouch.time };
}

function atr14At(bars: Bar[], index: number) {
  if (index < 13) return Number.NaN;
  let total = 0;
  for (let cursor = index - 13; cursor <= index; cursor += 1) {
    const bar = bars[cursor]!;
    const previousClose = cursor > 0 ? bars[cursor - 1]!.mid.c : bar.mid.c;
    total += Math.max(bar.mid.h - bar.mid.l, Math.abs(bar.mid.h - previousClose), Math.abs(bar.mid.l - previousClose));
  }
  return total / 14;
}

function observeGroup(group: EurUsdNewsV12Group, bars: Bar[], indexByTime: Map<number, number>, observedAt: string): LedgerRow {
  const base = {
    releaseTimeUtc: group.releaseTimeUtc,
    policyHash,
    direction: (group.direction === 1 ? "UP" : "DOWN") as "UP" | "DOWN",
    surpriseStrength: group.surpriseStrength,
    eventNames: group.events.map((event) => `${event.currency} ${event.eventName}`),
    observedAt,
  };
  if (group.surpriseStrength < EUR_USD_NEWS_V12_SHADOW_POLICY.surpriseStrengthThreshold) {
    return { ...base, state: "SKIPPED", reason: "SURPRISE_STRENGTH_BELOW_FROZEN_THRESHOLD" };
  }

  const releaseIndex = indexByTime.get(Date.parse(group.releaseTimeUtc));
  if (releaseIndex === undefined || releaseIndex < 14) return { ...base, state: "WAIT", reason: "MISSING_PRE_RELEASE_M5_HISTORY" };
  const decisionIndex = releaseIndex + 2;
  const entryIndex = releaseIndex + 3;
  if (!bars[decisionIndex] || !bars[entryIndex]) return { ...base, state: "WAIT", reason: "AWAITING_15_MINUTE_CONFIRMATION" };

  const preReleaseIndex = releaseIndex - 1;
  const preReleaseAtr = atr14At(bars, preReleaseIndex);
  const preReleaseMid = bars[preReleaseIndex]!.mid.c;
  const confirmationCloseMid = bars[decisionIndex]!.mid.c;
  const filterInput = { group, preReleaseAtr, preReleaseMid, confirmationCloseMid };
  if (!passesEurUsdNewsV12FrozenFilters(filterInput)) {
    const reason = preReleaseAtr * 10_000 > EUR_USD_NEWS_V12_SHADOW_POLICY.lowVolatilityAtrCeilingPips
      ? "PRE_RELEASE_ATR_ABOVE_FROZEN_CEILING"
      : "PRICE_CONFIRMATION_DISAGREED_WITH_NEWS_DIRECTION";
    return { ...base, state: "SKIPPED", reason, preReleaseAtrPips: preReleaseAtr * 10_000, confirmationCloseMid };
  }

  const entryBar = bars[entryIndex]!;
  const executableEntry = group.direction === 1 ? entryBar.ask.o : entryBar.bid.o;
  const levels = createEurUsdNewsV12Levels({ direction: group.direction, executableEntry, preReleaseAtr });
  const entryTime = Date.parse(entryBar.time);
  const deadline = entryTime + EUR_USD_NEWS_V12_SHADOW_POLICY.maximumHoldingHours * 3_600_000;
  let exitIndex = entryIndex;
  let outcome: Outcome | undefined;
  let resultR: number | undefined;

  for (let index = entryIndex; index < bars.length && Date.parse(bars[index]!.time) <= deadline; index += 1) {
    exitIndex = index;
    const bar = bars[index]!;
    const targetHit = group.direction === 1 ? bar.bid.h >= levels.target : bar.ask.l <= levels.target;
    const stopHit = group.direction === 1 ? bar.bid.l <= levels.stop : bar.ask.h >= levels.stop;
    if (targetHit && stopHit) {
      outcome = "AMBIGUOUS_STOP";
      resultR = EUR_USD_NEWS_V12_SHADOW_POLICY.lossPayoffR;
      break;
    }
    if (targetHit) {
      outcome = "TARGET";
      resultR = EUR_USD_NEWS_V12_SHADOW_POLICY.winPayoffR;
      break;
    }
    if (stopHit) {
      outcome = "STOP";
      resultR = EUR_USD_NEWS_V12_SHADOW_POLICY.lossPayoffR;
      break;
    }
  }

  const trade = {
    ...base,
    preReleaseAtrPips: preReleaseAtr * 10_000,
    confirmationCloseMid,
    entryTimeUtc: new Date(entryTime).toISOString(),
    executableEntry,
    spreadPips: (entryBar.ask.o - entryBar.bid.o) * 10_000,
    spreadToStopRatio: (entryBar.ask.o - entryBar.bid.o) / levels.risk,
    stop: levels.stop,
    target: levels.target,
  };
  if (outcome && resultR !== undefined) {
    return { ...trade, state: "RESOLVED", outcome, resultR, exitTimeUtc: new Date(Date.parse(bars[exitIndex]!.time)).toISOString() };
  }
  if (now < deadline) return { ...trade, state: "OPEN" };

  const exitBar = bars[exitIndex];
  if (!exitBar || Date.parse(exitBar.time) < deadline - 6 * 3_600_000) {
    return { ...trade, state: "WAIT", reason: "MISSING_72_HOUR_EXIT_HISTORY" };
  }
  const exit = group.direction === 1 ? exitBar.bid.c : exitBar.ask.c;
  resultR = 0.75 * (group.direction === 1 ? exit - executableEntry : executableEntry - exit) / levels.risk;
  return { ...trade, state: "RESOLVED", outcome: "TIME_EXIT", resultR, exitTimeUtc: new Date(Date.parse(exitBar.time)).toISOString() };
}

function summarize(rows: LedgerRow[]) {
  const resolved = rows.filter((row): row is LedgerRow & { resultR: number } => row.state === "RESOLVED" && typeof row.resultR === "number");
  const wins = resolved.filter((row) => row.resultR > 0).length;
  const totalR = resolved.reduce((sum, row) => sum + row.resultR, 0);
  const grossProfit = resolved.filter((row) => row.resultR > 0).reduce((sum, row) => sum + row.resultR, 0);
  const grossLoss = -resolved.filter((row) => row.resultR < 0).reduce((sum, row) => sum + row.resultR, 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0;
  const metrics = {
    resolvedTrades: resolved.length,
    wins,
    winRate: resolved.length ? wins / resolved.length : null,
    totalR,
    expectancyR: resolved.length ? totalR / resolved.length : null,
    profitFactor,
    openTrades: rows.filter((row) => row.state === "OPEN").length,
    waitingRows: rows.filter((row) => row.state === "WAIT").length,
    skippedRows: rows.filter((row) => row.state === "SKIPPED").length,
  };
  const enoughTrades = metrics.resolvedTrades >= EUR_USD_NEWS_V12_SHADOW_POLICY.minimumResolvedTrades;
  const passed = enoughTrades
    && (metrics.winRate ?? 0) >= EUR_USD_NEWS_V12_SHADOW_POLICY.minimumWinRate
    && (metrics.expectancyR ?? 0) > 0
    && (metrics.profitFactor ?? 0) > EUR_USD_NEWS_V12_SHADOW_POLICY.minimumProfitFactor;
  return {
    metrics,
    gate: {
      status: !enoughTrades ? "COLLECTING" : passed ? "QUALIFIED_FOR_REVIEW_ONLY" : "FAILED_FROZEN_FORWARD_GATE",
      passed,
      remainingResolvedTrades: Math.max(0, EUR_USD_NEWS_V12_SHADOW_POLICY.minimumResolvedTrades - metrics.resolvedTrades),
      note: "Passing never authorizes orders; it only permits a separate review.",
    },
  };
}

function asV13ChallengerRow(row: LedgerRow): LedgerRow | null {
  if (Date.parse(row.releaseTimeUtc) < Date.parse(EUR_USD_NEWS_V13_CHALLENGER_POLICY.forwardSampleStartsAt)) return null;
  const candidate = { ...row, policyHash: v13PolicyHash };
  if ((row.state === "OPEN" || row.state === "RESOLVED") && (row.spreadToStopRatio ?? Number.POSITIVE_INFINITY) > EUR_USD_NEWS_V13_CHALLENGER_POLICY.maximumSpreadToStopRatio) {
    return {
      ...candidate,
      state: "SKIPPED",
      reason: "SPREAD_EXCEEDED_HALF_OF_STOP_DISTANCE",
      outcome: undefined,
      exitTimeUtc: undefined,
      resultR: undefined,
      m1FirstTouch: undefined,
      m1FirstTouchTimeUtc: undefined,
    };
  }
  return candidate;
}

function mergeLedger(priorRows: LedgerRow[], newRows: LedgerRow[], expectedPolicyHash: string) {
  if (priorRows.some((row) => row.policyHash !== expectedPolicyHash)) throw new Error("Existing shadow ledger was created under a different policy. Refusing to mix samples.");
  const merged = new Map(priorRows.map((row) => [row.releaseTimeUtc, row]));
  for (const row of newRows) {
    const prior = merged.get(row.releaseTimeUtc);
    if (!prior || prior.state !== "RESOLVED") merged.set(row.releaseTimeUtc, row);
    else if (!prior.m1FirstTouch && row.m1FirstTouch) merged.set(row.releaseTimeUtc, { ...prior, m1FirstTouch: row.m1FirstTouch, m1FirstTouchTimeUtc: row.m1FirstTouchTimeUtc });
  }
  return [...merged.values()].sort((left, right) => Date.parse(left.releaseTimeUtc) - Date.parse(right.releaseTimeUtc));
}

mkdirSync(outputDirectory, { recursive: true });
const events = loadEvents();
const forwardStart = Date.parse(EUR_USD_NEWS_V12_SHADOW_POLICY.forwardSampleStartsAt);
const postFreezeEvents = events.filter((event) => Date.parse(event.releaseTimeUtc) >= forwardStart);
const groups = nonOverlappingGroups(groupEurUsdNewsV12Events(postFreezeEvents));
const priorRows = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) as LedgerRow[] : [];

let observedRows: LedgerRow[] = [];
if (groups.length) {
  const earliest = Math.min(...groups.map((group) => Date.parse(group.releaseTimeUtc))) - 2 * 3_600_000;
  const latestNeeded = Math.min(now, Math.max(...groups.map((group) => Date.parse(group.releaseTimeUtc) + 73 * 3_600_000)));
  const bars = await fetchM5(new Date(earliest).toISOString(), new Date(latestNeeded + 300_000).toISOString());
  const indexByTime = new Map(bars.map((bar, index) => [Date.parse(bar.time), index]));
  const observedAt = new Date().toISOString();
  observedRows = groups.map((group) => observeGroup(group, bars, indexByTime, observedAt));
  observedRows = await Promise.all(observedRows.map(resolveAmbiguousWithM1));
}

const ledger = mergeLedger(priorRows, observedRows, policyHash);
writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
const summary = summarize(ledger);
const status = {
  generatedAt: new Date().toISOString(),
  execution: { status: "SHADOW_ONLY", ordersAllowed: false, orderCallsMade: 0 },
  policy: EUR_USD_NEWS_V12_SHADOW_POLICY,
  policyHash,
  source: { eventFile, totalCalendarRows: events.length, rejectedPreFreezeRows: events.length - postFreezeEvents.length },
  sample: { directionalNonOverlappingGroups: groups.length, ledgerRows: ledger.length },
  ...summary,
};
writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);

const priorV13Rows = existsSync(v13LedgerFile) ? JSON.parse(readFileSync(v13LedgerFile, "utf8")) as LedgerRow[] : [];
const currentV13Rows = observedRows.map(asV13ChallengerRow).filter((row): row is LedgerRow => row !== null);
const v13Ledger = mergeLedger(priorV13Rows, currentV13Rows, v13PolicyHash);
writeFileSync(v13LedgerFile, `${JSON.stringify(v13Ledger, null, 2)}\n`);
const v13Summary = summarize(v13Ledger);
const v13Status = {
  generatedAt: new Date().toISOString(),
  execution: { status: "SHADOW_ONLY", ordersAllowed: false, orderCallsMade: 0 },
  policy: EUR_USD_NEWS_V13_CHALLENGER_POLICY,
  policyHash: v13PolicyHash,
  historicalDiagnostic: {
    development: { trades: 15, winRate: 0.4666666666666667, expectancyR: 0.3, profitFactor: 1.75 },
    reusedValidation: { trades: 20, winRate: 0.35, expectancyR: 0.0375, profitFactor: 1.0769230769230769 },
    warning: "These results justify observation only and do not establish a winning edge.",
  },
  sample: { ledgerRows: v13Ledger.length },
  ...v13Summary,
};
writeFileSync(v13StatusFile, `${JSON.stringify(v13Status, null, 2)}\n`);
console.log(JSON.stringify({ v12: status, v13Challenger: v13Status }, null, 2));
