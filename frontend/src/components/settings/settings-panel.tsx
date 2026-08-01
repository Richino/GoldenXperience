"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { RefreshCw, Volume1, Volume2, VolumeX } from "lucide-react";
import { SectionLabel } from "@/components/ui/section-label";
import { SelectMenu } from "@/components/ui/select-menu";
import { useTextSize } from "@/components/providers/text-size-provider";
import { useMarketStream } from "@/lib/market-stream/use-market-stream";
import { apiUrl } from "@/lib/api/url";
import { DEFAULT_NOTIFICATION_VOLUME, NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSounds, notificationVolume, type NotificationSound } from "@/lib/notifications/sounds";
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

const unavailableStatus: ConnectionStatus = {
  state: "error",
  source: "mock",
  environment: "practice",
  label: "OANDA unavailable",
  message: "The connection status is temporarily unavailable.",
  checkedAt: new Date(0).toISOString(),
};

type PracticeExecution = {
  policy: { enabled: boolean; updatedAt: string };
  intents: { pending: number; sending: number; submitted: number; failed: number; unknown: number };
};

export function SettingsPanel({
  initialStatus,
}: {
  initialStatus?: ConnectionStatus;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { textSize, setTextSize, mounted: textSizeMounted } = useTextSize();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [status, setStatus] = useState(initialStatus ?? unavailableStatus);
  const [testing, setTesting] = useState(false);
  const [notificationSound, setNotificationSound] = useState<NotificationSound>("soft-whistle");
  const [notificationVolumePercent, setNotificationVolumePercent] = useState(Math.round(DEFAULT_NOTIFICATION_VOLUME * 100));
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushStatus, setPushStatus] = useState<"checking" | "available" | "enabled" | "unsupported" | "unavailable" | "error">("checking");
  const [pushBusy, setPushBusy] = useState(false);
  const [practiceExecution, setPracticeExecution] = useState<PracticeExecution | null>(null);
  const [savingPracticeExecution, setSavingPracticeExecution] = useState(false);
  const notificationAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(NOTIFICATION_SOUND_KEY) as NotificationSound | null;
    if (stored && notificationSounds.some((sound) => sound.value === stored)) setNotificationSound(stored);
    const storedVolume = window.localStorage.getItem(NOTIFICATION_VOLUME_KEY);
    const parsedVolume = Number(storedVolume);
    if (Number.isFinite(parsedVolume)) setNotificationVolumePercent(Math.min(100, Math.max(0, parsedVolume)));
    setBrowserNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    void (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return setPushStatus("unsupported");
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        const response = await fetch(apiUrl("/api/push/vapid-key"), { credentials: "include", cache: "no-store" });
        setPushStatus(response.ok && subscription ? "enabled" : response.ok ? "available" : "unavailable");
      } catch { setPushStatus("error"); }
    })();
  }, []);

  useEffect(() => {
    void fetch(apiUrl("/api/practice-execution"), { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<PracticeExecution> : null)
      .then((value) => setPracticeExecution(value));
  }, []);

  function selectNotificationSound(value: NotificationSound) {
    setNotificationSound(value);
    window.localStorage.setItem(NOTIFICATION_SOUND_KEY, value);
  }

  function previewNotificationSound() {
    const selected = notificationSounds.find((sound) => sound.value === notificationSound);
    if (!selected || !notificationAudio.current) return;
    notificationAudio.current.src = selected.path;
    notificationAudio.current.volume = notificationVolume(String(notificationVolumePercent));
    notificationAudio.current.currentTime = 0;
    void notificationAudio.current.play().catch(() => undefined);
  }

  async function requestBrowserNotifications() {
    if (typeof Notification === "undefined") return;
    setBrowserNotificationPermission(await Notification.requestPermission());
  }

  function decodeBase64Url(value: string) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  async function enablePushNotifications() {
    setPushBusy(true);
    try {
      if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return setPushStatus("unsupported");
      const permission = await Notification.requestPermission();
      setBrowserNotificationPermission(permission);
      if (permission !== "granted") return setPushStatus("error");
      const keyResponse = await fetch(apiUrl("/api/push/vapid-key"), { credentials: "include", cache: "no-store" });
      if (!keyResponse.ok) return setPushStatus("unavailable");
      const { publicKey } = await keyResponse.json() as { publicKey: string };
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeBase64Url(publicKey) });
      const response = await fetch(apiUrl("/api/push/subscribe"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription }) });
      setPushStatus(response.ok ? "enabled" : "error");
    } catch { setPushStatus("error"); }
    finally { setPushBusy(false); }
  }

  async function togglePracticeExecution() {
    if (status.state !== "connected" || status.environment !== "practice") return;
    setSavingPracticeExecution(true);
    try {
      const response = await fetch(apiUrl("/api/practice-execution"), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !practiceExecution?.policy.enabled }),
      });
      const payload = await response.json() as { policy?: PracticeExecution["policy"] };
      if (response.ok && payload.policy) setPracticeExecution((current) => ({ policy: payload.policy!, intents: current?.intents ?? { pending: 0, sending: 0, submitted: 0, failed: 0, unknown: 0 } }));
    } finally {
      setSavingPracticeExecution(false);
    }
  }

  useEffect(() => {
    setStatus(initialStatus ?? unavailableStatus);
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
      label: "Paper journal",
      value: "API-backed",
      meta: "Railway Postgres",
      tone: "success" as const,
    },
    {
      label: "Research data",
      value: "OANDA candles",
      meta: "Price-only evidence",
      tone: "success" as const,
    },
  ];

  async function testConnection() {
    setTesting(true);
    try {
      const response = await fetch(apiUrl("/api/oanda/test"), { credentials: "include", cache: "no-store" });
      const payload = (await response.json()) as {
        status?: ConnectionStatus;
        data?: { status?: ConnectionStatus };
      };
      const nextStatus = payload.status ?? payload.data?.status;
      if (!nextStatus) throw new Error("The connection endpoint returned no status.");
      setStatus(nextStatus);
    } catch (error) {
      setStatus({
        state: "error",
        source: "mock",
        environment: "practice",
        label: "OANDA unavailable",
        message: error instanceof Error ? error.message : "The connection test could not be completed.",
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
        <SectionLabel title="Notifications" variant="minimal" />
        <p className="mt-1 max-w-xl text-sm text-[color:var(--muted)]">Choose the sound used when the notification system announces an event. Your choice is saved in this browser.</p>
        <div className="mt-4 settings-row items-end">
          <span className="settings-row-label">Notification sound</span>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <SelectMenu
              ariaLabel="Notification sound"
              value={notificationSound}
              onChange={selectNotificationSound}
              options={notificationSounds}
              size="control"
              className="w-full sm:w-56"
              fullWidth
            />
            <button type="button" className="settings-accent-btn pressable h-11 shrink-0" onClick={previewNotificationSound}>
              Preview sound
            </button>
          </div>
        </div>
        <div className="mt-4 settings-row items-center">
          <label className="settings-row-label" htmlFor="notification-volume">Notification volume</label>
          <div className="flex w-full items-center gap-3 sm:w-80">
            {notificationVolumePercent === 0 ? <VolumeX aria-hidden="true" className="size-5 shrink-0 text-[color:var(--muted)]" /> : notificationVolumePercent < 50 ? <Volume1 aria-hidden="true" className="size-5 shrink-0 text-[color:var(--accent)]" /> : <Volume2 aria-hidden="true" className="size-5 shrink-0 text-[color:var(--accent)]" />}
            <input
              id="notification-volume"
              type="range"
              min="0"
              max="100"
              step="5"
              value={notificationVolumePercent}
              onChange={(event) => {
                const value = Number(event.target.value);
                setNotificationVolumePercent(value);
                window.localStorage.setItem(NOTIFICATION_VOLUME_KEY, String(value));
              }}
              className="h-2 w-full cursor-pointer appearance-none rounded-full accent-[color:var(--accent)]"
              style={{ background: `linear-gradient(to right, var(--accent) 0% ${notificationVolumePercent}%, var(--surface-raised) ${notificationVolumePercent}% 100%)` }}
              aria-label="Notification volume"
            />
            <output htmlFor="notification-volume" className="w-12 text-right text-sm font-semibold tabular-nums text-[color:var(--foreground)]">{notificationVolumePercent}%</output>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[color:var(--surface-raised)] px-4 py-3">
          <div><p className="text-xs font-semibold">Browser alerts</p><p className="mt-0.5 text-xs text-[color:var(--muted)]">{browserNotificationPermission === "granted" ? "Allowed. Alerts can appear while the app is open." : browserNotificationPermission === "denied" ? "Blocked by this browser. Change it in browser site settings to enable alerts." : browserNotificationPermission === "unsupported" ? "This browser does not support desktop alerts." : "Allow browser alerts for trade and system events."}</p></div>
          {browserNotificationPermission === "default" ? <button type="button" className="secondary-button pressable" onClick={() => void requestBrowserNotifications()}>Allow alerts</button> : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[color:var(--border)] px-4 py-3">
          <div><p className="text-xs font-semibold">Desktop and mobile push</p><p className="mt-0.5 text-xs text-[color:var(--muted)]">{pushStatus === "enabled" ? "Enabled on this device." : pushStatus === "unavailable" ? "The server has not configured push delivery yet." : pushStatus === "unsupported" ? "This browser or device does not support web push here." : pushStatus === "error" ? "Could not enable push notifications. Check permission and try again." : "Receive alerts when the app is closed."}</p></div>
          {pushStatus !== "enabled" && pushStatus !== "unsupported" ? <button type="button" className="secondary-button pressable" disabled={pushBusy} onClick={() => void enablePushNotifications()}>{pushBusy ? "Enabling…" : "Enable push"}</button> : null}
        </div>
        <audio ref={notificationAudio} preload="none" aria-hidden="true" />
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
        <SectionLabel title="Demo auto-trading" variant="minimal" />
        <p className="mt-1 max-w-xl text-sm text-[color:var(--muted)]">Submits market orders only to your OANDA practice account, with the strategy stop and target attached. Live accounts are refused by the server.</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-[color:var(--surface-raised)] px-4 py-4">
          <div><p className="text-sm font-semibold">{practiceExecution?.policy.enabled ? "Practice auto-trading armed" : "Practice auto-trading off"}</p><p className="mt-1 text-xs text-[color:var(--muted)]">{status.state === "connected" && status.environment === "practice" ? "New accepted paper trades will be submitted to OANDA Practice only when armed." : "Connect an OANDA practice account before this can be armed."}</p></div>
          <button type="button" onClick={() => void togglePracticeExecution()} disabled={savingPracticeExecution || status.state !== "connected" || status.environment !== "practice"} className={practiceExecution?.policy.enabled ? "secondary-button pressable" : "primary-button pressable"}>{savingPracticeExecution ? "Saving…" : practiceExecution?.policy.enabled ? "Turn off" : "Arm practice trading"}</button>
        </div>
        {practiceExecution ? <p className="mt-3 text-xs text-[color:var(--muted)]">Broker intents: {practiceExecution.intents.pending} pending · {practiceExecution.intents.submitted} submitted · {practiceExecution.intents.failed} failed · {practiceExecution.intents.unknown} need review. An unknown intent is never automatically retried.</p> : null}
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
