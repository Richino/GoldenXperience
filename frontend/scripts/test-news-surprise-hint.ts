import assert from "node:assert/strict";
import { describeNewsSurpriseHint, newsSurpriseHint, parseCalendarValue } from "../src/lib/news/surprise-hint";

assert.equal(parseCalendarValue("220K"), 220_000);
assert.equal(parseCalendarValue("0.3%"), 0.003);
assert.equal(parseCalendarValue("-0.2%"), -0.002);

const before = newsSurpriseHint({
  title: "Cash Rate",
  currency: "AUD",
  forecast: "4.35%",
  previous: "4.35%",
  actual: null,
});
assert.equal(before.kind, "before");
if (before.kind === "before") {
  assert.equal(before.beatDirection, "up");
  assert.equal(before.missDirection, "down");
}

const unemployment = newsSurpriseHint({
  title: "Unemployment Rate",
  currency: "USD",
  forecast: "4.1%",
  previous: "4.0%",
  actual: null,
});
if (unemployment.kind === "before") {
  assert.equal(unemployment.beatDirection, "down");
  assert.equal(unemployment.missDirection, "up");
}

const afterBeat = newsSurpriseHint({
  title: "CPI m/m",
  currency: "USD",
  forecast: "0.3%",
  previous: "0.2%",
  actual: "0.5%",
});
assert.equal(afterBeat.kind, "after");
if (afterBeat.kind === "after") {
  assert.equal(afterBeat.outcome, "beat");
  assert.equal(afterBeat.direction, "up");
}

const speech = newsSurpriseHint({
  title: "ECB President Lagarde Speaks",
  currency: "EUR",
  forecast: null,
  previous: null,
  actual: null,
});
assert.equal(speech.kind, "unknown");
assert.equal(describeNewsSurpriseHint(before)?.includes("Up if beat"), true);

console.log("news surprise hint: OK");
