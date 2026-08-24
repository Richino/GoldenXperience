import { loadCandles, loadQuotes, alignQuotes, pipSizeFor } from "../../src/data.js";
import { meanCi95, maxDrawdown, mean, profitFactor } from "../../src/math.js";
import {
  CURRENCIES,
  DECISION_EVERY_BARS,
  EDGE,
  FINANCING_SCALE,
  PAIR_UNIVERSE,
  PRIMARY_TIMEFRAME,
  SLIPPAGE_PIPS,
  STRATEGY_VERSION,
  WAVE_ID,
  ZONES,
  type Hypothesis,
} from "./config.js";
import { atr14, rankDescending, splitPair } from "./momentum/currency-strength.js";
import {
  carryFavorsDirection,
  momentumFavorsTrade,
  pairCarryDifferential,
  pairFromCurrencies,
  wouldBreachExposure,
} from "./pairs.js";
import { loadYields, yieldAsOf, yieldChange } from "./yields/store.js";
import type { CmExperiment, CmVariant, Currency, Direction, TradeResult, YieldObs } from "./types.js";

type PanelBar = {
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  bidClose: number | null;
  askClose: number | null;
};

type Panel = {
  instrument: string;
  bars: PanelBar[];
  closes: number[];
  highs: number[];
  lows: number[];
  atrs: number[];
  timeIndex: Map<string, number>;
};

function zoneOf(iso: string): "train" | "dev" | "sealed" | "other" {
  const t = Date.parse(iso);
  if (t >= Date.parse(ZONES.trainStart) && t <= Date.parse(ZONES.trainEnd)) return "train";
  if (t >= Date.parse(ZONES.devStart) && t <= Date.parse(ZONES.devEnd)) return "dev";
  if (t >= Date.parse(ZONES.sealedStart) && t <= Date.parse(ZONES.sealedEnd)) return "sealed";
  return "other";
}

function zscoreMap(scores: Map<Currency, number>): Map<Currency, number> {
  const vals = [...scores.values()];
  const m = mean(vals);
  const v = vals.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, vals.length);
  const sd = Math.sqrt(v) || 1;
  const out = new Map<Currency, number>();
  for (const [c, x] of scores) out.set(c, (x - m) / sd);
  return out;
}

function realizedVolPct(closes: number[], i: number, lookback = 20): number {
  if (i < lookback + 5) return 50;
  const rets: number[] = [];
  for (let k = i - lookback + 1; k <= i; k++) {
    const a = closes[k - 1]!;
    const b = closes[k]!;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  const m = mean(rets);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, rets.length));
  // crude percentile vs trailing 120
  const hist: number[] = [];
  for (let j = Math.max(lookback + 5, i - 120); j <= i; j++) {
    const slice: number[] = [];
    for (let k = j - lookback + 1; k <= j; k++) {
      const a = closes[k - 1]!;
      const b = closes[k]!;
      if (a > 0 && b > 0) slice.push(Math.log(b / a));
    }
    const mj = mean(slice);
    hist.push(Math.sqrt(slice.reduce((s, x) => s + (x - mj) ** 2, 0) / Math.max(1, slice.length)));
  }
  const below = hist.filter((h) => h <= sd).length;
  return (100 * below) / Math.max(1, hist.length);
}

function simulateTrade(args: {
  panel: Panel;
  entryIdx: number;
  holdBars: number;
  direction: Direction;
  carryDiffPct: number;
  variant: CmVariant;
  strong: Currency;
  weak: Currency;
}): TradeResult | null {
  const { panel, entryIdx, holdBars, direction, carryDiffPct, variant, strong, weak } = args;
  const exitIdx = entryIdx + holdBars;
  if (exitIdx >= panel.bars.length) return null;
  const e = panel.bars[entryIdx]!;
  const x = panel.bars[exitIdx]!;
  if (e.bidClose == null || e.askClose == null || x.bidClose == null || x.askClose == null) return null;

  const slip = SLIPPAGE_PIPS * pipSizeFor(panel.instrument);
  const entry = direction === "long" ? e.askClose + slip : e.bidClose - slip;
  const exitPx = direction === "long" ? x.bidClose - slip : x.askClose + slip;
  const gross =
    direction === "long" ? x.bidClose - e.askClose : e.bidClose - x.askClose;
  const spreadCost = e.askClose - e.bidClose + 2 * slip;
  const holdDays = holdBars / DECISION_EVERY_BARS;
  // Positive signedCarry = receive carry. Historical OANDA financing not in DB — estimate.
  const signedCarry = direction === "long" ? carryDiffPct : -carryDiffPct;
  const financingCashflow = signedCarry * (holdDays / 365) * FINANCING_SCALE * entry;
  const execNet = direction === "long" ? exitPx - entry : entry - exitPx;
  const netWithFin = execNet + financingCashflow;
  const atr = panel.atrs[entryIdx] || 1;

  return {
    instrument: panel.instrument,
    direction,
    entryTime: e.closeTime,
    exitTime: x.closeTime,
    holdBars,
    grossReturn: gross,
    spreadCost,
    financingCost: financingCashflow,
    slippageCost: 2 * slip,
    netReturn: netWithFin,
    netAtr: atr > 0 ? netWithFin / atr : 0,
    variant,
    strong,
    weak,
  };
}

