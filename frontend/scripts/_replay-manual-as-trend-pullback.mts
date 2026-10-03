// Replay the user's last-2-weeks manual trades as TrendPullbackV1 plans: at each
// trade's open time, run the rule on the candles available then, then simulate
// its limit entry, stop and target on OANDA M1 bid/ask. Fixed $200 risk/trade.
import { readFileSync } from "node:fs";
process.loadEnvFile("../api-server/.env");
import { analyzeTrendPullbackV1, type TrendPullbackMode } from "../src/lib/strategy/trend-pullback-v1";
import type { Candle, MajorInstrument } from "../src/types/forex";

const HOST = "https://api-fxpractice.oanda.com";
const H = { Authorization: `Bearer ${process.env.OANDA_API_KEY}` };
const RISK_USD = 200;
const GRAN_MS: Record<string, number> = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D: 86_400_000 };
const trades = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Array<{
  pair: string; direction: "long" | "short"; opened_at: string; entry: string; stop: string; target: string;
  result_r: string | null; paper_pl: string | null; status: string;
}>;

type BA = { time: string; bid: { h: string; l: string; c: string }; ask: { h: string; l: string; c: string } };

async function mid(inst: string, gran: string, to: string, count: number): Promise<Candle[]> {
  const url = `${HOST}/v3/instruments/${inst}/candles?price=M&granularity=${gran}&to=${encodeURIComponent(to)}&count=${count}`;
  const j = (await (await fetch(url, { headers: H })).json()) as { candles: Array<{ time: string; volume: number; complete: boolean; mid: { o: string; h: string; l: string; c: string } }> };
  return j.candles.map((c) => ({ time: c.time, volume: c.volume, complete: c.complete, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c }))
    // Only candles fully closed before the trade time. OANDA's `complete` is
    // judged against today, so check the candle's end against `to` instead.
    .filter((c) => Date.parse(c.time) + GRAN_MS[gran]! <= Date.parse(to));
}

const m1Cache = new Map<string, BA[]>();
async function m1(inst: string, from: string): Promise<BA[]> {
  const key = `${inst}|${from}`;
  if (m1Cache.has(key)) return m1Cache.get(key)!;
  const out: BA[] = [];
  let t = from;
  for (;;) {
    const url = `${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M1&from=${encodeURIComponent(t)}&count=5000`;
    const j = (await (await fetch(url, { headers: H })).json()) as { candles?: BA[] };
    const cs = j.candles ?? [];
    if (!cs.length) break;
    out.push(...cs);
    if (cs.length < 5000) break;
    t = new Date(Date.parse(cs.at(-1)!.time) + 60_000).toISOString();
  }
  m1Cache.set(key, out);
  return out;
}

/** Limit entry within `expiryH`, then stop/target (stop first on a shared bar). */
function simulate(bars: BA[], long: boolean, entry: number, stop: number, target: number, expiryH: number, startMs: number, market = false) {
  let filled: number | null = market ? startMs : null;
  let last = 0;
  for (const k of bars) {
    const t = Date.parse(k.time);
    if (filled === null) {
      if (t - startMs > expiryH * 3_600_000) return { out: "no fill", r: 0, hours: null as number | null };
      // A buy limit fills on the ask, a sell limit on the bid.
      if (long ? +k.ask.l <= entry : +k.bid.h >= entry) filled = t; else continue;
    }
    const hi = long ? +k.bid.h : +k.ask.h, lo = long ? +k.bid.l : +k.ask.l;
    const risk = Math.abs(entry - stop);
    if (long ? lo <= stop : hi >= stop) return { out: "SL", r: -1, hours: (t - startMs) / 3_600_000 };
    if (long ? hi >= target : lo <= target) return { out: "TP", r: Math.abs(target - entry) / risk, hours: (t - startMs) / 3_600_000 };
    last = long ? +k.bid.c : +k.ask.c;
  }
  if (filled === null) return { out: "no fill", r: 0, hours: null };
  return { out: "open", r: (long ? last - entry : entry - last) / Math.abs(entry - stop), hours: null };
}

