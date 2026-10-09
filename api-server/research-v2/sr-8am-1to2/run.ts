// EUR/USD 8–12 NY S/R test: levels from the production S/R indicator frozen at 08:00 NY,
// trade only if price reaches a level before 12:00 NY, 1:2 with 12–15 pip targets.
// Entries: plain touch (limit at level) vs liquidity sweep + reclaim. Bid/ask M1 fills.
import fs from "node:fs";
import { computeSupportResistanceLevels } from "../../../frontend/src/lib/strategy/support-resistance";

const M1 = "C:/Users/arche/AppData/Local/Temp/claude/C--Users-arche-Desktop-code-GoldenXperience/b91639a8-31ca-421e-813c-77c1bd106f29/scratchpad/eurusd-m1-mba-cache.json";
const CAL = "C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/pre-news-prediction-v1/data/calendar_raw.json";
const PIP = 0.0001;
const MIN = 60_000;

// ---------- load M1 bid/ask: [t, bh, bl, ah, al, bc, ac]
process.stderr.write("loading M1...\n");
const raw: [string, number, number, number, number, number, number][] = JSON.parse(fs.readFileSync(M1, "utf8"));
const N = raw.length;
const T = new Float64Array(N), BH = new Float64Array(N), BL = new Float64Array(N), AH = new Float64Array(N),
  AL = new Float64Array(N), BC = new Float64Array(N), AC = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const r = raw[i]!;
  T[i] = Date.parse(r[0].slice(0, 19) + "Z"); BH[i] = r[1]; BL[i] = r[2]; AH[i] = r[3]; AL[i] = r[4]; BC[i] = r[5]; AC[i] = r[6];
}
raw.length = 0;
const MH = (i: number) => (BH[i]! + AH[i]!) / 2, ML = (i: number) => (BL[i]! + AL[i]!) / 2, MC = (i: number) => (BC[i]! + AC[i]!) / 2;
process.stderr.write(`M1 ${N} bars ${new Date(T[0]!).toISOString()} -> ${new Date(T[N - 1]!).toISOString()}\n`);

function lowerBound(t: number) { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m]! < t) lo = m + 1; else hi = m; } return lo; }

// ---------- aggregate mid candles (M5, M15)
type C = { t: number; open: number; high: number; low: number; close: number };
function aggregate(mins: number): C[] {
  const out: C[] = []; let cur: C | null = null; const w = mins * MIN;
  for (let i = 0; i < N; i++) {
    const b = Math.floor(T[i]! / w) * w;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, open: i ? MC(i - 1) : MC(i), high: MH(i), low: ML(i), close: MC(i) }; }
    else { cur.high = Math.max(cur.high, MH(i)); cur.low = Math.min(cur.low, ML(i)); cur.close = MC(i); }
  }
  if (cur) out.push(cur);
  return out;
}
const TF: Record<string, C[]> = { M15: aggregate(15), M5: aggregate(5) };

// ---------- NY time (US DST rules since 2007)
function nthSunday(y: number, m: number, n: number) { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return first + (n - 1) * 7; }
function nyOffsetHours(utcMs: number) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return utcMs >= start && utcMs < end ? -4 : -5;
}
function nyToUtc(y: number, m: number, d: number, h: number) { const guess = Date.UTC(y, m, d, h + 5); return Date.UTC(y, m, d, h - nyOffsetHours(guess)); }

// ---------- USD high-impact news (calendar covers 2021+)
const cal = JSON.parse(fs.readFileSync(CAL, "utf8")) as { currency: string; importance: number; date: string; indicator?: string }[];
const newsTimes = cal.filter((e) => e.currency === "USD" && e.importance === 1).map((e) => Date.parse(e.date)).sort((a, b) => a - b);
const holidays = new Set(cal.filter((e) => e.currency === "USD" && e.indicator === "Holidays").map((e) => e.date.slice(0, 10)));
const CAL_START = Date.UTC(2021, 0, 1);

