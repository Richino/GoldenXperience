/**
 * Frozen-portfolio near-target exit protection experiment.
 * Research / paper only. Does not change entries, deploy, or place orders.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

type Direction = "LONG" | "SHORT";
type VariantId = "V0" | "V1" | "V2" | "V3" | "V4";
type ExitReason = "TAKE_PROFIT" | "ORIGINAL_STOP" | "PROTECTED_STOP" | "TIME_EXIT";
type Side = { open: number; high: number; low: number; close: number };
type MinuteBar = { t: number; bid: Side; ask: Side };
type CompactCandle = { t: number; bo: number; bh: number; bl: number; bc: number; ao: number; ah: number; al: number; ac: number };
type ResearchLike = {
  time: string;
  bid: { open: number; high: number; low: number; close: number } | { o: string; h: string; l: string; c: string };
  ask: { open: number; high: number; low: number; close: number } | { o: string; h: string; l: string; c: string };
};

type FrozenTrade = {
  pair: string;
  instrument: string;
  strategy: string;
  version: string;
  tradeNumber: number;
  direction: Direction;
  geometry: string;
  entryUtc: string;
  decisionMs: number;
  horizonMs: number;
  execEntry: number;
  risk: number;
  originalStop: number;
  originalTarget: number;
  publishedExecR: number | null;
  publishedExitReason: string;
  matched: boolean;
  unmatchedReason: string;
};

type Replay = {
  reason: ExitReason;
  resultR: number;
  exitMs: number;
  exitPrice: number;
  triggered: boolean;
  mfeR: number;
  sameMinuteAmbiguous: boolean;
  optimisticResultR: number;
  optimisticReason: ExitReason;
};

type VariantSpec = { id: VariantId; label: string; lockR: number | null; trail: boolean };

const ROOT = resolve(process.cwd(), "../api-server/research-v2");
const OUT = resolve(ROOT, "frozen-portfolio-near-target-protection-v1");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const TRIGGER_R = 1.8;
const VARIANTS: VariantSpec[] = [
  { id: "V0", label: "FROZEN BASELINE", lockR: null, trail: false },
  { id: "V1", label: "1.80R TRIGGER / LOCK +1.00R", lockR: 1.0, trail: false },
  { id: "V2", label: "1.80R TRIGGER / LOCK +1.25R", lockR: 1.25, trail: false },
  { id: "V3", label: "1.80R TRIGGER / LOCK +1.50R", lockR: 1.5, trail: false },
  { id: "V4", label: "LITERAL 90% TRAIL", lockR: null, trail: true },
];
const PUBLISHED: Record<string, { expectancyR: number; trades: number; pf: number; wr: number; matched?: number }> = {
  USDCHF: { expectancyR: 0.2664, trades: 103, pf: 1.523, wr: 45.63 },
  USDCAD: { expectancyR: 0.228, trades: 53, pf: 1.424, wr: 49.06 },
  GBPUSD: { expectancyR: 0.196, trades: 98, pf: 1.332, wr: 44.9 },
  NZDUSD: { expectancyR: 0.1898, trades: 102, pf: 1.38, wr: 48, matched: 100 },
  AUDUSD: { expectancyR: 0.118, trades: 195, pf: 1.232, wr: 45.64 },
  USDJPY: { expectancyR: 0.0802, trades: 272, pf: 1.179, wr: 48.34, matched: 271 },
  EURUSD: { expectancyR: 0.078, trades: 356, pf: 1.127, wr: 38.48 },
};
const STRICT_BASELINE_PAIRS = new Set(["USDCHF", "USDCAD", "GBPUSD", "NZDUSD", "USDJPY"]);
const SOURCE_REFERENCES = {
  USDCHF: "api-server/research-v2/usdchf-bear-consensus-v1-spread-validation/",
  USDCAD: "api-server/research-v2/usdcad-v3-1100-long-spread-validation/",
  GBPUSD: "api-server/research-v2/gbpusd-frequency-v3-spread-validation/",
  NZDUSD: "api-server/research-v2/nzdusd-bull-consensus-structure-v1-spread-validation/",
  AUDUSD: "api-server/research-v2/executable-cost-validation/ (GX AUDUSD Strong Consensus Structure V1)",
  USDJPY: "api-server/research-v2/usdjpy-v6-spread-validation/",
  EURUSD: "api-server/research-v2/executable-cost-validation/ (EURUSD London Breakout V1; not rejected Frequency V3)",
};

function canonical(value: string) { return new Date(value).toISOString(); }
function round(value: number, digits = 6) { const f = 10 ** digits; return Math.round(value * f) / f; }
function csvCell(value: string | number | boolean) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows: Array<Record<string, string | number | boolean>>) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  return [headers.join(","), ...rows.map((row) => headers.map((key) => csvCell(row[key]!)).join(","))].join("\n") + "\n";
}
function side(open: number, high: number, low: number, close: number): Side { return { open, high, low, close }; }
function fromCompact(c: CompactCandle): MinuteBar {
  return { t: c.t, bid: side(c.bo, c.bh, c.bl, c.bc), ask: side(c.ao, c.ah, c.al, c.ac) };
}
function fromResearch(bar: ResearchLike): MinuteBar {
  const bid = "open" in bar.bid ? bar.bid : { open: +bar.bid.o, high: +bar.bid.h, low: +bar.bid.l, close: +bar.bid.c };
  const ask = "open" in bar.ask ? bar.ask : { open: +bar.ask.o, high: +bar.ask.h, low: +bar.ask.l, close: +bar.ask.c };
  return { t: Date.parse(bar.time), bid, ask };
}
function readJson<T>(path: string) { return readFile(path, "utf8").then((text) => JSON.parse(text) as T); }
function windowOf(bars: readonly MinuteBar[], fromMs: number, toMs: number) {
  return bars.filter((bar) => bar.t >= fromMs && bar.t < toMs).sort((a, b) => a.t - b.t);
}
function favorableR(direction: Direction, entry: number, risk: number, bar: MinuteBar) {
  return direction === "LONG" ? (bar.bid.high - entry) / risk : (entry - bar.ask.low) / risk;
}
function adverseHit(direction: Direction, stop: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  return direction === "LONG" ? px.low <= stop : px.high >= stop;
}
function targetHit(direction: Direction, target: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  return direction === "LONG" ? px.high >= target : px.low <= target;
}
function stopFill(direction: Direction, stop: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  if (direction === "LONG") return px.open <= stop ? px.open : stop;
  return px.open >= stop ? px.open : stop;
}
function targetFill(direction: Direction, target: number, bar: MinuteBar) {
  const px = direction === "LONG" ? bar.bid : bar.ask;
  if (direction === "LONG") return px.open >= target ? px.open : target;
  return px.open <= target ? px.open : target;
}
function timeFill(direction: Direction, bar: MinuteBar) {
  return direction === "LONG" ? bar.bid.close : bar.ask.close;
}
function resultR(direction: Direction, entry: number, risk: number, exit: number) {
  return direction === "LONG" ? (exit - entry) / risk : (entry - exit) / risk;
}
function moreProtectiveStop(direction: Direction, original: number, protectedStop: number) {
  return direction === "LONG" ? Math.max(original, protectedStop) : Math.min(original, protectedStop);
}
function lockPrice(direction: Direction, entry: number, risk: number, lockR: number) {
  return direction === "LONG" ? entry + lockR * risk : entry - lockR * risk;
}

function classifyReason(reason: string): ExitReason {
  if (reason === "TAKE_PROFIT" || reason === "TARGET_2R" || reason === "TP") return "TAKE_PROFIT";
  if (reason === "TIME_EXIT") return "TIME_EXIT";
  if (reason === "PROTECTED_STOP") return "PROTECTED_STOP";
  return "ORIGINAL_STOP";
}

function metrics(rs: readonly number[]) {
  const wins = rs.filter((value) => value > 0);
  const losses = rs.filter((value) => value <= 0);
  const gp = wins.reduce((sum, value) => sum + value, 0);
  const gl = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 0, peak = 0, maxDd = 0;
  for (const value of rs) { equity += value; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
  return {
    trades: rs.length,
    wins: wins.length,
    losses: losses.length,
    wr: rs.length ? 100 * wins.length / rs.length : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    totalR: rs.reduce((sum, value) => sum + value, 0),
    expectancyR: rs.length ? rs.reduce((sum, value) => sum + value, 0) / rs.length : 0,
    averageWinnerR: wins.length ? gp / wins.length : 0,
    averageLoserR: losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0,
    maxDdR: maxDd,
  };
}

function replayTrade(trade: FrozenTrade, bars: readonly MinuteBar[], spec: VariantSpec): Replay | null {
  if (!trade.matched || !(trade.risk > 0) || !bars.length) return null;
  const usable = windowOf(bars, trade.decisionMs, trade.horizonMs);
  if (usable.length < 10) return null;
  const lastNeeded = trade.horizonMs - MINUTE;
  if (usable.at(-1)!.t < lastNeeded - 5 * MINUTE) return null;

  let mfeR = 0;
  let armed = false;
  let primary: { reason: ExitReason; exit: number; t: number; ambiguous: boolean } | null = null;
  let optimistic: { reason: ExitReason; exit: number; t: number } | null = null;

  for (const bar of usable) {
    const fav = favorableR(trade.direction, trade.execEntry, trade.risk, bar);
    const originalStopHit = adverseHit(trade.direction, trade.originalStop, bar);
    const tpHit = targetHit(trade.direction, trade.originalTarget, bar);
    const wouldArm = fav >= TRIGGER_R || mfeR >= TRIGGER_R;
    const newMfe = Math.max(mfeR, fav);
    let protectedStop: number | null = null;
    if (spec.id !== "V0" && (armed || wouldArm)) {
      if (spec.trail) protectedStop = lockPrice(trade.direction, trade.execEntry, trade.risk, 0.9 * newMfe);
      else if (spec.lockR !== null) protectedStop = lockPrice(trade.direction, trade.execEntry, trade.risk, spec.lockR);
    }
    const effectiveStop = protectedStop === null ? trade.originalStop : moreProtectiveStop(trade.direction, trade.originalStop, protectedStop);
    const protHit = protectedStop !== null && adverseHit(trade.direction, effectiveStop, bar);
    const newlyArmedThisBar = !armed && wouldArm;
    const sameMinuteTriggerAndProt = newlyArmedThisBar && protHit && !originalStopHit;
    const stopIsProtected = protectedStop !== null && effectiveStop !== trade.originalStop
      && Math.abs(effectiveStop - trade.originalStop) > 1e-12;

    if (originalStopHit && tpHit) {
      const fill = stopFill(trade.direction, trade.originalStop, bar);
      primary = { reason: "ORIGINAL_STOP", exit: fill, t: bar.t, ambiguous: true };
      optimistic = optimistic ?? { reason: "TAKE_PROFIT", exit: targetFill(trade.direction, trade.originalTarget, bar), t: bar.t };
      break;
    }
    if (originalStopHit) {
      primary = { reason: "ORIGINAL_STOP", exit: stopFill(trade.direction, trade.originalStop, bar), t: bar.t, ambiguous: false };
      break;
    }
    if (tpHit) {
      primary = { reason: "TAKE_PROFIT", exit: targetFill(trade.direction, trade.originalTarget, bar), t: bar.t, ambiguous: false };
      break;
    }
    if (sameMinuteTriggerAndProt) {
      const fill = stopFill(trade.direction, effectiveStop, bar);
      const protReason: ExitReason = stopIsProtected ? "PROTECTED_STOP" : "ORIGINAL_STOP";
      if (!optimistic) optimistic = { reason: protReason, exit: fill, t: bar.t };
      armed = true;
      mfeR = newMfe;
      continue;
    }
    if (protHit && armed) {
      const fill = stopFill(trade.direction, effectiveStop, bar);
      primary = { reason: stopIsProtected ? "PROTECTED_STOP" : "ORIGINAL_STOP", exit: fill, t: bar.t, ambiguous: false };
      break;
    }
    if (protHit && !newlyArmedThisBar) {
      const fill = stopFill(trade.direction, effectiveStop, bar);
      primary = { reason: stopIsProtected ? "PROTECTED_STOP" : "ORIGINAL_STOP", exit: fill, t: bar.t, ambiguous: false };
      break;
    }
    armed = armed || wouldArm;
    mfeR = newMfe;
  }

  const last = usable.at(-1)!;
  if (!primary) {
    primary = { reason: "TIME_EXIT", exit: timeFill(trade.direction, last), t: last.t, ambiguous: false };
  }
  const optimisticUse = optimistic ?? primary;
  return {
    reason: primary.reason,
    resultR: resultR(trade.direction, trade.execEntry, trade.risk, primary.exit),
    exitMs: primary.t + MINUTE,
    exitPrice: primary.exit,
    triggered: mfeR >= TRIGGER_R || armed || primary.reason === "PROTECTED_STOP",
    mfeR,
    sameMinuteAmbiguous: primary.ambiguous || Boolean(optimistic && optimistic.reason !== primary.reason),
    optimisticResultR: resultR(trade.direction, trade.execEntry, trade.risk, optimisticUse.exit),
    optimisticReason: optimisticUse.reason,
  };
}

function oandaCredentials() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  loadEnvConfig(process.cwd());
  const token = (process.env.OANDA_API_KEY ?? process.env.OANDA_API_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) throw new Error("OANDA_API_KEY/OANDA_API_TOKEN is required for EURUSD/AUDUSD M1 windows.");
  if ((process.env.OANDA_ENVIRONMENT ?? "").toLowerCase() === "live") throw new Error("Practice-only experiment refuses a live OANDA environment.");
  return { token, host: "https://api-fxpractice.oanda.com" };
}

async function oandaM1(instrument: string, fromIso: string, toIso: string, token: string, host: string) {
  const out: MinuteBar[] = [];
  let from = Date.parse(fromIso);
  const end = Date.parse(toIso);
  while (from < end) {
    const url = new URL(`${host}/v3/instruments/${instrument}/candles`);
    url.searchParams.set("price", "MBA");
    url.searchParams.set("granularity", "M1");
    url.searchParams.set("from", new Date(from).toISOString());
    url.searchParams.set("to", new Date(end).toISOString());
    url.searchParams.set("includeFirst", "true");
    let body: { candles?: Array<{ time: string; complete: boolean; bid?: Record<"o"|"h"|"l"|"c", string>; ask?: Record<"o"|"h"|"l"|"c", string> }> } | null = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) { body = await response.json() as typeof body; break; }
      if (attempt === 5 || ![429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`OANDA ${instrument} M1 ${url.search} HTTP ${response.status}`);
      }
      await new Promise((done) => setTimeout(done, attempt * 400));
    }
    const batch = (body?.candles ?? []).filter((row) => row.complete && row.bid && row.ask).map((row) => fromResearch({
      time: canonical(row.time),
      bid: { open: +row.bid!.o, high: +row.bid!.h, low: +row.bid!.l, close: +row.bid!.c },
      ask: { open: +row.ask!.o, high: +row.ask!.h, low: +row.ask!.l, close: +row.ask!.c },
    })).filter((bar) => bar.t < end);
    if (!batch.length) break;
    out.push(...batch);
    const next = batch.at(-1)!.t + MINUTE;
    if (next <= from) break;
    from = next;
  }
  return [...new Map(out.map((bar) => [bar.t, bar])).values()].sort((a, b) => a.t - b.t);
}

async function loadCompactSeries(path: string) {
  const raw = await readJson<{ candles?: CompactCandle[] | ResearchLike[]; windows?: unknown }>(path);
  const candles = (raw as { candles?: unknown }).candles ?? raw;
  if (!Array.isArray(candles) || !candles.length) return [];
  const first = candles[0] as CompactCandle | ResearchLike;
  if (first && typeof first === "object" && "t" in first) return (candles as CompactCandle[]).map(fromCompact);
  return (candles as ResearchLike[]).map(fromResearch);
}

async function loadWindows(path: string) {
  const raw = await readJson<{ windows: Record<string, ResearchLike[]> }>(path);
  return Object.fromEntries(Object.entries(raw.windows).map(([key, bars]) => [key, bars.map(fromResearch)]));
}

async function cachedWindows(file: string, trades: FrozenTrade[], instrument: string) {
  const path = resolve(OUT, "data", file);
  try {
    const cached = await readJson<{ windows: Record<string, ResearchLike[]> }>(path);
    if (Object.keys(cached.windows).length >= trades.filter((t) => t.matched).length) {
      return Object.fromEntries(Object.entries(cached.windows).map(([key, bars]) => [key, bars.map(fromResearch)]));
    }
  } catch { /* fetch */ }
  const { token, host } = oandaCredentials();
  const windows: Record<string, MinuteBar[]> = {};
  const needed = trades.filter((trade) => trade.matched);
  for (let i = 0; i < needed.length; i += 4) {
    const batch = needed.slice(i, i + 4);
    const fetched = await Promise.all(batch.map(async (trade) => {
      const bars = await oandaM1(instrument, new Date(trade.decisionMs).toISOString(), new Date(trade.horizonMs).toISOString(), token, host);
      return [String(trade.tradeNumber), bars] as const;
    }));
    for (const [id, bars] of fetched) windows[id] = bars;
    if (i + 4 < needed.length) await new Promise((done) => setTimeout(done, 120));
    if (i % 20 === 0) console.log(`${instrument} M1 windows ${Math.min(i + 4, needed.length)}/${needed.length}`);
  }
  await mkdir(resolve(OUT, "data"), { recursive: true });
  await writeFile(path, JSON.stringify({ instrument, source: "OANDA Practice M1 MBA", windows }));
  return windows;
}

