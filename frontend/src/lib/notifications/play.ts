/**
 * Notification sounds that mix with whatever else the phone is playing.
 *
 * An <audio> element takes over the device's audio session, so on iOS (and
 * some Android builds) a notification pauses the user's music or podcast.
 * Sounds here go through the Web Audio API instead, and on iOS 17+ the page's
 * audio session is set to "ambient", which mixes over other audio rather than
 * interrupting it (it also follows the ring/silent switch, like other app
 * sounds). Each sound file is fetched and decoded once, then reused.
 *
 * iOS only lets a page start audio after a user gesture, so the provider
 * calls unlockNotificationAudio() on the first tap or key press.
 */

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

let context: AudioContext | null = null;
const decoded = new Map<string, Promise<AudioBuffer>>();

/** Mix with other audio instead of pausing it (Safari 17+; ignored elsewhere). */
function applyAmbientSession() {
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (!session || session.type === "ambient") return;
  try {
    session.type = "ambient";
  } catch {
    // Older WebKit: the property exists but is read-only.
  }
}

function audioContext() {
  if (context) return context;
  if (typeof window === "undefined") return null;
  const Context = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
  if (!Context) return null;
  applyAmbientSession();
  context = new Context();
  return context;
}

function soundBuffer(audio: AudioContext, path: string) {
  let pending = decoded.get(path);
  if (!pending) {
    pending = fetch(path)
      .then((response) => {
        if (!response.ok) throw new Error(`Sound ${path} is unavailable.`);
        return response.arrayBuffer();
      })
      .then((bytes) => audio.decodeAudioData(bytes));
    pending.catch(() => decoded.delete(path));
    decoded.set(path, pending);
  }
  return pending;
}

/** From a user gesture: lets later, gesture-less notification sounds play on iOS. */
export function unlockNotificationAudio() {
  const audio = audioContext();
  if (audio?.state === "suspended") void audio.resume().catch(() => undefined);
}

/** Play a notification sound at 0–1 volume, mixed with any other audio. */
export async function playNotificationSound(path: string, volume: number) {
  const audio = audioContext();
  if (!audio) return;
  applyAmbientSession();
  try {
    if (audio.state === "suspended") await audio.resume();
    const buffer = await soundBuffer(audio, path);
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    source.buffer = buffer;
    gain.gain.value = Math.min(1, Math.max(0, volume));
    source.connect(gain).connect(audio.destination);
    source.start();
  } catch {
    // A sound that cannot play is not worth interrupting anything for.
  }
}
