/**
 * EUR/USD — PREVIOUS DAILY HIGH/LOW BREAK-FADE (V13, research-only, NEW system).
 *
 * Independent of V11/V12 S/R-reversal work. Do not modify V12.
 *
 * Question: After price breaks the previous completed Daily High/Low by X% of
 * yesterday's range, how often does it rotate back through yesterday's range?
 *
 * Levels (no lookahead): for trading day D, PDH/PDL = high/low of the previous
 * COMPLETED daily candle only. Never today's developing H/L.
 *
 * LONG: break below PDL; entry at depth% of (PDH-PDL) below PDL.
 * SHORT: break above PDH; entry at depth% of (PDH-PDL) above PDH.
 * Depths: 20/25/30/35%. Behavioral targets: return to broken level, 25/50/60/70/100%.
 *
 * Detection: M15 mid confirms a same-day break of PDH/PDL.
 * Path: M5 BID/ASK (LONG enter ASK / mark BID; SHORT enter BID / mark ASK).
 * No stop optimization in V13.
 */
import fs from "node:fs";
import path from "node:path";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT = "EUR_USD";
const PIP = pipSizeFor(INSTRUMENT);
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15C = path.join(PAD, "eurusd-m15-mba-cache.json");
const M5C = path.join(PAD, "eurusd-m5-mba-cache.json");
const D1C = path.join(PAD, "eurusd-d-mid-cache.json");
const OUT_DIR = PAD;

const DEPTHS = [20, 25, 30, 35] as const;
const PATH_M5 = 576; // ~2 calendar days of M5 path after entry
const RANGE_BUCKETS: Array<{ key: string; lo: number; hi: number }> = [
  { key: "0-30", lo: 0, hi: 30 },
  { key: "30-50", lo: 30, hi: 50 },
  { key: "50-75", lo: 50, hi: 75 },
  { key: "75-100", lo: 75, hi: 100 },
  { key: "100+", lo: 100, hi: Infinity },
];

type Side = "long" | "short";
type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC; bid: OHLC; ask: OHLC };
type MidBar = { time: string; open: number; high: number; low: number; close: number };

interface DayWin {
  /** Open time of current daily candle (session start). */
  open: string;
  /** Open time of next daily candle (exclusive end), or null if last. */
  nextOpen: string | null;
  pdh: number;
  pdl: number;
  rangePips: number;
}

interface Event {
  side: Side;
  depth: number;
  dayOpen: string;
  entryTime: string;
  entry: number;
  pdh: number;
  pdl: number;
  rangePips: number;
  bucket: string;
  /** Behavioral reach flags (failures stay in denominator). */
  retBroken: boolean;
  r25: boolean;
  r50: boolean;
  r60: boolean;
  r70: boolean;
  r100: boolean;
  maePips: number;
  mfePips: number;
  /** Minutes to milestone; NaN if never reached within path. */
  tRetMin: number;
  t50Min: number;
  t60Min: number;
  t70Min: number;
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
  al = new Float64Array(M);
for (let i = 0; i < M; i++) {
  const r = m5raw[i]!;
  mt[i] = r[0];
  bh[i] = r[1];
  bl[i] = r[2];
  ah[i] = r[3];
  al[i] = r[4];
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
function bucketOf(rangePips: number): string {
  for (const b of RANGE_BUCKETS) if (rangePips >= b.lo && rangePips < b.hi) return b.key;
  return "100+";
}
function pct(a: number, b: number): number {
  return b > 0 ? (a / b) * 100 : NaN;
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos),
    hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - pos) + sorted[hi]! * (pos - lo);
}
function median(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return quantile(s, 0.5);
}
function p75(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return quantile(s, 0.75);
}
function p90(xs: number[]): number {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return quantile(s, 0.9);
}

// Build day windows: session i uses COMPLETED day i-1 for PDH/PDL.
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

const events: Event[] = [];
/** Eligible trading days with a full next-open bound (needed for same-day M15 scan). */
let eligibleDays = 0;
const brokeLongDays = new Set<string>();
const brokeShortDays = new Set<string>();

