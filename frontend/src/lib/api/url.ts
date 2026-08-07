const DEFAULT_API_SERVER_URL = "http://localhost:8787";

function baseUrl() {
  return (process.env.NEXT_PUBLIC_API_SERVER_URL || DEFAULT_API_SERVER_URL).replace(/\/$/, "");
}

/**
 * Builds a browser-safe URL for the separately deployed API service.
 *
 * In the browser this stays relative so the request goes through the
 * `/api/:path*` rewrite in next.config on whatever origin the page was served
 * from. An absolute URL would hard-code the API host into the page, and
 * `localhost:8787` resolves to the *device* — so any phone or tablet loading the
 * app over the LAN fails every fetch.
 */
export function apiUrl(path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return typeof window === "undefined" ? `${baseUrl()}${normalized}` : normalized;
}

/** Uses Railway's private service URL on the server when it is configured. */
export function serverApiUrl(path: string) {
  const configured = process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL || DEFAULT_API_SERVER_URL;
  return `${configured.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
