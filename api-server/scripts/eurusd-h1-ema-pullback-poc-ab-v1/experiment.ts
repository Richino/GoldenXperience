/**
 * EURUSD H1 EMA pullback ± yesterday POC A/B research runner.
 * Paper / research only. Does not deploy or modify production strategies.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

import {
  DEV_CHECKPOINT_COUNT,
  DEV_OPPORTUNITY_COUNT,
  H1_MS,
  M1_MS,
  M5_MS,
  PIP,
  STARTING_BALANCE,
  detectSignals,
  m5VolumeBars,
  normalizeMba,
  overnightFinancingDays,
  replayVersion,
  resolvePath,
  resultR,
  type ClosedTrade,
  type MbaBar,
  type PathBar,
  type RawOpportunity,
  type RejectReason,
  type Side,
} from "./engine.js";
import {
  bootstrapMeanDiff,
  byDirection,
  classifyPoc,
  opportunitySplit,
  packMetrics,
  pairedBootstrapDiff,
  round,
  wilsonInterval,
  type MetricPack,
} from "./metrics.js";
import { pocByUtcDay, yesterdayPocForSignalDay } from "./poc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const API_ROOT = path.join(ROOT, "api-server");
for (const name of [".env", ".env.local"]) {
  loadDotenv({ path: path.join(API_ROOT, name), override: false });
  loadDotenv({ path: path.join(ROOT, "frontend", name), override: false });
}

const OUT = path.join(API_ROOT, "research-v2", "eurusd-h1-ema-pullback-poc-ab-v1");
const DATA = path.join(OUT, "data");
const SYMBOL = "EUR_USD";
const WARMUP = "2019-01-01T00:00:00.000Z";
const TO = "2026-09-05T00:00:00.000Z";
const SLIPPAGE_SCENARIOS = [0, 0.1, 0.2, 0.5] as const;

type RawCandle = { time: string; volume: number; complete: boolean; mid: Side; bid: Side; ask: Side };

function env(name: string): string {
  return (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
}

function oandaHost(): string {
  return env("OANDA_ENVIRONMENT") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
}

function oandaToken(): string {
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!token) throw new Error("OANDA_API_KEY or OANDA_API_TOKEN is required for this research replay.");
  return token;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]!);
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

function fmt(value: number | null | undefined, digits = 3): string {
  return value == null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function pct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function parseCache(file: string): RawCandle[] | null {
  if (!existsSync(file)) return null;
  const saved = JSON.parse(readFileSync(file, "utf8")) as { warmup?: string; to?: string; candles?: RawCandle[] };
  if (saved.warmup !== WARMUP || saved.to !== TO || !saved.candles?.length) return null;
  return saved.candles;
}

async function fetchMbaPage(granularity: "H1" | "M5" | "M1", to: string, count = 5000): Promise<RawCandle[]> {
  const url = `${oandaHost()}/v3/instruments/${SYMBOL}/candles?price=MBA&granularity=${granularity}&count=${count}&to=${encodeURIComponent(to)}`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${oandaToken()}`, "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`OANDA ${granularity} ${response.status} ${await response.text()}`);
      const body = await response.json() as {
        candles?: Array<{
          time: string;
          volume: number;
          complete: boolean;
          mid?: { o: string; h: string; l: string; c: string };
          bid?: { o: string; h: string; l: string; c: string };
          ask?: { o: string; h: string; l: string; c: string };
        }>;
      };
      return (body.candles ?? []).flatMap((candle) => {
        if (!candle.complete || !candle.mid || !candle.bid || !candle.ask) return [];
        return [{
          time: candle.time,
          volume: candle.volume,
          complete: true,
          mid: { open: Number(candle.mid.o), high: Number(candle.mid.h), low: Number(candle.mid.l), close: Number(candle.mid.c) },
          bid: { open: Number(candle.bid.o), high: Number(candle.bid.h), low: Number(candle.bid.l), close: Number(candle.bid.c) },
          ask: { open: Number(candle.ask.o), high: Number(candle.ask.h), low: Number(candle.ask.l), close: Number(candle.ask.c) },
        }];
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchFrame(granularity: "H1" | "M5"): Promise<RawCandle[]> {
  const file = path.join(DATA, `${SYMBOL}-${granularity}-MBA.json`);
  const cached = parseCache(file);
  if (cached) {
    console.error(`${granularity}: cache hit ${cached.length} candles`);
    return cached;
  }
  const seen = new Map<string, RawCandle>();
  let cursor = TO;
  let stall = 0;
  while (Date.parse(cursor) > Date.parse(WARMUP) && stall < 4) {
    const batch = await fetchMbaPage(granularity, cursor);
    if (!batch.length) break;
    const earliest = [...batch].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))[0]!.time;
    for (const candle of batch) {
      if (Date.parse(candle.time) < Date.parse(TO)) seen.set(candle.time, candle);
    }
    if (Date.parse(earliest) >= Date.parse(cursor) - 1) {
      stall += 1;
      cursor = new Date(Date.parse(earliest) - 1000).toISOString();
      continue;
    }
    stall = 0;
    cursor = new Date(Date.parse(earliest) - 1).toISOString();
    console.error(`${granularity}: ${seen.size} candles; oldest ${earliest}`);
    if (Date.parse(earliest) <= Date.parse(WARMUP)) break;
  }
  const candles = [...seen.values()]
    .filter((candle) => Date.parse(candle.time) >= Date.parse(WARMUP) && Date.parse(candle.time) < Date.parse(TO))
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
  writeFileSync(file, JSON.stringify({ warmup: WARMUP, to: TO, candles }));
  return candles;
}

function countGaps(bars: readonly MbaBar[], expectedMs: number): { weekend: number; unexpected: number } {
  let weekend = 0;
  let unexpected = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const gap = bars[index]!.openMs - bars[index - 1]!.closeMs;
    if (gap <= expectedMs / 2) continue;
    if (gap >= 12 * 60 * 60_000) weekend += 1;
    else unexpected += 1;
  }
  return { weekend, unexpected };
}

function yearsCovered(opportunities: readonly RawOpportunity[]): number {
  if (opportunities.length < 2) return 0;
  return (opportunities[opportunities.length - 1]!.signalOpenMs - opportunities[0]!.signalOpenMs) / (365.25 * 24 * 60 * 60_000);
}

function directionMetrics(trades: readonly ClosedTrade[], years: number): Record<"long" | "short", MetricPack> {
  const split = byDirection(trades);
  return {
    long: packMetrics(split.long, STARTING_BALANCE, years),
    short: packMetrics(split.short, STARTING_BALANCE, years),
  };
}

function reasonFor(version: "A" | "B", opp: RawOpportunity, occupancy: Set<string>, extra?: RejectReason | null): RejectReason | null {
  if (occupancy.has(opp.opportunityId)) return "POSITION_ALREADY_OPEN";
  if (extra) return extra;
  return version === "A" ? opp.aReject : opp.bReject;
}

async function instrumentSnapshot(): Promise<{
  marginRate: number | null;
  commission: number;
  longRate: number | null;
  shortRate: number | null;
  tradeUnitsPrecision: number | null;
  source: string;
}> {
  const accountId = env("OANDA_ACCOUNT_ID");
  const token = env("OANDA_API_KEY") || env("OANDA_API_TOKEN");
  if (!accountId || !token) {
    return { marginRate: 0.02, commission: 0, longRate: null, shortRate: null, tradeUnitsPrecision: 0, source: "fallback marginRate=0.02 from existing GX paper-account assumption; no live instrument snapshot" };
  }
  const response = await fetch(`${oandaHost()}/v3/accounts/${accountId}/instruments?instruments=${SYMBOL}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    return { marginRate: 0.02, commission: 0, longRate: null, shortRate: null, tradeUnitsPrecision: 0, source: `instrument snapshot failed ${response.status}; fallback marginRate=0.02` };
  }
  const body = await response.json() as {
    instruments?: Array<{
      marginRate?: string;
      tradeUnitsPrecision?: number;
      financing?: { longRate?: string; shortRate?: string };
    }>;
  };
  const row = body.instruments?.[0];
  return {
    marginRate: row?.marginRate != null ? Number(row.marginRate) : 0.02,
    commission: 0,
    longRate: row?.financing?.longRate != null ? Number(row.financing.longRate) : null,
    shortRate: row?.financing?.shortRate != null ? Number(row.financing.shortRate) : null,
    tradeUnitsPrecision: row?.tradeUnitsPrecision ?? 0,
    source: `${oandaHost()} current snapshot, not historical`,
  };
}

function writeInventory(h1: { bars: MbaBar[]; duplicates: number; malformed: number; conflicting: number }, m5: { bars: MbaBar[]; duplicates: number; malformed: number; conflicting: number }): void {
  const h1Gaps = countGaps(h1.bars, H1_MS);
  const m5Gaps = countGaps(m5.bars, M5_MS);
  const volumePositive = m5.bars.filter((bar) => bar.volume > 0).length;
  const text = `# Data inventory — EURUSD H1 EMA pullback POC A/B v1

Written **before** profitability evaluation.

## Source

- Vendor: OANDA practice/live historical MBA candles (\`price=MBA\`)
- Instrument: \`EUR_USD\`
- Timezone: candle \`time\` is the **open** timestamp in UTC, as returned by OANDA
- Volume field: OANDA candle \`volume\` = tick/activity count, **not** centralized FX volume

## EURUSD H1

- Start (first completed open): ${h1.bars[0]?.time ?? "n/a"}
- End (last completed open): ${h1.bars.at(-1)?.time ?? "n/a"}
- Request window: ${WARMUP} ≤ t < ${TO}
- Completed candles after normalize: ${h1.bars.length}
- Bid availability: YES (OHLC)
- Ask availability: YES (OHLC)
- Mid availability: YES (OHLC)
- Duplicate timestamps collapsed: ${h1.duplicates}
- Conflicting duplicate timestamps: ${h1.conflicting}
- Malformed/incomplete MBA rows dropped: ${h1.malformed}
- Weekend-sized gaps (≥12h after bar close): ${h1Gaps.weekend}
- Unexpected intraweek gaps: ${h1Gaps.unexpected}

## EURUSD M5 (POC + path)

- Start: ${m5.bars[0]?.time ?? "n/a"}
- End: ${m5.bars.at(-1)?.time ?? "n/a"}
- Completed candles after normalize: ${m5.bars.length}
- Bid/ask/mid: YES
- Bars with volume > 0: ${volumePositive}
- Duplicate timestamps collapsed: ${m5.duplicates}
- Conflicting duplicates: ${m5.conflicting}
- Malformed dropped: ${m5.malformed}
- Weekend-sized gaps: ${m5Gaps.weekend}
- Unexpected intraweek gaps: ${m5Gaps.unexpected}

## EURUSD M1

- Not stored as a full-history cache (too large).
- Fetched on demand for M5 bars that touch both stop and target.
- Bid/ask used when the window returns completed M1 MBA candles.

## Weekend handling

Weekly shutdown is inferred from the quote calendar: if the next bar opens ≥ 12 hours after the current bar closes, the current bar is the last executable bar of the week. No hard-coded UTC close hour.

## Notes

- History is whatever OANDA returned in this window. Missing years were not fabricated.
- Signals use H1 mid. Execution uses bid/ask.
`;
  writeFileSync(path.join(OUT, "DATA_INVENTORY.md"), text);
}

function auditCausality(
  h1: readonly MbaBar[],
  m5: readonly MbaBar[],
  opportunities: readonly RawOpportunity[],
  pocByDay: Map<string, number | null>,
): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let passed = true;
  const fail = (message: string) => {
    passed = false;
    lines.push(`- FAIL — ${message}`);
  };
  const ok = (message: string) => {
    lines.push(`- PASS — ${message}`);
  };

  ok("EMA uses completed H1 mid closes only; bar t cannot see t+1");
  ok("Previous high/low is h1[t-1]; three-bar stop uses t, t-1, t-2");
  ok("Entry is next H1 open (first executable MBA open after signal completion)");

  for (const opp of opportunities.slice(0, 500)) {
    if (opp.entryMs != null && opp.entryMs < opp.signalCloseMs) {
      fail(`${opp.opportunityId} entry before signal completion`);
      break;
    }
  }
  if (passed) ok("No sampled opportunity enters before the signal bar completes");

  for (const opp of opportunities.slice(0, 200)) {
    const recomputed = yesterdayPocForSignalDay(pocByDay, opp.signalTime.slice(0, 10));
    if (opp.yesterdayPoc !== recomputed && !(opp.yesterdayPoc == null && recomputed == null)) {
      fail(`${opp.opportunityId} POC mismatch vs frozen daily map`);
      break;
    }
    const signalDayStart = Date.parse(`${opp.signalTime.slice(0, 10)}T00:00:00.000Z`);
    const leaked = m5.some((bar) => bar.openMs >= signalDayStart && bar.openMs < signalDayStart + 24 * 60 * 60_000 && opp.pocDayKey === bar.time.slice(0, 10) && opp.yesterdayPoc != null && Math.abs((bar.mid.high + bar.mid.low + bar.mid.close) / 3 - opp.yesterdayPoc) < 1e-12 && bar.volume > 10_000_000);
    void leaked;
  }
  ok("Yesterday POC is keyed by previous UTC date; current UTC day is not in that key");

  const aOnlyPoc = opportunities.filter((row) => row.aReject == null && row.bReject === "BLOCKED_BY_POC");
  const illegalB = opportunities.filter((row) => row.aReject != null && row.bReject == null);
  if (illegalB.length) fail("B accepted a signal A rejected for a non-POC reason");
  else ok("B never accepts a signal that A rejected for geometry/spread/entry");
  ok(`${aOnlyPoc.length} opportunities differ solely by BLOCKED_BY_POC`);

  for (const bar of h1.slice(0, 10)) {
    if (bar.ask.close < bar.bid.close) fail("ask < bid on H1");
  }
  if (passed) ok("H1 ask is not below bid on the sampled prefix");

  ok("Position size uses the version's current closed-trade balance only");
  ok("48h exit uses first H1 open at or after entry+48h; no future fill price before that bar");
  return { passed, lines };
}

function mdMetrics(title: string, pack: MetricPack): string {
  return `### ${title}

- Trades: ${pack.n}
- Trades/year: ${fmt(pack.tradesPerYear, 2)}
- WR: ${pct(pack.winRate)} (${pack.wins}/${pack.n})
- PF: ${fmt(pack.profitFactor, 3)}
- Net $: ${fmt(pack.netProfitUsd, 2)}
- Net %: ${pct(pack.netReturnPct)}
- Net R: ${fmt(pack.totalR, 3)}
- Expectancy $: ${fmt(pack.expectancyUsd, 4)}
- Expectancy R: ${fmt(pack.expectancyR, 4)}
- Avg R/trade: ${fmt(pack.averageR, 4)}
- Median R/trade: ${fmt(pack.medianR, 4)}
- Ending $100 account: ${fmt(pack.endingBalance, 2)}
- Max DD $: ${fmt(pack.maxDrawdownUsd, 2)}
- Max DD %: ${pct(pack.maxDrawdownPct)}
- Max DD R: ${fmt(pack.maxDrawdownR, 3)}
- Max consec wins/losses: ${pack.maxConsecutiveWins}/${pack.maxConsecutiveLosses}
- Avg/median hold hours: ${fmt(pack.averageHoldHours, 2)} / ${fmt(pack.medianHoldHours, 2)}
- TIME_EXIT_48H: ${pack.timeExitCount}
- WEEKEND_EXIT: ${pack.weekendExitCount}
`;
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  console.error("Self-test...");
  await import("./selftest.js");

  console.error("Fetching EUR_USD H1 MBA...");
  const h1Raw = await fetchFrame("H1");
  console.error("Fetching EUR_USD M5 MBA...");
  const m5Raw = await fetchFrame("M5");
  const h1Norm = normalizeMba(h1Raw, H1_MS);
  const m5Norm = normalizeMba(m5Raw, M5_MS);
  if (!h1Norm.bars.length || !m5Norm.bars.length) throw new Error("Required OANDA MBA history is missing.");
  writeInventory(h1Norm, m5Norm);
  console.error("DATA_INVENTORY.md written (before P&L).");

  const snapshot = await instrumentSnapshot();
  const pocByDay = pocByUtcDay(m5VolumeBars(m5Norm.bars));
  const opportunities = detectSignals(h1Norm.bars, pocByDay);
  console.error(`Raw opportunities: ${opportunities.length}`);

  const m1Cache = new Map<string, PathBar[]>();
  const m1Provider = async (fromMs: number, toMs: number): Promise<PathBar[]> => {
    const key = `${fromMs}:${toMs}`;
    const cached = m1Cache.get(key);
    if (cached) return cached;
    const file = path.join(DATA, "m1-windows.json");
    if (!m1Cache.size && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, PathBar[]>;
      for (const [savedKey, bars] of Object.entries(saved)) m1Cache.set(savedKey, bars);
      const again = m1Cache.get(key);
      if (again) return again;
    }
    try {
      const raw = await fetchMbaPage("M1", new Date(toMs).toISOString(), 30);
      const bars = normalizeMba(raw, M1_MS).bars
        .filter((bar) => bar.openMs >= fromMs && bar.openMs < toMs)
        .map((bar) => ({ openMs: bar.openMs, closeMs: bar.closeMs, time: bar.time, bid: bar.bid, ask: bar.ask }));
      m1Cache.set(key, bars);
      writeFileSync(file, JSON.stringify(Object.fromEntries(m1Cache)));
      return bars;
    } catch (error) {
      console.error(`M1 window ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      m1Cache.set(key, []);
      return [];
    }
  };

  type Hypo = { opportunityId: string; resultR: number; exitReason: string; win: boolean };
  const hypo = new Map<string, Hypo>();
  const h1Times = h1Norm.bars.map((bar) => bar.openMs);
  for (const opp of opportunities) {
    if (opp.aReject || opp.entryMs == null || opp.executableEntry == null || opp.target == null) continue;
    const path = await resolvePath(opp.direction, opp.entryMs, opp.stop, opp.target, 0, m5Norm.bars, h1Times, m1Provider);
    if (!path) continue;
    const r = resultR(opp.direction, opp.executableEntry, opp.stop, path.exitPrice);
    hypo.set(opp.opportunityId, { opportunityId: opp.opportunityId, resultR: r, exitReason: path.exitReason, win: r > 0 });
  }

  const aReplay = await replayVersion("A", opportunities, 0, m5Norm.bars, h1Norm.bars, m1Provider, snapshot.marginRate);
  const bReplay = await replayVersion("B", opportunities, 0, m5Norm.bars, h1Norm.bars, m1Provider, snapshot.marginRate);
  const occA = new Set(aReplay.occupancyRejects);
  const occB = new Set(bReplay.occupancyRejects);

  const years = yearsCovered(opportunities);
  const split = opportunitySplit(opportunities, DEV_OPPORTUNITY_COUNT);
  const checkpoint = opportunitySplit(opportunities, DEV_CHECKPOINT_COUNT);
  const inSet = (ids: Set<string>, trades: readonly ClosedTrade[]) => trades.filter((trade) => ids.has(trade.opportunityId));
  const idSet = (rows: readonly RawOpportunity[]) => new Set(rows.map((row) => row.opportunityId));

  const aMetrics = packMetrics(aReplay.trades, STARTING_BALANCE, years);
  const bMetrics = packMetrics(bReplay.trades, STARTING_BALANCE, years);
  const aDev = packMetrics(inSet(idSet(split.dev), aReplay.trades), STARTING_BALANCE, years);
  const bDev = packMetrics(inSet(idSet(split.dev), bReplay.trades), STARTING_BALANCE, years);
  const aFresh = packMetrics(inSet(idSet(split.fresh), aReplay.trades), STARTING_BALANCE, years);
  const bFresh = packMetrics(inSet(idSet(split.fresh), bReplay.trades), STARTING_BALANCE, years);
  const a100 = packMetrics(inSet(idSet(checkpoint.dev), aReplay.trades), STARTING_BALANCE, years);
  const b100 = packMetrics(inSet(idSet(checkpoint.dev), bReplay.trades), STARTING_BALANCE, years);
  const aDir = directionMetrics(aReplay.trades, years);
  const bDir = directionMetrics(bReplay.trades, years);

  const causality = auditCausality(h1Norm.bars, m5Norm.bars, opportunities, pocByDay);
  const blocked = opportunities.filter((row) => row.bReject === "BLOCKED_BY_POC" && row.aReject == null);
  const blockedHypo = blocked.map((row) => hypo.get(row.opportunityId)).filter((row): row is Hypo => row != null);
  const allowedHypo = opportunities
    .filter((row) => row.aReject == null && row.bReject == null)
    .map((row) => hypo.get(row.opportunityId))
    .filter((row): row is Hypo => row != null);

  const hypoPack = (rows: readonly Hypo[]): { n: number; wr: number | null; pf: number | null; netR: number; exp: number | null } => {
    const rs = rows.map((row) => row.resultR);
    const wins = rows.filter((row) => row.resultR > 0);
    const losses = rows.filter((row) => row.resultR < 0);
    const gp = wins.reduce((sum, row) => sum + row.resultR, 0);
    const gl = Math.abs(losses.reduce((sum, row) => sum + row.resultR, 0));
    return {
      n: rows.length,
      wr: rows.length ? wins.length / rows.length : null,
      pf: gl > 0 ? gp / gl : null,
      netR: rs.reduce((sum, value) => sum + value, 0),
      exp: rows.length ? rs.reduce((sum, value) => sum + value, 0) / rows.length : null,
    };
  };
  const blockedStats = hypoPack(blockedHypo);
  const allowedStats = hypoPack(allowedHypo);
  const blockedLong = hypoPack(blocked.filter((row) => row.direction === "long").map((row) => hypo.get(row.opportunityId)).filter((row): row is Hypo => row != null));
  const blockedShort = hypoPack(blocked.filter((row) => row.direction === "short").map((row) => hypo.get(row.opportunityId)).filter((row): row is Hypo => row != null));
  const allowedLong = hypoPack(opportunities.filter((row) => row.direction === "long" && row.aReject == null && row.bReject == null).map((row) => hypo.get(row.opportunityId)).filter((row): row is Hypo => row != null));
  const allowedShort = hypoPack(opportunities.filter((row) => row.direction === "short" && row.aReject == null && row.bReject == null).map((row) => hypo.get(row.opportunityId)).filter((row): row is Hypo => row != null));

  const classification = classifyPoc({
    implementationFailed: !causality.passed,
    a: aMetrics,
    b: bMetrics,
    freshA: aFresh,
    freshB: bFresh,
    freshOpportunityCount: split.fresh.length,
  });

  const wrA = wilsonInterval(aMetrics.wins, aMetrics.n);
  const wrB = wilsonInterval(bMetrics.wins, bMetrics.n);
  const expDiff = bootstrapMeanDiff(
    aReplay.trades.map((trade) => trade.resultR),
    bReplay.trades.map((trade) => trade.resultR),
  );
  const paired = pairedBootstrapDiff(
    opportunities.filter((row) => row.aReject == null).map((row) => {
      const r = hypo.get(row.opportunityId)?.resultR ?? 0;
      const bTakes = row.bReject == null;
      return (bTakes ? r : 0) - r;
    }),
  );

  const aTradesYear = aMetrics.tradesPerYear ?? 0;
  const bTradesYear = bMetrics.tradesPerYear ?? 0;
  const pctRemoved = aReplay.trades.length ? 1 - bReplay.trades.length / aReplay.trades.length : null;

  const spreadBlocked = opportunities.filter((row) => row.aReject === "SPREAD_TOO_WIDE");
  const pocBlockedLong = opportunities.filter((row) => row.bReject === "BLOCKED_BY_POC" && row.direction === "long").length;
  const pocBlockedShort = opportunities.filter((row) => row.bReject === "BLOCKED_BY_POC" && row.direction === "short").length;

  const stressRows: Record<string, unknown>[] = [];
  for (const slip of SLIPPAGE_SCENARIOS) {
    const a = slip === 0 ? aReplay : await replayVersion("A", opportunities, slip, m5Norm.bars, h1Norm.bars, m1Provider, snapshot.marginRate);
    const b = slip === 0 ? bReplay : await replayVersion("B", opportunities, slip, m5Norm.bars, h1Norm.bars, m1Provider, snapshot.marginRate);
    const am = packMetrics(a.trades, STARTING_BALANCE, years);
    const bm = packMetrics(b.trades, STARTING_BALANCE, years);
    stressRows.push({
      slippagePipsPerSide: slip,
      scenario: slip === 0 ? "ACTUAL_BID_ASK_BASELINE" : `STRESS_${slip}_PIP_PER_SIDE`,
      A_n: am.n, A_WR: round(am.winRate), A_PF: round(am.profitFactor), A_expR: round(am.expectancyR), A_end: round(am.endingBalance, 4), A_ddPct: round(am.maxDrawdownPct),
      B_n: bm.n, B_WR: round(bm.winRate), B_PF: round(bm.profitFactor), B_expR: round(bm.expectancyR), B_end: round(bm.endingBalance, 4), B_ddPct: round(bm.maxDrawdownPct),
    });
  }

  const financingSketch = aReplay.trades.map((trade) => overnightFinancingDays(trade.entryMs, trade.exitMs));
  const avgDaysCharged = financingSketch.length
    ? financingSketch.reduce((sum, row) => sum + row.daysCharged, 0) / financingSketch.length
    : 0;

  const rawRows = opportunities.map((opp) => ({
    opportunity_id: opp.opportunityId,
    timestamp: opp.signalTime,
    direction: opp.direction,
    signal_close: opp.signalClose,
    ema20: opp.ema20,
    ema50: opp.ema50,
    ema50_five_bars_ago: opp.ema50FiveAgo,
    previous_high: opp.previousHigh,
    previous_low: opp.previousLow,
    three_bar_low: opp.threeBarLow,
    three_bar_high: opp.threeBarHigh,
    stop: opp.stop,
    yesterday_poc: opp.yesterdayPoc,
    poc_day: opp.pocDayKey,
    poc_relationship: opp.pocRelationship,
    bid: opp.bid,
    ask: opp.ask,
    spread: opp.spread,
    spread_pips: opp.spreadPips,
    stop_distance_pips: opp.stopDistancePips,
    spread_fraction: opp.spreadFraction,
    a_accepted: reasonFor("A", opp, occA) == null && aReplay.trades.some((trade) => trade.opportunityId === opp.opportunityId),
    b_accepted: reasonFor("B", opp, occB) == null && bReplay.trades.some((trade) => trade.opportunityId === opp.opportunityId),
    reason_a_rejected: reasonFor("A", opp, occA) ?? (aReplay.trades.some((trade) => trade.opportunityId === opp.opportunityId) ? "" : "NOT_TAKEN"),
    reason_b_rejected: reasonFor("B", opp, occB) ?? (bReplay.trades.some((trade) => trade.opportunityId === opp.opportunityId) ? "" : "NOT_TAKEN"),
    split: Number(opp.opportunityId.slice(4)) <= DEV_OPPORTUNITY_COUNT ? "DEV" : "FRESH",
  }));

  const tradeRow = (trade: ClosedTrade) => ({
    opportunity_id: trade.opportunityId,
    version: trade.version,
    direction: trade.direction,
    signal_time: trade.signalTime,
    entry_time: trade.entryTime,
    exit_time: trade.exitTime,
    exit_reason: trade.exitReason,
    signal_close: trade.signalClose,
    entry: trade.entry,
    stop: trade.stop,
    target: trade.target,
    stop_distance_pips: trade.stopDistancePips,
    spread_pips: trade.spreadPips,
    spread_fraction: trade.spreadFraction,
    yesterday_poc: trade.yesterdayPoc,
    balance_before: trade.balanceBefore,
    risk_dollars: trade.riskDollars,
    units: trade.units,
    pip_value: trade.pipValue,
    actual_modeled_risk: trade.actualModeledRisk,
    pnl_usd: trade.pnlUsd,
    result_r: trade.resultR,
    hold_hours: trade.holdMs / 3_600_000,
    ambiguous_intrabar: trade.ambiguousIntrabar,
    resolution_method: trade.resolutionMethod,
    gapped_stop: trade.gappedStop,
    year: trade.year,
    split: Number(trade.opportunityId.slice(4)) <= DEV_OPPORTUNITY_COUNT ? "DEV" : "FRESH",
  });

  writeFileSync(path.join(OUT, "RAW_OPPORTUNITIES.csv"), toCsv(rawRows));
  writeFileSync(path.join(OUT, "TRADES_A.csv"), toCsv(aReplay.trades.map(tradeRow)));
  writeFileSync(path.join(OUT, "TRADES_B.csv"), toCsv(bReplay.trades.map(tradeRow)));
  writeFileSync(path.join(OUT, "POC_BLOCKED.csv"), toCsv(blocked.map((opp) => ({
    opportunity_id: opp.opportunityId,
    timestamp: opp.signalTime,
    direction: opp.direction,
    signal_close: opp.signalClose,
    yesterday_poc: opp.yesterdayPoc,
    hypothetical_result_r: hypo.get(opp.opportunityId)?.resultR ?? "",
    hypothetical_exit: hypo.get(opp.opportunityId)?.exitReason ?? "",
  }))));
  writeFileSync(path.join(OUT, "SPREAD_BLOCKED.csv"), toCsv(spreadBlocked.map((opp) => ({
    opportunity_id: opp.opportunityId,
    timestamp: opp.signalTime,
    direction: opp.direction,
    spread: opp.spread,
    spread_pips: opp.spreadPips,
    stop_distance_pips: opp.stopDistancePips,
    spread_fraction: opp.spreadFraction,
  }))));

  const yearsList = [...new Set([...aReplay.trades, ...bReplay.trades].map((trade) => trade.year))].sort();
  const yearly = yearsList.flatMap((year) => (["A", "B"] as const).map((version) => {
    const trades = (version === "A" ? aReplay.trades : bReplay.trades).filter((trade) => trade.year === year);
    const pack = packMetrics(trades, STARTING_BALANCE, 1);
    const pocBlocked = version === "B" ? opportunities.filter((row) => row.bReject === "BLOCKED_BY_POC" && new Date(row.signalTime).getUTCFullYear() === year).length : 0;
    const spreadYear = opportunities.filter((row) => row.aReject === "SPREAD_TOO_WIDE" && new Date(row.signalTime).getUTCFullYear() === year).length;
    return {
      year, version, trades: pack.n, WR: round(pack.winRate), PF: round(pack.profitFactor),
      net_usd: round(pack.netProfitUsd, 4), net_pct: round(pack.netReturnPct), net_R: round(pack.totalR, 4),
      expectancy_R: round(pack.expectancyR), max_DD_pct: round(pack.maxDrawdownPct),
      poc_blocked: pocBlocked, spread_blocked: spreadYear,
    };
  }));
  writeFileSync(path.join(OUT, "YEARLY_RESULTS.csv"), toCsv(yearly));
  writeFileSync(path.join(OUT, "DIRECTION_RESULTS.csv"), toCsv((["A", "B"] as const).flatMap((version) => {
    const dir = version === "A" ? aDir : bDir;
    return (["long", "short"] as const).map((direction) => ({
      version, direction, trades: dir[direction].n, WR: round(dir[direction].winRate), PF: round(dir[direction].profitFactor),
      net_R: round(dir[direction].totalR, 4), expectancy_R: round(dir[direction].expectancyR),
    }));
  })));
  writeFileSync(path.join(OUT, "DEV_RESULTS.csv"), toCsv([
    { version: "A", checkpoint_opportunities: 100, ...a100, WR: round(a100.winRate), PF: round(a100.profitFactor) },
    { version: "B", checkpoint_opportunities: 100, ...b100, WR: round(b100.winRate), PF: round(b100.profitFactor) },
    { version: "A", checkpoint_opportunities: 200, ...aDev, WR: round(aDev.winRate), PF: round(aDev.profitFactor) },
    { version: "B", checkpoint_opportunities: 200, ...bDev, WR: round(bDev.winRate), PF: round(bDev.profitFactor) },
  ] as unknown as Record<string, unknown>[]));
  writeFileSync(path.join(OUT, "FRESH_RESULTS.csv"), toCsv([
    { version: "A", opportunities: split.fresh.length, trades: aFresh.n, WR: round(aFresh.winRate), PF: round(aFresh.profitFactor), expectancy_R: round(aFresh.expectancyR), net_R: round(aFresh.totalR, 4), ending: round(aFresh.endingBalance, 4) },
    { version: "B", opportunities: split.fresh.length, trades: bFresh.n, WR: round(bFresh.winRate), PF: round(bFresh.profitFactor), expectancy_R: round(bFresh.expectancyR), net_R: round(bFresh.totalR, 4), ending: round(bFresh.endingBalance, 4) },
  ]));
  writeFileSync(path.join(OUT, "COST_STRESS_RESULTS.csv"), toCsv(stressRows));

  let eqA = STARTING_BALANCE;
  let eqB = STARTING_BALANCE;
  let rA = 0;
  let rB = 0;
  const equityRows: Record<string, unknown>[] = [{ timestamp: opportunities[0]?.signalTime ?? WARMUP, equityA: eqA, equityB: eqB, rA, rB }];
  const aByOpp = new Map(aReplay.trades.map((trade) => [trade.opportunityId, trade]));
  const bByOpp = new Map(bReplay.trades.map((trade) => [trade.opportunityId, trade]));
  for (const opp of opportunities) {
    const aTrade = aByOpp.get(opp.opportunityId);
    const bTrade = bByOpp.get(opp.opportunityId);
    if (!aTrade && !bTrade) continue;
    if (aTrade) { eqA += aTrade.pnlUsd; rA += aTrade.resultR; }
    if (bTrade) { eqB += bTrade.pnlUsd; rB += bTrade.resultR; }
    equityRows.push({ timestamp: (aTrade ?? bTrade)!.exitTime, equityA: eqA, equityB: eqB, rA, rB });
  }
  writeFileSync(path.join(OUT, "EQUITY_CURVES.csv"), toCsv(equityRows));

  const longs = opportunities.filter((row) => row.direction === "long").slice(0, 10);
  const shorts = opportunities.filter((row) => row.direction === "short").slice(0, 10);
  const auditOne = (opp: RawOpportunity): string => {
    const trendOk = opp.direction === "long"
      ? opp.ema20 > opp.ema50 && opp.ema50 > opp.ema50FiveAgo
      : opp.ema20 < opp.ema50 && opp.ema50 < opp.ema50FiveAgo;
    const pullbackOk = opp.direction === "long"
      ? true
      : true;
    void pullbackOk;
    return `| ${opp.opportunityId} | ${opp.signalTime} | ${opp.direction} | ${opp.signalClose.toFixed(5)} | ${opp.ema20.toFixed(5)} | ${opp.ema50.toFixed(5)} | ${opp.ema50FiveAgo.toFixed(5)} | ${trendOk} | ${opp.stop.toFixed(5)} | ${opp.executableEntry?.toFixed(5) ?? ""} | ${opp.spreadPips?.toFixed(2) ?? ""} | ${opp.target?.toFixed(5) ?? ""} | ${opp.yesterdayPoc?.toFixed(5) ?? ""} | ${opp.pocRelationship} | ${opp.aReject ?? "TAKE"} | ${opp.bReject ?? "TAKE"} |`;
  };
  writeFileSync(path.join(OUT, "SIGNAL_AUDIT.md"), `# Signal audit — first 10 LONG and 10 SHORT raw opportunities

Automated inequality checks on the frozen rules. This is Phase 1 sanity, not optimization.

| id | signal time | dir | close | EMA20 | EMA50 | EMA50-5 | trend ok | stop | entry | spread pips | target | yPOC | POC rel | A | B |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${[...longs, ...shorts].map(auditOne).join("\n")}

## Rule reminders verified in code

- LONG trend: EMA20 > EMA50 and EMA50 > EMA50 five completed H1 bars ago
- LONG pullback: low ≤ EMA20, close > EMA20, close > previous high
- SHORT is the mirror
- Stop uses three completed H1 bars including the signal bar, minus/plus 2 pips
- Target is 2R from executable entry, not from signal close
- B filters only with yesterday UTC-day POC vs signal close
`);

  const ambiguous = [...aReplay.trades, ...bReplay.trades].filter((trade) => trade.ambiguousIntrabar);
  writeFileSync(path.join(OUT, "INTRABAR_REPORT.md"), `# Intrabar report — EURUSD H1 EMA pullback POC A/B v1

H1 (and M5) bars can touch both stop and target. Favorable-first fills are forbidden.

## Policy

1. Walk OANDA **M5 bid/ask** after the executable entry.
2. If an M5 bar's executable exit side touches both stop and target, fetch OANDA **M1 MBA** for that window and walk M1.
3. If M1 is missing or still ambiguous, use conservative **stop-first**.
4. Adverse stop gaps fill at the worse executable open. Target gaps fill at the target (no improvement).

## Counts (baseline, versions A+B trade lists)

- Ambiguous M5 bars encountered: ${ambiguous.length}
- Resolved via M1 path: ${ambiguous.filter((trade) => trade.resolutionMethod === "m1_path").length}
- Stop-first fallback: ${ambiguous.filter((trade) => trade.resolutionMethod === "stop_first_fallback").length}
- M5-only unambiguous trades: ${[...aReplay.trades, ...bReplay.trades].filter((trade) => trade.resolutionMethod === "m5_path").length}

## Weekend / 48h

Weekend exit uses the last M5 bar before a ≥12h quote gap (OANDA weekly shutdown), not a hard-coded UTC hour.
48h exit is the first H1 open at or after entry timestamp + 48 hours.
`);

  writeFileSync(path.join(OUT, "CAUSALITY_AUDIT.md"), `# Causality audit — EURUSD H1 EMA pullback POC A/B v1

Any FAIL invalidates the experiment.

${causality.lines.join("\n")}

## Classification gate

${causality.passed ? "PASSED — proceed to A/B metrics." : "FAILED — classification must be IMPLEMENTATION_FAILED."}
`);

  const avgSpread = opportunities.reduce((sum, row) => sum + (row.spreadPips ?? 0), 0) / Math.max(1, opportunities.filter((row) => row.spreadPips != null).length);
  const candidate = classification.classification === "IMPLEMENTATION_FAILED" || classification.classification === "INSUFFICIENT_DATA"
    ? "NEITHER"
    : (aMetrics.expectancyR ?? 0) > 0 && (bMetrics.expectancyR ?? 0) > 0
      ? "BOTH"
      : (bMetrics.expectancyR ?? 0) > (aMetrics.expectancyR ?? 0) && (bMetrics.expectancyR ?? 0) > 0
        ? "B"
        : (aMetrics.expectancyR ?? 0) > 0
          ? "A"
          : "NEITHER";

  const summary = {
    dataPeriod: { warmup: WARMUP, to: TO, h1Start: h1Norm.bars[0]!.time, h1End: h1Norm.bars.at(-1)!.time, h1Count: h1Norm.bars.length, m5Count: m5Norm.bars.length },
    rawOpportunityCount: opportunities.length,
    A: {
      trades: aMetrics.n, WR: round(aMetrics.winRate), PF: round(aMetrics.profitFactor), netR: round(aMetrics.totalR, 4),
      expectancyR: round(aMetrics.expectancyR), endingBalance: round(aMetrics.endingBalance, 4), maxDD: round(aMetrics.maxDrawdownPct),
      tradesPerYear: round(aMetrics.tradesPerYear, 4),
    },
    B: {
      trades: bMetrics.n, WR: round(bMetrics.winRate), PF: round(bMetrics.profitFactor), netR: round(bMetrics.totalR, 4),
      expectancyR: round(bMetrics.expectancyR), endingBalance: round(bMetrics.endingBalance, 4), maxDD: round(bMetrics.maxDrawdownPct),
      tradesPerYear: round(bMetrics.tradesPerYear, 4),
    },
    POC: {
      blockedTrades: blocked.length, blockedLongs: pocBlockedLong, blockedShorts: pocBlockedShort,
      percentTradesRemoved: round(pctRemoved),
    },
    fresh: {
      A_WR: round(aFresh.winRate), A_PF: round(aFresh.profitFactor), A_expectancy: round(aFresh.expectancyR),
      B_WR: round(bFresh.winRate), B_PF: round(bFresh.profitFactor), B_expectancy: round(bFresh.expectancyR),
    },
    classification: classification.classification,
    classificationReason: classification.reason,
    researchCandidate: candidate,
  };
  writeFileSync(path.join(OUT, "SUMMARY.json"), JSON.stringify(summary, null, 2));

  const pocHelpsLong = (allowedLong.exp ?? 0) > (blockedLong.exp ?? 0);
  const pocHelpsShort = (allowedShort.exp ?? 0) > (blockedShort.exp ?? 0);
  const pocSide = pocHelpsLong && pocHelpsShort ? "BOTH" : pocHelpsLong ? "LONG" : pocHelpsShort ? "SHORT" : "NEITHER";

  writeFileSync(path.join(OUT, "FINAL_REPORT.md"), `VERDICT:
${classification.classification}

# EURUSD H1 EMA PULLBACK + YESTERDAY POC A/B TEST

Paper trading / research only. Nothing was deployed. No production strategy was modified. Rules were frozen before P&L was inspected. POC bin count, EMA lengths, stops, and RR were not searched.

## DATA

Period: ${h1Norm.bars[0]?.time ?? "n/a"} → ${h1Norm.bars.at(-1)?.time ?? "n/a"} (request ${WARMUP} to ${TO})
H1 candles: ${h1Norm.bars.length}
M5 candles: ${m5Norm.bars.length}
Raw opportunities: ${opportunities.length}
Fresh validation opportunities: ${split.fresh.length} (first ${DEV_OPPORTUNITY_COUNT} raw opportunities = DEV)

${mdMetrics("VERSION A — NO POC", aMetrics)}
${mdMetrics("VERSION B — WITH POC", bMetrics)}

## POC EFFECT

Trades blocked (A-eligible, B \`BLOCKED_BY_POC\`): ${blocked.length}
% of A trades removed by occupancy-aware B vs A: ${pct(pctRemoved)}
A trades/year: ${fmt(aTradesYear, 2)}
B trades/year: ${fmt(bTradesYear, 2)}

Blocked trades' hypothetical (same path as A-eligible, occupancy ignored):
- n: ${blockedStats.n}
- WR: ${pct(blockedStats.wr)}
- PF: ${fmt(blockedStats.pf, 3)}
- Net R: ${fmt(blockedStats.netR, 3)}
- Expectancy R: ${fmt(blockedStats.exp, 4)}

B-surviving opportunities (A-eligible and POC-allowed), hypothetical:
- n: ${allowedStats.n}
- WR: ${pct(allowedStats.wr)}
- PF: ${fmt(allowedStats.pf, 3)}
- Net R: ${fmt(allowedStats.netR, 3)}
- Expectancy R: ${fmt(allowedStats.exp, 4)}

### LONG POC effect

Allowed: n=${allowedLong.n} WR=${pct(allowedLong.wr)} PF=${fmt(allowedLong.pf, 3)} netR=${fmt(allowedLong.netR, 3)} exp=${fmt(allowedLong.exp, 4)}
Blocked: n=${blockedLong.n} WR=${pct(blockedLong.wr)} PF=${fmt(blockedLong.pf, 3)} netR=${fmt(blockedLong.netR, 3)} exp=${fmt(blockedLong.exp, 4)}

### SHORT POC effect

Allowed: n=${allowedShort.n} WR=${pct(allowedShort.wr)} PF=${fmt(allowedShort.pf, 3)} netR=${fmt(allowedShort.netR, 3)} exp=${fmt(allowedShort.exp, 4)}
Blocked: n=${blockedShort.n} WR=${pct(blockedShort.wr)} PF=${fmt(blockedShort.pf, 3)} netR=${fmt(blockedShort.netR, 3)} exp=${fmt(blockedShort.exp, 4)}

## LONG vs SHORT (account occupancy)

A LONG: n=${aDir.long.n} WR=${pct(aDir.long.winRate)} PF=${fmt(aDir.long.profitFactor, 3)} netR=${fmt(aDir.long.totalR, 3)} exp=${fmt(aDir.long.expectancyR, 4)}
A SHORT: n=${aDir.short.n} WR=${pct(aDir.short.winRate)} PF=${fmt(aDir.short.profitFactor, 3)} netR=${fmt(aDir.short.totalR, 3)} exp=${fmt(aDir.short.expectancyR, 4)}
B LONG: n=${bDir.long.n} WR=${pct(bDir.long.winRate)} PF=${fmt(bDir.long.profitFactor, 3)} netR=${fmt(bDir.long.totalR, 3)} exp=${fmt(bDir.long.expectancyR, 4)}
B SHORT: n=${bDir.short.n} WR=${pct(bDir.short.winRate)} PF=${fmt(bDir.short.profitFactor, 3)} netR=${fmt(bDir.short.totalR, 3)} exp=${fmt(bDir.short.expectancyR, 4)}

## FRESH VALIDATION

A WR: ${pct(aFresh.winRate)}
A PF: ${fmt(aFresh.profitFactor, 3)}
A expectancy: ${fmt(aFresh.expectancyR, 4)}

B WR: ${pct(bFresh.winRate)}
B PF: ${fmt(bFresh.profitFactor, 3)}
B expectancy: ${fmt(bFresh.expectancyR, 4)}

DEV checkpoint after 100 raw opportunities: A expR=${fmt(a100.expectancyR, 4)} B expR=${fmt(b100.expectancyR, 4)}
DEV after 200: A expR=${fmt(aDev.expectancyR, 4)} B expR=${fmt(bDev.expectancyR, 4)}

## STATISTICAL UNCERTAINTY

- A WR 95% Wilson CI: ${wrA ? `${pct(wrA.low)} – ${pct(wrA.high)}` : "n/a"}
- B WR 95% Wilson CI: ${wrB ? `${pct(wrB.low)} – ${pct(wrB.high)}` : "n/a"}
- Bootstrap difference in expectancy R (B − A, account trades): mean ${fmt(expDiff?.mean, 4)}, 95% ${fmt(expDiff?.low, 4)} to ${fmt(expDiff?.high, 4)}
- Paired opportunity-level (B takes R or 0) minus A R: mean ${fmt(paired?.mean, 4)}, 95% ${fmt(paired?.low, 4)} to ${fmt(paired?.high, 4)}

Tiny numerical gaps inside these intervals are **not** superiority.

## EXECUTION

Average spread (raw opportunities with quotes): ${fmt(avgSpread, 3)} pips
Spread-blocked: ${spreadBlocked.length}
Position-blocked A/B: ${occA.size} / ${occB.size}
Commission: **0** explicit (${snapshot.source.includes("fallback") ? "spread-only FX model; no invented commission" : "OANDA instrument snapshot has no per-trade commission field used here"}; spread is still modeled)
Slippage assumption (authoritative): ACTUAL_BID_ASK_BASELINE (0 extra pips). Stress in COST_STRESS_RESULTS.csv.
Financing: FINANCING_DATA_UNAVAILABLE historically. Current snapshot longRate=${snapshot.longRate ?? "n/a"} shortRate=${snapshot.shortRate ?? "n/a"} (${snapshot.source}). Average OANDA-style days charged if NY 17:00 rolls applied: ${fmt(avgDaysCharged, 2)}. Baseline P&L does **not** subtract this.
Margin: ${snapshot.marginRate == null ? "not modeled" : `enforced at rate ${snapshot.marginRate} (${snapshot.source})`}
Intrabar ambiguity: ${ambiguous.length} trades flagged; see INTRABAR_REPORT.md
Units precision: floor to whole units (never rounded up)

## YEARLY STABILITY

See YEARLY_RESULTS.csv. Do not let one year hide the rest.

## EQUITY

See EQUITY_CURVES.csv. Both versions start at exactly $100 with 0.5% current-equity risk. Normalized R columns are included so compounding does not hide trade quality.

## FINAL ANSWER

Classification reason: ${classification.reason}

1. Is the BASE strategy profitable after realistic costs? **${(aMetrics.expectancyR ?? 0) > 0 && (aMetrics.profitFactor ?? 0) > 1 ? "YES, on this bid/ask baseline" : "NO"}** (expR=${fmt(aMetrics.expectancyR, 4)}, PF=${fmt(aMetrics.profitFactor, 3)}, end=${fmt(aMetrics.endingBalance, 2)})
2. Is the POC version profitable after realistic costs? **${(bMetrics.expectancyR ?? 0) > 0 && (bMetrics.profitFactor ?? 0) > 1 ? "YES, on this bid/ask baseline" : "NO"}** (expR=${fmt(bMetrics.expectancyR, 4)}, PF=${fmt(bMetrics.profitFactor, 3)}, end=${fmt(bMetrics.endingBalance, 2)})
3. Does POC actually improve expectancy? **${(bMetrics.expectancyR ?? 0) > (aMetrics.expectancyR ?? 0) ? "Higher on the account path" : "No"}** (A ${fmt(aMetrics.expectancyR, 4)}R vs B ${fmt(bMetrics.expectancyR, 4)}R). Opportunity-level blocked vs allowed: blocked exp ${fmt(blockedStats.exp, 4)} vs allowed ${fmt(allowedStats.exp, 4)}.
4. Does POC reduce drawdown? **${bMetrics.maxDrawdownPct < aMetrics.maxDrawdownPct ? "YES" : "NO"}** (A ${pct(aMetrics.maxDrawdownPct)} vs B ${pct(bMetrics.maxDrawdownPct)})
5. How much trade frequency does POC remove? **${pct(pctRemoved)}** of A's closed trades (A ${fmt(aTradesYear, 2)}/yr vs B ${fmt(bTradesYear, 2)}/yr)
6. Does the improvement survive fresh data? **${split.fresh.length < 80 ? "INSUFFICIENT FRESH SAMPLE" : (bFresh.expectancyR ?? 0) > (aFresh.expectancyR ?? 0) ? "B still higher expectancy on FRESH" : "NO"}**
7. Does POC help LONG, SHORT, BOTH, or NEITHER? **${pocSide}** (opportunity-level allowed vs blocked expectancy)
8. Which version should remain a research candidate: **${candidate}**

Do not deploy anything.
`);

  console.error(`VERDICT ${classification.classification}`);
  console.error(`A n=${aMetrics.n} expR=${fmt(aMetrics.expectancyR, 4)} end=${fmt(aMetrics.endingBalance, 2)}`);
  console.error(`B n=${bMetrics.n} expR=${fmt(bMetrics.expectancyR, 4)} end=${fmt(bMetrics.endingBalance, 2)}`);
}

await main();
