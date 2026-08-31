/**
 * h1-direction-v1 — metrics, horizon evaluation, trading simulation.
 */
import type { Bar, Instrument } from "./data.js";
import { H1_MS, pipSizeFor } from "./data.js";
import type { MarketRegime, SignalDirection } from "./model.js";
import { pairLabel } from "./model.js";

export const HORIZONS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export type Horizon = (typeof HORIZONS)[number];
export type HorizonResult = "WIN" | "LOSS" | "TIE" | "NA";

export function wilsonInterval(wins: number, n: number, z = 1.96): { lower: number; upper: number; center: number } {
  if (!n) return { lower: 0, upper: 0, center: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lower: (center - margin) / denom, upper: (center + margin) / denom, center: p };
}

export function wilsonLower(wins: number, n: number): number {
  return wilsonInterval(wins, n).lower;
}

export type CountResult = {
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
};

export function summarizeResults(results: HorizonResult[]): CountResult {
  const decided = results.filter((r) => r !== "NA");
  const wins = decided.filter((r) => r === "WIN").length;
  const losses = decided.filter((r) => r === "LOSS").length;
  const ties = decided.filter((r) => r === "TIE").length;
  const n = wins + losses + ties;
  const ci = wilsonInterval(wins, n);
  return {
    signals: n,
    wins,
    losses,
    ties,
    winRate: n ? wins / n : 0,
    ciLower: ci.lower,
    ciUpper: ci.upper,
  };
}

export function forwardResult(direction: SignalDirection, entry: number, future: number): HorizonResult {
  if (direction === "WAIT" || !Number.isFinite(future)) return "NA";
  if (future === entry) return "TIE";
  if (direction === "LONG") return future > entry ? "WIN" : "LOSS";
  return future < entry ? "WIN" : "LOSS";
}

export type SignalRecord = {
  timestamp: string;
  pair: Instrument;
  pairLabel: string;
  barIndex: number;
  direction: SignalDirection;
  directionScore: number;
  marketRegime: MarketRegime;
  entryPrice: number;
  ema20: number;
  ema50: number;
  ema200: number;
  ema20Slope: number;
  ema50Slope: number;
  ema200Slope: number;
  rsi: number;
  macd: number;
  atr: number;
  structureClassification: string;
  momentumClassification: string;
  volatilityClassification: string;
  forwardPrices: Record<Horizon, number | null>;
  horizonResults: Record<Horizon, HorizonResult>;
  spreadPips: number;
  breakdown: Record<string, number>;
  trading?: Record<string, TradeSimOutcome>;
};

export type TradeSimOutcome = {
  rr: string;
  gross: "WIN" | "LOSS" | "AMBIGUOUS" | "OPEN";
  net: "WIN" | "LOSS" | "AMBIGUOUS" | "OPEN";
  rGross: number;
  rNet: number;
  barsHeld: number;
};

const RR_CONFIGS = [
  { label: "1:1", tpMult: 1 },
  { label: "1.5:1", tpMult: 1.5 },
  { label: "2:1", tpMult: 2 },
] as const;

