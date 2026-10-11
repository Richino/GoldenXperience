/** Rank Mon–Fri (NY) for each major pair — 08:00–16:00 session stats on M15 mid. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";
import { pipSizeFor } from "../../frontend/src/lib/instruments/catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of [".env", ".env.local"]) loadDotenv({ path: path.join(root, name), override: false });
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const CACHE_DIR = path.join(root, "research-v2", "weekday-scan", "cache");
const OUT = path.join(root, "research-v2", "weekday-scan", "ALL-PAIRS-WEEKDAY.txt");
const FROM = "2021-01-04T00:00:00.000Z";
const TO = "2026-08-05T00:00:00.000Z";
const MIN = 60_000;
const BAR = 15 * MIN;
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type Bar = { t: number; open: number; high: number; low: number; close: number; spread: number };

const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
const host =
  process.env.OANDA_ENVIRONMENT === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";

async function loadM15(instrument: string): Promise<Bar[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${instrument}_M15.json`);
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Bar[];
  }

  const { query } = await import("../src/database.js");
  const db = await query<{
    close_time: string;
    bid_open: number;
    bid_high: number;
    bid_low: number;
    bid_close: number;
    ask_open: number;
    ask_high: number;
    ask_low: number;
    ask_close: number;
  }>(
    `SELECT close_time::text,bid_open::float,bid_high::float,bid_low::float,bid_close::float,
            ask_open::float,ask_high::float,ask_low::float,ask_close::float
       FROM market_candle_quotes
      WHERE instrument=$1 AND timeframe='M15' AND source='oanda'
        AND close_time >= $2 AND close_time < $3
      ORDER BY close_time`,
    [instrument, FROM, TO],
  );

  let bars: Bar[] = [];
  if (db.rows.length >= 5000) {
    bars = db.rows.map((r) => ({
      t: Date.parse(r.close_time),
      open: (r.bid_open + r.ask_open) / 2,
      high: (r.bid_high + r.ask_high) / 2,
      low: (r.bid_low + r.ask_low) / 2,
      close: (r.bid_close + r.ask_close) / 2,
      spread: r.ask_close - r.bid_close,
    }));
  } else if (token) {
    let cursor = FROM;
    for (let page = 0; page < 80; page++) {
      const url = `${host}/v3/instruments/${instrument}/candles?price=BA&granularity=M15&count=5000&from=${encodeURIComponent(cursor)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`${instrument} fetch ${res.status}`);
      const json = (await res.json()) as {
        candles?: Array<{ complete: boolean; time: string; bid: Record<string, string>; ask: Record<string, string> }>;
      };
      const batch = (json.candles ?? []).filter((c) => c.complete);
      for (const c of batch) {
        const t = Date.parse(c.time) + BAR;
        if (t >= Date.parse(TO)) continue;
        const mid = (k: string) => (+c.bid[k]! + +c.ask[k]!) / 2;
        bars.push({
          t,
          open: mid("o"),
          high: mid("h"),
          low: mid("l"),
          close: mid("c"),
          spread: +c.ask.c! - +c.bid.c!,
        });
      }
      if (batch.length < 5000) break;
      const last = batch.at(-1)!.time;
      cursor = new Date(Date.parse(last) + BAR).toISOString();
      if (Date.parse(cursor) >= Date.parse(TO)) break;
    }
    bars.sort((a, b) => a.t - b.t);
  } else {
    throw new Error(`No data for ${instrument} (DB=${db.rows.length}, no OANDA token)`);
  }

  fs.writeFileSync(cacheFile, JSON.stringify(bars));
  return bars;
}

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
  return new Date(utcMs + off * 3_600_000).getUTCDay();
}
function lb(arr: Bar[], t: number) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m]!.t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

type DowStats = { n: number; range816: number[]; net816: number[]; oneWay: number; hr1Cont: number; hr1N: number; spread8112: number[] };
function scanPair(instrument: string, m15: Bar[]) {
  const pip = pipSizeFor(instrument);
  const acc: Record<number, DowStats> = {};
  for (let d = 0; d < 7; d++) acc[d] = { n: 0, range816: [], net816: [], oneWay: 0, hr1Cont: 0, hr1N: 0, spread8112: [] };

  for (let t = Date.UTC(2021, 0, 4); t < m15.at(-1)!.t; t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();
    const t8 = nyToUtc(y, m, dd, 8);
    const t9 = nyToUtc(y, m, dd, 9);
    const t12 = nyToUtc(y, m, dd, 12);
    const t16 = nyToUtc(y, m, dd, 16);
    const dow = nyWeekday(t8);
    if (dow < 1 || dow > 5) continue;

    const i8 = lb(m15, t8);
    const i9 = lb(m15, t9);
    const i12 = lb(m15, t12);
    const i16 = lb(m15, t16);
    if (i16 - i8 < 20 || Math.abs(m15[i8]!.t - t8) > BAR) continue;

    const open8 = m15[i8]!.open;
    let hi16 = -Infinity;
    let lo16 = Infinity;
    let cross = 0;
    let side = 0;
    let spreadSum = 0;
    let spreadN = 0;
    for (let i = i8; i < i16; i++) {
      const b = m15[i]!;
      hi16 = Math.max(hi16, b.high);
      lo16 = Math.min(lo16, b.low);
      const s = b.close > open8 ? 1 : b.close < open8 ? -1 : 0;
      if (s && side && s !== side) cross++;
      if (s) side = s;
      if (b.t < t12) {
        spreadSum += b.spread;
        spreadN++;
      }
    }
    const close16 = m15[i16 - 1]!.close;
    const net = (close16 - open8) / pip;
    const upLeg = (hi16 - open8) / pip;
    const downLeg = (open8 - lo16) / pip;
    const range816 = (hi16 - lo16) / pip;
    const hr1 = i9 < i16 ? (m15[i9]!.open - open8) / pip : 0;

    let oneWay = false;
    if (range816 >= 18 && Math.abs(net) >= 8 && cross <= 2) {
      if (net >= 8 && downLeg <= 0.35 * upLeg) oneWay = true;
      if (net <= -8 && upLeg <= 0.35 * downLeg) oneWay = true;
    }

    const a = acc[dow]!;
    a.n++;
    a.range816.push(range816);
    a.net816.push(Math.abs(net));
    if (oneWay) a.oneWay++;
    if (Math.abs(hr1) >= 5) {
      a.hr1N++;
      if (Math.sign(hr1) === Math.sign(net) && Math.abs(net) >= 5) a.hr1Cont++;
    }
    if (spreadN) a.spread8112.push(spreadSum / spreadN / pip);
  }

  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  const rows = [];
  for (let dow = 1; dow <= 5; dow++) {
    const a = acc[dow]!;
    const medRange = med(a.range816);
    const medNet = med(a.net816);
    const oneWayPct = a.n ? (100 * a.oneWay) / a.n : 0;
    const hr1Pct = a.hr1N ? (100 * a.hr1Cont) / a.hr1N : 0;
    const medSpread = med(a.spread8112);
    const score = medRange * 0.35 + medNet * 0.25 + hr1Pct * 0.25 + oneWayPct * 0.15 - medSpread * 8;
    rows.push({ name: NAMES[dow]!, n: a.n, medRange, medNet, oneWayPct, hr1Pct, medSpread, score });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

const lines: string[] = [];
const bestByPair: { pair: string; best: string; rank: string; nDays: number }[] = [];

for (const instrument of MAJOR_INSTRUMENTS) {
  process.stderr.write(`load ${instrument}...\n`);
  try {
    const bars = await loadM15(instrument);
    if (bars.length < 1000) {
      lines.push(`${instrument}: insufficient bars (${bars.length})\n`);
      continue;
    }
    const rows = scanPair(instrument, bars);
    const label = instrument.replace("_", "/");
    lines.push(`=== ${label}  (${bars[0]!.t ? new Date(bars[0]!.t).toISOString().slice(0, 10) : "?"} → ${new Date(bars.at(-1)!.t).toISOString().slice(0, 10)}, M15 mid, NY 08:00–16:00)`);
    lines.push(`Best → worst: ${rows.map((r) => r.name).join(" > ")}`);
    lines.push(
      `  #1 ${rows[0]!.name}: med range ${rows[0]!.medRange.toFixed(1)} pips, |net| ${rows[0]!.medNet.toFixed(1)}, 1-way ${rows[0]!.oneWayPct.toFixed(1)}%, 1hr→day ${rows[0]!.hr1Pct.toFixed(1)}%, spread ${rows[0]!.medSpread.toFixed(2)} pips`,
    );
    lines.push(`  Mon range ${rows.find((r) => r.name === "Mon")!.medRange.toFixed(1)} pips vs ${rows[0]!.name} ${rows[0]!.medRange.toFixed(1)} pips\n`);
    bestByPair.push({
      pair: label,
      best: rows[0]!.name,
      rank: rows.map((r) => r.name).join(">"),
      nDays: rows.reduce((s, r) => s + r.n, 0) / 5,
    });
  } catch (e) {
    lines.push(`${instrument}: ${e instanceof Error ? e.message : e}\n`);
  }
}

lines.push("=== SUMMARY — best NY weekday per pair ===");
for (const b of bestByPair.sort((a, b) => a.pair.localeCompare(b.pair))) {
  lines.push(`  ${b.pair.padEnd(8)} → ${b.best.padEnd(3)}  (${b.rank})`);
}
const dayVotes: Record<string, number> = {};
for (const b of bestByPair) dayVotes[b.best] = (dayVotes[b.best] ?? 0) + 1;
lines.push(`\nVote count (#1 rank across pairs): ${Object.entries(dayVotes).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}=${n}`).join(", ")}`);

const text = lines.join("\n");
console.log(text);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
