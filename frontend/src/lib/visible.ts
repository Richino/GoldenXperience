/**
 * True while the page is on screen. Background polls skip their request when
 * it is false: a tab left open in the background otherwise keeps hitting the
 * API (and Railway egress) all day for data nobody is looking at.
 */
export function tabVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}