export async function loadPanels(instruments: readonly string[]): Promise<Map<string, Panel>> {
  const out = new Map<string, Panel>();
  for (const instrument of instruments) {
    const [candles, quotes] = await Promise.all([
      loadCandles(instrument, PRIMARY_TIMEFRAME),
      loadQuotes(instrument, PRIMARY_TIMEFRAME),
    ]);
    if (candles.length < 500) {
      console.warn(`  skip ${instrument}: only ${candles.length} ${PRIMARY_TIMEFRAME} bars`);
      continue;
    }
    const aligned = alignQuotes(candles, quotes);
    const bars: PanelBar[] = aligned.map((c) => ({
      closeTime: c.closeTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      bidClose: c.quote?.bidClose ?? null,
      askClose: c.quote?.askClose ?? null,
    }));
    const closes = bars.map((b) => b.close);
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const atrs = closes.map((_, i) => atr14(highs, lows, closes, i));
    const timeIndex = new Map(bars.map((b, i) => [b.closeTime, i]));
    out.set(instrument, { instrument, bars, closes, highs, lows, atrs, timeIndex });
    console.log(`  loaded ${instrument}: ${bars.length} bars`);
  }
  return out;
}

/** Shared timeline: intersection of closeTimes across panels (hourly). */
function sharedTimeline(panels: Map<string, Panel>): string[] {
  let times: string[] | null = null;
  for (const p of panels.values()) {
    const t = p.bars.map((b) => b.closeTime);
    times = times == null ? t : times.filter((x) => p.timeIndex.has(x));
  }
  return times ?? [];
}

function ratesAt(yields: YieldObs[], asOf: string): Map<Currency, number> {
  const m = new Map<Currency, number>();
  for (const c of CURRENCIES) {
    const v = yieldAsOf(yields, c, asOf);
    if (v != null) m.set(c, v);
  }
  return m;
}

function carryScoreAt(
  yields: YieldObs[],
  asOf: string,
  mode: Hypothesis["carryMode"],
): Map<Currency, { level: number; chg5: number; chg20: number; score: number }> {
  const levels = ratesAt(yields, asOf);
  const out = new Map<Currency, { level: number; chg5: number; chg20: number; score: number }>();
  for (const c of CURRENCIES) {
    const level = levels.get(c) ?? NaN;
    const chg5 = yieldChange(yields, c, asOf, 5) ?? 0;
    const chg20 = yieldChange(yields, c, asOf, 20) ?? 0;
    let score = 0;
    if (mode === "level") score = level;
    else if (mode === "change") score = chg20 !== 0 ? chg20 : chg5;
    else score = (Number.isFinite(level) ? level : 0) + 2 * chg20;
    out.set(c, { level: Number.isFinite(level) ? level : 0, chg5, chg20, score: Number.isFinite(score) ? score : 0 });
  }
  return out;
}

