import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { simulate } from "./simulate-three-percent-risk";
import type { TradeAudit } from "./validate-executable-costs";
import type { ResearchCandle } from "../src/lib/oanda/client";

const ROOT = resolve(process.cwd(), "../api-server/research-v2");
const OUT = resolve(ROOT, "selective-portfolio-v1");
const PAIRS = ["EUR_USD", "USD_JPY", "GBP_USD", "AUD_USD"] as const;
type Pair = typeof PAIRS[number];
export const RULES = Object.freeze({ maximumSpreadToStop: 0.10, maximumOpenPositions: 1, riskPerTrade: 0.03 });
// This type deliberately contains no result, exit timestamp, future candle,
// confidence model, or historical profit field.
export type SelectionCandidate = {
  id: string; pair: string; decisionTime: string;
  entry: number; bid: number; ask: number; stop: number;
};
export type SelectionDecision = { id: string; pair: string; accepted: boolean; reason: string; spreadToStop: number | null };

export function selectBatch(candidates: SelectionCandidate[], activePositions: number, admittedPairs: readonly string[]): SelectionDecision[] {
  assert.ok(Number.isInteger(activePositions) && activePositions >= 0);
  const timestamps = new Set(candidates.map(c => Date.parse(c.decisionTime)));
  assert.ok(timestamps.size <= 1 && !timestamps.has(NaN), "A batch must contain one valid decision time");
  assert.equal(new Set(candidates.map(c => c.id)).size, candidates.length, "Duplicate candidate ID");
  const rows = candidates.map(c => {
    const valid = [c.entry, c.bid, c.ask, c.stop].every(Number.isFinite) && c.ask >= c.bid && Math.abs(c.entry - c.stop) > 0;
    const ratio = valid ? (c.ask - c.bid) / Math.abs(c.entry - c.stop) : null;
    const reason = !admittedPairs.includes(c.pair) ? "PAIR_NOT_ADMITTED" : !valid ? "INVALID_GEOMETRY"
      : ratio! > RULES.maximumSpreadToStop + 1e-12 ? "SPREAD_TOO_EXPENSIVE"
      : activePositions >= RULES.maximumOpenPositions ? "POSITION_ALREADY_OPEN" : "ELIGIBLE";
    return { id: c.id, pair: c.pair, accepted: false, reason, spreadToStop: ratio };
  });
  const winner = rows.filter(r => r.reason === "ELIGIBLE").sort((a, b) => a.spreadToStop! - b.spreadToStop! || a.pair.localeCompare(b.pair) || a.id.localeCompare(b.id))[0];
  for (const row of rows) if (row.reason === "ELIGIBLE") {
    row.accepted = row === winner;
    row.reason = row.accepted ? "ACCEPTED" : "LOWER_COST_SIMULTANEOUS_SIGNAL_SELECTED";
  }
  return rows;
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const tradeId = (t: TradeAudit) => `${t.pair}:${t.strategy}:${t.version}:${t.signalTimestamp}`;
export function selectHistorical(trades: TradeAudit[], admitted: readonly string[] = PAIRS) {
  const batches = new Map<number, TradeAudit[]>();
  for (const trade of trades) {
    const time = Date.parse(trade.decisionTime);
    batches.set(time, [...(batches.get(time) ?? []), trade]);
  }
  const selected: TradeAudit[] = [], decisions: (SelectionDecision & { decisionTime: string; resultR: number; exitReason: string })[] = [];
  // Exit events only release a position when their timestamp has arrived.
  // Future exit times are never passed to the selection decision function.
  const open = new Map<string, number>();
  for (const [time, batch] of [...batches.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [id, closeTime] of open) if (closeTime <= time) open.delete(id);
    const candidates = batch.map(t => ({ id: tradeId(t), pair: t.pair, decisionTime: t.decisionTime,
      entry: t.executableEntry, bid: t.bid, ask: t.ask, stop: t.stop }));
    const picks = selectBatch(candidates, open.size, admitted);
    for (const pick of picks) {
      const trade = batch.find(t => tradeId(t) === pick.id)!;
      if (pick.accepted) { selected.push(trade); open.set(pick.id, Date.parse(trade.exitTimestamp)); }
      // Outcomes are attached only after the decision has been made.
      decisions.push({ ...pick, decisionTime: trade.decisionTime, resultR: trade.executableResultR, exitReason: trade.exitReason });
    }
  }
  return { selected, decisions };
}

function metrics(trades: TradeAudit[], years: number) {
  const values = trades.map(t => t.executableResultR);
  const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
  const profits = values.filter(r => r > 0), losses = values.filter(r => r < 0);
  return { n: trades.length, wins: profits.length, winRate: trades.length ? profits.length / trades.length : null,
    expectancyR: trades.length ? sum(values) / trades.length : null, totalR: sum(values), annualizedTotalR: sum(values) / years,
    profitFactor: sum(losses) < 0 ? sum(profits) / -sum(losses) : null,
    annualTradeFrequency: trades.length / years,
    averageSpreadPips: trades.length ? sum(trades.map(t => t.spreadPips)) / trades.length : null,
    averageSpreadToStop: trades.length ? sum(trades.map(t => (t.ask - t.bid) / Math.abs(t.executableEntry - t.stop))) / trades.length : null,
    averageWinR: profits.length ? sum(profits) / profits.length : null,
    tp: trades.filter(t => t.exitReason === "TP").length };
}

async function freezeFile(path: string, content: string) {
  try { assert.equal(await readFile(path, "utf8"), content, `Frozen file changed: ${path}. Create a new experiment version.`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, content, { flag: "wx" });
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const sourcePath = resolve(ROOT, "executable-cost-validation/RESULTS.json");
  const sourceText = await readFile(sourcePath, "utf8");
  const source = JSON.parse(sourceText) as { pairs: Record<Pair, { trades: TradeAudit[]; period: { requestedFrom: string; requestedToExclusive: string; to: string } }> };
  const strategyHashes = Object.fromEntries(await Promise.all(PAIRS.map(async pair => {
    const path = resolve(process.cwd(), `src/lib/strategy/strategies/${pair.replace("_", "").toLowerCase()}-strategy.ts`);
    return [pair, { path, sha256: digest(await readFile(path, "utf8")) }] as const;
  })));
  const protocol = {
    id: "SELECTIVE_PORTFOLIO_V1", status: "FROZEN_RESEARCH_ONLY", rules: RULES,
    hypothesis: "A fixed low execution-cost selector with one concurrent position improves total net profit and drawdown despite fewer trades.",
    arms: { CONTROL: "Every eligible frozen signal; original exits and geometry.", SELECTIVE: "Spread/executable-stop <= 0.10, at most one open position, lowest spread/stop wins simultaneous signals, lexical pair/ID ties. No waiting for a cheaper entry." },
    initialAdmittedPairs: PAIRS, excluded: ["NZD_USD"], additionalPairs: "PENDING_FROZEN_PAIR_SPECIFIC_RULES",
    additionalPairAdmission: ["explicit pair and version", "source hash frozen before evaluating outcomes", "causal signal and original execution geometry adapter", "midpoint parity documented", "historical MBA coverage", "development executable costs positive", "separate prospective cohort begins only after admission; do not retroactively add to V1"],
    sourceSha256: digest(sourceText), strategyHashes,
    historicalPhase: { from: "2025-01-06T00:00:00.000Z", toExclusive: "2026-09-01T00:00:00.000Z", label: "REUSED_DEVELOPMENT_DATA_NOT_OOS", parameterSearch: false },
    prospectivePhase: { from: "2026-09-07T00:00:00.000Z", toExclusive: "2027-09-07T00:00:00.000Z", status: "NOT_STARTED", interimOptimization: false,
      minimumControlSignals: 100, minimumSelectedSignals: 50, minimumMonthsWithSignals: 9,
      passRequirements: ["SELECTIVE total net R and annual net R exceed CONTROL", "SELECTIVE 3% account ending equity exceeds CONTROL under same verified margin model", "SELECTIVE sampled equity drawdown no greater", "positive paired monthly incremental R in at least 2 of 4 calendar quarters", "paired month-bootstrap 95% interval for incremental total R excludes zero", "no margin-closeout events", "otherwise FAILS or INSUFFICIENT_DATA; no retuning"] },
    limitations: ["10% is a fixed hypothesis, not a proven profitable threshold", "one combined selection policy; cannot attribute results separately to cost gate and position limit", "prior historical signals and outcomes were already inspected", "no validated big-move predictor is introduced", "3% risk is an experiment assumption, not a safety claim", "future collection is not scheduled or enabled by this standalone development run"],
  };
  await freezeFile(resolve(OUT, "PROTOCOL.json"), JSON.stringify(protocol, null, 2) + "\n");
  const implementationHashes = Object.fromEntries(await Promise.all(["selective-portfolio-v1.ts", "simulate-three-percent-risk.ts"].map(async file =>
    [file, digest(await readFile(resolve(process.cwd(), "scripts", file), "utf8"))] as const)));
  await freezeFile(resolve(OUT, "IMPLEMENTATION.json"), JSON.stringify(implementationHashes, null, 2) + "\n");
  const from = Date.parse(protocol.historicalPhase.from), to = Date.parse(protocol.historicalPhase.toExclusive);
  const years = (to - from) / (365.2425 * 86_400_000);
  const controls = PAIRS.flatMap(pair => source.pairs[pair].trades).filter(t => Date.parse(t.decisionTime) >= from && Date.parse(t.decisionTime) < to);
  const { selected, decisions } = selectHistorical(controls);
  const market = {} as Record<Pair, ResearchCandle[]>;
  for (const pair of PAIRS) {
    const data = JSON.parse(await readFile(resolve(ROOT, `exit-duration-experiment/data/${pair}-MBA.json`), "utf8"));
    market[pair] = data.candles.filter((c: ResearchCandle) => Date.parse(c.time) <= Date.parse(source.pairs[pair].period.to));
  }
  const priorRisk = JSON.parse(await readFile(resolve(ROOT, "three-percent-risk-simulation/RESULTS.json"), "utf8"));
  const controlAccount = simulate(controls, from, to, true, market, priorRisk.rates);
  assert.ok(Math.abs(controlAccount.endingBalance - priorRisk.marginConstrained.endingBalance) < 1e-8, "Account control changed");
  const accountDecisions: SelectionDecision[] = [];
  const selectiveAccount = simulate(controls, from, to, true, market, priorRisk.rates, (batch, openCount) => {
    const picks = selectBatch(batch.map(t => ({ id: tradeId(t), pair: t.pair, decisionTime: t.decisionTime,
      entry: t.executableEntry, bid: t.bid, ask: t.ask, stop: t.stop })), openCount, PAIRS);
    accountDecisions.push(...picks);
    const ids = new Set(picks.filter(p => p.accepted).map(p => p.id));
    return batch.filter(t => ids.has(tradeId(t)));
  });
  assert.ok(selectiveAccount.maximumOpenPositions <= RULES.maximumOpenPositions);
  const acceptedIds = new Set(selectiveAccount.ledger.filter(r => r.event === "ENTRY").map(r => `${r.pair}:${r.signalTimestamp}`));
  const controlFilledIds = new Set(controlAccount.ledger.filter(r => r.event === "ENTRY").map(r => `${r.pair}:${r.signalTimestamp}`));
  const accountMetrics = (rows: TradeAudit[], ids: Set<string>) => metrics(rows.filter(t => ids.has(`${t.pair}:${t.signalTimestamp}`)), years);
  const controlMetrics = metrics(controls, years), selectiveMetrics = metrics(selected, years);
  const byYear = Object.fromEntries([2025, 2026].map(year => {
    const durationYears = (Math.min(to, Date.UTC(year + 1, 0, 1)) - Math.max(from, Date.UTC(year, 0, 1))) / (365.2425 * 86_400_000);
    return [year, { control: metrics(controls.filter(t => t.year === year), durationYears), selective: metrics(selected.filter(t => t.year === year), durationYears) }];
  }));
  const skipped = decisions.filter(d => !d.accepted);
  const reasons = Object.fromEntries([...new Set(skipped.map(d => d.reason))].map(reason => {
    const rows = skipped.filter(d => d.reason === reason);
    return [reason, { n: rows.length, skippedWinners: rows.filter(d => d.resultR > 0).length, skippedNetR: rows.reduce((s, r) => s + r.resultR, 0) }];
  }));
  const improvesHistorical = selectiveMetrics.totalR > controlMetrics.totalR && selectiveAccount.endingBalance > controlAccount.endingBalance && selectiveAccount.maxDrawdownPct <= controlAccount.maxDrawdownPct;
  const verdict = improvesHistorical ? "DEVELOPMENT_PASS_REQUIRES_PROSPECTIVE_VALIDATION" : "DEVELOPMENT_FAIL_DO_NOT_ACTIVATE";
  const trim = (r: ReturnType<typeof simulate>) => { const { ledger, equityCurve, ...rest } = r; void ledger; void equityCurve; return rest; };
  const output = { generatedAt: new Date().toISOString(), verdict, phase: "REUSED_DEVELOPMENT_ONLY", additionalPairs: "PENDING_ENTRY_RULES", prospective: "NOT_STARTED", protocolSha256: digest(JSON.stringify(protocol, null, 2) + "\n"),
    control: controlMetrics, selective: selectiveMetrics, byYear, rejectedReasons: reasons,
    byPair: Object.fromEntries(PAIRS.map(pair => [pair, { control: metrics(controls.filter(t => t.pair === pair), years), selective: metrics(selected.filter(t => t.pair === pair), years) }])),
    missedWinnerCount: skipped.filter(d => d.resultR > 0).length, avoidedLoserCount: skipped.filter(d => d.resultR < 0).length,
    controlAccount: trim(controlAccount), selectiveAccount: trim(selectiveAccount), marginMetadata: priorRisk.marginMetadata,
    marginConstrainedMetrics: { control: accountMetrics(controls, controlFilledIds), selective: accountMetrics(controls, acceptedIds) } };
  await writeFile(resolve(OUT, "RESULTS.json"), JSON.stringify(output, null, 2));
  await writeFile(resolve(OUT, "decisions.json"), JSON.stringify(decisions, null, 2));
  await writeFile(resolve(OUT, "account-decisions.json"), JSON.stringify({ decisions: accountDecisions, fills: selectiveAccount.ledger }, null, 2));
  const f = (v: number | null) => v === null ? "n/a" : v.toFixed(3);
  const table = `| Arm | Trades | Annual frequency | PF | EXP R | Total R | Annual net R | Avg spread/stop |\n|---|---:|---:|---:|---:|---:|---:|---:|\n` + [["CONTROL", controlMetrics], ["SELECTIVE", selectiveMetrics]].map(([label, raw]) => { const m = raw as ReturnType<typeof metrics>; return `| ${label} | ${m.n} | ${f(m.annualTradeFrequency)} | ${f(m.profitFactor)} | ${f(m.expectancyR)} | ${f(m.totalR)} | ${f(m.annualizedTotalR)} | ${f(m.averageSpreadToStop)} |`; }).join("\n");
  await writeFile(resolve(OUT, "FINAL_REPORT.md"), `# Selective portfolio V1 — ${verdict}\n\nThis is a development test on previously inspected history, not new out-of-sample validation. ${protocol.historicalPhase.from} to ${protocol.historicalPhase.toExclusive}.\n\nFrozen hypothesis: accept only spread/executable-stop <= 10%, permit one concurrent position, choose the cheapest simultaneous signal. Keep every underlying entry, direction, stop, target and timeout unchanged.\n\n${table}\n\nSame-margin account illustration ($100, 3% equity risk per accepted trade): CONTROL $${controlAccount.endingBalance.toFixed(2)}, drawdown ${controlAccount.maxDrawdownPct.toFixed(1)}%; SELECTIVE $${selectiveAccount.endingBalance.toFixed(2)}, drawdown ${selectiveAccount.maxDrawdownPct.toFixed(1)}%. Margin metadata: ${priorRisk.marginMetadata}. These account figures include margin-rejected signals; the R table above compares the selector's candidate cohorts before margin rejections.\n\nSkipped ${skipped.length} trades, including ${output.missedWinnerCount} winners and ${output.avoidedLoserCount} losers. Every skipped outcome and decision reason is retained in decisions.json. No decision used its outcome.\n\nThe result does not establish that cheaper signals have better return. ${improvesHistorical ? "The historical screen passes but still requires independent prospective evidence." : "The fixed selector fails the combined total-profit/drawdown objective. Do not tune the threshold after this result or activate this version."}\n\nAdditional pairs are awaiting their own frozen entry definitions. No extra pair-specific implementations were found beyond the four controls and excluded NZDUSD. No existing pair's rules were copied to another instrument. Admission requirements and a prospective 2026-09-07 to 2027-09-07 protocol are recorded in PROTOCOL.json. The prospective collector has not been scheduled or started.\n\nTests and runnable commands:\n\n- From frontend: npx.cmd tsx scripts/test-selective-portfolio-v1.ts\n- From frontend: npx.cmd tsx scripts/selective-portfolio-v1.ts\n\nNo production settings, broker orders or strategy implementations were changed.\n`);
  for (const entry of Object.values(strategyHashes)) assert.equal(digest(await readFile(entry.path, "utf8")), entry.sha256, "Frozen strategy changed during experiment");
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(e => { console.error(e); process.exitCode = 1; });
