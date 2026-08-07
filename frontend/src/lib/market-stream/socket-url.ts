function isLoopbackHost(value: string) {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(value);
}

/**
 * Resolves the market-stream socket endpoint. Shared by every consumer so the
 * loopback handling below is stated once.
 */
export function getWebSocketUrl() {
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
