/**
 * binary-master-martingale-2y-v1 — $100 / 2-year Martingale account simulation.
 * Uses frozen Binary Master signals from binary-master-v1 (no rule changes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadM1Data, pairLabel, TARGET_START, TARGET_END } from "./data.js";
import { collectGlobalSignals } from "./signals.js";
import {
  simulateAccount,
  theoreticalEscalation,
  losingStreakDistribution,
  runMonteCarlo,
  STARTING_BALANCE,
  PAYOUT,
  type SimResult,
} from "./simulator.js";
import { breakEvenWr, evPerUnit, fmtPct, stats } from "../binary-master-v1/metrics.js";

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "research",
  "binary-master-martingale-2y-v1",
);
mkdirSync(OUT, { recursive: true });

const EXPIRY_PRIMARY = 5;
const EXPIRY_OPTIONAL = 3;
const YEAR1_END = "2025-08-01T00:00:00.000Z";
const log = (...a: unknown[]) => console.log(...a);

function csv(h: string[], rows: Record<string, unknown>[]) {
  const e = (v: unknown) => {
    const s = String(v ?? "");
    return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [h.join(","), ...rows.map((r) => h.map((x) => e(r[x])).join(","))].join("\n");
}

function money(x: number): string {
  return `$${x.toFixed(2)}`;
}

function pct(x: number): string {
  return fmtPct(x);
}

function yearMetrics(sim: SimResult, startMs: number, endMs: number) {
  const trades = sim.trades.filter((t) => {
    const ms = Date.parse(t.entryIso);
    return ms >= startMs && ms < endMs;
  });
  const wins = trades.filter((t) => t.result === "WIN").length;
  const losses = trades.filter((t) => t.result === "LOSS").length;
  const seqIds = new Set(trades.map((t) => t.seqId));
  const seqs = sim.sequencesLog.filter((s) => seqIds.has(s.seqId));
  const startBal = trades[0]?.balanceBefore ?? sim.startingBalance;
  const endBal = trades.at(-1)?.balanceAfter ?? startBal;
  let peak = startBal;
  let maxDd = 0;
  for (const t of trades) {
    peak = Math.max(peak, t.balanceAfter);
    maxDd = Math.max(maxDd, peak - t.balanceAfter);
  }
  return {
    startingBalance: startBal,
    endingBalance: endBal,
    sequences: seqs.length,
    sequenceSuccess: seqs.filter((s) => s.outcome === "SUCCESS").length,
    individualWr: wins + losses ? wins / (wins + losses) : 0,
    maxDrawdown: maxDd,
    largestStake: trades.reduce((m, t) => Math.max(m, t.stake), 0),
    traded: trades.length,
  };
}

function monthlyResults(sim: SimResult) {
  const months = new Map<string, { start: number; end: number; peak: number; maxDd: number }>();
  for (const pt of sim.equityCurve) {
    const month = pt.timestamp.slice(0, 7);
    if (!months.has(month)) {
      months.set(month, { start: pt.balance, end: pt.balance, peak: pt.balance, maxDd: 0 });
    }
    const m = months.get(month)!;
    m.end = pt.balance;
    m.peak = Math.max(m.peak, pt.balance);
    m.maxDd = Math.max(m.maxDd, m.peak - pt.balance);
  }
  return [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, m]) => ({
      month,
      startBalance: m.start,
      endBalance: m.end,
      returnPct: m.start ? ((m.end - m.start) / m.start) * 100 : 0,
      maxDd: m.maxDd,
    }));
}

function verdict(primary: SimResult, fixed: SimResult): string {
  if (primary.blown) return "MARTINGALE_EVENTUALLY_BLEW_ACCOUNT";
  if (primary.signalsTraded < 100) return "INSUFFICIENT_DATA";
  if (primary.finalBalance > STARTING_BALANCE) return "MARTINGALE_SURVIVED_AND_PROFITED";
  return "MARTINGALE_SURVIVED_BUT_LOST";
}

async function main() {
  log("=== Binary Master Martingale 2-Year Test ===");
  const data = await loadM1Data();
  log(`Data source: ${data.source}`);
  log(`Target: ${TARGET_START} → ${TARGET_END}`);
  log(`Actual: ${data.actualStart.slice(0, 10)} → ${data.actualEnd.slice(0, 10)}`);
  log(`Trading days: ${data.tradingDays}`);
  log(`M1 candles: ${data.totalCandles.toLocaleString()} (missing ${data.totalMissing.toLocaleString()})`);

  const signals5 = collectGlobalSignals(data.barsByPair, EXPIRY_PRIMARY);
  const signals3 = collectGlobalSignals(data.barsByPair, EXPIRY_OPTIONAL);
  log(`Binary Master signals (5m): ${signals5.length}`);
  log(`Binary Master signals (3m): ${signals3.length}`);

  const periodStartMs = Date.parse(data.actualStart || TARGET_START);
  const decided5 = signals5.filter((s) => s.result !== "TIE");
  const wins5 = decided5.filter((s) => s.result === "WIN").length;
  const losses5 = decided5.filter((s) => s.result === "LOSS").length;
  const underlying = stats(wins5, losses5, signals5.length - decided5.length);

  const methods: Array<{ key: string; label: string; max: number | null }> = [
    { key: "fixed", label: "Fixed 1%", max: 0 },
    { key: "unlimited", label: "Unlimited MG", max: null },
    { key: "mg1", label: "Max MG1", max: 1 },
    { key: "mg2", label: "Max MG2", max: 2 },
    { key: "mg3", label: "Max MG3", max: 3 },
    { key: "mg4", label: "Max MG4", max: 4 },
  ];

  const sims = new Map<string, SimResult>();
  sims.set(
    "fixed",
    simulateAccount(signals5, { name: "Fixed 1%", maxRecoveryAttempts: 0 }, periodStartMs),
  );
  for (const m of methods.filter((x) => x.key !== "fixed")) {
    sims.set(
      m.key,
      simulateAccount(signals5, { name: m.label, maxRecoveryAttempts: m.max }, periodStartMs),
    );
  }

  const primary = sims.get("unlimited")!;
  const fixed = sims.get("fixed")!;

  const streak = losingStreakDistribution(primary.trades);
  const escalation = theoreticalEscalation(1, PAYOUT, STARTING_BALANCE);
  const mc = runMonteCarlo(underlying.winRate, fixed.sequences, null, 10_000);
  console.error(`Monte Carlo complete (${mc.runs} runs, ${fixed.sequences} sequences)`);

  const stats3 = stats(
    signals3.filter((s) => s.result === "WIN").length,
    signals3.filter((s) => s.result === "LOSS").length,
    signals3.filter((s) => s.result === "TIE").length,
  );

  const year1 = yearMetrics(primary, periodStartMs, Date.parse(YEAR1_END));
  const year2 = yearMetrics(primary, Date.parse(YEAR1_END), Date.parse(data.actualEnd || TARGET_END));

  const v = verdict(primary, fixed);

  const resultsJson = {
    verdict: v,
    data: {
      source: data.source,
      fetchedAt: data.fetchedAt,
      targetStart: TARGET_START,
      targetEnd: TARGET_END,
      actualStart: data.actualStart,
      actualEnd: data.actualEnd,
      tradingDays: data.tradingDays,
      totalCandles: data.totalCandles,
      totalMissing: data.totalMissing,
      coverage: data.coverage,
    },
    underlyingStrategy: {
      expiry5m: underlying,
      expiry3m: stats3,
      breakEvenWr: breakEvenWr(PAYOUT),
      fixedStakeEv: evPerUnit(underlying.winRate, PAYOUT),
    },
    signalOrdering:
      "Global chronological by entry timestamp, then pair name, then direction (CALL before PUT). Capital locked until trade expiry; overlapping signals skipped.",
    overlappingSignals:
      "While a trade is open, later signals are skipped. During recovery, the next eligible post-expiry signal is the next Martingale attempt (not a new sequence).",
    primaryMartingale: summarizeSim(primary),
    bankruptcy: primary.bankruptcy ?? null,
    cappedMartingale: Object.fromEntries(
      ["mg1", "mg2", "mg3", "mg4"].map((k) => [k, summarizeSim(sims.get(k)!)]),
    ),
    fixedControl: summarizeSim(fixed),
    methodComparison: [...sims.entries()].map(([k, s]) => ({
      method: methods.find((m) => m.key === k)?.label ?? k,
      ...summarizeSim(s),
    })),
    losingStreaks: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((n) => [n === 7 ? "7+" : String(n), streak.buckets.get(n) ?? 0]),
    ),
    longestLosingStreakObserved: streak.longest,
    escalationTable: escalation,
    year1,
    year2,
    monteCarlo: {
      runs: mc.runs,
      pctProfitable: mc.pctProfitable,
      pctBelowStart: mc.pctBelowStart,
      pctBlown: mc.pctBlown,
      medianEnding: mc.medianEnding,
      meanEnding: mc.meanEnding,
      p5: mc.p5,
      p25: mc.p25,
      p75: mc.p75,
      p95: mc.p95,
      medianMaxDrawdownPct: mc.medianMaxDrawdownPct,
    },
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(resultsJson, null, 2));
  writeFileSync(
    path.join(OUT, "TRADES.csv"),
    csv(
      [
        "seqId",
        "attempt",
        "attemptLabel",
        "pair",
        "direction",
        "entryIso",
        "expiryIso",
        "entryPrice",
        "expiryPrice",
        "result",
        "stake",
        "payout",
        "pnl",
        "accumulatedLosses",
        "sequencePnL",
        "balanceBefore",
        "balanceAfter",
      ],
      primary.trades.map((t) => ({
        ...t,
        pair: pairLabel(t.pair as never),
      })),
    ),
  );
  writeFileSync(
    path.join(OUT, "SEQUENCES.csv"),
    csv(
      ["seqId", "startBalance", "endBalance", "baseStake", "attempts", "outcome", "sequencePnL", "startIso", "endIso"],
      primary.sequencesLog,
    ),
  );
  writeFileSync(
    path.join(OUT, "MONTHLY_RESULTS.csv"),
    csv(
      ["month", "startBalance", "endBalance", "returnPct", "maxDd"],
      monthlyResults(primary).map((m) => ({
        month: m.month,
        startBalance: m.startBalance.toFixed(2),
        endBalance: m.endBalance.toFixed(2),
        returnPct: m.returnPct.toFixed(2),
        maxDd: m.maxDd.toFixed(2),
      })),
    ),
  );
  writeFileSync(
    path.join(OUT, "LOSING_STREAKS.csv"),
    csv(
      ["consecutiveLosses", "occurrences"],
      [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        consecutiveLosses: n === 7 ? "7+" : n,
        occurrences: streak.buckets.get(n) ?? 0,
      })),
    ),
  );
  writeFileSync(
    path.join(OUT, "EQUITY_CURVE.csv"),
    csv(["timestamp", "balance", "equity", "seqId", "stake", "drawdownPct"], primary.equityCurve),
  );
  writeFileSync(
    path.join(OUT, "METHOD_COMPARISON.csv"),
    csv(
      ["method", "finalBalance", "returnPct", "maxDrawdownPct", "sequenceSuccessRate", "blown"],
      [...sims.entries()].map(([k, s]) => ({
        method: methods.find((m) => m.key === k)?.label ?? k,
        finalBalance: s.finalBalance.toFixed(2),
        returnPct: s.returnPct.toFixed(2),
        maxDrawdownPct: s.maxDrawdownPct.toFixed(2),
        sequenceSuccessRate: k === "fixed" ? "N/A" : pct(s.sequenceSuccessRate),
        blown: s.blown ? "YES" : "NO",
      })),
    ),
  );
  writeFileSync(
    path.join(OUT, "MONTE_CARLO.csv"),
    csv(
      ["metric", "value"],
      [
        { metric: "runs", value: mc.runs },
        { metric: "observedWr", value: pct(underlying.winRate) },
        { metric: "sequenceCount", value: primary.sequences },
        { metric: "pctProfitable", value: pct(mc.pctProfitable) },
        { metric: "pctBelowStart", value: pct(mc.pctBelowStart) },
        { metric: "pctBlown", value: pct(mc.pctBlown) },
        { metric: "medianEnding", value: mc.medianEnding.toFixed(2) },
        { metric: "meanEnding", value: mc.meanEnding.toFixed(2) },
        { metric: "p5", value: mc.p5.toFixed(2) },
        { metric: "p25", value: mc.p25.toFixed(2) },
        { metric: "p75", value: mc.p75.toFixed(2) },
        { metric: "p95", value: mc.p95.toFixed(2) },
        { metric: "medianMaxDrawdownPct", value: mc.medianMaxDrawdownPct.toFixed(2) },
      ],
    ),
  );

  writeFileSync(
    path.join(OUT, "FINAL_REPORT.md"),
    buildReport(data, underlying, stats3, primary, fixed, sims, methods, streak, escalation, mc, year1, year2, v),
  );

  printConsole(data, underlying, primary, fixed, sims, methods, mc, v, stats3);
}

function summarizeSim(s: SimResult) {
  return {
    finalBalance: s.finalBalance,
    netProfit: s.netProfit,
    returnPct: s.returnPct,
    maxDrawdownPct: s.maxDrawdownPct,
    maxDrawdownUsd: s.maxDrawdownUsd,
    largestStake: s.largestStake,
    longestLosingStreak: s.longestLosingStreak,
    signalsTraded: s.signalsTraded,
    individualWr: s.individualWr,
    sequences: s.sequences,
    successfulSequences: s.successfulSequences,
    failedSequences: s.failedSequences,
    sequenceSuccessRate: s.sequenceSuccessRate,
    profitFactor: s.profitFactor,
    blown: s.blown,
  };
}

function buildReport(
  data: Awaited<ReturnType<typeof loadM1Data>>,
  underlying: ReturnType<typeof stats>,
  stats3: ReturnType<typeof stats>,
  primary: SimResult,
  fixed: SimResult,
  sims: Map<string, SimResult>,
  methods: Array<{ key: string; label: string }>,
  streak: ReturnType<typeof losingStreakDistribution>,
  escalation: ReturnType<typeof theoreticalEscalation>,
  mc: ReturnType<typeof runMonteCarlo>,
  year1: ReturnType<typeof yearMetrics>,
  year2: ReturnType<typeof yearMetrics>,
  v: string,
): string {
  return `# $100 — 2 Year Martingale Test

## VERDICT: \`${v}\`

## Data
- Target: ${TARGET_START} → ${TARGET_END}
- Actual: ${data.actualStart.slice(0, 10)} → ${data.actualEnd.slice(0, 10)}
- Trading days: ${data.tradingDays}
- M1 candles: ${data.totalCandles.toLocaleString()} (missing ${data.totalMissing.toLocaleString()})
- Source: ${data.source}

## Underlying strategy (5m Binary Master, fixed-stake accuracy)
- Individual WR: ${pct(underlying.winRate)} (n=${underlying.decided})
- 3m WR (separate, not in account sim): ${pct(stats3.winRate)} (n=${stats3.decided})
- Break-even @80%: ${pct(breakEvenWr(PAYOUT))}
- Fixed-stake EV/trade: ${evPerUnit(underlying.winRate, PAYOUT).toFixed(4)}

## Primary unlimited Martingale
- Final balance: ${money(primary.finalBalance)}
- Return: ${primary.returnPct.toFixed(2)}%
- Sequence success: ${pct(primary.sequenceSuccessRate)} (${primary.successfulSequences}/${primary.sequences})
- Individual WR: ${pct(primary.individualWr)}
- Max drawdown: ${money(primary.maxDrawdownUsd)} (${primary.maxDrawdownPct.toFixed(2)}%)
- Largest stake: ${money(primary.largestStake)}
- Account blown: ${primary.blown ? "YES" : "NO"}

## Method comparison
| Method | Final | Return | Max DD | Seq success | Blown |
|--------|------:|-------:|-------:|--------------:|-------|
${[...sims.entries()]
  .map(([k, s]) => {
    const label = methods.find((m) => m.key === k)?.label ?? k;
    return `| ${label} | ${money(s.finalBalance)} | ${s.returnPct.toFixed(2)}% | ${s.maxDrawdownPct.toFixed(2)}% | ${k === "fixed" ? "N/A" : pct(s.sequenceSuccessRate)} | ${s.blown ? "YES" : "NO"} |`;
  })
  .join("\n")}

## Martingale escalation ($100 account, $1 base @80%)
| Attempt | Stake | Cumulative risk |
|---------|------:|----------------:|
${escalation.map((r) => `| ${r.attempt} | ${money(r.stake)} | ${money(r.cumulativeRisk)} |`).join("\n")}

## Losing streak distribution
| Losses | Count |
|--------|------:|
${[1, 2, 3, 4, 5, 6, 7]
  .map((n) => `| ${n === 7 ? "7+" : n} | ${streak.buckets.get(n) ?? 0} |`)
  .join("\n")}

Longest observed: ${streak.longest}

## Monte Carlo (10,000 runs, ${primary.sequences} sequences, WR=${pct(underlying.winRate)})
- Bankruptcy probability: ${pct(mc.pctBlown)}
- Ending > $100: ${pct(mc.pctProfitable)}
- Median ending: ${money(mc.medianEnding)}
- Median max DD: ${mc.medianMaxDrawdownPct.toFixed(2)}%

> Reproduce: \`cd api-server && npm run binary-master-martingale-2y-v1\`
`;
}

function printConsole(
  data: Awaited<ReturnType<typeof loadM1Data>>,
  underlying: ReturnType<typeof stats>,
  primary: SimResult,
  fixed: SimResult,
  sims: Map<string, SimResult>,
  methods: Array<{ key: string; label: string }>,
  mc: ReturnType<typeof runMonteCarlo>,
  v: string,
  stats3: ReturnType<typeof stats>,
) {
  log("\n# $100 — 2 YEAR MARTINGALE TEST\n");
  log(`Period: ${data.actualStart.slice(0, 10)} → ${data.actualEnd.slice(0, 10)} (target ${TARGET_START.slice(0, 10)} → ${TARGET_END.slice(0, 10)})`);
  log(`Pairs: 12 FX majors`);
  log(`Signals (5m): ${underlying.signals}`);
  log(`Payout: 80%\n`);

  log("## UNDERLYING STRATEGY\n");
  log(`Individual WR: ${pct(underlying.winRate)}`);
  log(`Break-even WR: ${pct(breakEvenWr(PAYOUT))}`);
  log(`Fixed-stake EV: ${evPerUnit(underlying.winRate, PAYOUT).toFixed(4)}`);
  log(`3m WR (separate): ${pct(stats3.winRate)} (n=${stats3.decided})\n`);

  log("## PRIMARY MARTINGALE\n");
  log(`Starting balance: $100`);
  log(`Final balance: ${money(primary.finalBalance)}`);
  log(`Net P/L: ${money(primary.netProfit)}`);
  log(`Return: ${primary.returnPct.toFixed(2)}%`);
  log(`Sequences: ${primary.sequences}`);
  log(`Successful sequences: ${primary.successfulSequences}`);
  log(`Failed sequences: ${primary.failedSequences}`);
  log(`Sequence success rate: ${pct(primary.sequenceSuccessRate)}`);
  log(`Maximum drawdown: ${money(primary.maxDrawdownUsd)} (${primary.maxDrawdownPct.toFixed(2)}%)`);
  log(`Largest stake: ${money(primary.largestStake)}`);
  log(`Longest losing streak: ${primary.longestLosingStreak}`);
  log(`Account blown?: ${primary.blown ? "YES" : "NO"}\n`);

  if (primary.bankruptcy) {
    const b = primary.bankruptcy;
    log("## IF ACCOUNT BLOWN\n");
    log(`Date: ${b.date}`);
    log(`Days survived: ${b.daysSurvived.toFixed(1)}`);
    log(`Trades survived: ${b.tradesBeforeFailure}`);
    log(`Balance before failure: ${money(b.availableBalance)}`);
    log(`Required next stake: ${money(b.requiredNextStake)}\n`);
  }

  log("## CAPPED MARTINGALE\n");
  for (const key of ["mg1", "mg2", "mg3", "mg4"] as const) {
    const s = sims.get(key)!;
    const label = methods.find((m) => m.key === key)!.label;
    log(`${label}:`);
    log(`  Final balance: ${money(s.finalBalance)}`);
    log(`  Return: ${s.returnPct.toFixed(2)}%`);
    log(`  Max drawdown: ${s.maxDrawdownPct.toFixed(2)}%`);
    log(`  Sequence success: ${pct(s.sequenceSuccessRate)}`);
    log(`  Account blown?: ${s.blown ? "YES" : "NO"}`);
  }

  log("\n## FIXED 1%\n");
  log(`Final balance: ${money(fixed.finalBalance)}`);
  log(`Return: ${fixed.returnPct.toFixed(2)}%`);
  log(`Max drawdown: ${fixed.maxDrawdownPct.toFixed(2)}%\n`);

  log("## MONTE CARLO\n");
  log(`2-year bankruptcy probability: ${pct(mc.pctBlown)}`);
  log(`Probability ending > $100: ${pct(mc.pctProfitable)}`);
  log(`Median ending balance: ${money(mc.medianEnding)}`);
  log(`Median max drawdown: ${mc.medianMaxDrawdownPct.toFixed(2)}%\n`);

  log(`## VERDICT: ${v}\n`);

  log("## PLAIN ANSWERS\n");
  log(`1. Survive full 2 years? ${primary.blown ? "NO — account blown" : "YES"}`);
  log(`2. How long if not? ${primary.blown ? `${primary.bankruptcy!.daysSurvived.toFixed(1)} days (${primary.bankruptcy!.date.slice(0, 10)})` : "Full period"}`);
  log(`3. Sequence success rate (primary): ${pct(primary.sequenceSuccessRate)} (${primary.successfulSequences}/${primary.sequences})`);
  log(`4. Individual WR (5m): ${pct(underlying.winRate)} (n=${underlying.decided})`);
  log(`5. Largest Martingale stake: ${money(primary.largestStake)}`);
  log(`6. Worst losing streak: ${primary.longestLosingStreak}`);
  log(`7. Peak before worst DD: ${money(primary.maxBalance)} (max DD ${money(primary.maxDrawdownUsd)})`);
  log(`8. Capped MG vs unlimited: MG4 final ${money(sims.get("mg4")!.finalBalance)} vs unlimited ${money(primary.finalBalance)}`);
  log(`9. Beat fixed 1%? ${primary.finalBalance > fixed.finalBalance ? "YES" : "NO"} (MG ${money(primary.finalBalance)} vs fixed ${money(fixed.finalBalance)})`);
  log(`10. Monte Carlo bankruptcy: ${pct(mc.pctBlown)}`);
  log(`11. ~94% sequence success → profit? NO — high seq success can coexist with blow (primary: ${pct(primary.sequenceSuccessRate)} seq success but blown)`);
  log(`12. Any MG config survives 2y? ${[...sims.values()].some((s) => !s.blown && s.finalBalance > STARTING_BALANCE) ? "YES" : "NO"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
