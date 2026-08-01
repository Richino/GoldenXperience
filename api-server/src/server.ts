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
import { MAJOR_INSTRUMENTS } from "../../frontend/src/types/forex.js";
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
import { decideResearchExperiment, forwardResearchSummary, latestDayTradingValidation, latestResearchExperiment, latestResearchHoldout, latestResearchRun, latestWalkForwardResearch, processNextResearchJob, researchDiagnostics, researchExperimentDiagnostics, researchSummary, runDayTradingValidation, runResearchExperiment, runWalkForwardResearch, startLockedResearchHoldout, startStrictHistoricalBackfill, stopResearchRun } from "./research.js";
import { collectPaperCycle, decidePaperBatch, paperCycleOverview, paperRiskExposure, paperRiskPolicy, parsePaperRiskConfiguration, reviewPaperTrade, updatePaperRiskPolicy, watchlistSnapshot } from "./paper-cycle.js";
import { markNotificationsRead, notificationsForUser, pushPublicKey, queueNotification, removePushSubscription, savePushSubscription } from "./notifications.js";
import { practiceExecutionOverview, setPracticeExecutionEnabled } from "./practice-execution.js";

const STREAM_INSTRUMENTS: MajorInstrument[] = [...MAJOR_INSTRUMENTS];

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
function normalizeOrigin(value: string) {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGIN || "http://localhost:3000")
    .split(",")
    .map(normalizeOrigin)
    .filter((origin): origin is string => Boolean(origin)),
);

