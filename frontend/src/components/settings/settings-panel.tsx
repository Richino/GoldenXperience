"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { RefreshCw } from "lucide-react";
import { SectionLabel } from "@/components/ui/section-label";
import { useTextSize } from "@/components/providers/text-size-provider";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { apiUrl } from "@/lib/api/url";
import type { TextSize } from "@/lib/text-size";
import type { ConnectionStatus } from "@/types/forex";
import type { MarketStreamState } from "@/types/market-stream";

const textSizeOptions: { value: TextSize; label: string }[] = [
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
];

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="settings-segment" role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`settings-segment-btn pressable ${
              selected ? "settings-segment-btn-active" : ""
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function statusBadgeClass(state: ConnectionStatus["state"]) {
  switch (state) {
    case "connected":
      return "is-success";
    case "error":
      return "is-danger";
    default:
      return "is-accent";
  }
}

function streamBadgeClass(state: MarketStreamState) {
  switch (state) {
    case "connected":
      return "is-success";
    case "error":
      return "is-danger";
    case "mock":
      return "is-accent";
    default:
      return "is-muted";
  }
}

export function SettingsPanel({
  initialStatus,
}: {
  initialStatus: ConnectionStatus;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { textSize, setTextSize, mounted: textSizeMounted } = useTextSize();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [status, setStatus] = useState(initialStatus);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setStatus(initialStatus);
  }, [initialStatus]);

  const marketStream = useMarketStream("EUR_USD", undefined, {
    trackPrice: false,
  });
  const streamLabel =
    marketStream.state === "connected"
      ? "Live"
      : marketStream.state === "mock"
        ? "Mock"
        : marketStream.state === "connecting" || marketStream.state === "idle"
          ? "Connecting"
          : "Offline";
  const foundationItems = [
    {
      label: "Market data",
      value:
        status.state === "connected" && marketStream.state === "connected"
          ? "OANDA practice"
          : marketStream.state === "mock"
            ? "Mock stream"
            : "Not connected",
      meta:
        status.state === "connected" && marketStream.state === "connected"
          ? "REST + stream"
          : "Check connection",
      tone:
        status.state === "connected" && marketStream.state === "connected"
          ? ("success" as const)
          : ("accent" as const),
    },
    {
      label: "Journal",
      value: "On-device",
      meta: "Local storage",
      tone: "success" as const,
    },
    {
      label: "Database",
      value: "Not configured",
      meta: "Supabase deferred",
      tone: "accent" as const,
    },
  ];

  async function testConnection() {
    setTesting(true);
    try {
      const response = await fetch(apiUrl("/api/oanda/test"), { cache: "no-store" });
      const payload = (await response.json()) as { status: ConnectionStatus };
      setStatus(payload.status);
    } catch {
      setStatus({
        state: "error",
        source: "mock",
        environment: "practice",
        label: "OANDA unavailable",
        message: "The local test endpoint could not be reached.",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  }

  const themeValue =
    mounted && resolvedTheme === "dark" ? "dark" : "light";

  return (
    <div className="settings-view space-y-6">
      <header>
        <h1 className="text-display tracking-[-0.05em]">Settings</h1>
        <p className="mt-1.5 max-w-xl text-sm text-[color:var(--muted)]">
          Theme and broker connection.
        </p>
      </header>

      <section className="app-card p-5 md:p-6">
        <SectionLabel title="Appearance" variant="minimal" />
        <div className="mt-4 space-y-4">
          <div className="settings-row">
            <span className="settings-row-label">Theme</span>
            <SegmentControl
              ariaLabel="Theme"
              value={themeValue}
              onChange={setTheme}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Text size</span>
            <SegmentControl
              ariaLabel="Text size"
              value={textSizeMounted ? textSize : "medium"}
              onChange={setTextSize}
              options={textSizeOptions}
            />
          </div>
        </div>
      </section>

      <section className="app-card p-5 md:p-6">
        <SectionLabel title="OANDA" variant="minimal" />
        <div className="mt-4">
          <div className="settings-status">
            <div className="min-w-0">
              <div className="settings-status-title">{status.label}</div>
              <p className="settings-status-detail">{status.message}</p>
            </div>
            <span
              className={`settings-status-badge ${statusBadgeClass(status.state)}`}
            >
              {status.state === "connected" ? "Connected" : status.state}
            </span>
          </div>

          <div className="settings-status">
            <div className="min-w-0">
              <div className="settings-status-title">Pricing stream</div>
              <p className="settings-status-detail">{marketStream.message}</p>
            </div>
            <span
              className={`settings-status-badge ${streamBadgeClass(marketStream.state)}`}
            >
              {streamLabel}
            </span>
          </div>

          <div className="mt-2">
            {["OANDA_API_KEY", "OANDA_ACCOUNT_ID"].map((name) => (
              <div key={name} className="settings-env">
                <span className="settings-env-name">{name}</span>
                <span className="settings-env-hint">Server only</span>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={testConnection}
            disabled={testing}
            className="minimal-submit pressable mt-4"
          >
            <RefreshCw className={`size-3.5 ${testing ? "animate-spin" : ""}`} />
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
      </section>

      <section className="app-card p-5 md:p-6">
        <SectionLabel title="Data" variant="minimal" />
        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          {foundationItems.map((item) => (
          <div key={item.label} className="settings-stat">
            <div className="settings-stat-label">{item.label}</div>
            <div className="settings-stat-value">{item.value}</div>
            <div
              className={`settings-stat-meta ${
                item.tone === "success" ? "is-success" : "is-accent"
              }`}
            >
              {item.meta}
            </div>
          </div>
          ))}
        </div>
      </section>
    </div>
  );
}
