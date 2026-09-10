import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { WS_URL } from "@/api/config";
import { MAJOR_INSTRUMENTS } from "@/types/forex";
import type { MarketStreamMessage } from "@/types/market-stream";
import { MarketStore, type Quote, type StreamStatus } from "@/realtime/store";

const MAX_RECONNECT_DELAY_MS = 10_000;
const STALE_AFTER_MS = 20_000;

const MarketStoreContext = createContext<MarketStore | null>(null);

function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 4), MAX_RECONNECT_DELAY_MS);
}

/**
 * Owns the single market-stream socket for the app. Mirrors the web hook's
 * lifecycle — subscribe on open, exponential-backoff reconnect, stale-stream
 * detection, and a forced reconnect when the app returns to the foreground —
 * adapted to React Native's `AppState`. The UI never crashes when the stream is
 * down; screens read the last snapshot and the connection banner reflects the
 * phase (brief §11).
 */
export function MarketStreamProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new MarketStore(), []);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMessageAt = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    const clearReconnect = () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    const connect = () => {
      clearReconnect();
      // The GX server's WS upgrade authorises by Origin only (a native client
      // sends none), so the market stream needs no session cookie.
      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;
      store.setStatus({
        phase: attemptRef.current === 0 ? "connecting" : "reconnecting",
        message: attemptRef.current === 0 ? "Connecting to the market stream…" : "Reconnecting…",
      });

      socket.onopen = () => {
        attemptRef.current = 0;
        lastMessageAt.current = Date.now();
        socket.send(JSON.stringify({ type: "subscribe", instruments: [...MAJOR_INSTRUMENTS] }));
      };

      socket.onmessage = (event) => {
        lastMessageAt.current = Date.now();
        let message: MarketStreamMessage;
        try {
          message = JSON.parse(event.data as string) as MarketStreamMessage;
        } catch {
          return;
        }
        if (message.type === "price") {
          store.applyTick(message);
        } else if (message.type === "status") {
          store.setStatus({
            source: message.source,
            phase: message.state === "error" || message.state === "closed" ? "reconnecting" : "connected",
            message: message.message,
          });
        }
        // Heartbeats only refresh the staleness clock, handled above.
      };

      socket.onerror = () => {
        store.setStatus({ phase: "reconnecting", message: "Market stream error. Reconnecting…" });
      };

      socket.onclose = () => {
        if (unmountedRef.current) return;
        const attempt = (attemptRef.current += 1);
        const delay = reconnectDelay(attempt);
        // After several failed attempts, tell the user we are offline rather
        // than silently retrying forever.
        store.setStatus({
          phase: attempt >= 4 ? "offline" : "reconnecting",
          message:
            attempt >= 4
              ? "Market stream is offline. Retrying…"
              : `Disconnected. Reconnecting in ${Math.round(delay / 1000)}s…`,
        });
        reconnectTimer.current = setTimeout(connect, delay);
      };
    };

    connect();

    // Stale-stream watchdog: an open socket that has gone quiet is as good as
    // dead, so force a reconnect.
    const staleTimer = setInterval(() => {
      const socket = socketRef.current;
      if (
        socket?.readyState === WebSocket.OPEN &&
        lastMessageAt.current > 0 &&
        Date.now() - lastMessageAt.current > STALE_AFTER_MS
      ) {
        store.setStatus({ phase: "reconnecting", message: "Stream stalled. Reconnecting…" });
        socket.close();
      }
    }, 5_000);

    // Returning to the foreground: pull a dead socket forward immediately
    // instead of waiting out the backoff.
    const onAppState = (state: AppStateStatus) => {
      if (state !== "active") return;
      const socket = socketRef.current;
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        attemptRef.current = 0;
        connect();
      } else if (
        socket.readyState === WebSocket.OPEN &&
        lastMessageAt.current > 0 &&
        Date.now() - lastMessageAt.current > STALE_AFTER_MS
      ) {
        socket.close();
      }
    };
    const appStateSub = AppState.addEventListener("change", onAppState);

    return () => {
      unmountedRef.current = true;
      clearReconnect();
      clearInterval(staleTimer);
      appStateSub.remove();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [store]);

  return <MarketStoreContext.Provider value={store}>{children}</MarketStoreContext.Provider>;
}

function useStore(): MarketStore {
  const store = useContext(MarketStoreContext);
  if (!store) throw new Error("Market stream hooks must be used within a MarketStreamProvider.");
  return store;
}

/** Live quote for one instrument. Re-renders only when THAT instrument ticks. */
export function useQuote(instrument: string): Quote | undefined {
  const store = useStore();
  return useSyncExternalStore(
    (listener) => store.subscribeQuote(instrument, listener),
    () => store.getQuote(instrument),
  );
}

/** The full quote map; re-renders on any tick. Use for aggregate views. */
export function useAllQuotes(): Record<string, Quote> {
  const store = useStore();
  return useSyncExternalStore(store.subscribeAllQuotes, store.getAllQuotes);
}

/** Connection status; re-renders only on phase/source/message changes. */
export function useStreamStatus(): StreamStatus {
  const store = useStore();
  return useSyncExternalStore(store.subscribeStatus, store.getStatus);
}
