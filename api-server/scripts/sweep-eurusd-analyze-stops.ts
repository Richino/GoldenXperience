import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTrend, DAY, replay, toBars, type Config, type Granularity, type Series, type TrendReader, type TrendSnapshot } from "./lib/eurusd-analyze-hold.js";
import type { ResearchCandle } from "../../frontend/src/lib/oanda/client.js";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(apiRoot, "..");
const baselineDir = path.join(apiRoot, "research-v2/eurusd-analyze-hold-v1");
const output = path.join(apiRoot, "research-v2/eurusd-analyze-stop-sweep-v1");
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
const baseline = JSON.parse(readFileSync(path.join(baselineDir, "RESULTS.json"), "utf8")) as {
  requestedRange: { since: string; until: string };
  data: Array<{ timeframe: string; sha256: string }>;
  runs: Array<{ config: Config; summary: ReturnType<typeof replay>["summary"] }>;
};
const since = Date.parse(baseline.requestedRange.since), until = Date.parse(baseline.requestedRange.until);
// Date and grid chosen before any sweep results. These are retrospective
// chronological checks: none of this previously viewed history is sealed.
const split = since + (until - since) * 0.75;
const series = {} as Series;
for (const granularity of ["M15", "H1", "H4", "D"] as Granularity[]) {
  const warmup = since - (granularity === "D" ? 500 : granularity === "H4" ? 80 : granularity === "H1" ? 25 : 8) * DAY;
  const key = sha(`EUR_USD|${granularity}|${warmup}|${until}`).slice(0, 16);
  const raw = JSON.parse(readFileSync(path.join(baselineDir, "cache", `${granularity}-${key}.json`), "utf8")) as ResearchCandle[];
  series[granularity] = toBars(raw, granularity).filter(bar => bar.closeAt <= until);
  if (sha(JSON.stringify(series[granularity].map(bar => bar.candle))) !== baseline.data.find(source => source.timeframe === granularity)?.sha256) {
    throw new Error(`Baseline ${granularity} candle hash mismatch`);
  }
}
// The same causal Analyze packet is reusable across books. This memoizes
// pure reads by mode/time, never a result calculated on later candles.
const memo = new Map<string, TrendSnapshot>();
const cachedTrend: TrendReader = (input, bar, mode) => {
  const key = `${mode}|${bar.closeAt}`;
  let snapshot = memo.get(key);
  if (!snapshot) { snapshot = analyzeTrend(input, bar, mode); memo.set(key, snapshot); }
  return snapshot;
};
const candidates: NonNullable<Config["stopLoss"]>[] = [
  ...Array.from({ length: 500 }, (_, index) => ({ kind: "pips" as const, value: index + 1 })),
  ...Array.from({ length: 700 }, (_, index) => ({ kind: "atr" as const, value: Number(((index + 1) / 10).toFixed(1)) })),
];
type Summary = ReturnType<typeof replay>["summary"];
interface Row { mode: Config["mode"]; stop: Config["stopLoss"] | null; full: Summary; development: Summary; validation: Summary }
const rows: Row[] = [];
const selected: Array<{ mode: Config["mode"]; stop: Config["stopLoss"]; developmentNetUsd: number; validation: Summary }> = [];
const finalistLedgers: Array<{ mode: Config["mode"]; stop: Config["stopLoss"]; run: ReturnType<typeof replay> }> = [];
const netUsd = (summary: Summary) => summary.realizedNetUsd + summary.unrealizedNetUsd;
const rank = (left: Row, right: Row, period: "full" | "development") => netUsd(right[period]) - netUsd(left[period])
  || left[period].maxDrawdownUsd - right[period].maxDrawdownUsd
  || (left.stop?.value ?? 0) - (right.stop?.value ?? 0);

