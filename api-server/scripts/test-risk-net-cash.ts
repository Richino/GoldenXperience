import assert from "node:assert/strict";
import { readRiskNetCash } from "../src/risk-net-cash.js";
const records: Record<string, unknown> = {
  "/trades/100": { trade: { id: "100", state: "OPEN", initialUnits: "100", currentUnits: "50", realizedPL: "200", unrealizedPL: "100", financing: "-8", closingTransactionIDs: ["101"] } },
  "/transactions/100": { transaction: { type: "ORDER_FILL", units: "200", commission: "20", tradeOpened: { tradeID: "100", units: "100", guaranteedExecutionFee: "0" } } },
  "/transactions/101": { transaction: { type: "ORDER_FILL", units: "-100", commission: "10", tradesClosed: [{ tradeID: "100", units: "-50", realizedPL: "200", financing: "-3", guaranteedExecutionFee: "0" }, { tradeID: "other", units: "-50", realizedPL: "500", financing: "-3", guaranteedExecutionFee: "0" }] } },
};
const paths: string[] = [];
const read = async (path: string) => { paths.push(path); return records[path]; };
const result = await readRiskNetCash("100", read);
assert.equal(result?.realizedNetPnlUsd, 187); // 200 - 3 - 5 close commission - 5 entry commission.
assert.equal(result?.unrealizedNetPnlUsd, 90); // 100 - 5 financing - 5 remaining entry commission.
assert.equal((result?.realizedNetPnlUsd ?? 0) + (result?.unrealizedNetPnlUsd ?? 0), 277);
assert.ok(paths.every(path => /^\/(trades|transactions)\/\d+$/.test(path)), "accounting only reads broker evidence");
const open = records["/transactions/100"] as { transaction: { commission?: string } };
delete open.transaction.commission;
assert.equal(await readRiskNetCash("100", read), null, "missing commission must never become zero");
open.transaction.commission = "20";
const trade = records["/trades/100"] as { trade: Record<string, unknown> };
trade.trade.currentUnits = "0"; trade.trade.state = "CLOSED"; trade.trade.realizedPL = "400"; trade.trade.unrealizedPL = "0"; trade.trade.closingTransactionIDs = ["101", "102"];
records["/transactions/102"] = { transaction: { type: "ORDER_FILL", units: "-50", commission: "5", tradesClosed: [{ tradeID: "100", units: "-50", realizedPL: "200", financing: "-5", guaranteedExecutionFee: "0" }] } };
assert.equal((await readRiskNetCash("100", read))?.realizedNetPnlUsd, 372);
trade.trade.financing = "-12";
const financedClose = await readRiskNetCash("100", read);
assert.equal(financedClose?.realizedNetPnlUsd, 368, "include cumulative financing booked before the closing fills");
assert.equal(financedClose?.unrealizedNetPnlUsd, 0, "a fully closed trade has no remaining floating cash");
trade.trade.currentUnits = "50";
assert.equal(await readRiskNetCash("100", read), null, "reject a CLOSED trade with remaining exposure");
trade.trade.currentUnits = "0";
trade.trade.closingTransactionIDs = ["101", "101"];
assert.equal(await readRiskNetCash("100", read), null, "duplicate closes cannot double count cash or risk");
console.log("Broker net cash passed: partial closes, independent same-fill trades, costs/financing, complete closure, missing costs, read-only paths and duplicate protection.");
