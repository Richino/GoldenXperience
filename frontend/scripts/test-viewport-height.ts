import assert from "node:assert/strict";
import { syncAppViewportHeight } from "../src/lib/pwa/viewport-height";

class TestViewport extends EventTarget {
  height = 800;
  scale = 1;
}
class TestWindow extends EventTarget {
  innerHeight = 800;
  visualViewport: TestViewport | null = new TestViewport();
  frames = new Map<number, FrameRequestCallback>();
  timers = new Map<number, () => void>();
  nextId = 0;
  scrollResets = 0;
  requestAnimationFrame(callback: FrameRequestCallback) { const id = ++this.nextId; this.frames.set(id, callback); return id; }
  cancelAnimationFrame(id: number) { this.frames.delete(id); }
  setTimeout(callback: () => void) { const id = ++this.nextId; this.timers.set(id, callback); return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  scrollTo() { this.scrollResets++; }
  flushFrames() {
    for (let pass = 0; this.frames.size && pass < 5; pass++) {
      const callbacks = [...this.frames.values()]; this.frames.clear();
      callbacks.forEach(callback => callback(0));
    }
  }
  flushTimers() { const callbacks = [...this.timers.values()]; this.timers.clear(); callbacks.forEach(callback => callback()); }
}
class TestDocument extends EventTarget {
  visibilityState = "visible";
  activeElement: Element | null = null;
  properties = new Map<string, string>();
  documentElement = { scrollTop: 80, style: {
    setProperty: (key: string, value: string) => { this.properties.set(key, value); },
    removeProperty: (key: string) => { this.properties.delete(key); },
  } };
}
const browser = new TestWindow();
const page = new TestDocument();
const height = () => page.properties.get("--app-viewport-height");
const emit = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type));
const stop = syncAppViewportHeight(browser as unknown as Window, page as unknown as Document);
assert.equal(height(), "800px");

// The OS shrinks both viewports while the app switcher is open. Retain the
// last visible layout instead of committing the temporary background height.
page.visibilityState = "hidden"; emit(page, "visibilitychange");
browser.innerHeight = 320; browser.visualViewport!.height = 320;
emit(browser.visualViewport!, "resize"); emit(browser, "resize");
assert.equal(height(), "800px", "background resize measurements cannot shrink the chart");
assert.equal(browser.frames.size + browser.timers.size, 0, "suspend pending measurements while hidden");

// No visualViewport resize fires on return. Its stale short height must not
// override the restored window, even though it looks like a keyboard gap.
browser.innerHeight = 800; page.visibilityState = "visible";
emit(page, "visibilitychange");
assert.equal(height(), "800px", "foreground restoration uses layout height without an editable focus");

// Some devices restore innerHeight later, after the visibility event and first
// frames, with no further resize event. Bounded settling checks recover it.
browser.innerHeight = 350; emit(browser, "pageshow"); browser.flushFrames();
assert.equal(height(), "350px");
browser.innerHeight = 800; browser.flushTimers();
assert.equal(height(), "800px", "late OS window restoration is picked up without resize events");

// The original iOS keyboard behavior still works and only its close edge
// resets residual page scroll. A visual resize alone is not a keyboard.
page.activeElement = { tagName: "TEXTAREA", matches: () => true } as unknown as Element;
browser.visualViewport!.height = 430; emit(page, "focusin");
assert.equal(height(), "430px");
assert.equal(browser.scrollResets, 0, "do not move the page while typing");
browser.visualViewport!.height = 800; emit(browser.visualViewport!, "resize");
assert.equal(height(), "800px");
assert.equal(browser.scrollResets, 1);
assert.equal(page.documentElement.scrollTop, 0);
page.activeElement = null;
browser.visualViewport!.height = 0; emit(browser.visualViewport!, "resize");
assert.equal(height(), "800px", "zero visual viewport measurements cannot collapse the layout");
browser.innerHeight = 0; emit(browser, "resize");
assert.equal(height(), "800px", "zero layout measurements retain the last good size");

// Pinch zoom changes visual size but must not change the page's layout height.
browser.innerHeight = 800; browser.visualViewport!.height = 400; browser.visualViewport!.scale = 2;
page.activeElement = { tagName: "TEXTAREA", matches: () => true } as unknown as Element;
emit(browser.visualViewport!, "resize");
assert.equal(height(), "800px");
browser.visualViewport!.scale = 1;

// Android can resize the window itself for its keyboard. Window resize is
// sufficient there, and orientation/window-focus transitions also resync.
browser.innerHeight = 430; browser.visualViewport!.height = 430; emit(browser, "resize");
assert.equal(height(), "430px");
page.activeElement = null; browser.innerHeight = 800; emit(browser, "focus");
assert.equal(height(), "800px");
browser.innerHeight = 390; emit(browser, "orientationchange");
assert.equal(height(), "390px");
assert.equal(browser.frames.size, 1, "repeated lifecycle signals coalesce pending frame work");
assert.equal(browser.timers.size, 2);
stop();
assert.equal(height(), undefined);
assert.equal(browser.frames.size + browser.timers.size, 0, "cleanup cancels all pending work");
emit(browser, "focus"); emit(page, "visibilitychange"); emit(browser.visualViewport!, "resize");
assert.equal(height(), undefined, "cleanup removes event listeners");

browser.visualViewport = null; browser.innerHeight = 720;
const stopFallback = syncAppViewportHeight(browser as unknown as Window, page as unknown as Document);
assert.equal(height(), "720px", "browsers without VisualViewport use their window height");
stopFallback();
console.log("Viewport checks passed: background/resume, delayed restoration, keyboard, zoom, orientation, fallback and cleanup.");
