/**
 * Leakage / orientation self-tests. Fail-fast before any hunt.
 */
import { detectBreak20 } from "./setups.js";
import type { Panel } from "./panels.js";
import type { PanelBar } from "./panels.js";

function bar(partial: Partial<PanelBar> & { closeTime: string; close: number; high: number; low: number }): PanelBar {
  return {
    ts: Date.parse(partial.closeTime),
    open: partial.open ?? partial.close,
    atr: partial.atr ?? 0.01,
    spread: 0.0001,
    mid: partial.close,
    session: "london",
    bidClose: partial.close - 0.00005,
    askClose: partial.close + 0.00005,
    bidHigh: partial.high,
    bidLow: partial.low,
    askHigh: partial.high,
    askLow: partial.low,
    ...partial,
  };
}

function dummyPanel(bars: PanelBar[]): Panel {
  return { instrument: "EUR_USD", timeframe: "H1", bars, pip: 0.0001 };
}

export function runLeakageSelfTest(): void {
  // 25 bars, last-but-one sets prior high at 2.0; current close 1.9 must NOT break.
  const bars: PanelBar[] = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(Date.UTC(2020, 0, 1, i)).toISOString();
    const high = i === 23 ? 2.0 : 1.2;
    bars.push(bar({ closeTime: t, close: 1.1, high, low: 1.0, atr: 0.05 }));
  }
  const tLast = new Date(Date.UTC(2020, 0, 2, 0)).toISOString();
  bars.push(bar({ closeTime: tLast, close: 1.9, high: 3.0, low: 1.0, atr: 0.05 }));
  const noBreak = detectBreak20(dummyPanel(bars)).filter((s) => s.idx === 24);
  if (noBreak.length !== 0) {
    throw new Error("break20 lookahead: current high must not be the breakout level (close 1.9 < prior high 2.0)");
  }

  // close above prior high 2.0 → break
  bars[24] = bar({ closeTime: tLast, close: 2.1, high: 2.15, low: 1.0, atr: 0.05 });
  const yes = detectBreak20(dummyPanel(bars)).filter((s) => s.idx === 24 && s.impulseDir === "long");
  if (yes.length !== 1) throw new Error(`expected one upside break20, got ${yes.length}`);

  // Downside: prior low 0.9 at i-1, close 0.8
  const bars2: PanelBar[] = [];
  for (let i = 0; i < 24; i++) {
    const t = new Date(Date.UTC(2020, 0, 1, i)).toISOString();
    const low = i === 23 ? 0.9 : 1.1;
    bars2.push(bar({ closeTime: t, close: 1.2, high: 1.3, low, atr: 0.05 }));
  }
  bars2.push(bar({ closeTime: tLast, close: 0.8, high: 1.2, low: 0.7, atr: 0.05 }));
  const dn = detectBreak20(dummyPanel(bars2)).filter((s) => s.idx === 24 && s.impulseDir === "short");
  if (dn.length !== 1) throw new Error(`expected downside break20, got ${dn.length}`);

  console.log("reversal-fade leakage self-test OK");
}
