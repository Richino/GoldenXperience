"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { ChevronRight, LogOut, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { PhoneSettingsPicker } from "@/components/settings/phone-settings-ui";
import { MobileSheet } from "@/components/ui/mobile-sheet";
import { apiUrl } from "@/lib/api/url";
import { RiskWorkspace, type PaperRiskPolicy } from "@/components/risk/risk-workspace";
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

/** Section index on desktop, in page order. */
const SECTIONS = [
  { id: "risk", label: "Risk" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
  { id: "account", label: "Account" },
] as const;


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
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    const targets = SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (element): element is HTMLElement => element !== null,
    );
    if (!targets.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

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
  const soundLabel = notificationSounds.find((sound) => sound.value === notificationSound)?.label ?? "Soft Whistle";

  return (
    <div className="nl-st">
      <header className="nl-st-head">
        <span className="nl-overline">Workspace</span>
        <h1>Settings</h1>
      </header>

      <div className="nl-st-layout">
        <nav className="nl-st-index nl-st-desk" aria-label="Settings sections">
          {SECTIONS.map((section, index) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={activeSection === section.id ? "is-active" : ""}
              aria-current={activeSection === section.id ? "true" : undefined}
            >
              <span className="nl-st-index-num metric-number">{String(index + 1).padStart(2, "0")}</span>
              {section.label}
            </a>
          ))}
        </nav>

        <div className="nl-st-content">
          <RiskWorkspace initialPolicy={initialPolicy} />

          {/* ------------------------------------------------ desktop cards */}
          <section id="notifications" className="nl-st-card nl-st-desk" aria-labelledby="nl-st-notif-title">
            <div className="nl-st-card-head">
              <h2 id="nl-st-notif-title">Notifications</h2>
            </div>
            <div className="nl-st-block">
              <span className="nl-st-field-label">Sound</span>
              <div className="nl-st-sounds" role="radiogroup" aria-label="Notification sound">
                {notificationSounds.map((sound) => {
                  const active = notificationSound === sound.value;
                  return (
                    <button
                      key={sound.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`nl-st-sound${active ? " is-active" : ""}`}
                      onClick={() => {
                        selectNotificationSound(sound.value);
                        playSound(sound.value);
                      }}
                    >
                      <span className="nl-st-sound-icon" aria-hidden="true">
                        <Play />
                      </span>
                      {sound.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="nl-st-volume" htmlFor="notification-volume">
              <span className="nl-st-field-label">Volume</span>
              {notificationVolumePercent === 0 ? (
                <VolumeX aria-hidden="true" className="nl-st-volume-icon" />
              ) : notificationVolumePercent < 50 ? (
                <Volume1 aria-hidden="true" className="nl-st-volume-icon" />
              ) : (
                <Volume2 aria-hidden="true" className="nl-st-volume-icon" />
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
                aria-label="Notification volume"
              />
              <output htmlFor="notification-volume" className="metric-number">
                {notificationVolumePercent}%
              </output>
            </label>
            <div className="nl-st-rows">
              <div className="nl-st-row">
                <span className="nl-st-row-copy">
                  <b>Alert sound</b>
                  <span>Play the selected sound as an in-app alert</span>
                </span>
                <button type="button" className="nl-st-ghost pressable" onClick={previewToast}>
                  Test
                </button>
              </div>
              <div className="nl-st-row">
                <span className="nl-st-row-copy">
                  <b>Browser alerts</b>
                  <span>{browserAlertDetail(browserNotificationPermission)}</span>
                </span>
                {browserNotificationPermission === "default" ? (
                  <button type="button" className="nl-st-ghost pressable" onClick={() => void requestBrowserNotifications()}>
                    Allow
                  </button>
                ) : null}
              </div>
              <div className="nl-st-row">
                <span className="nl-st-row-copy">
                  <b>Push</b>
                  <span>{pushDetail(pushStatus, pushError)}</span>
                </span>
                {pushActionable ? (
                  <button type="button" className="nl-st-ghost pressable" disabled={pushBusy} onClick={() => void enablePushNotifications()}>
                    {pushBusy ? "Enabling…" : "Enable"}
                  </button>
                ) : null}
              </div>
            </div>
          </section>

          <section id="appearance" className="nl-st-card nl-st-desk" aria-labelledby="nl-st-app-title">
            <div className="nl-st-card-head">
              <h2 id="nl-st-app-title">Appearance</h2>
            </div>
            <div className="nl-st-block">
              <span className="nl-st-field-label">Theme</span>
              <div className="nl-st-themes" role="radiogroup" aria-label="Theme">
                {phoneThemeOptions.map((option) => {
                  const active = themeValue === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`nl-st-theme is-${option.value}${active ? " is-active" : ""}`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="nl-st-theme-preview" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="nl-st-theme-foot">
                        <span className="nl-st-row-copy">
                          <b>{option.label}</b>
                          <span>{option.detail}</span>
                        </span>
                        <span className="nl-st-radio" aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="nl-st-block">
              <span className="nl-st-field-label">Text size</span>
              <div className="nl-st-sizes" role="radiogroup" aria-label="Text size">
                {phoneTextSizeOptions.map((option) => {
                  const active = textSizeValue === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`nl-st-size is-${option.value}${active ? " is-active" : ""}`}
                      onClick={() => setTextSize(option.value)}
                    >
                      <span className="nl-st-size-aa" aria-hidden="true">Aa</span>
                      <span className="nl-st-row-copy">
                        <b>{option.label}</b>
                        <span>{option.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section id="account" className="nl-st-card nl-st-desk" aria-labelledby="nl-st-acct-title">
            <div className="nl-st-card-head">
              <h2 id="nl-st-acct-title">Account</h2>
            </div>
            <dl className="nl-st-account">
              <div>
                <dt>Signed in as</dt>
                <dd>{email ?? "—"}</dd>
              </div>
            </dl>
            <button type="button" className="nl-st-signout pressable" onClick={() => void signOut()} disabled={signingOut}>
              <LogOut aria-hidden="true" />
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </section>

          {/* -------------------------------------------------- phone rows */}
          <section className="nl-st-mcard nl-st-phone" aria-labelledby="nl-st-mnotif-title">
            <h2 id="nl-st-mnotif-title" className="nl-st-mcard-title">Notifications</h2>
            <button type="button" className="nl-st-mrow pressable" onClick={() => setPhonePicker("sound")}>
              <span>Sound</span>
              <span className="nl-st-mrow-end">
                {soundLabel}
                <ChevronRight aria-hidden="true" />
              </span>
            </button>
            {pushActionable && !pushBusy ? (
              <button type="button" className="nl-st-mrow pressable" onClick={() => void enablePushNotifications()}>
                <span>Push alerts</span>
                <span className="nl-st-mrow-end is-accent">Enable</span>
              </button>
            ) : (
              <div className="nl-st-mrow is-static">
                <span>Push alerts</span>
                <span className="nl-st-mrow-end">{pushBusy ? "Enabling…" : pushDetail(pushStatus, pushError)}</span>
              </div>
            )}
          </section>

          <section className="nl-st-mcard nl-st-phone" aria-labelledby="nl-st-mapp-title">
            <h2 id="nl-st-mapp-title" className="nl-st-mcard-title">Appearance</h2>
            <button type="button" className="nl-st-mrow pressable" onClick={() => setPhonePicker("theme")}>
              <span>Theme</span>
              <span className="nl-st-mrow-end">
                {themeValue === "light" ? "Light" : "Dark"}
                <ChevronRight aria-hidden="true" />
              </span>
            </button>
            <button type="button" className="nl-st-mrow pressable" onClick={() => setPhonePicker("text")}>
              <span>Text size</span>
              <span className="nl-st-mrow-end">
                {phoneTextSizeOptions.find((option) => option.value === textSizeValue)?.label ?? "Standard"}
                <ChevronRight aria-hidden="true" />
              </span>
            </button>
          </section>

          <section className="nl-st-mcard nl-st-phone" aria-labelledby="nl-st-macct-title">
            <h2 id="nl-st-macct-title" className="nl-st-mcard-title">Account</h2>
            <div className="nl-st-mrow is-static">
              <span>Signed in as</span>
              <span className="nl-st-mrow-end nl-st-email">{email ?? "—"}</span>
            </div>
            <button type="button" className="nl-st-mrow is-danger pressable" onClick={() => setSignOutOpen(true)}>
              <span>Sign out</span>
            </button>
          </section>
        </div>
      </div>

      <audio ref={notificationAudio} preload="none" aria-hidden="true" />

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
