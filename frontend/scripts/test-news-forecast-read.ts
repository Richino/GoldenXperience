import assert from "node:assert/strict";
import { combinedForecastRead, forecastRead } from "../src/lib/news/forecast-read";

const mm = forecastRead({ title: "GDP m/m", currency: "GBP", forecast: "0.0%", previous: "0.1%" });
const qq = forecastRead({ title: "Prelim GDP q/q", currency: "GBP", forecast: "0.7%", previous: "0.5%" });
assert.equal(mm?.label, "Slightly bearish GBP");
assert.equal(qq?.label, "Bullish GBP");
assert.equal(combinedForecastRead([mm, qq]).direction, "up", "a clear rise outweighs a slight dip");

// Higher unemployment is bad for the currency.
assert.equal(forecastRead({ title: "Unemployment Rate", currency: "USD", forecast: "4.3%", previous: "4.1%" })?.label, "Bearish USD");
// Counts compare relative to the previous level.
assert.equal(forecastRead({ title: "Non-Farm Employment Change", currency: "USD", forecast: "180K", previous: "170K" })?.label, "Slightly bullish USD");
assert.equal(forecastRead({ title: "CPI m/m", currency: "USD", forecast: "0.3%", previous: "0.3%" })?.direction, "flat");
assert.equal(forecastRead({ title: "Fed Chair Speaks", currency: "USD", forecast: null, previous: null }), null);
console.log("Forecast read checks passed: GBP GDP reads like the desk note, weights combine, flat and unmapped cases handled.");