export function simulateTrade(
  bars: Bar[], startIndex: number, direction: SignalDirection, atr: number,
  tpMult: number, maxBars: number, spreadPips: number, pair: Instrument,
): TradeSimOutcome {
  if (direction === "WAIT" || atr <= 0) {
    return { rr: `${tpMult}:1`, gross: "OPEN", net: "OPEN", rGross: 0, rNet: 0, barsHeld: 0 };
  }
  const slDist = atr;
  const tpDist = atr * tpMult;
  const entry = bars[startIndex]!.close;
  const pip = pipSizeFor(pair);
  const costR = (spreadPips * pip) / slDist;

  for (let h = 1; h <= maxBars && startIndex + h < bars.length; h++) {
    const bar = bars[startIndex + h]!;
    if (direction === "LONG") {
      const hitSl = bar.low <= entry - slDist;
      const hitTp = bar.high >= entry + tpDist;
      if (hitSl && hitTp) return { rr: `${tpMult}:1`, gross: "AMBIGUOUS", net: "AMBIGUOUS", rGross: -1, rNet: -1 - costR, barsHeld: h };
      if (hitSl) return { rr: `${tpMult}:1`, gross: "LOSS", net: "LOSS", rGross: -1, rNet: -1 - costR, barsHeld: h };
      if (hitTp) return { rr: `${tpMult}:1`, gross: "WIN", net: "WIN", rGross: tpMult, rNet: tpMult - costR, barsHeld: h };
    } else {
      const hitSl = bar.high >= entry + slDist;
      const hitTp = bar.low <= entry - tpDist;
      if (hitSl && hitTp) return { rr: `${tpMult}:1`, gross: "AMBIGUOUS", net: "AMBIGUOUS", rGross: -1, rNet: -1 - costR, barsHeld: h };
      if (hitSl) return { rr: `${tpMult}:1`, gross: "LOSS", net: "LOSS", rGross: -1, rNet: -1 - costR, barsHeld: h };
      if (hitTp) return { rr: `${tpMult}:1`, gross: "WIN", net: "WIN", rGross: tpMult, rNet: tpMult - costR, barsHeld: h };
    }
  }
  return { rr: `${tpMult}:1`, gross: "OPEN", net: "OPEN", rGross: 0, rNet: 0, barsHeld: maxBars };
}

export function attachTradingSim(sig: SignalRecord, bars: Bar[]): void {
  sig.trading = {};
  for (const cfg of RR_CONFIGS) {
    const key = cfg.label;
    sig.trading[key] = simulateTrade(bars, sig.barIndex, sig.direction, sig.atr, cfg.tpMult, 48, sig.spreadPips, sig.pair);
  }
}

export type TradingSummary = {
  rr: string;
  mode: "GROSS" | "NET";
  trades: number;
  wins: number;
  losses: number;
  ambiguous: number;
  open: number;
  winRate: number;
  totalR: number;
  expectancy: number;
  profitFactor: number;
};

export function summarizeTrading(signals: SignalRecord[], rr: string, mode: "GROSS" | "NET"): TradingSummary {
  const trades = signals.filter((s) => s.direction !== "WAIT" && s.trading?.[rr]);
  let wins = 0, losses = 0, ambiguous = 0, open = 0, totalR = 0, grossWin = 0, grossLoss = 0;
  for (const s of trades) {
    const t = s.trading![rr]!;
    const cls = mode === "GROSS" ? t.gross : t.net;
    const r = mode === "GROSS" ? t.rGross : t.rNet;
    if (cls === "WIN") { wins++; if (r > 0) grossWin += r; else grossLoss -= r; }
    else if (cls === "LOSS") { losses++; grossLoss += Math.abs(r); }
    else if (cls === "AMBIGUOUS") ambiguous++;
    else open++;
    totalR += r;
  }
  const decided = wins + losses;
  return {
    rr,
    mode,
    trades: trades.length,
    wins,
    losses,
    ambiguous,
    open,
    winRate: decided ? wins / decided : 0,
    totalR,
    expectancy: trades.length ? totalR / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
  };
}

export function formatPct(x: number, digits = 2): string {
  return (x * 100).toFixed(digits) + "%";
}

export function formatPairTable(rows: Array<{ pair: Instrument } & CountResult>): string {
  const lines = ["| Pair | Signals | Wins | Losses | Ties | WR |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const r of rows) {
    lines.push(`| ${pairLabel(r.pair)} | ${r.signals} | ${r.wins} | ${r.losses} | ${r.ties} | ${formatPct(r.winRate)} |`);
  }
  return lines.join("\n");
}

export function quarterKey(iso: string): string {
  const d = new Date(iso);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

export function yearKey(iso: string): string {
  return iso.slice(0, 4);
}

export function expectedH1Bars(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / H1_MS) + 1;
}
