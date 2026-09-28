/** Centered dialog motion (confirm sheets, alerts). */

export const CENTER_MODAL_OPEN_MS = 260;
export const CENTER_MODAL_CLOSE_MS = 200;
export const CENTER_MODAL_OPEN_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
export const CENTER_MODAL_CLOSE_EASE = "cubic-bezier(0.33, 0, 0.67, 0.33)";

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function motionMs(open: boolean) {
  if (reducedMotion()) return 0;
  return open ? CENTER_MODAL_OPEN_MS : CENTER_MODAL_CLOSE_MS;
}

export function animateCenterModalIn(panel: HTMLElement, backdrop: HTMLElement | null): Promise<void> {
  panel.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  const ms = motionMs(true);
  const panelAnimation = panel.animate(
    [
      { opacity: 0, transform: "translate3d(0, 14px, 0) scale(0.94)" },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    ],
    { duration: ms, easing: CENTER_MODAL_OPEN_EASE, fill: "forwards" },
  );
  const backdropAnimation = backdrop?.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: ms, easing: CENTER_MODAL_OPEN_EASE, fill: "forwards" },
  );

  panel.style.willChange = "transform, opacity";
  return Promise.all([panelAnimation.finished, backdropAnimation?.finished])
    .then(() => {
      panel.style.opacity = "";
      panel.style.transform = "";
      panel.style.willChange = "";
      panelAnimation.cancel();
      if (backdrop && backdropAnimation) {
        backdrop.style.opacity = "";
        backdropAnimation.cancel();
      }
    })
    .catch(() => undefined);
}

export function animateCenterModalOut(panel: HTMLElement, backdrop: HTMLElement | null): Promise<void> {
  panel.getAnimations().forEach((animation) => animation.cancel());
  backdrop?.getAnimations().forEach((animation) => animation.cancel());

  const ms = motionMs(false);
  const panelAnimation = panel.animate(
    [
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      { opacity: 0, transform: "translate3d(0, 10px, 0) scale(0.96)" },
    ],
    { duration: ms, easing: CENTER_MODAL_CLOSE_EASE, fill: "forwards" },
  );
  const backdropAnimation = backdrop?.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    { duration: ms, easing: CENTER_MODAL_CLOSE_EASE, fill: "forwards" },
  );

  panel.style.willChange = "transform, opacity";
  return Promise.all([panelAnimation.finished, backdropAnimation?.finished])
    .then(() => {
      // Commit the end frame before cancel(). cancel() drops `fill: forwards`
      // and snaps back to opacity: 1 for one frame before React unmounts.
      panel.style.opacity = "0";
      panel.style.transform = "translate3d(0, 10px, 0) scale(0.96)";
      panel.style.pointerEvents = "none";
      panel.style.willChange = "";
      if (backdrop) {
        backdrop.style.opacity = "0";
        backdrop.style.pointerEvents = "none";
      }
      panelAnimation.cancel();
      backdropAnimation?.cancel();
    })
    .catch(() => undefined);
}
