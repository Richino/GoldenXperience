/**
 * Research-only V20 entry timing policy for EUR/USD news setups.
 *
 * It fixes the V19 weak-DOWN entry-timing failure without changing signal
 * direction, target, stop geometry, or execution permissions. The caller must
 * supply completed M5 bars only; until the 20-minute window is complete the
 * policy returns WAIT rather than leaking a future pullback into a decision.
 */
export type NewsDirection = "UP" | "DOWN";
export type CompletedM5Bar = { time: string; midClose: number };
export type V20EntryDecision =
  | { action: "ENTER"; entryBarIndex: number; reason: "baseline_entry" | "weak_down_pullback" | "weak_down_window_elapsed" }
  | { action: "WAIT"; requiredBars: number; observedBars: number; reason: "weak_down_observation_window" };

export const NEWS_V20_PULLBACK_ENTRY_POLICY = Object.freeze({
  version: "eurusd-news-v20-pullback-entry-v1",
  appliesWhen: "direction is DOWN and surpriseStrength is below 0.15",
  pullbackAtr: 0.2,
  maximumWaitMinutes: 20,
  barMinutes: 5,
  alignment: "completed M5 close remains below the pre-release mid close",
  fallback: "enter at the end of the completed observation window",
  status: "RESEARCH_ONLY_NOT_CONNECTED_TO_ORDER_EXECUTION",
});

function requiresPullback(direction: NewsDirection, surpriseStrength: number) {
  return direction === "DOWN" && surpriseStrength < 0.15;
}

/**
 * Selects an executable M5-open entry index. `bars` must contain the baseline
 * entry bar and all completed bars since it. The selected entry is always the
 * bar immediately after the completed pullback signal, or the first bar after
 * the fully observed 20-minute fallback window.
 */
export function decideNewsV20PullbackEntry(input: {
  direction: NewsDirection;
  surpriseStrength: number;
  preReleaseMidClose: number;
  preReleaseAtr: number;
  baselineEntryIndex: number;
  bars: CompletedM5Bar[];
}): V20EntryDecision {
  const policy = NEWS_V20_PULLBACK_ENTRY_POLICY;
  if (!requiresPullback(input.direction, input.surpriseStrength)) {
    return { action: "ENTER", entryBarIndex: input.baselineEntryIndex, reason: "baseline_entry" };
  }
  if (!(input.preReleaseAtr > 0) || !Number.isFinite(input.preReleaseAtr)) {
    throw new Error("V20 pullback entry requires a positive pre-release ATR.");
  }
  const waitBars = policy.maximumWaitMinutes / policy.barMinutes;
  const finalObservedIndex = input.baselineEntryIndex + waitBars - 1;
  if (input.bars.length < finalObservedIndex + 1) {
    const observedBars = Math.max(0, input.bars.length - input.baselineEntryIndex);
    return { action: "WAIT", requiredBars: waitBars, observedBars, reason: "weak_down_observation_window" };
  }

  let favorableExtreme = input.bars[input.baselineEntryIndex - 1]?.midClose;
  if (!Number.isFinite(favorableExtreme)) throw new Error("V20 pullback entry requires the completed pre-entry M5 bar.");
  for (let signalIndex = input.baselineEntryIndex; signalIndex <= finalObservedIndex; signalIndex += 1) {
    const close = input.bars[signalIndex]?.midClose;
    if (!Number.isFinite(close)) throw new Error("V20 pullback entry requires contiguous completed M5 bars.");
    favorableExtreme = Math.min(favorableExtreme, close!);
    const retracement = close! - favorableExtreme;
    const remainsAligned = close! < input.preReleaseMidClose;
    if (remainsAligned && retracement + 1e-12 >= policy.pullbackAtr * input.preReleaseAtr) {
      return { action: "ENTER", entryBarIndex: signalIndex + 1, reason: "weak_down_pullback" };
    }
  }
  return { action: "ENTER", entryBarIndex: finalObservedIndex + 1, reason: "weak_down_window_elapsed" };
}
