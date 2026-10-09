// How often does EUR/USD break the app's S/R lines between 08:00 and 12:00 NY?
// Lines = production computeSupportResistanceLevels on M15 / M5 mid candles completed before 08:00 NY,
// FROZEN for the whole window. Mid prices only — this describes price, it is not a trade test.
import fs from "node:fs";
import { computeSupportResistanceLevels } from "../../../frontend/src/lib/strategy/support-resistance";

const M1 = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const CAL = "C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/pre-news-prediction-v1/data/calendar_raw.json";
const PIP = 1e-4, MIN = 60_000;

const raw: [string, number, number, number, number, number, number][] = JSON.parse(fs.readFileSync(M1, "utf8"));
const N = raw.length;
const T = new Float64Array(N), H = new Float64Array(N), L = new Float64Array(N), C = new Float64Array(N);
raw.forEach((r, i) => { T[i] = Date.parse(r[0].slice(0, 19) + "Z"); H[i] = (r[1] + r[3]) / 2; L[i] = (r[2] + r[4]) / 2; C[i] = (r[5] + r[6]) / 2; });
raw.length = 0;

type Bar = { t: number; open: number; high: number; low: number; close: number };
function aggregate(mins: number): Bar[] {
  const out: Bar[] = []; let cur: Bar | null = null; const w = mins * MIN;
  for (let i = 0; i < N; i++) {
    const b = Math.floor(T[i]! / w) * w;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, open: i ? C[i - 1]! : C[i]!, high: H[i]!, low: L[i]!, close: C[i]! }; }
    else { cur.high = Math.max(cur.high, H[i]!); cur.low = Math.min(cur.low, L[i]!); cur.close = C[i]!; }
  }
  if (cur) out.push(cur);
  return out;
}
const BARS: Record<string, Bar[]> = { M15: aggregate(15), M5: aggregate(5) };
const firstAtOrAfter = (arr: { t: number }[], t: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m]!.t < t) lo = m + 1; else hi = m; } return lo; };

function nthSunday(y: number, m: number, n: number) { const d = new Date(Date.UTC(y, m, 1)); return (7 - d.getUTCDay()) % 7 + 1 + (n - 1) * 7; }
function nyOffset(ms: number) { const y = new Date(ms).getUTCFullYear(); return ms >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSunday(y, 10, 1), 6) ? -4 : -5; }
const nyToUtc = (y: number, m: number, d: number, h: number) => Date.UTC(y, m, d, h - nyOffset(Date.UTC(y, m, d, h + 5)));

const cal = JSON.parse(fs.readFileSync(CAL, "utf8")) as { currency: string; importance: number; date: string; indicator?: string }[];
const news = cal.filter((e) => e.currency === "USD" && e.importance === 1).map((e) => Date.parse(e.date));
const holidays = new Set(cal.filter((e) => e.currency === "USD" && e.indicator === "Holidays").map((e) => e.date.slice(0, 10)));

type Outcome = "not reached" | "held (no poke through)" | "swept, came back (no 15m close past)" | "broke, kept going 15p+" | "broke, failed (came back)" | "broke, stalled (<15p, stayed past)";
type Row = { tf: string; year: number; side: "S" | "R"; kind: string; dist: number; outcome: Outcome; crossings: number; news: boolean | null; endBeyond: boolean };
const rows: Row[] = [];
let dayCount = 0;