for (const previous of baseline.runs) {
  const base = { ...previous.config };
  delete base.stopLoss;
  for (const [index, stop] of [null, ...candidates].entries()) {
    const config: Config = stop ? { ...base, stopLoss: stop } : base;
    const full = replay(series, config, cachedTrend);
    if (!stop && Math.abs(full.summary.finalEquityUsd - previous.summary.finalEquityUsd) > 1e-6) throw new Error("No-stop baseline no longer reproduces");
    const development = replay(series, { ...config, until: split }, cachedTrend);
    const validation = replay(series, { ...config, since: split }, cachedTrend);
    rows.push({ mode: base.mode, stop, full: full.summary, development: development.summary, validation: validation.summary });
    if (index % 100 === 0) console.log(`${base.mode}: ${index}/${candidates.length} stops complete`);
  }
  const developmentBest = rows.filter(row => row.mode === base.mode && row.stop).sort((a, b) => rank(a, b, "development"))[0]!;
  selected.push({ mode: base.mode, stop: developmentBest.stop!, developmentNetUsd: netUsd(developmentBest.development), validation: developmentBest.validation });
  for (const kind of ["pips", "atr"] as const) {
    const winner = rows.filter(row => row.mode === base.mode && row.stop?.kind === kind).sort((a, b) => rank(a, b, "full"))[0]!;
    const run = replay(series, { ...base, stopLoss: winner.stop! }, cachedTrend);
    if (Math.abs(run.summary.finalEquityUsd - winner.full.finalEquityUsd) > 1e-6) throw new Error("Finalist replay failed to reproduce");
    for (const trade of run.trades) {
      const sign = trade.side === "long" ? 1 : -1;
      if (trade.stopPrice === undefined) throw new Error("Stop missing from trade ledger");
      if (trade.reason === "stop_loss" && sign * (trade.exitPrice - trade.stopPrice) > 1e-8) throw new Error("Optimistic stop fill");
      if (trade.enteredAt < trade.signaledAt) throw new Error("Early entry fill");
      if (Math.abs(trade.netUsd - (trade.grossPips * 0.0001 * trade.units - trade.financingUsd - trade.commissionUsd)) > 1e-6) throw new Error("Trade cost reconciliation failed");
    }
    if (Math.abs(run.trades.reduce((sum, trade) => sum + trade.netUsd, 0) - netUsd(run.summary)) > 1e-6) throw new Error("Ledger reconciliation failed");
    finalistLedgers.push({ mode: base.mode, stop: winner.stop!, run });
  }
}

