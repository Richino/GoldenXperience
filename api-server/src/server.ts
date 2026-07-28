import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { WebSocket, WebSocketServer } from "ws";

import { OandaPricingStream } from "../../backend/src/oanda-stream.js";
import { createMockTick, getDefaultMockInstruments } from "../../backend/src/mock-stream.js";
import type {
  MajorInstrument,
  MarketPriceTick,
  MarketStreamMessage,
  MarketStreamStatus,
} from "../../backend/src/types.js";
import { getEconomicCalendar } from "../../frontend/src/lib/calendar/forex-factory.js";
import { isKnownInstrument } from "../../frontend/src/lib/instruments/catalog.js";
import {
  getAccountSummary,
  getCandles,
  getOpenPositions,
  getPricing,
  testOandaConnection,
} from "../../frontend/src/lib/oanda/client.js";
import { getStrategySnapshot } from "../../frontend/src/lib/strategy/strategy-service.js";

const STREAM_INSTRUMENTS: MajorInstrument[] = ["EUR_USD", "GBP_USD", "USD_JPY"];

for (const file of [".env", ".env.local"]) {
  const envPath = path.join(process.cwd(), file);
  if (fs.existsSync(envPath)) loadDotenv({ path: envPath, override: false });
}

const environment: "practice" | "live" = process.env.OANDA_ENVIRONMENT === "live" ? "live" : "practice";
const accountId = process.env.OANDA_ACCOUNT_ID?.trim() || null;
const apiKey = process.env.OANDA_API_KEY?.trim() || process.env.OANDA_API_TOKEN?.trim() || null;
const configuredInstruments = (process.env.MARKET_STREAM_INSTRUMENTS || "")
  .split(",")
  .map((instrument) => instrument.trim())
  .filter((instrument): instrument is MajorInstrument => STREAM_INSTRUMENTS.includes(instrument as MajorInstrument));
const config = {
  accountId,
  apiKey,
  environment,
  streamBaseUrl: environment === "practice" ? "https://stream-fxpractice.oanda.com" : "https://stream-fxtrade.oanda.com",
  port: Number(process.env.MARKET_STREAM_WS_PORT) || 8787,
  instruments: configuredInstruments.length ? configuredInstruments : STREAM_INSTRUMENTS,
  isConfigured: Boolean(accountId && apiKey),
};
const PORT = Number(process.env.PORT) || config.port;
const GRANULARITIES = new Set(["M1", "M5", "M15", "M30", "H1", "H4", "D"]);
const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const subscriptions = new WeakMap<WebSocket, Set<MajorInstrument>>();
const clientAlive = new WeakMap<WebSocket, boolean>();
const latestPrices = new Map<MajorInstrument, MarketPriceTick>();
let currentStatus: MarketStreamStatus;

function cors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(request: IncomingMessage, response: ServerResponse, body: unknown, status = 200) {
  cors(request, response);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function parseInstruments(value: string | null): MajorInstrument[] {
  if (!value) return [...config.instruments];
  const instruments = value
    .split(",")
    .map((instrument) => instrument.trim().toUpperCase())
    .filter(isKnownInstrument);
  return instruments.length ? [...new Set(instruments)] as MajorInstrument[] : [...config.instruments];
}

async function handleApi(request: IncomingMessage, response: ServerResponse) {
  if (!request.url) return json(request, response, { error: "Missing request URL." }, 400);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    cors(request, response);
    response.writeHead(204);
    return response.end();
  }
  if (request.method !== "GET") return json(request, response, { error: "Method not allowed." }, 405);

  switch (url.pathname) {
    case "/health":
      return json(request, response, { ok: true, service: "goldenxperience-api", checkedAt: new Date().toISOString() });
    case "/api/oanda/account-summary":
      return json(request, response, await getAccountSummary());
    case "/api/oanda/open-positions":
      return json(request, response, await getOpenPositions());
    case "/api/oanda/calendar":
      return json(request, response, await getEconomicCalendar());
    case "/api/oanda/status": {
      const status = await testOandaConnection();
      return json(request, response, { ok: status.state === "connected", status }, status.state === "error" ? 502 : 200);
    }
    case "/api/oanda/test": {
      const status = await testOandaConnection();
      return json(request, response, {
        ok: status.state === "connected",
        mode: status.source === "mock" ? "fallback" : "live",
        message: status.message,
        status,
      }, status.state === "error" ? 502 : 200);
    }
    case "/api/oanda/pricing":
      return json(request, response, await getPricing(parseInstruments(url.searchParams.get("instruments"))));
    case "/api/oanda/candles": {
      const instrument = (url.searchParams.get("instrument") || "EUR_USD").toUpperCase();
      if (!isKnownInstrument(instrument)) return json(request, response, { error: `Unknown instrument "${instrument}".` }, 400);
      const requestedGranularity = (url.searchParams.get("granularity") || "M15").toUpperCase();
      const granularity = GRANULARITIES.has(requestedGranularity) ? requestedGranularity : "M15";
      const requestedCount = Number(url.searchParams.get("count") || 64);
      const count = Number.isFinite(requestedCount) ? Math.min(5_000, Math.max(10, Math.floor(requestedCount))) : 64;
      return json(request, response, await getCandles(instrument, granularity, count, { to: url.searchParams.get("to") || undefined }));
    }
    case "/api/strategy":
      return json(request, response, await getStrategySnapshot());
    default:
      return json(request, response, { error: "Not found." }, 404);
  }
}