function pairStats(rows: Array<{ resultR: number; reason: ExitReason; triggered: boolean }>) {
  const m = metrics(rows.map((row) => row.resultR));
  return {
    ...m,
    protectionTriggered: rows.filter((row) => row.triggered).length,
    protectedStopExits: rows.filter((row) => row.reason === "PROTECTED_STOP").length,
    tpExits: rows.filter((row) => row.reason === "TAKE_PROFIT").length,
    originalSlExits: rows.filter((row) => row.reason === "ORIGINAL_STOP").length,
    timeExits: rows.filter((row) => row.reason === "TIME_EXIT").length,
    reached180: rows.filter((row) => row.triggered).length,
  };
}

async function loadUsdchf(): Promise<{ trades: FrozenTrade[]; barsFor: (trade: FrozenTrade) => MinuteBar[] | null }> {
  const raw = await readJson<{ rows: Array<Record<string, unknown>> }>(resolve(ROOT, "usdchf-bear-consensus-v1-spread-validation/RAW_RESULTS.json"));
  const series = await loadCompactSeries(resolve(ROOT, "usdchf-bear-consensus-v1-spread-validation/data/USD_CHF-M1-MBA.json"));
  const trades = raw.rows.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "USDCHF", instrument: "USD_CHF", strategy: "USDCHF Bear Consensus Structure V1", version: "V1",
      tradeNumber: Number(row.trade_number), direction: "SHORT" as const, geometry: "+2R/-1R ATR14 midpoint barriers; SHORT entry BID",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_bid_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, barsFor: (trade) => series.length ? series : null };
}

