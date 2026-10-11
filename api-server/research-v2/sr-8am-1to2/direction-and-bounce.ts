// EUR/USD: (1) does the session from 08:00 NY tend to move one way through 16:00?
// (2) when price reaches the nearest frozen app S/R level (M15 @ 08:00), does it bounce back?
import fs from "node:fs";
import { computeSupportResistanceLevels } from "../../../frontend/src/lib/strategy/support-resistance";

const M1 =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const OUT = "C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/sr-8am-1to2/DIRECTION-BOUNCE.txt";
const PIP = 1e-4;
const MIN = 60_000;

const raw: [string, number, number, number, number, number, number][] = JSON.parse(fs.readFileSync(M1, "utf8"));
const N = raw.length;
const T = new Float64Array(N);
const H = new Float64Array(N);
const L = new Float64Array(N);
const C = new Float64Array(N);
raw.forEach((r, i) => {
  T[i] = Date.parse(r[0].slice(0, 19) + "Z");
  H[i] = (r[1] + r[3]) / 2;
  L[i] = (r[2] + r[4]) / 2;
  C[i] = (r[5] + r[6]) / 2;
});
raw.length = 0;

type Bar = { t: number; open: number; high: number; low: number; close: number };
function aggregate(mins: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  const w = mins * MIN;
  for (let i = 0; i < N; i++) {
    const b = Math.floor(T[i]! / w) * w;
    if (!cur || cur.t !== b) {
      if (cur) out.push(cur);
      cur = { t: b, open: i ? C[i - 1]! : C[i]!, high: H[i]!, low: L[i]!, close: C[i]! };
    } else {
      cur.high = Math.max(cur.high, H[i]!);
      cur.low = Math.min(cur.low, L[i]!);
      cur.close = C[i]!;
    }
  }
  if (cur) out.push(cur);
  return out;
}
const M5 = aggregate(5);
const M15 = aggregate(15);
const lb = (arr: { t: number }[], t: number) => {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m]!.t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
};

function nthSunday(y: number, m: number, n: number) {
  const d = new Date(Date.UTC(y, m, 1));
  return ((7 - d.getUTCDay()) % 7) + 1 + (n - 1) * 7;
}
function nyOffset(ms: number) {
  const y = new Date(ms).getUTCFullYear();
  return ms >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSunday(y, 10, 1), 6) ? -4 : -5;
}
const nyToUtc = (y: number, m: number, d: number, h: number) => Date.UTC(y, m, d, h - nyOffset(Date.UTC(y, m, d, h + 5)));

type DayKind = "one-way up" | "one-way down" | "two-sided";
type SrTouch = "no touch" | "held/swept (bounce)" | "broke through";
type DayRow = {
  key: string;
  kind: DayKind;
  netPips: number;
  rangePips: number;
  efficiency: number;
  cross8Open: number;
  hr1Pips: number;
  sr: SrTouch;
  srSide: "S" | "R" | null;
};

const rows: DayRow[] = [];

