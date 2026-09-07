/**
 * Faithful local port of "Micro Confirmation V4.4 Validation" (Pine v6).
 *
 * The port mirrors the Pine script's exact top-to-bottom, bar-by-bar execution
 * order. Pine semantics reproduced:
 *
 *  - process_orders_on_close=true => a market entry fills at the CLOSE of the
 *    signal bar (same bar), and its stop/limit exit orders only become live on
 *    the NEXT bar. Resting stop/limit exits are checked intrabar on each
 *    subsequent bar using that bar's high/low.
 *  - strategy.position_size[1] (used by newLong/newShort to freeze tradeATR) is
 *    the position size at the END of the PREVIOUS bar. We capture `posPrev` at
 *    the very start of the bar, before any intrabar exit fill, so the
 *    "exit + re-enter same side same bar => tradeATR NOT refreshed" edge case is
 *    preserved exactly.
 *  - ta.atr = Wilder RMA of True Range.
 *  - ta.highest(high[1], N) = max of high over bars t-1..t-N (excludes current).
 *  - Ambiguous bar (both stop and target inside the bar's range): Pine's default
 *    conservative assumption => STOP filled first (loss). Reproduced.
 *
 * Prices used for signal generation and the PINE-COMPATIBLE broker emulation are
 * MID (bid+ask)/2, matching a TradingView OANDA chart with no commission/spread
 * configured. Realistic execution cost is applied afterward as a per-trade
 * spread penalty (see run.ts) so the SIGNAL/trade set stays identical across all
 * cost scenarios, as required by the cost-stress phase.
 */

export type Candle = {
  closeTime: string; open: number; high: number; low: number; close: number;
  bidOpen: number; bidHigh: number; bidLow: number; bidClose: number;
  askOpen: number; askHigh: number; askLow: number; askClose: number;
};

export type Trade = {
  dir: "long" | "short";
  entryIdx: number; entryTime: string; entryMid: number;
  exitIdx: number; exitTime: string; exitMid: number;
  reason: "TP" | "SL";
  tradeATR: number;      // ATR frozen at entry (mid)
  riskDist: number;      // 0.5 * tradeATR
  pnlPriceMid: number;   // signed mid P&L for 1 unit (no cost)
  pnlR: number;          // pnlPriceMid / riskDist  (win ~ +2R, loss ~ -1R)
  spreadAtEntry: number; // ask-bid at entry bar close (price units)
  session: string;       // NY session of entry bar
};

// ---- frozen parameters (from the Pine input defaults) ----
export const P = {
  lookback: 20,
  atrLength: 14,
  pressureBars: 10,
  pressureThreshold: 0.65,
  strongThreshold: 0.75,
  sustainBars: 3,
  breakATR: 0.10,
  minBodyATR: 0.15,
  holdBars: 2,
  structureLookback: 3,
  failureBars: 2,
  maxCrosses: 5,
  neutralReset: 0.60,
  stopATR: 0.50,
  targetATR: 1.00,
  bodyFilter: 0.60,
  pressureMin: 0.75,
  pressureMax: 0.85,
} as const;

export type TestMode =
  | "BASELINE" | "LONDON_ONLY" | "OVERRIDE_ONLY"
  | "LONDON_OVERRIDE" | "LONDON_BODY" | "LONDON_PRESSURE";

