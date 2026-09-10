/**
 * Turns strategy setups + watchlist plans into card-ready signals. Ported from
 * the web's `lib/signals/build.ts` (the pure view-model logic, not any trading
 * decision — the backend still decides what a setup is). Kept in sync with it.
 */
import { displayNameFor } from "@/lib/instruments";
import type { StrategySetup, WatchRow } from "@/types/api";
import type { JournalTrade } from "@/types/forex";

export type SignalStatus = "active" | "watching" | "triggered";

export interface ActiveSignal {
  instrument: string;
  pair: string;
  direction: "long" | "short";
  strategy: string;
  timeframe: string;
  evaluatedAt: string | null;
  entry: number;
  stop: number;
  target: number;
  riskReward: number | null;
  current: number | null;
  status: SignalStatus;
  riskPercent: number;
  lots: number | null;
  fillPrice: number | null;
  note: string | null;
}

export interface RecentSignal {
  id: string;
  instrument: string;
  pair: string;
  direction: "long" | "short";
  strategy: string;
  outcome: "tp" | "sl" | "expired" | "other";
  resultR: number | null;
  closedAt: string | null;
}

const DEFAULT_RISK_PERCENT = 1;

/** Branded, card-facing names for the pair strategies (mirrors the web map). */
const STRATEGY_NAME: Record<string, string> = {
  EUR_USD: "GX Range Break V1",
  USD_JPY: "GX Body Extreme V6",
  GBP_USD: "GX Frequency V3",
  AUD_USD: "GX Structure V1",
  NZD_USD: "GX Pre-Range Breakout V1",
  USD_CAD: "GX Structure V1",
  USD_CHF: "GX Consensus Structure V1",
  EUR_JPY: "GX Range Break V1",
  CAD_JPY: "GX Range Break V1",
  NZD_JPY: "GX Range Break V1",
  GBP_JPY: "GX Range Break V1",
  EUR_GBP: "GX Structure V1",
  EUR_AUD: "GX Structure V1",
  AUD_JPY: "GX Range Break V1",
};

export function signalStrategyName(instrument: string): string {
  return STRATEGY_NAME[instrument] ?? "GX Signal";
}

const TIMEFRAME_LABEL: Record<string, string> = { "15m": "M15", "30m": "M30", "1h": "H1" };

export function timeframeLabel(timeframe: string): string {
  return TIMEFRAME_LABEL[timeframe] ?? timeframe.toUpperCase();
}

const STATUS_ORDER: Record<SignalStatus, number> = { active: 0, triggered: 1, watching: 2 };

export const RECENT_OUTCOME_LABEL: Record<RecentSignal["outcome"], string> = {
  tp: "TP hit",
  sl: "SL hit",
  expired: "Expired",
  other: "Closed",
};

function signalStatus(setupStatus: StrategySetup["status"], triggered: boolean): SignalStatus {
  if (triggered) return "triggered";
  return setupStatus === "valid" ? "active" : "watching";
}

export function buildActiveSignals(
  setups: StrategySetup[],
  plans: Pick<WatchRow, "instrument" | "openTradeId">[],
  quotes: Record<string, { bid: number; ask: number }>,
): ActiveSignal[] {
  const openByInstrument = new Set(
    plans.filter((plan) => plan.openTradeId).map((plan) => plan.instrument),
  );

  return setups
    .filter(
      (setup) =>
        setup.direction &&
        setup.entry !== null &&
        setup.stop !== null &&
        setup.target !== null &&
        (setup.status === "valid" || setup.status === "developing"),
    )
    .map((setup) => {
      const triggered = openByInstrument.has(setup.instrument);
      const status = signalStatus(setup.status, triggered);
      const quote = quotes[setup.instrument];
      const current = quote ? (quote.bid + quote.ask) / 2 : null;
      return {
        instrument: setup.instrument,
        pair: displayNameFor(setup.instrument),
        direction: setup.direction as "long" | "short",
        strategy: signalStrategyName(setup.instrument),
        timeframe: timeframeLabel(setup.timeframe),
        evaluatedAt: setup.evaluatedAt ?? null,
        entry: setup.entry as number,
        stop: setup.stop as number,
        target: setup.target as number,
        riskReward: setup.riskReward,
        current,
        status,
        riskPercent: DEFAULT_RISK_PERCENT,
        lots: setup.positionSize?.standardLots ?? null,
        fillPrice: triggered ? (setup.entry as number) : null,
        note: status === "watching" ? setup.summary || null : null,
      };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

function outcomeKind(trade: JournalTrade): RecentSignal["outcome"] {
  const outcome = (trade.outcome ?? "").toLowerCase();
  if (outcome.includes("target") || trade.result === "win") return "tp";
  if (outcome.includes("stop") || trade.result === "loss") return "sl";
  if (outcome.includes("expire") || outcome.includes("timeout")) return "expired";
  if ((trade.resultR ?? 0) > 0) return "tp";
  if ((trade.resultR ?? 0) < 0) return "sl";
  return "expired";
}

export function buildRecentSignals(trades: JournalTrade[], limit = 20): RecentSignal[] {
  return trades
    .filter((trade) => trade.status === "closed" && trade.closedAt)
    .slice()
    .sort((a, b) => new Date(b.closedAt ?? 0).getTime() - new Date(a.closedAt ?? 0).getTime())
    .slice(0, limit)
    .map((trade) => ({
      id: trade.id,
      instrument: trade.instrument ?? trade.pair,
      pair: trade.instrument ? displayNameFor(trade.instrument) : trade.pair,
      direction: trade.direction,
      strategy: signalStrategyName(trade.instrument ?? ""),
      outcome: outcomeKind(trade),
      resultR: trade.resultR,
      closedAt: trade.closedAt,
    }));
}

/** Where live price sits between stop (0) and target (1); direction-agnostic. */
export function signalProgress(signal: Pick<ActiveSignal, "stop" | "target" | "current">): number {
  if (signal.current === null) return 0;
  const span = signal.target - signal.stop;
  if (span === 0) return 0;
  return Math.min(1, Math.max(0, (signal.current - signal.stop) / span));
}

/** The open R multiple a live price implies for an active signal. */
export function signalOpenR(signal: ActiveSignal): number | null {
  if (signal.current === null || signal.entry === signal.stop) return null;
  return (
    ((signal.current - signal.entry) / Math.abs(signal.entry - signal.stop)) *
    (signal.direction === "long" ? 1 : -1)
  );
}
