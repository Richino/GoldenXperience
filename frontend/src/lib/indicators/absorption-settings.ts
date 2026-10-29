"use client";
import { useSyncExternalStore } from "react";
import { ABSORPTION_DEFAULTS, parseAbsorptionSettings, type AbsorptionSettings } from "./absorption";
const KEY = "gx-chart-absorption-v1", EVENT = "gx-absorption-settings";
let cached = ABSORPTION_DEFAULTS, previous: string | null | undefined, memoryOnly = false;
function snapshot() {
  if (typeof window === "undefined") return ABSORPTION_DEFAULTS;
  if (memoryOnly) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== previous) { previous = raw; try { cached = raw ? parseAbsorptionSettings(JSON.parse(raw)) : ABSORPTION_DEFAULTS; } catch { cached = ABSORPTION_DEFAULTS; } }
  } catch { /* Private-mode storage can be unavailable; memory settings still work. */ }
  return cached;
}
function subscribe(read: () => void) {
  window.addEventListener(EVENT, read); window.addEventListener("storage", read);
  return () => { window.removeEventListener(EVENT, read); window.removeEventListener("storage", read); };
}
export function useAbsorptionSettings() { return useSyncExternalStore(subscribe, snapshot, () => ABSORPTION_DEFAULTS); }
export function updateAbsorptionSettings(patch: Partial<AbsorptionSettings>) {
  cached = parseAbsorptionSettings({ ...snapshot(), ...patch });
  try { previous = JSON.stringify(cached); localStorage.setItem(KEY, previous); } catch { memoryOnly = true; }
  window.dispatchEvent(new Event(EVENT));
}