const subscriptions = new WeakMap<WebSocket, Set<MajorInstrument>>();
const clientAlive = new WeakMap<WebSocket, boolean>();
const latestPrices = new Map<MajorInstrument, MarketPriceTick>();
let currentStatus: MarketStreamStatus;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function cors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin ? normalizeOrigin(request.headers.origin) : null;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
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
    if (url.pathname === "/api/watchlist" && request.method === "GET") {
      return json(request, response, { watchlist: await watchlistSnapshot() });
    }
    if (url.pathname === "/api/notifications" && request.method === "GET") {
      return json(request, response, await notificationsForUser(user.id, url.searchParams.get("after")));
    }
    if (url.pathname === "/api/notifications/read" && request.method === "PATCH") {
      const payload = await body(request);
      const ids = Array.isArray(payload?.ids) ? payload.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50) : undefined;
      await markNotificationsRead(user.id, ids);
      return json(request, response, { ok: true });
    }
    if (url.pathname === "/api/push/vapid-key" && request.method === "GET") {
      const publicKey = pushPublicKey();
      return publicKey ? json(request, response, { publicKey }) : json(request, response, { error: "Push notifications are not configured on the server." }, 503);
    }
    if (url.pathname === "/api/push/subscribe" && request.method === "POST") {
      const payload = await body(request);
      const subscription = payload?.subscription;
      if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) return json(request, response, { error: "A push subscription is required." }, 400);
      const value = subscription as Record<string, unknown>;
      const keys = value.keys as Record<string, unknown> | undefined;
      if (typeof value.endpoint !== "string" || !keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return json(request, response, { error: "The push subscription is invalid." }, 400);
      await savePushSubscription(user.id, { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
      return json(request, response, { ok: true });
    }
    if (url.pathname === "/api/push/subscribe" && request.method === "DELETE") {
      const payload = await body(request);
      if (typeof payload?.endpoint !== "string") return json(request, response, { error: "The subscription endpoint is required." }, 400);
      await removePushSubscription(user.id, payload.endpoint);
      return json(request, response, { ok: true });
    }
    if (url.pathname === "/api/practice-execution" && request.method === "GET") {
      return json(request, response, await practiceExecutionOverview(user.id));
    }
    if (url.pathname === "/api/practice-execution" && request.method === "PATCH") {
      const payload = await body(request);
      if (typeof payload?.enabled !== "boolean") return json(request, response, { error: "Choose whether practice auto-trading is enabled." }, 400);
      return json(request, response, { policy: await setPracticeExecutionEnabled(user.id, payload.enabled) });
    }
    if (url.pathname === "/api/strategy/setup" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      if (!instrument || !MAJOR_INSTRUMENTS.includes(instrument as (typeof MAJOR_INSTRUMENTS)[number])) return json(request, response, { error: "Choose a monitored currency pair." }, 400);
      const snapshot = await getStrategySnapshot();
      const setup = snapshot.strategy.setups.find((item) => item.instrument === instrument);
      return setup ? json(request, response, { setup }) : json(request, response, { error: "Strategy setup unavailable." }, 503);
    }
    if (url.pathname === "/api/paper-cycle" && request.method === "GET") {
      return json(request, response, await paperCycleOverview());
    }
    if (url.pathname === "/api/paper-risk" && request.method === "GET") {
      return json(request, response, { exposure: await paperRiskExposure(user.id), policy: await paperRiskPolicy(user.id) });
    }
    if (url.pathname === "/api/paper-risk/settings" && request.method === "PATCH") {
      const payload = await body(request);
      try {
        const configuration = parsePaperRiskConfiguration(payload?.configuration);
        if (typeof payload?.collectionPaused !== "boolean") return json(request, response, { error: "Choose whether new paper entries are paused." }, 400);
        return json(request, response, { policy: await updatePaperRiskPolicy(user.id, configuration, payload.collectionPaused) });
      } catch (error) {
        return json(request, response, { error: error instanceof Error ? error.message : "Risk settings are invalid." }, 400);
      }
    }
    if (url.pathname === "/api/paper-cycle/trades/review" && request.method === "PATCH") {
      const payload = await body(request);
      if (typeof payload?.tradeId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.tradeId)) return json(request, response, { error: "Choose a valid paper trade." }, 400);
      const review = payload.review && typeof payload.review === "object" && !Array.isArray(payload.review) ? payload.review as Record<string, unknown> : {};
      const saved = await reviewPaperTrade(user.id, payload.tradeId, review);
      return saved ? json(request, response, { trade: saved }) : json(request, response, { error: "Paper trade not found." }, 404);
    }
    if (url.pathname === "/api/paper-cycle/batches/decision" && request.method === "POST") {
      const payload = await body(request);
      if (typeof payload?.batchId !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.batchId) || !["approved", "rejected"].includes(String(payload.decision))) return json(request, response, { error: "Choose a completed batch and a valid decision." }, 400);
      const saved = await decidePaperBatch(payload.batchId, payload.decision as "approved" | "rejected", typeof payload.note === "string" ? payload.note.trim() : "");
      return saved ? json(request, response, { batch: saved }) : json(request, response, { error: "The batch recommendation is unavailable or already decided." }, 409);
    }
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
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      return json(request, response, { summary: await researchSummary(instrument) });
    }
    if (url.pathname === "/api/research/forward" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      if (!instrument) return json(request, response, { error: "Choose a currency pair." }, 400);
      return json(request, response, { summary: await forwardResearchSummary(instrument) });
    }
    if (url.pathname === "/api/research/diagnostics" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      return json(request, response, { diagnostics: await researchDiagnostics(instrument) });
    }
    if (url.pathname === "/api/research/experiments" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      return json(request, response, { experiment: await latestResearchExperiment(user.id, instrument) });
    }
    if (url.pathname === "/api/research/experiments/diagnostics" && request.method === "GET") {
      const experimentId = url.searchParams.get("experimentId");
      if (!experimentId || !/^[0-9a-f-]{36}$/i.test(experimentId)) return json(request, response, { error: "Choose a valid research experiment." }, 400);
      const diagnostics = await researchExperimentDiagnostics(user.id, experimentId);
      return diagnostics ? json(request, response, { diagnostics }) : json(request, response, { error: "Research experiment not found." }, 404);
    }
    if (url.pathname === "/api/research/experiments" && request.method === "POST") {
      return json(request, response, { error: "Retired strategy experiments are read-only. Run the active day-trading validation instead." }, 410);
    }
    if (url.pathname === "/api/research/experiments/decision" && request.method === "POST") {
      return json(request, response, { error: "Retired strategy experiments are immutable historical evidence." }, 410);
    }
    if (url.pathname === "/api/research/holdouts" && request.method === "GET") {
      const experimentId = url.searchParams.get("experimentId");
      if (!experimentId || !/^[0-9a-f-]{36}$/i.test(experimentId)) return json(request, response, { error: "Choose a valid research experiment." }, 400);
      return json(request, response, await latestResearchHoldout(user.id, experimentId));
    }
    if (url.pathname === "/api/research/holdouts" && request.method === "POST") {
      return json(request, response, { error: "Retired strategy holdouts are immutable historical evidence." }, 410);
    }
    if (url.pathname === "/api/research/walk-forward" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      if (!instrument || !isKnownInstrument(instrument)) return json(request, response, { error: "Choose a supported OANDA currency pair." }, 400);
      return json(request, response, { run: await latestWalkForwardResearch(user.id, instrument) });
    }
    if (url.pathname === "/api/research/walk-forward" && request.method === "POST") {
      return json(request, response, { error: "The retired walk-forward filter search is inactive. Run the fixed day-trading validation instead." }, 410);
    }
    if (url.pathname === "/api/research/day-validation" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      if (!instrument || !isKnownInstrument(instrument)) return json(request, response, { error: "Choose a supported OANDA currency pair." }, 400);
      return json(request, response, { run: await latestDayTradingValidation(user.id, instrument) });
    }
    if (url.pathname === "/api/research/day-validation" && request.method === "POST") {
      const payload = await body(request);
      if (typeof payload?.instrument !== "string") return json(request, response, { error: "Choose a currency pair." }, 400);
      try {
        return json(request, response, { run: await runDayTradingValidation(user.id, payload.instrument) }, 201);
      } catch (error) {
        return json(request, response, { error: error instanceof Error ? error.message : "Could not run day-trading validation." }, 400);
      }
    }
    if (url.pathname === "/api/research/runs" && request.method === "GET") {
      const instrument = url.searchParams.get("instrument")?.toUpperCase();
      return json(request, response, { run: await latestResearchRun(instrument) });
    }
    if (url.pathname === "/api/research/runs" && request.method === "POST") {
      const payload = await body(request);
      if (typeof payload?.instrument !== "string") return json(request, response, { error: "Choose a currency pair." }, 400);
      const months = typeof payload.months === "number" ? payload.months : 12;
      const run = await startStrictHistoricalBackfill(payload.instrument.toUpperCase(), months);
      return json(request, response, { run }, 202);
    }
    if (url.pathname === "/api/research/runs/stop" && request.method === "POST") {
      const payload = await body(request);
      if (typeof payload?.instrument !== "string") return json(request, response, { error: "Choose a currency pair." }, 400);
      const run = await stopResearchRun(payload.instrument.toUpperCase());
      return json(request, response, { run }, run ? 200 : 404);
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

let researchWorker: NodeJS.Timeout | null = null;
let paperCollector: NodeJS.Timeout | null = null;
if (databaseConfigured()) {
  let collectionBusy = false;
  const collect = async () => {
    if (collectionBusy) return;
    collectionBusy = true;
    try {
      const result = await collectPaperCycle();
      if (result.reason) console.warn(`[paper-cycle] collection skipped: ${result.reason}`);
      else if (result.opened || result.resolved) console.log(`[paper-cycle] opened ${result.opened}, resolved ${result.resolved}`);
    } catch (error) {
      console.error("[paper-cycle] collection failed", error);
      const owner = await query<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1");
      if (owner.rows[0]) {
        await queueNotification({
          userId: owner.rows[0].id,
          kind: "system_issue",
          title: "Paper collector needs attention",
          message: error instanceof Error ? error.message.slice(0, 180) : "The collector stopped before completing its latest check.",
          instrument: null,
          paperTradeId: null,
          dedupeKey: `paper_collector_failure:${new Date().toISOString().slice(0, 10)}`,
        }).catch(() => undefined);
      }
    } finally {
      collectionBusy = false;
    }
  };
  void collect();
  paperCollector = setInterval(() => void collect(), 60_000);
  let workerBusy = false;
  const work = async () => {
    if (workerBusy) return;
    workerBusy = true;
    try { await processNextResearchJob(); }
    catch (error) { console.error("[research] durable worker failed", error); }
    finally { workerBusy = false; }
  };
  void work();
  researchWorker = setInterval(() => void work(), 1_000);
}

function shutdown() {
  clearInterval(heartbeat);
  if (researchWorker) clearInterval(researchWorker);
  if (paperCollector) clearInterval(paperCollector);
  wss.clients.forEach((socket) => socket.close(1001, "Server shutting down"));
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