async function loadUsdcad() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "usdcad-v3-1100-long-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "usdcad-v3-1100-long-spread-validation/data/USD_CAD-M1-TV53-MBA.json"));
  const trades = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "USDCAD", instrument: "USD_CAD", strategy: "GX USDCAD Structure EMA Reclaim V3 11:00 LONG Only", version: "V3",
      tradeNumber: Number(row.trade_number), direction: "LONG" as const, geometry: "+2R/-1R ATR14; LONG ASK; 3 future H1 bars",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, barsFor: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? null };
}

async function loadGbpusd() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "gbpusd-frequency-v3-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "gbpusd-frequency-v3-spread-validation/data/GBP_USD-M1-TV98-MBA.json"));
  const trades = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.tv_entry_timestamp_utc));
    const direction = String(row.direction).toUpperCase() === "SHORT" ? "SHORT" as const : "LONG" as const;
    return {
      pair: "GBPUSD", instrument: "GBP_USD", strategy: "GX GBPUSD Frequency V3", version: "V3",
      tradeNumber: Number(row.trade_number), direction, geometry: "+2R/-1R frozen TV/ATR risk; M30; max hold 6 bars",
      entryUtc: String(row.tv_entry_timestamp_utc), decisionMs: entryMs + 30 * MINUTE, horizonMs: entryMs + 7 * 30 * MINUTE,
      execEntry: Number(row.execEntry), risk: Number(row.initial_risk_pips) * 0.0001,
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, barsFor: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? null };
}