// ---- ATR via Wilder RMA of True Range ----
export function computeATR(c: Candle[], n: number): number[] {
  const tr: number[] = new Array(c.length).fill(NaN);
  for (let i = 0; i < c.length; i++) {
    if (i === 0) { tr[i] = c[i]!.high - c[i]!.low; continue; }
    const h = c[i]!.high, l = c[i]!.low, pc = c[i - 1]!.close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr: number[] = new Array(c.length).fill(NaN);
  // seed RMA with SMA of first n TRs (Pine's ta.rma seeding)
  if (c.length >= n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += tr[i]!;
    atr[n - 1] = s / n;
    for (let i = n; i < c.length; i++) atr[i] = (atr[i - 1]! * (n - 1) + tr[i]!) / n;
  }
  return atr;
}

// ---- NY-local session helpers (DST-aware via Intl) ----
const nyFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  hour: "2-digit", minute: "2-digit",
});
function nyMinutes(msUtc: number): number {
  const parts = nyFmt.formatToParts(new Date(msUtc));
  let h = 0, m = 0;
  for (const p of parts) { if (p.type === "hour") h = +p.value; if (p.type === "minute") m = +p.value; }
  if (h === 24) h = 0; // en-US hour12:false can emit "24" at midnight
  return h * 60 + m;
}
// Conventional NY-time session blocks. London PINNED to the Pine spec 0300-0800.
export function sessionOf(openMsUtc: number): "ASIA" | "LONDON" | "NEW_YORK" | "OTHER" {
  const mm = nyMinutes(openMsUtc);
  if (mm >= 180 && mm < 480) return "LONDON";        // 03:00-08:00
  if (mm >= 480 && mm < 1020) return "NEW_YORK";     // 08:00-17:00
  if (mm >= 1080 || mm < 180) return "ASIA";         // 18:00-03:00
  return "OTHER";                                    // 17:00-18:00
}
export function isLondon(openMsUtc: number): boolean {
  const mm = nyMinutes(openMsUtc);
  return mm >= 180 && mm < 480;
}

function stepMs(c: Candle[]): number {
  return Date.parse(c[1]!.closeTime) - Date.parse(c[0]!.closeTime);
}

/**
 * Run the strategy exactly, returning the canonical trade list (mid-price,
 * PINE-COMPATIBLE broker emulation).
 */