// ---------- days
type Level = { price: number; side: "S" | "R"; kind: string };
type Day = { key: string; year: number; t8: number; t12: number; t16: number; i8: number; i12: number; i16: number; levels: Record<string, Level[]>; news: boolean | null };
const days: Day[] = [];
for (let t = Date.UTC(2013, 0, 7); t < T[N - 1]!; t += 86_400_000) {
  const d = new Date(t); const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), dd = d.getUTCDate();
  const key = d.toISOString().slice(0, 10);
  if (holidays.has(key)) continue;
  const t8 = nyToUtc(y, m, dd, 8), t12 = nyToUtc(y, m, dd, 12), t16 = nyToUtc(y, m, dd, 16);
  const i8 = lowerBound(t8), i12 = lowerBound(t12), i16 = lowerBound(t16);
  if (i12 - i8 < 200 || T[i8]! - t8 > 5 * MIN) continue; // missing data / holiday-thin
  const levels: Record<string, Level[]> = {};
  for (const tf of Object.keys(TF)) {
    const arr = TF[tf]!; let lo = 0, hi = arr.length; while (lo < hi) { const mm = (lo + hi) >> 1; if (arr[mm]!.t < t8) lo = mm + 1; else hi = mm; }
    const tfMin = tf === "M15" ? 15 : 5;
    const slice = arr.slice(Math.max(0, lo - 160), lo).filter((c) => c.t + tfMin * MIN <= t8);
    const lv = computeSupportResistanceLevels(slice.map((c) => ({ time: new Date(c.t).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, volume: 0, complete: true })), "EUR_USD" as never);
    const L: Level[] = [];
    if (lv) {
      if (lv.rangeHigh > lv.current) L.push({ price: lv.rangeHigh, side: "R", kind: "range" });
      if (lv.rangeLow < lv.current) L.push({ price: lv.rangeLow, side: "S", kind: "range" });
      if (lv.swingHigh !== null) L.push({ price: lv.swingHigh, side: "R", kind: "swing" });
      if (lv.swingLow !== null) L.push({ price: lv.swingLow, side: "S", kind: "swing" });
    }
    levels[tf] = L;
  }
  let news: boolean | null = null;
  if (t8 >= CAL_START) { news = newsTimes.some((nt) => nt >= t8 && nt < t12); }
  days.push({ key, year: y, t8, t12, t16, i8, i12, i16, levels, news });
}
process.stderr.write(`days ${days.length}\n`);

// ---------- trade engine
type Trade = { day: Day; dir: 1 | -1; entryIdx: number; entry: number; risk: number; r: number; pips: number; outcome: "TP" | "SL" | "TIME"; kind: string; spread: number };
type Mode = "exec" | "mid";

/** Run SL/TP from bar `from` (inclusive) to 16:00 NY. On the fill bar of a limit, only the stop may trigger. */
function manage(day: Day, mode: Mode, dir: 1 | -1, entry: number, sl: number, tp: number, from: number, fillBarStopOnly: number | null) {
  const exitHigh = (i: number) => mode === "mid" ? MH(i) : dir === 1 ? BH[i]! : AH[i]!; // long exits on bid, short on ask
  const exitLow = (i: number) => mode === "mid" ? ML(i) : dir === 1 ? BL[i]! : AL[i]!;
  if (fillBarStopOnly !== null) {
    const i = fillBarStopOnly;
    if (dir === 1 ? exitLow(i) <= sl : exitHigh(i) >= sl) return { exit: sl, outcome: "SL" as const };
  }
  for (let i = from; i < day.i16; i++) {
    const hitSl = dir === 1 ? exitLow(i) <= sl : exitHigh(i) >= sl;
    const hitTp = dir === 1 ? exitHigh(i) >= tp : exitLow(i) <= tp;
    if (hitSl) return { exit: sl, outcome: "SL" as const };   // stop first when both in one minute
    if (hitTp) return { exit: tp, outcome: "TP" as const };
  }
  const last = day.i16 - 1;
  const close = mode === "mid" ? MC(last) : dir === 1 ? BC[last]! : AC[last]!;
  return { exit: close, outcome: "TIME" as const };
}

function finish(day: Day, mode: Mode, dir: 1 | -1, idx: number, entry: number, risk: number, tpR: number, kind: string, fillBar: boolean): Trade {
  const sl = entry - dir * risk, tp = entry + dir * risk * tpR;
  const res = manage(day, mode, dir, entry, sl, tp, fillBar ? idx + 1 : idx + 1, fillBar ? idx : null);
  const pips = dir * (res.exit - entry) / PIP;
  return { day, dir, entryIdx: idx, entry, risk, r: pips / (risk / PIP), pips, outcome: res.outcome, kind, spread: (AC[idx]! - BC[idx]!) / PIP };
}

