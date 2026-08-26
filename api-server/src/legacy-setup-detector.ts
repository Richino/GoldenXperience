/**
 * Legacy 10-gate EMA-pullback setup detector.
 *
 * Extracted from scripts/_backtest_legacy_expanded.ts so the live daemon and
 * the backtest evaluate the same recipe. Any change here should be paired with
 * a backtest re-run.
 *
 * Recipe (in order):
 *   1) EMA21/50/200 stack aligned on M15 (long: 21>50>200; short: reversed)
 *   2) H1 EMA21/50 agrees with M15 direction
 *   3) H4 EMA21/50 does not oppose (matches or is neutral)
 *   4) Pullback: close inside the [min(EMA21,EMA50) - 0.35*ATR14, max + 0.35*ATR14] zone,
 *      with EMA200 not lost (close on trend side of EMA200)
 *   5) Market-structure break: close beyond recent 5-bar high (long) / low (short)
 *   6) Confirmation candle: last bar body engulfs prior body & closes in direction
 *   7) RSI14 in trend-supporting band (long 45..70, short 30..55)
 *   8) ATR14 sufficient (>= 5 pips)
 *   9) Session = London (03-08 ET) or London/NY overlap (08-12 ET)
 *  10) Spread cap: askClose - bidClose <= spreadCap(pair) at signal bar
 *
 * Stop = 10-bar structural swing; Target = entry +/- 1.5 * risk.
 * Entry fill: ask (long) / bid (short) at signal bar close.
 */

export type LegacyCandle = {
  closeTime: string;
  open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export function pipSize(inst: string): number {
  if (inst === "XAU_USD") return 0.1;
  return inst.endsWith("JPY") ? 0.01 : 0.0001;
}

export function spreadCap(inst: string): number {
  if (inst === "XAU_USD") return 30;
  if (inst.includes("JPY") && !inst.startsWith("USD_JPY")) return 4;
  return 3;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = []; if (!values.length) return out;
  const k = 2 / (period + 1);
  let e = values[0]!; out.push(e);
  for (let i = 1; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}

export function atr(bars: LegacyCandle[], period: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN);
  const trs: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i === 0) { trs[i] = b.high - b.low; continue; }
    const p = bars[i - 1]!;
    trs[i] = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  let sum = 0;
  for (let i = 0; i < period && i < trs.length; i++) sum += trs[i]!;
  if (trs.length >= period) {
    let a = sum / period;
    out[period - 1] = a;
    for (let i = period; i < trs.length; i++) { a = (a * (period - 1) + trs[i]!) / period; out[i] = a; }
  }
  return out;
}

export function rsi(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const up = d > 0 ? d : 0; const dn = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + dn) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function etHour(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}

export function inLegacySession(iso: string): boolean {
  const h = etHour(iso);
  return h >= 3 && h < 12;
}

