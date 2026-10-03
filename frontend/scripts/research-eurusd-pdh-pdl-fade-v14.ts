/**
 * EUR/USD — PDH/PDL BREAK-FADE EXECUTION TEST (V14, research-only).
 *
 * V13 is FROZEN — this script does not modify it.
 *
 * Validates the V13 20%/25% entry cohort first. If counts/return behavior diverge,
 * STOP before TP/SL reporting.
 *
 * PRIMARY TP = broken daily level (PDL for LONG, PDH for SHORT).
 * SECONDARY TP = 25% / 50% inside prior daily range.
 * Stops: fixed 40/60/80/100/120/140p and range-scaled 50/75/100/125/150%.
 * Holds: 24h and 48h. M15 setup, M5 BID/ASK path. Ambiguous if TP+SL same bar.
 */
import fs from "node:fs";
import path from "node:path";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const PIP = pipSizeFor("EUR_USD");
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15C = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5C = path.join(PAD, "eurusd-m5-mba-cache.json");
const D1C = path.join(PAD, "eurusd-d-mid-cache.json");
const OUT_DIR = PAD;

const DEPTHS = [20, 25] as const;
const HOLD_BARS = { h24: 288, h48: 576 } as const; // M5 bars
const VAL_PATH = 576; // V13 behavioral path
const FIXED_STOPS = [40, 60, 80, 100, 120, 140] as const;
const SCALED_STOPS = [50, 75, 100, 125, 150] as const;
const TARGETS = ["broken", "in25", "in50"] as const;
const COHORTS = ["ALL", "30-50", "50-75", "30-75", "75-100", "100+"] as const;

/** V13 frozen reference (20/25% only) — must match closely before continuing. */
const V13_REF: Record<string, { n: number; ret: number }> = {
  "long|20": { n: 1198, ret: 79.3 },
  "long|25": { n: 1081, ret: 75.0 },
  "short|20": { n: 1190, ret: 83.3 },
  "short|25": { n: 1079, ret: 79.5 },
};

type Side = "long" | "short";
type Target = (typeof TARGETS)[number];
type Hold = keyof typeof HOLD_BARS;
type Cohort = (typeof COHORTS)[number];
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type MidBar = { time: string; open: number; high: number; low: number; close: number };
type OC = "win" | "loss" | "timeout" | "ambiguous";

interface DayWin {
  open: string;
  nextOpen: string | null;
  pdh: number;
  pdl: number;
  rangePips: number;
}

interface Entry {
  side: Side;
  depth: number;
  dayOpen: string;
  entryTime: string;
  ei: number;
  entry: number;
  pdh: number;
  pdl: number;
  range: number; // price
  rangePips: number;
  /** V13 behavioral: returned to broken level within VAL_PATH (no stop). */
  valRet: boolean;
}

interface TradeRow {
  side: Side;
  depth: number;
  target: Target;
  stopKind: "fixed" | "scaled";
  stopLabel: string;
  stopPips: number;
  hold: Hold;
  entryTime: string;
  rangePips: number;
  pnl: number;
  oc: OC;
}

const m15: RC[] = JSON.parse(fs.readFileSync(M15C, "utf8"));
const days: MidBar[] = JSON.parse(fs.readFileSync(D1C, "utf8"));
const m5raw: Array<[string, number, number, number, number, number, number]> = JSON.parse(
  fs.readFileSync(M5C, "utf8"),
);
const M = m5raw.length;
const mt: string[] = new Array(M);
const bh = new Float64Array(M),
  bl = new Float64Array(M),
  ah = new Float64Array(M),
  al = new Float64Array(M),
  bc = new Float64Array(M),
  ac = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
  bc[i] = r[5];
  ac[i] = r[6];
}
(m5raw as unknown as { length: number }).length = 0;

const N15 = m15.length;
const t15: string[] = m15.map((c) => c.time);
const m15h = new Float64Array(N15),
  m15l = new Float64Array(N15);
for (let i = 0; i < N15; i++) {
  m15h[i] = m15[i]!.mid.high;
  m15l[i] = m15[i]!.mid.low;
}