for (const w of wins) {
  if (!w.nextOpen) continue; // need a closed session window
  eligibleDays++;
  const m15a = lb(t15, w.open);
  const m15b = lb(t15, w.nextOpen);
  if (m15a >= m15b) continue;

  let longBreakBar = -1;
  let shortBreakBar = -1;
  for (let j = m15a; j < m15b; j++) {
    if (longBreakBar < 0 && m15l[j]! < w.pdl) longBreakBar = j;
    if (shortBreakBar < 0 && m15h[j]! > w.pdh) shortBreakBar = j;
    if (longBreakBar >= 0 && shortBreakBar >= 0) break;
  }
  if (longBreakBar >= 0) brokeLongDays.add(w.open);
  if (shortBreakBar >= 0) brokeShortDays.add(w.open);

  const m5DayStart = lb(mt, w.open);
  const m5DayEnd = lb(mt, w.nextOpen); // exclusive
  if (m5DayStart >= m5DayEnd) continue;

  for (const depth of DEPTHS) {
    const pen = (depth / 100) * (w.pdh - w.pdl);

    // LONG: M15 mid first broke PDL; M5 from that M15 bar's open resolves entry ordering.
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
        events.push(simulate("long", depth, w, entryLvl, ei));
      }
    }

    // SHORT: M15 mid first broke PDH; M5 from that M15 bar's open resolves entry ordering.
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
        events.push(simulate("short", depth, w, entryLvl, ei));
      }
    }
  }
}

function simulate(side: Side, depth: number, w: DayWin, entry: number, ei: number): Event {
  const R = w.pdh - w.pdl;
  const broken = side === "long" ? w.pdl : w.pdh;
  const lvl = (p: number) => (side === "long" ? w.pdl + p * R : w.pdh - p * R);
  const t25 = lvl(0.25),
    t50 = lvl(0.5),
    t60 = lvl(0.6),
    t70 = lvl(0.7),
    t100 = lvl(1.0);

  const end = Math.min(ei + PATH_M5, M - 1);
  let mae = 0,
    mfe = 0;
  let retBroken = false,
    r25 = false,
    r50 = false,
    r60 = false,
    r70 = false,
    r100 = false;
  let tRetMin = NaN,
    t50Min = NaN,
    t60Min = NaN,
    t70Min = NaN;

  for (let k = ei + 1; k <= end; k++) {
    const mins = (k - ei) * 5;
    if (side === "long") {
      mae = Math.max(mae, (entry - bl[k]!) / PIP);
      mfe = Math.max(mfe, (bh[k]! - entry) / PIP);
      if (!retBroken && bh[k]! >= broken) {
        retBroken = true;
        tRetMin = mins;
      }
      if (!r25 && bh[k]! >= t25) r25 = true;
      if (!r50 && bh[k]! >= t50) {
        r50 = true;
        t50Min = mins;
      }
      if (!r60 && bh[k]! >= t60) {
        r60 = true;
        t60Min = mins;
      }
      if (!r70 && bh[k]! >= t70) {
        r70 = true;
        t70Min = mins;
      }
      if (!r100 && bh[k]! >= t100) r100 = true;
    } else {
      // SHORT: entered BID; adverse = ask rising; favorable = ask falling
      mae = Math.max(mae, (ah[k]! - entry) / PIP);
      mfe = Math.max(mfe, (entry - al[k]!) / PIP);
      if (!retBroken && al[k]! <= broken) {
        retBroken = true;
        tRetMin = mins;
      }
      if (!r25 && al[k]! <= t25) r25 = true;
      if (!r50 && al[k]! <= t50) {
        r50 = true;
        t50Min = mins;
      }
      if (!r60 && al[k]! <= t60) {
        r60 = true;
        t60Min = mins;
      }
      if (!r70 && al[k]! <= t70) {
        r70 = true;
        t70Min = mins;
      }
      if (!r100 && al[k]! <= t100) r100 = true;
    }
  }

  return {
    side,
    depth,
    dayOpen: w.open,
    entryTime: mt[ei]!,
    entry,
    pdh: w.pdh,
    pdl: w.pdl,
    rangePips: w.rangePips,
    bucket: bucketOf(w.rangePips),
    retBroken,
    r25,
    r50,
    r60,
    r70,
    r100,
    maePips: mae,
    mfePips: mfe,
    tRetMin,
    t50Min,
    t60Min,
    t70Min,
  };
}

