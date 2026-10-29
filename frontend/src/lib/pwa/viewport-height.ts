const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
const HEIGHT_PROPERTY = "--app-viewport-height";

/** Keep fixed-height pages sized correctly after mobile app/keyboard transitions. */
export function syncAppViewportHeight(browser: Window, page: Document) {
  const viewport = browser.visualViewport;
  const root = page.documentElement;
  let keyboardWasOpen = false;
  let frame: number | null = null;
  let settleTimers: number[] = [];

  const sync = () => {
    // Background/app-switcher measurements can be zero or temporarily smaller.
    if (page.visibilityState !== "visible") return;
    const layoutHeight = browser.innerHeight;
    if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;
    const active = page.activeElement;
    const editing = Boolean(active && (
      active.matches("textarea, [contenteditable='true'], [contenteditable='']") ||
      active.tagName === "INPUT" && !NON_TEXT_INPUTS.has((active as HTMLInputElement).type)
    ));
    // iOS keeps innerHeight unchanged under its keyboard. Otherwise use the
    // layout height: visualViewport can retain an app-switcher or zoomed size.
    const keyboardOpen = Boolean(editing && viewport && viewport.scale === 1 &&
      viewport.height > 0 && viewport.height < layoutHeight - 120);
    const height = Math.round(keyboardOpen && viewport ? viewport.height : layoutHeight);
    root.style.setProperty(HEIGHT_PROPERTY, `${height}px`);
    if (keyboardWasOpen && !keyboardOpen) {
      browser.scrollTo(0, 0);
      root.scrollTop = 0;
    }
    keyboardWasOpen = keyboardOpen;
  };

  const cancelSettling = () => {
    if (frame !== null) browser.cancelAnimationFrame(frame);
    frame = null;
    settleTimers.forEach(timer => browser.clearTimeout(timer));
    settleTimers = [];
  };
  const resume = () => {
    cancelSettling();
    if (page.visibilityState !== "visible") return;
    // Let CSS use its viewport fallback while the browser restores its window.
    root.style.removeProperty(HEIGHT_PROPERTY);
    sync();
    frame = browser.requestAnimationFrame(() => {
      sync();
      frame = browser.requestAnimationFrame(() => { frame = null; sync(); });
    });
    // Mobile OS window restoration can finish after its visibility event,
    // without a visualViewport resize notification. These retries are bounded.
    settleTimers = [250, 750, 1500, 2500].map(delay => browser.setTimeout(sync, delay));
  };

  resume();
  viewport?.addEventListener("resize", sync);
  viewport?.addEventListener("scroll", sync);
  browser.addEventListener("resize", sync);
  browser.addEventListener("orientationchange", resume);
  browser.addEventListener("focus", resume);
  browser.addEventListener("pageshow", resume);
  page.addEventListener("visibilitychange", resume);
  page.addEventListener("resume", resume);
  page.addEventListener("focusin", sync);
  page.addEventListener("focusout", sync);
  return () => {
    cancelSettling();
    viewport?.removeEventListener("resize", sync);
    viewport?.removeEventListener("scroll", sync);
    browser.removeEventListener("resize", sync);
    browser.removeEventListener("orientationchange", resume);
    browser.removeEventListener("focus", resume);
    browser.removeEventListener("pageshow", resume);
    page.removeEventListener("visibilitychange", resume);
    page.removeEventListener("resume", resume);
    page.removeEventListener("focusin", sync);
    page.removeEventListener("focusout", sync);
    root.style.removeProperty(HEIGHT_PROPERTY);
  };
}
