type Schedule = (run: () => void, delayMs: number) => () => void;

const scheduleTimeout: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Sequential polling with idle backoff and an enqueue wake-up. */
export function startIdleResearchWorker(
  run: () => Promise<{ processed: boolean }>,
  onError: (error: unknown) => void,
  schedule: Schedule = scheduleTimeout,
  timing = { activeMs: 1_000, idleMs: 30_000 },
) {
  let stopped = false;
  let busy = false;
  let wakePending = false;
  let nextDelay = Infinity;
  let generation = 0;
  let cancelNext: (() => void) | null = null;
  const arm = (delayMs: number) => {
    const current = ++generation;
    nextDelay = delayMs;
    cancelNext = schedule(() => {
      if (current !== generation) return;
      cancelNext = null; nextDelay = Infinity; void tick();
    }, delayMs);
  };
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    let delayMs = timing.idleMs;
    try {
      if ((await run()).processed) delayMs = timing.activeMs;
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
      if (wakePending) delayMs = timing.activeMs;
      wakePending = false;
      if (!stopped) arm(delayMs);
    }
  };
  void tick();
  const stop = () => { stopped = true; generation++; cancelNext?.(); };
  const wake = () => {
    if (stopped) return;
    if (busy) { wakePending = true; return; }
    // Repeated Analyze requests must not keep pushing the next check away.
    if (nextDelay <= timing.activeMs) return;
    cancelNext?.();
    arm(timing.activeMs);
  };
  return Object.assign(stop, { wake });
}