// ---- reporting ----
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");

interface Agg {
  n: number;
  triggerPct: number;
  ret: number;
  r25: number;
  r50: number;
  r60: number;
  r70: number;
  r100: number;
  maeMed: number;
  maeP75: number;
  maeP90: number;
  mfeMed: number;
  tRetMed: number;
  t50Med: number;
  t60Med: number;
  t70Med: number;
}

function aggregate(list: Event[], denomDays: number): Agg {
  const n = list.length;
  return {
    n,
    triggerPct: pct(n, denomDays),
    ret: pct(list.filter((e) => e.retBroken).length, n),
    r25: pct(list.filter((e) => e.r25).length, n),
    r50: pct(list.filter((e) => e.r50).length, n),
    r60: pct(list.filter((e) => e.r60).length, n),
    r70: pct(list.filter((e) => e.r70).length, n),
    r100: pct(list.filter((e) => e.r100).length, n),
    maeMed: median(list.map((e) => e.maePips)),
    maeP75: p75(list.map((e) => e.maePips)),
    maeP90: p90(list.map((e) => e.maePips)),
    mfeMed: median(list.map((e) => e.mfePips)),
    tRetMed: median(list.map((e) => e.tRetMin)),
    t50Med: median(list.map((e) => e.t50Min)),
    t60Med: median(list.map((e) => e.t60Min)),
    t70Med: median(list.map((e) => e.t70Min)),
  };
}

function row(label: string, a: Agg): string {
  return [
    label.padEnd(14),
    String(a.n).padStart(7),
    f1(a.triggerPct).padStart(8),
    f1(a.ret).padStart(8),
    f1(a.r25).padStart(8),
    f1(a.r50).padStart(8),
    f1(a.r60).padStart(8),
    f1(a.r70).padStart(8),
    f1(a.r100).padStart(8),
    f1(a.maeMed).padStart(8),
    f1(a.maeP75).padStart(8),
    f1(a.maeP90).padStart(8),
    f1(a.mfeMed).padStart(8),
    f0(a.tRetMed).padStart(8),
  ].join("");
}

const HDR = [
  "Group".padEnd(14),
  "Trades".padStart(7),
  "Trig%".padStart(8),
  "RetH/L%".padStart(8),
  "R25%".padStart(8),
  "R50%".padStart(8),
  "R60%".padStart(8),
  "R70%".padStart(8),
  "R100%".padStart(8),
  "MAE50".padStart(8),
  "MAE75".padStart(8),
  "MAE90".padStart(8),
  "MFE50".padStart(8),
  "tRetMed".padStart(8),
].join("");

const L: string[] = [];
const years =
  (new Date(wins[wins.length - 1]!.open).getTime() - new Date(wins[0]!.open).getTime()) /
  (365.25 * 864e5);

L.push("EUR/USD — PREVIOUS DAILY HIGH/LOW BREAK-FADE (V13, research-only)");
L.push(
  `Eligible trading days (completed sessions): ${eligibleDays} (~${f1(years)}y). Path horizon: ${PATH_M5} M5 bars (~2d).`,
);
L.push(
  `Break days (M15 mid): LONG/PDL ${brokeLongDays.size} (${f1(pct(brokeLongDays.size, eligibleDays))}%), SHORT/PDH ${brokeShortDays.size} (${f1(pct(brokeShortDays.size, eligibleDays))}%).`,
);
L.push(
  "Rules: PDH/PDL = previous COMPLETED daily candle only. Entry depth = % of prior daily range beyond broken level.",
);
L.push(
  "M15 mid detects first break of PDH/PDL; M5 BID/ASK from that M15 open fills entry same day (intrabar order). LONG enter ASK / targets on BID; SHORT enter BID / targets on ASK.",
);
L.push("Trig% = entries / eligible days. Reach % keep failures in denominator. tRetMed = median minutes among those that returned.");
L.push("No stop. Behavioral study only — not a strategy.");
L.push("");

