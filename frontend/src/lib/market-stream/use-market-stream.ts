"use client";

import { useEffect, useRef, useState } from "react";
import type { MajorInstrument } from "@/types/forex";
import type {
  MarketPriceTick,
  MarketStreamState,
  MarketStreamStatus,
} from "@/types/market-stream";

interface MarketStreamSnapshot {
  state: MarketStreamState;
  source: "oanda" | "mock" | null;
  message: string;
  price: MarketPriceTick | null;
  lastHeartbeatAt: string | null;
  lastPriceAt: string | null;
}

const MAX_RECONNECT_DELAY_MS = 10_000;
const STALE_STREAM_AFTER_MS = 15_000;

function isLoopbackHost(value: string) {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(value);
}

function getWebSocketUrl() {
  if (process.env.NEXT_PUBLIC_MARKET_STREAM_WS_URL) {
    return process.env.NEXT_PUBLIC_MARKET_STREAM_WS_URL;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const configured = process.env.NEXT_PUBLIC_API_SERVER_URL;

  // A configured loopback host is only meaningful to a browser running on the
  // dev machine. A phone on the LAN has to be sent back to the host it loaded
  // the page from — the socket cannot go through the Next rewrite the way the
  // HTTP calls do.
  if (configured && !isLoopbackHost(new URL(configured).hostname)) {
    return configured.replace(/^http/, "ws");
  }

  const port = configured ? new URL(configured).port || "8787" : "8787";
  return `${protocol}//${window.location.hostname}:${port}`;
}

function getReconnectDelay(attempt: number) {
  return Math.min(1000 * 2 ** Math.min(attempt, 4), MAX_RECONNECT_DELAY_MS);
}

function isStatusMessage(message: unknown): message is MarketStreamStatus {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "status"
  );
}

function isPriceTick(message: unknown): message is MarketPriceTick {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "price"
  );
}

function isHeartbeatMessage(
  message: unknown,
): message is { type: "heartbeat"; source?: "oanda" | "mock"; time?: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: string }).type === "heartbeat"
  );
}

export function useMarketStream(
  instrument: MajorInstrument,
  onPrice?: (tick: MarketPriceTick) => void,
  options: { trackPrice?: boolean } = {},
) {
  const instrumentRef = useRef(instrument);
  const onPriceRef = useRef(onPrice);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const closedByUnmountRef = useRef(false);
  const lastMessageAtRef = useRef(0);
  const trackPriceRef = useRef(options.trackPrice ?? true);
  const [snapshot, setSnapshot] = useState<MarketStreamSnapshot>({
    state: "idle",
    source: null,
    message: "Market stream has not connected yet.",
    price: null,
    lastHeartbeatAt: null,
    lastPriceAt: null,
  });

  useEffect(() => {
    instrumentRef.current = instrument;

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "subscribe", instruments: [instrument] }),
      );
    }
  }, [instrument]);

  useEffect(() => {
    onPriceRef.current = onPrice;
  }, [onPrice]);

  useEffect(() => {
    trackPriceRef.current = options.trackPrice ?? true;
  }, [options.trackPrice]);

  useEffect(() => {
    closedByUnmountRef.current = false;

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function connect() {
      clearReconnectTimer();

      const wsUrl = getWebSocketUrl();
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      setSnapshot((current) => ({
        ...current,
        state: "connecting",
        message: `Connecting to market stream at ${wsUrl}.`,
      }));

      socket.addEventListener("open", () => {
        reconnectAttemptRef.current = 0;
        lastMessageAtRef.current = Date.now();
        socket.send(
          JSON.stringify({
            type: "subscribe",
            instruments: [instrumentRef.current],
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        let message: unknown;
        lastMessageAtRef.current = Date.now();

        try {
          message = JSON.parse(event.data as string) as typeof message;
        } catch {
          return;
        }

        if (isStatusMessage(message)) {
          setSnapshot((current) => ({
            ...current,
            state: message.state,
            source: message.source,
            message: message.message,
          }));
          return;
        }

        if (isHeartbeatMessage(message)) {
          setSnapshot((current) => ({
            ...current,
            source: message.source ?? current.source,
            lastHeartbeatAt: message.time ?? new Date().toISOString(),
          }));
          return;
        }

        if (isPriceTick(message) && message.instrument === instrumentRef.current) {
          onPriceRef.current?.(message);
          setSnapshot((current) => {
            const nextState =
              message.source === "mock" ? "mock" : "connected";
            const nextMessage =
              message.source === "mock"
                ? "Receiving mock market stream."
                : "Receiving live OANDA market stream.";

            if (
              !trackPriceRef.current &&
              current.state === nextState &&
              current.source === message.source &&
              current.message === nextMessage
            ) {
              return current;
            }

            return {
              ...current,
              state: nextState,
              source: message.source,
              message: nextMessage,
              price: trackPriceRef.current ? message : current.price,
              lastPriceAt: trackPriceRef.current
                ? message.time
                : current.lastPriceAt,
            };
          });
        }
      });

      socket.addEventListener("error", () => {
        setSnapshot((current) => ({
          ...current,
          state: "error",
          message: "Market stream socket error.",
        }));
      });

      socket.addEventListener("close", () => {
        if (closedByUnmountRef.current) {
          return;
        }

        const attempt = reconnectAttemptRef.current + 1;
        reconnectAttemptRef.current = attempt;
        const delay = getReconnectDelay(attempt);

        setSnapshot((current) => ({
          ...current,
          state: "error",
          message: `Market stream disconnected. Reconnecting in ${Math.round(delay / 1000)}s.`,
        }));

        reconnectTimerRef.current = setTimeout(connect, delay);
      });
    }

    connect();

    const staleCheckTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (
        socket?.readyState === WebSocket.OPEN &&
        lastMessageAtRef.current > 0 &&
        Date.now() - lastMessageAtRef.current > STALE_STREAM_AFTER_MS
      ) {
        setSnapshot((current) => ({
          ...current,
          state: "error",
          message: "Market stream is stale. Reconnecting.",
        }));
        socket.close(4000, "stale stream");
      }
    }, 5_000);

    return () => {
      closedByUnmountRef.current = true;
      clearReconnectTimer();
      window.clearInterval(staleCheckTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  return snapshot;
}
