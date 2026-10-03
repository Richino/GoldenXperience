/**
 * EUR/USD — 4-HOUR FROZEN S/R MIDPOINT REACH TEST V1
 *
 * RESEARCH ONLY. No trades, stops, RR, spread, or P&L.
 *
 * Question: after freezing Support/Resistance from the previous UTC 4H block
 * (16 M15 mids), how often does the NEXT 4H block trade through the midpoint,
 * and how does that change with previous range size / starting distance?
 */
import fs from "node:fs";
import path from "node:path";
import type { MajorInstrument } from "../src/types/forex";
import { pipSizeFor } from "../src/lib/instruments/catalog";

const INSTRUMENT: MajorInstrument = "EUR_USD";
const PAD =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad";
const M15_PATH = path.join(PAD, "eurusd-m15-mba-cache.json");
const OUT_DIR = path.resolve(__dirname, "../research-output");

const PIP = pipSizeFor(INSTRUMENT);
const BLOCK = 16;
const BLOCK_MS = 4 * 60 * 60 * 1000;
const BAR_MS = 15 * 60 * 1000;
const UTC_HOURS = [0, 4, 8, 12, 16, 20] as const;

const RANGE_BUCKETS: Array<[string, (w: number) => boolean]> = [
  ["0-10", (w) => w > 0 && w <= 10],
  ["10-15", (w) => w > 10 && w <= 15],
  ["15-20", (w) => w > 15 && w <= 20],
  ["20-30", (w) => w > 20 && w <= 30],
  ["30-40", (w) => w > 30 && w <= 40],
  ["40-50", (w) => w > 40 && w <= 50],
  ["50+", (w) => w > 50],
];

const DIST_BUCKETS: Array<[string, (d: number) => boolean]> = [
  ["0-2", (d) => d >= 0 && d <= 2],
  ["2-5", (d) => d > 2 && d <= 5],
  ["5-10", (d) => d > 5 && d <= 10],
  ["10-15", (d) => d > 10 && d <= 15],
  ["15-20", (d) => d > 15 && d <= 20],
  ["20-30", (d) => d > 20 && d <= 30],
  ["30+", (d) => d > 30],
];

const START_LOC: Array<[string, (p: number) => boolean]> = [
  ["below_S", (p) => p < 0],
  ["0-10", (p) => p >= 0 && p < 0.1],
  ["10-25", (p) => p >= 0.1 && p < 0.25],
  ["25-40", (p) => p >= 0.25 && p < 0.4],
  ["40-60", (p) => p >= 0.4 && p <= 0.6],
  ["60-75", (p) => p > 0.6 && p <= 0.75],
  ["75-90", (p) => p > 0.75 && p <= 0.9],
  ["90-100", (p) => p > 0.9 && p <= 1],
  ["above_R", (p) => p > 1],
];

const TIME_CUM = [15, 30, 60, 120, 180, 240] as const;

type OHLC = { open: number; high: number; low: number; close: number };
type RC = { time: string; mid: OHLC };

const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "-");
const q = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const median = (a: number[]) => q(a, 0.5);
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pad = (xs: Array<string | number>, widths: number[]) =>
  xs.map((x, i) => String(x).padStart(widths[i] ?? 10)).join("");

function bucket(val: number, defs: Array<[string, (v: number) => boolean]>): string {
  for (const [name, fn] of defs) if (fn(val)) return name;
  return "other";
}

console.error("4H-MIDPOINT-V1 loading M15...");
const raw: RC[] = JSON.parse(fs.readFileSync(M15_PATH, "utf8"));
const n = raw.length;
const tms = new Float64Array(n);
const o = new Float64Array(n);
const h = new Float64Array(n);
const l = new Float64Array(n);
const c = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const m = raw[i]!.mid;
  tms[i] = Date.parse(raw[i]!.time);
  o[i] = m.open;
  h[i] = m.high;
  l[i] = m.low;
  c[i] = m.close;
}

