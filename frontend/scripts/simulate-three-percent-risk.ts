import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import type { TradeAudit } from "./validate-executable-costs";
import type { ResearchCandle } from "../src/lib/oanda/client";

const PAIRS = ["EUR_USD", "USD_JPY", "GBP_USD", "AUD_USD"] as const;
type Pair = typeof PAIRS[number];
const ROOT = resolve(process.cwd(), "../api-server/research-v2");
const OUT = resolve(ROOT, "three-percent-risk-simulation");
const RISK = 0.03, START = 100;
type Prior = { period: { requestedFrom: string; requestedToExclusive: string; from: string; to: string }; trades: TradeAudit[] };
type Rates = Record<Pair, { marginRate: number; minimumTradeSize: number; tradeUnitsPrecision: number }>;
type Quote = { bid: number; ask: number; mid: number };
type Position = { trade: TradeAudit; cashRisk: number; units: number };
const candles = {} as Record<Pair, ResearchCandle[]>;
let rates: Rates;
const avg = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;

export function simulate(trades: TradeAudit[], from: number, to: number, marginConstrained: boolean, market = candles, instrumentRates = rates,
  selectionPolicy?: (candidates: TradeAudit[], openPositions: number) => TradeAudit[]) {
  const selected = trades.filter(t => Date.parse(t.decisionTime) >= from && Date.parse(t.decisionTime) < to);
  const events = new Map<number, { quotes: Partial<Record<Pair, Quote>>; entries: TradeAudit[]; exits: TradeAudit[] }>();
  const at = (time: number) => { if (!events.has(time)) events.set(time, { quotes: {}, entries: [], exits: [] }); return events.get(time)!; };
  for (const pair of new Set(selected.map(t => t.pair))) {
    const duration = pair === "GBP_USD" ? 1_800_000 : 3_600_000;
    for (const bar of market[pair]) {
      const time = Date.parse(bar.time) + duration;
      if (time >= from && time <= to) at(time).quotes[pair] = { bid: bar.bid.close, ask: bar.ask.close, mid: bar.mid.close };
    }
  }
  for (const trade of selected) {
    at(Date.parse(trade.decisionTime)).entries.push(trade);
    if (Date.parse(trade.exitTimestamp) <= to) at(Date.parse(trade.exitTimestamp)).exits.push(trade);
  }
  const open = new Map<string, Position>(), quotes = new Map<Pair, Quote>();
  const id = (t: TradeAudit) => `${t.pair}:${t.signalTimestamp}`;
  const signed = (t: TradeAudit, price: number) => t.direction === "long" ? price - t.executableEntry : t.executableEntry - price;
  const priceRisk = (t: TradeAudit) => Math.abs(t.executableEntry - t.stop);
  let cash = START, peak = START, minimumEquity = START, maxDrawdown = 0, maximumOpenPositions = 0, maximumCommittedRiskPct = 0;
  let maxMarginToEquity = 0, marginRejected = 0, wouldReject = 0, minimumSizeRejected = 0, marginCloseoutSamples = 0, filled = 0;
  let consecutiveLosses = 0, longestLosingStreak = 0;
  const equityCurve: Record<string, unknown>[] = [], ledger: Record<string, unknown>[] = [];
  const equity = () => cash + [...open.values()].reduce((sum, p) => {
    const q = quotes.get(p.trade.pair)!;
    return sum + p.cashRisk * signed(p.trade, p.trade.direction === "long" ? q.bid : q.ask) / priceRisk(p.trade);
  }, 0);
  const margin = () => [...open.values()].reduce((sum, p) => sum + p.units * (p.trade.pair === "USD_JPY" ? 1 : quotes.get(p.trade.pair)!.mid) * instrumentRates[p.trade.pair].marginRate, 0);
  for (const [time, event] of [...events.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [pair, quote] of Object.entries(event.quotes)) quotes.set(pair as Pair, quote);
    for (const t of event.exits) {
      const position = open.get(id(t)); if (!position) continue;
      const profit = position.cashRisk * t.executableResultR;
      cash += profit; open.delete(id(t));
      consecutiveLosses = profit < 0 ? consecutiveLosses + 1 : 0;
      longestLosingStreak = Math.max(longestLosingStreak, consecutiveLosses);
      ledger.push({ event: "EXIT", time: new Date(time).toISOString(), pair: t.pair, signalTimestamp: t.signalTimestamp, riskDollars: position.cashRisk, pnlDollars: profit, cash });
    }
    // Same-time candidates share a common pre-entry equity snapshot. Margin
    // allocation uses the fixed PAIRS order, never outcomes or strategy ranking.
    const beforeEntries = equity();
    const entryCandidates = selectionPolicy ? selectionPolicy(event.entries, open.size) : event.entries;
    for (const t of entryCandidates.sort((a, b) => PAIRS.indexOf(a.pair) - PAIRS.indexOf(b.pair))) {
      const q = quotes.get(t.pair); assert.ok(q);
      assert.equal(q.bid, t.bid); assert.equal(q.ask, t.ask);
      let cashRisk = beforeEntries * RISK;
      const unitRiskUsd = priceRisk(t) / (t.pair === "USD_JPY" ? t.executableEntry : 1);
      let units = cashRisk / unitRiskUsd;
      if (marginConstrained) {
        const scale = 10 ** instrumentRates[t.pair].tradeUnitsPrecision;
        units = Math.floor(units * scale) / scale; cashRisk = units * unitRiskUsd;
      }
      const need = units * (t.pair === "USD_JPY" ? 1 : q.mid) * instrumentRates[t.pair].marginRate;
      const available = equity() - margin();
      if (need > available) wouldReject++;
      if (marginConstrained && need > available) { marginRejected++; continue; }
      if (marginConstrained && units < instrumentRates[t.pair].minimumTradeSize) { minimumSizeRejected++; continue; }
      open.set(id(t), { trade: t, cashRisk, units }); filled++;
      ledger.push({ event: "ENTRY", time: new Date(time).toISOString(), pair: t.pair, signalTimestamp: t.signalTimestamp, riskDollars: cashRisk, units, preEntryEquity: beforeEntries });
    }
    const nav = equity(), used = margin();
    peak = Math.max(peak, nav); minimumEquity = Math.min(minimumEquity, nav);
    maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak);
    maximumOpenPositions = Math.max(maximumOpenPositions, open.size);
    maximumCommittedRiskPct = Math.max(maximumCommittedRiskPct, [...open.values()].reduce((s, p) => s + p.cashRisk, 0) / nav);
    maxMarginToEquity = Math.max(maxMarginToEquity, used / nav);
    if (used > 0 && nav <= 0.5 * used) marginCloseoutSamples++;
    if (event.entries.length || event.exits.length || open.size) equityCurve.push({ time: new Date(time).toISOString(), cash, equity: nav, openPositions: open.size, marginEstimate: used, drawdown: 1 - nav / peak });
  }
  const endingEquity = equity();
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), marginConstrained,
    initialBalance: START, endingBalance: endingEquity, endingCash: cash, openPositionsAtEnd: open.size,
    returnPct: (endingEquity / START - 1) * 100,
    candidates: selected.length, filled, marginRejected, minimumSizeRejected, wouldReject,
    maxDrawdownPct: 100 * maxDrawdown, minimumEquity, maximumOpenPositions,
    maximumCommittedRiskPct: 100 * maximumCommittedRiskPct, maxMarginToEquity,
    marginCloseoutSamples, longestLosingStreak, reached7000: peak >= 7000, reached10000: peak >= 10000,
    equityCurve, ledger };
}

