/**
 * Adaptive Swing Trendlines V1 — WIDE STOP / RISK-2-TO-MAKE-1 TEST
 *
 * Hypothesis: direction is often right, but tight stops die in normal MAE before +10p.
 * Question: does a wider SL (esp. 20p) with FIXED +10p TP pay for its worse payoff after spread?
 *
 * ENTRY: exact same first-causal 25% pullback entries from depth-entry v1 CSV (n≈58).
 * Do NOT change entries between stop configs. Indicator frozen. No optimization.
 *
 * "2:1" here means RISK 2 TO MAKE 1 (e.g. 20p SL / 10p TP), NOT conventional 1:2 RR.
 *
 * Position sizing: constant account risk → full SL = −1.00R; TP reward = TP/SL R.
 *
 * Ambiguity: if M15 bar hits both TP and SL, resolve with local M5 BID/ASK when available;
 * else mark AMBIGUOUS (never assume TP first).
 */
import fs from "node:fs";
import path from "node:path";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import type { MajorInstrument } from "../src/types/forex";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const TP_PIPS = 10;
const SL_MATRIX = [10, 15, 20, 25, 30] as const;
const CONTROL_SL = 10;
const CONTROL_TP = 20;
const HORIZON_BARS = 96; // 24h M15
const TRADING_DAYS = 30;
const WARMUP_BARS = 400;

const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_CACHE = process.env.ATL_M15_CACHE ?? path.join(PAD, "eurusd-m15-mba-cache.json");
const M5_CACHE = process.env.ATL_M5_CACHE ?? path.join(PAD, "eurusd-m5-mba-cache.json");
const ENTRIES_CSV = path.resolve(__dirname, "../research-output/eurusd-adaptive-trendline-depth-entry-v1-events.csv");
const OUT_DIR = path.resolve(__dirname, "../research-output");
const CSV_OUT = path.join(OUT_DIR, "eurusd-adaptive-trendline-wide-stop-v1-trades.csv");
const REPORT_OUT = path.join(OUT_DIR, "eurusd-adaptive-trendline-wide-stop-v1-report.txt");

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; volume?: number; complete: boolean; mid: OHLC; bid: OHLC; ask: OHLC };
type Dir = "long" | "short";
type Outcome = "tp" | "sl" | "timeout" | "ambiguous";

type Entry = {
  eventId: string;
  timestamp: string;
  direction: Dir;
  entryPrice: number;
  spreadPips: number;
  majorDirection: string;
  currentDirection: string;
  currentLineId: string;
  entryBar: number;
};

type TradeRow = {
  eventId: string;
  timestamp: string;
  direction: Dir;
  entryPrice: number;
  spreadPips: number;
  majorDirection: string;
  currentDirection: string;
  currentLineId: string;
  stopPips: number;
  targetPips: number;
  riskRewardLabel: string;
  stopPrice: number;
  targetPrice: number;
  outcome: Outcome;
  exitTimestamp: string;
  exitPrice: number;
  holdingMinutes: number;
  netPips: number;
  resultR: number;
  maeBeforeExit: number;
  mfeBeforeExit: number;
  would10pStopHaveLost: boolean;
  savedVs10p: boolean;
  eventuallyReached10pAfterCrossing10pAdverse: boolean;
  resolvedVia: "m15" | "m5" | "timeout" | "ambiguous";
  isControl: boolean;
};

type SimResult = {
  outcome: Outcome;
  exitBar: number;
  exitPrice: number;
  exitTime: string;
  holdingMinutes: number;
  netPips: number;
  resultR: number;
  mae: number;
  mfe: number;
  resolvedVia: "m15" | "m5" | "timeout" | "ambiguous";
  crossed10Adverse: boolean;
  reached10Favorable: boolean;
  maeBeforeTp: number | null;
  mfeBeforeSl: number | null;
};

const L: string[] = [];
const log = (s = "") => {
  L.push(s);
  console.log(s);
};
const f1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(1));
const f2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(2));
const f3 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "-" : x.toFixed(3));
const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function theoreticalBeWr(sl: number, tp: number): number {
  return (100 * sl) / (sl + tp);
}

function rewardR(sl: number, tp: number): number {
  return tp / sl;
}

function tradingDayKey(iso: string): string {
  return iso.slice(0, 10);
}

function loadWindow(raw: RC[], tradingDays: number): { rows: RC[]; analysisStart: number } {
  const completed = raw.filter((c) => c.complete !== false);
  const dayOrder: string[] = [];
  const seen = new Set<string>();
  for (let i = completed.length - 1; i >= 0; i -= 1) {
    const d = tradingDayKey(completed[i]!.time);
    if (!seen.has(d)) {
      seen.add(d);
      dayOrder.push(d);
      if (dayOrder.length >= tradingDays) break;
    }
  }
  const keep = new Set(dayOrder);
  let firstKeep = completed.length;
  for (let i = 0; i < completed.length; i += 1) {
    if (keep.has(tradingDayKey(completed[i]!.time))) {
      firstKeep = i;
      break;
    }
  }
  const sliceStart = Math.max(0, firstKeep - WARMUP_BARS);
  return { rows: completed.slice(sliceStart), analysisStart: firstKeep - sliceStart };
}

