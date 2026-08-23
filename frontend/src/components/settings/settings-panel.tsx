"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { RiskWorkspace, type PaperRiskPolicy } from "@/components/risk/risk-workspace";
import { SelectMenu } from "@/components/ui/select-menu";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { useTextSize } from "@/components/providers/text-size-provider";
import { DEFAULT_NOTIFICATION_VOLUME, NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSounds, notificationVolume, type NotificationSound } from "@/lib/notifications/sounds";
import { currentPushStatus, subscribeThisDeviceToPush, type PushUiStatus } from "@/lib/notifications/push";
import { useNotificationContext } from "@/components/notifications/notification-provider";
import type { TextSize } from "@/lib/text-size";

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

function browserAlertDetail(permission: NotificationPermission | "unsupported") {
  switch (permission) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Blocked in browser settings";
    case "unsupported":
      return "Not supported";
    case "default":
      return "Not enabled";
    default: {
      const _exhaustive: never = permission;
      return _exhaustive;
    }
  }
}

function pushDetail(status: PushUiStatus, errorMessage: string | null) {
  switch (status) {
    case "enabled":
      return "Enabled on this device";
    case "unavailable":
      return "Server not configured";
    case "unsupported":
      return "Not supported here";
    case "insecure":
      return "Needs HTTPS";
    case "install_required":
      return "Add to Home Screen, then open the app";
    case "error":
      return errorMessage ?? "Could not enable";
    case "checking":
      return "Checking…";
    case "available":
      return "Available";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function SettingsPanel({
  initialPolicy,
}: {
  initialPolicy: PaperRiskPolicy;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { textSize, setTextSize, mounted: textSizeMounted } = useTextSize();
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [notificationSound, setNotificationSound] = useState<NotificationSound>("soft-whistle");
  const [notificationVolumePercent, setNotificationVolumePercent] = useState(Math.round(DEFAULT_NOTIFICATION_VOLUME * 100));
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushStatus, setPushStatus] = useState<PushUiStatus>("checking");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const { previewToast } = useNotificationContext();
  const notificationAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(NOTIFICATION_SOUND_KEY) as NotificationSound | null;
    if (stored && notificationSounds.some((sound) => sound.value === stored)) setNotificationSound(stored);
    const storedVolume = window.localStorage.getItem(NOTIFICATION_VOLUME_KEY);
    const parsedVolume = Number(storedVolume);
    if (Number.isFinite(parsedVolume)) setNotificationVolumePercent(Math.min(100, Math.max(0, parsedVolume)));
    setBrowserNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    void currentPushStatus().then(setPushStatus);
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

  async function enablePushNotifications() {
    setPushBusy(true);
    setPushError(null);
    try {
      const result = await subscribeThisDeviceToPush();
      setPushStatus(result.status);
      if ("permission" in result && result.permission) setBrowserNotificationPermission(result.permission);
      if (result.status === "error") setPushError(result.message ?? "Could not enable");
    } catch (reason) {
      setPushStatus("error");
      setPushError(reason instanceof Error ? reason.message : "Could not enable");
    } finally {
      setPushBusy(false);
    }
  }

  const themeValue =
    mounted && resolvedTheme === "dark" ? "dark" : "light";

  return (
    <div className="settings-view settings-minimal space-y-8 lg:space-y-10">
      <header>
        <h1 className="text-display">Settings</h1>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          Appearance, alerts, and account
        </p>
      </header>

      <section className="settings-minimal-section" aria-label="Appearance">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Appearance</h2>
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

      <section className="settings-minimal-section" aria-label="Notifications">
        <h2 className="text-sm font-semibold tracking-[-0.01em]">Notifications</h2>
        <div className="mt-4 space-y-4">
          <div className="settings-row items-end">
            <span className="settings-row-label">Sound</span>
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
              <button type="button" className="secondary-button pressable h-11 shrink-0" onClick={previewNotificationSound}>
                Preview
              </button>
            </div>
          </div>

          <div className="settings-row items-center">
            <label className="settings-row-label" htmlFor="notification-volume">Volume</label>
            <div className="flex w-full items-center gap-3 sm:w-80">
              {notificationVolumePercent === 0 ? (
                <VolumeX aria-hidden="true" className="size-5 shrink-0 text-[color:var(--muted)]" />
              ) : notificationVolumePercent < 50 ? (
                <Volume1 aria-hidden="true" className="size-5 shrink-0 text-[color:var(--accent)]" />
              ) : (
                <Volume2 aria-hidden="true" className="size-5 shrink-0 text-[color:var(--accent)]" />
              )}
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
              <output htmlFor="notification-volume" className="w-12 text-right text-sm font-semibold tabular-nums text-[color:var(--foreground)]">
                {notificationVolumePercent}%
              </output>
            </div>
          </div>

          <div className="settings-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">Toast</p>
              <p className="mt-0.5 text-xs text-[color:var(--muted)]">Sample alert with the selected sound</p>
            </div>
            <button type="button" className="secondary-button pressable" onClick={previewToast}>
              Test
            </button>
          </div>

          <div className="settings-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">Browser alerts</p>
              <p className="mt-0.5 text-xs text-[color:var(--muted)]">{browserAlertDetail(browserNotificationPermission)}</p>
            </div>
            {browserNotificationPermission === "default" ? (
              <button type="button" className="secondary-button pressable" onClick={() => void requestBrowserNotifications()}>
                Allow
              </button>
            ) : null}
          </div>

          <div className="settings-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">Push</p>
              <p className="mt-0.5 text-xs text-[color:var(--muted)]">{pushDetail(pushStatus, pushError)}</p>
            </div>
            {pushStatus === "available" || pushStatus === "unavailable" || pushStatus === "error" ? (
              <button type="button" className="secondary-button pressable" disabled={pushBusy} onClick={() => void enablePushNotifications()}>
                {pushBusy ? "Enabling…" : "Enable"}
              </button>
            ) : null}
          </div>
        </div>
        <audio ref={notificationAudio} preload="none" aria-hidden="true" />
      </section>

      <section id="risk" className="settings-minimal-section scroll-mt-6" aria-label="Risk">
        <RiskWorkspace initialPolicy={initialPolicy} />
      </section>

      <section className="settings-minimal-section" aria-label="Account actions">
        <SignOutButton />
      </section>
    </div>
  );
}
