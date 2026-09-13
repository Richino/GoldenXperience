/**
 * binary-master-v1 — 70% claim verification backtest.
 * Isolated research; does not modify production binary engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadM1Data, PAIRS, pairLabel, type Pair, type M1Bar } from "./data.js";
import {
  pinBarSignal, smaJustinSignal, binaryMasterSignal, invertedMaster,
  pinOnlyInvertedSma, invertedPinOnlySma, sessionUtc, SMA_SLOW,
} from "./indicators.js";
import {
  settle, stats, fmtPct, breakEvenWr, evPerUnit, simulateMartingale,
  type Dir, type Result, type TradeStats,
} from "./metrics.js";

const EXPIRIES = [1, 2, 3, 5, 10] as const;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "research", "binary-master-v1");
mkdirSync(OUT, { recursive: true });

const DEV_FRAC = 0.75;
const SEALED_FRAC = 0.25;
const log = (...a: unknown[]) => console.log(...a);

type Variant = "pin_only" | "sma_only" | "binary_master" | "pin_inv_sma" | "inv_pin_sma" | "inverted_master";

function csv(h: string[], rows: Record<string, unknown>[]) {
  const e = (v: unknown) => { const s = String(v ?? ""); return s.includes(",") ? `"${s.replace(/"/g, '""')}"` : s; };
  return [h.join(","), ...rows.map((r) => h.map((x) => e(r[x])).join(","))].join("\n");
}

type Trade = {
  pair: Pair;
  signalBar: number;
  entryIdx: number;
  entryIso: string;
  entryPrice: number;
  direction: Dir;
  variant: Variant;
  expiry: number;
  expiryPrice: number;
  result: Result;
  split: "DEV" | "SEALED";
  session: string;
  day: string;
  pin: Dir | null;
  sma: Dir | null;
};

function signalForVariant(v: Variant, pin: Dir | null, sma: Dir | null): Dir | null {
  switch (v) {
    case "pin_only": return pin;
    case "sma_only": return sma;
    case "binary_master": return binaryMasterSignal(pin, sma);
    case "pin_inv_sma": return pinOnlyInvertedSma(pin, sma);
    case "inv_pin_sma": return invertedPinOnlySma(pin, sma);
    case "inverted_master": return invertedMaster(pin, sma);
    default: {
      const _x: never = v;
      return _x;
    }
  }
}

function collectTrades(bars: M1Bar[], pair: Pair, splitCutoffMs: number): Trade[] {
  const closes = bars.map((b) => b.close);
  const out: Trade[] = [];
  const warmup = SMA_SLOW + 2;

  for (let i = warmup; i < bars.length - 11; i++) {
    const pin = pinBarSignal(bars, i);
    const sma = smaJustinSignal(closes, i);
    const entryIdx = i + 1;
    if (entryIdx >= bars.length) continue;
    const entryPrice = bars[entryIdx]!.open;
    const entryIso = bars[entryIdx]!.iso;
    const split: "DEV" | "SEALED" = bars[entryIdx]!.t < splitCutoffMs ? "DEV" : "SEALED";
    const session = sessionUtc(entryIso);
    const day = entryIso.slice(0, 10);

    for (const variant of ["binary_master", "pin_only", "sma_only", "pin_inv_sma", "inv_pin_sma", "inverted_master"] as Variant[]) {
      const dir = signalForVariant(variant, pin, sma);
      if (!dir) continue;
      for (const expiry of EXPIRIES) {
        const expIdx = entryIdx + expiry - 1;
        if (expIdx >= bars.length) continue;
        const expiryPrice = bars[expIdx]!.close;
        out.push({
          pair, signalBar: i, entryIdx, entryIso, entryPrice, direction: dir, variant,
          expiry, expiryPrice, result: settle(dir, entryPrice, expiryPrice), split, session, day,
          pin, sma,
        });
      }
    }
  }
  return out;
}

function filterTrades(all: Trade[], variant: Variant, expiry: number, split?: "DEV" | "SEALED") {
  return all.filter((t) => t.variant === variant && t.expiry === expiry && (!split || t.split === split));
}

function aggregate(trades: Trade[]): TradeStats {
  const wins = trades.filter((t) => t.result === "WIN").length;
  const losses = trades.filter((t) => t.result === "LOSS").length;
  const ties = trades.filter((t) => t.result === "TIE").length;
  return stats(wins, losses, ties);
}

function claimClass(wr: number, ciLower: number, ciUpper: number, n: number): string {
  if (n < 100) return "INSUFFICIENT_DATA";
  if (ciLower > 0.68) return "70_PERCENT_SUPPORTED";
  if (wr >= 0.67 && ciLower > 0.60) return "70_PERCENT_PLAUSIBLE_BUT_UNPROVEN";
  if (0.70 >= ciLower && 0.70 <= ciUpper) return "70_PERCENT_PLAUSIBLE_BUT_UNPROVEN";
  return "70_PERCENT_NOT_SUPPORTED";
}

async function main() {
  log("=== Binary Master 70% Claim Verification ===");
  const data = await loadM1Data();
  log(`Data source: ${data.source}, fetched: ${data.fetchedAt}`);
  for (const c of data.coverage) {
    log(`  ${pairLabel(c.pair)}: ${c.candles} M1 | ${c.start.slice(0, 10)} → ${c.end.slice(0, 10)} | gaps=${c.gaps} missing=${c.missing}`);
  }

  const allTimes = PAIRS.flatMap((p) => data.barsByPair.get(p)!.map((b) => b.t)).sort((a, b) => a - b);
  const splitCutoff = allTimes[Math.floor(allTimes.length * DEV_FRAC)]!;
  log(`Split: DEV < ${new Date(splitCutoff).toISOString()} | SEALED >=`);

  let allTrades: Trade[] = [];
  for (const pair of PAIRS) {
    allTrades = allTrades.concat(collectTrades(data.barsByPair.get(pair)!, pair, splitCutoff));
  }

  const masterSealed = filterTrades(allTrades, "binary_master", 3, "SEALED");
  const masterSealed5 = filterTrades(allTrades, "binary_master", 5, "SEALED");
  const masterDev = filterTrades(allTrades, "binary_master", 3, "DEV");

  const expiryResults = EXPIRIES.map((exp) => {
    const t = filterTrades(allTrades, "binary_master", exp, "SEALED");
    const s = aggregate(t);
    return { expiry: exp, ...s };
  });

  const variantResults = (["pin_only", "sma_only", "binary_master", "pin_inv_sma", "inv_pin_sma", "inverted_master"] as Variant[]).map((v) => {
    const t3 = filterTrades(allTrades, v, 3, "SEALED");
    const t5 = filterTrades(allTrades, v, 5, "SEALED");
    return { variant: v, exp3: aggregate(t3), exp5: aggregate(t5) };
  });

  const pairResults3 = PAIRS.map((pair) => ({ pair, ...aggregate(filterTrades(allTrades, "binary_master", 3, "SEALED").filter((t) => t.pair === pair)) }));
  const pairResults5 = PAIRS.map((pair) => ({ pair, ...aggregate(filterTrades(allTrades, "binary_master", 5, "SEALED").filter((t) => t.pair === pair)) }));

  const callPut3 = {
    call: aggregate(masterSealed.filter((t) => t.direction === "CALL")),
    put: aggregate(masterSealed.filter((t) => t.direction === "PUT")),
  };
  const callPut5 = {
    call: aggregate(masterSealed5.filter((t) => t.direction === "CALL")),
    put: aggregate(masterSealed5.filter((t) => t.direction === "PUT")),
  };

  const dailyMap = new Map<string, TradeStats & { day: string }>();
  for (const t of masterSealed5) {
    if (!dailyMap.has(t.day)) dailyMap.set(t.day, { day: t.day, ...stats(0, 0, 0) });
  }
  for (const day of [...new Set(masterSealed5.map((t) => t.day))]) {
    const ts = masterSealed5.filter((t) => t.day === day);
    dailyMap.set(day, { day, ...aggregate(ts) });
  }
  const dailyResults = [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  const sessionMap = new Map<string, TradeStats>();
  for (const t of masterSealed5) {
    if (!sessionMap.has(t.session)) sessionMap.set(t.session, stats(0, 0, 0));
  }
  for (const [session, _] of sessionMap) {
    sessionMap.set(session, aggregate(masterSealed5.filter((t) => t.session === session)));
  }
  const sessionResults = [...sessionMap.entries()].map(([session, s]) => ({ session, ...s }));

  const selectivity = [0.50, 0.60, 0.70, 0.80, 0.90]; // score N/A for rule model — use pin+sma agreement strength proxy: both fired = 1.0
  void selectivity;

  const sealed3 = aggregate(masterSealed);
  const sealed5 = aggregate(masterSealed5);
  const claim3 = claimClass(sealed3.winRate, sealed3.ciLower, sealed3.ciUpper, sealed3.decided);
  const claim5 = claimClass(sealed5.winRate, sealed5.ciLower, sealed5.ciUpper, sealed5.decided);

  const payouts = [0.70, 0.75, 0.80, 0.85, 0.90];
  const payoutEcon = payouts.map((p) => ({
    payout: p,
    breakEven: breakEvenWr(p),
    ev3m: evPerUnit(sealed3.winRate, p),
    ev5m: evPerUnit(sealed5.winRate, p),
  }));

  const mgOutcomes = masterSealed5.filter((t) => t.result !== "TIE").map((t) => t.result);
  const mg = simulateMartingale(mgOutcomes, 0.8, 4);
  const fixedPL80 = masterSealed5.reduce((s, t) => {
    if (t.result === "TIE") return s;
    return s + (t.result === "WIN" ? 0.8 : -1);
  }, 0);

  const totalCandles = data.coverage.reduce((s, c) => s + c.candles, 0);
  const totalMissing = data.coverage.reduce((s, c) => s + c.missing, 0);

  let verdict: string = "NO_BINARY_MASTER_EDGE";
  if (sealed5.decided < 100) verdict = "INSUFFICIENT_DATA";
  else if (claim3 === "70_PERCENT_SUPPORTED" || claim5 === "70_PERCENT_SUPPORTED") verdict = "70_PERCENT_CLAIM_SUPPORTED";
  else if (sealed5.ciLower > 0.52) verdict = "POSSIBLE_EDGE_BUT_NOT_70_PERCENT";

  const resultsJson = {
    verdict,
    claim3m: claim3,
    claim5m: claim5,
    data: { source: data.source, fetchedAt: data.fetchedAt, period: { start: data.coverage[0]?.start, end: data.coverage[0]?.end }, totalCandles, totalMissing, coverage: data.coverage },
    split: { devFraction: DEV_FRAC, cutoff: new Date(splitCutoff).toISOString() },
    sealedModel: { exp3: sealed3, exp5: sealed5, dev3: aggregate(masterDev) },
    expiryResults,
    variantResults,
    pairResults3,
    pairResults5,
    callPut3,
    callPut5,
    dailyResults,
    sessionResults,
    payoutEcon,
    martingale: { ...mg, individualWR: sealed5.winRate, fixedStakePL80: fixedPL80 },
    ruleConfidence: "AMBIGUOUS — original .ex4 sources unavailable; STRICT_NON_REPAINTING 12/26 SMA + standard pin bar",
    repaintingConcerns: "Commercial Justin/PinBar builds may repaint; this test uses causal bar-close signals only",
  };

  writeFileSync(path.join(OUT, "RESULTS.json"), JSON.stringify(resultsJson, null, 2));
  writeFileSync(path.join(OUT, "EXPIRY_RESULTS.csv"), csv(
    ["expiry", "signals", "wins", "losses", "ties", "winRate", "ci95"],
    expiryResults.map((r) => ({ expiry: r.expiry, signals: r.decided, wins: r.wins, losses: r.losses, ties: r.ties, winRate: fmtPct(r.winRate), ci95: `[${fmtPct(r.ciLower)}, ${fmtPct(r.ciUpper)}]` })),
  ));
  writeFileSync(path.join(OUT, "VARIANT_RESULTS.csv"), csv(
    ["variant", "expiry", "signals", "wins", "losses", "winRate", "ci95"],
    variantResults.flatMap((v) => [
      { variant: v.variant, expiry: 3, signals: v.exp3.decided, wins: v.exp3.wins, losses: v.exp3.losses, winRate: fmtPct(v.exp3.winRate), ci95: `[${fmtPct(v.exp3.ciLower)}, ${fmtPct(v.exp3.ciUpper)}]` },
      { variant: v.variant, expiry: 5, signals: v.exp5.decided, wins: v.exp5.wins, losses: v.exp5.losses, winRate: fmtPct(v.exp5.winRate), ci95: `[${fmtPct(v.exp5.ciLower)}, ${fmtPct(v.exp5.ciUpper)}]` },
    ]),
  ));
  writeFileSync(path.join(OUT, "PAIR_RESULTS.csv"), csv(
    ["expiry", "pair", "signals", "wins", "losses", "ties", "winRate"],
    [...pairResults3.map((r) => ({ expiry: 3, pair: pairLabel(r.pair), signals: r.decided, wins: r.wins, losses: r.losses, ties: r.ties, winRate: fmtPct(r.winRate) })),
      ...pairResults5.map((r) => ({ expiry: 5, pair: pairLabel(r.pair), signals: r.decided, wins: r.wins, losses: r.losses, ties: r.ties, winRate: fmtPct(r.winRate) }))],
  ));
  writeFileSync(path.join(OUT, "DAILY_RESULTS.csv"), csv(
    ["date", "signals", "wins", "losses", "winRate"],
    dailyResults.map((d) => ({ date: d.day, signals: d.decided, wins: d.wins, losses: d.losses, winRate: fmtPct(d.winRate) })),
  ));
  writeFileSync(path.join(OUT, "SESSION_RESULTS.csv"), csv(
    ["session", "signals", "winRate"],
    sessionResults.map((s) => ({ session: s.session, signals: s.decided, winRate: fmtPct(s.winRate) })),
  ));
  writeFileSync(path.join(OUT, "MARTINGALE_RESULTS.csv"), csv(
    ["metric", "value"],
    Object.entries({ individualWR: sealed5.winRate, sequenceSuccessRate: mg.sequenceSuccessRate, fullFailureRate: mg.fullFailure / Math.max(1, mg.sequences), simpleDoublingPL: mg.simpleDoublingPL, recoverySizingPL: mg.recoverySizingPL, maxDrawdown: mg.maxDrawdown, fixedStakePL80: fixedPL80 }).map(([metric, value]) => ({ metric, value })),
  ));
  writeFileSync(path.join(OUT, "TRADES.csv"), csv(
    ["timestamp", "pair", "split", "variant", "expiry", "direction", "entry", "expiryPrice", "result", "session"],
    masterSealed5.slice(0, 50000).map((t) => ({
      timestamp: t.entryIso, pair: pairLabel(t.pair), split: t.split, variant: t.variant, expiry: t.expiry,
      direction: t.direction, entry: t.entryPrice, expiryPrice: t.expiryPrice, result: t.result, session: t.session,
    })),
  ));

  const pin3 = variantResults.find((v) => v.variant === "pin_only")!.exp3;
  const sma3 = variantResults.find((v) => v.variant === "sma_only")!.exp3;
  const inv3 = variantResults.find((v) => v.variant === "inverted_master")!.exp3;

  writeFileSync(path.join(OUT, "FINAL_REPORT.md"), `# Binary Master 70% Claim Verification

## VERDICT: \`${verdict}\`

See SOURCE_RULES.md and REPAINT_AUDIT.md.

## Sealed fixed-stake (Binary Master)

| Expiry | n | WR | 95% CI |
|--------|---:|---:|---|
${expiryResults.map((r) => `| ${r.expiry}m | ${r.decided} | ${fmtPct(r.winRate)} | [${fmtPct(r.ciLower)}, ${fmtPct(r.ciUpper)}] |`).join("\n")}

## 70% claim (3m sealed)

Observed: ${fmtPct(sealed3.winRate)} | 70% in CI: ${sealed3.ciLower <= 0.7 && sealed3.ciUpper >= 0.7 ? "Yes" : "No"} | Class: ${claim3}

## 80% payout economics (5m)

Break-even: ${fmtPct(breakEvenWr(0.8))} | EV/trade: ${evPerUnit(sealed5.winRate, 0.8).toFixed(4)}

> Reproduce: \`cd api-server && npm run binary-master-v1\`
`);

  // Console report
  log("\n# BINARY MASTER — 70% CLAIM VERIFICATION\n");
  log(`Data period: ${data.coverage[0]?.start.slice(0, 10)} → ${data.coverage[0]?.end.slice(0, 10)}`);
  log(`Pairs: ${PAIRS.map(pairLabel).join(", ")}`);
  log(`M1 candles: ${totalCandles.toLocaleString()} (missing ${totalMissing.toLocaleString()})\n`);

  log("## RULE REPRODUCTION\n");
  log("PinBar: standard wick/body thresholds (see SOURCE_RULES.md)");
  log("SMA CrossOver Justin: SMA 12/26 cross on close, bar-close confirmation");
  log("Rule confidence: AMBIGUOUS (no original .mq4 in repo)");
  log("Repainting concerns: possible in commercial builds; strict causal replay used\n");

  log("## SEALED FIXED-STAKE RESULTS\n");
  for (const r of expiryResults) log(`${r.expiry}m WR: ${fmtPct(r.winRate)} (n=${r.decided})`);

  log("\n## PRIMARY 3M\n");
  log(`Signals: ${sealed3.decided}`);
  log(`Wins: ${sealed3.wins}`);
  log(`Losses: ${sealed3.losses}`);
  log(`Ties: ${sealed3.ties}`);
  log(`WR: ${fmtPct(sealed3.winRate)}`);
  log(`95% CI: [${fmtPct(sealed3.ciLower)}, ${fmtPct(sealed3.ciUpper)}]`);

  log("\n## PRIMARY 5M\n");
  log(`Signals: ${sealed5.decided}`);
  log(`Wins: ${sealed5.wins}`);
  log(`Losses: ${sealed5.losses}`);
  log(`Ties: ${sealed5.ties}`);
  log(`WR: ${fmtPct(sealed5.winRate)}`);
  log(`95% CI: [${fmtPct(sealed5.ciLower)}, ${fmtPct(sealed5.ciUpper)}]`);

  log("\n## CALL VS PUT (5m sealed)\n");
  log(`CALL WR: ${fmtPct(callPut5.call.winRate)} (n=${callPut5.call.decided})`);
  log(`PUT WR: ${fmtPct(callPut5.put.winRate)} (n=${callPut5.put.decided})`);

  log("\n## COMPONENTS (3m sealed)\n");
  log(`PinBar only: ${fmtPct(pin3.winRate)} (n=${pin3.decided})`);
  log(`SMA only: ${fmtPct(sma3.winRate)} (n=${sma3.decided})`);
  log(`Binary Master: ${fmtPct(sealed3.winRate)} (n=${sealed3.decided})`);
  log(`Inverted Binary Master: ${fmtPct(inv3.winRate)} (n=${inv3.decided})`);

  log("\n## 70% CLAIM\n");
  log("Claimed: ~70%");
  log(`Observed 3m: ${fmtPct(sealed3.winRate)}`);
  log(`Observed 5m: ${fmtPct(sealed5.winRate)}`);
  log(`70% inside 95% CI (3m)? ${sealed3.ciLower <= 0.7 && sealed3.ciUpper >= 0.7 ? "Yes" : "No"}`);
  log(`Classification 3m: ${claim3}`);

  log("\n## 80% PAYOUT\n");
  log(`Break-even WR: ${fmtPct(breakEvenWr(0.8))}`);
  log(`3m EV/trade: ${evPerUnit(sealed3.winRate, 0.8).toFixed(4)}`);
  log(`5m EV/trade: ${evPerUnit(sealed5.winRate, 0.8).toFixed(4)}`);

  log("\n## MARTINGALE (5m sealed, secondary)\n");
  log(`Individual WR: ${fmtPct(sealed5.winRate)}`);
  log(`Sequence success rate: ${fmtPct(mg.sequenceSuccessRate)}`);
  log(`Full sequence failure rate: ${fmtPct(mg.fullFailure / Math.max(1, mg.sequences))}`);
  log(`Simple-doubling P/L (units): ${mg.simpleDoublingPL.toFixed(2)}`);
  log(`Recovery-sizing P/L (units): ${mg.recoverySizingPL.toFixed(2)}`);
  log(`Maximum drawdown (units): ${mg.maxDrawdown.toFixed(2)}`);
  log(`Fixed-stake P/L @80%: ${fixedPL80.toFixed(2)}`);

  log(`\n## VERDICT: ${verdict}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