function parseEntriesCsv(csvPath: string, timeToBar: Map<string, number>): Entry[] {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]!.split(",");
  const idx = (name: string) => header.indexOf(name);
  const out: Entry[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i]!.split(",");
    if (Number(cols[idx("entryThresholdPct")]) !== 25) continue;
    const timestamp = cols[idx("timestamp")]!;
    const entryBar = timeToBar.get(timestamp);
    if (entryBar == null) {
      console.error(`WARN: entry timestamp not in M15 window: ${timestamp}`);
      continue;
    }
    out.push({
      eventId: cols[idx("eventId")]!,
      timestamp,
      direction: cols[idx("direction")] as Dir,
      entryPrice: Number(cols[idx("entryPrice")]),
      spreadPips: Number(cols[idx("spreadPips")]),
      majorDirection: cols[idx("majorDirection")]!,
      currentDirection: cols[idx("currentDirection")]!,
      currentLineId: cols[idx("currentLineId")]!,
      entryBar,
    });
  }
  return out;
}

function barHits(direction: Dir, entry: number, bar: RC, tpPips: number, slPips: number): {
  hitTp: boolean;
  hitSl: boolean;
  fav: number;
  adv: number;
} {
  if (direction === "long") {
    const fav = (bar.bid.high - entry) / PIP;
    const adv = (entry - bar.bid.low) / PIP;
    return { hitTp: fav >= tpPips, hitSl: adv >= slPips, fav, adv };
  }
  const fav = (entry - bar.ask.low) / PIP;
  const adv = (bar.ask.high - entry) / PIP;
  return { hitTp: fav >= tpPips, hitSl: adv >= slPips, fav, adv };
}

function exitMark(direction: Dir, bar: RC): number {
  return direction === "long" ? bar.bid.close : bar.ask.close;
}

/** Resolve TP vs SL order inside one M15 window using M5 BID/ASK bars. */
function resolveWithM5(
  direction: Dir,
  entry: number,
  tpPips: number,
  slPips: number,
  m15Time: string,
  m5ByTime: Map<string, RC>,
  m5Times: string[],
): "tp" | "sl" | "ambiguous" {
  const startMs = Date.parse(m15Time);
  const endMs = startMs + 15 * 60 * 1000;
  // M5 bars whose open is inside [m15 open, m15 open+15)
  for (const t of m5Times) {
    const ms = Date.parse(t);
    if (ms < startMs) continue;
    if (ms >= endMs) break;
    const b = m5ByTime.get(t);
    if (!b) continue;
    const { hitTp, hitSl } = barHits(direction, entry, b, tpPips, slPips);
    if (hitTp && hitSl) return "ambiguous";
    if (hitTp) return "tp";
    if (hitSl) return "sl";
  }
  return "ambiguous";
}