const rows: Record<string, unknown>[] = [];
const totals: Record<string, { usd: number; tp: number; sl: number; open: number; nofill: number }> = {};
const add = (k: string, out: string, r: number) => {
  const t = (totals[k] ??= { usd: 0, tp: 0, sl: 0, open: 0, nofill: 0 });
  t.usd += r * RISK_USD;
  if (out === "TP") t.tp++; else if (out === "SL") t.sl++; else if (out === "open") t.open++; else t.nofill++;
};

for (const tr of trades) {
  const inst = tr.pair.replace("/", "_") as MajorInstrument;
  const at = new Date(tr.opened_at).toISOString();
  const atMs = Date.parse(at);
  const bars = await m1(inst, at);
  const price = bars[0] ? (+bars[0].bid.c + +bars[0].ask.c) / 2 : null;
  const row: Record<string, unknown> = { opened: at.slice(5, 16).replace("T", " "), pair: tr.pair, yours: tr.direction };

  // Your trade with its own levels, held to TP/SL, at $200 risk (the baseline).
  const e = +tr.entry, s = +tr.stop, tp = +tr.target;
  if (tp !== e) {
    const mine = simulate(bars, tr.direction === "long", e, s, tp, 0, atMs, true);
    add("yours held", mine.out, mine.r);
  }

  for (const mode of ["normal", "swing"] as TrendPullbackMode[]) {
    const [base, htf1, htf2] = mode === "swing" ? ["H1", "H4", "D"] : ["M15", "H1", "H4"];
    const [candles, h1Candles, h4Candles] = await Promise.all([
      mid(inst, base, at, 500), mid(inst, htf1, at, 300), mid(inst, htf2, at, 300),
    ]);
    const plan = analyzeTrendPullbackV1({ instrument: inst, candles, h1Candles, h4Candles, currentPrice: price, mode, now: atMs });
    if (!plan.action || plan.entry === null) { row[mode] = "no plan"; continue; }
    const long = plan.action === "LONG";
    // Wide stop: swing mode's own stop, or normal mode's structure stop when it has one.
    const useStructure = mode === "normal" && plan.structureStop?.available;
    const stop = useStructure && plan.structureStop?.available ? plan.structureStop.stop : plan.stopLoss!;
    const target = useStructure && plan.structureStop?.available ? plan.structureStop.takeProfit : plan.takeProfit!;
    const expiryH = mode === "swing" ? 48 : 4;
    // A plan "available now" is a market order at the current price.
    const entry = plan.status === "ENTRY_AVAILABLE_NOW" && price ? price : plan.entry;
    const sim = simulate(bars, long, entry, stop, target, expiryH, atMs);
    add(`rule ${mode}`, sim.out, sim.r);
    const stopPips = Math.abs(entry - stop) / (inst.includes("JPY") ? 0.01 : 0.0001);
    row[`${mode} dir`] = `${long ? "long" : "short"}${plan.counterTrend ? " (ctr)" : ""}`;
    row[`${mode} stop`] = Math.round(stopPips);
    row[`${mode} →`] = `${sim.out}${sim.hours !== null ? ` ${sim.hours.toFixed(0)}h` : ""}`;
    row[`${mode} $`] = Math.round(sim.r * RISK_USD);
  }
  rows.push(row);
}

console.table(rows);
for (const [k, t] of Object.entries(totals)) {
  console.log(`${k.padEnd(12)} $${Math.round(t.usd)}  TP ${t.tp}  SL ${t.sl}  open ${t.open}  no fill ${t.nofill}`);
}
const agree = rows.filter((r) => r["swing dir"] && String(r["swing dir"]).startsWith(String(r.yours))).length;
const agreeN = rows.filter((r) => r["normal dir"] && String(r["normal dir"]).startsWith(String(r.yours))).length;
console.log(`Your direction matched the rule's trend: normal ${agreeN}/${rows.length}, swing ${agree}/${rows.length}`);
