/**
 * The single HTTP entry point for the app. No screen calls `fetch` directly —
 * they go through `apiGet` / `apiSend` so cookie attachment, timeouts and error
 * normalisation live in one place (brief §13).
 */
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "@/api/config";
import { sessionCookieHeader } from "@/api/session";

export type ApiErrorKind = "http" | "network" | "timeout" | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;

  constructor(message: string, kind: ApiErrorKind, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }

  /** True when the failure is connectivity, not a server rejection. */
  get isOffline(): boolean {
    return this.kind === "network" || this.kind === "timeout";
  }

  /** True when the session is missing or expired. */
  get isUnauthorized(): boolean {
    return this.kind === "http" && this.status === 401;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Caller cancellation (component unmount) chains into our timeout controller.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const cookie = sessionCookieHeader();
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new ApiError("The request timed out.", "timeout");
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Network request failed.",
      "network",
    );
  }
  clearTimeout(timeout);

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Non-JSON error body — keep the status-based message.
    }
    throw new ApiError(message, "http", response.status);
  }

  // 204 and empty bodies are valid for the logout/patch endpoints.
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("The server returned an unreadable response.", "parse", response.status);
  }
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { signal });
}

export function apiSend<T>(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  return request<T>(path, { method, body });
}
