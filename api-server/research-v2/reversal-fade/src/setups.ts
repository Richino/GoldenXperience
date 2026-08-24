import { BREAKOUT_LOOKBACK, SWING_K_H1, SWING_K_H4, VOL_LOOKBACK } from "./config.js";
import { volBucketAt, type Panel } from "./panels.js";
import type { Direction, SetupKind, Signal } from "./types.js";

function impulseDir(move: number): Direction | null {
  if (move > 0) return "long";
  if (move < 0) return "short";
  return null;
}

function push(
  out: Signal[],
  panel: Panel,
  i: number,
  kind: SetupKind,
  param: string,
  dir: Direction,
  extensionAtr: number,
): void {
  const b = panel.bars[i]!;
  if (!(b.atr > 0)) return;
  out.push({
    instrument: panel.instrument,
    timeframe: panel.timeframe,
    idx: i,
    closeTime: b.closeTime,
    ts: b.ts,
    kind,
    param,
    impulseDir: dir,
    extensionAtr,
    session: b.session,
    volBucket: volBucketAt(panel.bars, i, VOL_LOOKBACK),
  });
}

/** 1-bar close-to-close / ATR. ATR and closes are from completed bar i only. */
export function detectImpulse1(panel: Panel): Signal[] {
  const out: Signal[] = [];
  const { bars } = panel;
  for (let i = 20; i < bars.length; i++) {
    const atr = bars[i]!.atr;
    const prev = bars[i - 1]!.close;
    if (!(atr > 0) || !(prev > 0)) continue;
    const move = (bars[i]!.close - prev) / atr;
    const dir = impulseDir(move);
    if (!dir) continue;
    const ext = Math.abs(move);
    if (ext >= 0.2) push(out, panel, i, "impulse_1bar", "raw", dir, ext);
  }
  return out;
}

/** Multi-bar impulse: H1=4 bars (~session chunk), H4=3 bars. */
export function detectImpulseMulti(panel: Panel): Signal[] {
  const L = panel.timeframe === "H4" ? 3 : 4;
  const out: Signal[] = [];
  const { bars } = panel;
  for (let i = 20 + L; i < bars.length; i++) {
    const atr = bars[i]!.atr;
    const prev = bars[i - L]!.close;
    if (!(atr > 0) || !(prev > 0)) continue;
    const move = (bars[i]!.close - prev) / atr;
    const dir = impulseDir(move);
    if (!dir) continue;
    const ext = Math.abs(move);
    if (ext >= 0.2) push(out, panel, i, "impulse_multibar", `L=${L}`, dir, ext);
  }
  return out;
}

/**
 * 20-bar breakout using ONLY bars [i-20, i-1] for the level.
 * Bar i close vs that predetermined high/low — no intra-bar lookahead of bar i's high as the level.
 */
export function detectBreak20(panel: Panel): Signal[] {
  const out: Signal[] = [];
  const { bars } = panel;
  const lb = BREAKOUT_LOOKBACK;
  for (let i = lb + 2; i < bars.length; i++) {
    let priorHigh = -Infinity;
    let priorLow = Infinity;
    for (let k = i - lb; k < i; k++) {
      priorHigh = Math.max(priorHigh, bars[k]!.high);
      priorLow = Math.min(priorLow, bars[k]!.low);
    }
    const atr = bars[i]!.atr;
    const close = bars[i]!.close;
    if (!(atr > 0)) continue;
    if (close > priorHigh) {
      push(out, panel, i, "break20", "n=20", "long", (close - priorHigh) / atr);
    }
    if (close < priorLow) {
      push(out, panel, i, "break20", "n=20", "short", (priorLow - close) / atr);
    }
  }
  return out;
}

function isSwingHigh(bars: Panel["bars"], p: number, k: number): boolean {
  if (p < k || p + k >= bars.length) return false;
  const h = bars[p]!.high;
  for (let j = 1; j <= k; j++) {
    if (bars[p - j]!.high >= h) return false;
    if (bars[p + j]!.high >= h) return false;
  }
  return true;
}

function isSwingLow(bars: Panel["bars"], p: number, k: number): boolean {
  if (p < k || p + k >= bars.length) return false;
  const l = bars[p]!.low;
  for (let j = 1; j <= k; j++) {
    if (bars[p - j]!.low <= l) return false;
    if (bars[p + j]!.low <= l) return false;
  }
  return true;
}

/**
 * Structure-extension: swing confirmed only after k bars on the right.
 * At bar i, pivot p = i-k is newly confirmed. Extension uses close[i] vs that pivot.
 */
export function detectStructure(panel: Panel): Signal[] {
  const k = panel.timeframe === "H4" ? SWING_K_H4 : SWING_K_H1;
  const out: Signal[] = [];
  const { bars } = panel;
  for (let i = k * 2 + 5; i < bars.length; i++) {
    const p = i - k;
    const atr = bars[i]!.atr;
    if (!(atr > 0)) continue;
    if (isSwingHigh(bars, p, k)) {
      const ext = (bars[i]!.close - bars[p]!.high) / atr;
      if (ext >= 0.25) push(out, panel, i, "structure", `k=${k}`, "long", ext);
    }
    if (isSwingLow(bars, p, k)) {
      const ext = (bars[p]!.low - bars[i]!.close) / atr;
      if (ext >= 0.25) push(out, panel, i, "structure", `k=${k}`, "short", ext);
    }
  }
  return out;
}

/**
 * Momentum exhaustion: consecutive same-direction closes + cumulative ATR move + wide body.
 */
export function detectMomentum(panel: Panel): Signal[] {
  const out: Signal[] = [];
  const { bars } = panel;
  const specs = panel.timeframe === "H4"
    ? [{ run: 3, cum: 0.75 }, { run: 4, cum: 1.0 }]
    : [{ run: 4, cum: 0.75 }, { run: 6, cum: 1.0 }];

  for (let i = 30; i < bars.length; i++) {
    const atr = bars[i]!.atr;
    if (!(atr > 0)) continue;
    const range = bars[i]!.high - bars[i]!.low;
    const body = Math.abs(bars[i]!.close - bars[i]!.open);
    const bodyFrac = range > 0 ? body / range : 0;

    let upRun = 0;
    let upCum = 0;
    for (let j = i; j > 0; j--) {
      if (bars[j]!.close <= bars[j - 1]!.close) break;
      upRun += 1;
      upCum += (bars[j]!.close - bars[j - 1]!.close) / atr;
    }
    let dnRun = 0;
    let dnCum = 0;
    for (let j = i; j > 0; j--) {
      if (bars[j]!.close >= bars[j - 1]!.close) break;
      dnRun += 1;
      dnCum += (bars[j - 1]!.close - bars[j]!.close) / atr;
    }

    for (const s of specs) {
      if (upRun >= s.run && upCum >= s.cum && bodyFrac >= 0.5) {
        push(out, panel, i, "momentum", `run>=${s.run},cum>=${s.cum}`, "long", upCum);
      }
      if (dnRun >= s.run && dnCum >= s.cum && bodyFrac >= 0.5) {
        push(out, panel, i, "momentum", `run>=${s.run},cum>=${s.cum}`, "short", dnCum);
      }
    }
  }
  return out;
}

export function detectAll(panel: Panel): Signal[] {
  return [
    ...detectImpulse1(panel),
    ...detectImpulseMulti(panel),
    ...detectBreak20(panel),
    ...detectStructure(panel),
    ...detectMomentum(panel),
  ];
}