function passesVariant(args: {
  variant: CmVariant;
  momFavors: boolean;
  carryFavors: boolean;
  pairCarryDiff: number;
  momSpread: number;
  volPct: number;
  riskOff: boolean;
  volFilterPct?: number;
}): boolean {
  const { variant, momFavors, carryFavors, pairCarryDiff, momSpread, volPct, riskOff, volFilterPct } = args;
  if (volFilterPct != null && volPct > volFilterPct) return false;
  if (riskOff) return false;

  switch (variant) {
    case "momentum_only":
      return momFavors && momSpread > 0;
    case "carry_only":
      return carryFavors && Math.abs(pairCarryDiff) > 0.05;
    case "full_agreement":
      return momFavors && carryFavors;
    case "mom_strong_carry_nonneg":
      return momFavors && (carryFavors || Math.abs(pairCarryDiff) < 0.15);
    case "carry_with_mom_confirm":
      return Math.abs(pairCarryDiff) > 0.3 && momFavors;
    case "mom_carry_50_50":
    case "mom_carry_70_30":
    case "mom_carry_30_70":
    case "mom_carry_vol_filter":
    case "mom_carry_riskoff_filter":
      return momFavors || carryFavors; // combined rank drives selection; soft filter
    default: {
      const _exhaustive: never = variant;
      return _exhaustive;
    }
  }
}

export function backtestHypothesis(args: {
  panels: Map<string, Panel>;
  yields: YieldObs[];
  hyp: Hypothesis;
  zone: "train" | "dev" | "sealed";
  instrumentFilter?: (inst: string) => boolean;
}): TradeResult[] {
  const { panels, yields, hyp, zone, instrumentFilter } = args;
  const instruments = [...panels.keys()].filter((i) => (instrumentFilter ? instrumentFilter(i) : true));
  if (instruments.length < 4) return [];

  const timeline = sharedTimeline(new Map(instruments.map((i) => [i, panels.get(i)!])));
  const lookbackBars = hyp.momDays * DECISION_EVERY_BARS;
  const holdBars = hyp.holdDays * DECISION_EVERY_BARS;
  const stride = holdBars; // purged: non-overlapping labels
  const trades: TradeResult[] = [];

  for (let ti = lookbackBars; ti < timeline.length - holdBars; ti += DECISION_EVERY_BARS) {
    const closeTime = timeline[ti]!;
    if (zoneOf(closeTime) !== zone) continue;

    // Align each instrument idx
    const idxs = new Map<string, number>();
    let ok = true;
    for (const inst of instruments) {
      const ix = panels.get(inst)!.timeIndex.get(closeTime);
      if (ix == null || ix < lookbackBars) {
        ok = false;
        break;
      }
      idxs.set(inst, ix);
    }
    if (!ok) continue;

    const volInst = instruments.includes("EUR_USD") ? "EUR_USD" : instruments[0]!;
    const volIdx = idxs.get(volInst)!;
    const volPct = realizedVolPct(panels.get(volInst)!.closes, volIdx);

    const momFixed = currencyMomentumAt(instruments, panels, closeTime, lookbackBars);

    const carry = carryScoreAt(yields, closeTime, hyp.carryMode);
    if ([...carry.values()].filter((c) => c.level !== 0 || c.score !== 0).length < 4) continue;

    const momMap = new Map<Currency, number>();
    const carryMap = new Map<Currency, number>();
    for (const c of CURRENCIES) {
      momMap.set(c, momFixed.get(c)?.score ?? 0);
      carryMap.set(c, carry.get(c)!.score);
    }
    const momZ = zscoreMap(momMap);
    const carryZ = zscoreMap(carryMap);
    const combined = new Map<Currency, number>();
    for (const c of CURRENCIES) {
      combined.set(c, hyp.momWeight * (momZ.get(c) ?? 0) + hyp.carryWeight * (carryZ.get(c) ?? 0));
    }

    const ranked = rankDescending(combined);
    // Risk-off: broad JPY + CHF strengthening (top-3 includes both)
    const momRanked = rankDescending(momMap);
    const riskOff =
      Boolean(hyp.riskOffFilter) &&
      (momRanked.slice(0, 3).includes("JPY") && momRanked.slice(0, 3).includes("CHF"));

    // Candidate edges: top vs bottom
    type Cand = {
      instrument: string;
      direction: Direction;
      strong: Currency;
      weak: Currency;
      score: number;
      momSpread: number;
      pairCarryDiff: number;
    };
    const cands: Cand[] = [];
    const tops = ranked.slice(0, 2);
    const bottoms = ranked.slice(-2);
    for (const strong of tops) {
      for (const weak of bottoms) {
        const mapped = pairFromCurrencies(strong, weak, instruments);
        if (!mapped) continue;
        const rates = new Map<Currency, number>();
        for (const c of CURRENCIES) rates.set(c, carry.get(c)!.level);
        const pairCarryDiff = pairCarryDifferential(mapped.instrument, rates);
        if (pairCarryDiff == null) continue;
        const momSpread = (momMap.get(strong) ?? 0) - (momMap.get(weak) ?? 0);
        const momFavors = momentumFavorsTrade(momMap.get(strong) ?? 0, momMap.get(weak) ?? 0);
        const carryFavors = carryFavorsDirection(pairCarryDiff, mapped.direction);
        if (
          !passesVariant({
            variant: hyp.variant,
            momFavors,
            carryFavors,
            pairCarryDiff,
            momSpread,
            volPct,
            riskOff,
            volFilterPct: hyp.volFilterPct,
          })
        ) {
          continue;
        }
        const score = (combined.get(strong) ?? 0) - (combined.get(weak) ?? 0);
        if (score < 0.15 && hyp.variant !== "momentum_only" && hyp.variant !== "carry_only") continue;
        cands.push({
          instrument: mapped.instrument,
          direction: mapped.direction,
          strong,
          weak,
          score,
          momSpread,
          pairCarryDiff,
        });
      }
    }

    cands.sort((a, b) => b.score - a.score);
    const picked: Cand[] = [];
    const maxPer = 2;
    for (const c of cands) {
      if (picked.length >= (hyp.topK ?? 2)) break;
      if (wouldBreachExposure(picked, c, maxPer)) continue;
      picked.push(c);
    }

    for (const c of picked) {
      const panel = panels.get(c.instrument)!;
      const entryIdx = panel.timeIndex.get(closeTime);
      if (entryIdx == null) continue;
      const tr = simulateTrade({
        panel,
        entryIdx,
        holdBars,
        direction: c.direction,
        carryDiffPct: c.pairCarryDiff,
        variant: hyp.variant,
        strong: c.strong,
        weak: c.weak,
      });
      if (tr) trades.push(tr);
    }

    // Advance timeline by stride in decision space — already stepping by DECISION_EVERY_BARS;
    // for purged independence, skip extra after taking trades
    if (picked.length > 0) {
      ti += stride - DECISION_EVERY_BARS;
    }
  }

  return trades;
}

