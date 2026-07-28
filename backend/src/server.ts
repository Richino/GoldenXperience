import { WebSocket, WebSocketServer } from "ws";
import { getMarketStreamConfig } from "./config.js";
import { createMockTick } from "./mock-stream.js";
import { OandaPricingStream } from "./oanda-stream.js";
import {
  STREAM_INSTRUMENTS,
  type MajorInstrument,
  type MarketPriceTick,
  type MarketStreamMessage,
  type MarketStreamStatus,
  type MarketStreamSubscribe,
} from "./types.js";

const config = getMarketStreamConfig();
const latestPrices = new Map<MajorInstrument, MarketPriceTick>();
const subscriptions = new WeakMap<WebSocket, Set<MajorInstrument>>();
const clientAlive = new WeakMap<WebSocket, boolean>();
let currentStatus: MarketStreamStatus = {
  type: "status",
  state: config.isConfigured ? "connecting" : "mock",
  source: config.isConfigured ? "oanda" : "mock",
  environment: config.environment,
  message: config.isConfigured
    ? "Starting OANDA pricing stream."
    : "OANDA credentials missing. Broadcasting mock market ticks.",
  instruments: config.instruments,
  connectedClients: 0,
  checkedAt: new Date().toISOString(),
};
let sequence = 0;

function serialize(message: MarketStreamMessage) {
  return JSON.stringify(message);
}

function send(socket: WebSocket, message: MarketStreamMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(serialize(message));
  }
}

function shouldSend(socket: WebSocket, tick: MarketPriceTick) {
  const subscribed = subscriptions.get(socket);
  return !subscribed || subscribed.has(tick.instrument);
}

function broadcast(message: MarketStreamMessage) {
  const payload = serialize(message);

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    if (message.type === "price" && !shouldSend(client, message)) {
      continue;
    }

    client.send(payload);
  }
}

function setStatus(status: Omit<MarketStreamStatus, "connectedClients">) {
  currentStatus = {
    ...status,
    connectedClients: wss.clients.size,
  };
  console.info(`[market-stream] ${currentStatus.state}: ${currentStatus.message}`);
  broadcast(currentStatus);
}

function parseSubscribeMessage(value: WebSocket.RawData) {
  try {
    const message = JSON.parse(value.toString()) as MarketStreamSubscribe;
    if (message.type !== "subscribe") return null;

    const allowed = new Set<string>(STREAM_INSTRUMENTS);
    const instruments = (message.instruments ?? config.instruments).filter(
      (instrument): instrument is MajorInstrument => allowed.has(instrument),
    );

    return instruments.length ? new Set(instruments) : null;
  } catch {
    return null;
  }
}

const wss = new WebSocketServer({ port: config.port });

wss.on("connection", (socket) => {
  subscriptions.set(socket, new Set(config.instruments));
  clientAlive.set(socket, true);
  currentStatus = { ...currentStatus, connectedClients: wss.clients.size };

  console.info(`[market-stream] Client connected (${wss.clients.size})`);
  send(socket, currentStatus);

  for (const tick of latestPrices.values()) {
    if (shouldSend(socket, tick)) {
      send(socket, tick);
    }
  }

  socket.on("message", (value) => {
    const instruments = parseSubscribeMessage(value);
    if (instruments) {
      subscriptions.set(socket, instruments);
      for (const tick of latestPrices.values()) {
        if (instruments.has(tick.instrument)) {
          send(socket, tick);
        }
      }
    }
  });

  socket.on("pong", () => {
    clientAlive.set(socket, true);
  });

  socket.on("close", () => {
    currentStatus = { ...currentStatus, connectedClients: wss.clients.size };
    console.info(`[market-stream] Client disconnected (${wss.clients.size})`);
  });
});

const clientHealthTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (clientAlive.get(client) === false) {
      console.warn("[market-stream] Terminating an unresponsive client.");
      client.terminate();
      continue;
    }

    clientAlive.set(client, false);
    client.ping();
  }
}, 30_000);

function handlePrice(tick: MarketPriceTick) {
  latestPrices.set(tick.instrument, tick);
  broadcast(tick);
}

function startMockStream() {
  setStatus({
    ...currentStatus,
    state: "mock",
    source: "mock",
    message: "Mock market stream is running because OANDA credentials are missing.",
    checkedAt: new Date().toISOString(),
  });

  return setInterval(() => {
    for (const instrument of config.instruments) {
      handlePrice(createMockTick(instrument, ++sequence));
    }
  }, 1000);
}

const mockTimer = config.isConfigured ? null : startMockStream();
const oandaStream = config.isConfigured
  ? new OandaPricingStream(config, {
      onPrice: handlePrice,
      onHeartbeat: (heartbeat) => broadcast(heartbeat),
      onStatus: setStatus,
    })
  : null;

oandaStream?.start();

console.info(
  `[market-stream] WebSocket server listening on ws://localhost:${config.port}`,
);

function shutdown() {
  console.info("[market-stream] Shutting down.");
  if (mockTimer) clearInterval(mockTimer);
  clearInterval(clientHealthTimer);
  oandaStream?.stop();
  wss.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