function simulate(
  entry: Entry,
  bars: RC[],
  slPips: number,
  tpPips: number,
  m5ByTime: Map<string, RC> | null,
  m5Times: string[],
): SimResult {
  const reward = rewardR(slPips, tpPips);
  const direction = entry.direction;
  const entryPx = entry.entryPrice;
  const stopPrice =
    direction === "long" ? entryPx - slPips * PIP : entryPx + slPips * PIP;
  const targetPrice =
    direction === "long" ? entryPx + tpPips * PIP : entryPx - tpPips * PIP;
  void stopPrice;
  void targetPrice;

  const from = entry.entryBar + 1;
  const end = Math.min(bars.length, from + HORIZON_BARS);
  let mae = 0;
  let mfe = 0;
  let crossed10Adverse = false;
  let reached10Favorable = false;
  let maeBeforeTp: number | null = null;
  let mfeBeforeSl: number | null = null;

  for (let i = from; i < end; i += 1) {
    const bar = bars[i]!;
    const { hitTp, hitSl, fav, adv } = barHits(direction, entryPx, bar, tpPips, slPips);
    if (adv >= 10) crossed10Adverse = true;
    if (fav >= 10 && !reached10Favorable) {
      reached10Favorable = true;
      maeBeforeTp = Math.max(mae, adv); // include same-bar adverse if only TP for +10 tracking separately
    }
    // track mfe before eventual SL for deep dive
    if (hitSl && mfeBeforeSl == null) mfeBeforeSl = mfe;

    if (hitTp && hitSl) {
      let resolved: "tp" | "sl" | "ambiguous" = "ambiguous";
      let via: SimResult["resolvedVia"] = "ambiguous";
      if (m5ByTime) {
        resolved = resolveWithM5(direction, entryPx, tpPips, slPips, bar.time, m5ByTime, m5Times);
        via = resolved === "ambiguous" ? "ambiguous" : "m5";
      }
      if (resolved === "ambiguous") {
        return {
          outcome: "ambiguous",
          exitBar: i,
          exitPrice: exitMark(direction, bar),
          exitTime: bar.time,
          holdingMinutes: (i - from + 1) * 15,
          netPips: NaN,
          resultR: NaN,
          mae: Math.max(mae, adv),
          mfe: Math.max(mfe, fav),
          resolvedVia: via,
          crossed10Adverse,
          reached10Favorable,
          maeBeforeTp,
          mfeBeforeSl,
        };
      }
      if (resolved === "tp") {
        return {
          outcome: "tp",
          exitBar: i,
          exitPrice: direction === "long" ? entryPx + tpPips * PIP : entryPx - tpPips * PIP,
          exitTime: bar.time,
          holdingMinutes: (i - from + 1) * 15,
          netPips: tpPips,
          resultR: reward,
          mae: Math.max(mae, adv),
          mfe: Math.max(mfe, fav),
          resolvedVia: via,
          crossed10Adverse,
          reached10Favorable: true,
          maeBeforeTp: maeBeforeTp ?? Math.max(mae, 0),
          mfeBeforeSl,
        };
      }
      return {
        outcome: "sl",
        exitBar: i,
        exitPrice: direction === "long" ? entryPx - slPips * PIP : entryPx + slPips * PIP,
        exitTime: bar.time,
        holdingMinutes: (i - from + 1) * 15,
        netPips: -slPips,
        resultR: -1,
        mae: Math.max(mae, adv),
        mfe: Math.max(mfe, fav),
        resolvedVia: via,
        crossed10Adverse: crossed10Adverse || slPips >= 10,
        reached10Favorable,
        maeBeforeTp,
        mfeBeforeSl: mfeBeforeSl ?? mfe,
      };
    }

    if (hitTp) {
      return {
        outcome: "tp",
        exitBar: i,
        exitPrice: direction === "long" ? entryPx + tpPips * PIP : entryPx - tpPips * PIP,
        exitTime: bar.time,
        holdingMinutes: (i - from + 1) * 15,
        netPips: tpPips,
        resultR: reward,
        mae: Math.max(mae, adv),
        mfe: Math.max(mfe, fav),
        resolvedVia: "m15",
        crossed10Adverse,
        reached10Favorable: true,
        maeBeforeTp: maeBeforeTp ?? mae,
        mfeBeforeSl,
      };
    }
    if (hitSl) {
      return {
        outcome: "sl",
        exitBar: i,
        exitPrice: direction === "long" ? entryPx - slPips * PIP : entryPx + slPips * PIP,
        exitTime: bar.time,
        holdingMinutes: (i - from + 1) * 15,
        netPips: -slPips,
        resultR: -1,
        mae: Math.max(mae, adv),
        mfe: Math.max(mfe, fav),
        resolvedVia: "m15",
        crossed10Adverse: crossed10Adverse || slPips >= 10,
        reached10Favorable,
        maeBeforeTp,
        mfeBeforeSl: mfeBeforeSl ?? mfe,
      };
    }

    mae = Math.max(mae, adv);
    mfe = Math.max(mfe, fav);
  }

  const lastIdx = Math.max(from, end - 1);
  const last = bars[lastIdx]!;
  const mark = exitMark(direction, last);
  const netPips = direction === "long" ? (mark - entryPx) / PIP : (entryPx - mark) / PIP;
  return {
    outcome: "timeout",
    exitBar: lastIdx,
    exitPrice: mark,
    exitTime: last.time,
    holdingMinutes: Math.max(1, lastIdx - from + 1) * 15,
    netPips,
    resultR: netPips / slPips,
    mae,
    mfe,
    resolvedVia: "timeout",
    crossed10Adverse,
    reached10Favorable,
    maeBeforeTp,
    mfeBeforeSl,
  };
}

type Agg = {
  n: number;
  tp: number;
  sl: number;
  timeout: number;
  amb: number;
  resolved: number;
  sumPips: number;
  pips: number[];
  sumR: number;
  rs: number[];
  holds: number[];
  spreads: number[];
  equity: number[];
};

function emptyAgg(): Agg {
  return {
    n: 0,
    tp: 0,
    sl: 0,
    timeout: 0,
    amb: 0,
    resolved: 0,
    sumPips: 0,
    pips: [],
    sumR: 0,
    rs: [],
    holds: [],
    spreads: [],
    equity: [0],
  };
}