async function main() {
  loadEnvConfig(resolve(process.cwd(), "../api-server"));
  await mkdir(OUT, { recursive: true });
  const sourceText = await readFile(resolve(ROOT, "executable-cost-validation/RESULTS.json"), "utf8");
  const prior = JSON.parse(sourceText).pairs as Record<Pair, Prior>;
  for (const pair of PAIRS) {
    const cached = JSON.parse(await readFile(resolve(ROOT, `exit-duration-experiment/data/${pair}-MBA.json`), "utf8"));
    candles[pair] = cached.candles.filter((c: ResearchCandle) => Date.parse(c.time) <= Date.parse(prior[pair].period.to));
  }
  const token = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim();
  const account = process.env.OANDA_ACCOUNT_ID?.trim();
  assert.ok(token && account, "Practice credentials required for read-only instrument margin metadata");
  assert.notEqual(process.env.OANDA_ENVIRONMENT, "live", "This research metadata request is practice-only");
  const getMetadata = () => fetch(`https://api-fxpractice.oanda.com/v3/accounts/${encodeURIComponent(account)}/instruments?instruments=${PAIRS.join(",")}`, { headers: { Authorization: `Bearer ${token}` } });
  let response = await getMetadata();
  for (let retry = 0; !response.ok && response.status >= 500 && retry < 3; retry++) {
    await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
    response = await getMetadata();
  }
  const marginMetadata = response.ok ? "CURRENT_PRACTICE_INSTRUMENT_RATES"
    : `UNAVAILABLE_HTTP_${response.status}; ILLUSTRATIVE_50_TO_1_AND_WHOLE_UNITS`;
  if (response.ok) {
    const data = await response.json() as { instruments: { name: Pair; marginRate: string; minimumTradeSize: string; tradeUnitsPrecision: number }[] };
    rates = Object.fromEntries(data.instruments.map(i => [i.name, { marginRate: Number(i.marginRate), minimumTradeSize: Number(i.minimumTradeSize), tradeUnitsPrecision: i.tradeUnitsPrecision }])) as Rates;
  } else {
    rates = Object.fromEntries(PAIRS.map(pair => [pair, { marginRate: 0.02, minimumTradeSize: 1, tradeUnitsPrecision: 0 }])) as Rates;
  }
  for (const pair of PAIRS) assert.ok(rates[pair]?.marginRate > 0);
  const allTrades = PAIRS.flatMap(p => prior[p].trades);
  const commonFrom = Math.max(...PAIRS.map(p => Date.parse(prior[p].period.requestedFrom)));
  const commonTo = Math.min(...PAIRS.map(p => Date.parse(prior[p].period.requestedToExclusive)));
  const pairResults = Object.fromEntries(PAIRS.map(p => [p, simulate(prior[p].trades, Date.parse(prior[p].period.requestedFrom), Date.parse(prior[p].period.requestedToExclusive), false)]));
  const combined = simulate(allTrades, commonFrom, commonTo, false);
  const constrained = simulate(allTrades, commonFrom, commonTo, true);
  const rolling: Record<string, unknown>[] = [];
  for (const months of [11, 12]) {
    let start = commonFrom;
    while (true) {
      const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + months);
      if (end.getTime() > commonTo) break;
      for (const marginConstrained of [false, true]) {
        const { equityCurve: _curve, ledger: _ledger, ...result } = simulate(allTrades, start, end.getTime(), marginConstrained);
        void _curve; void _ledger;
        rolling.push({ months, ...result });
      }
      const next = new Date(start); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1); start = next.getTime();
    }
  }
  const methodology = [
    `Margin metadata status: ${marginMetadata}. If unavailable, the margin-constrained result is explicitly a hypothetical 50:1 leverage scenario, not a claim about the user's account or historical OANDA requirements.`,
    "$100 initial equity, 3% pre-entry equity stop risk per trade; current frozen exits and recorded executable R results, no new signals or exit variants.",
    "Equity for sizing includes unrealized P&L at the latest completed executable candle close. Same-timestamp exits settle before entries; entries share a pre-entry equity snapshot. Correlated chronological outcomes and overlapping positions are retained.",
    "Two models: unconstrained fills of every saved signal, and a margin-feasibility approximation using instrument margin rates and unit precision where available, otherwise the explicitly stated hypothetical 50:1/whole-unit scenario. Fixed pair order allocates simultaneous margin. A rejected candidate is skipped, never delayed or resized except rounding down to allowed unit precision.",
    "Margin and conversion calculations are estimates: current instrument rates are applied throughout history; USDJPY risk dollars are converted at entry and saved R determines realized P&L. Account-specific rate overrides, historical rate changes, currency-conversion charges, financing, latency, gap slippage and netting details are not fully modeled.",
    "Margin closeout samples flag equity at/below half estimated margin, not a full broker liquidation simulation. Drawdown is sampled at completed H1/M30 closes plus entry/exit events, not tick-level worst drawdown. Real intrabar losses may be larger.",
    "The combined portfolio uses only the common available period, avoiding an artificial GBPUSD absence before its saved window. Rolling 11/12-month windows overlap and are descriptive, not independent trials or probabilities.",
    "Window entries are admitted by entry time only. Trades still open at a window boundary are marked to the latest available completed quote; their later recorded outcome is not used. Ending balance in these tables denotes ending equity, including any unrealized P&L.",
    "Recorded EURUSD/GBPUSD executable targets can pay below +2R; USDJPY/AUDUSD target +2R. Existing Pine-parity and historical-sample limitations carry forward. Risk-only percentage sizing generally cannot hit exactly zero with bounded stops, so ending above zero is not evidence of safety.",
  ];
  const trim = (s: ReturnType<typeof simulate>) => { const { equityCurve, ledger, ...rest } = s; void equityCurve; void ledger; return rest; };
  const output = { generatedAt: new Date().toISOString(), sourceSha256: createHash("sha256").update(sourceText).digest("hex"), riskFraction: RISK, marginMetadata, rates, methodology,
    pairs: Object.fromEntries(Object.entries(pairResults).map(([p, r]) => [p, trim(r)])), combined: trim(combined), marginConstrained: trim(constrained), rolling };
  await writeFile(resolve(OUT, "RESULTS.json"), JSON.stringify(output, null, 2));
  await writeFile(resolve(OUT, "equity-and-trades.json"), JSON.stringify({ pairs: pairResults, combined, constrained }));
  const compact = Object.entries(pairResults).map(([pair, r]) => `| ${pair} | ${r.filled} | $${r.endingBalance.toFixed(2)} | ${r.maxDrawdownPct.toFixed(1)}% | $${r.minimumEquity.toFixed(2)} |`);
  const rollingSummary = [11, 12].flatMap(months => [false, true].map(marginConstrained => {
    const rows = rolling.filter(r => r.months === months && r.marginConstrained === marginConstrained);
    const balances = rows.map(r => Number(r.endingBalance));
    return { months, marginConstrained, windows: rows.length, minimumEndingBalance: Math.min(...balances), averageEndingBalance: avg(balances), maximumEndingBalance: Math.max(...balances), worstDrawdownPct: Math.max(...rows.map(r => Number(r.maxDrawdownPct))), reached7000: rows.filter(r => r.reached7000).length };
  }));
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# Three-percent risk simulation\n\n$100 starting equity; current exits; historical executable costs.\n\n| Pair, original window | Trades | Ending balance | Sampled equity drawdown | Lowest equity |\n|---|---:|---:|---:|---:|\n${compact.join("\n")}\n\nCombined common window: ${combined.from} to ${combined.to}. All-fill model: $${combined.endingBalance.toFixed(2)}, ${combined.maxDrawdownPct.toFixed(1)}% drawdown, minimum $${combined.minimumEquity.toFixed(2)}; ${combined.maximumOpenPositions} simultaneous positions; maximum committed stop risk ${combined.maximumCommittedRiskPct.toFixed(1)}% of equity. ${combined.wouldReject} entries exceed estimated available margin.\n\nMargin-feasibility approximation: $${constrained.endingBalance.toFixed(2)}, ${constrained.maxDrawdownPct.toFixed(1)}% drawdown; ${constrained.filled} filled, ${constrained.marginRejected} margin-rejected candidates; margin-closeout samples ${constrained.marginCloseoutSamples}.\n\nRolling window summary:\n\n${rollingSummary.map(r => `- ${r.months} months, ${r.marginConstrained ? "margin constrained" : "all fills"}: ${r.windows} overlapping windows; ending balance $${r.minimumEndingBalance.toFixed(2)}–$${r.maximumEndingBalance.toFixed(2)}; worst sampled drawdown ${r.worstDrawdownPct.toFixed(1)}%; $7000 reached in ${r.reached7000} windows.`).join("\n")}\n\n${methodology.map(s => `- ${s}`).join("\n")}\n`);
  console.log(JSON.stringify({ ...output, rolling: rollingSummary }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(error => { console.error(error instanceof Error ? error.message : "Risk simulation failed"); process.exitCode = 1; });