function lb(times: string[], t: string): number {
  let lo = 0,
    hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function pct(a: number, b: number): number {
  return b > 0 ? (a / b) * 100 : NaN;
}
function inCohort(rangePips: number, c: Cohort): boolean {
  switch (c) {
    case "ALL":
      return true;
    case "30-50":
      return rangePips >= 30 && rangePips < 50;
    case "50-75":
      return rangePips >= 50 && rangePips < 75;
    case "30-75":
      return rangePips >= 30 && rangePips < 75;
    case "75-100":
      return rangePips >= 75 && rangePips < 100;
    case "100+":
      return rangePips >= 100;
    default: {
      const _e: never = c;
      return _e;
    }
  }
}
function tpLevel(e: Entry, target: Target): number {
  const R = e.range;
  switch (target) {
    case "broken":
      return e.side === "long" ? e.pdl : e.pdh;
    case "in25":
      return e.side === "long" ? e.pdl + 0.25 * R : e.pdh - 0.25 * R;
    case "in50":
      return e.side === "long" ? e.pdl + 0.5 * R : e.pdh - 0.5 * R;
    default: {
      const _e: never = target;
      return _e;
    }
  }
}

// ---- day windows (identical to V13) ----
const wins: DayWin[] = [];
for (let i = 1; i < days.length; i++) {
  const prev = days[i - 1]!;
  const cur = days[i]!;
  const next = i + 1 < days.length ? days[i + 1]! : null;
  const range = prev.high - prev.low;
  if (!(range > 0)) continue;
  wins.push({
    open: cur.time,
    nextOpen: next ? next.time : null,
    pdh: prev.high,
    pdl: prev.low,
    rangePips: range / PIP,
  });
}

// ---- entries (identical V13 logic, depths 20/25 only) ----
const entries: Entry[] = [];
for (const w of wins) {
  if (!w.nextOpen) continue;
  const m15a = lb(t15, w.open);
  const m15b = lb(t15, w.nextOpen);
  if (m15a >= m15b) continue;
  let longBreakBar = -1,
    shortBreakBar = -1;
  for (let j = m15a; j < m15b; j++) {
    if (longBreakBar < 0 && m15l[j]! < w.pdl) longBreakBar = j;
    if (shortBreakBar < 0 && m15h[j]! > w.pdh) shortBreakBar = j;
    if (longBreakBar >= 0 && shortBreakBar >= 0) break;
  }
  const m5DayStart = lb(mt, w.open);
  const m5DayEnd = lb(mt, w.nextOpen);
  if (m5DayStart >= m5DayEnd) continue;
  const R = w.pdh - w.pdl;

  for (const depth of DEPTHS) {
    const pen = (depth / 100) * R;
    if (longBreakBar >= 0) {
      const entryLvl = w.pdl - pen;
      const m5Start = Math.max(m5DayStart, lb(mt, t15[longBreakBar]!));
      let ei = -1;
      for (let k = m5Start; k < m5DayEnd; k++) {
        if (al[k]! <= entryLvl) {
          ei = k;
          break;
        }
      }
      if (ei >= 0) {
        let valRet = false;
        const end = Math.min(ei + VAL_PATH, M - 1);
        for (let k = ei + 1; k <= end; k++) {
          if (bh[k]! >= w.pdl) {
            valRet = true;
            break;
          }
        }
        entries.push({
          side: "long",
          depth,
          dayOpen: w.open,
          entryTime: mt[ei]!,
          ei,
          entry: entryLvl,
          pdh: w.pdh,
          pdl: w.pdl,
          range: R,
          rangePips: w.rangePips,
          valRet,
        });
      }
    }
    if (shortBreakBar >= 0) {
      const entryLvl = w.pdh + pen;
      const m5Start = Math.max(m5DayStart, lb(mt, t15[shortBreakBar]!));
      let ei = -1;
      for (let k = m5Start; k < m5DayEnd; k++) {
        if (bh[k]! >= entryLvl) {
          ei = k;
          break;
        }
      }
      if (ei >= 0) {
        let valRet = false;
        const end = Math.min(ei + VAL_PATH, M - 1);
        for (let k = ei + 1; k <= end; k++) {
          if (al[k]! <= w.pdh) {
            valRet = true;
            break;
          }
        }
        entries.push({
          side: "short",
          depth,
          dayOpen: w.open,
          entryTime: mt[ei]!,
          ei,
          entry: entryLvl,
          pdh: w.pdh,
          pdl: w.pdl,
          range: R,
          rangePips: w.rangePips,
          valRet,
        });
      }
    }
  }
}

// ---- V13 validation ----
const L: string[] = [];
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
L.push("EUR/USD — PDH/PDL BREAK-FADE EXECUTION (V14, research-only)");
L.push("V13 FROZEN — entry/PDH/PDL definition copied exactly; depths restricted to 20/25%.");
L.push("");
L.push("=".repeat(100));
L.push("VALIDATION vs V13 behavioral cohort (20/25%, return-to-broken within ~2d, no stop)");
L.push("=".repeat(100));

let validationOk = true;
for (const side of ["long", "short"] as Side[]) {
  for (const depth of DEPTHS) {
    const list = entries.filter((e) => e.side === side && e.depth === depth);
    const ret = pct(list.filter((e) => e.valRet).length, list.length);
    const key = `${side}|${depth}`;
    const ref = V13_REF[key]!;
    const nOk = list.length === ref.n;
    const retOk = Math.abs(ret - ref.ret) <= 0.6;
    const ok = nOk && retOk;
    if (!ok) validationOk = false;
    L.push(
      `  ${key}: n=${list.length} (V13 ${ref.n})  ret=${f1(ret)}% (V13 ${f1(ref.ret)}%)  ${ok ? "PASS" : "FAIL"}`,
    );
  }
}
L.push(`VALIDATION: ${validationOk ? "PASS — continuing to TP/SL grid." : "FAIL — STOP. Do not trust TP/SL results."}`);
L.push("");

if (!validationOk) {
  const report = L.join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "eurusd-pdh-pdl-fade-v14-report.txt"), report + "\n");
  console.log(report);
  console.error("V13 cohort mismatch — aborted V14 execution grid.");
  process.exit(1);
}