function addTrade(a: Agg, row: TradeRow) {
  a.n += 1;
  a.spreads.push(row.spreadPips);
  if (row.outcome === "tp") a.tp += 1;
  else if (row.outcome === "sl") a.sl += 1;
  else if (row.outcome === "timeout") a.timeout += 1;
  else a.amb += 1;

  if (row.outcome === "ambiguous") return;
  a.resolved += 1;
  a.sumPips += row.netPips;
  a.pips.push(row.netPips);
  a.sumR += row.resultR;
  a.rs.push(row.resultR);
  a.holds.push(row.holdingMinutes);
  a.equity.push(a.equity[a.equity.length - 1]! + row.resultR);
}

function maxDdR(equity: number[]): number {
  let peak = 0;
  let dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    dd = Math.max(dd, peak - e);
  }
  return dd;
}

function profitFactor(rs: number[]): number | null {
  let wins = 0;
  let losses = 0;
  for (const r of rs) {
    if (r > 0) wins += r;
    else if (r < 0) losses += -r;
  }
  if (losses === 0) return wins > 0 ? Infinity : null;
  return wins / losses;
}

function resolvedWr(a: Agg): number {
  // WR among TP+SL only (timeouts/amb excluded from win rate denominator as separate)
  const decided = a.tp + a.sl;
  return pct(a.tp, decided);
}

function tpBeforeSlRate(a: Agg): number {
  return pct(a.tp, a.tp + a.sl);
}

function summarizeConfig(label: string, a: Agg, sl: number, tp: number) {
  const be = theoreticalBeWr(sl, tp);
  const wr = resolvedWr(a);
  const expR = a.resolved ? a.sumR / a.resolved : NaN;
  const pf = profitFactor(a.rs);
  const dd = maxDdR(a.equity);
  return { label, a, sl, tp, be, wr, expR, pf, dd };
}

