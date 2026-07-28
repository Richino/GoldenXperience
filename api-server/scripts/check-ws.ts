import WebSocket from "ws";

const port = Number(process.env.MARKET_STREAM_WS_PORT) || 8787;
const url = process.env.MARKET_STREAM_WS_URL || `ws://localhost:${port}`;
const timeoutMs = Number(process.env.MARKET_STREAM_TEST_TIMEOUT_MS) || 8000;

const ws = new WebSocket(url);
const timeout = setTimeout(() => {
  console.error(`[market-stream:test] Timed out waiting for a price message from ${url}`);
  ws.close();
  process.exit(1);
}, timeoutMs);

ws.on("open", () => {
  console.info(`[market-stream:test] Connected to ${url}`);
  ws.send(JSON.stringify({ type: "subscribe", instruments: ["EUR_USD"] }));
});

ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString()) as { type?: string; instrument?: string; source?: string };
  console.info(`[market-stream:test] ${raw.toString()}`);

  if (message.type === "price" && message.instrument === "EUR_USD") {
    clearTimeout(timeout);
    ws.close();
    console.info(`[market-stream:test] Received EUR_USD ${message.source ?? "unknown"} tick.`);
    process.exit(0);
  }
});

ws.on("error", (error) => {
  clearTimeout(timeout);
  console.error(`[market-stream:test] ${error.message}`);
  process.exit(1);
});


