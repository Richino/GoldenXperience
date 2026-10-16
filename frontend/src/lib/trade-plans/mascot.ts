import { displayNameFor, pipSizeFor, precisionFor } from "@/lib/instruments/catalog";
import type { ObserverMascotExpression } from "@/lib/observer-mascot";
import type { TradePlan } from "@/lib/trade-plans/api";

/**
 * What the mascot says about one pair's accepted plans. Pure: the same plans
 * always give the same line. Priority: a confirmed plan, then a blocked
 * confirmation, then a plan whose sequence has started, then distances to
 * the zones.
 */

export type MascotLine = {
  expression: ObserverMascotExpression;
  tone: "live" | "collecting" | "paused" | "closed";
  status: string;
  text: string;
};

const EARLY_STAGES = new Set([null, "WAITING", "WAITING_FOR_ZONE", "WAITING_FOR_BREAKOUT"]);

export function mascotLine(plans: TradePlan[]): MascotLine | null {
  if (!plans.length) return null;
  const instrument = plans[0]!.instrument;
  const pair = displayNameFor(instrument);
  const digits = precisionFor(instrument);
  const pip = pipSizeFor(instrument);
  const fmt = (value: number) => value.toFixed(digits);
  const status = `${pair} · ${plans.length === 2 ? "BUY & SELL" : plans[0]!.direction}`;

  const confirmed = plans.find((plan) => plan.status === "CONFIRMED" || plan.status === "NOTIFIED");
  if (confirmed) {
    const p = confirmed.monitorState?.proposal;
    const levels = p ? `Entry near ${fmt(p.entry)}, stop ${fmt(p.stopLoss)}, target ${fmt(p.takeProfit)}.` : `Stop ${fmt(confirmed.stopLoss ?? 0)}, target ${fmt(confirmed.takeProfit ?? 0)}.`;
    return {
      expression: "confirmed",
      tone: "live",
      status,
      text: confirmed.monitoringMode === "AUTO"
        ? `${confirmed.direction} confirmed. ${levels} Automatic execution isn't set up yet, so no order was placed.`
        : `${confirmed.direction} confirmed — your call. ${levels}`,
    };
  }

  const blocked = plans.find((plan) => plan.monitorStage === "CONFIRMED_BLOCKED");
  if (blocked) {
    return { expression: "cautious", tone: "paused", status, text: `${blocked.direction}: ${blocked.notTriggeredReason ?? "Setup formed but blocked for now."}` };
  }

  const progressing = plans.find((plan) => !EARLY_STAGES.has(plan.monitorStage) && plan.notTriggeredReason);
  if (progressing) {
    return { expression: "alert", tone: "live", status, text: `${progressing.direction}: ${progressing.notTriggeredReason}` };
  }

  const price = plans.find((plan) => plan.lastPrice !== null)?.lastPrice ?? null;
  if (price === null) {
    return { expression: "analyzing", tone: "collecting", status, text: `Watching ${pair}. First check of the zones within a minute.` };
  }
  const parts = plans.map((plan) => {
    const inside = price >= plan.entryZoneLow && price <= plan.entryZoneHigh;
    if (inside) return `price is in the ${plan.direction} zone`;
    const below = price < plan.entryZoneLow;
    const pips = Math.round((below ? plan.entryZoneLow - price : price - plan.entryZoneHigh) / pip);
    return `${plan.direction} zone ${fmt(plan.entryZoneLow)}–${fmt(plan.entryZoneHigh)} is ${pips} pips ${below ? "above" : "below"}`;
  });
  return { expression: "neutral", tone: "live", status, text: `${pair} at ${fmt(price)}: ${parts.join("; ")}.` };
}

/** The pair the mascot talks about: the chart's pair if it has plans, else the most urgent. */
export function mascotPair(plans: TradePlan[], chartInstrument: string | null): string | null {
  if (!plans.length) return null;
  if (chartInstrument && plans.some((plan) => plan.instrument === chartInstrument)) return chartInstrument;
  const urgent = plans.find((plan) => plan.status === "CONFIRMED" || plan.status === "NOTIFIED") ?? plans[0]!;
  return urgent.instrument;
}
