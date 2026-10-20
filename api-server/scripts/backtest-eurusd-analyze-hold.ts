import { config as loadDotenv } from "dotenv";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getResearchCandles, type ResearchCandle } from "../../frontend/src/lib/oanda/client.js";
import type { AnalyzeMode } from "../../frontend/src/lib/strategy/analyze-v2/config.js";
import { DAY, DEFAULT_CONFIG, replay, toBars, validateConfig, type Config, type Granularity, type Series } from "./lib/eurusd-analyze-hold.js";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(apiRoot, "..");
loadDotenv({ path: path.join(apiRoot, ".env"), quiet: true });
const help = `EURUSD Analyze trend / 14-day losing hold / profitable pullback backtest
Usage: npm --workspace api-server run eurusd:analyze-hold -- [options]
  --days=365                    Lookback (unless --since supplied)
  --since=2025-10-13             UTC start, inclusive
  --until=2026-10-13             UTC end, exclusive; default current time
  --modes=NORMAL,SWING           Independent accounts, M15 or H4 trend
  --hold-days=14 --pullback-atr=1.5
  --initial-usd=10000 --units=10000 --leverage=30 --closeout-fraction=0.5
  --slippage-pips=0.2 --commission-per-million=0
  --long-financing-pct=5 --short-financing-pct=5
  --input=DIR                   Offline ResearchCandle arrays M15/H1/H4/D.json
  --offline                     Use exact cached date range; never fetch
  --output=DIR                  Default research-v2/eurusd-analyze-hold-v1
  --help
Financing is an annualized calendar-day estimate, NOT historical broker swaps.
No stop loss / take profit. Margin closeout remains possible and halts the run.
No news filter. Analyze's trend is reused; its execution checklist is bypassed.`;

const allowed = new Set(["days", "since", "until", "modes", "hold-days", "pullback-atr", "initial-usd", "units", "leverage", "closeout-fraction", "slippage-pips", "commission-per-million", "long-financing-pct", "short-financing-pct", "input", "offline", "output", "help"]);
const args: Record<string, string> = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (!match || !allowed.has(match[1]!)) throw new Error(`Unknown option ${arg}; use --help`);
  const flag = match[1]!;
  if (match[2] === undefined && !["offline", "help"].includes(flag)) throw new Error(`Use --${flag}=VALUE`);
  args[flag] = match[2] ?? "true";
}
if (args.help) { console.log(help); process.exit(0); }

const date = (value: string) => {
  // Reject calendar overflow (Date.parse silently normalizes February 30).
  const at = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(at) || (value.length === 10 && new Date(at).toISOString().slice(0, 10) !== value)
    || (value.length !== 10 && !/(Z|[+-]\d\d:\d\d)$/.test(value))) throw new Error(`Use a valid UTC date or timezone-qualified timestamp: ${value}`);
  return at;
};
const until = args.until ? date(args.until) : Date.now();
const days = Number(args.days ?? 365);
if (!Number.isFinite(days) || days <= 0) throw new Error("days must be positive");
const since = args.since ? date(args.since) : until - days * DAY;
if (until > Date.now() + 60_000) throw new Error("until cannot be in the future");
const modes = [...new Set((args.modes ?? "NORMAL,SWING").split(","))] as AnalyzeMode[];
if (!modes.length || modes.some(mode => !["NORMAL", "SWING"].includes(mode))) throw new Error("modes must be NORMAL and/or SWING");
const config: Config = { ...DEFAULT_CONFIG, since, until };
for (const [option, field] of Object.entries({ "hold-days": "holdDays", "pullback-atr": "pullbackAtr", "initial-usd": "initialUsd", units: "units", leverage: "leverage", "closeout-fraction": "closeoutFraction", "slippage-pips": "slippagePips", "commission-per-million": "commissionPerMillion", "long-financing-pct": "longAnnualFinancingPct", "short-financing-pct": "shortAnnualFinancingPct" })) {
  if (args[option] !== undefined) (config as unknown as Record<string, number>)[field] = Number(args[option]);
}
validateConfig(config);
const output = args.output ? path.resolve(args.output) : path.join(apiRoot, "research-v2/eurusd-analyze-hold-v1");
const cache = path.join(output, "cache");
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const series = {} as Series;
const sources: Array<{ timeframe: string; sha256: string; bars: number; first: string | null; last: string | null }> = [];
const granularities: Granularity[] = ["M15", "H1", "H4", "D"];

