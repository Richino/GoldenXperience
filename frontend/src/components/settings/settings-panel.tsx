"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut, Volume1, Volume2, VolumeX } from "lucide-react";
import { PhoneSettingsPicker, PhoneSettingsRow } from "@/components/settings/phone-settings-ui";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { apiUrl } from "@/lib/api/url";
import { RiskWorkspace, type PaperRiskPolicy } from "@/components/risk/risk-workspace";
import { SelectMenu } from "@/components/ui/select-menu";
import { SignOutButton } from "@/components/ui/sign-out-button";
import { useTextSize } from "@/components/providers/text-size-provider";
import { DEFAULT_NOTIFICATION_VOLUME, NOTIFICATION_SOUND_KEY, NOTIFICATION_VOLUME_KEY, notificationSounds, notificationVolume, type NotificationSound } from "@/lib/notifications/sounds";
import { currentPushStatus, subscribeThisDeviceToPush, type PushUiStatus } from "@/lib/notifications/push";
import { useNotificationContext } from "@/components/notifications/notification-provider";
import type { TextSize } from "@/lib/text-size";

/** Phone pickers: the app's Settings drawer options and wording. */
const phoneThemeOptions = [
  { value: "dark", label: "Dark", detail: "GX dark appearance" },
  { value: "light", label: "Light", detail: "Bright GX appearance" },
] as const;

const phoneTextSizeOptions = [
  { value: "small", label: "Small", detail: "More information on screen" },
  { value: "medium", label: "Standard", detail: "Recommended" },
  { value: "large", label: "Large", detail: "Easier to read" },
] as const satisfies readonly { value: TextSize; label: string; detail: string }[];

const phoneSoundOptions = notificationSounds.map((sound) => ({
  value: sound.value,
  label: sound.label,
  detail: "Saved for alert playback",
}));

type PhonePicker = "theme" | "text" | "sound" | null;

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
  email,
}: {
  initialPolicy: PaperRiskPolicy;
  email: string | null;
}) {
  const router = useRouter();
  const [phonePicker, setPhonePicker] = useState<PhonePicker>(null);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
  const textSizeValue: TextSize = textSizeMounted ? textSize : "medium";

  function playSound(value: NotificationSound) {
    const selected = notificationSounds.find((sound) => sound.value === value);
    if (!selected || !notificationAudio.current) return;
    notificationAudio.current.src = selected.path;
    notificationAudio.current.volume = notificationVolume(String(notificationVolumePercent));
    notificationAudio.current.currentTime = 0;
    void notificationAudio.current.play().catch(() => undefined);
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  const pushActionable = pushStatus === "available" || pushStatus === "unavailable" || pushStatus === "error";

  return (
    <div className="settings-view settings-minimal space-y-8 lg:space-y-10">
      <header>
        <h1 className="text-display">Settings</h1>
        <p className="mt-1 text-sm text-[color:var(--muted)]">
          Appearance, alerts, and account
        </p>
      </header>

      {/* Phone layout: the app's Settings tab (rows that open drawers). */}
      <section className="phone-settings-card settings-phone-only" aria-label="Appearance">
        <h2 className="phone-settings-section">Appearance</h2>
        <PhoneSettingsRow label="Theme" value={themeValue === "light" ? "Light" : "Dark"} onClick={() => setPhonePicker("theme")} />
        <PhoneSettingsRow
          label="Text size"
          value={phoneTextSizeOptions.find((option) => option.value === textSizeValue)?.label ?? "Standard"}
          onClick={() => setPhonePicker("text")}
        />
      </section>

      <section className="phone-settings-card settings-phone-only" aria-label="Notifications">
        <h2 className="phone-settings-section">Notifications</h2>
        <PhoneSettingsRow
          label="Notification sound"
          value={notificationSounds.find((sound) => sound.value === notificationSound)?.label ?? "Soft Whistle"}
          onClick={() => setPhonePicker("sound")}
        />
        <PhoneSettingsRow
          label="Push alerts"
          value={pushBusy ? "Enabling…" : pushActionable ? "Enable" : pushDetail(pushStatus, pushError)}
          onClick={pushActionable && !pushBusy ? () => void enablePushNotifications() : undefined}
        />
      </section>

      <PhoneSettingsPicker
        open={phonePicker === "theme"}
        onClose={() => setPhonePicker(null)}
        eyebrow="Settings"
        title="Theme"
        options={phoneThemeOptions}
        selected={themeValue}
        onSelect={(value) => {
          setTheme(value);
          setPhonePicker(null);
        }}
      />
      <PhoneSettingsPicker
        open={phonePicker === "text"}
        onClose={() => setPhonePicker(null)}
        eyebrow="Settings"
        title="Text size"
        options={phoneTextSizeOptions}
        selected={textSizeValue}
        onSelect={(value) => {
          setTextSize(value);
          setPhonePicker(null);
        }}
      />
      <PhoneSettingsPicker
        open={phonePicker === "sound"}
        onClose={() => setPhonePicker(null)}
        eyebrow="Settings"
        title="Notification sound"
        options={phoneSoundOptions}
        selected={notificationSound}
        onSelect={(value) => {
          selectNotificationSound(value);
          // The phone layout has no Preview button, so play the choice.
          playSound(value);
          setPhonePicker(null);
        }}
      />

      <section className="settings-minimal-section settings-desktop-only" aria-label="Appearance">
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

      <section className="settings-minimal-section settings-desktop-only" aria-label="Notifications">
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
              <p className="text-sm font-medium">Alert sound</p>
              <p className="mt-0.5 text-xs text-[color:var(--muted)]">Play the selected sound</p>
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
      </section>
      <audio ref={notificationAudio} preload="none" aria-hidden="true" />

      <section id="risk" className="settings-minimal-section scroll-mt-6" aria-label="Risk">
        <RiskWorkspace initialPolicy={initialPolicy} />
      </section>

      <section className="settings-minimal-section settings-desktop-only" aria-label="Account actions">
        <SignOutButton />
      </section>

      <section className="phone-settings-card settings-phone-only" aria-label="Account">
        <h2 className="phone-settings-section">Account</h2>
        <PhoneSettingsRow label="Signed in as" value={email ?? "—"} />
        <button type="button" className="phone-settings-sign-out pressable" onClick={() => setSignOutOpen(true)}>
          <LogOut className="size-4" strokeWidth={2} aria-hidden="true" />
          Sign out
        </button>
      </section>

      <MobileSheet open={signOutOpen} onClose={() => setSignOutOpen(false)} title="Sign out?">
        <p className="phone-settings-confirm-copy">You will need to sign in again to access your workspace.</p>
        <div className="phone-settings-confirm-actions">
          <button type="button" className="phone-settings-confirm-cancel pressable" onClick={() => setSignOutOpen(false)} disabled={signingOut}>
            Cancel
          </button>
          <button type="button" className="phone-settings-confirm-sign-out pressable" onClick={() => void signOut()} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </MobileSheet>
    </div>
  );
}