type Variant = { name: string; tf: string; entry: "touch" | "sweep" | "sweepStruct" | "placebo"; stop: number; flip?: boolean; offset?: number; rr?: number };

/** One trade per day: the first level that produces an entry between 08:00 and 12:00 NY. */
function runDay(day: Day, v: Variant, mode: Mode, rng: () => number): Trade | null {
  const levels = day.levels[v.tf]!;
  const risk = v.stop * PIP;
  if (v.entry === "placebo") {
    const touched = runDay(day, { ...v, entry: "touch" }, mode, rng);
    if (!touched) return null; // placebo only on days that would have traded
    const idx = day.i8 + Math.floor(rng() * (day.i12 - day.i8));
    const dir: 1 | -1 = rng() < 0.5 ? 1 : -1;
    const entry = mode === "mid" ? MC(idx) : dir === 1 ? AC[idx]! : BC[idx]!;
    return finish(day, mode, dir, idx, entry, risk, v.rr ?? 2, "placebo", false);
  }
  // sweep state per level
  const st = levels.map(() => ({ breachedAt: -1, extreme: NaN, dead: false }));
  for (let i = day.i8; i < day.i12; i++) {
    for (let k = 0; k < levels.length; k++) {
      const L = levels[k]!; const s = st[k]!; if (s.dead) continue;
      const fade: 1 | -1 = L.side === "S" ? 1 : -1;
      if (v.entry === "touch") {
        // buy limit at support fills when ask <= level; sell limit at resistance fills when bid >= level
        // optional resting order beyond the line: buy below support / sell above resistance
        const px = L.price - fade * (v.offset ?? 0) * PIP;
        const touched = L.side === "S" ? (mode === "mid" ? ML(i) : AL[i]!) <= px : (mode === "mid" ? MH(i) : BH[i]!) >= px;
        if (!touched) continue;
        if (v.flip) { // breakout direction instead of fade: enter at market on the touch minute's close
          const dir = (-fade) as 1 | -1; const entry = mode === "mid" ? MC(i) : dir === 1 ? AC[i]! : BC[i]!;
          return finish(day, mode, dir, i, entry, risk, v.rr ?? 2, L.kind, false);
        }
        // if the bar opened beyond the level (gap), fill at the open-ish price = previous close
        let entry = px;
        const prev = mode === "mid" ? MC(i - 1) : fade === 1 ? AC[i - 1]! : BC[i - 1]!;
        if (fade === 1 && prev < entry) entry = prev; if (fade === -1 && prev > entry) entry = prev;
        return finish(day, mode, fade, i, entry, risk, v.rr ?? 2, L.kind, true);
      }
      // sweep: mid trades >=1 pip beyond the level, then an M1 close back inside within 15 minutes,
      // without running more than the stop size beyond the level first.
      const beyond = L.side === "S" ? (L.price - ML(i)) / PIP : (MH(i) - L.price) / PIP;
      if (s.breachedAt < 0) {
        if (beyond >= 1) { s.breachedAt = i; s.extreme = L.side === "S" ? ML(i) : MH(i); }
        else continue;
      } else {
        s.extreme = L.side === "S" ? Math.min(s.extreme, ML(i)) : Math.max(s.extreme, MH(i));
      }
      if (beyond > v.stop) { s.dead = true; continue; }              // that's a break, not a sweep
      if (i - s.breachedAt > 15) { s.dead = true; continue; }        // never reclaimed in time
      const reclaimed = L.side === "S" ? MC(i) > L.price : MC(i) < L.price;
      if (!reclaimed) continue;
      const entry = mode === "mid" ? MC(i) : fade === 1 ? AC[i]! : BC[i]!;
      if (v.entry === "sweep") return finish(day, mode, fade, i, entry, risk, v.rr ?? 2, L.kind, false);
      // structural: stop 1 pip past the sweep extreme (+ spread for shorts), target 2R, risk 3..stop pips
      const slPrice = L.side === "S" ? s.extreme - 1 * PIP : s.extreme + 1 * PIP + (mode === "mid" ? 0 : (AC[i]! - BC[i]!));
      const r = Math.abs(entry - slPrice);
      if (r < 3 * PIP || r > risk) { s.dead = true; continue; }
      return finish(day, mode, fade, i, entry, r, v.rr ?? 2, L.kind, false);
    }
  }
  return null;
}