for (const granularity of granularities) {
  // 300 trading daily bars plus weekends/holidays for Analyze's history.
  const warmup = since - (granularity === "D" ? 500 : granularity === "H4" ? 80 : granularity === "H1" ? 25 : 8) * DAY;
  const key = sha(`EUR_USD|${granularity}|${warmup}|${until}`).slice(0, 16);
  const input = args.input ? path.resolve(args.input, `${granularity}.json`) : path.join(cache, `${granularity}-${key}.json`);
  let raw: ResearchCandle[];
  if (existsSync(input)) raw = JSON.parse(readFileSync(input, "utf8")) as ResearchCandle[];
  else {
    if (args.input || args.offline) throw new Error(`Missing offline candles: ${input}`);
    console.log(`Fetching EUR_USD ${granularity} with warmup (read-only OANDA history)...`);
    const all: ResearchCandle[] = [];
    let to = until;
    for (let page = 0; ; page++) {
      if (page >= 1000) throw new Error(`Pagination limit reached for ${granularity}`);
      const batch = await getResearchCandles("EUR_USD", granularity, 5000, { to: new Date(to).toISOString() });
      if (!batch.length) break;
      all.push(...batch);
      const earliest = Math.min(...batch.map(candle => Date.parse(candle.time)));
      if (!Number.isFinite(earliest) || earliest >= to) throw new Error(`Non-progressing ${granularity} history page`);
      if (earliest <= warmup || batch.length < 5000) break;
      to = earliest - 1;
      if (page % 5 === 0) console.log(`  ${granularity}: ${all.length} candles fetched`);
    }
    // Validate before writing the snapshot. Never use generated fallback candles.
    raw = toBars(all, granularity).filter(bar => bar.openAt >= warmup && bar.closeAt <= until).map(bar => bar.candle);
    mkdirSync(cache, { recursive: true });
    writeFileSync(input, JSON.stringify(raw));
  }
  if (!Array.isArray(raw)) throw new Error(`Expected a candle array in ${input}`);
  series[granularity] = toBars(raw, granularity).filter(bar => bar.closeAt <= until);
  if (!series[granularity].length) throw new Error(`Empty ${granularity} series`);
  const serialized = JSON.stringify(series[granularity].map(bar => bar.candle));
  sources.push({ timeframe: granularity, sha256: sha(serialized), bars: series[granularity].length,
    first: series[granularity][0]!.candle.time, last: series[granularity].at(-1)!.candle.time });
  console.log(`${granularity}: ${series[granularity].length} completed candles`);
}

const first = series.M15.find(bar => bar.openAt >= since);
const last = series.M15.at(-1)!;
if (!first || first.openAt - since > 4 * DAY || until - last.closeAt > 4 * DAY) throw new Error("Requested period is not covered by M15 history (more than 4 days missing at an edge)");
const runs = modes.map(mode => {
  console.log(`Replaying ${mode}...`);
  return replay(series, { ...config, mode });
});
const engineFiles = ["api-server/scripts/lib/eurusd-analyze-hold.ts", "api-server/scripts/backtest-eurusd-analyze-hold.ts",
  "frontend/src/lib/strategy/analyze-v2/config.ts", "frontend/src/lib/strategy/analyze-v2/foundation.ts",
  "frontend/src/lib/strategy/analyze-v2/structure.ts", "frontend/src/lib/strategy/analyze-v2/data-quality.ts",
  "frontend/src/lib/strategy/analyze-v2/zones.ts", "frontend/src/lib/strategy/analyze-v2/pullback.ts",
  "frontend/src/lib/strategy/analyze-v2/instrument-math.ts", "frontend/src/lib/strategy/market-regime.ts",
  "frontend/src/lib/strategy/session.ts", "frontend/src/lib/strategy/indicators.ts",
  "frontend/src/lib/instruments/catalog.ts", "frontend/src/lib/oanda/client.ts"];
