/**
 * Resolves where the GX backend lives. The mobile client talks ONLY to the
 * existing GX API server (never to OANDA directly), so both the HTTP base and
 * the market-stream WebSocket derive from one configured origin.
 *
 * Set `EXPO_PUBLIC_GX_API_URL` in `.env` to the API server's origin. On a
 * physical device `localhost` resolves to the phone, so it must be the dev
 * machine's LAN address (e.g. http://10.0.0.111:8787). Only EXPO_PUBLIC_*
 * values are readable here — no server secret is ever bundled into the client.
 */

const DEFAULT_API_URL = "http://localhost:8787";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export const API_BASE_URL = trimTrailingSlash(
  process.env.EXPO_PUBLIC_GX_API_URL?.trim() || DEFAULT_API_URL,
);

/** WebSocket origin: explicit override, else the API origin with http→ws. */
export const WS_URL = (() => {
  const override = process.env.EXPO_PUBLIC_GX_WS_URL?.trim();
  if (override) return trimTrailingSlash(override);
  return API_BASE_URL.replace(/^http/, "ws");
})();

/** Network requests fail fast rather than hanging a financial screen forever. */
export const REQUEST_TIMEOUT_MS = 12_000;
