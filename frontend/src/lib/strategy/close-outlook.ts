import { DAY_FORCED_EXIT_MINUTES, DAY_TRADING_TIME_ZONE } from "@/lib/strategy/strategy-engine";
import { getForexSessionStatus, localMinutes } from "@/lib/strategy/session";

/**
 * When an open paper trade is next going to be resolved, and why.
 *
 * Pure and read-only: it describes the behaviour the resolvers already have and
 * changes none of it. Nothing here can close, hold, or alter a trade.
 *
 * The rules it mirrors, in the order the resolver applies them:
 *   - Both resolvers are gated on the market being open, so nothing at all
 *     resolves over a weekend.
 *   - A trade is force-closed at 16:45 ET on its ENTRY DAY.
 *   - Failing that it runs to a 48-hour horizon and is closed as a timeout.
 *   - Stop or target can end it earlier at any point, which is why every label
 *     describes the LATEST it can close rather than a prediction.
 */

/** Mirrors OUTCOME_HOURS in the research resolver. */
export const OUTCOME_HORIZON_HOURS = 48;

export type CloseOutlookTone = "waiting" | "due" | "overdue";

export interface CloseOutlook {
  /** Short badge text. */
  label: string;
  /** The longer explanation, for a title attribute. */
  detail: string;
  tone: CloseOutlookTone;
}

/** Calendar date in the trading timezone, as YYYY-MM-DD. */
function tradingDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_TRADING_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function formatEt(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ET`;
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/**
 * Describe when this open trade will close.
 *
 * Returns null when the trade has no usable open time, so a caller renders
 * nothing rather than a confident guess.
 */
export function openTradeCloseOutlook(
  trade: { openedAt: string | null | undefined },
  now: Date = new Date(),
): CloseOutlook | null {
  if (!trade.openedAt) return null;
  const opened = new Date(trade.openedAt);
  if (Number.isNaN(opened.getTime())) return null;

  const horizon = new Date(opened.getTime() + OUTCOME_HORIZON_HOURS * 3_600_000);
  const pastHorizon = now >= horizon;
  const marketOpen = getForexSessionStatus(now).marketOpen;

  // The weekend dominates every other rule: both resolvers return early while
  // the market is shut, so nothing can close no matter how overdue it is.
  if (!marketOpen) {
    return {
      label: pastHorizon ? "Overdue — closes at reopen" : "Closes at reopen",
      detail: pastHorizon
        ? `Past its ${OUTCOME_HORIZON_HOURS}-hour horizon, but the resolvers are idle while forex is shut. It closes on the first scan after the Sunday 17:00 ET reopen.`
        : `Forex is shut, so nothing resolves until the Sunday 17:00 ET reopen. Its 16:45 ET session exit is applied then, from the real prices at the time.`,
      tone: pastHorizon ? "overdue" : "waiting",
    };
  }

  if (pastHorizon) {
    return {
      label: "Overdue — closes next scan",
      detail: `Open longer than the ${OUTCOME_HORIZON_HOURS}-hour horizon. The collector closes it on its next 60-second scan.`,
      tone: "overdue",
    };
  }

  const sameTradingDay = tradingDate(opened) === tradingDate(now);
  const minutesNow = localMinutes(now, DAY_TRADING_TIME_ZONE);

  if (sameTradingDay && minutesNow < DAY_FORCED_EXIT_MINUTES) {
    const left = DAY_FORCED_EXIT_MINUTES - minutesNow;
    const hours = Math.floor(left / 60);
    return {
      label: `Closes ${formatEt(DAY_FORCED_EXIT_MINUTES)}`,
      detail: `Day trade: forced exit at ${formatEt(DAY_FORCED_EXIT_MINUTES)}, about ${hours ? `${hours}h ${left % 60}m` : `${left}m`} away — sooner if it reaches its stop or target first.`,
      tone: "waiting",
    };
  }

  // Its session exit has already come due — either later the same day or on a
  // previous day — so the next scan is what books it.
  return {
    label: "Closes next scan",
    detail: `Its ${formatEt(DAY_FORCED_EXIT_MINUTES)} session exit is already due. The collector books it on the next 60-second scan, at the price from the time it should have exited.`,
    tone: "due",
  };
}
