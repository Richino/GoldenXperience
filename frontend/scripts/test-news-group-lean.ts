import assert from "node:assert/strict";
import { groupLean } from "../src/lib/news/group-lean";

const overall = { n: 826, hits: 438, scope: "overall" as const };

// The real GBP GDP pair: m/m 0.1% → 0.0% (slight) is High impact, q/q
// 0.5% → 0.7% (clear) is Medium. The bigger forecast change decides, ahead of impact.
const realGdp = groupLean([
  { title: "GDP m/m", impact: 3, move: "down", record: overall, forecastStrength: { weight: 1, size: 0.1 } },
  { title: "Prelim GDP q/q", impact: 2, move: "up", record: overall, forecastStrength: { weight: 2, size: 0.2 } },
]);
assert.equal(realGdp?.move, "up");
assert.equal(realGdp?.reason, "forecast");
assert.equal(realGdp?.leader.title, "Prelim GDP q/q");

// Same weight: the bigger change wins.
const sameWeight = groupLean([
  { title: "A m/m", move: "up", record: null, forecastStrength: { weight: 2, size: 0.3 } },
  { title: "B m/m", move: "down", record: null, forecastStrength: { weight: 2, size: 0.5 } },
]);
assert.equal(sameWeight?.move, "down");
assert.equal(sameWeight?.reason, "forecast");

// Without forecast reads, same record and impact: the quarterly headline print decides.
const gdp = groupLean([
  { title: "GDP m/m", impact: 3, move: "down", record: overall },
  { title: "Prelim GDP q/q", impact: 3, move: "up", record: overall },
]);
assert.equal(gdp?.move, "up");
assert.equal(gdp?.reason, "headline");
assert.equal(gdp?.leader.title, "Prelim GDP q/q");

// A clearly better record wins before anything else.
const record = groupLean([
  { title: "CPI y/y", impact: 3, move: "up", record: { n: 9, hits: 4, scope: "series" } },
  { title: "CPI m/m", impact: 3, move: "down", record: { n: 9, hits: 8, scope: "series" } },
]);
assert.equal(record?.move, "down");
assert.equal(record?.reason, "record");

// A better record on fewer than 8 calls does not count as clearly better.
const thin = groupLean([
  { title: "Retail Sales m/m", impact: 2, move: "up", record: { n: 4, hits: 4, scope: "series" } },
  { title: "Claimant Count Change", impact: 3, move: "down", record: overall },
]);
assert.equal(thin?.reason, "impact");
assert.equal(thin?.move, "down");

// Everything even: the first-listed release decides, so there is always an answer.
const even = groupLean([
  { title: "Trade Balance", move: "down", record: null },
  { title: "Current Account", move: "up", record: null },
]);
assert.equal(even?.move, "down");
assert.equal(even?.reason, "listed");

// Agreeing calls need no tie-break.
assert.equal(groupLean([{ title: "A", move: "up", record: null }, { title: "B", move: "up", record: null }]), null);

console.log("News group lean checks passed: record, impact, headline and fallback all give one direction.");