function seeded(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

function stats(tr: Trade[]) {
  const n = tr.length; if (!n) return null;
  const sum = tr.reduce((a, t) => a + t.r, 0);
  const wins = tr.filter((t) => t.r > 0).length;
  const gw = tr.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), gl = -tr.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
  const mean = sum / n; const sd = Math.sqrt(tr.reduce((a, t) => a + (t.r - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, wr: wins / n, tp: tr.filter((t) => t.outcome === "TP").length / n, time: tr.filter((t) => t.outcome === "TIME").length / n,
    avgR: mean, t: mean / (sd / Math.sqrt(n)), pf: gl ? gw / gl : Infinity, pips: tr.reduce((a, t) => a + t.pips, 0) / n,
    spread: tr.reduce((a, t) => a + t.spread, 0) / n, risk: tr.reduce((a, t) => a + t.risk / PIP, 0) / n };
}

// STOPS / RRS / TAG env vars pick the stop sizes (pips), reward multiples and output suffix.
const STOPS = (process.env.STOPS ?? "6,7.5").split(",").map(Number);
const RRS = (process.env.RRS ?? "2").split(",").map(Number);
const TAG = process.env.TAG ?? "";
const vname = (tf: string, label: string, stop: number, rr: number) => `${tf} ${label.padEnd(15)} SL${stop}/TP${stop * rr}`;
const variants: Variant[] = [];
for (const tf of ["M15", "M5"]) for (const stop of STOPS) for (const rr of RRS) {
  variants.push({ name: vname(tf, "touch", stop, rr), tf, entry: "touch", stop, rr });
  variants.push({ name: vname(tf, "limit 2p past", stop, rr), tf, entry: "touch", stop, rr, offset: 2 });
  variants.push({ name: vname(tf, "sweep+reclaim", stop, rr), tf, entry: "sweep", stop, rr });
  variants.push({ name: vname(tf, "sweep wick stop", stop, rr), tf, entry: "sweepStruct", stop, rr });
  variants.push({ name: vname(tf, "touch BREAK", stop, rr), tf, entry: "touch", stop, rr, flip: true });
  variants.push({ name: vname(tf, "random dir", stop, rr), tf, entry: "placebo", stop, rr });
}

const results: Record<string, { exec: Trade[]; mid: Trade[] }> = {};
for (const v of variants) {
  const r1 = seeded(42), r2 = seeded(42);
  results[v.name] = { exec: [], mid: [] };
  for (const d of days) {
    const e = runDay(d, v, "exec", r1); if (e) results[v.name]!.exec.push(e);
    const m = runDay(d, v, "mid", r2); if (m) results[v.name]!.mid.push(m);
  }
}

const f = (x: number, p = 3) => (x >= 0 ? "+" : "") + x.toFixed(p);
const out: string[] = [];
const P = (s = "") => out.push(s);
P(`EUR/USD — S/R fade at 08:00–12:00 NY, one trade per day   (${days[0]!.key} → ${days.at(-1)!.key}, ${days.length} weekdays)`);
P(`levels = production computeSupportResistanceLevels on mid candles completed before 08:00 NY, frozen for the window`);
P(`fills on OANDA M1 bid/ask ("exec"); "mid" = same trades with no spread. Stop wins same-minute ties. Max hold to 16:00 NY.\n`);
const traded: Record<string, number> = {};
P(`${"variant".padEnd(36)} ${"trades".padStart(6)} ${"days%".padStart(6)} ${"win%".padStart(6)} ${"TP%".padStart(5)} ${"time%".padStart(6)} ${"midR".padStart(7)} ${"execR".padStart(7)} ${"t".padStart(6)} ${"PF".padStart(5)} ${"pips".padStart(6)} ${"spread".padStart(6)} ${"risk".padStart(5)}`);
for (const v of variants) {
  const e = stats(results[v.name]!.exec)!, m = stats(results[v.name]!.mid)!;
  traded[v.name] = e.n;
  P(`${v.name.padEnd(36)} ${String(e.n).padStart(6)} ${(100 * e.n / days.length).toFixed(0).padStart(5)}% ${(100 * e.wr).toFixed(1).padStart(5)}% ${(100 * e.tp).toFixed(0).padStart(4)}% ${(100 * e.time).toFixed(0).padStart(5)}% ${f(m.avgR).padStart(7)} ${f(e.avgR).padStart(7)} ${e.t.toFixed(2).padStart(6)} ${e.pf.toFixed(2).padStart(5)} ${f(e.pips, 2).padStart(6)} ${e.spread.toFixed(2).padStart(6)} ${e.risk.toFixed(1).padStart(5)}`);
}

const focus = variants.filter((v) => !v.flip && v.stop === STOPS.at(-1) && v.rr === RRS[0]).map((v) => v.name);
P(`\nBy year — exec avgR per trade (n)`);
const years = [...new Set(days.map((d) => d.year))];
P(`${"variant".padEnd(36)} ` + years.map((y) => String(y).padStart(13)).join(""));
for (const name of focus) {
  const tr = results[name]!.exec;
  P(`${name.padEnd(36)} ` + years.map((y) => { const s = stats(tr.filter((t) => t.day.year === y)); return s ? `${f(s.avgR, 2)} (${s.n})`.padStart(13) : "".padStart(13); }).join(""));
}
P(`\nYears positive (exec):`);
for (const name of focus) {
  const tr = results[name]!.exec; const pos = years.filter((y) => (stats(tr.filter((t) => t.day.year === y))?.avgR ?? 0) > 0).length;
  P(`  ${name.padEnd(36)} ${pos}/${years.length}`);
}

P(`\n2021+ split by USD high-impact news inside 08:00–12:00 NY — exec avgR (n, win%)`);
for (const name of focus) {
  const tr = results[name]!.exec.filter((t) => t.day.news !== null);
  const cell = (x: Trade[]) => { const s = stats(x); return s ? `${f(s.avgR, 3)} (${s.n}, ${(100 * s.wr).toFixed(0)}%)` : "-"; };
  P(`  ${name.padEnd(36)} news ${cell(tr.filter((t) => t.day.news)).padEnd(22)} no-news ${cell(tr.filter((t) => !t.day.news))}`);
}

P(`\nBy level type — exec avgR (n)`);
for (const name of focus.filter((n) => !n.includes("random"))) {
  const tr = results[name]!.exec;
  const cell = (k: string) => { const s = stats(tr.filter((t) => t.kind === k)); return s ? `${f(s.avgR, 3)} (${s.n})` : "-"; };
  P(`  ${name.padEnd(36)} range ${cell("range").padEnd(18)} swing ${cell("swing")}`);
}

P(`\nRecent 2024–2026 only — exec avgR (n, win%)`);
for (const name of focus) {
  const s = stats(results[name]!.exec.filter((t) => t.day.year >= 2024))!;
  P(`  ${name.padEnd(36)} ${f(s.avgR, 3)} (${s.n}, ${(100 * s.wr).toFixed(1)}%)  t=${s.t.toFixed(2)}`);
}

const noLevelDays = days.length - traded[vname("M15", "touch", STOPS.at(-1)!, RRS[0]!)]!;
P(`\nDays where no M15 level was reached 08–12 NY (no trade): ${noLevelDays} / ${days.length} (${(100 * noLevelDays / days.length).toFixed(0)}%)`);
P(`Breakeven win rate = ${RRS.map((r) => `1:${r} ${(100 / (1 + r)).toFixed(1)}%`).join(", ")} before costs.`);
const text = out.join("\n");
console.log(text);
fs.writeFileSync(`C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/sr-8am-1to2/REPORT${TAG}.txt`, text);
const csv = ["variant,date,dir,kind,entry_utc,entry,risk_pips,outcome,r,pips,spread,news"];
for (const name of focus) for (const t of results[name]!.exec) csv.push([name.trim(), t.day.key, t.dir, t.kind, new Date(T[t.entryIdx]!).toISOString(), t.entry.toFixed(5), (t.risk / PIP).toFixed(1), t.outcome, t.r.toFixed(3), t.pips.toFixed(1), t.spread.toFixed(2), t.day.news].join(","));
fs.writeFileSync(`C:/Users/arche/Desktop/code/GoldenXperience/api-server/research-v2/sr-8am-1to2/TRADES${TAG}.csv`, csv.join("\n"));