async function loadNzdusd() {
  const raw = await readJson<{ rows: Array<Record<string, unknown>> }>(resolve(ROOT, "nzdusd-bull-consensus-structure-v1-spread-validation/RAW_RESULTS.json"));
  const series = await loadCompactSeries(resolve(ROOT, "nzdusd-bull-consensus-structure-v1-spread-validation/data/NZD_USD-M1-MBA.json"));
  const trades = raw.rows.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_entry));
    return {
      pair: "NZDUSD", instrument: "NZD_USD", strategy: "NZDUSD Bull Consensus Structure V1", version: "V1",
      tradeNumber: Number(row.trade_number), direction: "LONG" as const, geometry: "+2R/-1R ATR14; LONG ASK; 3 future H1 bars",
      entryUtc: String(row.resolved_utc_entry), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.atr_at_entry),
      originalStop: Number(row.original_stop), originalTarget: Number(row.original_target),
      publishedExecR: row.matched ? Number(row.exec_result_r) : null, publishedExitReason: String(row.exec_exit_reason ?? ""),
      matched: Boolean(row.matched), unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, barsFor: (trade: FrozenTrade) => series.length ? series : null };
}

async function loadUsdjpy() {
  const raw = await readJson<{ trades: Array<Record<string, unknown>> }>(resolve(ROOT, "usdjpy-v6-spread-validation/RAW_RESULTS.json"));
  const windows = await loadWindows(resolve(ROOT, "usdjpy-v6-spread-validation/data/USD_JPY-M1-TV272-MBA.json"));
  const trades = raw.trades.map((row) => {
    const entryMs = Date.parse(String(row.resolved_utc_timestamp));
    const matched = String(row.execution_status) === "MATCHED";
    return {
      pair: "USDJPY", instrument: "USD_JPY", strategy: "USDJPY Body Extreme V6 Long Only 08-10 Range", version: "V6",
      tradeNumber: Number(row.trade_number), direction: "LONG" as const, geometry: "+2R/-1R frozen TV risk (ATR14 fallback on TIME_EXIT)",
      entryUtc: String(row.resolved_utc_timestamp), decisionMs: entryMs + HOUR, horizonMs: entryMs + 4 * HOUR,
      execEntry: Number(row.oanda_ask_entry), risk: Number(row.risk),
      originalStop: Number(row.stop), originalTarget: Number(row.target),
      publishedExecR: matched ? Number(row.net_execution_r) : null, publishedExitReason: String(row.oanda_execution_exit_reason ?? ""),
      matched, unmatchedReason: String(row.unmatched_reason ?? ""),
    };
  });
  return { trades, barsFor: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? null };
}

async function loadCostPair(pair: "EURUSD" | "AUDUSD") {
  const key = pair === "EURUSD" ? "EUR_USD" : "AUD_USD";
  const instrument = key;
  const raw = await readJson<{ pairs: Record<string, { trades: Array<Record<string, unknown>>; executableGeometry?: string }> }>(
    resolve(ROOT, "executable-cost-validation/RESULTS.json"),
  );
  const block = raw.pairs[key]!;
  const maxHold = pair === "AUDUSD" ? 3 : null;
  const trades: FrozenTrade[] = block.trades.map((row, index) => {
    const direction = String(row.direction).toLowerCase() === "short" ? "SHORT" as const : "LONG" as const;
    const decisionMs = Date.parse(String(row.decisionTime));
    const exitMs = Date.parse(String(row.exitTimestamp));
    const horizonMs = maxHold === null ? Math.max(exitMs, decisionMs + HOUR) : decisionMs + maxHold * HOUR;
    const execEntry = Number(row.executableEntry);
    const stop = Number(row.stop);
    const atr = Number(row.atr);
    const risk = pair === "EURUSD" ? Math.abs(execEntry - stop) : atr;
    return {
      pair, instrument, strategy: pair === "EURUSD" ? "EURUSD London Breakout V1" : "GX AUDUSD Strong Consensus Structure V1",
      version: "V1", tradeNumber: index + 1, direction,
      geometry: pair === "EURUSD"
        ? "+2R/-1R midpoint ATR barriers; executable 1R = |entry-stop| (MIDPOINT_LEVELS); no time exit"
        : "+2R/-1R ATR14 around executable entry; 3 future H1 bars",
      entryUtc: canonical(String(row.signalTimestamp)), decisionMs, horizonMs,
      execEntry, risk, originalStop: stop, originalTarget: Number(row.target),
      publishedExecR: Number(row.executableResultR), publishedExitReason: String(row.exitReason),
      matched: true, unmatchedReason: "",
    };
  });
  const windows = await cachedWindows(`${instrument}-M1-windows.json`, trades, instrument);
  return { trades, barsFor: (trade: FrozenTrade) => windows[String(trade.tradeNumber)] ?? null };
}

