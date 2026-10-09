"use client";

import { useEffect, useRef, useState } from "react";
import type { MajorInstrument, PriceQuote } from "@/types/forex";
import { apiUrl } from "@/lib/api/url";
import { getWebSocketUrl } from "@/lib/market-stream/socket-url";
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
/**
 * The tick stream carries a fixed list of pairs (the server's
 * STREAM_INSTRUMENTS); a chart on any other catalog pair, or a streamed pair
 * that has gone quiet this long, is kept moving from the REST quote instead.
 */
const REST_FALLBACK_QUIET_MS = 10_000;
const REST_POLL_MS = 2_000;

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
  /** Pairs the server streams (from its status message); null until known. */
  const streamedRef = useRef<Set<string> | null>(null);
  /** When the current pair last received a price, from either source. */
  const lastTickAtRef = useRef(0);
  const lastTickTimeRef = useRef<string | null>(null);
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
    lastTickAtRef.current = 0;
    lastTickTimeRef.current = null;

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

    /** One path for a price, whether it came from the stream or REST. */
    function deliver(message: MarketPriceTick) {
      if (message.instrument !== instrumentRef.current) return;
      lastTickAtRef.current = Date.now();
      lastTickTimeRef.current = message.time;
      onPriceRef.current?.(message);
      setSnapshot((current) => {
        const nextState = message.source === "mock" ? "mock" : "connected";
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
          lastPriceAt: trackPriceRef.current ? message.time : current.lastPriceAt,
        };
      });
    }

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
          if (Array.isArray(message.instruments)) streamedRef.current = new Set(message.instruments);
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

        if (isPriceTick(message)) deliver(message);
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

    // Backgrounding the app freezes the socket, and the stale check above is
    // itself throttled while hidden — so on reopen the stream can sit dead for
    // seconds before a tick notices. Force it back to a good connection the
    // moment the app returns to the foreground.
    function onForeground() {
      if (document.visibilityState !== "visible") return;
      const socket = socketRef.current;
      const stale =
        lastMessageAtRef.current > 0 &&
        Date.now() - lastMessageAtRef.current > STALE_STREAM_AFTER_MS;

      if (!socket || socket.readyState === WebSocket.CLOSED) {
        // A reconnect may be scheduled far out by the backoff; pull it forward.
        reconnectAttemptRef.current = 0;
        connect();
      } else if (socket.readyState === WebSocket.OPEN && stale) {
        socket.close(4000, "stale stream");
      }
    }

    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);

    // REST fallback: pairs the stream does not carry (any catalog pair beyond
    // STREAM_INSTRUMENTS), or a streamed pair that has gone quiet, are polled
    // so the chart keeps moving without a refresh. Live ticks win again as
    // soon as they arrive, since they reset the quiet clock.
    let polling = false;
    const restTimer = window.setInterval(async () => {
      if (polling || document.visibilityState !== "visible") return;
      const current = instrumentRef.current;
      const streamed = streamedRef.current;
      const notStreamed = streamed !== null && !streamed.has(current);
      const quiet = Date.now() - lastTickAtRef.current > REST_FALLBACK_QUIET_MS;
      if (!notStreamed && !quiet) return;
      polling = true;
      try {
        const response = await fetch(apiUrl(`/api/oanda/pricing?instruments=${current}`), { credentials: "include", cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { data?: PriceQuote[] };
        const quote = payload.data?.find((item) => item.instrument === current);
        if (!quote || quote.source !== "oanda" || !(quote.bid > 0) || !(quote.ask >= quote.bid)) return;
        // Only newer prices; never step the chart back to an older quote.
        if (lastTickTimeRef.current && Date.parse(quote.time) <= Date.parse(lastTickTimeRef.current)) return;
        if (instrumentRef.current !== current) return;
        deliver({
          type: "price",
          instrument: quote.instrument,
          displayName: quote.displayName,
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          spread: quote.ask - quote.bid,
          status: quote.status,
          time: quote.time,
          source: "oanda",
          sequence: 0,
        });
      } catch {
        // Next poll retries.
      } finally {
        polling = false;
      }
    }, REST_POLL_MS);

    return () => {
      closedByUnmountRef.current = true;
      clearReconnectTimer();
      window.clearInterval(staleCheckTimer);
      window.clearInterval(restTimer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  return snapshot;
}