function currencyMomentumAt(
  instruments: string[],
  panels: Map<string, Panel>,
  closeTime: string,
  lookbackBars: number,
): Map<Currency, { score: number; n: number }> {
  const acc = new Map<Currency, { sum: number; n: number }>();
  for (const c of CURRENCIES) acc.set(c, { sum: 0, n: 0 });

  for (const inst of instruments) {
    const p = panels.get(inst)!;
    const idx = p.timeIndex.get(closeTime);
    if (idx == null || idx < lookbackBars) continue;
    const c0 = p.closes[idx - lookbackBars]!;
    const c1 = p.closes[idx]!;
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const atr = p.atrs[idx];
    const r = atr && atr > 0 ? (c1 - c0) / atr : Math.log(c1 / c0);
    const { base, quote } = splitPair(inst);
    const b = acc.get(base)!;
    const q = acc.get(quote)!;
    b.sum += r;
    b.n += 1;
    q.sum -= r;
    q.n += 1;
  }

  const out = new Map<Currency, { score: number; n: number }>();
  for (const c of CURRENCIES) {
    const a = acc.get(c)!;
    out.set(c, { score: a.n > 0 ? a.sum / a.n : 0, n: a.n });
  }
  return out;
}

function summarize(trades: TradeResult[], hyp: Hypothesis, status: CmExperiment["status"], reason: string, sealedTouched: boolean): CmExperiment {
  const nets = trades.map((t) => t.netAtr); // ATR-normalized for cross-pair fairness
  const ci = meanCi95(nets);
  const byPair: Record<string, { n: number; net: number }> = {};
  const byYear: Record<string, { n: number; net: number }> = {};
  for (const t of trades) {
    const p = byPair[t.instrument] ?? { n: 0, net: 0 };
    p.n += 1;
    p.net += t.netAtr;
    byPair[t.instrument] = p;
    const y = t.entryTime.slice(0, 4);
    const yr = byYear[y] ?? { n: 0, net: 0 };
    yr.n += 1;
    yr.net += t.netAtr;
    byYear[y] = yr;
  }
  for (const k of Object.keys(byPair)) {
    byPair[k]!.net /= Math.max(1, byPair[k]!.n);
  }
  for (const k of Object.keys(byYear)) {
    byYear[k]!.net /= Math.max(1, byYear[k]!.n);
  }
  const longs = trades.filter((t) => t.direction === "long");
  const shorts = trades.filter((t) => t.direction === "short");

  return {
    experimentId: `cm-${hyp.id}-${Date.now().toString(36)}`,
    wave: WAVE_ID,
    timestamp: new Date().toISOString(),
    hypothesis: hyp.hypothesis,
    hypothesisId: hyp.id,
    strategyVersion: STRATEGY_VERSION,
    variant: hyp.variant,
    momentumLookbackBars: hyp.momDays * DECISION_EVERY_BARS,
    carryMode: hyp.carryMode,
    yieldSource: "fred:DGS2+OECD_IRLTLT01*",
    timeframe: PRIMARY_TIMEFRAME,
    holdBars: hyp.holdDays * DECISION_EVERY_BARS,
    stride: hyp.holdDays * DECISION_EVERY_BARS,
    pairUniverse: [...PAIR_UNIVERSE],
    train: { start: ZONES.trainStart, end: ZONES.trainEnd },
    dev: { start: ZONES.devStart, end: ZONES.devEnd },
    sealed: { start: ZONES.sealedStart, end: ZONES.sealedEnd },
    n: trades.length,
    independentN: trades.length, // already purged via stride
    winRate: trades.length ? trades.filter((t) => t.netAtr > 0).length / trades.length : 0,
    grossExpectancy: mean(trades.map((t) => t.grossReturn)),
    netExpectancy: ci.mean,
    ci95Low: ci.low,
    ci95High: ci.high,
    profitFactor: profitFactor(nets),
    maxDrawdown: maxDrawdown(nets),
    totalNet: nets.reduce((a, b) => a + b, 0),
    avgSpread: mean(trades.map((t) => t.spreadCost)),
    avgFinancing: mean(trades.map((t) => t.financingCost)),
    byPair,
    byYear,
    longN: longs.length,
    shortN: shorts.length,
    longNet: mean(longs.map((t) => t.netAtr)),
    shortNet: mean(shorts.map((t) => t.netAtr)),
    status,
    reason,
    sealedTouched,
  };
}