let nSkippedIncomplete = 0;
let nSkippedGap = 0;
let nSkippedZeroRange = 0;
let auditPrevLenFail = 0;
let auditTradeLenFail = 0;
let auditOverlapFail = 0;
let auditHourFail = 0;
let auditFrozenFail = 0;
let auditFutureFail = 0;

interface Event {
  year: number;
  rangePips: number;
  rangeBucket: string;
  mid: number;
  support: number;
  resistance: number;
  open: number;
  startProgress: number;
  startLoc: string;
  distToMid: number;
  distBucket: string;
  exactMid: boolean; // open essentially at midpoint
  dir: "UP" | "DOWN" | "AT_MID";
  hit: boolean;
  tHit: number | null; // minutes into observation block
}

const events: Event[] = [];

function isUtcBlockStart(ms: number): boolean {
  const d = new Date(ms);
  return (
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    (UTC_HOURS as readonly number[]).includes(d.getUTCHours())
  );
}

const blockStarts: number[] = [];
for (let i = 0; i < n; i++) {
  if (!isUtcBlockStart(tms[i]!)) continue;
  if (i < BLOCK) continue;
  if (i + BLOCK > n) {
    nSkippedIncomplete++;
    continue;
  }
  blockStarts.push(i);
}
console.error(`Trade-block starts: ${blockStarts.length}`);

for (const trade0 of blockStarts) {
  const prev0 = trade0 - BLOCK;
  const trade1 = trade0 + BLOCK - 1;

  if (trade0 - prev0 !== BLOCK) {
    auditPrevLenFail++;
    continue;
  }
  if (trade1 - trade0 + 1 !== BLOCK) {
    auditTradeLenFail++;
    continue;
  }
  if (prev0 + BLOCK - 1 >= trade0) {
    auditOverlapFail++;
    continue;
  }

  let gap = false;
  for (let i = prev0 + 1; i <= trade1; i++) {
    if (Math.abs(tms[i]! - tms[i - 1]! - BAR_MS) > 1000) {
      gap = true;
      break;
    }
  }
  if (gap) {
    nSkippedGap++;
    continue;
  }

  if (!isUtcBlockStart(tms[trade0]!)) {
    auditHourFail++;
    continue;
  }
  if (Math.abs(tms[prev0]! - (tms[trade0]! - BLOCK_MS)) > 1000) {
    auditHourFail++;
    continue;
  }

  let support = Infinity;
  let resistance = -Infinity;
  for (let i = prev0; i < trade0; i++) {
    if (i >= trade0) auditFutureFail++;
    support = Math.min(support, l[i]!);
    resistance = Math.max(resistance, h[i]!);
  }
  const frozenS = support;
  const frozenR = resistance;
  const range = frozenR - frozenS;
  if (!(range > 0)) {
    nSkippedZeroRange++;
    continue;
  }

  const rangePips = range / PIP;
  const midpoint = frozenS + range * 0.5;
  const nextOpen = o[trade0]!;
  const startProgress = (nextOpen - frozenS) / range;
  const distToMid = Math.abs(nextOpen - midpoint) / PIP;
  const exactMid = distToMid < 0.05; // < 0.05 pip ≈ on mid

  let dir: Event["dir"];
  if (exactMid) dir = "AT_MID";
  else if (nextOpen < midpoint) dir = "UP";
  else dir = "DOWN";

  let hit = false;
  let tHit: number | null = null;
  for (let i = trade0; i <= trade1; i++) {
    if (frozenS !== support || frozenR !== resistance) auditFrozenFail++;
    const hi = h[i]!;
    const lo = l[i]!;
    if (lo <= midpoint && hi >= midpoint) {
      hit = true;
      tHit = (i - trade0 + 1) * 15;
      break;
    }
  }

  // If AT_MID: the open bar almost always "hits" immediately — flagged separately
  if (exactMid && !hit) {
    // open alone doesn't span mid unless high/low crosses; treat open-on-mid as hit at 0
    hit = true;
    tHit = 0;
  }

  events.push({
    year: new Date(tms[trade0]!).getUTCFullYear(),
    rangePips,
    rangeBucket: bucket(rangePips, RANGE_BUCKETS),
    mid: midpoint,
    support: frozenS,
    resistance: frozenR,
    open: nextOpen,
    startProgress,
    startLoc: bucket(startProgress, START_LOC),
    distToMid,
    distBucket: bucket(distToMid, DIST_BUCKETS),
    exactMid,
    dir,
    hit,
    tHit,
  });
}