// ---- simulate TP/SL ----
function simulate(
  e: Entry,
  target: Target,
  stopPips: number,
  hold: Hold,
): { pnl: number; oc: OC } {
  const tp = tpLevel(e, target);
  const isLong = e.side === "long";
  const sl = isLong ? e.entry - stopPips * PIP : e.entry + stopPips * PIP;
  const end = Math.min(e.ei + HOLD_BARS[hold], M - 1);
  for (let k = e.ei + 1; k <= end; k++) {
    const tpTouch = isLong ? bh[k]! >= tp : al[k]! <= tp;
    const slTouch = isLong ? bl[k]! <= sl : ah[k]! >= sl;
    if (tpTouch && slTouch) return { pnl: 0, oc: "ambiguous" };
    if (tpTouch) {
      const pnl = isLong ? (tp - e.entry) / PIP : (e.entry - tp) / PIP;
      return { pnl, oc: "win" };
    }
    if (slTouch) return { pnl: -stopPips, oc: "loss" };
  }
  const last = end;
  const pnl = isLong ? (bc[last]! - e.entry) / PIP : (e.entry - ac[last]!) / PIP;
  return { pnl, oc: "timeout" };
}

const trades: TradeRow[] = [];
const stopSpecs: Array<{ kind: "fixed" | "scaled"; label: string; pipsOf: (e: Entry) => number }> = [
  ...FIXED_STOPS.map((p) => ({
    kind: "fixed" as const,
    label: `${p}p`,
    pipsOf: () => p,
  })),
  ...SCALED_STOPS.map((p) => ({
    kind: "scaled" as const,
    label: `${p}%R`,
    pipsOf: (e: Entry) => (p / 100) * e.rangePips,
  })),
];

for (const e of entries) {
  for (const target of TARGETS) {
    for (const stop of stopSpecs) {
      const stopPips = stop.pipsOf(e);
      if (!(stopPips > 0)) continue;
      for (const hold of ["h24", "h48"] as Hold[]) {
        const { pnl, oc } = simulate(e, target, stopPips, hold);
        trades.push({
          side: e.side,
          depth: e.depth,
          target,
          stopKind: stop.kind,
          stopLabel: stop.label,
          stopPips,
          hold,
          entryTime: e.entryTime,
          rangePips: e.rangePips,
          pnl,
          oc,
        });
      }
    }
  }
}

