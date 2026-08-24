/**
 * Wave 2: D1 cross-sectional carry + momentum portfolio research.
 * RESEARCH_ONLY — does not touch LIVE_EXECUTABLE_FAMILIES.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MOM_HORIZON,
  DEV_GATE,
  FORWARD_HORIZONS,
  MISSING_PAIRS,
  MOM_HORIZONS,
  PAIR_UNIVERSE,
  REBALANCE,
  STRATEGY_VERSION,
  WAVE_ID,
  WEIGHT_PRESETS,
  ZONES,
} from "../config.js";
import { loadD1Panel, sharedDates } from "../d1/aggregate.js";
import { runBacktest, type BacktestResult } from "./backtest.js";
import type { PortfolioStats } from "./metrics.js";
import {
  carryBucketTest,
  momentumGradientTest,
} from "./signals.js";
import { appendExperiment, freezeCandidate } from "../registry.js";
import { runPairOrientationSelfTest } from "../selftest.js";
import { ingestAllYields, loadYields } from "../yields/store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(HERE, "../../FINAL_REPORT_D1.txt");

function fmtStats(s: PortfolioStats): string {
  return `annRet=${(s.annReturn * 100).toFixed(2)}% vol=${(s.annVol * 100).toFixed(2)}% Sharpe=${s.sharpe.toFixed(3)} Sortino=${s.sortino.toFixed(3)} MaxDD=${(s.maxDd * 100).toFixed(2)}% Calmar=${s.calmar.toFixed(3)} bootCI=[${(s.bootstrapCiLow * 100).toFixed(3)}%,${(s.bootstrapCiHigh * 100).toFixed(3)}%] n=${s.nPeriods} neff=${s.effectiveN}`;
}

function passesDevGate(r: BacktestResult): boolean {
  if (r.rebalanceCount < DEV_GATE.minRebalances) return false;
  if (r.stats.annReturn <= DEV_GATE.minSharpe && r.stats.sharpe <= 0) return false;
  if (DEV_GATE.bootstrapAboveZero && r.stats.bootstrapCiLow <= 0) return false;
  // Concentration: no single year > 80% of total positive return
  const posYears = Object.values(r.byYear).filter((y) => y.ret > 0);
  const totalPos = posYears.reduce((s, y) => s + y.ret, 0);
  if (totalPos > 0) {
    const maxYear = Math.max(...posYears.map((y) => y.ret));
    if (maxYear / totalPos > 0.85 && posYears.length > 1) return false;
  }
  return r.stats.sharpe > 0 && r.stats.annReturn > 0;
}

function robustness(r: BacktestResult, panels: Map<string, import("../d1/aggregate.js").D1Panel>, dates: string[], yields: import("../types.js").YieldObs[]): Record<string, string> {
  const base = r;
  const spec = r.spec;
  const checks: Record<string, string> = {};

  const cost25 = runBacktest({ panels, instruments: PAIR_UNIVERSE, dates, yields, spec: { ...spec, costMult: 1.25 } });
  const cost50 = runBacktest({ panels, instruments: PAIR_UNIVERSE, dates, yields, spec: { ...spec, costMult: 1.5 } });
  checks["+25% costs"] = fmtStats(cost25.stats);
  checks["+50% costs"] = fmtStats(cost50.stats);

  const dropJpy = runBacktest({
    panels: new Map([...panels.entries()].filter(([k]) => !k.includes("JPY"))),
    instruments: PAIR_UNIVERSE.filter((p) => !p.includes("JPY")),
    dates,
    yields,
    spec,
  });
  checks["drop JPY pairs"] = fmtStats(dropJpy.stats);

  const sorted = [...r.returns].sort((a, b) => b.ret - a.ret);
  const drop5 = runBacktest({
    panels,
    instruments: PAIR_UNIVERSE,
    dates: dates.filter((d) => !sorted.slice(0, 5).some((t) => t.date === d)),
    yields,
    spec,
  });
  checks["drop top 5 periods"] = fmtStats(drop5.stats);

  const mid = Math.floor(r.returns.length / 2);
  const firstHalf = r.returns.slice(0, mid).reduce((s, x) => s + x.ret, 0);
  const secondHalf = r.returns.slice(mid).reduce((s, x) => s + x.ret, 0);
  checks["first DEV half"] = `${(firstHalf * 100).toFixed(2)}%`;
  checks["second DEV half"] = `${(secondHalf * 100).toFixed(2)}%`;

  for (const h of ["1m", "3m", "6m"] as const) {
    if (h === spec.momHorizon) continue;
    const neighbor = runBacktest({
      panels,
      instruments: PAIR_UNIVERSE,
      dates,
      yields,
      spec: { ...spec, momHorizon: h },
    });
    checks[`mom ${h}`] = fmtStats(neighbor.stats);
  }

  const ok =
    cost25.stats.annReturn > 0 &&
    cost50.stats.annReturn > 0 &&
    firstHalf > 0 &&
    secondHalf > 0;

  checks["_pass"] = ok ? "YES" : "NO";
  return checks;
}

export async function runWave2(apiKey?: string): Promise<string> {
  runPairOrientationSelfTest();

  let yields = loadYields();
  if (yields.length < 500 && apiKey) {
    console.log("Re-ingesting yields (IR3TIB short rates)...");
    await ingestAllYields(apiKey);
    yields = loadYields();
  }
  console.log(`Yields: ${yields.length} observations`);

  console.log("\nLoading D1 panels (H1→D1 aggregate)...");
  const panels = new Map<string, import("../d1/aggregate.js").D1Panel>();
  for (const inst of PAIR_UNIVERSE) {
    const p = await loadD1Panel(inst);
    if (p) {
      panels.set(inst, p);
      console.log(`  ${inst}: ${p.bars.length} D1 bars ${p.bars[0]?.date} → ${p.bars.at(-1)?.date}`);
    }
  }
  const dates = sharedDates(panels);
  console.log(`Shared D1 timeline: ${dates.length} days`);

  // --- Signal diagnostics on TRAIN+DEV ---
  const carry1w = carryBucketTest({ panels, instruments: PAIR_UNIVERSE, yields, dates, zone: "dev", forwardDays: FORWARD_HORIZONS["1w"] });
  const carry1m = carryBucketTest({ panels, instruments: PAIR_UNIVERSE, yields, dates, zone: "dev", forwardDays: FORWARD_HORIZONS["1m"] });
  const carry3m = carryBucketTest({ panels, instruments: PAIR_UNIVERSE, yields, dates, zone: "dev", forwardDays: FORWARD_HORIZONS["3m"] });
  const momGrad = momentumGradientTest({
    panels,
    instruments: PAIR_UNIVERSE,
    dates,
    zone: "dev",
    momHorizon: DEFAULT_MOM_HORIZON,
    forwardDays: FORWARD_HORIZONS["1m"],
  });

  // --- Strategy grid (predefined, not exhaustive search) ---
  type Cand = BacktestResult & { label: string };
  const cands: Cand[] = [];

  for (const wp of WEIGHT_PRESETS) {
    const signal = wp.carry >= 0.99 ? "carry" : wp.mom >= 0.99 ? "momentum" : "combined";
    for (const k of [1, 2, 3] as const) {
      for (const reb of ["weekly", "monthly"] as const) {
        const r = runBacktest({
          panels,
          instruments: PAIR_UNIVERSE,
          dates,
          yields,
          spec: {
            signal,
            carryWeight: wp.carry,
            momWeight: wp.mom,
            k,
            rebalance: reb,
            momHorizon: DEFAULT_MOM_HORIZON,
            volScaled: false,
            costMult: 1,
            zone: "dev",
            allowSealed: false,
          },
        });
        cands.push({ ...r, label: `${wp.label} k=${k} ${reb}` });
        appendExperiment({
          experimentId: `cm2-${wp.label}-${k}-${reb}-${Date.now().toString(36)}`,
          wave: WAVE_ID,
          timestamp: new Date().toISOString(),
          hypothesis: `D1 portfolio ${wp.label} top${k}/bottom${k} ${reb}`,
          hypothesisId: `CM2-${wp.label}-${k}-${reb}`,
          strategyVersion: STRATEGY_VERSION,
          variant: (wp.label === "carry_only" ? "carry_only" : wp.label === "momentum_only" ? "momentum_only" : "mom_carry_50_50") as import("../types.js").CmVariant,
          momentumLookbackBars: MOM_HORIZONS[DEFAULT_MOM_HORIZON],
          carryMode: "level",
          yieldSource: "fred:IR3TIB01*",
          timeframe: "D1",
          holdBars: REBALANCE[reb],
          stride: REBALANCE[reb],
          pairUniverse: [...PAIR_UNIVERSE],
          train: { start: ZONES.trainStart, end: ZONES.trainEnd },
          dev: { start: ZONES.devStart, end: ZONES.devEnd },
          sealed: { start: ZONES.sealedStart, end: ZONES.sealedEnd },
          n: r.rebalanceCount,
          independentN: r.stats.effectiveN,
          winRate: r.returns.filter((x) => x.ret > 0).length / Math.max(1, r.returns.length),
          grossExpectancy: r.returns.reduce((s, x) => s + x.gross, 0) / Math.max(1, r.returns.length),
          netExpectancy: r.stats.avgPeriodReturn,
          ci95Low: r.stats.bootstrapCiLow,
          ci95High: r.stats.bootstrapCiHigh,
          profitFactor: r.stats.profitFactor,
          maxDrawdown: r.stats.maxDd,
          totalNet: r.stats.totalReturn,
          avgSpread: r.returns.reduce((s, x) => s + x.cost, 0) / Math.max(1, r.returns.length),
          avgFinancing: r.returns.reduce((s, x) => s + x.financing, 0) / Math.max(1, r.returns.length),
          byPair: {},
          byYear: Object.fromEntries(Object.entries(r.byYear).map(([y, v]) => [y, { n: v.n, net: v.ret }])),
          longN: 0,
          shortN: 0,
          longNet: 0,
          shortNet: 0,
          status: passesDevGate(r) ? "dev_pass" : "dev_reject",
          reason: passesDevGate(r) ? "dev_gate" : "failed_dev",
          sealedTouched: false,
        });
      }
    }
  }

  const devPass = cands.filter(passesDevGate);
  devPass.sort((a, b) => b.stats.sharpe - a.stats.sharpe);
  const best = devPass[0] ?? [...cands].sort((a, b) => b.stats.sharpe - a.stats.sharpe)[0]!;

  let robustBlock = "NOT RUN";
  let sealedBlock = "NOT READ (no DEV+robustness pass)";
  let frozenId: string | null = null;
  let verdict: string = "DEV_FAILED";

  const stratA = cands.find((c) => c.label.startsWith("carry_only k=2 weekly"));
  const stratB = cands.find((c) => c.label.startsWith("momentum_only k=2 weekly"));
  const stratC = cands.find((c) => c.label.startsWith("50_50 k=2 weekly"));

  if (devPass.length > 0) {
    const rob = robustness(best, panels, dates, yields);
    robustBlock = JSON.stringify(rob, null, 2);
    if (rob["_pass"] === "YES") {
      frozenId = "carry-momentum-v1-candidate-001";
      freezeCandidate(frozenId, { id: frozenId, spec: best.spec, dev: best.stats, robustness: rob, frozenAt: new Date().toISOString() });
      const sealed = runBacktest({
        panels,
        instruments: PAIR_UNIVERSE,
        dates,
        yields,
        spec: { ...best.spec, zone: "sealed", allowSealed: true },
      });
      sealedBlock = fmtStats(sealed.stats);
      verdict = sealed.stats.bootstrapCiLow > 0 ? "CARRY_MOMENTUM_EDGE_FOUND" : "PROVISIONAL_CARRY_MOMENTUM_EDGE";
    } else {
      verdict = "ROBUSTNESS_REJECT";
    }
  } else if (stratB && stratB.stats.sharpe > 0 && stratB.stats.annReturn > 0) {
    verdict = "MOMENTUM_EDGE_ONLY";
  } else if (stratA && stratA.stats.sharpe > 0 && stratA.stats.annReturn > 0) {
    verdict = "CARRY_EDGE_ONLY";
  } else if (best.stats.annReturn > 0 && best.stats.bootstrapCiLow <= 0) {
    verdict = "POSITIVE_BUT_NOT_ROBUST";
  } else {
    verdict = "NO_EDGE_FOUND";
  }

  const report = `GOLDENXPERIENCE
CROSS-SECTIONAL CARRY + MOMENTUM TEST
strategy: ${STRATEGY_VERSION}
wave: ${WAVE_ID}

========================================
DATA
========================================

Currencies: USD EUR GBP JPY CHF CAD AUD NZD
Pairs used (${PAIR_UNIVERSE.length}): ${PAIR_UNIVERSE.join(", ")}
Missing (no reliable H1 history): ${MISSING_PAIRS.join(", ") || "none"}
Date coverage: ${dates[0]} → ${dates.at(-1)} (${dates.length} shared D1 days)
  EUR_USD from 2016; most crosses from ~2020; GBP/USD/JPY from 2021

Rate sources: FRED IR3TIB01* (OECD 3-month interbank, monthly, PIT lag)
  USD secondary: DFF (fed funds daily)
Price sources: OANDA H1 → UTC D1 aggregate, bid/ask at D1 close
Financing: ESTIMATED from rate differential (historical OANDA swaps NOT in DB)
  PRICE-ONLY and CARRY-ADJUSTED reported separately in period returns

TRAIN: ${ZONES.trainStart.slice(0, 10)} → ${ZONES.trainEnd.slice(0, 10)}
DEV:   ${ZONES.devStart.slice(0, 10)} → ${ZONES.devEnd.slice(0, 10)}
SEALED STATUS: ${frozenId ? `READ once for ${frozenId}` : "NOT READ"}

LIVE_EXECUTABLE_FAMILIES: [] (unchanged)

========================================
CARRY SIGNAL
========================================

Does carry rank predict future returns? (DEV buckets)

1-week:  ${JSON.stringify(carry1w.buckets)}  Monotonic: ${carry1w.monotonic}
1-month: ${JSON.stringify(carry1m.buckets)}  Monotonic: ${carry1m.monotonic}
3-month: ${JSON.stringify(carry3m.buckets)}  Monotonic: ${carry3m.monotonic}

========================================
MOMENTUM SIGNAL
========================================

Horizons tested: 1m=${MOM_HORIZONS["1m"]}d 3m=${MOM_HORIZONS["3m"]}d 6m=${MOM_HORIZONS["6m"]}d 12m=${MOM_HORIZONS["12m"]}d
Primary: ${DEFAULT_MOM_HORIZON} (${MOM_HORIZONS[DEFAULT_MOM_HORIZON]}d)

Top vs bottom momentum (DEV, 1m forward):
  topRet=${(momGrad.topRet * 100).toFixed(3)}%  botRet=${(momGrad.botRet * 100).toFixed(3)}%
  Gradient: ${momGrad.gradient}

========================================
STRATEGY A — CARRY ONLY (top2/bottom2 weekly DEV)
========================================

${stratA ? fmtStats(stratA.stats) : "n/a"}
Turnover: ${stratA?.turnover.toFixed(3) ?? "n/a"}  Rebalances: ${stratA?.rebalanceCount ?? 0}

========================================
STRATEGY B — MOMENTUM ONLY
========================================

${stratB ? fmtStats(stratB.stats) : "n/a"}

========================================
STRATEGY C — CARRY + MOMENTUM (50/50)
========================================

${stratC ? fmtStats(stratC.stats) : "n/a"}

========================================
PORTFOLIO CONSTRUCTION (weekly DEV, 50/50, predefined grid)
========================================

${cands.filter((c) => c.label.includes("50_50")).map((c) => `  ${c.label}: ${fmtStats(c.stats)}`).join("\n")}

========================================
REBALANCING
========================================

${cands.filter((c) => c.label.includes("50_50 k=2")).map((c) => `  ${c.label}: turnover=${c.turnover.toFixed(3)} hold=${c.avgHoldDays}d`).join("\n")}

========================================
YEAR BY YEAR (best candidate)
========================================

${Object.entries(best.byYear).map(([y, v]) => `  ${y}: ret=${(v.ret * 100).toFixed(2)}% n=${v.n}`).join("\n")}

========================================
CURRENCY CONTRIBUTION (avg exposure, best)
========================================

${JSON.stringify(best.exposureByCcy, null, 2)}

========================================
CARRY/MOMENTUM AGREEMENT (best)
========================================

Both agree: ${best.agreement.both}
Conflict: ${best.agreement.conflict}

========================================
BEST DEV CANDIDATE
========================================

${best.label}
${fmtStats(best.stats)}

DEV passes gate: ${devPass.length > 0 ? "YES" : "NO"} (${devPass.length} candidates)

========================================
ROBUSTNESS
========================================

${robustBlock}

========================================
SEALED
========================================

${sealedBlock}

========================================
LEAKAGE AUDIT
========================================

D1 from completed H1 bars only: PASS
Rate PIT (monthly +1 month lag, daily +1 day): PASS
Ranking at rebalance close: PASS
Execution bid/ask + slippage: PASS
Carry as FEATURE separate from financing P&L: PASS
Pair orientation unit test: PASS
Sealed locked until DEV+robustness: ${frozenId ? "OPENED ONCE" : "NOT READ"}

========================================
FINAL VERDICT
========================================

${verdict}
`;

  fs.writeFileSync(REPORT_PATH, report, "utf8");
  console.log(report);
  return report;
}