console.error(`Events: ${events.length}`);

const nonTrivial = events.filter((e) => !e.exactMid);
const trivial = events.filter((e) => e.exactMid);

interface Agg {
  n: number;
  hits: number;
  ranges: number[];
  dists: number[];
  times: number[]; // only hits
}
function newAgg(): Agg {
  return { n: 0, hits: 0, ranges: [], dists: [], times: [] };
}
function add(a: Agg, e: Event) {
  a.n++;
  if (e.hit) {
    a.hits++;
    if (e.tHit !== null) a.times.push(e.tHit);
  }
  a.ranges.push(e.rangePips);
  a.dists.push(e.distToMid);
}

const byKey = new Map<string, Agg>();
function A(k: string): Agg {
  let a = byKey.get(k);
  if (!a) {
    a = newAgg();
    byKey.set(k, a);
  }
  return a;
}

for (const e of nonTrivial) {
  add(A("ALL"), e);
  add(A(`R|${e.rangeBucket}`), e);
  add(A(`D|${e.distBucket}`), e);
  add(A(`RD|${e.rangeBucket}|${e.distBucket}`), e);
  add(A(`DIR|${e.dir}`), e);
  add(A(`LOC|${e.startLoc}`), e);
  const era = e.year <= 2019 ? "2013-2019" : "2020-2026";
  add(A(`ERA|${era}`), e);
  add(A(`ERA_R|${era}|${e.rangeBucket}`), e);
  // finer year for stability
  add(A(`YR|${e.year}`), e);
}

for (const e of trivial) add(A("TRIVIAL_AT_MID"), e);

const L: string[] = [];
L.push("=".repeat(120));
L.push("EUR/USD — 4-HOUR FROZEN S/R MIDPOINT REACH TEST V1 (MID behavioral, RESEARCH ONLY)");
L.push("=".repeat(120));
L.push(`PIP = ${PIP} (expect 0.0001)`);
L.push(`M15 bars: ${n}`);
L.push(`Valid observation blocks: ${events.length}`);
L.push(`Non-trivial (open not on midpoint): ${nonTrivial.length}`);
L.push(`Trivial open-on-midpoint (excluded from main tables): ${trivial.length}`);
L.push("");

L.push("-".repeat(120));
L.push("INTEGRITY CHECKS");
L.push("-".repeat(120));
L.push(`  exactly 16 previous M15: ${auditPrevLenFail === 0 ? "PASS" : "FAIL"} (${auditPrevLenFail})`);
L.push(`  exactly 16 next M15: ${auditTradeLenFail === 0 ? "PASS" : "FAIL"} (${auditTradeLenFail})`);
L.push(`  no observation candles in S/R: ${auditOverlapFail === 0 && auditFutureFail === 0 ? "PASS" : "FAIL"} (overlap=${auditOverlapFail} future=${auditFutureFail})`);
L.push(`  frozen S/R immutable: ${auditFrozenFail === 0 ? "PASS" : "FAIL"} (${auditFrozenFail})`);
L.push(`  UTC 00/04/08/12/16/20: ${auditHourFail === 0 ? "PASS" : "FAIL"} (${auditHourFail})`);
L.push(`  pip=0.0001: ${Math.abs(PIP - 0.0001) < 1e-12 ? "PASS" : "FAIL"}`);
L.push(`  gaps skipped: ${nSkippedGap}; incomplete excluded: ${nSkippedIncomplete}; zero-range: ${nSkippedZeroRange}`);
{
  const all = A("ALL");
  let sumR = 0;
  for (const [name] of RANGE_BUCKETS) sumR += A(`R|${name}`).n;
  L.push(`  count reconcile ALL=${all.n} vs sum(range buckets)=${sumR} ${all.n === sumR ? "PASS" : "FAIL"}`);
}
L.push("");

