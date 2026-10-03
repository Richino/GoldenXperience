// For each manual trade: did it follow TrendPullbackV1 at the moment it was
// opened (direction and pullback entry), in normal and swing mode? Also tags
// its TP 2× / SL 4× outcome so losers can be compared with winners.
import { readFileSync } from "node:fs";
import { analyzeTrendPullbackV1, type TrendPullbackMode } from "../src/lib/strategy/trend-pullback-v1";
import { pipSizeFor } from "../src/lib/instruments/catalog";
import type { Candle, MajorInstrument } from "../src/types/forex";

process.loadEnvFile("../api-server/.env");
const HOST = "https://api-fxpractice.oanda.com";
const H = { Authorization: `Bearer ${process.env.OANDA_API_KEY}` };
const GRAN_MS: Record<string, number> = { M15: 900_000, H1: 3_600_000, H4: 14_400_000, D: 86_400_000 };
const trades = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Array<{ pair: string; direction: "long" | "short"; opened_at: string; entry: string; stop: string }>;

type BA = { time: string; bid: { h: string; l: string; c: string }; ask: { h: string; l: string; c: string } };

async function mid(inst: string, gran: string, to: string, count: number): Promise<Candle[]> {
  const j = (await (await fetch(`${HOST}/v3/instruments/${inst}/candles?price=M&granularity=${gran}&to=${encodeURIComponent(to)}&count=${count}`, { headers: H })).json()) as { candles: Array<{ time: string; mid: { o: string; h: string; l: string; c: string } }> };
  return j.candles
    .filter((c) => Date.parse(c.time) + GRAN_MS[gran]! <= Date.parse(to))
    .map((c) => ({ time: c.time, volume: 0, complete: true, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c }));
}

async function m1(inst: string, from: string): Promise<BA[]> {
  const out: BA[] = [];
  let t = from;
  for (;;) {
    const j = (await (await fetch(`${HOST}/v3/instruments/${inst}/candles?price=BA&granularity=M1&from=${encodeURIComponent(t)}&count=5000`, { headers: H })).json()) as { candles?: BA[] };
    const cs = j.candles ?? [];
    if (!cs.length) break;
    out.push(...cs);
    if (cs.length < 5000) break;
    t = new Date(Date.parse(cs.at(-1)!.time) + 60_000).toISOString();
  }
  return out;
}

/** TP 2× / SL 4× the original stop distance, market at the recorded entry. */
function tp2sl4(bars: BA[], long: boolean, e: number, d: number) {
  const stop = long ? e - 4 * d : e + 4 * d, tp = long ? e + 2 * d : e - 2 * d;
  for (const k of bars) {
    const hi = long ? +k.bid.h : +k.ask.h, lo = long ? +k.bid.l : +k.ask.l;
    if (long ? lo <= stop : hi >= stop) return "SL";
    if (long ? hi >= tp : lo <= tp) return "TP";
  }
  return "open";
}

const rows: Record<string, unknown>[] = [];
for (const tr of trades) {
  const inst = tr.pair.replace("/", "_") as MajorInstrument;
  const at = new Date(tr.opened_at).toISOString();
  const pip = pipSizeFor(inst);
  const e = +tr.entry, d = Math.abs(e - +tr.stop);
  const bars = await m1(inst, at);
  const price = bars[0] ? (+bars[0].bid.c + +bars[0].ask.c) / 2 : e;
  const row: Record<string, unknown> = { opened: at.slice(5, 16).replace("T", " "), pair: tr.pair, yours: tr.direction, "TP2/SL4": tp2sl4(bars, tr.direction === "long", e, d) };
  for (const mode of ["normal", "swing"] as TrendPullbackMode[]) {
    const [base, a, b, counts] = mode === "swing" ? ["H1", "H4", "D", [500, 250, 250]] as const : ["M15", "H1", "H4", [500, 250, 250]] as const;
    const [candles, h1Candles, h4Candles] = await Promise.all([mid(inst, base, at, counts[0]), mid(inst, a, at, counts[1]), mid(inst, b, at, counts[2])]);
    const plan = analyzeTrendPullbackV1({ instrument: inst, candles, h1Candles, h4Candles, currentPrice: price, mode, now: Date.parse(at) });
    const ruleDir = plan.action === "LONG" ? "long" : plan.action === "SHORT" ? "short" : "—";
    const same = ruleDir === tr.direction;
    // How far your entry was from the rule's pullback entry, in the trade's favour (+) or chased (−).
    const better = plan.entry === null ? null : (tr.direction === "long" ? plan.entry - e : e - plan.entry) / pip;
    const atPullback = same && plan.entry !== null && (better! >= -3);
    row[`${mode} trend`] = `${ruleDir}${plan.counterTrend ? " (ctr)" : ""}`;
    row[`${mode} follows`] = !same ? "NO – against" : atPullback ? "yes" : `dir only (${Math.round(-better!)}p early)`;
  }
  rows.push(row);
}
console.table(rows);
for (const outcome of ["SL", "TP"]) {
  const group = rows.filter((r) => r["TP2/SL4"] === outcome);
  for (const mode of ["normal", "swing"]) {
    const against = group.filter((r) => String(r[`${mode} follows`]).startsWith("NO")).length;
    const full = group.filter((r) => r[`${mode} follows`] === "yes").length;
    console.log(`${outcome} (${group.length}): ${mode} — against trend ${against}, fully followed ${full}, direction only ${group.length - against - full}`);
  }
}
