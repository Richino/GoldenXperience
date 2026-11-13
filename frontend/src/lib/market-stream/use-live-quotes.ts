"use client";

import { useEffect, useState } from "react";
import { getWebSocketUrl } from "@/lib/market-stream/socket-url";

export interface LiveQuote {
  bid: number;
  ask: number;
}

const STALE_STREAM_AFTER_MS = 15_000;
/** One price per pair per second is plenty for valuing open trades. */
const QUOTE_THROTTLE_MS = 1_000;
/** A tab hidden this long drops its socket; it reconnects on return. */
export const HIDDEN_DISCONNECT_MS = 30_000;

/**
 * Live bid/ask for every streamed pair, keyed by OANDA code.
 *
 * `useMarketStream` follows one chart and carries connection state for it, so
 * it cannot answer "what is every open trade worth right now". A new socket
 * subscribes to all instruments by default and is replayed the latest price
 * per pair on connect, which means a view is populated immediately rather than
 * waiting for the next tick.
 *
 * There is no polling fallback on purpose: the views using this render a value
 * only when a quote exists, so a dropped socket shows the last known figure
 * until it reconnects rather than a wrong one.
 *
 * Backgrounding freezes the socket on iOS/Android PWAs; on return we reconnect
 * if the socket is dead or has gone quiet, matching `useMarketStream`.
 */
export function useLiveQuotes() {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closedByUnmount = false;
    let lastMessageAt = 0;
    // Hidden tabs would otherwise receive every tick all day — the largest
    // share of the API's network egress. A paused socket waits for visibility.
    let paused = false;
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const connect = () => {
      clearReconnectTimer();
      try {
        socket = new WebSocket(getWebSocketUrl());
      } catch {
        return;
      }

      const opened = socket;
      opened.onopen = () => {
        attempt = 0;
        opened.send(JSON.stringify({ type: "throttle", ms: QUOTE_THROTTLE_MS }));
      };

      socket.onmessage = (event) => {
        lastMessageAt = Date.now();
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            instrument?: string;
            bid?: number;
            ask?: number;
          };
          if (
            message.type !== "price" ||
            typeof message.instrument !== "string" ||
            typeof message.bid !== "number" ||
            typeof message.ask !== "number"
          ) {
            return;
          }
          const { instrument, bid, ask } = message;
          setQuotes((current) => {
            const previous = current[instrument];
            if (previous && previous.bid === bid && previous.ask === ask) return current;
            return { ...current, [instrument]: { bid, ask } };
          });
        } catch {
          // A malformed frame is not worth tearing the socket down for.
        }
      };

      socket.onclose = () => {
        if (closedByUnmount || paused) return;
        attempt += 1;
        reconnectTimer = setTimeout(
          connect,
          Math.min(1000 * 2 ** Math.min(attempt, 4), 10_000),
        );
      };

      socket.onerror = () => socket?.close();
    };

    const onForeground = () => {
      if (document.visibilityState !== "visible") {
        if (!hiddenTimer && !paused) {
          hiddenTimer = setTimeout(() => {
            hiddenTimer = null;
            if (document.visibilityState === "visible") return;
            paused = true;
            clearReconnectTimer();
            socket?.close(4001, "hidden");
          }, HIDDEN_DISCONNECT_MS);
        }
        return;
      }
      if (hiddenTimer) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
      paused = false;
      const stale =
        lastMessageAt > 0 && Date.now() - lastMessageAt > STALE_STREAM_AFTER_MS;

      if (!socket || socket.readyState === WebSocket.CLOSED) {
        attempt = 0;
        connect();
      } else if (socket.readyState === WebSocket.OPEN && stale) {
        socket.close(4000, "stale stream");
      }
    };

    connect();

    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);

    return () => {
      closedByUnmount = true;
      clearReconnectTimer();
      if (hiddenTimer) clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
      socket?.close();
    };
  }, []);

  return quotes;
}