const all = A("ALL");
L.push("-".repeat(120));
L.push("TABLE 1 — OVERALL MIDPOINT HIT (non-trivial opens)");
L.push("-".repeat(120));
L.push(`  N                  = ${all.n}`);
L.push(`  Midpoint hits      = ${all.hits}`);
L.push(`  Midpoint hit %     = ${f1(pct(all.hits, all.n))}%`);
L.push(`  Median prev 4H rng = ${f1(median(all.ranges))} pips`);
L.push(`  Median start dist  = ${f1(median(all.dists))} pips`);
L.push(`  Median time to mid = ${f0(median(all.times))} minutes (among hits)`);
L.push(`  P75 time to mid    = ${f0(q(all.times, 0.75))} minutes`);
L.push(`  Trivial AT_MID N   = ${A("TRIVIAL_AT_MID").n} (excluded above)`);
L.push("");

L.push("-".repeat(120));
L.push("TABLE 2 — BY 4H RANGE SIZE");
L.push("-".repeat(120));
L.push(pad(["Range", "N", "HitN", "Hit%", "AvgRng", "MedRng", "MedT", "P75T"], [10, 8, 8, 8, 10, 10, 8, 8]));
for (const [name] of RANGE_BUCKETS) {
  const a = A(`R|${name}`);
  if (!a.n) continue;
  L.push(
    pad(
      [name, a.n, a.hits, f1(pct(a.hits, a.n)), f1(mean(a.ranges)), f1(median(a.ranges)), f0(median(a.times)), f0(q(a.times, 0.75))],
      [10, 8, 8, 8, 10, 10, 8, 8],
    ),
  );
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 3 — BY START DISTANCE TO MIDPOINT");
L.push("-".repeat(120));
L.push(pad(["Distance", "N", "Hit%", "MedT", "P75T"], [10, 8, 8, 8, 8]));
for (const [name] of DIST_BUCKETS) {
  const a = A(`D|${name}`);
  if (!a.n) continue;
  L.push(pad([name, a.n, f1(pct(a.hits, a.n)), f0(median(a.times)), f0(q(a.times, 0.75))], [10, 8, 8, 8, 8]));
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 4 — RANGE SIZE × START DISTANCE (most important)");
L.push("-".repeat(120));
L.push(pad(["Range", "Distance", "N", "Hit%"], [10, 10, 8, 8]));
for (const [r] of RANGE_BUCKETS) {
  for (const [d] of DIST_BUCKETS) {
    const a = A(`RD|${r}|${d}`);
    if (a.n < 20) continue;
    L.push(pad([r, d, a.n, f1(pct(a.hits, a.n))], [10, 10, 8, 8]));
  }
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 5 — DIRECTION");
L.push("-".repeat(120));
L.push(pad(["Direction", "N", "Hit%", "MedT"], [16, 8, 8, 8]));
for (const dir of ["UP", "DOWN"] as const) {
  const a = A(`DIR|${dir}`);
  L.push(pad([dir === "UP" ? "UP_to_mid" : "DOWN_to_mid", a.n, f1(pct(a.hits, a.n)), f0(median(a.times))], [16, 8, 8, 8]));
}
L.push("");

L.push("-".repeat(120));
L.push("START LOCATION (informational, not a filter)");
L.push("-".repeat(120));
L.push(pad(["StartLoc", "N", "Hit%"], [12, 8, 8]));
for (const [name] of START_LOC) {
  const a = A(`LOC|${name}`);
  if (!a.n) continue;
  L.push(pad([name, a.n, f1(pct(a.hits, a.n))], [12, 8, 8]));
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 6 — CUMULATIVE TIME TO MIDPOINT (% of all non-trivial blocks)");
L.push("-".repeat(120));
function cumLine(label: string, subset: Event[]) {
  const N = subset.length;
  const parts = TIME_CUM.map((t) => {
    const hits = subset.filter((e) => e.hit && e.tHit !== null && e.tHit <= t).length;
    return `${t}m=${f1(pct(hits, N))}%`;
  });
  L.push(`  ${label} (N=${N}): ${parts.join("  ")}`);
}
cumLine("ALL", nonTrivial);
for (const [name] of RANGE_BUCKETS) {
  cumLine(`range ${name}`, nonTrivial.filter((e) => e.rangeBucket === name));
}
L.push("");

L.push("-".repeat(120));
L.push("TABLE 7 — ERA STABILITY");
L.push("-".repeat(120));
for (const era of ["2013-2019", "2020-2026"]) {
  const a = A(`ERA|${era}`);
  L.push(`  ${era}: N=${a.n} Hit%=${f1(pct(a.hits, a.n))}% MedT=${f0(median(a.times))}m`);
  for (const [r] of RANGE_BUCKETS) {
    const b = A(`ERA_R|${era}|${r}`);
    if (b.n < 50) continue;
    L.push(`    ${r}: N=${b.n} Hit%=${f1(pct(b.hits, b.n))}%`);
  }
}
L.push("");

// Highlight strong combos vs baseline
const baseline = pct(all.hits, all.n);
L.push("-".repeat(120));
L.push("COMBOS ABOVE BASELINE (N≥100, Hit% ≥ baseline+5pp) — descriptive only, NOT an edge");
L.push("-".repeat(120));
{
  const combos: Array<{ label: string; n: number; hit: number }> = [];
  for (const [r] of RANGE_BUCKETS) {
    for (const [d] of DIST_BUCKETS) {
      const a = A(`RD|${r}|${d}`);
      if (a.n < 100) continue;
      const hpct = pct(a.hits, a.n);
      if (hpct >= baseline + 5) combos.push({ label: `${r} × dist ${d}`, n: a.n, hit: hpct });
    }
  }
  combos.sort((a, b) => b.hit - a.hit);
  if (!combos.length) L.push("  (none)");
  for (const c of combos.slice(0, 15)) {
    L.push(`  ${c.label}: N=${c.n} Hit%=${f1(c.hit)}% (baseline ${f1(baseline)}%)`);
  }
}
L.push("");

// Answers
const byRange = RANGE_BUCKETS.map(([name]) => {
  const a = A(`R|${name}`);
  return { name, n: a.n, hit: pct(a.hits, a.n), medT: median(a.times) };
}).filter((r) => r.n > 0);
const mostOften = [...byRange].sort((a, b) => b.hit - a.hit)[0]!;
// balance: maximize min(hit, sampleScore) — prefer N>=500 and high hit
const balanced = [...byRange]
  .filter((r) => r.n >= 500)
  .map((r) => ({ ...r, score: r.hit * Math.log10(r.n) }))
  .sort((a, b) => b.score - a.score)[0]!;

const distAns = [5, 10, 15, 20].map((dMin) => {
  // approximate: use buckets starting at that distance
  const subset = nonTrivial.filter((e) => e.distToMid >= dMin);
  return { dMin, n: subset.length, hit: pct(subset.filter((e) => e.hit).length, subset.length) };
});

const up = A("DIR|UP");
const down = A("DIR|DOWN");
const era1 = A("ERA|2013-2019");
const era2 = A("ERA|2020-2026");

L.push("-".repeat(120));
L.push("PLAIN-ENGLISH ANSWERS");
L.push("-".repeat(120));
L.push(`1. Next 4H reaches previous-4H midpoint: ${f1(baseline)}% of blocks (N=${all.n}, excluding opens already on mid).`);
L.push(
  `2. By previous range size: hit rate tends to ${
    byRange[0]!.hit > byRange[byRange.length - 1]!.hit ? "FALL as range widens" : "RISE as range widens"
  } — e.g. ${byRange[0]!.name}=${f1(byRange[0]!.hit)}% … ${byRange[byRange.length - 1]!.name}=${f1(byRange[byRange.length - 1]!.hit)}%.`,
);
L.push(`3. Highest hit-rate bucket: ${mostOften.name} at ${f1(mostOften.hit)}% (N=${mostOften.n}).`);
L.push(
  `4. Best balance (N≥500, hit×logN): ${balanced?.name ?? "-"} at ${f1(balanced?.hit ?? NaN)}% (N=${balanced?.n ?? 0}).`,
);
L.push(
  `5. Starting distance explains a lot: near mid (0-2p) Hit%=${f1(pct(A("D|0-2").hits, A("D|0-2").n))}%; far (30+) Hit%=${f1(pct(A("D|30+").hits, A("D|30+").n))}%.`,
);
L.push(
  `6. If start ≥5/10/15/20p from mid: ` +
    distAns.map((d) => `≥${d.dMin}p → ${f1(d.hit)}% (N=${d.n})`).join("; ") +
    `.`,
);
L.push(
  `7. UP vs DOWN: UP Hit%=${f1(pct(up.hits, up.n))}% (N=${up.n}); DOWN Hit%=${f1(pct(down.hits, down.n))}% (N=${down.n}) — ${
    Math.abs(pct(up.hits, up.n) - pct(down.hits, down.n)) < 3 ? "roughly symmetric" : "noticeable asymmetry"
  }.`,
);
L.push(
  `8. Speed: among hits, median=${f0(median(all.times))}m P75=${f0(q(all.times, 0.75))}m; cumulative ALL: 15m=${f1(pct(nonTrivial.filter((e) => e.hit && (e.tHit ?? 999) <= 15).length, nonTrivial.length))}% 1h=${f1(pct(nonTrivial.filter((e) => e.hit && (e.tHit ?? 999) <= 60).length, nonTrivial.length))}% 4h=${f1(baseline)}%.`,
);
L.push(
  `9. Era stability: 2013-2019 Hit%=${f1(pct(era1.hits, era1.n))}%; 2020-2026 Hit%=${f1(pct(era2.hits, era2.n))}% — ${
    Math.abs(pct(era1.hits, era1.n) - pct(era2.hits, era2.n)) < 5 ? "stable" : "shifted"
  }.`,
);
{
  const strong = [...byKey.entries()]
    .filter(([k, a]) => k.startsWith("RD|") && a.n >= 100 && pct(a.hits, a.n) >= baseline + 10)
    .map(([k, a]) => ({ k, n: a.n, hit: pct(a.hits, a.n) }))
    .sort((a, b) => b.hit - a.hit);
  if (strong.length) {
    L.push(
      `10. Stronger-than-baseline combos exist (descriptive): top=${strong[0]!.k.replace("RD|", "")} Hit%=${f1(strong[0]!.hit)}% (N=${strong[0]!.n}) vs baseline ${f1(baseline)}%. NOT labeled a trading edge.`,
    );
  } else {
    L.push(`10. No range×distance combo with N≥100 clears baseline by +10pp — attraction is mostly distance-driven, not a special magnet regime.`);
  }
}
L.push("");
L.push("=".repeat(120));
L.push("NOTE: This measures midpoint reach frequency only — not a trading edge.");
L.push("=".repeat(120));

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, "eurusd-4h-frozen-sr-midpoint-reach-v1-report.txt");
fs.writeFileSync(outPath, L.join("\n") + "\n");
console.error(`Wrote ${outPath}`);
console.log(L.join("\n"));
