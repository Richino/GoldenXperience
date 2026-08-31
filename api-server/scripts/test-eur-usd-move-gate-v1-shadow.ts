import assert from "node:assert/strict";
import { eurUsdMoveGateV1ShadowInternals } from "../src/eur-usd-move-gate-v1-shadow.js";

const future = Array.from({ length: 16 }, (_, index) => ({
  closeTime: new Date(Date.UTC(2024, 0, 1, 0, (index + 1) * 15)).toISOString(),
  bidClose: 1.1, bidHigh: 1.1002, bidLow: 1.0998, askClose: 1.10002, askHigh: 1.10022, askLow: 1.09982,
}));
future[2] = { ...future[2]!, bidHigh: 1.1016 };
assert.equal(eurUsdMoveGateV1ShadowInternals.targetFirst("long", 1.1, 0.001, future), true);
const collision = [...future];
collision[0] = { ...collision[0]!, bidHigh: 1.1016, bidLow: 1.0991 };
assert.equal(eurUsdMoveGateV1ShadowInternals.targetFirst("long", 1.1, 0.001, collision), false, "same-bar target/stop collision must fail closed");
assert.equal(eurUsdMoveGateV1ShadowInternals.targetFirst("short", 1.1, 0.001, future), false);
console.log("EUR/USD move gate v1 shadow tests passed");