function serialize(message: MarketStreamMessage) {
  return JSON.stringify(message);
}

function send(socket: WebSocket, message: MarketStreamMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(serialize(message));
}

function shouldSend(socket: WebSocket, tick: MarketPriceTick) {
  const requested = subscriptions.get(socket);
  return !requested || requested.size === 0 || requested.has(tick.instrument);
}

function broadcast(message: MarketStreamMessage) {
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN && (message.type !== "price" || shouldSend(socket, message))) send(socket, message);
  }
}

function setStatus(state: MarketStreamStatus["state"], source: MarketStreamStatus["source"], message: string) {
  currentStatus = {
    type: "status", state, source, environment: config.environment, message,
    instruments: config.instruments, connectedClients: wss.clients.size, checkedAt: new Date().toISOString(),
  };
  broadcast(currentStatus);
}

function parseSubscribeMessage(value: WebSocket.RawData): MajorInstrument[] | null {
  try {
    const parsed = JSON.parse(value.toString()) as { type?: string; instruments?: unknown };
    if (parsed.type !== "subscribe" || !Array.isArray(parsed.instruments)) return null;
    const instruments = parsed.instruments.filter((item): item is MajorInstrument => typeof item === "string" && config.instruments.includes(item as MajorInstrument));
    return instruments.length ? instruments : null;
  } catch { return null; }
}

const server = createServer((request, response) => {
  void handleApi(request, response).catch((error: unknown) => {
    console.error("[api] Unhandled request error", error);
    json(request, response, { error: "Internal server error." }, 500);
  });
});
const wss = new WebSocketServer({ noServer: true });

currentStatus = {
  type: "status", state: config.isConfigured ? "connecting" : "mock", source: config.isConfigured ? "oanda" : "mock",
  environment: config.environment, message: config.isConfigured ? "Starting OANDA pricing stream." : "OANDA credentials missing. Broadcasting mock market ticks.",
  instruments: config.instruments, connectedClients: 0, checkedAt: new Date().toISOString(),
};

server.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return socket.destroy();
  wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
});

wss.on("connection", (socket) => {
  clientAlive.set(socket, true);
  subscriptions.set(socket, new Set(config.instruments));
  send(socket, currentStatus);
  for (const price of latestPrices.values()) send(socket, price);
  socket.on("pong", () => clientAlive.set(socket, true));
  socket.on("message", (value) => {
    const requested = parseSubscribeMessage(value);
    if (requested) subscriptions.set(socket, new Set(requested));
  });
  socket.on("close", () => { subscriptions.delete(socket); });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!clientAlive.get(socket)) { socket.terminate(); continue; }
    clientAlive.set(socket, false);
    socket.ping();
  }
  broadcast({ type: "heartbeat", source: currentStatus.source, time: new Date().toISOString() });
}, 10_000);

function handlePrice(tick: MarketPriceTick) { latestPrices.set(tick.instrument, tick); broadcast(tick); }

if (config.isConfigured) {
  const stream = new OandaPricingStream(config, {
    onStatus: (status) => setStatus(status.state, status.source, status.message),
    onPrice: handlePrice,
    onHeartbeat: (heartbeat) => broadcast(heartbeat),
  });
  void stream.start();
} else {
  const instruments = getDefaultMockInstruments();
  let mockSequence = 0;
  setInterval(() => instruments.forEach((instrument) => handlePrice(createMockTick(instrument, ++mockSequence))), 1_000);
}

server.listen(PORT, () => console.log(`[api] HTTP and WebSocket server listening on :${PORT}`));

function shutdown() {
  clearInterval(heartbeat);
  wss.clients.forEach((socket) => socket.close(1001, "Server shutting down"));
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
