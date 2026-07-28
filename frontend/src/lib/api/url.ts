const DEFAULT_API_SERVER_URL = "http://localhost:8787";

function baseUrl() {
  return (process.env.NEXT_PUBLIC_API_SERVER_URL || DEFAULT_API_SERVER_URL).replace(/\/$/, "");
}

/** Builds a browser-safe URL for the separately deployed API service. */
export function apiUrl(path: string) {
  return `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Uses Railway's private service URL on the server when it is configured. */
export function serverApiUrl(path: string) {
  const configured = process.env.API_SERVER_URL || process.env.NEXT_PUBLIC_API_SERVER_URL || DEFAULT_API_SERVER_URL;
  return `${configured.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
