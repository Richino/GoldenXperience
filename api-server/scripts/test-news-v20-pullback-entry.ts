import assert from "node:assert/strict";
import { decideNewsV20PullbackEntry } from "../src/news-v20-pullback-entry.js";

const bars = (closes: number[]) => closes.map((midClose, index) => ({ time: new Date(Date.UTC(2026, 0, 1, 0, index * 5)).toISOString(), midClose }));

// Strong DOWN signals retain their existing entry; V20 does not alter them.
assert.deepEqual(decideNewsV20PullbackEntry({ direction: "DOWN", surpriseStrength: 0.2, preReleaseMidClose: 1.1, preReleaseAtr: 0.001, baselineEntryIndex: 1, bars: bars([1.1, 1.0998]) }), { action: "ENTER", entryBarIndex: 1, reason: "baseline_entry" });

// A weak DOWN signal cannot enter while its observation window is incomplete.
const waiting = decideNewsV20PullbackEntry({ direction: "DOWN", surpriseStrength: 0.1, preReleaseMidClose: 1.1, preReleaseAtr: 0.001, baselineEntryIndex: 1, bars: bars([1.1, 1.0996, 1.0998]) });
assert.equal(waiting.action, "WAIT");

// After a favourable sell-off, a 0.2 ATR pullback below the pre-release price enters on the following M5 open.
assert.deepEqual(decideNewsV20PullbackEntry({ direction: "DOWN", surpriseStrength: 0.1, preReleaseMidClose: 1.1, preReleaseAtr: 0.001, baselineEntryIndex: 1, bars: bars([1.1, 1.0995, 1.0997, 1.0996, 1.09955, 1.0995, 1.09945]) }), { action: "ENTER", entryBarIndex: 3, reason: "weak_down_pullback" });

// No qualifying pullback still enters only after all four completed M5 bars are known.
assert.deepEqual(decideNewsV20PullbackEntry({ direction: "DOWN", surpriseStrength: 0.1, preReleaseMidClose: 1.1, preReleaseAtr: 0.001, baselineEntryIndex: 1, bars: bars([1.1, 1.0997, 1.0996, 1.0995, 1.0994, 1.0993, 1.0992]) }), { action: "ENTER", entryBarIndex: 5, reason: "weak_down_window_elapsed" });
console.log("news V20 pullback-entry policy tests passed");
