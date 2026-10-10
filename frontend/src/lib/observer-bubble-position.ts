export type ObserverBubbleSide = "left" | "right";
export interface ObserverBubbleViewport { left: number; top: number; width: number; height: number }
export interface ObserverBubblePosition { x: number; y: number; side: ObserverBubbleSide; iconSize: number; rowHeight: number; viewport: ObserverBubbleViewport }
const MARGIN = 16;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/** Anchor the mascot itself so hiding the message or flipping sides never jumps the icon. */
export function observerBubblePosition(x: number, y: number, iconSize: number, rowHeight: number, viewport: ObserverBubbleViewport, side?: ObserverBubbleSide): ObserverBubblePosition {
  const left = viewport.left + MARGIN;
  const top = viewport.top + MARGIN;
  const clampedX = clamp(x, left, viewport.left + viewport.width - MARGIN - iconSize);
  const clampedY = clamp(y, top + Math.max(0, rowHeight - iconSize), viewport.top + viewport.height - MARGIN - iconSize);
  return { x: clampedX, y: clampedY, iconSize, rowHeight, viewport,
    side: side ?? (clampedX + iconSize / 2 < viewport.left + viewport.width / 2 ? "left" : "right") };
}

export function observerBubbleCloudRoom(position: ObserverBubblePosition) {
  const { x, iconSize, viewport, side } = position;
  return Math.max(0, side === "left" ? viewport.left + viewport.width - MARGIN - x - iconSize - 10 : x - viewport.left - MARGIN - 10);
}

/** Desktop chat stays beside the moved bubble; phone chat keeps its bottom-sheet layout. */
export function observerBubblePanel(position: ObserverBubblePosition) {
  const { x, y, iconSize, rowHeight, side, viewport } = position;
  const width = Math.min(360, viewport.width - 2 * MARGIN);
  const left = clamp(side === "left" ? x : x + iconSize - width, viewport.left + MARGIN, viewport.left + viewport.width - MARGIN - width);
  const bubbleTop = y + iconSize - rowHeight;
  const above = Math.max(0, bubbleTop - viewport.top - MARGIN - 10);
  const below = Math.max(0, viewport.top + viewport.height - MARGIN - y - iconSize - 10);
  return { left, above: above >= below, edge: above >= below ? bubbleTop - 10 : y + iconSize + 10, height: Math.min(680, Math.max(above, below)) };
}
