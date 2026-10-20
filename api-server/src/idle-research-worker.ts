type Schedule = (run: () => void, delayMs: number) => () => void;

const scheduleTimeout: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Keep active backtests moving; an empty queue needs only two checks per minute. */
export function startIdleResearchWorker(
  run: () => Promise<{ processed: boolean }>,
  onError: (error: unknown) => void,
  schedule: Schedule = scheduleTimeout,
) {
  let stopped = false;
  let cancelNext: (() => void) | null = null;
  const tick = async () => {
    if (stopped) return;
    let delayMs = 30_000;
    try {
      if ((await run()).processed) delayMs = 1_000;
    } catch (error) {
      onError(error);
    } finally {
      if (!stopped) cancelNext = schedule(() => { void tick(); }, delayMs);
    }
  };
  void tick();
  return () => { stopped = true; cancelNext?.(); };
}
