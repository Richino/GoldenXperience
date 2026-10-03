/**
 * Current EUR/USD M15 structure from causal swing highs/lows only.
 * No EMA/RSI/MACD/S/R, no production changes, no trade signal.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.resolve(__dirname, "../../api-server/.env");
for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && /^OANDA_/.test(m[1]!)) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}

const PIP = 0.0001;
const THRESHOLDS = [5, 10, 15, 20] as const;
const EQUAL_PIPS = 2;
const MIGRATION_PIPS = 3;
const LINE_BUFFER_PIPS = 3;
const FETCH_COUNT = 600;
const OUT = path.resolve(__dirname, "../research-output/eurusd-m15-current-swing-trend.txt");

type Bar = { time: string; high: number; low: number; close: number; open: number };

type Swing = {
  kind: "HIGH" | "LOW";
  candidateIdx: number;
  candidateTime: string;
  candidatePrice: number;
  confirmIdx: number;
  confirmTime: string;
  confirmPrice: number;
  delayBars: number;
  moveAwayPips: number;
};

type Trend = "BULLISH" | "BEARISH" | "UNCLEAR";
type LineStatus = "INTACT" | "TESTING" | "BROKEN" | "RECLAIMED" | "NO VALID TRENDLINE";

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f5 = (x: number) => x.toFixed(5);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const pips = (a: number, b: number) => (a - b) / PIP;

function detectSwings(bars: Bar[], thresholdPips: number): Swing[] {
  const thr = thresholdPips * PIP;
  const swings: Swing[] = [];
  if (bars.length < 2) return swings;

  let hi = bars[0]!.high;
  let hiIdx = 0;
  let lo = bars[0]!.low;
  let loIdx = 0;
  let mode: "UNK" | "UP" | "DOWN" = "UNK";

  const pushHigh = (confirmIdx: number) => {
    const bar = bars[confirmIdx]!;
    const move = (hi - bar.low) / PIP;
    swings.push({
      kind: "HIGH",
      candidateIdx: hiIdx,
      candidateTime: bars[hiIdx]!.time,
      candidatePrice: hi,
      confirmIdx,
      confirmTime: bar.time,
      confirmPrice: bar.close,
      delayBars: confirmIdx - hiIdx,
      moveAwayPips: move,
    });
  };
  const pushLow = (confirmIdx: number) => {
    const bar = bars[confirmIdx]!;
    const move = (bar.high - lo) / PIP;
    swings.push({
      kind: "LOW",
      candidateIdx: loIdx,
      candidateTime: bars[loIdx]!.time,
      candidatePrice: lo,
      confirmIdx,
      confirmTime: bar.time,
      confirmPrice: bar.close,
      delayBars: confirmIdx - loIdx,
      moveAwayPips: move,
    });
  };

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (mode === "UNK") {
      if (b.high >= hi) {
        hi = b.high;
        hiIdx = i;
      }
      if (b.low <= lo) {
        lo = b.low;
        loIdx = i;
      }
      const canHi = hiIdx < i && hi - b.low >= thr;
      const canLo = loIdx < i && b.high - lo >= thr;
      if (canHi && (!canLo || hiIdx <= loIdx)) {
        pushHigh(i);
        mode = "DOWN";
        lo = b.low;
        loIdx = i;
        hi = b.high;
        hiIdx = i;
      } else if (canLo) {
        pushLow(i);
        mode = "UP";
        hi = b.high;
        hiIdx = i;
        lo = b.low;
        loIdx = i;
      }
      continue;
    }

    if (mode === "UP") {
      if (b.high >= hi) {
        hi = b.high;
        hiIdx = i;
      }
      if (hiIdx < i && hi - b.low >= thr) {
        pushHigh(i);
        mode = "DOWN";
        lo = b.low;
        loIdx = i;
        hi = b.high;
        hiIdx = i;
      }
    } else {
      if (b.low <= lo) {
        lo = b.low;
        loIdx = i;
      }
      if (loIdx < i && b.high - lo >= thr) {
        pushLow(i);
        mode = "UP";
        hi = b.high;
        hiIdx = i;
        lo = b.low;
        loIdx = i;
      }
    }
  }
  return swings;
}

function relHigh(diff: number): "HH" | "LH" | "EH" {
  if (diff > EQUAL_PIPS) return "HH";
  if (diff < -EQUAL_PIPS) return "LH";
  return "EH";
}
function relLow(diff: number): "HL" | "LL" | "EL" {
  if (diff > EQUAL_PIPS) return "HL";
  if (diff < -EQUAL_PIPS) return "LL";
  return "EL";
}

function classify(highs: Swing[], lows: Swing[]): { trend: Trend; netHigh: number; netLow: number } {
  if (highs.length < 2 || lows.length < 2) {
    return { trend: "UNCLEAR", netHigh: NaN, netLow: NaN };
  }
  const netHigh = pips(highs[highs.length - 1]!.candidatePrice, highs[0]!.candidatePrice);
  const netLow = pips(lows[lows.length - 1]!.candidatePrice, lows[0]!.candidatePrice);
  if (netHigh > MIGRATION_PIPS && netLow > MIGRATION_PIPS) return { trend: "BULLISH", netHigh, netLow };
  if (netHigh < -MIGRATION_PIPS && netLow < -MIGRATION_PIPS) return { trend: "BEARISH", netHigh, netLow };
  return { trend: "UNCLEAR", netHigh, netLow };
}

type LineFit = {
  kind: "RISING_SUPPORT" | "FALLING_RESISTANCE";
  a1: Swing;
  a2: Swing;
  slopePipsPerBar: number;
  projected: number;
  distancePips: number;
  status: LineStatus;
  breakTime?: string;
  breakDepth?: number;
  maxDepth?: number;
  barsBeyond?: number;
  reclaimed?: boolean;
};

function lineAt(a1: Swing, a2: Swing, idx: number): number {
  const slope = (a2.candidatePrice - a1.candidatePrice) / (a2.candidateIdx - a1.candidateIdx);
  return a2.candidatePrice + slope * (idx - a2.candidateIdx);
}

function evalLine(
  bars: Bar[],
  a1: Swing,
  a2: Swing,
  kind: "RISING_SUPPORT" | "FALLING_RESISTANCE",
): LineFit {
  const slopePips = pips(a2.candidatePrice, a1.candidatePrice) / (a2.candidateIdx - a1.candidateIdx);
  const now = bars.length - 1;
  const projected = lineAt(a1, a2, now);
  const close = bars[now]!.close;
  const distance = pips(close, projected);

  let firstBreak = -1;
  let maxDepth = 0;
  let barsBeyond = 0;
  let reclaimed = false;
  let seenBreak = false;

  for (let j = a2.candidateIdx + 1; j < bars.length; j++) {
    const line = lineAt(a1, a2, j);
    const b = bars[j]!;
    const beyond =
      kind === "RISING_SUPPORT" ? b.close < line - LINE_BUFFER_PIPS * PIP : b.close > line + LINE_BUFFER_PIPS * PIP;
    const depth =
      kind === "RISING_SUPPORT" ? (line - b.low) / PIP : (b.high - line) / PIP;
    if (beyond) {
      if (firstBreak < 0) firstBreak = j;
      seenBreak = true;
      barsBeyond++;
      maxDepth = Math.max(maxDepth, depth);
    } else if (seenBreak) {
      const back =
        kind === "RISING_SUPPORT" ? b.close >= line : b.close <= line;
      if (back) reclaimed = true;
    }
    if (depth > maxDepth && (kind === "RISING_SUPPORT" ? b.low < line : b.high > line)) {
      maxDepth = Math.max(maxDepth, depth);
    }
  }

  let status: LineStatus = "INTACT";
  const absDist = Math.abs(distance);
  const currentlyBeyond =
    kind === "RISING_SUPPORT" ? close < projected - LINE_BUFFER_PIPS * PIP : close > projected + LINE_BUFFER_PIPS * PIP;
  if (firstBreak >= 0 && reclaimed && !currentlyBeyond) status = "RECLAIMED";
  else if (currentlyBeyond || (firstBreak >= 0 && !reclaimed)) status = "BROKEN";
  else if (absDist <= LINE_BUFFER_PIPS) status = "TESTING";
  else status = "INTACT";

  return {
    kind,
    a1,
    a2,
    slopePipsPerBar: slopePips,
    projected,
    distancePips: distance,
    status,
    breakTime: firstBreak >= 0 ? bars[firstBreak]!.time : undefined,
    breakDepth: firstBreak >= 0 ? (kind === "RISING_SUPPORT"
      ? (lineAt(a1, a2, firstBreak) - bars[firstBreak]!.close) / PIP
      : (bars[firstBreak]!.close - lineAt(a1, a2, firstBreak)) / PIP) : undefined,
    maxDepth: firstBreak >= 0 ? maxDepth : undefined,
    barsBeyond: firstBreak >= 0 ? barsBeyond : undefined,
    reclaimed: firstBreak >= 0 ? reclaimed : undefined,
  };
}

async function main(): Promise<void> {
  const { getResearchCandles } = await import("../src/lib/oanda/client");
  const raw = await getResearchCandles("EUR_USD", "M15", FETCH_COUNT);
  const bars: Bar[] = raw
    .filter((c) => c.complete && c.mid)
    .map((c) => ({
      time: c.time,
      open: c.mid.open,
      high: c.mid.high,
      low: c.mid.low,
      close: c.mid.close,
    }))
    .sort((a, b) => (a.time < b.time ? -1 : 1));

  if (bars.length < 50) throw new Error(`Too few completed candles: ${bars.length}`);

  const last = bars[bars.length - 1]!;
  const votes: {
    thr: number;
    trend: Trend;
    netHigh: number;
    netLow: number;
    broadTrend: Trend;
    broadNetHigh: number;
    broadNetLow: number;
    highs: Swing[];
    lows: Swing[];
    broadHighs: Swing[];
    broadLows: Swing[];
  }[] = [];

  log("=".repeat(72));
  log("EUR/USD M15 CURRENT STRUCTURE — CAUSAL SWING HIGHS / LOWS");
  log("=".repeat(72));
  log(`Generated: ${new Date().toISOString()}`);
  log("No EMA, RSI, MACD, S/R, or trade signal.");
  log("");
  log("DATA");
  log("-".repeat(72));
  log(`  Instrument: EUR_USD  Granularity: M15  Price: OANDA MID`);
  log(`  Completed candles only (incomplete dropped)`);
  log(`  First timestamp: ${bars[0]!.time}`);
  log(`  Last timestamp:  ${last.time}`);
  log(`  Candle count:    ${bars.length}`);
  log(`  Current completed close: ${f5(last.close)}`);
  log("");
  log("METHOD");
  log("-".repeat(72));
  log("  Zigzag is causal: a swing high/low is confirmed only after price");
  log("  moves away from the extreme by the sensitivity (5/10/15/20 pips).");
  log("  Confirmation timestamp is that later candle, not the extreme candle.");
  log(`  EH/EL if successive swings differ by <= ${EQUAL_PIPS} pips.`);
  log(`  Migration counted on the latest 4 swings. |net| <= ${MIGRATION_PIPS}p counts as flat.`);
  log("  Broader up-to-6 nets are shown so one older swing cannot silently define 'current'.");
  log("");

  for (const thr of THRESHOLDS) {
    const swings = detectSwings(bars, thr);
    const highs = swings.filter((s) => s.kind === "HIGH");
    const lows = swings.filter((s) => s.kind === "LOW");
    const broadH = highs.slice(-6);
    const broadL = lows.slice(-6);
    const recentH = highs.slice(-4);
    const recentL = lows.slice(-4);
    const broad = classify(broadH, broadL);
    const cls = classify(recentH, recentL);
    votes.push({
      thr,
      ...cls,
      broadTrend: broad.trend,
      broadNetHigh: broad.netHigh,
      broadNetLow: broad.netLow,
      highs: recentH,
      lows: recentL,
      broadHighs: broadH,
      broadLows: broadL,
    });

    log("=".repeat(72));
    log(`SWING SENSITIVITY: ${thr} pip move-away`);
    log("=".repeat(72));
    log(`  Confirmed swings in window: highs=${highs.length} lows=${lows.length}`);
    log(`  Current read uses the latest 4 highs/lows. Broader context uses up to 6.`);
    log(`  Latest-4 highs=${recentH.length} lows=${recentL.length}`);
    log("");
    log("  RECENT SWING HIGHS (up to 6)");
    broadH.forEach((s, i) => {
      log(
        `  H${i + 1}: candidate ${s.candidateTime} @ ${f5(s.candidatePrice)} | confirmed ${s.confirmTime} close ${f5(s.confirmPrice)} | delay ${s.delayBars} bars | move away ${f1(s.moveAwayPips)}p`,
      );
    });
    log("");
    log("  HIGH COMPARISONS");
    for (let i = 1; i < broadH.length; i++) {
      const d = pips(broadH[i]!.candidatePrice, broadH[i - 1]!.candidatePrice);
      log(
        `  H${i} ${f5(broadH[i - 1]!.candidatePrice)} → H${i + 1} ${f5(broadH[i]!.candidatePrice)}  diff ${d >= 0 ? "+" : ""}${f1(d)}p  ${relHigh(d)}`,
      );
    }
    log("");
    log("  RECENT SWING LOWS (up to 6)");
    broadL.forEach((s, i) => {
      log(
        `  L${i + 1}: candidate ${s.candidateTime} @ ${f5(s.candidatePrice)} | confirmed ${s.confirmTime} close ${f5(s.confirmPrice)} | delay ${s.delayBars} bars | move away ${f1(s.moveAwayPips)}p`,
      );
    });
    log("");
    log("  LOW COMPARISONS");
    for (let i = 1; i < broadL.length; i++) {
      const d = pips(broadL[i]!.candidatePrice, broadL[i - 1]!.candidatePrice);
      log(
        `  L${i} ${f5(broadL[i - 1]!.candidatePrice)} → L${i + 1} ${f5(broadL[i]!.candidatePrice)}  diff ${d >= 0 ? "+" : ""}${f1(d)}p  ${relLow(d)}`,
      );
    }
    log("");
    log(`  CURRENT net high migration (latest 4): ${cls.netHigh >= 0 ? "+" : ""}${f1(cls.netHigh)}p`);
    log(`  CURRENT net low migration (latest 4):  ${cls.netLow >= 0 ? "+" : ""}${f1(cls.netLow)}p`);
    log(`  CURRENT classification @ ${thr}p: ${cls.trend}`);
    log(
      `  Broader (up to 6) nets: highs ${broad.netHigh >= 0 ? "+" : ""}${f1(broad.netHigh)}p, lows ${broad.netLow >= 0 ? "+" : ""}${f1(broad.netLow)}p → ${broad.trend}`,
    );
    log("");
  }

  const bullN = votes.filter((v) => v.trend === "BULLISH").length;
  const bearN = votes.filter((v) => v.trend === "BEARISH").length;
  const unclearN = votes.filter((v) => v.trend === "UNCLEAR").length;
  let overall: Trend = "UNCLEAR";
  if (bullN >= 3 && bearN === 0) overall = "BULLISH";
  else if (bearN >= 3 && bullN === 0) overall = "BEARISH";
  else if (bullN >= 3 && bearN > 0) overall = "BULLISH";
  else if (bearN >= 3 && bullN > 0) overall = "BEARISH";

  const confidence =
    (overall !== "UNCLEAR" && bullN + bearN === 4 && unclearN === 0 && (bullN === 0 || bearN === 0))
      ? "STRONG STRUCTURAL AGREEMENT"
      : overall !== "UNCLEAR" && (bullN >= 3 || bearN >= 3)
        ? "MODERATE STRUCTURAL AGREEMENT"
        : "MIXED STRUCTURE";

  // Primary narrative = 10p if present, else first
  const primary = votes.find((v) => v.thr === 10) ?? votes[0]!;
  const highs = primary.highs;
  const lows = primary.lows;

  let line: LineFit | null = null;
  let lineNote = "NO VALID TRENDLINE";
  if (lows.length >= 2 && primary.netLow > MIGRATION_PIPS) {
    const a1 = lows[0]!;
    const a2 = lows[lows.length - 1]!;
    if (a2.candidateIdx > a1.candidateIdx) {
      line = evalLine(bars, a1, a2, "RISING_SUPPORT");
      lineNote = "RISING";
    }
  } else if (highs.length >= 2 && primary.netHigh < -MIGRATION_PIPS) {
    const a1 = highs[0]!;
    const a2 = highs[highs.length - 1]!;
    if (a2.candidateIdx > a1.candidateIdx) {
      line = evalLine(bars, a1, a2, "FALLING_RESISTANCE");
      lineNote = "FALLING";
    }
  }

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows.length >= 2 ? lows[lows.length - 2] : undefined;
  const prevHigh = highs.length >= 2 ? highs[highs.length - 2] : undefined;

  log("=".repeat(72));
  log("CURRENT EURUSD M15 STRUCTURE");
  log("=".repeat(72));
  log(`Latest completed candle: ${last.time}`);
  log(`PRICE: ${f5(last.close)}`);
  log("");
  log(`TREND (10p narrative): ${primary.trend}`);
  log("");
  log("Recent highs (10p, latest 4):");
  log(`  ${highs.map((h) => f5(h.candidatePrice)).join(" → ") || "(none)"}`);
  log(
    `High structure: ${highs.slice(1).map((h, i) => relHigh(pips(h.candidatePrice, highs[i]!.candidatePrice))).join(" / ") || "-"}`,
  );
  log(`Net high migration: ${primary.netHigh >= 0 ? "+" : ""}${f1(primary.netHigh)} pips`);
  log("");
  log("Recent lows (10p, latest 4):");
  log(`  ${lows.map((h) => f5(h.candidatePrice)).join(" → ") || "(none)"}`);
  log(
    `Low structure: ${lows.slice(1).map((h, i) => relLow(pips(h.candidatePrice, lows[i]!.candidatePrice))).join(" / ") || "-"}`,
  );
  log(`Net low migration: ${primary.netLow >= 0 ? "+" : ""}${f1(primary.netLow)} pips`);
  log("");
  log("Swing sensitivity agreement (latest 4 swings):");
  for (const v of votes) {
    log(
      `  ${v.thr}p swings: ${v.trend}  | broader up-to-6: ${v.broadTrend} (highs ${v.broadNetHigh >= 0 ? "+" : ""}${f1(v.broadNetHigh)}p, lows ${v.broadNetLow >= 0 ? "+" : ""}${f1(v.broadNetLow)}p)`,
    );
  }
  log("");
  log(`OVERALL: ${overall}`);
  log("");

  if (line) {
    log("TRENDLINE");
    log("-".repeat(72));
    log(`  Type: ${line.kind}`);
    log(`  Anchor 1: ${line.a1.candidateTime} @ ${f5(line.a1.candidatePrice)}`);
    log(`  Anchor 2: ${line.a2.candidateTime} @ ${f5(line.a2.candidatePrice)}`);
    log(`  Slope: ${line.slopePipsPerBar >= 0 ? "+" : ""}${f2(line.slopePipsPerBar)} pips per M15 candle`);
    log(`  Projected now: ${f5(line.projected)}`);
    log(`  Current close distance: ${line.distancePips >= 0 ? "+" : ""}${f1(line.distancePips)} pips (close minus line)`);
    log(`  TRENDLINE STATUS: ${line.status}`);
    if (line.breakTime) {
      log(`  Break timestamp: ${line.breakTime}`);
      log(`  Break depth (close vs line): ${f1(line.breakDepth ?? NaN)} pips`);
      log(`  Maximum depth: ${f1(line.maxDepth ?? NaN)} pips`);
      log(`  Completed candles with close beyond line: ${line.barsBeyond}`);
      log(`  Reclaimed: ${line.reclaimed ? "yes" : "no"}`);
    }
  } else {
    log("TRENDLINE STATUS: NO VALID TRENDLINE");
    log("  (Rising support needs rising lows; falling resistance needs falling highs.)");
  }
  log("");

  log("WHAT WOULD CHANGE THE STRUCTURE");
  log("-".repeat(72));
  if (overall === "BULLISH") {
    const ref = lastLow;
    log("  Bullish structure remains intact while:");
    log(
      ref
        ? `    later swing lows stay above roughly ${f5(ref.candidatePrice)} (last confirmed 10p swing low), allowing small pauses that do not confirm a lower low.`
        : "    both highs and lows keep migrating upward.",
    );
    log("  Bullish structure becomes questionable if:");
    log(
      ref
        ? `    price trades below ${f5(ref.candidatePrice)} and then rallies at least the swing threshold (about 10p) — that would CONFIRM a lower low. A wick or a single large bearish candle is not enough by itself.`
        : "    a confirmed lower low appears.",
    );
    log("  A bearish structure would require:");
    log("    that confirmed lower low, followed by a later swing high that confirms as a lower high. One large down candle does not flip the trend.");
    if (prevLow) {
      log(`  Prior swing low (context): ${f5(prevLow.candidatePrice)} at ${prevLow.candidateTime}`);
    }
  } else if (overall === "BEARISH") {
    const ref = lastHigh;
    log("  Bearish structure remains intact while:");
    log(
      ref
        ? `    later swing highs stay below roughly ${f5(ref.candidatePrice)} (last confirmed 10p swing high).`
        : "    both highs and lows keep migrating downward.",
    );
    log("  Bearish structure becomes questionable if:");
    log(
      ref
        ? `    price trades above ${f5(ref.candidatePrice)} and then falls at least ~10p — that would CONFIRM a higher high. A single large bullish candle is not enough by itself.`
        : "    a confirmed higher high appears.",
    );
    log("  A bullish structure would require:");
    log("    that confirmed higher high, followed by a later swing low that confirms as a higher low.");
    if (prevHigh) log(`  Prior swing high (context): ${f5(prevHigh.candidatePrice)} at ${prevHigh.candidateTime}`);
  } else {
    log("  Structure is unclear / range. Latest confirmed swings are not migrating together.");
    log("  It stays unclear while price oscillates between the latest meaningful swing low and swing high without confirming a new pair of swings in the same direction.");
    if (lastLow && lastHigh) {
      log(`  Unclear remains intact while:`);
      log(`    new 10p swing lows hold near or above ${f5(lastLow.candidatePrice)} AND new 10p swing highs stay near or below ${f5(lastHigh.candidatePrice)}, without both sides stepping the same way.`);
      log(`  A bullish structure would require:`);
      log(`    a confirmed higher low above ${f5(lastLow.candidatePrice)}, then a confirmed higher high above ${f5(lastHigh.candidatePrice)}. Touching either level is not enough; the swing must be confirmed by a later ~10p move away.`);
      log(`  A bearish structure would require:`);
      log(`    a confirmed lower low below ${f5(lastLow.candidatePrice)}, then a confirmed lower high below ${f5(lastHigh.candidatePrice)}.`);
    } else {
      log("    bullish needs both highs and lows stepping up; bearish needs both stepping down.");
    }
  }
  log("");

  const highChain = highs
    .slice(1)
    .map((h, i) => relHigh(pips(h.candidatePrice, highs[i]!.candidatePrice)))
    .join("/");
  const lowChain = lows
    .slice(1)
    .map((h, i) => relLow(pips(h.candidatePrice, lows[i]!.candidatePrice)))
    .join("/");

  log("=".repeat(72));
  log("EURUSD M15");
  log("");
  log(`Current trend: ${overall}`);
  log("");
  log("Confidence description:");
  log(confidence);
  log("");
  log("Why:");
  log(
    `- highs: 10p sequence ${highs.map((h) => f5(h.candidatePrice)).join(" → ")} (${highChain || "-"}), net ${primary.netHigh >= 0 ? "+" : ""}${f1(primary.netHigh)}p`,
  );
  log(
    `- lows: 10p sequence ${lows.map((h) => f5(h.candidatePrice)).join(" → ")} (${lowChain || "-"}), net ${primary.netLow >= 0 ? "+" : ""}${f1(primary.netLow)}p`,
  );
  log(`- swing sensitivity agreement: ${votes.map((v) => `${v.thr}p ${v.trend}`).join("; ")} (latest 4). Broader: ${votes.map((v) => `${v.thr}p ${v.broadTrend}`).join("; ")}`);
  log(
    `- trendline: ${line ? `${lineNote} from ${f5(line.a1.candidatePrice)} to ${f5(line.a2.candidatePrice)}, status ${line.status}, distance ${line.distancePips >= 0 ? "+" : ""}${f1(line.distancePips)}p` : "NONE"}`,
  );
  log("");
  log(`Most important current swing high: ${lastHigh ? f5(lastHigh.candidatePrice) : "NONE"}`);
  log(`Most important current swing low: ${lastLow ? f5(lastLow.candidatePrice) : "NONE"}`);
  log("");
  log(`Trendline: ${lineNote === "NO VALID TRENDLINE" ? "NONE" : lineNote}`);
  log(`Trendline status: ${line ? line.status : "NONE"}`);
  log("=".repeat(72));

  const why =
    overall === "BULLISH"
      ? "Highs and lows are both migrating upward across the recent confirmed swings."
      : overall === "BEARISH"
        ? "Highs and lows are both migrating downward across the recent confirmed swings."
        : "Highs and lows do not migrate in the same direction by a meaningful amount, so the structure is not a clean trend.";
  log(why);
  log("Large candles were kept. A swing prints only after a later move-away confirmation, so one large candle does not by itself reverse the label.");

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, L.join("\n") + "\n");
  console.error(`\n[written] ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
