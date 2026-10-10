import assert from "node:assert/strict";
import { observerBubbleCloudRoom, observerBubblePanel, observerBubblePosition } from "../src/lib/observer-bubble-position";

for (const viewport of [{ left: 0, top: 0, width: 492, height: 884 }, { left: 0, top: 0, width: 320, height: 568 }, { left: 40, top: 100, width: 390, height: 600 }, { left: 0, top: 0, width: 1440, height: 900 }]) {
  for (const [x, y] of [[-1000, -1000], [10000, -1000], [-1000, 10000], [10000, 10000], [viewport.left + viewport.width / 2, viewport.top + viewport.height / 2]]) {
    const position = observerBubblePosition(x, y, 58, 100, viewport);
    assert(position.x >= viewport.left + 16);
    assert(position.x + 58 <= viewport.left + viewport.width - 16);
    assert(position.y + 58 - 100 >= viewport.top + 16, "The speech cloud cannot disappear above the screen");
    assert(position.y + 58 <= viewport.top + viewport.height - 16);
    const cloud = Math.min(250, observerBubbleCloudRoom(position));
    const left = position.side === "left" ? position.x : position.x - cloud - 10;
    const right = position.side === "left" ? position.x + 58 + 10 + cloud : position.x + 58;
    assert(left >= viewport.left + 16 && right <= viewport.left + viewport.width - 16, "Docking must fit the message toward the center");
    const panel = observerBubblePanel(position);
    assert(panel.left >= viewport.left + 16);
    assert(panel.left + Math.min(360, viewport.width - 32) <= viewport.left + viewport.width - 16);
    assert(panel.height > 0 && panel.height <= 680);
  }
}
const viewport = { left: 0, top: 0, width: 492, height: 884 };
const draggingLeft = observerBubblePosition(16, 400, 58, 100, viewport, "right");
assert.equal(draggingLeft.side, "right", "Orientation stays unchanged during the drag");
const releasedLeft = observerBubblePosition(draggingLeft.x, draggingLeft.y, 58, 100, viewport);
assert.equal(releasedLeft.side, "left");
assert.equal(releasedLeft.x, draggingLeft.x, "Flipping the cloud must not jump the mascot horizontally");
assert.equal(releasedLeft.y, draggingLeft.y);
const minimized = observerBubblePosition(releasedLeft.x, releasedLeft.y, 58, 58, viewport);
assert.equal(minimized.x, releasedLeft.x);
assert.equal(minimized.y, releasedLeft.y, "Hiding the message keeps the icon at its dropped position");
const resized = observerBubblePosition(418, 750, 58, 100, { ...viewport, width: 320, height: 568 });
assert.equal(resized.x, 246); assert.equal(resized.y, 494);
assert.equal(observerBubblePanel(observerBubblePosition(16, 100, 58, 100, viewport)).above, false);
assert.equal(observerBubblePanel(observerBubblePosition(418, 700, 58, 100, viewport)).above, true);
console.log("Observer bubble positioning tests passed: edge limits, inward message layout, release-only flipping, stable mascot anchors, minimization, viewport resize and desktop panel placement.");
