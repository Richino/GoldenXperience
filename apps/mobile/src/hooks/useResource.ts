import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { ApiError } from "@/api/client";

export interface ResourceState<T> {
  data: T | null;
  /** True only on the first load, when there is nothing to show yet. */
  loading: boolean;
  /** True during a background refresh (pull-to-refresh, interval, foreground). */
  refreshing: boolean;
  error: ApiError | null;
  /** Manually re-run the fetch (used by pull-to-refresh). */
  refresh: () => Promise<void>;
}

/**
 * Loads a resource and keeps it fresh, exposing the distinct states a financial
 * screen needs (brief §14): first-load `loading`, background `refreshing`,
 * `error`, and the last-good `data` (which is retained across a failed refresh
 * so the screen never blanks out). Refreshes on an optional interval and
 * whenever the app returns to the foreground.
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean } = {},
): ResourceState<T> {
  const { intervalMs, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const hasDataRef = useRef(false);
  const inFlight = useRef<AbortController | null>(null);

  // `loader` is expected to be stable (callers wrap it in useCallback), so it
  // can be a direct dependency rather than a render-time ref write.
  const run = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    if (hasDataRef.current) setRefreshing(true);
    try {
      const result = await loader(controller.signal);
      if (controller.signal.aborted) return;
      setData(result);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      // Keep the last good data on a refresh failure; only surface the error.
      setError(err instanceof ApiError ? err : new ApiError("Something went wrong.", "network"));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [loader]);

  useEffect(() => {
    if (!enabled) return;
    // The state update happens in an async continuation after the fetch, not
    // synchronously in the effect body — the lint rule can't see through it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
    return () => inFlight.current?.abort();
  }, [enabled, run]);

  useEffect(() => {
    if (!enabled || !intervalMs) return;
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, run]);

  useEffect(() => {
    if (!enabled) return;
    const onChange = (state: AppStateStatus) => {
      if (state === "active") void run();
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, [enabled, run]);

  return { data, loading, refreshing, error, refresh: run };
}