for (let t = Date.UTC(2013, 0, 7); t < T[N - 1]!; t += 86_400_000) {
  const d = new Date(t); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  const key = d.toISOString().slice(0, 10); if (holidays.has(key)) continue;
  const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  const t8 = nyToUtc(y, m, dd, 8), t12 = nyToUtc(y, m, dd, 12);
  const m5 = BARS.M5!, m15 = BARS.M15!;
  const a5 = firstAtOrAfter(m5, t8), b5 = firstAtOrAfter(m5, t12);
  if (b5 - a5 < 40 || m5[a5]!.t !== t8) continue;
  const a15 = firstAtOrAfter(m15, t8), b15 = firstAtOrAfter(m15, t12);
  dayCount++;
  const isNews = t8 >= Date.UTC(2021, 0, 1) ? news.some((n) => n >= t8 && n < t12) : null;
  for (const tf of ["M15", "M5"]) {
    const src = BARS[tf]!; const end = firstAtOrAfter(src, t8);
    const slice = src.slice(Math.max(0, end - 160), end); // completed bars before 08:00 → frozen lines
    const lv = computeSupportResistanceLevels(slice.map((c) => ({ time: new Date(c.t).toISOString(), ...c, volume: 0, complete: true })), "EUR_USD" as never);
    if (!lv) continue;
    const lines: { p: number; side: "S" | "R"; kind: string }[] = [];
    const add = (p: number | null, side: "S" | "R", kind: string) => { if (p === null) return; if (lines.some((x) => Math.abs(x.p - p) < PIP)) return; lines.push({ p, side, kind }); };
    if (lv.swingHigh !== null) add(lv.swingHigh, "R", "swing"); if (lv.swingLow !== null) add(lv.swingLow, "S", "swing");
    if (lv.rangeHigh > lv.current) add(lv.rangeHigh, "R", "range"); if (lv.rangeLow < lv.current) add(lv.rangeLow, "S", "range");
    for (const ln of lines) {
      const s = ln.side === "S" ? -1 : 1; // +beyond = past the line in the break direction
      const past = (price: number) => s * (price - ln.p) / PIP;
      let reached = false, maxPast = -Infinity, m15ClosePast = false, after15Max = -Infinity, backInsideAfterBreak = false, crossings = 0;
      let side = 0; // -1 inside, +1 past (M5 closes)
      for (let i = a5; i < b5; i++) {
        const b = m5[i]!; const ext = ln.side === "S" ? b.low : b.high;
        if (past(ext) >= 0) reached = true;
        if (!reached) continue;
        maxPast = Math.max(maxPast, past(ext));
        const cs = past(b.close) > 0 ? 1 : -1;
        if (side !== 0 && cs !== side) crossings++;
        side = cs;
      }
      for (let i = a15; i < b15; i++) {
        const b = m15[i]!; const ext = ln.side === "S" ? b.low : b.high;
        if (m15ClosePast) { after15Max = Math.max(after15Max, past(ext)); if (past(b.close) < 0) backInsideAfterBreak = true; }
        else if (past(b.close) > 0) { m15ClosePast = true; after15Max = Math.max(after15Max, past(b.close)); }
      }
      const endBeyond = past(m5[b5 - 1]!.close) > 0;
      let outcome: Outcome;
      if (!reached) outcome = "not reached";
      else if (maxPast < 1 && !m15ClosePast) outcome = "held (no poke through)";
      else if (!m15ClosePast) outcome = "swept, came back (no 15m close past)";
      else if (after15Max >= 15) outcome = "broke, kept going 15p+";
      else if (backInsideAfterBreak || !endBeyond) outcome = "broke, failed (came back)";
      else outcome = "broke, stalled (<15p, stayed past)";
      rows.push({ tf, year: y, side: ln.side, kind: ln.kind, dist: Math.abs(lv.current - ln.p) / PIP, outcome, crossings, news: isNews, endBeyond });
    }
  }
}