function htfBias(closeTime: string, bars: LegacyCandle[], e21: number[], e50: number[]): -1 | 0 | 1 {
  const t = Date.parse(closeTime);
  let lo = 0, hi = bars.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (Date.parse(bars[m]!.closeTime) <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return 0;
  const a = e21[k]; const b = e50[k];
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const spread = Math.abs(a - b) / (bars[k]!.close || 1);
  if (spread < 1e-5) return 0;
  return a > b ? 1 : -1;
}

export type LegacyRejection = {
  passed: false;
  reason: string;
};

export type LegacySetup = {
  passed: true;
  pair: string;
  decisionTime: string;
  direction: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  riskPrice: number;
  riskPips: number;
  targetPips: number;
  atrPips: number;
  rsi14: number;
  spreadPips: number;
  hourEt: number;
  gatesPassed: string[];
};

export type LegacyResult = LegacySetup | LegacyRejection;

/**
 * Evaluate whether the current M15/H1/H4 state produces a legacy setup at
 * the last completed M15 bar for `pair`. Returns either a full setup or a
 * rejection with the first failing gate.
 */
export function evaluateLegacySetup(
  pair: string,
  m15: LegacyCandle[],
  h1: LegacyCandle[],
  h4: LegacyCandle[],
): LegacyResult {
  if (m15.length < 210) return { passed: false, reason: "insufficient M15 history (<210 bars)" };
  const i = m15.length - 1;
  const bar = m15[i]!;

  // 1) EMA stack on M15
  const closes15 = m15.map((b) => b.close);
  const e21 = ema(closes15, 21);
  const e50 = ema(closes15, 50);
  const e200 = ema(closes15, 200);
  const f21 = e21[i]!, f50 = e50[i]!, f200 = e200[i]!;
  const bullish = f21 > f50 && f50 > f200;
  const bearish = f21 < f50 && f50 < f200;
  const dir: "long" | "short" | null = bullish ? "long" : bearish ? "short" : null;
  if (!dir) return { passed: false, reason: "M15 EMA21/50/200 stack not aligned" };

  // 2, 3) HTF alignment
  const h1_e21 = ema(h1.map((b) => b.close), 21);
  const h1_e50 = ema(h1.map((b) => b.close), 50);
  const h4_e21 = ema(h4.map((b) => b.close), 21);
  const h4_e50 = ema(h4.map((b) => b.close), 50);
  const h1b = htfBias(bar.closeTime, h1, h1_e21, h1_e50);
  const h4b = htfBias(bar.closeTime, h4, h4_e21, h4_e50);
  const need = dir === "long" ? 1 : -1;
  if (h1b !== need) return { passed: false, reason: "H1 EMA21/50 does not agree with M15 direction" };
  if (h4b === -need) return { passed: false, reason: "H4 EMA21/50 opposes M15 direction" };

  // 4) Pullback into EMA21/50 zone, EMA200 intact
  const a14 = atr(m15, 14);
  const atrV = a14[i]!;
  if (!Number.isFinite(atrV) || atrV <= 0) return { passed: false, reason: "ATR14 unavailable" };
  const zoneLo = Math.min(f21, f50) - 0.35 * atrV;
  const zoneHi = Math.max(f21, f50) + 0.35 * atrV;
  const inZone = bar.low <= zoneHi && bar.high >= zoneLo;
  const structIntact = dir === "long" ? bar.low > f200 : bar.high < f200;
  if (!inZone) return { passed: false, reason: "Price did not pull into EMA21/50 zone" };
  if (!structIntact) return { passed: false, reason: "EMA200 structure broken" };

  // 5) Market-structure break of last 5 bars
  const winStart = Math.max(0, i - 5);
  const prevHi = Math.max(...m15.slice(winStart, i).map((b) => b.high));
  const prevLo = Math.min(...m15.slice(winStart, i).map((b) => b.low));
  const structBreak = dir === "long" ? bar.close > prevHi : bar.close < prevLo;
  if (!structBreak) return { passed: false, reason: "No 5-bar structural break in direction" };

  // 6) Confirmation candle
  const prev = m15[i - 1]!;
  const bodyNow = Math.abs(bar.close - bar.open);
  const bodyPrev = Math.abs(prev.close - prev.open);
  const closedDir = dir === "long" ? bar.close > bar.open : bar.close < bar.open;
  const engulfs = bodyNow >= bodyPrev
    && Math.min(bar.open, bar.close) <= Math.min(prev.open, prev.close)
    && Math.max(bar.open, bar.close) >= Math.max(prev.open, prev.close);
  if (!closedDir) return { passed: false, reason: "Confirmation candle did not close in direction" };
  if (!engulfs) return { passed: false, reason: "Confirmation candle did not engulf prior body" };

  // 7) RSI in trend-supporting band
  const r14 = rsi(closes15, 14);
  const rv = r14[i];
  if (rv === undefined || !Number.isFinite(rv)) return { passed: false, reason: "RSI14 unavailable" };
  if (dir === "long" && !(rv >= 45 && rv <= 70)) return { passed: false, reason: `RSI14 ${rv.toFixed(1)} outside long band [45,70]` };
  if (dir === "short" && !(rv >= 30 && rv <= 55)) return { passed: false, reason: `RSI14 ${rv.toFixed(1)} outside short band [30,55]` };

  // 8) Volatility floor
  const pip = pipSize(pair);
  const atrPips = atrV / pip;
  if (atrPips < 5) return { passed: false, reason: `ATR ${atrPips.toFixed(1)} pips < 5 pip floor` };

  // 9) Session
  if (!inLegacySession(bar.closeTime)) return { passed: false, reason: "Outside London / London-NY overlap sessions" };

  // 10) Spread cap
  const spreadPips = (bar.askClose - bar.bidClose) / pip;
  const spreadMax = spreadCap(pair);
  if (!Number.isFinite(spreadPips) || spreadPips > spreadMax) {
    return { passed: false, reason: `Spread ${spreadPips.toFixed(1)} > ${spreadMax} pip cap` };
  }

  // Build trade geometry — 10-bar structural swing stop, 1.5R target
  const swWin = m15.slice(Math.max(0, i - 10), i + 1);
  const rawStop = dir === "long" ? Math.min(...swWin.map((b) => b.low)) : Math.max(...swWin.map((b) => b.high));
  const entry = dir === "long" ? bar.askClose : bar.bidClose;
  const risk = Math.abs(entry - rawStop);
  if (risk <= 0 || risk / entry < 1e-6) return { passed: false, reason: "Degenerate stop distance" };
  const target = dir === "long" ? entry + 1.5 * risk : entry - 1.5 * risk;

  return {
    passed: true,
    pair,
    decisionTime: bar.closeTime,
    direction: dir,
    entry,
    stop: rawStop,
    target,
    riskPrice: risk,
    riskPips: risk / pip,
    targetPips: (1.5 * risk) / pip,
    atrPips,
    rsi14: rv,
    spreadPips,
    hourEt: etHour(bar.closeTime),
    gatesPassed: ["ema-stack", "h1-align", "h4-not-oppose", "pullback-zone", "structure-break", "engulfing", "rsi-band", "atr-floor", "session", "spread-cap"],
  };
}
