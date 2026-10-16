"use client";

import { TradePlanCard } from "@/components/trade-plans/trade-plan-card";
import type { TradePlan } from "@/lib/trade-plans/api";
import styles from "@/components/trade-plans/trade-plans.module.css";

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const base: TradePlan = {
  id: "00000000-0000-4000-8000-000000000001",
  analysisId: "00000000-0000-4000-8000-0000000000aa",
  instrument: "EUR_USD",
  direction: "BUY",
  setupType: "SR_REVERSAL",
  status: "PENDING_APPROVAL",
  planVersion: 1,
  stateVersion: "2",
  monitoringMode: null,
  pausedAt: null,
  timeframe: "H1",
  marketBias: "Bearish",
  trendClassification: "D1 downtrend · H4 unclear · H1 transition",
  entryZoneLow: 1.12113,
  entryZoneHigh: 1.12153,
  stopLoss: 1.12015,
  takeProfit: 1.12386,
  rewardRisk: 1.76,
  maxRiskPercent: 1,
  plan: {
    entryTrigger: "A bullish M15 structure break after price rejects 1.12113–1.12153.",
    confirmation: [
      "Price reaches the support zone 1.12113–1.12153.",
      "A completed M15 candle rejects it, or sweeps below 1.12113 by at most 0.6 H1 ATR and closes back inside.",
      "If it swept, price reclaims the zone on a completed close — a sweep alone never triggers.",
      "M15 breaks its last lower high (local structure turns up).",
      "Estimated stop sits beyond the rejection.",
      "Reward/risk from the executable entry stays at least 1.5.",
      "News blackout, spread and account-risk checks pass.",
    ],
    stopLossRule: "Fixed at 1.12015 when approved: beyond the deepest allowed sweep plus 0.15 H1 ATR.",
    takeProfitRule: "Short of the next resistance zone 1.12399–1.12439 by 0.1 H1 ATR.",
    positionSizingRule: "Risk 1% of equity on the distance from the executable entry to the protective stop.",
    spreadSlippage: { rule: "No entry while the spread is over 15% of the stop distance." },
    newsRestrictions: { rule: "No new entry from 30 min before to 30 min after high-impact EUR/USD news.", upcomingHighImpact: [] },
    invalidation: { rules: ["A completed M15 close below 1.12088 (the zone gave way).", "The plan expires before confirming."] },
    expiryRule: "Expires 24h after it was generated if it has not confirmed.",
    explanation: [
      "Support at 1.12113–1.12153 (2 swing reactions, minor, old resistance that flipped), 0.5 H4 ATR from price.",
      "Reaching the zone is not a signal: the plan needs a rejection and an M15 structure turn.",
      "Against the D1 trend: a counter-trend plan, judged on its own confirmation.",
    ],
  },
  strategyVersion: "trade-plans-v1",
  marketDataAt: hours(-0.2),
  expiresAt: hours(23),
  createdAt: hours(-1),
  updatedAt: hours(-1),
  monitorStage: null,
  lastEvaluatedAt: null,
  lastPrice: null,
  notTriggeredReason: null,
  monitorState: null,
  conditions: [
    { key: "approach", label: "Price reaches the support zone", status: "PENDING", detail: null },
    { key: "rejection_or_sweep", label: "Rejection or liquidity sweep", status: "PENDING", detail: null },
    { key: "reclaim", label: "Zone reclaimed (if swept)", status: "PENDING", detail: null },
    { key: "local_structure", label: "M15 structure turns up", status: "PENDING", detail: null },
    { key: "stop_placement", label: "Stop beyond the rejection", status: "PENDING", detail: null },
    { key: "reward_risk", label: "Reward/risk still adequate", status: "PENDING", detail: null },
    { key: "execution_safety", label: "News, spread and risk checks", status: "PENDING", detail: null },
  ],
};

