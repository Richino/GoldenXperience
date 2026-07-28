import type { MarketStreamConfig } from "./market-stream-config.js";
import { normalizeOandaPrice, type OandaStreamPrice } from "./market-stream-normalize.js";
import type {
  MarketPriceTick,
  MarketStreamHeartbeat,
  MarketStreamStatus,
} from "./market-stream-types.js";

interface StreamHandlers {
  onPrice: (tick: MarketPriceTick) => void;
  onHeartbeat: (heartbeat: MarketStreamHeartbeat) => void;
  onStatus: (status: Omit<MarketStreamStatus, "connectedClients">) => void;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const STREAM_READ_TIMEOUT_MS = 20_000;

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Stream stopped."));
      },
      { once: true },
    );
  });
}

function status(
  config: MarketStreamConfig,
  state: MarketStreamStatus["state"],
  message: string,
): Omit<MarketStreamStatus, "connectedClients"> {
  return {
    type: "status",
    state,
    source: config.isConfigured ? "oanda" : "mock",
    environment: config.environment,
    message,
    instruments: config.instruments,
    checkedAt: new Date().toISOString(),
  };
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OANDA stream stopped sending heartbeats.")),
          STREAM_READ_TIMEOUT_MS,
        );
        abortHandler = () => reject(new Error("Stream stopped."));
        signal.addEventListener("abort", abortHandler, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function parseStreamLine(line: string) {
  try {
    return JSON.parse(line) as OandaStreamPrice | { type?: string; time?: string };
  } catch {
    return null;
  }
}

export class OandaPricingStream {
  private controller: AbortController | null = null;
  private sequence = 0;

  constructor(
    private readonly config: MarketStreamConfig,
    private readonly handlers: StreamHandlers,
  ) {}

  start() {
    this.controller = new AbortController();
    void this.run(this.controller.signal);
  }

  stop() {
    this.controller?.abort();
    this.controller = null;
  }

  private async run(signal: AbortSignal) {
    let attempt = 0;

    while (!signal.aborted) {
      try {
        attempt += 1;
        this.handlers.onStatus(
          status(this.config, "connecting", "Connecting to OANDA pricing stream."),
        );

        await this.connectOnce(signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted) return;

        const message =
          error instanceof Error ? error.message : "Unknown OANDA stream error.";
        const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), MAX_RECONNECT_DELAY_MS);

        console.error(`[market-stream] OANDA stream error: ${message}`);
        this.handlers.onStatus(
          status(
            this.config,
            "error",
            `OANDA stream error. Reconnecting in ${Math.round(delay / 1000)}s.`,
          ),
        );

        await wait(delay, signal).catch(() => undefined);
      }
    }
  }

  private async connectOnce(signal: AbortSignal) {
    const accountId = this.config.accountId;
    const apiKey = this.config.apiKey;

    if (!accountId || !apiKey) {
      throw new Error("OANDA credentials are not configured.");
    }

    const url = new URL(
      `/v3/accounts/${encodeURIComponent(accountId)}/pricing/stream`,
      this.config.streamBaseUrl,
    );
    url.searchParams.set("instruments", this.config.instruments.join(","));
    url.searchParams.set("snapshot", "true");

    console.info(
      `[market-stream] Opening OANDA ${this.config.environment} stream for ${this.config.instruments.join(", ")}`,
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Accept-Datetime-Format": "RFC3339",
      },
      signal,
    });

    if (!response.ok || !response.body) {
      const body = (await response.text()).slice(0, 240);
      throw new Error(`OANDA stream returned ${response.status}${body ? `: ${body}` : ""}`);
    }

    this.handlers.onStatus(
      status(this.config, "connected", "OANDA pricing stream is live."),
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!signal.aborted) {
        const { done, value } = await readStreamChunk(reader, signal);

        if (done) {
          throw new Error("OANDA pricing stream ended.");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parsed = parseStreamLine(trimmed);
          if (!parsed) continue;

          if (parsed.type === "HEARTBEAT") {
            this.handlers.onHeartbeat({
              type: "heartbeat",
              source: "oanda",
              time: parsed.time ?? new Date().toISOString(),
            });
            continue;
          }

          const tick = normalizeOandaPrice(
            parsed as OandaStreamPrice,
            ++this.sequence,
          );
          if (tick) {
            this.handlers.onPrice(tick);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}