function concentrationOk(trades: TradeResult[]): { ok: boolean; reason: string } {
  if (trades.length === 0) return { ok: false, reason: "empty" };
  const totalPos = trades.reduce((s, t) => s + Math.max(0, t.netAtr), 0);
  if (totalPos <= 0) return { ok: true, reason: "no_positive_mass" };
  const sorted = [...trades].sort((a, b) => b.netAtr - a.netAtr);
  const top5 = sorted.slice(0, 5).reduce((s, t) => s + Math.max(0, t.netAtr), 0);
  if (top5 / totalPos > 0.65) return { ok: false, reason: "top5_dominate" };
  const byPair = new Map<string, number>();
  for (const t of trades) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netAtr);
  const profits = [...byPair.values()].filter((v) => v > 0);
  const sum = profits.reduce((a, b) => a + b, 0) || 1;
  if (Math.max(0, ...profits) / sum > 0.85 && byPair.size > 1) return { ok: false, reason: "single_pair_dominates" };
  const byYear = new Map<string, number>();
  for (const t of trades) byYear.set(t.entryTime.slice(0, 4), (byYear.get(t.entryTime.slice(0, 4)) ?? 0) + t.netAtr);
  const yProf = [...byYear.values()].filter((v) => v > 0);
  const ySum = yProf.reduce((a, b) => a + b, 0) || 1;
  if (byYear.size > 1 && Math.max(0, ...yProf) / ySum > 0.9) return { ok: false, reason: "single_year_dominates" };
  return { ok: true, reason: "ok" };
}

export function evaluateDev(trades: TradeResult[], hyp: Hypothesis): CmExperiment {
  if (trades.length < EDGE.minIndependentN) {
    return summarize(trades, hyp, "dev_reject", `independent_n=${trades.length}<${EDGE.minIndependentN}`, false);
  }
  const ci = meanCi95(trades.map((t) => t.netAtr));
  if (!(ci.mean > 0)) {
    return summarize(trades, hyp, "dev_reject", `net_expectancy=${ci.mean.toFixed(4)}<=0`, false);
  }
  const conc = concentrationOk(trades);
  if (!conc.ok) return summarize(trades, hyp, "dev_reject", conc.reason, false);
  if (ci.low <= 0) {
    return summarize(trades, hyp, "dev_reject", `dev_ci_includes_zero [${ci.low.toFixed(4)},${ci.high.toFixed(4)}]`, false);
  }
  return summarize(trades, hyp, "sealed_pass", "dev_gate_pass_pending_sealed", false);
}

