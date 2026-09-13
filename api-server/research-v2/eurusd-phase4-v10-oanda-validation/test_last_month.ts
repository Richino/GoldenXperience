/** Last-month replay of BOTH EURUSD strategies: V10 (frozen cohort) + London BO. RESEARCH ONLY, no orders. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const DIR = import.meta.dirname;
for (const line of (() => { try { return readFileSync(resolve(DIR, "../../.env"), "utf8").split(/\r?\n/); } catch { return []; } })()) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, ""); }
const env = (k: string) => (process.env[k] ?? "").trim().replace(/^["']|["']$/g, "");
const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
const host = env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
import { evaluateEurusdStrategy } from "../../../frontend/src/lib/strategy/strategies/eurusd-strategy.js";
import type { StrategyEvaluationInput } from "../../../frontend/src/lib/strategy/types.js";
import type { Candle } from "../../../frontend/src/types/forex.js";

const NOW = Date.now();
const MONTH_START = Date.parse("2026-08-11T00:00:00Z");

async function fetchCandles(gran: string, price: string, fromISO: string) {
  const out: any[] = []; let cursor = fromISO; const step = gran === "M1" ? 60_000 : 3_600_000;
  for (let g = 0; g < 400; g++) {
    const url = `${host}/v3/instruments/EUR_USD/candles?price=${price}&granularity=${gran}&from=${encodeURIComponent(cursor)}&count=5000`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`${gran} ${r.status}`);
    const j: any = await r.json(); const b = j.candles ?? []; if (!b.length) break; for (const c of b) out.push(c);
    const last = b.at(-1); if (Date.parse(last.time) >= NOW || b.length < 5000) break; cursor = new Date(Date.parse(last.time) + step).toISOString();
  }
  return out;
}

// ---------- V10 last month from the validated cohort ----------
function v10LastMonth() {
  const rows = readFileSync(resolve(DIR, "trade_replay.csv"), "utf8").split(/\r?\n/).filter((l) => l.trim());
  const h = rows[0]!.split(",");
  const idx = (k: string) => h.indexOf(k);
  const trades = rows.slice(1).map((r) => r.split(",")).filter((c) => Date.parse(c[idx("originUtc")]!) >= MONTH_START);
  const frozenR = trades.map((c) => +c[idx("frozenR")]!);
  const execR = trades.map((c) => +c[idx("B_R")]!);
  const stat = (rs: number[]) => { const n = rs.length, w = rs.filter((x) => x > 0).length, tot = rs.reduce((s, x) => s + x, 0); return { n, w, l: n - w, wr: n ? w / n * 100 : 0, net: tot }; };
  return { trades: trades.map((c) => ({ time: c[idx("originUtc")], setup: c[idx("setup")], frozenR: +c[idx("frozenR")]!, execReason: c[idx("B_reason")], execR: +c[idx("B_R")]! })), frozen: stat(frozenR), exec: stat(execR) };
}

// ---------- London BO last month replay ----------
function baseInput(c1h: Candle[], last: Candle): StrategyEvaluationInput {
  return { instrument: "EUR_USD" as StrategyEvaluationInput["instrument"], accountBalance: 10000, accountCurrency: "USD", dataSource: "oanda", candles15m: [], candles1h: c1h, candles4h: [], bid: last.close, ask: last.close, spreadPips: 1, marketOpen: true, calendarConnected: true, highImpactNewsWithinMinutes: null, evaluatedAt: new Date(Date.parse(last.time) + 3_600_000).toISOString(), newsRequired: false, evaluationMode: "live" };
}

async function main() {
  // ---- V10 ----
  const v10 = v10LastMonth();

  // ---- London BO ----
  const h1raw = await fetchCandles("H1", "M", new Date(MONTH_START - 40 * 24 * 3_600_000).toISOString());
  const h1 = h1raw.filter((c) => c.complete).map((c) => ({ time: new Date(Date.parse(c.time)).toISOString(), open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, volume: c.volume, complete: true }) as Candle);
  const m1raw = await fetchCandles("M1", "BA", new Date(MONTH_START).toISOString());
  const m1 = m1raw.filter((c) => c.complete).map((c) => ({ t: Date.parse(c.time), bh: +c.bid.h, bl: +c.bid.l, bc: +c.bid.c, ah: +c.ask.h, al: +c.ask.l, ao: +c.ask.o, bo: +c.bid.o })).sort((a, b) => a.t - b.t);

  const signals: any[] = [];
  for (let i = 60; i < h1.length; i++) {
    const t = Date.parse(h1[i]!.time); if (t < MONTH_START || t > NOW) continue;
    const cand: any = evaluateEurusdStrategy(baseInput(h1.slice(0, i + 1), h1[i]!));
    if (cand.direction) signals.push({ time: h1[i]!.time, dir: cand.direction, close: h1[i]!.close, atr: cand.regime.atr });
  }
  // sequential one-position (pyramiding=0), executable resolution on M1
  const trades: any[] = []; let freeAt = 0;
  for (const s of signals) {
    const fill = Date.parse(s.time) + 3_600_000; if (fill < freeAt) continue; if (!(s.atr > 0)) continue;
    const win = m1.filter((c) => c.t >= fill && c.t <= fill + 48 * 3_600_000);
    const first = win[0]; if (!first) continue;
    const long = s.dir === "long";
    const entry = long ? first.ao : first.bo;
    const stop = long ? entry - s.atr : entry + s.atr;
    const target = long ? entry + 2 * s.atr : entry - 2 * s.atr;
    let reason = "OPEN", R: number | null = null, exitT = fill;
    for (const c of win) {
      const slHit = long ? c.bl <= stop : c.ah >= stop;
      const tpHit = long ? c.bh >= target : c.al <= target;
      if (slHit && tpHit) { reason = "AMBIGUOUS"; R = -1; exitT = c.t; break; }
      if (slHit) { reason = "SL"; R = -1; exitT = c.t; break; }
      if (tpHit) { reason = "TP"; R = 2; exitT = c.t; break; }
    }
    if (reason !== "OPEN") { freeAt = exitT; trades.push({ time: s.time, dir: s.dir, reason, R }); }
    else trades.push({ time: s.time, dir: s.dir, reason: "OPEN", R: null });
  }
  const closed = trades.filter((t) => t.R != null);
  const w = closed.filter((t) => t.R > 0).length;
  const net = closed.reduce((s, t) => s + t.R, 0);

  // ---- report ----
  console.log(`\n================  LAST MONTH (${new Date(MONTH_START).toISOString().slice(0, 10)} -> ${new Date(NOW).toISOString().slice(0, 10)})  ================\n`);
  console.log("### EURUSD Phase 4 V10 (Frozen Confirmation, 1:1)  — from validated cohort");
  console.log(`Trades taken: ${v10.frozen.n}`);
  console.log(`  TradingView (frozen, midpoint):  ${v10.frozen.w}W / ${v10.frozen.l}L  = WR ${v10.frozen.wr.toFixed(1)}%  netR ${v10.frozen.net >= 0 ? "+" : ""}${v10.frozen.net.toFixed(2)}`);
  console.log(`  OANDA executable (real 1R fill): ${v10.exec.w}W / ${v10.exec.l}L  = WR ${v10.exec.wr.toFixed(1)}%  netR ${v10.exec.net >= 0 ? "+" : ""}${v10.exec.net.toFixed(2)}`);
  for (const t of v10.trades) console.log(`   ${t.time.slice(0, 16).replace("T", " ")}  ${t.setup.padEnd(16)} TV=${t.frozenR >= 0 ? "+" : ""}${t.frozenR.toFixed(2)}  EXEC ${t.execReason} ${t.execR >= 0 ? "+" : ""}${t.execR.toFixed(2)}`);

  console.log(`\n### EURUSD London Breakout (existing deployed strategy, 1:2)  — replayed executable`);
  console.log(`Trades taken: ${closed.length}${trades.length - closed.length ? ` (+${trades.length - closed.length} still open)` : ""}`);
  console.log(`  ${w}W / ${closed.length - w}L  = WR ${closed.length ? (w / closed.length * 100).toFixed(1) : "n/a"}%  netR ${net >= 0 ? "+" : ""}${net.toFixed(2)}`);
  for (const t of trades) console.log(`   ${t.time.slice(0, 16).replace("T", " ")}  ${t.dir.padEnd(5)} ${t.reason} ${t.R == null ? "" : (t.R >= 0 ? "+" : "") + t.R.toFixed(2)}`);

  console.log(`\n### COMBINED (both EURUSD strategies, last month)`);
  const cTrades = v10.exec.n + closed.length, cW = v10.exec.w + w;
  console.log(`  Total trades: ${cTrades}   Wins: ${cW}   Losses: ${cTrades - cW}   Win rate: ${cTrades ? (cW / cTrades * 100).toFixed(1) : "n/a"}%`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