for (let t = Date.UTC(2013, 0, 7); t < T[N - 1]!; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const dd = d.getUTCDate();
  const key = d.toISOString().slice(0, 10);
  const t8 = nyToUtc(y, m, dd, 8);
  const t9 = nyToUtc(y, m, dd, 9);
  const t16 = nyToUtc(y, m, dd, 16);
  const i8 = lb(M5, t8);
  const i9 = lb(M5, t9);
  const i16 = lb(M5, t16);
  if (i16 - i8 < 60 || M5[i8]!.t !== t8) continue;

  const open8 = M5[i8]!.open;
  let hi = -Infinity;
  let lo = Infinity;
  let cross8Open = 0;
  let side = 0;
  for (let i = i8; i < i16; i++) {
    const b = M5[i]!;
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
    const s = b.close > open8 ? 1 : b.close < open8 ? -1 : 0;
    if (s && side && s !== side) cross8Open++;
    if (s) side = s;
  }
  const close16 = M5[i16 - 1]!.close;
  const netPips = (close16 - open8) / PIP;
  const upLeg = (hi - open8) / PIP;
  const downLeg = (open8 - lo) / PIP;
  const rangePips = (hi - lo) / PIP;
  const efficiency = rangePips > 0 ? Math.abs(netPips) / rangePips : 0;

  let kind: DayKind = "two-sided";
  const minNet = 8;
  const minRange = 18;
  if (rangePips >= minRange && netPips >= minNet && downLeg <= 0.35 * upLeg && cross8Open <= 1) kind = "one-way up";
  else if (rangePips >= minRange && netPips <= -minNet && upLeg <= 0.35 * downLeg && cross8Open <= 1) kind = "one-way down";

  const close9 = i9 < i16 ? M5[i9]!.open : open8;
  const hr1Pips = (close9 - open8) / PIP;

  // Nearest M15 S/R at 08:00
  const end15 = lb(M15, t8);
  const slice = M15.slice(Math.max(0, end15 - 160), end15);
  const lv = computeSupportResistanceLevels(
    slice.map((c) => ({ time: new Date(c.t).toISOString(), ...c, volume: 0, complete: true })),
    "EUR_USD" as never,
  );
  let sr: SrTouch = "no touch";
  let srSide: "S" | "R" | null = null;
  if (lv) {
    const lines: { p: number; side: "S" | "R" }[] = [];
    const add = (p: number | null, side: "S" | "R") => {
      if (p === null) return;
      if (lines.some((x) => Math.abs(x.p - p) < PIP)) return;
      lines.push({ p, side });
    };
    if (lv.swingHigh !== null) add(lv.swingHigh, "R");
    if (lv.swingLow !== null) add(lv.swingLow, "S");
    if (lv.rangeHigh > lv.current) add(lv.rangeHigh, "R");
    if (lv.rangeLow < lv.current) add(lv.rangeLow, "S");
    let nearest: { p: number; side: "S" | "R"; dist: number } | null = null;
    for (const ln of lines) {
      const dist = Math.abs(lv.current - ln.p) / PIP;
      if (!nearest || dist < nearest.dist) nearest = { ...ln, dist };
    }
    if (nearest && nearest.dist >= 2) {
      srSide = nearest.side;
      const ln = nearest;
      const past = (price: number) => (ln.side === "S" ? -1 : 1) * (price - ln.p) / PIP;
      let reached = false;
      let maxPast = -Infinity;
      let m15ClosePast = false;
      let backInside = false;
      const a15 = lb(M15, t8);
      const b15 = lb(M15, t16);
      for (let i = i8; i < i16; i++) {
        const b = M5[i]!;
        const ext = ln.side === "S" ? b.low : b.high;
        if (past(ext) >= 0) reached = true;
        if (reached) maxPast = Math.max(maxPast, past(ext));
      }
      for (let i = a15; i < b15; i++) {
        const b = M15[i]!;
        if (m15ClosePast) {
          if (past(b.close) < 0) backInside = true;
        } else if (past(b.close) > 0) m15ClosePast = true;
      }
      if (!reached) sr = "no touch";
      else if (!m15ClosePast && maxPast < 15) sr = "held/swept (bounce)";
      else if (m15ClosePast && backInside) sr = "held/swept (bounce)";
      else if (m15ClosePast) sr = "broke through";
      else sr = "held/swept (bounce)";
    }
  }

  rows.push({ key, kind, netPips, rangePips, efficiency, cross8Open, hr1Pips, sr, srSide });
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const out: string[] = [];
const P = (x = "") => out.push(x);

P(`EUR/USD — 08:00 NY session direction + nearest S/R bounce (2013 → 2026-09, ${rows.length} weekdays)`);
P(`Session window: 08:00–16:00 New York, mid prices on M5.`);
P(`One-way day: net move ≥8 pips, range ≥18 pips, ≤1 close cross back through 08:00 open,`);
P(`  and pullback leg ≤35% of impulse leg (up: downLeg≤0.35×upLeg; down: symmetric).`);
P(`Nearest S/R: closest M15 production level frozen at 08:00 (min 2 pips away); touch = price reaches level 08:00–16:00.`);
P(`Bounce = held or swept without 15m close past, or broke then came back inside.\n`);

const up = rows.filter((r) => r.kind === "one-way up");
const down = rows.filter((r) => r.kind === "one-way down");
const chop = rows.filter((r) => r.kind === "two-sided");
P(`=== Full-day shape (08:00 → 16:00)`);
P(`  one-way up     ${String(up.length).padStart(5)}  ${pct(up.length, rows.length)}`);
P(`  one-way down   ${String(down.length).padStart(5)}  ${pct(down.length, rows.length)}`);
P(`  two-sided      ${String(chop.length).padStart(5)}  ${pct(chop.length, rows.length)}`);
P(`  median range ${median(rows.map((r) => r.rangePips)).toFixed(1)} pips  |  median |net| ${median(rows.map((r) => Math.abs(r.netPips))).toFixed(1)} pips`);
P(`  strict: never re-cross 08:00 open (0 crosses): ${pct(rows.filter((r) => r.cross8Open === 0).length, rows.length)} of days\n`);

P(`=== First hour (08:00–09:00) vs rest of day (09:00 → 16:00 close)`);
for (const [lab, minHr] of [
  ["|1st hour| ≥ 3 pips", 3],
  ["|1st hour| ≥ 5 pips", 5],
  ["|1st hour| ≥ 8 pips", 8],
] as const) {
  const sub = rows.filter((r) => Math.abs(r.hr1Pips) >= minHr);
  const cont = sub.filter((r) => Math.sign(r.hr1Pips) === Math.sign(r.netPips) && Math.abs(r.netPips) >= minHr);
  P(`  ${lab}: n=${sub.length}  same sign 08:00→16:00 & |day|≥${minHr}p: ${pct(cont.length, sub.length)} (${cont.length})`);
}
P(`  Of one-way UP days: 1st hour also up (≥3p): ${pct(up.filter((r) => r.hr1Pips >= 3).length, up.length)}`);
P(`  Of one-way DOWN days: 1st hour also down (≤-3p): ${pct(down.filter((r) => r.hr1Pips <= -3).length, down.length)}\n`);

P(`=== Nearest frozen S/R level (08:00 M15, ≥2 pips away)`);
const touched = rows.filter((r) => r.sr !== "no touch");
const withLevel = rows.filter((r) => r.srSide !== null);
P(`  days with a level in range: ${withLevel.length}  |  level touched 08:00–16:00: ${touched.length} (${pct(touched.length, withLevel.length)} of those days)`);
const bounce = touched.filter((r) => r.sr === "held/swept (bounce)");
const broke = touched.filter((r) => r.sr === "broke through");
P(`  of touches: bounce (hold/sweep/failed break) ${pct(bounce.length, touched.length)}  |  broke & stayed ${pct(broke.length, touched.length)}`);
P(`  by level side (of touches): support bounce ${pct(touched.filter((r) => r.srSide === "S" && r.sr === "held/swept (bounce)").length, touched.filter((r) => r.srSide === "S").length)}  resistance bounce ${pct(touched.filter((r) => r.srSide === "R" && r.sr === "held/swept (bounce)").length, touched.filter((r) => r.srSide === "R").length)}\n`);

P(`=== S/R bounce when the day is one-way vs two-sided (level touched only)`);
for (const [lab, set] of [
  ["one-way UP", up],
  ["one-way DOWN", down],
  ["two-sided", chop],
] as const) {
  const t = set.filter((r) => r.sr !== "no touch");
  P(`  ${lab.padEnd(14)} touches=${String(t.length).padStart(4)}  bounce ${pct(t.filter((r) => r.sr === "held/swept (bounce)").length, t.length)}  broke ${pct(t.filter((r) => r.sr === "broke through").length, t.length)}`);
}

P(`\n=== One-way days that also touched nearest S/R`);
const ow = [...up, ...down];
const owTouch = ow.filter((r) => r.sr !== "no touch");
P(`  one-way days: ${ow.length}  touched nearest S/R: ${owTouch.length} (${pct(owTouch.length, ow.length)})`);
P(`  when both: bounce ${pct(owTouch.filter((r) => r.sr === "held/swept (bounce)").length, owTouch.length)}  (fade-the-level days)`);
P(`  when both: broke ${pct(owTouch.filter((r) => r.sr === "broke through").length, owTouch.length)}  (breakout-with-trend days)`);

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

const text = out.join("\n");
console.log(text);
fs.writeFileSync(OUT, text);