const monitoring: TradePlan = {
  ...base,
  id: "00000000-0000-4000-8000-000000000002",
  direction: "SELL",
  setupType: "BREAKOUT_RETEST",
  status: "MONITORING",
  monitoringMode: "NOTIFY",
  entryZoneLow: 1.12365, entryZoneHigh: 1.12425, stopLoss: 1.12537, takeProfit: 1.12166, rewardRisk: 1.9,
  monitorStage: "WAITING_FOR_RETEST",
  lastEvaluatedAt: hours(-0.05),
  lastPrice: 1.12296,
  notTriggeredReason: "Breakout confirmed; waiting for a retest of 1.12395.",
  conditions: [
    { key: "breakout_close", label: "H1 close below the zone", status: "PASSED", detail: "H1 closed at 1.12341, beyond 1.12395." },
    { key: "breakout_size", label: "Breakout clears the noise threshold", status: "PASSED", detail: "The close cleared the level by 0.31 H1 ATR (needs 0.25)." },
    { key: "retest", label: "Price retests the broken level", status: "PENDING", detail: "Waiting for price to come back within 0.30 H1 ATR of 1.12395." },
    { key: "retest_holds", label: "The retest holds", status: "PENDING", detail: null },
    { key: "continuation", label: "Bearish continuation", status: "PENDING", detail: null },
    { key: "reward_risk", label: "Reward/risk still adequate", status: "PENDING", detail: null },
    { key: "execution_safety", label: "News, spread and risk checks", status: "PENDING", detail: null },
  ],
};

const notified: TradePlan = {
  ...monitoring,
  id: "00000000-0000-4000-8000-000000000003",
  instrument: "USD_JPY",
  status: "NOTIFIED",
  entryZoneLow: 158.726, entryZoneHigh: 158.782, stopLoss: 158.922, takeProfit: 157.907, rewardRisk: 4.55,
  monitorStage: "CONFIRMED",
  notTriggeredReason: null,
  monitorState: { outcome: "CONFIRMED", proposal: { confirmedAt: hours(-0.3), side: "SELL", entry: 158.701, stopLoss: 158.922, takeProfit: 157.907, rewardRisk: 3.59, spread: 0.014, quoteTime: hours(-0.3) } },
  conditions: monitoring.conditions.map((item) => ({ ...item, status: "PASSED" as const, detail: item.detail ?? "Passed." })),
};

const blocked: TradePlan = {
  ...monitoring,
  id: "00000000-0000-4000-8000-000000000004",
  instrument: "GBP_USD",
  pausedAt: null,
  monitorStage: "CONFIRMED_BLOCKED",
  notTriggeredReason: "Technically confirmed, but blocked: News blackout: high-impact USD CPI at 12:30 UTC.",
  conditions: monitoring.conditions.map((item) => item.key === "execution_safety"
    ? { ...item, status: "BLOCKED" as const, detail: "News blackout: high-impact USD CPI at 12:30 UTC." }
    : { ...item, status: "PASSED" as const, detail: item.detail ?? "Passed." }),
};

const ended: TradePlan = { ...base, id: "00000000-0000-4000-8000-000000000005", status: "INVALIDATED", updatedAt: hours(-3), notTriggeredReason: "M15 closed at 1.12071, through 1.12088: the zone gave way.",
  conditions: base.conditions.map((item, index) => index === 0 ? { ...item, status: "PASSED" as const, detail: "Price reached the zone at 1.12140." } : index === 1 ? { ...item, status: "FAILED" as const, detail: "M15 closed at 1.12071, through 1.12088: the zone gave way." } : item) };

export function PlansPreview() {
  return (
    <main style={{ padding: 16, background: "var(--background)", minHeight: "100vh" }}>
      <div className={styles.list} style={{ maxWidth: "64rem" }}>
        {[base, monitoring, blocked, notified, ended].map((plan) => (
          <TradePlanCard key={plan.id} plan={plan} autoAvailable={false} onChanged={() => undefined} />
        ))}
      </div>
    </main>
  );
}
