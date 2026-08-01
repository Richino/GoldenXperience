export const NOTIFICATION_SOUND_KEY = "goldenxperience.notification-sound";
export const NOTIFICATION_VOLUME_KEY = "goldenxperience.notification-volume";
export const DEFAULT_NOTIFICATION_VOLUME = 0.6;

export const notificationSounds = [
  { value: "soft-whistle", label: "Soft Whistle", path: "/notification-sounds/soft-whistle.mp3" },
  { value: "quick-chime", label: "Quick Chime", path: "/notification-sounds/quick-chime.mp3" },
  { value: "bright-ping", label: "Bright Ping", path: "/notification-sounds/bright-ping.mp3" },
  { value: "classic-ring", label: "Classic Ring", path: "/notification-sounds/classic-ring.mp3" },
  { value: "chat-alert", label: "Chat Alert", path: "/notification-sounds/chat-alert.mp3" },
] as const;

export type NotificationSound = (typeof notificationSounds)[number]["value"];

export function notificationSoundPath(value: string | null | undefined) {
  return notificationSounds.find((sound) => sound.value === value)?.path ?? notificationSounds[0].path;
}

export function notificationVolume(value: string | null | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NOTIFICATION_VOLUME;
  return Math.min(1, Math.max(0, parsed / 100));
}