type Loaded = { trades: FrozenTrade[]; barsFor: (trade: FrozenTrade) => MinuteBar[] | null };

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(resolve(OUT, "data"), { recursive: true });
  const loaded: Record<string, Loaded> = {
    USDCHF: await loadUsdchf(),
    USDCAD: await loadUsdcad(),
    GBPUSD: await loadGbpusd(),
    NZDUSD: await loadNzdusd(),
    USDJPY: await loadUsdjpy(),
    AUDUSD: await loadCostPair("AUDUSD"),
    EURUSD: await loadCostPair("EURUSD"),
  };

  const pairOrder = ["USDCHF", "USDCAD", "GBPUSD", "NZDUSD", "AUDUSD", "USDJPY", "EURUSD"];
  const tradeRows: Array<Record<string, string | number | boolean>> = [];
  const pairVariantRows: Array<Record<string, string | number | boolean>> = [];
  const ambiguousRows: Array<Record<string, string | number | boolean>> = [];
  const reversalRows: Array<Record<string, string | number | boolean>> = [];
  const yearRows: Array<Record<string, string | number | boolean>> = [];
  const sanity: Array<Record<string, unknown>> = [];
  const includedPairs: string[] = [];
  const v0ByKey = new Map<string, Replay>();

  for (const pair of pairOrder) {
    const { trades, barsFor } = loaded[pair]!;
    const published = PUBLISHED[pair]!;
    const geometryNotes = [...new Set(trades.map((trade) => trade.geometry))];
    const matchedTrades = trades.filter((trade) => trade.matched);
    const v0s: Replay[] = [];
    const usable: FrozenTrade[] = [];
    for (const trade of trades) {
      if (!trade.matched) {
        tradeRows.push({
          pair, variant: "AUDIT", trade_number: trade.tradeNumber, direction: trade.direction, entry_utc: trade.entryUtc,
          matched: false, unmatched_reason: trade.unmatchedReason, result_r: "", exit_reason: "", triggered: false, mfe_r: "",
        });
        continue;
      }
      const bars = barsFor(trade);
      const replay = bars ? replayTrade(trade, bars, VARIANTS[0]!) : null;
      if (!replay) {
        tradeRows.push({
          pair, variant: "AUDIT", trade_number: trade.tradeNumber, direction: trade.direction, entry_utc: trade.entryUtc,
          matched: false, unmatched_reason: "INCOMPLETE_M1_WINDOW", result_r: "", exit_reason: "", triggered: false, mfe_r: "",
        });
        continue;
      }
      v0s.push(replay);
      usable.push(trade);
      v0ByKey.set(`${pair}:${trade.tradeNumber}`, replay);
    }
    const v0Metrics = metrics(v0s.map((row) => row.resultR));
    const delta = v0Metrics.expectancyR - published.expectancyR;
    const failed = STRICT_BASELINE_PAIRS.has(pair) ? Math.abs(delta) > 0.012 : Math.abs(delta) > 0.035;
    sanity.push({
      pair, publishedExpectancyR: published.expectancyR, replayedExpectancyR: round(v0Metrics.expectancyR, 4),
      delta: round(delta, 4), publishedTrades: published.matched ?? published.trades, replayedTrades: v0Metrics.trades,
      cohortTrades: trades.length, matchedPublished: matchedTrades.length, usableM1: usable.length,
      geometry: geometryNotes, baselineOk: !failed, includedInAggregate: !failed,
    });
    if (failed) {
      console.error(`BASELINE FAIL ${pair}: published ${published.expectancyR} vs V0 ${v0Metrics.expectancyR.toFixed(4)} (n=${v0Metrics.trades})`);
      continue;
    }
    includedPairs.push(pair);

    const thresholds = [1.5, 1.6, 1.7, 1.8, 1.9];
    for (const threshold of thresholds) {
      const subset = usable.map((trade, index) => ({ trade, v0: v0s[index]! })).filter(({ v0 }) => v0.mfeR >= threshold && v0.reason !== "TAKE_PROFIT");
      const giveback = subset.map(({ v0 }) => v0.mfeR - v0.resultR);
      reversalRows.push({
        pair, threshold_r: threshold, count: subset.length,
        eventual_avg_baseline_r: subset.length ? subset.reduce((sum, row) => sum + row.v0.resultR, 0) / subset.length : 0,
        loss_count: subset.filter((row) => row.v0.resultR <= 0 && row.v0.reason !== "TIME_EXIT").length,
        time_exit_count: subset.filter((row) => row.v0.reason === "TIME_EXIT").length,
        winner_count: subset.filter((row) => row.v0.resultR > 0).length,
        avg_giveback_r: giveback.length ? giveback.reduce((sum, value) => sum + value, 0) / giveback.length : 0,
      });
    }

    for (const spec of VARIANTS) {
      const rows = usable.flatMap((trade) => {
        const bars = barsFor(trade);
        const replay = spec.id === "V0" ? v0ByKey.get(`${pair}:${trade.tradeNumber}`) ?? null : bars ? replayTrade(trade, bars, spec) : null;
        return replay ? [{ trade, replay }] : [];
      });
      const stats = pairStats(rows.map((row) => row.replay));
      const reached = rows.filter((row) => row.replay.triggered || row.replay.mfeR >= TRIGGER_R);
      const ofReached = {
        baselineTp: reached.filter((row) => v0ByKey.get(`${pair}:${row.trade.tradeNumber}`)?.reason === "TAKE_PROFIT").length,
        baselineWinner: reached.filter((row) => (v0ByKey.get(`${pair}:${row.trade.tradeNumber}`)?.resultR ?? 0) > 0).length,
        baselineLoss: reached.filter((row) => (v0ByKey.get(`${pair}:${row.trade.tradeNumber}`)?.resultR ?? 0) <= 0).length,
        baselineTime: reached.filter((row) => v0ByKey.get(`${pair}:${row.trade.tradeNumber}`)?.reason === "TIME_EXIT").length,
      };
      pairVariantRows.push({
        pair, variant: spec.id, label: spec.label, trades: stats.trades, wins: stats.wins, losses: stats.losses,
        wr: round(stats.wr, 4), pf: round(stats.pf, 4), total_r: round(stats.totalR, 4), expectancy_r: round(stats.expectancyR, 6),
        average_winner_r: round(stats.averageWinnerR, 4), average_loser_r: round(stats.averageLoserR, 4), max_dd_r: round(stats.maxDdR, 4),
        protection_triggered: stats.protectionTriggered, protected_stop_exits: stats.protectedStopExits,
        tp_exits: stats.tpExits, original_sl_exits: stats.originalSlExits, time_exits: stats.timeExits,
        reached_1_80r: reached.length, pct_reached_1_80r: round(100 * reached.length / Math.max(stats.trades, 1), 2),
        of_reached_baseline_tp: ofReached.baselineTp, of_reached_baseline_winner: ofReached.baselineWinner,
        of_reached_baseline_loss: ofReached.baselineLoss, of_reached_baseline_time: ofReached.baselineTime,
      });
      const changes = {
        lossToProtectedWin: { n: 0, r: 0 },
        timeLossToProtectedWin: { n: 0, r: 0 },
        smallWinToLarger: { n: 0, r: 0 },
        tpToSmallerWin: { n: 0, r: 0 },
        tpToProtectedStop: { n: 0, r: 0 },
        noChange: { n: 0, r: 0 },
      };
      for (const row of rows) {
        const v0 = v0ByKey.get(`${pair}:${row.trade.tradeNumber}`)!;
        const next = row.replay;
        const d = next.resultR - v0.resultR;
        if (Math.abs(d) < 1e-9 && next.reason === v0.reason) changes.noChange.n += 1;
        else if (v0.resultR <= 0 && next.resultR > 0 && v0.reason === "TIME_EXIT") { changes.timeLossToProtectedWin.n += 1; changes.timeLossToProtectedWin.r += d; }
        else if (v0.resultR <= 0 && next.resultR > 0) { changes.lossToProtectedWin.n += 1; changes.lossToProtectedWin.r += d; }
        else if (v0.resultR > 0 && next.resultR > v0.resultR + 1e-9) { changes.smallWinToLarger.n += 1; changes.smallWinToLarger.r += d; }
        else if (v0.reason === "TAKE_PROFIT" && next.reason === "PROTECTED_STOP") { changes.tpToProtectedStop.n += 1; changes.tpToProtectedStop.r += d; }
        else if (v0.reason === "TAKE_PROFIT" && next.resultR > 0 && next.resultR < v0.resultR - 1e-9) { changes.tpToSmallerWin.n += 1; changes.tpToSmallerWin.r += d; }
        else changes.noChange.n += 1;
        if (next.sameMinuteAmbiguous) {
          ambiguousRows.push({
            pair, variant: spec.id, trade_number: row.trade.tradeNumber, entry_utc: row.trade.entryUtc,
            conservative_reason: next.reason, conservative_r: round(next.resultR, 6),
            optimistic_reason: next.optimisticReason, optimistic_r: round(next.optimisticResultR, 6),
          });
        }
        tradeRows.push({
          pair, variant: spec.id, trade_number: row.trade.tradeNumber, direction: row.trade.direction,
          entry_utc: row.trade.entryUtc, year: new Date(row.trade.entryUtc).getUTCFullYear(),
          matched: true, unmatched_reason: "", exec_entry: row.trade.execEntry, risk: row.trade.risk,
          original_stop: row.trade.originalStop, original_target: row.trade.originalTarget,
          result_r: round(next.resultR, 6), exit_reason: next.reason, triggered: next.triggered || next.mfeR >= TRIGGER_R,
          mfe_r: round(next.mfeR, 6), protected_stop_exit: next.reason === "PROTECTED_STOP",
          same_minute_ambiguous: next.sameMinuteAmbiguous, v0_result_r: round(v0.resultR, 6), v0_reason: v0.reason,
          delta_r: round(next.resultR - v0.resultR, 6),
        });
      }
      const changeRow = pairVariantRows.at(-1)!;
      changeRow.loss_to_protected_win_n = changes.lossToProtectedWin.n;
      changeRow.loss_to_protected_win_r = round(changes.lossToProtectedWin.r, 4);
      changeRow.time_loss_to_protected_win_n = changes.timeLossToProtectedWin.n;
      changeRow.time_loss_to_protected_win_r = round(changes.timeLossToProtectedWin.r, 4);
      changeRow.small_win_to_larger_n = changes.smallWinToLarger.n;
      changeRow.small_win_to_larger_r = round(changes.smallWinToLarger.r, 4);
      changeRow.tp_to_smaller_win_n = changes.tpToSmallerWin.n;
      changeRow.tp_to_smaller_win_r = round(changes.tpToSmallerWin.r, 4);
      changeRow.tp_to_protected_stop_n = changes.tpToProtectedStop.n;
      changeRow.tp_to_protected_stop_r = round(changes.tpToProtectedStop.r, 4);
      changeRow.no_change_n = changes.noChange.n;

      for (const year of [2023, 2024, 2025, 2026]) {
        const yr = rows.filter((row) => new Date(row.trade.entryUtc).getUTCFullYear() === year).map((row) => row.replay.resultR);
        if (!yr.length) continue;
        const ym = metrics(yr);
        yearRows.push({ pair, variant: spec.id, year, trades: ym.trades, wins: ym.wins, wr: round(ym.wr, 2), pf: round(ym.pf, 3), total_r: round(ym.totalR, 4), expectancy_r: round(ym.expectancyR, 4) });
      }
    }
    console.log(`${pair} included n=${usable.length} V0 exp=${v0Metrics.expectancyR.toFixed(4)} published=${published.expectancyR}`);
  }

  const portfolioRows: Array<Record<string, string | number | boolean>> = [];
  const comparison: Array<Record<string, string | number | boolean>> = [];
  for (const spec of VARIANTS) {
    const selected = tradeRows.filter((row) => row.variant === spec.id && row.matched === true) as Array<Record<string, string | number | boolean>>;
    const chronological = [...selected].sort((a, b) => Date.parse(String(a.entry_utc)) - Date.parse(String(b.entry_utc)));
    const m = metrics(chronological.map((row) => Number(row.result_r)));
    const pairsImproved = includedPairs.filter((pair) => {
      const v0 = Number(pairVariantRows.find((row) => row.pair === pair && row.variant === "V0")?.expectancy_r);
      const vx = Number(pairVariantRows.find((row) => row.pair === pair && row.variant === spec.id)?.expectancy_r);
      return vx > v0 + 1e-9;
    }).length;
    const pairsWorsened = includedPairs.filter((pair) => {
      const v0 = Number(pairVariantRows.find((row) => row.pair === pair && row.variant === "V0")?.expectancy_r);
      const vx = Number(pairVariantRows.find((row) => row.pair === pair && row.variant === spec.id)?.expectancy_r);
      return vx < v0 - 1e-9;
    }).length;
    portfolioRows.push({
      variant: spec.id, label: spec.label, trades: m.trades, wins: m.wins, losses: m.losses, wr: round(m.wr, 4),
      pf: round(m.pf, 4), total_r: round(m.totalR, 4), expectancy_r: round(m.expectancyR, 6),
      average_winner_r: round(m.averageWinnerR, 4), average_loser_r: round(m.averageLoserR, 4),
      max_portfolio_dd_r: round(m.maxDdR, 4), pairs_improved: spec.id === "V0" ? 0 : pairsImproved,
      pairs_worsened: spec.id === "V0" ? 0 : pairsWorsened, pairs_in_aggregate: includedPairs.length,
    });
    for (const year of [2023, 2024, 2025, 2026]) {
      const yr = chronological.filter((row) => Number(row.year) === year).map((row) => Number(row.result_r));
      if (!yr.length) continue;
      const ym = metrics(yr);
      yearRows.push({ pair: "PORTFOLIO", variant: spec.id, year, trades: ym.trades, wins: ym.wins, wr: round(ym.wr, 2), pf: round(ym.pf, 3), total_r: round(ym.totalR, 4), expectancy_r: round(ym.expectancyR, 4) });
    }
  }
  for (const pair of includedPairs) {
    const cell = (id: VariantId) => Number(pairVariantRows.find((row) => row.pair === pair && row.variant === id)?.expectancy_r);
    const baseline = cell("V0");
    const values = VARIANTS.map((spec) => ({ id: spec.id, exp: cell(spec.id) }));
    const best = values.reduce((a, b) => b.exp > a.exp ? b : a);
    comparison.push({
      pair, baseline_exp: round(baseline, 6), lock_1_00: round(cell("V1"), 6), lock_1_25: round(cell("V2"), 6),
      lock_1_50: round(cell("V3"), 6), trail_90: round(cell("V4"), 6), best_variant: best.id,
      delta_vs_baseline: round(best.exp - baseline, 6), improved: best.exp > baseline + 1e-9,
    });
  }

  const v0p = portfolioRows.find((row) => row.variant === "V0")!;
  const ranked = portfolioRows.filter((row) => row.variant !== "V0").sort((a, b) => Number(b.expectancy_r) - Number(a.expectancy_r));
  const best = ranked[0]!;
  const deltaExp = Number(best.expectancy_r) - Number(v0p.expectancy_r);
  const improvedCount = Number(best.pairs_improved);
  const worsenedCount = Number(best.pairs_worsened);
  const yearStability = [2023, 2024, 2025, 2026].map((year) => {
    const base = yearRows.find((row) => row.pair === "PORTFOLIO" && row.variant === "V0" && row.year === year);
    const treat = yearRows.find((row) => row.pair === "PORTFOLIO" && row.variant === best.variant && row.year === year);
    return { year, v0: base?.expectancy_r, best: treat?.expectancy_r, improved: Number(treat?.expectancy_r ?? 0) >= Number(base?.expectancy_r ?? 0) };
  });
  const yearsImproved = yearStability.filter((row) => row.improved).length;
  let classification = "NO_MEANINGFUL_IMPROVEMENT";
  if (deltaExp < -0.005) classification = "PROTECTION_HURTS_EDGE";
  else if (improvedCount <= 2 && includedPairs.length >= 5) classification = "PAIR_SPECIFIC_ONLY";
  else if (deltaExp >= 0.02 && Number(best.pf) >= Number(v0p.pf) && Number(best.total_r) > Number(v0p.total_r) && improvedCount >= Math.ceil(includedPairs.length * 0.6) && yearsImproved >= 3) {
    classification = "PORTFOLIO_EXIT_EDGE";
  } else if (deltaExp < 0.02) classification = "NO_MEANINGFUL_IMPROVEMENT";
  else classification = "PAIR_SPECIFIC_ONLY";

  const changeTotals = VARIANTS.filter((spec) => spec.id !== "V0").map((spec) => {
    const rows = pairVariantRows.filter((row) => row.variant === spec.id && includedPairs.includes(String(row.pair)));
    const sum = (key: string) => rows.reduce((n, row) => n + Number(row[key] ?? 0), 0);
    return {
      variant: spec.id,
      rescueR: sum("loss_to_protected_win_r") + sum("time_loss_to_protected_win_r"),
      clipR: sum("tp_to_protected_stop_r") + sum("tp_to_smaller_win_r"),
      rescueN: sum("loss_to_protected_win_n") + sum("time_loss_to_protected_win_n"),
      clipN: sum("tp_to_protected_stop_n") + sum("tp_to_smaller_win_n"),
    };
  });

  const fmt = (n: number, d = 4) => n.toFixed(d);
  const report = `# Frozen portfolio near-target protection v1

Research / paper only. Entries were not regenerated. No deployment. No broker orders. No entry-rule changes.

## Classification: ${classification}

Best aggregate variant: **${best.variant}** (${best.label}).
Delta vs baseline: **${fmt(deltaExp, 4)}R/trade**.
OOS note: even a positive result is an **EXIT_CANDIDATE_FOR_OOS**, not production-ready. This is the same historical development sample.

## Baseline sanity

${sanity.map((row) => `- ${row.pair}: published ${row.publishedExpectancyR} vs V0 ${row.replayedExpectancyR} (Δ ${row.delta}); usable M1 ${row.usableM1}/${row.matchedPublished}; ${row.includedInAggregate ? "INCLUDED" : "EXCLUDED"}`).join("\n")}

Excluded from aggregate: ${pairOrder.filter((pair) => !includedPairs.includes(pair)).join(", ") || "none"}.

## Geometry notes

All seven books are 1R stop / 2R target systems. EURUSD V1 uses midpoint ATR stop/target with executable 1R = |executable entry − original stop| so V0 can reproduce the frozen +0.078R validation. USDJPY V6 preserves each trade's frozen TV risk distance (ATR14 fallback on TIME_EXIT rows). No geometry was silently altered.

## Portfolio

| Variant | Trades | Wins | WR | PF | Total R | Exp R/trade | Avg win | Avg loss | Max DD | Pairs + | Pairs - |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${portfolioRows.map((row) => `| ${row.variant} ${row.label} | ${row.trades} | ${row.wins} | ${fmt(Number(row.wr), 2)}% | ${fmt(Number(row.pf), 3)} | ${fmt(Number(row.total_r))} | ${fmt(Number(row.expectancy_r), 4)} | ${fmt(Number(row.average_winner_r), 3)} | ${fmt(Number(row.average_loser_r), 3)} | ${fmt(Number(row.max_portfolio_dd_r))} | ${row.pairs_improved} | ${row.pairs_worsened} |`).join("\n")}

Entry count is identical across variants for every included pair.

## Pair expectancy

| Pair | Baseline | +1.00 lock | +1.25 lock | +1.50 lock | 90% trail | Best | Δ | Improved? |
|---|---:|---:|---:|---:|---:|---|---:|---|
${comparison.map((row) => `| ${row.pair} | ${fmt(Number(row.baseline_exp), 4)} | ${fmt(Number(row.lock_1_00), 4)} | ${fmt(Number(row.lock_1_25), 4)} | ${fmt(Number(row.lock_1_50), 4)} | ${fmt(Number(row.trail_90), 4)} | ${row.best_variant} | ${fmt(Number(row.delta_vs_baseline), 4)} | ${row.improved} |`).join("\n")}

Pair-specific bests were **not** adopted as a new frozen rule.

## Rescue vs clip (aggregate of included pairs)

${changeTotals.map((row) => `- ${row.variant}: rescues ${row.rescueN} trades / ${fmt(row.rescueR, 3)}R; clips ${row.clipN} TP-path trades / ${fmt(row.clipR, 3)}R`).join("\n")}

## Year stability (portfolio)

${[2023, 2024, 2025, 2026].map((year) => {
    const cells = VARIANTS.map((spec) => {
      const row = yearRows.find((item) => item.pair === "PORTFOLIO" && item.variant === spec.id && item.year === year);
      return row ? fmt(Number(row.expectancy_r), 3) : "—";
    });
    return `- ${year}: V0 ${cells[0]} · V1 ${cells[1]} · V2 ${cells[2]} · V3 ${cells[3]} · V4 ${cells[4]}`;
  }).join("\n")}

Years where best variant ≥ baseline: ${yearsImproved}/4.

## Same-minute ambiguity

Conservative primary results never assume trigger-before-reversal in the arming minute. Ambiguous minutes: **${ambiguousRows.length}**. Optimistic bound is in AMBIGUOUS_INTRAMINUTE.csv.

## Source references

${Object.entries(SOURCE_REFERENCES).map(([pair, path]) => `- ${pair}: ${path}`).join("\n")}

## Decision

1. Baseline portfolio expectancy: **${fmt(Number(v0p.expectancy_r), 4)}R/trade**
2. V1 +1.00R lock: **${fmt(Number(portfolioRows.find((r) => r.variant === "V1")!.expectancy_r), 4)}R**
3. V2 +1.25R lock: **${fmt(Number(portfolioRows.find((r) => r.variant === "V2")!.expectancy_r), 4)}R**
4. V3 +1.50R lock: **${fmt(Number(portfolioRows.find((r) => r.variant === "V3")!.expectancy_r), 4)}R**
5. V4 90% trail: **${fmt(Number(portfolioRows.find((r) => r.variant === "V4")!.expectancy_r), 4)}R**
6. Best aggregate: **${best.variant}**
7. Delta vs baseline: **${fmt(deltaExp, 4)}R/trade**
8. PF before/after: **${fmt(Number(v0p.pf), 3)} / ${fmt(Number(best.pf), 3)}**
9. WR before/after: **${fmt(Number(v0p.wr), 2)}% / ${fmt(Number(best.wr), 2)}%**
10. Total R before/after: **${fmt(Number(v0p.total_r), 2)} / ${fmt(Number(best.total_r), 2)}**
11. Pairs improved / worsened: **${improvedCount} / ${worsenedCount}** of ${includedPairs.length}
12. Classification: **${classification}**
13. Separate OOS validation deserved?: **${classification === "PORTFOLIO_EXIT_EDGE" || deltaExp >= 0.02 ? "YES — EXIT_CANDIDATE_FOR_OOS" : "NO — do not spend OOS budget unless a later predefined test is specified"}**

No deployment. No live activation. No broker orders. No entry-rule modifications.
`;

  const artifact = {
    generatedAt: new Date().toISOString(),
    purpose: "Exit-management only. Same frozen entries. Protection after +1.80R executable MFE.",
    classification,
    oosLabel: "EXIT_CANDIDATE_FOR_OOS",
    includedPairs,
    excludedPairs: pairOrder.filter((pair) => !includedPairs.includes(pair)),
    sanity,
    sourceReferences: SOURCE_REFERENCES,
    publishedBaselines: PUBLISHED,
    portfolio: portfolioRows,
    comparison,
    changeTotals,
    yearStability,
    bestVariant: best,
    baseline: v0p,
    deltaExp,
    ambiguousCount: ambiguousRows.length,
    frequencyUnchanged: true,
    deployment: false,
    brokerOrders: false,
    entryRuleChanges: false,
  };

  await Promise.all([
    writeFile(resolve(OUT, "REPORT.md"), report),
    writeFile(resolve(OUT, "PORTFOLIO_SUMMARY.csv"), toCsv(portfolioRows)),
    writeFile(resolve(OUT, "PAIR_VARIANTS.csv"), toCsv(pairVariantRows)),
    writeFile(resolve(OUT, "TRADE_VARIANTS.csv"), toCsv(tradeRows)),
    writeFile(resolve(OUT, "NEAR_TP_REVERSALS.csv"), toCsv(reversalRows)),
    writeFile(resolve(OUT, "YEAR_STABILITY.csv"), toCsv(yearRows)),
    writeFile(resolve(OUT, "AMBIGUOUS_INTRAMINUTE.csv"), toCsv(ambiguousRows)),
    writeFile(resolve(OUT, "RAW_RESULTS.json"), `${JSON.stringify(artifact, null, 2)}\n`),
    writeFile(resolve(OUT, "SOURCE_REFERENCES.json"), `${JSON.stringify(SOURCE_REFERENCES, null, 2)}\n`),
  ]);
  console.log(JSON.stringify({ classification, includedPairs, baseline: v0p.expectancy_r, best: { variant: best.variant, exp: best.expectancy_r }, deltaExp, output: OUT }, null, 2));
}

void main();