export function runStrategy(c: Candle[], mode: TestMode): Trade[] {
  const n = c.length;
  const atr = computeATR(c, P.atrLength);
  const step = stepMs(c);
  const closeArr = c.map((x) => x.close);
  const highArr = c.map((x) => x.high);
  const lowArr = c.map((x) => x.low);
  const openArr = c.map((x) => x.open);

  // pressure series (needed as history for sustain)
  const longPressureArr: number[] = new Array(n).fill(0.5);
  const shortPressureArr: number[] = new Array(n).fill(0.5);

  // persistent (Pine `var`) state
  let signalLock = 0;
  let frozenResistance = NaN, frozenSupport = NaN;
  let observingLong = false, observingShort = false;
  let longBreakSeen = false, shortBreakSeen = false;
  let longBreakBar = NaN, shortBreakBar = NaN;
  let longHoldCount = 0, shortHoldCount = 0;
  let tradeATR = NaN;

  // position state (broker emulation)
  let position = 0;            // 0 flat, 1 long, -1 short
  let posPrev = 0;            // position at END of previous bar (== position_size[1])
  let entryIdx = -1;
  let entryPrice = NaN;
  let entrySpread = NaN;
  let stopLevel = NaN, targetLevel = NaN;

  const trades: Trade[] = [];
  const START = 25; // warmup for lookback(20)+atr(14) history

  for (let t = 0; t < n; t++) {
    posPrev = position; // capture BEFORE any intrabar exit fill (== position_size[1])

    // ---------- STEP A: resting exit fills (orders live from NEXT bar) ----------
    if (position !== 0 && entryIdx < t && !Number.isNaN(tradeATR)) {
      const hi = highArr[t]!, lo = lowArr[t]!, op = openArr[t]!;
      let filled: "TP" | "SL" | null = null;
      let fillPrice = NaN;
      if (position > 0) {
        const hitStop = lo <= stopLevel;
        const hitTgt = hi >= targetLevel;
        if (hitStop && hitTgt) { filled = "SL"; fillPrice = op <= stopLevel ? op : stopLevel; }
        else if (hitStop) { filled = "SL"; fillPrice = op <= stopLevel ? op : stopLevel; }
        else if (hitTgt) { filled = "TP"; fillPrice = op >= targetLevel ? op : targetLevel; }
      } else {
        const hitStop = hi >= stopLevel;
        const hitTgt = lo <= targetLevel;
        if (hitStop && hitTgt) { filled = "SL"; fillPrice = op >= stopLevel ? op : stopLevel; }
        else if (hitStop) { filled = "SL"; fillPrice = op >= stopLevel ? op : stopLevel; }
        else if (hitTgt) { filled = "TP"; fillPrice = op <= targetLevel ? op : targetLevel; }
      }
      if (filled) {
        const dir = position > 0 ? "long" : "short";
        const pnl = position > 0 ? fillPrice - entryPrice : entryPrice - fillPrice;
        const riskDist = P.stopATR * tradeATR;
        trades.push({
          dir, entryIdx, entryTime: c[entryIdx]!.closeTime, entryMid: entryPrice,
          exitIdx: t, exitTime: c[t]!.closeTime, exitMid: fillPrice, reason: filled,
          tradeATR, riskDist, pnlPriceMid: pnl, pnlR: pnl / riskDist,
          spreadAtEntry: entrySpread, session: sessionOf(Date.parse(c[entryIdx]!.closeTime) - step),
        });
        position = 0; entryIdx = -1; stopLevel = NaN; targetLevel = NaN;
        // tradeATR cleared later by tradeClosed block (mirrors Pine ordering)
      }
    }

    if (t < START || Number.isNaN(atr[t]!)) { position = position; continue; }
    const A = atr[t]!;

    // ---------- indicators ----------
    let rawResistance = -Infinity, rawSupport = Infinity;
    for (let k = 1; k <= P.lookback; k++) {
      if (highArr[t - k]! > rawResistance) rawResistance = highArr[t - k]!;
      if (lowArr[t - k]! < rawSupport) rawSupport = lowArr[t - k]!;
    }

    // pressure (i = 0..pressureBars-2)
    let upMoves = 0, downMoves = 0;
    for (let i = 0; i <= P.pressureBars - 2; i++) {
      const a = closeArr[t - i]!, b = closeArr[t - i - 1]!;
      if (a > b) upMoves++; else if (a < b) downMoves++;
    }
    const totalMoves = upMoves + downMoves;
    const longPressure = totalMoves > 0 ? upMoves / totalMoves : 0.5;
    const shortPressure = totalMoves > 0 ? downMoves / totalMoves : 0.5;
    longPressureArr[t] = longPressure;
    shortPressureArr[t] = shortPressure;

    // sustain (i = 0..sustainBars-1)
    let longSustain = 0, shortSustain = 0;
    for (let i = 0; i <= P.sustainBars - 1; i++) {
      if (longPressureArr[t - i]! >= P.pressureThreshold) longSustain++;
      if (shortPressureArr[t - i]! >= P.pressureThreshold) shortSustain++;
    }
    const longPressureConfirmed = longSustain >= P.sustainBars;
    const shortPressureConfirmed = shortSustain >= P.sustainBars;

    // structure (i = 0..structureLookback-2)
    let higherLows = true, lowerHighs = true;
    for (let i = 0; i <= P.structureLookback - 2; i++) {
      if (lowArr[t - i]! <= lowArr[t - i - 1]!) higherLows = false;
      if (highArr[t - i]! >= highArr[t - i - 1]!) lowerHighs = false;
    }
    const longStructure = higherLows;
    const shortStructure = lowerHighs;

    // ---------- signal lock ----------
    if (signalLock === 1 && longPressure < P.neutralReset) signalLock = 0;
    if (signalLock === -1 && shortPressure < P.neutralReset) signalLock = 0;
    const longAllowed = signalLock !== 1;
    const shortAllowed = signalLock !== -1;

    // ---------- start observation ----------
    if (!observingLong && !observingShort) {
      if (longPressure >= P.pressureThreshold && longAllowed) {
        frozenResistance = rawResistance; frozenSupport = rawSupport;
        observingLong = true; observingShort = false;
        longBreakSeen = false; shortBreakSeen = false;
        longBreakBar = NaN; shortBreakBar = NaN; longHoldCount = 0; shortHoldCount = 0;
      } else if (shortPressure >= P.pressureThreshold && shortAllowed) {
        frozenResistance = rawResistance; frozenSupport = rawSupport;
        observingLong = false; observingShort = true;
        longBreakSeen = false; shortBreakSeen = false;
        longBreakBar = NaN; shortBreakBar = NaN; longHoldCount = 0; shortHoldCount = 0;
      }
    }

    // ---------- breakout ----------
    const bodySize = Math.abs(closeArr[t]! - openArr[t]!);
    const longDistance = !Number.isNaN(frozenResistance) ? closeArr[t]! - frozenResistance : 0;
    const shortDistance = !Number.isNaN(frozenSupport) ? frozenSupport - closeArr[t]! : 0;
    const strongLongBreak = observingLong && !Number.isNaN(frozenResistance) &&
      closeArr[t]! > frozenResistance && longDistance >= A * P.breakATR && bodySize >= A * P.minBodyATR;
    const strongShortBreak = observingShort && !Number.isNaN(frozenSupport) &&
      closeArr[t]! < frozenSupport && shortDistance >= A * P.breakATR && bodySize >= A * P.minBodyATR;
    if (strongLongBreak && !longBreakSeen) { longBreakSeen = true; longBreakBar = t; }
    if (strongShortBreak && !shortBreakSeen) { shortBreakSeen = true; shortBreakBar = t; }

    // ---------- failed breakout ----------
    let longFailed = false, shortFailed = false;
    if (longBreakSeen && !Number.isNaN(longBreakBar) && !Number.isNaN(frozenResistance)) {
      if (t - longBreakBar <= P.failureBars && closeArr[t]! <= frozenResistance) longFailed = true;
    }
    if (shortBreakSeen && !Number.isNaN(shortBreakBar) && !Number.isNaN(frozenSupport)) {
      if (t - shortBreakBar <= P.failureBars && closeArr[t]! >= frozenSupport) shortFailed = true;
    }

    // ---------- hold ----------
    if (longBreakSeen && !longFailed && !Number.isNaN(frozenResistance)) {
      if (closeArr[t]! > frozenResistance) longHoldCount++; else longHoldCount = 0;
    } else longHoldCount = 0;
    if (shortBreakSeen && !shortFailed && !Number.isNaN(frozenSupport)) {
      if (closeArr[t]! < frozenSupport) shortHoldCount++; else shortHoldCount = 0;
    } else shortHoldCount = 0;
    const longHoldConfirmed = longHoldCount >= P.holdBars;
    const shortHoldConfirmed = shortHoldCount >= P.holdBars;

    // ---------- crossings / chop ----------
    let activeMid: number;
    if (!Number.isNaN(frozenResistance) && !Number.isNaN(frozenSupport)) activeMid = (frozenResistance + frozenSupport) / 2;
    else activeMid = (rawResistance + rawSupport) / 2;
    let crossCount = 0;
    for (let i = 0; i <= P.pressureBars - 2; i++) {
      const a = closeArr[t - i]!, b = closeArr[t - i - 1]!;
      let crossed = false;
      if (a > activeMid && b <= activeMid) crossed = true;
      if (a < activeMid && b >= activeMid) crossed = true;
      if (crossed) crossCount++;
    }
    const isChop = crossCount >= P.maxCrosses;

    // ---------- structure override ----------
    const strongLongOverride = longPressure >= P.strongThreshold && longPressureConfirmed && longBreakSeen && longHoldConfirmed;
    const strongShortOverride = shortPressure >= P.strongThreshold && shortPressureConfirmed && shortBreakSeen && shortHoldConfirmed;
    const longOverride = strongLongOverride && !longStructure;
    const shortOverride = strongShortOverride && !shortStructure;
    const longStructureGate = longStructure || strongLongOverride;
    const shortStructureGate = shortStructure || strongShortOverride;

    // ---------- base confirmation ----------
    const baseLong = observingLong && longAllowed && longPressureConfirmed && longBreakSeen &&
      longHoldConfirmed && longStructureGate && !longFailed && !isChop;
    const baseShort = observingShort && shortAllowed && shortPressureConfirmed && shortBreakSeen &&
      shortHoldConfirmed && shortStructureGate && !shortFailed && !isChop;

    // ---------- validation features (evaluated at entry bar) ----------
    const openMs = Date.parse(c[t]!.closeTime) - step;
    const inLondon = isLondon(openMs);
    const bodyATR = A > 0 ? bodySize / A : 0;
    const longPressureBucket = longPressure >= P.pressureMin && longPressure < P.pressureMax;
    const shortPressureBucket = shortPressure >= P.pressureMin && shortPressure < P.pressureMax;

    let longFilter = false, shortFilter = false;
    switch (mode) {
      case "BASELINE": longFilter = true; shortFilter = true; break;
      case "LONDON_ONLY": longFilter = inLondon; shortFilter = inLondon; break;
      case "OVERRIDE_ONLY": longFilter = longOverride; shortFilter = shortOverride; break;
      case "LONDON_OVERRIDE": longFilter = inLondon && longOverride; shortFilter = inLondon && shortOverride; break;
      case "LONDON_BODY": longFilter = inLondon && bodyATR >= P.bodyFilter; shortFilter = inLondon && bodyATR >= P.bodyFilter; break;
      case "LONDON_PRESSURE": longFilter = inLondon && longPressureBucket; shortFilter = inLondon && shortPressureBucket; break;
    }
    const finalLong = baseLong && longFilter;
    const finalShort = baseShort && shortFilter;

    // ---------- ENTRY (process_orders_on_close => fill at this bar's close) ----------
    if (finalLong && position === 0) {
      position = 1; entryIdx = t; entryPrice = closeArr[t]!;
      entrySpread = c[t]!.askClose - c[t]!.bidClose; signalLock = 1;
    }
    if (finalShort && position === 0) {
      position = -1; entryIdx = t; entryPrice = closeArr[t]!;
      entrySpread = c[t]!.askClose - c[t]!.bidClose; signalLock = -1;
    }

    // ---------- fix ATR at actual entry (uses position_size[1] == posPrev) ----------
    const newLong = position > 0 && posPrev <= 0;
    const newShort = position < 0 && posPrev >= 0;
    if (newLong || newShort) tradeATR = A;

    // ---------- exit orders (Pine calls strategy.exit EVERY bar while in a
    // position; levels recomputed from the CURRENT position_avg_price + tradeATR,
    // and become active on the NEXT bar). ----------
    if (position > 0 && !Number.isNaN(tradeATR)) {
      stopLevel = entryPrice - tradeATR * P.stopATR; targetLevel = entryPrice + tradeATR * P.targetATR;
    } else if (position < 0 && !Number.isNaN(tradeATR)) {
      stopLevel = entryPrice + tradeATR * P.stopATR; targetLevel = entryPrice - tradeATR * P.targetATR;
    }

    // ---------- tradeClosed => clear tradeATR ----------
    if (position === 0 && posPrev !== 0) tradeATR = NaN;

    // ---------- reset observation ----------
    if (baseLong || baseShort || longFailed || shortFailed) {
      observingLong = false; observingShort = false;
      frozenResistance = NaN; frozenSupport = NaN;
      longBreakSeen = false; shortBreakSeen = false;
      longBreakBar = NaN; shortBreakBar = NaN; longHoldCount = 0; shortHoldCount = 0;
    }

    // ---------- cancel on pressure flip ----------
    if (observingLong && shortPressure >= P.pressureThreshold) {
      observingLong = false; frozenResistance = NaN; frozenSupport = NaN;
      longBreakSeen = false; longBreakBar = NaN; longHoldCount = 0;
    }
    if (observingShort && longPressure >= P.pressureThreshold) {
      observingShort = false; frozenResistance = NaN; frozenSupport = NaN;
      shortBreakSeen = false; shortBreakBar = NaN; shortHoldCount = 0;
    }
  }

  return trades;
}