for (const side of ["long", "short"] as Side[]) {
  const title = side === "long" ? "LONG FADE (break below PDL, fade up)" : "SHORT FADE (break above PDH, fade down)";
  L.push("#".repeat(130));
  L.push(title);
  L.push("#".repeat(130));
  L.push(HDR);
  for (const d of DEPTHS) {
    const list = events.filter((e) => e.side === side && e.depth === d);
    L.push(row(`depth ${d}%`, aggregate(list, eligibleDays)));
  }
  L.push("");
  L.push(`-- by prior-day range bucket (depth rows nested) --`);
  L.push(HDR);
  for (const b of RANGE_BUCKETS) {
    for (const d of DEPTHS) {
      const list = events.filter((e) => e.side === side && e.depth === d && e.bucket === b.key);
      // Trigger denom for bucket = eligible days in that bucket
      const denom = wins.filter((w) => w.nextOpen && bucketOf(w.rangePips) === b.key).length;
      L.push(row(`${b.key}|${d}%`, aggregate(list, denom)));
    }
    L.push("");
  }
}

// Extra: time-to-target medians table
L.push("=".repeat(130));
L.push("TIME TO TARGET (median minutes among events that reached; '-' if none)");
L.push("=".repeat(130));
L.push(
  ["Side", "Depth", "n", "tRet", "t50", "t60", "t70"].map((s) => s.padStart(10)).join(""),
);
for (const side of ["long", "short"] as Side[]) {
  for (const d of DEPTHS) {
    const list = events.filter((e) => e.side === side && e.depth === d);
    const a = aggregate(list, eligibleDays);
    L.push(
      [side, `${d}%`, `${a.n}`, f0(a.tRetMed), f0(a.t50Med), f0(a.t60Med), f0(a.t70Med)]
        .map((x) => x.padStart(10))
        .join(""),
    );
  }
}
L.push("");

// Range-bucket day counts
L.push("=".repeat(130));
L.push("PRIOR-DAY RANGE DISTRIBUTION (eligible days)");
L.push("=".repeat(130));
for (const b of RANGE_BUCKETS) {
  const n = wins.filter((w) => w.nextOpen && bucketOf(w.rangePips) === b.key).length;
  L.push(`  ${b.key.padEnd(8)} ${n} days (${f1(pct(n, eligibleDays))}%)`);
}

const report = L.join("\n");
fs.writeFileSync(path.join(OUT_DIR, "eurusd-pdh-pdl-fade-v13-report.txt"), report + "\n");
console.log(report);

const csv: string[] = [];
csv.push(
  [
    "side",
    "depth_pct",
    "day_open",
    "entry_time",
    "entry",
    "pdh",
    "pdl",
    "range_pips",
    "bucket",
    "ret_broken",
    "r25",
    "r50",
    "r60",
    "r70",
    "r100",
    "mae_pips",
    "mfe_pips",
    "t_ret_min",
    "t50_min",
    "t60_min",
    "t70_min",
  ].join(","),
);
for (const e of events) {
  csv.push(
    [
      e.side,
      e.depth,
      e.dayOpen,
      e.entryTime,
      e.entry.toFixed(5),
      e.pdh.toFixed(5),
      e.pdl.toFixed(5),
      e.rangePips.toFixed(1),
      e.bucket,
      e.retBroken ? 1 : 0,
      e.r25 ? 1 : 0,
      e.r50 ? 1 : 0,
      e.r60 ? 1 : 0,
      e.r70 ? 1 : 0,
      e.r100 ? 1 : 0,
      e.maePips.toFixed(2),
      e.mfePips.toFixed(2),
      Number.isFinite(e.tRetMin) ? e.tRetMin : "",
      Number.isFinite(e.t50Min) ? e.t50Min : "",
      Number.isFinite(e.t60Min) ? e.t60Min : "",
      Number.isFinite(e.t70Min) ? e.t70Min : "",
    ].join(","),
  );
}
fs.writeFileSync(path.join(OUT_DIR, "eurusd-pdh-pdl-fade-v13-events.csv"), csv.join("\n") + "\n");
console.error(`[written] eurusd-pdh-pdl-fade-v13-report.txt | eurusd-pdh-pdl-fade-v13-events.csv (${events.length} events)`);
