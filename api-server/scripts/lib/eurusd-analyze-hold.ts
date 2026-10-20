import { ANALYZE_V2, type AnalyzeMode, type V2Timeframe } from "../../../frontend/src/lib/strategy/analyze-v2/config.js";
import { readMarketFoundation } from "../../../frontend/src/lib/strategy/analyze-v2/foundation.js";
import { isMarketOpen } from "../../../frontend/src/lib/strategy/analyze-v2/data-quality.js";
import type { ResearchCandle } from "../../../frontend/src/lib/oanda/client.js";
import type { Candle } from "../../../frontend/src/types/forex.js";

export const DAY = 86_400_000;
export const PIP = 0.0001;
const STEP = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D: DAY };
export type Granularity = keyof typeof STEP;
export type Series = Record<Granularity, Bar[]>;
export interface Bar { openAt: number; closeAt: number; candle: ResearchCandle }
export interface Config {
  mode: AnalyzeMode;
  since: number;
  until: number;
  holdDays: number;
  pullbackAtr: number;
  initialUsd: number;
  units: number;
  leverage: number;
  closeoutFraction: number;
  slippagePips: number;
  commissionPerMillion: number;
  longAnnualFinancingPct: number;
  shortAnnualFinancingPct: number;
  /** Optional research stop; the original no-stop configuration stays unchanged. */
  stopLoss?: { kind: "pips" | "atr"; value: number };
}
export const DEFAULT_CONFIG: Config = {
  mode: "NORMAL", since: 0, until: Number.MAX_SAFE_INTEGER,
  holdDays: 14, pullbackAtr: 1.5, initialUsd: 10_000, units: 10_000,
  leverage: 30, closeoutFraction: 0.5, slippagePips: 0.2,
  commissionPerMillion: 0, longAnnualFinancingPct: 5, shortAnnualFinancingPct: 5,
};

// OANDA daily bars end at the next 17:00 New York roll, including DST.
const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
export function candleCloseAt(openAt: number, granularity: Granularity) {
  if (granularity !== "D") return openAt + STEP[granularity];
  const tomorrow = openAt + DAY;
  const hour = Number(nyHour.format(tomorrow));
  return tomorrow + (17 - hour) * 3_600_000;
}

export function toBars(raw: ResearchCandle[], granularity: Granularity): Bar[] {
  const unique = new Map<number, ResearchCandle>();
  for (const candle of raw) {
    if (!candle.complete) continue;
    const openAt = Date.parse(candle.time);
    if (!Number.isFinite(openAt)) throw new Error(`Invalid ${granularity} candle time`);
    for (const prices of [candle.mid, candle.bid, candle.ask]) {
      if (!prices || !Object.values(prices).every(value => Number.isFinite(value) && value > 0)
        || prices.low > Math.min(prices.open, prices.close) || prices.high < Math.max(prices.open, prices.close)) {
        throw new Error(`Invalid ${granularity} OHLC at ${candle.time}`);
      }
    }
    if (candle.ask.open < candle.bid.open || candle.ask.close < candle.bid.close) throw new Error(`Crossed ${granularity} candle at ${candle.time}`);
    unique.set(openAt, candle);
  }
  return [...unique].sort(([a], [b]) => a - b).map(([openAt, candle]) => ({ openAt, closeAt: candleCloseAt(openAt, granularity), candle }));
}

export function closedBy(bars: Bar[], at: number): Candle[] {
  let low = 0, high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bars[middle]!.closeAt <= at) low = middle + 1;
    else high = middle;
  }
  return bars.slice(Math.max(0, low - 300), low).map(({ candle }) => ({ ...candle.mid, time: candle.time, volume: candle.volume, complete: true }));
}

