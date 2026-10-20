import assert from "node:assert/strict";
import { addTradingHours, generateTradePlans, TRADE_PLAN_CONFIG, type GeneratorInput } from "../src/trade-plan-generator.js";
import { getForexSessionStatus } from "../../frontend/src/lib/strategy/session.js";
import { validateTradePlanInput } from "../src/trade-plans.js";
import { evaluateConfirmation } from "../src/trade-plan-confirmation.js";
import type { Candle } from "../../frontend/src/types/forex.js";

/**
 * Trade plan generator on fixed synthetic candles: no network, no
 * randomness. Asserts behaviour (levels on the right side, no lookahead,
 * mirror symmetry, refusals), not profitability.
 */

const HOUR = 3_600_000;
const STEP = { D1: 24 * HOUR, H4: 4 * HOUR, H1: HOUR, M15: HOUR / 4 } as const;
/** Wednesday 2026-10-14 12:00 UTC: market open, mid-week. */
const NOW = Date.parse("2026-10-14T12:00:00Z");

/** One price path (turning points at times), sampled into candles of every timeframe. */
type Path = Array<[number, number]>; // [ms, price]
function priceAt(path: Path, at: number) {
  if (at <= path[0]![0]) return path[0]![1];
  for (let i = 1; i < path.length; i += 1) {
    const [t1, p1] = path[i]!;
    const [t0, p0] = path[i - 1]!;
    if (at <= t1) return p0 + ((p1 - p0) * (at - t0)) / (t1 - t0);
  }
  return path.at(-1)![1];
}
function candles(path: Path, step: number, count: number, end: number, wick: number): Candle[] {
  const out: Candle[] = [];
  const firstOpen = Math.floor(end / step) * step - count * step;
  for (let i = 0; i < count; i += 1) {
    const open = firstOpen + i * step;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((f) => priceAt(path, open + f * step));
    out.push({
      time: new Date(open).toISOString(),
      open: samples[0]!,
      close: samples[4]!,
      high: Math.max(...samples) + wick,
      low: Math.min(...samples) - wick,
      volume: 100,
      complete: true,
    });
  }
  return out;
}

/** Zigzag uptrend: higher highs and higher lows over the last ~50 days, ending between zones. */
/** Scale 5 gives EUR/USD-like volatility (H4 ATR ≈ 25 pips). */
function uptrendPath(center = 1.12, scale = 5): Path {
  const legs = [0, -0.02, 0.0, -0.012, 0.008, -0.004, 0.016, 0.006, 0.024, 0.012, 0.03, 0.019, 0.0198];
  const span = 52 * 24 * HOUR;
  return legs.map((offset, i) => [NOW - span + (span * i) / (legs.length - 1), center + offset * scale]);
}

function inputFor(path: Path, patch: Partial<GeneratorInput> = {}, wick = 0.001): GeneratorInput {
  const close = priceAt(path, NOW);
  return {
    instrument: "EUR_USD",
    candles: {
      D1: candles(path, STEP.D1, 300, NOW, wick),
      H4: candles(path, STEP.H4, 300, NOW, wick),
      H1: candles(path, STEP.H1, 300, NOW, wick),
      M15: candles(path, STEP.M15, 300, NOW, wick),
    },
    quote: { bid: close - 0.00004, ask: close + 0.00004, time: new Date(NOW - 1000).toISOString() },
    news: [],
    now: NOW,
    maxRiskPercent: 1,
    ...patch,
  };
}

const mirror = (path: Path, center: number): Path => path.map(([t, p]) => [t, 2 * center - p]);
const strip = (result: ReturnType<typeof generateTradePlans>) =>
  result.plans.map((plan) => ({ direction: plan.direction, setupType: plan.setupType, low: plan.entryZoneLow, high: plan.entryZoneHigh, stop: plan.stopLoss, target: plan.takeProfit, rr: plan.rewardRisk }));