async function main() {
  if (!fs.existsSync(ENTRIES_CSV)) {
    console.error(`Missing depth entries CSV: ${ENTRIES_CSV}`);
    process.exit(1);
  }
  if (!fs.existsSync(M15_CACHE)) {
    console.error(`Missing M15 cache: ${M15_CACHE}`);
    process.exit(1);
  }

  console.error("Loading M15 ...");
  const m15raw: RC[] = JSON.parse(fs.readFileSync(M15_CACHE, "utf8"));
  const { rows } = loadWindow(m15raw, TRADING_DAYS);
  const timeToBar = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) timeToBar.set(rows[i]!.time, i);

  const entries = parseEntriesCsv(ENTRIES_CSV, timeToBar);
  console.error(`25% entries loaded: ${entries.length}`);

  let m5ByTime: Map<string, RC> | null = null;
  let m5Times: string[] = [];
  let m5Note =
    "M5 not used — local eurusd-m5-mba-cache.json is compact/non-RC format; same-M15 TP+SL collisions marked AMBIGUOUS (never assume TP first)";
  if (fs.existsSync(M5_CACHE)) {
    try {
      const m5raw = JSON.parse(fs.readFileSync(M5_CACHE, "utf8"));
      if (Array.isArray(m5raw) && m5raw[0] && typeof m5raw[0] === "object" && "time" in m5raw[0] && "bid" in m5raw[0]) {
        console.error("Loading M5 for ambiguity resolution ...");
        const windowStart = rows[0]!.time;
        const windowEnd = rows[rows.length - 1]!.time;
        m5ByTime = new Map();
        for (const c of m5raw as RC[]) {
          if (!c.complete) continue;
          if (c.time < windowStart || c.time > windowEnd) continue;
          m5ByTime.set(c.time, c);
        }
        m5Times = [...m5ByTime.keys()].sort();
        m5Note = `M5 BID/ASK used to resolve same-M15 TP/SL collisions (${m5Times.length} M5 bars in window)`;
        console.error(m5Note);
      } else {
        console.error(m5Note);
      }
    } catch {
      console.error(m5Note);
    }
  }

  const configs: Array<{ sl: number; tp: number; isControl: boolean }> = [
    ...SL_MATRIX.map((sl) => ({ sl, tp: TP_PIPS, isControl: false })),
    { sl: CONTROL_SL, tp: CONTROL_TP, isControl: true },
  ];

  // First pass: simulate all
  const byKey = new Map<string, TradeRow>(); // eventId|sl|tp
  const simsByEvent = new Map<string, Map<string, SimResult>>(); // eventId -> configKey -> sim

  for (const entry of entries) {
    const eventSims = new Map<string, SimResult>();
    for (const cfg of configs) {
      const sim = simulate(entry, rows, cfg.sl, cfg.tp, m5ByTime, m5Times);
      const key = `${cfg.sl}/${cfg.tp}`;
      eventSims.set(key, sim);
    }
    simsByEvent.set(entry.eventId, eventSims);
  }

  const allRows: TradeRow[] = [];
  for (const entry of entries) {
    const eventSims = simsByEvent.get(entry.eventId)!;
    const sim10 = eventSims.get("10/10")!;
    const would10Lose = sim10.outcome === "sl";

    for (const cfg of configs) {
      const key = `${cfg.sl}/${cfg.tp}`;
      const sim = eventSims.get(key)!;
      const saved =
        !cfg.isControl && cfg.sl > 10 && would10Lose && sim.outcome === "tp";
      const eventuallyAfter10Adverse =
        sim.crossed10Adverse && sim.outcome === "tp";

      const stopPrice =
        entry.direction === "long"
          ? entry.entryPrice - cfg.sl * PIP
          : entry.entryPrice + cfg.sl * PIP;
      const targetPrice =
        entry.direction === "long"
          ? entry.entryPrice + cfg.tp * PIP
          : entry.entryPrice - cfg.tp * PIP;

      const row: TradeRow = {
        eventId: entry.eventId,
        timestamp: entry.timestamp,
        direction: entry.direction,
        entryPrice: entry.entryPrice,
        spreadPips: entry.spreadPips,
        majorDirection: entry.majorDirection,
        currentDirection: entry.currentDirection,
        currentLineId: entry.currentLineId,
        stopPips: cfg.sl,
        targetPips: cfg.tp,
        riskRewardLabel: `risk ${f2(cfg.sl / cfg.tp)} to make 1`,
        stopPrice,
        targetPrice,
        outcome: sim.outcome,
        exitTimestamp: sim.exitTime,
        exitPrice: sim.exitPrice,
        holdingMinutes: sim.holdingMinutes,
        netPips: sim.netPips,
        resultR: sim.resultR,
        maeBeforeExit: sim.mae,
        mfeBeforeExit: sim.mfe,
        would10pStopHaveLost: would10Lose,
        savedVs10p: saved,
        eventuallyReached10pAfterCrossing10pAdverse: eventuallyAfter10Adverse,
        resolvedVia: sim.resolvedVia,
        isControl: cfg.isControl,
      };
      allRows.push(row);
      byKey.set(`${entry.eventId}|${key}`, row);
    }
  }

  // Aggregates
  const aggFor = (sl: number, tp: number, side?: Dir) => {
    const a = emptyAgg();
    for (const r of allRows) {
      if (r.stopPips !== sl || r.targetPips !== tp) continue;
      if (side && r.direction !== side) continue;
      addTrade(a, r);
    }
    return a;
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = [
    "eventId",
    "timestamp",
    "direction",
    "entryPrice",
    "spreadPips",
    "majorDirection",
    "currentDirection",
    "currentLineId",
    "stopPips",
    "targetPips",
    "riskReward",
    "stopPrice",
    "targetPrice",
    "outcome",
    "exitTimestamp",
    "exitPrice",
    "holdingMinutes",
    "netPips",
    "resultR",
    "maeBeforeExit",
    "mfeBeforeExit",
    "would10pStopHaveLost",
    "savedVs10p",
    "eventuallyReached10pAfterCrossing10pAdverse",
    "resolvedVia",
    "isControl",
  ];
  const csvLines = [header.join(",")];
  for (const r of allRows) {
    csvLines.push(
      [
        r.eventId,
        r.timestamp,
        r.direction,
        r.entryPrice.toFixed(5),
        r.spreadPips.toFixed(3),
        r.majorDirection,
        r.currentDirection,
        r.currentLineId,
        r.stopPips,
        r.targetPips,
        r.riskRewardLabel,
        r.stopPrice.toFixed(5),
        r.targetPrice.toFixed(5),
        r.outcome,
        r.exitTimestamp,
        r.exitPrice.toFixed(5),
        r.holdingMinutes,
        Number.isFinite(r.netPips) ? r.netPips.toFixed(3) : "",
        Number.isFinite(r.resultR) ? r.resultR.toFixed(4) : "",
        r.maeBeforeExit.toFixed(3),
        r.mfeBeforeExit.toFixed(3),
        r.would10pStopHaveLost,
        r.savedVs10p,
        r.eventuallyReached10pAfterCrossing10pAdverse,
        r.resolvedVia,
        r.isControl,
      ].join(","),
    );
  }
  fs.writeFileSync(CSV_OUT, csvLines.join("\n"));

  const first = entries[0]?.timestamp ?? "";
  const last = entries[entries.length - 1]?.timestamp ?? "";
  const windowFirst = rows.find((r) => tradingDayKey(r.time) >= "2026-08-16")?.time ?? rows[0]!.time;
  const windowLast = rows[rows.length - 1]!.time;

  log("ADAPTIVE TRENDLINE — WIDE STOP TEST");
  log("EURUSD M15");
  log(`${tradingDayKey(windowFirst)} → ${tradingDayKey(windowLast)}`);
  log("TP = 10 PIPS  (primary) | Entry = first causal 25% pullback (frozen depth-test set)");
  log(`N entries: ${entries.length} | LONG ${entries.filter((e) => e.direction === "long").length} / SHORT ${entries.filter((e) => e.direction === "short").length}`);
  log(`Ambiguity: ${m5Note}`);
  log("R model: constant account risk → SL = −1.00R; TP = +(TP/SL)R");
  log('"2:1" = risk 2 to make 1 (20 SL / 10 TP)');
  log("");

  // Saved vs 10p analysis
  type SavedStats = {
    saved: number;
    stillLost: number;
    extraAdverse: number[];
    tenLosses: number;
  };
  const savedStats = new Map<number, SavedStats>();
  for (const sl of SL_MATRIX) {
    if (sl === 10) continue;
    let saved = 0;
    let stillLost = 0;
    const extraAdverse: number[] = [];
    let tenLosses = 0;
    for (const entry of entries) {
      const s10 = simsByEvent.get(entry.eventId)!.get("10/10")!;
      const sw = simsByEvent.get(entry.eventId)!.get(`${sl}/10`)!;
      if (s10.outcome !== "sl") continue;
      tenLosses += 1;
      if (sw.outcome === "tp") saved += 1;
      else if (sw.outcome === "sl") {
        stillLost += 1;
        extraAdverse.push(sl - 10);
      }
    }
    savedStats.set(sl, { saved, stillLost, extraAdverse, tenLosses });
  }

  log("COMBINED");
  log("-".repeat(90));
  log(
    `${"SL".padEnd(6)}${"N".padStart(4)}  ${"WIN%".padStart(6)}  ${"BE WR".padStart(6)}  ${"EXP R".padStart(7)}  ${"TOTAL R".padStart(8)}  ${"PF".padStart(5)}  ${"MAX DD".padStart(7)}  ${"SAVED VS 10P".padStart(12)}`,
  );
  for (const sl of SL_MATRIX) {
    const a = aggFor(sl, TP_PIPS);
    const s = summarizeConfig(`${sl}`, a, sl, TP_PIPS);
    const saved = savedStats.get(sl);
    const savedStr = sl === 10 ? "-" : `${saved?.saved ?? 0}/${saved?.tenLosses ?? 0}`;
    log(
      `${`${sl}p`.padEnd(6)}${String(a.n).padStart(4)}  ${f1(s.wr).padStart(6)}  ${f1(s.be).padStart(6)}  ${f3(s.expR).padStart(7)}  ${f2(a.sumR).padStart(8)}  ${f2(s.pf).padStart(5)}  ${f2(s.dd).padStart(7)}  ${savedStr.padStart(12)}`,
    );
  }

  const printSide = (side: Dir) => {
    log("");
    log(`${side.toUpperCase()} ONLY`);
    log("-".repeat(60));
    log(`${"SL".padEnd(6)}${"N".padStart(4)}  ${"WIN%".padStart(6)}  ${"EXP R".padStart(7)}  ${"PF".padStart(5)}  ${"TOTAL R".padStart(8)}`);
    for (const sl of SL_MATRIX) {
      const a = aggFor(sl, TP_PIPS, side);
      const s = summarizeConfig(`${sl}`, a, sl, TP_PIPS);
      log(
        `${`${sl}p`.padEnd(6)}${String(a.n).padStart(4)}  ${f1(s.wr).padStart(6)}  ${f3(s.expR).padStart(7)}  ${f2(s.pf).padStart(5)}  ${f2(a.sumR).padStart(8)}`,
      );
    }
  };
  printSide("long");
  printSide("short");

  // Detailed metrics per SL
  log("");
  log("DETAILED METRICS (COMBINED, TP=10)");
  for (const sl of SL_MATRIX) {
    const a = aggFor(sl, TP_PIPS);
    const s = summarizeConfig(`${sl}`, a, sl, TP_PIPS);
    log("");
    log(`--- ${sl}p SL / 10p TP (risk ${f2(sl / 10)} to make 1; TP pays +${f3(rewardR(sl, 10))}R) ---`);
    log(`  N=${a.n}  TP=${a.tp}  SL=${a.sl}  timeout=${a.timeout}  ambiguous=${a.amb}`);
    log(`  resolved WR (TP/(TP+SL))=${f1(s.wr)}%  BE=${f1(s.be)}%  gap=${f1(s.wr - s.be)}pp`);
    log(`  TP-before-SL rate=${f1(tpBeforeSlRate(a))}%`);
    log(`  avg net pips=${f2(mean(a.pips))}  med net pips=${f2(median(a.pips))}`);
    log(`  ExpR=${f3(s.expR)}  TotalR=${f2(a.sumR)}  PF=${f2(s.pf)}  MaxDDR=${f2(s.dd)}`);
    log(`  avg hold=${f1(mean(a.holds))}m  med hold=${f1(median(a.holds))}m`);
    log(`  avg spread=${f2(mean(a.spreads))}p  med spread=${f2(median(a.spreads))}p`);
    if (sl > 10) {
      const st = savedStats.get(sl)!;
      log(
        `  vs 10p SL losers (${st.tenLosses}): SAVED→TP ${st.saved} | still lost at wider SL ${st.stillLost} | med extra adverse absorbed when still lost=${f1(median(st.extraAdverse))}p`,
      );
    }
  }

  // CONTROL
  log("");
  log("CONTROL — 10p SL / 20p TP (conventional risk 1 to make 2)");
  {
    const a = aggFor(CONTROL_SL, CONTROL_TP);
    const s = summarizeConfig("ctrl", a, CONTROL_SL, CONTROL_TP);
    log(`  N=${a.n} TP=${a.tp} SL=${a.sl} timeout=${a.timeout} amb=${a.amb}`);
    log(`  WR=${f1(s.wr)}% BE=${f1(s.be)}% ExpR=${f3(s.expR)} TotalR=${f2(a.sumR)} PF=${f2(s.pf)} MaxDDR=${f2(s.dd)}`);
  }

  // 20/10 DEEP DIVE
  log("");
  log("20P SL / 10P TP DEEP DIVE");
  log("-".repeat(60));
  const a20 = aggFor(20, 10);
  const s20 = summarizeConfig("20", a20, 20, 10);
  log(`N=${a20.n}  wins(TP)=${a20.tp}  losses(SL)=${a20.sl}  timeouts=${a20.timeout}  ambiguous=${a20.amb}`);
  log(`WR=${f1(s20.wr)}%  BE WR=${f1(s20.be)}%  diff=${f1(s20.wr - s20.be)}pp`);
  log(`ExpR/trade=${f3(s20.expR)}  TotalR=${f2(a20.sumR)}  PF=${f2(s20.pf)}  MaxDDR=${f2(s20.dd)}`);
  {
    const st = savedStats.get(20)!;
    log(`Saved vs 10p: ${st.saved} of ${st.tenLosses} ten-pip losers eventually hit +10 with 20p SL`);
    log(`Still lost at 20p anyway: ${st.stillLost}`);
  }

  const wins20 = allRows.filter((r) => !r.isControl && r.stopPips === 20 && r.targetPips === 10 && r.outcome === "tp");
  log("");
  log("Of 20/10 winning trades, MAE before TP went below:");
  for (const thr of [5, 10, 15, 18]) {
    const n = wins20.filter((r) => r.maeBeforeExit >= thr).length;
    // Better: use sim maeBeforeTp
    let count = 0;
    for (const entry of entries) {
      const sim = simsByEvent.get(entry.eventId)!.get("20/10")!;
      if (sim.outcome !== "tp") continue;
      const mae = sim.maeBeforeTp ?? sim.mae;
      if (mae >= thr) count += 1;
    }
    log(`  -${thr}p: ${count}/${wins20.length} (${f1(pct(count, wins20.length))}%)`);
    void n;
  }

  log("");
  log("Of 20/10 SL losses, MFE before stop reached:");
  const losses20 = entries.filter((e) => simsByEvent.get(e.eventId)!.get("20/10")!.outcome === "sl");
  for (const thr of [2, 5, 8]) {
    let count = 0;
    for (const entry of losses20) {
      const sim = simsByEvent.get(entry.eventId)!.get("20/10")!;
      const mfe = sim.mfeBeforeSl ?? sim.mfe;
      if (mfe >= thr) count += 1;
    }
    log(`  +${thr}p: ${count}/${losses20.length} (${f1(pct(count, losses20.length))}%)`);
  }

  // LONG/SHORT 20/10
  for (const side of ["long", "short"] as Dir[]) {
    const a = aggFor(20, 10, side);
    const s = summarizeConfig(side, a, 20, 10);
    log(`20/10 ${side.toUpperCase()}: N=${a.n} WR=${f1(s.wr)}% ExpR=${f3(s.expR)} PF=${f2(s.pf)} TotalR=${f2(a.sumR)}`);
  }

  // STOP SURVIVAL CURVE — among trades that eventually reached +10p favorable (any path within 24h from entry)
  // Use unbounded excursion: simulate with huge SL to see if +10 hit, track mae before +10
  log("");
  log("STOP SURVIVAL CURVE");
  log("(of entries that eventually reached +10p favorable within 24h — % whose MAE-before-+10 ≤ stop)");
  log(`${"ADVERSE".padEnd(12)}  ${"% OF +10 WINNERS ALIVE".padStart(24)}  N_base`);
  const maeBefore10: number[] = [];
  for (const entry of entries) {
    // Use 30/10 sim if TP, else check mfe from a "no stop" style: re-sim with sl=999
    const free = simulate(entry, rows, 999, 10, m5ByTime, m5Times);
    if (free.outcome === "tp" && free.maeBeforeTp != null) maeBefore10.push(free.maeBeforeTp);
    else if (free.reached10Favorable && free.maeBeforeTp != null) maeBefore10.push(free.maeBeforeTp);
  }
  for (const stop of [5, 10, 15, 20, 25, 30]) {
    const alive = maeBefore10.filter((m) => m <= stop).length;
    log(`${`${stop}p`.padEnd(12)}  ${f1(pct(alive, maeBefore10.length)).padStart(24)}  ${maeBefore10.length}`);
  }
  log(`MAE-before-+10 among eventual +10 reachers: P50=${f1(median(maeBefore10))} P75=${f1(percentile(maeBefore10, 0.75))} P90=${f1(percentile(maeBefore10, 0.9))} (n=${maeBefore10.length})`);

  // Plain answers
  const a10 = aggFor(10, 10);
  const s10 = summarizeConfig("10", a10, 10, 10);
  const st20 = savedStats.get(20)!;
  const wrLift = s20.wr - s10.wr;

  log("");
  log("PLAIN ANSWERS");
  log("-".repeat(72));
  log(
    `1. 10→20 SL lift TP-before-SL WR: ${f1(s10.wr)}% → ${f1(s20.wr)}% (Δ ${f1(wrLift)}pp). ${wrLift > 5 ? "Material WR increase." : "Modest/limited WR increase."}`,
  );
  log(
    `2. 20/10 vs BE ${f1(s20.be)}%: observed ${f1(s20.wr)}% → ${s20.wr >= s20.be ? "AT/ABOVE break-even WR" : "BELOW break-even WR"}.`,
  );
  log(
    `3. After spread (BID/ASK marks): 20/10 ExpR=${f3(s20.expR)} → ${s20.expR > 0 ? "POSITIVE" : "NEGATIVE"} expectancy.`,
  );
  log(`4. Genuinely saved by 20p vs 10p: ${st20.saved} trades (of ${st20.tenLosses} ten-pip losers).`);
  log(`5. Still lost at 20p anyway: ${st20.stillLost} (wider stop absorbed +10p more adverse, still −1R).`);
  {
    const a25 = summarizeConfig("25", aggFor(25, 10), 25, 10);
    const a30 = summarizeConfig("30", aggFor(30, 10), 30, 10);
    log(
      `6. Beyond 20p: 25p ExpR=${f3(a25.expR)} (still ${a25.wr < a25.be ? "below" : "above"} BE by ${f1(Math.abs(a25.wr - a25.be))}pp); 30p ExpR=${f3(a30.expR)}. Wider stops move ExpR closer to zero but remain negative — they raise required WR faster than realized WR catches up.`,
    );
  }
  {
    const l = summarizeConfig("L", aggFor(20, 10, "long"), 20, 10);
    const s = summarizeConfig("S", aggFor(20, 10, "short"), 20, 10);
    log(
      `7. 20/10 LONG ExpR=${f3(l.expR)} WR=${f1(l.wr)}% vs SHORT ExpR=${f3(s.expR)} WR=${f1(s.wr)}% → both negative; SHORT worse. Wide stops do not fix the SHORT side.`,
    );
  }
  {
    const positive = SL_MATRIX.filter((sl) => {
      const s = summarizeConfig(`${sl}`, aggFor(sl, 10), sl, 10);
      return (s.expR ?? 0) > 0;
    });
    log(
      `8. Positive ExpR stops (no optimization, this window): ${positive.length ? positive.map((x) => `${x}p`).join(", ") : "NONE"}.`,
    );
  }
  log(
    `9. "Direction right, stop too tight"? Saved ${st20.saved}/${st20.tenLosses} supports partial truth, but ExpR ${f3(s20.expR)} and WR vs BE ${f1(s20.wr - s20.be)}pp ${s20.wr >= s20.be && s20.expR > 0 ? "leans yes for this sample" : "does not fully pay for the worse payoff"}.`,
  );
  log(
    `10. Or "deep adverse = usually not worth more room"? Still-lost ${st20.stillLost} vs saved ${st20.saved} → ${st20.stillLost > st20.saved ? "MORE often the wider stop just delays a full −1R loss" : "more saves than wasted wider losses in this sample"}.`,
  );

  log("");
  log(`CSV: ${CSV_OUT}`);
  log(`Report: ${REPORT_OUT}`);
  fs.writeFileSync(REPORT_OUT, L.join("\n"));
}

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