export interface TrendSnapshot {
  direction: "UPTREND" | "DOWNTREND" | "RANGE" | "TRANSITION" | "UNCLEAR";
  atr: number;
  usable: boolean;
  alignment: string;
  evidence: string[];
}
export type TrendReader = (series: Series, bar: Bar, mode: AnalyzeMode) => TrendSnapshot;
export const analyzeTrend: TrendReader = (series, bar, mode) => {
  const config = ANALYZE_V2[mode];
  const byTimeframe: Partial<Record<V2Timeframe, Candle[]>> = {
    M15: closedBy(series.M15, bar.closeAt), H1: closedBy(series.H1, bar.closeAt),
    H4: closedBy(series.H4, bar.closeAt), D1: closedBy(series.D, bar.closeAt),
  };
  // This is the same deterministic foundation called by the live analyzeV2.
  // Its stop/target, entry-trigger, liquidity and news checklist is not this theory.
  const foundation = readMarketFoundation({ instrument: "EUR_USD", mode, candles: byTimeframe,
    quote: { bid: bar.candle.bid.close, ask: bar.candle.ask.close, time: new Date(bar.closeAt).toISOString() }, now: bar.closeAt });
  return {
    direction: foundation.primary?.direction ?? "UNCLEAR", atr: foundation.primary?.atr ?? 0,
    usable: isMarketOpen(bar.closeAt) && foundation.data.checks.every(check => check.status !== "FAIL" && check.status !== "UNKNOWN"),
    alignment: foundation.alignment, evidence: foundation.primary?.evidence ?? [],
  };
};

type Side = "long" | "short";
type Exit = "major_pullback" | "loss_timeout" | "margin_closeout" | "stop_loss" | "open";
export interface Trade {
  side: Side; signaledAt: number; enteredAt: number; markedAt: number; exitSignalAt: number | null;
  entry: number; exitPrice: number; reason: Exit; units: number; entryAtrPips: number;
  grossPips: number; netPips: number; netUsd: number; financingUsd: number; commissionUsd: number;
  maePips: number; mfePips: number; peakClosePips: number; heldDays: number;
  entryAlignment: string; entryEvidence: string[];
  stopPrice?: number;
}
interface Position {
  side: Side; signaledAt: number; enteredAt: number; entry: number; entryAtrPips: number;
  marginUsd: number; entryNotional: number; maePips: number; mfePips: number; peakClosePips: number;
  entryAlignment: string; entryEvidence: string[];
  stopPrice?: number;
}
export interface Replay {
  config: Config; trades: Trade[]; equity: Array<{ at: number; usd: number }>;
  summary: ReturnType<typeof summarize>;
  diagnostics: { evaluations: number; usable: number; trending: number; marginRejected: number; expiredEntrySignals: number; halted: boolean; missingM15Bars: number };
}

