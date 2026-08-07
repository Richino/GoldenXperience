"use client";

import { useEffect, useState } from "react";
import { getWebSocketUrl } from "@/lib/market-stream/socket-url";

export interface LiveQuote {
  bid: number;
  ask: number;
}

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
 */
export function useLiveQuotes() {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let closedByUnmount = false;

    const connect = () => {
      try {
        socket = new WebSocket(getWebSocketUrl());
      } catch {
        return;
      }

      socket.onopen = () => {
        attempt = 0;
      };

      socket.onmessage = (event) => {
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
        if (closedByUnmount) return;
        attempt += 1;
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempt, 4), 10_000));
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closedByUnmount = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return quotes;
}