const out: string[] = []; const P = (x = "") => out.push(x);
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(1)}%` : "-";
const ORDER: Outcome[] = ["not reached", "held (no poke through)", "swept, came back (no 15m close past)", "broke, kept going 15p+", "broke, stalled (<15p, stayed past)", "broke, failed (came back)"];
P(`EUR/USD — what price does at FROZEN app S/R lines, 08:00–12:00 New York (${dayCount} weekdays, 2013 → 2026-09)`);
P(`Lines: production computeSupportResistanceLevels at 08:00 NY (range high/low + nearest swing high/low), never recalculated in the window.`);
P(`"Poke through" = ≥1 pip past the line. "Broke" = a 15-minute candle CLOSES past the line. Mid prices.\n`);
for (const tf of ["M15", "M5"]) {
  const R = rows.filter((r) => r.tf === tf);
  const reached = R.filter((r) => r.outcome !== "not reached");
  P(`=== ${tf} S/R lines: ${R.length} lines (${(R.length / dayCount).toFixed(1)} per morning), median distance from 08:00 price ${median(R.map((r) => r.dist)).toFixed(1)} pips`);
  P(`  ${"outcome".padEnd(40)} ${"of all lines".padStart(13)} ${"of lines reached".padStart(17)}`);
  for (const o of ORDER) { const n = R.filter((r) => r.outcome === o).length; P(`  ${o.padEnd(40)} ${String(n).padStart(6)} ${pct(n, R.length).padStart(6)} ${o === "not reached" ? "" : pct(n, reached.length).padStart(17)}`); }
  const broke = reached.filter((r) => r.outcome.startsWith("broke")).length;
  P(`  → reached lines that BROKE (15m close past): ${pct(broke, reached.length)}   held or only swept: ${pct(reached.length - broke, reached.length)}`);
  P(`  → reached lines with price still past the line at 12:00: ${pct(reached.filter((r) => r.endBeyond).length, reached.length)}`);
  const cr = reached.map((r) => r.crossings);
  P(`  → times price crossed back and forth over a reached line (5m closes): avg ${(cr.reduce((a, b) => a + b, 0) / cr.length).toFixed(1)}  | 0: ${pct(cr.filter((x) => x === 0).length, cr.length)}  1: ${pct(cr.filter((x) => x === 1).length, cr.length)}  2: ${pct(cr.filter((x) => x === 2).length, cr.length)}  3+: ${pct(cr.filter((x) => x >= 3).length, cr.length)}`);
  // per morning
  P(`  Breaks by line type (of lines reached):`);
  for (const [lab, f] of [["support · swing", (r: Row) => r.side === "S" && r.kind === "swing"], ["support · range", (r: Row) => r.side === "S" && r.kind === "range"], ["resistance · swing", (r: Row) => r.side === "R" && r.kind === "swing"], ["resistance · range", (r: Row) => r.side === "R" && r.kind === "range"]] as const) {
    const g = reached.filter(f); const gb = g.filter((r) => r.outcome.startsWith("broke"));
    P(`    ${lab.padEnd(20)} reached ${String(g.length).padStart(5)}  broke ${pct(gb.length, g.length).padStart(6)}  kept going 15p+ ${pct(g.filter((r) => r.outcome === "broke, kept going 15p+").length, g.length).padStart(6)}  held/swept ${pct(g.length - gb.length, g.length).padStart(6)}`);
  }
  P(`  2021+ news split (of lines reached):`);
  for (const [lab, nv] of [["USD high-impact news 8–12", true], ["no high-impact news", false]] as const) {
    const g = reached.filter((r) => r.news === nv); const gb = g.filter((r) => r.outcome.startsWith("broke"));
    P(`    ${lab.padEnd(28)} n=${String(g.length).padStart(5)}  broke ${pct(gb.length, g.length).padStart(6)}  kept going 15p+ ${pct(g.filter((r) => r.outcome === "broke, kept going 15p+").length, g.length).padStart(6)}`);
  }
  P(`  By year — broke % of lines reached:`);
  const years = [...new Set(R.map((r) => r.year))];
  P("    " + years.map((yy) => { const g = reached.filter((r) => r.year === yy); return `${yy} ${pct(g.filter((r) => r.outcome.startsWith("broke")).length, g.length)}`; }).join("  "));
  P();
}
function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; }
const text = out.join("\n"); console.log(text);
fs.writeFileSync("BREAK-COUNT.txt", text);