let passed = 0;
function test(name: string, run: () => void) {
  try { run(); passed += 1; console.log(`ok  ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; }
}

const base = uptrendPath();
const result = generateTradePlans(inputFor(base));

test("an uptrend between zones produces conditional plans", () => {
  assert.equal(result.result, "PLANS", result.reason ?? "");
  assert.ok(result.plans.length >= 1 && result.plans.length <= 2);
  assert.equal(result.context?.trend.H4, "UPTREND");
});

test("every plan validates and has its levels on the right side", () => {
  for (const plan of result.plans) {
    assert.equal(validateTradePlanInput(plan, new Date(NOW)), null, `${plan.direction} ${plan.setupType}`);
    assert.ok(plan.stopLoss !== null && plan.takeProfit !== null);
    if (plan.direction === "BUY") assert.ok(plan.stopLoss! < plan.entryZoneLow && plan.takeProfit! > plan.entryZoneHigh);
    else assert.ok(plan.stopLoss! > plan.entryZoneHigh && plan.takeProfit! < plan.entryZoneLow);
    assert.ok((plan.rewardRisk ?? 0) >= TRADE_PLAN_CONFIG.minRewardRisk);
    const mid = (plan.entryZoneLow + plan.entryZoneHigh) / 2;
    const atr = result.context!.atr;
    assert.ok(Math.abs(plan.takeProfit! - mid) <= TRADE_PLAN_CONFIG.maxTargetD1Atr * atr.D1 + 1e-5, "target within a 2–5 day reach");
    assert.ok(Math.abs(mid - plan.stopLoss!) >= TRADE_PLAN_CONFIG.minStopAtr * atr.H4 - 1e-5, "stop outside H4 noise");
  }
});

test("plans are swing plans: H4 setup, H4 breakouts, H1 confirmation, 72h to trigger, 5-day hold", () => {
  for (const plan of result.plans) {
    assert.equal(plan.timeframe, "H4");
    const rules = plan.plan.rules as Record<string, unknown>;
    assert.equal(rules.atrTimeframe, "H4");
    assert.equal(rules.atr, result.context!.atr.H4);
    if (plan.setupType === "BREAKOUT_RETEST") { assert.equal(rules.breakoutTimeframe, "H4"); assert.equal(rules.retestTimeframe, "H1"); }
    else assert.equal(rules.confirmTimeframe, "H1");
    assert.equal(plan.plan.maxHoldTradingDays, 5);
    assert.equal(plan.expiresAt, new Date(addTradingHours(NOW, 72)).toISOString());
  }
});

test("at most one plan per direction", () => {
  const directions = result.plans.map((plan) => plan.direction);
  assert.equal(new Set(directions).size, directions.length);
});

test("plans carry their conditions, rules, evidence and inputs", () => {
  for (const plan of result.plans) {
    const keys = plan.conditions!.map((condition) => condition.key);
    if (plan.setupType === "BREAKOUT_RETEST") {
      for (const key of ["breakout_close", "retest", "retest_holds", "continuation"]) assert.ok(keys.includes(key), key);
    } else {
      for (const key of ["approach", "rejection_or_sweep", "reclaim", "local_structure"]) assert.ok(keys.includes(key), key);
    }
    for (const field of ["entryTrigger", "confirmation", "stopLossRule", "takeProfitRule", "positionSizingRule", "spreadSlippage", "newsRestrictions", "invalidation", "explanation"]) {
      assert.ok(plan.plan[field] !== undefined, field);
    }
    assert.ok((plan.plan.explanation as string[]).length >= 2);
    assert.ok(Date.parse(plan.expiresAt) > NOW);
    assert.equal(plan.analysisId, result.analysisId);
    assert.ok(plan.analysisInputs && "context" in plan.analysisInputs);
  }
});

test("a sweep alone is never the trigger", () => {
  for (const plan of result.plans.filter((item) => item.setupType === "SR_REVERSAL")) {
    assert.ok((plan.plan.confirmation as string[]).some((line) => /sweep alone never triggers/.test(line)));
  }
});

test("a breakout alone is never the trigger", () => {
  for (const plan of result.plans.filter((item) => item.setupType === "BREAKOUT_RETEST")) {
    assert.ok((plan.plan.confirmation as string[]).some((line) => /retest/.test(line)));
    assert.ok((plan.plan.explanation as string[]).some((line) => /breakout alone is not a signal/.test(line)));
  }
});

test("an incomplete candle is ignored (no lookahead)", () => {
  const input = inputFor(base);
  const spike = (series: Candle[] | undefined, step: number): Candle[] => {
    const last = series!.at(-1)!;
    return [...series!, { time: new Date(Date.parse(last.time) + step).toISOString(), open: last.close, high: last.close + 0.05, low: last.close - 0.05, close: last.close + 0.04, volume: 1, complete: false }];
  };
  const withSpike = generateTradePlans({
    ...input,
    candles: { D1: spike(input.candles.D1, STEP.D1), H4: spike(input.candles.H4, STEP.H4), H1: spike(input.candles.H1, STEP.H1), M15: spike(input.candles.M15, STEP.M15) },
  });
  assert.deepEqual(strip(withSpike), strip(result));
});

test("mirrored prices give mirrored plans", () => {
  const center = 1.12;
  const mirrored = generateTradePlans(inputFor(mirror(base, center)));
  assert.equal(mirrored.context?.trend.H4, "DOWNTREND");
  const flip = (direction: string) => (direction === "BUY" ? "SELL" : "BUY");
  const expected = strip(result).map((plan) => ({ direction: flip(plan.direction), setupType: plan.setupType })).sort((a, b) => a.direction.localeCompare(b.direction));
  const actual = strip(mirrored).map((plan) => ({ direction: plan.direction, setupType: plan.setupType })).sort((a, b) => a.direction.localeCompare(b.direction));
  assert.deepEqual(actual, expected);
  for (const plan of strip(result)) {
    const twin = strip(mirrored).find((item) => item.direction === flip(plan.direction) && item.setupType === plan.setupType)!;
    assert.ok(Math.abs(twin.stop! - (2 * center - plan.stop!)) < 0.001, "stop mirrors");
    assert.ok(Math.abs(twin.target! - (2 * center - plan.target!)) < 0.001, "target mirrors");
  }
});

test("doubling volatility scales the levels instead of changing the setups", () => {
  // Same shape at twice the amplitude (and twice the wick): ATR doubles, so ATR-based rules pick the same setups.
  const wide = generateTradePlans(inputFor(uptrendPath(1.12, 10), {}, 0.002));
  assert.deepEqual(strip(wide).map((plan) => [plan.direction, plan.setupType]), strip(result).map((plan) => [plan.direction, plan.setupType]));
});

test("too little history is TECHNICAL_DATA_UNAVAILABLE", () => {
  const input = inputFor(base);
  const short = generateTradePlans({ ...input, candles: { ...input.candles, H1: input.candles.H1!.slice(-30) } });
  assert.equal(short.result, "TECHNICAL_DATA_UNAVAILABLE");
  assert.equal(short.plans.length, 0);
});

test("stale candles are TECHNICAL_DATA_UNAVAILABLE", () => {
  const stale = generateTradePlans({ ...inputFor(base), now: NOW + 6 * HOUR });
  assert.equal(stale.result, "TECHNICAL_DATA_UNAVAILABLE");
  assert.match(stale.reason ?? "", /data/i);
});

test("an unreadable calendar keeps the plan but blocks entry until it is readable", () => {
  const unknown = generateTradePlans(inputFor(base, { news: null }));
  assert.equal(unknown.context?.news.state, "NEWS_UNKNOWN");
  for (const plan of unknown.plans) {
    assert.match((plan.plan.newsRestrictions as { rule: string }).rule, /could not be read/);
  }
});

test("upcoming high-impact news is listed on the plan", () => {
  const news = [{ title: "CPI", currency: "USD", impact: 3, timestamp: new Date(NOW + 6 * HOUR).toISOString() }];
  const withNews = generateTradePlans(inputFor(base, { news }));
  for (const plan of withNews.plans) {
    const upcoming = (plan.plan.newsRestrictions as { upcomingHighImpact: Array<{ title: string }> }).upcomingHighImpact;
    assert.ok(upcoming.some((event) => event.title === "CPI"));
  }
});

test("low estimated reward/risk keeps both conditional scenarios without lowering the entry threshold", () => {
  const original = TRADE_PLAN_CONFIG.minRewardRisk;
  (TRADE_PLAN_CONFIG as { minRewardRisk: number }).minRewardRisk = 50;
  try {
    const strict = generateTradePlans(inputFor(base));
    assert.equal(strict.result, "PLANS");
    assert.deepEqual(strict.plans.map((plan) => plan.direction).sort(), ["BUY", "SELL"]);
    for (const plan of strict.plans) {
      assert.equal((plan.plan.entryReadiness as { status: string }).status, "WAITING_FOR_RISK_REWARD");
      assert.equal((plan.plan.rules as { minRewardRisk: number }).minRewardRisk, 50);
      assert.equal(validateTradePlanInput(plan, new Date(NOW)), null);
    }
  } finally {
    (TRADE_PLAN_CONFIG as { minRewardRisk: number }).minRewardRisk = original;
  }
});

test("plan lifetimes count open-market hours only", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  // Mid-week: plain wall-clock hours.
  assert.equal(iso(addTradingHours(Date.parse("2026-10-14T12:00:00Z"), 24)), "2026-10-15T12:00:00.000Z");
  // Friday 08:00 New York: 9h until the 17:00 close, then the rest after Sunday's 17:00 open.
  assert.equal(iso(addTradingHours(Date.parse("2026-10-16T12:00:00Z"), 24)), "2026-10-19T12:00:00.000Z");
  // Made while closed (Saturday): the clock starts at Sunday's open.
  assert.equal(iso(addTradingHours(Date.parse("2026-10-17T04:56:00Z"), 24)), "2026-10-19T21:00:00.000Z");
  // Over a whole week of start times, no plan ever expires while the market is closed.
  for (let start = Date.parse("2026-10-12T00:00:00Z"); start < Date.parse("2026-10-19T00:00:00Z"); start += 37 * 60_000) {
    for (const hours of [24, 48]) {
      const end = addTradingHours(start, hours);
      assert.ok(getForexSessionStatus(new Date(end - 60_000)).marketOpen, `${iso(start)} + ${hours}h ended at ${iso(end)} with the market closed`);
    }
  }
});

test("generated plans carry everything the confirmation engine needs", () => {
  const input = inputFor(base);
  for (const plan of result.plans) {
    const evaluation = evaluateConfirmation({
      plan: { ...plan, stopLoss: plan.stopLoss!, takeProfit: plan.takeProfit!, createdAt: new Date(NOW).toISOString() },
      candles: { H4: input.candles.H4!, H1: input.candles.H1!, M15: input.candles.M15! },
      quote: input.quote, news: [], now: NOW,
      limits: { maxSpreadStopFraction: 0.15, maxDataAgeSeconds: 10, newsBlackoutBeforeMinutes: 30, newsBlackoutAfterMinutes: 30 },
    });
    // No candle has closed since creation: nothing can have confirmed or failed yet.
    assert.equal(evaluation.outcome, "WAITING", `${plan.direction} ${plan.setupType}: ${evaluation.notTriggeredReason}`);
    assert.ok(evaluation.notTriggeredReason);
  }
});

console.log(`trade plan generator: ${passed} checks passed`);
console.log(JSON.stringify(strip(result)));
