/**
 * h1-sell-only-v1 — isolated SELL-only H1 bias test.
 * Does not modify live engines or prior research outputs.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllPairs, MAJOR_INSTRUMENTS, type Instrument } from "../h1-direction-v1/data.js";
import { atrSeries } from "../h1-direction-v1/indicators.js";
import {
  summarize, sellOpenClose, sellForward, invertOutcome, classifyPairBias,
  fmtPct, sessionUtc, hourNewYork, type Outcome,
} from "./metrics.js";

const HORIZONS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "h1-sell-only-v1");
const FROZEN_SIGNALS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "h1-direction-v1", "SIGNALS.csv");
const ATR_WARMUP = 14;

mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(...a);

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(","))].join("\n");
}

function pairLabel(pair: Instrument): string {
  return pair.replace("_", "/");
}

function pairFromLabel(label: string): Instrument | null {
  const p = label.replace("/", "_") as Instrument;
  return (MAJOR_INSTRUMENTS as readonly string[]).includes(p) ? p : null;
}

type FrozenShort = { timestamp: string; pair: Instrument; result24h: Outcome };

function loadFrozenShorts(): FrozenShort[] {
  const text = readFileSync(FROZEN_SIGNALS, "utf8");
  const lines = text.trim().split("\n");
  const headers = lines[0]!.split(",");
  const dirIdx = headers.indexOf("direction");
  const tsIdx = headers.indexOf("timestamp");
  const pairIdx = headers.indexOf("pair");
  const r24Idx = headers.indexOf("result_24h");
  const out: FrozenShort[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    if (cols[dirIdx] !== "SHORT") continue;
    const pair = pairFromLabel(cols[pairIdx]!);
    if (!pair) continue;
    const result24h = cols[r24Idx] as Outcome;
    if (result24h !== "WIN" && result24h !== "LOSS" && result24h !== "TIE") continue;
    out.push({ timestamp: cols[tsIdx]!, pair, result24h });
  }
  return out;
}

async function main() {
  log("=== H1 Sell-Only V1 ===");
  log("Pairs:", MAJOR_INSTRUMENTS.map(pairLabel).join(", "));

  const dataset = await loadAllPairs();
  const frozenShorts = loadFrozenShorts();
  log(`Loaded ${frozenShorts.length} frozen SHORT signals from h1-direction-v1`);

  const allOpenClose: Outcome[] = [];
  const pairOpenClose = new Map<Instrument, Outcome[]>();
  const yearOutcomes = new Map<string, Outcome[]>();
  const monthOutcomes = new Map<string, Outcome[]>();
  const hourUtcOutcomes = new Map<number, Outcome[]>();
  const hourNyOutcomes = new Map<number, Outcome[]>();
  const sessionOutcomes = new Map<string, Outcome[]>();
  const candleBuckets = new Map<string, { outcomes: Outcome[]; signedReturns: number[] }>();
  const returns: number[] = [];
  const bearishReturns: number[] = [];
  const bullishReturns: number[] = [];
  const winMagnitudes: number[] = [];
  const lossMagnitudes: number[] = [];

  const forwardHorizons = Object.fromEntries(HORIZONS.map((h) => [h, [] as Outcome[]])) as Record<(typeof HORIZONS)[number], Outcome[]>;
  const forwardByPair = new Map<Instrument, Record<number, Outcome[]>>();

  for (const pair of MAJOR_INSTRUMENTS) {
    pairOpenClose.set(pair, []);
    forwardByPair.set(pair, Object.fromEntries(HORIZONS.map((h) => [h, [] as Outcome[]])));
  }

  const bucketDefs = [
    { label: "<0.10 ATR", lo: 0, hi: 0.10 },
    { label: "0.10-0.25 ATR", lo: 0.10, hi: 0.25 },
    { label: "0.25-0.50 ATR", lo: 0.25, hi: 0.50 },
    { label: "0.50-1.00 ATR", lo: 0.50, hi: 1.00 },
    { label: ">1.00 ATR", lo: 1.00, hi: Infinity },
  ];
  for (const b of bucketDefs) candleBuckets.set(b.label, { outcomes: [], signedReturns: [] });

  let totalCandles = 0;
  let totalMissing = 0;

  for (const pair of MAJOR_INSTRUMENTS) {
    const bars = dataset.barsByPair.get(pair)!;
    const atrs = atrSeries(bars, 14);
    totalCandles += bars.length;
    const cov = dataset.coverage.find((c) => c.pair === pair)!;
    totalMissing += cov.missingCandles;

    for (let i = ATR_WARMUP; i < bars.length; i++) {
      const bar = bars[i]!;
      const oc = sellOpenClose(bar.open, bar.close);
      allOpenClose.push(oc);
      pairOpenClose.get(pair)!.push(oc);

      const ret = (bar.close - bar.open) / bar.open;
      returns.push(ret);
      if (bar.close < bar.open) bearishReturns.push(ret);
      if (bar.close > bar.open) bullishReturns.push(ret);
      if (oc === "WIN") winMagnitudes.push(-ret);
      if (oc === "LOSS") lossMagnitudes.push(-ret);

      const year = bar.iso.slice(0, 4);
      const month = bar.iso.slice(0, 7);
      const hourUtc = new Date(bar.iso).getUTCHours();
      const session = sessionUtc(hourUtc);
      const hourNy = hourNewYork(bar.iso);

      if (!yearOutcomes.has(year)) yearOutcomes.set(year, []);
      if (!monthOutcomes.has(month)) monthOutcomes.set(month, []);
      if (!hourUtcOutcomes.has(hourUtc)) hourUtcOutcomes.set(hourUtc, []);
      if (!hourNyOutcomes.has(hourNy)) hourNyOutcomes.set(hourNy, []);
      if (!sessionOutcomes.has(session)) sessionOutcomes.set(session, []);

      yearOutcomes.get(year)!.push(oc);
      monthOutcomes.get(month)!.push(oc);
      hourUtcOutcomes.get(hourUtc)!.push(oc);
      hourNyOutcomes.get(hourNy)!.push(oc);
      sessionOutcomes.get(session)!.push(oc);

      const atr = atrs[i]!;
      if (atr > 0) {
        const bodyAtr = Math.abs(bar.close - bar.open) / atr;
        const signedRet = (bar.open - bar.close) / atr;
        for (const b of bucketDefs) {
          if (bodyAtr >= b.lo && bodyAtr < b.hi) {
            candleBuckets.get(b.label)!.outcomes.push(oc);
            candleBuckets.get(b.label)!.signedReturns.push(signedRet);
            break;
          }
        }
      }

      for (const h of HORIZONS) {
        if (i + h >= bars.length) continue;
        const fwd = sellForward(bar.close, bars[i + h]!.close);
        forwardHorizons[h].push(fwd);
        forwardByPair.get(pair)![h]!.push(fwd);
      }
    }
  }

  const overall = summarize(allOpenClose);
  const pairResults = MAJOR_INSTRUMENTS.map((pair) => {
    const stats = summarize(pairOpenClose.get(pair)!);
    return { pair, ...stats, bias: classifyPairBias(stats) };
  });
  pairResults.sort((a, b) => b.winRate - a.winRate);

  const yearResults = [...yearOutcomes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, oc]) => ({ year, ...summarize(oc) }));
  const monthResults = [...monthOutcomes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, oc]) => ({ month, ...summarize(oc) }));
  const hourResultsFixed = [...hourUtcOutcomes.entries()].sort((a, b) => a[0] - b[0]).map(([hourUtc, oc]) => {
    const sampleIso = `2024-06-15T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
    return { hourUtc, hourNewYork: hourNewYork(sampleIso), ...summarize(oc) };
  });

  const hourNyResults = [...hourNyOutcomes.entries()].sort((a, b) => a[0] - b[0]).map(([hourNewYork, oc]) => ({ hourNewYork, ...summarize(oc) }));
  const sessionResults = [...sessionOutcomes.entries()].map(([session, oc]) => ({ session, ...summarize(oc) }));
  sessionResults.sort((a, b) => b.winRate - a.winRate);

  const candleResults = bucketDefs.map((b) => {
    const data = candleBuckets.get(b.label)!;
    const stats = summarize(data.outcomes);
    const avgSigned = data.signedReturns.length
      ? data.signedReturns.reduce((s, x) => s + x, 0) / data.signedReturns.length
      : 0;
    return { bucket: b.label, count: stats.n, sellWr: stats.winRate, avgSignedReturn: avgSigned, ...stats };
  });

  const sortedMonths = [...monthResults].sort((a, b) => b.winRate - a.winRate);
  const bestMonth = sortedMonths[0]!;
  const worstMonth = sortedMonths.at(-1)!;

  const bestPair = pairResults[0]!;
  const worstPair = pairResults.at(-1)!;
  const bestSession = sessionResults[0]!;
  const worstSession = sessionResults.at(-1)!;

  const forwardStats = Object.fromEntries(HORIZONS.map((h) => [h, summarize(forwardHorizons[h])]));

  // Model comparison at 24H close-to-close
  const alwaysSell24 = summarize(forwardHorizons[24]!);
  const frozenStats = summarize(frozenShorts.map((s) => s.result24h));
  const invertedStats = summarize(frozenShorts.map((s) => invertOutcome(s.result24h)));

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  let verdict: "SELL_BIAS_FOUND" | "WEAK_SELL_BIAS" | "NO_SELL_BIAS" | "BUY_BIAS_FOUND" = "NO_SELL_BIAS";
  if (overall.ciLower > 0.5) verdict = overall.ciLower > 0.52 ? "SELL_BIAS_FOUND" : "WEAK_SELL_BIAS";
  else if (overall.ciUpper < 0.5) verdict = "BUY_BIAS_FOUND";

  const resultsJson = {
    verdict,
    generatedAt: new Date().toISOString(),
    pairs: [...MAJOR_INSTRUMENTS],
    historicalPeriod: { start: dataset.commonStart, end: dataset.commonEnd },
    totalH1Candles: totalCandles,
    totalMissingCandles: totalMissing,
    coverage: dataset.coverage,
    testA_openClose: overall,
    testB_forward: forwardStats,
    pairResults,
    yearResults,
    monthResults: { all: monthResults, best: bestMonth, worst: worstMonth },
    hourResultsUtc: hourResultsFixed,
    hourResultsNewYork: hourNyResults,
    sessionResults,
    candleResults,
    returnMagnitude: {
      medianHourlyReturn: median(returns),
      meanHourlyReturn: mean(returns),
      meanBearishCandleReturn: mean(bearishReturns),
      meanBullishCandleReturn: mean(bullishReturns),
      avgWinMagnitude: mean(winMagnitudes),
      avgLossMagnitude: mean(lossMagnitudes),
    },
    modelComparison24H: {
      alwaysSell: alwaysSell24,
      frozenShort: frozenStats,
      invertedFrozenShort: invertedStats,
    },
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(resultsJson, null, 2));
  writeFileSync(path.join(OUT, "PAIR_RESULTS.csv"), toCsv(
    pairResults.map((r) => ({
      pair: pairLabel(r.pair), candles: r.n, wins: r.wins, losses: r.losses, ties: r.ties,
      sellWr: fmtPct(r.winRate), ci95: `[${fmtPct(r.ciLower)}, ${fmtPct(r.ciUpper)}]`, bias: r.bias,
    })),
    ["pair", "candles", "wins", "losses", "ties", "sellWr", "ci95", "bias"],
  ));
  writeFileSync(path.join(OUT, "YEAR_RESULTS.csv"), toCsv(
    yearResults.map((r) => ({ year: r.year, wins: r.wins, losses: r.losses, ties: r.ties, sellWr: fmtPct(r.winRate), ci95: `[${fmtPct(r.ciLower)}, ${fmtPct(r.ciUpper)}]` })),
    ["year", "wins", "losses", "ties", "sellWr", "ci95"],
  ));
  writeFileSync(path.join(OUT, "MONTH_RESULTS.csv"), toCsv(
    monthResults.map((r) => ({ month: r.month, signals: r.n, sellWr: fmtPct(r.winRate) })),
    ["month", "signals", "sellWr"],
  ));
  writeFileSync(path.join(OUT, "HOUR_RESULTS.csv"), toCsv(
    hourResultsFixed.map((r) => ({ hourUtc: r.hourUtc, hourNewYork: r.hourNewYork, signals: r.n, sellWr: fmtPct(r.winRate) })),
    ["hourUtc", "hourNewYork", "signals", "sellWr"],
  ));
  writeFileSync(path.join(OUT, "SESSION_RESULTS.csv"), toCsv(
    sessionResults.map((r) => ({ session: r.session, signals: r.n, wins: r.wins, losses: r.losses, sellWr: fmtPct(r.winRate) })),
    ["session", "signals", "wins", "losses", "sellWr"],
  ));
  writeFileSync(path.join(OUT, "CANDLE_RESULTS.csv"), toCsv(
    candleResults.map((r) => ({ bucket: r.bucket, count: r.count, sellWr: fmtPct(r.sellWr), avgSignedReturn: r.avgSignedReturn.toFixed(5) })),
    ["bucket", "count", "sellWr", "avgSignedReturn"],
  ));

  const report = `# H1 Sell-Only V1 — FINAL REPORT

## VERDICT: \`${verdict}\`

**Period:** ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}  
**Pairs:** ${MAJOR_INSTRUMENTS.map(pairLabel).join(", ")}  
**Total H1 candles:** ${totalCandles.toLocaleString()}  
**Missing candles (all pairs):** ${totalMissing.toLocaleString()}

## Test A — Always SELL (open → close)

| Metric | Value |
| --- | --- |
| Candles | ${overall.n.toLocaleString()} |
| Wins | ${overall.wins.toLocaleString()} |
| Losses | ${overall.losses.toLocaleString()} |
| Ties | ${overall.ties.toLocaleString()} |
| SELL WR | ${fmtPct(overall.winRate)} |
| 95% CI | [${fmtPct(overall.ciLower)}, ${fmtPct(overall.ciUpper)}] |
| 50% in CI? | ${overall.fiftyInCi ? "Yes" : "No"} |

## Pair Results (open → close)

| Pair | Candles | Wins | Losses | Ties | SELL WR | Bias |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${pairResults.map((r) => `| ${pairLabel(r.pair)} | ${r.n} | ${r.wins} | ${r.losses} | ${r.ties} | ${fmtPct(r.winRate)} | ${r.bias} |`).join("\n")}

## Forward close-to-close SELL

| Horizon | n | SELL WR | 95% CI |
| --- | ---: | ---: | --- |
${HORIZONS.map((h) => { const s = forwardStats[h]!; return `| ${h}H | ${s.n} | ${fmtPct(s.winRate)} | [${fmtPct(s.ciLower)}, ${fmtPct(s.ciUpper)}] |`; }).join("\n")}

## Model Comparison (24H close-to-close)

| Method | Signals | Wins | Losses | WR |
| --- | ---: | ---: | ---: | ---: |
| Always SELL | ${alwaysSell24.n} | ${alwaysSell24.wins} | ${alwaysSell24.losses} | ${fmtPct(alwaysSell24.winRate)} |
| Frozen model SHORT | ${frozenStats.n} | ${frozenStats.wins} | ${frozenStats.losses} | ${fmtPct(frozenStats.winRate)} |
| Inverted frozen SHORT | ${invertedStats.n} | ${invertedStats.wins} | ${invertedStats.losses} | ${fmtPct(invertedStats.winRate)} |

> Reproduce: \`cd api-server && npm run h1-sell-only-v1\`
`;
  writeFileSync(path.join(OUT, "FINAL_REPORT.md"), report);

  // Terminal output
  log("\n# H1 SELL-ONLY RESULTS\n");
  log(`Historical period: ${dataset.commonStart.slice(0, 10)} → ${dataset.commonEnd.slice(0, 10)}`);
  log(`Pairs: ${MAJOR_INSTRUMENTS.map(pairLabel).join(", ")}`);
  log(`Candles: ${totalCandles.toLocaleString()}\n`);
  log("## NEXT H1 OPEN → CLOSE\n");
  log(`Wins: ${overall.wins.toLocaleString()}`);
  log(`Losses: ${overall.losses.toLocaleString()}`);
  log(`Ties: ${overall.ties.toLocaleString()}`);
  log(`SELL WR: ${fmtPct(overall.winRate)}`);
  log(`95% CI: [${fmtPct(overall.ciLower)}, ${fmtPct(overall.ciUpper)}]`);
  log(`50% in CI: ${overall.fiftyInCi ? "Yes" : "No"}\n`);
  log("## PAIR RESULTS\n");
  for (const r of pairResults) {
    log(`${pairLabel(r.pair).padEnd(11)} ${String(r.wins).padStart(6)}/${String(r.n).padStart(6)} = ${fmtPct(r.winRate)}  [${r.bias}]`);
  }
  log("\n## YEAR RESULTS\n");
  for (const r of yearResults) log(`${r.year}: ${fmtPct(r.winRate)} (n=${r.n})`);
  log("\n## BEST SELL PAIR\n");
  log(`Pair: ${pairLabel(bestPair.pair)}`);
  log(`WR: ${fmtPct(bestPair.winRate)}`);
  log(`n: ${bestPair.n}`);
  log(`95% CI: [${fmtPct(bestPair.ciLower)}, ${fmtPct(bestPair.ciUpper)}]\n`);
  log("## WORST SELL PAIR\n");
  log(`Pair: ${pairLabel(worstPair.pair)}`);
  log(`WR: ${fmtPct(worstPair.winRate)}`);
  log(`n: ${worstPair.n}`);
  log(`95% CI: [${fmtPct(worstPair.ciLower)}, ${fmtPct(worstPair.ciUpper)}]\n`);
  log("## BEST SESSION\n");
  log(`Session: ${bestSession.session}`);
  log(`WR: ${fmtPct(bestSession.winRate)}`);
  log(`n: ${bestSession.n}\n`);
  log("## WORST SESSION\n");
  log(`Session: ${worstSession.session}`);
  log(`WR: ${fmtPct(worstSession.winRate)}`);
  log(`n: ${worstSession.n}\n`);
  log("## FORWARD CLOSE-TO-CLOSE SELL TEST\n");
  for (const h of HORIZONS) {
    const s = forwardStats[h]!;
    log(`${String(h).padStart(2)}H: ${s.wins} / ${s.n} = ${fmtPct(s.winRate)}`);
  }
  log("\n## MODEL COMPARISON (24H)\n");
  log(`Always SELL: ${fmtPct(alwaysSell24.winRate)} (n=${alwaysSell24.n})`);
  log(`Frozen model SHORT: ${fmtPct(frozenStats.winRate)} (n=${frozenStats.n})`);
  log(`Inverted frozen SHORT: ${fmtPct(invertedStats.winRate)} (n=${invertedStats.n})\n`);
  log(`## VERDICT: ${verdict}\n`);
  log(`Report: ${path.join(OUT, "FINAL_REPORT.md")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