export function validateConfig(config: Config) {
  for (const [key, value] of Object.entries(config)) {
    if (key !== "mode" && key !== "stopLoss" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
  }
  if (!["NORMAL", "SWING"].includes(config.mode) || config.since >= config.until) throw new Error("Invalid mode or date range");
  for (const key of ["holdDays", "pullbackAtr", "initialUsd", "units", "leverage", "closeoutFraction"] as const) {
    if (config[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (config.closeoutFraction > 1 || config.leverage < 1 || !Number.isSafeInteger(config.units)) throw new Error("Invalid margin settings or units");
  if (config.slippagePips < 0 || config.commissionPerMillion < 0) throw new Error("Execution costs cannot be negative");
  if (config.commissionPerMillion >= 1_000_000) throw new Error("Commission must be less than the traded notional");
  if (config.stopLoss && (!["pips", "atr"].includes(config.stopLoss.kind)
    || !Number.isFinite(config.stopLoss.value) || config.stopLoss.value <= 0)) throw new Error("Invalid stop loss");
}

function summarize(trades: Trade[], config: Config, finalEquity: number, maxDrawdownUsd: number, maxDrawdownPct: number, lowestEquityUsd: number, exposureMs: number, periodMs: number) {
  const closed = trades.filter(trade => trade.reason !== "open");
  const winners = closed.filter(trade => trade.netUsd > 0), losers = closed.filter(trade => trade.netUsd <= 0);
  const profit = winners.reduce((sum, trade) => sum + trade.netUsd, 0);
  const loss = -losers.reduce((sum, trade) => sum + trade.netUsd, 0);
  const sum = (set: Trade[], field: "netUsd" | "netPips") => set.reduce((total, trade) => total + trade[field], 0);
  return {
    closedTrades: closed.length, openTrades: trades.length - closed.length,
    winRate: closed.length ? winners.length / closed.length : null,
    profitFactor: loss > 0 ? profit / loss : null,
    profitFactorNote: loss === 0 ? (profit > 0 ? "No closed losses; ratio undefined" : "No closed profit or loss") : null,
    realizedNetUsd: sum(closed, "netUsd"), unrealizedNetUsd: sum(trades.filter(trade => trade.reason === "open"), "netUsd"),
    totalNetPips: sum(trades, "netPips"), finalEquityUsd: finalEquity, returnPct: (finalEquity / config.initialUsd - 1) * 100,
    maxDrawdownUsd, maxDrawdownPct, lowestEquityUsd,
    worstClosedTradeUsd: closed.length ? Math.min(...closed.map(trade => trade.netUsd)) : null,
    avgWinUsd: winners.length ? profit / winners.length : null, avgLossUsd: losers.length ? -loss / losers.length : null,
    maxTradeMaePips: Math.max(0, ...trades.map(trade => trade.maePips)),
    maxHoldDays: Math.max(0, ...trades.map(trade => trade.heldDays)),
    avgHoldDays: trades.length ? trades.reduce((sum, trade) => sum + trade.heldDays, 0) / trades.length : null,
    financingUsd: trades.reduce((sum, trade) => sum + trade.financingUsd, 0),
    commissionUsd: trades.reduce((sum, trade) => sum + trade.commissionUsd, 0),
    exposurePct: periodMs > 0 ? exposureMs / periodMs * 100 : 0,
    exits: Object.fromEntries(["major_pullback", "loss_timeout", "margin_closeout", ...(config.stopLoss ? ["stop_loss"] : []), "open"].map(reason => [reason, trades.filter(trade => trade.reason === reason).length])),
  };
}

/** One independent USD account; next-open fills and no broker order paths. */
export function replay(series: Series, config: Config, readTrend: TrendReader = analyzeTrend): Replay {
  validateConfig(config);
  const bars = series.M15.filter(bar => bar.openAt >= config.since && bar.closeAt <= config.until);
  if (!bars.length) throw new Error("No complete M15 bars in the requested period");
  const primaryCloses = new Set(series[config.mode === "NORMAL" ? "M15" : "H4"].map(bar => bar.closeAt));
  const slip = config.slippagePips * PIP;
  let balance = config.initialUsd, position: Position | null = null;
  let entryOrder: { at: number; snapshot: TrendSnapshot } | null = null;
  let exitOrder: { at: number; reason: "major_pullback" | "loss_timeout" } | null = null;
  let highEquity = balance, lowestEquity = balance, drawdownUsd = 0, drawdownPct = 0, exposureMs = 0;
  const trades: Trade[] = [], equity: Replay["equity"] = [];
  const diagnostics = { evaluations: 0, usable: 0, trending: 0, marginRejected: 0, expiredEntrySignals: 0, halted: false, missingM15Bars: 0 };
  const sign = (p: Position) => p.side === "long" ? 1 : -1;
  const exitPrice = (p: Pick<Position, "side">, bar: Bar, point: "open" | "close") => p.side === "long" ? bar.candle.bid[point] - slip : bar.candle.ask[point] + slip;
  const net = (p: Position, price: number, at: number) => {
    const days = Math.max(0, at - p.enteredAt) / DAY;
    const annual = p.side === "long" ? config.longAnnualFinancingPct : config.shortAnnualFinancingPct;
    const financing = p.entryNotional * annual / 100 * days / 365;
    const commission = config.units * (p.entry + price) * config.commissionPerMillion / 1_000_000;
    return { usd: sign(p) * (price - p.entry) * config.units - financing - commission, financing, commission };
  };
  const observeEquity = (usd: number, close: boolean) => {
    lowestEquity = Math.min(lowestEquity, usd);
    drawdownUsd = Math.max(drawdownUsd, highEquity - usd);
    drawdownPct = Math.max(drawdownPct, (highEquity - usd) / highEquity * 100);
    // Close-equity peaks against intrabar adverse NAV, avoiding OHLC path assumptions.
    if (close) highEquity = Math.max(highEquity, usd);
  };
  const record = (p: Position, price: number, at: number, reason: Exit, signalAt: number | null) => {
    const costs = net(p, price, at);
    const grossPips = sign(p) * (price - p.entry) / PIP;
    const trade: Trade = { side: p.side, signaledAt: p.signaledAt, enteredAt: p.enteredAt, markedAt: at, exitSignalAt: signalAt,
      entry: p.entry, exitPrice: price, reason, units: config.units, entryAtrPips: p.entryAtrPips,
      grossPips, netPips: costs.usd / config.units / PIP, netUsd: costs.usd,
      financingUsd: costs.financing, commissionUsd: costs.commission, maePips: p.maePips, mfePips: p.mfePips,
      peakClosePips: p.peakClosePips, heldDays: (at - p.enteredAt) / DAY, entryAlignment: p.entryAlignment, entryEvidence: p.entryEvidence };
    if (p.stopPrice !== undefined) trade.stopPrice = p.stopPrice;
    trades.push(trade);
    exposureMs += at - p.enteredAt;
    if (reason !== "open") { balance += costs.usd; position = null; exitOrder = null; }
  };

  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!, previous = bars[index - 1];
    if (previous) {
      for (let at = previous.closeAt; at < bar.openAt; at += STEP.M15) {
        if (isMarketOpen(at) && isMarketOpen(at + STEP.M15 - 1)) diagnostics.missingM15Bars++;
      }
    }
    if (diagnostics.halted) { equity.push({ at: bar.closeAt, usd: balance }); continue; }
    // A gap through the margin threshold takes precedence over a queued
    // strategy exit, even if the prior candle signaled a profitable pullback.
    if (position) {
      const openingPrice = exitPrice(position, bar, "open");
      const openingNav = balance + net(position, openingPrice, bar.openAt).usd;
      if (openingNav <= position.marginUsd * config.closeoutFraction) {
        position.maePips = Math.max(position.maePips, -sign(position) * (openingPrice - position.entry) / PIP);
        observeEquity(openingNav, false);
        record(position, openingPrice, bar.openAt, "margin_closeout", null);
        diagnostics.halted = true;
        equity.push({ at: bar.closeAt, usd: balance });
        continue;
      }
    }
    if (position && exitOrder) {
      const openingQuote = position.side === "long" ? bar.candle.bid.open : bar.candle.ask.open;
      const stopAtOpen = position.stopPrice !== undefined && (position.side === "long" ? openingQuote <= position.stopPrice : openingQuote >= position.stopPrice);
      record(position, exitPrice(position, bar, "open"), bar.openAt, stopAtOpen ? "stop_loss" : exitOrder.reason, stopAtOpen ? null : exitOrder.at);
      observeEquity(balance, true);
    }
    if (!position && entryOrder) {
      const order = entryOrder;
      entryOrder = null;
      // Do not carry a Friday or missing-feed signal into a new session.
      if (bar.openAt !== order.at) diagnostics.expiredEntrySignals++;
      else {
        const side: Side = order.snapshot.direction === "UPTREND" ? "long" : "short";
        const entry = side === "long" ? bar.candle.ask.open + slip : bar.candle.bid.open - slip;
        if (entry <= 0 || exitPrice({ side }, bar, "open") <= 0) throw new Error("Slippage exceeds the instrument price");
        const marginUsd = config.units * entry / config.leverage;
        const candidate: Position = { side, signaledAt: order.at, enteredAt: bar.openAt, entry, entryAtrPips: order.snapshot.atr / PIP,
          marginUsd, entryNotional: config.units * entry, maePips: 0, mfePips: 0, peakClosePips: 0,
          entryAlignment: order.snapshot.alignment, entryEvidence: order.snapshot.evidence };
        if (config.stopLoss) {
          const distance = config.stopLoss.value * (config.stopLoss.kind === "pips" ? PIP : order.snapshot.atr);
          candidate.stopPrice = entry - (side === "long" ? distance : -distance);
          if (candidate.stopPrice <= 0) throw new Error("Stop distance exceeds the instrument price");
        }
        if (balance + net(candidate, exitPrice(candidate, bar, "open"), bar.openAt).usd >= marginUsd) position = candidate;
        else diagnostics.marginRejected++;
      }
    }
    if (position) {
      const p = position;
      const adverse = p.side === "long" ? bar.candle.bid.low - slip : bar.candle.ask.high + slip;
      const favorable = p.side === "long" ? bar.candle.bid.high - slip : bar.candle.ask.low + slip;
      const floor = p.marginUsd * config.closeoutFraction;
      const adverseNav = balance + net(p, adverse, bar.closeAt).usd;
      // Stop activation uses the actual bid/ask, before exit slippage. If
      // both margin and stop thresholds are crossed, the closer NAV
      // threshold wins. A stop reached inside a bar is priced at its level
      // plus adverse slippage; a crossed opening quote fills at that open.
      const rawAdverse = p.side === "long" ? bar.candle.bid.low : bar.candle.ask.high;
      const rawOpen = p.side === "long" ? bar.candle.bid.open : bar.candle.ask.open;
      const stopHit = p.stopPrice !== undefined && (p.side === "long" ? rawAdverse <= p.stopPrice : rawAdverse >= p.stopPrice);
      const stopFill = p.stopPrice === undefined ? null : p.side === "long" ? Math.min(p.stopPrice, rawOpen) - slip : Math.max(p.stopPrice, rawOpen) + slip;
      if (stopHit && stopFill !== null && balance + net(p, stopFill, bar.closeAt).usd > floor) {
        p.maePips = Math.max(p.maePips, -sign(p) * (stopFill - p.entry) / PIP);
        observeEquity(balance + net(p, stopFill, bar.closeAt).usd, false);
        record(p, stopFill, bar.closeAt, "stop_loss", null);
      } else if (adverseNav <= floor) {
        // Simplified fixed-opening-margin model. Solve its NAV threshold;
        // gaps fill at the worse open. Financing conservatively uses bar end.
        const rate = config.commissionPerMillion / 1_000_000;
        const financing = net(p, adverse, bar.closeAt).financing;
        const threshold = (floor - balance + financing + config.units * p.entry * (sign(p) + rate)) / (config.units * (sign(p) - rate));
        const openingExit = exitPrice(p, bar, "open");
        const price = p.side === "long" ? Math.min(threshold, openingExit) : Math.max(threshold, openingExit);
        p.maePips = Math.max(p.maePips, -sign(p) * (price - p.entry) / PIP);
        observeEquity(balance + net(p, price, bar.closeAt).usd, false);
        record(p, price, bar.closeAt, "margin_closeout", null);
        diagnostics.halted = true;
      } else {
        p.maePips = Math.max(p.maePips, -sign(p) * (adverse - p.entry) / PIP);
        p.mfePips = Math.max(p.mfePips, sign(p) * (favorable - p.entry) / PIP);
        observeEquity(adverseNav, false);
      }
    }
    const closeNav = position ? balance + net(position, exitPrice(position, bar, "close"), bar.closeAt).usd : balance;
    observeEquity(closeNav, true);
    equity.push({ at: bar.closeAt, usd: closeNav });
    if (diagnostics.halted) continue;

    const primaryClose = primaryCloses.has(bar.closeAt);
    if (position) {
      const p = position;
      const mark = exitPrice(p, bar, "close");
      const profitable = net(p, mark, bar.closeAt).usd > 0;
      if (!profitable && bar.closeAt - p.enteredAt >= config.holdDays * DAY) {
        exitOrder = { at: bar.closeAt, reason: "loss_timeout" };
      } else if (primaryClose) {
        const closePips = sign(p) * (mark - p.entry) / PIP;
        p.peakClosePips = Math.max(p.peakClosePips, closePips);
        if (profitable && p.peakClosePips - closePips >= config.pullbackAtr * p.entryAtrPips) {
          exitOrder = { at: bar.closeAt, reason: "major_pullback" };
        }
      }
    } else if (primaryClose) {
      diagnostics.evaluations++;
      const snapshot = readTrend(series, bar, config.mode);
      if (snapshot.usable) diagnostics.usable++;
      if (snapshot.direction === "UPTREND" || snapshot.direction === "DOWNTREND") diagnostics.trending++;
      if (snapshot.usable && snapshot.atr > 0 && ["UPTREND", "DOWNTREND"].includes(snapshot.direction)) {
        entryOrder = { at: bar.closeAt, snapshot };
      }
    }
  }
  const last = bars.at(-1)!;
  if (position) record(position, exitPrice(position, last, "close"), last.closeAt, "open", exitOrder?.at ?? null);
  const finalEquity = equity.at(-1)!.usd;
  return { config, trades, equity, diagnostics,
    summary: summarize(trades, config, finalEquity, drawdownUsd, drawdownPct, lowestEquity, exposureMs, last.closeAt - bars[0]!.openAt) };
}