export function evaluateSealed(trades: TradeResult[], hyp: Hypothesis): CmExperiment {
  if (trades.length < EDGE.sealedMinN) {
    return summarize(trades, hyp, "sealed_fail", `sealed_n=${trades.length}<${EDGE.sealedMinN}`, true);
  }
  const ci = meanCi95(trades.map((t) => t.netAtr));
  if (!(ci.low > 0)) {
    return summarize(trades, hyp, "sealed_fail", `sealed_ci_not_gt_0 [${ci.low.toFixed(4)},${ci.high.toFixed(4)}]`, true);
  }
  const pf = profitFactor(trades.map((t) => t.netAtr));
  if (pf < EDGE.sealedMinPf) {
    return summarize(trades, hyp, "sealed_fail", `pf=${pf.toFixed(3)}<${EDGE.sealedMinPf}`, true);
  }
  const conc = concentrationOk(trades);
  if (!conc.ok) return summarize(trades, hyp, "robustness_reject", `sealed_${conc.reason}`, true);
  return summarize(trades, hyp, "sealed_pass", "sealed_ci_gt_0", true);
}

export function robustnessAudit(trades: TradeResult[]): { ok: boolean; details: Record<string, unknown> } {
  const base = meanCi95(trades.map((t) => t.netAtr));
  const cost25 = meanCi95(trades.map((t) => t.netAtr - 0.25 * (t.spreadCost / Math.max(1e-9, Math.abs(t.netReturn) || 1) * Math.abs(t.netAtr))));
  // Simpler stress: shrink netAtr by cost multiples via reducing each trade
  const stress = (mult: number) =>
    meanCi95(
      trades.map((t) => {
        const atr = Math.abs(t.netReturn) > 1e-12 ? t.netAtr / t.netReturn : 0;
        return t.netAtr - mult * t.spreadCost * atr;
      }),
    );

  const dropBestPair = () => {
    const byPair = new Map<string, number>();
    for (const t of trades) byPair.set(t.instrument, (byPair.get(t.instrument) ?? 0) + t.netAtr);
    let best = "";
    let bestV = -Infinity;
    for (const [k, v] of byPair) if (v > bestV) { best = k; bestV = v; }
    return meanCi95(trades.filter((t) => t.instrument !== best).map((t) => t.netAtr));
  };

  const dropBestMonth = () => {
    const byM = new Map<string, number>();
    for (const t of trades) {
      const m = t.entryTime.slice(0, 7);
      byM.set(m, (byM.get(m) ?? 0) + t.netAtr);
    }
    let best = "";
    let bestV = -Infinity;
    for (const [k, v] of byM) if (v > bestV) { best = k; bestV = v; }
    return meanCi95(trades.filter((t) => t.entryTime.slice(0, 7) !== best).map((t) => t.netAtr));
  };

  const dropTopN = (n: number) => {
    const sorted = [...trades].sort((a, b) => b.netAtr - a.netAtr);
    const drop = new Set(sorted.slice(0, n));
    return meanCi95(trades.filter((t) => !drop.has(t)).map((t) => t.netAtr));
  };

  const longs = trades.filter((t) => t.direction === "long");
  const shorts = trades.filter((t) => t.direction === "short");

  const s25 = stress(0.25);
  const s50 = stress(0.5);
  const dbp = dropBestPair();
  const dbm = dropBestMonth();
  const d5 = dropTopN(5);
  const d10 = dropTopN(10);
  const L = meanCi95(longs.map((t) => t.netAtr));
  const S = meanCi95(shorts.map((t) => t.netAtr));

  const details = {
    base,
    cost25: s25,
    cost50: s50,
    dropBestPair: dbp,
    dropBestMonth: dbm,
    dropTop5: d5,
    dropTop10: d10,
    long: L,
    short: S,
    dummyCost25: cost25,
  };

  const ok =
    s25.low > 0 &&
    s50.mean > 0 &&
    dbp.mean > 0 &&
    dbm.mean > 0 &&
    d5.mean > 0 &&
    (longs.length < 15 || L.mean > 0) &&
    (shorts.length < 15 || S.mean > 0);

  return { ok, details };
}

export { loadYields };
