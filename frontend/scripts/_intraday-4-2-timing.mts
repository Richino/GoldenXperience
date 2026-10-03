// Normal-mode 4:2 (base = 1x H1 ATR14, min 10 pips): how big is the target
// next to the average daily range, and how often does a trade resolve within
// the day? Random market entries every 3h, 14 majors, 2021-10..2026-10, M5 bid/ask.
import fs from "node:fs";
const DIR = process.argv[2]!;
const PAIRS = ["EUR_USD","GBP_USD","USD_JPY","AUD_USD","NZD_USD","USD_CAD","USD_CHF","EUR_GBP","EUR_JPY","CAD_JPY","NZD_JPY","GBP_JPY","AUD_JPY","EUR_AUD"];
const rows = [];
const all = { n: 0, by4: 0, by8: 0, by16: 0, by24: 0, tp: 0, hours: [] as number[] };
for (const inst of PAIRS) {
  const pip = inst.includes("JPY") ? 0.01 : 0.0001;
  const h1 = JSON.parse(fs.readFileSync(`${DIR}/${inst}_H1.json`, "utf8")) as number[][];
  const d1 = JSON.parse(fs.readFileSync(`${DIR}/${inst}_D.json`, "utf8")) as number[][];
  const recent = d1.filter((d) => d[0]! >= Date.parse("2021-10-01"));
  const adr = recent.reduce((s, d) => s + (d[2]! - d[3]!), 0) / recent.length / pip;
  const buf = fs.readFileSync(`${DIR}/${inst}_M5BA.bin`);
  const m5 = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const n5 = m5.length / 9;
  const atr: number[] = []; let prev = 0;
  for (let i = 0; i < h1.length; i++) {
    const [, , h, l, c] = h1[i]!; const pc = i ? h1[i - 1]![4]! : c!;
    const tr = Math.max(h! - l!, Math.abs(h! - pc), Math.abs(l! - pc));
    prev = i < 14 ? (prev * i + tr) / (i + 1) : (prev * 13 + tr) / 14; atr.push(prev);
  }
  const p = { n: 0, by24: 0, tp: 0, base: [] as number[], hours: [] as number[] };
  let k = 0;
  for (let i = 20; i < h1.length; i += 3) {
    const t = h1[i]![0]! + 3_600_000;
    if (t < Date.parse("2021-10-01")) continue;
    while (k < n5 && m5[k * 9]! < t) k++;
    if (k >= n5 - 2000) break;
    if (m5[k * 9]! - t > 2 * 3_600_000) continue;
    const base = Math.max(Number(process.env.BASE ?? 1) * atr[i]!, Number(process.env.MINPIPS ?? 10) * pip);
    // Alternate long/short so direction doesn't matter.
    const long = (p.n % 2) === 0;
    const fill = long ? m5[k * 9 + 5]! : m5[k * 9 + 1]!;
    const stop = long ? fill - 4 * base : fill + 4 * base, tp = long ? fill + 2 * base : fill - 2 * base;
    let end: number | null = null, hit = "";
    for (let j = k; j < n5; j++) {
      const hi = long ? m5[j * 9 + 2]! : m5[j * 9 + 6]!, lo = long ? m5[j * 9 + 3]! : m5[j * 9 + 7]!;
      if (long ? lo <= stop : hi >= stop) { end = m5[j * 9]!; hit = "SL"; break; }
      if (long ? hi >= tp : lo <= tp) { end = m5[j * 9]!; hit = "TP"; break; }
      if (m5[j * 9]! - t > 30 * 86_400_000) break;
    }
    if (end === null) continue;
    const hrs = (end - t) / 3_600_000;
    p.n++; p.base.push(base / pip); p.hours.push(hrs); if (hrs <= 24) p.by24++; if (hit === "TP") p.tp++;
    all.n++; all.hours.push(hrs); if (hrs <= 4) all.by4++; if (hrs <= 8) all.by8++; if (hrs <= 16) all.by16++; if (hrs <= 24) all.by24++; if (hit === "TP") all.tp++;
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  const tpPips = 2 * med(p.base);
  rows.push({ pair: inst, "avg daily range": Math.round(adr), "typical TP": Math.round(tpPips), "TP % of day": Math.round(100 * tpPips / adr), "typical SL": Math.round(2 * tpPips), "done ≤24h %": Math.round(100 * p.by24 / p.n), "median hours": med(p.hours).toFixed(1), "TP hit %": Math.round(100 * p.tp / p.n) });
}
console.table(rows);
const med = [...all.hours].sort((a, b) => a - b)[Math.floor(all.n / 2)]!;
console.log(`ALL n=${all.n}: done ≤4h ${Math.round(100*all.by4/all.n)}%, ≤8h ${Math.round(100*all.by8/all.n)}%, ≤16h ${Math.round(100*all.by16/all.n)}%, ≤24h ${Math.round(100*all.by24/all.n)}%, median ${med.toFixed(1)}h, TP hit ${Math.round(100*all.tp/all.n)}%`);
