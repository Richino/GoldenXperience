import assert from "node:assert/strict";
import { buildPaperRecommendation, paperBatchMetrics, paperBreakdown, paperRiskAllowsEntry, parsePaperRiskConfiguration, type StoredTrade } from "../src/paper-cycle.js";
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";

assert.deepEqual(MAJOR_INSTRUMENTS, ["EUR_USD", "GBP_USD", "USD_JPY", "AUD_USD", "NZD_USD", "USD_CAD", "USD_CHF", "EUR_GBP", "EUR_JPY", "GBP_JPY"], "the monitored universe must remain the fixed ten-pair contract");
assert.deepEqual(parsePaperRiskConfiguration({ riskPercent: 0.5, maxSimultaneousPositions: 3, maxTotalNominalRiskPercent: 2 }), { riskPercent: 0.5, maxSimultaneousPositions: 3, maxTotalNominalRiskPercent: 2 });
assert.deepEqual(parsePaperRiskConfiguration({ riskPercent: 1, maxSimultaneousPositions: null, maxTotalNominalRiskPercent: null }), { riskPercent: 1, maxSimultaneousPositions: null, maxTotalNominalRiskPercent: null }, "position and total exposure limits may be unlimited");
assert.throws(() => parsePaperRiskConfiguration({ riskPercent: 10, maxSimultaneousPositions: null, maxTotalNominalRiskPercent: null }), /between 0.1% and 5%/);
assert.throws(() => parsePaperRiskConfiguration({ riskPercent: 1, maxSimultaneousPositions: 11, maxTotalNominalRiskPercent: null }), /between 1 and 10/);
assert.equal(paperRiskAllowsEntry({ riskPercent: 1, maxSimultaneousPositions: null, maxTotalNominalRiskPercent: null }, 10, 10), true, "unlimited collection accepts cross-pair exposure");
assert.equal(paperRiskAllowsEntry({ riskPercent: 1, maxSimultaneousPositions: 3, maxTotalNominalRiskPercent: null }, 3, 3), false, "position cap blocks a new entry");
assert.equal(paperRiskAllowsEntry({ riskPercent: 1, maxSimultaneousPositions: null, maxTotalNominalRiskPercent: 3 }, 2, 2.5), false, "total nominal exposure cap blocks a new entry");

const rows: StoredTrade[] = Array.from({ length: 100 }, (_, index) => ({
  id: String(index),
  trade_sequence: String(index + 1),
  instrument: index < 25 ? "USD_JPY" : "EUR_USD",
  direction: index % 2 ? "long" : "short",
  status: "closed",
  outcome: index < 25 ? "stop_first" : index % 3 ? "target_first" : "stop_first",
  result_r: index < 25 ? "-1" : index % 3 ? "1.5" : "-1",
  session: index < 25 ? "London" : "London/New York overlap",
  weekday: "Monday",
  spread_pips: "1",
  opened_at: new Date(2026, 0, 1, 9, index).toISOString(),
  closed_at: new Date(2026, 0, 1, 10, index).toISOString(),
}));

const summary = paperBatchMetrics(rows);
assert.equal(summary.assigned, 100);
assert.equal(summary.resolved, 100);
assert.ok(summary.maxDrawdownR >= 20, "drawdown must be calculated in trade order");

const pairs = paperBreakdown(rows, "instrument");
assert.equal(pairs.find((item) => item.group === "USD_JPY")?.evidenceEligible, true, "20 or more resolved trades may support a subgroup conclusion");
const recommendation = buildPaperRecommendation(rows);
assert.equal(recommendation?.type, "exclude_pair");
assert.equal(recommendation?.value, "USD_JPY");

const tooSmall = buildPaperRecommendation(rows.slice(0, 19));
assert.equal(tooSmall, null, "fewer than 20 samples must not generate a strategy recommendation");

console.log("Paper-cycle fixture checks passed.");