const money = (value: number) => `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}`;
const label = (row: Pick<Row, "stop">) => row.stop ? `${row.stop.value} ${row.stop.kind === "pips" ? "pips" : "ATR"}` : "No stop";
const table = (set: Row[]) => [
  "| Mode | Stop | Net P&L | Return | Max drawdown | Closed trades | Win rate | PF | First 75% net | Last 25% net |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...set.map(row => { const s = row.full; return `| ${row.mode} | ${label(row)} | ${money(netUsd(s))} | ${s.returnPct.toFixed(2)}% | ${s.maxDrawdownPct.toFixed(2)}% | ${s.closedTrades} | ${s.winRate === null ? "n/a" : (s.winRate * 100).toFixed(1) + "%"} | ${s.profitFactor === null ? "n/a" : s.profitFactor.toFixed(2)} | ${money(netUsd(row.development))} | ${money(netUsd(row.validation))} |`; }),
];
const report = ["# EURUSD Analyze stop-loss sweep", "", "Retrospective research only. No stop guarantees profits. This grid was not evaluated on unseen history.", "",
  `Sample: ${baseline.requestedRange.since} to ${baseline.requestedRange.until}. Split: ${new Date(split).toISOString()}.`, "",
  "Tested each fixed distance from 1 through 500 pips (1-pip steps) and 0.1 through 70 ATR (0.1-ATR steps), plus the no-stop baseline, in both modes: 2,400 stop/mode combinations. The initial 0.1–10 ATR sweep was expanded because baseline adverse excursions reached 63.04 entry ATR. Beyond the observed maximum, stops do not activate in the original full-sample book. This is a finite grid, not every possible continuous level or exit design.", "",
  "The original trend, 1.5-entry-ATR pullback, 14-day losing timeout, fixed size, spreads, 0.2-pip per-side slippage, financing estimates and margin model stay fixed. After a stop, the account can enter again on a subsequent completed primary signal; trade counts and entries can therefore change.", "",
  "Stops are fixed from the actual fill price, never trailed. Activation uses raw bid/ask high/low and fills at the stop plus slippage or a worse opening gap. Entry-bar stops are checked. Intrabar fills are timestamped at the candle end and charged financing through that time; no tick path is invented. Floating drawdown ends at the stop fill on a stopped bar. If a margin threshold is closer, margin wins and the account halts.", "",
  "Each period is a separate account, starting flat with $10,000 and fixed 10,000 EUR units. Partial-period open trades are marked to market. Training/validation returns will not sum to the full-run result because account boundary positions and entry availability differ.", "",
  "## No-stop baseline", "", ...table(rows.filter(row => !row.stop)), "",
  "## Highest full-sample net profit (in-sample winners)", "",
  ...baseline.runs.flatMap(run => [`### ${run.config.mode}`, "", ...table(rows.filter(row => row.mode === run.config.mode && row.stop).sort((a, b) => rank(a, b, "full")).slice(0, 10)), ""]),
  "## Chronological selection check", "",
  "Select the largest first-75% net profit; ties prefer lower drawdown, then the smaller numerical stop. Test that choice on the last 25% without changing it. This is a retrospective check, not untouched out-of-sample evidence.", "",
  ...selected.map(choice => `${choice.mode}: selected **${label(choice)}**, development ${money(choice.developmentNetUsd)}, validation **${money(netUsd(choice.validation))}** (${choice.validation.returnPct.toFixed(2)}%), ${choice.validation.closedTrades} closed trades, max DD ${choice.validation.maxDrawdownPct.toFixed(2)}%.`), "",
  "## Profitability and sensitivity", "",
  ...baseline.runs.flatMap(run => ["pips", "atr"].map(kind => {
    const set = rows.filter(row => row.mode === run.config.mode && row.stop?.kind === kind);
    const profit = set.filter(row => netUsd(row.full) > 0);
    const both = set.filter(row => netUsd(row.development) > 0 && netUsd(row.validation) > 0);
    return `${run.config.mode} ${kind}: ${profit.length}/${set.length} full-sample profitable; ${both.length}/${set.length} profitable in both chronological periods.`;
  })), "",
  "Estimated financing and a simplified margin model remain limitations. Original history has 192 M15 gaps flagged by the market-open calendar; no synthetic bars are inserted. Very tight stops are especially sensitive to actual spread, slippage and execution latency.", "",
  "Inspect neighboring levels in RESULTS.csv rather than promoting a single peak. Finalist trade ledgers (best fixed-pip and ATR level per mode) are in FINALISTS.json. Any level chosen after inspecting this whole grid needs new forward evidence. Preserve this sweep; do not claim parameter selection as validation.", "",
  "Reproduce: `npm --workspace api-server run eurusd:analyze-stop-sweep`. Reads and verifies the existing baseline cache; no network or broker orders.", ""];
mkdirSync(output, { recursive: true });
const sourceFiles = ["api-server/scripts/sweep-eurusd-analyze-stops.ts", "api-server/scripts/lib/eurusd-analyze-hold.ts", ...Object.keys((JSON.parse(readFileSync(path.join(baselineDir, "RESULTS.json"), "utf8")) as { sourceHashes: Record<string, string> }).sourceHashes)];
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify({ generatedAt: new Date().toISOString(), researchOnly: true,
  dates: { since: baseline.requestedRange.since, until: baseline.requestedRange.until, split: new Date(split).toISOString() },
  grid: { fixedPips: [1, 500, 1], atr: [0.1, 70, 0.1], combinations: candidates.length * baseline.runs.length },
  data: baseline.data, sourceHashes: Object.fromEntries([...new Set(sourceFiles)].map(file => [file, sha(readFileSync(path.join(workspace, file), "utf8"))])),
  selected, rows }, null, 2) + "\n");
writeFileSync(path.join(output, "FINALISTS.json"), JSON.stringify(finalistLedgers.map(({ mode, stop, run: { equity, ...run } }) => ({ mode, stop, ...run })), null, 2) + "\n");
writeFileSync(path.join(output, "RESULTS.csv"), "mode,stop_kind,stop_value,net_usd,return_pct,max_drawdown_pct,closed_trades,win_rate,profit_factor,development_net_usd,validation_net_usd\n" + rows.map(row => [row.mode, row.stop?.kind ?? "none", row.stop?.value ?? "", netUsd(row.full), row.full.returnPct, row.full.maxDrawdownPct, row.full.closedTrades, row.full.winRate ?? "", row.full.profitFactor ?? "", netUsd(row.development), netUsd(row.validation)].join(",")).join("\n") + "\n");
writeFileSync(path.join(output, "REPORT.md"), report.join("\n"));
console.log(report.join("\n"));
console.log(`Saved ${output}`);
