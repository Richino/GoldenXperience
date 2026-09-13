/** V10 signal-parity: does evaluateEurusdPhase4V10 reproduce the 197 TV cohort exactly? RESEARCH ONLY. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const DIR = import.meta.dirname;
for (const line of (() => { try { return readFileSync(resolve(DIR, "../../.env"), "utf8").split(/\r?\n/); } catch { return []; } })()) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, ""); }
const env = (k: string) => (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
import { evaluateEurusdPhase4V10 } from "../../../frontend/src/lib/strategy/strategies/eurusd-phase4-v10-strategy.js";
import type { Candle } from "../../../frontend/src/types/forex.js";

function nyOffset(y: number, mo: number, d: number, h: number) { const s = (() => { const f = new Date(Date.UTC(y, 2, 1)).getUTCDay(); return ((7 - f) % 7) + 1 + 7; })(); const n = (() => { const f = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return ((7 - f) % 7) + 1; })(); const a = mo > 3 || (mo === 3 && (d > s || (d === s && h >= 2))); const b = mo < 11 || (mo === 11 && (d < n || (d === n && h < 2))); return a && b ? -4 : -5; }
function nyToUtc(local: string) { const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local.trim())!; const [, ys, mos, ds, hs, mis] = m; const y = +ys!, mo = +mos!, d = +ds!, h = +hs!, mi = +mis!; return new Date(Date.UTC(y, mo - 1, d, h - nyOffset(y, mo, d, h), mi)).toISOString(); }

async function fetchH1() { const out: any[] = []; let cursor = "2022-10-01T00:00:00Z"; const toMs = Date.now(); for (let g = 0; g < 400; g++) { const url = `${host}/v3/instruments/EUR_USD/candles?price=M&granularity=H1&from=${encodeURIComponent(cursor)}&count=5000`; const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`${r.status}`); const j: any = await r.json(); const b = j.candles ?? []; if (!b.length) break; for (const c of b) out.push(c); const last = b.at(-1); if (Date.parse(last.time) >= toMs || b.length < 5000) break; cursor = new Date(Date.parse(last.time) + 3_600_000).toISOString(); } return out.filter((c) => c.complete).map((c) => ({ time: new Date(Date.parse(c.time)).toISOString(), open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, volume: c.volume, complete: true }) as Candle); }

function cohort() { const txt = readFileSync(resolve(DIR, "tradingview-trades.csv"), "utf8").replace(/^﻿/, ""); const rows = txt.split(/\r?\n/).filter((l) => l.trim()); const h = rows[0]!.split(","); const iType = h.indexOf("Type"), iTime = h.indexOf("Date and time"), iSig = h.indexOf("Signal"); const out: Array<{ utc: string; setup: string }> = []; for (const row of rows.slice(1)) { const c = row.split(","); if (c[iType] !== "Entry long") continue; out.push({ utc: nyToUtc(c[iTime]!), setup: c[iSig]! }); } return out; }

async function main() {
  const cs = await fetchH1();
  const tv = cohort();
  const tvKey = new Set(tv.map((t) => `${t.utc}|${t.setup}`));
  const firstOrigin = Date.parse(tv[0]!.utc), lastOrigin = Date.parse(tv.at(-1)!.utc);
  const tsSignals: Array<{ time: string; setup: string }> = [];
  for (let i = 4; i < cs.length; i++) {
    const h = new Date(cs[i]!.time).getUTCHours();
    if (h !== 7 && h !== 8 && h !== 10) continue;
    const t = Date.parse(cs[i]!.time); if (t < firstOrigin || t > lastOrigin) continue;
    const p = evaluateEurusdPhase4V10(cs.slice(0, i + 1));
    if (p.strategySignalQualified) tsSignals.push({ time: cs[i]!.time, setup: p.setup! });
  }
  const tsKey = new Set(tsSignals.map((s) => `${s.time}|${s.setup}`));
  const exact = [...tvKey].filter((k) => tsKey.has(k));
  const tvOnly = [...tvKey].filter((k) => !tsKey.has(k)).sort();
  const tsOnly = [...tsKey].filter((k) => !tvKey.has(k)).sort();
  const bySetup: Record<string, { tv: number; ts: number }> = {};
  for (const t of tv) (bySetup[t.setup] ??= { tv: 0, ts: 0 }).tv++;
  for (const s of tsSignals) (bySetup[s.setup] ??= { tv: 0, ts: 0 }).ts++;
  console.log("=== V10 SIGNAL PARITY (2023-02-01 .. last cohort origin) ===");
  console.log(`TV cohort entries: ${tvKey.size}`);
  console.log(`TS evaluator signals: ${tsKey.size}`);
  console.log(`EXACT (time+setup) matches: ${exact.length}`);
  console.log(`TV ONLY (missed by TS): ${tvOnly.length}`);
  console.log(`TS ONLY (extra TS): ${tsOnly.length}`);
  console.log("by setup:", JSON.stringify(bySetup));
  if (tvOnly.length) console.log("TV-only sample:", tvOnly.slice(0, 20));
  if (tsOnly.length) console.log("TS-only sample:", tsOnly.slice(0, 20));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
