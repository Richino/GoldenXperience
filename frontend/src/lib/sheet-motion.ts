/**
 * Bottom-drawer motion shared by MobileSheet and the custom drawers (Trade,
 * Analyze). Timings and curves are the app's BottomDrawer ones.
 *
 * Everything runs through the Web Animations API on `transform` / `opacity`,
 * which the browser composites on the GPU at the display's own refresh rate —
 * no React render per frame. Finger drags write the transform directly inside
 * requestAnimationFrame for the same reason.
 */

export const OPEN_MS = 300;
export const OPEN_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const CLOSE_MS = 220;
export const CLOSE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
export const SNAP_BACK_MS = 240;

/** Drag past 90px, or flick faster than 0.5px/ms, to dismiss. */
export const DISMISS_DISTANCE = 90;
export const DISMISS_VELOCITY = 0.5;

export function isPhoneLayout() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches;
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Far enough below the fold that the sheet is fully hidden. */
export function offscreenDistance(sheet: HTMLElement) {
  return sheet.getBoundingClientRect().height + 24;
}

function translate(y: number) {
  return `translate3d(0, ${y}px, 0)`;
}

/**
 * Slide the sheet from `fromY` to `toY` (px). The backdrop fades from its
 * current opacity to fully shown (resting) or hidden (off-screen) — it does
 * not track the drag itself. Resolves when finished; the final transform is
 * left applied inline so the sheet never flashes back to its resting position
 * before the owner unmounts.
 */
export function animateSheet(
  sheet: HTMLElement,
  backdrop: HTMLElement | null,
  fromY: number,
  toY: number,
  duration: number,
  easing: string,
  backdropFrom?: number,
): Promise<void> {
  // A close can arrive while the open animation is still settling (especially
  // after a quick tap on a freshly opened phone drawer). Cancel its animation
  // before starting the new one. The stale animation must never finish later
  // and briefly restore the sheet to its open transform.
  sheet.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());
  const startOpacity = backdropFrom ?? (backdrop ? Number(getComputedStyle(backdrop).opacity) : 1);
  const endOpacity = toY === 0 ? 1 : 0;
  const ms = reducedMotion() ? 0 : duration;
  sheet.style.willChange = "transform";

  const sheetAnimation = sheet.animate(
    [{ transform: translate(fromY) }, { transform: translate(toY) }],
    { duration: ms, easing, fill: "forwards" },
  );
  const backdropAnimation = backdrop?.animate(
    [{ opacity: String(startOpacity) }, { opacity: String(endOpacity) }],
    { duration: ms, easing, fill: "forwards" },
  );

  return Promise.all([sheetAnimation.finished, backdropAnimation?.finished])
    .then(() => {
      // Commit the end state as inline styles and drop the animations, so a
      // later drag starts from the real position and nothing keeps a layer alive.
      sheet.style.transform = toY === 0 ? "" : translate(toY);
      sheet.style.willChange = "";
      sheetAnimation.cancel();
      if (backdrop && backdropAnimation) {
        backdrop.style.opacity = toY === 0 ? "" : String(endOpacity);
        backdropAnimation.cancel();
      }
    })
    // Cancellation means a newer animation owns this sheet now. Do not write
    // this animation's final transform or opacity after it has been replaced.
    .catch(() => undefined);
}

export function animateSheetIn(sheet: HTMLElement, backdrop: HTMLElement | null) {
  return animateSheet(sheet, backdrop, offscreenDistance(sheet), 0, OPEN_MS, OPEN_EASE, 0);
}

export function animateSheetOut(sheet: HTMLElement, backdrop: HTMLElement | null, fromY = 0) {
  return animateSheet(sheet, backdrop, fromY, offscreenDistance(sheet), CLOSE_MS, CLOSE_EASE);
}

export function animateSheetBack(sheet: HTMLElement, backdrop: HTMLElement | null, fromY: number) {
  return animateSheet(sheet, backdrop, fromY, 0, SNAP_BACK_MS, OPEN_EASE);
}

/**
 * Follows a finger: batches position writes to one per display frame without
 * touching React state. The backdrop stays as it is while dragging.
 */
export function createDragFollower(sheet: HTMLElement, backdrop: HTMLElement | null) {
  let frame = 0;
  let pending = 0;
  sheet.style.willChange = "transform";
  // Stop any running open/snap animation so it cannot fight the finger.
  sheet.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  return {
    move(y: number) {
      pending = Math.max(0, y);
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sheet.style.transform = translate(pending);
      });
    },
    stop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      return pending;
    },
  };
}

/** Velocity (px/ms) over the last ~80ms of samples, so a flick counts even after a slow start. */
export function createVelocityTracker() {
  const samples: { y: number; t: number }[] = [];
  return {
    add(y: number, t: number) {
      samples.push({ y, t });
      while (samples.length > 2 && t - samples[0]!.t > 80) samples.shift();
    },
    velocity() {
      if (samples.length < 2) return 0;
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    },
  };
}
