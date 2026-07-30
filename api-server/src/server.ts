import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { WebSocket, WebSocketServer } from "ws";

import { OandaPricingStream } from "./oanda-stream.js";
import { createMockTick, getDefaultMockInstruments } from "./mock-stream.js";
import type {
  MajorInstrument,
  MarketPriceTick,
  MarketStreamMessage,
  MarketStreamStatus,
} from "./market-stream-types.js";
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
import { databaseConfigured, query } from "./database.js";
import { cookieName, login, logout, sessionUser } from "./auth.js";
import { collectForwardEvaluation } from "./research.js";

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
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function cors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Credentials", "true");
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

function cookies(request: IncomingMessage) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => item.trim().split(/=(.*)/s)).filter(([key]) => key));
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { return null; }
}

function sessionCookie(token: string, expires: Date) {
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; ${domain ? `Domain=${domain}; ` : ""}${process.env.NODE_ENV === "production" ? "Secure; " : ""}Expires=${expires.toUTCString()}`;
}

async function requireOwner(request: IncomingMessage, response: ServerResponse) {
  if (!databaseConfigured()) { json(request, response, { error: "Database is not configured." }, 503); return null; }
  const user = await sessionUser(cookies(request)[cookieName]);
  if (!user) { json(request, response, { error: "Authentication required." }, 401); return null; }
  return user;
}

async function handleApi(request: IncomingMessage, response: ServerResponse) {
  if (!request.url) return json(request, response, { error: "Missing request URL." }, 400);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    cors(request, response);
    response.writeHead(204);
    return response.end();
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    if (!databaseConfigured()) return json(request, response, { error: "Database is not configured." }, 503);
    const ip = request.socket.remoteAddress || "unknown"; const attempt = loginAttempts.get(ip); const now = Date.now();
    if (attempt && attempt.resetAt > now && attempt.count >= 5) return json(request, response, { error: "Too many login attempts. Try again later." }, 429);
    const payload = await body(request);
    if (typeof payload?.email !== "string" || typeof payload.password !== "string") return json(request, response, { error: "Email and password are required." }, 400);
    const result = await login(payload.email, payload.password);
    if (!result) { loginAttempts.set(ip, { count: attempt && attempt.resetAt > now ? attempt.count + 1 : 1, resetAt: now + 15 * 60_000 }); return json(request, response, { error: "Invalid email or password." }, 401); }
    loginAttempts.delete(ip);
    response.setHeader("Set-Cookie", sessionCookie(result.token, result.expiresAt));
    return json(request, response, { user: { id: result.userId, email: payload.email.trim().toLowerCase() } });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (databaseConfigured()) await logout(cookies(request)[cookieName]);
    response.setHeader("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return json(request, response, { ok: true });
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const user = await requireOwner(request, response); if (!user) return;
    return json(request, response, { user });
  }
  if (url.pathname.startsWith("/api/")) {
    const user = await requireOwner(request, response); if (!user) return;
    if (url.pathname === "/api/journal/trades" && request.method === "GET") {
      const trades = await query("SELECT id, origin, pair, direction, status, result, opened_at AS \"openedAt\", closed_at AS \"closedAt\", entry::float, stop::float, target::float, exit::float, result_r::float AS \"resultR\", reason, notes FROM paper_trades WHERE user_id=$1 ORDER BY opened_at DESC", [user.id]);
      return json(request, response, { trades: trades.rows });
    }
    if (url.pathname === "/api/journal/import" && request.method === "POST") {
      const payload = await body(request); const trades = Array.isArray(payload?.trades) ? payload.trades : [];
      for (const trade of trades) {
        if (!trade || typeof trade !== "object") continue;
        const value = trade as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.pair !== "string" || !["long", "short"].includes(String(value.direction))) continue;
        await query("INSERT INTO paper_trades (user_id,legacy_id,origin,pair,direction,status,result,opened_at,closed_at,entry,stop,target,exit,result_r,reason,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(user_id,legacy_id) DO NOTHING", [user.id, value.id, value.origin === "demo" ? "demo" : "manual", value.pair, value.direction, value.status === "closed" ? "closed" : "open", value.result || "open", value.openedAt || new Date().toISOString(), value.closedAt || null, value.entry, value.stop, value.target, value.exit || null, value.resultR ?? null, String(value.reason || ""), String(value.notes || "")]);
      }
      return json(request, response, { ok: true });
    }
    if (url.pathname === "/api/journal/trades" && request.method === "POST") {
      const value = await body(request);
      if (!value || typeof value.pair !== "string" || !["long", "short"].includes(String(value.direction))) return json(request, response, { error: "Invalid trade." }, 400);
      const fields = [value.origin === "demo" ? "demo" : "manual", value.pair, value.direction, value.status === "closed" ? "closed" : "open", value.result || "open", value.openedAt || new Date().toISOString(), value.closedAt || null, value.entry, value.stop, value.target, value.exit || null, value.resultR ?? null, String(value.reason || ""), String(value.notes || "")];
      const created = await query("INSERT INTO paper_trades (user_id,origin,pair,direction,status,result,opened_at,closed_at,entry,stop,target,exit,result_r,reason,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id", [user.id, ...fields]);
      return json(request, response, { id: created.rows[0]?.id }, 201);
    }
    if (url.pathname === "/api/research/summary" && request.method === "GET") {
      const summary = await query("SELECT count(*)::int AS evaluations, count(*) FILTER (WHERE status='valid')::int AS valid_evaluations, count(*) FILTER (WHERE status<>'valid')::int AS blocked_evaluations, count(ol.*) FILTER (WHERE ol.outcome='target_first')::int AS target_first, count(ol.*) FILTER (WHERE ol.outcome='stop_first')::int AS stop_first, count(ol.*) FILTER (WHERE ol.outcome='unresolved')::int AS unresolved, avg(ol.result_r)::float AS average_r FROM strategy_evaluations se LEFT JOIN trade_candidates tc ON tc.evaluation_id=se.id LEFT JOIN outcome_labels ol ON ol.candidate_id=tc.id");
      return json(request, response, { summary: summary.rows[0] });
    }
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

if (databaseConfigured()) {
  const collect = () => void collectForwardEvaluation().catch((error) => console.error("[research] collection failed", error));
  collect();
  setInterval(collect, 60_000);
}

function shutdown() {
  clearInterval(heartbeat);
  wss.clients.forEach((socket) => socket.close(1001, "Server shutting down"));
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
