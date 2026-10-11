// EUR/USD: rank Mon–Fri (America/New_York calendar) for trading quality.
import fs from "node:fs";

const M1 =
  "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const PIP = 1e-4;
const MIN = 60_000;
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const raw: [string, number, number, number, number, number, number][] = JSON.parse(fs.readFileSync(M1, "utf8"));
const N = raw.length;
const T = new Float64Array(N);
const H = new Float64Array(N);
const L = new Float64Array(N);
const C = new Float64Array(N);
const SP = new Float64Array(N);
raw.forEach((r, i) => {
  T[i] = Date.parse(r[0].slice(0, 19) + "Z");
  H[i] = (r[1] + r[3]) / 2;
  L[i] = (r[2] + r[4]) / 2;
  C[i] = (r[5] + r[6]) / 2;
  SP[i] = r[6] - r[5];
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
function nyOffsetHours(utcMs: number) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return utcMs >= start && utcMs < end ? -4 : -5;
}
function nyToUtc(y: number, m: number, d: number, h: number) {
  return Date.UTC(y, m, d, h - nyOffsetHours(Date.UTC(y, m, d, h + 5)));
}
function nyWeekday(utcMs: number) {
  const off = nyOffsetHours(utcMs);
  const local = new Date(utcMs + off * 3_600_000);
  return local.getUTCDay();
}

type Acc = {
  n: number;
  range8112: number[];
  range816: number[];
  net816: number[];
  oneWay: number;
  hr1Cont: number;
  hr1N: number;
  spread8112: number[];
  fullDayRange: number[];
};

const acc: Record<number, Acc> = {};
for (let dow = 0; dow < 7; dow++) acc[dow] = { n: 0, range8112: [], range816: [], net816: [], oneWay: 0, hr1Cont: 0, hr1N: 0, spread8112: [], fullDayRange: [] };

for (let t = Date.UTC(2013, 0, 7); t < T[N - 1]!; t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const dd = d.getUTCDate();
  const t8 = nyToUtc(y, m, dd, 8);
  const t9 = nyToUtc(y, m, dd, 9);
  const t12 = nyToUtc(y, m, dd, 12);
  const t16 = nyToUtc(y, m, dd, 16);
  const t17 = nyToUtc(y, m, dd, 17);
  const dow = nyWeekday(t8);
  if (dow === 0 || dow === 6) continue;

  const i8 = lb(M5, t8);
  const i9 = lb(M5, t9);
  const i12 = lb(M5, t12);
  const i16 = lb(M5, t16);
  const i17 = lb(M5, t17);
  if (M5[i8]!.t !== t8 || i16 - i8 < 60) continue;

  const open8 = M5[i8]!.open;
  let hi12 = -Infinity;
  let lo12 = Infinity;
  let hi16 = -Infinity;
  let lo16 = Infinity;
  let cross = 0;
  let side = 0;
  for (let i = i8; i < i12; i++) {
    const b = M5[i]!;
    hi12 = Math.max(hi12, b.high);
    lo12 = Math.min(lo12, b.low);
  }
  for (let i = i8; i < i16; i++) {
    const b = M5[i]!;
    hi16 = Math.max(hi16, b.high);
    lo16 = Math.min(lo16, b.low);
    const s = b.close > open8 ? 1 : b.close < open8 ? -1 : 0;
    if (s && side && s !== side) cross++;
    if (s) side = s;
  }
  const close16 = M5[i16 - 1]!.close;
  const net = (close16 - open8) / PIP;
  const upLeg = (hi16 - open8) / PIP;
  const downLeg = (open8 - lo16) / PIP;
  const range816 = (hi16 - lo16) / PIP;
  const range8112 = (hi12 - lo12) / PIP;
  const hr1 = i9 < i16 ? (M5[i9]!.open - open8) / PIP : 0;

  let oneWay = false;
  if (range816 >= 18 && Math.abs(net) >= 8 && cross <= 1) {
    if (net >= 8 && downLeg <= 0.35 * upLeg) oneWay = true;
    if (net <= -8 && upLeg <= 0.35 * downLeg) oneWay = true;
  }

  let spreadSum = 0;
  let spreadN = 0;
  let iM1 = 0;
  while (iM1 < N && T[iM1]! < t8) iM1++;
  for (; iM1 < N && T[iM1]! < t12; iM1++) {
    spreadSum += SP[iM1]!;
    spreadN++;
  }

  let fdHi = -Infinity;
  let fdLo = Infinity;
  const iDayStart = lb(M5, nyToUtc(y, m, dd, 0));
  const iDayEnd = i17 < M5.length ? i17 : M5.length;
  for (let i = iDayStart; i < iDayEnd && M5[i]!.t < t17; i++) {
    fdHi = Math.max(fdHi, M5[i]!.high);
    fdLo = Math.min(fdLo, M5[i]!.low);
  }

  const a = acc[dow]!;
  a.n++;
  a.range8112.push(range8112);
  a.range816.push(range816);
  a.net816.push(Math.abs(net));
  if (oneWay) a.oneWay++;
  if (Math.abs(hr1) >= 5) {
    a.hr1N++;
    if (Math.sign(hr1) === Math.sign(net) && Math.abs(net) >= 5) a.hr1Cont++;
  }
  if (spreadN) a.spread8112.push((spreadSum / spreadN) / PIP);
  if (fdHi > fdLo) a.fullDayRange.push((fdHi - fdLo) / PIP);
}

function med(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function avg(a: number[]) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

type Row = { dow: number; name: string; n: number; medRange816: number; medRange8112: number; medAbsNet: number; oneWayPct: number; hr1Pct: number; medSpread: number; medFullRange: number; score: number };
const rows: Row[] = [];
for (let dow = 1; dow <= 5; dow++) {
  const a = acc[dow]!;
  const medRange816 = med(a.range816);
  const medRange8112 = med(a.range8112);
  const medAbsNet = med(a.net816);
  const oneWayPct = a.n ? (100 * a.oneWay) / a.n : 0;
  const hr1Pct = a.hr1N ? (100 * a.hr1Cont) / a.hr1N : 0;
  const medSpread = med(a.spread8112);
  const medFullRange = med(a.fullDayRange);
  // Higher movement + continuation + tight spread = better; normalize roughly
  const score = medRange816 * 0.35 + medAbsNet * 0.25 + hr1Pct * 0.25 + oneWayPct * 0.15 - medSpread * 8;
  rows.push({ dow, name: NAMES[dow]!, n: a.n, medRange816, medRange8112, medAbsNet, oneWayPct, hr1Pct, medSpread, medFullRange, score });
}
rows.sort((a, b) => b.score - a.score);

const out: string[] = [];
const P = (s = "") => out.push(s);
P("EUR/USD weekday scan (New York calendar, 2013 → 2026-09)");
P("Metrics: 08:00–16:00 NY session unless noted. Mid prices on M5.");
P("Score = weighted blend (more 8–16 range, |net|, 1st-hr continuation, one-way days; penalize 8–12 spread).\n");
P(`${"Day".padEnd(4)} ${"n".padStart(5)} ${"8-16rng".padStart(8)} ${"8-12rng".padStart(8)} ${"|net|".padStart(7)} ${"1way%".padStart(7)} ${"1hr→day%".padStart(9)} ${"sprd8-12".padStart(9)} ${"NYdayR".padStart(8)} ${"score".padStart(7)}`);
for (const r of rows) {
  P(
    `${r.name.padEnd(4)} ${String(r.n).padStart(5)} ${r.medRange816.toFixed(1).padStart(8)} ${r.medRange8112.toFixed(1).padStart(8)} ${r.medAbsNet.toFixed(1).padStart(7)} ${r.oneWayPct.toFixed(1).padStart(7)} ${r.hr1Pct.toFixed(1).padStart(9)} ${r.medSpread.toFixed(2).padStart(9)} ${r.medFullRange.toFixed(1).padStart(8)} ${r.score.toFixed(1).padStart(7)}`,
  );
}
P(`\nRank (best → worst): ${rows.map((r) => r.name).join(" > ")}`);
P(`\nBest for trend-style (highest one-way %): ${[...rows].sort((a, b) => b.oneWayPct - a.oneWayPct)[0]!.name}`);
P(`Best for movement (median 8–16 range): ${[...rows].sort((a, b) => b.medRange816 - a.medRange816)[0]!.name}`);
P(`Best for 8–12 continuation after 5+ pip 1st hour: ${[...rows].sort((a, b) => b.hr1Pct - a.hr1Pct)[0]!.name}`);
P(`Tightest 8–12 spread (M1 avg): ${[...rows].sort((a, b) => a.medSpread - b.medSpread)[0]!.name}`);

const text = out.join("\n");
console.log(text);
fs.writeFileSync("C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/sr-8am-1to2/WEEKDAY-SCAN.txt", text);