let gitHead: string | null = null;
try { gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim(); } catch { /* Source hashes still identify this run. */ }
const result = { strategy: "eurusd-analyze-hold-v1", generatedAt: new Date().toISOString(), researchOnly: true,
  requestedRange: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
  actualRange: { since: new Date(first.openAt).toISOString(), until: new Date(last.closeAt).toISOString() },
  gitHead, sourceHashes: Object.fromEntries(engineFiles.map(file => [file, sha(readFileSync(path.join(workspace, file), "utf8"))])),
  data: sources, assumptions: {
    trend: "Same readMarketFoundation primary trend as live Analyze V2. Trend-only entries bypass its trade checklist. Higher alignment is recorded, not a filter.",
    fills: "Signal on completed candle, fill at next M15 open. Ask buy / bid sell plus slippage on each side. Entry expires across a gap.",
    losses: "No stop loss. If net P&L <= 0 at any M15 close at/after holdDays from entry, exit next available open. Profitable trades may exceed holdDays.",
    winners: "Primary close retreats pullbackAtr * fixed entry ATR from best favorable primary close since entry, AND net P&L > 0; exit next M15 open. Gap may make the realized exit a loss.",
    finance: "Signed annualized opening USD notional / 365, accrued over calendar time including weekends. Positive rate is a charge. Estimate, not historical OANDA roll/swap rates.",
    margin: "Fixed opening notional / leverage required for entry. Liquidate at NAV <= closeoutFraction * opening margin (worst open for gaps); halt account afterward. Simplified, not exact OANDA rules.",
    drawdown: "Close-equity peaks against every M15 adverse extreme, including floating losses and estimated exit costs. Conservative bar approximation.",
    news: "No historical news filter; calendar is not consulted for trend-only entries.",
    sample: "Retrospective exploratory sample. Analyze was developed on overlapping history; no claim of unseen/out-of-sample validation.",
    end: "Remaining position marked to market with estimated exit costs, kept separate from closed-trade win rate and profit factor.",
  }, runs: runs.map(({ equity, ...run }) => run) };
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "RESULTS.json"), JSON.stringify(result, null, 2) + "\n");
for (const run of runs) writeFileSync(path.join(output, `equity-${run.config.mode.toLowerCase()}.csv`), "time,equity_usd\n" + run.equity.map(point => `${new Date(point.at).toISOString()},${point.usd.toFixed(4)}`).join("\n") + "\n");
const usd = (value: number | null) => value === null ? "n/a" : `$${value.toFixed(2)}`;
const report = ["# EURUSD Analyze hold backtest", "", "Research only; retrospective exploratory results, not a validated strategy.", "",
  `Requested: ${result.requestedRange.since} to ${result.requestedRange.until}. Actual M15 coverage: ${result.actualRange.since} to ${result.actualRange.until}.`, "",
  `Independent USD accounts: ${usd(config.initialUsd)} each, ${config.units} fixed EUR units, ${config.leverage}:1 maximum leverage. Losing hold ${config.holdDays} calendar days. Pullback ${config.pullbackAtr} entry ATR.`, "",
  `Observed bid/ask spread + ${config.slippagePips} pips slippage per side. Financing estimate: long ${config.longAnnualFinancingPct}% / short ${config.shortAnnualFinancingPct}% annually. Commission ${config.commissionPerMillion} USD per million USD notional per side.`, "",
  "| Mode | Closed / open | Win rate | Closed PF | Total net P&L | Return | Floating-inclusive max DD | Worst closed loss | Max hold |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...runs.map(run => { const s = run.summary; return `| ${run.config.mode} | ${s.closedTrades} / ${s.openTrades} | ${s.winRate === null ? "n/a" : (s.winRate * 100).toFixed(1) + "%"} | ${s.profitFactor === null ? "n/a" : s.profitFactor.toFixed(2)} | ${usd(s.finalEquityUsd - config.initialUsd)} | ${s.returnPct.toFixed(2)}% | ${usd(s.maxDrawdownUsd)} (${s.maxDrawdownPct.toFixed(2)}%) | ${usd(s.worstClosedTradeUsd)} | ${s.maxHoldDays.toFixed(2)}d |`; }), "",
  ...runs.map(run => `${run.config.mode}: exits ${JSON.stringify(run.summary.exits)}; financing ${usd(run.summary.financingUsd)}; largest adverse excursion ${run.summary.maxTradeMaePips.toFixed(1)} pips; missing market-open M15 bars ${run.diagnostics.missingM15Bars}; halted ${run.diagnostics.halted}.`), "",
  "## Rules and limitations", "", ...Object.entries(result.assumptions).map(([key, value]) => `- **${key}:** ${value}`), "",
  "No parameter tuning was performed by this runner. Exact inputs and code hashes are in RESULTS.json. Equity CSVs are regenerable local artifacts.", ""];
writeFileSync(path.join(output, "REPORT.md"), report.join("\n"));
console.log(report.join("\n"));
console.log(`Saved ${output}`);