// ---- stats ----
const years =
  (new Date(wins[wins.length - 1]!.open).getTime() - new Date(wins[0]!.open).getTime()) /
  (365.25 * 864e5);
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

interface Stats {
  n: number;
  wins: number;
  losses: number;
  timeouts: number;
  amb: number;
  wr: number;
  avgW: number;
  avgL: number;
  pf: number;
  exp: number;
  total: number;
  dd: number;
  perYr: number;
}

function stats(list: TradeRow[]): Stats {
  const amb = list.filter((t) => t.oc === "ambiguous").length;
  const res = list.filter((t) => t.oc !== "ambiguous");
  const wins = res.filter((t) => t.oc === "win" || (t.oc === "timeout" && t.pnl > 0));
  const losses = res.filter((t) => t.oc === "loss" || (t.oc === "timeout" && t.pnl < 0));
  // WR: wins among decisive win/loss only? User asked Win rate with timeouts included in expectancy.
  // Standard: WR = wins / (wins+losses) where timeout with pnl>0 counts win, pnl<0 loss, pnl==0 neither.
  const flat = res.filter((t) => t.pnl === 0 && t.oc === "timeout");
  const gW = wins.reduce((s, t) => s + t.pnl, 0);
  const gL = -losses.reduce((s, t) => s + t.pnl, 0);
  const total = res.reduce((s, t) => s + t.pnl, 0);
  const seq = [...res].sort((a, b) => (a.entryTime < b.entryTime ? -1 : 1));
  let eq = 0,
    pk = 0,
    dd = 0;
  for (const t of seq) {
    eq += t.pnl;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, pk - eq);
  }
  const decided = wins.length + losses.length;
  return {
    n: res.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: res.filter((t) => t.oc === "timeout").length,
    amb,
    wr: pct(wins.length, decided),
    avgW: mean(wins.map((t) => t.pnl)),
    avgL: mean(losses.map((t) => t.pnl)),
    pf: gL > 0 ? gW / gL : gW > 0 ? Infinity : NaN,
    exp: res.length ? total / res.length : NaN,
    total,
    dd,
    perYr: res.length / years,
  };
}

type Slice = {
  side: "long" | "short" | "both";
  depth: number | "both";
  cohort: Cohort;
  target: Target;
  stopKind: "fixed" | "scaled";
  stopLabel: string;
  hold: Hold;
};

function filterTrades(s: Slice, pool: TradeRow[], entryIndex: Entry[]): TradeRow[] {
  // Map trades back via matching — trades don't carry cohort; filter by joining entry range
  // Easier: filter entries first then we need trades tagged with range — already have rangePips on TradeRow
  return pool.filter((t) => {
    if (s.side !== "both" && t.side !== s.side) return false;
    if (s.depth !== "both" && t.depth !== s.depth) return false;
    if (t.target !== s.target) return false;
    if (t.stopKind !== s.stopKind) return false;
    if (t.stopLabel !== s.stopLabel) return false;
    if (t.hold !== s.hold) return false;
    if (!inCohort(t.rangePips, s.cohort)) return false;
    return true;
  });
}

function row(label: string, s: Stats): string {
  return [
    label.padEnd(52),
    String(s.n).padStart(6),
    String(s.wins).padStart(6),
    String(s.losses).padStart(6),
    String(s.timeouts).padStart(6),
    String(s.amb).padStart(5),
    f1(s.wr).padStart(7),
    f2(s.avgW).padStart(8),
    f2(s.avgL).padStart(8),
    f2(s.pf).padStart(7),
    f2(s.exp).padStart(8),
    f1(s.total).padStart(9),
    f1(s.dd).padStart(8),
    f1(s.perYr).padStart(7),
  ].join("");
}

const HDR = [
  "Cell".padEnd(52),
  "N".padStart(6),
  "Win".padStart(6),
  "Loss".padStart(6),
  "T/O".padStart(6),
  "Amb".padStart(5),
  "WR%".padStart(7),
  "AvgW".padStart(8),
  "AvgL".padStart(8),
  "PF".padStart(7),
  "Exp".padStart(8),
  "Total".padStart(9),
  "MaxDD".padStart(8),
  "/yr".padStart(7),
].join("");

interface CellResult {
  slice: Slice;
  stats: Stats;
  label: string;
}
const allCells: CellResult[] = [];

function labelOf(s: Slice): string {
  const side = s.side === "both" ? "BOTH" : s.side.toUpperCase();
  const dep = s.depth === "both" ? "20+25" : `${s.depth}%`;
  return `${side}|${dep}|${s.cohort}|${s.target}|${s.stopLabel}|${s.hold}`;
}

for (const side of ["long", "short", "both"] as const) {
  for (const depth of [20, 25, "both"] as const) {
    for (const cohort of COHORTS) {
      for (const target of TARGETS) {
        for (const stop of stopSpecs) {
          for (const hold of ["h24", "h48"] as Hold[]) {
            const slice: Slice = {
              side,
              depth,
              cohort,
              target,
              stopKind: stop.kind,
              stopLabel: stop.label,
              hold,
            };
            const list = filterTrades(slice, trades, entries);
            if (!list.length) continue;
            const st = stats(list);
            allCells.push({ slice, stats: st, label: labelOf(slice) });
          }
        }
      }
    }
  }
}

// Full CSV of all cells
const cellCsv: string[] = [];
cellCsv.push(
  [
    "side",
    "depth",
    "cohort",
    "target",
    "stop_kind",
    "stop",
    "hold",
    "n",
    "wins",
    "losses",
    "timeouts",
    "ambiguous",
    "wr",
    "avg_win",
    "avg_loss",
    "pf",
    "exp",
    "total_pips",
    "max_dd",
    "per_year",
  ].join(","),
);
for (const c of allCells) {
  const s = c.slice;
  const st = c.stats;
  cellCsv.push(
    [
      s.side,
      s.depth,
      s.cohort,
      s.target,
      s.stopKind,
      s.stopLabel,
      s.hold,
      st.n,
      st.wins,
      st.losses,
      st.timeouts,
      st.amb,
      f1(st.wr),
      f2(st.avgW),
      f2(st.avgL),
      f2(st.pf),
      f2(st.exp),
      f1(st.total),
      f1(st.dd),
      f1(st.perYr),
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-pdh-pdl-fade-v14-cells.csv"), cellCsv.join("\n") + "\n");

// ---- focused report sections ----
function printGrid(
  title: string,
  pred: (c: CellResult) => boolean,
  limit?: number,
) {
  L.push("#".repeat(140));
  L.push(title);
  L.push("#".repeat(140));
  L.push(HDR);
  const rows = allCells.filter(pred).sort((a, b) => {
    // sort by depth, cohort order, stop, hold
    return a.label.localeCompare(b.label);
  });
  const out = limit ? rows.slice(0, limit) : rows;
  for (const c of out) L.push(row(c.label, c.stats));
  L.push("");
}

// Primary: broken TP, both sides separate + combined, per depth, ALL + key cohorts, all stops, both holds
printGrid(
  "PRIMARY TP = broken PDH/PDL | LONG | depth 20/25 | ALL cohorts × stops × holds",
  (c) =>
    c.slice.side === "long" &&
    c.slice.depth !== "both" &&
    c.slice.target === "broken" &&
    c.slice.cohort === "ALL",
);

printGrid(
  "PRIMARY TP = broken PDH/PDL | SHORT | depth 20/25 | ALL cohorts × stops × holds",
  (c) =>
    c.slice.side === "short" &&
    c.slice.depth !== "both" &&
    c.slice.target === "broken" &&
    c.slice.cohort === "ALL",
);

printGrid(
  "PRIMARY TP = broken | BOTH sides | depth 20/25 | ALL | all stops × holds",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth !== "both" &&
    c.slice.target === "broken" &&
    c.slice.cohort === "ALL",
);

printGrid(
  "PRIMARY TP = broken | BOTH | depth both | by range cohort | fixed+scaled stops | 48h",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === "both" &&
    c.slice.target === "broken" &&
    c.slice.hold === "h48",
);

printGrid(
  "SECONDARY TP = in25 / in50 | BOTH | 20% | ALL | 48h | all stops",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === 20 &&
    c.slice.cohort === "ALL" &&
    c.slice.hold === "h48" &&
    (c.slice.target === "in25" || c.slice.target === "in50"),
);

printGrid(
  "SECONDARY TP = in25 / in50 | BOTH | 25% | ALL | 48h | all stops",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === 25 &&
    c.slice.cohort === "ALL" &&
    c.slice.hold === "h48" &&
    (c.slice.target === "in25" || c.slice.target === "in50"),
);

// Best positive cells: PF>=1.05, exp>0, n>=150 (both) or n>=80 (side)
L.push("=".repeat(140));
L.push("POSITIVE CELLS (exp>0, PF>=1.05) ranked by expectancy — min n: side>=80 / both>=150");
L.push("=".repeat(140));
L.push(HDR);
const positive = allCells
  .filter((c) => {
    const minN = c.slice.side === "both" ? 150 : 80;
    return c.stats.n >= minN && c.stats.exp > 0 && c.stats.pf >= 1.05;
  })
  .sort((a, b) => b.stats.exp - a.stats.exp || b.stats.pf - a.stats.pf);
for (const c of positive.slice(0, 60)) L.push(row(c.label, c.stats));
if (!positive.length) L.push("  (none)");
L.push("");

// Compact decision helpers
function bestFor(
  title: string,
  pred: (c: CellResult) => boolean,
  minN: number,
) {
  L.push(`-- ${title} --`);
  const pool = allCells.filter((c) => pred(c) && c.stats.n >= minN);
  if (!pool.length) {
    L.push("  no cells");
    return;
  }
  const byExp = [...pool].sort((a, b) => b.stats.exp - a.stats.exp)[0]!;
  const byPf = [...pool].sort((a, b) => b.stats.pf - a.stats.pf)[0]!;
  L.push(
    `  best Exp: ${byExp.label}  exp=${f2(byExp.stats.exp)} PF=${f2(byExp.stats.pf)} n=${byExp.stats.n} DD=${f1(byExp.stats.dd)}`,
  );
  L.push(
    `  best PF:  ${byPf.label}  exp=${f2(byPf.stats.exp)} PF=${f2(byPf.stats.pf)} n=${byPf.stats.n} DD=${f1(byPf.stats.dd)}`,
  );
}

L.push("=".repeat(140));
L.push("DECISION HELPERS (broken TP focus unless noted)");
L.push("=".repeat(140));
bestFor(
  "20% vs 25% (BOTH, ALL, broken, any stop/hold)",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth !== "both" &&
    c.slice.cohort === "ALL" &&
    c.slice.target === "broken",
  200,
);
bestFor(
  "24h vs 48h (BOTH, 20%, ALL, broken)",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === 20 &&
    c.slice.cohort === "ALL" &&
    c.slice.target === "broken",
  200,
);
bestFor(
  "30-75 vs 100+ (BOTH, depth both, broken, 48h)",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === "both" &&
    c.slice.target === "broken" &&
    c.slice.hold === "h48" &&
    (c.slice.cohort === "30-75" || c.slice.cohort === "100+"),
  100,
);
bestFor(
  "LONG only broken ALL",
  (c) => c.slice.side === "long" && c.slice.depth !== "both" && c.slice.cohort === "ALL" && c.slice.target === "broken",
  80,
);
bestFor(
  "SHORT only broken ALL",
  (c) => c.slice.side === "short" && c.slice.depth !== "both" && c.slice.cohort === "ALL" && c.slice.target === "broken",
  80,
);
bestFor(
  "broken vs in25 vs in50 (BOTH, 20%, ALL, 48h)",
  (c) =>
    c.slice.side === "both" &&
    c.slice.depth === 20 &&
    c.slice.cohort === "ALL" &&
    c.slice.hold === "h48",
  200,
);
L.push("");

// Summary counts
L.push(`Entries: ${entries.length}. Trade sims stored: ${trades.length}. Cells: ${allCells.length}.`);
L.push(`Positive cells (filters above): ${positive.length}.`);
L.push("Full cell grid: eurusd-pdh-pdl-fade-v14-cells.csv");
L.push("No final strategy. No trend filter. PDH/PDL definition unchanged from V13.");

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-pdh-pdl-fade-v14-report.txt"), report + "\n");
console.log(report);
console.error(
  `[written] eurusd-pdh-pdl-fade-v14-report.txt | eurusd-pdh-pdl-fade-v14-cells.csv (${allCells.length} cells)`,
);
